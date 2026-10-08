// Fit only available prior labels for training decisions; audit uses a frozen final model.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {EVIDENCE_MODELS,fitEvidenceV8,assessEvidenceV8,availableEvidenceV8,prequentialEvidenceV8} from './codex-evidence-wave-v8.mjs';
import {exitStats} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
const data=JSON.parse(readFileSync('reports/codex-engineering-v5-dataset.json'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(hash('reports/codex-engineering-v5-dataset.json'),parent.datasetHash);
for(const[p,h]of Object.entries(parent.hashes))assert.equal(hash(p),h,`Changed dependency ${p}`);
const protocol='docs/CODEX_EVIDENCE_WAVE_V8_PROTOCOL.md';
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-evidence-wave-v8.mjs','scripts/run-codex-evidence-v8.mjs'].map(p=>[p,hash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+parent.datasetHash).digest('hex');
const signals=new Map(data.cases.map(c=>[c.signal.id,c.signal]));
const rows=parent.results.train.AGY_NATIVE.base.rows;
const labels=rows.map(r=>({id:r.id,mint:r.mint,signalAt:r.signalAt,availableAt:r.at??r.captureEnd,
  target:r.pnl??r.bound,features:signals.get(r.id).features,unknownProxy:r.pnl===null}));
function chooseRows(native,decisions){return native.map(r=>{
  const d=decisions.get(r.id);assert.ok(d,`Missing decision ${r.id}`);
  if(d.allowed)return {...r,evidence:d};
  return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.signalAt,day:r.day,captureEnd:r.captureEnd,solUsd:r.solUsd,
    solAssumed:r.solAssumed,status:'SKIP',stakeUsd:0,at:r.signalAt,pnl:0,ret:null,bound:0,reason:d.reason,evidence:d};
});}
function stats(xs){const active=xs.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
  return {summary:{...exitStats(active),opportunities:xs.length,skips:xs.length-active.length},
    portfolio:{...portfolio,selectedIds:undefined},rows:xs};}
const scenarios=['base','delay2s','feeStress'];
const opportunities=rows.map(r=>signals.get(r.id));
const ranking=EVIDENCE_MODELS.map(config=>{
  const predictions=prequentialEvidenceV8(config,opportunities,labels),decisions=new Map(predictions.map(p=>[p.id,p]));
  const results=Object.fromEntries(scenarios.map(s=>[s,stats(chooseRows(parent.results.train.AGY_NATIVE[s].rows,decisions))]));
  const summary=results.base.summary;
  return {config,predictions,results,enough:summary.closed>=10&&summary.days>=3,
    score:Math.min(...Object.values(results).map(r=>r.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
const activeRanking=ranking.filter(r=>r.results.base.summary.signals>0),selected=activeRanking[0]?.config??null;
const primary=activeRanking[0]??null;
const diagnostic=selected??EVIDENCE_MODELS.find(c=>c.features==='SAFETY'&&c.depth===1);
const finalModel=fitEvidenceV8(diagnostic,availableEvidenceV8(labels,parent.trainEnd));
const trainingPassed=!!primary&&primary.results.base.summary.closed>=30&&primary.results.base.summary.days>=3&&
  scenarios.every(s=>{const c=primary.results[s].summary;return c.conservativePnl>0&&c.unknown===0&&
    ['AGY_NATIVE','AGY_REFERENCE'].every(b=>{const v=parent.results.train[b][s].summary;
      return c.conservativePnl>v.conservativePnl&&c.eventBoundDrawdown<=v.eventBoundDrawdown&&c.tailLoss10<=v.tailLoss10;});});
const compact=rs=>Object.fromEntries(Object.entries(rs).map(([s,r])=>[s,{...r,rows:undefined}]));
const status=!selected?'NO_ACTIVE_TRAINING_MODEL':trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED';
const selection={fingerprint,hashes,protocol,selected,diagnosticModel:diagnostic,diagnosticOnly:!selected,model:finalModel,
  trainEnd:parent.trainEnd,trainingPassed,status,liveAllowed:false,prequentialTraining:true,
  targetProxyUnknown:labels.filter(r=>r.unknownProxy).length,rankedBeforeAudit:true,
  ranking:ranking.map(r=>({...r,results:compact(r.results)}))};
writeFileSync('reports/codex-evidence-v8-selection.json',JSON.stringify(selection,null,2));
const auditNative=parent.results.audit.AGY_NATIVE.base.rows;
const auditDecisions=new Map(auditNative.map(r=>[r.id,assessEvidenceV8(finalModel,signals.get(r.id))]));
const audit=Object.fromEntries(scenarios.map(s=>[s,stats(chooseRows(parent.results.audit.AGY_NATIVE[s].rows,auditDecisions))]));
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Code changed ${p}`);
const report={...selection,counts:{trainingOpportunities:rows.length,trainingLabels:labels.length,auditOpportunities:auditNative.length},
  audit,controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE},cumulativeHypotheses:37,
  caveats:['Censored outcomes are risk proxies, not realized losses.',
    'All training predictions use strict availableAt < opportunity time; audit fits no extra labels.',
    'Small learned trees and positive predicted means are not calibrated probabilities.',
    'Diagnostic fallback does not constitute an eligible selected strategy.',
    'Historical audit already viewed; a new frozen evaluation remains separate.']};
writeFileSync('reports/codex-evidence-v8-results.json',JSON.stringify(report));
writeFileSync('reports/codex-evidence-v8-summary.json',JSON.stringify({...report,audit:compact(audit),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,r])=>[p,compact(r)]))},null,2));
console.log(JSON.stringify({status,selected,diagnosticOnly:!selected,modelN:finalModel?.n,
  ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),audit:audit.base.summary}));
