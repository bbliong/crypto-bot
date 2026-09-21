import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('Usage: node scripts/finalize-unclosed-paper.mjs <research-run-folder>');
const folder = resolve(run);
const lines = file => existsSync(join(folder, file)) ? readFileSync(join(folder, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const events = lines('simulated-trades.jsonl');
const trades = lines('trades.jsonl');
const buys = events.filter(row => row.type === 'SIMULATED_BUY');
const sold = new Set(events.filter(row => row.type === 'SIMULATED_SELL').map(row => row.mint));
let finalized = 0;
for (const buy of buys) {
  if (sold.has(buy.mint)) continue;
  const last = trades.filter(row => row.mint === buy.mint && Number.isFinite(row.priceUsd) && row.observedAt >= buy.observedAt).at(-1);
  if (!last) continue;
  const quantity = Number(buy.quantity), price = Number(last.priceUsd), stake = Number(buy.stakeUsd);
  if (![quantity, price, stake].every(Number.isFinite) || quantity <= 0 || price <= 0) continue;
  const proceeds = quantity * price, pnlUsd = proceeds - stake;
  appendFileSync(join(folder, 'simulated-trades.jsonl'), JSON.stringify({
    type: 'SIMULATED_SELL', mint: buy.mint, observedAt: Date.now(), reason: 'OBSERVATION_END',
    entry: { openedAt: buy.observedAt, priceUsd: buy.entryPriceUsd, stakeUsd: stake, quantity },
    exit: { priceUsd: price, grossProceedsUsd: proceeds }, pnlUsd, pnlPercent: pnlUsd / stake * 100,
    decision: { priceSource: 'last persisted detail socket tick', priceObservedAt: last.observedAt, finalizer: true },
    assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper-only finalization at the final recorded detail socket price; no order was submitted.' }, metadata: buy.metadata ?? null,
  }) + '\n');
  sold.add(buy.mint); finalized++;
}
const updated = lines('simulated-trades.jsonl'), closed = updated.filter(row => row.type === 'SIMULATED_SELL');
const totalPnlUsd = closed.reduce((sum, row) => sum + (Number(row.pnlUsd) || 0), 0);
writeFileSync(join(folder, 'simulation-summary.json'), JSON.stringify({ observedAt: Date.now(), positionsOpened: buys.length, positionsClosed: closed.length, openAtEnd: buys.length - closed.length, totalStakeUsd: buys.reduce((sum, row) => sum + (Number(row.stakeUsd) || 0), 0), totalPnlUsd, profitable: closed.filter(row => row.pnlUsd > 0).length, losing: closed.filter(row => row.pnlUsd < 0).length, breakEven: closed.filter(row => row.pnlUsd === 0).length, exitsByReason: Object.fromEntries(closed.reduce((map, row) => map.set(row.reason ?? 'UNKNOWN', (map.get(row.reason ?? 'UNKNOWN') ?? 0) + 1), new Map())), assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper simulation only; it does not represent executable net proceeds.' } }, null, 2));
console.log(JSON.stringify({ finalized, positionsOpened: buys.length, positionsClosed: closed.length }));
