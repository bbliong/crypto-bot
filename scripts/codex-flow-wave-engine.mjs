import {FLOW_WAVE_ENTRIES,FLOW_WAVE_EXITS,flowWaveEntryAllowed,flowWaveNetFloor,flowWaveNetReturn} from '../src/codex-flow-wave-v2.ts';
import {asOf,firstAfter} from './guarded-wave-replay-core.mjs';
import {receivedTicks,knownMajorSell} from './codex-guarded-wave-engine.mjs';
import {confirmCodexSetup} from '../src/codex-guarded-wave.ts';
const sum=(xs,f)=>xs.reduce((n,x)=>n+f(x),0),usd=t=>Math.max(0,t.usd??0);
const share=xs=>{const total=sum(xs,usd);return total?sum(xs.filter(t=>t.side==='buy'),usd)/total:null;};
function tapeMetrics(tape,now){
  const last=tape.at(-1),a5=asOf(tape,now-5000,'observedAt'),a2=asOf(tape,now-2000,'observedAt');
  const x20=tape.filter(t=>t.observedAt>now-20000),x10=x20.filter(t=>t.observedAt>now-10000),x5=x10.filter(t=>t.observedAt>now-5000),x2=x5.filter(t=>t.observedAt>now-2000);
  const bs=x5.filter(t=>t.side==='buy'),volumes=new Map();for(const t of bs)if(t.wallet)volumes.set(t.wallet,(volumes.get(t.wallet)??0)+usd(t));
  let peak10=-Infinity,trough10=Infinity,peakAt=null,troughAt=null;
  for(const t of x10){if(t.priceUsd>peak10){peak10=t.priceUsd;peakAt=t.observedAt;}if(t.priceUsd<trough10){trough10=t.priceUsd;troughAt=t.observedAt;}}
  const buyUsd=sum(bs,usd),total5=sum(x5,usd),price=last?.priceUsd??null;
  const peak5=Math.max(price??0,...x5.map(t=>t.priceUsd));
  return {price,priceAt:last?.observedAt??0,tickId:last?.id??'',historySec:last?(now-tape[0].observedAt)/1000:0,
    ready:!!last&&now-last.observedAt<=750&&!!a5&&now-5000-a5.observedAt<=2000&&new Set(x5.map(t=>Math.floor(t.observedAt/1000))).size>=4,
    return5:a5?(price/a5.priceUsd-1)*100:null,return2:a2&&now-2000-a2.observedAt<=2000?(price/a2.priceUsd-1)*100:null,
    drawdown5:peak5>0?(1-price/peak5)*100:100,drawdown10:peak10>0?(1-price/peak10)*100:100,
    rebound10:trough10>0?(price/trough10-1)*100:0,peakBeforeTrough:peakAt!==null&&troughAt!==null&&peakAt<troughAt,
    aboveWeightedPrice:total5>0&&price>=sum(x5,t=>t.priceUsd*usd(t))/total5,
    buy5:share(x5),buy2:share(x2),buy10:share(x10),buy20:share(x20),buyers:volumes.size,trades:x5.length,buyUsd,
    topBuyer:buyUsd>0?Math.max(0,...volumes.values())/buyUsd:null,
    sellUsd:sum(x5.filter(t=>t.side==='sell'),usd),sellers:new Set(x5.filter(t=>t.side==='sell'&&t.wallet).map(t=>t.wallet)).size,
    collapse1s:(()=>{const p=asOf(tape,now-1000,'observedAt');return p&&now-1000-p.observedAt<=1000?(price/p.priceUsd-1)*100:null;})()};
}
export function prepareFlowWaveSession(data,s,globalSol){
  const d=data.tokens[s.mint],ticks=receivedTicks(d,s),fields=name=>d.fields.filter(f=>f.name===name);
  const created=fields('createdAt'),mcs=fields('marketCapUsd'),prices=fields('priceUsd'),counts=fields('holders');
  const frames=[],signals=[],arms=new Map(),signaled=new Set(),tape=[];
  let ti=0;
  const end=Math.min(s.end,s.start+180000);
  for(let now=s.start;now<=end;now+=250){
    while(ti<ticks.length&&ticks[ti].observedAt<=now)tape.push(ticks[ti++]);
    if(!tape.length)continue;
    const m=tapeMetrics(tape,now),h=asOf(d.holders,now),dev=asOf(d.dev,now),stat=asOf(d.stats,now),c=asOf(created,now);
    const devWallets=new Set(dev?.owners.map(o=>o.wallet)??[]);
    const devSell30=sum(tape.filter(t=>t.observedAt>now-30000&&t.side==='sell'&&devWallets.has(t.wallet)),usd);
    const screenMc=asOf(mcs,now),screenPrice=asOf(prices,now),screenCount=asOf(counts,now);
    const fallbackSupply=screenMc?.value>0&&screenPrice?.value>0&&Math.abs(screenMc.at-screenPrice.at)<=1000?screenMc.value/screenPrice.value:null;
    const supply=h?.supplyEstimate??fallbackSupply;
    const count=stat?.status===200?stat.count:screenCount?.value;
    const countAt=stat?.status===200?stat.at:screenCount?.at;
    const majorSell=knownMajorSell(d,tape,now);
    const f={...m,at:now,mc:supply>0?supply*m.price:null,top1:h?.top1??null,top5:h?.top5??null,
      dev:dev?.status===200?Math.max(h?.devPercent??0,sum(dev.owners,o=>o.percent??0)):null,
      holders:count??null,tokenAgeSec:c?.value>0?(now-c.value)/1000:null,
      holderFresh:h?.status===200&&!h.incomplete&&now-h.at<=30000,
      devFresh:dev?.status===200&&dev.owners.every(o=>o.percent!==null)&&now-dev.at<=60000,
      countFresh:countAt!=null&&now-countAt<=30000,majorSell,devSell30};
    frames.push(f);
    if(now>s.start+60000)continue;
    for(const profile of FLOW_WAVE_ENTRIES){
      if(signaled.has(profile.id))continue;
      const allowed=flowWaveEntryAllowed(f,profile);
      const result=confirmCodexSetup(arms.get(profile.id)??null,allowed,now,m.price,m.tickId);
      arms.set(profile.id,result.arm);
      if(result.confirmed){
        const spot=asOf(globalSol,now),solKnown=spot&&now-spot.at<=120000;
        signaled.add(profile.id);signals.push({id:`${s.id}:${profile.id}`,sessionId:s.id,mint:s.mint,symbol:s.symbol,
          source:s.source,entryProfile:profile.id,at:now,price:m.price,solUsd:solKnown?spot.usd:120,solAssumed:!solKnown,
          features:{return5:m.return5,return2:m.return2,flow5:m.buy5,flow10:m.buy10,flow20:m.buy20,top1:f.top1,top5:f.top5,dev:f.dev,
            buyers:m.buyers,buyUsd:m.buyUsd,mc:f.mc,age:f.tokenAgeSec,drawdown5:m.drawdown5,rebound10:m.rebound10,
            holderAge:now-h.at,devAge:now-dev.at}});
      }
    }
  }
  return {ticks,frames,signals,end};
}
export function replayFlowWave(signal,prepared,rule,{stakeUsd=.5,delayMs=1000,feeSide=.01,networkSol=.000205,buyPriceCap=.02,sellOutputCap=.05}={}){
  const base={stakeUsd,delayMs,exitProfile:rule.id};
  const priceNow=signal.price,sol=signal.solUsd,immediate=flowWaveNetReturn(stakeUsd,sol,priceNow,priceNow,feeSide,networkSol);
  if(immediate<=-rule.maxNetRisk)return {...base,status:'REJECTED_COST',at:signal.at,pnl:0,ret:null};
  const buy=firstAfter(prepared.ticks,signal.at+delayMs,Math.min(prepared.end,signal.at+delayMs+2000));
  if(!buy)return {...base,status:'BUY_UNKNOWN',at:null,pnl:null,ret:null};
  if(buy.priceUsd>priceNow*(1+buyPriceCap))return {...base,status:'BUY_FAILED',at:buy.observedAt,pnl:-.000105*sol,ret:null};
  const opened={...base,buyAt:buy.observedAt,buyPrice:buy.priceUsd,initialNet:immediate};
  const retAt=price=>flowWaveNetReturn(stakeUsd,sol,buy.priceUsd,price,feeSide,networkSol);
  const netFloor=flowWaveNetFloor(immediate,rule);
  let peak=immediate,floor=null,lastBreach=null,lastTick=null,request=null;
  for(const f of prepared.frames){
    if(f.at<buy.observedAt)continue;
    const net=retAt(f.price),socket=(f.price/buy.priceUsd-1)*100,held=(f.at-buy.observedAt)/1000;
    peak=Math.max(peak,net);let reason=null;
    // A holder's partial profit-taking is not itself proof of a rug. A dev sale or
    // weakening price confirms urgency; an actual rapid price collapse remains immediate.
    if((f.majorSell&&((f.return2??0)<=0||f.devSell30>=25))||(f.collapse1s!==null&&f.collapse1s<=-8))reason='DUMP_OR_FLASH';
    // This archive contains trade receipts, not a reliable connection-health log.
    // Two seconds without swaps must not be mislabeled as a disconnected socket.
    else if(f.at-f.priceAt>10000)reason='PRICE_GAP_10S';
    else if(net<=netFloor||socket<=-rule.priceStop)reason='HARD_RISK';
    const broken=f.buy5!==null&&f.buy5<=.35&&f.sellUsd>=150&&f.sellers>=3&&(f.return2??0)<0;
    if(!broken)lastBreach=null;
    else if(f.tickId!==lastTick){if(lastBreach!==null&&f.at-lastBreach<=500)reason??='FLOW_BROKEN';lastBreach=f.at;}
    lastTick=f.tickId;
    if(peak>=rule.floorActivation)floor=Math.max(floor??-Infinity,1);
    if(peak>=rule.runnerActivation)floor=Math.max(floor??-Infinity,2,(100+peak)*(1-rule.trailNet/100)-100);
    if(floor!==null&&net<=floor)reason??='NET_TRAIL';
    if(net>=rule.targetNet&&((f.buy5??0)<.7||(f.return2??0)<=0))reason??='TARGET_FLOW_WEAK';
    if(held>=rule.stagnationSec&&peak<2&&((f.buy5??0)<.6||(f.return2??0)<=0))reason??='STAGNATION';
    if(held>=rule.maxHoldSec)reason??='TIME_LIMIT';
    if(reason){request={at:f.at,price:f.price,reason,net};break;}
  }
  if(!request)return {...opened,status:'SELL_UNKNOWN',at:null,pnl:null,ret:null,reason:'CAPTURE_END'};
  const exit={...opened,reason:request.reason,exitSignalAt:request.at,exitSignalReturn:request.net};
  let at=request.at,failed=0;
  while(failed<3){
    const sell=firstAfter(prepared.ticks,at+delayMs,Math.min(prepared.end,at+delayMs+2000));
    if(!sell)return {...exit,status:'SELL_UNKNOWN',at:null,pnl:null,ret:null,failedSell:failed};
    const p=asOf(prepared.ticks,at,'observedAt')?.priceUsd??request.price;
    if(sell.priceUsd<p*(1-sellOutputCap)){failed++;at=sell.observedAt;continue;}
    const cost=stakeUsd+networkSol*sol,ret=retAt(sell.priceUsd)-failed*.000105*sol/cost*100;
    return {...exit,status:'CLOSED',at:sell.observedAt,sellPrice:sell.priceUsd,pnl:cost*ret/100,ret,failedSell:failed,peakNet:peak};
  }
  return {...exit,status:'SELL_UNKNOWN',at:null,pnl:null,ret:null,failedSell:failed};
}
export function replayFlowWaveSession(data,s,globalSol){
  const prepared=prepareFlowWaveSession(data,s,globalSol);
  return prepared.signals.map(signal=>({...signal,outcomes:FLOW_WAVE_EXITS.flatMap(rule=>[.5,10].flatMap(stakeUsd=>[1000,2000].map(delayMs=>
    replayFlowWave(signal,prepared,rule,{stakeUsd,delayMs}))))}));
}
