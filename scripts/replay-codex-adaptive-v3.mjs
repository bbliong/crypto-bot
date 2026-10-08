// Offline head-to-head, no execution endpoints. Protocol is frozen before inspecting new-period results.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {historySources,loadHistorySource} from './codex-history-source.mjs';
import {prepareAdaptiveSession,replayAdaptiveTrade} from './codex-adaptive-engine.mjs';
const cutoff=Date.parse('2026-10-03T12:00:00Z'),split=Date.parse('2026-10-03T05:00:00Z');
const wanted=process.argv.find(a=>a.startsWith('--source='))?.slice(9);
const hashes=Object.fromEntries(['src/codex-adaptive-wave-v3.ts','scripts/codex-adaptive-engine.mjs','scripts/codex-history-source.mjs',
  'scripts/codex-flow-wave-engine.mjs','src/momentum-strategy.ts','src/adaptive-wave.ts','docs/CODEX_ADAPTIVE_V3_PROTOCOL.md']
  .map(p=>[p,createHash('sha256').update(readFileSync(p)).digest('hex')]));
const fingerprint=createHash('sha256').update(JSON.stringify(hashes)+cutoff).digest('hex');
mkdirSync('reports/codex-adaptive-v3-runs',{recursive:true});
const records=[],universe=[],sources=historySources().filter(s=>!wanted||s.id.includes(wanted));
let index=0;
for(const source of sources){
  const path=`reports/codex-adaptive-v3-runs/${source.id.replace(/[^a-zA-Z0-9_-]/g,'_')}.json`;
  let result=process.argv.includes('--resume')&&existsSync(path)?JSON.parse(readFileSync(path)):null;
  if(result?.fingerprint!==fingerprint)result=null;
  if(!result){
    const data=await loadHistorySource(source,{cutoff}),sol=Object.values(data.tokens).flatMap(d=>d.sol).sort((a,b)=>a.at-b.at);
    const rows=[],sessions=[];
    for(const s of data.sessions){
      const p=prepareAdaptiveSession(data,s,sol);
      sessions.push({id:s.id,mint:s.mint,start:s.start,end:s.end,ticks:p.ticks.length,
        flash:p.frames.some(f=>(f.collapse1s??0)<=-8),rising:p.ticks.length>1?p.ticks.at(-1).priceUsd>p.ticks[0].priceUsd:null});
      for(const signal of p.signals)rows.push({...signal,outcomes:[{delayMs:1000,feeSide:.01},{delayMs:2000,feeSide:.01},{delayMs:1000,feeSide:.02}]
        .map(options=>replayAdaptiveTrade(signal,p,options))});
    }
    result={fingerprint,source:source.id,sessions,records:rows,counts:data.counts};
    writeFileSync(path,JSON.stringify(result));
  }
  records.push(...result.records);universe.push(...result.sessions);index++;
  if(result.records.length||index%20===0)console.log(JSON.stringify({progress:`${index}/${sources.length}`,source:source.id,
    details:result.sessions.length,signals:result.records.length,total:records.length}));
}
const uniqueRecords=[...new Map(records.map(r=>[r.id,r])).values()].sort((a,b)=>a.at-b.at);
const uniqueSessions=[...new Map(universe.map(s=>[s.id,s])).values()];
const output=wanted?'reports/codex-adaptive-v3-smoke.json':'reports/codex-adaptive-v3-replay.json';
writeFileSync(output,JSON.stringify({cutoff,split,hashes,fingerprint,stakeUsd:5,records:uniqueRecords,universe:uniqueSessions,
  caveats:['As-of shared data-quality adapter, not a full replica of collector scheduling/holder fallbacks/reentry.',
    'AGY_NATIVE is imported unchanged. AGY_REFERENCE tracks peak and uses modeled all-in net, without changing AGY files.',
    'All modeled fills share latency/slippage/fee assumptions; every result is hypothetical, not chain receipt.',
    'Resume cache assumes old capture files unchanged; run without --resume if source data was modified.']}));
console.log(JSON.stringify({output,details:uniqueSessions.length,signals:uniqueRecords.length}));
