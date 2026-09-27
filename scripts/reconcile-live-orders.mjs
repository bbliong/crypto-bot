import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/reconcile-live-orders.mjs <research-run-folder>');
const folder = resolve(input);
const lines = file => {
  const path = join(folder, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    try { return [JSON.parse(line)]; }
    catch { console.warn(`[reconcile] ignoring invalid ${file}:${index + 1}`); return []; }
  });
};
const pct = (value, base) => value > 0 && base > 0 ? (value / base - 1) * 100 : null;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const signals = lines('trade-signals.jsonl');
const orders = lines('live-trade-ledger.jsonl').filter(row => row.type === 'LIVE_ORDER_SUBMITTED');
const quotes = lines('live-trade-ledger.jsonl').filter(row => row.type === 'LIVE_ROUTE_QUOTE');
const trades = lines('trades.jsonl').filter(row => Number.isFinite(row.priceUsd) && row.priceUsd > 0);
const walletSnapshots = lines('live-trade-ledger.jsonl').filter(row => row.type === 'GMGN_WALLETSTAT_SNAPSHOT');
const signalById = new Map(signals.map(signal => [signal.signalId, signal]));
const tradesByMint = new Map();
for (const trade of trades) {
  const rows = tradesByMint.get(trade.mint) ?? [];
  rows.push(trade); tradesByMint.set(trade.mint, rows);
}
for (const rows of tradesByMint.values()) rows.sort((a, b) => a.observedAt - b.observedAt);

function matchingQuote(order) {
  const candidates = quotes.filter(quote => quote.side === order.side && quote.mint === order.mint && quote.observedAt <= order.observedAt);
  return candidates.at(-1) ?? null;
}
function matchingSocketTrade(order) {
  const rows = tradesByMint.get(order.mint) ?? [];
  if (order.hash) {
    const exact = rows.find(row => row.signature === order.hash);
    if (exact) return { row: exact, confidence: 'EXACT_SIGNATURE' };
  }
  const near = rows.filter(row => row.observedAt >= order.observedAt - 1_000 && row.observedAt <= order.observedAt + 5_000)
    .sort((a, b) => Math.abs(a.observedAt - order.observedAt) - Math.abs(b.observedAt - order.observedAt))[0];
  return near ? { row: near, confidence: 'NEAREST_SOCKET_TICK' } : { row: null, confidence: 'NO_SOCKET_TICK' };
}
function matchingWalletSnapshot(order) {
  const afterOrder = walletSnapshots.filter(row => row.token === order.mint && row.observedAt >= order.observedAt);
  const expectedStage = order.side === 'BUY' ? 'POST_BUY' : 'POST_SELL';
  return afterOrder.find(row => row.stage === expectedStage) ?? afterOrder[0] ?? null;
}

const reconciledOrders = orders.map(order => {
  const signal = signalById.get(order.signalId) ?? null;
  const socket = matchingSocketTrade(order);
  const quote = matchingQuote(order);
  const wallet = matchingWalletSnapshot(order);
  return {
    side: order.side, mint: order.mint, signalId: order.signalId ?? null, positionId: order.positionId ?? null,
    orderId: order.orderId ?? null, hash: order.hash ?? null, submittedAt: order.observedAt ?? null,
    signalAt: signal?.decisionAt ?? null, signalPriceUsd: signal?.priceUsd ?? order.tokenPriceUsd ?? null,
    submitDelayMs: signal?.decisionAt && order.observedAt ? order.observedAt - signal.decisionAt : null,
    socket: socket.row ? {
      observedAt: socket.row.observedAt, priceUsd: socket.row.priceUsd, signature: socket.row.signature ?? null,
      confidence: socket.confidence,
      signalToSocketMs: signal?.decisionAt ? socket.row.observedAt - signal.decisionAt : null,
      priceChangeFromSignalPercent: signal?.priceUsd ? pct(socket.row.priceUsd, signal.priceUsd) : null,
    } : { confidence: socket.confidence },
    quote: quote ? {
      observedAt: quote.observedAt, amountInUsd: quote.amountInUsd ?? null, amountOutUsd: quote.amountOutUsd ?? null,
      priceImpactPct: quote.quote?.priceImpactPct ?? null, platformFeeUsdEstimate: quote.fees?.platformFeeUsdEstimate ?? null,
    } : null,
    wallet: wallet ? {
      observedAt: wallet.observedAt, stage: wallet.stage ?? null, balance: wallet.balance ?? null,
      historyBoughtCostUsd: wallet.historyBoughtCostUsd ?? null, historySoldIncomeUsd: wallet.historySoldIncomeUsd ?? null,
      grossPnlUsd: wallet.grossPnlUsd ?? null, reportedRealizedProfitUsd: wallet.reportedRealizedProfitUsd ?? null,
      reportedGasUsd: wallet.reportedGasUsd ?? null,
    } : null,
  };
});

const paired = new Map();
for (const order of reconciledOrders) {
  if (!order.positionId) continue;
  const pair = paired.get(order.positionId) ?? { positionId: order.positionId, mint: order.mint };
  pair[order.side.toLowerCase()] = order; paired.set(order.positionId, pair);
}
const positions = [...paired.values()].map(pair => {
  const buy = pair.buy, sell = pair.sell;
  const signalReturnPercent = buy?.signalPriceUsd && sell?.signalPriceUsd ? pct(sell.signalPriceUsd, buy.signalPriceUsd) : null;
  const socketReturnPercent = buy?.socket?.priceUsd && sell?.socket?.priceUsd ? pct(sell.socket.priceUsd, buy.socket.priceUsd) : null;
  return {
    ...pair,
    signalReturnPercent, socketReturnPercent,
    socketMinusSignalPercent: signalReturnPercent !== null && socketReturnPercent !== null ? socketReturnPercent - signalReturnPercent : null,
    evidence: buy?.socket?.confidence === 'EXACT_SIGNATURE' && sell?.socket?.confidence === 'EXACT_SIGNATURE'
      ? 'SOCKET_MATCHED_BOTH_ORDERS' : 'PARTIAL_SOCKET_EVIDENCE',
  };
});
const completed = positions.filter(row => row.socketReturnPercent !== null);
const output = {
  generatedAt: new Date().toISOString(), run: basename(folder),
  caveat: 'Socket return uses the activity tick whose signature equals the submitted GMGN order hash when available. It is execution evidence, but not a final settled on-chain fill or fee-inclusive P/L.',
  orders: reconciledOrders, positions,
  summary: {
    submittedOrders: reconciledOrders.length, pairedPositions: positions.length, exactSignatureOrders: reconciledOrders.filter(row => row.socket?.confidence === 'EXACT_SIGNATURE').length,
    completeSocketPairs: completed.length,
    averageBuySignalToSocketMs: average(reconciledOrders.filter(row => row.side === 'BUY').map(row => row.socket?.signalToSocketMs).filter(Number.isFinite)),
    averageSellSignalToSocketMs: average(reconciledOrders.filter(row => row.side === 'SELL').map(row => row.socket?.signalToSocketMs).filter(Number.isFinite)),
    medianSellSignalToSocketMs: median(reconciledOrders.filter(row => row.side === 'SELL').map(row => row.socket?.signalToSocketMs).filter(Number.isFinite)),
    averageSignalReturnPercent: average(completed.map(row => row.signalReturnPercent)),
    averageSocketReturnPercent: average(completed.map(row => row.socketReturnPercent)),
    averageSocketMinusSignalPercent: average(completed.map(row => row.socketMinusSignalPercent)),
  },
};
const outputPath = join(folder, 'execution-reconciliation.json');
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ output: outputPath, summary: output.summary }, null, 2));
