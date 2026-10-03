import {historySources,readHistoryLines,HISTORY_CUTOFF} from './codex-history-source.mjs';
import {existsSync,writeFileSync} from 'node:fs';
const studies=[];
for(const source of historySources().filter(s=>s.dir&&existsSync(`${s.dir}/socket-ticks.jsonl`))){
  const r={source:source.id,sessions:0,sessionMints:new Set(),files:{},replayEligibility:'NO_FULL_HOLDER_AND_DEV_HISTORY'};
  for(const file of ['events.jsonl','trades.jsonl','socket-ticks.jsonl','flow-windows.jsonl','holder-counts.jsonl']){
    const mints=new Set(),fields=new Set();let rows=0,start=Infinity,end=-Infinity;
    await readHistoryLines(source,file,x=>{
      const at=x.observedAt??x.startedAt;if(!(at<HISTORY_CUTOFF))return;
      rows++;if(x.mint)mints.add(x.mint);for(const k of Object.keys(x))fields.add(k);start=Math.min(start,at);end=Math.max(end,at);
      if(file==='events.jsonl'&&x.type==='SESSION_STARTED'){r.sessions++;r.sessionMints.add(x.mint);}
    });
    r.files[file]={rows,mints:mints.size,start:Number.isFinite(start)?start:null,end:Number.isFinite(end)?end:null,fields:[...fields]};
  }
  r.sessionMints=r.sessionMints.size;studies.push(r);
}
const result={cutoff:new Date(HISTORY_CUTOFF).toISOString(),studies,
  counts:{studies:studies.length,sessions:studies.reduce((n,r)=>n+r.sessions,0),
    tradeRows:studies.reduce((n,r)=>n+r.files['trades.jsonl'].rows,0),socketPriceRows:studies.reduce((n,r)=>n+r.files['socket-ticks.jsonl'].rows,0),
    flowRows:studies.reduce((n,r)=>n+r.files['flow-windows.jsonl'].rows,0)},
  note:'Price/flow-only studies are distinct from full research detail captures. Missing full-holder/dev evidence is not converted to zero risk.'};
writeFileSync('reports/codex-tick-study-audit.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result.counts));
