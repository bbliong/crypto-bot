import test from 'node:test';
import assert from 'node:assert/strict';
import {ROBUST_ACTIONS,ROBUST_CONFIGS,robustLabelsV20,robustDecisionV20} from '../scripts/codex-robust-router-v20.mjs';
test('robust label waits for last scenario and retains unknown full-risk proxy',()=>{
  const results=Object.fromEntries(ROBUST_ACTIONS.map(a=>[a,{
    base:{rows:[{id:'x',at:20,pnl:1,captureEnd:90}]},
    delay2s:{rows:[{id:'x',at:25,pnl:.5,captureEnd:90}]},
    feeStress:{rows:[{id:'x',at:null,pnl:null,bound:-5.02,captureEnd:90}]}
  }]));
  const labels=robustLabelsV20(results,new Map([['x',{at:10,mint:'x',features:{}}]]));
  assert.equal(labels.NATIVE[0].target,-5.02);assert.equal(labels.NATIVE[0].availableAt,90);
  assert.equal(labels.NATIVE[0].unknownProxy,true);
});
test('future or simultaneous outcome cannot change present action',()=>{
  const past=Array.from({length:24},(_,i)=>({id:String(i),mint:String(i),signalAt:i,availableAt:i+1,target:.2,features:{}}));
  const labels=Object.fromEntries(ROBUST_ACTIONS.map(a=>[a,past]));
  const signal={at:100,features:{}},first=robustDecisionV20(ROBUST_CONFIGS[0],labels,signal);
  const next=Object.fromEntries(ROBUST_ACTIONS.map(a=>[a,[...past,{id:'future',mint:'future',signalAt:99,availableAt:100,target:-100,features:{}}]]));
  assert.deepEqual(robustDecisionV20(ROBUST_CONFIGS[0],next,signal),first);assert.equal(first.action,'NATIVE');
});
test('nonpositive stress label means wait even with ample samples',()=>{
  const past=Array.from({length:24},(_,i)=>({id:String(i),mint:String(i),signalAt:i,availableAt:i+1,target:-.01,features:{}}));
  const d=robustDecisionV20(ROBUST_CONFIGS[0],Object.fromEntries(ROBUST_ACTIONS.map(a=>[a,past])),{at:100,features:{}});
  assert.equal(d.action,'WAIT');assert.equal(d.predictions[0].historyN,24);
});
