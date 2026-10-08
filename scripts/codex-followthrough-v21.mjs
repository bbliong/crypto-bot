// Pure research exit: fixed post-fill proof deadline, native entry/exit retained otherwise.
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {firstAfter} from './guarded-wave-replay-core.mjs';
import {createMomentumPosition,assessMomentumAdaptiveWaveExit} from '../src/momentum-strategy.ts';
export const FOLLOWTHROUGH_CONFIGS=[2000,4000].flatMap(deadlineMs=>[1,2].map(proofPp=>({
  id:`FOLLOWTHROUGH_${deadlineMs}_${proofPp}`,deadlineMs,proofPp})));
export function createFollowthroughV21(config,at,initialNet,price,eventAt){
  return {config,openedAt:at,initialNet,proved:false,lastTick:null,position:createMomentumPosition(at,price,eventAt)};
}
export function assessFollowthroughV21(s,f,net,ticks){
  const fresh=Number.isFinite(f.priceAt)&&f.priceAt>=s.openedAt&&f.at>=f.priceAt&&f.at-f.priceAt<=750;
  const elapsed=f.at-s.openedAt;
  if(fresh){
    if(net<=-6)return 'HARD_NET_RISK';
    if(!s.proved&&net-s.initialNet<=-2)return 'EARLY_ADVERSE_MOVE';
    // Evidence after the deadline cannot retroactively pass probation.
    if(elapsed<=s.config.deadlineMs&&net-s.initialNet>=s.config.proofPp)s.proved=true;
  }
  if(!s.proved&&elapsed>=s.config.deadlineMs)return 'NO_FOLLOWTHROUGH';
  // A deadline can request an exit on stale data; fills still require later observed ticks.
  if(f.tickId===s.lastTick)return null;s.lastTick=f.tickId;
  const tape=ticks.slice(0,f.tickCount),tick=tape.at(-1);
  if(!tick||tick.observedAt<=s.openedAt)return null;
  return assessMomentumAdaptiveWaveExit(s.position,tick,tape)?.reason??null;
}
export function evaluateFollowthroughV21(signal,prepared,config,options){
  if(!FOLLOWTHROUGH_CONFIGS.some(c=>c.id===config.id&&c.deadlineMs===config.deadlineMs&&c.proofPp===config.proofPp))throw Error('Invalid followthrough config');
  const buy=firstAfter(prepared.ticks,signal.at+options.delayMs,Math.min(prepared.end,signal.at+options.delayMs+2000));
  const exitController={create:(at,net)=>createFollowthroughV21(config,at,net,buy.priceUsd,buy.occurredAt),
    assess:(s,f,net)=>assessFollowthroughV21(s,f,net,prepared.ticks)};
  return replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,{...options,exitController});
}
