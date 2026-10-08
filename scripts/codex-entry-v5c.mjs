import {asOf} from './guarded-wave-replay-core.mjs';
import {gateV5,entryQualityV5,evaluateV5} from './codex-engineering-v5.mjs';
export function capPctV5c(frame){
  return Number.isFinite(frame?.sigma1)&&frame.sigma1>=0?Math.max(1,Math.min(5,.75*frame.sigma1)):null;
}
export function planEntryV5c(signal,prepared,{entryMode,gate}){
  if(!['CONFIRM_1S','CONFIRM_3S'].includes(entryMode))throw new Error('Invalid v5c entry mode');
  const initial=asOf(prepared.frames,signal.at,'at'),capPct=capPctV5c(initial);
  if(!gateV5(gate,initial))return {signal:null,at:signal.at,reason:'GATE'};
  if(capPct===null)return {signal:null,at:signal.at,reason:'VOLATILITY_UNKNOWN'};
  const minimum=entryMode==='CONFIRM_1S'?1000:3000;
  let armAt=null,armTick=null,lastAt=signal.at;
  for(const f of prepared.frames){
    if(f.at<signal.at)continue;if(f.at>signal.at+12000)break;lastAt=f.at;
    if(f.devSell30>=25||(f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8)
      return {signal:null,at:f.at,reason:'PREBUY_DANGER',capPct};
    if(f.at<signal.at+minimum||!entryQualityV5(f)||f.price>signal.price*(1+capPct/100)){
      armAt=null;armTick=null;continue;
    }
    if(armAt===null){armAt=f.at;armTick=f.tickId;continue;}
    if(f.at-armAt>=500&&f.tickId!==armTick)return {signal:{...signal,at:f.at,price:f.price,opportunityAt:signal.at},at:f.at,reason:entryMode,capPct};
  }
  return {signal:null,at:lastAt,reason:lastAt<signal.at+12000?'NO_CONFIRM_BEFORE_CAPTURE_END':'NO_CONFIRM',capPct};
}
export function evaluateV5c(signal,prepared,config,options){
  const decision=planEntryV5c(signal,prepared,config);
  if(!decision.signal)return {...options,status:'SKIP',pnl:0,ret:null,at:decision.at,reason:decision.reason,stakeUsd:0,capPct:decision.capPct};
  return {...evaluateV5(decision.signal,prepared,{entryMode:'DIRECT',exitMode:config.exitMode,gate:'ALL'},options),capPct:decision.capPct};
}
