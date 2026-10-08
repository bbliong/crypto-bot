// One read-only capture pass shared by future Codex research evaluations.
import {existsSync} from 'node:fs';
import {historySources,readHistoryLines,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession} from './codex-adaptive-engine.mjs';
export async function readOpportunityWindow({start,cutoff,priorUniverse}){
  if(!(Number.isFinite(start)&&Number.isFinite(cutoff)&&cutoff>start))throw new Error('Invalid capture window');
  const universe=new Map(priorUniverse.map(s=>[s.id,s])),cases=[],inventory=[];
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
      for(const signal of p.signals.filter(r=>r.lane==='AGY_NATIVE'))cases.push({signal,prepared:{ticks:p.ticks,frames:p.frames,end:p.end}});
    }inventory.push({source:source.id,details,withTicks});
  }
  return {universe:[...universe.values()],cases,inventory};
}
