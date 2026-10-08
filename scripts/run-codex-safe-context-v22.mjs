import {readFileSync,writeFileSync,mkdirSync,existsSync,statfsSync,statSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {SAFE_CONTEXT_CONFIGS,safeSignalsV22,evaluateSafeV22} from './codex-safe-context-v22.mjs';
import {commonCohort,wibDay,exitStats,pairedExitDifference} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
import {STUDY_SCENARIOS,studyHash,studyTrainingPassed,compactStudy} from './codex-cached-opportunity-study.mjs';
const start=Date.parse('2026-09-30T17:00Z'),trainEnd=Date.parse('2026-10-03T05:00Z'),auditEnd=Date.parse('2026-10-04T03:00Z'),cutoff=Date.parse('2026-10-04T13:30Z');
const root='reports/codex-safe-context-v22',output=`${root}-results.json`;
assert.ok(!existsSync(output),'Preserve completed study');mkdirSync(root,{recursive:true});
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
const hashes={...parent.hashes,...Object.fromEntries(['docs/CODEX_SAFE_CONTEXT_V22_PROTOCOL.md','scripts/codex-safe-context-v22.mjs',
  'scripts/run-codex-safe-context-v22.mjs','scripts/codex-cached-opportunity-study.mjs','scripts/codex-portfolio.mjs',
  'scripts/codex-same-entry-analysis.mjs'].map(p=>[p,studyHash(p)]))};
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Source changed ${p}`);
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
let bytes=readdirSync(root).reduce((n,p)=>n+statSync(`${root}/${p}`).size,0);
function write(path,value){const body=JSON.stringify(value);const disk=statfsSync(root);
  assert.ok(disk.bavail*disk.bsize>=2*1024**3,'DISK_LIMIT');assert.ok(bytes+Buffer.byteLength(body)<=512*1024**2,'ARTIFACT_LIMIT');
  writeFileSync(path,body,{flag:'wx'});bytes+=Buffer.byteLength(body);}
const previous=JSON.parse(readFileSync('reports/codex-cost-tempo-v12-results.json'));
const universe=new Map(previous.universe.map(s=>[s.id,s])),records=[],inventory=[],caseFiles=[];
const sources=[];
for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){let details=0;
  await readHistoryLines(source,'events.jsonl',x=>{if(x.type==='DETAIL_STARTED'&&x.startedAt>=start&&x.startedAt<cutoff)details++;});
  if(details)sources.push({source,details});}
console.log(JSON.stringify({stage:'inventory',sources:sources.length,details:sources.reduce((n,s)=>n+s.details,0)}));
for(const{source,details}of sources){
  const path=`${root}/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  if(existsSync(path)){
    assert.ok(process.argv.includes('--cached'),'Use --cached for interrupted study');
    const saved=JSON.parse(readFileSync(path));assert.equal(saved.fingerprint,fingerprint);
    records.push(...saved.records);inventory.push(saved.inventory);for(const s of saved.universe)universe.set(s.id,s);
    caseFiles.push({path,sha256:studyHash(path)});continue;
  }
  const data=await loadHistorySource(source,{cutoff}),sol=Object.values(data.tokens).flatMap(t=>t.sol).sort((a,b)=>a.at-b.at);
  const out=[],sessions=[],cases=[];let withTicks=0,inferred=0,atLeast90s=0;
  for(const session of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    const u={id:session.id,mint:session.mint,start:session.start,end:session.end,source:session.source};sessions.push(u);universe.set(u.id,u);
    const p=prepareAdaptiveSession(data,session,sol),native=p.signals.filter(s=>s.lane.startsWith('AGY_')),safe=safeSignalsV22(session,p,sol);
    if(p.ticks.length)withTicks++;if(session.endInferred)inferred++;if(session.end-session.start>=90000)atLeast90s++;
    for(const signal of [...native,...safe]){
      const agy=signal.lane.startsWith('AGY_'),mode=signal.lane==='SAFE_NATIVE'?'SAFE_NATIVE':'CONTEXT';
      const outcomes=STUDY_SCENARIOS.map(([,delayMs,feeSide])=>agy?replayAdaptiveTrade(signal,p,{delayMs,feeSide}):evaluateSafeV22(signal,p,mode,{delayMs,feeSide}));
      const sameBuy=mode==='CONTEXT'&&!agy?STUDY_SCENARIOS.map(([,delayMs,feeSide])=>evaluateSafeV22(signal,p,'SAFE_NATIVE',{delayMs,feeSide})):null;
      if(sameBuy)for(let i=0;i<outcomes.length;i++)for(const k of ['buyAt','buyPrice','buyQuantity','initialNet'])assert.equal(outcomes[i][k],sameBuy[i][k]);
      out.push({...signal,outcomes,sameBuy});
    }
    if(native.length||safe.length)cases.push({session,signals:[...native,...safe],prepared:{ticks:p.ticks,frames:p.frames,end:p.end}});
  }
  const item={source:source.id,metadataDetails:details,loadedDetails:sessions.length,withTicks,inferred,atLeast90s,
    signals:Object.fromEntries(['AGY_NATIVE','SAFE_NATIVE',...SAFE_CONTEXT_CONFIGS.map(c=>c.id)].map(l=>[l,out.filter(r=>r.lane===l).length]))};
  write(path,{fingerprint,inventory:item,universe:sessions,records:out,cases});caseFiles.push({path,sha256:studyHash(path)});
  records.push(...out);inventory.push(item);console.log(JSON.stringify({stage:'replayed',progress:`${inventory.length}/${sources.length}`,...item}));
}
function evaluate(lane,lo,hi,sameBuy=false){
  const cohort=commonCohort(records.filter(r=>r.lane===lane),[...universe.values()],lo,hi);
  return Object.fromEntries(STUDY_SCENARIOS.map(([name,delayMs,feeSide])=>{
    const rows=cohort.map(r=>{let o=(sameBuy?r.sameBuy:r.outcomes).find(o=>o.delayMs===delayMs&&o.feeSide===feeSide);
      if(o.at!==null&&o.at>=hi)o={...o,status:'PARTITION_UNKNOWN',at:null,pnl:null,ret:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.at,day:wibDay(r.at),captureEnd:Math.min(r.captureEnd,hi),
        solUsd:r.solUsd,solAssumed:r.solAssumed,entryMode:r.mode,...o,bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });return [name,{summary:exitStats(rows),portfolio:simulateOnePosition(rows,5),rows}];
  }));
}
const controls=['AGY_NATIVE','AGY_REFERENCE','SAFE_NATIVE'];
const train=Object.fromEntries([...controls,...SAFE_CONTEXT_CONFIGS.map(c=>c.id)].map(l=>[l,evaluate(l,start,trainEnd)]));
const ranking=SAFE_CONTEXT_CONFIGS.map(config=>{const results=train[config.id],s=results.base.summary;return {config,results,
  enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(r=>r.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
const primary=ranking[0],selected=primary.config,trainingPassed=studyTrainingPassed(primary,train);
const selection={fingerprint,hashes,selected,trainingPassed,liveAllowed:false,cumulativeHypotheses:88,
  status:trainingPassed?'HISTORICAL_SCREEN_PASSED':'TRAINING_REJECTED',generatedAt:new Date().toISOString(),
  ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
write(`${root}-selection.json`,selection);
const results={train},sameBuy={},paired={};
for(const [part,lo,hi]of [['train',start,trainEnd],['audit',trainEnd,auditEnd],['storedLater',auditEnd,cutoff]]){
  if(part!=='train')results[part]=Object.fromEntries([...controls,selected.id].map(l=>[l,evaluate(l,lo,hi)]));
  sameBuy[part]=evaluate(selected.id,lo,hi,true);
  paired[part]=Object.fromEntries(STUDY_SCENARIOS.map(([s])=>[s,pairedExitDifference(results[part][selected.id][s].rows,sameBuy[part][s].rows)]));
}
const cumulative=Object.fromEntries([...controls,selected.id].map(l=>[l,Object.fromEntries(STUDY_SCENARIOS.map(([s])=>{
  const rows=Object.values(results).flatMap(part=>part[l][s].rows);return [s,{summary:exitStats(rows),portfolio:simulateOnePosition(rows,5)}];
}))]));
const coverage=Object.fromEntries(Object.entries(results).map(([part,ls])=>{
  const rs=ls[selected.id].base.rows,byHour={},byMode={};
  for(const r of rs){const h=new Date(r.signalAt+25200000).getUTCHours();byHour[h]=(byHour[h]??0)+1;byMode[r.entryMode]=(byMode[r.entryMode]??0)+1;}
  return [part,{byHour,byMode,switches:rs.reduce((n,r)=>n+(r.exitState?.switches??0),0)}];
}));
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Source changed ${p}`);
const report={...selection,start,trainEnd,auditEnd,cutoff,inventory,caseFiles,results,sameBuy,paired,cumulative,coverage,
  counts:{details:inventory.reduce((n,r)=>n+r.loadedDetails,0),withTicks:inventory.reduce((n,r)=>n+r.withTicks,0),inferred:inventory.reduce((n,r)=>n+r.inferred,0)},
  caveats:['Independent entries versus AGY; same-buy safe-native comparator isolates exit.',
    'Reused historical periods; not an untouched holdout. Sparse hours do not prove all-time profitability.',
    'Available raw only; deleted captures cannot be recovered.', 'Modeled fills, not quote-exact orders/receipts. No live deployment.']};
write(output,report);
write(`${root}-summary.json`,{...report,results:Object.fromEntries(Object.entries(results).map(([p,ls])=>[p,Object.fromEntries(Object.entries(ls).map(([l,r])=>[l,compactStudy(r)]))])),
  sameBuy:Object.fromEntries(Object.entries(sameBuy).map(([p,r])=>[p,compactStudy(r)]))});
console.log(JSON.stringify({stage:'complete',selected,trainingPassed,counts:report.counts,
  results:Object.fromEntries(Object.entries(results).map(([p,ls])=>[p,Object.fromEntries(Object.entries(ls).map(([l,r])=>[l,r.base.summary]))])),coverage}));
