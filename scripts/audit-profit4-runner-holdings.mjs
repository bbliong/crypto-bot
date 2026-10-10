import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import{gunzipSync}from'node:zlib';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const input=JSON.parse(fs.readFileSync(path.join(dir,'analysis.json')));
const c=JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,'runner-cache.json.gz'))));
const walletAudit=JSON.parse(fs.readFileSync(path.join(dir,'runner-wallet-audit.json')));
const wallets=walletAudit.sellers.slice(0,3).map(r=>r.wallet);
const meta=new Map(c.tokens.map(t=>[t.mint,t])),history=new Map();let frames=0;
function rg(patterns){const p=spawn('rg',['--text','--no-line-number','--no-heading','-F',...patterns.flatMap(s=>['-e',s])]);
  const done=new Promise((resolve,reject)=>{let err='';p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code===0||code===1?resolve():reject(new Error(err)));});
  p.stdin.on('error',e=>{if(e.code!=='EPIPE')throw e;});return{p,done};}
for(const f of input.inputFiles.filter(f=>f.path.endsWith('/websocket-frames.jsonl')&&f.bytes)){
  const a=rg(['"channel":"token_holding"','"channel":"token_tag_holding"']),b=rg(wallets);
  fs.createReadStream(f.path,{end:f.bytes-1}).pipe(a.p.stdin);a.p.stdout.pipe(b.p.stdin);
  for await(const l of readline.createInterface({input:b.p.stdout,crlfDelay:Infinity})){
    let j;try{j=JSON.parse(l);}catch{continue;}if(j.direction!=='received'||j.observedAt>Date.parse(input.cutoff))continue;frames++;
    for(const row of j.body?.data||[]){const mint=row.ta??row.a??j.mint;if(!meta.has(mint))continue;
      for(const h of row.h||[]){if(!wallets.includes(h.wa)||!Number.isFinite(Number(h.b)))continue;
        const key=mint+':'+h.wa,a=history.get(key)||[];a.push({at:j.observedAt,balance:Number(h.b),tags:h.ttgs||[],sells:h.ts??null});history.set(key,a);
      }
    }
  }
  await Promise.all([a.done,b.done]);
}
for(const a of history.values())a.sort((a,b)=>a.at-b.at);
const study=JSON.parse(fs.readFileSync(path.join(dir,'runner-study.json')));
const rows=study.decisions.filter(r=>r.seconds===60).map(r=>{
  const t=meta.get(r.mint),supply=t.meta.filter(m=>m.at<=r.at&&m.circulating_supply!=null).at(-1)?.circulating_supply;
  const holdings=wallets.map(wallet=>{const h=(history.get(r.mint+':'+wallet)||[]).filter(h=>h.at<=r.at).at(-1);return{wallet,knownRiskBeforeEntry:walletAudit.sellers.find(s=>s.wallet===wallet).firstKnownDumpAt<r.at,
    balance:h?.balance??null,pct:h&&supply?100*h.balance/Number(supply):null,ageSeconds:h?(r.at-h.at)/1000:null,tags:h?.tags??null};});
  return {mint:r.mint,symbol:r.symbol,at:r.at,target:r.outcome.status==='TARGET',holdings};
});
const result={cutoff:input.cutoff,frames,method:'Three largest repeated dump sellers chosen retrospectively; as-of holding snapshots only. Missing is unknown, never zero. knownRiskBeforeEntry uses first observed dump by that address. Tags and balances are vendor socket records, not on-chain verified ownership.',rows,
  histories:Object.fromEntries(history)};
fs.writeFileSync(path.join(dir,'runner-holdings-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({frames,rows:rows.length,anyKnown:rows.filter(r=>r.holdings.some(h=>h.balance!==null)).length,allThreeKnown:rows.filter(r=>r.holdings.every(h=>h.balance!==null)).length,sample:rows.slice(0,3)},null,2));
