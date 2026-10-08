import test from 'node:test';
import assert from 'node:assert/strict';
import {capPctV5c,planEntryV5c} from '../scripts/codex-entry-v5c.mjs';
const frame=(at,price=100,sigma1=4)=>({at,price,priceAt:at,tickId:String(at),ready:true,historySec:30,
  return2:1,drawdown5:.5,buy5:.75,buy20:.75,buyers:6,trades:10,buyUsd:700,topBuyer:.3,
  mc:20000,top1:3,top5:12,dev:1,holders:150,tokenAgeSec:500,holderFresh:true,devFresh:true,countFresh:true,
  majorSell:false,devSell30:0,sigma1,collapse1s:0});
const signal={at:0,price:100},config={entryMode:'CONFIRM_1S',gate:'ALL'};
test('volatility cap has fixed bounds and refuses unknown sigma',()=>{
  assert.equal(capPctV5c({sigma1:0}),1);assert.equal(capPctV5c({sigma1:4}),3);
  assert.equal(capPctV5c({sigma1:20}),5);assert.equal(capPctV5c({sigma1:null}),null);
});
test('volatility cap is frozen at opportunity time, not inflated by later volatility',()=>{
  const frames=[frame(0),frame(1000,104,20),frame(1500,104,20)];
  assert.equal(planEntryV5c(signal,{frames},config).signal,null);
});
test('volatility-scaled confirmation can enter within cap and ignores future outcomes',()=>{
  const frames=[frame(0),frame(1000,102),frame(1500,102.5)];
  const a=planEntryV5c(signal,{frames},config);assert.equal(a.signal.price,102.5);assert.equal(a.at,1500);
  assert.deepEqual(planEntryV5c(signal,{frames:[...frames,{...frame(2000),devSell30:200}]},config),a);
});
