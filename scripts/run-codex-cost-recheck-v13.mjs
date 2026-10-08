import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {COST_RECHECK_CONFIGS,evaluateCostRecheckV13} from './codex-cost-recheck-v13.mjs';
import {evaluateCachedCandidate,rankCachedCandidates,studyHash,studyTrainingPassed,compactStudy} from './codex-cached-opportunity-study.mjs';
const output='reports/codex-cost-recheck-v13-results.json';assert.ok(!existsSync(output),'Preserve original v13 study');
const parentPath='reports/codex-cost-tempo-v12-results.json',parent=JSON.parse(readFileSync(parentPath));
assert.equal(parent.selected.lambda,.25,'Parent lambda selection changed');
for(const[p,h]of Object.entries(parent.hashes))assert.equal(studyHash(p),h,`Changed v12 source ${p}`);
const protocol='docs/CODEX_COST_RECHECK_V13_PROTOCOL.md';
const hashes={...parent.hashes,...Object.fromEntries([parentPath,protocol,'scripts/codex-cost-recheck-v13.mjs','scripts/run-codex-cost-recheck-v13.mjs']
  .map(p=>[p,studyHash(p)]))};
const bySession=new Map(),cases=new Map();
for(const file of parent.caseFiles){assert.equal(studyHash(file.path),file.sha256);
  for(const c of JSON.parse(readFileSync(file.path)).cases)bySession.set(c.session.id,c);
}
for(const r of parent.records.filter(r=>r.lane===parent.selected.id))cases.set(r.id,{signal:r,prepared:bySession.get(r.sessionId).prepared});
const trainRows=parent.results.train[parent.selected.id].base.rows;
const ranking=rankCachedCandidates(COST_RECHECK_CONFIGS,cases,trainRows,evaluateCostRecheckV13,parent.trainEnd);
const primary=ranking.find(r=>r.results.base.summary.signals>0)??null,selected=primary?.config??null;
const trainingPassed=studyTrainingPassed(primary,parent.results.train);
const selection={generatedAt:new Date().toISOString(),hashes,protocol,selected,trainingPassed,liveAllowed:false,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':selected?'TRAINING_REJECTED':'NO_ACTIVE_CANDIDATE',
  selectionBeforeAuditAggregation:true,forwardStart:Math.max(Date.parse('2026-10-04T07:00Z'),Date.now()),cumulativeHypotheses:59,
  ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync('reports/codex-cost-recheck-v13-selection.json',JSON.stringify(selection,null,2),{flag:'wx'});
const audit=selected?evaluateCachedCandidate(cases,parent.results.audit[parent.selected.id].base.rows,selected,evaluateCostRecheckV13,parent.cutoff):null;
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Changed source ${p}`);
const report={...selection,trainEnd:parent.trainEnd,auditEnd:parent.cutoff,results:{train:primary?.results??null,audit},
  controls:{train:{AGY_NATIVE:parent.results.train.AGY_NATIVE,AGY_REFERENCE:parent.results.train.AGY_REFERENCE},
    audit:{AGY_NATIVE:parent.results.audit.AGY_NATIVE,AGY_REFERENCE:parent.results.audit.AGY_REFERENCE}},
  caveats:['Changing entry timing/universe; not same-buy paired exit improvement.',
    'Historical audit already viewed, not a holdout.',
    'Positive tiny subset is not a validated winner; unknown cannot be silently removed.',
    'Revalidation cannot prevent every future rugpull or guarantee min-output sell.']};
writeFileSync(output,JSON.stringify(report),{flag:'wx'});
writeFileSync('reports/codex-cost-recheck-v13-summary.json',JSON.stringify({...report,
  results:Object.fromEntries(Object.entries(report.results).map(([part,r])=>[part,r?compactStudy(r):null])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([part,ls])=>[part,Object.fromEntries(Object.entries(ls).map(([l,r])=>[l,compactStudy(r)]))]))},null,2),{flag:'wx'});
console.log(JSON.stringify({status:report.status,selected,ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),audit:audit?.base.summary}));
