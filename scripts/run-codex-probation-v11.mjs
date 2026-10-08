import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PROBATION_CONFIGS,evaluateProbationV11} from './codex-probation-wave-v11.mjs';
import {cachedOpportunityStudy,studyHash,rankCachedCandidates,evaluateCachedCandidate,compactStudy,studyTrainingPassed} from './codex-cached-opportunity-study.mjs';
const {parent,cases}=cachedOpportunityStudy(),protocol='docs/CODEX_PROBATION_WAVE_V11_PROTOCOL.md';
const files=[protocol,'scripts/codex-probation-wave-v11.mjs','scripts/run-codex-probation-v11.mjs',
  'scripts/codex-peak-recheck-v10.mjs','scripts/codex-prebuy-recheck-v9.mjs','scripts/codex-cached-opportunity-study.mjs'];
const hashes={...parent.hashes,...Object.fromEntries(files.map(p=>[p,studyHash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+parent.datasetHash).digest('hex');
const ranking=rankCachedCandidates(PROBATION_CONFIGS,cases,parent.results.train.AGY_NATIVE.base.rows,evaluateProbationV11,parent.trainEnd);
const primary=ranking.find(r=>r.results.base.summary.signals>0);assert.ok(primary);
const selected=primary.config,trainingPassed=studyTrainingPassed(primary,parent.results.train);
const selection={fingerprint,hashes,protocol,selected,trainingPassed,status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',
  liveAllowed:false,selectionBeforeAudit:true,selectionBeforeFresh:true,ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync('reports/codex-probation-v11-selection.json',JSON.stringify(selection,null,2));
const audit=evaluateCachedCandidate(cases,parent.results.audit.AGY_NATIVE.base.rows,selected,evaluateProbationV11,parent.historicalEnd);
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Source changed ${p}`);
const report={...selection,trainEnd:parent.trainEnd,auditEnd:parent.historicalEnd,results:{train:primary.results,audit},
  controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE},cumulativeHypotheses:51,
  caveats:['Probation, structural protection and monotone floors are evaluated together.',
    'Historical audit already viewed; fresh evaluation remains separate.',
    'Stop and floor requests do not guarantee modeled or actual fills at those values.']};
writeFileSync('reports/codex-probation-v11-results.json',JSON.stringify(report));
writeFileSync('reports/codex-probation-v11-summary.json',JSON.stringify({...report,
  results:Object.fromEntries(Object.entries(report.results).map(([p,r])=>[p,compactStudy(r)])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,r])=>[p,compactStudy(r)]))},null,2));
console.log(JSON.stringify({selected,trainingPassed,status:selection.status,
  ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),audit:audit.base.summary}));
