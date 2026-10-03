import test from 'node:test';
import assert from 'node:assert/strict';
import { asOf, firstAfter, immediateNetReturn, makeFill, netReturn, exitReason, portfolio } from '../scripts/guarded-wave-replay-core.mjs';

test('as-of evidence never selects the next snapshot', () => {
  const xs=[{at:100,value:'before'},{at:300,value:'future'}];
  assert.equal(asOf(xs,99),null);
  assert.equal(asOf(xs,299).value,'before');
  assert.equal(asOf(xs,300).value,'future');
});
test('a delayed fill requires a fresh received tick within the capture deadline', () => {
  const xs=[{observedAt:2000,occurredAt:-1000,priceUsd:1},{observedAt:2500,occurredAt:2000,priceUsd:.7}];
  assert.equal(firstAfter(xs,1000,2400),null);
  assert.equal(firstAfter(xs,1000,2500).priceUsd,.7);
});
test('small stake cannot hide fixed transaction fees', () => {
  assert.ok(immediateNetReturn(.5,120)<-11);
  assert.ok(immediateNetReturn(10,120)>-3);
});
test('valuation follows cash and fees, not a hard-stop fill price', () => {
  const settings={platformFee:0,networkFeeSol:0};
  const p=makeFill(10,100,1,1000,settings);
  assert.ok(Math.abs(netReturn(p,.7,100)+30)<1e-10);
  const reason=exitReason(p,{now:2000,priceUsd:.7,solUsd:100,metrics:{},stale:false,majorSell:false,collapse1s:null,newTick:true,tickId:'a'});
  assert.equal(reason,'HARD_RISK');
  assert.ok(netReturn(p,.5,100)<-40);
});
test('stale evidence triggers an exit request, never an invented close', () => {
  const p=makeFill(10,120,1,0);
  assert.equal(exitReason(p,{now:3000,stale:true}),'DATA_STALE');
  assert.equal(p.closed,undefined);
});
test('unresolved exposure prevents later portfolio entries', () => {
  const p=portfolio([{mint:'a',signalAt:100,buyAt:200,status:'EXIT_UNRESOLVED',pnlUsd:null},
    {mint:'b',signalAt:1000,buyAt:1100,resolvedAt:2000,status:'CLOSED',pnlUsd:1}],.5,10000);
  assert.equal(p.selected.length,1);
  assert.equal(p.knownPnlUsd,0);
});
test('a failed buy may retry after its result, but a filled token cannot re-enter', () => {
  const p=portfolio([{mint:'a',signalAt:100,resolvedAt:500,status:'BUY_SLIPPAGE_FAILED',pnlUsd:-.01},
    {mint:'a',signalAt:300,resolvedAt:700,status:'BUY_SLIPPAGE_FAILED',pnlUsd:-.01},
    {mint:'a',signalAt:600,buyAt:800,resolvedAt:1200,status:'CLOSED',pnlUsd:.1},
    {mint:'a',signalAt:1300,buyAt:1500,resolvedAt:1800,status:'CLOSED',pnlUsd:.1}],.5,10000);
  assert.equal(p.selected.length,2);
  assert.equal(p.skipped.concurrency,1);
  assert.equal(p.skipped.alreadyEntered,1);
});
