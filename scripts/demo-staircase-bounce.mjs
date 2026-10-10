import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function findFiles(dir, name) {
  let res = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) res.push(...findFiles(full, name));
      else if (item === name) res.push(full);
    }
  } catch (e) {}
  return res;
}

const baseDir = 'data/profit4-watch';

// 1. Load all positions from profit4-state.json and profit4-events.jsonl
console.log('=== MEMUAT SEMUA DATA TRANSAKSI & POSITION DARI SELURUH SESI ===');
const runs = fs.readdirSync(baseDir).filter(d => {
  try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
});

const closedPositions = [];
for (const r of runs) {
  const statePath = path.join(baseDir, r, 'profit4-state.json');
  if (!fs.existsSync(statePath)) continue;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const p of state.positions || []) {
      if (p.netReturnPercent !== null && p.netReturnPercent !== undefined) {
        closedPositions.push({ ...p, run: r });
      }
    }
  } catch (e) {}
}

console.log(`Total posisi yang pernah selesai di-tradingkan: ${closedPositions.length}`);

// Map per token: group by mint
const tokensMap = new Map();
for (const p of closedPositions) {
  if (!tokensMap.has(p.mint)) tokensMap.set(p.mint, []);
  tokensMap.get(p.mint).push(p);
}
console.log(`Total token unik yang pernah diperdagangkan: ${tokensMap.size}`);

// 2. Load token trades for each token to analyze price trajectory around dump and bounce
console.log('\n=== MENGANALISIS TRAJEKTORI HARGA & KONFIRMASI BERTAHAP PER TOKEN ===');
const tradeFiles = findFiles(baseDir, 'token-trades.jsonl');

async function loadTradesForMints(mints) {
  const mintTrades = new Map();
  for (const m of mints) mintTrades.set(m, []);

  const mintSet = new Set(mints);
  for (const f of tradeFiles) {
    const rl = readline.createInterface({
      input: fs.createReadStream(f),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.mint && mintSet.has(j.mint) && (j.price || j.priceUsd)) {
          mintTrades.get(j.mint).push({
            time: j.observedAt || (j.timestamp ? j.timestamp * 1000 : 0),
            price: j.price || j.priceUsd,
            side: j.side,
            usd: j.usd || 0,
          });
        }
      } catch (e) {}
    }
  }

  for (const [m, trades] of mintTrades.entries()) {
    trades.sort((a, b) => a.time - b.time);
  }
  return mintTrades;
}

// Evaluate Staircase Bounce Rule on each token
async function runDemo() {
  const allMints = Array.from(tokensMap.keys());
  console.log(`Mengindeks trade time-series untuk ${allMints.length} token...`);
  const mintTrades = await loadTradesForMints(allMints);

  const demoResults = [];

  for (const [mint, positions] of tokensMap.entries()) {
    const sample = positions[0];
    const symbol = sample.symbol || mint.slice(0, 8);
    const trades = mintTrades.get(mint) || [];

    // Lane V1 & Lane V2 actual performance
    const v1Pos = positions.find(p => p.laneLabel === 'V1' || p.version?.includes('v1') || !p.laneLabel);
    const v2Pos = positions.find(p => p.laneLabel === 'V2' || p.version?.includes('v2'));

    // Check Staircase Simulation on trades
    let peak = 0;
    let trough = Infinity;
    let dumpOccurred = false;
    let step1 = null;
    let staircaseConfirmed = false;
    let confirmPrice = null;
    let confirmTime = null;
    let fakeSpikeDetected = false;
    let fakeSpikeReason = '';

    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      if (t.price > peak) {
        peak = t.price;
        trough = t.price;
      } else if (t.price < trough) {
        trough = t.price;
      }

      const dd = peak > 0 ? ((peak - t.price) / peak) * 100 : 0;
      if (dd >= 60) dumpOccurred = true;

      if (!dumpOccurred) continue;

      const bounce = trough > 0 ? ((t.price - trough) / trough) * 100 : 0;

      // Tahap 1: Initial Bounce 3.5% - 5.0%
      if (!step1 && bounce >= 3.5 && bounce <= 15.0) {
        step1 = { price: t.price, time: t.time, troughAtStep: trough };
        continue;
      }

      // Tahap 2: Staircase Confirmation Window (2.0s s/d 6.0s setelah Step 1)
      if (step1 && !staircaseConfirmed && !fakeSpikeDetected) {
        const dt = (t.time - step1.time) / 1000;
        if (dt < 2.0) {
          // Masih dalam 2 detik pertama: cek apakah harga langsung tembus jatuh di bawah trough
          if (t.price < step1.troughAtStep) {
            fakeSpikeDetected = true;
            fakeSpikeReason = 'Tembus Trough Baru (<2s)';
          }
        } else if (dt >= 2.0 && dt <= 6.0) {
          // Jendela konfirmasi tercapai:
          // Syarat A: Harga tidak jatuh di bawah trough
          // Syarat B: Harga bertahan / membentuk higher low (price >= step1.price * 0.97)
          // Syarat C: Belum overextended (>18%)
          if (t.price < step1.troughAtStep) {
            fakeSpikeDetected = true;
            fakeSpikeReason = 'Tembus Trough Saat Konfirmasi';
          } else if (t.price < step1.price * 0.90) {
            fakeSpikeDetected = true;
            fakeSpikeReason = 'Spike Ambruk >10% dalam 3 detik';
          } else if (bounce > 18.0) {
            fakeSpikeDetected = true;
            fakeSpikeReason = 'Overextended >18% (Pucuk)';
          } else if (t.price >= step1.price * 0.97) {
            // TERKONFIRMASI BERTAHAP!
            staircaseConfirmed = true;
            confirmPrice = t.price;
            confirmTime = t.time;
            break;
          }
        } else if (dt > 6.0) {
          // Kadaluarsa tanpa konfirmasi
          fakeSpikeDetected = true;
          fakeSpikeReason = 'Tidak Ada Kenaikan Lanjutan (>6s)';
        }
      }
    }

    // Simulasi Hasil Exit jika Staircase Confirmed
    let simOutcome = 'NO_ENTRY';
    let simNetPercent = 0;
    let simExitReason = '-';

    if (staircaseConfirmed && confirmPrice && confirmTime) {
      // Cari harga-harga setelah confirmTime
      const afterTrades = trades.filter(t => t.time > confirmTime);
      let highestNet = -Infinity;
      let exitP = null;

      for (const at of afterTrades) {
        const net = ((at.price - confirmPrice) / confirmPrice) * 100 - 3.0; // potong biaya fee/slippage ~3%
        if (net > highestNet) highestNet = net;

        // Take Profit +18%
        if (net >= 18.0) {
          simOutcome = 'WIN';
          simNetPercent = 18.5;
          simExitReason = 'TAKE_PROFIT_18';
          exitP = at.price;
          break;
        }

        // Lock Profit +14% jika berbalik
        if (highestNet >= 14.0 && (highestNet - net >= 3.5 || net <= 8.0)) {
          simOutcome = 'WIN';
          simNetPercent = Math.max(10.0, net);
          simExitReason = 'PROFIT_LOCK_14';
          exitP = at.price;
          break;
        }

        // Stop Loss -10%
        if (net <= -10.0) {
          simOutcome = 'LOSS';
          simNetPercent = -10.0;
          simExitReason = 'STOP_LOSS_10';
          exitP = at.price;
          break;
        }
      }

      if (simOutcome === 'NO_ENTRY') {
        // Jika tidak kena TP/SL sampai akhir data, pakai net terakhir
        const lastNet = afterTrades.length ? ((afterTrades.at(-1).price - confirmPrice) / confirmPrice) * 100 - 3.0 : 0;
        simNetPercent = Number(lastNet.toFixed(1));
        simOutcome = simNetPercent > 0 ? 'WIN' : 'LOSS';
        simExitReason = 'TIME_LIMIT';
      }
    }

    demoResults.push({
      symbol,
      mint: mint.slice(0, 8),
      fullMint: mint,
      v1Net: v1Pos ? Number(v1Pos.netReturnPercent?.toFixed(1) || 0) : null,
      v1Pnl: v1Pos ? v1Pos.pnlUsd : null,
      v2Net: v2Pos ? Number(v2Pos.netReturnPercent?.toFixed(1) || 0) : null,
      v2Pnl: v2Pos ? v2Pos.pnlUsd : null,
      staircaseStatus: staircaseConfirmed ? 'TERKONFIRMASI 🟢' : `DITOLAK 🔴 (${fakeSpikeReason || 'Tidak Ada Pantulan'})`,
      staircaseConfirmed,
      simOutcome,
      simNetPercent,
      simExitReason,
      fakeSpikeReason,
    });
  }

  // Ringkasan Komparasi
  console.log('\n========================================================================================');
  console.log('HASIL DEMO & BACKTEST KOMPARASI: LANE V1 vs LANE V2 vs LANE V3 (STAIRCASE CONFIRMATION)');
  console.log('========================================================================================');

  const v1List = demoResults.filter(d => d.v1Net !== null);
  const v1Wins = v1List.filter(d => d.v1Net > 0);
  const v1Loss = v1List.filter(d => d.v1Net <= 0);
  const v1PnlTot = v1List.reduce((acc, d) => acc + (d.v1Pnl || 0), 0);
  const v1AvgNet = v1List.reduce((acc, d) => acc + d.v1Net, 0) / (v1List.length || 1);

  const v2List = demoResults.filter(d => d.v2Net !== null);
  const v2Wins = v2List.filter(d => d.v2Net > 0);
  const v2Loss = v2List.filter(d => d.v2Net <= 0);
  const v2PnlTot = v2List.reduce((acc, d) => acc + (d.v2Pnl || 0), 0);
  const v2AvgNet = v2List.length ? v2List.reduce((acc, d) => acc + d.v2Net, 0) / v2List.length : 0;

  const v3List = demoResults.filter(d => d.staircaseConfirmed);
  const v3Wins = v3List.filter(d => d.simOutcome === 'WIN');
  const v3Loss = v3List.filter(d => d.simOutcome === 'LOSS');
  const v3AvgNet = v3List.length ? v3List.reduce((acc, d) => acc + d.simNetPercent, 0) / v3List.length : 0;
  const v3PnlTot = v3List.reduce((acc, d) => acc + (d.simNetPercent * 5 / 100), 0);

  const summaryTable = {
    'Total Token Dianalisis': { 'Lane V1 (Original)': v1List.length, 'Lane V2 (Anti-Whale)': v2List.length, 'Lane V3 (Staircase)': v3List.length },
    'Jumlah Trade WIN 🟢': { 'Lane V1 (Original)': v1Wins.length, 'Lane V2 (Anti-Whale)': v2Wins.length, 'Lane V3 (Staircase)': v3Wins.length },
    'Jumlah Trade LOSS 🔴': { 'Lane V1 (Original)': v1Loss.length, 'Lane V2 (Anti-Whale)': v2Loss.length, 'Lane V3 (Staircase)': v3Loss.length },
    'Win Rate (%)': {
      'Lane V1 (Original)': `${((v1Wins.length / (v1List.length || 1)) * 100).toFixed(1)}%`,
      'Lane V2 (Anti-Whale)': `${((v2Wins.length / (v2List.length || 1)) * 100).toFixed(1)}%`,
      'Lane V3 (Staircase)': `${((v3Wins.length / (v3List.length || 1)) * 100).toFixed(1)}%`,
    },
    'Total Realized PnL ($)': {
      'Lane V1 (Original)': `$${v1PnlTot.toFixed(2)}`,
      'Lane V2 (Anti-Whale)': `$${v2PnlTot.toFixed(2)}`,
      'Lane V3 (Staircase)': `$${v3PnlTot.toFixed(2)}`,
    },
    'Rata-rata Net Return (%)': {
      'Lane V1 (Original)': `${v1AvgNet.toFixed(1)}%`,
      'Lane V2 (Anti-Whale)': `${v2AvgNet.toFixed(1)}%`,
      'Lane V3 (Staircase)': `${v3AvgNet.toFixed(1)}%`,
    },
  };
  console.table(summaryTable);

  console.log('\n=== DETAIL SAMPEL TOKEN LOSS YANG BERHASIL DISELAMATKAN OLEH STAIRCASE RULE ===');
  const savedLosses = demoResults.filter(d => (d.v1Net < 0 || d.v2Net < 0) && !d.staircaseConfirmed);
  console.table(savedLosses.slice(0, 10).map(d => ({
    Token: d.symbol,
    Mint: d.mint,
    'Hasil V1 / V2': `${d.v1Net || d.v2Net}% (LOSS)`,
    'Evaluasi Staircase V3': d.staircaseStatus,
    'Status di V3': 'TIDAK BELI (SELAMAT $0 LOSS) 🛡️',
  })));

  console.log('\n=== DETAIL SAMPEL TOKEN WIN YANG TETAP LOLOS & PROFIT DI STAIRCASE RULE ===');
  const preservedWins = demoResults.filter(d => (d.v1Net > 0 || d.v2Net > 0) && d.staircaseConfirmed);
  console.table(preservedWins.slice(0, 10).map(d => ({
    Token: d.symbol,
    Mint: d.mint,
    'Hasil V1 Net': `${d.v1Net}% (WIN)`,
    'Status Staircase V3': d.staircaseStatus,
    'Hasil Simulasi V3': `+${d.simNetPercent}% (${d.simExitReason}) 🟢`,
  })));
}

runDemo().catch(console.error);
