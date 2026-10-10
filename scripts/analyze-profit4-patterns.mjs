// Offline descriptive research. Never imports or changes the running worker.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const base = 'data/profit4-watch';
const output = process.argv[2] || 'reports/profit4-patterns-2026-10-10';
const cutoff = Date.now();
const inputs = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/^(token-trades|api-responses|websocket-frames|profit4-events)\.jsonl$/.test(e.name))
      inputs.push({ path: p, bytes: fs.statSync(p).size });
  }
}
walk(base); inputs.sort((a, b) => a.path.localeCompare(b.path));
const tokens = new Map();
const quality = { tradeRows: 0, duplicates: 0, staleTrades: 0, invalidLines: 0, invalidPrices: 0 };
function token(mint) {
  if (!tokens.has(mint)) tokens.set(mint, { mint, symbol: mint.slice(0, 8), bins: new Map(), meta: [], holders: [], events: [], seen: new Map() });
  return tokens.get(mint);
}
async function scan(name, prefilter, consume) {
  let count = 0;
  for (const f of inputs.filter(f => path.basename(f.path) === name)) {
    if (!f.bytes) continue;
    const lines = readline.createInterface({ input: fs.createReadStream(f.path, { end: f.bytes - 1 }), crlfDelay: Infinity });
    for await (const l of lines) {
      if (!prefilter(l)) continue;
      let j;
      try { j = JSON.parse(l); } catch { quality.invalidLines++; continue; }
      if (j.observedAt > cutoff) continue;
      consume(j); count++;
    }
  }
  console.log(name, count, 'parsed records;', tokens.size, 'tokens');
}
await scan('token-trades.jsonl', () => true, j => {
  if (!j.mint || !j.observedAt) return;
  quality.tradeRows++;
  const p = Number(j.price ?? j.priceUsd), at = Number(j.observedAt), ts = Number(j.timestamp) * 1000;
  if (!(p > 0) || !Number.isFinite(p)) { quality.invalidPrices++; return; }
  // Exclude historical backfills; a quote may only describe the observable live market.
  if (ts && (at - ts > 10000 || ts > at + 2000)) { quality.staleTrades++; return; }
  const t = token(j.mint); t.symbol = j.trackedFrom?.symbol || t.symbol;
  t.transferAt = Math.min(t.transferAt ?? Infinity, (j.trackedFrom?.timestamp || at / 1000) * 1000);
  const key = `${j.signature || ''}:${j.wallet}:${j.side}:${j.timestamp}:${p}:${j.usd}`;
  if (t.seen.has(key)) { quality.duplicates++; return; }
  t.seen.set(key, at);
  if (!t.purgeAt || at - t.purgeAt > 30000) {
    for (const [k, v] of t.seen) if (at - v > 60000) t.seen.delete(k);
    t.purgeAt = at;
  }
  const sec = Math.floor(at / 1000);
  let b = t.bins.get(sec);
  if (!b) { b = { at: sec * 1000 + 999, p, quoteAt: at, quoteTs: ts, buy: 0, sell: 0, n: 0, tiny: 0, meaningfulBuy: 0, maxSell: 0, buyers: {} }; t.bins.set(sec, b); }
  // A later exchange timestamp takes priority over a delayed earlier trade in the same second.
  if (ts > b.quoteTs || ts === b.quoteTs && at >= b.quoteAt) { b.p = p; b.quoteAt = at; b.quoteTs = ts; }
  const usd = Number(j.usd) || 0; b.n++; if (usd < 1) b.tiny++;
  if (j.side === 'buy') { b.buy += usd; if (usd >= 1) { b.meaningfulBuy += usd; if (j.wallet) b.buyers[j.wallet] = (b.buyers[j.wallet] || 0) + usd; } }
  if (j.side === 'sell') { b.sell += usd; b.maxSell = Math.max(b.maxSell, usd); }
});
for (const t of tokens.values()) { delete t.seen; delete t.purgeAt; }
await scan('api-responses.jsonl', l => l.includes('"role":"token_detail"') && (l.includes('/token_stat/') || l.includes('/token_trader_stat/') || l.includes('/mutil_window_token_info')), j => {
  if (!tokens.has(j.mint) || j.status !== 200 || j.body?.code !== 0) return;
  const t = token(j.mint); let d = j.body.data;
  if (j.endpoint.includes('mutil_window_token_info')) {
    d = Array.isArray(d) ? d.find(x => x.address === j.mint) : null;
    if (!d) return;
    t.meta.push({ at: j.observedAt, holder_count: d.holder_count, liquidity: d.liquidity, creation_timestamp: d.creation_timestamp,
      top_10_holder_rate: d.dev?.top_10_holder_rate });
  } else if (d && !Array.isArray(d)) t.meta.push({ at: j.observedAt, ...d });
  if (d?.holder_count != null) t.holders.push({ at: j.observedAt, count: Number(d.holder_count) });
});
await scan('websocket-frames.jsonl', l => l.includes('"channel":"token_general_stat_num"') && l.includes('holder_count'), j => {
  if (j.direction !== 'received') return;
  for (const d of j.body?.data || []) {
    const mint = d.a ?? d.ta ?? j.mint;
    if (d.t === 'holder_count' && tokens.has(mint) && Number.isFinite(Number(d.v)))
      token(mint).holders.push({ at: j.observedAt, count: Number(d.v) });
  }
});
await scan('profit4-events.jsonl', l => l.includes('"type":"PAPER_SELL"') || l.includes('"type":"PAPER_BUY"'), j => {
  if (tokens.has(j.mint)) token(j.mint).events.push(j);
});
const finite = v => v !== null && v !== undefined && Number.isFinite(Number(v));
const num = v => finite(v) ? Number(v) : null;
const pct = (a, b) => b > 0 ? (a / b - 1) * 100 : null;
function lastBefore(a, at) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m].at <= at) lo = m + 1; else hi = m; } return a[lo - 1] || null; }
function features(t, at) {
  const m = {}, times = {};
  for (const row of t.meta) { if (row.at > at) break; for (const [k,v] of Object.entries(row)) if (k !== 'at' && v != null) { m[k] = v; times[k] = row.at; } }
  const h = lastBefore(t.holders, at), h15 = lastBefore(t.holders, at - 15000);
  const freshH = h && at - h.at <= 30000, freshH15 = h15 && at - 15000 - h15.at <= 30000;
  const window = t.series.filter(b => b.at > at - 15000 && b.at <= at);
  const buy = window.reduce((s,b) => s+b.buy,0), sell = window.reduce((s,b) => s+b.sell,0);
  const buyers = new Map(); for (const b of window) for (const [w,v] of Object.entries(b.buyers)) buyers.set(w,(buyers.get(w)||0)+v);
  const mb = window.reduce((s,b)=>s+b.meaningfulBuy,0), n = window.reduce((s,b)=>s+b.n,0);
  const p = lastBefore(t.series, at), prev = lastBefore(t.series, at - 15000);
  return {
    holderCount: freshH ? h.count : null, holderDelta15: freshH && freshH15 ? h.count-h15.count : null,
    ratPct: finite(m.top_rat_trader_percentage) ? Number(m.top_rat_trader_percentage)*100 : null,
    top10Pct: finite(m.top_10_holder_rate) ? Number(m.top_10_holder_rate)*100 : null,
    devTeamPct: finite(m.dev_team_hold_rate) ? Number(m.dev_team_hold_rate)*100 : null,
    sniperHoldPct: finite(m.top70_sniper_hold_rate) ? Number(m.top70_sniper_hold_rate)*100 : null,
    bundlerPct: finite(m.top_bundler_trader_percentage) ? Number(m.top_bundler_trader_percentage)*100 : null,
    insiderCount: num(m.insider_count), dexBotCount: num(m.dex_bot_count), liquidity: num(m.liquidity),
    ratAgeSeconds: times.top_rat_trader_percentage ? (at-times.top_rat_trader_percentage)/1000 : null,
    ageSeconds: finite(m.creation_timestamp) ? at/1000-Number(m.creation_timestamp) : null,
    buyShare15: buy+sell>0 ? buy/(buy+sell)*100 : null, buyUsd15: buy, sellUsd15: sell,
    meaningfulBuyUsd15: mb, buyers15: buyers.size, topBuyerPct15: mb>0 ? Math.max(0,...buyers.values())/mb*100 : null,
    largestSell15: Math.max(0,...window.map(b=>b.maxSell)), tinyTradePct15: n>0 ? window.reduce((s,b)=>s+b.tiny,0)/n*100 : null,
    momentum15: p && prev && at-prev.at <= 20000 ? pct(p.p,prev.p) : null,
  };
}
function future(t, at, price, seconds=600) {
  const arr=t.series.filter(b=>b.at>at && b.at<=at+seconds*1000);
  if (!arr.length) return null;
  const last=arr.at(-1), coverage=(last.at-at)/1000;
  let hit50=null, hitMinus20=null, hit30=null, hitMinus12=null, max=-Infinity, min=Infinity;
  for(const b of arr){const r=pct(b.p,price); max=Math.max(max,r); min=Math.min(min,r); if(r>=50 && hit50===null)hit50=b.at; if(r<=-20 && hitMinus20===null)hitMinus20=b.at; if(r>=30 && hit30===null)hit30=b.at; if(r<=-12 && hitMinus12===null)hitMinus12=b.at;}
  const gaps=arr.map((b,i)=>(b.at-(i?arr[i-1].at:at))/1000);
  const complete=coverage>=seconds-30 && Math.max(...gaps)<=30;
  return {max,min,end:pct(last.p,price),coverageSeconds:coverage,maxGapSeconds:Math.max(...gaps),complete,
    pumpFirst:hit50!==null && (hitMinus20===null||hit50<hitMinus20),
    pumpResolved:hit50!==null||hitMinus20!==null||complete,
    bounceFirst:hit30!==null && (hitMinus12===null||hit30<hitMinus12),
    bounceResolved:hit30!==null||hitMinus12!==null||complete,
    hit50Seconds:hit50===null?null:(hit50-at)/1000};
}
const rows=[];
for(const t of tokens.values()){
  t.series=[...t.bins.values()].sort((a,b)=>a.at-b.at); delete t.bins;
  t.meta.sort((a,b)=>a.at-b.at); t.holders.sort((a,b)=>a.at-b.at);
  const a=t.series;if(a.length<2)continue;
  const first=a[0],last=a.at(-1),anchor=lastBefore(a,first.at+30000);
  let peak=first.p,maxDD=0,dumpAt=null,trough=null,bounceMax=0,bounceAt=null,maxPrice=first.p;
  for(const b of a){peak=Math.max(peak,b.p);maxPrice=Math.max(maxPrice,b.p);const dd=(1-b.p/peak)*100;maxDD=Math.max(maxDD,dd);
    if(dumpAt===null && dd>=60){dumpAt=b.at;trough=b.p;}
    if(dumpAt!==null){trough=Math.min(trough,b.p);const bounce=pct(b.p,trough);bounceMax=Math.max(bounceMax,bounce);if(bounce>=30 && bounceAt===null)bounceAt=b.at;}
  }
  // First qualifying rebound: causal running trough; no future minimum is used.
  let signal=null, runningPeak=first.p,runningLow=Infinity,dumped=false;
  for(const b of a){runningPeak=Math.max(runningPeak,b.p);if((1-b.p/runningPeak)*100>=60)dumped=true;
    if(dumped){runningLow=Math.min(runningLow,b.p);const rebound=pct(b.p,runningLow);
      if(b.at>=first.at+20000 && b.at<=first.at+600000 && rebound>=4 && rebound<=15){const f=features(t,b.at);if(f.buyShare15>=50 && f.meaningfulBuyUsd15>=2){signal={at:b.at,price:b.p,rebound,...f,future:future(t,b.at,b.p,300)};break;}}
    }
  }
  const end=pct(last.p,first.p),rise=pct(maxPrice,first.p);
  const group=dumpAt!==null?(bounceAt!==null?'JATUH_BOUNCE':'JATUH_TANPA_BOUNCE_30'):(rise>=50?'NAIK_50_TANPA_DUMP_60':'LAINNYA');
  rows.push({mint:t.mint,symbol:t.symbol,firstAt:first.at,lastAt:last.at,transferAt:t.transferAt,observedSeconds:(last.at-first.at)/1000,
    samples:a.length,group,maxRisePct:rise,maxDrawdownPct:maxDD,endReturnPct:end,dumpAt,bounceAt,maxBouncePct:bounceMax,
    anchorAt:anchor.at,anchorPrice:anchor.p,early:features(t,anchor.at),future:future(t,anchor.at,anchor.p),signal,
    paper:t.events.filter(e=>e.type==='PAPER_SELL').map(e=>({at:e.observedAt,lane:e.laneLabel||e.paperLane,net:e.netReturnPercent,reason:e.reason}))});
}
rows.sort((a,b)=>a.firstAt-b.firstAt);
function median(a){a=a.filter(finite).map(Number).sort((a,b)=>a-b);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;}
const fields=['holderCount','holderDelta15','ratPct','top10Pct','devTeamPct','sniperHoldPct','bundlerPct','insiderCount','dexBotCount','buyShare15','meaningfulBuyUsd15','buyers15','topBuyerPct15','largestSell15','tinyTradePct15','momentum15'];
function summarize(arr, pick=r=>r.early){return {n:arr.length,metrics:Object.fromEntries(fields.map(k=>[k,{n:arr.filter(r=>finite(pick(r)?.[k])).length,median:median(arr.map(r=>pick(r)?.[k]))}]))};}
const eligible=rows.filter(r=>r.anchorAt-r.firstAt>=25000 && r.future?.pumpResolved && r.future.maxGapSeconds<=30);
const splitIndex=Math.floor(eligible.length*0.7), splitAt=eligible[splitIndex]?.firstAt;
const train=eligible.filter(r=>r.firstAt<splitAt),test=eligible.filter(r=>r.firstAt>=splitAt);
const tests=[['rat <50',f=>finite(f.ratPct)&&f.ratPct<50],['rat >=70',f=>finite(f.ratPct)&&f.ratPct>=70],['holder delta >0',f=>finite(f.holderDelta15)&&f.holderDelta15>0],['holder delta >=0',f=>finite(f.holderDelta15)&&f.holderDelta15>=0],['buy share >=70',f=>f.buyShare15>=70],['meaningful buy >=10',f=>f.meaningfulBuyUsd15>=10],['buyers >=3',f=>f.buyers15>=3],['top buyer <=60',f=>finite(f.topBuyerPct15)&&f.topBuyerPct15<=60],['flow + holders',f=>f.buyShare15>=70&&f.meaningfulBuyUsd15>=10&&f.buyers15>=3&&finite(f.holderDelta15)&&f.holderDelta15>=0],['flow + breadth',f=>f.buyShare15>=70&&f.meaningfulBuyUsd15>=10&&f.buyers15>=3&&finite(f.topBuyerPct15)&&f.topBuyerPct15<=60]];
function rate(arr,pred=()=>true,signal=false){const a=arr.filter(r=>pred(signal?r.signal:r.early));const wins=a.filter(r=>signal?r.signal.future.bounceFirst:r.future.pumpFirst).length;return {n:a.length,wins,rate:a.length?wins/a.length*100:null};}
const bounceRows=rows.filter(r=>r.signal?.future?.bounceResolved&&r.signal.future.maxGapSeconds<=30);
const result={cutoff:new Date(cutoff).toISOString(),quality,inputFiles:inputs,counts:{tokens:rows.length,eligible:eligible.length,train:train.length,test:test.length,bounceSignals:bounceRows.length},
  groups:Object.fromEntries([...new Set(rows.map(r=>r.group))].map(g=>[g,summarize(rows.filter(r=>r.group===g))])),
  pump:{base:rate(eligible),train:rate(train),test:rate(test),winners:summarize(eligible.filter(r=>r.future.pumpFirst)),others:summarize(eligible.filter(r=>!r.future.pumpFirst)),rules:tests.map(([name,p])=>({name,all:rate(eligible,p),train:rate(train,p),test:rate(test,p)}))},
  bounce:{base:rate(bounceRows,()=>true,true),winners:summarize(bounceRows.filter(r=>r.signal.future.bounceFirst),r=>r.signal),others:summarize(bounceRows.filter(r=>!r.signal.future.bounceFirst),r=>r.signal),rules:tests.map(([name,p])=>({name,all:rate(bounceRows,p,true)}))},rows};
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'analysis.json'),JSON.stringify(result,null,2));
const cols=['symbol','mint','group','firstAt','observedSeconds','maxRisePct','maxDrawdownPct','endReturnPct','maxBouncePct'];
const esc=x=>'"'+String(x??'').replaceAll('"','""')+'"';
fs.writeFileSync(path.join(output,'tokens.csv'),[cols.join(','),...rows.map(r=>cols.map(k=>esc(r[k])).join(','))].join('\n')+'\n');
console.log(JSON.stringify({counts:result.counts,quality,pump:result.pump,bounce:result.bounce,groups:Object.fromEntries(Object.entries(result.groups).map(([k,v])=>[k,v.n]))},null,2));
