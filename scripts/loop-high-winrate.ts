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

interface HighWrCandidate {
  label: string;
  desc: string;
  // Entry gates
  minMeaningfulBuyers?: number;
  minBuySharePercent?: number;
  maxLargestSellUsd?: number;
  maxDrawdownPercent?: number;
  maxEntryReturnPercent?: number;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  // Exit gates
  stopLossPercent?: number;
  nominalTargetPercent?: number;
  trailingStartPercent?: number;
  trailingDrawdownPercent?: number;
  breakevenTriggerPercent?: number; // Saat peak return capai X%, geser SL ke positive breakeven
  breakevenLockNetPercent?: number; // Lock di gross return Y% (misal 3.5% gross = net positif)
  maxHoldSeconds?: number;
}

const HIGH_WR_CANDIDATES: HighWrCandidate[] = [
  // --- BASELINE CONTROL ---
  {
    label: 'T-Phoenix-Base',
    desc: 'Baseline Phoenix (SL 15%, Trail 25/6, TP 60%, No BE)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },
  {
    label: 'T-AntiDump-Base',
    desc: 'Baseline AntiDump100 (Sell < $100, SL 15%, Trail 25/6, TP 60%)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    maxLargestSellUsd: 100,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },

  // --- KELOMPOK 1: NET BREAKEVEN LOCK (Kunci Profit +3.5% Gross saat Peak Capai +6% s/d +10%) ---
  {
    label: 'WR-BE-Peak6',
    desc: 'Peak >= +6% -> Lock Net Profit (+3.5% Gross) | TP 25%, SL 12%, Sell < $80',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    maxLargestSellUsd: 80,
    stopLossPercent: 12.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 6.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-BE-Peak8',
    desc: 'Peak >= +8% -> Lock Net Profit (+3.5% Gross) | TP 30%, SL 12%, Sell < $80',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    maxLargestSellUsd: 80,
    stopLossPercent: 12.0,
    nominalTargetPercent: 30.0,
    trailingStartPercent: 18.0,
    trailingDrawdownPercent: 3.5,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-BE-Peak10',
    desc: 'Peak >= +10% -> Lock Net Profit (+4.0% Gross) | TP 35%, SL 14%, Sell < $100',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 45.0,
    maxLargestSellUsd: 100,
    stopLossPercent: 14.0,
    nominalTargetPercent: 35.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    breakevenTriggerPercent: 10.0,
    breakevenLockNetPercent: 4.0,
  },

  // --- KELOMPOK 2: RAPID SCALPING (Ambil Profit Cepat +12% s/d +20% Sebelum Rug) ---
  {
    label: 'WR-Scalp12',
    desc: 'Target Cepat +12% | SL 7%, Buyers 8, BuyShare 55%, Sell < $60',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    stopLossPercent: 7.0,
    nominalTargetPercent: 12.0,
    trailingStartPercent: 8.0,
    trailingDrawdownPercent: 2.0,
    breakevenTriggerPercent: 5.5,
    breakevenLockNetPercent: 3.2,
  },
  {
    label: 'WR-Scalp15',
    desc: 'Target Cepat +15% | SL 8%, Buyers 8, BuyShare 50%, Sell < $75',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 50.0,
    maxLargestSellUsd: 75,
    stopLossPercent: 8.0,
    nominalTargetPercent: 15.0,
    trailingStartPercent: 10.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-Scalp18',
    desc: 'Target Cepat +18% | SL 9%, Buyers 7, BuyShare 50%, Sell < $75',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    maxLargestSellUsd: 75,
    stopLossPercent: 9.0,
    nominalTargetPercent: 18.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-Scalp20',
    desc: 'Target Cepat +20% | SL 10%, Buyers 7, BuyShare 50%, Sell < $80',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    maxLargestSellUsd: 80,
    stopLossPercent: 10.0,
    nominalTargetPercent: 20.0,
    trailingStartPercent: 14.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.5,
    breakevenLockNetPercent: 3.5,
  },

  // --- KELOMPOK 3: ULTRA HIGH QUALITY ENTRY (Buyers 8-10, BuyShare 60-70%, No Whales) ---
  {
    label: 'WR-UltraQuality-1',
    desc: 'Buyers >= 8, BuyShare >= 60%, Sell < $50, Anti-FOMO < 20%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 60.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 20.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 10.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 7.5,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-UltraQuality-2',
    desc: 'Buyers >= 9, BuyShare >= 60%, Sell < $60, Anti-FOMO < 25%',
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
    label: 'WR-CrowdDominance',
    desc: 'Buyers >= 10, BuyShare >= 65%, Sell < $50, Peak BE@7%',
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

  // --- KELOMPOK 4: COMBINED MASTER STRATEGIES ---
  {
    label: 'WR-Aegis-65',
    desc: 'Aegis Defender: Buyers 8, Share 55%, Sell < $70, FOMO < 20%, DD < 8%, BE@7%, TP 22%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 70,
    maxEntryReturnPercent: 20.0,
    maxDrawdownPercent: 8.0,
    stopLossPercent: 11.0,
    nominalTargetPercent: 22.0,
    trailingStartPercent: 14.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-Aegis-75',
    desc: 'Aegis Titan: Buyers 8, Share 55%, Sell < $60, FOMO < 18%, DD < 7%, BE@6.5%, TP 18%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 55.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 18.0,
    maxDrawdownPercent: 7.0,
    stopLossPercent: 9.0,
    nominalTargetPercent: 18.0,
    trailingStartPercent: 11.0,
    trailingDrawdownPercent: 2.5,
    breakevenTriggerPercent: 6.5,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-Vanguard-80',
    desc: 'Vanguard Elite: Buyers 9, Share 60%, Sell < $50, FOMO < 15%, DD < 6%, BE@6%, TP 15%',
    minMeaningfulBuyers: 9,
    minBuySharePercent: 60.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 15.0,
    maxDrawdownPercent: 6.0,
    stopLossPercent: 8.0,
    nominalTargetPercent: 15.0,
    trailingStartPercent: 10.0,
    trailingDrawdownPercent: 2.0,
    breakevenTriggerPercent: 6.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-SniperPro-70',
    desc: 'Sniper Pro: Buyers 7, Share 52%, Sell < $75, FOMO < 22%, BE@8%, TP 25%, Trail 16/3',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 52.0,
    maxLargestSellUsd: 75,
    maxEntryReturnPercent: 22.0,
    maxDrawdownPercent: 9.0,
    stopLossPercent: 12.0,
    nominalTargetPercent: 25.0,
    trailingStartPercent: 16.0,
    trailingDrawdownPercent: 3.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
  },
  {
    label: 'WR-PhoenixPro-65',
    desc: 'Phoenix Pro: Buyers 7, Share 45%, Sell < $90, FOMO < 30%, BE@10%, TP 40%, Trail 20/4',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 45.0,
    maxLargestSellUsd: 90,
    maxEntryReturnPercent: 30.0,
    maxDrawdownPercent: 10.0,
    stopLossPercent: 14.0,
    nominalTargetPercent: 40.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    breakevenTriggerPercent: 10.0,
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
const SANDBOX_DIR = join(PROJECT_DIR, 'data/verify-replay-high-wr');

class HighWrLane extends DistributionTargetLane {
  protected peakGrossSeen = -Infinity;

  constructor(
    mint: string,
    readonly cand: HighWrCandidate,
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
        name: `high-wr-${cand.label.toLowerCase()}`,
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

          // 2. Market Cap sweet spot
          const minMcap = cand.minMarketCapUsd ?? 30000;
          const maxMcap = cand.maxMarketCapUsd ?? 600000;
          if (f.price !== null && f.price * 1_000_000_000 < minMcap) {
            reasons.push('ENTRY_MCAP_TOO_LOW');
          }
          if (f.price !== null && maxMcap > 0 && f.price * 1_000_000_000 > maxMcap) {
            reasons.push('ENTRY_MCAP_TOO_HIGH');
          }

          // 3. Holder decline flight risk
          if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) {
            reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');
          }

          // 4. Buyer consensus & Buy share
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

          // 5. Anti-Dump: Largest Sell Guard
          if (cand.maxLargestSellUsd !== undefined && f.largestSellUsd >= cand.maxLargestSellUsd) {
            reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
          }

          // 6. Anti-Dump: Pre-Entry Drawdown Guard
          if (cand.maxDrawdownPercent !== undefined && f.drawdownPercent !== null && f.drawdownPercent > cand.maxDrawdownPercent) {
            reasons.push('PRE_ENTRY_DRAWDOWN_TOO_HIGH');
          }

          // 7. Anti-FOMO / Anti-Pucuk: Observation Gain Cap
          if (cand.maxEntryReturnPercent !== undefined && f.entryReturnPercent !== null && f.entryReturnPercent > cand.maxEntryReturnPercent) {
            reasons.push('FOMO_GAIN_TOO_HIGH_TOP_BUY');
          }

          // 8. Entry window expiry
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
          const sl = cand.stopLossPercent ?? 12.0;
          if (grossRet <= -sl) {
            return `STOP_LOSS_${Math.round(sl)}PCT`;
          }

          // 2. NET PROFIT BREAKEVEN LOCK (KUNCI JUARA WIN RATE)
          // Jika harga sempat naik >= trigger (misal +7%), dan kemudian pullback ke lock level (+3.5% gross = ~ +1% net)
          if (cand.breakevenTriggerPercent !== undefined) {
            const lockGross = cand.breakevenLockNetPercent ?? 3.5;
            if (this.peakGrossSeen >= cand.breakevenTriggerPercent) {
              if (grossRet <= lockGross) {
                return `BREAKEVEN_PROFIT_LOCKED_${Math.round(cand.breakevenTriggerPercent)}_${Math.round(lockGross)}`;
              }
            }
          }

          // 3. NOMINAL TAKE PROFIT CEILING
          const tp = cand.nominalTargetPercent ?? 30.0;
          if (grossRet >= tp) {
            return `TAKE_PROFIT_CEILING_${Math.round(tp)}`;
          }

          // 4. DYNAMIC TRAILING PROFIT
          const trailStart = cand.trailingStartPercent ?? 18.0;
          const trailDrop = cand.trailingDrawdownPercent ?? 3.0;
          if (this.peakGrossSeen >= trailStart) {
            const ddFromPeak = this.peakGrossSeen - grossRet;
            if (ddFromPeak >= trailDrop) {
              return `TRAILING_PROFIT_ABOVE_${Math.round(trailStart)}_DD${Math.round(trailDrop)}`;
            }
          }

          // 5. MAX HOLD TIMEOUT
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

class HighWrRuntime extends DistributionProfit4Runtime {
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

    for (const cand of HIGH_WR_CANDIDATES) {
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
        version: `rules-high-wr-${cand.label.toLowerCase()}`,
        paperOnly: true,
        enabled: true,
        stakeUsd: 5.0,
        stopLossPercent: cand.stopLossPercent ?? 12.0,
        targetPercent: 1000.0,
        trailingStartPercent: cand.trailingStartPercent ?? 18.0,
        trailingDrawdownPercent: cand.trailingDrawdownPercent ?? 3.0,
        maxHoldSeconds: cand.maxHoldSeconds ?? 2700,
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
        blockKnownDumpSellers: true,
      });

      const lane = new HighWrLane(transfer.mint, cand, rules, makeOnEvent(key, cand.label));
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
  console.log('🚀 MEMULAI LOOP ENGINEERING TINGKAT TINGGI: OPTIMALISASI HIGH WIN RATE');
  console.log(`Menguji ${HIGH_WR_CANDIDATES.length} variasi strategi pada 2.28 Juta Tick Replay`);
  console.log('='.repeat(100));

  if (existsSync(SANDBOX_DIR)) rmSync(SANDBOX_DIR, { recursive: true, force: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

  // 1. Ekstrak mint & transfer waktu registrasi
  console.log('[1/4] Mengumpulkan token mint & transfer dari live run...');
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
  console.log(`-> Ditemukan ${transfers.size} kandidat unik dari live runs.`);

  // 2. Load trades dari chunks
  console.log('[2/4] Memuat ~2.28 juta tick WebSocket granular...');
  const tradeEvents: ReplayEvent[] = [];
  let loadedFiles = 0;
  for (const fd of FEED_DIRS) {
    if (!existsSync(fd)) continue;
    for (const cn of readdirSync(fd).sort()) {
      const tf = join(fd, cn, 'token-trades.jsonl');
      if (!existsSync(tf)) continue;
      loadedFiles++;
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
  console.log(`-> Berhasil memuat ${tradeEvents.length.toLocaleString()} matching ticks dari ${loadedFiles} chunk files.`);

  // 3. Susun kronologis
  console.log('[3/4] Mengurutkan event kronologis...');
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
  console.log(`-> Total timeline sequence: ${allEvents.length.toLocaleString()} events.`);

  const startTime = allEvents[0].time;
  const endTime = allEvents[allEvents.length - 1].time;

  // 4. Jalankan Replay Engine
  console.log('[4/4] Mengeksekusi High Win Rate Replay Simulation...');
  const runtime = new HighWrRuntime(SANDBOX_DIR, () => {}, SANDBOX_DIR, 'trend20m');

  let lastEvalAt = startTime;
  let processed = 0;
  const total = allEvents.length;

  for (const ev of allEvents) {
    processed++;
    if (processed % 250000 === 0) {
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

  // Aggregation per Candidate
  const summary: any[] = [];
  for (const cand of HIGH_WR_CANDIDATES) {
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

  // Sort by Win Rate descending, then Total PnL descending
  summary.sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl);

  console.log('\n' + '='.repeat(120));
  console.log('🏆 LEADERBOARD LOOP ENGINEERING: RANKING TERTINGGI WIN RATE');
  console.log('='.repeat(120));
  console.log(
    'Rank'.padEnd(5) +
    '| Lane Label'.padEnd(20) +
    '| Trades (W/L)'.padEnd(16) +
    '| Win Rate'.padEnd(12) +
    '| Net PnL ($5)'.padEnd(15) +
    '| Profit Factor'.padEnd(15) +
    '| Dominant Exit'
  );
  console.log('-'.repeat(120));

  summary.forEach((s, idx) => {
    const rank = `#${idx + 1}`.padEnd(5);
    const label = s.label.padEnd(20);
    const tradeSummary = `${s.trades} (${s.wins}/${s.losses})`.padEnd(16);
    const wr = `${s.winRate.toFixed(1)}%`.padEnd(12);
    const pnl = `${s.totalPnl >= 0 ? '+' : ''}$${s.totalPnl.toFixed(2)}`.padEnd(15);
    const pf = `${s.profitFactor.toFixed(2)}x`.padEnd(15);

    const topReason = Object.entries(s.reasons).sort((a: any, b: any) => (b[1] as number) - (a[1] as number))[0];
    const reasonStr = topReason ? `${topReason[0]} (${topReason[1]})` : '-';

    console.log(`${rank}| ${label}| ${tradeSummary}| ${wr}| ${pnl}| ${pf}| ${reasonStr}`);
  });
  console.log('='.repeat(120));

  console.log('\n🎯 ANALISIS TOP 3 JUARA WIN RATE:');
  summary.slice(0, 3).forEach((s, i) => {
    console.log(`\n${i + 1}. [${s.label}] - Win Rate: ${s.winRate.toFixed(1)}% | Net PnL: $${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl.toFixed(2)}`);
    console.log(`   Deskripsi    : ${s.desc}`);
    console.log(`   Total Trades : ${s.trades} (${s.wins} Menang / ${s.losses} Kalah)`);
    console.log(`   Profit Factor: ${s.profitFactor.toFixed(2)}x`);
    console.log(`   Sebaran Exit :`, JSON.stringify(s.reasons));
  });
}

main().catch(console.error);
