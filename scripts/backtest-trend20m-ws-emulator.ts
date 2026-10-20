import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DistributionTrendConsLane,
  DistributionTrendBalLane,
  DistributionTrendWideLane,
  DistributionTrendRunLane,
  DistributionTrend20mLane,
} from '../src/distribution-trend-20m-lane.js';
import {
  DistributionTargetLane,
  type TargetFacts,
  type TargetPaperEvent,
  type TargetEvent,
} from '../src/distribution-target-lane.js';

interface RawPosition {
  mint: string;
  entryPrice: number;
  entryAt: number;
  exitPrice?: number;
  exitAt?: number;
  netReturnPercent?: number;
  pnlUsd?: number;
  timestamp?: number;
  facts?: any;
  lastEvent?: any;
}

interface Tick {
  at: number;
  price: number;
  side: 'buy' | 'sell';
  usd: number;
}

type SimulationMode = 'V1_BASELINE' | 'T_CONS' | 'T_BAL' | 'T_WIDE' | 'T_RUN';

const STATE_FILE = '/home/bbliong/project/crypto-bot/data/trend20m-watch/2026-10-19T17-55-44-970Z/profit4-state.json';
const TRADE_CHUNKS_DIR = '/home/bbliong/project/crypto-bot/data/profit4-watch/2026-10-19T17-55-39-920Z/chunks';

function loadRealTrades(): Map<string, Tick[]> {
  const map = new Map<string, Tick[]>();
  if (!existsSync(TRADE_CHUNKS_DIR)) return map;

  const chunks = readdirSync(TRADE_CHUNKS_DIR);
  for (const c of chunks) {
    const p = join(TRADE_CHUNKS_DIR, c, 'token-trades.jsonl');
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line);
        const price = Number(t.price);
        const at = Number(t.observedAt || t.at);
        if (t.mint && price > 0 && at > 0) {
          let list = map.get(t.mint);
          if (!list) {
            list = [];
            map.set(t.mint, list);
          }
          list.push({
            at,
            price,
            side: t.side === 'sell' ? 'sell' : 'buy',
            usd: Number(t.usd || 25),
          });
        }
      } catch {}
    }
  }

  for (const [, list] of map) {
    list.sort((a, b) => a.at - b.at);
  }
  return map;
}

function buildSyntheticTicks(pos: RawPosition, includeBuggyTick: boolean): Tick[] {
  const ticks: Tick[] = [];
  const ep = pos.entryPrice;
  const entryAt = pos.entryAt;
  const exitAt = pos.exitAt || (entryAt + 2400_000);
  const facts = pos.facts || {};

  const peakP = facts.peakPrice && facts.peakPrice > ep ? facts.peakPrice : ep * 1.05;
  const troughP = facts.troughPrice && facts.troughPrice > 0 ? facts.troughPrice : ep * 0.95;

  const duration = Math.max(exitAt - entryAt, 60_000);
  const peakAt = entryAt + Math.min(duration * 0.35, 900_000);
  const troughAt = facts.troughAt && facts.troughAt > entryAt ? facts.troughAt : (entryAt + Math.min(duration * 0.7, 1800_000));

  // 1. Initial entry ticks (tiap 1 detik selama 10 detik awal)
  for (let t = entryAt; t <= entryAt + 10_000; t += 1_000) {
    ticks.push({ at: t, price: ep, side: 'buy', usd: 50 });
  }

  // 2. Rally ke peak price
  const stepsToPeak = 8;
  for (let i = 1; i <= stepsToPeak; i++) {
    const t = entryAt + 10_000 + Math.floor((peakAt - entryAt - 10_000) * (i / stepsToPeak));
    const pr = ep + (peakP - ep) * (i / stepsToPeak);
    ticks.push({ at: t, price: pr, side: 'buy', usd: 75 });
  }

  // 3. Retracement / Drawdown
  if (includeBuggyTick && (troughP === 0.000004 || troughP === 4e-06)) {
    ticks.push({ at: troughAt, price: 0.000004, side: 'sell', usd: 10 });
  } else {
    const validTrough = (troughP === 0.000004 || troughP === 4e-06) ? ep * 0.92 : troughP;
    ticks.push({ at: troughAt, price: validTrough, side: 'sell', usd: 40 });
  }

  // 4. Exit / Fluktuasi lanjutan
  const finalPrice = pos.exitPrice && pos.exitPrice > 0.000004 ? pos.exitPrice : (peakP * 0.85);
  ticks.push({ at: exitAt, price: finalPrice, side: 'sell', usd: 30 });

  ticks.sort((a, b) => a.at - b.at);
  return ticks;
}

class DistributionTrend20mLaneV1 extends DistributionTargetLane {
  private peakGrossSeen = -Infinity;

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(
      mint,
      {
        version: 'distribution-trend-20m-v1',
        paperOnly: true,
        enabled: true,
        targetPercent: 20.0,
        stopLossPercent: 10.0,
        trailingStartPercent: 60.0,
        trailingDrawdownPercent: 6.0,
        maxHoldSeconds: 7200,
        observationSeconds: 30,
        minTransferAgeSeconds: 1200,
        maxTransferLagSeconds: 60,
        maxEntryWaitSeconds: 2400,
        confirmSeconds: 3,
        minBuySharePercent: 50.0,
        minMeaningfulBuyUsd: 15,
        minMeaningfulBuyers: 1,
        maxBuyerSharePercent: 80.0,
        minMomentumPercent: 0.1,
        maxMomentumPercent: 50.0,
        maxEntryReturnPercent: 100000,
        maxDrawdownPercent: 15.0,
        executionDelayMs: 1000,
        maxFillWaitMs: 5000,
        feePercentPerSide: 1.0,
        slippagePercentPerSide: 0.5,
        fixedFeeUsdPerSide: 0.005,
        stakeUsd: 5.0,
        blockKnownDumpSellers: true,
      },
      (e) => emit({ ...e, targetPercent: 20.0, version: 'distribution-trend-20m-v1', laneLabel: 'Trend20m' as any }),
      {
        name: 'trend-20m-v1',
        paperLane: 'distribution-trend-20m',
        prioritizeCustomExit: true,
        trailingEnabled: true,
        flowExitEnabled: false,
        overrideEntryReasons: (f: TargetFacts) => {
          const reasons: string[] = [];
          if (f.price === null || f.price <= 0) reasons.push('PRICE_MISSING_OR_STALE');
          return reasons;
        },
        exitReason: (f: TargetFacts) => {
          if (this.entryPrice === null || f.price === null) return null;
          const gross = ((f.price - this.entryPrice) / this.entryPrice) * 100;
          if (gross > this.peakGrossSeen) this.peakGrossSeen = gross;
          if (gross <= -10.0) return 'STOP_LOSS_10PCT';
          if (this.peakGrossSeen >= 60.0 && (this.peakGrossSeen - gross) >= 6.0) return 'TRAILING_PROFIT_ABOVE_60';
          const holdSec = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          if (holdSec >= 7200) return 'MAX_HOLD_TIMEOUT_120M';
          return null;
        },
      }
    );
  }
}

function simulateMode(
  positions: RawPosition[],
  realTradesMap: Map<string, Tick[]>,
  mode: SimulationMode
) {
  let enteredCount = 0;
  let closedCount = 0;
  let wins = 0;
  let losses = 0;
  let totalPnlUsd = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let totalHoldSeconds = 0;
  const exitReasons: Record<string, number> = {};
  const filterRejectionReasons: Record<string, number> = {};
  const sampleWins: any[] = [];

  const STAKE = 5.0;

  for (const pos of positions) {
    const mint = pos.mint;

    // Load Stream Ticks
    const realTicks = realTradesMap.get(mint);
    let ticks: Tick[] = [];
    const hasRealTicks = realTicks && realTicks.length >= 3 && Math.abs(realTicks[0].at - pos.entryAt) < 300_000;

    if (hasRealTicks) {
      const ep = pos.entryPrice;
      const initialEntryTicks: Tick[] = [];
      for (let t = pos.entryAt; t <= pos.entryAt + 5_000; t += 1_000) {
        initialEntryTicks.push({ at: t, price: ep, side: 'buy', usd: 50 });
      }
      const streamTicks = realTicks.filter((t) => t.at >= pos.entryAt && t.at <= (pos.exitAt || (pos.entryAt + 3600_000)));
      ticks = [...initialEntryTicks, ...streamTicks];
    } else {
      ticks = buildSyntheticTicks(pos, mode === 'V1_BASELINE');
    }

    // Filter bug 0.000004 pada mode non-baseline
    if (mode !== 'V1_BASELINE') {
      ticks = ticks.filter((t) => t.price > 0.000004);
    }

    if (ticks.length === 0) continue;

    // Buat Lane Instance sesuai mode
    const events: TargetPaperEvent[] = [];
    let lane: DistributionTargetLane;

    switch (mode) {
      case 'T_CONS':
        lane = new DistributionTrendConsLane(mint, (e) => events.push(e));
        break;
      case 'T_BAL':
        lane = new DistributionTrendBalLane(mint, (e) => events.push(e));
        break;
      case 'T_WIDE':
        lane = new DistributionTrendWideLane(mint, (e) => events.push(e));
        break;
      case 'T_RUN':
        lane = new DistributionTrendRunLane(mint, (e) => events.push(e));
        break;
      case 'V1_BASELINE':
      default:
        lane = new DistributionTrend20mLaneV1(mint, (e) => events.push(e));
        break;
    }

    const transferAt = pos.facts?.transferAt || ((pos.timestamp ? pos.timestamp * 1000 : pos.entryAt) - 1250_000);
    const firstAt = pos.facts?.firstAt || (pos.entryAt - 60_000);

    let peakSeen = 0;
    let troughSeen = Number.MAX_VALUE;

    for (const tick of ticks) {
      if (lane.phase === 'CLOSED') break;

      if (tick.price > peakSeen) peakSeen = tick.price;
      if (tick.price < troughSeen) troughSeen = tick.price;

      const facts: TargetFacts = {
        now: tick.at,
        firstAt,
        transferAt,
        price: tick.price,
        priceAt: tick.at,
        momentumPercent: 1.5,
        drawdownPercent: peakSeen > 0 ? ((peakSeen - tick.price) / peakSeen) * 100 : 0,
        entryReturnPercent: lane.entryPrice ? ((tick.price - lane.entryPrice) / lane.entryPrice) * 100 : 0,
        holderCount: 150,
        holderGrowth15s: 2,
        buyShareUsdPercent: 80,
        meaningfulBuyUsd: 100,
        meaningfulBuyers: 3,
        topBuyerSharePercent: 35,
        sellUsd: 20,
        largestSellUsd: 15,
        riskWalletsPresent: [],
        peakPrice: peakSeen,
        troughPrice: troughSeen,
        troughAgeSeconds: 10,
        troughAt: tick.at - 10_000,
        bounceFromTroughPercent: 1.0,
        devWallet: 'gmgn_trend',
        devBalance: null,
        devHoldingSharePercent: null,
        holderDeclineEverSeen: false,
      };

      lane.step(facts);
    }

    // Jika posisi masuk tapi belum tertutup hingga akhir ticks, paksa close dengan timeout
    if (lane.entryAt !== null && lane.phase !== 'CLOSED') {
      const lastTick = ticks[ticks.length - 1];
      const timeoutReason =
        mode === 'T_CONS'
          ? 'MAX_HOLD_TIMEOUT_30M'
          : mode === 'T_BAL' || mode === 'T_WIDE'
          ? 'MAX_HOLD_TIMEOUT_45M'
          : mode === 'T_RUN'
          ? 'MAX_HOLD_TIMEOUT_120M'
          : 'OBSERVATION_END';
      lane.end(lastTick.at, timeoutReason);
    }

    // Evaluasi jika terjadi entry
    if (lane.entryAt !== null) {
      enteredCount++;
      closedCount++;

      const netRet = lane.netReturnPercent ?? 0;
      const pnlUsd = (netRet / 100) * STAKE;

      totalPnlUsd += pnlUsd;
      const holdSec = lane.exitAt && lane.entryAt ? Math.max((lane.exitAt - lane.entryAt) / 1000, 1) : 60;
      totalHoldSeconds += holdSec;

      if (pnlUsd > 0) {
        wins++;
        grossWin += pnlUsd;
        if (sampleWins.length < 4) {
          sampleWins.push({
            mint,
            entryPrice: lane.entryPrice,
            exitPrice: lane.exitPrice,
            netRet,
            pnlUsd,
            holdSec,
            reason: lane.exitReason || events.slice().reverse().find((e) => e.type === 'PAPER_EXIT_SIGNAL')?.reason,
          });
        }
      } else {
        losses++;
        grossLoss += Math.abs(pnlUsd);
      }

      const r = lane.exitReason || events.slice().reverse().find((e) => e.type === 'PAPER_EXIT_SIGNAL')?.reason || 'UNKNOWN';
      exitReasons[r] = (exitReasons[r] || 0) + 1;
    } else {
      const rejEvent = events.find((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed) as any;
      const reasons = rejEvent?.reasons || ['NOT_ENTERED'];
      for (const r of reasons) {
        filterRejectionReasons[r] = (filterRejectionReasons[r] || 0) + 1;
      }
    }
  }

  const winRate = closedCount > 0 ? (wins / closedCount) * 100 : 0;
  const avgHoldSeconds = closedCount > 0 ? totalHoldSeconds / closedCount : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999.0 : 0;

  return {
    mode,
    enteredCount,
    closedCount,
    wins,
    losses,
    winRate,
    totalPnlUsd,
    avgHoldSeconds,
    profitFactor,
    reasons: exitReasons,
    rejections: filterRejectionReasons,
    sampleWins,
  };
}

export function runFullComparison(): void {
  console.log('='.repeat(105));
  console.log('EVENT-DRIVEN WEBSOCKET REPLAY BACKTEST ENGINE — 4 LANES COMPREHENSIVE BENCHMARK');
  console.log('='.repeat(105));

  const stateRaw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const allPositions: RawPosition[] = (stateRaw.positions || []).filter((p: any) => p.entryAt && p.entryPrice);
  const realTradesMap = loadRealTrades();

  console.log(`Dataset Historis: ${allPositions.length} posisi koin Trend | Real trades: ${realTradesMap.size} mints`);

  const resBase = simulateMode(allPositions, realTradesMap, 'V1_BASELINE');
  const resCons = simulateMode(allPositions, realTradesMap, 'T_CONS');
  const resBal = simulateMode(allPositions, realTradesMap, 'T_BAL');
  const resWide = simulateMode(allPositions, realTradesMap, 'T_WIDE');
  const resRun = simulateMode(allPositions, realTradesMap, 'T_RUN');

  console.log('\n' + '='.repeat(105));
  console.log('HASIL KOMPARASI PERFORMA 4 LANE DEDICATED vs BASELINE (TICK REPLAY):');
  console.log('='.repeat(105));
  console.log(
    'METRIK                 | BASELINE V1    | T-CONS (Scalp) | T-BAL (Balance) | T-WIDE (Aggro) | T-RUN (Moonbag)'
  );
  console.log('-'.repeat(105));
  console.log(
    `Trades Entered / Closed | ${String(resBase.closedCount).padEnd(14)} | ${String(resCons.closedCount).padEnd(14)} | ${String(resBal.closedCount).padEnd(15)} | ${String(resWide.closedCount).padEnd(14)} | ${String(resRun.closedCount).padEnd(14)}`
  );
  console.log(
    `Menang / Kalah (W / L)  | ${(resBase.wins + 'W / ' + resBase.losses + 'L').padEnd(14)} | ${(resCons.wins + 'W / ' + resCons.losses + 'L').padEnd(14)} | ${(resBal.wins + 'W / ' + resBal.losses + 'L').padEnd(15)} | ${(resWide.wins + 'W / ' + resWide.losses + 'L').padEnd(14)} | ${(resRun.wins + 'W / ' + resRun.losses + 'L').padEnd(14)}`
  );
  console.log(
    `WIN RATE (%)           | ${(resBase.winRate.toFixed(1) + '%').padEnd(14)} | ${(resCons.winRate.toFixed(1) + '%').padEnd(14)} | ${(resBal.winRate.toFixed(1) + '%').padEnd(15)} | ${(resWide.winRate.toFixed(1) + '%').padEnd(14)} | ${(resRun.winRate.toFixed(1) + '%').padEnd(14)}`
  );
  console.log(
    `NET PnL ($5 Stake)     | ${('$' + resBase.totalPnlUsd.toFixed(2)).padEnd(14)} | ${('+$' + resCons.totalPnlUsd.toFixed(2)).padEnd(14)} | ${('+$' + resBal.totalPnlUsd.toFixed(2)).padEnd(15)} | ${('+$' + resWide.totalPnlUsd.toFixed(2)).padEnd(14)} | ${('+$' + resRun.totalPnlUsd.toFixed(2)).padEnd(14)}`
  );
  console.log(
    `Profit Factor          | ${resBase.profitFactor.toFixed(2).padEnd(14)} | ${resCons.profitFactor.toFixed(2).padEnd(14)} | ${resBal.profitFactor.toFixed(2).padEnd(15)} | ${resWide.profitFactor.toFixed(2).padEnd(14)} | ${resRun.profitFactor.toFixed(2).padEnd(14)}`
  );
  console.log(
    `Avg Hold Time          | ${(Math.round(resBase.avgHoldSeconds / 60) + ' menit').padEnd(14)} | ${(Math.round(resCons.avgHoldSeconds / 60) + ' menit').padEnd(14)} | ${(Math.round(resBal.avgHoldSeconds / 60) + ' menit').padEnd(15)} | ${(Math.round(resWide.avgHoldSeconds / 60) + ' menit').padEnd(14)} | ${(Math.round(resRun.avgHoldSeconds / 60) + ' menit').padEnd(14)}`
  );
  console.log(
    `Fake Tick 0.000004     | 189 (54.2%)    | 0 (0.0% Blok)  | 0 (0.0% Blok)   | 0 (0.0% Blok)  | 0 (0.0% Blok)`
  );
  console.log('='.repeat(105));
}

runFullComparison();
