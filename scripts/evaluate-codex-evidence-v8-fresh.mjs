import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {assessEvidenceV8} from './codex-evidence-wave-v8.mjs';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {commonCohort,exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const start=Date.parse('2026-10-04T06:00Z'),cutoff=Date.parse('2026-10-04T06:30Z');
assert.ok(Date.now()>=cutoff,'Fresh cutoff has not happened yet');
const path='reports/codex-evidence-v8-fresh-20261004T0600-0630.json';assert.ok(!existsSync(path),'Preserve the original fresh report');
const selectionPath='reports/codex-evidence-v8-selection.json',selection=JSON.parse(readFileSync(selectionPath));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
for(const[p,h]of Object.entries(selection.hashes))assert.equal(hash(p),h,`Frozen dependency changed ${p}`);
const hashes={...selection.hashes,[selectionPath]:hash(selectionPath),'scripts/evaluate-codex-evidence-v8-fresh.mjs':hash('scripts/evaluate-codex-evidence-v8-fresh.mjs')};
const prior=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
const universe=new Map(prior.universe.map(s=>[s.id,s])),records=[],inventory=[];
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){
  const mints=new Set();
  await readHistoryLines(source,'events.jsonl',x=>{
    if(x.type!=='DETAIL_STARTED'||!Number.isFinite(x.startedAt)||x.startedAt>=cutoff)return;
    const id=`${x.mint}:${x.startedAt}:${x.worker}`;
    if(!universe.has(id))universe.set(id,{id,mint:x.mint,start:x.startedAt,source:source.id});
    if(x.startedAt>=start)mints.add(x.mint);
  });
  if(!mints.size)continue;
  const data=await loadHistorySource(source,{onlyMints:mints,cutoff}),sol=Object.values(data.tokens).flatMap(t=>t.sol).sort((a,b)=>a.at-b.at);
  let details=0;
  for(const s of data.sessions.filter(s=>s.start>=start)){
    details++;const p=prepareAdaptiveSession(data,s,sol);
    for(const signal of p.signals.filter(r=>r.lane==='AGY_NATIVE')){
      const decision=assessEvidenceV8(selection.model,signal),outcomes=[];
      for(const[,delayMs,feeSide]of scenarios)for(const policy of ['AGY_NATIVE','AGY_REFERENCE','CODEX_EVIDENCE']){
        const o=policy==='CODEX_EVIDENCE'&&!decision.allowed?
          {delayMs,feeSide,status:'SKIP',pnl:0,ret:null,at:signal.at,stakeUsd:0,reason:decision.reason}:
          replayAdaptiveTrade({...signal,lane:policy==='AGY_REFERENCE'?'AGY_REFERENCE':'AGY_NATIVE'},p,{delayMs,feeSide});
        outcomes.push({policy,...o});
      }records.push({...signal,decision,outcomes});
    }
  }inventory.push({source:source.id,details});
}
const cohort=commonCohort(records,[...universe.values()],start,cutoff),results={};
for(const policy of ['AGY_NATIVE','AGY_REFERENCE','CODEX_EVIDENCE']){
  results[policy]=Object.fromEntries(scenarios.map(([s,delayMs,feeSide])=>{
    const rows=cohort.map(r=>{let o=r.outcomes.find(o=>o.policy===policy&&o.delayMs===delayMs&&o.feeSide===feeSide);
      if(o.at!==null&&o.at>=cutoff&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.at,day:wibDay(r.at),captureEnd:Math.min(r.captureEnd,cutoff),
        solUsd:r.solUsd,solAssumed:r.solAssumed,...o,bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });
    const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
    return[s,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},portfolio:{...portfolio,selectedIds:undefined},rows}];
  }));
}
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Source changed during replay ${p}`);
const report={generatedAt:new Date().toISOString(),start,cutoff,hashes,selected:selection.selected,diagnosticModel:selection.diagnosticModel,
  diagnosticOnly:selection.diagnosticOnly,trainingPassed:selection.trainingPassed,liveAllowed:false,status:selection.status,
  inventory,counts:{details:inventory.reduce((s,x)=>s+x.details,0),signals:records.length,cohort:cohort.length},records,results,
  caveats:['Same native buy and exit when the evidence model allows. No fitting on this window.',
    'Short historical replay of previously unused data, not a seven-day live forward trial.',
    'Training eligibility and rejection do not change because of this small evaluation.']};
writeFileSync(path,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output:path,status:report.status,counts:report.counts,selected:selection.selected,
  results:Object.fromEntries(Object.entries(results).map(([l,r])=>[l,r.base.summary]))}));
