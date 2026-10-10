// Study the initial rise separately from a later dump or bounce.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const old=JSON.parse(fs.readFileSync(path.join(dir,'analysis.json')));
const tokens=new Map(old.rows.map(r=>[r.mint,{row:r,bins:new Map()}]));
for(const f of old.inputFiles.filter(f=>f.path.endsWith('/token-trades.jsonl')&&f.bytes)){
  for await(const line of readline.createInterface({input:fs.createReadStream(f.path,{end:f.bytes-1}),crlfDelay:Infinity})){
    let j;try{j=JSON.parse(line);}catch{continue;}
    const t=tokens.get(j.mint);if(!t)continue;
    const at=Number(j.observedAt),ts=Number(j.timestamp)*1000,p=Number(j.price??j.priceUsd);
    if(!(p>0)||!Number.isFinite(p)||(ts&&(at-ts>10000||ts>at+2000)))continue;
    const sec=Math.floor(at/1000),b=t.bins.get(sec);
    if(!b||ts>b.ts||ts===b.ts&&at>=b.observedAt)t.bins.set(sec,{at:sec*1000+999,observedAt:at,ts,p});
  }
}
function outcome(series,at,entry,target,minutes){
  let peak=entry,min=entry,previous=at,maxGap=0,stop12=null,stop20=null,max=entry,last=null;
  for(const b of series){
    if(b.at<=at)continue;if(b.at>at+minutes*60000)break;
    maxGap=Math.max(maxGap,b.at-previous);previous=b.at;last=b;
    peak=Math.max(peak,b.p);max=Math.max(max,b.p);min=Math.min(min,b.p);
    if(stop12===null&&b.p<=entry*.88)stop12=b.at;
    if(stop20===null&&b.p<=entry*.8)stop20=b.at;
    if(b.p>=target)return {status:maxGap>30000?'GAP_TARGET_OBSERVED':'TARGET',seconds:(b.at-at)/1000,price:b.p,
      maxBeforeResolution:max,minReturnPct:(min/entry-1)*100,stop12Before:stop12!==null,stop20Before:stop20!==null,maxGapSeconds:maxGap/1000};
    if(b.p<=peak*.4)return {status:maxGap>30000?'GAP_DUMP_OBSERVED':'DUMP_FIRST',seconds:(b.at-at)/1000,price:b.p,
      maxBeforeResolution:max,minReturnPct:(min/entry-1)*100,stop12Before:stop12!==null,stop20Before:stop20!==null,maxGapSeconds:maxGap/1000};
  }
  return {status:maxGap>30000?'GAP_UNRESOLVED':last&&last.at>=at+minutes*60000-30000?'TIMEOUT':'CENSORED',
    seconds:last?(last.at-at)/1000:0,maxBeforeResolution:max,minReturnPct:(min/entry-1)*100,
    stop12Before:stop12!==null,stop20Before:stop20!==null,maxGapSeconds:maxGap/1000};
}
const rows=[...tokens.values()].map(t=>{
  const r=t.row,a=[...t.bins.values()].sort((a,b)=>a.at-b.at);
  const before=a.filter(b=>b.at<=r.anchorAt);let peak=0,alreadyDumped=false;
  for(const b of before){peak=Math.max(peak,b.p);if(b.p<=peak*.4)alreadyDumped=true;}
  return {mint:r.mint,symbol:r.symbol,firstAt:r.firstAt,anchorAt:r.anchorAt,anchorPrice:r.anchorPrice,
    alreadyDumped,early:r.early,wholeRecordMaxPrice:a.reduce((m,b)=>Math.max(m,b.p),0),
    price3xx:r.anchorPrice>=.0003&&r.anchorPrice<.0004&&r.anchorAt-r.firstAt>=25000&&!alreadyDumped,
    price600_30m:outcome(a,r.anchorAt,r.anchorPrice,.0006,30),price600_60m:outcome(a,r.anchorAt,r.anchorPrice,.0006,60),
    double30m:outcome(a,r.anchorAt,r.anchorPrice,r.anchorPrice*2,30)};
});
const valid=rows.filter(r=>r.price3xx),resolved=valid.filter(r=>['TARGET','DUMP_FIRST','TIMEOUT'].includes(r.price600_30m.status));
const med=a=>{a=a.filter(x=>x!==null&&x!==undefined&&Number.isFinite(x)).sort((a,b)=>a-b);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
const fields=['holderCount','holderDelta15','ratPct','devTeamPct','top10Pct','sniperHoldPct','insiderCount','dexBotCount','buyShare15','meaningfulBuyUsd15','buyers15','topBuyerPct15','largestSell15','tinyTradePct15','momentum15','ageSeconds'];
const summary=a=>({n:a.length,median:Object.fromEntries(fields.map(k=>[k,med(a.map(r=>r.early[k]))]))});
const splitAt=resolved[Math.floor(resolved.length*.7)]?.firstAt;
const rules=[['all',()=>true],['holder delta >0',f=>f.holderDelta15!==null&&f.holderDelta15>0],['rat <50',f=>f.ratPct!==null&&f.ratPct<50],['rat >=70',f=>f.ratPct>=70],['buy share >=95',f=>f.buyShare15>=95],['meaningful buys >=100',f=>f.meaningfulBuyUsd15>=100],['momentum15 >=0.5',f=>f.momentum15>=.5],['>=3 buyers',f=>f.buyers15>=3]];
const rate=(a,p)=>{a=a.filter(r=>p(r.early));return {n:a.length,hits:a.filter(r=>r.price600_30m.status==='TARGET').length};};
const result={cutoff:old.cutoff,units:'USD token price only; price 0.000300 <= anchor <0.000400, target >=0.000600. Market-cap interpretation needs as-of supply; not assumed here.',
  method:'Anchor at ~30s after first observed quote; exclude pre-anchor dump60; target before running-peak dump60; fixed 30min horizon and 60min sensitivity. Gap >30s before resolution separated. End-of-life dump after target does not invalidate target success. Price-touch analysis, not executable profit.',
  counts:{all:rows.length,price3xx:valid.length,statuses:Object.fromEntries([...new Set(valid.map(r=>r.price600_30m.status))].map(s=>[s,valid.filter(r=>r.price600_30m.status===s).length]))},
  winners:summary(resolved.filter(r=>r.price600_30m.status==='TARGET')),others:summary(resolved.filter(r=>r.price600_30m.status!=='TARGET')),
  rules:rules.map(([name,p])=>({name,all:rate(resolved,p),early:rate(resolved.filter(r=>r.firstAt<splitAt),p),late:rate(resolved.filter(r=>r.firstAt>=splitAt),p)})),rows};
fs.writeFileSync(path.join(dir,'initial-run-analysis.json'),JSON.stringify(result,null,2));
const winners=valid.filter(r=>r.price600_30m.status==='TARGET');
console.log(JSON.stringify({counts:result.counts,winners:result.winners,others:result.others,rules:result.rules,examples:winners.map(r=>({symbol:r.symbol,mint:r.mint,entry:r.anchorPrice,hit:r.price600_30m.price,seconds:r.price600_30m.seconds,minReturn:r.price600_30m.minReturnPct,max:r.wholeRecordMaxPrice}))},null,2));
