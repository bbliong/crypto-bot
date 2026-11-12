import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {MultiScenarioDryRunEngine} from '../src/multi-scenario-dryrun-engine.ts';
import * as monitoring from '../src/ap-exit-monitor.ts';
import {WalletFollowerRunner} from '../scripts/run-wallet-follower.ts';

function setup() {
 const e=new MultiScenarioDryRunEngine(fs.mkdtempSync(path.join(os.tmpdir(),'ap-net10-monitor-')));
 for(const [i,s] of [e.scenarios.s14,e.scenarios.s14_alpha,e.scenarios.s14_beta].entries()){
  let ticket; e.onTradeAction=(_a,_s,_sig,d)=>{ticket=d.quoteTicket};
  const sig={mint:'same-mint',symbol:'FX',tokenName:'FX',priceUsd:.00001,remainingHolding:70e6,pairAddress:'pair',solAmount:30,usdAmount:2700};
  e.processScenarioBuy(s,sig,true,2700,Date.now(),'fixture',{maxTokenExposure:5,getStake:()=>5,allowReEntryCycle:true});
  e.syncRealBuyExecution(s.id,sig.mint,.00001,497500,4.975,{...ticket,baseUnits:'497500000000',decimals:6});
 }
 e.onTradeAction=()=>{};
 return e;
}
function dependencies(sell) { return {sell,buy:async()=>{throw Error('unexpected BUY')},sleep:async()=>{},audit:()=>{}}; }
const route=(req,gross=5)=>({ok:true,routeData:{quote:{inAmount:req.baseUnits,outAmount:String(Math.round(gross/100*1e9)),inDecimals:6,outDecimals:9}}});

test('bounded fair monitor quotes only exact active lane balances without wallet/chart signals',async()=>{
 const e=setup(),seen=[]; let active=0,peak=0;
 const m=new monitoring.ApExitMonitor(e,dependencies(async req=>{seen.push(req);peak=Math.max(peak,++active);await Promise.resolve();active--;return route(req)}),{maxConcurrency:2,cooldownMs:0});
 await m.tick(100); await m.tick(100);
 assert.equal(new Set(seen.map(x=>x.lane)).size,3); assert.ok(peak<=2);
 assert.ok(seen.every(x=>x.baseUnits==='497500000000'&&x.pairAddress==='pair'));
 for(const s of [e.scenarios.s14,e.scenarios.s14_alpha,e.scenarios.s14_beta]){
  assert.equal(s.openPositions[0].ap.status,'OPEN_QUOTED');assert.equal(s.openPositions[0].ap.lastFreshAt>0,true);
  assert.equal(s.availableCash,0);assert.equal(s.closedTrades.length,0);
 }
});

test('monitor no-route, timeout, bad quantity preserve exposure and reject late results',async()=>{
 const e=setup(); let now=Date.now(); let resolve;
 const deps=dependencies(req=>new Promise(r=>{resolve=()=>r(route(req,100))}));
 const m=new monitoring.ApExitMonitor(e,deps,{maxConcurrency:1,timeoutMs:10,cooldownMs:5000,now:()=>now});
 await m.tick(100);
 const p=e.scenarios.s14.openPositions[0];
 assert.equal(p.ap.status,'OPEN_UNPRICED'); assert.match(p.ap.lastError,/TIMEOUT/);
 resolve();await Promise.resolve();assert.equal(e.scenarios.s14.availableCash,0);
 m.deps.sell=async req=>({...route(req),ok:false,error:'NO_ROUTE'});
 now+=5001;await m.tick(100);
 assert.equal(e.scenarios.s14_alpha.openPositions.length,1);
 assert.equal(e.scenarios.s14_alpha.openPositions[0].ap.lastError,'NO_ROUTE');
 m.deps.sell=async req=>route({...req,baseUnits:'1'});
 now+=5001;await m.tick(100);
 assert.match(e.scenarios.s14_beta.openPositions[0].ap.lastError,/MALFORMED/);
});

test('monitor retries unresolved exit, settles exactly once, quote cannot sell a newer revision',async()=>{
 const e=setup(),s=e.scenarios.s14; e.executeScenarioExit(s,0,.00001,Date.now(),'fixture','WHALE_EXIT');
 const p=s.openPositions[0]; e.recordFailedSellExecution(s.id,p.mint,'NO_ROUTE',p.ap.pending);
 const m=new monitoring.ApExitMonitor(e,dependencies(async req=>route(req,5.5)),{maxConcurrency:1,cooldownMs:0});
 await m.tick(100);assert.equal(s.openPositions.length,0);assert.equal(s.closedTrades.length,1);
 assert.ok(Math.abs(s.availableCash-5.475)<1e-10);
 await m.tick(100);assert.equal(s.closedTrades.length,1);
});

test('actual runner polling uses injected monitor without constructor live data or browser',async()=>{
 const e=setup(),seen=[],r=Object.create(WalletFollowerRunner.prototype);
 r.multiDryRunEngine=e;r.solPriceUsd=100;r.apPaperDependencies=dependencies(async req=>{seen.push(req);return route(req)});
 await r.pollApExitQuotes();
 assert.equal(seen.length,2);assert.equal(e.scenarios.s14.openPositions[0].ap.status,'OPEN_QUOTED');
});
