// One bounded, offline evaluation of preselected candidates. No fitting or live execution.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,loadHistorySource,readHistoryLines} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
import {evaluateV5} from './codex-engineering-v5.mjs';
import {evaluateV5c} from './codex-entry-v5c.mjs';
import {signalsV6} from './codex-independent-v6.mjs';
import {commonCohort,exitStats,wibDay} from './codex-same-entry-analysis.mjs';
import {simulateOnePosition} from './codex-portfolio.mjs';
const start=Date.parse('2026-10-04T03:40:00Z'),cutoff=Date.parse('2026-10-04T04:00:00Z');
assert.ok(Date.now()>=cutoff,'The frozen evaluation cutoff has not happened yet');
const output='reports/codex-engineering-frozen-20261004T0340-0400.json';
assert.ok(!existsSync(output),'Evaluation already exists; preserve the original artifact');
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const selectionFiles=['reports/codex-engineering-v5b-selection.json','reports/codex-engineering-v5c-selection.json','reports/codex-independent-v6-selection.json'];
const [b,c,d]=selectionFiles.map(p=>JSON.parse(readFileSync(p)));
// v5b selection stores its hashes in the linked results report.
const bReport=JSON.parse(readFileSync('reports/codex-engineering-v5b-results.json'));assert.equal(bReport.fingerprint,b.fingerprint);
for(const manifest of [bReport,c,d])for(const[p,h]of Object.entries(manifest.hashes))assert.equal(hash(p),h,`Frozen code changed: ${p}`);
const protocol='docs/CODEX_ENGINEERING_FORWARD_PROTOCOL.md';
const hashes={...bReport.hashes,...c.hashes,...d.hashes,...Object.fromEntries([...selectionFiles,protocol,'scripts/evaluate-codex-engineering-frozen.mjs'].map(p=>[p,hash(p)]))};
const lanes=['AGY_NATIVE','AGY_REFERENCE','CODEX_V5B','CODEX_V5C','CODEX_V6'];
const scenarios=[['base',1000,.01],['delay2s',2000,.01],['feeStress',1000,.02]];
const prior=JSON.parse(readFileSync('reports/codex-same-entry-overnight-replay.json'));
const universe=new Map(prior.universe.map(s=>[s.id,s])),records=[],inventory=[];
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
  for(const s of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    details++;const p=prepareAdaptiveSession(data,s,sol);if(p.ticks.length)withTicks++;
    for(const r of p.signals.filter(r=>r.lane==='AGY_NATIVE'))for(const lane of lanes.filter(l=>l!=='CODEX_V6')){
      const outcomes=scenarios.map(([,delayMs,feeSide])=>{
        const opts={delayMs,feeSide};
        if(lane.startsWith('AGY'))return replayAdaptiveTrade({...r,lane},p,opts);
        return lane==='CODEX_V5B'?evaluateV5(r,p,b.selected,opts):evaluateV5c(r,p,c.selected,opts);
      });records.push({...r,id:`${r.id}:${lane}`,lane,outcomes});
    }
    const exitMode=d.selected.endsWith('_HARVEST')?'HARVEST':'NATIVE';
    const entry=d.selected.replace(/_(HARVEST|NATIVE)$/,'');
    for(const r of signalsV6(s,p,sol).filter(r=>r.lane===entry)){
      records.push({...r,id:`${r.id}:CODEX_V6`,lane:'CODEX_V6',outcomes:scenarios.map(([,delayMs,feeSide])=>
        evaluateV5(r,p,{entryMode:'DIRECT',exitMode,gate:'ALL'},{delayMs,feeSide}))});
    }
  }
  inventory.push({source:source.id,details,withTicks});
}
const results={};
for(const lane of lanes){
  const cohort=commonCohort(records.filter(r=>r.lane===lane),[...universe.values()],start,cutoff);
  results[lane]=Object.fromEntries(scenarios.map(([name,delayMs,feeSide])=>{
    const rows=cohort.map(r=>{let o=r.outcomes.find(o=>o.delayMs===delayMs&&o.feeSide===feeSide);
      if(o.at!==null&&o.at>=cutoff&&o.status!=='SKIP')o={...o,status:'PARTITION_UNKNOWN',pnl:null,ret:null,at:null};
      return {id:r.id,mint:r.mint,symbol:r.symbol,signalAt:o.decisionAt??r.at,day:wibDay(o.decisionAt??r.at),captureEnd:Math.min(r.captureEnd,cutoff),
        solUsd:r.solUsd,solAssumed:r.solAssumed,...o,bound:o.pnl??-(5+.000205*r.solUsd+(o.failedSell??0)*.000105*r.solUsd)};
    });
    const active=rows.filter(r=>r.status!=='SKIP'),portfolio=simulateOnePosition(active,5);
    return[name,{summary:{...exitStats(active),opportunities:rows.length,skips:rows.length-active.length},
      portfolio:{...portfolio,selectedIds:undefined},rows}];
  }));
}
for(const[p,h]of Object.entries(hashes))assert.equal(hash(p),h,`Code changed during evaluation: ${p}`);
const report={generatedAt:new Date().toISOString(),protocol,hashes,start,cutoff,liveAllowed:false,status:'NO_VALIDATED_OUTPERFORMANCE',
  selections:{v5b:{selected:b.selected,trainingPassed:b.trainingPassed},v5c:{selected:c.selected,trainingPassed:c.trainingPassed},
    v6:{selected:d.selected,trainingPassed:d.trainingPassed}},inventory,results,records,
  caveats:['Short, frozen additional replay; not seven-day live forward paper.',
    'Training rejection persists. No reselection or automatic promotion on these results.',
    'Different entries/exposure; unknown costs and receipt coverage remain incomplete.']};
writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
console.log(JSON.stringify({output,status:report.status,details:inventory.reduce((s,x)=>s+x.details,0),
  results:Object.fromEntries(Object.entries(results).map(([l,x])=>[l,x.base.summary]))}));
