import test from 'node:test';
import assert from 'node:assert/strict';
import {planInvalidationV19,evaluateInvalidationV19,INVALIDATION_CONFIGS} from '../scripts/codex-invalidation-v19.mjs';
const signal={at:1000,price:100,solUsd:120,lane:'AGY_NATIVE'};
const frame=(at,price=100)=>({at,price,priceAt:at,tickId:String(at),tickCount:1});
test('does not require unrelated full Codex entry gates and ignores future deterioration',()=>{
  const d=planInvalidationV19(signal,{frames:[frame(1000),frame(1500),frame(1750,50)]},INVALIDATION_CONFIGS[0]);
  assert.equal(d.signal.at,1500);assert.equal(d.signal.price,100);
});
test('cancels observed price deterioration or absence of fresh decision frame',()=>{
  assert.equal(planInvalidationV19(signal,{frames:[frame(1250,98)]},INVALIDATION_CONFIGS[0]).reason,'PRICE_DETERIORATED');
  assert.equal(planInvalidationV19(signal,{frames:[{...frame(1500),priceAt:0}]},INVALIDATION_CONFIGS[0]).reason,'STALE_PRICE');
  assert.equal(planInvalidationV19(signal,{frames:[]},INVALIDATION_CONFIGS[0]).reason,'NO_RECHECK_FRAME');
});
test('flow veto needs the conjunction of observed sell pressure and falling price',()=>{
  const p={frames:[{...frame(1500),buy5:.4,return2:-.1,sellUsd:200,sellers:2}]};
  assert.ok(planInvalidationV19(signal,p,INVALIDATION_CONFIGS[0]).signal);
  assert.equal(planInvalidationV19(signal,p,INVALIDATION_CONFIGS[1]).reason,'FLOW_DETERIORATED');
});
test('buy delay starts after recheck and initial price ceiling is preserved',()=>{
  const ticks=[{id:'pre',observedAt:2000,occurredAt:2000,priceUsd:100},{id:'fill',observedAt:2500,occurredAt:2500,priceUsd:111}];
  const r=evaluateInvalidationV19(signal,{ticks,frames:[frame(1500,105)],end:3000},INVALIDATION_CONFIGS[0],{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'BUY_FAILED');assert.equal(r.at,2500);assert.equal(r.reason,'TOTAL_BUY_PRICE_BUDGET');
});
