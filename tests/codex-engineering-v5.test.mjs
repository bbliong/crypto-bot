import test from 'node:test';
import assert from 'node:assert/strict';
import {planEntryV5,createGuardStateV5,assessGuardExitV5,evaluateV5,gateV5} from '../scripts/codex-engineering-v5.mjs';
const frame=(at,price=100)=>({at,price,priceAt:at,tickId:String(at),ready:true,historySec:30,
  return5:3,return2:1,drawdown5:.5,buy5:.75,buy2:.7,buy20:.75,buyers:6,trades:10,buyUsd:700,topBuyer:.3,
  mc:20000,top1:3,top5:12,dev:1,holders:150,tokenAgeSec:120,holderFresh:true,devFresh:true,countFresh:true,
  majorSell:false,devSell30:0,efficiency20:.6,sigma1:2,sellUsd:100,sellers:1,collapse1s:0});
const signal={id:'opportunity',at:0,price:100,solUsd:120,mode:'AGY',lane:'AGY_NATIVE'};
test('confirmation requires elapsed time and a distinct tick',()=>{
  const frames=[frame(0),frame(1000),{...frame(1500),tickId:'1000'},frame(1750)];
  assert.equal(planEntryV5(signal,{frames},'CONFIRM_1S').at,1750);
  assert.equal(planEntryV5(signal,{frames:frames.slice(0,3)},'CONFIRM_1S').signal,null);
});
test('confirmed entry is invariant to future frames and does not inspect capture duration',()=>{
  const frames=[frame(0),frame(1000),frame(1500)],a=planEntryV5(signal,{frames},'CONFIRM_1S');
  const b=planEntryV5(signal,{frames:[...frames,{...frame(1750),devSell30:100}],end:999999},'CONFIRM_1S');
  assert.deepEqual(a,b);
});
test('reclaim uses a past dip and rebound, never a future trough',()=>{
  const frames=[frame(0),frame(1000,98),frame(1500,99.1),frame(2000,99.2)];
  assert.equal(planEntryV5(signal,{frames},'RECLAIM').at,2000);
  assert.equal(planEntryV5(signal,{frames:[frame(0),frame(1000),frame(1500)]},'RECLAIM').signal,null);
});
test('danger cancels prebuy rather than waiting for a known later recovery',()=>{
  const frames=[frame(0),{...frame(500),devSell30:30},frame(1000),frame(1500)];
  assert.equal(planEntryV5(signal,{frames},'CONFIRM_1S').reason,'PREBUY_DANGER');
});
test('confirmation refuses stale safety snapshots and chasing over the price cap',()=>{
  for(const change of [{holderFresh:false},{countFresh:false},{price:102}]){
    const frames=[frame(0),{...frame(1000),...change},{...frame(1500),...change}];
    assert.equal(planEntryV5(signal,{frames},'CONFIRM_1S').signal,null);
  }
});
test('entry gates use the initial context, not a future better value',()=>{
  const frames=[frame(0),{...frame(1000),mc:30000},{...frame(1500),mc:30000}];
  assert.equal(planEntryV5(signal,{frames},'CONFIRM_1S','MC25K').reason,'GATE');
  assert.equal(gateV5('SIGMA_MAX3',{sigma1:null}),false);
});
test('short harvest uses a fixed buy-relative deadline and monotonically increasing floor',()=>{
  const s=createGuardStateV5('HARVEST',0,-3,100);
  assert.equal(assessGuardExitV5(s,frame(1000),9,[]),null);const floor=s.floor;
  assert.equal(assessGuardExitV5(s,frame(2000),6,[]),null);assert.equal(s.floor,floor);
  assert.equal(assessGuardExitV5(s,frame(12000),6,[]),'TIME_LIMIT');
});
test('hard risk remains active even when price gap overshoots the stop',()=>{
  for(const mode of ['GUARD','HARVEST'])assert.equal(assessGuardExitV5(createGuardStateV5(mode,0,-3,100),frame(1000),-70,[]),'HARD_NET_RISK');
});
test('no entry spends no money; missing delayed buy remains unknown, not a free skip',()=>{
  const options={delayMs:1000,feeSide:.01},prepared={frames:[frame(0)],ticks:[],end:2000};
  assert.equal(evaluateV5(signal,prepared,{entryMode:'CONFIRM_1S',exitMode:'GUARD'},options).status,'SKIP');
  const out=evaluateV5(signal,prepared,{entryMode:'DIRECT',exitMode:'GUARD'},options);
  assert.equal(out.status,'BUY_UNKNOWN');assert.equal(out.pnl,null);
});
