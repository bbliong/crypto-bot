// Finite, preregistered research loop. Selected only on TRAIN; live is always disabled.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,loadHistorySource,readHistoryLines} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {ENTRY_MODES,EXIT_MODES,ENTRY_GATES,evaluateV5} from './codex-engineering-v5.mjs';
import {commonCohort,exitStats,wibDay,round} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const availableTraining=process.argv.includes('--available-training');
const prefix=availableTraining?'codex-engineering-v5b':'codex-engineering-v5';
const protocol=availableTraining?'docs/CODEX_ENGINEERING_LOOP_V5B_PROTOCOL.md':'docs/CODEX_ENGINEERING_LOOP_V5_PROTOCOL.md';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const old=JSON.parse(readFileSync('reports/codex-same-entry-replay.json'));
const recent=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
const historicalEnd=recent.cutoff,start=availableTraining?Date.parse('2026-10-04T03:30:00Z'):historicalEnd;
const cutoff=Date.parse(availableTraining?'2026-10-04T03:40:00Z':'2026-10-04T03:30:00Z');
const trainEnd=Date.parse(availableTraining?'2026-10-03T05:00:00Z':'2026-09-30T17:00:00Z');
const files=[...Object.keys(old.hashes),protocol,'scripts/codex-engineering-v5.mjs','scripts/run-codex-engineering-v5.mjs',
  'scripts/codex-same-entry-analysis.mjs','scripts/codex-portfolio.mjs','src/research-simulation.ts',
  'src/codex-flow-wave-v2.ts','src/codex-guarded-wave.ts','scripts/codex-guarded-wave-engine.mjs',
  'scripts/guarded-wave-replay-core.mjs','src/codex-adaptive-wave-v3.ts'];
for(const[p,h]of Object.entries(old.hashes))assert.equal(hash(p),h,`Frozen dependency changed ${p}`);
const hashes=Object.fromEntries(files.map(p=>[p,hash(p)]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
const sources=historySources(),available=sources.filter(s=>!s.archive||existsSync(s.archive));
const stored=[...new Map([...old.records,...recent.records].map(r=>[r.id,r])).values()];
const universe=new Map(recent.universe.map(s=>[s.id,s]));
const groups=new Map();for(const r of stored){if(!groups.has(r.source))groups.set(r.source,[]);groups.get(r.source).push(r);}
let cases=[],missing=[],parity=0;
const cachePath='reports/codex-engineering-v5-dataset.json';
if(availableTraining||process.argv.includes('--cached')){
  const cached=JSON.parse(readFileSync(cachePath));
  // Changes to selection/reporting do not invalidate frozen frames; all frame/fee/native dependencies do.
  for(const[p,h]of Object.entries(cached.hashes))if(![protocol,'docs/CODEX_ENGINEERING_LOOP_V5_PROTOCOL.md',
    'scripts/run-codex-engineering-v5.mjs','scripts/codex-engineering-v5.mjs'].includes(p))assert.equal(hash(p),h,`Cached dependency changed ${p}`);
  ({cases,missing,parity}=cached);
  for(const c of cases){const r=stored.find(r=>r.id===c.signal.id);assert.ok(r);assert.equal(r.at,c.signal.at);assert.equal(r.captureEnd,c.signal.captureEnd);}
}else{
  for(const[sourceId,signals]of groups){
    const source=available.find(s=>s.id===sourceId);
    if(!source){missing.push(...signals.map(r=>({id:r.id,source:sourceId,reason:'SOURCE_MISSING'})));continue;}
    const data=await loadHistorySource(source,{onlyMints:new Set(signals.map(r=>r.mint)),cutoff:historicalEnd});
    for(const signal of signals){
      const s=data.sessions.find(s=>s.id===signal.sessionId);
      if(!s){missing.push({id:signal.id,source:sourceId,reason:'SESSION_MISSING'});continue;}
      s.end=Math.min(s.end,signal.captureEnd);
      const p=prepareAdaptiveSession(data,s,[]),prepared={ticks:p.ticks,frames:p.frames,end:p.end};
      for(const expected of signal.outcomes.filter(o=>['AGY_NATIVE','AGY_REFERENCE'].includes(o.policy))){
        const actual=replayAdaptiveTrade({...signal,lane:expected.policy},prepared,expected);
        for(const[k,v]of Object.entries(expected))if(k!=='policy'){
          if(typeof v==='number')assert.ok(Math.abs(actual[k]-v)<1e-9,`Parity ${signal.id} ${k}`);
          else assert.deepEqual(actual[k],v,`Parity ${signal.id} ${k}`);
        }parity++;
      }
      cases.push({signal,prepared});
    }
    console.log(JSON.stringify({stage:'capture',source:sourceId,cases:cases.length,parity}));
  }
  writeFileSync(cachePath,JSON.stringify({fingerprint,hashes,cases,missing,parity}));
}
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
const byId=new Map(cases.map(c=>[c.signal.id,c]));
const allRecords=()=>cases.map(c=>c.signal);
const cohort=(lo,hi)=>commonCohort(allRecords(),[...universe.values()],lo,hi);
function rowsFor(rs,config,delayMs,feeSide,end){
  return rs.map(r=>{
    const {prepared}=byId.get(r.id);
    let o=config.control?replayAdaptiveTrade({...r,lane:config.control},prepared,{delayMs,feeSide}):
      evaluateV5(r,prepared,config,{delayMs,feeSide});
    if(o.at!==null&&o.at>=end&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
    return {id:r.id,mint:r.mint,symbol:r.symbol,opportunityAt:r.at,signalAt:o.decisionAt??r.at,
      captureEnd:Math.min(r.captureEnd,end),day:wibDay(o.decisionAt??r.at),solUsd:r.solUsd,solAssumed:r.solAssumed,...o,
      bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
  });
}
function summary(rows){
  const active=rows.filter(r=>r.status!=='SKIP');return {...exitStats(active),opportunities:rows.length,skips:rows.length-active.length,
    skipReasons:rows.filter(r=>r.status==='SKIP').reduce((a,r)=>(a[r.reason]=(a[r.reason]??0)+1,a),{})};
}
function evaluate(config,rs,end,withRows=false){
  return Object.fromEntries(scenarios.map(([name,delayMs,feeSide])=>{
    const rows=rowsFor(rs,config,delayMs,feeSide,end),p=simulateOnePosition(rows.filter(r=>r.status!=='SKIP'),5);
    return[name,{summary:summary(rows),portfolio:{...p,selectedIds:undefined},...(withRows?{rows}:{})}];
  }));
}
const train=cohort(-Infinity,trainEnd);
assert.ok(train.length>0,'TRAINING_DATA_UNAVAILABLE: stop before selection or fresh-data evaluation');
function rank(configs){return configs.map(config=>{
  const results=evaluate(config,train,trainEnd),s=results.base.summary;
  return {config,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(r=>r.summary.conservativePnl))};
}).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);}
const loopA=rank(ENTRY_MODES.flatMap(entryMode=>EXIT_MODES.map(exitMode=>({id:`${entryMode}_${exitMode}_ALL`,entryMode,exitMode,gate:'ALL'}))));
const loopB=rank(ENTRY_GATES.map(gate=>({...loopA[0].config,gate,id:`${loopA[0].config.entryMode}_${loopA[0].config.exitMode}_${gate}`})));
const selected=loopB[0].config;
const controls=[{id:'AGY_NATIVE',control:'AGY_NATIVE'},{id:'AGY_REFERENCE',control:'AGY_REFERENCE'}];
const trainControls=Object.fromEntries(controls.map(c=>[c.id,evaluate(c,train,trainEnd)]));
// Selection written BEFORE reading fresh candidates or aggregating audit outcomes.
const trainingPassed=loopB[0].results.base.summary.closed>=30&&loopB[0].results.base.summary.days>=3&&
  scenarios.every(([s])=>{const c=loopB[0].results[s].summary;
    return c.conservativePnl>0&&c.unknown===0&&controls.every(b=>{const v=trainControls[b.id][s].summary;
      return c.conservativePnl>v.conservativePnl&&c.eventBoundDrawdown<=v.eventBoundDrawdown&&c.tailLoss10<=v.tailLoss10;});});
writeFileSync(`reports/${prefix}-selection.json`,JSON.stringify({fingerprint,selected,trainingPassed,
  selectedBeforeFreshRead:true,loopA,loopB,trainControls,missing,parity,liveAllowed:false},null,2));
console.log(JSON.stringify({stage:'selected',selected,trainingPassed,train:loopB[0].results.base.summary,
  loopATop:loopA.slice(0,3).map(r=>({id:r.config.id,enough:r.enough,score:r.score,stats:r.results.base.summary}))}));
// Scan metadata after selection, including new details in continuously running old-named sources.
let freshDetails=0;
for(const source of available){
  const mints=new Set();
  await readHistoryLines(source,'events.jsonl',x=>{
    if(x.type!=='DETAIL_STARTED'||x.startedAt>=cutoff||!Number.isFinite(x.startedAt))return;
    const id=`${x.mint}:${x.startedAt}:${x.worker}`;
    if(!universe.has(id))universe.set(id,{id,mint:x.mint,start:x.startedAt,source:source.id});
    if(x.startedAt>=start)mints.add(x.mint);
  });
  if(!mints.size)continue;
  const data=await loadHistorySource(source,{onlyMints:mints,cutoff}),sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
  for(const s of data.sessions.filter(s=>s.start>=start)){
    freshDetails++;const p=prepareAdaptiveSession(data,s,sol);
    for(const signal of p.signals.filter(r=>r.lane==='AGY_NATIVE')){
      const c={signal,prepared:{ticks:p.ticks,frames:p.frames,end:p.end}};cases.push(c);byId.set(signal.id,c);
    }
  }
}
const parts=[['train',-Infinity,trainEnd],['audit',trainEnd,historicalEnd],['fresh',start,cutoff]],results={};
function paired(a,b){
  assert.equal(a.length,b.length);const pairs=a.map((r,i)=>{assert.equal(r.id,b[i].id);return[r,b[i]];});
  const known=pairs.filter(([x,y])=>x.pnl!==null&&y.pnl!==null);
  return {opportunities:pairs.length,bothKnown:known.length,candidateUnknown:a.filter(r=>r.pnl===null).length,
    baselineUnknown:b.filter(r=>r.pnl===null).length,knownOnlyDifference:round(known.reduce((s,[x,y])=>s+x.pnl-y.pnl,0)),
    boundDifference:round(pairs.reduce((s,[x,y])=>s+x.bound-y.bound,0)),
    warning:'Different timing/exposure permitted; not a same-buy comparison. Difference of unknown bounds is not a rigorous improvement bound.'};
}
for(const[name,lo,hi]of parts){
  const rs=cohort(lo,hi);results[name]=Object.fromEntries([...controls,selected].map(c=>[c.id,evaluate(c,rs,hi,true)]));
  for(const[s]of scenarios)results[name][selected.id][s].paired=Object.fromEntries(controls.map(c=>[c.id,
    paired(results[name][selected.id][s].rows,results[name][c.id][s].rows)]));
}
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Code changed during replay ${p}`);
const fresh=results.fresh[selected.id].base.summary;
const status=trainingPassed?'REQUIRES_INDEPENDENT_FORWARD_VALIDATION':'TRAINING_REJECTED';
const report={generatedAt:new Date().toISOString(),fingerprint,hashes,protocol,selected,trainingPassed,status,liveAllowed:false,
  trainEnd,historicalEnd,start,cutoff,datasetHash:hash(cachePath),counts:{storedSignals:stored.length,missing:missing.length,matchedHistorical:cases.filter(c=>c.signal.at<historicalEnd).length,
    freshDetails,freshSignals:cases.filter(c=>c.signal.at>=start).length,freshCohort:fresh.opportunities},missing,parity,
  testedHypotheses:17,loopA,loopB,results,caveats:['Historical TRAIN/AUDIT were already explored; not untouched holdouts.',
    'All candidates share opportunity universe and cost model, but timing/abstention changes exposure.',
    'Source-missing opportunities excluded from every lane; this is matched available capture, not full original history.',
    'Data duration and transaction evidence remain incomplete; these are hypothetical socket fills.',
    'SOL/USD valuation for delayed entry remains frozen at initial opportunity time (maximum 12-second decision delay).',
    'Fresh short window cannot validate a seven-day trading strategy; no live promotion.']};
writeFileSync(`reports/${prefix}-results.json`,JSON.stringify(report));
const small={...report,results:Object.fromEntries(Object.entries(results).map(([part,lanes])=>[part,
  Object.fromEntries(Object.entries(lanes).map(([lane,ss])=>[lane,Object.fromEntries(Object.entries(ss).map(([s,r])=>[s,{...r,rows:undefined}]))]))]))};
writeFileSync(`reports/${prefix}-summary.json`,JSON.stringify(small,null,2));
console.log(JSON.stringify({status,selected,counts:report.counts,results:Object.fromEntries(Object.entries(results).map(([part,lanes])=>
  [part,Object.fromEntries(Object.entries(lanes).map(([lane,ss])=>[lane,ss.base.summary]))]))}));
