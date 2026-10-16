import fs from 'node:fs';
import path from 'node:path';

// 1. Load cache and map tokens
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

const target18Symbols = [
  'Airdrop-489MM', 'Airdrop-6PaFL', 'Airdrop-HcUpQ', 'Airdrop-Hv2e5',
  'Airdrop-aiqZf', 'Airdrop-d71om', 'Airdrop-37ed3', 'Airdrop-AaZKr',
  'Airdrop-9zScs', 'Airdrop-7z48G', 'Airdrop-8ZnGZ', 'Airdrop-35c4m',
  'Airdrop-76nUT', 'Airdrop-4mttm', 'Airdrop-CnHN9', 'Airdrop-BUHd3',
  'Airdrop-yjioR', 'Airdrop-5qBvK'
];

const target18Tokens = Array.from(mintMap.values())
  .filter(m => target18Symbols.includes(m.symbol))
  .map(m => ({
    mint: m.mint,
    symbol: m.symbol,
    walletCount: m.wallets.size,
    firstAirdropTime: m.firstAirdropTime
  }));

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
    if (entry.isDirectory()) files.push(...collectTradeFiles(full));
    else if (entry.name === 'token-trades.jsonl') files.push(full);
  }
  return files;
}

const allTradeFiles = [];
for (const r of rootDirs) allTradeFiles.push(...collectTradeFiles(r));
const tradesByMint = new Map();
for (const t of target18Tokens) tradesByMint.set(t.mint, []);
const targetMints = new Set(target18Tokens.map(t => t.mint));

for (const tf of allTradeFiles) {
  try {
    const lines = fs.readFileSync(tf, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      let foundMint = null;
      for (const m of targetMints) {
        if (line.includes(m)) { foundMint = m; break; }
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

// 3. Deep Analysis of the 18 Tokens
const detailedAnalysis = [];

for (const token of target18Tokens) {
  const raw = tradesByMint.get(token.mint) || [];
  if (raw.length < 5) continue;

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

  // Analysis in minute 0 - 4 (The S5 Entry Window)
  const m4Trades = dataTrades.filter(t => t.timestamp <= t0 + 240);
  let maxPumpM4 = 0;
  let minDropM4 = 0;
  if (m4Trades.length > 0) {
    const maxP4 = Math.max(...m4Trades.map(t => t.price));
    const minP4 = Math.min(...m4Trades.map(t => t.price));
    maxPumpM4 = ((maxP4 - initialPrice) / initialPrice) * 100;
    minDropM4 = ((minP4 - initialPrice) / initialPrice) * 100;
  }

  // Trajectory AFTER minute 4
  const laterTrades = dataTrades.filter(t => t.timestamp > t0 + 240);
  let maxLaterPrice = initialPrice;
  let maxLaterTime = t0;
  let minLaterPrice = initialPrice;
  let minLaterTime = t0;

  for (const t of dataTrades) {
    if (t.price > maxLaterPrice) {
      maxLaterPrice = t.price;
      maxLaterTime = t.timestamp;
    }
    if (t.timestamp >= maxLaterTime && t.price < minLaterPrice) {
      minLaterPrice = t.price;
      minLaterTime = t.timestamp;
    }
  }

  const overallMaxPumpPct = initialPrice > 0 ? ((maxLaterPrice - initialPrice) / initialPrice) * 100 : 0;
  const minuteOfPeak = ((maxLaterTime - t0) / 60).toFixed(1);

  // Subsequent dump from peak
  const subsequentDumpPct = maxLaterPrice > 0 ? ((maxLaterPrice - minLaterPrice) / maxLaterPrice) * 100 : 0;
  const minuteOfTrough = ((minLaterTime - t0) / 60).toFixed(1);

  // Classification of what happened:
  // - LATE_PUMP_THEN_DUMP: Pumped significantly later (e.g. > +20%), then dumped hard
  // - FLAT_THEN_DUMP: Stayed flat/dead, then dumped
  // - SLOW_RUNNER: Kept climbing slowly over hours without dumping
  let category = 'FLAT';
  if (overallMaxPumpPct >= 20 && subsequentDumpPct >= 60) {
    category = 'LATE_PUMP_THEN_DUMP';
  } else if (overallMaxPumpPct >= 20 && subsequentDumpPct < 30) {
    category = 'SLOW_RUNNER_HODL';
  } else if (subsequentDumpPct >= 50) {
    category = 'DEAD_FLAT_THEN_DUMP';
  }

  detailedAnalysis.push({
    symbol: token.symbol,
    mint: token.mint,
    walletCount: token.walletCount,
    initialPrice,
    maxPumpM4,
    minDropM4,
    overallMaxPumpPct,
    minuteOfPeak: Number(minuteOfPeak),
    subsequentDumpPct,
    minuteOfTrough: Number(minuteOfTrough),
    category
  });
}

// 4. Output the Deep Findings
console.log('='.repeat(95));
console.log('🔬 BEDAH ANATOMI 18 TOKEN YANG DITOLAK MASUK LANE S5 (ENTRY WINDOW EXPIRED)');
console.log('='.repeat(95));

console.log('Symbol          | Wallets | Kenaikan 0-4m | Puncak Nanti | Menit Puncak | Dump Sesudahnya | Kategori Perilaku');
console.log('----------------+---------+---------------+--------------+--------------+-----------------+--------------------');

for (const it of detailedAnalysis) {
  const sym = it.symbol.padEnd(15);
  const wal = `${it.walletCount} W`.padStart(7);
  const p4 = (`${it.maxPumpM4 >= 0 ? '+' : ''}${it.maxPumpM4.toFixed(1)}%`).padStart(13);
  const ovr = (`+${it.overallMaxPumpPct.toFixed(1)}%`).padStart(12);
  const mpk = (`m-${it.minuteOfPeak}`).padStart(12);
  const dmp = (`-${it.subsequentDumpPct.toFixed(1)}%`).padStart(15);
  const cat = it.category.padEnd(20);

  console.log(`${sym} | ${wal} | ${p4} | ${ovr} | ${mpk} | ${dmp} | ${cat}`);
}

console.log('----------------+---------+---------------+--------------+--------------+-----------------+--------------------');

// Group summaries
const runners = detailedAnalysis.filter(d => d.category === 'SLOW_RUNNER_HODL');
const lateDump = detailedAnalysis.filter(d => d.category === 'LATE_PUMP_THEN_DUMP');
const deadDump = detailedAnalysis.filter(d => d.category === 'DEAD_FLAT_THEN_DUMP');

console.log('\n--- KESIMPULAN DARI 18 TOKEN YANG DI-SKIP ---');
console.log(`1. 🚀 Kategori SLOW RUNNER HODL (Naik Besar & Tidak Dump) : ${runners.length} Token (${((runners.length/detailedAnalysis.length)*100).toFixed(1)}%)`);
for (const r of runners) {
  console.log(`   • ${r.symbol}: Naik +${r.overallMaxPumpPct.toFixed(1)}% di menit ke-${r.minuteOfPeak} (Drawdown hanya -${r.subsequentDumpPct.toFixed(1)}%)`);
}

console.log(`\n2. ⚠️ Kategori LATE PUMP THEN DUMP (Dipompa Terlambat Lalu Dibantai) : ${lateDump.length} Token (${((lateDump.length/detailedAnalysis.length)*100).toFixed(1)}%)`);
for (const ld of lateDump) {
  console.log(`   • ${ld.symbol}: Naik telat +${ld.overallMaxPumpPct.toFixed(1)}% di menit ke-${ld.minuteOfPeak}, lalu DIBANTING -${ld.subsequentDumpPct.toFixed(1)}%`);
}

console.log(`\n3. 💀 Kategori DEAD FLAT THEN DUMP (Tidak Pernah Naik, Langsung Amblas) : ${deadDump.length} Token (${((deadDump.length/detailedAnalysis.length)*100).toFixed(1)}%)`);
for (const dd of deadDump) {
  console.log(`   • ${dd.symbol}: Kenaikan awal hanya +${dd.overallMaxPumpPct.toFixed(1)}%, langsung DUMP -${dd.subsequentDumpPct.toFixed(1)}%`);
}
console.log('='.repeat(95) + '\n');
