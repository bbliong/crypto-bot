import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTokenSocketSession, runBatchEvaluation } from './evaluate-socket-rules-agy.mjs';

const readLines = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const group = rows => {
  const m = new Map();
  for (const r of rows) { if (!m.has(r.mint)) m.set(r.mint, []); m.get(r.mint).push(r); }
  for (const a of m.values()) a.sort((x, y) => x.observedAt - y.observedAt);
  return m;
};

// Empirical swap quote drag measured from 766 paired quote orders in Momentum V2
const EMPIRICAL_ROUNDTRIP_DRAG = 5.43; // %

console.log('=====================================================================');
console.log('   PENGUJIAN RULES PADA DATASET SOCKET 900 TOKEN & MOMENTUM V2');
console.log('=====================================================================\n');

// 1. DATASET 1: Pump-Band 12h Paused Optimizer (916 Token, 355k Ticks, 416k Trades)
console.log('[1/2] Memuat Dataset 1: 916 Token (~772.000 Event Socket)...');
const dir1 = 'research/pump-band-12h-paused-optimizer-2026-09-28T14-50-00Z';
const summaries1 = readLines(join(dir1, 'token-summary.jsonl')).sort((a, b) => a.startedAt - b.startedAt);
const tickMap1 = group(readLines(join(dir1, 'socket-ticks.jsonl')).filter(t => t.source?.startsWith('detail_socket_activity')));
const holderMap1 = group(readLines(join(dir1, 'holder-snapshots.jsonl')));
const tradeMap1 = group(readLines(join(dir1, 'trades.jsonl')));

const sessions1 = summaries1.map(s => buildTokenSocketSession(s, tickMap1.get(s.mint) ?? [], holderMap1.get(s.mint) ?? [], tradeMap1.get(s.mint) ?? []));
console.log(`  -> Berhasil memuat ${sessions1.length} sesi token dari Dataset 1.`);

// 2. DATASET 2: Momentum V2 (WebSocket Trade Tape)
console.log('\n[2/2] Memuat Dataset 2: Momentum V2 (WebSocket Trade Tape)...');
const dir2 = 'research/2026-09-28T10-11-44-620Z';
const trades2 = readLines(join(dir2, 'trades.jsonl'));
const screened2 = readLines(join(dir2, 'screened-tokens.jsonl'));
const tradesByMint2 = new Map();
for (const t of trades2) {
  if (!tradesByMint2.has(t.mint)) tradesByMint2.set(t.mint, []);
  tradesByMint2.get(t.mint).push(t);
}

const sessions2 = [];
for (const s of screened2) {
  const mintTrades = tradesByMint2.get(s.mint) ?? [];
  if (mintTrades.length < 5) continue;
  mintTrades.sort((a, b) => a.observedAt - b.observedAt);
  const ticks = mintTrades.map(t => ({ observedAt: t.observedAt, priceUsd: t.priceUsd }));
  const sessionMeta = {
    mint: s.mint,
    startedAt: mintTrades[0].observedAt,
    endedAt: mintTrades.at(-1).observedAt,
    entryMarketCapUsd: s.initialMarketCapUsd ?? 50000,
    metadata: s.metadata,
  };
  sessions2.push(buildTokenSocketSession(sessionMeta, ticks, [], mintTrades));
}
console.log(`  -> Berhasil memuat ${sessions2.length} sesi token dari WebSocket Tape Momentum V2.`);

// Define rules to test:
const rulesToTest = [
  {
    name: 'AGY Runner (Trailing 1%, Activation 2%, MaxTop1 40%)',
    buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.75, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
    sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 1, takeProfit: null },
  },
  {
    name: 'AGY Scalp WinRate (Target +3%, Activation 2%, MaxTop1 40%)',
    buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.75, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
    sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 2, takeProfit: 3 },
  },
  {
    name: 'AGY Pure Socket Momentum (Tanpa Holder, BuyShare 75%, Min 3 Buyers)',
    buy: { entryReturn: 1.0, momentum1s: 0.5, maxDrawdown: -2, minBuyShare: 0.75, minBuyers: 3, maxTop1: 'off', maxRange3: 5, maxMarketCap: 300000 },
    sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 1.5, takeProfit: 3, maxHoldSeconds: 60 },
  },
];

console.log('\n=====================================================================');
console.log('   HASIL EVALUASI DENGAN DELAY 500MS & SLIPPAGE NYATA (-5.43%)');
console.log('=====================================================================');

for (const rule of rulesToTest) {
  console.log(`\n>>> Rule: ${rule.name}`);

  // Test on Dataset 1
  const res1 = runBatchEvaluation(sessions1, rule.buy, rule.sell, 500);
  const s1 = res1.summary;
  const realMean1 = s1.meanReturn - EMPIRICAL_ROUNDTRIP_DRAG;
  const realWins1 = res1.trades.filter(t => t.ret - EMPIRICAL_ROUNDTRIP_DRAG > 0).length;

  console.log(`  [Dataset 1 - 916 Token]:`);
  console.log(`    - Sinyal Buy Terpenuhi: ${s1.filledBuys} token`);
  console.log(`    - Di Socket Paper (500ms delay): WinRate ${s1.winRate.toFixed(1)}% (${s1.wins}W / ${s1.losses}L) | Mean: +${s1.meanReturn.toFixed(2)}% | Worst: ${s1.worstLoss.toFixed(2)}% | Best: +${s1.bestGain.toFixed(2)}%`);
  console.log(`    - Setelah Gesekan Swap Nyata (-5.43%): Real WinRate ${(realWins1 / (s1.filledBuys || 1) * 100).toFixed(1)}% | Real Net Mean: ${realMean1 >= 0 ? '+' : ''}${realMean1.toFixed(2)}%`);

  // Test on Dataset 2
  const res2 = runBatchEvaluation(sessions2, rule.buy, rule.sell, 500);
  const s2 = res2.summary;
  const realMean2 = s2.meanReturn - EMPIRICAL_ROUNDTRIP_DRAG;
  const realWins2 = res2.trades.filter(t => t.ret - EMPIRICAL_ROUNDTRIP_DRAG > 0).length;

  console.log(`  [Dataset 2 - Momentum V2 WebSocket Tape]:`);
  console.log(`    - Sinyal Buy Terpenuhi: ${s2.filledBuys} token`);
  console.log(`    - Di Socket Paper (500ms delay): WinRate ${s2.winRate.toFixed(1)}% (${s2.wins}W / ${s2.losses}L) | Mean: ${s2.meanReturn >= 0 ? '+' : ''}${s2.meanReturn.toFixed(2)}% | Worst: ${s2.worstLoss.toFixed(2)}% | Best: +${s2.bestGain.toFixed(2)}%`);
  console.log(`    - Setelah Gesekan Swap Nyata (-5.43%): Real WinRate ${(realWins2 / (s2.filledBuys || 1) * 100).toFixed(1)}% | Real Net Mean: ${realMean2 >= 0 ? '+' : ''}${realMean2.toFixed(2)}%`);
}

console.log('\n[SELESAI] Pengujian pada kedua dataset berhasil dijalankan.');
