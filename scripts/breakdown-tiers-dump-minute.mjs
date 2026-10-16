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
console.log(`Scanning ${allTradeFiles.length} local token-trades.jsonl files...`);

const targetMints = new Set(allTokens.map(t => t.mint));

for (const tf of allTradeFiles) {
  try {
    const lines = fs.readFileSync(tf, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      // Fast check
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

// 3. Analyze each token
const tokenAnalysis = [];

for (const token of allTokens) {
  const raw = tradesByMint.get(token.mint) || [];
  if (raw.length < 5) continue;

  raw.sort((a, b) => a.timestamp - b.timestamp);
  // deduplicate
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
  let peakPrice = initialPrice;
  let peakTime = dataTrades[0].timestamp;

  for (const t of dataTrades) {
    if (t.price > peakPrice) {
      peakPrice = t.price;
      peakTime = t.timestamp;
    }
  }

  const pumpPercent = initialPrice > 0 ? ((peakPrice - initialPrice) / initialPrice) * 100 : 0;
  const timeToPeakSec = Math.max(0, peakTime - t0);
  const minutePeak = (timeToPeakSec / 60).toFixed(1);

  // Trough after peak
  let troughPrice = peakPrice;
  let troughTime = peakTime;
  for (const t of dataTrades) {
    if (t.timestamp >= peakTime && t.price < troughPrice) {
      troughPrice = t.price;
      troughTime = t.timestamp;
    }
  }

  const dumpPercent = peakPrice > 0 ? ((peakPrice - troughPrice) / peakPrice) * 100 : 0;
  const dumpDurationSec = Math.max(0, troughTime - peakTime);
  const dumpDurationMin = (dumpDurationSec / 60).toFixed(1);

  tokenAnalysis.push({
    mint: token.mint,
    symbol: token.symbol,
    tier: token.tier,
    tierNum: token.tierNum,
    walletCount: token.walletCount,
    supplyPercent: token.supplyPercent,
    initialPrice,
    peakPrice,
    troughPrice,
    pumpPercent,
    minutePeak: Number(minutePeak),
    dumpPercent,
    dumpDurationMin: Number(dumpDurationMin),
    tradesCount: dataTrades.length
  });
}

console.log(`Evaluated ${tokenAnalysis.length} tokens with trade history.\n`);

// Group by Tier and Output
const tiers = ['Tier 1 (8-48 W)', 'Tier 2 (56-80 W)', 'Tier 3 (88-112 W)', 'Tier 4 (120+ W)'];

for (const tName of tiers) {
  const items = tokenAnalysis.filter(t => t.tier === tName);
  console.log(`\n========================================================================================`);
  console.log(`🏷️ ${tName} - Total: ${items.length} Token`);
  console.log(`========================================================================================`);
  console.log(`Symbol          | Wallets | Suplai (%) | Max Pump (%) | Dump Dimulai | Durasi Dump | Kedalaman Dump`);
  console.log(`----------------+---------+------------+--------------+--------------+-------------+---------------`);
  for (const it of items) {
    const sym = (it.symbol || 'UNKNOWN').slice(0, 15).padEnd(15);
    const wal = String(it.walletCount).padStart(7);
    const sup = (it.supplyPercent.toFixed(2) + '%').padStart(10);
    const pmp = ('+' + it.pumpPercent.toFixed(1) + '%').padStart(12);
    const pkM = (`m-${it.minutePeak}`).padStart(12);
    const dDur = (`${it.dumpDurationMin} m`).padStart(11);
    const dmp = ('-' + it.dumpPercent.toFixed(1) + '%').padStart(13);
    console.log(`${sym} | ${wal} | ${sup} | ${pmp} | ${pkM} | ${dDur} | ${dmp}`);
  }

  if (items.length > 0) {
    const avgPmp = items.reduce((a, b) => a + b.pumpPercent, 0) / items.length;
    const avgPk = items.reduce((a, b) => a + b.minutePeak, 0) / items.length;
    const avgDmp = items.reduce((a, b) => a + b.dumpPercent, 0) / items.length;
    const avgDur = items.reduce((a, b) => a + b.dumpDurationMin, 0) / items.length;
    console.log(`----------------+---------+------------+--------------+--------------+-------------+---------------`);
    console.log(`RATA-RATA ${tName}: Pump +${avgPmp.toFixed(1)}% | Puncak di Menit ke-${avgPk.toFixed(1)} | Dump -${avgDmp.toFixed(1)}% (${avgDur.toFixed(1)} menit)`);
  }
}
