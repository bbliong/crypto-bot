// All-history offline replay. Incremental per-source outputs keep raw logs out of conversational context.
import {readFileSync,writeFileSync,mkdirSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {historySources,loadHistorySource,HISTORY_CUTOFF} from './codex-history-source.mjs';
import {replayFlowWaveSession} from './codex-flow-wave-engine.mjs';
const wanted=process.argv.find(x=>x.startsWith('--source='))?.slice(9);
const sources=historySources().filter(s=>!wanted||s.id.includes(wanted));
const fingerprint=createHash('sha256').update(['src/codex-flow-wave-v2.ts','scripts/codex-flow-wave-engine.mjs','scripts/codex-history-source.mjs']
  .map(p=>readFileSync(p,'utf8')).join('\n')+HISTORY_CUTOFF).digest('hex');
mkdirSync('reports/codex-v2-runs',{recursive:true});
const all=[],inventory=[],seenSessions=new Set();let index=0;
for(const source of sources){
  const path=`reports/codex-v2-runs/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  let result;
  if(process.argv.includes('--resume')&&existsSync(path)){
    const prev=JSON.parse(readFileSync(path));
    if(prev.fingerprint===fingerprint)result=prev;
  }
  if(!result){
    const data=await loadHistorySource(source);
    const sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
    const records=[];
    for(const s of data.sessions){
      if(seenSessions.has(s.id))continue;
      seenSessions.add(s.id);
      records.push(...replayFlowWaveSession(data,s,sol));
    }
    result={source:source.id,fingerprint,cutoff:HISTORY_CUTOFF,counts:data.counts,excluded:data.excluded??null,
      sessions:data.sessions.map(({id,mint,start,end,endInferred,reason})=>({id,mint,start,end,endInferred,reason})),records};
    writeFileSync(path,JSON.stringify(result));
  }else for(const s of result.sessions)seenSessions.add(s.id);
  all.push(...result.records);
  inventory.push({source:result.source,counts:result.counts,details:result.sessions.length,candidates:result.records.length,excluded:result.excluded});
  index++;
  if(result.sessions.length||index%20===0)console.log(JSON.stringify({progress:`${index}/${sources.length}`,source:source.id,details:result.sessions.length,candidates:result.records.length,totalCandidates:all.length}));
}
const dedup=[...new Map(all.map(r=>[r.id,r])).values()].sort((a,b)=>a.at-b.at);
const report={generatedAt:new Date().toISOString(),cutoff:new Date(HISTORY_CUTOFF).toISOString(),fingerprint,
  counts:{sources:sources.length,detailSessions:seenSessions.size,signalRecords:dedup.length,signalMints:new Set(dedup.map(r=>r.mint)).size,
    rawTicksRead:inventory.reduce((n,x)=>n+x.counts.rawTicks,0),acceptedTicks:inventory.reduce((n,x)=>n+x.counts.acceptedTicks,0),
    signalsWithAssumedSol:dedup.filter(r=>r.solAssumed).length},inventory,records:dedup};
const out=wanted?'reports/codex-v2-smoke.json':'reports/codex-v2-all-history.json';
writeFileSync(out,JSON.stringify(report));console.log(JSON.stringify({output:out,...report.counts}));
