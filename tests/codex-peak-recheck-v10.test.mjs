import test from 'node:test';
import assert from 'node:assert/strict';
import {createMomentumPosition} from '../src/momentum-strategy.ts';
import {assessPeakV10,evaluatePeakV10} from '../scripts/codex-peak-recheck-v10.mjs';
const tick=(at,priceUsd)=>({id:String(at),observedAt:at,occurredAt:at,priceUsd,side:'buy',usd:100,wallet:'w'});
test('peak wrapper only ratchets from ticks already present at the frame',()=>{
  const s={position:createMomentumPosition(1000,100,1000),lastTick:null},ticks=[tick(1000,100),tick(2000,120),tick(3000,200)];
  assessPeakV10(s,{at:2000,tickId:'2000',tickCount:2},ticks);assert.equal(s.position.peak,120);
  assessPeakV10(s,{at:2250,tickId:'2000',tickCount:2},ticks);assert.equal(s.position.peak,120);
});
test('native trailing becomes reachable after a prior observed price peak',()=>{
  const s={position:createMomentumPosition(1000,100,1000),lastTick:null},ticks=[tick(1000,100),tick(2000,120),tick(3000,113)];
  assert.equal(assessPeakV10(s,{at:2000,tickId:'2000',tickCount:2},ticks),null);
  assert.equal(assessPeakV10(s,{at:3000,tickId:'3000',tickCount:3},ticks),'ADAPTIVE_TRAILING_STOP');
});
test('peak wrapper retains unknown when no delayed buy exists',()=>{
  const r=evaluatePeakV10({at:0,price:100,solUsd:120,mode:'AGY',lane:'AGY_NATIVE'},
    {ticks:[],frames:[],end:2000},{waitMs:0},{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'BUY_UNKNOWN');assert.equal(r.pnl,null);
});
