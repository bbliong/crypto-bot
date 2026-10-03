// Run with: node --import tsx scripts/replay-guarded-wave-day.mjs
// Full-day candidate replay, as-of observations only. No network or live trading.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { momentumMetrics, cleanTape } from '../src/momentum-strategy.ts';
import { INITIAL, valid, asOf, firstAfter, immediateNetReturn, makeFill, netReturn, exitReason, portfolio } from './guarded-wave-replay-core.mjs';

const root = resolve(import.meta.dirname, '..');
const input = JSON.parse(readFileSync(resolve(root, 'reports/guarded-wave-input-2026-10-02.json')));
const globalSol = Object.values(input.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
const solAt = now => asOf(globalSol,now);
const round = x => valid(x) ? Math.round(x * 10000) / 10000 : null;
const countBy = (rows,f) => rows.reduce((out,r)=>{const k=f(r);out[k]=(out[k]??0)+1;return out;},{});
const eligible = [], visitResults = [], checkpoints = {};
const bump = k => { checkpoints[k]=(checkpoints[k]??0)+1; };
const strictMissing = ['historical_onchain_mint_authorities', 'verified_pool_reserves', 'quote_context_slot_and_min_output', 'actual_fill_and_fee_receipts'];

function fieldAt(d,name,now) { return asOf(d.fields.filter(f=>f.name===name),now); }
function context(d,s,tape,now) {
  const m = momentumMetrics(tape,now), h = asOf(d.holders,now), dev = asOf(d.dev,now), stat = asOf(d.stats,now), candle = asOf(d.candles,now);
  const clean = cleanTape(tape,now,20000);
  const buy20=clean.filter(t=>t.side==='buy').reduce((n,t)=>n+(t.usd>0?t.usd:0),0);
  const sell20=clean.filter(t=>t.side==='sell').reduce((n,t)=>n+(t.usd>0?t.usd:0),0);
  const flow20=buy20+sell20>0?buy20/(buy20+sell20):null;
  const created=fieldAt(d,'createdAt',now);
  const age=created&&valid(created.value)?(now-created.value)/1000:null;
  const devPct=dev?.status===200?Math.max(h?.devPercent??0,dev.owners.reduce((n,o)=>n+(valid(o.percent)?o.percent:0),0)):null;
  const mc=h?.supplyEstimate>0&&m.priceUsd>0?h.supplyEstimate*m.priceUsd:null;
  const devWallets = new Set(dev?.owners.map(o=>o.wallet)??[]);
  const devSell30=tape.filter(t=>t.observedAt>=now-30000&&t.observedAt<=now&&t.side==='sell'&&devWallets.has(t.wallet)).reduce((n,t)=>n+(t.usd>0?t.usd:0),0);
  let reason=null;
  if (!m.ready || now-(tape[0]?.observedAt??now)<20000) reason='HISTORY_LT_20S';
  else if (now-(m.priceAt??0)>750) reason='SOCKET_STALE';
  else if (age===null||age<60) reason='AGE_LT_60S_OR_UNKNOWN';
  else if (!h||h.status!==200||h.incomplete||now-h.at>10000) reason='HOLDER_MISSING_OR_STALE';
  else if (!dev||dev.status!==200||now-dev.at>10000||dev.owners.some(o=>!valid(o.percent))) reason='DEV_MISSING_OR_STALE';
  else if (!stat||stat.status!==200||!valid(stat.count)||now-stat.at>10000||stat.count<100) reason='HOLDER_COUNT_LT_100_OR_STALE';
  else if (!valid(mc)||mc<10000||mc>100000) reason='MC_OUTSIDE_10K_100K_OR_UNKNOWN';
  else if (h.top1>8||h.top5>25||devPct>2.5) reason='DISTRIBUTION_RISK';
  else if (m.return5s<.25||m.return5s>20||(m.slope5s??0)<=0||m.drawdown5s>2.5) reason='MOMENTUM_OR_PULLBACK';
  else if (m.trades<5||m.buyers<4||m.buyUsd<300||(m.topBuyerShare??1)>.5||(m.buyShare??0)<.6||(flow20??0)<.65) reason='FLOW_OR_BUYERS';
  else if (devSell30>=25) reason='DEV_SELL_BEFORE_ENTRY';
  else if (dumpFromKnownOwners(d,tape,now)) reason='MAJOR_SELL_BEFORE_ENTRY';
  else if (!candle||candle.status!==200||!candle.last||now-candle.at>15000||Math.floor(candle.last.time/60000)!==Math.floor(now/60000)||candle.last.close<candle.last.open) reason='CURRENT_CANDLE_RED_OR_UNKNOWN';
  const sol=solAt(now);
  if (!reason&&(!sol||now-sol.at>120000)) reason='SOL_SPOT_MISSING_OR_STALE';
  return {reason,m,h,dev,flow20,mc,age,devPct,sol};
}
for (const s of input.sessions) {
  const d=input.tokens[s.mint], ticks=d.ticks.filter(t=>t.observedAt>=s.start&&t.observedAt<=s.end);
  const rejected={}, passed=[], confirmed=[];
  let armed=null,lastEvent=-Infinity;
  const tape=[];
  for(const t of ticks) {
    if(t.observedAt>=input.end)break;
    // Individual tick clocks are checked before updating replay prices.
    if(t.observedAt-t.occurredAt>2000||t.occurredAt>t.observedAt+3000||t.occurredAt<lastEvent)continue;
    lastEvent=t.occurredAt;tape.push(t);
    const c=context(d,s,tape,t.observedAt);
    if(c.reason){rejected[c.reason]=(rejected[c.reason]??0)+1;armed=null;continue;}
    passed.push(t.observedAt);
    if(!armed||t.observedAt-armed.at>1000||Math.abs(t.priceUsd/armed.price-1)>.02){armed={at:t.observedAt,price:t.priceUsd,id:t.id};continue;}
    const gap=t.observedAt-armed.at;
    if(gap>500){armed={at:t.observedAt,price:t.priceUsd,id:t.id};continue;}
    if(gap<150||t.id===armed.id)continue;
    confirmed.push({at:t.observedAt,price:t.priceUsd,armAt:armed.at,solUsd:c.sol.usd,
      metrics:{...c.m,flow20:c.flow20,mcEstimate:c.mc,top1:c.h.top1,top5:c.h.top5,dev:c.devPct,tokenAgeSec:c.age},
      holderAt:c.h.at,devAt:c.dev.at});
    armed=null;
  }
  const first=confirmed[0];
  visitResults.push({id:s.id,mint:s.mint,symbol:s.symbol,start:s.start,end:s.end,reason:s.reason,
    tickCount:ticks.length,gatePassedTicks:passed.length,confirmations:confirmed.length,
    firstGateAt:passed[0]??null,firstSignalAt:first?.at??null,rejected});
  for(const confirmation of confirmed)eligible.push({...confirmation,session:s,token:d});
  for(const k of Object.keys(rejected))bump(k);
}

function dumpFromKnownOwners(d,tape,now) {
  const groups=new Map();
  for(const t of tape.filter(t=>t.side==='sell'&&t.observedAt>now-5000&&t.observedAt<=now)) {
    if(!groups.has(t.wallet))groups.set(t.wallet,[]);groups.get(t.wallet).push(t);
  }
  for(const[wallet,xs]of groups){
    const before=xs[0].observedAt-1,h=asOf(d.holders,before),dev=asOf(d.dev,before);
    const owner=h&&before-h.at<=30000?h.owners.find(o=>o.wallet===wallet):null;
    const developer=dev&&before-dev.at<=30000?dev.owners.find(o=>o.wallet===wallet):null;
    const usd=xs.reduce((n,t)=>n+(t.usd>0?t.usd:0),0),tokens=xs.reduce((n,t)=>n+(t.tokens>0?t.tokens:0),0);
    if(usd>=25&&((developer?.amount>0&&tokens/developer.amount>=.05)||(owner?.amount>0&&owner.percent>=1.5&&tokens/owner.amount>=.2)))return true;
  }
  return false;
}
function replayOne(signal,stakeUsd,{costGate=true,latencyMs=1000,allowUnboundedSell=false}={}) {
  const {session:s,token:d}=signal,settings={...INITIAL,latencyMs};
  const base={sessionId:s.id,mint:s.mint,symbol:s.symbol,signalAt:signal.at,stakeUsd,metrics:signal.metrics,
    knownMissing:strictMissing,expectedImmediateNetPercent:immediateNetReturn(stakeUsd,signal.solUsd,settings)};
  base.minimumOutputStressPercent=(100+base.expectedImmediateNetPercent)*.99*.98-100;
  if(costGate&&(base.expectedImmediateNetPercent < -3 || base.minimumOutputStressPercent < -6)) return {...base,status:'REJECTED_COST',resolvedAt:signal.at,pnlUsd:0};
  const ticks=d.ticks.filter(t=>t.observedAt>=s.start&&t.observedAt<=s.end);
  const fill=firstAfter(ticks,signal.at+latencyMs,Math.min(s.end,signal.at+latencyMs+settings.maxFillWaitMs));
  if(!fill)return {...base,status:'BUY_UNRESOLVED',resolvedAt:null,pnlUsd:null};
  const fillSol=solAt(fill.observedAt)?.usd??signal.solUsd;
  if(fill.priceUsd>signal.price*(1+settings.buySlippageCap))return {...base,status:'BUY_SLIPPAGE_FAILED',resolvedAt:fill.observedAt,pnlUsd:-settings.failedFeeSol*fillSol};
  const p=makeFill(stakeUsd,fillSol,fill.priceUsd,fill.observedAt,settings);
  const timeline=[...new Set([...ticks.filter(t=>t.observedAt>=fill.observedAt).map(t=>t.observedAt),
    ...Array.from({length:Math.max(0,Math.floor((s.end-fill.observedAt)/250)+1)},(_,i)=>fill.observedAt+i*250)])].sort((a,b)=>a-b);
  const seen=[];let ti=0,lastId=null,lastEvent=-Infinity,decision=null;
  for(const now of timeline){
    let isNew=false;
    while(ti<ticks.length&&ticks[ti].observedAt<=now){const t=ticks[ti++];
      if(t.observedAt-t.occurredAt>2000||t.occurredAt<lastEvent||t.occurredAt>t.observedAt+3000)continue;
      lastEvent=t.occurredAt;seen.push(t);isNew=true;
    }
    const t=seen.at(-1);if(!t)continue;
    const m=momentumMetrics(seen,now),sol=solAt(now)?.usd??fillSol;
    const previous=asOf(seen,now-1000,'observedAt');
    const collapse=previous?(t.priceUsd/previous.priceUsd-1)*100:null;
    const reason=exitReason(p,{now,priceUsd:t.priceUsd,solUsd:sol,metrics:m,
      stale:now-t.observedAt>2000,majorSell:dumpFromKnownOwners(d,seen,now),collapse1s:collapse,
      tickId:t.id,newTick:isNew&&t.id!==lastId});lastId=t.id;
    if(reason){decision={at:now,reason,price:t.priceUsd,return:netReturn(p,t.priceUsd,sol)};break;}
  }
  if(!decision)return {...base,status:'EXIT_UNRESOLVED',buyAt:fill.observedAt,buyPrice:fill.priceUsd,resolvedAt:null,pnlUsd:null,reason:'CAPTURE_ENDED_BEFORE_EXIT'};
  let requestAt=decision.at,attempts=0,failedFees=0;
  while(attempts<3){
    const sell=firstAfter(ticks,requestAt+latencyMs,Math.min(s.end,requestAt+latencyMs+settings.maxFillWaitMs));
    if(!sell)return {...base,status:'EXIT_UNRESOLVED',buyAt:fill.observedAt,buyPrice:fill.priceUsd,reason:decision.reason,
      exitSignalAt:decision.at,exitSignalReturn:decision.return,resolvedAt:null,pnlUsd:null,failedSellAttempts:attempts};
    // Each retry uses information at its new request time, not the future fill price.
    const requestPrice=asOf(ticks,requestAt,'observedAt')?.priceUsd??decision.price;
    if(!allowUnboundedSell&&sell.priceUsd<requestPrice*(1-settings.sellSlippageCap)){
      failedFees+=settings.failedFeeSol;attempts++;requestAt=sell.observedAt;continue;
    }
    const sellSol=solAt(sell.observedAt)?.usd??fillSol;
    const ret=netReturn(p,sell.priceUsd,sellSol)-failedFees/p.buyCostSol*100;
    const pnlSol=p.buyCostSol*ret/100;
    return {...base,status:'CLOSED',buyAt:fill.observedAt,buyPrice:fill.priceUsd,exitSignalAt:decision.at,
      exitSignalReturn:decision.return,reason:decision.reason,sellAt:sell.observedAt,sellPrice:sell.priceUsd,
      resolvedAt:sell.observedAt,returnPercent:ret,pnlUsd:pnlSol*sellSol,peakNet:p.peak,failedSellAttempts:attempts,
      heldSec:(sell.observedAt-fill.observedAt)/1000};
  }
  return {...base,status:'EXIT_UNRESOLVED',buyAt:fill.observedAt,reason:decision.reason,exitSignalAt:decision.at,
    exitSignalReturn:decision.return,resolvedAt:null,pnlUsd:null,failedSellAttempts:attempts};
}
function summarize(rs){
  const closed=rs.filter(r=>r.status==='CLOSED'),xs=closed.map(r=>r.returnPercent);
  return {candidates:rs.length,bought:rs.filter(r=>r.buyAt!=null).length,closed:closed.length,
    wins:xs.filter(x=>x>0).length,losses:xs.filter(x=>x<0).length,flat:xs.filter(x=>x===0).length,
    unresolved:rs.filter(r=>r.status.includes('UNRESOLVED')).length,
    buyFailed:rs.filter(r=>r.status==='BUY_SLIPPAGE_FAILED').length,costRejected:rs.filter(r=>r.status==='REJECTED_COST').length,
    knownPnlUsd:round(rs.reduce((n,r)=>n+(valid(r.pnlUsd)?r.pnlUsd:0),0)),
    meanReturn:round(xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null),worstReturn:xs.length?round(Math.min(...xs)):null,
    statuses:countBy(rs,r=>r.status),exitReasons:countBy(rs.filter(r=>r.reason),r=>r.reason)};
}
const scenarios={};
for(const[name,stake,options]of [
  ['configured_0_50_cost_guard',.5,{costGate:true}],
  ['diagnostic_0_50_force_entry',.5,{costGate:false}],
  ['diagnostic_10_00_cost_guard',10,{costGate:true}],
  ['diagnostic_10_00_delay_2s',10,{costGate:true,latencyMs:2000}],
]){
  const outcomes=eligible.map(s=>replayOne(s,stake,options));
  const p=portfolio(outcomes.filter(r=>r.status!=='REJECTED_COST'),stake,input.end);
  scenarios[name]={stakeUsd:stake,options,independentCandidateResults:summarize(outcomes),
    portfolio:{...p,summary:summarize(p.selected)},outcomes};
}
const gateCandidates=eligible.map(({token:d,session:s,...r})=>{
  const qs=d.quotes.filter(q=>q.at<=r.at&&r.at-q.at<=750);
  const buy=qs.filter(q=>q.type==='QUOTE_BUY_COMPARISON');
  const paired=buy.filter(b=>qs.some(q=>(q.type==='PERIODIC_SELL_ROUTE_QUOTE'||q.type==='QUOTE_SELL_COMPARISON')&&(q.input??q.inAmount)===b.outAmount));
  const future=d.ticks.filter(t=>t.observedAt>=r.at&&t.observedAt<=Math.min(s.end,r.at+20000));
  const worst=future.length?Math.min(...future.map(t=>(t.priceUsd/r.price-1)*100)):null;
  return {...r,sessionId:s.id,mint:s.mint,symbol:s.symbol,asOfBuyQuote:buy.length,asOfRoundTripQuote:paired.length,
    observedPostSignalSec:((future.at(-1)?.observedAt??r.at)-r.at)/1000,worstReturnNext20s:worst};
});
const crashVisits=[];
for(const s of input.sessions){
  const ticks=input.tokens[s.mint].ticks.filter(t=>t.observedAt>=s.start&&t.observedAt<=Math.min(s.end,s.start+90000));
  const window=[];let lastEvent=-Infinity,hit=null;
  for(const t of ticks){
    if(t.observedAt-t.occurredAt>2000||t.occurredAt>t.observedAt+3000||t.occurredAt<lastEvent)continue;
    lastEvent=t.occurredAt;
    while(window.length&&window[0].observedAt<t.observedAt-10000)window.shift();
    const peak=window.length?Math.max(...window.map(x=>x.priceUsd)):t.priceUsd;
    const drawdown=(t.priceUsd/peak-1)*100;
    if(drawdown<=-30){hit={at:t.observedAt,drawdown};break;}
    window.push(t);
  }
  if(hit)crashVisits.push({sessionId:s.id,mint:s.mint,symbol:s.symbol,at:hit.at,drawdown:hit.drawdown,
    signalBeforeCrash:gateCandidates.some(g=>g.sessionId===s.id&&g.at<=hit.at),
    source:s.source,label:'OBSERVED_FAST_CRASH_30PCT_WITHIN_10S_NOT_CONFIRMED_RUGPULL'});
}
const result={generatedAt:new Date().toISOString(),dateWib:'2026-10-02',start:input.start,end:input.end,coverage:input.counts,
  strictReplay:{accepted:0,wins:0,losses:0,conclusion:'Not executable from archived evidence; missing hard-gate and fill evidence is NOT a strategy success.',missing:strictMissing},
  measurableEntry:{visits:visitResults.length,passedEntryAtLeastOnce:visitResults.filter(r=>r.gatePassedTicks).length,
    confirmedVisits:new Set(eligible.map(r=>r.session.id)).size,confirmedSignals:eligible.length,confirmedMints:new Set(eligible.map(r=>r.session.mint)).size,
    withAsOfBuyQuote:gateCandidates.filter(r=>r.asOfBuyQuote).length,withAsOfRoundTripQuote:gateCandidates.filter(r=>r.asOfRoundTripQuote).length,
    rejectionVisitCounts:checkpoints},
  model:{...INITIAL,priceSource:'First fresh received socket tick after order delay; price gaps are not clamped at stop.',
    labels:'ALL diagnostic win/loss values are model estimates, not observed swap fills or validated full Guarded Wave performance.',
    optimisticCostCaveat:'1% GMGN per side plus configured priority/tip/base; additional DEX/creator fees, ATA rent and adverse market impact unknown and not included.',
    supply:'Inferred from contemporaneous holder amount / supply percentage; not verified on-chain.',
    unknownRulesNotApplied:strictMissing,quoteUse:'Coverage audit only. Quotes for a different position/quantity/time are not substituted as fills.',
    candleFreshnessMs:15000,solSpotFreshnessMs:120000,capital:'Diagnostic equity = 100 × stake, no live wallet queried.',
    observation:'Sessions opened during the day are eligible. No entry after day end. Holdings may finish only if captured data exists; no synthetic 90-second completion.',
    errorPolicy:'Failed sells retry at most three times within captured data; unresolved positions block later portfolio entries. A known failed buy may retry only at a later qualified signal after failure receipt.',
    entryMajorSellLookbackMs:5000},
  crashAudit:{definition:'Observed fresh socket price drop >=30% from a peak in the previous 10s during the first 90s of a detail visit; not an on-chain rugpull label.',
    visits:crashVisits.length,uniqueMints:new Set(crashVisits.map(r=>r.mint)).size,
    signalsBeforeCrash:crashVisits.filter(r=>r.signalBeforeCrash).length,examples:crashVisits.slice(0,10)},
  scenarios,gateCandidates,visitResults,crashVisits};
writeFileSync(resolve(root,'reports/guarded-wave-replay-2026-10-02.json'),JSON.stringify(result,null,2)+'\n');
const summary={dateWib:result.dateWib,coverage:result.coverage,measurableEntry:result.measurableEntry,strictReplay:result.strictReplay,
  model:result.model,crashAudit:result.crashAudit,scenarios:Object.fromEntries(Object.entries(scenarios).map(([k,v])=>[k,{independent:v.independentCandidateResults,portfolio:v.portfolio.summary,skipped:v.portfolio.skipped}]))};
writeFileSync(resolve(root,'reports/guarded-wave-replay-summary-2026-10-02.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary));
