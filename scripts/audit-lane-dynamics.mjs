// Exploratory timing audit over captured socket events. No orders or live state changes.
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const audit = JSON.parse(readFileSync(resolve(root, 'reports/lane-audit-2026-10-03.json')));
const rows = audit.records, cutoff = Date.parse(audit.cutoff);
const byMint = new Map(), tapes = new Map();
for (const r of rows) { if (!byMint.has(r.mint)) byMint.set(r.mint, []); byMint.get(r.mint).push(r); }
const dirs = [...new Set(audit.sources.map(p => dirname(resolve(root, p))))];
let scanned = 0, accepted = 0, malformed = 0;
for (const dir of dirs) {
  const file = `${dir}/trades.jsonl`;
  if (!existsSync(file)) continue;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let t; try { t = JSON.parse(line); } catch { malformed++; continue; }
    scanned++;
    const positions = byMint.get(t.mint);
    if (!positions || t.observedAt > cutoff || !(t.priceUsd > 0)) continue;
    if (!positions.some(r => t.observedAt >= r.at - 30000 && t.observedAt <= r.at + 180000)) continue;
    if (!tapes.has(t.mint)) tapes.set(t.mint, new Map());
    const map = tapes.get(t.mint);
    const key = t.signature ?? t.raw?.id ?? `${t.occurredAt}:${t.wallet}:${t.side}:${t.priceUsd}`;
    const old = map.get(key);
    // Earliest receipt only; copied run folders must not multiply one trade.
    if (!old || t.observedAt < old.at) map.set(key, { at: t.observedAt, eventAt: t.occurredAt,
      price: t.priceUsd, side: t.side, usd: t.amountUsd, wallet: t.wallet });
  }
}
const tapesSorted = new Map([...tapes].map(([mint, map]) => [mint, [...map.values()].sort((a, b) => a.at - b.at)]));
for (const xs of tapesSorted.values()) accepted += xs.length;
const valid = x => typeof x === 'number' && Number.isFinite(x);
const round = x => valid(x) ? Math.round(x * 10000) / 10000 : null;
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const q = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] : null;
function stats(rs, field = 'route') {
  const priced = rs.filter(r => valid(r[field])), xs = priced.map(r => r[field]);
  const pos = xs.filter(x => x > 0).reduce((a, b) => a + b, 0), neg = xs.filter(x => x < 0).reduce((a, b) => a - b, 0);
  return { candidates: rs.length, n: xs.length, mints: new Set(priced.map(r => r.mint)).size,
    mean: round(avg(xs)), median: round(q(xs, .5)), winPercent: round(xs.length ? xs.filter(x => x > 0).length / xs.length * 100 : null),
    profitFactor: round(neg ? pos / neg : null), worst: round(xs.length ? Math.min(...xs) : null) };
}
const dynamics = [];
for (const r of rows) {
  const tape = tapesSorted.get(r.mint) ?? [];
  const future = tape.filter(t => t.at >= r.at && t.at <= r.at + 120000);
  const last = future.at(-1);
  const firstAfter = t => tape.find(x => x.at >= t && x.at <= t + 2000 && x.at - x.eventAt <= 2000 && x.eventAt <= x.at + 3000);
  const delays = {};
  for (const delay of [500, 1000, 2000]) {
    const buy = firstAfter(r.at + delay), sell = firstAfter(r.exitAt + delay);
    delays[delay] = buy && sell && sell.at >= buy.at ? (sell.price / buy.price - 1) * 100 : null;
  }
  const afterExit = tape.filter(t => t.at > r.exitAt && t.at <= r.exitAt + 20000);
  const observedThroughExit20s = tape.some(t => t.at >= r.exitAt + 20000 && t.at <= r.exitAt + 22000);
  const peakAfterExit20s = afterExit.length ? Math.max(...afterExit.map(t => (t.price / r.price - 1) * 100)) : null;
  const minAfterExit20s = afterExit.length ? Math.min(...afterExit.map(t => (t.price / r.price - 1) * 100)) : null;
  const afterEntry60 = future.filter(t => t.at <= r.at + 60000);
  const minimum60s = afterEntry60.length ? Math.min(...afterEntry60.map(t => (t.price / r.price - 1) * 100)) : null;
  dynamics.push({ id: r.id, lane: r.lane, mint: r.mint, socket: r.socket, route: r.route, exitReason: r.exitReason,
    captureAfterEntrySec: last ? (last.at - r.at) / 1000 : null, delays,
    observedThroughExit20s, peakAfterExit20s, minAfterExit20s, minimum60s });
}
const laneResults = {};
for (const lane of [...new Set(rows.map(r => r.lane))]) {
  const rs = rows.filter(r => r.lane === lane), ds = dynamics.filter(r => r.lane === lane);
  const hardStops = ds.filter(r => r.exitReason === 'AGGRESSIVE_HARD_STOP');
  const withCoverage = hardStops.filter(r => r.observedThroughExit20s);
  const firstMint = [...new Map([...rs].reverse().map(r => [r.mint, r])).values()];
  laneResults[lane] = { all: stats(rs), firstPerMint: stats(firstMint),
    delays: Object.fromEntries([500, 1000, 2000].map(delay => {
      const covered = ds.filter(r => valid(r.delays[delay]));
      return [delay, { covered: covered.length, baselineSocket: stats(covered, 'socket'),
        delayedSocket: stats(covered.map(r => ({ ...r, delayed: r.delays[delay] })), 'delayed'),
        meanDeltaPoints: round(avg(covered.map(r => r.delays[delay] - r.socket))) }];
    })),
    hardStopRebound20s: { allStops: hardStops.length, observedThrough20s: withCoverage.length,
      recoveredToPlus8: withCoverage.filter(r => r.peakAfterExit20s >= 8).length,
      fellToMinus20: withCoverage.filter(r => r.minAfterExit20s <= -20).length },
    captureAfterEntrySec: { median: round(q(ds.map(r => r.captureAfterEntrySec).filter(valid), .5)), p90: round(q(ds.map(r => r.captureAfterEntrySec).filter(valid), .9)) } };
}
// A small declared family, not a grid search. Historic exits are unchanged here.
const variants = {
  baseline: () => true,
  flow60_top8_dev2_5: r => ['buyShare5s', 'buyShare20s', 'top1', 'dev'].every(k => valid(r.features[k]))
    && r.features.buyShare5s >= .60 && r.features.buyShare20s >= 60 && r.features.top1 <= 8 && r.features.dev <= 2.5,
  flow65_top8_dev2_5: r => ['buyShare5s', 'buyShare20s', 'top1', 'dev'].every(k => valid(r.features[k]))
    && r.features.buyShare5s >= .60 && r.features.buyShare20s >= 65 && r.features.top1 <= 8 && r.features.dev <= 2.5,
  guarded_candidate: r => ['buyShare5s', 'buyShare20s', 'top1', 'top5', 'dev', 'buyers', 'buyUsd5s', 'topBuyerShare',
    'return5s', 'drawdown5s', 'developerSellUsd30s', 'priceAgeMs'].every(k => valid(r.features[k]))
    && r.features.buyShare5s >= .60 && r.features.buyShare20s >= 65 && r.features.top1 <= 8 && r.features.top5 <= 25
    && r.features.dev <= 2.5 && r.features.buyers >= 5 && r.features.buyUsd5s >= 300 && r.features.topBuyerShare <= .5
    && r.features.return5s >= 1 && r.features.return5s <= 20 && r.features.drawdown5s <= 2.5
    && r.features.developerSellUsd30s < 25 && r.features.priceAgeMs <= 1000,
};
const entryFilters = {};
const split = Date.parse('2026-10-02T14:00:00Z');
for (const lane of ['aggressive-wave', 'momentum-v2', 'momentum-v3']) {
  entryFilters[lane] = {};
  for (const [name, predicate] of Object.entries(variants)) {
    const rs = rows.filter(r => r.lane === lane && predicate(r));
    entryFilters[lane][name] = { all: stats(rs), beforeSplit: stats(rs.filter(r => r.at < split)), afterSplit: stats(rs.filter(r => r.at >= split)),
      withStrictHolderGate: stats(rs.filter(r => r.features.strictHolderGate === true)) };
  }
}
const extremeExamples = rows.filter(r => r.paired && r.route < -30).sort((a, b) => a.route - b.route).slice(0,12)
  .map(r => ({ id: r.id, lane: r.lane, symbol: r.symbol, socket: round(r.socket), route: round(r.route),
    reason: r.exitReason, buyTime: new Date(r.at).toISOString(), features: r.features,
    buyLatencyMs: r.buyQuote.latency, sellLatencyMs: r.sellQuote.latency, source: r.source, exitSource: r.exitSource }));
const result = { cutoff: audit.cutoff, scanned, accepted, malformed,
  caveats: ['Delayed replay uses first fresh RECEIVED socket tick after delay, not a quote or actual fill.',
    'No interpolation or filling at a stop threshold. Missing future capture remains missing.',
    'Rebound conditions can both occur on one token; they are not mutually exclusive.',
    'Entry filters retain historical exits and only consider historically bought tokens: not a full candidate strategy backtest.',
    'The chronological split is exploratory because all data was inspected; next unseen sessions are required for validation.',
    'guarded_candidate is a measurable subset only: current MC, authorities, executable prebuy quote, cluster risk and full fee gate are not replayed.'],
  split: new Date(split).toISOString(), lanes: laneResults, entryFilters, extremeExamples, dynamics };
writeFileSync(resolve(root, 'reports/lane-dynamics-2026-10-03.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output: resolve(root, 'reports/lane-dynamics-2026-10-03.json'), scanned, accepted, malformed,
  lanes: Object.fromEntries(Object.entries(laneResults).map(([k,v]) => [k, { firstPerMint: v.firstPerMint,
    delay1000MeanDeltaPoints: v.delays[1000].meanDeltaPoints, hardStopRebound20s: v.hardStopRebound20s }])) }));
