import fs from 'fs';
import readline from 'readline';

const runDir = 'research/momentum-aggressive-2026-09-29T08-10-54-526Z';

const pct = (a, b) => (a / b - 1) * 100;
const positive = (n) => n !== null && Number.isFinite(n) && n > 0;

function cleanTape(tape, now, windowMs = 10_000) {
  const seen = new Set();
  let latestEventAt = -Infinity;
  return tape
    .filter(t => t.observedAt <= now && t.observedAt >= now - windowMs &&
      t.occurredAt <= now + 3000 && t.observedAt - t.occurredAt >= -3000 && t.observedAt - t.occurredAt <= 2000)
    .sort((a, b) => a.observedAt - b.observedAt || (a.raw?.si && b.raw?.si ? (BigInt(a.raw.si) < BigInt(b.raw.si) ? -1 : 1) : 0))
    .filter(t => {
      if (seen.has(t.id) || t.occurredAt < latestEventAt) return false;
      seen.add(t.id);
      latestEventAt = t.occurredAt;
      return true;
    });
}

function momentumMetrics(tape, now) {
  const clean = cleanTape(tape, now);
  const prices = clean.filter(t => positive(t.priceUsd));
  const latest = prices.at(-1);
  const anchor = prices.filter(t => t.observedAt <= now - 5_000).at(-1);
  const window = clean.filter(t => t.observedAt > now - 5_000);
  const buckets = new Map();
  for (const t of prices.filter(t => t.observedAt >= now - 5_000)) buckets.set(Math.floor(t.observedAt / 1000), t);
  const points = [...buckets.values()];
  const xs = points.map(t => (t.observedAt - now) / 1000);
  const ys = points.map(t => Math.log(t.priceUsd));
  const meanX = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const meanY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
  const varianceX = xs.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const slope = varianceX > 0 ? xs.reduce((a, x, i) => a + (x - meanX) * (ys[i] - meanY), 0) / varianceX : null;
  const buyUsd = window.filter(t => t.side === 'buy').reduce((s, t) => s + (positive(t.usd) ? t.usd : 0), 0);
  const sellUsd = window.filter(t => t.side === 'sell').reduce((s, t) => s + (positive(t.usd) ? t.usd : 0), 0);
  return {
    slope5s: slope === null ? null : Math.expm1(5 * slope) * 100,
    trades: window.length,
    buyUsd,
    sellUsd,
    buyShare: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) : null
  };
}

function simulatePosition(cfg, buy, trades) {
  const entryPrice = buy.entryPriceUsd;
  const entryTime = buy.observedAt;

  // Accurate chronologically sorted trades by observedAt + blockchain sequence ID (si)
  const postTrades = trades
    .filter(t => t.observedAt >= entryTime && positive(t.priceUsd))
    .sort((a, b) => a.observedAt - b.observedAt || (a.raw?.si && b.raw?.si ? (BigInt(a.raw.si) < BigInt(b.raw.si) ? -1 : 1) : 0));

  let peak = entryPrice;
  let closed = false;
  let exitTrade = null;
  let exitReason = null;
  let peakReturn = 0;

  const tapeHistory = [];

  for (const t of postTrades) {
    tapeHistory.push({
      id: t.raw?.id || `${t.observedAt}-${Math.random()}`,
      observedAt: t.observedAt,
      occurredAt: t.occurredAt,
      priceUsd: t.priceUsd,
      side: t.side,
      wallet: t.wallet,
      usd: t.amountUsd || t.amount,
      tokens: null,
      raw: t.raw
    });

    const now = t.observedAt;
    const r = pct(t.priceUsd, entryPrice);
    if (t.priceUsd > peak) peak = t.priceUsd;
    peakReturn = pct(peak, entryPrice);

    // 1. Hard stop
    if (r <= -cfg.hardStopPercent) {
      exitReason = 'HARD_STOP';
      exitTrade = t;
      closed = true;
      break;
    }

    // 2. Fixed Target Take Profit
    if (cfg.fixedTarget && r >= cfg.fixedTarget) {
      exitReason = `TARGET_${cfg.fixedTarget}%`;
      exitTrade = t;
      closed = true;
      break;
    }

    // 3. Dynamic Tiered Trailing Exit
    if (cfg.tiered) {
      for (const tier of cfg.tiers) {
        if (peakReturn >= tier.minPeak) {
          const trailFloor = (100 + peakReturn) * (1 - tier.trail / 100) - 100;
          const floor = Math.max(tier.lock, trailFloor);
          if (r <= floor) {
            exitReason = `TRAIL_T${tier.minPeak}`;
            exitTrade = t;
            closed = true;
          }
          break;
        }
      }
      if (closed) break;
    } else if (cfg.activationPercent && peakReturn >= cfg.activationPercent) {
      const trailFloor = (100 + peakReturn) * (1 - cfg.trailingPercent / 100) - 100;
      const floor = Math.max(cfg.lockPercent, trailFloor);
      if (r <= floor) {
        exitReason = 'PROFIT_TRAIL';
        exitTrade = t;
        closed = true;
        break;
      }
    }

    // 4. Stagnation Exit
    if (cfg.stagnationSeconds && (now - entryTime) >= cfg.stagnationSeconds * 1000) {
      if (peakReturn < (cfg.stagnationThreshold ?? 2.5)) {
        exitReason = 'STAGNATION';
        exitTrade = t;
        closed = true;
        break;
      }
    }

    // 5. Intelligent Flow Exit (Dump detection)
    if (cfg.flowExit) {
      const m = momentumMetrics(tapeHistory, now);
      const minTrades = cfg.flowMinTrades ?? 5;
      const minSellUsd = cfg.flowMinSellUsd ?? 150;
      const maxBuyShare = cfg.flowMaxBuyShare ?? 0.20;
      if (m.trades >= minTrades && m.sellUsd >= minSellUsd && m.buyShare !== null && m.buyShare <= maxBuyShare && (m.slope5s ?? 0) < 0) {
        exitReason = 'FLOW_DUMP';
        exitTrade = t;
        closed = true;
        break;
      }
    }
  }

  if (!closed && postTrades.length > 0) {
    exitTrade = postTrades[postTrades.length - 1];
    exitReason = 'OBSERVATION_END';
  }

  const exitPrice = exitTrade ? exitTrade.priceUsd : entryPrice;
  const socketReturn = pct(exitPrice, entryPrice);
  const duration = exitTrade ? (exitTrade.observedAt - entryTime) / 1000 : 0;
  // AMM realistic roundtrip friction (slippage + pump fee) ~3.5%
  const realNetReturn = socketReturn - 3.5;

  return {
    mint: buy.mint,
    name: buy.metadata?.name || buy.mint.slice(0, 8),
    symbol: buy.metadata?.symbol || '???',
    entryPrice,
    exitPrice,
    peakReturn,
    socketReturn,
    realNetReturn,
    duration,
    exitReason,
    isWin: socketReturn > 0,
    isRealWin: realNetReturn > 0
  };
}

async function main() {
  const simTrades = [];
  const simRl = readline.createInterface({ input: fs.createReadStream(`${runDir}/simulated-trades.jsonl`) });
  for await (const line of simRl) {
    if (line.trim()) simTrades.push(JSON.parse(line));
  }
  const buys = simTrades.filter(t => t.type === 'SIMULATED_BUY');

  const mints = new Set(buys.map(b => b.mint));
  const tradesByMint = new Map();
  for (const m of mints) tradesByMint.set(m, []);

  const tradeRl = readline.createInterface({ input: fs.createReadStream(`${runDir}/trades.jsonl`) });
  for await (const line of tradeRl) {
    if (!line.trim()) continue;
    const t = JSON.parse(line);
    if (mints.has(t.mint)) tradesByMint.get(t.mint).push(t);
  }

  // Pre-sort all trades with sequence ID
  for (const [m, tr] of tradesByMint) {
    tr.sort((a, b) => a.observedAt - b.observedAt || (a.raw?.si && b.raw?.si ? (BigInt(a.raw.si) < BigInt(b.raw.si) ? -1 : 1) : 0));
  }

  const candidateConfigs = [
    // 0. Baseline (Live Sekarang)
    {
      name: 'Baseline Live (Scalp Rapat 1%)',
      hardStopPercent: 3.0,
      activationPercent: 4.0,
      lockPercent: 2.5,
      trailingPercent: 1.0,
      stagnationSeconds: 12,
      stagnationThreshold: 2.5,
      flowExit: false
    },
    // 1. Moderate Scalp
    {
      name: 'Scalp 2% Trail (Act 6%, Lock 3%)',
      hardStopPercent: 3.5,
      activationPercent: 6.0,
      lockPercent: 3.0,
      trailingPercent: 2.0,
      stagnationSeconds: 15,
      stagnationThreshold: 2.5,
      flowExit: false
    },
    // 2. Wide Trail 8% (Kunci Temuan Elgatito)
    {
      name: 'Runner Wide-8 (Act 8%, Trail 8%, Lock 4%)',
      hardStopPercent: 3.5,
      activationPercent: 8.0,
      lockPercent: 4.0,
      trailingPercent: 8.0,
      stagnationSeconds: 20,
      stagnationThreshold: 3.0,
      flowExit: false
    },
    // 3. Wide Trail 7%
    {
      name: 'Runner Wide-7 (Act 8%, Trail 7%, Lock 4%)',
      hardStopPercent: 3.5,
      activationPercent: 8.0,
      lockPercent: 4.0,
      trailingPercent: 7.0,
      stagnationSeconds: 20,
      stagnationThreshold: 3.0,
      flowExit: false
    },
    // 4. Tiered Wide Runner (Multi-Stage)
    {
      name: 'Tiered Runner A (Peak 8->trail8%, Peak 25->trail6%, Peak 50->trail5%)',
      hardStopPercent: 3.5,
      stagnationSeconds: 25,
      stagnationThreshold: 3.0,
      flowExit: false,
      tiered: true,
      tiers: [
        { minPeak: 50, lock: 35.0, trail: 5.0 },
        { minPeak: 25, lock: 18.0, trail: 6.0 },
        { minPeak: 8,  lock: 3.5,  trail: 8.0 },
      ]
    },
    // 5. Tiered Runner B (More Aggressive Lock)
    {
      name: 'Tiered Runner B (Peak 8->trail7%, Peak 20->trail5%, Peak 40->trail4%)',
      hardStopPercent: 3.5,
      stagnationSeconds: 25,
      stagnationThreshold: 3.0,
      flowExit: false,
      tiered: true,
      tiers: [
        { minPeak: 40, lock: 30.0, trail: 4.0 },
        { minPeak: 20, lock: 14.0, trail: 5.0 },
        { minPeak: 8,  lock: 4.0,  trail: 7.0 },
      ]
    },
    // 6. Target Take Profit + Wide Trail
    {
      name: 'Take Profit +25% Fixed (or Trail 8%)',
      hardStopPercent: 3.5,
      fixedTarget: 25.0,
      activationPercent: 8.0,
      lockPercent: 4.0,
      trailingPercent: 8.0,
      stagnationSeconds: 20,
      stagnationThreshold: 3.0,
      flowExit: false
    },
    // 7. Target Take Profit +35% Fixed (or Trail 8%)
    {
      name: 'Take Profit +35% Fixed (or Trail 8%)',
      hardStopPercent: 3.5,
      fixedTarget: 35.0,
      activationPercent: 8.0,
      lockPercent: 4.0,
      trailingPercent: 8.0,
      stagnationSeconds: 20,
      stagnationThreshold: 3.0,
      flowExit: false
    },
    // 8. Target Take Profit +45% Fixed (or Tiered)
    {
      name: 'Take Profit +45% Fixed + Tiered Runner',
      hardStopPercent: 3.5,
      fixedTarget: 45.0,
      stagnationSeconds: 25,
      stagnationThreshold: 3.0,
      flowExit: false,
      tiered: true,
      tiers: [
        { minPeak: 25, lock: 18.0, trail: 6.0 },
        { minPeak: 8,  lock: 3.5,  trail: 8.0 },
      ]
    }
  ];

  const results = [];

  for (const cfg of candidateConfigs) {
    const list = [];
    for (const b of buys) {
      const tr = tradesByMint.get(b.mint) || [];
      const res = simulatePosition(cfg, b, tr);
      list.push(res);
    }
    const total = list.length;
    const wins = list.filter(r => r.isWin).length;
    const realWins = list.filter(r => r.isRealWin).length;
    const meanSocket = list.reduce((s, r) => s + r.socketReturn, 0) / total;
    const meanReal = list.reduce((s, r) => s + r.realNetReturn, 0) / total;
    const totalPnlUsd = list.reduce((s, r) => s + (r.realNetReturn / 100) * 0.25, 0);
    const winningTrades = list.filter(r => r.isRealWin);
    const avgWinnerGain = winningTrades.length > 0 ? winningTrades.reduce((s, r) => s + r.realNetReturn, 0) / winningTrades.length : 0;
    const maxGain = Math.max(...list.map(r => r.socketReturn));
    const avgHold = list.reduce((s, r) => s + r.duration, 0) / total;

    results.push({
      cfg,
      wins,
      total,
      winRate: (wins / total) * 100,
      realWins,
      realWinRate: (realWins / total) * 100,
      meanSocket,
      meanReal,
      totalPnlUsd,
      avgWinnerGain,
      maxGain,
      avgHold,
      trades: list
    });
  }

  console.log('='.repeat(125));
  console.log('COMPREHENSIVE RUNNER STRATEGY COMPARISON (N = 10 TRADED TOKENS)');
  console.log('='.repeat(125));
  console.log(
    'Strategy Name'.padEnd(46) +
    'Real WR'.padEnd(12) +
    'Mean Real Net'.padEnd(16) +
    'Avg Win Gain'.padEnd(14) +
    'Max Gain'.padEnd(12) +
    'Total PnL'.padEnd(14) +
    'Avg Hold'
  );
  console.log('-'.repeat(125));

  for (const r of results) {
    console.log(
      r.cfg.name.padEnd(46) +
      `${r.realWinRate.toFixed(1)}% (${r.realWins}/${r.total})`.padEnd(12) +
      `${(r.meanReal >= 0 ? '+' : '') + r.meanReal.toFixed(2)}%`.padEnd(16) +
      `+${r.avgWinnerGain.toFixed(2)}%`.padEnd(14) +
      `+${r.maxGain.toFixed(2)}%`.padEnd(12) +
      `${(r.totalPnlUsd >= 0 ? '+' : '')}$${r.totalPnlUsd.toFixed(4)}`.padEnd(14) +
      `${r.avgHold.toFixed(1)}s`
    );
  }

  // Find best config by total Real Net return
  const sorted = [...results].sort((a, b) => b.meanReal - a.meanReal);
  const best = sorted[0];
  const baseline = results[0];

  console.log('\n' + '='.repeat(125));
  console.log(`DETAILED TOKEN-BY-TOKEN COMPARISON: BASELINE vs TOP RUNNER [${best.cfg.name}]`);
  console.log('='.repeat(125));

  for (let i = 0; i < buys.length; i++) {
    const b = buys[i];
    const baseT = baseline.trades[i];
    const bestT = best.trades[i];
    const name = (b.metadata?.name || b.mint.slice(0, 8)).padEnd(14);

    console.log(`\n#${i + 1} ${name} (${b.metadata?.symbol})`);
    console.log(`   Peak Potensi: +${bestT.peakReturn.toFixed(2)}%`);
    console.log(`   Baseline    : Socket ${baseT.socketReturn >= 0 ? '+' : ''}${baseT.socketReturn.toFixed(2)}% | Real Net ${baseT.realNetReturn >= 0 ? '+' : ''}${baseT.realNetReturn.toFixed(2)}% | Exit: ${baseT.exitReason} (${baseT.duration.toFixed(1)}s)`);
    console.log(`   Top Runner  : Socket ${bestT.socketReturn >= 0 ? '+' : ''}${bestT.socketReturn.toFixed(2)}% | Real Net ${bestT.realNetReturn >= 0 ? '+' : ''}${bestT.realNetReturn.toFixed(2)}% | Exit: ${bestT.exitReason} (${bestT.duration.toFixed(1)}s)`);
    const gainDiff = bestT.realNetReturn - baseT.realNetReturn;
    console.log(`   Diff        : ${gainDiff >= 0 ? '🟢 +' : '🔴 '}${gainDiff.toFixed(2)}% net`);
  }
}

main().catch(console.error);
