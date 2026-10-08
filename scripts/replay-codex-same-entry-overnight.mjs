// Offline extension only: retain the original selection, rules, and historical reports.
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {SAME_ENTRY_POLICIES,createSameEntryExit,assessSameEntryExit,chooseExitMode} from '../src/codex-same-entry-exits.ts';
import {EXIT_COMPARATORS,commonCohort,outcomeRows,exitStats,pairedExitDifference,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
import {asOf} from './guarded-wave-replay-core.mjs';
const protocol='docs/CODEX_SAME_ENTRY_OVERNIGHT_PROTOCOL.md';
const start=Date.parse('2026-10-03T12:55:00Z'),cutoff=Date.parse('2026-10-04T03:00:00Z');
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const prior=JSON.parse(readFileSync('reports/codex-same-entry-replay.json'));
const selection=JSON.parse(readFileSync('reports/codex-same-entry-summary.json'));
assert.equal(prior.cutoff,start);assert.equal(selection.selected,'CODEX_TREND');
assert.equal(selection.fingerprint,prior.fingerprint);
for(const[path,expected]of Object.entries(prior.hashes))assert.equal(hash(path),expected,`Frozen source changed: ${path}`);
const frozenInputs=['reports/codex-same-entry-replay.json','reports/codex-same-entry-summary.json',protocol,
  'scripts/replay-codex-same-entry-overnight.mjs','scripts/codex-same-entry-analysis.mjs','scripts/codex-portfolio.mjs',
  'src/codex-flow-wave-v2.ts','src/codex-guarded-wave.ts','src/codex-adaptive-wave-v3.ts',
  'src/research-simulation.ts','scripts/guarded-wave-replay-core.mjs'];
const hashes={...prior.hashes,...Object.fromEntries(frozenInputs.map(p=>[p,hash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+start+cutoff).digest('hex');
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
const files=['events.jsonl','token-summary.jsonl','screened-tokens.jsonl','trades.jsonl','developer-holders.jsonl',
  'token-stat.jsonl','sol-spot-checks.jsonl','tracked-holders.jsonl','research.sqlite','research.sqlite-wal'];
function snapshot(source){return Object.fromEntries((source.archive?[source.archive]:files.map(f=>`${source.dir}/${f}`))
  .map(p=>{if(!existsSync(p))return[p,null];const s=statSync(p);return[p,{size:s.size,mtimeMs:s.mtimeMs}];}));}
const sources=historySources(),missing=sources.filter(s=>s.archive&&!existsSync(s.archive));
const available=sources.filter(s=>!missing.includes(s));
const universe=new Map(prior.universe.map(s=>[s.id,s])),sourceInventory=[],newSources=[];
for(const source of available){
  const before=snapshot(source);let details=0;const mints=new Set();
  const metadata=await readHistoryLines(source,'events.jsonl',x=>{
    if(x.type!=='DETAIL_STARTED'||!Number.isFinite(x.startedAt)||x.startedAt>=cutoff)return;
    const id=`${x.mint}:${x.startedAt}:${x.worker}`;
    if(!universe.has(id))universe.set(id,{id,mint:x.mint,start:x.startedAt,source:source.id});
    if(x.startedAt>=start){details++;mints.add(x.mint);}
  });
  const entry={source:source.id,details,metadata,before};sourceInventory.push(entry);
  if(details)newSources.push({source,mints,entry});
}
console.log(JSON.stringify({stage:'discovery',sources:newSources.length,details:sourceInventory.reduce((s,x)=>s+x.details,0),
  missingArchives:missing.map(s=>s.id)}));
const records=[],coverage=[];let buyParityChecks=0;
for(const{source,mints,entry}of newSources){
  const data=await loadHistorySource(source,{onlyMints:mints,cutoff});
  const sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
  let signals=0;
  for(const s of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    universe.set(s.id,{id:s.id,mint:s.mint,start:s.start,end:s.end,source:s.source});
    const p=prepareAdaptiveSession(data,s,sol);
    coverage.push({id:s.id,mint:s.mint,start:s.start,end:s.end,ticks:p.ticks.length,
      durationMs:s.end-s.start,endInferred:!!s.endInferred,reason:s.reason??null});
    for(const signal of p.signals.filter(r=>r.lane==='AGY_NATIVE')){
      signals++;const outcomes=[];
      for(const[,delayMs,feeSide]of scenarios){
        const options={delayMs,feeSide},native=replayAdaptiveTrade(signal,p,options);
        const all=[{policy:'AGY_NATIVE',...native},
          {policy:'AGY_REFERENCE',...replayAdaptiveTrade({...signal,lane:'AGY_REFERENCE'},p,options)}];
        for(const policy of SAME_ENTRY_POLICIES){
          const exitController={create:(at,net,f)=>createSameEntryExit(policy,at,net,f),assess:assessSameEntryExit};
          all.push({policy:`CODEX_${policy}`,...replayAdaptiveTrade(signal,p,{...options,exitController})});
        }
        for(const outcome of all)for(const key of ['buyAt','buyPrice','buyQuantity','initialNet']){
          assert.equal(outcome[key],native[key],`${signal.id} ${outcome.policy} ${key}`);buyParityChecks++;
        }
        outcomes.push(...all);
      }
      records.push({...signal,entryRegime:chooseExitMode(asOf(p.frames,signal.at,'at')),outcomes});
    }
  }
  entry.after=snapshot(source);entry.counts=data.counts;
  entry.changedDuringRead=JSON.stringify(entry.before)!==JSON.stringify(entry.after);
  console.log(JSON.stringify({stage:'replay',source:source.id,details:entry.details,signals,buyParityChecks}));
}
// Catch source changes in the middle of replay, not just at initial load.
for(const[path,expected]of Object.entries(hashes))assert.equal(hash(path),expected,`Source changed during replay: ${path}`);
const allUniverse=[...universe.values()],cohort=commonCohort([...prior.records,...records],allUniverse,start,cutoff);
assert.ok(cohort.every(r=>r.at>=start&&r.at<cutoff-180000));
assert.equal(new Set(records.map(r=>r.id)).size,records.length,'Duplicate signal IDs');
const results={};
for(const[name,delayMs,feeSide]of scenarios){
  const rows=Object.fromEntries(EXIT_COMPARATORS.map(p=>[p,outcomeRows(cohort,p,delayMs,feeSide,cutoff)]));
  results[name]=Object.fromEntries(EXIT_COMPARATORS.map(p=>{
    const portfolio=simulateOnePosition(rows[p],5);
    return[p,{summary:exitStats(rows[p]),portfolio:{...portfolio,selectedIds:undefined},
      paired:p.startsWith('CODEX')?Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE'].map(b=>[b,pairedExitDifference(rows[p],rows[b])])):undefined}];
  }));
}
const cells=[0,4,8,12,16,20].map(hour=>({hourWib:hour,descriptiveOnly:true,
  lanes:Object.fromEntries(EXIT_COMPARATORS.map(p=>[p,exitStats(outcomeRows(cohort,p,1000,.01,cutoff)
    .filter(r=>Math.floor(((new Date(r.signalAt+25200000).getUTCHours()))/4)*4===hour))]))}));
const previousDayDetails=allUniverse.filter(s=>wibDay(s.start)==='2026-10-03');
const counts={newDetailSessions:coverage.length,newMints:new Set(coverage.map(s=>s.mint)).size,
  sessionsWithTicks:coverage.filter(s=>s.ticks>0).length,sessionsAtLeast90s:coverage.filter(s=>s.durationMs>=90000).length,
  inferredEnds:coverage.filter(s=>s.endInferred).length,rawSignals:records.length,cohort:cohort.length,
  previousWibDay:'2026-10-03',previousDayDetails:previousDayDetails.length,
  previousDayMints:new Set(previousDayDetails.map(s=>s.mint)).size};
const report={generatedAt:new Date().toISOString(),protocol,fingerprint,hashes,priorFingerprint:prior.fingerprint,
  start,cutoff,selected:selection.selected,trainingPassed:selection.trainingPassed,
  status:'NO_VALIDATED_OUTPERFORMANCE',liveAllowed:false,stakeUsd:5,buyParityChecks,counts,
  missingArchives:missing.map(s=>s.id),sourceInventory,coverage,universe:allUniverse,records,cohortIds:cohort.map(r=>r.id),results,cells,
  caveats:[...prior.caveats.filter(s=>!s.startsWith('All data before')),
    'Original training selection retained, including TRAINING_REJECTED; no overnight reselection.',
    'Metadata/coverage counts use stored prior universe plus available DETAIL_STARTED records, not a claim of complete service capture.',
    'Original datasets may have been cleaned externally; missing sources are not reconstructed.',
    'Difference of conservative bounds is not a rigorous bound on unknown paired improvement.',
    'One-position portfolio starts flat at window start and is separate from the blocked historical portfolio.',
    'Observed end duration >=90s does not establish continuous tape coverage for 90s.',
    'Stored independent event study, not actual fills or a seven-day forward-paper trial.']};
writeFileSync('reports/codex-same-entry-overnight-replay.json',JSON.stringify(report));
const small={...report,sourceInventory:undefined,coverage:undefined,universe:undefined,records:undefined,cohortIds:undefined,
  changedSources:sourceInventory.filter(s=>s.changedDuringRead).map(s=>s.source),
  invalidLines:sourceInventory.reduce((sum,s)=>sum+s.metadata.invalid+(s.counts?.invalid??0),0)};
writeFileSync('reports/codex-same-entry-overnight-summary.json',JSON.stringify(small,null,2));
console.log(JSON.stringify({counts,selected:report.selected,buyParityChecks,results:results.base,status:report.status}));
