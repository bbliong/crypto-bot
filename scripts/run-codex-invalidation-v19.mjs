import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {INVALIDATION_CONFIGS,evaluateInvalidationV19} from './codex-invalidation-v19.mjs';
import {cachedOpportunityStudy,studyHash,rankCachedCandidates,evaluateCachedCandidate,compactStudy,studyTrainingPassed} from './codex-cached-opportunity-study.mjs';
const out='reports/codex-invalidation-v19';
assert.ok(!existsSync(`${out}-selection.json`),'Frozen study already exists');
const {parent,cases}=cachedOpportunityStudy();
const hashes={...parent.hashes,...Object.fromEntries(['docs/CODEX_INVALIDATION_V19_PROTOCOL.md',
  'scripts/codex-invalidation-v19.mjs','scripts/run-codex-invalidation-v19.mjs',
  'scripts/codex-cached-opportunity-study.mjs'].map(p=>[p,studyHash(p)]))};
const rank=rankCachedCandidates(INVALIDATION_CONFIGS,cases,parent.results.train.AGY_NATIVE.base.rows,evaluateInvalidationV19,parent.trainEnd);
const primary=rank[0],selected=primary.config,trainingPassed=studyTrainingPassed(primary,parent.results.train);
const selection={at:new Date().toISOString(),hashes,selected,trainingPassed,liveAllowed:false,cumulativeHypotheses:80,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',ranking:rank.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync(`${out}-selection.json`,JSON.stringify(selection,null,2),{flag:'wx'});
const results={train:primary.results,audit:evaluateCachedCandidate(cases,parent.results.audit.AGY_NATIVE.base.rows,selected,evaluateInvalidationV19,parent.historicalEnd)};
const snapshotPath='reports/codex-online-forward-v17r1/snapshots/20261004T133000000Z.json';
const snapshot=JSON.parse(readFileSync(snapshotPath)),ledger=JSON.parse(readFileSync(snapshot.ledger)),freshCases=new Map();
for(const line of readFileSync('reports/codex-online-forward-v17r1/sessions.jsonl','utf8').trim().split('\n')){
  const e=JSON.parse(line);if(e.caseFile){assert.equal(studyHash(e.caseFile.path),e.caseFile.sha256);
    const c=JSON.parse(readFileSync(e.caseFile.path));freshCases.set(c.signal.id,c);}
}
results.catchup=evaluateCachedCandidate(freshCases,ledger.results.AGY_NATIVE.base.rows,selected,evaluateInvalidationV19,snapshot.cutoff);
for(const [p,h]of Object.entries(hashes))assert.equal(studyHash(p),h);
const report={...selection,results,controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE,catchup:ledger.results.AGY_NATIVE},
  catchupInput:{snapshotPath,snapshotHash:studyHash(snapshotPath),ledger:snapshot.ledger,ledgerHash:studyHash(snapshot.ledger)},
  caveats:['Purchase timing differs: same opportunity comparison, not same fill.',
    'Historical audit and catch-up are diagnostic, not untouched validation. No real order/quote execution.']};
writeFileSync(`${out}-results.json`,JSON.stringify(report),{flag:'wx'});
writeFileSync(`${out}-summary.json`,JSON.stringify({...report,results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,compactStudy(v)])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([k,v])=>[k,compactStudy(v)]))},null,2),{flag:'wx'});
console.log(JSON.stringify({selected,trainingPassed,ranking:rank.map(r=>({config:r.config,score:r.score,base:r.results.base.summary})),
  results:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,Object.fromEntries(Object.entries(v).map(([s,r])=>[s,r.summary]))]))}));
