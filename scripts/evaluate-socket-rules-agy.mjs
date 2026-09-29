import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Utility functions
const finite = x => typeof x === 'number' && Number.isFinite(x);
const readLines = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

/**
 * Deduplicate trade events by exact signature fields.
 */
export function deduplicateTrades(trades) {
  const seen = new Set();
  return [...trades].sort((a, b) => a.observedAt - b.observedAt).filter(t => {
    const key = JSON.stringify([t.mint, t.wallet, t.side, t.occurredAt, t.priceUsd, t.amountUsd]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Build rich per-token state from socket tick stream, trade stream, and holder snapshots.
 */
export function buildTokenSocketSession(s, inputTicks, inputHolders = [], inputTrades = []) {
  const ticks = inputTicks
    .filter(t => t.observedAt >= s.startedAt && t.observedAt <= s.endedAt && finite(t.priceUsd) && t.priceUsd > 0)
    .sort((a, b) => a.observedAt - b.observedAt);

  const holders = inputHolders
    .filter(h => h.observedAt >= s.startedAt && h.status === 200 && finite(h.top1Percent) && Array.isArray(h.queryKeys) && !h.queryKeys.includes('tag'))
    .sort((a, b) => a.observedAt - b.observedAt);

  const trades = deduplicateTrades(inputTrades.filter(t => t.observedAt >= s.startedAt && t.observedAt <= s.endedAt));

  let hp = -1, tp = 0, peak = 0, up = 0, activeTrades = [];
  const highs = [], lows = [];
  let highHead = 0, lowHead = 0;
  const anchors = { 1: -1, 3: -1, 5: -1 };
  const points = [];

  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i], at = t.observedAt, price = t.priceUsd;
    while (hp + 1 < holders.length && holders[hp + 1].observedAt < at) hp++;
    const h = holders[hp];

    peak = Math.max(peak, price);
    up = i > 0 && price > ticks[i - 1].priceUsd ? up + 1 : 0;

    while (highs.length > highHead && ticks[highs.at(-1)].priceUsd <= price) highs.pop();
    while (lows.length > lowHead && ticks[lows.at(-1)].priceUsd >= price) lows.pop();
    highs.push(i); lows.push(i);
    while (highs[highHead] < i && ticks[highs[highHead]].observedAt < at - 3000) highHead++;
    while (lows[lowHead] < i && ticks[lows[lowHead]].observedAt < at - 3000) lowHead++;

    const returns = {};
    for (const seconds of [1, 3, 5]) {
      while (anchors[seconds] + 1 < i && ticks[anchors[seconds] + 1].observedAt <= at - seconds * 1000) anchors[seconds]++;
      const a = ticks[anchors[seconds]];
      returns[seconds] = a && at - seconds * 1000 - a.observedAt <= 2000 ? (price / a.priceUsd - 1) * 100 : null;
    }

    while (tp < trades.length && trades[tp].observedAt <= at) activeTrades.push(trades[tp++]);
    activeTrades = activeTrades.filter(tr => tr.occurredAt >= at - 5000);
    const flow = activeTrades.filter(tr => tr.occurredAt <= at && finite(tr.amountUsd) && tr.amountUsd >= 0);
    const buys = flow.filter(tr => tr.side === 'buy'), sells = flow.filter(tr => tr.side === 'sell');
    const buyUsd = buys.reduce((sum, tr) => sum + tr.amountUsd, 0);
    const sellUsd = sells.reduce((sum, tr) => sum + tr.amountUsd, 0);

    points.push({
      i,
      at,
      price,
      ret: (price / ticks[0].priceUsd - 1) * 100,
      dd: (price / peak - 1) * 100,
      returns,
      up,
      range3: (ticks[highs[highHead]].priceUsd / ticks[lows[lowHead]].priceUsd - 1) * 100,
      top1: h && at - h.observedAt <= 30000 ? h.top1Percent : null,
      holderAt: h?.observedAt ?? null,
      buyShare: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) : null,
      buyUsd,
      sellUsd,
      uniqueBuyers: new Set(buys.map(tr => tr.wallet).filter(Boolean)).size,
      uniqueSellers: new Set(sells.map(tr => tr.wallet).filter(Boolean)).size,
      flowTrades: flow.length,
    });
  }

  return {
    mint: s.mint,
    symbol: s.metadata?.symbol ?? s.mint,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    mc: s.entryMarketCapUsd,
    points,
    ticksCount: ticks.length,
    tradesCount: trades.length,
    suspect: ticks.some((t, i) => i > 0 && t.priceUsd / ticks[i - 1].priceUsd > 100),
  };
}

/**
 * Check if a single incoming socket tick qualifies for BUY.
 */
export function checkSocketBuyCondition(p, s, rules) {
  // Market cap filter
  if (finite(rules.minMarketCap) && (!finite(s.mc) || s.mc < rules.minMarketCap)) return false;
  if (finite(rules.maxMarketCap) && (!finite(s.mc) || s.mc > rules.maxMarketCap)) return false;

  // Price return from initial socket tick
  if (finite(rules.entryReturn) && p.ret < rules.entryReturn) return false;

  // Rolling momentum
  if (finite(rules.momentum1s) && (p.returns[1] === null || p.returns[1] < rules.momentum1s)) return false;
  if (finite(rules.momentum3s) && (p.returns[3] === null || p.returns[3] < rules.momentum3s)) return false;
  if (finite(rules.momentum5s) && (p.returns[5] === null || p.returns[5] < rules.momentum5s)) return false;

  // Maximum allowed drawdown from observed peak
  if (finite(rules.maxDrawdown) && p.dd < rules.maxDrawdown) return false;

  // Minimum consecutive rising ticks
  if (finite(rules.risingTicks) && p.up < rules.risingTicks) return false;

  // Volatility range
  if (finite(rules.maxRange3) && p.range3 > rules.maxRange3) return false;

  // Trade flow rules
  if (finite(rules.minBuyShare) && (p.buyShare === null || p.buyShare < rules.minBuyShare)) return false;
  if (finite(rules.minBuyers) && p.uniqueBuyers < rules.minBuyers) return false;
  if (finite(rules.minTrades) && p.flowTrades < rules.minTrades) return false;

  // Optional Top-1 holder filter
  if (rules.maxTop1 !== null && rules.maxTop1 !== 'off' && finite(rules.maxTop1)) {
    if (p.top1 === null || p.top1 > rules.maxTop1) return false;
  }

  return true;
}

/**
 * Evaluates a token's socket stream tick-by-tick and simulates trading.
 */
export function evaluateTokenSocketStream(session, buyRules, sellRules, latencyMs = 0) {
  const points = session.points;
  if (!points || points.length < 2) return null;

  let since = null, prevPoint = null, entryIndex = -1;

  // Tick-by-tick streaming evaluation for BUY
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const qualified = checkSocketBuyCondition(p, session, buyRules);

    if (!qualified) {
      since = null;
      prevPoint = p;
      continue;
    }

    if (since === null || !prevPoint || p.i !== prevPoint.i + 1 || p.at - prevPoint.at > 2000) {
      since = p.at;
    }

    if (p.at - since >= (buyRules.confirmMs ?? 0)) {
      entryIndex = i;
      break;
    }
    prevPoint = p;
  }

  if (entryIndex < 0) return null; // No buy signal triggered

  const signal = points[entryIndex];
  let buyIndex = entryIndex;

  // Account for execution latency
  if (latencyMs > 0) {
    buyIndex = points.findIndex((p, idx) => idx >= entryIndex && p.at >= signal.at + latencyMs);
    if (buyIndex < 0) return { unfilled: true, symbol: session.symbol, mint: session.mint };
  }

  const buy = points[buyIndex];
  let peak = 0, neg = 0, lastWindow = -Infinity;

  const makeResult = (exitPoint, reason, exitSignalAt) => {
    const rawRet = (exitPoint.price / buy.price - 1) * 100;
    return {
      symbol: session.symbol,
      mint: session.mint,
      entrySignalAt: signal.at,
      buyAt: buy.at,
      buyPrice: buy.price,
      mc: session.mc,
      exitSignalAt,
      exitAt: exitPoint.at,
      exitPrice: exitPoint.price,
      heldSeconds: (exitPoint.at - buy.at) / 1000,
      reason,
      rawRet,
      ret: session.suspect && rawRet > 0 ? 0 : rawRet,
      latencyMs,
    };
  };

  // Tick-by-tick streaming evaluation for SELL
  for (let j = buyIndex + 1; j < points.length; j++) {
    const p = points[j];
    const r = (p.price / buy.price - 1) * 100;
    peak = Math.max(peak, r);
    let reason = null;

    // Hard stop loss
    if (finite(sellRules.hardStop) && peak < sellRules.activation && r <= -sellRules.hardStop) {
      reason = 'HARD_STOP';
    }
    // Profit activation + trailing stop lock
    else if (finite(sellRules.activation) && peak >= sellRules.activation) {
      const trailFloor = (100 + peak) * (1 - (sellRules.trailing ?? 2) / 100) - 100;
      const lockFloor = sellRules.lock ?? 0.5;
      if (r <= Math.max(lockFloor, trailFloor)) {
        reason = 'PROFIT_LOCK_TRAILING';
      }
    }

    // Fixed Take Profit target
    if (!reason && finite(sellRules.takeProfit) && r >= sellRules.takeProfit) {
      reason = 'TAKE_PROFIT';
    }

    // Time-based exit limit
    if (!reason && finite(sellRules.maxHoldSeconds) && p.at - buy.at >= sellRules.maxHoldSeconds * 1000) {
      reason = 'TIME_LIMIT';
    }

    // Flow reversal exit
    if (!reason && sellRules.flowExit && p.flowTrades >= 3 && p.buyShare !== null && p.buyShare < 0.35 && p.returns[3] !== null && p.returns[3] < 0) {
      reason = 'SELL_FLOW_DOMINATES';
    }

    // Consecutive negative momentum windows
    if (!reason && sellRules.negativeWindows > 0 && p.at - lastWindow >= 4500 && p.returns[5] !== null) {
      neg = p.returns[5] < 0 ? neg + 1 : 0;
      lastWindow = p.at;
      if (neg >= sellRules.negativeWindows && r > 0) {
        reason = 'NEGATIVE_MOMENTUM';
      }
    }

    if (reason) {
      if (latencyMs === 0) return makeResult(p, reason, p.at);
      const fill = points.find((v, k) => k >= j && v.at >= p.at + latencyMs);
      return fill ? makeResult(fill, reason, p.at) : makeResult(points.at(-1), 'CAPTURE_END_PENDING_SELL', p.at);
    }
  }

  return makeResult(points.at(-1), 'CAPTURE_END_MARK_ONLY', points.at(-1).at);
}

/**
 * Summarize batch trading results.
 */
export function summarizeBatch(trades, assumedFeePercent = 1.0) {
  const filled = trades.filter(t => t && !t.unfilled);
  const rets = filled.map(t => t.ret);
  const n = rets.length;
  const wins = rets.filter(x => x > 0).length;
  const losses = rets.filter(x => x < 0).length;
  const total = rets.reduce((a, b) => a + b, 0);
  const grossLoss = -rets.filter(x => x < 0).reduce((a, b) => a + b, 0);
  const grossProfit = rets.filter(x => x > 0).reduce((a, b) => a + b, 0);

  return {
    totalSignals: trades.length,
    filledBuys: n,
    wins,
    losses,
    winRate: n > 0 ? (wins / n) * 100 : 0,
    meanReturn: n > 0 ? total / n : 0,
    netReturnAfterFee: n > 0 ? total / n - assumedFeePercent : 0,
    totalProfitPoints: total,
    grossProfit,
    grossLoss,
    worstLoss: n > 0 ? Math.min(...rets) : 0,
    bestGain: n > 0 ? Math.max(...rets) : 0,
    withoutLargestWinnerMean: n > 1 ? (total - Math.max(...rets)) / (n - 1) : 0,
    unfilled: trades.filter(t => t?.unfilled).length,
  };
}

/**
 * Run evaluation across all tokens.
 */
export function runBatchEvaluation(sessions, buyRules, sellRules, latencyMs = 500) {
  const trades = [];
  for (const session of sessions) {
    const trade = evaluateTokenSocketStream(session, buyRules, sellRules, latencyMs);
    if (trade) trades.push(trade);
  }
  const summary = summarizeBatch(trades);
  return { buyRules, sellRules, latencyMs, summary, trades };
}

async function main() {
  const input = process.argv[2] ?? 'research/pump-band-12h-paused-optimizer-2026-09-28T14-50-00Z';
  const mode = process.argv[3] ?? 'all'; // 'winRate', 'runner', 'pureSocket', or 'all'

  console.log(`[EVALUATE-SOCKET] Loading sessions from ${input}...`);
  const group = rows => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.mint)) m.set(r.mint, []); m.get(r.mint).push(r); }
    for (const a of m.values()) a.sort((x, y) => x.observedAt - y.observedAt);
    return m;
  };

  const summaries = readLines(join(input, 'token-summary.jsonl')).sort((a, b) => a.startedAt - b.startedAt);
  const tickMap = group(readLines(join(input, 'socket-ticks.jsonl')).filter(t => t.source?.startsWith('detail_socket_activity')));
  const holderMap = group(readLines(join(input, 'holder-snapshots.jsonl')));
  const tradeMap = group(readLines(join(input, 'trades.jsonl')));

  const sessions = summaries.map(s => buildTokenSocketSession(s, tickMap.get(s.mint) ?? [], holderMap.get(s.mint) ?? [], tradeMap.get(s.mint) ?? []));
  console.log(`[EVALUATE-SOCKET] Loaded ${sessions.length} token sessions. Evaluating tick-by-tick...`);

  // Presets
  const presets = {
    winRate: {
      label: '1. AGY Scalp WinRate (Target +3%, MaxTop1 40%)',
      buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.75, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
      sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 2, takeProfit: 3 },
    },
    runner: {
      label: '2. AGY Runner Profit (Trailing 1%, MaxTop1 40%, No TP Cap)',
      buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.75, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
      sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 1, takeProfit: null },
    },
    pureSocketScalp: {
      label: '3. Pure Socket Scalp (No Holder Check, 1s Momentum + 75% Buy Flow)',
      buy: { entryReturn: 1, momentum1s: 0.5, maxDrawdown: -2, minBuyShare: 0.75, minBuyers: 3, maxTop1: 'off', maxRange3: 5, maxMarketCap: 300000 },
      sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 1.5, takeProfit: 3, maxHoldSeconds: 60 },
    },
    adaptiveRunner: {
      label: '4. AGY Adaptive Runner V3 (Anti-Choke Act 3.5%, Lock 2%, Pure Flow 90%, Flow Exit)',
      buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.90, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
      sell: { hardStop: 3, activation: 3.5, lock: 2.0, trailing: 1.0, takeProfit: null, flowExit: true },
    },
  };

  const toRun = mode === 'all' ? Object.entries(presets) : [[mode, presets[mode] ?? presets.winRate]];

  for (const [key, config] of toRun) {
    console.log(`\n=====================================================================`);
    console.log(`Preset: ${config.label}`);
    console.log(`BUY Rules:`, config.buy);
    console.log(`SELL Rules:`, config.sell);
    console.log(`---------------------------------------------------------------------`);

    for (const latency of [0, 250, 500]) {
      const result = runBatchEvaluation(sessions, config.buy, config.sell, latency);
      const s = result.summary;
      console.log(`[Latency ${latency}ms] Buys: ${s.filledBuys} | WinRate: ${s.winRate.toFixed(1)}% (${s.wins}W / ${s.losses}L) | Mean: ${s.meanReturn >= 0 ? '+' : ''}${s.meanReturn.toFixed(2)}% | Net after 1% Fee: ${s.netReturnAfterFee >= 0 ? '+' : ''}${s.netReturnAfterFee.toFixed(2)}% | Worst: ${s.worstLoss.toFixed(2)}% | Best: +${s.bestGain.toFixed(2)}%`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

