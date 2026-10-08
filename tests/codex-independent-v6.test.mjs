import test from 'node:test';
import assert from 'node:assert/strict';
import {signalsV6,setupV6} from '../scripts/codex-independent-v6.mjs';
const frame=at=>({at,price:100,priceAt:at,tickId:String(at),ready:true,historySec:30,
  return5:3,return2:1,drawdown5:.5,buy5:.75,buy20:.75,buyers:6,trades:10,buyUsd:700,topBuyer:.3,
  mc:20000,top1:3,top5:12,dev:1,holders:150,tokenAgeSec:500,holderFresh:true,devFresh:true,countFresh:true,
  majorSell:false,devSell30:0,sigma1:3,collapse1s:0,peakBeforeTrough:true,rebound10:2,drawdown10:4});
const session={id:'s',mint:'m',start:0,source:'fixture'};
test('independent entries need no future AGY signal and only emit once per profile',()=>{
  const signals=signalsV6(session,{frames:[frame(0),frame(500),frame(1000)],end:90000},[]);
  assert.equal(signals.length,2);assert.ok(signals.every(r=>r.at===500));
});
test('independent entry decision is invariant under future crash and future duration',()=>{
  const a=signalsV6(session,{frames:[frame(0),frame(500)],end:90000},[]);
  const b=signalsV6(session,{frames:[frame(0),frame(500),{...frame(1000),collapse1s:-90}],end:90000},[]);
  assert.deepEqual(a,b);
});
test('independent strategies do not silently relax maturity or safety gates',()=>{
  assert.equal(setupV6({...frame(0),tokenAgeSec:299},'MATURE_TREND'),false);
  assert.equal(setupV6({...frame(0),devSell30:25},'MATURE_RECLAIM'),false);
  assert.equal(setupV6({...frame(0),peakBeforeTrough:false},'MATURE_RECLAIM'),false);
});
