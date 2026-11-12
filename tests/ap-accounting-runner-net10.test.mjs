import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {MultiScenarioDryRunEngine} from '../src/multi-scenario-dryrun-engine.ts';
import {WalletFollowerRunner} from '../scripts/run-wallet-follower.ts';

function setup(second) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-net10-runner-'));
  const e=new MultiScenarioDryRunEngine(dir), s=e.scenarios.s14, calls=[], audit=[];
  const r=Object.create(WalletFollowerRunner.prototype);
  r.multiDryRunEngine=e; r.dataDir=dir; r.solPriceUsd=100;
  r.apPaperDependencies={buy:async (req)=>{calls.push(req); return calls.length===1 ?
    {ok:true,routeData:{quote:{inAmount:'49750000',outAmount:'500000000000',outDecimals:6}}}:second();},
    sell:async()=>{throw Error('unexpected sell')},sleep:async()=>{},audit:x=>audit.push(x)};
  let action;
  e.onTradeAction=(...a)=>{action=a};
  const signal={mint:'Offline',symbol:'FX',tokenName:'FX',priceUsd:.00001,remainingHolding:70e6,solAmount:30,usdAmount:2700,pairAddress:'FixturePair'};
  e.processScenarioBuy(s,signal,true,2700,Date.now(),'fixture',{maxTokenExposure:5,getStake:()=>5,allowReEntryCycle:true});
  return {r,e,s,calls,audit,action};
}

test('actual runner paper path quotes reserved 4.975 twice, selects and audits probe 2 without real wallet calls',async()=>{
  const f=setup(()=>({ok:true,routeData:{quote:{inAmount:'49750000',outAmount:'248750000000',outDecimals:6}}}));
  await f.r.executeApPaperAction(...f.action);
  assert.deepEqual(f.calls.map(x=>x.stakeUsd),[4.975,4.975]);
  assert.equal(f.s.openPositions[0].tokens,248750);
  assert.deepEqual(f.audit.map(x=>x.probe),[1,2]);
  assert.equal(f.audit[1].selected,true);
  assert.equal(f.audit[1].quote.outAmount,'248750000000');
});
for(const [name,second] of [['throw',()=>{throw Error('offline throw')}],['malformed',()=>({ok:true,routeData:{}})],
  ['no route',()=>({ok:false,error:'NO_ROUTE'})]]) {
  test(`probe 2 ${name} fails closed and refunds reservation`,async()=>{
    const f=setup(second); await f.r.executeApPaperAction(...f.action);
    assert.equal(f.s.openPositions.length,0); assert.equal(f.s.availableCash,5); assert.equal(f.s.totalFeesPaid,0);
    assert.equal(f.audit.length,2); assert.equal(f.audit[1].selected,false);
  });
}
