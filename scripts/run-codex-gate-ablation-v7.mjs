import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {evaluateV5} from './codex-engineering-v5.mjs';
import {historySources,loadHistorySource,readHistoryLines} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {commonCohort,exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const protocol='docs/CODEX_GATE_ABLATION_V7_PROTOCOL.md',hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const parent=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));
const data=JSON.parse(readFileSync('reports/codex-engineering-v5-dataset.json'));
assert.equal(hash('reports/codex-engineering-v5-dataset.json'),parent.datasetHash);
for(const[p,h]of Object.entries(parent.hashes))assert.equal(hash(p),h,`Dependency changed ${p}`);
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/run-codex-gate-ablation-v7.mjs'].map(p=>[p,hash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)).digest('hex');
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
const prior=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
const universe=new Map(prior.universe.map(s=>[s.id,s])),cases=new Map(data.cases.map(c=>[c.signal.id,c]));
function rowsFor(rs,config,delayMs,feeSide,end){return rs.map(r=>{
  let o=config.control?replayAdaptiveTrade({...r,lane:config.control},cases.get(r.id).prepared,{delayMs,feeSide}):
    evaluateV5(r,cases.get(r.id).prepared,config,{delayMs,feeSide});
  if(o.at!==null&&o.at>=end&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
  return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:o.decisionAt??r.at,day:wibDay(o.decisionAt??r.at),
    captureEnd:Math.min(r.captureEnd,end),solUsd:r.solUsd,solAssumed:r.solAssumed,...o,
    bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
});}
function evaluate(rs,config,end){return Object.fromEntries(scenarios.map(([name,delayMs,feeSide])=>{
  const rows=rowsFor(rs,config,delayMs,feeSide,end),active=rows.filter(r=>r.status!=='SKIP'),p=simulateOnePosition(active,5);
  return[name,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},
    portfolio:{...p,selectedIds:undefined},rows}];
}));}
const historical=data.cases.map(c=>c.signal),train=commonCohort(historical,[...universe.values()],-Infinity,parent.trainEnd);
const ranking=['NATIVE','GUARD'].flatMap(exitMode=>['AGE300','SIGMA_MAX3'].map(gate=>{
  const config={id:`DIRECT_${exitMode}_${gate}`,entryMode:'DIRECT',exitMode,gate},results=evaluate(train,config,parent.trainEnd),s=results.base.summary;
  return {config,results,enough:s.closed>=10&&s.days>=3,score:Math.min(...Object.values(results).map(x=>x.summary.conservativePnl))};
})).sort((a,b)=>Number(b.enough)-Number(a.enough)||b.score-a.score||b.results.base.summary.closed-a.results.base.summary.closed);
assert.ok(ranking[0].results.base.summary.closed>0,'No active training candidate');
const selected=ranking[0].config;
const controls=[{id:'AGY_NATIVE',control:'AGY_NATIVE'},{id:'AGY_REFERENCE',control:'AGY_REFERENCE'}];
const trainingPassed=ranking[0].results.base.summary.closed>=30&&ranking[0].results.base.summary.days>=3&&
  scenarios.every(([s])=>{const c=ranking[0].results[s].summary;return c.conservativePnl>0&&c.unknown===0&&
    controls.every(b=>{const v=parent.results.train[b.id][s].summary;return c.conservativePnl>v.conservativePnl&&
      c.eventBoundDrawdown<=v.eventBoundDrawdown&&c.tailLoss10<=v.tailLoss10;});});
const compact=r=>Object.fromEntries(Object.entries(r).map(([s,x])=>[s,{...x,rows:undefined}]));
writeFileSync('reports/codex-gate-ablation-v7-selection.json',JSON.stringify({fingerprint,hashes,protocol,selected,trainingPassed,
  liveAllowed:false,selectedBeforeFreshRead:true,ranking:ranking.map(r=>({...r,results:compact(r.results)}))},null,2));
console.log(JSON.stringify({stage:'selected',selected,trainingPassed,ranking:ranking.map(r=>({id:r.config.id,score:r.score,enough:r.enough,base:r.results.base.summary}))}));
const freshStart=Date.parse('2026-10-04T04:00Z'),freshEnd=Date.parse('2026-10-04T06:00Z');
assert.ok(Date.now()>=freshEnd);
const freshRecords=[],inventory=[];
for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){
  const mints=new Set();
  await readHistoryLines(source,'events.jsonl',x=>{
    if(x.type!=='DETAIL_STARTED'||!Number.isFinite(x.startedAt)||x.startedAt>=freshEnd)return;
    const id=`${x.mint}:${x.startedAt}:${x.worker}`;
    if(!universe.has(id))universe.set(id,{id,mint:x.mint,start:x.startedAt,source:source.id});
    if(x.startedAt>=freshStart)mints.add(x.mint);
  });
  if(!mints.size)continue;
  const sourceData=await loadHistorySource(source,{onlyMints:mints,cutoff:freshEnd});
  const sol=Object.values(sourceData.tokens).flatMap(t=>t.sol).sort((a,b)=>a.at-b.at);let details=0;
  for(const s of sourceData.sessions.filter(s=>s.start>=freshStart&&s.start<freshEnd)){
    details++;const p=prepareAdaptiveSession(sourceData,s,sol);
    for(const signal of p.signals.filter(r=>r.lane==='AGY_NATIVE')){
      freshRecords.push(signal);cases.set(signal.id,{signal,prepared:{ticks:p.ticks,frames:p.frames,end:p.end}});
    }
  }inventory.push({source:source.id,details});
}
const audit=commonCohort(historical,[...universe.values()],parent.trainEnd,parent.historicalEnd);
const fresh=commonCohort([...historical,...freshRecords],[...universe.values()],freshStart,freshEnd),results={};
for(const[part,rs,end]of [['train',train,parent.trainEnd],['audit',audit,parent.historicalEnd],['fresh',fresh,freshEnd]])
  results[part]=Object.fromEntries([...controls,selected].map(c=>[c.id,evaluate(rs,c,end)]));
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Code changed while running: ${p}`);
const report={generatedAt:new Date().toISOString(),fingerprint,hashes,protocol,selected,trainingPassed,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':'TRAINING_REJECTED',liveAllowed:false,
  trainEnd:parent.trainEnd,auditEnd:parent.historicalEnd,freshStart,freshEnd,inventory,
  freshUniverse:[...universe.values()].filter(s=>s.start>=freshStart),freshRecords,
  counts:{freshDetails:inventory.reduce((s,i)=>s+i.details,0),freshSignals:freshRecords.length,freshCohort:fresh.length},
  ranking:ranking.map(r=>({...r,results:compact(r.results)})),results,testedThisLoop:4,cumulativeHypotheses:33,
  caveats:['Gate changes exposure; positive differences alone do not prove profitability.',
    'Historical train and audit previously viewed; fresh two-hour interval was read only after selection.',
    'Native variants preserve AGY buy and exit exactly when gate allows; ownership is a separate Codex wrapper.',
    'All fills hypothetical; short window and small samples do not establish live performance.']};
writeFileSync('reports/codex-gate-ablation-v7-results.json',JSON.stringify(report));
writeFileSync('reports/codex-gate-ablation-v7-summary.json',JSON.stringify({...report,freshUniverse:undefined,freshRecords:undefined,
  results:Object.fromEntries(Object.entries(results).map(([p,ls])=>[p,Object.fromEntries(Object.entries(ls).map(([l,x])=>[l,compact(x)]))]))},null,2));
console.log(JSON.stringify({selected,status:report.status,counts:report.counts,results:Object.fromEntries(Object.entries(results).map(([p,ls])=>
  [p,Object.fromEntries(Object.entries(ls).map(([l,x])=>[l,x.base.summary]))]))}));
