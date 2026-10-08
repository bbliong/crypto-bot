import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {readOpportunityWindow} from './codex-available-window.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {studyHash,STUDY_SCENARIOS,evaluateCachedCandidate} from './codex-cached-opportunity-study.mjs';
import {commonCohort,wibDay} from './codex-same-entry-analysis.mjs';
const start=Date.parse('2026-10-04T06:00Z'),cutoff=Date.parse('2026-10-04T06:30Z');
assert.ok(Date.now()>=cutoff,'Fresh cutoff has not happened yet');
const path='reports/codex-peak-v10-fresh-20261004T0600-0630.json';assert.ok(!existsSync(path),'Preserve original fresh report');
const selectionPath='reports/codex-peak-v10-selection.json',selection=JSON.parse(readFileSync(selectionPath));
for(const[p,h]of Object.entries(selection.hashes))assert.equal(studyHash(p),h,`Frozen dependency changed ${p}`);
const hashes={...selection.hashes,...Object.fromEntries([selectionPath,'scripts/codex-available-window.mjs','scripts/evaluate-codex-peak-v10-fresh.mjs'].map(p=>[p,studyHash(p)]))};
const priorUniverse=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json')).universe;
const input=await readOpportunityWindow({start,cutoff,priorUniverse}),cases=new Map(input.cases.map(c=>[c.signal.id,c]));
const cohort=commonCohort(input.cases.map(c=>c.signal),input.universe,start,cutoff);
const opportunityRows=cohort.map(r=>({id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.at,day:wibDay(r.at),
  captureEnd:Math.min(r.captureEnd,cutoff),solUsd:r.solUsd,solAssumed:r.solAssumed}));
const results={CODEX_PEAK:evaluateCachedCandidate(cases,opportunityRows,selection.selected,evaluatePeakV10,cutoff)};
for(const policy of ['AGY_NATIVE','AGY_REFERENCE'])results[policy]=evaluateCachedCandidate(cases,opportunityRows,{},
  (signal,p,_,options)=>replayAdaptiveTrade({...signal,lane:policy},p,options),cutoff);
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Dependency changed during replay ${p}`);
const report={generatedAt:new Date().toISOString(),start,cutoff,hashes,selected:selection.selected,trainingPassed:selection.trainingPassed,
  liveAllowed:false,status:selection.status,inventory:input.inventory,
  counts:{details:input.inventory.reduce((s,x)=>s+x.details,0),signals:input.cases.length,cohort:cohort.length},results,
  cohortIds:cohort.map(r=>r.id),caveats:['Frozen peak policy, no fitting on this fresh window.',
    'Short previously unused data window is not a seven-day live forward trial.',
    'Training status persists. All fills remain hypothetical.']};
writeFileSync(path,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output:path,status:report.status,selected:selection.selected,counts:report.counts,
  results:Object.fromEntries(Object.entries(results).map(([l,r])=>[l,r.base.summary]))}));
