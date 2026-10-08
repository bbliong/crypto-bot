import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {PEAK_CONFIGS,evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {evaluateRecheckV9} from './codex-prebuy-recheck-v9.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {cachedOpportunityStudy,studyHash,rankCachedCandidates,evaluateCachedCandidate,compactStudy,studyTrainingPassed} from './codex-cached-opportunity-study.mjs';
const {parent,cases}=cachedOpportunityStudy(),protocol='docs/CODEX_PEAK_RECHECK_V10_PROTOCOL.md';
const files=[protocol,'scripts/codex-peak-recheck-v10.mjs','scripts/run-codex-peak-v10.mjs',
  'scripts/codex-prebuy-recheck-v9.mjs','scripts/codex-cached-opportunity-study.mjs'];
const hashes={...parent.hashes,...Object.fromEntries(files.map(p=>[p,studyHash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+parent.datasetHash).digest('hex');
const ranking=rankCachedCandidates(PEAK_CONFIGS,cases,parent.results.train.AGY_NATIVE.base.rows,evaluatePeakV10,parent.trainEnd);
const primary=ranking.find(r=>r.results.base.summary.signals>0);assert.ok(primary);
const selected=primary.config,trainingPassed=studyTrainingPassed(primary,parent.results.train);
const selection={fingerprint,hashes,protocol,selected,trainingPassed,status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',
  liveAllowed:false,selectionBeforeAudit:true,selectionBeforeFresh:true,ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync('reports/codex-peak-v10-selection.json',JSON.stringify(selection,null,2));
const audit=evaluateCachedCandidate(cases,parent.results.audit.AGY_NATIVE.base.rows,selected,evaluatePeakV10,parent.historicalEnd);
const baseline=(signal,p,config,options)=>config.waitMs?evaluateRecheckV9(signal,p,config,options):replayAdaptiveTrade(signal,p,options);
const sameTiming={train:evaluateCachedCandidate(cases,parent.results.train.AGY_NATIVE.base.rows,selected,baseline,parent.trainEnd),
  audit:evaluateCachedCandidate(cases,parent.results.audit.AGY_NATIVE.base.rows,selected,baseline,parent.historicalEnd)};
// Peak-only must preserve every modeled purchase on the same timing policy.
for(const[part,result]of [['train',primary.results],['audit',audit]])for(const[s,sc]of Object.entries(result)){
  const native=sameTiming[part][s].rows;
  for(let i=0;i<sc.rows.length;i++)for(const key of ['buyAt','buyPrice','buyQuantity','initialNet'])
    assert.equal(sc.rows[i][key],native[i][key],`Peak-only changed buy: ${part} ${i} ${key}`);
}
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Changed source ${p}`);
const report={...selection,trainEnd:parent.trainEnd,auditEnd:parent.historicalEnd,results:{train:primary.results,audit},sameTiming,
  controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE},cumulativeHypotheses:47,
  caveats:['Only peak tracking changes versus the same-timing native control; AGY source untouched.',
    'Native approximate exit valuation retained; final PnL uses the shared fee model.',
    'Historical audit already viewed; fresh evaluation remains separate.',
    'Trailing request is not a guaranteed fill at the floor.']};
writeFileSync('reports/codex-peak-v10-results.json',JSON.stringify(report));
writeFileSync('reports/codex-peak-v10-summary.json',JSON.stringify({...report,
  results:Object.fromEntries(Object.entries(report.results).map(([p,r])=>[p,compactStudy(r)])),
  sameTiming:Object.fromEntries(Object.entries(sameTiming).map(([p,r])=>[p,compactStudy(r)])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,r])=>[p,compactStudy(r)]))},null,2));
console.log(JSON.stringify({selected,trainingPassed,status:selection.status,
  ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),
  audit:audit.base.summary,sameTimingAudit:sameTiming.audit.base.summary}));
