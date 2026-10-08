import test from 'node:test';
import assert from 'node:assert/strict';
import {planRecheckV9,evaluateRecheckV9} from '../scripts/codex-prebuy-recheck-v9.mjs';
const frame=at=>({at,price:100,priceAt:at,tickId:String(at),tickCount:0,mc:20000,tokenAgeSec:120,holders:150,
  top1:3,top5:12,dev:1,holderFresh:true,devFresh:true,countFresh:true,devSell30:0,majorSell:false,return2:1,collapse1s:0});
const signal={id:'s',at:0,price:100,solUsd:120,lane:'AGY_NATIVE',mode:'AGY'};
const config={waitMs:750,check:'STRUCTURAL'};
test('recheck uses a fixed decision time, not the best future frame',()=>{
  const frames=[frame(750),{...frame(1000),price:90}];
  assert.equal(planRecheckV9(signal,{frames},config).signal.price,100);
});
test('recheck cancels a known danger before any purchase cost is incurred',()=>{
  const prepared={frames:[{...frame(750),devSell30:25}],ticks:[],end:5000};
  const r=evaluateRecheckV9(signal,prepared,config,{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'SKIP');assert.equal(r.pnl,0);assert.equal(r.reason,'RECHECK_DANGER');
});
test('recheck decision is prefix-invariant and does not consult future fills',()=>{
  const frames=[frame(750)],a=planRecheckV9(signal,{frames,ticks:[]},config);
  assert.deepEqual(a,planRecheckV9(signal,{frames:[...frames,{...frame(2000),collapse1s:-90}],ticks:[]},config));
});
test('additional preparation time remains in modeled fill latency',()=>{
  const ticks=[{id:'b',observedAt:1000,occurredAt:1000,priceUsd:100}];
  const r=evaluateRecheckV9(signal,{frames:[frame(750)],ticks,end:1500},config,{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'BUY_UNKNOWN');assert.equal(r.pnl,null);
});
test('total price-budget failure spends a failed fee rather than becoming a free skip',()=>{
  const ticks=[{id:'b',observedAt:1750,occurredAt:1750,priceUsd:115}];
  const r=evaluateRecheckV9(signal,{frames:[frame(750)],ticks,end:3000},config,{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'BUY_FAILED');assert.ok(r.pnl<0);assert.equal(r.decisionAt,750);
});
test('recheck never substitutes a distant frame for missing timely evidence',()=>{
  assert.equal(planRecheckV9(signal,{frames:[frame(1250)]},config).reason,'RECHECK_FRAME_MISSING');
});
