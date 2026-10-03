import test from 'node:test';
import assert from 'node:assert/strict';
import { receivedTicks, replayCodexSignal } from '../scripts/codex-guarded-wave-engine.mjs';
import { CODEX_EXIT_PROFILES } from '../src/codex-guarded-wave.ts';
const tick=(at,price,event=at)=>({id:String(at),observedAt:at,occurredAt:event,priceUsd:price,side:'buy',wallet:'a',usd:100,tokens:100});
function fixture(){
  const s={id:'detail-a',mint:'a',start:0,end:6000,ticks:[tick(0,1),tick(1000,1),tick(2000,1),tick(3000,.7),tick(4000,.65),tick(5000,.6),tick(6000,.6)]};
  return {env:{universe:new Map([[s.id,s]]),input:{tokens:{a:{holders:[],dev:[]}}},solAt:()=>({usd:100})},
    signal:{sessionId:s.id,mint:'a',symbol:'TEST',signalAt:1000,price:1,solUsd:100}};
}
test('out-of-order and stale ticks cannot become modeled fills',()=>{
  const d={ticks:[tick(1000,1),tick(1200,.1,500),tick(4000,.2,1000),tick(4500,.9)]};
  assert.deepEqual(receivedTicks(d,{start:0,end:5000}).map(t=>t.observedAt),[1000,4500]);
});
test('a gap through the stop is priced at a subsequent fill and retry fees are charged',()=>{
  const {env,signal}=fixture();
  const r=replayCodexSignal(env,signal,CODEX_EXIT_PROFILES[0],{stakeUsd:10,platformFee:0,networkFeeSol:0});
  assert.equal(r.reason,'HARD_RISK');
  assert.equal(r.status,'CLOSED');
  assert.equal(r.failedSellAttempts,2);
  assert.equal(r.sellAt,6000);
  assert.ok(r.returnPercent < -40);
});
test('a ended observation becomes unresolved, not a last-price sale',()=>{
  const {env,signal}=fixture();
  const r=replayCodexSignal(env,signal,CODEX_EXIT_PROFILES[0],{stakeUsd:10,platformFee:0,networkFeeSol:0,observationEnd:3500});
  assert.equal(r.status,'EXIT_UNRESOLVED');
  assert.equal(r.pnlUsd,null);
  assert.equal(r.sellAt,undefined);
});
test('a future partition cannot supply the missing buy fill',()=>{
  const {env,signal}=fixture();
  const r=replayCodexSignal(env,signal,CODEX_EXIT_PROFILES[0],{stakeUsd:10,observationEnd:1500});
  assert.equal(r.status,'BUY_UNRESOLVED');
  assert.equal(r.buyAt,undefined);
});
test('configured small stake is rejected before creating a position',()=>{
  const {env,signal}=fixture();
  const r=replayCodexSignal(env,signal,CODEX_EXIT_PROFILES[0],{stakeUsd:.5});
  assert.equal(r.status,'REJECTED_COST');
  assert.equal(r.buyAt,undefined);
  assert.equal(r.pnlUsd,0);
});
