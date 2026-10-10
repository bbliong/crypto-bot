// Exploratory initial-rise study. No production imports or writes.
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const fresh=process.argv.includes('--fresh');
const cache=JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,fresh?'runner-fresh-cache.json.gz':'runner-cache.json.gz'))));
const initial=JSON.parse(fs.readFileSync(path.join(dir,'initial-run-analysis.json')));
const initialMap=new Map(initial.rows.map(r=>[r.mint,r]));
const tokens=cache.tokens.filter(t=>t.originalEligible);
const baseResolved=initial.rows.filter(r=>r.price3xx&&['TARGET','DUMP_FIRST','TIMEOUT'].includes(r.price600_30m.status));
const splitAt=baseResolved[Math.floor(baseResolved.length*.7)].firstAt;
const finite=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const median=a=>{a=a.filter(finite).map(Number).sort((a,b)=>a-b);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
function prior(a,at){let l=0,h=a.length;while(l<h){const m=(l+h)>>>1;if(a[m].at<=at)l=m+1;else h=m;}return a[l-1]||null;}
function priceAt(t,at,age=5000){const b=prior(t.series,at);return b&&at-b.at<=age?b.p:null;}
const change=(a,b)=>a!==null&&b>0?(a/b-1)*100:null;
function features(t,at){
  const s=t.series.filter(b=>b.at<=at),p=s.at(-1)?.p,meta={},metaAt={};
  for(const m of t.meta){if(m.at>at)break;for(const[k,v]of Object.entries(m))if(k!=='at'&&v!=null){meta[k]=v;metaAt[k]=m.at;}}
  const f={price:p,window60Complete:at-t.firstAt>=60000,returnFirst:change(p,t.series[0].p),momentum15:change(p,priceAt(t,at-15000)),momentum30:change(p,priceAt(t,at-30000)),momentum60:change(p,priceAt(t,at-60000))};
  for(const seconds of [15,30,60]){
    const w=s.filter(b=>b.at>at-seconds*1000),buys=new Map(),sells=new Map();let buy=0,sell=0,n=0,tiny=0,meaningful=0;
    for(const b of w){buy+=b.buy;sell+=b.sell;n+=b.n;tiny+=b.tiny;meaningful+=b.meaningfulBuy;
      for(const[k,v]of Object.entries(b.buyers))buys.set(k,(buys.get(k)||0)+v);
      for(const[k,v]of Object.entries(b.sellers))sells.set(k,(sells.get(k)||0)+v);
    }
    const sorted=[...buys].sort((a,b)=>b[1]-a[1]),top=sorted[0];
    Object.assign(f,{[`buyUsd${seconds}`]:buy,[`sellUsd${seconds}`]:sell,[`buyShare${seconds}`]:buy+sell>0?100*buy/(buy+sell):null,
      [`meaningfulBuy${seconds}`]:meaningful,[`buyers${seconds}`]:buys.size,[`sellers${seconds}`]:sells.size,
      [`largestSell${seconds}`]:Math.max(0,...w.map(b=>b.maxSell)),[`topBuyerPct${seconds}`]:top&&meaningful>0?top[1]/meaningful*100:null,
      [`topBuyer${seconds}`]:top?.[0]||null,[`tinyPct${seconds}`]:n?100*tiny/n:null,
      [`drawdown${seconds}`]:w.length?(1-p/Math.max(...w.map(b=>b.p)))*100:null,
      [`activeMeaningfulBuySeconds${seconds}`]:w.filter(b=>b.meaningfulBuy>=1).length});
  }
  let peak=0,dumped=false,maxDD=0;for(const b of s){peak=Math.max(peak,b.p);const dd=(1-b.p/peak)*100;maxDD=Math.max(maxDD,dd);if(dd>=60)dumped=true;}
  f.drawdown=(1-p/peak)*100;f.maxDrawdownSoFar=maxDD;f.alreadyDumped=dumped;
  const prev30=s.filter(b=>b.at>at-60000&&b.at<=at-30000).reduce((n,b)=>n+b.meaningfulBuy,0);
  f.buyAcceleration30=prev30>0?f.meaningfulBuy30/prev30:null;
  const h=prior(t.holders,at);f.holderCount=h&&at-h.at<=30000?h.count:null;
  for(const sec of [15,30,60]){const prev=prior(t.holders,at-sec*1000);f[`holderDelta${sec}`]=f.holderCount!==null&&prev&&at-sec*1000-prev.at<=30000?h.count-prev.count:null;}
  for(const[k,col]of Object.entries({ratPct:'top_rat_trader_percentage',devTeamPct:'dev_team_hold_rate',top10Pct:'top_10_holder_rate',sniperHoldPct:'top70_sniper_hold_rate',bundlerPct:'top_bundler_trader_percentage'})){
    f[k]=finite(meta[col])?Number(meta[col])*100:null;f[k+'AgeSeconds']=metaAt[col]?(at-metaAt[col])/1000:null;
    const early=t.meta.find(m=>finite(m[col]));f[k+'Change']=f[k]!==null&&early&&early.at<=at?f[k]-Number(early[col])*100:null;
  }
  f.dexBotCount=finite(meta.dex_bot_count)?Number(meta.dex_bot_count):null;
  f.dexBotCountAgeSeconds=metaAt.dex_bot_count?(at-metaAt.dex_bot_count)/1000:null;
  f.insiderCount=finite(meta.insider_count)?Number(meta.insider_count):null;
  f.liquidity=finite(meta.liquidity)?Number(meta.liquidity):null;
  f.ageSeconds=finite(meta.creation_timestamp)?at/1000-Number(meta.creation_timestamp):null;
  f.supply=finite(meta.circulating_supply)?Number(meta.circulating_supply):null;
  f.marketCap=f.supply?p*f.supply:null;
  f.creatorBuyShare60=t.creator&&f.meaningfulBuy60>0?s.filter(b=>b.at>at-60000).reduce((n,b)=>n+(b.buyers[t.creator]||0),0)/f.meaningfulBuy60*100:null;
  f.initialLabel=initialMap.get(t.mint)?.price600_30m.status??null;
  return f;
}
function targetOutcome(t,at,p){
  let peak=p,previous=at,maxGap=0,last=null,min=p;
  for(const b of t.series){if(b.at<=at)continue;if(b.at>at+1800000)break;
    maxGap=Math.max(maxGap,b.at-previous);previous=b.at;last=b;peak=Math.max(peak,b.p);min=Math.min(min,b.p);
    if(b.p>=.0006||(1-b.p/peak)>=.6)return {status:maxGap>30000?'GAP':b.p>=.0006?'TARGET':'DUMP',seconds:(b.at-at)/1000,minReturn:change(min,p),maxGap:maxGap/1000};
  }
  return {status:maxGap>30000?'GAP':last&&last.at>=at+1770000?'TIMEOUT':'CENSORED',seconds:last?(last.at-at)/1000:0,minReturn:change(min,p),maxGap:maxGap/1000};
}
function net(entry,exit){return ((((5*.99-.005)/(entry*1.005))*exit*.995*.99-.005)/5-1)*100;}
function execute(t,at,delay=1000,exitMode='stop12'){
  const entry=t.series.find(b=>b.at>=at+delay);
  if(!entry||entry.at>at+delay+5000)return {status:'ENTRY_MISSING'};
  if(entry.p<.0003||entry.p>=.0004)return {status:'ENTRY_OUTSIDE_BAND'};
  let prev=entry.at,trigger=null,why=null,peak=entry.p;
  for(const b of t.series){if(b.at<=entry.at)continue;
    if(b.at-prev>10000)return {status:'PATH_GAP',entryAt:entry.at};prev=b.at;peak=Math.max(peak,b.p);
    const n=net(entry.p,b.p),recentSell=exitMode==='sell100'?t.series.filter(x=>x.at<=b.at&&x.at>b.at-5000).some(x=>x.maxSell>=100):false;
    if(b.p>=.0006||n<=-12||exitMode==='stop3gross'&&b.p<=entry.p*.97||recentSell||b.at>=entry.at+1800000){
      trigger=b;why=b.p>=.0006?'TARGET':recentSell?'SELL100':exitMode==='stop3gross'&&b.p<=entry.p*.97?'STOP3_GROSS':n<=-12?'STOP12_NET':'TIME';break;
    }
  }
  if(!trigger)return {status:'EXIT_NOT_OBSERVED',entryAt:entry.at};
  const exit=t.series.find(b=>b.at>=trigger.at+delay);
  if(!exit||exit.at>trigger.at+delay+5000)return {status:'EXIT_FILL_MISSING',entryAt:entry.at,why};
  return {status:'CLOSED',entryAt:entry.at,entryPrice:entry.p,exitAt:exit.at,exitPrice:exit.p,why,net:net(entry.p,exit.p)};
}
const clockSensitivity=process.argv.includes('--clock-sensitivity');
const lateCheckpoints=process.argv.includes('--late-checkpoints');
const checkpoints=fresh?[60]:clockSensitivity?[59,60,61,62,65]:lateCheckpoints?[240,300,360,420,480]:[30,60,90,120,180];
const decisions=[];
for(const t of tokens)for(const sec of checkpoints){
  const at=t.firstAt+sec*1000,p=priceAt(t,at);if(p===null||p<.0003||p>=.0004)continue;
  const f=features(t,at);if(f.alreadyDumped)continue;
  decisions.push({mint:t.mint,symbol:t.symbol,firstAt:t.firstAt,seconds:sec,at,f,outcome:targetOutcome(t,at,p),
    execution1:execute(t,at),execution2:execute(t,at,2000),stop3:execute(t,at,1000,'stop3gross'),sell100:execute(t,at,1000,'sell100')});
}
const rules=[
  ['baseline',()=>true],
  ['no sell >=100 in 60s',f=>f.window60Complete&&f.largestSell60<100],
  ['buy share60 >=95',f=>f.window60Complete&&f.buyShare60>=95],
  ['meaningful buy60 >=150',f=>f.window60Complete&&f.meaningfulBuy60>=150],
  ['buy acceleration >=1.2',f=>f.window60Complete&&f.buyAcceleration30!==null&&f.buyAcceleration30>=1.2],
  ['holder delta60 >=5',f=>f.holderDelta60!==null&&f.holderDelta60>=5],
  ['rat <50',f=>f.ratPct!==null&&f.ratPct<50],
  ['dex bots <150',f=>f.dexBotCount!==null&&f.dexBotCount<150],
  ['dex bots <150, metadata age <=10s',f=>f.dexBotCount!==null&&f.dexBotCount<150&&f.dexBotCountAgeSeconds!==null&&f.dexBotCountAgeSeconds<=10],
  ['steady price and concentrated buys',f=>f.momentum30>0&&f.momentum60>0&&f.drawdown30<2&&f.meaningfulBuy30>=30&&f.topBuyerPct30>=80&&f.largestSell60<50],
  ['low sell and meaningful flow',f=>f.window60Complete&&f.sellUsd60<=5&&f.meaningfulBuy60>=100],
];
function stats(a,key='execution1'){
  const resolved=a.filter(r=>['TARGET','DUMP','TIMEOUT'].includes(r.outcome.status)),closed=a.filter(r=>r[key].status==='CLOSED'),wins=closed.filter(r=>r[key].net>0).length;
  return {n:a.length,targets:resolved.filter(r=>r.outcome.status==='TARGET').length,resolved:resolved.length,
    closed:closed.length,wins,unresolved:a.length-closed.length,meanNet:closed.length?closed.reduce((n,r)=>n+r[key].net,0)/closed.length:null,
    pnlUsd:closed.reduce((n,r)=>n+r[key].net*.05,0),worstNet:closed.length?Math.min(...closed.map(r=>r[key].net)):null};
}
const comparisons=[];
for(const sec of checkpoints)for(const[name,pred]of rules){const a=decisions.filter(r=>r.seconds===sec&&pred(r.f));
  comparisons.push({seconds:sec,rule:name,all:stats(a),early:stats(a.filter(r=>r.firstAt<splitAt)),late:stats(a.filter(r=>r.firstAt>=splitAt)),delay2:stats(a,'execution2')});
}
const fields=['momentum15','momentum30','momentum60','returnFirst','drawdown','maxDrawdownSoFar','buyUsd30','sellUsd30','meaningfulBuy60','buyShare60','buyAcceleration30','buyers60','topBuyerPct60','activeMeaningfulBuySeconds60','largestSell60','holderCount','holderDelta60','ratPct','ratPctChange','devTeamPct','devTeamPctChange','top10Pct','dexBotCount','insiderCount','ageSeconds'];
const groupSummary=a=>({n:a.length,metrics:Object.fromEntries(fields.map(k=>[k,{n:a.filter(r=>finite(r.f[k])).length,median:median(a.map(r=>r.f[k]))}]))});
const groups=checkpoints.map(seconds=>{const a=decisions.filter(r=>r.seconds===seconds);return {seconds,winners:groupSummary(a.filter(r=>r.outcome.status==='TARGET')),losers:groupSummary(a.filter(r=>r.outcome.status==='DUMP'))};});
const firstSignals=[];
for(const[name,pred]of rules){const seen=new Set(),a=[];for(const d of decisions){if(seen.has(d.mint)||!pred(d.f))continue;seen.add(d.mint);a.push(d);}firstSignals.push({rule:name,all:stats(a),early:stats(a.filter(r=>r.firstAt<splitAt)),late:stats(a.filter(r=>r.firstAt>=splitAt)),delay2:stats(a,'execution2'),mints:a.map(r=>r.mint)});}
const result={cutoff:cache.cutoff,splitAt,cohort:tokens.length,method:'Prices in USD; frozen original 77-token cohort. Fixed causal checkpoints after first observed quote. Entry only price [0.0003,0.0004), fresh within5s, no prior dump60. Target600 before dump60 for labels. Execution delay1/2sec, fill wait5sec, gaps>10sec censored, target price600, net stop12, max30min. Same $5 fee model as native TargetLane; not native lane replay. Exploratory temporal split, not unseen holdout.',
  comparisons,firstSignals,groups,exitSensitivity:checkpoints.map(seconds=>{const a=decisions.filter(r=>r.seconds===seconds);return {seconds,baseline:stats(a),stop3:stats(a,'stop3'),sell100:stats(a,'sell100')};}),decisions};
fs.writeFileSync(path.join(dir,fresh?'runner-fresh-study.json':clockSensitivity?'runner-clock-sensitivity.json':lateCheckpoints?'runner-late-checkpoints.json':'runner-study.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({cohort:tokens.length,splitAt:new Date(splitAt).toISOString(),baseline:comparisons.filter(r=>r.rule==='baseline'),clockSensitivity},null,2));
