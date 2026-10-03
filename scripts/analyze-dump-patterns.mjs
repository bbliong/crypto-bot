import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const researchDir = 'research';
const runDirs = readdirSync(researchDir).filter(d => 
  d.startsWith('momentum-aggressive-') || 
  d.startsWith('2026-09-') || 
  d.startsWith('mc-low-loss-')
);

const instantDumps = []; // Peak <= 1.0% & ended in loss
const microPumps = [];   // 1.0% < Peak <= 8.0% & ended in loss
const runners = [];      // Peak >= 15.0% (successful pumps)
const midTrades = [];    // Others

let totalAnalyzed = 0;

for (const dir of runDirs) {
  const simPath = join(researchDir, dir, 'simulated-trades.jsonl');
  if (!existsSync(simPath)) continue;

  let lines = [];
  try {
    lines = readFileSync(simPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { continue; }

  const buys = lines.filter(l => l.type === 'SIMULATED_BUY');
  const sells = lines.filter(l => l.type === 'SIMULATED_SELL');
  const sellsByPos = new Map(sells.map(s => [s.positionId, s]));

  for (const buy of buys) {
    const sell = sellsByPos.get(buy.positionId);
    if (!sell) continue;

    totalAnalyzed++;
    const peak = sell.decision?.peakReturnPercent ?? sell.peakReturnPercent ?? 0;
    const finalReturn = sell.pnlPercent ?? sell.decision?.returnPercent ?? 0;
    const durationSec = Math.max(0.1, Number(((sell.observedAt - buy.observedAt) / 1000).toFixed(1)));
    const exitReason = sell.reason || sell.exitReason || 'UNKNOWN';

    const gate = buy.entryGate || {};
    const metrics = gate.momentum?.metrics || gate.aggressive?.metrics || {};
    const holders = gate.holderDistribution || {};
    const flow20s = gate.tradeFlow20s || {};

    const tradeData = {
      dir,
      mint: buy.mint,
      symbol: buy.metadata?.symbol || 'UNKNOWN',
      lane: buy.paperLane || 'control',
      peak,
      finalReturn,
      durationSec,
      exitReason,
      // Metrics at entry
      inflow5s: metrics.buyUsd ?? null,
      sellUsd5s: metrics.sellUsd ?? null,
      buyShare5s: metrics.buyShare != null ? metrics.buyShare * 100 : null,
      topBuyerShare: metrics.topBuyerShare != null ? metrics.topBuyerShare * 100 : null,
      return5s: metrics.return5s ?? null,
      slope5s: metrics.slope5s ?? null,
      volatility5s: metrics.volatilityPercent ?? null,
      trades5s: metrics.trades ?? null,
      buyers5s: metrics.buyers ?? null,
      // Holder distribution
      top1Percent: holders.top1Percent ?? null,
      top5Percent: holders.top5Percent ?? null,
      devPercent: holders.devPercent ?? null,
      holderCount: holders.holderCount ?? null,
      // 20s flow
      buyShare20s: flow20s.buySharePercent ?? null,
    };

    if (peak <= 1.0 && finalReturn < 0) {
      instantDumps.push(tradeData);
    } else if (peak > 1.0 && peak <= 8.0 && finalReturn < 0) {
      microPumps.push(tradeData);
    } else if (peak >= 15.0) {
      runners.push(tradeData);
    } else {
      midTrades.push(tradeData);
    }
  }
}

function computeAverages(list) {
  if (!list.length) return {};
  const avg = (fn) => {
    const vals = list.map(fn).filter(v => v !== null && !isNaN(v) && Number.isFinite(v));
    if (!vals.length) return null;
    return Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2));
  };
  const median = (fn) => {
    const vals = list.map(fn).filter(v => v !== null && !isNaN(v) && Number.isFinite(v)).sort((a,b) => a-b);
    if (!vals.length) return null;
    return Number(vals[Math.floor(vals.length / 2)].toFixed(2));
  };

  const exitReasons = list.reduce((acc, t) => {
    acc[t.exitReason] = (acc[t.exitReason] || 0) + 1;
    return acc;
  }, {});

  return {
    count: list.length,
    percentage: Number(((list.length / totalAnalyzed) * 100).toFixed(1)),
    avgDurationSec: avg(t => t.durationSec),
    medianDurationSec: median(t => t.durationSec),
    avgPeakReturn: avg(t => t.peak),
    avgFinalReturn: avg(t => t.finalReturn),
    avgInflow5s: avg(t => t.inflow5s),
    avgBuyShare5s: avg(t => t.buyShare5s),
    avgTopBuyerShare: avg(t => t.topBuyerShare),
    avgReturn5sAtEntry: avg(t => t.return5s),
    avgVolatility5s: avg(t => t.volatility5s),
    avgDevPercent: avg(t => t.devPercent),
    avgTop1Percent: avg(t => t.top1Percent),
    avgHolderCount: avg(t => t.holderCount),
    avgBuyShare20s: avg(t => t.buyShare20s),
    exitReasons,
  };
}

const statsInstant = computeAverages(instantDumps);
const statsMicro = computeAverages(microPumps);
const statsRunners = computeAverages(runners);

console.log(JSON.stringify({
  totalAnalyzed,
  instantDumps: statsInstant,
  microPumps: statsMicro,
  runners: statsRunners,
  sampleInstantDumps: instantDumps.slice(0, 5),
  sampleMicroPumps: microPumps.slice(0, 5),
  sampleRunners: runners.slice(0, 5),
}, null, 2));
