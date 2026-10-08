import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {COHORT_CONFIGS,evaluateCohortV18} from './codex-cohort-exit-v18.mjs';
import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {cachedOpportunityStudy,studyHash,rankCachedCandidates,evaluateCachedCandidate,compactStudy,studyTrainingPassed} from './codex-cached-opportunity-study.mjs';
const out='reports/codex-cohort-exit-v18';
assert.ok(!existsSync(`${out}-selection.json`),'Frozen study already exists');
const {parent,cases}=cachedOpportunityStudy();
const hashes={...parent.hashes,...Object.fromEntries(['docs/CODEX_COHORT_EXIT_V18_PROTOCOL.md',
  'scripts/codex-cohort-exit-v18.mjs','scripts/run-codex-cohort-exit-v18.mjs',
  'scripts/codex-peak-recheck-v10.mjs','scripts/codex-cached-opportunity-study.mjs'].map(p=>[p,studyHash(p)]))};
const rank=rankCachedCandidates(COHORT_CONFIGS,cases,parent.results.train.AGY_NATIVE.base.rows,evaluateCohortV18,parent.trainEnd);
const primary=rank[0],selected=primary.config,trainingPassed=studyTrainingPassed(primary,parent.results.train);
const selection={at:new Date().toISOString(),hashes,selected,trainingPassed,liveAllowed:false,cumulativeHypotheses:76,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',ranking:rank.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync(`${out}-selection.json`,JSON.stringify(selection,null,2),{flag:'wx'});
const results={train:primary.results,audit:evaluateCachedCandidate(cases,parent.results.audit.AGY_NATIVE.base.rows,selected,evaluateCohortV18,parent.historicalEnd)};
const peak={};
for(const part of ['train','audit']){
  const base=parent.results[part].AGY_NATIVE;
  peak[part]=evaluateCachedCandidate(cases,base.base.rows,{waitMs:0},evaluatePeakV10,part==='train'?parent.trainEnd:parent.historicalEnd);
  for(const [scenario,result]of Object.entries(results[part])){
    const originals=new Map(base[scenario].rows.map(r=>[r.id,r]));
    for(const r of result.rows)for(const key of ['buyAt','buyPrice','buyQuantity','initialNet'])
      assert.equal(r[key],originals.get(r.id)[key],`Same purchase invariant ${part} ${scenario} ${r.id} ${key}`);
  }
}
const snapshotPath='reports/codex-online-forward-v17r1/snapshots/20261004T133000000Z.json';
const snapshot=JSON.parse(readFileSync(snapshotPath)),ledger=JSON.parse(readFileSync(snapshot.ledger));
const freshCases=new Map();
for(const line of readFileSync('reports/codex-online-forward-v17r1/sessions.jsonl','utf8').trim().split('\n')){
  const e=JSON.parse(line);if(e.caseFile){assert.equal(studyHash(e.caseFile.path),e.caseFile.sha256);
    const c=JSON.parse(readFileSync(e.caseFile.path));freshCases.set(c.signal.id,c);}
}
results.catchup=evaluateCachedCandidate(freshCases,ledger.results.AGY_NATIVE.base.rows,selected,evaluateCohortV18,snapshot.cutoff);
peak.catchup=evaluateCachedCandidate(freshCases,ledger.results.AGY_NATIVE.base.rows,{waitMs:0},evaluatePeakV10,snapshot.cutoff);
for(const [scenario,result]of Object.entries(results.catchup)){
  const originals=new Map(ledger.results.AGY_NATIVE[scenario].rows.map(r=>[r.id,r]));
  for(const r of result.rows)for(const key of ['buyAt','buyPrice','buyQuantity','initialNet'])assert.equal(r[key],originals.get(r.id)[key]);
}
for(const [p,h]of Object.entries(hashes))assert.equal(studyHash(p),h);
const report={...selection,results,peak,controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE,catchup:ledger.results.AGY_NATIVE},
  catchupInput:{snapshotPath,snapshotHash:studyHash(snapshotPath),ledger:snapshot.ledger,ledgerHash:studyHash(snapshot.ledger)},
  caveats:['Historical audit is reused; catch-up aggregates seen before this design. Neither is untouched validation.',
    'USD flow is not wallet inventory or rugpull identification. Real execution receipts missing.']};
writeFileSync(`${out}-results.json`,JSON.stringify(report),{flag:'wx'});
writeFileSync(`${out}-summary.json`,JSON.stringify({...report,results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,compactStudy(v)])),
  peak:Object.fromEntries(Object.entries(peak).map(([k,v])=>[k,compactStudy(v)])),controls:Object.fromEntries(Object.entries(report.controls).map(([k,v])=>[k,compactStudy(v)]))},null,2),{flag:'wx'});
console.log(JSON.stringify({selected,trainingPassed,ranking:rank.map(r=>({config:r.config,score:r.score,base:r.results.base.summary})),
  results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).map(([s,r])=>[s,r.summary]))]))}));
