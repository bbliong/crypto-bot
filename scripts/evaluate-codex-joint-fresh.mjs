import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {frozenRegistry,verifyRegistry,FROZEN_POLICIES,evaluateFrozenPolicy,registryHash} from './codex-frozen-registry.mjs';
import {readOpportunityWindow} from './codex-available-window.mjs';
import {commonCohort,wibDay,exitStats} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const start=Date.parse('2026-10-04T06:00Z'),cutoff=Date.parse('2026-10-04T06:30Z');assert.ok(Date.now()>=cutoff);
const path='reports/codex-joint-fresh-20261004T0600-0630.json';assert.ok(!existsSync(path),'Preserve original fresh evaluation');
const registry=frozenRegistry();
for(const p of ['scripts/codex-available-window.mjs','scripts/evaluate-codex-joint-fresh.mjs'])registry.hashes[p]=registryHash(p);
const priorUniverse=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json')).universe;
const input=await readOpportunityWindow({start,cutoff,priorUniverse}),byId=new Map(input.cases.map(c=>[c.signal.id,c]));
const cohort=commonCohort(input.cases.map(c=>c.signal),input.universe,start,cutoff);
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]],results={};
for(const policy of FROZEN_POLICIES)results[policy]=Object.fromEntries(scenarios.map(([name,delayMs,feeSide])=>{
  const rows=cohort.map(r=>{const c=byId.get(r.id);let o=evaluateFrozenPolicy(policy,r,c.prepared,{delayMs,feeSide},registry);
    if(o.at!==null&&o.at>=cutoff&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
    return {id:r.id,mint:r.mint,symbol:r.symbol,opportunityAt:r.at,signalAt:o.decisionAt??r.at,
      day:wibDay(o.decisionAt??r.at),captureEnd:Math.min(r.captureEnd,cutoff),solUsd:r.solUsd,solAssumed:r.solAssumed,...o,
      bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
  });
  const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
  return[name,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},
    portfolio:{...portfolio,selectedIds:undefined},rows}];
}));
verifyRegistry(registry);
const report={generatedAt:new Date().toISOString(),start,cutoff,registry,inventory:input.inventory,
  counts:{details:input.inventory.reduce((s,x)=>s+x.details,0),signals:input.cases.length,cohort:cohort.length},results,
  cases:input.cases,cohortIds:cohort.map(r=>r.id),liveAllowed:false,status:'NO_VALIDATED_OUTPERFORMANCE',
  caveats:['All final policies selected before reading this window; no reselection from test.',
    'Training failures persist. Evidence v8 may be diagnostic-only with null selected model.',
    'Independent event PnL and occupied/unresolved portfolio are separate.',
    'Short previously unused replay is not a seven-day forward-paper trial.']};
writeFileSync(path,JSON.stringify(report),{flag:'wx'});
const summary={...report,cases:undefined,cohortIds:undefined,results:Object.fromEntries(Object.entries(results).map(([p,ss])=>[p,
  Object.fromEntries(Object.entries(ss).map(([s,r])=>[s,{...r,rows:undefined}]))]))};
writeFileSync('reports/codex-joint-fresh-20261004T0600-0630-summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify({output:path,status:report.status,counts:report.counts,
  results:Object.fromEntries(Object.entries(results).map(([p,r])=>[p,r.base.summary]))}));
