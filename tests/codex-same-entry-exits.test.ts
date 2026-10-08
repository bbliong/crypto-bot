import test from 'node:test';
import assert from 'node:assert/strict';
import {createSameEntryExit,assessSameEntryExit,chooseExitMode,SAME_ENTRY_POLICIES} from '../src/codex-same-entry-exits.js';
import type {AdaptiveFrame} from '../src/codex-adaptive-wave-v3.js';
const frame=(at=10000):AdaptiveFrame=>({at,price:100,priceAt:at,tickId:String(at),ready:true,historySec:30,
  return5:3,return2:1,drawdown5:.5,buy5:.75,buy2:.7,buy10:.7,buy20:.75,buyers:6,trades:10,buyUsd:700,topBuyer:.3,
  mc:20000,top1:3,top5:12,dev:1,holders:150,tokenAgeSec:120,holderFresh:true,devFresh:true,countFresh:true,
  majorSell:false,devSell30:0,drawdown10:4,rebound10:2,peakBeforeTrough:false,aboveWeightedPrice:true,
  efficiency20:.6,sigma1:2,sellUsd:200,sellers:3,collapse1s:0});
const weak=(at=10000)=>({...frame(at),buy5:.4,buy2:.5,return2:-1,drawdown5:2});
test('all same-entry Codex policies respect the same all-in hard stop',()=>{
  for(const policy of SAME_ENTRY_POLICIES){const s=createSameEntryExit(policy,9000,-3,frame());
    assert.equal(s.hardNet,-6);assert.equal(assessSameEntryExit(s,frame(),-6),'HARD_NET_RISK');}
});
test('regime routes present evidence and rejects unknown safety inputs',()=>{
  assert.equal(chooseExitMode(frame()),'TREND');assert.equal(chooseExitMode(weak()),'PULLBACK');
  assert.equal(chooseExitMode({...frame(),devFresh:false}),'DEFENSIVE');
  assert.equal(chooseExitMode({...frame(),buy20:null}),'DEFENSIVE');
});
test('defensive exits confirmed weak flow while trend grants a bounded two-second grace',()=>{
  const d=createSameEntryExit('DEFENSIVE',9000,-3),t=createSameEntryExit('TREND',9000,-3);
  assert.equal(assessSameEntryExit(d,weak(),-2),null);assert.equal(assessSameEntryExit(t,weak(),-2),null);
  assert.equal(assessSameEntryExit(d,weak(10500),-2),'FLOW_REVERSAL');
  assert.equal(assessSameEntryExit(t,weak(10500),-2),null);assert.equal(t.graceUntil,12000);
  assert.equal(assessSameEntryExit(t,weak(12000),-2),'PULLBACK_GRACE_EXPIRED');
});
test('a pullback grace expires even without another incoming trade',()=>{
  const s=createSameEntryExit('PULLBACK',9000,-3);
  assessSameEntryExit(s,weak(),-2);assessSameEntryExit(s,weak(10500),-2);
  assert.equal(s.graceUntil,13000);
  assert.equal(assessSameEntryExit(s,{...weak(13000),priceAt:10500,tickId:'10500'},-2),'PULLBACK_GRACE_EXPIRED');
});
test('grace never overrides hard risk, structural danger or an existing profit floor',()=>{
  const s=createSameEntryExit('PULLBACK',9000,-3);
  assessSameEntryExit(s,weak(),-2);assessSameEntryExit(s,weak(10500),-2);
  assert.equal(assessSameEntryExit({...s},weak(11000),-7),'HARD_NET_RISK');
  assert.equal(assessSameEntryExit({...s},{...weak(11000),devSell30:25},-2),'DANGER');
  assert.equal(assessSameEntryExit({...s,floor:1,peak:9},weak(11000),.5),'PROFIT_FLOOR');
});
test('same tick cannot confirm a reversal; extreme selling never receives grace',()=>{
  const s=createSameEntryExit('PULLBACK',9000,-3);
  assessSameEntryExit(s,weak(),-2);
  assert.equal(assessSameEntryExit(s,{...weak(10500),tickId:'10000'},-2),null);
  assert.equal(s.weakTicks,1);
  assert.equal(assessSameEntryExit(s,{...weak(10750),buy5:.2},-2),'EXTREME_SELL_FLOW');
});
test('mode widening cannot reduce locked floor or extend the original hold deadline',()=>{
  const s=createSameEntryExit('CONTEXT',9000,-3,{...frame(),historySec:5});
  assessSameEntryExit(s,frame(),10);const floor=s.floor;
  assessSameEntryExit(s,{...frame(11250),sigma1:5},15);
  assert.equal(s.mode,'TREND');assert.ok(s.floor>=floor);assert.equal(s.maxHoldMs,45000);assert.equal(s.hardNet,-6);
});
test('invalid prices do not silently continue a position',()=>{
  assert.equal(assessSameEntryExit(createSameEntryExit('TREND',9000,-3),{...frame(),price:NaN},1),'INVALID_VALUATION');
});
