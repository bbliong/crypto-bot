// Scoped offline worker. No browser, network, wallet, cron, or live service calls.
import {readFileSync,writeFileSync,appendFileSync,existsSync,mkdirSync,readdirSync,statSync,statfsSync,unlinkSync,renameSync,createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession} from './codex-adaptive-engine.mjs';
import {normalizedEventsV16} from './codex-normalized-breadth-v16.mjs';
import {evaluateForwardResearch} from './codex-forward-research-engine.mjs';
import {studyHash,compactStudy} from './codex-cached-opportunity-study.mjs';
const root='reports/codex-online-forward-v17',journalPath=`${root}/sessions.jsonl`,manifestPath=`${root}/manifest.json`,
  statusPath=`${root}/latest-status.json`,lockPath=`${root}/worker.lock`,intervalMs=1800000,runId=randomUUID();
mkdirSync(`${root}/cases`,{recursive:true});mkdirSync(`${root}/decisions`,{recursive:true});mkdirSync(`${root}/snapshots`,{recursive:true});
const budget=512*1024**2;
function directoryBytes(path){let n=0;for(const e of readdirSync(path,{withFileTypes:true})){
  const p=`${path}/${e.name}`;n+=e.isDirectory()?directoryBytes(p):statSync(p).size;
}return n;}
let artifactBytes=directoryBytes(root),stopping=false,lastStatus={};
function resourceCheck(extra=0){
  const disk=statfsSync(root);assert.ok(disk.bavail*disk.bsize>=2*1024**3,'DISK_FREE_LIMIT');
  assert.ok(artifactBytes+extra<=budget,'ARTIFACT_BUDGET_LIMIT');
}
function writeOwned(path,value,{exclusive=false}={}){
  const body=JSON.stringify(value),size=Buffer.byteLength(body),old=existsSync(path)?statSync(path).size:0;
  resourceCheck(Math.max(0,size-old));writeFileSync(path,body,{flag:exclusive?'wx':'w',mode:0o600});artifactBytes+=size-old;
}
if(existsSync(lockPath)){
  const old=JSON.parse(readFileSync(lockPath));let running=true;
  try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')running=false;else throw e;}
  assert.ok(!running,`Worker already running at PID ${old.pid}`);
  renameSync(lockPath,`${lockPath}.stale-${Date.now()}`);
}
writeOwned(lockPath,{pid:process.pid,runId,startedAt:new Date().toISOString()},{exclusive:true});
const updateStatus=(status,extra={})=>{lastStatus={...lastStatus,status,active:!stopping,pid:process.pid,runId,
  updatedAt:new Date().toISOString(),artifactBytes,liveAllowed:false,...extra};writeOwned(statusPath,lastStatus);};
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;});
let manifest;
try{
  if(existsSync(manifestPath))manifest=JSON.parse(readFileSync(manifestPath));
  else{
    const paths={peak:'reports/codex-peak-v10-selection.json',normalized:'reports/codex-normalized-breadth-v16-selection.json',
      value:'reports/codex-action-value-v15-forward-lock.json'};
    const registry=Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,JSON.parse(readFileSync(p))]));
    assert.ok(registry.peak.selected&&registry.normalized.selected&&registry.value.selected,'Need active historical diagnostic candidates');
    const files=['docs/CODEX_ONLINE_FORWARD_V17_PROTOCOL.md','scripts/codex-online-value-v17.mjs','scripts/codex-forward-research-engine.mjs',
      'scripts/run-codex-online-forward-v17.mjs','scripts/codex-cost-tempo-v12.mjs','scripts/codex-engineering-v5.mjs',
      'scripts/codex-action-value-v15.mjs','scripts/codex-normalized-breadth-v16.mjs',
      'src/research-collector.ts','config/autobuy-settings.json','reports/codex-action-value-v15-results.json',...Object.values(paths)];
    const hashes={};for(const r of Object.values(registry))Object.assign(hashes,r.hashes);
    for(const p of files)hashes[p]=studyHash(p);
    const freezeAt=Date.now(),start=Math.ceil(Math.max(Date.parse('2026-10-04T08:00Z'),freezeAt)/intervalMs)*intervalMs;
    const historical=JSON.parse(readFileSync('reports/codex-cost-tempo-v12-results.json'));
    const labels=JSON.parse(readFileSync('reports/codex-action-value-v15-results.json')).labels;
    writeOwned(`${root}/initial-universe.json`,historical.universe,{exclusive:true});
    writeOwned(`${root}/seed-labels.json`,labels,{exclusive:true});
    hashes[`${root}/initial-universe.json`]=studyHash(`${root}/initial-universe.json`);hashes[`${root}/seed-labels.json`]=studyHash(`${root}/seed-labels.json`);
    manifest={version:17,generatedAt:new Date(freezeAt).toISOString(),freezeAt,start,endAt:start+7*86400000,intervalMs,
      firstCutoff:start+intervalMs,registry,hashes,artifactBudgetBytes:budget,liveAllowed:false,cumulativeHypotheses:72,
      learning:'Seven-day past available labels only; fixed config; independent shadow outcomes, not actual receipts.'};
    writeOwned(manifestPath,manifest,{exclusive:true});
  }
  const verify=()=>{for(const[p,h]of Object.entries(manifest.hashes))assert.equal(studyHash(p),h,`SOURCE_CHANGED ${p}`);};verify();
  const universe=new Map(JSON.parse(readFileSync(`${root}/initial-universe.json`)).map(s=>[s.id,s]));
  const seedLabels=JSON.parse(readFileSync(`${root}/seed-labels.json`)),processed=new Set(),cases=new Map(),contextEvents=[];
  const accept=envelope=>{
    assert.ok(!processed.has(envelope.session.id),'Duplicate journal session');processed.add(envelope.session.id);
    universe.set(envelope.session.id,envelope.session);contextEvents.push(...envelope.events);
    if(envelope.caseFile){assert.equal(studyHash(envelope.caseFile.path),envelope.caseFile.sha256,'Saved case changed');
      const c=JSON.parse(readFileSync(envelope.caseFile.path));cases.set(c.signal.id,c);}
  };
  if(existsSync(journalPath))for await(const line of createInterface({input:createReadStream(journalPath),crlfDelay:Infinity})){
    if(line.trim())accept(JSON.parse(line));
  }
  const decisionPaths=new Map(readdirSync(`${root}/decisions`).filter(x=>x.endsWith('.json')).map(x=>{
    const p=`${root}/decisions/${x}`,d=JSON.parse(readFileSync(p));return[d.id,{path:p,decision:d.decision}];
  }));
  let lastCutoff=existsSync(statusPath)?(JSON.parse(readFileSync(statusPath)).lastCutoff??null):null;
  updateStatus('RUNNING_WAITING_WINDOW',{start:manifest.start,endAt:manifest.endAt,nextCutoff:lastCutoff?lastCutoff+intervalMs:manifest.firstCutoff,
    lastCutoff,processedSessions:processed.size,savedNativeCases:cases.size,formulasFound:[]});
  const follow=process.argv.includes('--follow');
  do{
    verify();resourceCheck();
    const cutoff=Math.min(Math.floor(Date.now()/intervalMs)*intervalMs,manifest.endAt);
    if(cutoff>=manifest.firstCutoff&&cutoff>(lastCutoff??-Infinity)){
      updateStatus('READING_COMPLETED_WINDOW',{evaluatingCutoff:cutoff});
      let newSessions=0;const inventory=[],warmStart=manifest.start-900000-180000;
      for(const source of historySources().filter(s=>!s.archive||existsSync(s.archive))){
        if(stopping)break;const mints=new Set(),wanted=new Set();
        await readHistoryLines(source,'events.jsonl',x=>{
          if(x.type!=='DETAIL_STARTED'||!Number.isFinite(x.startedAt)||x.startedAt>=cutoff)return;
          const id=`${x.mint}:${x.startedAt}:${x.worker}`;
          if(!universe.has(id))universe.set(id,{id,mint:x.mint,start:x.startedAt,source:source.id});
          if(x.startedAt>=warmStart&&x.startedAt<=cutoff-180000&&!processed.has(id)){wanted.add(id);mints.add(x.mint);}
        });
        if(!mints.size)continue;
        const data=await loadHistorySource(source,{onlyMints:mints,cutoff}),sol=Object.values(data.tokens).flatMap(t=>t.sol).sort((a,b)=>a.at-b.at);
        let loaded=0,withTicks=0;
        for(const s of data.sessions.filter(s=>wanted.has(s.id))){
          const p=prepareAdaptiveSession(data,s,sol),native=p.signals.find(r=>r.lane==='AGY_NATIVE'),events=normalizedEventsV16(s,p);
          loaded++;if(p.ticks.length)withTicks++;
          const session={id:s.id,mint:s.mint,start:s.start,end:s.end,endInferred:!!s.endInferred,source:s.source};
          let caseFile=null;
          if(native){
            const casePath=`${root}/cases/${createHash('sha256').update(s.id).digest('hex')}.json`;
            if(!existsSync(casePath))writeOwned(casePath,{signal:native,prepared:{ticks:p.ticks,frames:p.frames,end:p.end}},{exclusive:true});
            caseFile={path:casePath,sha256:studyHash(casePath)};
          }
          const envelope={session,events,caseFile,firstProcessedAt:new Date().toISOString()},line=JSON.stringify(envelope)+'\n';
          resourceCheck(Buffer.byteLength(line));appendFileSync(journalPath,line,{mode:0o600});artifactBytes+=Buffer.byteLength(line);
          accept(envelope);newSessions++;
        }
        inventory.push({source:source.id,wanted:wanted.size,loaded,withTicks,missing:wanted.size-loaded});
      }
      if(stopping)break;
      verify();const result=evaluateForwardResearch({cases,universe:[...universe.values()],contextEvents,registry:manifest.registry,
        start:manifest.start,cutoff,seedLabels});
      for(const[id,d]of Object.entries(result.decisions)){
        const old=decisionPaths.get(id);
        if(old)assert.deepEqual(d,old.decision,`PREFIX_DECISION_CHANGED ${id}`);
        else{
          const path=`${root}/decisions/${createHash('sha256').update(id).digest('hex')}.json`;
          writeOwned(path,{id,decision:d,firstRecordedCutoff:cutoff},{exclusive:true});decisionPaths.set(id,{path,decision:d});
        }
      }
      const signature=createHash('sha256').update(JSON.stringify({cohort:result.cohortIds,results:result.results})).digest('hex');
      const ledger=`${root}/ledger-${signature}.json`;
      if(!existsSync(ledger))writeOwned(ledger,{...result,manifestHash:studyHash(manifestPath),caseInputs:[...cases].map(([id,c])=>({id,sessionId:c.signal.sessionId}))},{exclusive:true});
      const summaries=Object.fromEntries(Object.entries(result.results).map(([policy,r])=>[policy,compactStudy(r)]));
      writeOwned(`${root}/snapshots/${new Date(cutoff).toISOString().replace(/[-:.]/g,'')}.json`,{
        generatedAt:new Date().toISOString(),start:manifest.start,cutoff,status:result.status,liveAllowed:false,results:summaries,
        ledger,signature,inventory,newSessions,processedSessions:processed.size,caseCount:cases.size,contextEvents:contextEvents.length,
        promising:result.promising,counts:{eligibleOpportunities:result.cohortIds.length},
        caveats:['Cumulative overlapping snapshots; do not add PnL across snapshots.',
          'Fresh replay, not actual orders/quote receipts.', 'Missing/inferred capture remains censored; no portfolio reset.']},{exclusive:true});
      lastCutoff=cutoff;
      updateStatus(result.promising.length?'PROMISING_FORWARD_REPLAY':'RUNNING_WAITING_WINDOW',{
        lastCutoff,nextCutoff:cutoff+intervalMs,processedSessions:processed.size,savedNativeCases:cases.size,
        eligibleOpportunities:result.cohortIds.length,latestResults:summaries,latestLedger:ledger,formulasFound:result.promising});
      console.log(JSON.stringify({cutoff:new Date(cutoff).toISOString(),status:result.status,eligibleOpportunities:result.cohortIds.length,
        results:Object.fromEntries(Object.entries(result.results).map(([p,r])=>[p,r.base.summary]))}));
      if(result.promising.length)break;
    }
    if(Date.now()>=manifest.endAt){stopping=true;updateStatus('TIME_LIMIT_NO_VALIDATED_FORMULA',{finishedAt:new Date().toISOString()});break;}
    if(!follow)break;
    await new Promise(resolve=>setTimeout(resolve,45000));
    updateStatus(lastStatus.status,{heartbeatAt:new Date().toISOString()});
  }while(!stopping);
  stopping=true;
  updateStatus(lastStatus.status==='PROMISING_FORWARD_REPLAY'?lastStatus.status:
    lastStatus.status==='TIME_LIMIT_NO_VALIDATED_FORMULA'?lastStatus.status:follow?'STOPPED_BY_SIGNAL':'ONCE_COMPLETE',
    {active:false,finishedAt:new Date().toISOString()});
}catch(error){
  stopping=true;try{updateStatus('STOPPED_ERROR',{active:false,error:String(error.stack??error),finishedAt:new Date().toISOString()});}catch{}
  console.error(error);process.exitCode=1;
}finally{
  if(existsSync(lockPath)&&JSON.parse(readFileSync(lockPath)).runId===runId)unlinkSync(lockPath);
}
