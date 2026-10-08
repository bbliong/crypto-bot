// Explicit bounded offline evaluation; no recurring daemon or live execution.
import {readFileSync,writeFileSync,existsSync,statfsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {signalsCostTempoV12,evaluateCostTempoV12} from './codex-cost-tempo-v12.mjs';
import {commonCohort,wibDay,exitStats} from './codex-same-entry-analysis.mjs';
import {STUDY_SCENARIOS,studyHash,compactStudy} from './codex-cached-opportunity-study.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const selectionPath='reports/codex-cost-tempo-v12-selection.json',reportPath='reports/codex-cost-tempo-v12-results.json';
assert.ok(existsSync(selectionPath)&&existsSync(reportPath),'Run v12 historical selection first');
const selection=JSON.parse(readFileSync(selectionPath)),prior=JSON.parse(readFileSync(reportPath));
for(const[p,h]of Object.entries(selection.hashes))assert.equal(studyHash(p),h,`Frozen source changed ${p}`);
const index=process.argv.indexOf('--cutoff'),text=index<0?null:process.argv[index+1];
assert.ok(index<0||text,'--cutoff requires an ISO timestamp');
const start=selection.forwardStart,cutoff=text?Date.parse(text):Math.floor(Date.now()/1800000)*1800000;
assert.ok(Number.isFinite(cutoff)&&cutoff<=Date.now()&&cutoff-start>=1800000,
  'Need a completed >=30-minute window after frozen forwardStart; no evaluation performed');
const disk=statfsSync('reports');assert.ok(disk.bavail*disk.bsize>=2*1024**3,'Keep at least 2 GiB free for research outputs');
const stamp=t=>new Date(t).toISOString().replace(/[-:.]/g,'').replace('000Z','Z');
const output=`reports/codex-cost-tempo-v12-forward-${stamp(start)}-${stamp(cutoff)}.json`;
assert.ok(!existsSync(output),'Preserve prior forward output');
const hashes={...selection.hashes,[selectionPath]:studyHash(selectionPath),
  'scripts/evaluate-codex-cost-tempo-forward.mjs':studyHash('scripts/evaluate-codex-cost-tempo-forward.mjs')};
const universe=new Map(prior.universe.map(s=>[s.id,s])),cases=[],records=[],inventory=[];
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
  let details=0,withTicks=0;
  for(const session of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    details++;const p=prepareAdaptiveSession(data,session,sol);if(p.ticks.length)withTicks++;
    const native=p.signals.filter(s=>s.lane.startsWith('AGY_'));
    const independent=selection.selected?signalsCostTempoV12(session,p,sol).filter(s=>s.lambda===selection.selected.lambda):[];
    for(const signal of native)records.push({...signal,outcomes:STUDY_SCENARIOS.map(([,delayMs,feeSide])=>replayAdaptiveTrade(signal,p,{delayMs,feeSide}))});
    for(const signal of independent)records.push({...signal,id:`${signal.id}:${selection.selected.exitMode}`,lane:selection.selected.id,
      outcomes:STUDY_SCENARIOS.map(([,delayMs,feeSide])=>evaluateCostTempoV12(signal,p,selection.selected,{delayMs,feeSide}))});
    if(native.length||independent.length)cases.push({session,signals:[...native,...independent],prepared:{ticks:p.ticks,frames:p.frames,end:p.end}});
  }
  inventory.push({source:source.id,details,withTicks});
}
const lanes=['AGY_NATIVE','AGY_REFERENCE',...(selection.selected?[selection.selected.id]:[])];
const results=Object.fromEntries(lanes.map(lane=>{
  const cohort=commonCohort(records.filter(r=>r.lane===lane),[...universe.values()],start,cutoff);
  return[lane,Object.fromEntries(STUDY_SCENARIOS.map(([name,delayMs,feeSide])=>{
    const rows=cohort.map(r=>{let o=r.outcomes.find(o=>o.delayMs===delayMs&&o.feeSide===feeSide);
      if(o.at!==null&&o.at>=cutoff)o={...o,status:'PARTITION_UNKNOWN',at:null,pnl:null,ret:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.at,day:wibDay(r.at),captureEnd:Math.min(r.captureEnd,cutoff),
        solUsd:r.solUsd,solAssumed:r.solAssumed,entryMode:r.mode,entryScore:r.entryScore,...o,
        bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });return[name,{summary:exitStats(rows),portfolio:simulateOnePosition(rows,5),rows}];
  }))];
}));
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Source changed while evaluating ${p}`);
const report={generatedAt:new Date().toISOString(),start,cutoff,hashes,selection,inventory,results,cases,
  counts:{details:inventory.reduce((s,r)=>s+r.details,0),withTicks:inventory.reduce((s,r)=>s+r.withTicks,0),signals:records.length},
  status:'NO_VALIDATED_OUTPERFORMANCE',liveAllowed:false,
  caveats:['All policies selected before this interval; no reselection or fit from test.',
    'Training rejection remains; short fresh replay cannot replace >=100trade/7day validation.',
    'Each later invocation is cumulative from the same frozen start, not independent additive windows.',
    'Latest 180 seconds embargoed; do not sum overlapping cumulative reports.',
    'Source archives are mutable/deletable; compare inventory and preserve replay cases.',
    'No actual swap execution or recurring monitor started.']};
writeFileSync(output,JSON.stringify(report),{flag:'wx'});
writeFileSync(output.replace('.json','-summary.json'),JSON.stringify({...report,cases:undefined,
  results:Object.fromEntries(Object.entries(results).map(([l,r])=>[l,compactStudy(r)]))},null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:report.status,counts:report.counts,
  results:Object.fromEntries(Object.entries(results).map(([l,r])=>[l,r.base.summary]))}));
