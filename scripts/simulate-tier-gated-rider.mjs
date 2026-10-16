import fs from 'node:fs';
import path from 'node:path';

// 1. Load all tokens from tx-cluster-cache.json
const cache = JSON.parse(fs.readFileSync('/home/bbliong/project/crypto-bot/data/profit4-watch/tx-cluster-cache.json', 'utf8'));
const mintMap = new Map();

for (const [sig, item] of Object.entries(cache)) {
  if (item && item.mint && item.recipients && item.recipients.length >= 4) {
    if (!mintMap.has(item.mint)) {
      mintMap.set(item.mint, {
        mint: item.mint,
        symbol: item.symbol || 'UNKNOWN',
        firstAirdropTime: item.timestamp,
        wallets: new Set(item.recipients),
        txCount: 1
      });
    } else {
      const m = mintMap.get(item.mint);
      m.txCount++;
      if (item.timestamp < m.firstAirdropTime) m.firstAirdropTime = item.timestamp;
      for (const w of item.recipients) m.wallets.add(w);
    }
  }
}

const allTokens = Array.from(mintMap.values()).map(m => {
  const wCount = m.wallets.size;
  let tier = 'Tier 1 (8-48 W)';
  let tierNum = 1;
  if (wCount >= 56 && wCount <= 80) { tier = 'Tier 2 (56-80 W)'; tierNum = 2; }
  else if (wCount >= 88 && wCount <= 112) { tier = 'Tier 3 (88-112 W)'; tierNum = 3; }
  else if (wCount >= 120) { tier = 'Tier 4 (120+ W)'; tierNum = 4; }

  return {
    mint: m.mint,
    symbol: m.symbol,
    walletCount: wCount,
    totalAirdropTokens: wCount * 360500,
    supplyPercent: ((wCount * 360500) / 1000000000) * 100,
    firstAirdropTime: m.firstAirdropTime,
    txCount: m.txCount,
    tier,
    tierNum
  };
});

// 2. Scan all local trade files to aggregate trades per mint
const rootDirs = [
  '/home/bbliong/project/crypto-bot/data/profit4-watch',
  '/home/bbliong/project/crypto-bot/data/profit4-watch/archive-pre-migration',
  '/home/bbliong/project/crypto-bot/data/profit4-watch-backup/runs-2026-10-15-before-gmgn-ws',
  '/home/bbliong/project/crypto-bot/data/profit4-watch-legacy-chrome'
];

const tradesByMint = new Map();
for (const t of allTokens) tradesByMint.set(t.mint, []);

function collectTradeFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTradeFiles(full));
    } else if (entry.name === 'token-trades.jsonl') {
      files.push(full);
    }
  }
  return files;
}

const allTradeFiles = [];
for (const r of rootDirs) allTradeFiles.push(...collectTradeFiles(r));
const targetMints = new Set(allTokens.map(t => t.mint));

for (const tf of allTradeFiles) {
  try {
    const lines = fs.readFileSync(tf, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let foundMint = null;
      for (const m of targetMints) {
        if (line.includes(m)) {
          foundMint = m;
          break;
        }
      }
      if (!foundMint) continue;

      try {
        const row = JSON.parse(line);
        if (Number(row.price) > 0) {
          tradesByMint.get(foundMint).push({
            price: Number(row.price),
            timestamp: Number(row.timestamp || Math.floor((row.at || row.observedAt || Date.now()) / 1000)),
            side: row.side || row.e,
            usd: Number(row.usd || row.au || 0)
          });
        }
      } catch {}
    }
  } catch {}
}

// 3. Simulate the Proposed New Strategy: "Syndicate Tier-Gated Time-Boxed Rider"
// Rules:
// - Tier 1 & 2: REJECT IMMEDIATELY (0% entry, no monitoring)
// - Tier 3: Only enter if momentum confirms in minute 1-2, Hard Max Hold: 180s (3 minutes), TP: +20%, SL: -7%
// - Tier 4: Enter if momentum confirms in minute 1-3, Hard Max Hold: 480s (8 minutes), TP: +30%, SL: -8%, Trailing: start +20% trail 4%

const simResults = [];

for (const token of allTokens) {
  // RULE 1: Filter out Tier 1 and Tier 2 completely!
  if (token.tierNum === 1 || token.tierNum === 2) {
    simResults.push({
      mint: token.mint,
      symbol: token.symbol,
      tier: token.tier,
      tierNum: token.tierNum,
      walletCount: token.walletCount,
      outcome: 'REJECTED_TIER_FILTER',
      netReturn: 0,
      exitReason: 'TIER_1_OR_2_DISCARDED'
    });
    continue;
  }

  const raw = tradesByMint.get(token.mint) || [];
  if (raw.length < 10) {
    simResults.push({
      mint: token.mint,
      symbol: token.symbol,
      tier: token.tier,
      tierNum: token.tierNum,
      walletCount: token.walletCount,
      outcome: 'NO_TRADES',
      netReturn: 0,
      exitReason: 'INSUFFICIENT_DATA'
    });
    continue;
  }

  raw.sort((a, b) => a.timestamp - b.timestamp);
  const trades = [];
  const seen = new Set();
  for (const tr of raw) {
    const k = `${tr.timestamp}:${tr.price}`;
    if (!seen.has(k)) { seen.add(k); trades.push(tr); }
  }

  const t0 = token.firstAirdropTime || trades[0].timestamp;
  const initialPrice = trades[0].price;

  // Parameters based on Tier
  const isTier4 = token.tierNum === 4;
  const maxEntryWaitSec = isTier4 ? 240 : 120; // 4 mins for T4, 2 mins for T3
  const hardMaxHoldSec = isTier4 ? 480 : 180;  // 8 mins for T4, 3 mins for T3
  const targetTp = isTier4 ? 30 : 20;
  const stopLoss = isTier4 ? -8 : -7;

  let entryPrice = null;
  let entryTime = null;
  let peakPriceSinceEntry = null;
  let exitPrice = null;
  let outcome = 'NO_ENTRY';
  let exitReason = 'ENTRY_WINDOW_EXPIRED';

  for (const t of trades) {
    const elapsedSinceT0 = t.timestamp - t0;

    // Entry evaluation
    if (!entryPrice) {
      if (elapsedSinceT0 < 30) continue; // Observe at least 30s
      if (elapsedSinceT0 > maxEntryWaitSec) break; // Missed entry window

      // Check if price is climbing with momentum (> +3% from initial) and not dumping
      if (t.price >= initialPrice * 1.03 && t.price <= initialPrice * 1.25) {
        entryPrice = t.price;
        entryTime = t.timestamp;
        peakPriceSinceEntry = t.price;
        outcome = 'HOLDING';
      }
    } else {
      // Manage position
      const holdDuration = t.timestamp - entryTime;
      if (t.price > peakPriceSinceEntry) peakPriceSinceEntry = t.price;

      const currentReturn = ((t.price - entryPrice) / entryPrice) * 100;
      const drawdownFromPeak = ((peakPriceSinceEntry - t.price) / peakPriceSinceEntry) * 100;

      // 1. Take profit
      if (currentReturn >= targetTp) {
        exitPrice = t.price;
        outcome = 'WIN_TAKE_PROFIT';
        exitReason = `TARGET_TP_${targetTp}`;
        break;
      }

      // 2. Trailing stop (if gained >= 15% and drops 4% from peak)
      if (peakPriceSinceEntry >= entryPrice * 1.15 && drawdownFromPeak >= 4.0) {
        exitPrice = t.price;
        outcome = currentReturn > 0 ? 'WIN_TRAILING_STOP' : 'LOSS_TRAILING_STOP';
        exitReason = 'TRAILING_STOP';
        break;
      }

      // 3. Stop loss
      if (currentReturn <= stopLoss) {
        exitPrice = t.price;
        outcome = 'LOSS_STOP_LOSS';
        exitReason = 'STOP_LOSS';
        break;
      }

      // 4. HARD TIME EXIT (The Core Innovation!)
      // Exit before the dump slaughterhouse window!
      if (holdDuration >= hardMaxHoldSec) {
        exitPrice = t.price;
        outcome = currentReturn > 0 ? 'WIN_HARD_TIME_EXIT' : 'LOSS_HARD_TIME_EXIT';
        exitReason = `HARD_TIME_LIMIT_${hardMaxHoldSec}S`;
        break;
      }
    }
  }

  const netReturn = entryPrice && exitPrice 
    ? Number((((exitPrice - entryPrice) / entryPrice) * 100 - 2.5).toFixed(1))
    : 0;

  simResults.push({
    mint: token.mint,
    symbol: token.symbol,
    tier: token.tier,
    tierNum: token.tierNum,
    walletCount: token.walletCount,
    entryPrice,
    exitPrice,
    outcome,
    netReturn,
    exitReason
  });
}

// 4. Output Results
console.log('='.repeat(75));
console.log('🚀 SIMULASI STRATEGI BARU: "SYNDICATE TIER-GATED & TIME-BOXED RIDER"');
console.log('='.repeat(75));

const executed = simResults.filter(r => r.outcome.startsWith('WIN') || r.outcome.startsWith('LOSS'));
const wins = executed.filter(r => r.netReturn > 0);
const losses = executed.filter(r => r.netReturn <= 0);
const rejectedT1T2 = simResults.filter(r => r.outcome === 'REJECTED_TIER_FILTER');
const noTrades = simResults.filter(r => r.outcome === 'NO_TRADES' || r.outcome === 'NO_ENTRY');

console.log(`Total Token yang Dievaluasi: ${simResults.length}`);
console.log(`• Token Tier 1 & Tier 2 Langsung Dibuang (Di-Skip) : ${rejectedT1T2.length} Token ✅ (Bebas Risiko)`);
console.log(`• Token Tier 3 & Tier 4 Tanpa Data Trade Lokal    : ${noTrades.length} Token`);
console.log(`• Token Tier 3 & Tier 4 yang Dieksekusi Masuk     : ${executed.length} Token`);
console.log(`• WIN TRADES                                      : ${wins.length} Token`);
console.log(`• LOSS TRADES                                     : ${losses.length} Token`);

const wr = executed.length > 0 ? ((wins.length / executed.length) * 100).toFixed(1) : '0.0';
const totalPnl = executed.reduce((a, b) => a + b.netReturn, 0);

console.log(`• WIN RATE                                        : ${wr}%`);
console.log(`• TOTAL CUMULATIVE RETURN                         : ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`);

console.log('\n--- DETAIL EKSEKUSI TRADE TIER 3 & TIER 4 ---');
for (const e of executed) {
  const sym = (e.symbol || 'UNKNOWN').slice(0, 15).padEnd(15);
  const tier = e.tier.padEnd(17);
  const ret = (e.netReturn >= 0 ? '+' : '') + e.netReturn.toFixed(1) + '%';
  console.log(`• ${sym} | ${tier} | Hasil: ${e.outcome.padEnd(19)} | Net: ${ret.padStart(7)} | Alasan: ${e.exitReason}`);
}
console.log('='.repeat(75) + '\n');
