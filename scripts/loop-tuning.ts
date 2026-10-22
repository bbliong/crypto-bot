import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  DistributionProfit4Runtime,
  Transfer,
} from '../src/distribution-profit4-runtime.js';
import {
  DistributionTargetLane,
  DEFAULT_TARGET_RULES,
  validateTargetRules,
  TargetEvent,
  TargetFacts,
  TargetRules,
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
  maxDrawdownPercent?: number;
  maxEntryReturnPercent?: number;
  maxLargestSellUsd?: number;
  breakevenTriggerPercent?: number;
}

const CANDIDATES: StrategyCandidate[] = [
  // 1. Juara Sebelumnya
  {
    label: 'Phoenix-Original',
    desc: 'Original Phoenix (SL 15%, Trail 25/6, TP 60%, Buyers 6, Share 40%)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },
  {
    label: 'Sniper-Original',
    desc: 'Original Sniper (SL 12%, Trail 20/4, TP 40%, Buyers 7, Share 50%)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 12.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 40.0,
  },

  // 2. Fine-Tuning Anti-Dump pada Phoenix (Mencari sweet-spot batas sell whale)
  {
    label: 'Phoenix-Dump100',
    desc: 'Phoenix + Sell < $100',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
    maxLargestSellUsd: 100,
  },
  {
    label: 'Phoenix-Dump125',
    desc: 'Phoenix + Sell < $125',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
    maxLargestSellUsd: 125,
  },
  {
    label: 'Phoenix-Dump150',
    desc: 'Phoenix + Sell < $150',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
    maxLargestSellUsd: 150,
  },
  {
    label: 'Phoenix-Dump200',
    desc: 'Phoenix + Sell < $200',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
    maxLargestSellUsd: 200,
  },

  // 3. Fine-Tuning Stop Loss pada Phoenix (14%, 15%, 16%, 18%)
  {
    label: 'Phoenix-SL14',
    desc: 'Phoenix with SL 14%',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 14.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },
  {
    label: 'Phoenix-SL16',
    desc: 'Phoenix with SL 16%',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 16.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },
  {
    label: 'Phoenix-SL18',
    desc: 'Phoenix with SL 18%',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 18.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },

  // 4. Fine-Tuning Trailing & TP pada Phoenix
  {
    label: 'Phoenix-Trail22_5',
    desc: 'Phoenix with Trail 22% / DD 5%',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 22.0,
    trailingDrawdownPercent: 5.0,
    nominalTargetPercent: 60.0,
  },
  {
    label: 'Phoenix-Trail28_6',
    desc: 'Phoenix with Trail 28% / DD 6% (Bigger Runner)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 28.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 70.0,
  },

  // 5. Sniper Fine-Tuning (Meningkatkan Profit Sniper)
  {
    label: 'Sniper-Dump150',
    desc: 'Sniper + Sell < $150',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 12.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 40.0,
    maxLargestSellUsd: 150,
  },
  {
    label: 'Sniper-SL14',
    desc: 'Sniper with SL 14% (Room to Breathe)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 14.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 45.0,
  },
  {
    label: 'Sniper-Trail22_4',
    desc: 'Sniper with Trail 22% / DD 4% (Target 45%)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 12.0,
    trailingStartPercent: 22.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 45.0,
  },
];

const PROJECT_DIR = '/home/bbliong/project/crypto-bot';
const LIVE_RUN_DIRS = [
  join(PROJECT_DIR, 'data/trend20m-watch/2026-10-20T22-06-10-886Z'),
  join(PROJECT_DIR, 'data/trend20m-watch/2026-10-21T11-42-54-227Z'),
  join(PROJECT_DIR, 'data/trend20m-watch/2026-10-21T20-30-33-166Z'),
];
const FEED_DIRS = [
  join(PROJECT_DIR, 'data/feed-hub/2026-10-20T22-06-07-165Z/chunks'),
  join(PROJECT_DIR, 'data/feed-hub/2026-10-21T03-57-38-424Z/chunks'),
  join(PROJECT_DIR, 'data/feed-hub/2026-10-21T11-42-44-751Z/chunks'),
];
const SANDBOX_DIR = join(PROJECT_DIR, 'data/verify-replay-tuning');

class CustomReplayLane extends DistributionTargetLane {
  protected peakGrossSeen = -Infinity;
  protected peakNetSeen = -Infinity;

  constructor(
    mint: string,
    readonly cand: StrategyCandidate,
    rules: TargetRules,
    emit: (event: TargetEvent) => void = () => {}
  ) {
    super(
      mint,
      rules,
      (e) =>
        emit({
          ...e,
          targetPercent: cand.nominalTargetPercent || 40.0,
          version: rules.version,
          laneLabel: cand.label as any,
        }),
      {
        name: `tuning-${cand.label.toLowerCase()}`,
        paperLane: 'distribution-trend-20m',
        prioritizeCustomExit: true,
        trailingEnabled: true,
        flowExitEnabled: false,
        overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
          const reasons: string[] = [];
          if (!r.enabled) reasons.push('LANE_DISABLED');

          if (
            f.price === null ||
            f.priceAt === null ||
            f.priceAt > f.now ||
            f.now - f.priceAt > 5000 ||
            f.price <= 0.000004 ||
            f.price > 10.0 ||
            !Number.isFinite(f.price)
          ) {
            reasons.push('PRICE_MISSING_OR_STALE');
          }

          const transferAgeSec = f.transferAt > 0 ? (f.now - f.transferAt) / 1000 : 0;
          if (transferAgeSec < 1200) {
            reasons.push('TOKEN_AGE_LESS_THAN_20M');
          }

          const minMcap = cand.minMarketCapUsd ?? 30000;
          const maxMcap = cand.maxMarketCapUsd ?? 600000;
          if (f.price !== null && f.price * 1_000_000_000 < minMcap) {
            reasons.push('ENTRY_MCAP_TOO_LOW');
          }
          if (f.price !== null && maxMcap > 0 && f.price * 1_000_000_000 > maxMcap) {
            reasons.push('ENTRY_MCAP_TOO_HIGH');
          }

          if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) {
            reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');
          }

          const minShare = cand.minBuySharePercent ?? 40.0;
          if (f.buyShareUsdPercent !== null && f.buyShareUsdPercent < minShare) {
            reasons.push('BUY_SHARE_TOO_LOW');
          }
          const minBuyers = cand.minMeaningfulBuyers ?? 6;
          if (f.meaningfulBuyers < minBuyers) {
            reasons.push('NOT_ENOUGH_BUYERS');
          }
          if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 80.0) {
            reasons.push('SINGLE_BUYER_DOMINATES');
          }

          if (cand.maxLargestSellUsd !== undefined && f.largestSellUsd >= cand.maxLargestSellUsd) {
            reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
          }

          const waitStart = f.firstAt ?? f.now;
          if (f.now - waitStart > 7200 * 1000) {
            reasons.push('ENTRY_WINDOW_EXPIRED');
          }

          return reasons;
        },
        exitReason: (f: TargetFacts, net: number) => {
          if (this.entryPrice === null || this.entryPrice <= 0 || f.price === null) return null;

          const grossRet = ((f.price - this.entryPrice) / this.entryPrice) * 100;
          if (grossRet > this.peakGrossSeen) {
            this.peakGrossSeen = grossRet;
          }
          if (net > this.peakNetSeen) {
            this.peakNetSeen = net;
          }

          const sl = cand.stopLossPercent ?? 15.0;
          if (grossRet <= -sl) {
            return `STOP_LOSS_${Math.round(sl)}PCT`;
          }

          const holdSeconds = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          const maxHold = cand.maxHoldSeconds ?? 3600;
          if (holdSeconds >= maxHold) {
            return `MAX_HOLD_TIMEOUT_${Math.round(maxHold / 60)}M`;
          }

          const trailStart = cand.trailingStartPercent ?? 25.0;
          const trailDrop = cand.trailingDrawdownPercent ?? 6.0;
          if (this.peakGrossSeen >= trailStart) {
            const drawdownFromPeak = this.peakGrossSeen - grossRet;
            if (drawdownFromPeak >= trailDrop) {
              if (this.peakGrossSeen >= 60.0) {
                return 'TRAILING_PROFIT_ABOVE_60';
              } else if (this.peakGrossSeen >= 35.0) {
                return 'TRAILING_PROFIT_ABOVE_35';
              } else if (this.peakGrossSeen >= 20.0) {
                return 'TRAILING_PROFIT_ABOVE_20';
              } else {
                return `TRAILING_PROFIT_ABOVE_${Math.round(trailStart)}`;
              }
            }
          }

          const tp = cand.nominalTargetPercent ?? 60.0;
          if (grossRet >= tp) {
            return `TAKE_PROFIT_CEILING_${Math.round(tp)}`;
          }

          return null;
        },
      }
    );
  }
}

class ExtendedLoopRuntimeTuning extends DistributionProfit4Runtime {
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
      if (state.lane.entryAt === null && waitStart !== null && now - waitStart > 7200 * 1000) {
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
    const mcap = transfer.marketCapUsd ?? (transfer.priceUsd ? transfer.priceUsd * 1_000_000_000 : null);
    if (!mcap || mcap < 10000) return;

    let observation = (this as any).observations.get(transfer.mint);
    if (!observation) {
      super.register(transfer, now);
      observation = (this as any).observations.get(transfer.mint);
    }
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

      const rules: TargetRules = validateTargetRules({
        ...DEFAULT_TARGET_RULES,
        version: `tuning-${cand.label.toLowerCase()}`,
        paperOnly: true,
        enabled: true,
        targetPercent: 1000.0,
        stopLossPercent: cand.stopLossPercent ?? 15.0,
        trailingStartPercent: cand.trailingStartPercent ?? 25.0,
        trailingDrawdownPercent: cand.trailingDrawdownPercent ?? 6.0,
        maxHoldSeconds: cand.maxHoldSeconds ?? 3600,
        observationSeconds: 30,
        minTransferAgeSeconds: 1200,
        maxTransferLagSeconds: 60,
        maxEntryWaitSeconds: 7200,
        confirmSeconds: 3,
        minBuySharePercent: cand.minBuySharePercent ?? 40.0,
        minMeaningfulBuyUsd: 15,
        minMeaningfulBuyers: cand.minMeaningfulBuyers ?? 6,
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
      });

      const lane = new CustomReplayLane(transfer.mint, cand, rules, makeOnEvent(key, cand.label));
      this.states.set(key, {
        key,
        transfer,
        observation,
        lane,
        facts: null,
        active: true,
        registeredAt: now,
        laneLabel: cand.label as any,
        version: rules.version,
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

function runTuning() {
  console.log('='.repeat(105));
  console.log(`FINE-TUNING LOOP: OPTIMASI FINAL PHOENIX & SNIPER (${CANDIDATES.length} STRATEGI)`);
  console.log('='.repeat(105));

  prepareSandbox();

  console.log('[1/4] Memuat kandidat token dari live runs...');
  const transfers = new Map<string, { registeredAt: number; transfer: Transfer }>();
  for (const ld of LIVE_RUN_DIRS) {
    const chunksDir = join(ld, 'chunks');
    if (!existsSync(chunksDir)) continue;
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
  }
  const mints = new Set(transfers.keys());

  console.log('[2/4] Memuat trade events...');
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

  console.log('[3/4] Mengurutkan timeline events...');
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

  const startTime = allEvents[0].time;
  const endTime = allEvents[allEvents.length - 1].time;

  console.log('[4/4] Menjalankan Replay Engine...');
  const runtime = new ExtendedLoopRuntimeTuning(SANDBOX_DIR, () => {}, SANDBOX_DIR, 'trend20m');

  let lastEvalAt = startTime;
  let processed = 0;
  const total = allEvents.length;

  for (const ev of allEvents) {
    processed++;
    if (processed % 300000 === 0) {
      process.stdout.write(`   Tuning progres: ${(processed / total * 100).toFixed(1)}%\r`);
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

  runtime.evaluate(endTime + 5000);
  runtime.saveAll(endTime + 5000);

  const replayStatePath = join(SANDBOX_DIR, 'profit4-state.json');
  let replayPositions: any[] = [];
  if (existsSync(replayStatePath)) {
    replayPositions = JSON.parse(readFileSync(replayStatePath, 'utf8')).positions || [];
  }

  const summary: any[] = [];
  for (const cand of CANDIDATES) {
    const pos = replayPositions.filter((p: any) => p.laneLabel === cand.label && p.phase === 'CLOSED');
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
      label: cand.label,
      desc: cand.desc,
      trades: pos.length,
      wins: wins.length,
      losses: losses.length,
      winRate,
      totalPnl,
      profitFactor,
      reasons,
    });
  }

  summary.sort((a, b) => b.totalPnl - a.totalPnl);

  console.log('\n\n' + '='.repeat(110));
  console.log('HASIL TUNING OPTIMASI PHOENIX & SNIPER');
  console.log('='.repeat(110));
  console.log(
    'Rank'.padEnd(5) +
    '| Lane Label'.padEnd(20) +
    '| Trades (W/L)'.padEnd(16) +
    '| Win Rate'.padEnd(11) +
    '| Net PnL ($5)'.padEnd(15) +
    '| Profit Factor'.padEnd(15) +
    '| Dominant Exit Reason'
  );
  console.log('-'.repeat(110));

  summary.forEach((s, idx) => {
    const rank = `#${idx + 1}`.padEnd(5);
    const label = s.label.padEnd(20);
    const tradeSummary = `${s.trades} (${s.wins}/${s.losses})`.padEnd(16);
    const wr = `${s.winRate.toFixed(1)}%`.padEnd(11);
    const pnl = `${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}`.padEnd(15);
    const pf = `${s.profitFactor.toFixed(2)}x`.padEnd(15);

    const topReason = Object.entries(s.reasons).sort((a: any, b: any) => b[1] - a[1])[0];
    const reasonStr = topReason ? `${topReason[0]} (${topReason[1]})` : '-';

    console.log(`${rank}| ${label}| ${tradeSummary}| ${wr}| ${pnl}| ${pf}| ${reasonStr}`);
  });
  console.log('='.repeat(110));
}

runTuning();
