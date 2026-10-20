import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DistributionMomentumScalpLane,
  DistributionMomentumTrendLane,
  DistributionMApex10kLane,
} from '../src/distribution-evolved-momentum-lanes.js';
import {
  DistributionWave2ScalpLane,
  DistributionWave2TrendLane,
} from '../src/distribution-wave2-lane.js';
import {
  DistributionTargetLane,
  type TargetFacts,
  type TargetPaperEvent,
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

type SimulationMode = 'V1_BASELINE_BUGGY' | 'V1_BASELINE_CLEAN' | 'M_SCALP' | 'M_TREND' | 'W2_SCALP' | 'W2_TREND';

const MOMENTUM_DIRS = [
  '/home/bbliong/project/crypto-bot/data/momentum-watch/2026-10-19T17-31-04-571Z',
  '/home/bbliong/project/crypto-bot/data/momentum-watch/2026-10-19T17-55-44-959Z',
  '/home/bbliong/project/crypto-bot/data/momentum-watch/2026-10-20T04-19-43-518Z',
  '/home/bbliong/project/crypto-bot/data/momentum-watch/2026-10-20T06-55-43-888Z',
];

const TRADE_CHUNKS_DIRS = [
  '/home/bbliong/project/crypto-bot/data/profit4-watch/2026-10-19T17-55-39-920Z/chunks',
  '/home/bbliong/project/crypto-bot/data/profit4-watch/2026-10-20T04-19-36-377Z/chunks',
  '/home/bbliong/project/crypto-bot/data/profit4-watch/2026-10-20T06-55-37-208Z/chunks',
];

function loadRealTrades(): Map<string, Tick[]> {
  const map = new Map<string, Tick[]>();
  for (const chunksDir of TRADE_CHUNKS_DIRS) {
    if (!existsSync(chunksDir)) continue;
    const chunks = readdirSync(chunksDir);
    for (const c of chunks) {
      const p = join(chunksDir, c, 'token-trades.jsonl');
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
  }

  for (const [, list] of map) {
    list.sort((a, b) => a.at - b.at);
  }
  return map;
}

function loadAllPositions(): RawPosition[] {
  const list: RawPosition[] = [];
  const seen = new Set<string>();

  for (const dir of MOMENTUM_DIRS) {
    const fpath = join(dir, 'profit4-state.json');
    if (!existsSync(fpath)) continue;
    try {
      const d = JSON.parse(readFileSync(fpath, 'utf8'));
      for (const p of d.positions || []) {
        if (!p.entryPrice || !p.entryAt || !p.mint) continue;
        const key = `${p.mint}:${p.entryAt}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(p);
      }
    } catch {}
  }
  return list;
}

function buildSyntheticTicks(pos: RawPosition, includeBuggyTick: boolean): Tick[] {
  const ticks: Tick[] = [];
  const ep = pos.entryPrice;
  const entryAt = pos.entryAt;
  const exitAt = pos.exitAt || (entryAt + 300_000);
  const facts = pos.facts || {};

  const peakP = facts.peakPrice && facts.peakPrice > ep ? facts.peakPrice : ep * 1.05;
  const troughP = facts.troughPrice && facts.troughPrice > 0 ? facts.troughPrice : ep * 0.95;

  const duration = Math.max(exitAt - entryAt, 60_000);
  const peakAt = entryAt + Math.min(duration * 0.35, 120_000);
  const troughAt = facts.troughAt && facts.troughAt > entryAt ? facts.troughAt : (entryAt + Math.min(duration * 0.7, 240_000));

  // 1. Initial entry ticks (tiap 1 detik selama 5 detik)
  for (let t = entryAt; t <= entryAt + 5_000; t += 1_000) {
    ticks.push({ at: t, price: ep, side: 'buy', usd: 50 });
  }

  // 2. Rally ke peak price
  const stepsToPeak = 6;
  for (let i = 1; i <= stepsToPeak; i++) {
    const t = entryAt + 5_000 + Math.floor((peakAt - entryAt - 5_000) * (i / stepsToPeak));
    const pr = ep + (peakP - ep) * (i / stepsToPeak);
    ticks.push({ at: t, price: pr, side: 'buy', usd: 75 });
  }

  // 3. Retracement / Drawdown
  if (includeBuggyTick && (troughP === 0.000004 || troughP === 4e-06)) {
    ticks.push({ at: troughAt, price: 0.000004, side: 'sell', usd: 10 });
  } else {
    const validTrough = (troughP === 0.000004 || troughP === 4e-06) ? ep * 0.93 : troughP;
    ticks.push({ at: troughAt, price: validTrough, side: 'sell', usd: 40 });
  }

  // 4. Final exit
  const finalPrice = pos.exitPrice && pos.exitPrice > 0.000004 ? pos.exitPrice : (peakP * 0.9);
  ticks.push({ at: exitAt, price: finalPrice, side: 'sell', usd: 30 });

  ticks.sort((a, b) => a.at - b.at);
  return ticks;
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

  const STAKE = 5.0;

  for (const pos of positions) {
    const mint = pos.mint;

    // Load stream ticks
    const realTicks = realTradesMap.get(mint);
    let ticks: Tick[] = [];
    const hasRealTicks = realTicks && realTicks.length >= 3 && Math.abs(realTicks[0].at - pos.entryAt) < 300_000;

    if (hasRealTicks) {
      const ep = pos.entryPrice;
      const initialEntryTicks: Tick[] = [];
      for (let t = pos.entryAt; t <= pos.entryAt + 3_000; t += 1_000) {
        initialEntryTicks.push({ at: t, price: ep, side: 'buy', usd: 50 });
      }
      const streamTicks = realTicks.filter((t) => t.at >= pos.entryAt && t.at <= (pos.exitAt || (pos.entryAt + 600_000)));
      ticks = [...initialEntryTicks, ...streamTicks];
    } else {
      ticks = buildSyntheticTicks(pos, mode === 'V1_BASELINE_BUGGY');
    }

    if (mode !== 'V1_BASELINE_BUGGY') {
      ticks = ticks.filter((t) => t.price > 0.000004);
    }

    if (ticks.length === 0) continue;

    // Buat Lane Instance
    const events: TargetPaperEvent[] = [];
    let lane: DistributionTargetLane;

    switch (mode) {
      case 'W2_SCALP':
        lane = new DistributionWave2ScalpLane(mint, (e) => events.push(e));
        break;
      case 'W2_TREND':
        lane = new DistributionWave2TrendLane(mint, (e) => events.push(e));
        break;
      case 'M_SCALP':
        lane = new DistributionMomentumScalpLane(mint, (e) => events.push(e));
        break;
      case 'M_TREND':
        lane = new DistributionMomentumTrendLane(mint, (e) => events.push(e));
        break;
      case 'V1_BASELINE_CLEAN':
      case 'V1_BASELINE_BUGGY':
      default:
        lane = new DistributionMApex10kLane(mint, (e) => events.push(e));
        break;
    }

    const transferAt = pos.facts?.transferAt || (pos.entryAt - 35_000);
    const firstAt = pos.facts?.firstAt || (pos.entryAt - 20_000);

    let peakSeen = 0;
    let troughSeen = Number.MAX_VALUE;

    // Ambil facts asli dari live jika ada, agar quality gates diuji akurat
    const origFacts = pos.facts || {};
    const buyers = origFacts.meaningfulBuyers ?? 5;
    const buyUsd = origFacts.meaningfulBuyUsd ?? 80;
    const buyShare = origFacts.buyShareUsdPercent ?? 75;

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
        momentumPercent: 4.5,
        drawdownPercent: peakSeen > 0 ? ((peakSeen - tick.price) / peakSeen) * 100 : 0,
        entryReturnPercent: lane.entryPrice ? ((tick.price - lane.entryPrice) / lane.entryPrice) * 100 : 0,
        holderCount: 80,
        holderGrowth15s: 3,
        buyShareUsdPercent: buyShare,
        meaningfulBuyUsd: buyUsd,
        meaningfulBuyers: buyers,
        topBuyerSharePercent: 35,
        sellUsd: 15,
        largestSellUsd: 15,
        riskWalletsPresent: [],
        peakPrice: peakSeen,
        troughPrice: troughSeen,
        troughAgeSeconds: 10,
        troughAt: tick.at - 10_000,
        bounceFromTroughPercent: 1.0,
        devWallet: 'gmgn_research',
        devBalance: null,
        devHoldingSharePercent: 5,
        holderDeclineEverSeen: false,
      };

      lane.step(facts);
    }

    // Timeout fallback jika trade masih open di akhir stream
    if (lane.entryAt !== null && lane.phase !== 'CLOSED') {
      const lastTick = ticks[ticks.length - 1];
      lane.end(lastTick.at + 1000, 'MAX_HOLD_TIMEOUT');
    }

    // Rekap Rejections
    const rejectEvents = events.filter((e) => e.type === 'PAPER_NO_ENTRY');
    for (const re of rejectEvents) {
      const r = (re as any).reason || 'UNKNOWN_REJECTION';
      filterRejectionReasons[r] = (filterRejectionReasons[r] || 0) + 1;
    }

    // Rekap Executed Trades
    const buyEv = events.find((e) => e.type === 'PAPER_ENTRY_SIGNAL' || e.type === 'PAPER_BUY');
    const sellEv = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL');

    if (buyEv && lane.entryPrice && lane.entryAt) {
      enteredCount++;

      if (sellEv) {
        closedCount++;
        const exitPrice = (sellEv as any).exitPrice || (sellEv as any).priceUsd || ticks[ticks.length - 1].price;
        const exitAt = (sellEv as any).observedAt || (sellEv as any).at || ticks[ticks.length - 1].at;
        const reason = (sellEv as any).reason || 'MANUAL_OR_TIMEOUT';
        exitReasons[reason] = (exitReasons[reason] || 0) + 1;

        const holdSec = Math.max(1, (exitAt - lane.entryAt) / 1000);
        totalHoldSeconds += holdSec;

        const grossRet = ((exitPrice - lane.entryPrice) / lane.entryPrice) * 100;
        const netRet = grossRet - 2.5; // Fee 2% + Slippage 0.5%
        const pnl = (netRet / 100) * STAKE;

        totalPnlUsd += pnl;

        if (pnl > 0) {
          wins++;
          grossWin += pnl;
        } else {
          losses++;
          grossLoss += Math.abs(pnl);
        }
      }
    }
  }

  const winRate = closedCount > 0 ? (wins / closedCount) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99.0 : 0;
  const avgHoldSec = closedCount > 0 ? totalHoldSeconds / closedCount : 0;

  return {
    mode,
    totalEvaluated: positions.length,
    enteredCount,
    closedCount,
    wins,
    losses,
    winRate,
    totalPnlUsd,
    profitFactor,
    avgHoldSec,
    exitReasons,
    filterRejectionReasons,
  };
}

async function main() {
  console.log('🚀 [BACKTEST EMULATOR MOMENTUM] Loading historical trade stream & positions...');
  const realTrades = loadRealTrades();
  console.log(`✅ Loaded real ticks for ${realTrades.size} mints.`);

  const positions = loadAllPositions();
  console.log(`✅ Loaded ${positions.length} unique historical candidate tokens.\n`);

  const modes: SimulationMode[] = ['V1_BASELINE_BUGGY', 'V1_BASELINE_CLEAN', 'M_SCALP', 'M_TREND', 'W2_SCALP', 'W2_TREND'];

  const results: any[] = [];

  for (const m of modes) {
    console.log(`⏳ Emulating mode: ${m}...`);
    const res = simulateMode(positions, realTrades, m);
    results.push(res);
  }

  console.log('\n' + '='.repeat(100));
  console.log('📊 HASIL BENCHMARK DISCRETE-EVENT EMULATOR MOMENTUM (TICK-BY-TICK REPLAY)');
  console.log('='.repeat(100));
  console.log(
    `${'Mode / Lane'.padEnd(20)} | ${'Total'.padStart(5)} | ${'Trades'.padStart(6)} | ${'W / L'.padStart(10)} | ${'Win Rate'.padStart(8)} | ${'Net PnL ($5)'.padStart(14)} | ${'Profit Factor'.padStart(13)} | ${'Avg Hold'.padStart(8)}`
  );
  console.log('-'.repeat(100));

  for (const r of results) {
    const wl = `${r.wins}W / ${r.losses}L`;
    const wr = `${r.winRate.toFixed(1)}%`;
    const pnl = `$${r.totalPnlUsd.toFixed(2)}`;
    const pf = r.profitFactor.toFixed(2);
    const hold = `${Math.round(r.avgHoldSec)}s`;
    console.log(
      `${r.mode.padEnd(20)} | ${String(r.totalEvaluated).padStart(5)} | ${String(r.closedCount).padStart(6)} | ${wl.padStart(10)} | ${wr.padStart(8)} | ${pnl.padStart(14)} | ${pf.padStart(13)} | ${hold.padStart(8)}`
    );
  }
  console.log('='.repeat(100));

  console.log('\n🔍 DETAIL BREAKDOWN ALASAN EXIT PER MODE:');
  for (const r of results) {
    console.log(`\n▶ [${r.mode}]:`);
    console.log(`  Exit Reasons:`, JSON.stringify(r.exitReasons));
    console.log(`  Filter Rejections:`, JSON.stringify(r.filterRejectionReasons));
  }
}

main().catch(console.error);
