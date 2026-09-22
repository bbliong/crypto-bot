import { readFileSync } from 'fs';
import { join } from 'path';

const dir = 'research/2026-09-22T08-04-30-955Z';
const trades = readFileSync(join(dir, 'simulated-trades.jsonl'), 'utf-8')
  .trim().split('\n').map(l => JSON.parse(l));

const sells = trades.filter(t => t.type === 'SIMULATED_SELL');
const wins = sells.filter(s => s.pnlPercent > 0);
const losses = sells.filter(s => s.pnlPercent <= 0);

console.log(`TOTAL SELLS: ${sells.length}`);
console.log(`WINS: ${wins.length}, LOSSES: ${losses.length}, WIN RATE: ${(wins.length / sells.length * 100).toFixed(1)}%`);

const avgWin = wins.reduce((acc, w) => acc + w.pnlPercent, 0) / (wins.length || 1);
const avgLoss = losses.reduce((acc, l) => acc + l.pnlPercent, 0) / (losses.length || 1);

console.log(`AVG WIN: +${avgWin.toFixed(2)}%, AVG LOSS: ${avgLoss.toFixed(2)}%`);
console.log('\nDETAIL ALL SELLS:');
for (const s of sells) {
  console.log(`  ${(s.metadata?.symbol || s.mint.slice(0, 8)).padEnd(12)}: PnL=${(s.pnlPercent.toFixed(1) + '%').padStart(7)} (${s.reason.padEnd(20)}) entry=${s.entry.priceUsd} exit=${s.exit.priceUsd}`);
}
