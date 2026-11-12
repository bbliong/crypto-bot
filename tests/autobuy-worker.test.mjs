import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WalletFollowerRunner} from '../scripts/run-wallet-follower.ts';
import {saveFollowerLiveConfig} from '../src/follower-live-store.ts';
const ids=['SCENARIO_14_BUNDLER_RUNNER','SCENARIO_14_ALPHA_60S_GRACE','SCENARIO_14_BETA_HOARDING_DEFENSE'];
for(const id of ids)test('worker OFF makes quote-only probes for '+id,async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s14-worker-test-'));
 try{
  saveFollowerLiveConfig(dir,{enabled:false,autobuyScenario:'DRY_RUN',autoSell:false});
  let quotes=0,submits=0,buySync=0,sellSync=0;
  const runner=Object.create(WalletFollowerRunner.prototype);
  Object.assign(runner,{dataDir:dir,solPriceUsd:100,page:{isClosed:()=>false,evaluate:async()=>{
   quotes++;return {ok:true,status:200,latencyMs:1,impliedPriceUsd:0.05,routeData:{exchange:'OFFLINE_FIXTURE',quote:{inAmount:'1000000',outAmount:'100000000'}}};
  }},liveAdapter:{submitSwapOrder:async()=>{submits++;throw new Error('REAL_SUBMISSION_FORBIDDEN_IN_TEST');}},multiDryRunEngine:{syncRealBuyExecution:()=>buySync++,syncRealSellExecution:()=>sellSync++,abortScenarioBuy:()=>{},recordFailedSellExecution:()=>{}}});
  const signal={mint:'OFFLINE_FIXTURE_MINT',symbol:'TEST',pairAddress:'OFFLINE_FIXTURE_POOL',priceUsd:0.05};
  await runner.executeGmgnApiProbe('BUY',id,signal,5,'ENTRY',100);
  await runner.executeGmgnApiProbe('SELL',id,signal,5,'STAGE_1_TP_50%',50);
  assert.equal(quotes,3);assert.equal(submits,0);assert.equal(buySync,1);assert.equal(sellSync,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('worker rechecks OFF after quote and before real submit',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'s14-worker-race-'));
 try{
  saveFollowerLiveConfig(dir,{enabled:true,autobuyScenario:'S14',autoSell:false,maxBuysQuota:3});
  let submits=0;
  const runner=Object.create(WalletFollowerRunner.prototype);
  Object.assign(runner,{dataDir:dir,solPriceUsd:100,page:{isClosed:()=>false,evaluate:async()=>{
   saveFollowerLiveConfig(dir,{enabled:false,autobuyScenario:'DRY_RUN'});
   return {ok:true,status:200,latencyMs:1,impliedPriceUsd:0.05,routeData:{quote:{inAmount:'50000000',outAmount:'100000000'}}};
  }},liveAdapter:{submitSwapOrder:async()=>{submits++;throw new Error('FORBIDDEN');}},multiDryRunEngine:{}});
  await runner.executeGmgnApiProbe('BUY',ids[0],{mint:'TEST',symbol:'TEST',pairAddress:'POOL'},5,'ENTRY',100);
  assert.equal(submits,0);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
