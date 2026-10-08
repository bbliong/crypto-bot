// Pure offline hypotheses. No data access, broker, clock, or mutable live settings.
import {asOf,firstAfter} from './guarded-wave-replay-core.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {createMomentumPosition,assessMomentumAdaptiveWaveExit} from '../src/momentum-strategy.ts';
import {assessHolderDistribution} from '../src/research-simulation.ts';
export const ENTRY_MODES=['DIRECT','CONFIRM_1S','CONFIRM_3S','RECLAIM'];
export const EXIT_MODES=['NATIVE','GUARD','HARVEST'];
export const ENTRY_GATES=['ALL','MC25K','AGE300','RETURN5_MAX5','SIGMA_MAX3','BUYERS6'];
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const range=(x,a,b)=>finite(x)&&x>=a&&x<=b;
export function gateV5(gate,f){
  if(gate==='ALL')return true;
  if(!f)return false;
  if(gate==='MC25K')return range(f.mc,25000,Infinity);
  if(gate==='AGE300')return range(f.tokenAgeSec,300,Infinity);
  if(gate==='RETURN5_MAX5')return range(f.return5,0,5);
  if(gate==='SIGMA_MAX3')return range(f.sigma1,0,3);
  if(gate==='BUYERS6')return range(f.buyers,6,Infinity);
  throw new Error(`Unknown gate ${gate}`);
}
export function entryQualityV5(f){
  if(!f||!f.ready||!f.holderFresh||!f.devFresh||!f.countFresh||!range(f.at-f.priceAt,0,750))return false;
  if(!range(f.mc,10000,100000)||!range(f.tokenAgeSec,60,Infinity)||!range(f.holders,100,Infinity)||
    !range(f.top1,0,8)||!range(f.top5,f.top1,25)||!range(f.dev,0,2.5)||!range(f.devSell30,0,25))return false;
  if(!assessHolderDistribution(f.holders,f.top1,f.top5,f.dev).allowed)return false;
  return range(f.buy5,.6,1)&&range(f.buy20,.65,1)&&range(f.return2,Number.EPSILON,Infinity)&&
    range(f.topBuyer,0,.5)&&f.buyers>=4&&f.trades>=5&&f.buyUsd>=300&&f.drawdown5<=2.5;
}
const danger=f=>f.devSell30>=25||(f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8;
export function planEntryV5(signal,prepared,entryMode,gate='ALL'){
  if(!ENTRY_MODES.includes(entryMode))throw new Error(`Unknown entry ${entryMode}`);
  const initial=asOf(prepared.frames,signal.at,'at');
  if(!gateV5(gate,initial))return {signal:null,reason:'GATE',at:signal.at};
  if(entryMode==='DIRECT')return {signal:{...signal},reason:'DIRECT',at:signal.at};
  let trough=signal.price,armAt=null,armTick=null,lastAt=signal.at;
  for(const f of prepared.frames){
    if(f.at<signal.at)continue;if(f.at>signal.at+12000)break;lastAt=f.at;
    if(danger(f))return {signal:null,reason:'PREBUY_DANGER',at:f.at};
    const fresh=range(f.at-f.priceAt,0,750);
    if(fresh&&f.price>0)trough=Math.min(trough,f.price);
    const minimum=entryMode==='CONFIRM_3S'?3000:entryMode==='CONFIRM_1S'?1000:0;
    const reclaimed=entryMode!=='RECLAIM'||(trough<=signal.price*.985&&f.price>=trough*1.01);
    const valid=f.at>=signal.at+minimum&&reclaimed&&entryQualityV5(f)&&f.price<=signal.price*1.01;
    if(!valid){armAt=null;armTick=null;continue;}
    if(armAt===null){armAt=f.at;armTick=f.tickId;continue;}
    if(f.tickId!==armTick&&f.at-armAt>=500){
      return {signal:{...signal,at:f.at,price:f.price,opportunityAt:signal.at},reason:entryMode,at:f.at};
    }
  }
  return {signal:null,reason:lastAt<signal.at+12000?'NO_CONFIRM_BEFORE_CAPTURE_END':'NO_CONFIRM',at:lastAt};
}
export function createGuardStateV5(mode,openedAt,initialNet,price,eventAt=openedAt){
  if(!['GUARD','HARVEST'].includes(mode))throw new Error(`Unknown guarded exit ${mode}`);
  return {mode,openedAt,peak:initialNet,floor:-Infinity,lastTick:null,position:createMomentumPosition(openedAt,price,eventAt)};
}
export function assessGuardExitV5(s,f,net,tape){
  if(!finite(net)||!finite(f.price)||f.price<=0)return 'INVALID_VALUATION';
  if(danger(f))return 'DANGER';
  if(net<=-6)return 'HARD_NET_RISK';
  s.peak=Math.max(s.peak,net);
  if(s.mode==='HARVEST'){
    if(s.peak>=4)s.floor=Math.max(s.floor,1);
    if(s.peak>=8)s.floor=Math.max(s.floor,(100+s.peak)*.95-100);
    if(net<=s.floor)return 'PROFIT_FLOOR';
  }
  if(f.tickId!==s.lastTick){
    const t=tape.at(-1);s.lastTick=f.tickId;
    if(t&&t.observedAt>s.openedAt){const native=assessMomentumAdaptiveWaveExit(s.position,t,tape);if(native)return `NATIVE_${native.reason}`;}
  }
  if(f.at-s.openedAt>=(s.mode==='HARVEST'?12000:20000))return 'TIME_LIMIT';
  return null;
}
export function evaluateV5(signal,prepared,{entryMode,exitMode,gate='ALL'},options){
  const decision=planEntryV5(signal,prepared,entryMode,gate);
  if(!decision.signal)return {...options,status:'SKIP',pnl:0,ret:null,at:decision.at,reason:decision.reason,stakeUsd:0};
  const next={...decision.signal,lane:'AGY_NATIVE'};
  if(exitMode==='NATIVE')return {...replayAdaptiveTrade(next,prepared,options),decisionAt:next.at};
  const buy=firstAfter(prepared.ticks,next.at+options.delayMs,Math.min(prepared.end,next.at+options.delayMs+2000));
  const exitController={create:(at,net)=>createGuardStateV5(exitMode,at,net,buy.priceUsd,buy.occurredAt),
    assess:(s,f,net)=>assessGuardExitV5(s,f,net,prepared.ticks.slice(0,f.tickCount))};
  return {...replayAdaptiveTrade(next,prepared,{...options,exitController}),decisionAt:next.at};
}
