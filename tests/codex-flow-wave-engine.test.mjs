import test from 'node:test';
import assert from 'node:assert/strict';
import {replayFlowWave} from '../scripts/codex-flow-wave-engine.mjs';
import {FLOW_WAVE_EXITS} from '../src/codex-flow-wave-v2.ts';
const tick=(at,price)=>({id:String(at),observedAt:at,occurredAt:at,priceUsd:price});
const frame=(at,price,extra={})=>({at,price,priceAt:at,tickId:String(at),majorSell:false,devSell30:0,collapse1s:null,
  return2:1,buy5:.8,sellUsd:0,sellers:0,...extra});
const signal={at:0,price:1,solUsd:120};
test('two seconds with no swaps do not prove a dead socket or force a sale',()=>{
  const p={end:8000,ticks:[tick(1000,1),tick(7000,1.2)],frames:[frame(1000,1),frame(4000,1,{priceAt:1000})]};
  const r=replayFlowWave(signal,p,FLOW_WAVE_EXITS[1]);
  assert.equal(r.status,'SELL_UNKNOWN');assert.equal(r.reason,'CAPTURE_END');assert.equal(r.exitSignalAt,undefined);
});
test('ordinary major-holder profit-taking with rising price is not automatically labeled a rug',()=>{
  const p={end:8000,ticks:[tick(1000,1),tick(5000,1.05)],frames:[frame(1000,1),frame(3000,1.03,{majorSell:true})]};
  const r=replayFlowWave(signal,p,FLOW_WAVE_EXITS[1]);
  assert.equal(r.reason,'CAPTURE_END');
});
test('a developer dump still requests immediate exit and waits for a possible fill',()=>{
  const p={end:8000,ticks:[tick(1000,1),tick(4000,1.03)],frames:[frame(1000,1),frame(3000,1.03,{majorSell:true,devSell30:50})]};
  const r=replayFlowWave(signal,p,FLOW_WAVE_EXITS[1]);
  assert.equal(r.reason,'DUMP_OR_FLASH');assert.equal(r.status,'CLOSED');assert.equal(r.at,4000);
});
test('end-of-capture is censored, not treated as breakeven',()=>{
  const p={end:1500,ticks:[tick(1000,1)],frames:[frame(1000,1)]};
  const r=replayFlowWave(signal,p,FLOW_WAVE_EXITS[1]);assert.equal(r.pnl,null);assert.equal(r.ret,null);
});
test('configured buy tolerance changes fill eligibility, not the observed fill price',()=>{
  const p={end:8000,ticks:[tick(1000,1.05)],frames:[frame(1000,1.05)]};
  assert.equal(replayFlowWave(signal,p,FLOW_WAVE_EXITS[1]).status,'BUY_FAILED');
  const r=replayFlowWave(signal,p,FLOW_WAVE_EXITS[1],{buyPriceCap:1/.91-1,sellOutputCap:.14});
  assert.equal(r.buyPrice,1.05);assert.equal(r.status,'SELL_UNKNOWN');
});
test('larger sell tolerance permits an adverse observed fill, not an invented stop-price sale',()=>{
  const p={end:4000,ticks:[tick(1000,1),tick(3000,.95),tick(4000,.88)],frames:[frame(1000,1),frame(3000,.95)]};
  const narrow=replayFlowWave(signal,p,FLOW_WAVE_EXITS[0]);
  const configured=replayFlowWave(signal,p,FLOW_WAVE_EXITS[0],{buyPriceCap:1/.91-1,sellOutputCap:.14});
  assert.equal(narrow.status,'SELL_UNKNOWN');assert.equal(configured.status,'CLOSED');
  assert.equal(configured.sellPrice,.88);assert.ok(configured.ret < -20);
});
