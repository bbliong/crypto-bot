// Bounded, read-only extraction of the historical input manifest.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const source=JSON.parse(fs.readFileSync(path.join(dir,'analysis.json')));
const initial=JSON.parse(fs.readFileSync(path.join(dir,'initial-run-analysis.json')));
const fresh=process.argv.includes('--fresh');
const oldCutoff=Date.parse(source.cutoff),cutoff=fresh?Date.now():oldCutoff;
const oldMints=new Set(initial.rows.map(r=>r.mint));
let inputFiles=source.inputFiles;
if(fresh){const oldSizes=new Map(source.inputFiles.map(f=>[f.path,f.bytes]));inputFiles=[];
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(['token-trades.jsonl','api-responses.jsonl','websocket-frames.jsonl'].includes(e.name)){const bytes=fs.statSync(p).size,start=oldSizes.get(p)||0;if(bytes>start)inputFiles.push({path:p,start,bytes});}}}
  walk('data/profit4-watch');inputFiles.sort((a,b)=>a.path.localeCompare(b.path));
}
const makeToken=row=>({mint:row.mint,symbol:row.symbol,firstAt:row.firstAt,originalEligible:row.price3xx,creator:null,bins:new Map(),holders:[],meta:[],seen:new Map()});
const tokens=new Map(fresh?[]:initial.rows.map(row=>[row.mint,makeToken(row)]));
const quality={parsed:{},duplicates:0,stale:0,invalid:0};
async function scan(name,patterns,fn){
  let count=0;
  for(const f of inputFiles.filter(f=>path.basename(f.path)===name&&f.bytes)){
    const stream=fs.createReadStream(f.path,{start:f.start||0,end:f.bytes-1});
    let input=stream,child,done;
    if(patterns){
      child=spawn('rg',['--text','--no-line-number','--no-heading','-F',...patterns.flatMap(p=>['-e',p])]);
      done=new Promise((resolve,reject)=>{let err='';child.stderr.on('data',x=>err+=x);child.on('error',reject);child.on('close',c=>c===0||c===1?resolve():reject(new Error(`rg ${c}: ${err}`)));});
      stream.on('error',e=>child.stdin.destroy(e));child.stdin.on('error',e=>{if(e.code!=='EPIPE')throw e;});
      stream.pipe(child.stdin);input=child.stdout;
    }
    for await(const line of readline.createInterface({input,crlfDelay:Infinity})){
      let j;try{j=JSON.parse(line);}catch{quality.invalid++;continue;}
      if(j.observedAt>cutoff)continue;fn(j);count++;
    }
    if(done)await done;
  }
  quality.parsed[name]=count;console.log(name,count);
}
await scan('token-trades.jsonl',null,j=>{
  const at=Number(j.observedAt),ts=Number(j.timestamp)*1000,p=Number(j.price??j.priceUsd);
  if(!at||!(p>0)||!Number.isFinite(p))return;
  if(ts&&(at-ts>10000||ts>at+2000)){quality.stale++;return;}
  if(fresh&&(oldMints.has(j.mint)||at<=oldCutoff))return;
  if(fresh&&!tokens.has(j.mint))tokens.set(j.mint,makeToken({mint:j.mint,symbol:j.trackedFrom?.symbol||j.mint,firstAt:Math.floor(at/1000)*1000+999}));
  const t=tokens.get(j.mint);if(!t)return;
  const key=`${j.signature||''}:${j.wallet}:${j.side}:${j.timestamp}:${p}:${j.usd}`;
  if(t.seen.has(key)){quality.duplicates++;return;}t.seen.set(key,at);
  if(!t.purgeAt||at-t.purgeAt>30000){for(const[k,v]of t.seen)if(at-v>60000)t.seen.delete(k);t.purgeAt=at;}
  t.creator ||=j.trackedFrom?.from||null;
  const sec=Math.floor(at/1000);let b=t.bins.get(sec);
  if(!b){b={at:sec*1000+999,p,quoteAt:at,ts,buy:0,sell:0,n:0,tiny:0,maxBuy:0,maxSell:0,buyers:{},sellers:{},meaningfulBuy:0};t.bins.set(sec,b);}
  if(ts>b.ts||ts===b.ts&&at>=b.quoteAt){b.p=p;b.quoteAt=at;b.ts=ts;}
  const usd=Number(j.usd)||0;b.n++;if(usd<1)b.tiny++;
  if(j.side==='buy'){b.buy+=usd;b.maxBuy=Math.max(b.maxBuy,usd);if(usd>=1){b.meaningfulBuy+=usd;if(j.wallet)b.buyers[j.wallet]=(b.buyers[j.wallet]||0)+usd;}}
  if(j.side==='sell'){b.sell+=usd;b.maxSell=Math.max(b.maxSell,usd);if(usd>=1&&j.wallet)b.sellers[j.wallet]=(b.sellers[j.wallet]||0)+usd;}
});
for(const t of tokens.values()){delete t.seen;delete t.purgeAt;t.series=[...t.bins.values()].sort((a,b)=>a.at-b.at);delete t.bins;}
await scan('api-responses.jsonl',['/token_stat/','/token_trader_stat/','/mutil_window_token_info'],j=>{
  const t=tokens.get(j.mint);if(!t||j.status!==200||j.body?.code!==0)return;
  let d=j.body.data;
  if(j.endpoint?.includes('/mutil_window_token_info')){
    d=Array.isArray(d)?d.find(r=>r.address===j.mint):null;if(!d)return;
    t.meta.push({at:j.observedAt,holder_count:d.holder_count,liquidity:d.liquidity,
      circulating_supply:d.circulating_supply,total_supply:d.total_supply,creation_timestamp:d.creation_timestamp,
      top_10_holder_rate:d.dev?.top_10_holder_rate,creator_address:d.dev?.creator_address});
  }else if(d&&!Array.isArray(d))t.meta.push({...d,at:j.observedAt});
  if(d?.holder_count!=null)t.holders.push({at:j.observedAt,count:Number(d.holder_count)});
});
await scan('websocket-frames.jsonl',['"channel":"token_general_stat_num"'],j=>{
  if(j.direction!=='received')return;
  for(const d of j.body?.data||[]){const t=tokens.get(d.a??d.ta??j.mint);
    if(t&&d.t==='holder_count'&&Number.isFinite(Number(d.v)))t.holders.push({at:j.observedAt,count:Number(d.v)});
  }
});
for(const t of tokens.values()){t.meta.sort((a,b)=>a.at-b.at);t.holders.sort((a,b)=>a.at-b.at);}
if(fresh)for(const t of tokens.values()){
  const at=t.firstAt+30000,p=t.series.filter(b=>b.at<=at).at(-1);let peak=0,dumped=false;
  for(const b of t.series){if(b.at>at)break;peak=Math.max(peak,b.p);if(b.p<=peak*.4)dumped=true;}
  t.originalEligible=Boolean(p&&at-p.at<=5000&&p.p>=.0003&&p.p<.0004&&!dumped);
}
const result={cutoff:new Date(cutoff).toISOString(),afterCutoff:fresh?source.cutoff:null,quality,inputFiles,tokens:[...tokens.values()]};
const bytes=gzipSync(JSON.stringify(result));
fs.writeFileSync(path.join(dir,fresh?'runner-fresh-cache.json.gz':'runner-cache.json.gz'),bytes);
console.log(JSON.stringify({tokens:tokens.size,bytes:bytes.length,quality},null,2));
