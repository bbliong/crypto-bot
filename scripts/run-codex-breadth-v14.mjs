import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareFlowWaveSession} from './codex-flow-wave-engine.mjs';
import {breadthEventsV14,attachBreadthV14,evaluateBreadthV14,BREADTH_CONFIGS} from './codex-breadth-router-v14.mjs';
import {cachedOpportunityStudy,studyHash,rankCachedCandidates,evaluateCachedCandidate,compactStudy,studyTrainingPassed} from './codex-cached-opportunity-study.mjs';
const protocol='docs/CODEX_BREADTH_ROUTER_V14_PROTOCOL.md',output='reports/codex-breadth-v14-results.json';
assert.ok(!existsSync(output),'Preserve original breadth study');
const {parent,cases}=cachedOpportunityStudy(),start=Date.parse('2026-09-30T17:00Z'),cutoff=parent.historicalEnd;
const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-breadth-router-v14.mjs','scripts/run-codex-breadth-v14.mjs',
  'scripts/codex-peak-recheck-v10.mjs','scripts/codex-prebuy-recheck-v9.mjs','scripts/codex-cached-opportunity-study.mjs'].map(p=>[p,studyHash(p)]))};
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
const sources=[];
for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){let details=0;
  await readHistoryLines(source,'events.jsonl',x=>{if(x.type==='DETAIL_STARTED'&&x.startedAt>=start&&x.startedAt<cutoff)details++;});
  if(details)sources.push({source,details});
}
mkdirSync('reports/codex-breadth-v14-context',{recursive:true});
const events=[],inventory=[],contextFiles=[];
for(const{source,details}of sources){
  const path=`reports/codex-breadth-v14-context/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  if(process.argv.includes('--cached')&&existsSync(path)){
    const saved=JSON.parse(readFileSync(path));assert.equal(saved.fingerprint,fingerprint);
    events.push(...saved.events);inventory.push(saved.inventory);contextFiles.push({path,sha256:studyHash(path)});continue;
  }
  assert.ok(!existsSync(path),'Use --cached to retain earlier context inputs');
  const data=await loadHistorySource(source,{cutoff}),out=[];let loaded=0,withTicks=0;
  for(const s of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
    loaded++;const p=prepareFlowWaveSession(data,s,[],{entries:[]});if(p.ticks.length)withTicks++;
    out.push(...breadthEventsV14(s,p));
  }
  const item={source:source.id,metadataDetails:details,details:loaded,withTicks,events:out.length};
  writeFileSync(path,JSON.stringify({fingerprint,inventory:item,events:out}),{flag:'wx'});
  events.push(...out);inventory.push(item);contextFiles.push({path,sha256:studyHash(path)});
  console.log(JSON.stringify({stage:'context',progress:`${inventory.length}/${sources.length}`,...item}));
}
const contextualCases=attachBreadthV14(cases,events);
const ranking=rankCachedCandidates(BREADTH_CONFIGS,contextualCases,parent.results.train.AGY_NATIVE.base.rows,evaluateBreadthV14,parent.trainEnd);
const primary=ranking.find(r=>r.results.base.summary.signals>0)??null,selected=primary?.config??null;
const trainingPassed=studyTrainingPassed(primary,parent.results.train);
const selection={generatedAt:new Date().toISOString(),fingerprint,hashes,protocol,selected,trainingPassed,liveAllowed:false,
  status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':selected?'TRAINING_REJECTED':'NO_ACTIVE_CANDIDATE',
  cumulativeHypotheses:63,selectionBeforeAuditAggregation:true,forwardStart:Math.max(Date.parse('2026-10-04T07:30Z'),Date.now()),
  ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
writeFileSync('reports/codex-breadth-v14-selection.json',JSON.stringify(selection,null,2),{flag:'wx'});
const audit=selected?evaluateCachedCandidate(contextualCases,parent.results.audit.AGY_NATIVE.base.rows,selected,evaluateBreadthV14,cutoff):null;
for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Changed frozen source ${p}`);
const report={...selection,trainEnd:parent.trainEnd,auditEnd:cutoff,contextFiles,inventory,
  counts:{details:inventory.reduce((s,r)=>s+r.details,0),events:events.length},
  snapshots:[...contextualCases.values()].map(c=>({id:c.signal.id,at:c.signal.at,breadth:c.signal.breadth})),
  results:{train:primary?.results??null,audit},controls:{train:parent.results.train,audit:parent.results.audit},
  caveats:['Context reflects selected monitored tokens, not whole-market breadth.',
    'Different timing/abstention; no same-buy claim against AGY.',
    'Snapshots exclude target mint and only receive strictly earlier events.',
    'Historical audit previously explored; needs untouched future interval.',
    'Unknown blocks portfolio; research only, no live writes.']};
writeFileSync(output,JSON.stringify(report),{flag:'wx'});
writeFileSync('reports/codex-breadth-v14-summary.json',JSON.stringify({...report,snapshots:undefined,
  results:Object.fromEntries(Object.entries(report.results).map(([p,r])=>[p,r?compactStudy(r):null])),
  controls:Object.fromEntries(Object.entries(report.controls).map(([p,ls])=>[p,Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE'].map(l=>[l,compactStudy(ls[l])]))]))},null,2),{flag:'wx'});
console.log(JSON.stringify({status:report.status,selected,counts:report.counts,ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,
  score:r.score,base:r.results.base.summary})),audit:audit?.base.summary}));
