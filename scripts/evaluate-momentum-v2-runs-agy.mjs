import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildTokenSocketSession, runBatchEvaluation } from './evaluate-socket-rules-agy.mjs';

const readLines = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

/**
 * Builds token sessions directly from a Momentum V2 run directory.
 * Each token's price ticks and trade flow are derived directly from the recorded WebSocket trade stream (trades.jsonl).
 */
export function buildSessionsFromMomentumV2Run(runDir) {
  const tradesFile = join(runDir, 'trades.jsonl');
  if (!existsSync(tradesFile)) return [];

  const allTrades = readLines(tradesFile);
  const tradesByMint = new Map();
  for (const t of allTrades) {
    if (!tradesByMint.has(t.mint)) tradesByMint.set(t.mint, []);
    tradesByMint.get(t.mint).push(t);
  }

  // Token metadata
  let tokenMetas = [];
  if (existsSync(join(runDir, 'token-summary.jsonl'))) {
    tokenMetas = readLines(join(runDir, 'token-summary.jsonl'));
  } else if (existsSync(join(runDir, 'screened-tokens.jsonl'))) {
    tokenMetas = readLines(join(runDir, 'screened-tokens.jsonl'));
  } else {
    for (const [mint, trs] of tradesByMint) {
      tokenMetas.push({ mint, symbol: trs[0]?.symbol || mint.slice(0, 8), initialMarketCapUsd: 50000 });
    }
  }

  // Optional holders
  const holderMap = new Map();
  if (existsSync(join(runDir, 'holder-snapshots.jsonl'))) {
    const holders = readLines(join(runDir, 'holder-snapshots.jsonl'));
    for (const h of holders) {
      if (!holderMap.has(h.mint)) holderMap.set(h.mint, []);
      holderMap.get(h.mint).push(h);
    }
  }

  const sessions = [];
  for (const s of tokenMetas) {
    const mintTrades = tradesByMint.get(s.mint) ?? [];
    if (mintTrades.length < 5) continue;
    mintTrades.sort((a, b) => a.observedAt - b.observedAt);

    const ticks = mintTrades.map(t => ({
      observedAt: t.observedAt,
      priceUsd: t.priceUsd,
      source: 'trades_socket',
    }));

    const sessionMeta = {
      mint: s.mint,
      symbol: s.symbol || s.metadata?.symbol || s.mint.slice(0, 8),
      startedAt: mintTrades[0].observedAt,
      endedAt: mintTrades.at(-1).observedAt,
      entryMarketCapUsd: s.initialMarketCapUsd ?? s.entryMarketCapUsd ?? 50000,
      metadata: s.metadata,
    };

    sessions.push(buildTokenSocketSession(sessionMeta, ticks, holderMap.get(s.mint) ?? [], mintTrades));
  }

  return { sessions, totalTrades: allTrades.length, totalTokens: tokenMetas.length };
}

async function main() {
  const targetRuns = [
    'research/2026-09-28T10-11-44-620Z',
    'research/2026-09-28T07-43-12-734Z',
    'research/2026-09-27T15-37-12-534Z',
    'research/2026-09-27T12-31-14-971Z',
    'research/pump-band-12h-paused-optimizer-2026-09-28T14-50-00Z'
  ];

  const presets = {
    adaptiveRunner: {
      name: 'AGY Adaptive Runner V3 (Anti-Choke, Pure Flow 90%, Trailing 1%)',
      buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.90, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
      sell: { hardStop: 3, activation: 3.5, lock: 2.0, trailing: 1.0, takeProfit: null, flowExit: true },
    },
    aggressiveRunner: {
      name: 'AGY Aggressive High-Volume Sniper (BuyUsd >= $300, Pure Flow 95%, Trailing 1%)',
      buy: { entryReturn: 1.0, momentum1s: 1.0, maxDrawdown: -2.0, minBuyShare: 0.95, minBuyers: 3, minBuyUsd: 300, maxTop1: 'off', maxRange3: 5, maxMarketCap: 200000 },
      sell: { hardStop: 3.0, takeProfit: null, activation: 4.0, lock: 2.5, trailing: 1.0, stagnationSeconds: 12, stagnationThreshold: 2.5, flowExit: true },
    },
    scalpWinRate: {
      name: 'AGY Scalp Precision (Target +3%, Trailing 2%, MaxTop1 40%)',
      buy: { entryReturn: 0.5, momentum1s: 0.5, maxDrawdown: -3, minBuyShare: 0.75, minBuyers: 2, maxTop1: 40, maxRange3: 5, maxMarketCap: 300000 },
      sell: { hardStop: 3, activation: 2, lock: 0.5, trailing: 2, takeProfit: 3 },
    }
  };

  console.log('=============================================================================');
  console.log('    EVALUASI RULES DI SELURUH DATASET SOCKET MOMENTUM V2 BEBERAPA HARI INI   ');
  console.log('=============================================================================\n');

  for (const runDir of targetRuns) {
    if (!existsSync(runDir)) continue;
    console.log(`\n>>> ANALISIS RUN: ${runDir}`);
    const { sessions, totalTrades, totalTokens } = buildSessionsFromMomentumV2Run(runDir);
    console.log(`    Total Event Socket Trades: ${totalTrades.toLocaleString()}`);
    console.log(`    Total Token Terpantau: ${totalTokens} (${sessions.length} aktif dengan stream valid)`);

    for (const [key, p] of Object.entries(presets)) {
      const res = runBatchEvaluation(sessions, p.buy, p.sell, 500);
      const s = res.summary;
      const trades = res.trades.filter(t => !t.unfilled);
      const realWins = trades.filter(t => t.ret - 5.43 > 0).length;
      const realWR = trades.length > 0 ? (realWins / trades.length) * 100 : 0;
      const meanNetReal = trades.length > 0 ? trades.reduce((sum, t) => sum + (t.ret - 5.43), 0) / trades.length : 0;
      const best = s.bestGain > 0 ? `+${s.bestGain.toFixed(1)}%` : '0%';

      console.log(`    [${p.name.slice(0, 32)}]`);
      console.log(`      Sinyal BUY: ${String(s.filledBuys).padStart(2)} token | Socket WR: ${s.winRate.toFixed(1)}% (${s.wins}W/${s.losses}L) | Real WR: ${realWR.toFixed(1)}% (${realWins}W/${trades.length-realWins}L) | MeanSocket: ${s.meanReturn>=0?'+':''}${s.meanReturn.toFixed(2)}% | MeanNetReal: ${meanNetReal>=0?'+':''}${meanNetReal.toFixed(2)}% | Best: ${best}`);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
