import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {signalsCostTempoV12,evaluateCostTempoV12,TEMPO_CONFIGS} from './codex-cost-tempo-v12.mjs';
import {commonCohort,wibDay,exitStats} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
import {STUDY_SCENARIOS,studyHash,studyTrainingPassed,compactStudy} from './codex-cached-opportunity-study.mjs';
const start=Date.parse('2026-09-30T17:00Z'),trainEnd=Date.parse('2026-10-03T05:00Z'),cutoff=Date.parse('2026-10-04T03:00Z');
const protocol='docs/CODEX_COST_TEMPO_V12_PROTOCOL.md',output='reports/codex-cost-tempo-v12-results.json';
assert.ok(!existsSync(output),'Preserve original v12 study');
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
for(const[p,h]of Object.entries(parent.hashes))assert.equal(studyHash(p),h,`Changed parent ${p}`);
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-cost-tempo-v12.mjs','scripts/run-codex-cost-tempo-v12.mjs',
  'scripts/codex-peak-recheck-v10.mjs','scripts/codex-prebuy-recheck-v9.mjs','scripts/codex-cached-opportunity-study.mjs']
  .map(p=>[p,studyHash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
const prior=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
const universe=new Map(prior.universe.map(s=>[s.id,s])),records=[],inventory=[],caseFiles=[];
const sources=[];
for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){let details=0;
  await readHistoryLines(source,'events.jsonl',x=>{if(x.type==='DETAIL_STARTED'&&x.startedAt>=start&&x.startedAt<cutoff)details++;});
  if(details)sources.push({source,details});
}
mkdirSync('reports/codex-cost-tempo-v12-runs',{recursive:true});
for(const{source,details}of sources){
  const path=`reports/codex-cost-tempo-v12-runs/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  if(process.argv.includes('--cached')&&existsSync(path)){
    const saved=JSON.parse(readFileSync(path));assert.equal(saved.fingerprint,fingerprint);
    records.push(...saved.records);inventory.push(saved.inventory);for(const s of saved.universe)universe.set(s.id,s);
    caseFiles.push({path,sha256:studyHash(path)});console.log(JSON.stringify({stage:'cached',source:source.id}));continue;
  }
  assert.ok(!existsSync(path),'Use --cached to retain earlier source results');
  const data=await loadHistorySource(source,{cutoff}),sol=Object.values(data.tokens).flatMap(t=>t.sol).sort((a,b)=>a.at-b.at);
  const out=[],sessions=[],cases=[];let withTicks=0,inferred=0,atLeast90s=0;
  for(const session of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    const u={id:session.id,mint:session.mint,start:session.start,end:session.end,source:session.source};
    sessions.push(u);universe.set(u.id,u);
    const p=prepareAdaptiveSession(data,session,sol),independent=signalsCostTempoV12(session,p,sol),native=p.signals.filter(s=>s.lane.startsWith('AGY_'));
    if(p.ticks.length)withTicks++;if(session.endInferred)inferred++;if(session.end-session.start>=90000)atLeast90s++;
    for(const signal of native)out.push({...signal,outcomes:STUDY_SCENARIOS.map(([,delayMs,feeSide])=>replayAdaptiveTrade(signal,p,{delayMs,feeSide}))});
    for(const signal of independent)for(const config of TEMPO_CONFIGS.filter(c=>c.lambda===signal.lambda)){
      out.push({...signal,id:`${signal.id}:${config.exitMode}`,lane:config.id,config,
        outcomes:STUDY_SCENARIOS.map(([,delayMs,feeSide])=>evaluateCostTempoV12(signal,p,config,{delayMs,feeSide}))});
    }
    if(native.length||independent.length)cases.push({session,signals:[...native,...independent],prepared:{ticks:p.ticks,frames:p.frames,end:p.end}});
  }
  const item={source:source.id,metadataDetails:details,loadedDetails:sessions.length,withTicks,inferred,atLeast90s,
    signals:Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE',...TEMPO_CONFIGS.map(c=>c.id)].map(l=>[l,out.filter(r=>r.lane===l).length]))};
  writeFileSync(path,JSON.stringify({fingerprint,inventory:item,universe:sessions,records:out,cases}),{flag:'wx'});
  caseFiles.push({path,sha256:studyHash(path)});records.push(...out);inventory.push(item);
  console.log(JSON.stringify({stage:'capture',progress:`${inventory.length}/${sources.length}`,...item}));
}
function evaluate(lane,lo,hi){
  const cohort=commonCohort(records.filter(r=>r.lane===lane),[...universe.values()],lo,hi);
  return Object.fromEntries(STUDY_SCENARIOS.map(([name,delayMs,feeSide])=>{
    const rows=cohort.map(r=>{let o=r.outcomes.find(o=>o.delayMs===delayMs&&o.feeSide===feeSide);
      if(o.at!==null&&o.at>=hi)o={...o,status:'PARTITION_UNKNOWN',at:null,pnl:null,ret:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.at,day:wibDay(r.at),captureEnd:Math.min(r.captureEnd,hi),
        solUsd:r.solUsd,solAssumed:r.solAssumed,entryMode:r.mode,entryScore:r.entryScore,...o,
        bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });
    return[name,{summary:exitStats(rows),portfolio:simulateOnePosition(rows,5),rows}];
  }));
}
const controls=['AGY_NATIVE','AGY_REFERENCE'];
const train=Object.fromEntries([...controls,...TEMPO_CONFIGS.map(c=>c.id)].map(l=>[l,evaluate(l,start,trainEnd)]));
const ranking=TEMPO_CONFIGS.map(config=>{const results=train[config.id],s=results.base.summary;
  return {config,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(r=>r.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
const primary=ranking.find(r=>r.results.base.summary.signals>0)??null,selected=primary?.config??null;
const trainingPassed=studyTrainingPassed(primary,train);
const selection={generatedAt:new Date().toISOString(),fingerprint,hashes,protocol,selected,trainingPassed,liveAllowed:false,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':selected?'TRAINING_REJECTED':'NO_ACTIVE_CANDIDATE',
  selectionBeforeAuditAggregation:true,forwardStart:Math.max(Date.parse('2026-10-04T07:00Z'),Date.now()),
  cumulativeHypotheses:55,ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync('reports/codex-cost-tempo-v12-selection.json',JSON.stringify(selection,null,2),{flag:'wx'});
const audit=Object.fromEntries([...controls,...(selected?[selected.id]:[])].map(l=>[l,evaluate(l,trainEnd,cutoff)]));
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Changed source ${p}`);
const report={...selection,start,trainEnd,cutoff,inventory,caseFiles,
  counts:{details:inventory.reduce((s,i)=>s+i.loadedDetails,0),withTicks:inventory.reduce((s,i)=>s+i.withTicks,0),
    atLeast90s:inventory.reduce((s,i)=>s+i.atLeast90s,0),inferred:inventory.reduce((s,i)=>s+i.inferred,0)},
  universe:[...universe.values()],records,results:{train,audit},
  caveats:['All historical windows previously studied; not an independent holdout.',
    'Independent entry universe, not same-buy pairs against AGY.',
    'Momentum projection is a fixed heuristic, not a calibrated expected-profit estimate.',
    'Duration >=90s does not imply continuous swaps, socket health, or receipt coverage.',
    'Portfolio can block on unknown; independent event totals are not executable portfolio returns.',
    'No guarantee of rugpull prevention or stop-price fills. No live integration.']};
writeFileSync(output,JSON.stringify(report),{flag:'wx'});
const summary={...report,universe:undefined,records:undefined,results:Object.fromEntries(Object.entries(report.results).map(([part,ls])=>[part,
  Object.fromEntries(Object.entries(ls).map(([l,r])=>[l,compactStudy(r)]))]))};
writeFileSync('reports/codex-cost-tempo-v12-summary.json',JSON.stringify(summary,null,2),{flag:'wx'});
console.log(JSON.stringify({status:report.status,selected,counts:report.counts,
  ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),
  audit:Object.fromEntries(Object.entries(audit).map(([l,r])=>[l,r.base.summary]))}));
