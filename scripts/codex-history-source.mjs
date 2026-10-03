// Read-only access to the entire research store, including the unique archived raw capture.
import {createReadStream,existsSync,readdirSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
export const HISTORY_CUTOFF=Date.parse('2026-10-03T05:00:00Z');
export const HISTORY_ARCHIVE={id:'archive:2026-09-24T09-35-20-902Z',
  archive:'research/crypto-bot-research-2026-09-24T09-35-20-902Z.zip',
  prefix:'home/bbliong/project/crypto-bot/research/2026-09-24T09-35-20-902Z/'};
export const historySources=()=>[...readdirSync('research',{withFileTypes:true}).filter(d=>d.isDirectory())
  .map(d=>({id:`research/${d.name}`,dir:`research/${d.name}`})),HISTORY_ARCHIVE].sort((a,b)=>a.id.localeCompare(b.id));
export const n=x=>x==null||x===''||!Number.isFinite(Number(x))?null:Number(x);
export async function readHistoryLines(source,file,fn){
  let stream,child,done;
  if(source.archive){
    child=spawn('unzip',['-p',source.archive,source.prefix+file],{stdio:['ignore','pipe','ignore']});
    done=new Promise((res,rej)=>{child.once('error',rej);child.once('close',code=>res(code));});stream=child.stdout;
  }else{const path=`${source.dir}/${file}`;if(!existsSync(path))return {lines:0,invalid:0};stream=createReadStream(path);}
  let lines=0,invalid=0;
  for await(const raw of createInterface({input:stream,crlfDelay:Infinity})){
    if(!raw.trim())continue;lines++;let x;try{x=JSON.parse(raw);}catch{invalid++;continue;}fn(x);
  }
  if(done){const code=await done;if(code!==0&&code!==11)throw new Error(`Archive read failed: ${file} (${code})`);}
  return {lines,invalid};
}
function distribution(bs){
  const users=bs.filter(b=>!b.pool).sort((a,b)=>b.percent-a.percent);
  const supplies=bs.filter(b=>b.amount>0&&b.percent>.01).map(b=>b.amount/(b.percent/100)).sort((a,b)=>a-b);
  return {top1:users[0]?.percent??null,top5:users.length?users.slice(0,5).reduce((s,b)=>s+b.percent,0):null,
    devPercent:users.filter(b=>b.dev).reduce((s,b)=>s+(b.percent??0),0),
    incomplete:!users.length||users.some(b=>b.percent===null),supplyEstimate:supplies[Math.floor(supplies.length/2)]??null,
    owners:users.filter(b=>b.percent>=1.5||b.dev)};
}
export async function loadHistorySource(source,{onlyMints=null}={}){
  const sessions=new Map(),tokens=new Map(),counts={rawTicks:0,acceptedTicks:0,duplicates:0,invalid:0};
  const key=x=>`${x.mint}:${x.detailStartedAt??x.startedAt}:${x.worker}`;
  const ensure=mint=>{if(!tokens.has(mint))tokens.set(mint,{ticks:[],holders:[],dev:[],stats:[],fields:[],sol:[],candles:[]});return tokens.get(mint);};
  const read=async(file,fn)=>{const r=await readHistoryLines(source,file,fn);counts.invalid+=r.invalid;};
  await read('events.jsonl',x=>{
    if(x.type==='DETAIL_STARTED'&&x.startedAt<HISTORY_CUTOFF&&(!onlyMints||onlyMints.has(x.mint))){const id=key(x);sessions.set(id,{id,mint:x.mint,symbol:x.symbol,start:x.startedAt,end:null,source:source.id});ensure(x.mint);}
  });
  if(!sessions.size)return {source:source.id,sessions:[],tokens:{},counts,excluded:'NO_DETAIL_STARTED_BEFORE_CUTOFF'};
  await read('token-summary.jsonl',x=>{
    const s=sessions.get(key(x));if(s){s.end=x.endedAt;s.reason=x.endedBecause;s.symbol??=x.metadata?.symbol;}
    if(!tokens.has(x.mint))return;
    for(const[name,f]of Object.entries(x.fields??{}))if(n(f.observedAt)!==null&&f.observedAt<HISTORY_CUTOFF&&['createdAt','marketCapUsd','priceUsd','holders'].includes(name))
      ensure(x.mint).fields.push({at:f.observedAt,name,value:n(f.value)});
  });
  await read('screened-tokens.jsonl',x=>{
    if(!tokens.has(x.mint))return;for(const[name,f]of Object.entries(x.fields??{}))if(n(f.observedAt)!==null&&f.observedAt<HISTORY_CUTOFF&&['createdAt','marketCapUsd','priceUsd','holders'].includes(name))
      ensure(x.mint).fields.push({at:f.observedAt,name,value:n(f.value)});
  });
  const seen=new Set();
  await read('trades.jsonl',x=>{
    counts.rawTicks++;if(!tokens.has(x.mint)||!(x.priceUsd>0)||!(x.observedAt<HISTORY_CUTOFF))return;
    const id=`${x.mint}:${x.signature??x.raw?.id??`${x.occurredAt}:${x.wallet}:${x.side}:${x.priceUsd}:${x.raw?.ba}`}`;
    if(seen.has(id)){counts.duplicates++;return;}seen.add(id);
    ensure(x.mint).ticks.push({id,observedAt:x.observedAt,occurredAt:x.occurredAt,priceUsd:x.priceUsd,side:x.side,wallet:x.wallet,
      usd:n(x.amountUsd??x.raw?.au),tokens:n(x.raw?.ba)});counts.acceptedTicks++;
  });
  await read('developer-holders.jsonl',x=>{
    if(tokens.has(x.mint)&&x.observedAt<HISTORY_CUTOFF)ensure(x.mint).dev.push({at:x.observedAt,status:x.status,
      owners:(x.holders??[]).map(h=>({wallet:h.wallet,amount:n(h.amount),percent:n(h.amountPercentage)===null?null:Number(h.amountPercentage)*100}))});
  });
  await read('token-stat.jsonl',x=>{if(tokens.has(x.mint)&&x.observedAt<HISTORY_CUTOFF)ensure(x.mint).stats.push({at:x.observedAt,status:x.status,count:n(x.holderCount)});});
  await read('sol-spot-checks.jsonl',x=>{if(tokens.has(x.mint)&&x.observedAt<HISTORY_CUTOFF&&x.solPriceUsd>0)ensure(x.mint).sol.push({at:x.observedAt,usd:x.solPriceUsd});});
  const dbPath=source.dir?`${source.dir}/research.sqlite`:null;
  if(dbPath&&existsSync(dbPath)){
    const db=new DatabaseSync(dbPath,{readOnly:true});db.exec('BEGIN');
    const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name));
    if(tables.has('holder_api_observations')&&tables.has('holder_balances')){
      const balances=db.prepare('SELECT wallet, amount_percentage, amount, is_dev, wallet_tag_v2, raw FROM holder_balances WHERE snapshot_id=?');
      const cache=new Map();
      for(const o of db.prepare('SELECT mint,observed_at,status,full_snapshot_id FROM holder_api_observations WHERE observed_at<? ORDER BY observed_at').iterate(HISTORY_CUTOFF)){
        if(!tokens.has(o.mint))continue;
        if(!cache.has(o.full_snapshot_id))cache.set(o.full_snapshot_id,distribution(balances.all(o.full_snapshot_id).map(b=>{
          let raw={};try{raw=JSON.parse(b.raw);}catch{}
          return {wallet:b.wallet,percent:n(b.amount_percentage),amount:n(b.amount),dev:!!b.is_dev,
            pool:raw.addr_type===2||!!raw.exchange||b.wallet_tag_v2?.toLowerCase().includes('lp')===true};
        })));
        ensure(o.mint).holders.push({at:o.observed_at,status:o.status,...cache.get(o.full_snapshot_id)});
      }
    }
    db.exec('ROLLBACK');db.close();
  }else{
    await read('tracked-holders.jsonl',x=>{
      if(!tokens.has(x.mint)||!(x.observedAt<HISTORY_CUTOFF))return;
      const bs=(x.holders??[]).map(h=>({wallet:h.wallet,percent:n(h.amountPercentage),amount:n(h.amount),dev:!!h.isDev,
        pool:h.raw?.addr_type===2||!!h.raw?.exchange||h.walletTagV2?.toLowerCase().includes('lp')===true}));
      ensure(x.mint).holders.push({at:x.observedAt,status:x.status,...distribution(bs)});
    });
  }
  for(const d of tokens.values())for(const xs of Object.values(d))xs.sort((a,b)=>(a.at??a.observedAt)-(b.at??b.observedAt));
  for(const s of sessions.values()){
    if(!s.end){s.end=Math.min(HISTORY_CUTOFF,s.start+90000);s.endInferred=true;}
    s.end=Math.min(s.end,HISTORY_CUTOFF);
  }
  return {source:source.id,sessions:[...sessions.values()],tokens:Object.fromEntries(tokens),counts};
}
