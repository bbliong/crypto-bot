import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {signalsV6,V6_ENTRIES} from './codex-independent-v6.mjs';
import {evaluateV5} from './codex-engineering-v5.mjs';
import {commonCohort,exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const protocol='docs/CODEX_ENGINEERING_LOOP_V6_PROTOCOL.md';
const start=Date.parse('2026-09-30T17:00Z'),trainEnd=Date.parse('2026-10-03T05:00Z'),cutoff=Date.parse('2026-10-04T03:00Z');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
for(const[p,h]of Object.entries(parent.hashes))assert.equal(hash(p),h,`Changed dependency ${p}`);
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-independent-v6.mjs','scripts/run-codex-independent-v6.mjs'].map(p=>[p,hash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
const prior=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
const universe=new Map(prior.universe.map(s=>[s.id,s])),available=historySources().filter(s=>!s.archive||existsSync(s.archive)),sources=[];
for(const source of available){let details=0;
  await readHistoryLines(source,'events.jsonl',x=>{if(x.type==='DETAIL_STARTED'&&x.startedAt>=start&&x.startedAt<cutoff)details++;});
  if(details)sources.push({source,details});
}
const lanes=['AGY_NATIVE','AGY_REFERENCE',...V6_ENTRIES.flatMap(e=>['NATIVE','HARVEST'].map(x=>`${e}_${x}`))];
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
const records=[],inventory=[];mkdirSync('reports/codex-independent-v6-runs',{recursive:true});
for(const{source,details}of sources){
  const path=`reports/codex-independent-v6-runs/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  if(process.argv.includes('--cached')&&existsSync(path)){
    const saved=JSON.parse(readFileSync(path));assert.equal(saved.fingerprint,fingerprint);
    records.push(...saved.records);inventory.push(saved.inventory);for(const s of saved.universe)universe.set(s.id,s);
    console.log(JSON.stringify({stage:'cached',source:source.id,records:saved.records.length}));continue;
  }
  const data=await loadHistorySource(source,{cutoff}),sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
  const out=[],sessions=[],cases=[];let withTicks=0,atLeast90s=0,inferred=0;
  for(const s of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    const u={id:s.id,mint:s.mint,start:s.start,end:s.end,source:s.source};sessions.push(u);universe.set(s.id,u);
    const p=prepareAdaptiveSession(data,s,sol),independent=signalsV6(s,p,sol),native=p.signals.filter(r=>r.lane.startsWith('AGY_'));
    if(p.ticks.length)withTicks++;if(s.end-s.start>=90000)atLeast90s++;if(s.endInferred)inferred++;
    for(const signal of native){
      out.push({...signal,outcomes:scenarios.map(([,delayMs,feeSide])=>replayAdaptiveTrade(signal,p,{delayMs,feeSide}))});
    }
    for(const signal of independent)for(const exitMode of ['NATIVE','HARVEST']){
      const lane=`${signal.lane}_${exitMode}`;
      out.push({...signal,id:`${signal.id}:${exitMode}`,lane,outcomes:scenarios.map(([,delayMs,feeSide])=>
        evaluateV5(signal,p,{entryMode:'DIRECT',exitMode,gate:'ALL'},{delayMs,feeSide}))});
    }
    if(native.length||independent.length)cases.push({session:s,signals:[...native,...independent],prepared:{ticks:p.ticks,frames:p.frames,end:p.end}});
  }
  const item={source:source.id,metadataDetails:details,loadedDetails:sessions.length,withTicks,atLeast90s,inferred,counts:data.counts,
    signals:Object.fromEntries(lanes.map(l=>[l,out.filter(r=>r.lane===l).length]))};
  inventory.push(item);records.push(...out);
  writeFileSync(path,JSON.stringify({fingerprint,inventory:item,universe:sessions,records:out,cases}));
  console.log(JSON.stringify({stage:'replay',progress:`${inventory.length}/${sources.length}`,source:source.id,...item,counts:undefined}));
}
function evaluate(lane,lo,hi){
  const rs=commonCohort(records.filter(r=>r.lane===lane),[...universe.values()],lo,hi);
  return Object.fromEntries(scenarios.map(([name,delayMs,feeSide])=>{
    const rows=rs.map(r=>{
      let o=r.outcomes.find(o=>o.delayMs===delayMs&&o.feeSide===feeSide);
      if(o.at!==null&&o.at>=hi)o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:r.at,day:wibDay(r.at),captureEnd:Math.min(r.captureEnd,hi),
        solUsd:r.solUsd,solAssumed:r.solAssumed,...o,bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });
    const portfolio=simulateOnePosition(rows,5);
    return[name,{summary:exitStats(rows),portfolio:{...portfolio,selectedIds:undefined},rows}];
  }));
}
const train=Object.fromEntries(lanes.map(l=>[l,evaluate(l,start,trainEnd)]));
const ranking=lanes.filter(l=>!l.startsWith('AGY')).map(lane=>({lane,enough:train[lane].base.summary.closed>=30&&train[lane].base.summary.days>=3,
  score:Math.min(...Object.values(train[lane]).map(s=>s.summary.conservativePnl)),summary:train[lane].base.summary}))
  .sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.summary.closed-a.summary.closed);
const selected=ranking[0].lane;
const trainingPassed=ranking[0].enough&&scenarios.every(([s])=>{const c=train[selected][s].summary;
  return c.conservativePnl>0&&c.unknown===0&&['AGY_NATIVE','AGY_REFERENCE'].every(l=>{
    const b=train[l][s].summary;return c.conservativePnl>b.conservativePnl&&c.eventBoundDrawdown<=b.eventBoundDrawdown&&c.tailLoss10<=b.tailLoss10;});});
writeFileSync('reports/codex-independent-v6-selection.json',JSON.stringify({fingerprint,hashes,protocol,selected,trainingPassed,ranking,liveAllowed:false,
  selectionBeforeAuditAggregation:true,unseenStart:'2026-10-04T03:40:00Z'},null,2));
const audit=Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE',selected].map(l=>[l,evaluate(l,trainEnd,cutoff)]));
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Code changed while running ${p}`);
const report={generatedAt:new Date().toISOString(),fingerprint,hashes,protocol,start,trainEnd,cutoff,selected,trainingPassed,liveAllowed:false,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',ranking,inventory,universe:[...universe.values()],records,
  counts:{details:inventory.reduce((s,i)=>s+i.loadedDetails,0),withTicks:inventory.reduce((s,i)=>s+i.withTicks,0),
    atLeast90s:inventory.reduce((s,i)=>s+i.atLeast90s,0),inferred:inventory.reduce((s,i)=>s+i.inferred,0)},
  results:{train,audit},caveats:['Signal universes differ; no paired same-entry claim.',
    'All historical dates here were previously studied. Forward validation remains outstanding.',
    'Only available raw captures; cleaned sources are not silently reconstructed. Prior universe retained for mint purge.',
    'Stored per-source cases enable research reproduction but are not byte-exact raw archives.',
    'Independent event PnL differs from one-position portfolio; unresolved blocks that portfolio.']};
writeFileSync('reports/codex-independent-v6-results.json',JSON.stringify(report));
const small={...report,universe:undefined,records:undefined,results:Object.fromEntries(Object.entries(report.results).map(([part,ls])=>[part,
  Object.fromEntries(Object.entries(ls).map(([lane,ss])=>[lane,Object.fromEntries(Object.entries(ss).map(([s,r])=>[s,{...r,rows:undefined}]))]))]))};
writeFileSync('reports/codex-independent-v6-summary.json',JSON.stringify(small,null,2));
console.log(JSON.stringify({selected,trainingPassed,status:report.status,counts:report.counts,ranking,
  audit:Object.fromEntries(Object.entries(audit).map(([l,r])=>[l,r.base.summary]))}));
