import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyCodexRegime,createCodexAdaptivePosition,assessCodexAdaptiveExit,assessCodexHourEvidence,wibHourBlock,
  type AdaptiveFrame,type ShadowOutcome} from '../src/codex-adaptive-wave-v3.js';
import {createMomentumPosition,assessMomentumAdaptiveWaveExit,type TapeTrade} from '../src/momentum-strategy.js';
const frame=():AdaptiveFrame=>({at:100000,price:1,priceAt:100000,tickId:'a',ready:true,historySec:25,
  return5:3,return2:1,drawdown5:1,buy5:.8,buy2:.8,buy10:.8,buy20:.75,buyers:6,trades:10,buyUsd:800,
  topBuyer:.3,mc:25000,top1:3,top5:12,dev:1,holders:150,tokenAgeSec:120,holderFresh:true,devFresh:true,countFresh:true,
  majorSell:false,devSell30:0,drawdown10:3,rebound10:3,peakBeforeTrough:false,aboveWeightedPrice:true,
  efficiency20:.65,sigma1:1,sellUsd:200,sellers:3,collapse1s:0});
test('v3 selects trend, impulse and reclaim from present tape, not clock alone',()=>{
  assert.equal(classifyCodexRegime(frame(),-3).mode,'TREND');
  assert.equal(classifyCodexRegime({...frame(),historySec:8},-3).mode,'IMPULSE');
  assert.equal(classifyCodexRegime({...frame(),peakBeforeTrough:true,buy2:.85},-3).mode,'RECLAIM');
  assert.equal(classifyCodexRegime({...frame(),efficiency20:.1},-3).mode,'WAIT');
});
test('danger, unknown data, concentration and excessive costs cannot be overridden by momentum',()=>{
  assert.equal(classifyCodexRegime({...frame(),devSell30:25},-3).mode,'DEFEND');
  for(const patch of [{holderFresh:false},{top1:null},{buy5:NaN},{topBuyer:-1},{sigma1:NaN},{top5:2},{historySec:NaN}])
    assert.equal(classifyCodexRegime({...frame(),...patch},-3).mode,'WAIT');
  assert.equal(classifyCodexRegime(frame(),-5).mode,'WAIT');
});
test('profit floor never decreases when trend volatility widens the trail',()=>{
  const s=createCodexAdaptivePosition(90000,'TREND',-3);
  assessCodexAdaptiveExit(s,frame(),19,-3);const floor=s.floor;
  assessCodexAdaptiveExit(s,{...frame(),at:100250,priceAt:100250,tickId:'b',sigma1:4},20,-3);
  assert.ok(s.floor>=floor);assert.equal(s.peak,20);
});
test('mode promotion requires elapsed persistence and another tick; original risk budget stays fixed',()=>{
  const s=createCodexAdaptivePosition(90000,'IMPULSE',-3);
  assessCodexAdaptiveExit(s,frame(),1,-3);
  assessCodexAdaptiveExit(s,{...frame(),at:101000,priceAt:101000},1,-3);
  assert.equal(s.mode,'IMPULSE');
  assessCodexAdaptiveExit(s,{...frame(),at:101250,priceAt:101250,tickId:'b'},1,-3);
  assert.equal(s.mode,'TREND');assert.equal(s.hardFloor,-7);assert.equal(s.maxHoldSec,45);
});
test('danger exits immediately and net stops do not reinterpret fees as free',()=>{
  assert.equal(assessCodexAdaptiveExit(createCodexAdaptivePosition(90000,'TREND',-3),{...frame(),collapse1s:-9},-2,-3),'DANGER_EXIT');
  assert.equal(assessCodexAdaptiveExit(createCodexAdaptivePosition(90000,'TREND',-3),frame(),-8,-3),'NET_RISK');
});
const now=Date.parse('2026-10-03T12:00:00Z');
const history=():ShadowOutcome[]=>Array.from({length:30},(_,i)=>({id:String(i),mint:String(i),mode:'TREND',
  signalAt:now-(1+i%3)*86400000-i*1000,availableAt:now-10000-i,returnPct:3,unknown:false}));
test('WIB clock blocks are explicit and cannot use future trade outcomes',()=>{
  assert.equal(wibHourBlock(now),16);assert.equal(wibHourBlock(Date.parse('2026-10-03T17:00:00Z')),0);
  assert.equal(assessCodexHourEvidence(history(),now,'TREND').allowed,true);
  assert.equal(assessCodexHourEvidence(history().map(r=>({...r,availableAt:now+1})),now,'TREND').allowed,false);
});
test('hour gate rejects repeated-token sample inflation, inadequate days and unresolved risk',()=>{
  assert.equal(assessCodexHourEvidence(history().map(r=>({...r,mint:'same'})),now,'TREND').allowed,false);
  assert.equal(assessCodexHourEvidence(history().map(r=>({...r,signalAt:now-3600000})),now,'TREND').allowed,false);
  assert.equal(assessCodexHourEvidence(history().map(r=>({...r,unknown:true})),now,'TREND').allowed,false);
});
test('diagnostic: native AGY exit does not maintain the peak used by its own trailing rule',()=>{
  const p=createMomentumPosition(0,100);const tick=(id:string,at:number,priceUsd:number):TapeTrade=>
    ({id,observedAt:at,occurredAt:at,side:'buy',priceUsd,usd:100,wallet:id,tokens:1});
  const a=tick('a',1000,115),b=tick('b',2000,108);
  assert.equal(assessMomentumAdaptiveWaveExit(p,a,[a]),null);
  assert.equal(p.peak,100);
  assert.equal(assessMomentumAdaptiveWaveExit(p,b,[a,b]),null);
  const control={...p,peak:115};assert.equal(assessMomentumAdaptiveWaveExit(control,b,[a,b])?.reason,'ADAPTIVE_TRAILING_STOP');
});
