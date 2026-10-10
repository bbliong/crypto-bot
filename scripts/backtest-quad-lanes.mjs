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

const tokensMap = new Map();
for (const p of closedPositions) {
  if (!tokensMap.has(p.mint)) tokensMap.set(p.mint, []);
  tokensMap.get(p.mint).push(p);
}

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

async function runBacktest() {
  const allMints = Array.from(tokensMap.keys());
  const mintTrades = await loadTradesForMints(allMints);

  const v1Results = [];
  const v2Results = [];
  const v3Results = []; // Precision TP +20%
  const v4Results = []; // Original V1 Rules (TP +30-35%, Stop -12%) + Staircase Confirmation

  for (const [mint, positions] of tokensMap.entries()) {
    const sample = positions[0];
    const symbol = sample.symbol || mint.slice(0, 8);
    const trades = mintTrades.get(mint) || [];

    const v1Pos = positions.find(p => p.laneLabel === 'V1' || p.version?.includes('v1') || !p.laneLabel);
    const v2Pos = positions.find(p => p.laneLabel === 'V2' || p.version?.includes('v2'));

    if (v1Pos && v1Pos.netReturnPercent != null) {
      v1Results.push({ symbol, mint, net: v1Pos.netReturnPercent, pnl: v1Pos.pnlUsd ?? (v1Pos.netReturnPercent / 100 * 5) });
    }
    if (v2Pos && v2Pos.netReturnPercent != null) {
      v2Results.push({ symbol, mint, net: v2Pos.netReturnPercent, pnl: v2Pos.pnlUsd ?? (v2Pos.netReturnPercent / 100 * 5) });
    }

    // Evaluate Staircase Confirmation
    let peak = 0;
    let trough = Infinity;
    let dumpOccurred = false;
    let step1 = null;
    let staircaseConfirmed = false;
    let confirmPrice = null;
    let confirmTime = null;
    let fakeSpikeDetected = false;

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

      // Step 1: Initial Bounce 3.5% - 15.0%
      if (!step1 && bounce >= 3.5 && bounce <= 15.0) {
        step1 = { price: t.price, time: t.time, troughAtStep: trough };
        continue;
      }

      // Step 2: Staircase Confirmation Window (2s - 6s)
      if (step1 && !staircaseConfirmed && !fakeSpikeDetected) {
        const dt = (t.time - step1.time) / 1000;
        if (dt < 2.0) {
          if (t.price < step1.troughAtStep * 0.98) fakeSpikeDetected = true;
        } else if (dt >= 2.0 && dt <= 6.0) {
          if (t.price < step1.troughAtStep * 0.98) fakeSpikeDetected = true;
          else if (t.price < step1.price * 0.90) fakeSpikeDetected = true;
          else if (bounce > 18.0) fakeSpikeDetected = true;
          else if (t.price >= step1.price * 0.97) {
            staircaseConfirmed = true;
            confirmPrice = t.price;
            confirmTime = t.time;
            break;
          }
        } else if (dt > 6.0) {
          fakeSpikeDetected = true;
        }
      }
    }

    // Jika Staircase Terkonfirmasi, hitung hasil untuk V3 (TP 20%) dan V4 (TP 35%)
    if (staircaseConfirmed && confirmPrice && confirmTime) {
      const afterTrades = trades.filter(t => t.time > confirmTime);
      let highestNet = -Infinity;

      // --- SIMULASI V3 (TP 20%, lock 14%, stop -10%) ---
      let v3Done = false;
      for (const at of afterTrades) {
        const net = ((at.price - confirmPrice) / confirmPrice) * 100 - 3.0; // biaya ~3%
        if (net > highestNet) highestNet = net;

        if (net >= 18.0) {
          v3Results.push({ symbol, mint, net: 18.5, pnl: 18.5 / 100 * 5, reason: 'TP_20' });
          v3Done = true;
          break;
        }
        if (highestNet >= 14.0 && (highestNet - net >= 3.5 || net <= 8.0)) {
          v3Results.push({ symbol, mint, net: Math.max(net, 10.0), pnl: Math.max(net, 10.0) / 100 * 5, reason: 'LOCK_14' });
          v3Done = true;
          break;
        }
        if (net <= -10.0) {
          v3Results.push({ symbol, mint, net: -10.5, pnl: -10.5 / 100 * 5, reason: 'STOP_10' });
          v3Done = true;
          break;
        }
      }
      if (!v3Done && afterTrades.length > 0) {
        const lastNet = ((afterTrades[afterTrades.length - 1].price - confirmPrice) / confirmPrice) * 100 - 3.0;
        v3Results.push({ symbol, mint, net: lastNet, pnl: lastNet / 100 * 5, reason: 'CLOSE' });
      }

      // --- SIMULASI V4 (TP +30% s/d +35%, Trailing Start 25%, Stop -12%) ---
      let v4Done = false;
      let highestNetV4 = -Infinity;
      for (const at of afterTrades) {
        const net = ((at.price - confirmPrice) / confirmPrice) * 100 - 3.0;
        if (net > highestNetV4) highestNetV4 = net;

        // Take Profit V4 Target Besar: >= 30%
        if (net >= 30.0) {
          const finalNet = Math.min(net, 35.0);
          v4Results.push({ symbol, mint, net: finalNet, pnl: finalNet / 100 * 5, reason: 'TARGET_BOUNCE_30_35' });
          v4Done = true;
          break;
        }
        // Trailing Profit V4: jika sudah sentuh >= 25% dan drawdown 5%
        if (highestNetV4 >= 25.0 && (highestNetV4 - net >= 5.0)) {
          const lockNet = Math.max(net, 20.0);
          v4Results.push({ symbol, mint, net: lockNet, pnl: lockNet / 100 * 5, reason: 'TRAILING_PROFIT_25' });
          v4Done = true;
          break;
        }
        // Stop Loss V4: -12%
        if (net <= -12.0) {
          v4Results.push({ symbol, mint, net: -12.5, pnl: -12.5 / 100 * 5, reason: 'STOP_LOSS_12' });
          v4Done = true;
          break;
        }
      }
      if (!v4Done && afterTrades.length > 0) {
        const lastNet = ((afterTrades[afterTrades.length - 1].price - confirmPrice) / confirmPrice) * 100 - 3.0;
        v4Results.push({ symbol, mint, net: lastNet, pnl: lastNet / 100 * 5, reason: 'CLOSE' });
      }
    }
  }

  function stat(arr) {
    const profit = arr.filter(x => x.net > 0);
    const loss = arr.filter(x => x.net < 0);
    const winRate = arr.length ? (profit.length / arr.length * 100).toFixed(1) + '%' : '0%';
    const totalPnl = arr.reduce((acc, x) => acc + x.pnl, 0);
    const meanNet = arr.length ? (arr.reduce((acc, x) => acc + x.net, 0) / arr.length).toFixed(1) + '%' : '0%';
    return {
      'Total Trade Selesai': arr.length,
      'Trade WIN 🟢': profit.length,
      'Trade LOSS 🔴': loss.length,
      'Win Rate %': winRate,
      'Total Realized PnL ($)': (totalPnl >= 0 ? '+$' : '-$') + Math.abs(totalPnl).toFixed(2),
      'Rata-rata Net Return %': (parseFloat(meanNet) >= 0 ? '+' : '') + meanNet,
    };
  }

  console.log('\n====================================================================================================');
  console.log('HASIL PERBANDINGAN KOMPREHENSIF SELURUH 4 LANE (V1, V2, V3, V4)');
  console.log('====================================================================================================');
  console.table({
    'Lane V1 (Original TP 35%)': stat(v1Results),
    'Lane V2 (Anti-Whale)': stat(v2Results),
    'Lane V3 (Precision TP 20%)': stat(v3Results),
    'Lane V4 (Original TP + Staircase)': stat(v4Results),
  });

  console.log('\n=== DETAIL TOP TOKEN WIN BESAR DI LANE V4 (NET +30% s/d +35%) ===');
  const v4Wins = v4Results.filter(x => x.net >= 25.0);
  console.log(`Total token yang sukses TP besar (+25% s/d +35%) di V4: ${v4Wins.length} token`);
  v4Wins.slice(0, 10).forEach((w, i) => {
    console.log(`${i+1}. ${w.symbol} (${w.mint.slice(0, 8)}...): Net +${w.net.toFixed(1)}% | PnL +$${w.pnl.toFixed(2)} [${w.reason}]`);
  });
}

runBacktest();
