import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as guard from '../src/autobuy-scenario-guard.ts';
import {isScenarioAllowedForRealOrder as allowed, getScenarioStakeUsd} from '../src/autobuy-scenario-guard.ts';
import {saveFollowerLiveConfig, readFollowerLiveConfig} from '../src/follower-live-store.ts';
import {MultiScenarioDryRunEngine} from '../src/multi-scenario-dryrun-engine.ts';
import {render3ScenariosLiveHtml} from '../scripts/render-3scenarios-live.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autobuy-contract-'));
process.on('exit',()=>fs.rmSync(dir,{recursive:true,force:true}));
const ids=['SCENARIO_14_BUNDLER_RUNNER','SCENARIO_14_ALPHA_60S_GRACE','SCENARIO_14_BETA_HOARDING_DEFENSE'];
test('non-boolean enabled cannot arm real execution',()=>{
 for(const enabled of ['false',1,'true',null]) assert.equal(allowed(ids[0],{enabled,autobuyScenario:'S14'}),false);
});
test('OFF or invalid component denies entire composite',()=>{
 for(const autobuyScenario of ['OFF+S14','DRY_RUN+S15','S14+BOGUS','BOTH+OFF'])
  for(const id of ids) assert.equal(allowed(id,{enabled:true,autobuyScenario}),false);
});
test('new scenario stakes never leak across families',()=>{
 const c={stakeUsdS13:0.25,stakeUsdS13Alpha:0.25,stakeUsdS14:0.5};
 assert.equal(getScenarioStakeUsd(ids[0],{}),5);
 assert.equal(getScenarioStakeUsd(ids[1],c),5);
 assert.equal(getScenarioStakeUsd(ids[2],c),5);
 assert.equal(getScenarioStakeUsd(ids[0],{stakeUsdS13:0.25}),5);
});
test('explicit arm works only when requested; OFF/DRY_RUN always disarm',()=>{
 for(const sc of ['S14','S14_ALPHA','S15']){
  const c=saveFollowerLiveConfig(dir,{autobuyScenario:sc,enabled:true});assert.equal(c.enabled,true);
  assert.equal(saveFollowerLiveConfig(dir,{autobuyScenario:'DRY_RUN',enabled:true}).enabled,false);
 }
});
test('S15/Beta alias stake updates synchronize persisted values',()=>{
 saveFollowerLiveConfig(dir,{stakeUsdS15:2});
 const c=saveFollowerLiveConfig(dir,{stakeUsdS14Beta:0.75});
 assert.equal(c.stakeUsdS15,0.75);assert.equal(c.stakeUsdS14Beta,0.75);
});
test('all actual engine IDs isolate the new selections',()=>{
 const engine=new MultiScenarioDryRunEngine(dir);
 for(let i=0;i<ids.length;i++){
  const target=['S14','S14_ALPHA','S15'][i];
  for(const s of Object.values(engine.scenarios)) assert.equal(allowed(s.id,{enabled:true,autobuyScenario:target}),s.id===ids[i],target+' -> '+s.id);
 }
});
test('real partial exit preserves moonbag and composite PnL',()=>{
 assert.equal(typeof guard.settleScenarioRealSell,'function');
 const pos={remainingBaseUnits:'100000001',remainingTokens:100.000001,costBasisUsd:5,realizedPnlUsd:0,status:'HOLDING',sells:[]};
 guard.settleScenarioRealSell(pos,'50000000',3.75,0.075,{side:'SELL'},1);
 assert.equal(pos.status,'HOLDING');assert.equal(pos.remainingBaseUnits,'50000001');assert.equal(pos.stage1Exited,true);
 assert.ok(Math.abs(pos.realizedPnlUsd-1.25)<0.000001);
 guard.settleScenarioRealSell(pos,'50000001',5,0.1,{side:'SELL'},2);
 assert.equal(pos.status,'CLOSED');assert.equal(pos.remainingBaseUnits,'0');assert.ok(Math.abs(pos.realizedPnlUsd-3.75)<0.000001);
 assert.equal(pos.sells.length,2);
});
test('exact base-unit sell slicing keeps partial ratio on retry',()=>{
 assert.equal(typeof guard.scenarioSellBaseUnits,'function');
 assert.equal(guard.scenarioSellBaseUnits('100000001','S14_STAGE_1_TP_50%'),'50000000');
 assert.equal(guard.scenarioSellBaseUnits('100000001','S14_STAGE_2_TP_100%'),'100000001');
 assert.throws(()=>guard.scenarioSellBaseUnits('0','S14_STAGE_1_TP_50%'));
});
test('rendered client JS compiles and controls are unique',()=>{
 const html=render3ScenariosLiveHtml();
 for(const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
 for(const id of ['s14StakeInput','s14AlphaStakeInput','s15StakeInput','s10StakeInput'])
  assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
});
