import {firstAfter} from './guarded-wave-replay-core.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {createMomentumPosition,MOMENTUM_ADAPTIVE_WAVE_RULES} from '../src/momentum-strategy.ts';
import {planRecheckV9} from './codex-prebuy-recheck-v9.mjs';
import {assessPeakV10} from './codex-peak-recheck-v10.mjs';
export const PROBATION_CONFIGS=[3000,5000].flatMap(probationMs=>['NATIVE','EARLY'].map(floor=>({id:`PROBATION_${probationMs}_${floor}`,probationMs,floor})));
export function createProbationV11(config,at,initialNet,price,eventAt=at){
  return {config,position:createMomentumPosition(at,price,eventAt),lastTick:null,initialNet,peakNet:initialNet,
    floor:-Infinity,nativeFloor:-Infinity,weakAt:null,weakTicks:0,weakLastTick:null};
}
export function assessProbationV11(s,f,net,ticks){
  if(!Number.isFinite(net)||!Number.isFinite(f.price)||f.price<=0)return 'INVALID_VALUATION';
  if(f.devSell30>=25||(f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8)return 'DANGER';
  if(net<=-6)return 'HARD_NET_RISK';if(f.at-f.priceAt>10000)return 'PRICE_GAP';
  s.peakNet=Math.max(s.peakNet,net);
  const native=assessPeakV10(s,f,ticks),rawPeak=(s.position.peak/s.position.entry-1)*100-3;
  const rules=MOMENTUM_ADAPTIVE_WAVE_RULES.adaptiveExit;
  if(rawPeak>=rules.breakeven.activationPeakPct)s.nativeFloor=Math.max(s.nativeFloor,rules.breakeven.floorNetPct);
  for(const t of rules.trailing)if(rawPeak>=t.peakMin&&rawPeak<t.peakMax)s.nativeFloor=Math.max(s.nativeFloor,rawPeak-t.trailDistPct);
  const rawNet=(f.price/s.position.entry-1)*100-3;
  if(rawNet<=s.nativeFloor)return 'MONOTONE_NATIVE_FLOOR';
  if(s.config.floor==='EARLY'&&s.peakNet>=2)s.floor=Math.max(s.floor,.5);
  if(net<=s.floor)return 'EARLY_NET_FLOOR';
  if(native)return native;
  const held=f.at-s.position.openedAt,fresh=f.at>=f.priceAt&&f.at-f.priceAt<=750;
  if(held>s.config.probationMs){s.weakAt=null;s.weakTicks=0;s.weakLastTick=null;return null;}
  const weak=fresh&&net<=s.initialNet-1&&Number.isFinite(f.buy2)&&f.buy2<=.5&&
    Number.isFinite(f.return2)&&f.return2<0&&f.sellUsd>=100&&f.sellers>=2;
  if(fresh&&!weak){s.weakAt=null;s.weakTicks=0;s.weakLastTick=null;}
  if(weak&&f.tickId!==s.weakLastTick){s.weakAt??=f.at;s.weakTicks++;s.weakLastTick=f.tickId;}
  if(weak&&s.weakTicks>=2&&f.at-s.weakAt>=250)return 'POSTBUY_PROBATION';
  return null;
}
export function evaluateProbationV11(signal,prepared,config,options){
  const decision=planRecheckV9(signal,prepared,{waitMs:1500,check:'FULL'});
  if(!decision.signal)return {...options,status:'SKIP',stakeUsd:0,at:decision.at,pnl:0,ret:null,reason:decision.reason};
  const buy=firstAfter(prepared.ticks,decision.at+options.delayMs,Math.min(prepared.end,decision.at+options.delayMs+2000));
  if(buy&&buy.priceUsd>signal.price/(1-.09))return {...options,status:'BUY_FAILED',stakeUsd:5,
    at:buy.observedAt,pnl:-.000105*signal.solUsd,ret:null,reason:'TOTAL_BUY_PRICE_BUDGET',decisionAt:decision.at};
  const exitController={create:(at,net)=>createProbationV11(config,at,net,buy.priceUsd,buy.occurredAt),
    assess:(s,f,net)=>assessProbationV11(s,f,net,prepared.ticks)};
  return {...replayAdaptiveTrade(decision.signal,prepared,{...options,exitController}),decisionAt:decision.at};
}
