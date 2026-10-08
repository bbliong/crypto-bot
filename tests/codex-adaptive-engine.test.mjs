import test from 'node:test';
import assert from 'node:assert/strict';
import {replayAdaptiveTrade} from '../scripts/codex-adaptive-engine.mjs';
const tick=(at,priceUsd)=>({id:String(at),observedAt:at,occurredAt:at,priceUsd,side:'sell',wallet:String(at),usd:200,tokens:1});
const signal={at:0,price:100,solUsd:120,mode:'IMPULSE'};
test('AGY and Codex use identical modeled fill costs and prices when they request the same exit',()=>{
  const ticks=[tick(1000,100),tick(2000,90),tick(3000,80)];
  const prepared={ticks,end:4000,frames:ticks.slice(0,2).map((t,i)=>({at:t.observedAt,price:t.priceUsd,priceAt:t.observedAt,tickId:t.id,
    tickCount:i+1,devSell30:0,majorSell:false,collapse1s:i?-10:0,return2:i?-10:0}))};
  const outcomes=['AGY_NATIVE','AGY_REFERENCE','CODEX_EVENT'].map(lane=>replayAdaptiveTrade({...signal,lane},prepared));
  for(const o of outcomes){assert.equal(o.status,'CLOSED');assert.equal(o.buyPrice,100);assert.equal(o.sellPrice,80);assert.ok(o.ret < -20);}
  assert.equal(outcomes[0].pnl,outcomes[1].pnl);assert.equal(outcomes[0].pnl,outcomes[2].pnl);
});
test('missing delayed buy cannot be fabricated from the signal price',()=>{
  const o=replayAdaptiveTrade({...signal,lane:'CODEX_EVENT'},{ticks:[tick(0,100)],frames:[],end:4000});
  assert.equal(o.status,'BUY_UNKNOWN');assert.equal(o.pnl,null);
});
test('buy minimum-output tolerance is not a percentage haircut or free failed attempt',()=>{
  const o=replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},{ticks:[tick(1000,112)],frames:[],end:4000});
  assert.equal(o.status,'BUY_FAILED');assert.ok(o.pnl<0);
});
test('custom exits preserve the identical buy quantity and sunk purchase cost',()=>{
  const ticks=[tick(1000,100),tick(2000,90),tick(3000,80)];
  const prepared={ticks,end:4000,frames:ticks.slice(0,2).map((t,i)=>({at:t.observedAt,price:t.priceUsd,priceAt:t.observedAt,
    tickId:t.id,tickCount:i+1,devSell30:0,majorSell:false,collapse1s:0,return2:0}))};
  const native=replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared);
  const custom=replayAdaptiveTrade({...signal,lane:'AGY_NATIVE'},prepared,{exitController:{create:()=>({}),assess:(_,f)=>f.at>=2000?'TEST_EXIT':null}});
  for(const k of ['buyAt','buyPrice','buyQuantity','initialNet','pnl'])assert.equal(custom[k],native[k]);
  assert.equal(custom.buyQuantity,.0495);
});
