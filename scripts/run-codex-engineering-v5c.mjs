import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {evaluateV5c} from './codex-entry-v5c.mjs';
import {commonCohort,exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
const datasetPath='reports/codex-engineering-v5-dataset.json',data=JSON.parse(readFileSync(datasetPath));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(hash(datasetPath),parent.datasetHash);
for(const[p,h]of Object.entries(parent.hashes))assert.equal(hash(p),h,`Changed v5b dependency ${p}`);
const protocol='docs/CODEX_ENGINEERING_LOOP_V5C_PROTOCOL.md';
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-entry-v5c.mjs','scripts/run-codex-engineering-v5c.mjs'].map(p=>[p,hash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+parent.datasetHash).digest('hex');
const universe=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json')).universe;
const byId=new Map(data.cases.map(c=>[c.signal.id,c])),records=data.cases.map(c=>c.signal);
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
function evaluate(config,cohort,end){return Object.fromEntries(scenarios.map(([scenario,delayMs,feeSide])=>{
  const rows=cohort.map(r=>{
    const c=byId.get(r.id);let o=evaluateV5c(r,c.prepared,config,{delayMs,feeSide});
    if(o.at!==null&&o.at>=end&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
    return {id:r.id,mint:r.mint,symbol:r.symbol,opportunityAt:r.at,signalAt:o.decisionAt??r.at,
      day:wibDay(o.decisionAt??r.at),captureEnd:Math.min(r.captureEnd,end),solUsd:r.solUsd,solAssumed:r.solAssumed,...o,
      bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
  });
  const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
  return[scenario,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},
    portfolio:{...portfolio,selectedIds:undefined},rows}];
}));}
const train=commonCohort(records,universe,-Infinity,parent.trainEnd);assert.ok(train.length);
const configs=['CONFIRM_1S','CONFIRM_3S'].flatMap(entryMode=>['NATIVE','HARVEST'].flatMap(exitMode=>['ALL','AGE300'].map(gate=>
  ({id:`VOL_${entryMode}_${exitMode}_${gate}`,entryMode,exitMode,gate}))));
const ranking=configs.map(config=>{const results=evaluate(config,train,parent.trainEnd),s=results.base.summary;
  return {config,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(x=>x.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
const selected=ranking[0].config;
const trainingPassed=ranking[0].results.base.summary.closed>=30&&ranking[0].results.base.summary.days>=3&&
  scenarios.every(([s])=>{const c=ranking[0].results[s].summary;return c.conservativePnl>0&&c.unknown===0&&
    ['AGY_NATIVE','AGY_REFERENCE'].every(b=>{const v=parent.results.train[b][s].summary;return c.conservativePnl>v.conservativePnl&&c.eventBoundDrawdown<=v.eventBoundDrawdown&&c.tailLoss10<=v.tailLoss10;});});
const compact=results=>Object.fromEntries(Object.entries(results).map(([s,r])=>[s,{...r,rows:undefined}]));
writeFileSync('reports/codex-engineering-v5c-selection.json',JSON.stringify({fingerprint,hashes,protocol,datasetHash:parent.datasetHash,
  selected,trainingPassed,liveAllowed:false,selectedBeforeAudit:true,nextUnseenStart:'2026-10-04T03:40:00Z',
  ranking:ranking.map(r=>({...r,results:compact(r.results)}))},null,2));
const audit=commonCohort(records,universe,parent.trainEnd,parent.historicalEnd),results={train:ranking[0].results,audit:evaluate(selected,audit,parent.historicalEnd)};
const report={fingerprint,hashes,protocol,selected,trainingPassed,liveAllowed:false,status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',
  trainEnd:parent.trainEnd,auditEnd:parent.historicalEnd,unseenStart:'2026-10-04T03:40:00Z',testedThisLoop:8,cumulativeHypotheses:25,
  ranking:ranking.map(r=>({...r,results:compact(r.results)})),results,
  controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE},
  caveat:'This audit was already viewed; no claim of independent holdout. Sample and absolute-profit gates unchanged.'};
writeFileSync('reports/codex-engineering-v5c-results.json',JSON.stringify(report));
writeFileSync('reports/codex-engineering-v5c-summary.json',JSON.stringify({...report,results:Object.fromEntries(Object.entries(results).map(([p,r])=>[p,compact(r)])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,r])=>[p,compact(r)]))},null,2));
console.log(JSON.stringify({status:report.status,selected,ranking:report.ranking.map(r=>({config:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),
  audit:results.audit.base.summary}));
