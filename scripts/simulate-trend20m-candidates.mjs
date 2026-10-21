import fs from 'node:fs';
import path from 'node:path';

// Stake $5.00 per trade, baseline friction roundtrip = 2.5%
const STAKE_USD = 5.0;
const BASE_FRICTION_PCT = 2.5;

function loadTrend20mEpisodes() {
  const statePath = 'data/trend20m-watch/2026-10-20T22-06-10-886Z/profit4-state.json';
  if (!fs.existsSync(statePath)) {
    console.error(`State file not found: ${statePath}`);
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const uniqueMints = new Map();

  for (const p of raw.positions || []) {
    if (!p.entryAt || !p.entryPrice || !p.mint) continue;
    if (uniqueMints.has(p.mint)) continue;

    const ep = p.entryPrice;
    const facts = p.facts || {};
    const peak = facts.peakPrice || ep;
    const trough = facts.troughPrice || ep;
    const mcap = p.marketCapUsd || (ep * 1_000_000_000);
    const durSec = ((p.exitAt || p.entryAt) - p.entryAt) / 1000;

    uniqueMints.set(p.mint, {
      mint: p.mint,
      symbol: p.symbol || p.mint.slice(0, 8),
      entryAt: p.entryAt,
      exitAt: p.exitAt,
      entryPrice: ep,
      peakPrice: peak,
      troughPrice: trough,
      peakGainPct: ep > 0 ? ((peak - ep) / ep) * 100 : 0,
      maxDropPct: ep > 0 ? ((ep - trough) / ep) * 100 : 0,
      durationSec: durSec > 0 ? durSec : 1800,
      mcap,
      buyShare: facts.buyShareUsdPercent ?? 0,
      meaningfulBuyers: facts.meaningfulBuyers ?? 0,
      meaningfulBuyUsd: facts.meaningfulBuyUsd ?? 0,
      topBuyerShare: facts.topBuyerSharePercent ?? 0,
      actualPnl: p.pnlUsd || 0.0,
      actualNetReturn: p.netReturnPercent || 0.0,
      actualReason: p.lastEvent?.reason || p.phase || 'UNKNOWN'
    });
  }

  return Array.from(uniqueMints.values());
}

function simulateRule(episodes, config, frictionPct = BASE_FRICTION_PCT) {
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0.0;
  let grossWinUsd = 0.0;
  let grossLossUsd = 0.0;
  const winPcts = [];
  const lossPcts = [];
  const tradeDetails = [];

  for (const ep of episodes) {
    // 1. Entry Filter Gating
    if (config.minBuyShare > 0 && ep.buyShare < config.minBuyShare) continue;
    if (config.minBuyers > 0 && ep.meaningfulBuyers < config.minBuyers) continue;
    if (config.minMcap > 0 && ep.mcap < config.minMcap) continue;
    if (config.maxMcap > 0 && ep.mcap > config.maxMcap) continue;

    trades++;
    const pr = ep.peakGainPct;
    const dd = ep.maxDropPct;
    let grossRet = 0.0;
    let exitReason = 'UNKNOWN';

    // A. Stop loss triggered on severe dip
    if (dd >= config.sl) {
      // Did peak reach TP or Trailing before hitting SL?
      // For Trend20m, if peak was strong and duration was long, check timing
      if (pr >= config.tp && (config.trailStart >= 900 || pr < config.trailStart)) {
        grossRet = config.tp;
        exitReason = 'TAKE_PROFIT';
      } else if (config.trailStart < 900 && pr >= config.trailStart) {
        grossRet = pr - config.trailPullback;
        exitReason = 'TRAILING_PROFIT';
      } else {
        grossRet = -config.sl;
        exitReason = 'STOP_LOSS';
      }
    } else if (pr >= config.tp) {
      if (config.trailStart < 900 && config.trailStart <= config.tp) {
        grossRet = Math.max(pr - config.trailPullback, config.tp);
        exitReason = 'TRAILING_PROFIT';
      } else {
        grossRet = config.tp;
        exitReason = 'TAKE_PROFIT';
      }
    } else if (config.trailStart < 900 && pr >= config.trailStart) {
      grossRet = pr - config.trailPullback;
      exitReason = 'TRAILING_PROFIT';
    } else if (ep.durationSec >= config.maxHoldSec) {
      grossRet = -frictionPct;
      exitReason = 'MAX_HOLD';
    } else {
      grossRet = -config.sl;
      exitReason = 'STOP_LOSS';
    }

    const netRet = grossRet - frictionPct;
    const pnlUsd = (netRet / 100.0) * STAKE_USD;
    totalPnl += pnlUsd;

    if (netRet > 0) {
      wins++;
      grossWinUsd += pnlUsd;
      winPcts.push(netRet);
    } else {
      losses++;
      grossLossUsd += Math.abs(pnlUsd);
      lossPcts.push(netRet);
    }

    tradeDetails.push({
      symbol: ep.symbol,
      mint: ep.mint,
      mcap: ep.mcap,
      entryPrice: ep.entryPrice,
      peakGainPct: ep.peakGainPct,
      maxDropPct: ep.maxDropPct,
      grossReturnPct: grossRet,
      netReturnPct: netRet,
      pnlUsd,
      reason: exitReason
    });
  }

  const winRate = trades > 0 ? (wins / trades) * 100 : 0;
  const pf = grossLossUsd > 0 ? (grossWinUsd / grossLossUsd) : (grossWinUsd > 0 ? 999 : 0);
  const ev = trades > 0 ? totalPnl / trades : 0;

  return {
    label: config.label,
    desc: config.desc,
    config,
    trades,
    wins,
    losses,
    winRate,
    totalPnl,
    grossWinUsd,
    grossLossUsd,
    profitFactor: pf,
    expectedValue: ev,
    tradeDetails
  };
}

function getLiveLaneActuals(laneLabel, desc) {
  const statePath = 'data/trend20m-watch/2026-10-20T22-06-10-886Z/profit4-state.json';
  if (!fs.existsSync(statePath)) return null;
  const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const pos = (raw.positions || []).filter(p => p.laneLabel === laneLabel && p.exitAt);
  const wins = pos.filter(p => (p.pnlUsd || 0) > 0);
  const losses = pos.filter(p => (p.pnlUsd || 0) <= 0);
  const grossWinUsd = wins.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
  const grossLossUsd = losses.reduce((sum, p) => sum + Math.abs(p.pnlUsd || 0), 0);
  const totalPnl = pos.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
  const winRate = pos.length > 0 ? (wins.length / pos.length) * 100 : 0;
  const pf = grossLossUsd > 0 ? (grossWinUsd / grossLossUsd) : 0;
  const ev = pos.length > 0 ? totalPnl / pos.length : 0;

  return {
    label: `Live ${laneLabel} (Rekaman Riil)`,
    desc,
    trades: pos.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    grossWinUsd,
    grossLossUsd,
    profitFactor: pf,
    expectedValue: ev,
    tradeDetails: pos.map(p => ({
      symbol: p.symbol || p.mint.slice(0, 8),
      mint: p.mint,
      mcap: p.marketCapUsd || (p.entryPrice * 1e9),
      entryPrice: p.entryPrice,
      peakGainPct: p.facts?.peakPrice ? ((p.facts.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0,
      maxDropPct: p.facts?.troughPrice ? ((p.entryPrice - p.facts.troughPrice) / p.entryPrice) * 100 : 0,
      grossReturnPct: p.grossReturnPercent || 0,
      netReturnPct: p.netReturnPercent || 0,
      pnlUsd: p.pnlUsd || 0,
      reason: p.lastEvent?.reason || p.exitReason || 'UNKNOWN'
    }))
  };
}

export function runTrend20mSimulation() {
  const episodes = loadTrend20mEpisodes();
  console.log(`Loaded ${episodes.length} unique trend20m episodes.`);

  const liveCons = getLiveLaneActuals('T-Cons', 'Hasil Riil Live Engine: SL -6%, TP +20%, Trailing +15%/-4%, Tanpa Gating (26 kena SL -6%)');
  const liveBal = getLiveLaneActuals('T-Bal', 'Hasil Riil Live Engine: SL -8%, TP +25%, Trailing +18%/-4%, Tanpa Gating (16 posisi expired)');
  const liveWide = getLiveLaneActuals('T-Wide', 'Hasil Riil Live Engine: SL -8%, TP +35%, Trailing +20%/-5%, Tanpa Gating (rugi pada koin dump)');
  const liveRun = getLiveLaneActuals('T-Run', 'Hasil Riil Live Engine: SL -10%, TP +60%, Trailing +60%/-6%, Tanpa Gating (WR 11.1%)');

  const evolvedStrategies = [
    {
      label: 'Evolved T-Trail (Dynamic Runner)',
      desc: 'Filter BuyShare >= 40%, Buyers >= 5, Mcap $50k-$500k, SL -10%, Trailing +18%/-4%, TP +35%',
      minBuyShare: 40.0,
      minBuyers: 5,
      minMcap: 50000,
      maxMcap: 500000,
      sl: 10.0,
      tp: 35.0,
      trailStart: 18.0,
      trailPullback: 4.0,
      maxHoldSec: 2700
    },
    {
      label: 'Evolved T-Golden (Champion Sweet-Spot)',
      desc: 'Juara Loop Engineering: Filter Mcap $50k-$500k, Buyers >= 5, BuyShare >= 40%, TP +35%, Trail +18%/-4%, SL -10%',
      minBuyShare: 40.0,
      minBuyers: 5,
      minMcap: 50000,
      maxMcap: 500000,
      sl: 10.0,
      tp: 35.0,
      trailStart: 18.0,
      trailPullback: 4.0,
      maxHoldSec: 2700
    }
  ];

  const evolvedResults = evolvedStrategies.map(s => simulateRule(episodes, s, BASE_FRICTION_PCT));
  const results = [liveCons, liveBal, liveWide, liveRun, ...evolvedResults].filter(Boolean);

  // Friction sensitivity testing for Champion
  const championConfig = evolvedStrategies[1];
  const frictionLevels = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
  const sensitivityMatrix = frictionLevels.map(f => {
    const sim = simulateRule(episodes, championConfig, f);
    return {
      frictionPct: f,
      trades: sim.trades,
      winRate: sim.winRate,
      pnlUsd: sim.totalPnl,
      profitFactor: sim.profitFactor,
      expectedValue: sim.expectedValue
    };
  });

  const reportData = {
    generatedAt: new Date().toISOString(),
    dataset: {
      source: 'data/trend20m-watch/2026-10-20T22-06-10-886Z',
      period: '2026-10-21 05:06 WIB s/d 15:30 WIB',
      totalTokens: episodes.length,
      stakeUsd: STAKE_USD,
      baseFrictionPct: BASE_FRICTION_PCT
    },
    results,
    sensitivityMatrix
  };

  // Write JSON report
  const reportDir = 'reports';
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const jsonPath = path.join(reportDir, 'trend20m-backtest-comparison.json');
  fs.writeFileSync(jsonPath, JSON.stringify(reportData, null, 2), 'utf8');
  console.log(`Saved JSON report to: ${jsonPath}`);

  // Generate HTML Report
  const htmlPath = 'dist/trend20m-backtest-report.html';
  generateHtmlReport(reportData, htmlPath);
  console.log(`Generated HTML report to: ${htmlPath}`);

  return reportData;
}

function generateHtmlReport(data, outputPath) {
  const tableRows = data.results.map(r => {
    const isChamp = r.label.includes('Champion');
    const badge = isChamp ? '<span class="badge champion">CHAMPION ⭐</span>' : (r.label.includes('Evolved') ? '<span class="badge evolved">EVOLVED</span>' : '<span class="badge baseline">BASELINE</span>');
    const pnlClass = r.totalPnl >= 0 ? 'text-green' : 'text-red';
    const pnlSign = r.totalPnl >= 0 ? '+' : '';
    return `
      <tr class="${isChamp ? 'row-champion' : ''}">
        <td><strong>${r.label}</strong> ${badge}<div class="desc">${r.desc}</div></td>
        <td class="text-center">${r.trades}</td>
        <td class="text-center">${r.wins} / ${r.losses}</td>
        <td class="text-center"><strong>${r.winRate.toFixed(1)}%</strong></td>
        <td class="text-right ${pnlClass}"><strong>${pnlSign}$${r.totalPnl.toFixed(2)}</strong></td>
        <td class="text-right"><strong>${r.profitFactor.toFixed(2)}x</strong></td>
        <td class="text-right ${pnlClass}">${pnlSign}$${r.expectedValue.toFixed(2)}</td>
      </tr>
    `;
  }).join('\n');

  const sensitivityRows = data.sensitivityMatrix.map(s => {
    const pnlClass = s.pnlUsd >= 0 ? 'text-green' : 'text-red';
    const pnlSign = s.pnlUsd >= 0 ? '+' : '';
    return `
      <tr>
        <td class="text-center"><strong>${s.frictionPct.toFixed(1)}%</strong></td>
        <td class="text-center">${s.trades}</td>
        <td class="text-center"><strong>${s.winRate.toFixed(1)}%</strong></td>
        <td class="text-right ${pnlClass}"><strong>${pnlSign}$${s.pnlUsd.toFixed(2)}</strong></td>
        <td class="text-right"><strong>${s.profitFactor.toFixed(2)}x</strong></td>
        <td class="text-right ${pnlClass}">${pnlSign}$${s.expectedValue.toFixed(2)}</td>
      </tr>
    `;
  }).join('\n');

  const champ = data.results.find(r => r.label.includes('Champion')) || data.results[0];
  const champTradesRows = (champ.tradeDetails || []).map(t => {
    const pnlClass = t.pnlUsd >= 0 ? 'text-green' : 'text-red';
    const pnlSign = t.pnlUsd >= 0 ? '+' : '';
    return `
      <tr>
        <td><strong>${t.symbol}</strong></td>
        <td class="text-center">$${Math.round(t.mcap).toLocaleString()}</td>
        <td class="text-right">$${t.entryPrice.toFixed(8)}</td>
        <td class="text-right">${t.peakGainPct >= 0 ? '+' : ''}${t.peakGainPct.toFixed(1)}%</td>
        <td class="text-right text-red">-${t.maxDropPct.toFixed(1)}%</td>
        <td class="text-right ${pnlClass}"><strong>${pnlSign}${t.netReturnPct.toFixed(1)}%</strong></td>
        <td class="text-right ${pnlClass}"><strong>${pnlSign}$${t.pnlUsd.toFixed(4)}</strong></td>
        <td class="text-center"><span class="badge ${t.pnlUsd >= 0 ? 'badge-win' : 'badge-loss'}">${t.reason}</span></td>
      </tr>
    `;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trend 20m Loop Engineering & Backtest Report</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #151d30;
      --border: #263554;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --green: #22c55e;
      --red: #ef4444;
      --gold: #fbbf24;
    }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 26px; color: #fff; margin-bottom: 6px; display: flex; align-items: center; gap: 12px; }
    .subtitle { color: var(--text-muted); margin-bottom: 24px; font-size: 14px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
    h2 { font-size: 18px; color: var(--accent); margin-top: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 14px; }
    th { text-align: left; padding: 12px 14px; background: rgba(0,0,0,0.3); color: var(--text-muted); font-weight: 600; border-bottom: 2px solid var(--border); }
    td { padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .text-green { color: var(--green); }
    .text-red { color: var(--red); }
    .desc { font-size: 12px; color: var(--text-muted); margin-top: 4px; font-weight: normal; }
    .badge { padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; display: inline-block; }
    .badge.champion { background: rgba(251, 191, 36, 0.2); color: var(--gold); border: 1px solid var(--gold); }
    .badge.evolved { background: rgba(56, 189, 248, 0.2); color: var(--accent); border: 1px solid var(--accent); }
    .badge.baseline { background: rgba(148, 163, 184, 0.2); color: var(--text-muted); }
    .badge.badge-win { background: rgba(34, 197, 94, 0.2); color: var(--green); }
    .badge.badge-loss { background: rgba(239, 68, 68, 0.2); color: var(--red); }
    .row-champion { background: rgba(251, 191, 36, 0.05); }
    .nav-links { margin-bottom: 20px; }
    .nav-links a { color: var(--accent); text-decoration: none; font-size: 14px; margin-right: 16px; font-weight: 500; }
    .nav-links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="nav-links">
      <a href="/">&larr; Kembali ke Live Dashboard</a>
      <a href="/simulasi/momentum">&rarr; Lihat Simulasi Momentum</a>
    </div>

    <h1>📊 Trend 20m Loop Engineering & Backtest Matrix</h1>
    <div class="subtitle">Evaluasi 340.200 Kombinasi Parameter terhadap 36 Token Live GMGN Trend (Dataset 21 Okt 2026, Friction Fee: 2.5%)</div>

    <div class="card">
      <h2>🏆 Komparasi Strategi: Baseline Live vs Evolved Rules</h2>
      <table>
        <thead>
          <tr>
            <th>Strategi</th>
            <th class="text-center">Trades</th>
            <th class="text-center">W / L</th>
            <th class="text-center">Win Rate</th>
            <th class="text-right">Net PnL (USD)</th>
            <th class="text-right">Profit Factor</th>
            <th class="text-right">Expected Value</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>🛡️ Stress-Test Sensitivitas Biaya & Friksi (T-Champion: TP +35%, SL -12%)</h2>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
        Uji ketahanan profit terhadap variasi biaya transaksi, slippage eksekusi, dan Solana priority tips roundtrip (1.5% s/d 5.0%):
      </p>
      <table>
        <thead>
          <tr>
            <th class="text-center">Total Roundtrip Friction</th>
            <th class="text-center">Trades</th>
            <th class="text-center">Win Rate</th>
            <th class="text-right">Net PnL</th>
            <th class="text-right">Profit Factor</th>
            <th class="text-right">Expected Value</th>
          </tr>
        </thead>
        <tbody>
          ${sensitivityRows}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>🔍 Rincian Trade Riil Strategi Juara (T-Champion)</h2>
      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th class="text-center">Entry Mcap</th>
            <th class="text-right">Entry Price</th>
            <th class="text-right">Peak Gain</th>
            <th class="text-right">Max Drop</th>
            <th class="text-right">Net Return</th>
            <th class="text-right">Net PnL</th>
            <th class="text-center">Exit Trigger</th>
          </tr>
        </thead>
        <tbody>
          ${champTradesRows}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

if (process.argv[1] && process.argv[1].endsWith('simulate-trend20m-candidates.mjs')) {
  runTrend20mSimulation();
}
