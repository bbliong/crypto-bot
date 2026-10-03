// Offline, read-only source audit. Does not import the collector/dashboard or submit orders.
// Usage: node scripts/audit-lane-plan.mjs [--cutoff=2026-10-02T23:00:00Z]
import { DatabaseSync } from 'node:sqlite';
import { createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { HISTORY_ARCHIVE, readHistoryLines } from './codex-history-source.mjs';

const root = resolve(import.meta.dirname, '..');
const cutoff = Date.parse(process.argv.find(x => x.startsWith('--cutoff='))?.slice(9) ?? '2026-10-02T23:00:00Z');
if (!Number.isFinite(cutoff)) throw new Error('Invalid cutoff');
const allHistory = process.argv.includes('--all');
const outputStem = allHistory ? 'codex-all-history-audit' : 'lane-audit-2026-10-03';
const output = resolve(root, `reports/${outputStem}.json`);
const dirs = readdirSync(resolve(root, 'research'), { withFileTypes: true })
  .filter(d => d.isDirectory() && (allHistory || d.name.startsWith('momentum-aggressive')))
  .map(d => resolve(root, 'research', d.name)).sort();
if (allHistory) dirs.push(HISTORY_ARCHIVE.id);
const valid = x => typeof x === 'number' && Number.isFinite(x);
const number = x => x == null || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const round = x => valid(x) ? Math.round(x * 10000) / 10000 : null;
const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const quantile = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)] : null;
const countBy = (xs, f) => { const out = {}; for (const x of xs) { const k = f(x); out[k] = (out[k] ?? 0) + 1; } return out; };
const groupBy = (xs, f) => { const out = new Map(); for (const x of xs) { const k = f(x); if (!out.has(k)) out.set(k, []); out.get(k).push(x); } return out; };
const slot = t => new Date(Math.floor((t + 7 * 3600000) / 10800000) * 10800000 - 7 * 3600000).toISOString();
const issues = { invalidLines: 0, duplicateBuys: 0, duplicateSells: 0, duplicateQuotes: 0, quoteAmountMismatch: 0, quoteTimingMismatch: 0 };
async function readLines(path, fn) {
  if (path.startsWith(HISTORY_ARCHIVE.id + '/')) {
    let line = 0;
    const result = await readHistoryLines(HISTORY_ARCHIVE, path.slice(HISTORY_ARCHIVE.id.length + 1), row => {
      line++;
      if (row.observedAt > cutoff) return;
      fn(row, { file: path, line });
    });
    issues.invalidLines += result.invalid;
    return;
  }
  if (!existsSync(path)) return;
  let line = 0;
  for await (const raw of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    line++;
    if (!raw.trim()) continue;
    let row; try { row = JSON.parse(raw); } catch { issues.invalidLines++; continue; }
    if (row.observedAt > cutoff) continue;
    fn(row, { file: path.slice(root.length + 1), line });
  }
}
const buys = new Map(), sells = new Map(), quotes = new Map(), quoteSeen = new Set();
const sourceFiles = [], screens = new Map(), developerEvents = new Map();
for (const dir of dirs) {
  const f = `${dir}/simulated-trades.jsonl`;
  if (dir === HISTORY_ARCHIVE.id) sourceFiles.push(f);
  else if (existsSync(f)) sourceFiles.push(f.slice(root.length + 1));
  await readLines(f, (x, source) => {
    const id = x.positionId ?? `${x.mint}:${x.type === 'SIMULATED_BUY' ? x.observedAt : x.entry?.openedAt}:${x.paperLane ?? 'control'}`;
    if (x.type === 'SIMULATED_BUY') {
      if (buys.has(id)) { issues.duplicateBuys++; return; }
      const g = x.entryGate ?? {}, m = g.momentum?.metrics ?? g.aggressive?.metrics ?? {};
      buys.set(id, { id, mint: x.mint, lane: x.paperLane ?? 'control', at: x.observedAt, stake: x.stakeUsd,
        price: x.entryPriceUsd, symbol: x.metadata?.symbol, source,
        features: { return5s: m.return5s, slope5s: m.slope5s, volatility: m.volatilityPercent, drawdown5s: m.drawdown5s,
          buyers: m.buyers, sellers: m.sellers, trades5s: m.trades, buyUsd5s: m.buyUsd, sellUsd5s: m.sellUsd,
          buyShare5s: m.buyShare, topBuyerShare: m.topBuyerShare, buyShare20s: g.tradeFlow20s?.buySharePercent,
          top1: g.holderDistribution?.top1Percent, top5: g.holderDistribution?.top5Percent, dev: g.holderDistribution?.devPercent,
          holders: g.holderDistribution?.holderCount, holderGate: g.holderDistribution?.allowed,
          strictHolderGate: g.strictHolderPreBuy?.allowed, strictHolderReason: g.strictHolderPreBuy?.reason,
          candleReturn: g.candleEntryFlow?.currentCandleReturnPercent, candleGate: g.candleEntryFlow?.allowed,
          sourceLagMs: x.timing?.sourceLagMs, priceAgeMs: x.timing?.priceAgeMsAtDecision,
          holderGrowth: g.momentum?.holders?.sustained, waveTarget: g.aggressiveWaveTarget?.targetPercent } });
    } else if (x.type === 'SIMULATED_SELL') {
      if (sells.has(id)) { issues.duplicateSells++; return; }
      sells.set(id, { at: x.observedAt, reason: x.reason, socket: x.pnlPercent, price: x.exit?.priceUsd,
        peak: x.decision?.peakReturnPercent, exitMetrics: x.decision?.metrics, majorSell: x.decision?.majorSell,
        timing: { sourceLagMs: x.timing?.sourceLagMs, priceAgeMs: x.timing?.priceAgeMsAtDecision }, source });
    }
  });
  await readLines(`${dir}/quote-simulated-orders.jsonl`, (x, source) => {
    if (!x.positionId) return;
    const key = `${x.positionId}:${x.type}:${x.observedAt}`;
    if (quoteSeen.has(key)) { issues.duplicateQuotes++; return; }
    quoteSeen.add(key);
    if (!quotes.has(x.positionId)) quotes.set(x.positionId, []);
    quotes.get(x.positionId).push({ type: x.type, at: x.observedAt, decisionAt: x.decisionAt,
      requestedAt: x.routeRequestedAt, buyQuoteAt: x.buyQuoteAt, latency: x.latencyMs,
      cacheHit: x.prewarmedCacheHit, cacheAge: x.prewarmedAgeMs,
      inUsd: number(x.quote?.amountInUsd), outUsd: number(x.quote?.amountOutUsd),
      input: x.inputAmountBaseUnits, inAmount: x.quote?.inAmount, outAmount: x.quote?.outAmount,
      inDecimals: x.quote?.inDecimals, outDecimals: x.quote?.outDecimals,
      buySpread: x.routeVsSocketPricePercent, sellSpread: x.routeVsSocketProceedsPercent,
      solSpotAge: x.detailSolSpotAgeMs, impact: x.quote?.priceImpactPct, source });
  });
  await readLines(`${dir}/screened-tokens.jsonl`, x => {
    if (!screens.has(x.mint)) screens.set(x.mint, []);
    screens.get(x.mint).push({ at: x.observedAt, mc: x.fields?.marketCapUsd?.value,
      liquidity: x.fields?.liquidityUsd?.value, createdAt: x.fields?.createdAt?.value });
  });
  await readLines(`${dir}/developer-activity.jsonl`, x => {
    if (!developerEvents.has(x.mint)) developerEvents.set(x.mint, []);
    developerEvents.get(x.mint).push({ at: x.observedAt, event: x.event, usd: x.trade?.amountUsd,
      wallet: x.trade?.wallet, signature: x.trade?.signature });
  });
}
const records = [];
for (const b of buys.values()) {
  const s = sells.get(b.id), qs = (quotes.get(b.id) ?? []).sort((a, b) => a.at - b.at);
  const qb = qs.find(q => q.type === 'QUOTE_BUY_COMPARISON' && q.inUsd > 0);
  const qe = s ? qs.find(q => q.type === 'QUOTE_SELL_COMPARISON' && valid(q.outUsd) && q.outUsd >= 0 && q.at >= s.at) : null;
  const sameAmount = qb && qe && qb.outAmount != null && (qe.input ?? qe.inAmount) === qb.outAmount;
  const sameTime = qb && qe && qb.at >= b.at && qe.at >= s.at && (!qe.buyQuoteAt || qe.buyQuoteAt === qb.at)
    && (qb.decisionAt == null || qb.decisionAt === b.at) && (qe.decisionAt == null || qe.decisionAt === s.at);
  if (qb && qe && !sameAmount) issues.quoteAmountMismatch++;
  if (qb && qe && !sameTime) issues.quoteTimingMismatch++;
  const paired = !!(qb && qe && sameAmount && sameTime);
  const prev = (screens.get(b.mint) ?? []).filter(x => x.at <= b.at).sort((a, b) => b.at - a.at)[0];
  const devBefore = [...new Map((developerEvents.get(b.mint) ?? []).filter(x => x.at <= b.at && x.at >= b.at - 30000 && x.event === 'DEVELOPER_SELL_OBSERVED')
    .map(x => [x.signature ?? `${x.wallet}:${x.at}`, x])).values()];
  const r = { ...b, slot: slot(b.at), exitAt: s?.at, exitReason: s?.reason, exitSource: s?.source,
    socket: valid(s?.socket) ? s.socket : null, peak: s?.peak, exitMetrics: s?.exitMetrics,
    durationSec: s ? (s.at - b.at) / 1000 : null, closed: !!s, paired,
    route: paired ? (qe.outUsd / qb.inUsd - 1) * 100 : null,
    routeSol: paired && Number(qb.inAmount ?? qb.input) > 0 ? (Number(qe.outAmount) / Number(qb.inAmount ?? qb.input) - 1) * 100 : null,
    quotePnlUsd: paired ? qe.outUsd - qb.inUsd : null,
    buyQuote: qb ?? null, sellQuote: qe ?? null,
    features: { ...b.features, screenedMc: prev?.mc, screenedLiquidity: prev?.liquidity,
      screenAgeMs: prev ? b.at - prev.at : null, tokenAgeSec: prev?.createdAt ? (b.at - prev.createdAt) / 1000 : null,
      developerSells30s: devBefore.length, developerSellUsd30s: devBefore.reduce((s, x) => s + (number(x.usd) ?? 0), 0) } };
  const periodic = qs.filter(q => q.type === 'PERIODIC_SELL_ROUTE_QUOTE' && valid(q.outUsd) && q.outUsd >= 0 && qb && q.at >= qb.at && (!s || q.at <= s.at));
  r.routePath = periodic.map(q => ({ at: q.at, return: (q.outUsd / qb.inUsd - 1) * 100, latency: q.latency }));
  r.quotePeak = periodic.length ? Math.max(...r.routePath.map(q => q.return)) : null;
  r.firstRoundTrip = r.routePath[0]?.return ?? null;
  records.push(r);
}
records.sort((a, b) => a.at - b.at);
function summary(rs, field = 'route') {
  const priced = rs.filter(r => valid(r[field])); const xs = priced.map(r => r[field]);
  const pos = xs.filter(x => x > 0).reduce((a, b) => a + b, 0), neg = xs.filter(x => x < 0).reduce((a, b) => a - b, 0);
  let balance = 0, peak = 0, dd = 0;
  for (const x of xs) { balance += x; peak = Math.max(peak, balance); dd = Math.max(dd, peak - balance); }
  const sorted = [...xs].sort((a, b) => b - a);
  return { entries: rs.length, closed: rs.filter(r => r.closed).length, n: xs.length,
    mints: new Set(priced.map(r => r.mint)).size, wins: xs.filter(x => x > 0).length,
    winPercent: round(xs.length ? 100 * xs.filter(x => x > 0).length / xs.length : null),
    mean: round(avg(xs)), median: round(quantile(xs, .5)), p05: round(quantile(xs, .05)),
    worst: round(xs.length ? Math.min(...xs) : null), best: round(xs.length ? Math.max(...xs) : null),
    profitFactor: round(neg ? pos / neg : null), sumReturnPoints: round(xs.reduce((a, b) => a + b, 0)),
    equalStakeDrawdownPoints: round(dd), meanWithoutTop3: round(avg(sorted.slice(3))),
    durationMedianSec: round(quantile(priced.map(r => r.durationSec).filter(valid), .5)),
    severeLossCount: xs.filter(x => x <= -20).length, socketWinsRouteLoss: priced.filter(r => r.socket > 0 && r[field] <= 0).length };
}
function bootstrapMint(rs) {
  const groups = [...groupBy(rs.filter(r => valid(r.route)), r => r.mint).values()];
  if (!groups.length) return null;
  let seed = 20261003;
  const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const means = [];
  for (let i = 0; i < 1200; i++) {
    let sum = 0, n = 0;
    for (let j = 0; j < groups.length; j++) for (const r of groups[Math.floor(random() * groups.length)]) { sum += r.route; n++; }
    means.push(sum / n);
  }
  return [round(quantile(means, .025)), round(quantile(means, .975))];
}
const lanes = [...new Set(records.map(r => r.lane))].sort();
const byLane = {};
const waveStart = records.find(r => r.lane === 'aggressive-wave')?.at;
for (const lane of lanes) {
  const rs = records.filter(r => r.lane === lane);
  byLane[lane] = { socket: summary(rs, 'socket'), exactQuote: summary(rs), quoteSol: summary(rs, 'routeSol'),
    mean95MintBootstrap: bootstrapMint(rs), commonWindow: summary(rs.filter(r => r.at >= waveStart)),
    firstAt: rs[0]?.at, lastAt: rs.at(-1)?.at,
    slots: Object.fromEntries([...groupBy(rs, r => r.slot)].map(([k, v]) => [k, summary(v)])),
    exits: Object.fromEntries([...groupBy(rs, r => r.exitReason ?? 'OPEN')].map(([k, v]) => [k, summary(v)])),
    strictGate: countBy(rs, r => r.features.strictHolderReason ?? 'NOT_RECORDED'),
    stressExtraCostPoints: [1, 2, 3, 5, 8].map(cost => ({ cost, ...summary(rs.map(r => ({ ...r, route: valid(r.route) ? r.route - cost : null }))) })) };
}
const featureBins = {
  return5s: [0, 2, 5, 10, 15, 22, 35, Infinity], buyers: [0, 3, 5, 8, 12, 20, Infinity],
  buyShare5s: [0, .6, .7, .8, .9, .95, 1.01], buyShare20s: [0, 50, 60, 65, 75, 85, 95, 101],
  topBuyerShare: [0, .25, .4, .5, .7, 1.01], dev: [0, .01, 1, 2, 2.5, 3.5, 10, Infinity],
  top1: [0, 3, 6, 8, 15, 25, Infinity], top5: [0, 10, 20, 30, 40, 60, Infinity],
  screenedMc: [0, 5500, 10000, 15000, 25000, 50000, 100000, Infinity],
  tokenAgeSec: [0, 30, 60, 120, 300, 900, Infinity],
  developerSellUsd30s: [0, .01, 25, 100, Infinity], volatility: [0, 1, 2, 3, 5, 10, Infinity],
};
const featureAnalysis = {};
for (const lane of lanes) {
  const rs = records.filter(r => r.lane === lane);
  featureAnalysis[lane] = {};
  for (const [feature, edges] of Object.entries(featureBins)) {
    featureAnalysis[lane][feature] = edges.slice(0, -1).map((lo, i) => ({ bin: `[${lo},${edges[i + 1]})`,
      ...summary(rs.filter(r => valid(r.features[feature]) && r.features[feature] >= lo && r.features[feature] < edges[i + 1])) }));
  }
}
const db = new DatabaseSync(resolve(root, 'data/crypto-bot.sqlite'), { readOnly: true });
db.exec('BEGIN');
const dbPaper = db.prepare('SELECT lane, count(*) n, avg(socket_return_percent) socket, avg(real_return_percent) dashboard_return FROM trades WHERE entry_time <= ? GROUP BY lane').all(cutoff);
const rawLive = db.prepare('SELECT * FROM real_trades WHERE buy_time <= ? ORDER BY buy_time').all(cutoff);
db.exec('ROLLBACK'); db.close();
const liveMap = new Map();
for (const r of rawLive) {
  const key = r.buy_hash || r.buy_order_id || `${r.mint}:${r.buy_time}:${r.lane}`;
  const prev = liveMap.get(key);
  const score = x => (x.sell_ok === 1 ? 100 : 0) + (x.wallet_snapshots_json ? 10 : 0) + (x.wallet_sold_income != null ? 5 : 0);
  if (!prev || score(r) > score(prev)) liveMap.set(key, r);
}
const live = [...liveMap.values()].map(r => {
  let snaps = []; try { snaps = JSON.parse(r.wallet_snapshots_json ?? '[]'); } catch {}
  const postSell = Array.isArray(snaps) && snaps.some(s => ['POST_SELL', 'RETRY_SELL'].includes(s.stage) && s.historySoldIncomeUsd != null);
  return { id: r.id, lane: r.lane, mint: r.mint, symbol: r.symbol, at: r.buy_time,
    closed: r.buy_ok === 1 && r.sell_ok === 1, status: r.status, buyOk: r.buy_ok, sellOk: r.sell_ok,
    buyHash: r.buy_hash, sellHash: r.sell_hash, postSellSnapshot: !!postSell,
    buyCost: r.wallet_buy_cost, sellIncome: r.wallet_sold_income, pnlUsd: r.wallet_pnl_usd,
    recordedReturn: r.actual_return_percent, theoryReturn: r.theory_return_percent,
    route: r.buy_ok === 1 && r.sell_ok === 1 && postSell && r.wallet_buy_cost > 0 && valid(r.wallet_sold_income) && r.wallet_sold_income >= 0
      ? (r.wallet_sold_income / r.wallet_buy_cost - 1) * 100 : null };
});
const quoteRows = [...quotes.values()].flat();
const dist = xs => ({ n: xs.filter(valid).length, median: round(quantile(xs.filter(valid), .5)), p90: round(quantile(xs.filter(valid), .9)), p95: round(quantile(xs.filter(valid), .95)), max: xs.filter(valid).length ? Math.max(...xs.filter(valid)) : null });
const quoteStats = Object.fromEntries([...groupBy(quoteRows, q => q.type)].map(([k, qs]) => [k, {
  n: qs.length, latency: dist(qs.map(q => q.latency)), cacheHits: qs.filter(q => q.cacheHit).length,
  cacheAge: dist(qs.map(q => q.cacheAge)), buySpread: dist(qs.map(q => q.buySpread)), sellSpread: dist(qs.map(q => q.sellSpread)),
  solSpotAge: dist(qs.map(q => q.solSpotAge)) }]));
const sameEntry = groupBy(records.filter(r => valid(r.route)), r => `${r.mint}:${r.at}`);
const matchedPairs = [];
for (const [a, b] of [['aggressive-safe','aggressive-wide'], ['aggressive-safe','aggressive-optimal'], ['momentum-v2','momentum-v3'], ['aggressive-swing-100k','aggressive-wave']]) {
  const pairs = [...sameEntry.values()].map(rs => [rs.find(r => r.lane === a), rs.find(r => r.lane === b)]).filter(([x, y]) => x && y);
  matchedPairs.push({ a, b, n: pairs.length, aStats: summary(pairs.map(x => x[0])), bStats: summary(pairs.map(x => x[1])), meanBMinusA: round(avg(pairs.map(([x, y]) => y.route - x.route))) });
}
const audit = { generatedAt: new Date().toISOString(), cutoff: new Date(cutoff).toISOString(), commonWindowStartsAt: new Date(waveStart).toISOString(),
  methodology: ['Streaming raw JSONL; deduplicate by positionId, not mint.', 'Quote join requires same positionId, raw token input equals buy output, matching decision timestamps.',
    'Quote returns exclude any execution costs not embedded in route amounts; quotes are not confirmed fills.', 'Only evidence observed before buy is used for entry features.',
    'Screening market cap is not entry-time market cap; screenAgeMs is retained.', 'Historical associations and inspected time splits are exploratory, not untouched validation.',
    'Live history is deduplicated by buy hash/order; POST_SELL wallet history is still not a full transaction balance-delta reconciliation.'],
  sources: sourceFiles, issues, counts: { rawBuyPositions: buys.size, rawSellPositions: sells.size, closed: records.filter(r => r.closed).length,
    exactQuotePairs: records.filter(r => r.paired).length, liveRawRows: rawLive.length, liveUniqueAttempts: live.length, liveDuplicateRows: rawLive.length - live.length },
  dashboardBaseline: dbPaper, byLane, featureAnalysis, matchedPairs, quoteStats,
  liveStats: Object.fromEntries([...groupBy(live, r => r.lane)].map(([k, rs]) => [k, { ...summary(rs),
    statuses: countBy(rs, r => r.status), bought: rs.filter(r => r.buyOk === 1).length,
    sellConfirmed: rs.filter(r => r.closed).length, unresolvedBuys: rs.filter(r => r.buyOk === 1 && r.sellOk !== 1).length,
    knownPnlUsd: round(rs.filter(r => valid(r.route)).reduce((s, r) => s + r.sellIncome - r.buyCost, 0)) }])),
  sourceLag: dist(records.map(r => r.features.sourceLagMs)), signalPriceAge: dist(records.map(r => r.features.priceAgeMs)), live, records };
mkdirSync(resolve(root, 'reports'), { recursive: true });
writeFileSync(output, JSON.stringify(audit, null, 2) + '\n');
const brief = { cutoff: audit.cutoff, commonWindowStartsAt: audit.commonWindowStartsAt, counts: audit.counts, issues,
  lanes: Object.fromEntries(Object.entries(byLane).map(([k, v]) => [k, { entries: v.socket.entries,
    n: v.exactQuote.n, mints: v.exactQuote.mints, socketMean: v.socket.mean, quoteMean: v.exactQuote.mean,
    quoteWinPercent: v.exactQuote.winPercent, profitFactor: v.exactQuote.profitFactor,
    worstSocket: v.socket.worst, worstQuote: v.exactQuote.worst, mean95: v.mean95MintBootstrap }])),
  liveStats: audit.liveStats, quoteStats, sourceLag: audit.sourceLag, signalPriceAge: audit.signalPriceAge };
writeFileSync(resolve(root, allHistory ? 'reports/codex-all-history-audit-summary.json' : 'reports/lane-audit-summary-2026-10-03.json'), JSON.stringify(brief, null, 2) + '\n');
console.log(JSON.stringify({ output, cutoff: brief.cutoff, counts: brief.counts, lanes: brief.lanes }));
