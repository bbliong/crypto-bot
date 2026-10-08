import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {RECHECK_CONFIGS,evaluateRecheckV9} from './codex-prebuy-recheck-v9.mjs';
import {exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
const data=JSON.parse(readFileSync('reports/codex-engineering-v5-dataset.json'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(hash('reports/codex-engineering-v5-dataset.json'),parent.datasetHash);
for(const[p,h]of Object.entries(parent.hashes))assert.equal(hash(p),h,`Changed dependency ${p}`);
const protocol='docs/CODEX_PREBUY_RECHECK_V9_PROTOCOL.md';
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-prebuy-recheck-v9.mjs','scripts/run-codex-prebuy-v9.mjs'].map(p=>[p,hash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+parent.datasetHash).digest('hex');
const cases=new Map(data.cases.map(c=>[c.signal.id,c]));
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
function evaluate(config,nativeRows,end){return Object.fromEntries(scenarios.map(([s,delayMs,feeSide])=>{
  const rows=nativeRows.map(r=>{const c=cases.get(r.id);let o=evaluateRecheckV9(c.signal,c.prepared,config,{delayMs,feeSide});
    if(o.at!==null&&o.at>=end&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
    return {id:r.id,mint:r.mint,symbol:r.symbol,opportunityAt:r.signalAt,signalAt:o.decisionAt??r.signalAt,
      day:wibDay(o.decisionAt??r.signalAt),captureEnd:r.captureEnd,solUsd:r.solUsd,solAssumed:r.solAssumed,...o,
      bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
  });
  const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
  return[s,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length,
    skipReasons:rows.filter(r=>r.status==='SKIP').reduce((a,r)=>(a[r.reason]=(a[r.reason]??0)+1,a),{})},
    portfolio:{...portfolio,selectedIds:undefined},rows}];
}));}
const trainRows=parent.results.train.AGY_NATIVE.base.rows;
const ranking=RECHECK_CONFIGS.map(config=>{const results=evaluate(config,trainRows,parent.trainEnd),s=results.base.summary;
  return {config,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(x=>x.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
const active=ranking.filter(r=>r.results.base.summary.signals>0),primary=active[0];assert.ok(primary,'No active recheck candidate');
const selected=primary.config;
const trainingPassed=primary.results.base.summary.closed>=30&&primary.results.base.summary.days>=3&&
  scenarios.every(([s])=>{const c=primary.results[s].summary;return c.conservativePnl>0&&c.unknown===0&&
    ['AGY_NATIVE','AGY_REFERENCE'].every(b=>{const v=parent.results.train[b][s].summary;
      return c.conservativePnl>v.conservativePnl&&c.eventBoundDrawdown<=v.eventBoundDrawdown&&c.tailLoss10<=v.tailLoss10;});});
const compact=rs=>Object.fromEntries(Object.entries(rs).map(([s,r])=>[s,{...r,rows:undefined}]));
const status=trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED';
const selection={fingerprint,hashes,protocol,selected,trainingPassed,status,liveAllowed:false,
  selectionBeforeAudit:true,selectionBeforeFresh:true,ranking:ranking.map(r=>({...r,results:compact(r.results)}))};
writeFileSync('reports/codex-prebuy-v9-selection.json',JSON.stringify(selection,null,2));
const audit=evaluate(selected,parent.results.audit.AGY_NATIVE.base.rows,parent.historicalEnd);
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Source changed ${p}`);
const report={...selection,trainEnd:parent.trainEnd,auditEnd:parent.historicalEnd,results:{train:primary.results,audit},
  controls:{train:parent.results.train.AGY_NATIVE,audit:parent.results.audit.AGY_NATIVE},cumulativeHypotheses:43,
  caveats:['Extra recheck time included before order latency; no simulated cancellation after a fill.',
    'Historical audit already viewed, not an independent holdout.',
    'Different purchase time/price can change exposure; no same-buy claim.',
    'Recheck cannot guarantee prevention of a later flash crash or liquidity removal.']};
writeFileSync('reports/codex-prebuy-v9-results.json',JSON.stringify(report));
writeFileSync('reports/codex-prebuy-v9-summary.json',JSON.stringify({...report,
  results:Object.fromEntries(Object.entries(report.results).map(([p,r])=>[p,compact(r)])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,r])=>[p,compact(r)]))},null,2));
console.log(JSON.stringify({status,selected,ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),audit:audit.base.summary}));
