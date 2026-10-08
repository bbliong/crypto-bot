import {firstAfter} from './guarded-wave-replay-core.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {createMomentumPosition,assessMomentumAdaptiveWaveExit} from '../src/momentum-strategy.ts';
import {planRecheckV9} from './codex-prebuy-recheck-v9.mjs';
export const PEAK_CONFIGS=[0,250,750,1500].map(waitMs=>({id:waitMs?`PEAK_FULL_${waitMs}`:'PEAK_DIRECT',waitMs,check:'FULL'}));
export function assessPeakV10(s,f,ticks){
  if(f.tickId===s.lastTick)return null;s.lastTick=f.tickId;
  const tape=ticks.slice(0,f.tickCount),t=tape.at(-1);if(!t||t.observedAt<=s.position.openedAt)return null;
  s.position.peak=Math.max(s.position.peak,t.priceUsd);
  return assessMomentumAdaptiveWaveExit(s.position,t,tape)?.reason??null;
}
export function evaluatePeakV10(signal,prepared,config,options){
  const decision=config.waitMs?planRecheckV9(signal,prepared,config):{signal:{...signal,lane:'AGY_NATIVE'},at:signal.at,reason:'DIRECT'};
  if(!decision.signal)return {...options,status:'SKIP',stakeUsd:0,at:decision.at,pnl:0,ret:null,reason:decision.reason};
  const buy=firstAfter(prepared.ticks,decision.at+options.delayMs,Math.min(prepared.end,decision.at+options.delayMs+2000));
  if(config.waitMs&&buy&&buy.priceUsd>signal.price/(1-.09))return {...options,status:'BUY_FAILED',stakeUsd:5,
    at:buy.observedAt,pnl:-.000105*signal.solUsd,ret:null,reason:'TOTAL_BUY_PRICE_BUDGET',decisionAt:decision.at};
  const exitController={create:at=>({position:createMomentumPosition(at,buy.priceUsd,buy.occurredAt),lastTick:null}),
    assess:(s,f)=>assessPeakV10(s,f,prepared.ticks)};
  return {...replayAdaptiveTrade(decision.signal,prepared,{...options,exitController}),decisionAt:decision.at};
}
