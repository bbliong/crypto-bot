import test from 'node:test';
import assert from 'node:assert/strict';
import {costTempoScore,costTempoSetup,signalsCostTempoV12,createTempoState,assessTempoExit,evaluateCostTempoV12,TEMPO_CONFIGS} from '../scripts/codex-cost-tempo-v12.mjs';
import {flowWaveNetReturn} from '../src/codex-flow-wave-v2.ts';
const frame=at=>({at,price:100,priceAt:at,tickId:String(at),mc:20000,tokenAgeSec:120,holders:150,top1:3,top5:12,dev:1,
  ready:true,holderFresh:true,devFresh:true,countFresh:true,devSell30:0,majorSell:false,collapse1s:0,return2:3,return5:6,
  buy2:.8,buy5:.8,buy20:.8,topBuyer:.3,buyers:5,trades:10,buyUsd:500,drawdown5:0,sigma1:1,efficiency20:.8});
test('break-even gross includes both network legs and fee sides',()=>{
  const score=costTempoScore(frame(0),120,.25);
  assert.ok(Math.abs(flowWaveNetReturn(5,120,1,1+score.grossBreakEven/100,.01,.000205))<1e-10);
  assert.ok(score.grossBreakEven>2);assert.ok(costTempoScore(frame(0),300,.25).grossBreakEven>score.grossBreakEven);
});
test('cost gate refuses small positive momentum and dangerous concentration',()=>{
  assert.equal(costTempoSetup({...frame(0),return2:.1,return5:.5},120,.25).allowed,false);
  assert.equal(costTempoSetup({...frame(0),majorSell:true},120,.25).allowed,false);
  assert.equal(costTempoSetup({...frame(0),top1:12},120,.25).allowed,false);
});
test('independent setup requires distinct ticks and preserves prefix invariance',()=>{
  const s={id:'s',start:0,mint:'m'},p={end:90000,frames:[frame(0),{...frame(250),tickId:'0'},frame(500)]};
  const a=signalsCostTempoV12(s,p,[]);assert.equal(a.length,2);assert.equal(a[0].at,500);
  assert.deepEqual(a,signalsCostTempoV12(s,{...p,frames:[...p.frames,{...frame(750),collapse1s:-90}]},[]));
});
test('stale or same-tick frames cannot confirm a setup',()=>{
  const s={id:'s',start:0,mint:'m'},p={end:90000,frames:[frame(0),{...frame(500),tickId:'0'}]};
  assert.equal(signalsCostTempoV12(s,p,[]).length,0);
  assert.equal(costTempoSetup({...frame(1000),priceAt:0},120,.25).allowed,false);
});
test('tempo promotions need persistence and cannot extend initial hold limit',()=>{
  const s=createTempoState(0,-3,{...frame(0),buy2:.6});assert.equal(s.mode,'SCALP');
  assessTempoExit(s,frame(250),0);assert.equal(s.mode,'SCALP');
  assessTempoExit(s,frame(1000),0);assert.equal(s.mode,'SCALP');
  assessTempoExit(s,frame(1250),0);assert.equal(s.mode,'RUNNER');assert.equal(s.maxHoldMs,15000);
});
test('profit floor never loosens when volatility or mode changes',()=>{
  const s=createTempoState(0,-3,frame(0));assessTempoExit(s,{...frame(1000),buy2:.6},20);
  const floor=s.floor;assessTempoExit(s,{...frame(3000),sigma1:2},21);assert.ok(s.floor>=floor);
});
test('weak flow needs distinct fresh ticks and a 500ms confirmation',()=>{
  const s=createTempoState(0,-3,frame(0)),weak=at=>({...frame(at),buy5:.3,return2:-1,sellUsd:200,sellers:3});
  assert.equal(assessTempoExit(s,weak(1000),0),null);
  assert.equal(assessTempoExit(s,{...weak(1500),tickId:'1000'},0),null);
  assert.equal(assessTempoExit(s,weak(1750),0),'FLOW_REVERSAL');
});
test('unknown delayed fill remains unknown and consumes no fabricated quote',()=>{
  const r=evaluateCostTempoV12({at:0,price:100,solUsd:120,lambda:.25},{frames:[],ticks:[],end:500},TEMPO_CONFIGS[1],{delayMs:1000,feeSide:.01});
  assert.equal(r.status,'BUY_UNKNOWN');assert.equal(r.pnl,null);
});
