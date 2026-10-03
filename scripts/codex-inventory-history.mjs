import {createReadStream,readdirSync,statSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
const cutoff=Date.parse('2026-10-03T05:00:00Z');
const inventory=[],sessions=new Map();
for(const dir of readdirSync('research',{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>`research/${d.name}`).sort()){
  const files=readdirSync(dir,{withFileTypes:true}).filter(d=>d.isFile()).map(d=>({name:d.name,bytes:statSync(`${dir}/${d.name}`).size}));
  const row={dir,files,details:0,duplicateDetails:0,start:null,end:null,malformed:0,hasTrades:existsSync(`${dir}/trades.jsonl`),hasTickOnly:existsSync(`${dir}/socket-ticks.jsonl`)};
  if(existsSync(`${dir}/events.jsonl`))for await(const line of createInterface({input:createReadStream(`${dir}/events.jsonl`),crlfDelay:Infinity})){
    if(!line.trim())continue;let e;try{e=JSON.parse(line);}catch{row.malformed++;continue;}
    if(e.type!=='DETAIL_STARTED'||!(e.startedAt<cutoff))continue;
    const id=`${e.mint}:${e.startedAt}:${e.worker}`;
    if(sessions.has(id)){row.duplicateDetails++;continue;}
    sessions.set(id,{id,source:dir,mint:e.mint,start:e.startedAt,end:null,worker:e.worker});row.details++;
    row.start=Math.min(row.start??Infinity,e.startedAt);row.end=Math.max(row.end??0,e.startedAt);
  }
  if(existsSync(`${dir}/token-summary.jsonl`))for await(const line of createInterface({input:createReadStream(`${dir}/token-summary.jsonl`),crlfDelay:Infinity})){
    if(!line.trim())continue;let e;try{e=JSON.parse(line);}catch{row.malformed++;continue;}
    const s=sessions.get(`${e.mint}:${e.detailStartedAt??e.startedAt}:${e.worker}`);
    if(s){s.end=e.endedAt;s.reason=e.endedBecause;}
  }
  if(existsSync(`${dir}/research.sqlite`)){
    const db=new DatabaseSync(`${dir}/research.sqlite`,{readOnly:true});
    row.tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name);db.close();
  }
  inventory.push(row);
}
const ss=[...sessions.values()],days={};
for(const s of ss){const day=new Date(s.start+25200000).toISOString().slice(0,10);days[day]=(days[day]??0)+1;}
const result={cutoff:new Date(cutoff).toISOString(),directories:inventory.length,rawTradeDirectories:inventory.filter(x=>x.hasTrades).length,
  tickOnlyDirectories:inventory.filter(x=>x.hasTickOnly).length,details:ss.length,uniqueMints:new Set(ss.map(s=>s.mint)).size,days,
  sessionEndsMissing:ss.filter(s=>!s.end).length,inventory,sessions:ss};
mkdirSync('reports',{recursive:true});writeFileSync('reports/codex-history-inventory.json',JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,inventory:undefined,sessions:undefined}));
