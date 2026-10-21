import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DistributionProfit4Runtime,
  Transfer,
  RuntimeState,
} from '../src/distribution-profit4-runtime.js';
import {
  DistributionTrendBaseLane,
  Trend20mRules,
  TREND_20M_GOLDEN_RULES,
} from '../src/distribution-trend-20m-lane.js';
import {
  DEFAULT_TARGET_RULES,
  validateTargetRules,
  TargetEvent,
  TargetTrade,
} from '../src/distribution-target-lane.js';

interface ReplayEvent {
  time: number;
  kind: 'REGISTER' | 'TRADE';
  mint: string;
  transfer?: Transfer;
  trade?: TargetTrade;
}

interface StrategyCandidate {
  label: string;
  desc: string;
  minMeaningfulBuyers?: number;
  minBuySharePercent?: number;
  stopLossPercent?: number;
  trailingStartPercent?: number;
  trailingDrawdownPercent?: number;
  nominalTargetPercent?: number;
  profitFloorPercent?: number;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  maxHoldSeconds?: number;
}

const CANDIDATES: StrategyCandidate[] = [
  // 1. Variasi Stop Loss (Menguji apakah SL lebih lebar selamat dari goncangan awal)
  { label: 'T-SL6', desc: 'Tight Stop Loss 6%', stopLossPercent: 6.0 },
  { label: 'T-SL8', desc: 'Moderate Stop Loss 8%', stopLossPercent: 8.0 },
  { label: 'T-SL12', desc: 'Wide Stop Loss 12%', stopLossPercent: 12.0 },
  { label: 'T-SL14', desc: 'Deep Stop Loss 14%', stopLossPercent: 14.0 },

  // 2. Variasi Filter Buyer & Buy Share (Menyaring token sampah sebelum terbeli)
  { label: 'T-Buyers3', desc: 'Relaxed Buyers >= 3', minMeaningfulBuyers: 3 },
  { label: 'T-Buyers7', desc: 'Active Momentum Buyers >= 7', minMeaningfulBuyers: 7 },
  { label: 'T-Buyers10', desc: 'Crowded Buyers >= 10', minMeaningfulBuyers: 10 },
  { label: 'T-Share50', desc: 'Buy Share >= 50%', minBuySharePercent: 50.0 },
  { label: 'T-Share60', desc: 'Strong Buy Share >= 60%', minBuySharePercent: 60.0 },

  // 3. Variasi Trailing Profit & Target (Mengamankan cuan lebih cepat atau membiarkan runner jalan)
  { label: 'T-Trail15_3', desc: 'Fast Profit Lock 15% (DD 3%)', trailingStartPercent: 15.0, trailingDrawdownPercent: 3.0, nominalTargetPercent: 25.0 },
  { label: 'T-Trail22_5', desc: 'Extended Runner 22% (DD 5%)', trailingStartPercent: 22.0, trailingDrawdownPercent: 5.0, nominalTargetPercent: 40.0 },
  { label: 'T-Trail25_5', desc: 'Big Runner 25% (DD 5%)', trailingStartPercent: 25.0, trailingDrawdownPercent: 5.0, nominalTargetPercent: 50.0 },

  // 4. Variasi Market Cap
  { label: 'T-Mcap25k', desc: 'Small Gems Mcap $25k-$500k', minMarketCapUsd: 25000 },
  { label: 'T-Mcap100k', desc: 'Established Mcap $100k-$1M', minMarketCapUsd: 100000, maxMarketCapUsd: 1000000 },

  // 5. Kombinasi Hibrida Terpilih (Sinergi Filter + Exit)
  {
    label: 'T-Sniper',
    desc: 'Stricter Buyers + Wider SL (Buyers 7, Share 50%, SL 12%, Trail 20/4, TP 40%)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 12.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 40.0,
    minMarketCapUsd: 30000,
  },
  {
    label: 'T-Apex',
    desc: 'High Conviction Balanced (Buyers 6, Share 50%, SL 10%, Trail 18/4, TP 35%)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 50.0,
    stopLossPercent: 10.0,
    trailingStartPercent: 18.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 35.0,
    minMarketCapUsd: 40000,
  },
  {
    label: 'T-Vanguard',
    desc: 'Runner Hunter (Buyers 7, Share 45%, SL 12%, Trail 22/5, TP 50%)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 45.0,
    stopLossPercent: 12.0,
    trailingStartPercent: 22.0,
    trailingDrawdownPercent: 5.0,
    nominalTargetPercent: 50.0,
  },
  {
    label: 'T-Guardian',
    desc: 'Defensive Scalp (Buyers 5, Share 50%, SL 8%, Trail 15/3, TP 25%)',
    minMeaningfulBuyers: 5,
    minBuySharePercent: 50.0,
    stopLossPercent: 8.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 3.0,
    nominalTargetPercent: 25.0,
    profitFloorPercent: 12.0,
  },
  {
    label: 'T-Titan',
    desc: 'Large Cap Surge (Buyers 8, Share 55%, SL 11%, Trail 20/4, Mcap $50k-$1M)',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    stopLossPercent: 11.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 45.0,
    minMarketCapUsd: 50000,
    maxMarketCapUsd: 1000000,
  },
  {
    label: 'T-Phoenix',
    desc: 'Deep Dip Runner (Buyers 6, Share 40%, SL 15%, Trail 25/6, TP 60%)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },
];

const PROJECT_DIR = '/home/bbliong/project/crypto-bot';
const LIVE_RUN_DIR = join(PROJECT_DIR, 'data/trend20m-watch/2026-10-20T22-06-10-886Z');
const SANDBOX_DIR = join(PROJECT_DIR, 'data/verify-replay-loop');
const FEED_DIRS = [
  join(PROJECT_DIR, 'data/feed-hub/2026-10-20T22-06-07-165Z/chunks'),
  join(PROJECT_DIR, 'data/feed-hub/2026-10-21T03-57-38-424Z/chunks'),
];

function buildCustomLane(mint: string, cand: StrategyCandidate, onEvent: (ev: TargetEvent) => void): DistributionTrendBaseLane {
  const fullRules: Trend20mRules = {
    ...validateTargetRules({
      ...DEFAULT_TARGET_RULES,
      version: `loop-${cand.label.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
      paperOnly: true,
      enabled: true,
      targetPercent: 1000.0,
      stopLossPercent: cand.stopLossPercent ?? TREND_20M_GOLDEN_RULES.stopLossPercent,
      trailingStartPercent: cand.trailingStartPercent ?? TREND_20M_GOLDEN_RULES.trailingStartPercent,
      trailingDrawdownPercent: cand.trailingDrawdownPercent ?? TREND_20M_GOLDEN_RULES.trailingDrawdownPercent,
      maxHoldSeconds: cand.maxHoldSeconds ?? TREND_20M_GOLDEN_RULES.maxHoldSeconds,
      observationSeconds: 30,
      minTransferAgeSeconds: 1200,
      maxTransferLagSeconds: 60,
      maxEntryWaitSeconds: 7200,
      confirmSeconds: 3,
      minBuySharePercent: cand.minBuySharePercent ?? TREND_20M_GOLDEN_RULES.minBuySharePercent,
      minMeaningfulBuyUsd: 15,
      minMeaningfulBuyers: cand.minMeaningfulBuyers ?? TREND_20M_GOLDEN_RULES.minMeaningfulBuyers,
      maxBuyerSharePercent: 80.0,
      minMomentumPercent: 0.1,
      maxMomentumPercent: 50.0,
      maxEntryReturnPercent: 100000,
      maxDrawdownPercent: 15.0,
      executionDelayMs: 1000,
      maxFillWaitMs: 15000,
      feePercentPerSide: 1.0,
      slippagePercentPerSide: 0.5,
      fixedFeeUsdPerSide: 0.005,
      stakeUsd: 5.0,
      blockKnownDumpSellers: true,
    }),
    minMarketCapUsd: cand.minMarketCapUsd ?? TREND_20M_GOLDEN_RULES.minMarketCapUsd,
    maxMarketCapUsd: cand.maxMarketCapUsd ?? TREND_20M_GOLDEN_RULES.maxMarketCapUsd,
    minHolderCount: 100,
    minTokenAgeSeconds: 1200,
    profitFloorPercent: cand.profitFloorPercent ?? TREND_20M_GOLDEN_RULES.profitFloorPercent,
    nominalTargetPercent: cand.nominalTargetPercent ?? TREND_20M_GOLDEN_RULES.nominalTargetPercent,
  };

  return new DistributionTrendBaseLane(mint, fullRules, cand.label, fullRules.nominalTargetPercent, onEvent);
}

class ExtendedLoopRuntime extends DistributionProfit4Runtime {
  override evaluate(now: number) {
    if (now - (this as any).lastEvaluationAt < 1000) return;
    (this as any).lastEvaluationAt = now;

    const factsCache = new Map<string, any>();

    for (const state of (this as any).states.values()) {
      if (!state.active) continue;

      let facts = factsCache.get(state.transfer.mint);
      if (!facts) {
        facts = state.observation.facts(now, [], state.transfer.from);
        factsCache.set(state.transfer.mint, facts);
      }
      state.facts = facts;

      const waitStart = state.registeredAt ?? facts.firstAt;
      if (state.lane.entryAt === null && waitStart !== null && now - waitStart > state.lane.rules.maxEntryWaitSeconds * 1000) {
        state.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
        state.active = false;
        (this as any).states.delete(state.key);
      } else {
        state.lane.step(facts);
        if (state.lane.phase === 'CLOSED' || state.lane.phase === 'CENSORED') {
          state.active = false;
          if (state.lane.entryAt !== null) {
            (this as any).closedPositions.set(state.key, (this as any).serializeState(state, now));
          } else {
            (this as any).states.delete(state.key);
          }
        }
      }
    }
  }

  saveAll(now: number) {
    (this as any).persist(now);
  }

  override register(transfer: Transfer, now: number) {
    // 1. Daftarkan baseline standar (T-Cons, T-Bal, T-Wide, T-Run, T-Golden)
    super.register(transfer, now);

    // 2. Daftarkan kandidat custom loop engineering
    const mcap = transfer.marketCapUsd ?? (transfer.priceUsd ? transfer.priceUsd * 1_000_000_000 : null);
    if (!mcap || mcap < 10000) return;

    const observation = (this as any).observations.get(transfer.mint);
    if (!observation) return;

    for (const cand of CANDIDATES) {
      const key = `${transfer.mint}:${cand.label.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      if (this.states.has(key)) continue;

      const makeOnEvent = (laneKey: string, laneLabel: string) => (event: TargetEvent) => {
        const state = this.states.get(laneKey);
        if (state) {
          state.lastEvent = event;
          if (event.type === 'PAPER_ENTRY_DECISION') {
            state.lastDecision = { allowed: event.allowed, reasons: event.reasons, observedAt: event.observedAt };
          }
        }
      };

      const lane = buildCustomLane(transfer.mint, cand, makeOnEvent(key, cand.label));
      this.states.set(key, {
        key,
        transfer,
        observation,
        lane,
        facts: null,
        active: true,
        registeredAt: now,
        laneLabel: cand.label as any,
        version: lane.rules.version,
        lastDecision: null,
        lastEvent: null,
      });
    }
  }
}

function prepareSandbox(): void {
  if (existsSync(SANDBOX_DIR)) {
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
  }
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(
    join(SANDBOX_DIR, 'bought-mints.json'),
    JSON.stringify({ updatedAt: Date.now(), mints: [] }, null, 2)
  );
}

function runLoopEngineering() {
  console.log('='.repeat(95));
  console.log(`LOOP ENGINEERING VIA 1:1 TICK REPLAY ENGINE (${CANDIDATES.length + 1} STRATEGIES TESTED)`);
  console.log('='.repeat(95));

  prepareSandbox();

  // 1. Load candidates
  console.log('[1/4] Memuat kandidat token dari live run...');
  const transfers = new Map<string, { registeredAt: number; transfer: Transfer }>();
  const chunksDir = join(LIVE_RUN_DIR, 'chunks');
  const chunkFolders = readdirSync(chunksDir).sort();
  for (const cf of chunkFolders) {
    const ef = join(chunksDir, cf, 'profit4-events.jsonl');
    if (!existsSync(ef)) continue;
    const lines = readFileSync(ef, 'utf8').trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const t: Transfer = e.transfer;
        const at = Number(e.observedAt || e.at);
        if (t && t.mint && at > 0) {
          const existing = transfers.get(t.mint);
          if (!existing || at < existing.registeredAt) {
            transfers.set(t.mint, { registeredAt: at, transfer: t });
          }
        }
      } catch {}
    }
  }
  const mints = new Set(transfers.keys());
  console.log(`-> Ditemukan ${transfers.size} kandidat unik.`);

  // 2. Load trades
  console.log('[2/4] Memuat 1.09 juta tick trade feed WebSocket...');
  const tradeEvents: ReplayEvent[] = [];
  for (const fd of FEED_DIRS) {
    if (!existsSync(fd)) continue;
    const chunkNames = readdirSync(fd).sort();
    for (const cn of chunkNames) {
      const tf = join(fd, cn, 'token-trades.jsonl');
      if (!existsSync(tf)) continue;
      const lines = readFileSync(tf, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let match = false;
        for (const m of mints) {
          if (line.includes(m)) {
            match = true;
            break;
          }
        }
        if (!match) continue;
        try {
          const t = JSON.parse(line);
          const mint = t.mint;
          if (!mints.has(mint)) continue;
          const price = Number(t.price);
          const at = Number(t.observedAt || t.at || (t.timestamp ? t.timestamp * 1000 : 0));
          if (price > 0.000004 && at > 0) {
            tradeEvents.push({
              time: at,
              kind: 'TRADE',
              mint,
              trade: {
                at,
                timestamp: Math.floor(at / 1000),
                price,
                side: t.side === 'sell' ? 'sell' : 'buy',
                wallet: t.wallet || 'trader',
                usd: Number(t.usd || 25),
                signature: t.signature || `sig_${at}`,
              },
            });
          }
        } catch {}
      }
    }
  }

  // 3. Combine events
  console.log('[3/4] Menggabungkan event dan mengurutkan secara kronologis...');
  const allEvents: ReplayEvent[] = [...tradeEvents];
  for (const [mint, item] of transfers.entries()) {
    allEvents.push({
      time: item.registeredAt,
      kind: 'REGISTER',
      mint,
      transfer: item.transfer,
    });
  }
  allEvents.sort((a, b) => a.time - b.time);
  console.log(`-> Total urutan event: ${allEvents.length} events.`);

  const startTime = allEvents[0].time;
  const endTime = allEvents[allEvents.length - 1].time;

  // 4. Run Runtime Replay
  console.log('[4/4] Menjalankan Replay Engine Tick-by-Tick...');
  const runtime = new ExtendedLoopRuntime(SANDBOX_DIR, () => {}, SANDBOX_DIR, 'trend20m');

  let lastEvalAt = startTime;
  let processed = 0;
  const total = allEvents.length;

  for (const ev of allEvents) {
    processed++;
    if (processed % 150000 === 0) {
      process.stdout.write(`   Replay progres: ${(processed / total * 100).toFixed(1)}% (${processed}/${total})\r`);
    }

    if (ev.time - lastEvalAt >= 1000) {
      if (ev.time - lastEvalAt > 30000) {
        runtime.evaluate(lastEvalAt + 1000);
        lastEvalAt = ev.time;
        runtime.evaluate(lastEvalAt);
      } else {
        while (ev.time - lastEvalAt >= 1000) {
          lastEvalAt += 1000;
          runtime.evaluate(lastEvalAt);
        }
      }
    }

    if (ev.kind === 'REGISTER' && ev.transfer) {
      runtime.register(ev.transfer, ev.time);
    } else if (ev.kind === 'TRADE' && ev.mint && ev.trade) {
      runtime.trade(ev.mint, ev.trade);
    }
  }

  // Final evaluate step & persist
  runtime.evaluate(endTime + 5000);
  runtime.saveAll(endTime + 5000);
  console.log('\n\nReplay selesai! Menghitung metrik performa setiap lane...\n');

  // Read saved state
  const replayStatePath = join(SANDBOX_DIR, 'profit4-state.json');
  let replayPositions: any[] = [];
  if (existsSync(replayStatePath)) {
    replayPositions = JSON.parse(readFileSync(replayStatePath, 'utf8')).positions || [];
  }

  const allLabels = ['T-Golden', ...CANDIDATES.map(c => c.label)];
  const labelDescMap: Record<string, string> = {
    'T-Golden': 'T-Golden Baseline (Buyers 5, Share 40%, SL 10%, Trail 18/4, TP 35%)',
    ...Object.fromEntries(CANDIDATES.map(c => [c.label, c.desc])),
  };

  const summary: any[] = [];
  for (const label of allLabels) {
    const pos = replayPositions.filter((p: any) => p.laneLabel === label && p.phase === 'CLOSED');
    const wins = pos.filter((p: any) => (p.pnlUsd || 0) > 0);
    const losses = pos.filter((p: any) => (p.pnlUsd || 0) <= 0);
    const winRate = pos.length > 0 ? (wins.length / pos.length) * 100 : 0;
    const totalPnl = pos.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);
    const grossWins = wins.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0));
    const profitFactor = grossLoss > 0 ? grossWins / grossLoss : grossWins > 0 ? 99.0 : 0;

    const reasons: Record<string, number> = {};
    for (const p of pos) {
      const r = p.lastEvent?.reason || p.exitReason || 'UNKNOWN';
      reasons[r] = (reasons[r] || 0) + 1;
    }

    summary.push({
      label,
      desc: labelDescMap[label] || label,
      trades: pos.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      totalPnl,
      profitFactor,
      reasons,
    });
  }

  // Sort by Total PnL descending
  summary.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log('='.repeat(105));
  console.log('LEADERBOARD HASIL LOOP ENGINEERING TICK-BY-TICK (RANKING BERDASARKAN NET PNL)');
  console.log('='.repeat(105));
  console.log(
    'Rank'.padEnd(5) +
    '| Lane Label'.padEnd(16) +
    '| Trades (W/L)'.padEnd(16) +
    '| Win Rate'.padEnd(11) +
    '| Net PnL ($5)'.padEnd(15) +
    '| Profit Factor'.padEnd(15) +
    '| Dominant Exit Reason'
  );
  console.log('-'.repeat(105));

  summary.forEach((s, idx) => {
    const rank = `#${idx + 1}`.padEnd(5);
    const label = s.label.padEnd(16);
    const tradeSummary = `${s.trades} (${s.wins}/${s.losses})`.padEnd(16);
    const wr = `${s.winRate.toFixed(1)}%`.padEnd(11);
    const pnl = `${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}`.padEnd(15);
    const pf = `${s.profitFactor.toFixed(2)}x`.padEnd(15);

    const topReason = Object.entries(s.reasons).sort((a: any, b: any) => b[1] - a[1])[0];
    const reasonStr = topReason ? `${topReason[0]} (${topReason[1]})` : '-';

    console.log(`${rank}| ${label}| ${tradeSummary}| ${wr}| ${pnl}| ${pf}| ${reasonStr}`);
  });
  console.log('='.repeat(105));

  // Tampilkan Top 3
  console.log('\n🏆 TOP 3 STRATEGI TERBAIK HASIL LOOP ENGINEERING TICK-BY-TICK:');
  summary.slice(0, 3).forEach((s, i) => {
    console.log(`\n${i + 1}. [${s.label}] - ${s.desc}`);
    console.log(`   Net PnL       : $${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(2)} | Profit Factor: ${s.profitFactor.toFixed(2)}x`);
    console.log(`   Trades        : ${s.trades} (${s.wins} Win, ${s.losses} Loss) | Win Rate: ${s.winRate.toFixed(1)}%`);
    console.log(`   Exit Breakdown:`, s.reasons);
  });
}

runLoopEngineering();
