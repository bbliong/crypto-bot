import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  DistributionBounceLane,
  DistributionBounceLaneV2,
  DistributionBounceLaneV3,
  DistributionBounceLaneV4,
  BOUNCE_TARGET_PERCENT,
  BOUNCE_TARGET_PERCENT_V3,
  BOUNCE_TARGET_PERCENT_V4,
} from '../src/distribution-bounce-lane.js';
import { TargetObservation } from '../src/distribution-target-lane.js';

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

// 1. Kumpulkan semua posisi / token dari run directories
const runs = fs.readdirSync(baseDir).filter(d => {
  try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
});

const tokensMap = new Map();
for (const r of runs) {
  const statePath = path.join(baseDir, r, 'profit4-state.json');
  if (!fs.existsSync(statePath)) continue;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const p of state.positions || []) {
      if (!tokensMap.has(p.mint)) {
        tokensMap.set(p.mint, {
          mint: p.mint,
          symbol: p.symbol || p.mint.slice(0, 8),
          timestamp: p.timestamp || (p.entryAt ? p.entryAt / 1000 : 0),
          runs: [r],
          positions: [p],
        });
      } else {
        tokensMap.get(p.mint).runs.push(r);
        tokensMap.get(p.mint).positions.push(p);
      }
    }
  } catch (e) {}
}

console.log(`Loaded ${tokensMap.size} unique tokens.`);

// 2. Load trades and holder frames
const tradeFiles = findFiles(baseDir, 'token-trades.jsonl');
const mintTrades = new Map();
for (const m of tokensMap.keys()) mintTrades.set(m, []);

const mintSet = new Set(tokensMap.keys());
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
          wallet: j.wallet,
        });
      }
    } catch (e) {}
  }
}

// Sort trades
for (const [m, trades] of mintTrades.entries()) {
  trades.sort((a, b) => a.time - b.time);
}

// 3. Simulasi replay per token untuk Lane V1, V2, V3, V4
function simulateLane(tokenInfo, trades, LaneClass) {
  const mint = tokenInfo.mint;
  let closedPosition = null;
  const events = [];

  const lane = new LaneClass(mint, (event) => {
    events.push(event);
    if (event.type === 'PAPER_SELL') {
      closedPosition = event;
    }
  });

  const obs = new TargetObservation(tokenInfo.timestamp * 1000);

  // Group trades or step trade-by-trade
  for (const t of trades) {
    obs.trade({
      at: t.time,
      price: t.price,
      side: t.side,
      usd: t.usd,
      wallet: t.wallet,
      timestamp: t.time / 1000,
    });

    const facts = obs.facts(t.time, []);
    lane.step(facts);

    if (lane.phase === 'CLOSED') {
      break;
    }
  }

  return {
    lane,
    closedPosition,
    events,
    phase: lane.phase,
    entryAt: lane.entryAt,
    entryPrice: lane.entryPrice,
    exitAt: lane.exitAt,
    exitPrice: lane.exitPrice,
    netReturnPercent: lane.netReturnPercent,
  };
}

const results = {
  v1: [],
  v2: [],
  v3: [],
  v4: [],
};

for (const [mint, info] of tokensMap.entries()) {
  const trades = mintTrades.get(mint) || [];
  if (!trades.length) continue;

  const sim1 = simulateLane(info, trades, DistributionBounceLane);
  const sim2 = simulateLane(info, trades, DistributionBounceLaneV2);
  const sim3 = simulateLane(info, trades, DistributionBounceLaneV3);
  const sim4 = simulateLane(info, trades, DistributionBounceLaneV4);

  results.v1.push({ symbol: info.symbol, mint, ...sim1 });
  results.v2.push({ symbol: info.symbol, mint, ...sim2 });
  results.v3.push({ symbol: info.symbol, mint, ...sim3 });
  results.v4.push({ symbol: info.symbol, mint, ...sim4 });
}

function summarize(arr) {
  const entries = arr.filter(x => x.entryAt !== null);
  const closed = entries.filter(x => x.netReturnPercent !== null);
  const profit = closed.filter(x => x.netReturnPercent > 0);
  const loss = closed.filter(x => x.netReturnPercent < 0);
  const totalPnlUsd = closed.reduce((acc, x) => acc + (x.netReturnPercent / 100 * 5), 0);
  const winRate = closed.length ? (profit.length / closed.length) * 100 : 0;
  const meanNet = closed.length ? closed.reduce((acc, x) => acc + x.netReturnPercent, 0) / closed.length : 0;

  return {
    totalEvaluated: arr.length,
    entries: entries.length,
    closed: closed.length,
    profit: profit.length,
    loss: loss.length,
    winRate: winRate.toFixed(1) + '%',
    totalPnlUsd: (totalPnlUsd >= 0 ? '+$' : '-$') + Math.abs(totalPnlUsd).toFixed(2),
    meanNet: (meanNet >= 0 ? '+' : '') + meanNet.toFixed(2) + '%',
  };
}

console.log('\n=== HASIL BACKTEST & PERBANDINGAN PERFORMA 4 LANE PADA SELURUH DATASET ===');
console.table({
  'Lane V1 (Original TP 35%)': summarize(results.v1),
  'Lane V2 (Anti-Whale)': summarize(results.v2),
  'Lane V3 (Precision TP 20%)': summarize(results.v3),
  'Lane V4 (Original + Staircase)': summarize(results.v4),
});

// Detail perbandingan pada token-token yang tadinya LOSS fatal di V1
console.log('\n=== DETAIL PENGUJIAN PADA TOKEN-TOKEN LOSS FATAL V1 DI LANE V4 ===');
const fatalLosses = ['Mr Beast', 'Cap Coin', 'GTA 6 Coin', 'Fartguy', 'LEGO', 'Muse AI'];
for (const name of fatalLosses) {
  const r1 = results.v1.find(x => x.symbol.toLowerCase().includes(name.toLowerCase()));
  const r4 = results.v4.find(x => x.symbol.toLowerCase().includes(name.toLowerCase()));
  if (r1 && r4) {
    console.log(`Token: ${r1.symbol} (${r1.mint.slice(0, 8)}...)`);
    console.log(`  - Lane V1: Entry: ${r1.entryAt ? 'YES' : 'NO'}, Net: ${r1.netReturnPercent != null ? r1.netReturnPercent.toFixed(1) + '%' : 'N/A'}`);
    console.log(`  - Lane V4: Entry: ${r4.entryAt ? 'YES' : 'NO'}, Net: ${r4.netReturnPercent != null ? r4.netReturnPercent.toFixed(1) + '%' : 'NO ENTRY (Terfilter Aman)'}`);
  }
}

// Token yang WIN di Lane V4
console.log('\n=== CONTOH TOKEN WIN DI LANE V4 (DENGAN TP BESAR +30% s/d +35%) ===');
const v4Wins = results.v4.filter(x => x.netReturnPercent !== null && x.netReturnPercent > 0);
v4Wins.slice(0, 10).forEach(w => {
  console.log(`- ${w.symbol}: Net ${w.netReturnPercent.toFixed(1)}% | PnL +$${(w.netReturnPercent/100*5).toFixed(2)} | Hold: ${((w.exitAt - w.entryAt)/1000).toFixed(0)}s`);
});
