import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {evaluateRecheckV9} from './codex-prebuy-recheck-v9.mjs';
import {readOpportunityWindow} from './codex-available-window.mjs';
import {replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {commonCohort,exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const start=Date.parse('2026-10-04T06:00Z'),cutoff=Date.parse('2026-10-04T06:30Z');
assert.ok(Date.now()>=cutoff,'Fresh cutoff has not happened yet');
const path='reports/codex-prebuy-v9-fresh-20261004T0600-0630.json';assert.ok(!existsSync(path),'Preserve the original fresh report');
const selectionPath='reports/codex-prebuy-v9-selection.json',selection=JSON.parse(readFileSync(selectionPath));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
for(const[p,h]of Object.entries(selection.hashes))assert.equal(hash(p),h,`Frozen dependency changed ${p}`);
const hashes={...selection.hashes,...Object.fromEntries([selectionPath,'scripts/codex-available-window.mjs','scripts/evaluate-codex-prebuy-v9-fresh.mjs'].map(p=>[p,hash(p)]))};
const priorUniverse=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json')).universe;
const input=await readOpportunityWindow({start,cutoff,priorUniverse});
const byId=new Map(input.cases.map(c=>[c.signal.id,c]));
const cohort=commonCohort(input.cases.map(c=>c.signal),input.universe,start,cutoff);
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]],results={};
for(const policy of ['AGY_NATIVE','AGY_REFERENCE','CODEX_PREBUY']){
  results[policy]=Object.fromEntries(scenarios.map(([s,delayMs,feeSide])=>{
    const rows=cohort.map(r=>{const c=byId.get(r.id),options={delayMs,feeSide};
      let o=policy==='CODEX_PREBUY'?evaluateRecheckV9(r,c.prepared,selection.selected,options):
        replayAdaptiveTrade({...r,lane:policy},c.prepared,options);
      if(o.at!==null&&o.at>=cutoff&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:o.decisionAt??r.at,day:wibDay(o.decisionAt??r.at),captureEnd:Math.min(r.captureEnd,cutoff),
        solUsd:r.solUsd,solAssumed:r.solAssumed,...o,bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });
    const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
    return[s,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},portfolio:{...portfolio,selectedIds:undefined},rows}];
  }));
}
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Dependency changed during replay ${p}`);
const report={generatedAt:new Date().toISOString(),start,cutoff,hashes,selected:selection.selected,trainingPassed:selection.trainingPassed,
  liveAllowed:false,status:selection.status,inventory:input.inventory,
  counts:{details:input.inventory.reduce((s,x)=>s+x.details,0),signals:input.cases.length,cohort:cohort.length},results,
  cases:input.cases,cohortIds:cohort.map(r=>r.id),
  caveats:['Frozen recheck policy, extra preparation time accounted for.',
    'Small historical replay of previously unused data; not a seven-day live forward trial.',
    'Training rejection persists and is not replaced by one small-window result.']};
writeFileSync(path,JSON.stringify(report),{flag:'wx'});
console.log(JSON.stringify({output:path,status:report.status,counts:report.counts,
  results:Object.fromEntries(Object.entries(results).map(([l,r])=>[l,r.base.summary]))}));
