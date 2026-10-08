// Versioned bounded research harness; all generated files are exclusive.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareFlowWaveSession} from './codex-flow-wave-engine.mjs';
import {attachBreadthV14} from './codex-breadth-router-v14.mjs';
import {cachedOpportunityStudy,studyHash,rankCachedCandidates,evaluateCachedCandidate,compactStudy,studyTrainingPassed} from './codex-cached-opportunity-study.mjs';
export async function runBreadthStudy({prefix,protocol,files,eventFactory,evaluator,configs,cumulativeHypotheses,forwardStart}){
  const output=`reports/${prefix}-results.json`;assert.ok(!existsSync(output),'Preserve prior study');
  const {parent,cases}=cachedOpportunityStudy(),cutoff=parent.historicalEnd,start=Date.parse('2026-09-30T17:00Z');
  const hashes={...parent.hashes,...Object.fromEntries([protocol,'scripts/codex-breadth-study-runner.mjs','scripts/codex-breadth-router-v14.mjs',
    'scripts/codex-peak-recheck-v10.mjs','scripts/codex-prebuy-recheck-v9.mjs','scripts/codex-cached-opportunity-study.mjs',...files].map(p=>[p,studyHash(p)]))};
  const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex'),sources=[];
  for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){let details=0;
    await readHistoryLines(source,'events.jsonl',x=>{if(x.type==='DETAIL_STARTED'&&x.startedAt>=start&&x.startedAt<cutoff)details++;});
    if(details)sources.push({source,details});
  }
  mkdirSync(`reports/${prefix}-context`,{recursive:true});
  const events=[],inventory=[],contextFiles=[];
  for(const{source,details}of sources){
    const path=`reports/${prefix}-context/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
    if(process.argv.includes('--cached')&&existsSync(path)){
      const s=JSON.parse(readFileSync(path));assert.equal(s.fingerprint,fingerprint);
      events.push(...s.events);inventory.push(s.inventory);contextFiles.push({path,sha256:studyHash(path)});continue;
    }
    assert.ok(!existsSync(path),'Use --cached to preserve saved inputs');
    const data=await loadHistorySource(source,{cutoff}),out=[];let loaded=0,withTicks=0;
    for(const session of data.sessions.filter(s=>s.start>=start&&s.start<cutoff)){
      loaded++;const p=prepareFlowWaveSession(data,session,[],{entries:[]});if(p.ticks.length)withTicks++;
      out.push(...eventFactory(session,p));
    }
    const item={source:source.id,metadataDetails:details,details:loaded,withTicks,events:out.length};
    writeFileSync(path,JSON.stringify({fingerprint,inventory:item,events:out}),{flag:'wx'});
    events.push(...out);inventory.push(item);contextFiles.push({path,sha256:studyHash(path)});
    console.log(JSON.stringify({stage:'context',progress:`${inventory.length}/${sources.length}`,...item}));
  }
  const contextual=attachBreadthV14(cases,events);
  const ranking=rankCachedCandidates(configs,contextual,parent.results.train.AGY_NATIVE.base.rows,evaluator,parent.trainEnd);
  const primary=ranking.find(r=>r.results.base.summary.signals>0)??null,selected=primary?.config??null;
  const trainingPassed=studyTrainingPassed(primary,parent.results.train);
  const selection={generatedAt:new Date().toISOString(),fingerprint,hashes,protocol,selected,trainingPassed,liveAllowed:false,
    status:trainingPassed?'REQUIRES_FORWARD_VALIDATION':selected?'TRAINING_REJECTED':'NO_ACTIVE_CANDIDATE',cumulativeHypotheses,
    selectionBeforeAuditAggregation:true,forwardStart:Math.max(forwardStart,Date.now()),ranking:ranking.map(r=>({...r,results:compactStudy(r.results)}))};
  writeFileSync(`reports/${prefix}-selection.json`,JSON.stringify(selection,null,2),{flag:'wx'});
  const audit=selected?evaluateCachedCandidate(contextual,parent.results.audit.AGY_NATIVE.base.rows,selected,evaluator,cutoff):null;
  for(const[p,h]of Object.entries(hashes))assert.equal(studyHash(p),h,`Changed source ${p}`);
  const report={...selection,trainEnd:parent.trainEnd,auditEnd:cutoff,contextFiles,inventory,
    counts:{details:inventory.reduce((s,r)=>s+r.details,0),events:events.length},snapshots:[...contextual.values()].map(c=>({id:c.signal.id,breadth:c.signal.breadth})),
    results:{train:primary?.results??null,audit},controls:{train:parent.results.train,audit:parent.results.audit},
    caveats:['Past observed cohort only, not a calibrated whole-market/rugpull probability.',
      'Historical windows already studied; no holdout claim.', 'Changing timing/abstention; unknown blocks portfolio. Research only.']};
  writeFileSync(output,JSON.stringify(report),{flag:'wx'});
  writeFileSync(`reports/${prefix}-summary.json`,JSON.stringify({...report,snapshots:undefined,
    results:Object.fromEntries(Object.entries(report.results).map(([p,r])=>[p,r?compactStudy(r):null])),
    controls:Object.fromEntries(Object.entries(report.controls).map(([p,ls])=>[p,Object.fromEntries(['AGY_NATIVE','AGY_REFERENCE'].map(l=>[l,compactStudy(ls[l])]))]))},null,2),{flag:'wx'});
  console.log(JSON.stringify({status:report.status,selected,counts:report.counts,ranking:ranking.map(r=>({id:r.config.id,enough:r.enough,score:r.score,base:r.results.base.summary})),audit:audit?.base.summary}));
}
