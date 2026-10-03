import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseline, prepareSession, exitReplay } from './search-mc-low-loss.mjs';

// Offline research only. Never writes an active formula or launches a worker.
const finite = x => typeof x === 'number' && Number.isFinite(x);
const readLines = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const group = rows => {
  const m = new Map();
  for (const row of rows) { if (!m.has(row.mint)) m.set(row.mint, []); m.get(row.mint).push(row); }
  for (const a of m.values()) a.sort((x,y) => x.observedAt-y.observedAt);
  return m;
};
export const priorEntry = { entryReturn:2, windowSeconds:5, momentum:0, maxDrawdown:-5, maxMarketCap:200000, maxTop1:50, risingTicks:0, flow:'off' };
export const priorExit = { hardStop:.5, activation:1, lock:.5, trailing:6, negativeWindows:0, maxHoldSeconds:null, holderExit:false, flowExit:false };
const oldEntry = {...priorEntry, entryReturn:8, maxDrawdown:-3, maxMarketCap:100000};
const oldExit = {...priorExit,...baseline};

export function deduplicateTrades(trades) {
  // Collector did not retain transaction signatures. Exact-field deduplication
  // prevents obvious replayed frames, but can merge indistinguishable real trades.
  const seen = new Set();
  return [...trades].sort((a,b)=>a.observedAt-b.observedAt).filter(t => {
    const key = JSON.stringify([t.mint,t.wallet,t.side,t.occurredAt,t.priceUsd,t.amountUsd]);
    if (seen.has(key)) return false; seen.add(key); return true;
  });
}

export function buildSession(s, inputTicks, inputHolders, inputTrades) {
  const ticks = inputTicks.filter(t => t.observedAt >= s.startedAt && t.observedAt <= s.endedAt && finite(t.priceUsd) && t.priceUsd > 0).sort((a,b)=>a.observedAt-b.observedAt);
  const holders = inputHolders.filter(h => h.observedAt >= s.startedAt && h.status===200 && finite(h.top1Percent)
    && Array.isArray(h.queryKeys) && !h.queryKeys.includes('tag')).sort((a,b)=>a.observedAt-b.observedAt);
  const trades = deduplicateTrades(inputTrades.filter(t=>t.observedAt>=s.startedAt && t.observedAt<=s.endedAt));
  let hp=-1,tp=0,peak=0,up=0,active=[];
  const highs=[],lows=[];let highHead=0,lowHead=0;
  const anchors = {1:-1,3:-1,5:-1}, points=[];
  for (let i=0;i<ticks.length;i++) {
    const t=ticks[i], at=t.observedAt, price=t.priceUsd;
    // Strict < avoids assuming an API response with the same millisecond was
    // processed before this websocket event (cross-file ordering is unavailable).
    while(hp+1<holders.length && holders[hp+1].observedAt<at) hp++;
    const h=holders[hp];
    peak=Math.max(peak,price);
    up=i>0 && price>ticks[i-1].priceUsd ? up+1 : 0;
    while(highs.length>highHead && ticks[highs.at(-1)].priceUsd<=price)highs.pop();
    while(lows.length>lowHead && ticks[lows.at(-1)].priceUsd>=price)lows.pop();
    highs.push(i);lows.push(i);
    while(highs[highHead]<i && ticks[highs[highHead]].observedAt<at-3000)highHead++;
    while(lows[lowHead]<i && ticks[lows[lowHead]].observedAt<at-3000)lowHead++;
    const returns={};
    for(const seconds of [1,3,5]) {
      while(anchors[seconds]+1<i && ticks[anchors[seconds]+1].observedAt<=at-seconds*1000) anchors[seconds]++;
      const a=ticks[anchors[seconds]];
      returns[seconds]=a && at-seconds*1000-a.observedAt<=2000 ? (price/a.priceUsd-1)*100 : null;
    }
    while(tp<trades.length && trades[tp].observedAt<=at) active.push(trades[tp++]);
    active=active.filter(t=>t.occurredAt>=at-5000);
    const flow=active.filter(t=>t.occurredAt<=at && finite(t.amountUsd) && t.amountUsd>=0);
    const buys=flow.filter(t=>t.side==='buy'), sells=flow.filter(t=>t.side==='sell');
    const buyUsd=buys.reduce((a,t)=>a+t.amountUsd,0), sellUsd=sells.reduce((a,t)=>a+t.amountUsd,0);
    points.push({i,at,price,ret:(price/ticks[0].priceUsd-1)*100,dd:(price/peak-1)*100,returns,up,
      range3:(ticks[highs[highHead]].priceUsd/ticks[lows[lowHead]].priceUsd-1)*100,
      top1:h && at-h.observedAt<=30000 ? h.top1Percent : null, holderAt:h?.observedAt??null,
      buyShare:buyUsd+sellUsd>0?buyUsd/(buyUsd+sellUsd):null,
      uniqueBuyers:new Set(buys.map(t=>t.wallet).filter(Boolean)).size, flowTrades:flow.length});
  }
  const safe=points.filter(p=>p.top1!==null && p.top1<=50);
  return {id:`${s.startedAt}:${s.mint}`,mint:s.mint,symbol:s.metadata?.symbol??s.mint,startedAt:s.startedAt,endedAt:s.endedAt,
    mc:s.entryMarketCapUsd,points,safe,ticks,holders,rawTradeCount:inputTrades.length,deduplicatedTradeCount:trades.length,
    suspect:ticks.some((t,i)=>i>0 && t.priceUsd/ticks[i-1].priceUsd>100)};
}

export function qualifies(p,s,f) {
  return p.top1!==null && p.top1<=f.maxTop1 && finite(s.mc) && s.mc<=f.maxMarketCap
    && p.ret>=f.entryReturn && p.returns[f.windowSeconds]!==null && p.returns[f.windowSeconds]>=f.momentum
    && p.dd>=f.maxDrawdown && p.up>=f.risingTicks
    && (!finite(f.maxRange3) || p.range3<=f.maxRange3)
    && (f.flow==='off' || (p.buyShare!==null && p.buyShare>=Number(f.flow.slice(3))/100 && p.uniqueBuyers>=2));
}
export function findEntry(s,f) {
  let since=null,previous=null;
  for(const p of s.safe) {
    if(!qualifies(p,s,f)){since=null;previous=p;continue;}
    if(since===null || !previous || p.i!==previous.i+1 || p.at-previous.at>2000)since=p.at;
    if(p.at-since>=(f.confirmMs??0))return p.i;
    previous=p;
  }
  return -1;
}

export function simulate(s,entryIndex,f,latencyMs=0) {
  const points=s.points, signal=points[entryIndex];
  if(!signal) return null;
  let buyIndex=entryIndex;
  if(latencyMs>0) { buyIndex=points.findIndex((p,i)=>i>=entryIndex && p.at>=signal.at+latencyMs); if(buyIndex<0) return {unfilled:true}; }
  const buy=points[buyIndex]; let peak=0,neg=0,lastWindow=-Infinity;
  const result=(p,reason,exitSignalAt=null)=>{
    const rawRet=(p.price/buy.price-1)*100;
    return {id:s.id,mint:s.mint,symbol:s.symbol,startedAt:s.startedAt,entrySignalAt:signal.at,buyAt:buy.at,buyPrice:buy.price,
      entrySeconds:(signal.at-s.startedAt)/1000,entryReturn:signal.ret,momentum:signal.returns,drawdown:signal.dd,
      top1:signal.top1,holderAt:signal.holderAt,buyShare:signal.buyShare,uniqueBuyers:signal.uniqueBuyers,range3:signal.range3,
      exitSignalAt,exitAt:p.at,exitPrice:p.price,reason,rawRet,ret:s.suspect&&rawRet>0?0:rawRet,suspect:s.suspect,latencyMs};
  };
  for(let j=buyIndex+1;j<points.length;j++) {
    const p=points[j],r=(p.price/buy.price-1)*100; peak=Math.max(peak,r);let reason=null;
    if(peak<f.activation && r<=-f.hardStop) reason='HARD_STOP';
    else if(peak>=f.activation && r<=Math.max(f.lock,(100+peak)*(1-f.trailing/100)-100)) reason='PROFIT_LOCK_TRAILING';
    if(!reason && finite(f.takeProfit) && r>=f.takeProfit)reason='TAKE_PROFIT';
    if(!reason && f.holderExit && p.top1!==null && p.top1>50) reason='HOLDER_RISK';
    if(!reason && f.flowExit && p.flowTrades>=3 && p.buyShare!==null && p.buyShare<.35 && p.returns[3]!==null && p.returns[3]<0) reason='SELL_FLOW_DOMINATES';
    if(!reason && f.negativeWindows>0 && p.at-lastWindow>=4500 && p.returns[5]!==null) {
      neg=p.returns[5]<0?neg+1:0;lastWindow=p.at;
      if(neg>=f.negativeWindows && r>0) reason='NEGATIVE_MOMENTUM';
    }
    if(!reason && finite(f.maxHoldSeconds) && p.at-buy.at>=f.maxHoldSeconds*1000) reason='TIME_LIMIT';
    if(reason) {
      if(latencyMs===0) return result(p,reason,p.at);
      const fill=points.find((v,k)=>k>=j && v.at>=p.at+latencyMs);
      return fill ? result(fill,reason,p.at) : result(points.at(-1),'CAPTURE_END_PENDING_SELL',p.at);
    }
  }
  return result(points.at(-1),'CAPTURE_END_MARK_ONLY');
}
const closed=t=>!t.reason.startsWith('CAPTURE_END');
export function summarize(trades) {
  const a=trades.filter(t=>t&&!t.unfilled),v=a.map(t=>t.ret),n=v.length;
  const wins=v.filter(x=>x>0).length,losses=v.filter(x=>x<0).length,total=v.reduce((x,y)=>x+y,0),grossLoss=-v.filter(x=>x<0).reduce((x,y)=>x+y,0);
  return {buys:n,wins,losses,flat:n-wins-losses,closed:a.filter(closed).length,open:a.filter(t=>!closed(t)).length,
    mean:n?total/n:null,winRate:n?wins/n*100:null,totalReturnPoints:total,grossLossPoints:grossLoss,
    lossPerBuy:n?grossLoss/n:null,meanLosingTrade:losses?-grossLoss/losses:null,worst:n?Math.min(...v):null,
    withoutLargestWinnerMean:n>1?(total-Math.max(...v))/(n-1):null,
    meanAfter1PercentCost:n?total/n-1:null,unfilled:trades.filter(t=>t?.unfilled).length};
}
function assess(sessions,entry,exit,splitAt,latencyMs=0) {
  const trades=sessions.flatMap(s=>{const i=findEntry(s,entry);return i<0?[]:[simulate(s,i,exit,latencyMs)];});
  const filled=trades.filter(t=>!t.unfilled);
  return {entry,exit,latencyMs,all:summarize(trades),earlier:summarize(filled.filter(t=>t.startedAt<splitAt)),later:summarize(filled.filter(t=>t.startedAt>=splitAt)),
    closed:summarize(filled.filter(closed)),open:summarize(filled.filter(t=>!closed(t))),
    raw:summarize(filled.map(t=>({...t,ret:t.rawRet}))),trades:filled};
}
function fixed25(sessions,summaries) {
  const trades=[];
  for(let i=0;i<sessions.length;i++) {
    const s=sessions[i],row=prepareSession(summaries[i],s.ticks,s.holders,true,25,'unfiltered');
    if(!row || !row.top || !finite(row.mc) || row.mc>200000 || row.r30<2 || row.r5===null || row.r5<0 || row.dd< -5) continue;
    const t=exitReplay(row,priorExit); trades.push({symbol:s.symbol,mint:s.mint,reason:t.reason,ret:row.upwardJumpSuspect&&t.ret>0?0:t.ret});
  }
  return {all:summarize(trades),closed:summarize(trades.filter(closed)),trades};
}

const compareSafe=(a,b)=>b.worst-a.worst || a.lossPerBuy-b.lossPerBuy || b.withoutLargestWinnerMean-a.withoutLargestWinnerMean;
const compareWins=(a,b)=>b.winRate-a.winRate || b.wins-a.wins || b.withoutLargestWinnerMean-a.withoutLargestWinnerMean;
const compareProfit=(a,b)=>b.withoutLargestWinnerMean-a.withoutLargestWinnerMean || b.mean-a.mean;
const compareBalanced=(a,b)=> (b.withoutLargestWinnerMean-b.lossPerBuy+(b.winRate-50)/20)-(a.withoutLargestWinnerMean-a.lossPerBuy+(a.winRate-50)/20);

async function main() {
  const input=process.argv[2]??'research/pump-band-12h-paused-optimizer-2026-09-28T14-50-00Z';
  const output=process.argv[3]??`research/ws-event-search-${new Date().toISOString().replace(/[:.]/g,'-')}`;
  const refine=process.argv.includes('--refine');
  const seedArg=process.argv.indexOf('--take-profit-from');
  const seedResult=seedArg<0?null:JSON.parse(readFileSync(process.argv[seedArg+1],'utf8'));
  mkdirSync(output,{recursive:true});
  const summaries=readLines(join(input,'token-summary.jsonl')).sort((a,b)=>a.startedAt-b.startedAt);
  const tickMap=group(readLines(join(input,'socket-ticks.jsonl')).filter(t=>t.source?.startsWith('detail_socket_activity')));
  const holderMap=group(readLines(join(input,'holder-snapshots.jsonl'))),tradeMap=group(readLines(join(input,'trades.jsonl')));
  const sessions=summaries.map(s=>buildSession(s,tickMap.get(s.mint)??[],holderMap.get(s.mint)??[],tradeMap.get(s.mint)??[]));
  const splitAt=summaries[Math.floor(summaries.length*2/3)].startedAt;
  const train=sessions.filter(s=>s.startedAt<splitAt && s.safe.length),minTrain=12;
  const result={generatedAt:new Date().toISOString(),input,sessionCount:sessions.length,splitAt,minTrain,
    method:'Offline event replay: first eligible received price event, one buy per observed session, no re-entry. Holder snapshots must be unfiltered, older than event and <=30 seconds old. Momentum anchor must be within 2 seconds of target window. Original session-start MC retained. Training is chronological earlier 2/3; last 1/3 not used to rank. Entire recording has been explored before, so this is NOT unseen validation. Default zero-latency prices are proxies, not fills; fees excluded. Positive returns on >100x upward-jump sessions score zero, all losses retained. Trade deduplication is heuristic because transaction signatures were not saved.',
    coverage:{sessionsWithPrice:sessions.filter(s=>s.points.length).length,sessionsWithSafeFreshHolder:sessions.filter(s=>s.safe.length).length,trainWithSafeFreshHolder:train.length,
      priceEvents:sessions.reduce((a,s)=>a+s.points.length,0),safeEvents:sessions.reduce((a,s)=>a+s.safe.length,0)},
    fixed25Baseline:fixed25(sessions,summaries),eventOriginalRules:assess(sessions,oldEntry,oldExit,splitAt),eventPriorRules:assess(sessions,priorEntry,priorExit,splitAt)};
  console.log(JSON.stringify({phase:'loaded',...result.coverage,baseline:result.fixed25Baseline.all,eventPrior:result.eventPriorRules.all}));
  const grid=refine
    ? {entryReturn:[0,.5,1,2,4],windowSeconds:[1,3,5],momentum:[0,.5,1,2],maxDrawdown:[0,-1,-3],maxMarketCap:[100000,200000,300000],maxTop1:[35,50],risingTicks:[0,2],flow:['off','buy55','buy65','buy75'],confirmMs:[0,250,500,1000],maxRange3:[null,2,5,10]}
    : {entryReturn:[0,.5,1,2,3,4,6,8],windowSeconds:[1,3,5],momentum:[0,.25,.5,1,2],maxDrawdown:[0,-.5,-1,-2,-3,-5],maxMarketCap:[60000,100000,200000,300000],maxTop1:[20,35,50],risingTicks:[0,2,3],flow:['off','buy55','buy65'],confirmMs:[0],maxRange3:[null]};
  result.entryGrid=grid;
  if(seedResult){
    result.seedInput=process.argv[seedArg+1];
    result.entryGrid={mode:'Earlier-period leaders from seed file, plus the two prior entry rules',seedInput:result.seedInput};
  }
  const candidates=new Map(),cache=new Map();let entryTests=0;
  function entryEvaluate(f) {
    entryTests++;
    const entries=train.flatMap((s,i)=>{const k=findEntry(s,f);return k<0?[]:[{i,k}];});
    if(entries.length<minTrain) return;
    const key=entries.map(e=>`${e.i}:${e.k}`).join('|');if(candidates.has(key)) return;
    const stats=[oldExit,priorExit].map((e,j)=>summarize(entries.map(({i,k})=>{
      const ck=`${i}:${k}:${j}`;if(!cache.has(ck))cache.set(ck,simulate(train[i],k,e));return cache.get(ck);
    })));
    candidates.set(key,{entry:f,entries,key,stats});
  }
  if(seedResult){
    for(const list of Object.values(seedResult.leaders))for(const candidate of list)entryEvaluate(candidate.entry);
  }else for(const entryReturn of grid.entryReturn) for(const windowSeconds of grid.windowSeconds) for(const momentum of grid.momentum)
    for(const maxDrawdown of grid.maxDrawdown) for(const maxMarketCap of grid.maxMarketCap) for(const maxTop1 of grid.maxTop1)
      for(const risingTicks of grid.risingTicks) for(const flow of grid.flow) for(const confirmMs of grid.confirmMs) for(const maxRange3 of grid.maxRange3) {
        entryEvaluate({entryReturn,windowSeconds,momentum,maxDrawdown,maxMarketCap,maxTop1,risingTicks,flow,confirmMs,maxRange3});
        if(entryTests%20000===0)console.log(JSON.stringify({phase:'entry-grid',entryTests,distinct:candidates.size}));
      }
  entryEvaluate(priorEntry);entryEvaluate(oldEntry);
  const shortlisted=new Map();
  for(const rank of [compareSafe,compareWins,compareProfit,compareBalanced]) for(const j of [0,1]) {
    const list=[...candidates.values()].sort((a,b)=>rank(a.stats[j],b.stats[j])).slice(0,12);
    for(const c of list)shortlisted.set(c.key,c);
  }
  const entries=[...shortlisted.values()],allKeys=new Map();
  for(const c of entries)for(const e of c.entries)allKeys.set(`${e.i}:${e.k}`,e);
  result.entryTests=entryTests;result.distinctEntrySets=candidates.size;result.shortlistedEntrySets=entries.length;
  console.log(JSON.stringify({phase:'exit-grid',entryTests,distinct:candidates.size,shortlisted:entries.length,uniqueEntryPoints:allKeys.size}));
  const exitGrid=seedResult
    ? {hardStop:[.5,1,2,3],activation:[1,3,6],lock:[0,.5],trailing:[1,3,6],negativeWindows:[0,1],maxHoldSeconds:[null,10,30],riskProfile:['price','holderFlow'],takeProfit:[null,.5,1,2,3,5]}
    : {hardStop:[.5,.75,1,1.5,2,3,4],activation:[1,2,3,4,6,8],lock:[0,.5,1],trailing:[1,2,3,4,6,8],negativeWindows:[0,1,2],maxHoldSeconds:[null,10,30,60],riskProfile:['price','holder','holderFlow'],takeProfit:[null]};
  result.exitGrid=exitGrid;
  const ranks={balanced:compareBalanced,winRate:compareWins,lowLoss:compareSafe,profit:compareProfit};
  const leaders=Object.fromEntries(Object.keys(ranks).map(k=>[k,[]]));let exits=0,pairs=0,positiveCandidates=0;
  for(const hardStop of exitGrid.hardStop)for(const activation of exitGrid.activation)for(const lock of exitGrid.lock)for(const trailing of exitGrid.trailing)
    for(const negativeWindows of exitGrid.negativeWindows)for(const maxHoldSeconds of exitGrid.maxHoldSeconds)for(const riskProfile of exitGrid.riskProfile)for(const takeProfit of exitGrid.takeProfit){
      if(lock>=activation)continue;
      const exit={hardStop,activation,lock,trailing,negativeWindows,maxHoldSeconds,holderExit:riskProfile!=='price',flowExit:riskProfile==='holderFlow',takeProfit};
      const trades=new Map([...allKeys].map(([key,{i,k}])=>[key,simulate(train[i],k,exit)]));exits++;
      for(const c of entries){
        pairs++;const ts=c.entries.map(({i,k})=>trades.get(`${i}:${k}`)),stats=summarize(ts);
        if(stats.closed<8 || stats.mean<=0 || stats.withoutLargestWinnerMean<=0)continue;
        positiveCandidates++;
        for(const [name,rank]of Object.entries(ranks)){
          const list=leaders[name],item={entry:c.entry,exit,stats};
          if(list.length>=8 && rank(stats,list.at(-1).stats)>=0)continue;
          item.signature=ts.map(t=>`${t.id}:${t.buyAt}:${t.exitAt}:${t.ret}`).join('|');
          if(list.some(v=>v.signature===item.signature))continue;
          list.push(item);list.sort((a,b)=>rank(a.stats,b.stats));if(list.length>8)list.pop();
        }
      }
      if(exits%2000===0)console.log(JSON.stringify({phase:'exit-grid',exits,pairs,positiveCandidates}));
    }
  result.exitTests=exits;result.pairTests=pairs;result.positiveCandidates=positiveCandidates;
  result.leaders={};
  for(const [name,list]of Object.entries(leaders))result.leaders[name]=list.slice(0,3).map(c=>({
    ...assess(sessions,c.entry,c.exit,splitAt),
    latency250:assess(sessions,c.entry,c.exit,splitAt,250),latency500:assess(sessions,c.entry,c.exit,splitAt,500),
  }));
  // Additional selection uses only EARLIER-period costs/delay sensitivity.
  // The later period is never used to select or promote a formula.
  const robustPool=new Map();
  for(const list of Object.values(leaders))for(const c of list)if(!robustPool.has(c.signature)){
    const delay=assess(sessions,c.entry,c.exit,splitAt,500);
    if(delay.earlier.meanAfter1PercentCost>0 && delay.earlier.withoutLargestWinnerMean>1 && delay.earlier.winRate>=50)
      robustPool.set(c.signature,{entry:c.entry,exit:c.exit,delay});
  }
  const robust=[...robustPool.values()].sort((a,b)=>compareBalanced(a.delay.earlier,b.delay.earlier))[0];
  result.trainingLatencyCandidate=robust?{...assess(sessions,robust.entry,robust.exit,splitAt),latency500:robust.delay}:null;
  result.validationStatus='RETROSPECTIVE_ONLY_NOT_VALIDATED_NOT_ACTIVATED';
  writeFileSync(join(output,'websocket-search.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({phase:'done',output,entryTests,exitTests:exits,pairTests:pairs,
    best:Object.fromEntries(Object.entries(result.leaders).map(([k,v])=>[k,v[0]?{entry:v[0].entry,exit:v[0].exit,all:v[0].all,later:v[0].later,latency500:v[0].latency500.all}:null]))}));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
