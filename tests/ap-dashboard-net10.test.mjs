import {test} from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {EventEmitter} from 'node:events';
import {MultiScenarioDryRunEngine} from '../src/multi-scenario-dryrun-engine.ts';
import {AP_LANES} from '../src/ap-lanes.ts';
import {render3ScenariosLiveHtml} from '../scripts/render-3scenarios-live.mjs';
import {normalizeScenarioId,SCENARIO_META,getScenarioTokenTimeline} from '../scripts/scenarios-timeline-aggregator.mjs';
import {handleFollowerDashboardRequest} from '../scripts/serve-wallet-follower-dashboard.mjs';

function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ap-net10-ui-'));const e=new MultiScenarioDryRunEngine(dir);
 e.scenarios.s14.availableCash=0;e.scenarios.s14.closedTrades.push({mint:'old',symbol:'LEGACY',openedAt:1,closedAt:2,totalInvestedUsd:5,totalReturnedUsd:0,realizedPnlUsd:-5,roiPct:-100,exitReason:'OLD'});
 e.saveState();return {dir,e};}

test('six cards render exact names PAPER only, accounting provenance and unmatched cohort with safe scripts',()=>{
 const {dir,e}=setup();
 fs.writeFileSync(path.join(dir,'follower-autobuy-settings.json'),JSON.stringify({enabled:true,autobuyScenario:'ALL'}));
 const s=e.scenarios.s14_alpha_net10;s.openPositions.push({mint:'pending',symbol:'PEND',tokens:0,costBasisUsd:4.975,entryCount:1,unrealizedPnlUsd:0,ap:{status:'BUY_PENDING',version:2,lastError:'NO_ROUTE'}});e.saveState();
 const html=render3ScenariosLiveHtml({dataDir:dir});
 assert.equal((html.match(/class="scenario-panel"/g)||[]).length,6);
 for(const lane of AP_LANES){assert.match(html,new RegExp(lane.label.replace('%','%')));assert.ok(html.includes('/3scenarios/sce'+lane.key.slice(1)));}
 assert.match(html,/PAPER ONLY/);assert.match(html,/unmatched legacy capital cohort/i);assert.match(html,/BUY_PENDING/);assert.match(html,/legacy-unreconciled/i);
 assert.doesNotMatch(html,/<input[^>]+value="AP[123]-10%"/);
 for(const [,script]of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(script);
});

test('exact alias normalization and ledger filters keep all net10 identities separate from base and scenario10',()=>{
 for(const lane of AP_LANES){const route='sce'+lane.key.slice(1);
  for(const id of [lane.id,lane.label,...lane.aliases])assert.equal(normalizeScenarioId(id),route);
  assert.equal(SCENARIO_META[route].canonicalKey,lane.key);
  if(lane.net10){const base=SCENARIO_META['sce'+lane.parentKey.slice(1)];assert.equal(base.ledgerFilter(lane.id,'SWAP_SIMULATION_BUY_'+lane.id),false);}
 }
});

test('AP timeline retains pending exposure/probe history and never synthesizes old spot fills',async()=>{
 const {dir,e}=setup();const s=e.scenarios.s14_net10;
 s.openPositions.push({mint:'same',symbol:'DUP',openedAt:100,updatedAt:101,costBasisUsd:4.975,tokens:0,ap:{version:2,status:'BUY_PENDING',lastError:'timeout'}});
 s.recentEvents=[{id:'i',mint:'same',symbol:'DUP',timestamp:100,action:'BUY_INTENT',reason:'pending'}];e.saveState();
 const data=await getScenarioTokenTimeline('AP1-10%','same',{dataDir:dir});
 assert.equal(data.scenarioId,'sce14_net10');assert.equal(data.summary.status,'BUY_PENDING');assert.equal(data.summary.accountingVersion,2);
 assert.equal(data.steps[0].type,'BUY_INTENT');assert.equal(data.summary.returnedUsd,0);assert.equal(data.summary.historicalAlternativePnl,'UNKNOWN');
 const legacy=await getScenarioTokenTimeline('AP1','old',{dataDir:dir});assert.equal(legacy.summary.provenance,'legacy-unreconciled');
});

test('actual dashboard request handler resolves net10 BEFORE base substring routes, without a listening server',async()=>{
 const {dir}=setup();const old=process.env.FOLLOWER_DASHBOARD_DATA_DIR;process.env.FOLLOWER_DASHBOARD_DATA_DIR=dir;
 try{for(const lane of AP_LANES.filter(l=>l.net10)){
  for(const alias of [lane.label,'sce'+lane.key.slice(1)]){
   const result=await new Promise((resolve,reject)=>{const res={writeHead(code,headers){this.code=code;},end(body){resolve({code:this.code,body})}};
    try{handleFollowerDashboardRequest({url:'/add-fol/3scenarios/'+encodeURIComponent(alias),method:'GET',headers:{host:'offline'}},res)}catch(e){reject(e)}});
   assert.equal(result.code,200);assert.ok(result.body.includes(lane.label));assert.match(result.body,/PAPER ONLY/);
  }
 }}finally{if(old===undefined)delete process.env.FOLLOWER_DASHBOARD_DATA_DIR;else process.env.FOLLOWER_DASHBOARD_DATA_DIR=old}
});

test('API refuses variant arming before any settings mutation and serves exact variant timeline JSON',async()=>{
 const {dir}=setup(),old=process.env.FOLLOWER_DASHBOARD_DATA_DIR;process.env.FOLLOWER_DASHBOARD_DATA_DIR=dir;
 try{
  for(const id of ['AP1-10%','ALL+AP2-10%','SCENARIO_14_BETA_HOARDING_DEFENSE_NET10']){
   const result=await new Promise(resolve=>{
    const req=new EventEmitter();Object.assign(req,{url:'/api/autobuy/config',method:'POST',headers:{host:'offline'}});
    const res={writeHead(code){this.code=code},end(body){resolve({code:this.code,body})}};
    handleFollowerDashboardRequest(req,res);req.emit('data',JSON.stringify({enabled:true,autobuyScenario:id}));req.emit('end');
   });
   assert.equal(result.code,400);assert.match(result.body,/PAPER_ONLY/);
  }
  const result=await new Promise(resolve=>handleFollowerDashboardRequest({url:'/api/scenarios/timeline?scenario=AP2-10%25',method:'GET',headers:{host:'offline'}},
   {writeHead(code){this.code=code},end(body){resolve({code:this.code,body})}}));
  assert.equal(result.code,200);assert.equal(JSON.parse(result.body).scenarioId,'sce14_alpha_net10');
 }finally{if(old===undefined)delete process.env.FOLLOWER_DASHBOARD_DATA_DIR;else process.env.FOLLOWER_DASHBOARD_DATA_DIR=old}
});
