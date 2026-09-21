import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {number,stats,pricePath} from './research-math.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const research=join(root,'research');
const warnings=[];
function lines(folder,file){const p=join(folder,file);if(!existsSync(p))return [];return readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).flatMap((s,i)=>{try{return [JSON.parse(s)];}catch{warnings.push(file+': baris '+(i+1)+' tidak lengkap di '+folder);return [];}});}
const field=(o,k)=>number(o?.fields?.[k]?.value);
const group=(a,key)=>{const m=new Map();for(const r of a){const k=key(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r);}return m;};
const runs=[],sessions=[];
for(const name of readdirSync(research,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^(holder|screening)-study-/.test(e.name)).map(e=>e.name).sort()){
 const folder=join(research,name),manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));
 const events=lines(folder,'events.jsonl'), trades=lines(folder,'trades.jsonl'), snapshots=lines(folder,'holder-snapshots.jsonl');
 const summaries=lines(folder,'token-summary.jsonl'),screened=lines(folder,'screened-tokens.jsonl');
 const tradeBy=group(trades,r=>r.mint),holderBy=group(snapshots,r=>r.mint),summaryBy=group(summaries,r=>r.mint),screenBy=group(screened,r=>r.mint);
 const lastData=Math.max(Date.parse(manifest.startedAt),...events.map(e=>e.observedAt??e.startedAt??0),...summaries.map(s=>s.endedAt??0),...trades.map(t=>t.observedAt??0),...snapshots.map(s=>s.observedAt??0));
 const run={id:name,startedAt:Date.parse(manifest.startedAt),lastData,rules:manifest.feedRules,complete:events.some(e=>e.type==='RUN_COMPLETE'),rawTrades:trades.length};runs.push(run);
 for(const ev of events.filter(e=>e.type==='DETAIL_STARTED')){
  const sum=(summaryBy.get(ev.mint)??[]).find(s=>s.startedAt===ev.startedAt);
  const stop=events.find(e=>e.type==='STOP_LOSS_REACHED'&&e.mint===ev.mint&&e.observedAt>=ev.startedAt&&(!sum||e.observedAt<=sum.endedAt));
  const end=sum?.endedAt??lastData,screen=(screenBy.get(ev.mint)??[]).filter(s=>s.observedAt<=ev.startedAt).at(-1);
  const all=tradeBy.get(ev.mint)??[],ts=all.filter(t=>t.occurredAt>=ev.startedAt&&t.occurredAt<=end&&t.observedAt>=ev.startedAt&&t.observedAt<=end).sort((a,b)=>a.occurredAt-b.occurredAt||a.observedAt-b.observedAt);
  const entry=number(sum?.openingPriceUsd)??number(stop?.openingPriceUsd);
  const finalPrice=field(sum,'priceUsd');const finalTime=sum?.fields?.priceUsd?.observedAt;
  const path=pricePath(entry,ev.startedAt,end,ts,stop?{t:stop.observedAt,p:stop.currentPriceUsd,source:'stop'}:finalPrice?{t:finalTime,p:finalPrice,source:'token_stats'}:null);
  const hs=(holderBy.get(ev.mint)??[]).filter(s=>s.observedAt>=ev.startedAt&&s.observedAt<=end);
  const walletSnapshots=group(hs.flatMap(s=>s.holders.map(h=>({...h,observedAt:h.observedAt??s.observedAt}))),h=>h.wallet);
  const tradeByM=group(ts.filter(t=>typeof t.raw?.m==='string'),t=>t.raw.m);
  const wallets=[];
  for(const [wallet,history] of walletSnapshots){
   history.sort((a,b)=>a.observedAt-b.observedAt);const first=history[0],last=history.at(-1),wt=tradeByM.get(wallet)??[];
   const since=wt.filter(t=>t.occurredAt>=first.observedAt),buy=wt.filter(t=>t.side==='buy'),sell=wt.filter(t=>t.side==='sell');
   const initial=number(first.raw?.b),current=number(last.raw?.b),qty=a=>a.reduce((s,t)=>s+(number(t.raw?.ba)??0),0);
   const soldQty=qty(since.filter(t=>t.side==='sell'));
   // Evidence is a join, not an assertion that the undocumented field m is a verified owner.
   const corroborations=wt.filter(t=>history.some(h=>Math.abs(h.observedAt-t.occurredAt)<6000&&number(h.raw?.p)===number(t.priceUsd)&&number(h.raw?.[t.side==='sell'?'soa':'boa'])===number(t.raw?.ba))).length;
   wallets.push({wallet,firstAt:first.observedAt,lastAt:last.observedAt,initial,current,balanceChange:history.length>1&&initial>0&&current!==null?(current/initial-1)*100:null,
    snapshots:history.length,buys:buy.length,sells:sell.length,buyUsd:buy.reduce((s,t)=>s+(number(t.amount)??0),0),sellUsd:sell.reduce((s,t)=>s+(number(t.amount)??0),0),
    boughtQty:qty(buy),soldQty:qty(sell),soldSinceFirst:soldQty,soldVsFirst:initial>0?soldQty/initial*100:null,corroborations,
    history:history.map(h=>({t:h.observedAt,b:number(h.raw?.b)})),trades:wt.map(t=>({t:t.occurredAt,side:t.side,usd:number(t.amount),qty:number(t.raw?.ba),price:number(t.priceUsd),signature:t.signature,ad:t.raw?.ad??null}))});
  }
  wallets.sort((a,b)=>(b.initial??0)-(a.initial??0));
  const bucketMap=new Map();
  for(const t of ts){const k=Math.floor((t.occurredAt-ev.startedAt)/5000);if(!bucketMap.has(k))bucketMap.set(k,{t:ev.startedAt+k*5000,buys:0,sells:0,buyUsd:0,sellUsd:0,sellers:new Set(),matchedSellers:new Set()});const b=bucketMap.get(k);if(t.side==='buy'){b.buys++;b.buyUsd+=number(t.amount)??0;}else if(t.side==='sell'){b.sells++;b.sellUsd+=number(t.amount)??0;if(t.raw?.m)b.sellers.add(t.raw.m);if(walletSnapshots.has(t.raw?.m))b.matchedSellers.add(t.raw.m);}}
  const buckets=[...bucketMap.values()].map(b=>({...b,sellers:b.sellers.size,matchedSellers:b.matchedSellers.size,sellShare:b.sells/(b.buys+b.sells)*100}));
  const buys=ts.filter(t=>t.side==='buy'),sells=ts.filter(t=>t.side==='sell');
  const holdersStart=field(screen,'holders'),endHolderField=sum?.fields?.holders;
  const holdersEnd=endHolderField?.observedAt>ev.startedAt?number(endHolderField.value):null;
  const preStop=stop?ts.filter(t=>t.occurredAt>=stop.observedAt-10000&&t.occurredAt<=stop.observedAt):[];
  sessions.push({id:name+'/'+ev.mint,run:name,mint:ev.mint,name:sum?.metadata?.symbol??screen?.metadata?.symbol??sum?.metadata?.name??screen?.metadata?.name??ev.mint.slice(0,8),
   start:ev.startedAt,end,completed:!!sum,status:sum?.endedBecause??'INTERRUPTED',entry,entrySource:entry?'openingPriceUsd':'Tidak tersimpan',path,
   screeningAt:screen?.observedAt??null,liquidity:field(screen,'liquidityUsd'),marketCap:field(screen,'marketCapUsd'),holdersStart,holdersEnd,top10:field(screen,'top10Percent'),age:field(screen,'createdAt')!==null?(ev.startedAt-field(screen,'createdAt'))/1000:null,
   excludedHistorical:all.filter(t=>t.occurredAt<ev.startedAt).length,buys:buys.length,sells:sells.length,buyUsd:buys.reduce((s,t)=>s+(number(t.amount)??0),0),sellUsd:sells.reduce((s,t)=>s+(number(t.amount)??0),0),
   transactionCount:ts.length,rawMCoverage:ts.filter(t=>t.raw?.m).length,matchedCount:ts.filter(t=>walletSnapshots.has(t.raw?.m)).length,directWallets:ts.filter(t=>t.wallet).length,
   conflictingMapping:ts.filter(t=>t.wallet&&t.raw?.m&&t.wallet!==t.raw.m).length,wallets,buckets,
   preStop:stop?{trades:preStop.length,sells:preStop.filter(t=>t.side==='sell').length,sellUsd:preStop.filter(t=>t.side==='sell').reduce((s,t)=>s+(number(t.amount)??0),0),buyUsd:preStop.filter(t=>t.side==='buy').reduce((s,t)=>s+(number(t.amount)??0),0)}:null});
 }
}
export function aggregate(rows){const valid=rows.filter(s=>s.path&&s.completed);return {sessions:rows.length,unique:new Set(rows.map(s=>s.mint)).size,valid:valid.length,interrupted:rows.filter(s=>!s.completed).length,
 entry:stats(valid.map(s=>s.entry)),liquidity:stats(valid.map(s=>s.liquidity)),marketCap:stats(valid.map(s=>s.marketCap)),holders:stats(valid.map(s=>s.holdersStart)),
 peak:stats(valid.map(s=>s.path.peakGain)),last:stats(valid.map(s=>s.path.lastReturn)),afterPeak:stats(valid.map(s=>s.path.afterPeakReturn)),drawdown:stats(valid.map(s=>s.path.afterPeakDrawdown)),peakSeconds:stats(valid.map(s=>s.path.secondsToPeak)),
 stop:rows.filter(s=>s.status==='STOP_LOSS_REACHED').length,stopSeconds:stats(rows.filter(s=>s.status==='STOP_LOSS_REACHED').map(s=>(s.end-s.start)/1000)),
 targets:[10,20,50].map(k=>({target:k,observed:valid.filter(s=>s.path.hits[k]!==null).length,beforeStop:valid.filter(s=>s.path.hits[k]!==null&&(s.path.hits.minus20===null||s.path.hits[k]<s.path.hits.minus20)).length,tied:valid.filter(s=>s.path.hits[k]!==null&&s.path.hits[k]===s.path.hits.minus20).length})),
 trades:rows.reduce((n,s)=>n+s.transactionCount,0),matched:rows.reduce((n,s)=>n+s.matchedCount,0),wallets:rows.reduce((n,s)=>n+s.wallets.length,0)};}
const data={generatedAt:Date.now(),sourceRoot:research,runs,sessions,warnings,aggregate:aggregate(sessions),cohorts:runs.map(r=>({...r,aggregate:aggregate(sessions.filter(s=>s.run===r.id))}))};
mkdirSync(join(root,'dist'),{recursive:true});mkdirSync(join(root,'reports'),{recursive:true});
writeFileSync(join(root,'dist/research-analysis-data.json'),JSON.stringify(data));
const template=readFileSync(join(root,'scripts/research-report.html'),'utf8');
writeFileSync(join(root,'dist/research-analysis.html'),template.replace('/*REPORT_DATA*/',JSON.stringify(data).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029')));
writeFileSync(join(root,'reports/research-analysis-summary.json'),JSON.stringify({generatedAt:data.generatedAt,aggregate:data.aggregate,cohorts:data.cohorts,warnings},null,2));
console.log(JSON.stringify({generatedAt:new Date(data.generatedAt).toISOString(),aggregate:data.aggregate,cohorts:data.cohorts.map(c=>({id:c.id,rules:c.rules,aggregate:c.aggregate})),warnings},null,2));
