import {firstAfter} from './guarded-wave-replay-core.mjs';
import {costTempoSetup,evaluateCostTempoV12,TEMPO_CONFIGS} from './codex-cost-tempo-v12.mjs';
export const COST_RECHECK_CONFIGS=[750,1500].flatMap(waitMs=>['PEAK_CONTROL','TEMPO'].map(exitMode=>({
  id:`COST_RECHECK_${waitMs}_${exitMode}`,waitMs,lambda:.25,exitMode})));
export function planCostRecheckV13(signal,prepared,config){
  if(!COST_RECHECK_CONFIGS.some(c=>c.id===config.id&&c.waitMs===config.waitMs&&c.lambda===config.lambda&&c.exitMode===config.exitMode)||signal.lambda!==.25)
    throw new Error('Invalid frozen cost recheck');
  const target=signal.at+config.waitMs,f=prepared.frames.find(f=>f.at>=target&&f.at<=target+250);
  if(!f)return {signal:null,at:target,reason:'RECHECK_FRAME_MISSING'};
  const setup=costTempoSetup(f,signal.solUsd,.25);
  if(!setup.allowed)return {signal:null,at:f.at,reason:`RECHECK_${setup.reason}`,recheckScore:setup};
  if(f.price>signal.price/(1-.09))return {signal:null,at:f.at,reason:'RECHECK_PRICE_BUDGET',recheckScore:setup};
  return {signal:{...signal,at:f.at,price:f.price,opportunityAt:signal.at,mode:setup.mode,entryScore:setup},
    at:f.at,reason:'RECHECK_OK',recheckScore:setup};
}
export function evaluateCostRecheckV13(signal,prepared,config,options){
  const decision=planCostRecheckV13(signal,prepared,config);
  if(!decision.signal)return {...options,status:'SKIP',stakeUsd:0,at:decision.at,pnl:0,ret:null,reason:decision.reason,recheckScore:decision.recheckScore};
  const buy=firstAfter(prepared.ticks,decision.at+options.delayMs,Math.min(prepared.end,decision.at+options.delayMs+2000));
  if(buy&&buy.priceUsd>signal.price/(1-.09))return {...options,status:'BUY_FAILED',stakeUsd:5,at:buy.observedAt,
    pnl:-.000105*signal.solUsd,ret:null,reason:'TOTAL_BUY_PRICE_BUDGET',decisionAt:decision.at,recheckScore:decision.recheckScore};
  const exit=TEMPO_CONFIGS.find(c=>c.lambda===.25&&c.exitMode===config.exitMode);
  return {...evaluateCostTempoV12(decision.signal,prepared,exit,options),decisionAt:decision.at,recheckScore:decision.recheckScore};
}
