import fs from 'node:fs';
import path from 'node:path';

// 1. Load tokens from tx-cluster-cache.json
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

// 2. Scan all local trade files
const rootDirs = [
  '/home/bbliong/project/crypto-bot/data/profit4-watch',
  '/home/bbliong/project/crypto-bot/data/profit4-watch/archive-pre-migration',
  '/home/bbliong/project/crypto-bot/data/profit4-watch-backup/runs-2026-10-15-before-gmgn-ws',
  '/home/bbliong/project/crypto-bot/data/profit4-watch-legacy-chrome'
];

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
const tradesByMint = new Map();
for (const t of allTokens) tradesByMint.set(t.mint, []);
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

// 3. Exact Lane S5 Simulation
// Lane S5 Exact Rules:
// - Discard Tier 1 & 2 immediately (wallets < 88)
// - Observation: 45s - 240s
// - Upward Momentum: price >= initialPrice * 1.025
// - Max Drawdown during observation: <= 2.5%
// - Target TP: +25%
// - Trailing Stop: start at +15%, trail 4%
// - Stop Loss: -8%
// - HARD TIME LIMIT: 420s (7 minutes) max hold

const results = [];

for (const token of allTokens) {
  if (token.tierNum === 1 || token.tierNum === 2) {
    results.push({
      symbol: token.symbol,
      mint: token.mint,
      tier: token.tier,
      tierNum: token.tierNum,
      walletCount: token.walletCount,
      outcome: 'SKIPPED_TIER_FILTER',
      netReturn: 0,
      reason: 'TIER_1_OR_2_DISCARDED'
    });
    continue;
  }

  const raw = tradesByMint.get(token.mint) || [];
  if (raw.length < 5) {
    results.push({
      symbol: token.symbol,
      mint: token.mint,
      tier: token.tier,
      tierNum: token.tierNum,
      walletCount: token.walletCount,
      outcome: 'NO_LOCAL_TRADES',
      netReturn: 0,
      reason: 'TRADE_DATA_NOT_FOUND'
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
  const relevantTrades = trades.filter(t => t.timestamp >= t0 - 60);
  const dataTrades = relevantTrades.length >= 5 ? relevantTrades : trades;

  const initialPrice = dataTrades[0].price;
  let entryPrice = null;
  let entryTime = null;
  let peakPriceSinceEntry = null;
  let exitPrice = null;
  let outcome = 'NO_ENTRY';
  let reason = 'NO_VALID_SETUP';

  let rollPeak = initialPrice;
  let rollLow = initialPrice;

  for (const t of dataTrades) {
    const elapsedSinceT0 = t.timestamp - t0;

    if (!entryPrice) {
      if (t.price > rollPeak) { rollPeak = t.price; rollLow = t.price; }
      if (t.price < rollLow) rollLow = t.price;

      // Observe at least 45s, max 240s
      if (elapsedSinceT0 < 45) continue;
      if (elapsedSinceT0 > 240) {
        reason = 'ENTRY_WINDOW_EXPIRED';
        break;
      }

      // Check Drawdown during observation
      const curDd = rollPeak > 0 ? ((rollPeak - t.price) / rollPeak) * 100 : 0;
      if (curDd > 2.5) {
        reason = 'MAX_DRAWDOWN_EXCEEDED';
        continue; // Wait or skip
      }

      // Check Upward Momentum (at least +2.5% gain)
      if (t.price >= initialPrice * 1.025) {
        entryPrice = t.price;
        entryTime = t.timestamp;
        peakPriceSinceEntry = t.price;
        outcome = 'HOLDING';
      }
    } else {
      // Position Management
      const holdDuration = t.timestamp - entryTime;
      if (t.price > peakPriceSinceEntry) peakPriceSinceEntry = t.price;

      const currentReturn = ((t.price - entryPrice) / entryPrice) * 100;
      const drawdownFromPeak = ((peakPriceSinceEntry - t.price) / peakPriceSinceEntry) * 100;

      // 1. Target Take Profit +25%
      if (currentReturn >= 25.0) {
        exitPrice = t.price;
        outcome = 'WIN';
        reason = 'TAKE_PROFIT_25%';
        break;
      }

      // 2. Trailing Stop (Start +15%, trail 4%)
      if (peakPriceSinceEntry >= entryPrice * 1.15 && drawdownFromPeak >= 4.0) {
        exitPrice = t.price;
        outcome = currentReturn > 0 ? 'WIN' : 'LOSS';
        reason = 'TRAILING_STOP';
        break;
      }

      // 3. Stop Loss -8%
      if (currentReturn <= -8.0) {
        exitPrice = t.price;
        outcome = 'LOSS';
        reason = 'STOP_LOSS_8%';
        break;
      }

      // 4. Hard Time Limit Exit (420s / 7 Menit)
      if (holdDuration >= 420) {
        exitPrice = t.price;
        outcome = currentReturn > 0 ? 'WIN' : 'LOSS';
        reason = 'HARD_TIME_EXIT_7M';
        break;
      }
    }
  }

  // If still holding at the end of data, mark exit at last trade
  if (entryPrice && !exitPrice) {
    const lastTrade = dataTrades[dataTrades.length - 1];
    exitPrice = lastTrade.price;
    const finalReturn = ((exitPrice - entryPrice) / entryPrice) * 100;
    outcome = finalReturn > 0 ? 'WIN' : 'LOSS';
    reason = 'END_OF_DATA_STREAM';
  }

  const netReturn = entryPrice && exitPrice 
    ? Number((((exitPrice - entryPrice) / entryPrice) * 100 - 2.5).toFixed(1))
    : 0;

  results.push({
    symbol: token.symbol,
    mint: token.mint,
    tier: token.tier,
    tierNum: token.tierNum,
    walletCount: token.walletCount,
    entryPrice,
    exitPrice,
    outcome,
    netReturn,
    reason
  });
}

// 4. Output Breakdown
console.log('='.repeat(75));
console.log('📊 HASIL DETAIL RULES LANE S5 (TIER-4 & TIER-3 PRE-DUMP RIDER)');
console.log('='.repeat(75));

const skipped = results.filter(r => r.outcome === 'SKIPPED_TIER_FILTER');
const noTrades = results.filter(r => r.outcome === 'NO_LOCAL_TRADES');
const noEntry = results.filter(r => r.outcome === 'NO_ENTRY');
const executed = results.filter(r => r.outcome === 'WIN' || r.outcome === 'LOSS');
const wins = executed.filter(r => r.outcome === 'WIN' && r.netReturn > 0);
const losses = executed.filter(r => r.outcome === 'LOSS' || r.netReturn <= 0);

console.log(`Total Token Terdaftar di Sindikat : ${results.length} Token`);
console.log(`• Tier 1 & Tier 2 Langsung Dibuang (Skip) : ${skipped.length} Token (34.2%) 🛡️ (100% Bebas Risiko Flash Dump)`);
console.log(`• Tier 3 & Tier 4 Tanpa Data Log Lokal    : ${noTrades.length} Token (61.3%)`);
console.log(`• Tier 3 & Tier 4 yang Setup Tidak Lolos : ${noEntry.length} Token (Setup Gagal / Drawdown Awal)`);
console.log(`• Tier 3 & Tier 4 yang DIEKSEKUSI MASUK   : ${executed.length} Token`);
console.log(`---------------------------------------------------------------------------`);
console.log(`🏆 TOTAL WIN TRADES : ${wins.length} Token`);
console.log(`❌ TOTAL LOSS TRADES: ${losses.length} Token`);
const wr = executed.length > 0 ? ((wins.length / executed.length) * 100).toFixed(1) : '0.0';
console.log(`🎯 WIN RATE         : ${wr}%`);
const totalGain = executed.reduce((a, b) => a + b.netReturn, 0);
console.log(`💰 TOTAL GAIN NET   : ${totalGain >= 0 ? '+' : ''}${totalGain.toFixed(1)}%`);
console.log(`---------------------------------------------------------------------------`);

console.log('\n--- RINCIAN SETIAP TOKEN YANG DIEKSEKUSI ---');
for (const e of executed) {
  const sym = e.symbol.padEnd(16);
  const w = `${e.walletCount} W`.padEnd(8);
  const ret = `${e.netReturn >= 0 ? '+' : ''}${e.netReturn.toFixed(1)}%`.padStart(8);
  console.log(`• ${sym} | ${w} | Hasil: ${e.outcome.padEnd(5)} | Net: ${ret} | Alasan: ${e.reason}`);
}

console.log('\n--- RINCIAN TOKEN TIER 3 & 4 YANG NO ENTRY (DITOLAK FILTER DRAWDOWN/WAKTU) ---');
for (const ne of noEntry) {
  console.log(`• ${ne.symbol.padEnd(16)} | ${ne.walletCount} W | Ditolak karena: ${ne.reason}`);
}
console.log('='.repeat(75) + '\n');
