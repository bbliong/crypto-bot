import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {VALUE_ACTIONS,VALUE_CONFIGS,fitActionHeadsV15,chooseActionV15,prequentialActionsV15,actionLabelsV15} from './codex-action-value-v15.mjs';
import {evaluatePeakV10} from './codex-peak-recheck-v10.mjs';
import {cachedOpportunityStudy,studyHash,evaluateCachedCandidate,compactStudy,studyTrainingPassed,STUDY_SCENARIOS} from './codex-cached-opportunity-study.mjs';
import {exitStats} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const output='reports/codex-action-value-v15-results.json';assert.ok(!existsSync(output),'Preserve original action value study');
const {parent,cases}=cachedOpportunityStudy(),protocol='docs/CODEX_ACTION_VALUE_V15_PROTOCOL.md';
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-action-value-v15.mjs','scripts/run-codex-action-value-v15.mjs',
  'scripts/codex-evidence-wave-v8.mjs','scripts/codex-peak-recheck-v10.mjs','scripts/codex-prebuy-recheck-v9.mjs',
  'scripts/codex-cached-opportunity-study.mjs'].map(p=>[p,studyHash(p)]))};
const signals=new Map([...cases].map(([id,c])=>[id,c.signal]));
const actionResults={};
for(const[part,end]of [['train',parent.trainEnd],['audit',parent.historicalEnd]]){
  actionResults[part]=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,evaluateCachedCandidate(cases,parent.results[part].AGY_NATIVE.base.rows,a,evaluatePeakV10,end)]));
}
const labels=actionLabelsV15(actionResults.train,signals),opportunities=parent.results.train.AGY_NATIVE.base.rows.map(r=>signals.get(r.id));
function applyChoices(nativeRows,results,choices){
  return Object.fromEntries(STUDY_SCENARIOS.map(([scenario])=>{
    const byAction=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,new Map(results[a.id][scenario].rows.map(r=>[r.id,r]))]));
    const rows=nativeRows.map(r=>{const d=choices.get(r.id);assert.ok(d,`Missing action decision ${r.id}`);
      if(d.action!=='WAIT')return {...byAction[d.action].get(r.id),valueDecision:d};
      return {...r,status:'SKIP',stakeUsd:0,at:r.signalAt,pnl:0,ret:null,bound:0,valueDecision:d,reason:d.reason,
        buyAt:undefined,buyPrice:undefined,buyQuantity:undefined,initialNet:undefined,exitSignalAt:undefined};
    });
    const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
    return[scenario,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},portfolio,rows}];
  }));
}
const ranking=VALUE_CONFIGS.map(config=>{
  const predictions=prequentialActionsV15(config,labels,opportunities),choices=new Map(predictions.map(p=>[p.id,p]));
  const results=applyChoices(parent.results.train.AGY_NATIVE.base.rows,actionResults.train,choices),s=results.base.summary;
  return {config,predictions,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(r=>r.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
const primary=ranking.find(r=>r.results.base.summary.signals>0)??null,selected=primary?.config??null;
const trainingPassed=studyTrainingPassed(primary,parent.results.train);
const trainingHeads=selected?fitActionHeadsV15(selected,labels,parent.trainEnd):null;
const selection={generatedAt:new Date().toISOString(),hashes,protocol,selected,trainingPassed,trainingHeads,liveAllowed:false,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':selected?'TRAINING_REJECTED':'NO_ACTIVE_TRAINING_MODEL',cumulativeHypotheses:67,
  prequentialTraining:true,selectionBeforeAuditAggregation:true,ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
const selectionPath='reports/codex-action-value-v15-selection.json';writeFileSync(selectionPath,JSON.stringify(selection,null,2),{flag:'wx'});
const auditChoices=selected?new Map(parent.results.audit.AGY_NATIVE.base.rows.map(r=>[r.id,chooseActionV15(trainingHeads,signals.get(r.id))])):null;
const audit=selected?applyChoices(parent.results.audit.AGY_NATIVE.base.rows,actionResults.audit,auditChoices):null;
const auditLabels=actionLabelsV15(actionResults.audit,signals),allLabels=Object.fromEntries(VALUE_ACTIONS.map(a=>[a.id,[...labels[a.id],...auditLabels[a.id]]]));
const freezeAt=Date.now(),forwardHeads=selected?fitActionHeadsV15(selected,allLabels,freezeAt):null;
const forwardLock={generatedAt:new Date(freezeAt).toISOString(),freezeAt,start:Math.max(Date.parse('2026-10-04T07:30Z'),freezeAt),
  selected,heads:forwardHeads,hashes:{...hashes,[selectionPath]:studyHash(selectionPath)},trainingPassed,liveAllowed:false,
  explanation:'Config selected only prequential TRAIN; weights refitted on available historical labels before untouched future interval.'};
writeFileSync('reports/codex-action-value-v15-forward-lock.json',JSON.stringify(forwardLock,null,2),{flag:'wx'});
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Changed source ${p}`);
const report={...selection,trainEnd:parent.trainEnd,auditEnd:parent.historicalEnd,forwardLock,labels:allLabels,
  actionResults,results:{train:primary?.results??null,audit},controls:{train:parent.results.train,audit:parent.results.audit},
  caveats:['Prequential training excludes outcomes unavailable at the current opportunity.',
    'WAIT/SKIP not a closed win; censored labels are risk proxies only.',
    'Audit uses frozen TRAIN heads, forward weights separately refit only before forward start.',
    'Small trees are not calibrated probabilities; search complexity and repeated history remain limitations.',
    'No live integration or guaranteed rugpull safety.']};
writeFileSync(output,JSON.stringify(report),{flag:'wx'});
writeFileSync('reports/codex-action-value-v15-summary.json',JSON.stringify({...report,labels:undefined,actionResults:undefined,
  results:Object.fromEntries(Object.entries(report.results).map(([p,r])=>[p,r?compactStudy(r):null])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,ls])=>[p,Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE'].map(l=>[l,compactStudy(ls[l])]))]))},null,2),{flag:'wx'});
console.log(JSON.stringify({status:report.status,selected,ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),audit:audit?.base.summary}));
