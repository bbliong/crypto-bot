import test from 'node:test';
import assert from 'node:assert/strict';
import {FLOW_WAVE_ENTRIES,FLOW_WAVE_EXITS,flowWaveEntryAllowed,flowWaveNetFloor,flowWaveNetReturn,type FlowWaveFeatures} from '../src/codex-flow-wave-v2.js';
const f=():FlowWaveFeatures=>({historySec:25,ready:true,return5:4,return2:2,drawdown5:1,buy5:.85,buy2:.8,buy10:.75,buy20:.7,
  buyers:6,trades:9,buyUsd:900,topBuyer:.3,mc:20000,top1:3,top5:15,dev:1,holders:100,tokenAgeSec:90,
  holderFresh:true,devFresh:true,countFresh:true,majorSell:false,devSell30:0,drawdown10:5,rebound10:3,peakBeforeTrough:true,aboveWeightedPrice:true});
test('v2 entries require known distribution and received momentum evidence',()=>{
  assert.equal(flowWaveEntryAllowed(f(),FLOW_WAVE_ENTRIES[0]!),true);
  for(const patch of [{top1:null},{dev:null},{holderFresh:false},{devFresh:false},{tokenAgeSec:null},{majorSell:true},{return2:-1}])
    assert.equal(flowWaveEntryAllowed({...f(),...patch},FLOW_WAVE_ENTRIES[0]!),false);
});
test('long-window entry cannot use a short observation as if it were 20 seconds',()=>{
  assert.equal(flowWaveEntryAllowed({...f(),historySec:12},FLOW_WAVE_ENTRIES[4]!),false);
});
test('reclaim requires earlier peak then trough and a distributed recovery',()=>{
  const r=FLOW_WAVE_ENTRIES[3]!;
  assert.equal(flowWaveEntryAllowed(f(),r),true);
  assert.equal(flowWaveEntryAllowed({...f(),peakBeforeTrough:false},r),false);
  assert.equal(flowWaveEntryAllowed({...f(),rebound10:10},r),false);
  assert.equal(flowWaveEntryAllowed({...f(),buy2:.65},r),false);
});
test('net valuation includes fixed costs and has no flat three-percent approximation',()=>{
  const small=flowWaveNetReturn(.5,120,1,1),larger=flowWaveNetReturn(10,120,1,1);
  assert.ok(small < -11);assert.ok(larger > -3);
});
test('v2 incremental market-risk budget does not immediately stop solely on known opening fees',()=>{
  const immediate=flowWaveNetReturn(.5,120,1,1),r=FLOW_WAVE_EXITS[1]!;
  assert.ok(immediate > flowWaveNetFloor(immediate,r));
  assert.equal(flowWaveNetFloor(immediate,r),immediate-6);
  assert.equal(flowWaveNetFloor(-19,r),-20);
});
test('prices gapping below a stop retain their actual modeled loss',()=>{
  assert.ok(flowWaveNetReturn(.5,120,1,.5)<-50);
});
