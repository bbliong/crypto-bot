import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateOnePosition} from '../scripts/codex-portfolio.mjs';
const row=(id,signalAt,at,pnl,status='CLOSED')=>({id,signalAt,at,pnl,status,day:'2026-10-02'});
test('unknown position blocks later entries rather than disappearing from the portfolio',()=>{
  const p=simulateOnePosition([row('a',1,null,null,'SELL_UNKNOWN'),row('b',10,20,50)],5);
  assert.equal(p.blocked,true);assert.equal(p.attempts,1);assert.equal(p.realizedPnl,0);assert.equal(p.skipped.unresolved,1);
});
test('pending order blocks simultaneous entries but a modeled failed buy releases exposure',()=>{
  const p=simulateOnePosition([row('a',1,10,-.01,'BUY_FAILED'),row('b',2,8,5),row('c',11,20,1)],5);
  assert.deepEqual(p.selectedIds,['a','c']);assert.equal(p.skipped.pending,1);assert.equal(p.buyFailed,1);
});
test('three consecutive losses enforce the fixed cooldown',()=>{
  const p=simulateOnePosition([row('a',1,2,-1),row('b',3,4,-1),row('c',5,6,-1),row('d',7,8,100)],5);
  assert.equal(p.skipped.cooldown,1);assert.equal(p.realizedPnl,-3);
});
