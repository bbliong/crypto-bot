import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runDir = process.argv[2] ? resolve(process.argv[2]) : resolve('research/2026-09-22T09-57-35-788Z');

function readJsonl(file) {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw) return [];
    return raw.split('\n').map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

const simTrades = readJsonl(`${runDir}/simulated-trades.jsonl`);
const allTrades = readJsonl(`${runDir}/trades.jsonl`);

const buys = simTrades.filter(t => t.type === 'SIMULATED_BUY');
const sells = simTrades.filter(t => t.type === 'SIMULATED_SELL');
const sellsByMint = new Map(sells.map(s => [s.mint, s]));

// Group trades by mint
const tradesByMint = new Map();
for (const t of allTrades) {
  if (!tradesByMint.has(t.mint)) tradesByMint.set(t.mint, []);
  tradesByMint.get(t.mint).push(t);
}

const results = [];

for (const buy of buys) {
  const mint = buy.mint;
  const symbol = buy.metadata?.symbol ?? 'Token';
  const entryPrice = buy.entryPriceUsd;
  const buyTime = buy.observedAt;
  const actualSell = sellsByMint.get(mint);

  const tokenTrades = tradesByMint.get(mint) ?? [];
  tokenTrades.sort((a, b) => (a.occurredAt ?? a.observedAt) - (b.occurredAt ?? b.observedAt));

  // Trades strictly after buy time
  const afterTrades = tokenTrades.filter(t => {
    const time = t.occurredAt ?? t.observedAt;
    return time >= buyTime && t.priceUsd > 0;
  });

  let peakPrice = entryPrice;
  let minPrice = entryPrice;
  let peakTime = buyTime;
  let minTime = buyTime;
  let lastPrice = entryPrice;
  let lastTime = buyTime;

  for (const t of afterTrades) {
    if (t.priceUsd > peakPrice) {
      peakPrice = t.priceUsd;
      peakTime = t.occurredAt ?? t.observedAt;
    }
    if (t.priceUsd < minPrice) {
      minPrice = t.priceUsd;
      minTime = t.occurredAt ?? t.observedAt;
    }
    lastPrice = t.priceUsd;
    lastTime = t.occurredAt ?? t.observedAt;
  }

  const maxGainPct = ((peakPrice / entryPrice) - 1) * 100;
  const maxDrawdownPct = ((minPrice / entryPrice) - 1) * 100;
  const finalGainPct = ((lastPrice / entryPrice) - 1) * 100;
  const durationObservedSec = ((lastTime - buyTime) / 1000).toFixed(1);

  // Trajectory classification:
  // Was there an opportunity to exit with profit >= +5%, >= +10%, >= +20%, >= +40%?
  let status = '';
  if (maxGainPct >= 40) {
    status = 'SANGAT UNTUNG (Capai Target +40%)';
  } else if (maxGainPct >= 20) {
    status = 'UNTUNG TINGGI (+20% s/d +40%)';
  } else if (maxGainPct >= 10) {
    status = 'UNTUNG SEDANG (+10% s/d +20%)';
  } else if (maxGainPct >= 5) {
    status = 'UNTUNG KECIL (+5% s/d +10%)';
  } else if (maxDrawdownPct <= -15) {
    status = 'RUGI / DUMP (Turun Tajam)';
  } else {
    status = 'FLAT / SEDIKIT RUGI';
  }

  results.push({
    symbol,
    mint: mint.slice(0, 8) + '...',
    actualPnlPct: actualSell ? actualSell.pnlPercent : null,
    actualReason: actualSell ? actualSell.reason : 'OPEN',
    actualHoldSec: actualSell ? ((actualSell.observedAt - buyTime) / 1000).toFixed(1) : '-',
    entryPrice,
    peakPrice,
    minPrice,
    lastPrice,
    maxGainPct,
    maxDrawdownPct,
    finalGainPct,
    tradeCountAfter: afterTrades.length,
    durationObservedSec,
    status
  });
}

console.log('='.repeat(110));
console.log(`ANALISIS REALITAS HARGA VS SIMULASI (RUN: ${runDir.split('\\').pop()})`);
console.log('='.repeat(110));

console.table(results.map(r => ({
  Token: r.symbol,
  'Hasil Tercatat': r.actualPnlPct !== null ? `${r.actualPnlPct >= 0 ? '+' : ''}${r.actualPnlPct.toFixed(1)}% (${r.actualHoldSec}s)` : '-',
  'Alasan Tercatat': r.actualReason,
  'Puncak Naik': `+${r.maxGainPct.toFixed(1)}%`,
  'Drop Terendah': `${r.maxDrawdownPct.toFixed(1)}%`,
  'Harga Akhir': `${r.finalGainPct >= 0 ? '+' : ''}${r.finalGainPct.toFixed(1)}%`,
  'Trades Post-Buy': r.tradeCountAfter,
  'Pantauan': `${r.durationObservedSec}s`,
  'Potensi Seharusnya': r.status
})));

console.log('\nANALISIS KELOMPOK TOKEN:');
const superUntung = results.filter(r => r.maxGainPct >= 10);
const untungKecil = results.filter(r => r.maxGainPct >= 5 && r.maxGainPct < 10);
const rugiLangsung = results.filter(r => r.maxGainPct < 5 && r.maxDrawdownPct <= -15);
const flat = results.filter(r => r.maxGainPct < 5 && r.maxDrawdownPct > -15);

console.log(`\n1. TOKEN YANG SEHARUSNYA UNTUNG BESAR (Puncak >= +10%): ${superUntung.length} token`);
for (const r of superUntung) {
  console.log(`   - ${r.symbol}: Tercatat ${r.actualPnlPct.toFixed(1)}% padahal harga sempat NAIK +${r.maxGainPct.toFixed(1)}% (Drop max ${r.maxDrawdownPct.toFixed(1)}%)`);
}

console.log(`\n2. TOKEN YANG SEHARUSNYA UNTUNG KECIL (Puncak +5% s/d +10%): ${untungKecil.length} token`);
for (const r of untungKecil) {
  console.log(`   - ${r.symbol}: Tercatat ${r.actualPnlPct.toFixed(1)}% padahal harga sempat NAIK +${r.maxGainPct.toFixed(1)}% (Drop max ${r.maxDrawdownPct.toFixed(1)}%)`);
}

console.log(`\n3. TOKEN YANG BENAR-BENAR RUGI / DUMP (Tidak pernah naik >=5%, langsung drop): ${rugiLangsung.length} token`);
for (const r of rugiLangsung) {
  console.log(`   - ${r.symbol}: Tercatat ${r.actualPnlPct.toFixed(1)}%, memang drop hingga ${r.maxDrawdownPct.toFixed(1)}% (Puncak hanya +${r.maxGainPct.toFixed(1)}%)`);
}

console.log(`\n4. TOKEN YANG FLAT / SIDEWAYS (Kenaikan <5%, penurunan <15%): ${flat.length} token`);
for (const r of flat) {
  console.log(`   - ${r.symbol}: Tercatat ${r.actualPnlPct.toFixed(1)}% (Puncak +${r.maxGainPct.toFixed(1)}%, Drop ${r.maxDrawdownPct.toFixed(1)}%)`);
}
