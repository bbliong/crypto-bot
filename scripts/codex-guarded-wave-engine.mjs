// Offline data adapter and execution model for the Codex lane. No network or order APIs.
import { momentumMetrics, cleanTape } from '../src/momentum-strategy.ts';
import { CODEX_ENTRY_PROFILES, assessCodexSetup, confirmCodexSetup, codexExitState, assessCodexExit } from '../src/codex-guarded-wave.ts';
import { asOf, firstAfter, INITIAL, immediateNetReturn, makeFill, netReturn, portfolio } from './guarded-wave-replay-core.mjs';
export const MISSING_EXECUTION_EVIDENCE = ['historical_mint_authority', 'verified_pool_reserves_and_supply',
  'quote_slot_minimum_output_exact_quantity', 'transaction_simulation_and_receipts', 'gap_reconnect_recovery'];
const good = x => typeof x === 'number' && Number.isFinite(x);
export function receivedTicks(d,s) {
  let lastEvent=-Infinity;
  return d.ticks.filter(t=> {
    if(t.observedAt<s.start||t.observedAt>s.end||!(t.priceUsd>0)||!good(t.occurredAt)||
      t.observedAt-t.occurredAt>2000||t.occurredAt>t.observedAt+3000||t.occurredAt<lastEvent)return false;
    lastEvent=t.occurredAt;return true;
  });
}
export function knownMajorSell(d,tape,now) {
  const groups=new Map();
  for(const t of tape)if(t.side==='sell'&&t.observedAt>now-5000&&t.observedAt<=now&&t.wallet){
    if(!groups.has(t.wallet))groups.set(t.wallet,[]);groups.get(t.wallet).push(t);
  }
  for(const[wallet,xs]of groups){
    const before=xs[0].observedAt-1,h=asOf(d.holders,before),dev=asOf(d.dev,before);
    const owner=h?.status===200&&before-h.at<=30000?h.owners.find(o=>o.wallet===wallet):null;
    const developer=dev?.status===200&&before-dev.at<=30000?dev.owners.find(o=>o.wallet===wallet):null;
    const usd=xs.reduce((n,t)=>n+Math.max(0,t.usd??0),0),tokens=xs.reduce((n,t)=>n+Math.max(0,t.tokens??0),0);
    if(usd>=25&&((developer?.amount>0&&tokens/developer.amount>=.05)||
      (owner?.amount>0&&owner.percent>=1.5&&tokens/owner.amount>=.2)))return true;
  }
  return false;
}
export function prepareResearch(input) {
  const sol=Object.values(input.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
  const solAt=t=>asOf(sol,t);
  const sessions=input.sessions.map(s=>({...s,ticks:receivedTicks(input.tokens[s.mint],s)}));
  const signals=Object.fromEntries(CODEX_ENTRY_PROFILES.map(p=>[p.id,[]]));
  const universe=new Map();
  for(const s of sessions){
    const d=input.tokens[s.mint],createdFields=d.fields.filter(f=>f.name==='createdAt');
    const arms=new Map(),tape=[];
    universe.set(s.id,s);
    for(const t of s.ticks){
      const now=t.observedAt;if(now>=input.end)break;
      tape.push(t);
      if(now-tape[0].observedAt<20000)continue;
      const m=momentumMetrics(tape,now),h=asOf(d.holders,now),dev=asOf(d.dev,now),stat=asOf(d.stats,now),candle=asOf(d.candles,now);
      const created=asOf(createdFields,now),spot=solAt(now),clean=cleanTape(tape,now,20000);
      const buy20=clean.filter(t=>t.side==='buy').reduce((n,t)=>n+Math.max(0,t.usd??0),0);
      const all20=clean.reduce((n,t)=>n+Math.max(0,t.usd??0),0);
      const devWallets=new Set(dev?.owners.map(o=>o.wallet)??[]);
      const devSell=tape.filter(t=>t.observedAt>=now-30000&&t.side==='sell'&&devWallets.has(t.wallet)).reduce((n,t)=>n+Math.max(0,t.usd??0),0);
      const f={at:now,price:m.priceUsd,ready:m.ready,historyMs:now-tape[0].observedAt,socketAgeMs:now-(m.priceAt??0),
        tokenAgeSec:created&&good(created.value)?(now-created.value)/1000:null,
        holderAgeMs:h?now-h.at:null,devAgeMs:dev?now-dev.at:null,countAgeMs:stat?now-stat.at:null,
        holderValid:h?.status===200&&!h.incomplete,devValid:dev?.status===200&&dev.owners.every(o=>good(o.percent)),
        count:stat?.status===200?stat.count:null,mc:h?.supplyEstimate>0?h.supplyEstimate*m.priceUsd:null,
        top1:h?.top1??null,top5:h?.top5??null,dev:dev?.status===200?Math.max(h?.devPercent??0,dev.owners.reduce((n,o)=>n+(o.percent??0),0)):null,
        return5:m.return5s,slope5:m.slope5s,drawdown5:m.drawdown5s,trades5:m.trades,buyers5:m.buyers,buyUsd5:m.buyUsd,
        topBuyerShare:m.topBuyerShare,buyShare5:m.buyShare,buyShare20:all20>0?buy20/all20:null,
        devSell30:devSell,majorSell:knownMajorSell(d,tape,now),
        candleValid:candle?.status===200&&!!candle.last&&now-candle.at<=15000&&
          Math.floor(candle.last.time/60000)===Math.floor(now/60000)&&candle.last.close>=candle.last.open,
        solUsd:spot?.usd??null,solAgeMs:spot?now-spot.at:null};
      for(const r of CODEX_ENTRY_PROFILES){
        const allowed=assessCodexSetup(f,r).allowed;
        const confirmation=confirmCodexSetup(arms.get(r.id)??null,allowed,now,t.priceUsd,t.id);
        arms.set(r.id,confirmation.arm);
        if(confirmation.confirmed)signals[r.id].push({sessionId:s.id,mint:s.mint,symbol:s.symbol,signalAt:now,
          price:t.priceUsd,solUsd:spot.usd,features:f});
      }
    }
  }
  return {input,signals,universe,solAt};
}
export function replayCodexSignal(env,signal,exitRules,options={}) {
  const settings={...INITIAL,...options},stakeUsd=options.stakeUsd??.5;
  const s=env.universe.get(signal.sessionId),d=env.input.tokens[s.mint];
  const captureEnd=Math.min(s.end,options.observationEnd??s.end),ticks=s.ticks.filter(t=>t.observedAt<=captureEnd);
  const cost=immediateNetReturn(stakeUsd,signal.solUsd,settings);
  const base={sessionId:s.id,mint:s.mint,symbol:s.symbol,signalAt:signal.signalAt,stakeUsd,
    immediateReturn:cost,modelOnly:true,missingEvidence:MISSING_EXECUTION_EVIDENCE};
  if(options.costGate!==false&&(cost < -3 || (100+cost)*.99*.98-100 < -6))
    return {...base,status:'REJECTED_COST',resolvedAt:signal.signalAt,pnlUsd:0};
  const delayed=signal.signalAt+settings.latencyMs;
  const fill=firstAfter(ticks,delayed,Math.min(captureEnd,delayed+settings.maxFillWaitMs));
  if(!fill)return {...base,status:'BUY_UNRESOLVED',pnlUsd:null,resolvedAt:null};
  const fillSol=env.solAt(fill.observedAt)?.usd??signal.solUsd;
  if(fill.priceUsd>signal.price*(1+settings.buySlippageCap))
    return {...base,status:'BUY_SLIPPAGE_FAILED',resolvedAt:fill.observedAt,pnlUsd:-settings.failedFeeSol*fillSol};
  const p=makeFill(stakeUsd,fillSol,fill.priceUsd,fill.observedAt,settings),state=codexExitState(fill.observedAt);
  const opened={...base,buyAt:fill.observedAt,buyPrice:fill.priceUsd};
  const timeline=[...new Set([...ticks.filter(t=>t.observedAt>=fill.observedAt).map(t=>t.observedAt),
    ...Array.from({length:Math.max(0,Math.floor((captureEnd-fill.observedAt)/250)+1)},(_,i)=>fill.observedAt+i*250)])].sort((a,b)=>a-b);
  let i=0,lastId=null,decision=null;const tape=[];
  for(const now of timeline){
    let isNew=false;while(i<ticks.length&&ticks[i].observedAt<=now){tape.push(ticks[i++]);isNew=true;}
    const t=tape.at(-1);if(!t)continue;
    const m=momentumMetrics(tape,now),spot=env.solAt(now)?.usd??fillSol,previous=asOf(tape,now-1000,'observedAt');
    const net=netReturn(p,t.priceUsd,spot);
    const reason=assessCodexExit(state,{at:now,net,socket:(t.priceUsd/p.priceUsd-1)*100,stale:now-t.observedAt>2000,
      structuralDanger:knownMajorSell(d,tape,now),collapse1s:previous?(t.priceUsd/previous.priceUsd-1)*100:null,
      buyShare5:m.buyShare,sellUsd5:m.sellUsd,sellers5:m.sellers,slope5:m.slope5s,tickId:t.id,newTick:isNew&&lastId!==t.id},exitRules);
    lastId=t.id;
    if(reason){decision={at:now,price:t.priceUsd,net,reason};break;}
  }
  if(!decision)return {...opened,status:'EXIT_UNRESOLVED',reason:'CAPTURE_ENDED',pnlUsd:null,resolvedAt:null};
  const signaled={...opened,reason:decision.reason,exitSignalAt:decision.at,exitSignalReturn:decision.net};
  let requestAt=decision.at,attempts=0,failedFees=0;
  while(attempts<3){
    const sell=firstAfter(ticks,requestAt+settings.latencyMs,Math.min(captureEnd,requestAt+settings.latencyMs+settings.maxFillWaitMs));
    if(!sell)return {...signaled,status:'EXIT_UNRESOLVED',pnlUsd:null,resolvedAt:null,failedSellAttempts:attempts,knownFailedFeeSol:failedFees};
    const requestPrice=asOf(ticks,requestAt,'observedAt')?.priceUsd??decision.price;
    if(sell.priceUsd<requestPrice*(1-settings.sellSlippageCap)){
      attempts++;failedFees+=settings.failedFeeSol;requestAt=sell.observedAt;continue;
    }
    const sellSol=env.solAt(sell.observedAt)?.usd??fillSol;
    const ret=netReturn(p,sell.priceUsd,sellSol)-failedFees/p.buyCostSol*100;
    return {...signaled,status:'CLOSED',sellAt:sell.observedAt,resolvedAt:sell.observedAt,sellPrice:sell.priceUsd,
      returnPercent:ret,pnlUsd:p.buyCostSol*ret/100*sellSol,peakNet:state.peakNet,failedSellAttempts:attempts,
      heldSec:(sell.observedAt-fill.observedAt)/1000};
  }
  return {...signaled,status:'EXIT_UNRESOLVED',pnlUsd:null,resolvedAt:null,failedSellAttempts:attempts,knownFailedFeeSol:failedFees};
}
const round=x=>good(x)?Math.round(x*10000)/10000:null;
export function summary(rows,stakeUsd) {
  const closed=rows.filter(r=>r.status==='CLOSED'),returns=closed.map(r=>r.returnPercent);
  const unresolved=rows.filter(r=>r.status.includes('UNRESOLVED'));
  const pnl=rows.reduce((n,r)=>n+(good(r.pnlUsd)?r.pnlUsd:0),0);
  const wins=returns.filter(x=>x>0),losses=returns.filter(x=>x<0),mean=returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:null;
  // A deliberately conservative accounting bound, not a realised loss assertion.
  const unknownExposure=unresolved.reduce((n,r)=>n+stakeUsd+((r.knownFailedFeeSol??0)+2*INITIAL.networkFeeSol)*125,0);
  let cumulative=0,peak=0,maxDrawdown=0;for(const r of rows){cumulative+=good(r.pnlUsd)?r.pnlUsd:-(stakeUsd+2*INITIAL.networkFeeSol*125);peak=Math.max(peak,cumulative);maxDrawdown=Math.max(maxDrawdown,peak-cumulative);}
  return {attempts:rows.length,closed:closed.length,wins:wins.length,losses:losses.length,
    winRate:closed.length?round(wins.length/closed.length*100):null,unresolved:unresolved.length,
    buyFailed:rows.filter(r=>r.status==='BUY_SLIPPAGE_FAILED').length,costRejected:rows.filter(r=>r.status==='REJECTED_COST').length,
    knownPnlUsd:round(pnl),conservativePnlUsd:round(pnl-unknownExposure),meanReturn:round(mean),
    worstReturn:returns.length?round(Math.min(...returns)):null,profitFactor:losses.length?round(wins.reduce((a,b)=>a+b,0)/-losses.reduce((a,b)=>a+b,0)):null,
    maxDrawdownUsd:round(maxDrawdown),mintCount:new Set(closed.map(r=>r.mint)).size};
}
export function replayPortfolio(env,signals,exitRules,options,partition={start:env.input.start,end:env.input.end,excludedMints:new Set()}) {
  const candidates=signals.filter(s=>s.signalAt>=partition.start&&s.signalAt<partition.end-90000&&!partition.excludedMints.has(s.mint));
  const outcomes=candidates.map(s=>replayCodexSignal(env,s,exitRules,{...options,observationEnd:partition.end}));
  const selected=portfolio(outcomes.filter(r=>r.status!=='REJECTED_COST'),options.stakeUsd,partition.end);
  return {summary:{...summary(selected.selected,options.stakeUsd),costRejected:outcomes.filter(r=>r.status==='REJECTED_COST').length,
    candidateSignals:candidates.length,candidateMints:new Set(candidates.map(r=>r.mint)).size},rows:selected.selected,skipped:selected.skipped};
}
