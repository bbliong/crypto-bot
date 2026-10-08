// Frozen research hypothesis: recycling of the wallets supporting entry, not ownership inference.
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {assessPeakV10} from './codex-peak-recheck-v10.mjs';
import {createMomentumPosition} from '../src/momentum-strategy.ts';
import {firstAfter} from './guarded-wave-replay-core.mjs';
export const COHORT_CONFIGS=[.25,.5].flatMap(fraction=>[1,2].map(minSellers=>({
  id:`COHORT_${fraction}_${minSellers}`,fraction,minSellers})));
export function entryCohortV18(ticks,at){
  const flows=new Map(),seen=new Set();
  for(const t of ticks){
    if(t.observedAt>at||t.observedAt<=at-5000||!t.wallet||!(t.usd>0)||seen.has(t.id))continue;
    seen.add(t.id);flows.set(t.wallet,(flows.get(t.wallet)??0)+(t.side==='buy'?t.usd:-t.usd));
  }
  const buyers=new Map([...flows].filter(([,usd])=>usd>=25));
  return {buyers,total:[...buyers.values()].reduce((a,b)=>a+b,0)};
}
export function cohortPressureV18(cohort,ticks,signalAt,now){
  const out=new Map(),seen=new Set();
  for(const t of ticks){
    if(t.observedAt<=signalAt||t.observedAt>now||!cohort.buyers.has(t.wallet)||!(t.usd>0)||seen.has(t.id))continue;
    seen.add(t.id);out.set(t.wallet,(out.get(t.wallet)??0)+(t.side==='sell'?t.usd:-t.usd));
  }
  // Incoming capital from other cohort members offsets outgoing USD: no gross-sale inflation.
  return {outflow:[...out.values()].reduce((a,b)=>a+b,0),sellers:[...out.values()].filter(x=>x>=25).length};
}
export function evaluateCohortV18(signal,prepared,config,options){
  if(!COHORT_CONFIGS.some(c=>c.id===config.id&&c.fraction===config.fraction&&c.minSellers===config.minSellers))
    throw new Error('Invalid cohort config');
  const cohort=entryCohortV18(prepared.ticks,signal.at);
  const buy=firstAfter(prepared.ticks,signal.at+options.delayMs,Math.min(prepared.end,signal.at+options.delayMs+2000));
  const exitController={
    create:at=>({position:createMomentumPosition(at,buy.priceUsd,buy.occurredAt),lastTick:null,cohortUsd:cohort.total}),
    assess:(state,f)=>{
      if(f.priceAt>=state.position.openedAt&&f.at-f.priceAt<=750&&cohort.total>=100){
        const pressure=cohortPressureV18(cohort,prepared.ticks,signal.at,f.at);
        if(pressure.sellers>=config.minSellers&&pressure.outflow>=config.fraction*cohort.total)
          return 'ENTRY_BUYER_RECYCLE';
      }
      return assessPeakV10(state,f,prepared.ticks);
    }
  };
  return replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,{...options,exitController});
}
