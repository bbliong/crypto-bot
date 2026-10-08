import test from 'node:test';
import assert from 'node:assert/strict';
import {planCostRecheckV13,evaluateCostRecheckV13,COST_RECHECK_CONFIGS} from '../scripts/codex-cost-recheck-v13.mjs';
const signal={id:'s',at:0,price:100,lambda:.25,solUsd:120},config=COST_RECHECK_CONFIGS[1];
const f=at=>({at,price:100,priceAt:at,tickId:String(at),mc:20000,tokenAgeSec:120,holders:150,top1:3,top5:12,dev:1,
  ready:true,holderFresh:true,devFresh:true,countFresh:true,devSell30:0,majorSell:false,collapse1s:0,return2:3,return5:6,
  buy2:.8,buy5:.8,buy20:.8,topBuyer:.3,buyers:5,trades:10,buyUsd:500,drawdown5:0,sigma1:1,efficiency20:.8});
test('cost recheck uses first timely frame, not a later recovered setup',()=>{
  const p={frames:[{...f(750),return2:-1},f(1000)],ticks:[]};
  assert.equal(planCostRecheckV13(signal,p,config).signal,null);
  assert.deepEqual(planCostRecheckV13(signal,p,config),planCostRecheckV13(signal,{...p,frames:[...p.frames,f(2000)]},config));
});
test('no cost is incurred when danger cancels before submission',()=>{
  const r=evaluateCostRecheckV13(signal,{frames:[{...f(750),majorSell:true}],ticks:[],end:90000},config,{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'SKIP');assert.equal(r.pnl,0);assert.equal(r.stakeUsd,0);
});
test('future original-budget breach is a paid failed order, never free skip',()=>{
  const p={frames:[{...f(750),price:108}],ticks:[{observedAt:1750,occurredAt:1750,priceUsd:112}],end:5000};
  const r=evaluateCostRecheckV13(signal,p,config,{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'BUY_FAILED');assert.ok(r.pnl<0);
});
test('wait remains additional to execution latency',()=>{
  const p={frames:[f(750)],ticks:[{observedAt:1000,occurredAt:1000,priceUsd:100}],end:1500};
  assert.equal(evaluateCostRecheckV13(signal,p,config,{delayMs:1000,feeSide:.01}).status,'BUY_UNKNOWN');
});
test('missing timely frame is not replaced with distant favorable evidence',()=>{
  assert.equal(planCostRecheckV13(signal,{frames:[f(1500)]},config).reason,'RECHECK_FRAME_MISSING');
});
