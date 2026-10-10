// Execution sensitivity for the research signals, not a replay of native V1/V4.
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
const dir = process.argv[2] || 'reports/profit4-patterns-2026-10-10';
const d = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json')));
const tokens = new Map(d.rows.filter(r => r.signal).map(r => [r.mint, { row:r, bins:new Map() }]));
for (const file of d.inputFiles.filter(f => f.path.endsWith('/token-trades.jsonl') && f.bytes)) {
  for await (const line of readline.createInterface({ input:fs.createReadStream(file.path,{end:file.bytes-1}), crlfDelay:Infinity })) {
    let j; try { j=JSON.parse(line); } catch { continue; }
    const t=tokens.get(j.mint); if(!t)continue;
    const at=Number(j.observedAt), ts=Number(j.timestamp)*1000,p=Number(j.price??j.priceUsd);
    if(at<t.row.signal.at || at>t.row.signal.at+315000 || !(p>0) || !Number.isFinite(p))continue;
    if(ts && (at-ts>10000 || ts>at+2000))continue;
    const sec=Math.floor(at/1000),old=t.bins.get(sec);
    if(!old || ts>old.ts || ts===old.ts&&at>=old.observedAt)t.bins.set(sec,{at:sec*1000+999,observedAt:at,ts,p});
  }
}
const net=(entry,exit)=>((((5*.99-.005)/(entry*1.005))*exit*.995*.99-.005)/5-1)*100;
function replay(row,series,delay) {
  const signal=row.signal;
  const entry=series.find(b=>b.at>=signal.at+delay);
  if(!entry || entry.at>signal.at+delay+5000)return {status:'ENTRY_MISSING'};
  let previous=entry.at,trigger=null,reason=null;
  for(const b of series){
    if(b.at<=entry.at)continue;
    if(b.at-previous>10000)return {status:'PATH_GAP',entryAt:entry.at};
    previous=b.at;
    const n=net(entry.p,b.p);
    if(n>=30 || n<=-12 || b.at>=entry.at+300000){trigger=b;reason=n>=30?'TARGET':n<=-12?'STOP':'TIME';break;}
  }
  if(!trigger)return {status:'EXIT_NOT_OBSERVED',entryAt:entry.at};
  const exit=series.find(b=>b.at>=trigger.at+delay);
  if(!exit || exit.at>trigger.at+delay+5000)return {status:'EXIT_FILL_MISSING',entryAt:entry.at,reason};
  return {status:'CLOSED',entryAt:entry.at,entryPrice:entry.p,exitAt:exit.at,exitPrice:exit.p,reason,net:net(entry.p,exit.p)};
}
const rows=[...tokens.values()].map(t=>({mint:t.row.mint,symbol:t.row.symbol,firstAt:t.row.firstAt,
  features:t.row.signal,delay1:replay(t.row,[...t.bins.values()].sort((a,b)=>a.at-b.at),1000),
  delay2:replay(t.row,[...t.bins.values()].sort((a,b)=>a.at-b.at),2000)}));
const rules=[['All signals',()=>true],['Top buyer <=60%',f=>f.topBuyerPct15!==null&&f.topBuyerPct15<=60],
  ['>=5 buyers + top buyer <=60% (post-hoc)',f=>f.buyers15>=5&&f.topBuyerPct15!==null&&f.topBuyerPct15<=60]];
function summarize(rs,p,k){const a=rs.filter(r=>p(r.features)),closed=a.filter(r=>r[k].status==='CLOSED');return {
  signals:a.length,closed:closed.length,wins:closed.filter(r=>r[k].net>0).length,
  unresolved:a.length-closed.length,meanNet:closed.length?closed.reduce((s,r)=>s+r[k].net,0)/closed.length:null,
  pnlUsd:closed.reduce((s,r)=>s+r[k].net*.05,0),worstNet:closed.length?Math.min(...closed.map(r=>r[k].net)):null};}
const result={description:'First bounce signal only; net target 30%, net stop 12%, max hold 300s, quote delay 1/2s on both sides, maximum fill wait 5s, path gaps >10s censored. Same cost equation as TargetLane: stake $5, fee 1%/side, slippage 0.5%/side, fixed $0.005/side. Quotes use last exchange timestamp per received second, not native median. All signals selected without filtering on future completeness; no trailing/staircase. Exploratory, not a native lane replay or executable swap.',
  rules:rules.map(([name,p])=>({name,delay1:summarize(rows,p,'delay1'),delay2:summarize(rows,p,'delay2')})),rows};
fs.writeFileSync(path.join(dir,'execution-stress.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({description:result.description,rules:result.rules},null,2));
