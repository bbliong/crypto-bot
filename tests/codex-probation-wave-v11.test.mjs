import test from 'node:test';
import assert from 'node:assert/strict';
import {createProbationV11,assessProbationV11} from '../scripts/codex-probation-wave-v11.mjs';
const frame=(at,price=100)=>({at,price,priceAt:at,tickId:String(at),tickCount:0,devSell30:0,majorSell:false,collapse1s:0,
  buy2:.4,return2:-1,sellUsd:200,sellers:2});
const config={probationMs:3000,floor:'NATIVE'};
test('probation needs two observed ticks spanning confirmation time',()=>{
  const s=createProbationV11(config,0,-3,100);
  assert.equal(assessProbationV11(s,frame(500),-4.2,[]),null);
  assert.equal(assessProbationV11(s,{...frame(750),tickId:'500'},-4.2,[]),null);
  assert.equal(assessProbationV11(s,frame(1000),-4.2,[]),'POSTBUY_PROBATION');
});
test('probation ends on its buy-relative deadline and does not delay hard risk',()=>{
  const s=createProbationV11(config,0,-3,100);
  assert.equal(assessProbationV11(s,frame(3500),-4.2,[]),null);
  assert.equal(assessProbationV11(s,frame(3600),-7,[]),'HARD_NET_RISK');
});
test('early net floor ratchets monotonically and overrides a recovery episode',()=>{
  const s=createProbationV11({...config,floor:'EARLY'},0,-3,100);
  assessProbationV11(s,{...frame(500,106),buy2:.8,return2:2},2.5,[]);assert.equal(s.floor,.5);
  assert.equal(assessProbationV11(s,frame(750,103),.4,[]),'EARLY_NET_FLOOR');
});
test('native floor cannot loosen when peak crosses the wider trailing tier',()=>{
  const s=createProbationV11(config,0,-3,100);
  const tick=(at,priceUsd)=>({id:String(at),observedAt:at,occurredAt:at,priceUsd,side:'buy',usd:100,wallet:'w'});
  const ticks=[tick(500,122.9),tick(1000,123.1),tick(1500,116)];
  assessProbationV11(s,{...frame(500,122.9),tickCount:1},19.9,ticks);const floor=s.nativeFloor;
  assessProbationV11(s,{...frame(1000,123.1),tickCount:2},20.1,ticks);assert.equal(s.nativeFloor,floor);
  assert.equal(assessProbationV11(s,{...frame(1500,116),tickCount:3},13,ticks),'MONOTONE_NATIVE_FLOOR');
});
