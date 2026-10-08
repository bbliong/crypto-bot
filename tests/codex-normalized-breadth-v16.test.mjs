import test from 'node:test';
import assert from 'node:assert/strict';
import {previousSigmaV16,severeShockV16} from '../scripts/codex-normalized-breadth-v16.mjs';
const ticks=Array.from({length:10},(_,i)=>({observedAt:i*1000,priceUsd:100*Math.exp(i*.01)}));
test('shock being measured and future ticks cannot inflate previous sigma',()=>{
  const baseline=previousSigmaV16(ticks,11000);
  assert.deepEqual(baseline,previousSigmaV16([...ticks,{observedAt:10000,priceUsd:1},{observedAt:12000,priceUsd:10000}],11000));
  assert.ok(Math.abs(baseline.sigma-1)<1e-10);
});
test('missing earlier history stays unknown, never zero volatility',()=>{
  assert.equal(previousSigmaV16(ticks.slice(0,3),11000).sigma,null);
  assert.equal(severeShockV16({return2:-20,collapse1s:-10},null),false);
});
test('the same raw movement is not an equally severe shock at every volatility',()=>{
  const frame={return2:-9,collapse1s:0};
  assert.equal(severeShockV16(frame,1),true);assert.equal(severeShockV16(frame,4),false);
  assert.equal(severeShockV16({return2:-30,collapse1s:0},4),true);
});
test('flat observed prices use a finite conservative sigma floor',()=>{
  assert.equal(previousSigmaV16(ticks.map(t=>({...t,priceUsd:100})),11000).sigma,.3);
});
