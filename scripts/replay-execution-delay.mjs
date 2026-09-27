import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const input = args.find(arg => !arg.startsWith('--'));
const delaysArg = args.find(arg => arg.startsWith('--delays='))?.slice('--delays='.length) ?? '500,1000,2000,3000';
if (!input) throw new Error('Usage: node scripts/replay-execution-delay.mjs <research-run-folder> [--delays=500,1000,2000,3000]');
const delays = [...new Set(delaysArg.split(',').map(Number).filter(value => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b);
if (!delays.length) throw new Error('Provide one or more non-negative integer delay milliseconds.');
const folder = resolve(input);
const lines = file => {
  const path = join(folder, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
};
const signals = lines('trade-signals.jsonl').filter(row => row.paperLane === 'control');
const trades = lines('trades.jsonl').filter(row => Number.isFinite(row.priceUsd) && row.priceUsd > 0);
const byMint = new Map();
for (const trade of trades) {
  const rows = byMint.get(trade.mint) ?? [];
  rows.push(trade); byMint.set(trade.mint, rows);
}
for (const rows of byMint.values()) rows.sort((a, b) => a.observedAt - b.observedAt);
const pct = (value, base) => value > 0 && base > 0 ? (value / base - 1) * 100 : null;
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
function firstPriceAtOrAfter(mint, at) {
  return (byMint.get(mint) ?? []).find(row => row.observedAt >= at) ?? null;
}
const pairs = new Map();
for (const signal of signals) {
  const pair = pairs.get(signal.positionId) ?? { positionId: signal.positionId, mint: signal.mint };
  pair[signal.side.toLowerCase()] = signal; pairs.set(signal.positionId, pair);
}
const positions = [...pairs.values()].filter(pair => pair.buy && pair.sell);
const scenarios = delays.map(delayMs => {
  const rows = positions.map(pair => {
    const buyAt = pair.buy.decisionAt + delayMs, sellAt = pair.sell.decisionAt + delayMs;
    const buyTick = firstPriceAtOrAfter(pair.mint, buyAt), sellTick = firstPriceAtOrAfter(pair.mint, sellAt);
    const replayReturnPercent = buyTick && sellTick ? pct(sellTick.priceUsd, buyTick.priceUsd) : null;
    return {
      positionId: pair.positionId, mint: pair.mint, delayMs,
      signal: { buyAt: pair.buy.decisionAt, buyPriceUsd: pair.buy.priceUsd, sellAt: pair.sell.decisionAt, sellPriceUsd: pair.sell.priceUsd, returnPercent: pct(pair.sell.priceUsd, pair.buy.priceUsd) },
      delayed: { buyTargetAt: buyAt, buyTickAt: buyTick?.observedAt ?? null, buyPriceUsd: buyTick?.priceUsd ?? null, sellTargetAt: sellAt, sellTickAt: sellTick?.observedAt ?? null, sellPriceUsd: sellTick?.priceUsd ?? null, returnPercent: replayReturnPercent },
      status: buyTick && sellTick ? 'PRICED' : 'NO_FRESH_SOCKET_TICK_AFTER_DELAY',
    };
  });
  const priced = rows.filter(row => row.status === 'PRICED');
  return {
    delayMs, rows,
    summary: {
      positions: rows.length, priced: priced.length, unpriced: rows.length - priced.length,
      averageReturnPercent: average(priced.map(row => row.delayed.returnPercent)),
      medianReturnPercent: median(priced.map(row => row.delayed.returnPercent)),
      profitable: priced.filter(row => row.delayed.returnPercent > 0).length,
      losing: priced.filter(row => row.delayed.returnPercent < 0).length,
    },
  };
});
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2;
}
const output = {
  generatedAt: new Date().toISOString(), run: basename(folder), delays,
  method: 'Historical-signal replay. It preserves entry and exit decisions recorded by the run, then replaces each signal price with the first socket tick received at or after decisionAt + delay. It measures execution-latency exposure; it does not recompute exit decisions from delayed positions.',
  scenarios,
};
const outputPath = join(folder, 'execution-delay-replay.json');
writeFileSync(outputPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ output: outputPath, scenarios: scenarios.map(row => ({ delayMs: row.delayMs, ...row.summary })) }, null, 2));
