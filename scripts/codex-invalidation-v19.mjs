// Revalidate deterioration, not an additional independent entry strategy. Offline only.
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {firstAfter} from './guarded-wave-replay-core.mjs';
export const INVALIDATION_CONFIGS=[500,1000].flatMap(waitMs=>['PRICE','FLOW'].map(check=>({id:`INVALIDATE_${waitMs}_${check}`,waitMs,check})));
export function planInvalidationV19(signal,prepared,config){
  const deadline=signal.at+config.waitMs;
  let last=signal.at;
  for(const f of prepared.frames){
    if(f.at<signal.at)continue;
    if(f.at>deadline+250)break;
    last=f.at;
    const fresh=Number.isFinite(f.priceAt)&&f.at>=f.priceAt&&f.at-f.priceAt<=750;
    if(f.devSell30>=25||f.majorSell||(f.collapse1s??0)<=-8)return {at:f.at,reason:'DANGER'};
    if(fresh&&f.price<signal.price*.99)return {at:f.at,reason:'PRICE_DETERIORATED'};
    if(config.check==='FLOW'&&fresh&&f.buy5!=null&&f.buy5<.5&&f.return2<0&&f.sellUsd>=100&&f.sellers>=2)
      return {at:f.at,reason:'FLOW_DETERIORATED'};
    if(f.at>=deadline){
      if(!fresh||!(f.price>0))return {at:f.at,reason:'STALE_PRICE'};
      if(f.price>signal.price/(1-.09))return {at:f.at,reason:'PRICE_BUDGET'};
      return {at:f.at,reason:'REVALIDATED',signal:{...signal,at:f.at,price:f.price,lane:'AGY_NATIVE'}};
    }
  }
  return {at:last,reason:'NO_RECHECK_FRAME'};
}
export function evaluateInvalidationV19(signal,prepared,config,options){
  if(!INVALIDATION_CONFIGS.some(c=>c.id===config.id&&c.waitMs===config.waitMs&&c.check===config.check))throw new Error('Invalid config');
  const d=planInvalidationV19(signal,prepared,config);
  if(!d.signal)return {...options,status:'SKIP',stakeUsd:0,at:d.at,pnl:0,ret:null,reason:d.reason};
  const buy=firstAfter(prepared.ticks,d.at+options.delayMs,Math.min(prepared.end,d.at+options.delayMs+2000));
  if(buy&&buy.priceUsd>signal.price/(1-.09))return {...options,status:'BUY_FAILED',stakeUsd:5,at:buy.observedAt,
    pnl:-.000105*signal.solUsd,ret:null,reason:'TOTAL_BUY_PRICE_BUDGET',decisionAt:d.at};
  return {...replayAdaptiveTrade(d.signal,prepared,options),decisionAt:d.at};
}
