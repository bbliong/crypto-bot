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

interface FineTuneCandidate {
  label: string;
  desc: string;
  minMeaningfulBuyers: number;
  minBuySharePercent: number;
  maxLargestSellUsd: number;
  maxEntryReturnPercent: number;
  maxDrawdownPercent: number;
  stopLossPercent: number;
  nominalTargetPercent: number;
  trailingStartPercent: number;
  trailingDrawdownPercent: number;
  breakevenTriggerPercent: number;
  breakevenLockNetPercent: number;
  maxHoldSeconds?: number;
}

const CANDIDATES: FineTuneCandidate[] = [
  // --- VARIASI CROWD DOMINANCE (Target Win Rate 75% - 85%) ---
  {
    label: 'CD-8Buyers-55Share',
    desc: 'Buyers 8, Share 55%, Sell < $50, FOMO < 25%, TP 20%, SL 10%, BE@7%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'CD-8Buyers-60Share',
    desc: 'Buyers 8, Share 60%, Sell < $50, FOMO < 25%, TP 20%, SL 10%, BE@7%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 60.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'CD-8Buyers-Sell60',
    desc: 'Buyers 8, Share 55%, Sell < $60, FOMO < 25%, TP 20%, SL 10%, BE@7%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'CD-8Buyers-TP25',
    desc: 'Buyers 8, Share 55%, Sell < $50, FOMO < 25%, TP 25%, SL 10%, BE@8%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 14.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },

  // --- VARIASI 9 BUYERS (ULTRA QUALITY SWEET SPOT) ---
  {
    label: 'UQ-9Buyers-55Share',
    desc: 'Buyers 9, Share 55%, Sell < $60, FOMO < 25%, TP 25%, SL 11%, BE@8%',
    minMeaningfulBuyers: 9,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 11.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'UQ-9Buyers-TP30',
    desc: 'Buyers 9, Share 60%, Sell < $60, FOMO < 25%, TP 30%, SL 12%, BE@8%',
    minMeaningfulBuyers: 9,
    minBuySharePercent: 60.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 12.0,
    nominalTargetPercent: 30.0,
    trailingStartPercent: 16.0,
    trailingDrawdownPercent: 3.5,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'UQ-9Buyers-Sell75',
    desc: 'Buyers 9, Share 55%, Sell < $75, FOMO < 25%, TP 25%, SL 11%, BE@8%',
    minMeaningfulBuyers: 9,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 75,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 11.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },

  // --- VARIASI 10 BUYERS (MAX ACCURACY / HIGHEST WIN RATE) ---
  {
    label: 'CD-10Buyers-55Share',
    desc: 'Buyers 10, Share 55%, Sell < $60, FOMO < 25%, TP 20%, SL 10%, BE@7%',
    minMeaningfulBuyers: 10,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'CD-10Buyers-65Share',
    desc: 'Buyers 10, Share 65%, Sell < $50, FOMO < 25%, TP 20%, SL 9%, BE@7%',
    minMeaningfulBuyers: 10,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 6.0,
    stopLossPercent: 9.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'CD-10Buyers-TP25',
    desc: 'Buyers 10, Share 55%, Sell < $60, FOMO < 25%, TP 25%, SL 10%, BE@7.5%',
    minMeaningfulBuyers: 10,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 14.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 7.5,
    breakevenLockNetPercent: 3.5,
  },

  // --- VARIASI 7 BUYERS (BALANCED HIGH WR & TRADE VOLUME) ---
  {
    label: 'Bal-7Buyers-55Share',
    desc: 'Buyers 7, Share 55%, Sell < $60, FOMO < 22%, TP 20%, SL 11%, BE@7%',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 22.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 11.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'Bal-7Buyers-Sell75',
    desc: 'Buyers 7, Share 52%, Sell < $75, FOMO < 22%, TP 22%, SL 11%, BE@7.5%',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 52.0,
    maxLargestSellUsd: 75,
    maxEntryReturnPercent: 22.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 11.0,
    nominalTargetPercent: 22.0,
    trailingStartPercent: 13.0,
    trailingDrawdownPercent: 2.8,
    breakevenTriggerPercent: 7.5,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'Bal-7Buyers-TP25',
    desc: 'Buyers 7, Share 55%, Sell < $60, FOMO < 22%, TP 25%, SL 12%, BE@8%',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 22.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 12.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
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
const SANDBOX_DIR = join(PROJECT_DIR, 'data/verify-replay-tuning-wr');

class TuningLane extends DistributionTargetLane {
  protected peakGrossSeen = -Infinity;

  constructor(
    mint: string,
    readonly cand: FineTuneCandidate,
    rules: TargetRules,
    emit: (event: TargetEvent) => void = () => {}
  ) {
    super(
      mint,
      rules,
      (e) =>
        emit({
          ...e,
          targetPercent: cand.nominalTargetPercent,
          version: rules.version,
          laneLabel: cand.label as any,
        }),
      {
        name: `tuning-wr-${cand.label.toLowerCase()}`,
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

          // 1. Usia token minimal 20 menit
          const transferAgeSec = f.transferAt > 0 ? (f.now - f.transferAt) / 1000 : 0;
          if (transferAgeSec < 1200) {
            reasons.push('TOKEN_AGE_LESS_THAN_20M');
          }

          // 2. Market Cap sweet spot ($30k - $600k)
          if (f.price !== null && f.price * 1_000_000_000 < 30000) {
            reasons.push('ENTRY_MCAP_TOO_LOW');
          }
          if (f.price !== null && f.price * 1_000_000_000 > 600000) {
            reasons.push('ENTRY_MCAP_TOO_HIGH');
          }

          // 3. Holder decline flight risk
          if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) {
            reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');
          }

          // 4. Buyer consensus & Buy share
          if (f.buyShareUsdPercent !== null && f.buyShareUsdPercent < cand.minBuySharePercent) {
            reasons.push('BUY_SHARE_TOO_LOW');
          }
          if (f.meaningfulBuyers < cand.minMeaningfulBuyers) {
            reasons.push('NOT_ENOUGH_BUYERS');
          }
          if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 80.0) {
            reasons.push('SINGLE_BUYER_DOMINATES');
          }

          // 5. Anti-Dump: Largest Sell Guard
          if (f.largestSellUsd >= cand.maxLargestSellUsd) {
            reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
          }

          // 6. Anti-Dump: Pre-Entry Drawdown Guard
          if (f.drawdownPercent !== null && f.drawdownPercent > cand.maxDrawdownPercent) {
            reasons.push('PRE_ENTRY_DRAWDOWN_TOO_HIGH');
          }

          // 7. Anti-FOMO / Anti-Pucuk: Observation Gain Cap
          if (f.entryReturnPercent !== null && f.entryReturnPercent > cand.maxEntryReturnPercent) {
            reasons.push('FOMO_GAIN_TOO_HIGH_TOP_BUY');
          }

          // 8. Entry window expiry (120m)
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

          // 1. HARD STOP LOSS
          if (grossRet <= -cand.stopLossPercent) {
            return `STOP_LOSS_${Math.round(cand.stopLossPercent)}PCT`;
          }

          // 2. NET PROFIT BREAKEVEN LOCK
          if (this.peakGrossSeen >= cand.breakevenTriggerPercent) {
            if (grossRet <= cand.breakevenLockNetPercent) {
              return `BREAKEVEN_PROFIT_LOCKED_${Math.round(cand.breakevenTriggerPercent)}_${Math.round(cand.breakevenLockNetPercent)}`;
            }
          }

          // 3. NOMINAL TAKE PROFIT CEILING
          if (grossRet >= cand.nominalTargetPercent) {
            return `TAKE_PROFIT_CEILING_${Math.round(cand.nominalTargetPercent)}`;
          }

          // 4. DYNAMIC TRAILING PROFIT
          if (this.peakGrossSeen >= cand.trailingStartPercent) {
            const ddFromPeak = this.peakGrossSeen - grossRet;
            if (ddFromPeak >= cand.trailingDrawdownPercent) {
              return `TRAILING_PROFIT_ABOVE_${Math.round(cand.trailingStartPercent)}_DD${Math.round(cand.trailingDrawdownPercent)}`;
            }
          }

          // 5. MAX HOLD TIMEOUT (45m)
          const holdSec = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          const maxHold = cand.maxHoldSeconds ?? 2700;
          if (holdSec >= maxHold) {
            return `MAX_HOLD_TIMEOUT_${Math.round(maxHold / 60)}M`;
          }

          return null;
        },
      }
    );
  }
}

class TuningRuntime extends DistributionProfit4Runtime {
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
        version: `rules-tuning-${cand.label.toLowerCase()}`,
        paperOnly: true,
        enabled: true,
        stakeUsd: 5.0,
        stopLossPercent: cand.stopLossPercent,
        targetPercent: 1000.0,
        trailingStartPercent: cand.trailingStartPercent,
        trailingDrawdownPercent: cand.trailingDrawdownPercent,
        maxHoldSeconds: cand.maxHoldSeconds ?? 2700,
        observationSeconds: 30,
        minTransferAgeSeconds: 1200,
        maxTransferLagSeconds: 60,
        maxEntryWaitSeconds: 7200,
        confirmSeconds: 3,
        minBuySharePercent: cand.minBuySharePercent,
        minMeaningfulBuyUsd: 15,
        minMeaningfulBuyers: cand.minMeaningfulBuyers,
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
        blockKnownDumpSellers: true,
      });

      const lane = new TuningLane(transfer.mint, cand, rules, makeOnEvent(key, cand.label));
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

async function main() {
  console.log('='.repeat(100));
  console.log('🚀 FINE-TUNING LOOP: MENCARI KOMBINASI WIN RATE MAKSIMAL (75% - 85%+)');
  console.log(`Menguji ${CANDIDATES.length} variasi parameter pada 2.28 Juta Tick Replay`);
  console.log('='.repeat(100));

  if (existsSync(SANDBOX_DIR)) rmSync(SANDBOX_DIR, { recursive: true, force: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

  const transfers = new Map<string, { registeredAt: number; transfer: Transfer }>();
  for (const dir of LIVE_RUN_DIRS) {
    const chunksDir = join(dir, 'chunks');
    if (!existsSync(chunksDir)) continue;
    for (const cf of readdirSync(chunksDir).sort()) {
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

  const tradeEvents: ReplayEvent[] = [];
  for (const fd of FEED_DIRS) {
    if (!existsSync(fd)) continue;
    for (const cn of readdirSync(fd).sort()) {
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

  const runtime = new TuningRuntime(SANDBOX_DIR, () => {}, SANDBOX_DIR, 'trend20m');

  let lastEvalAt = startTime;
  let processed = 0;
  const total = allEvents.length;

  for (const ev of allEvents) {
    processed++;
    if (processed % 300000 === 0) {
      process.stdout.write(`   Replay progres: ${(processed / total * 100).toFixed(1)}% (${processed.toLocaleString()}/${total.toLocaleString()})\r`);
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

  summary.sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl);

  console.log('\n\n' + '='.repeat(120));
  console.log('🏆 HASIL FINE-TUNING HIGH WIN RATE (RANKING TERTINGGI WIN RATE)');
  console.log('='.repeat(120));
  console.log(
    'Rank'.padEnd(5) +
    '| Lane Label'.padEnd(22) +
    '| Trades (W/L)'.padEnd(16) +
    '| Win Rate'.padEnd(12) +
    '| Net PnL ($5)'.padEnd(15) +
    '| Profit Factor'.padEnd(15) +
    '| Dominant Exit'
  );
  console.log('-'.repeat(120));

  summary.forEach((s, idx) => {
    const rank = `#${idx + 1}`.padEnd(5);
    const label = s.label.padEnd(22);
    const tradeSummary = `${s.trades} (${s.wins}/${s.losses})`.padEnd(16);
    const wr = `${s.winRate.toFixed(1)}%`.padEnd(12);
    const pnl = `${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}`.padEnd(15);
    const pf = `${s.profitFactor.toFixed(2)}x`.padEnd(15);

    const topReason = Object.entries(s.reasons).sort((a: any, b: any) => (b[1] as number) - (a[1] as number))[0];
    const reasonStr = topReason ? `${topReason[0]} (${topReason[1]})` : '-';

    console.log(`${rank}| ${label}| ${tradeSummary}| ${wr}| ${pnl}| ${pf}| ${reasonStr}`);
  });
  console.log('='.repeat(120));

  console.log('\n🎯 REKOMENDASI FORMULA STRATEGI HIGH WIN RATE:');
  summary.slice(0, 3).forEach((s, i) => {
    console.log(`\n${i + 1}. [${s.label}] - Win Rate: ${s.winRate.toFixed(1)}% | Net PnL: $${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(2)} | PF: ${s.profitFactor.toFixed(2)}x`);
    console.log(`   Deskripsi    : ${s.desc}`);
    console.log(`   Total Trades : ${s.trades} (${s.wins} Menang / ${s.losses} Kalah)`);
    console.log(`   Sebaran Exit :`, JSON.stringify(s.reasons));
  });
}

main().catch(console.error);
