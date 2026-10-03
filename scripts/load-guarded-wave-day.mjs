// Historical input extraction only: source files and SQLite are read-only.
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const start = Date.parse('2026-10-01T17:00:00Z'), end = Date.parse('2026-10-02T17:00:00Z');
const bufferEnd = end + 180000;
const dirs = readdirSync(resolve(root, 'research'), { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.startsWith('momentum-aggressive')).map(d => resolve(root, 'research', d.name));
const sessions = new Map(), activeDirs = new Set(), data = new Map();
const issues = { invalidLines: 0, missingSessionEnds: 0, duplicateSessions: 0, duplicateTicks: 0, duplicateQuotes: 0 };
const num = x => x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
const valid = x => typeof x === 'number' && Number.isFinite(x);
const key = x => `${x.mint}:${x.detailStartedAt ?? x.startedAt}:${x.worker}`;
async function lines(path, fn) {
  if (!existsSync(path)) return;
  let line = 0;
  for await (const raw of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    line++;
    if (!raw.trim()) continue;
    let x; try { x = JSON.parse(raw); } catch { issues.invalidLines++; continue; }
    fn(x, line);
  }
}
for (const dir of dirs) await lines(`${dir}/events.jsonl`, x => {
  if (x.type !== 'DETAIL_STARTED' || !(x.startedAt >= start && x.startedAt < end)) return;
  activeDirs.add(dir);
  const id = key(x);
  if (sessions.has(id)) { issues.duplicateSessions++; return; }
  sessions.set(id, { id, mint: x.mint, symbol: x.symbol, worker: x.worker, start: x.startedAt,
    end: null, reason: null, source: dir.slice(root.length + 1) });
  if (!data.has(x.mint)) data.set(x.mint, { ticks: [], holders: [], dev: [], stats: [], candles: [], fields: [], quotes: [], sol: [], events: [] });
});
const within = (x, at = x.observedAt) => data.has(x.mint) && at >= start - 120000 && at <= bufferEnd;
const tickSeen = new Map(), quoteSeen = new Set(), holdersSeen = new Set();
for (const dir of activeDirs) {
  await lines(`${dir}/token-summary.jsonl`, x => {
    const s = sessions.get(key(x));
    if (s) { s.end = x.endedAt; s.reason = x.endedBecause; s.symbol ??= x.metadata?.symbol; }
    if (!data.has(x.mint)) return;
    for (const [name, f] of Object.entries(x.fields ?? {})) if (valid(f.observedAt) && f.observedAt <= bufferEnd)
      data.get(x.mint).fields.push({ at: f.observedAt, name, value: f.value, source: f.source });
  });
  await lines(`${dir}/screened-tokens.jsonl`, x => {
    if (!data.has(x.mint)) return;
    for (const [name, f] of Object.entries(x.fields ?? {})) if (valid(f.observedAt) && f.observedAt <= bufferEnd)
      data.get(x.mint).fields.push({ at: f.observedAt, name, value: f.value, source: f.source });
  });
  await lines(`${dir}/trades.jsonl`, x => {
    if (!within(x) || !(x.priceUsd > 0)) return;
    const id = `${x.mint}:${x.signature ?? x.raw?.id ?? `${x.occurredAt}:${x.wallet}:${x.side}:${x.priceUsd}`}`;
    const t = { id, observedAt: x.observedAt, occurredAt: x.occurredAt, priceUsd: x.priceUsd,
      side: x.side, wallet: x.wallet, usd: num(x.amountUsd), tokens: num(x.raw?.ba) };
    const old = tickSeen.get(id);
    if (old) { issues.duplicateTicks++; if (old.observedAt > t.observedAt) Object.assign(old, t); return; }
    tickSeen.set(id, t); data.get(x.mint).ticks.push(t);
  });
  await lines(`${dir}/developer-holders.jsonl`, x => {
    if (!within(x)) return;
    data.get(x.mint).dev.push({ at: x.observedAt, status: x.status,
      owners: (x.holders ?? []).map(h => ({ wallet: h.wallet, percent: valid(h.amountPercentage) ? h.amountPercentage * 100 : null, amount: h.amount })) });
  });
  await lines(`${dir}/token-stat.jsonl`, x => {
    if (within(x)) data.get(x.mint).stats.push({ at: x.observedAt, status: x.status, count: x.holderCount });
  });
  await lines(`${dir}/mcap-candles.jsonl`, x => {
    if (!within(x)) return;
    const last = (x.candles ?? []).at(-1);
    data.get(x.mint).candles.push({ at: x.observedAt, status: x.status, last: last ?? null,
      decision: x.decision?.allowed, entryFlow: x.entryFlow?.allowed });
  });
  await lines(`${dir}/sol-spot-checks.jsonl`, x => {
    if (within(x) && x.solPriceUsd > 0) data.get(x.mint).sol.push({ at: x.observedAt, usd: x.solPriceUsd });
  });
  await lines(`${dir}/events.jsonl`, x => {
    if (!within(x) || !['OBSERVATION_ABORTED_DUMP', 'DETAIL_ERROR', 'SWAP_ROUTE_RATELIMITED'].includes(x.type)) return;
    data.get(x.mint).events.push({ at: x.observedAt, type: x.type, reason: x.reason, drawdown: x.drawdownPercent });
  });
  const dbPath = `${dir}/research.sqlite`;
  if (!existsSync(dbPath)) continue;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const obs = db.prepare('SELECT mint, observed_at, status, holder_count, snapshot_hash, full_snapshot_id FROM holder_api_observations WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at').all(start - 120000, bufferEnd);
  const getBalances = db.prepare('SELECT wallet, amount_percentage, amount, is_dev, wallet_tag_v2, raw FROM holder_balances WHERE snapshot_id = ?');
  const cache = new Map();
  for (const o of obs) {
    if (!data.has(o.mint)) continue;
    const id = `${o.mint}:${o.observed_at}:${o.status}:${o.snapshot_hash}`;
    if (holdersSeen.has(id)) continue;
    holdersSeen.add(id);
    if (!cache.has(o.full_snapshot_id)) {
      const bs = getBalances.all(o.full_snapshot_id).map(b => { let raw = {}; try { raw = JSON.parse(b.raw); } catch {}
        return { wallet: b.wallet, percent: b.amount_percentage, amount: b.amount, dev: !!b.is_dev,
          pool: raw.addr_type === 2 || !!raw.exchange || b.wallet_tag_v2?.toLowerCase().includes('lp') === true }; });
      const users = bs.filter(b => !b.pool).sort((a, b) => b.percent - a.percent);
      const supplies = bs.filter(b => b.amount > 0 && b.percent > .01).map(b => b.amount / (b.percent / 100)).sort((a, b) => a - b);
      cache.set(o.full_snapshot_id, { top1: users[0]?.percent ?? null,
        top5: users.length ? users.slice(0,5).reduce((s,b) => s + b.percent,0) : null,
        devPercent: users.filter(b => b.dev).reduce((s,b) => s+b.percent,0),
        incomplete: !users.length || users.some(b => !valid(b.percent)),
        supplyEstimate: supplies.length ? supplies[Math.floor(supplies.length/2)] : null,
        owners: users.filter(b => b.percent >= 1.5 || b.dev) });
    }
    data.get(o.mint).holders.push({ at: o.observed_at, status: o.status, ...cache.get(o.full_snapshot_id) });
  }
  db.close();
}
// Quote/simulation archives were repartitioned separately from original raw detail captures.
for (const dir of dirs) await lines(`${dir}/quote-simulated-orders.jsonl`, x => {
  if (!within(x)) return;
  const id = `${x.positionId}:${x.type}:${x.observedAt}`;
  if (quoteSeen.has(id)) { issues.duplicateQuotes++; return; }
  quoteSeen.add(id);
  data.get(x.mint).quotes.push({ type: x.type, at: x.observedAt, requestedAt: x.routeRequestedAt ?? (valid(x.latencyMs) ? x.observedAt - x.latencyMs : null),
    positionId: x.positionId, decisionAt: x.decisionAt, latency: x.latencyMs, cacheHit: x.prewarmedCacheHit,
    inAmount: x.quote?.inAmount, outAmount: x.quote?.outAmount, input: x.inputAmountBaseUnits,
    inDecimals: x.quote?.inDecimals, outDecimals: x.quote?.outDecimals, inUsd: num(x.quote?.amountInUsd), outUsd: num(x.quote?.amountOutUsd),
    priceImpact: num(x.quote?.priceImpactPct), solSpot: x.detailSolSpotUsd, solSpotAge: x.detailSolSpotAgeMs,
    contextSlot: x.quote?.contextSlot ?? null, minOut: x.quote?.otherAmountThreshold ?? null, execution: x.execution });
});
for (const d of data.values()) for (const [k, xs] of Object.entries(d)) xs.sort((a,b) => (a.at ?? a.observedAt) - (b.at ?? b.observedAt));
for (const s of sessions.values()) {
  const d = data.get(s.mint);
  if (!s.end) { issues.missingSessionEnds++; s.end = Math.min(s.start + 90000, bufferEnd); s.endInferred = true; }
  s.durationSec = (s.end - s.start) / 1000;
  const ticks = d.ticks.filter(t => t.observedAt >= s.start && t.observedAt <= s.end);
  const qs = d.quotes.filter(q => q.at >= s.start && q.at <= s.end);
  s.tickCount = ticks.length; s.firstTick = ticks[0]?.observedAt ?? null; s.lastTick = ticks.at(-1)?.observedAt ?? null;
  s.tickCoverageSec = ticks.length ? (s.lastTick - s.firstTick) / 1000 : 0;
  s.quoteCount = qs.length; s.buyQuoteCount = qs.filter(q => q.type === 'QUOTE_BUY_COMPARISON').length;
  s.sellQuoteCount = qs.filter(q => q.type === 'QUOTE_SELL_COMPARISON' || q.type === 'PERIODIC_SELL_ROUTE_QUOTE').length;
  s.snapshotCount = d.holders.filter(h => h.at >= s.start && h.at <= s.end).length;
  s.devSnapshotCount = d.dev.filter(h => h.at >= s.start && h.at <= s.end).length;
}
const ss = [...sessions.values()].sort((a,b)=>a.start-b.start);
const quantile = (xs,p) => [...xs].sort((a,b)=>a-b)[Math.floor((xs.length-1)*p)] ?? null;
const counts = { detailVisits: ss.length, uniqueMints: data.size, hasTicks: ss.filter(s=>s.tickCount).length,
  hasBuyQuote: ss.filter(s=>s.buyQuoteCount).length, hasSellQuote: ss.filter(s=>s.sellQuoteCount).length,
  hasBothQuoteDirections: ss.filter(s=>s.buyQuoteCount && s.sellQuoteCount).length,
  durationAtLeast90s: ss.filter(s=>s.durationSec>=90).length, tickCoverageAtLeast90s: ss.filter(s=>s.tickCoverageSec>=90).length,
  durationMedianSec: quantile(ss.map(s=>s.durationSec),.5), tickCoverageMedianSec: quantile(ss.map(s=>s.tickCoverageSec),.5),
  holderSnapshots: ss.filter(s=>s.snapshotCount).length, developerSnapshots: ss.filter(s=>s.devSnapshotCount).length,
  authorityFieldMints: [...data.values()].filter(d=>d.fields.some(f=>/mintVerified|mintAuthority|freezeAuthority/.test(f.name))).length,
  quotesWithContextSlot: [...data.values()].reduce((n,d)=>n+d.quotes.filter(q=>q.contextSlot!=null).length,0),
  quotesWithMinOut: [...data.values()].reduce((n,d)=>n+d.quotes.filter(q=>q.minOut!=null).length,0),
  earlyAbortReasons: ss.reduce((out,s)=>{out[s.reason??'UNKNOWN']=(out[s.reason??'UNKNOWN']??0)+1;return out;},{}) };
mkdirSync(resolve(root,'reports'),{recursive:true});
const result = { generatedAt: new Date().toISOString(), start, end, bufferEnd, counts, issues,
  sourceDirs: [...activeDirs].map(x=>x.slice(root.length+1)), sessions:ss, tokens:Object.fromEntries(data) };
writeFileSync(resolve(root,'reports/guarded-wave-input-2026-10-02.json'),JSON.stringify(result)+'\n');
writeFileSync(resolve(root,'reports/guarded-wave-coverage-2026-10-02.json'),JSON.stringify({start:new Date(start).toISOString(),end:new Date(end).toISOString(),counts,issues,sessions:ss},null,2)+'\n');
console.log(JSON.stringify({counts,issues}));
