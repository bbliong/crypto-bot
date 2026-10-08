import {asOf,firstAfter} from './guarded-wave-replay-core.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {assessHolderDistribution} from '../src/research-simulation.ts';
import {assessMomentumAdaptiveWaveEntry} from '../src/momentum-strategy.ts';
export const RECHECK_CONFIGS=[250,750,1500].flatMap(waitMs=>['STRUCTURAL','FULL'].map(check=>({id:`RECHECK_${check}_${waitMs}`,waitMs,check})));
const range=(x,a,b)=>typeof x==='number'&&Number.isFinite(x)&&x>=a&&x<=b;
export function planRecheckV9(signal,prepared,config){
  if(![250,750,1500].includes(config.waitMs)||!['STRUCTURAL','FULL'].includes(config.check))throw new Error('Invalid frozen recheck');
  const at=signal.at+config.waitMs,f=prepared.frames.find(f=>f.at>=at&&f.at<=at+250);
  if(!f)return {signal:null,at,reason:'RECHECK_FRAME_MISSING'};
  if(!f.holderFresh||!f.devFresh||!f.countFresh||!range(f.at-f.priceAt,0,750)||!range(f.price,Number.MIN_VALUE,Infinity))
    return {signal:null,at:f.at,reason:'RECHECK_STALE'};
  if(!range(f.mc,10000,100000)||!range(f.tokenAgeSec,60,Infinity)||!range(f.holders,100,Infinity)||
    !range(f.top1,0,8)||!range(f.top5,f.top1,25)||!range(f.dev,0,2.5))return {signal:null,at:f.at,reason:'RECHECK_HARDGATE'};
  const h=assessHolderDistribution(f.holders,f.top1,f.top5,f.dev);
  if(!h.allowed)return {signal:null,at:f.at,reason:'RECHECK_DISTRIBUTION'};
  if(f.devSell30>=25||(f.majorSell&&(f.return2??0)<=0)||(f.collapse1s??0)<=-8||
    (Number.isFinite(f.return2)&&f.return2<=-3))return {signal:null,at:f.at,reason:'RECHECK_DANGER'};
  if(f.price>signal.price/(1-.09))return {signal:null,at:f.at,reason:'RECHECK_PRICE_BUDGET'};
  if(config.check==='FULL'){
    const tape=prepared.ticks.slice(0,f.tickCount);
    if(!assessMomentumAdaptiveWaveEntry(tape,f.at,h,f.dev,f.top1,f.top5,f.mc,f.tokenAgeSec,f.holders).allowed)
      return {signal:null,at:f.at,reason:'RECHECK_MOMENTUM'};
  }
  return {signal:{...signal,at:f.at,price:f.price,opportunityAt:signal.at,lane:'AGY_NATIVE'},at:f.at,reason:'RECHECK_OK'};
}
export function evaluateRecheckV9(signal,prepared,config,options){
  const decision=planRecheckV9(signal,prepared,config);
  if(!decision.signal)return {...options,status:'SKIP',stakeUsd:0,at:decision.at,pnl:0,ret:null,reason:decision.reason};
  const buy=firstAfter(prepared.ticks,decision.at+options.delayMs,Math.min(prepared.end,decision.at+options.delayMs+2000));
  // This is an order-failure check on the modeled future fill, never an entry gate.
  if(buy&&buy.priceUsd>signal.price/(1-.09))return {...options,status:'BUY_FAILED',stakeUsd:5,
    at:buy.observedAt,pnl:-.000105*signal.solUsd,ret:null,reason:'TOTAL_BUY_PRICE_BUDGET',decisionAt:decision.at};
  return {...replayAdaptiveTrade(decision.signal,prepared,options),decisionAt:decision.at};
}
