import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {MultiScenarioDryRunEngine} from '../src/multi-scenario-dryrun-engine.ts';
import {isScenarioAllowedForRealOrder} from '../src/autobuy-scenario-guard.ts';
import {ApExitMonitor} from '../src/ap-exit-monitor.ts';

const families=[['s14','evaluateS14BundlerEntry','s14Trackers','AP1-10%'],
 ['s14_alpha','evaluateS14AlphaBundlerEntry','s14AlphaTrackers','AP2-10%'],
 ['s14_beta','evaluateS14BetaBundlerEntry','s14BetaTrackers','AP3-10%']];
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-net10-variants-'));
 const e=new MultiScenarioDryRunEngine(dir); e.startBundlerResearchTracker=()=>{};e.queryGmgnTokenStatRaw=async()=>null;e.bundlerResolver=async()=>null;
 const sig={action:'buy',mint:'Offline',symbol:'FX',tokenName:'FX',tokenAmount:70e6,remainingHolding:70e6,
 solAmount:30,usdAmount:2700,priceUsd:.00001,pairAddress:'',timestamp:Math.floor((Date.now()-65000)/1000),isFirstBuy:true,isOpenOrClose:true};
 // Avoid unrelated legacy RPC/timer paths by initialize through the AP radar-only entry point.
 e.observeApNet10Buy?.(sig,true);
 for(const [, ,map] of families)e[map].set(sig.mint,{mint:sig.mint,symbol:'FX',whaleFirstBuyAt:Date.now()-65000,
 whaleFirstBuyUsd:2700,whaleFirstBuySol:30,whaleRemainingHolding:70e6,whalePeakHolding:70e6,whaleBuysCount:1,
 consecutiveWhaleSells:0,hasEntered:false,status:'OBSERVING_BUNDLER',peakPriceUsd:.00001,targetBuySignal:sig});
 const calls=[];e.onTradeAction=(...a)=>calls.push(a);return {e,dir,sig,calls};}
function settle(e,call){const [,id,sig,d]=call;const units=497500000000;
 e.syncRealBuyExecution(id,sig.mint,.00001,units/1e6,d.stakeUsd,{...d.quoteTicket,baseUnits:String(units),decimals:6});}
for(const [key,method,map,name] of families){
 test(`${name}: additive identity PAPER denied even ALL and aliases`,()=>{
  const {e}=setup(),s=e.scenarios[key+'_net10'];assert.ok(s,'independent additive state exists');assert.equal(s.name,name);assert.equal(s.availableCash,5);
  for(const alias of [name,key+'_net10','sce'+key.slice(1)+'_net10',s.id]){
   assert.equal(e.getScenarioById(alias),s);
   for(const target of ['BOTH','ALL',name,'AP1+ALL'])assert.equal(isScenarioAllowedForRealOrder(alias,{enabled:true,autobuyScenario:target}),false);
  }
 });
 test(`${name}: bundler below 5 / unknown rejected, exactly 5 inherits entry independently from cash0 control`,()=>{
  const f=setup(),{e,sig,calls}=f;e.scenarios[key].availableCash=0;
  for(const bad of [4.999,null,undefined,NaN,Infinity,-Infinity])e[method](sig.mint,bad,.00001);
  assert.equal(calls.length,0);
  e[method](sig.mint,5,.00001);
  assert.equal(calls.length,1);assert.equal(calls[0][1],e.scenarios[key+'_net10'].id);
  assert.equal(calls[0][3].stakeUsd,4.975);
 });
 test(`${key} control rejects NaN bundler rather than bypass >=5 gate`,()=>{
  const {e,sig,calls}=setup();e[method](sig.mint,NaN,.00001);
  assert.equal(calls.length,0);
 });
}

test('net10 only full-exits exact fresh whole-position net >=10%, never spot +50 partial; controls retain partial TP',async()=>{
 const {e,sig,calls}=setup();e.evaluateS14BundlerEntry(sig.mint,5,.00001);
 assert.equal(calls.length,2);for(const c of calls.slice())settle(e,c);
 const control=e.scenarios.s14,variant=e.scenarios.s14_net10;
 e.updatePriceTick(sig.mint,.000016);
 assert.equal(variant.openPositions[0].stage1Exited,undefined);
 assert.equal(control.openPositions[0].ap.exitReason,'S14_STAGE_1_TP_50%');
 let gross=5.5249999;
 const deps={sell:async req=>({ok:true,routeData:{quote:{inAmount:req.baseUnits,outAmount:String(Math.round(gross/100*1e9)),inDecimals:6,outDecimals:9}}}),audit:()=>{},buy:async()=>{},sleep:async()=>{}};
 const monitor=new ApExitMonitor(e,deps,{cooldownMs:0,maxConcurrency:6});
 await monitor.tick(100);assert.equal(variant.closedTrades.length,0,'slightly below net10 stays open');
 gross=5.525;await monitor.tick(100);
 assert.equal(variant.openPositions.length,0);assert.equal(variant.closedTrades.length,1);
 assert.ok(Math.abs(variant.closedTrades[0].roiPct-10)<1e-10);
 assert.equal(variant.closedTrades[0].exitReason,'NET_TP_10%_FULL');
});

test('AP2/3 variants preserve 60s grace; AP3 min/max bag/no full dump; trackers persist independently',()=>{
 const {e,dir,sig,calls}=setup();
 for(const key of ['s14_alpha_net10','s14_beta_net10'])e.scenarios[key].apTrackers[sig.mint].whaleFirstBuyAt=Date.now();
 e.evaluateS14AlphaBundlerEntry(sig.mint,5);e.evaluateS14BetaBundlerEntry(sig.mint,5);
 assert.equal(calls.filter(c=>c[1].endsWith('_NET10')).length,0);
 const beta=e.scenarios.s14_beta_net10.apTrackers[sig.mint];beta.whaleFirstBuyAt=Date.now()-65000;beta.hasEverDumpedAll=true;
 e.evaluateS14BetaBundlerEntry(sig.mint,5);assert.equal(e.scenarios.s14_beta_net10.openPositions.length,0);
 e.saveState();const r=new MultiScenarioDryRunEngine(dir);
 assert.equal(r.scenarios.s14_beta_net10.apTrackers[sig.mint].hasEverDumpedAll,true);
 assert.notEqual(r.scenarios.s14_beta_net10.apTrackers,r.scenarios.s14_beta.apTrackers);
});

test('pending BUY cannot SELL, but whale safety observed during quote is retained for post-settlement exit',()=>{
 const {e,sig,calls}=setup();e.evaluateS14BundlerEntry(sig.mint,5,.00001);
 const buys=calls.slice();const s=e.scenarios.s14_net10;
 e.handleTargetSell({...sig,action:'sell',remainingHolding:0,solAmount:20,usdAmount:2000,isOpenOrClose:true});
 assert.equal(s.openPositions[0].tokens,0);assert.equal(s.closedTrades.length,0);
 assert.equal(calls.filter(c=>c[0]==='SELL').length,0,'cannot sell pending tokens');
 for(const c of buys)settle(e,c);
 assert.equal(s.openPositions[0].ap.status,'EXIT_UNAVAILABLE');
 assert.match(s.openPositions[0].ap.exitReason,/WHALE/);
});

test('AP3 net10 preserves exact bag gate endpoints and independently follows whale hoarding >=25%',()=>{
 for(const [holding,allowed]of [[14999999,false],[15000000,true],[80000000,true],[80000001,false]]){
  const {e,sig,calls}=setup();const t=e.scenarios.s14_beta_net10.apTrackers[sig.mint];
  t.whaleRemainingHolding=holding;t.whalePeakHolding=holding;
  e.evaluateS14BetaBundlerEntry(sig.mint,5,.00001);
  assert.equal(calls.some(c=>c[1]===e.scenarios.s14_beta_net10.id),allowed,String(holding));
 }
 const {e,sig,calls}=setup();e.evaluateS14BetaBundlerEntry(sig.mint,5,.00001);
 for(const c of calls.slice())settle(e,c);
 e.observeApNet10Buy({...sig,remainingHolding:87.5e6,isFirstBuy:false,timestamp:Math.floor(Date.now()/1000)},false);
 assert.match(e.scenarios.s14_beta_net10.openPositions[0].ap.exitReason,/HOARDING/);
 assert.equal(e.scenarios.s14_beta.openPositions[0].ap.exitReason,undefined,'clone observation does not mutate control tracker');
});
