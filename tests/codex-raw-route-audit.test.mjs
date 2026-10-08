import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRoute,signalRouteCoverage} from '../scripts/audit-codex-raw-routes.mjs';
const row={observedAt:10000,status:200,bodyText:JSON.stringify({code:0,data:{amount_in_usd:'0.5',amount_out_usd:'0.49',sol_cost:'2000000',
  quote:{inputMint:'So11111111111111111111111111111111111111112',outputMint:'token',inAmount:'1',outAmount:'100',
    otherAmountThreshold:'91',slippageBps:'900',platformFee:'0',routePlan:[]},raw_tx:{recentBlockhash:'secret-blockhash',message:'secret-message'}}})};
test('raw quote retains minOut and costs but not transaction messages',()=>{
  const q=extractRoute(row);assert.equal(q.side,'buy');assert.equal(q.minOut,'91');assert.equal(q.solCostLamports,2000000);
  assert.equal(q.contextSlot,null);assert.equal(q.hasBlockhash,true);assert.ok(Math.abs(q.impliedMinOutHaircutPct-9)<1e-9);
  assert.ok(!JSON.stringify(q).includes('secret'));
});
test('coverage rejects future and stale quotes, preserves unknown amounts',()=>{
  const q=extractRoute(row);let r=signalRouteCoverage([{at:9999,mint:'token'},{at:13000,mint:'token'},{at:11000,mint:'token'}],[q]);
  assert.equal(r.anyPrior2s,1);assert.equal(r.stake50cPrior2s,1);assert.equal(r.withSlotPrior2s,0);
  r=signalRouteCoverage([{at:11000,mint:'token'}],[{...q,inUsd:null}]);assert.equal(r.stake50cPrior2s,0);
});
