import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const laneLabels = {
  control: 'Raw Aggressive',
  'aggressive-safe': 'Safe Aggressive',
  'aggressive-optimal': 'Optimal Aggressive',
  'aggressive-wide': 'Wide Aggressive',
  'aggressive-swing-100k': 'Swing 100k Aggressive',
  'aggressive-wave': 'Wave Scalper Aggressive',
  'adaptive-wave': 'Adaptive Wave V1',
  'momentum-v2': 'Momentum V2',
  'momentum-v3': 'Momentum V3',
  'r5-band': 'Momentum R5 Band',
};

const fingerprint = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

// Cache only the two small inputs for the selected live run. Stat on every request
// so appends, truncation and replacement are visible without a TTL delay.
export function createLiveTradesReader({ readFile = readFileSync, stat = statSync } = {}) {
  const cache = new Map();
  function readRows(file) {
    try {
      const before = fingerprint(stat(file));
      const cached = cache.get(file);
      if (cached?.fingerprint === before) return cached.rows;
      const rows = [];
      for (const line of readFile(file, 'utf8').split(/\r?\n/)) {
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
        } catch { /* Skip malformed or incomplete lines; re-read after an append. */ }
      }
      // A concurrent append must not cache an older snapshot under a newer stat.
      cache.delete(file);
      if (fingerprint(stat(file)) === before) {
        cache.set(file, { fingerprint: before, rows });
        if (cache.size > 2) cache.delete(cache.keys().next().value);
      }
      return rows;
    } catch {
      cache.delete(file);
      return [];
    }
  }

  return function getLiveClosedTrades(runDir, fallbackStake = 0.5) {
    const events = readRows(join(runDir, 'simulated-trades.jsonl'));
    // Optional quote enrichment preserves the existing swap columns. Network
    // payload/audit logs and the full dashboard aggregator are never needed here.
    const quotes = readRows(join(runDir, 'quote-simulated-orders.jsonl'));
    const buys = events.filter(row => row.type === 'SIMULATED_BUY' && typeof row.mint === 'string' && Number.isFinite(row.observedAt));
    const sells = events.filter(row => row.type === 'SIMULATED_SELL' && typeof row.mint === 'string' && Number.isFinite(row.observedAt));
    const sellsByPosition = new Map(sells.filter(row => row.positionId).map(row => [row.positionId, row]));
    const quotesByPosition = new Map();
    for (const quote of quotes) {
      if (!quote.positionId) continue;
      const list = quotesByPosition.get(quote.positionId) || [];
      list.push(quote);
      quotesByPosition.set(quote.positionId, list);
    }

    const trades = [];
    for (const buy of buys) {
      const lane = buy.paperLane || 'control';
      const positionId = buy.positionId || `${buy.mint}:${buy.observedAt}:${lane}`;
      // Legacy sells include entry.openedAt even when positionId is absent.
      // Never let another position/lane's exit close a still-open live trade.
      const sell = sellsByPosition.get(positionId) || sells.find(row =>
        !row.positionId && row.mint === buy.mint && (row.paperLane || 'control') === lane &&
        row.observedAt >= buy.observedAt &&
        (row.entry?.openedAt != null ? row.entry.openedAt === buy.observedAt :
          buys.filter(b => b.mint === buy.mint && (b.paperLane || 'control') === lane).length === 1));
      if (!sell) continue;

      const exitPrice = sell.exit?.priceUsd ?? sell.timing?.priceUsd ?? sell.decision?.priceUsd ?? sell.exitPriceUsd ?? null;
      const socketReturn = sell.pnlPercent ?? (exitPrice != null && buy.entryPriceUsd > 0 ? (exitPrice / buy.entryPriceUsd - 1) * 100 : 0);
      const stakeUsd = buy.stakeUsd || fallbackStake;
      const tradePnlUsd = stakeUsd * socketReturn / 100;
      const positionQuotes = quotesByPosition.get(positionId) || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:control`) || [];
      const buyQuote = positionQuotes.find(q => q.type === 'QUOTE_BUY_COMPARISON');
      const sellQuote = positionQuotes.find(q => q.type === 'QUOTE_SELL_COMPARISON');
      const inUsd = Number(buyQuote?.quote?.amountInUsd || 0);
      const outUsd = Number(sellQuote?.quote?.amountOutUsd || 0);
      const hasExactSwapFill = inUsd > 0 && outUsd > 0;
      // Keep the historical dashboard's estimate when route quotes are absent.
      const realReturn = hasExactSwapFill ? (outUsd / inUsd - 1) * 100 : socketReturn - 3.5;
      const swapPnlUsd = hasExactSwapFill ? outUsd - inUsd : (sell.pnlUsd ?? stakeUsd * realReturn / 100);
      const symbol = buy.metadata?.symbol || buy.symbol || buy.mint.slice(0, 6);

      trades.push({
        positionId, mint: buy.mint, lane, laneLabel: laneLabels[lane] || lane,
        symbol, name: buy.metadata?.name || symbol, worker: buy.worker ?? 1,
        status: 'CLOSED', entryPrice: buy.entryPriceUsd, entryTime: buy.observedAt,
        exitPrice, exitTime: sell.observedAt,
        durationSec: Math.max(1, Math.round((sell.observedAt - buy.observedAt) / 1000)),
        exitReason: sell.exitReason || sell.reason || 'UNKNOWN',
        tradeReturnPercent: socketReturn, socketReturnPercent: socketReturn,
        realReturnPercent: realReturn, tradePnlUsd, swapPnlUsd, pnlUsd: tradePnlUsd,
        isWin: socketReturn > 0, isSocketWin: socketReturn > 0, isRealWin: realReturn > 0,
        swapRoute: {
          hasBuy: !!buyQuote, hasSell: !!sellQuote,
          buyTime: buyQuote?.observedAt || buy.observedAt,
          buyInSol: buyQuote?.inputAmountBaseUnits ? (Number(buyQuote.inputAmountBaseUnits) / 1e9).toFixed(4) + ' SOL' : null,
          buyInUsd: inUsd > 0 ? '$' + inUsd.toFixed(4) : null,
          buyOutTokens: buyQuote?.routeTokenAmount ? Math.round(buyQuote.routeTokenAmount).toLocaleString() : null,
          buySlippage: buyQuote?.routeVsSocketPricePercent != null ? (buyQuote.routeVsSocketPricePercent >= 0 ? '+' : '') + buyQuote.routeVsSocketPricePercent.toFixed(2) + '%' : '—',
          buyLatencyMs: buyQuote?.latencyMs,
          sellTime: sellQuote?.observedAt || sell.observedAt,
          sellInTokens: sellQuote?.inputAmountBaseUnits ? Math.round(Number(sellQuote.inputAmountBaseUnits) / 10**(sellQuote.tokenDecimals || 6)).toLocaleString() : null,
          sellOutSol: sellQuote?.quote?.outAmount ? (Number(sellQuote.quote.outAmount) / 1e9).toFixed(4) + ' SOL' : null,
          sellOutUsd: outUsd > 0 ? '$' + outUsd.toFixed(4) : null,
          sellSlippage: sellQuote?.routeVsSocketProceedsPercent != null ? (sellQuote.routeVsSocketProceedsPercent >= 0 ? '+' : '') + sellQuote.routeVsSocketProceedsPercent.toFixed(2) + '%' : '—',
          sellLatencyMs: sellQuote?.latencyMs,
        },
      });
    }
    return trades.sort((a, b) => (b.exitTime || b.entryTime) - (a.exitTime || a.entryTime));
  };
}
