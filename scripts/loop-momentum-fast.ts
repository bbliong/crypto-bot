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

interface MomentumCandidate {
  label: string;
  desc: string;
  minMeaningfulBuyers?: number;
  minBuySharePercent?: number;
  maxLargestSellUsd?: number;
  maxDrawdownPercent?: number;
  maxEntryReturnPercent?: number;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  stopLossPercent?: number;
  nominalTargetPercent?: number;
  trailingStartPercent?: number;
  trailingDrawdownPercent?: number;
  breakevenTriggerPercent?: number;
  breakevenLockNetPercent?: number;
  maxHoldSeconds?: number;
}

const CANDIDATES: MomentumCandidate[] = [
  // --- BASELINE KONTROL (Kondisi Live Saat Ini) ---
  {
    label: 'M-Scalp-Base',
    desc: 'Baseline M-Scalp (Buyers 4, Share 65%, Sell < $250, No Anti-FOMO, SL 5%, Trail 8/2.5, TP 20%)',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 250,
    stopLossPercent: 5.0,
    trailingStartPercent: 8.0,
    trailingDrawdownPercent: 2.5,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
    maxHoldSeconds: 180,
  },
  {
    label: 'M-Trend-Base',
    desc: 'Baseline M-Trend (Buyers 5, Share 70%, Sell < $250, No Anti-FOMO, SL 6%, Trail 12/3.5, TP 35%)',
    minMeaningfulBuyers: 5,
    minBuySharePercent: 70.0,
    maxLargestSellUsd: 250,
    stopLossPercent: 6.0,
    trailingStartPercent: 12.0,
    trailingDrawdownPercent: 3.5,
    nominalTargetPercent: 35.0,
    minMarketCapUsd: 20000,
    maxHoldSeconds: 300,
  },
  {
    label: 'M-Golden-Base',
    desc: 'Baseline M-Golden (Buyers 12, Share 65%, Sell < $250, No Anti-FOMO, SL 5%, Trail 10/2, TP 30%)',
    minMeaningfulBuyers: 12,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 250,
    stopLossPercent: 5.0,
    trailingStartPercent: 10.0,
    trailingDrawdownPercent: 2.0,
    nominalTargetPercent: 30.0,
    minMarketCapUsd: 20000,
    maxHoldSeconds: 600,
  },

  // --- KELOMPOK 1: WHALE SELL GUARD EXPERIMENTS ---
  {
    label: 'M-Guard-Sell50',
    desc: 'Whale Sell < $50: Buyers 4, Share 65%, SL 8%, TP 20%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Guard-Sell75',
    desc: 'Whale Sell < $75: Buyers 4, Share 65%, SL 8%, TP 20%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 75,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Guard-Sell100',
    desc: 'Whale Sell < $100: Buyers 4, Share 65%, SL 8%, TP 20%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 100,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },

  // --- KELOMPOK 2: ANTI-FOMO & ANTI-PUCUK ---
  {
    label: 'M-AntiFOMO-25',
    desc: 'Anti-FOMO < 25%: Sell < $50, Buyers 4, Share 65%, SL 8%, TP 20%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-AntiFOMO-20',
    desc: 'Anti-FOMO < 20%: Sell < $50, Buyers 4, Share 65%, SL 8%, TP 20%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 20.0,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },

  // --- KELOMPOK 3: NET BREAKEVEN LOCK + TAKE PROFIT CEILING ---
  {
    label: 'M-BE6-TP18',
    desc: 'BE Trigger +6% (Lock +3.5%), TP 18%, Sell < $50, FOMO < 25%, SL 8%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 6.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 8.0,
    nominalTargetPercent: 18.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-BE7-TP20',
    desc: 'BE Trigger +7% (Lock +3.5%), TP 20%, Sell < $50, FOMO < 25%, SL 8%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-BE8-TP25',
    desc: 'BE Trigger +8% (Lock +3.5%), TP 25%, Sell < $60, FOMO < 25%, SL 9%',
    minMeaningfulBuyers: 4,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 9.0,
    nominalTargetPercent: 25.0,
    minMarketCapUsd: 15000,
  },

  // --- KELOMPOK 4: CROWD CONSENSUS HIGH WIN RATE (BUYERS 5 - 6) ---
  {
    label: 'M-Crowd5-BE6-TP18',
    desc: 'Crowd 5B: Buyers 5, Share 65%, Sell < $50, FOMO < 25%, BE@6%, TP 18%, SL 8%',
    minMeaningfulBuyers: 5,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 6.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 8.0,
    nominalTargetPercent: 18.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Crowd5-BE7-TP20',
    desc: 'Crowd 5B: Buyers 5, Share 65%, Sell < $50, FOMO < 25%, BE@7%, TP 20%, SL 8%',
    minMeaningfulBuyers: 5,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Crowd5-BE8-TP25',
    desc: 'Crowd 5B: Buyers 5, Share 65%, Sell < $60, FOMO < 25%, BE@8%, TP 25%, SL 9%',
    minMeaningfulBuyers: 5,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 9.0,
    nominalTargetPercent: 25.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Crowd6-BE7-TP20',
    desc: 'Crowd 6B: Buyers 6, Share 65%, Sell < $50, FOMO < 20%, BE@7%, TP 20%, SL 8%',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 20.0,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Crowd6-BE8-TP25',
    desc: 'Crowd 6B: Buyers 6, Share 65%, Sell < $60, FOMO < 25%, BE@8%, TP 25%, SL 9%',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 60,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 8.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 9.0,
    nominalTargetPercent: 25.0,
    minMarketCapUsd: 15000,
  },
  {
    label: 'M-Golden-V2',
    desc: 'Golden V2: Mcap >= $20k, Buyers 8, Share 65%, Sell < $50, BE@7%, TP 20%, SL 8%',
    minMeaningfulBuyers: 8,
    minBuySharePercent: 65.0,
    maxLargestSellUsd: 50,
    maxEntryReturnPercent: 25.0,
    breakevenTriggerPercent: 7.0,
    breakevenLockNetPercent: 3.5,
    stopLossPercent: 8.0,
    nominalTargetPercent: 20.0,
    minMarketCapUsd: 20000,
  },
];

const root = '/home/bbliong/project/crypto-bot';
const SANDBOX_DIR = join(root, 'data', 'test-momentum-fast-sandbox');

const LIVE_RUN_DIRS = [
  join(root, 'data', 'momentum-watch', '2026-10-21T11-42-54-105Z'),
  join(root, 'data', 'momentum-watch', '2026-10-22T03-52-48-017Z'),
];

const FEED_DIRS = [
  join(root, 'data', 'feed-hub', '2026-10-21T11-42-44-751Z', 'chunks'),
  join(root, 'data', 'feed-hub', '2026-10-22T03-52-37-816Z', 'chunks'),
];

class CustomMomentumLane extends DistributionTargetLane {
  private peakGrossSeen = -Infinity;

  constructor(
    mint: string,
    cand: MomentumCandidate,
    emit: (event: TargetEvent) => void
  ) {
    const rules = validateTargetRules({
      ...DEFAULT_TARGET_RULES,
      paperOnly: true,
      enabled: true,
      version: `momentum-${cand.label.toLowerCase()}`,
      targetPercent: cand.nominalTargetPercent ?? 20.0,
      stopLossPercent: cand.stopLossPercent ?? 8.0,
      trailingStartPercent: cand.trailingStartPercent ?? 12.0,
      trailingDrawdownPercent: cand.trailingDrawdownPercent ?? 2.5,
      observationSeconds: 15,
      minTransferAgeSeconds: 10,
      maxTransferLagSeconds: 60,
      maxEntryWaitSeconds: 1800,
      confirmSeconds: 2,
      feePercentPerSide: 1,
      slippagePercentPerSide: 0.5,
      fixedFeeUsdPerSide: 0.005,
      stakeUsd: 5.0,
      maxHoldSeconds: cand.maxHoldSeconds ?? 600,
      minBuySharePercent: cand.minBuySharePercent ?? 65.0,
      minMeaningfulBuyers: cand.minMeaningfulBuyers ?? 4,
    });

    super(
      mint,
      rules,
      (e) =>
        emit({
          ...e,
          targetPercent: rules.targetPercent,
          version: rules.version,
          laneLabel: cand.label as any,
        }),
      {
        name: cand.label.toLowerCase(),
        paperLane: rules.version,
        trailingEnabled: true,
        prioritizeCustomExit: true,
        overrideEntryReasons: (f: TargetFacts) => {
          const reasons: string[] = [];

          if (f.firstAt === null || f.now - f.firstAt < rules.observationSeconds * 1000) {
            reasons.push('OBSERVATION_NOT_COMPLETE');
          }
          if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 5000) {
            reasons.push('PRICE_MISSING_OR_STALE');
          }

          // 1. Market Cap filter ($10k - $100k)
          const estMcap = (f.price ?? 0) * 1_000_000_000;
          const minMcap = cand.minMarketCapUsd ?? 10000;
          const maxMcap = cand.maxMarketCapUsd ?? 100000;
          if (estMcap < minMcap) reasons.push('MARKET_CAP_BELOW_MIN');
          if (estMcap > maxMcap) reasons.push('MARKET_CAP_ABOVE_MAX');

          // 2. Buyer consensus & Buy share
          if (f.buyShareUsdPercent !== null && f.buyShareUsdPercent < (cand.minBuySharePercent ?? 65.0)) {
            reasons.push('BUY_SHARE_TOO_LOW');
          }
          if (f.meaningfulBuyers < (cand.minMeaningfulBuyers ?? 4)) {
            reasons.push('NOT_ENOUGH_BUYERS');
          }
          if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 75.0) {
            reasons.push('BUYER_CONCENTRATION_HIGH');
          }

          // 3. Anti-Whale Dump Guard
          const maxSell = cand.maxLargestSellUsd ?? 250;
          if (f.largestSellUsd >= maxSell) {
            reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
          }

          // 4. Pre-Entry Drawdown Guard
          const maxDD = cand.maxDrawdownPercent ?? 4.0;
          if (f.drawdownPercent !== null && f.drawdownPercent > maxDD) {
            reasons.push('PRICE_DRAWDOWN_EXCEEDED');
          }

          // 5. Anti-FOMO: Observation Pre-Entry Gain Cap
          if (cand.maxEntryReturnPercent !== undefined) {
            if (f.entryReturnPercent !== null && f.entryReturnPercent > cand.maxEntryReturnPercent) {
              reasons.push('FOMO_GAIN_TOO_HIGH_TOP_BUY');
            }
          }

          // 6. Dev holding share
          if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 20) {
            reasons.push('DEV_HOLDING_TOO_HIGH');
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
          const sl = cand.stopLossPercent ?? 8.0;
          if (grossRet <= -sl) {
            return `STOP_LOSS_${Math.round(sl)}PCT`;
          }

          // 2. NET PROFIT BREAKEVEN LOCK
          if (cand.breakevenTriggerPercent !== undefined && cand.breakevenLockNetPercent !== undefined) {
            if (this.peakGrossSeen >= cand.breakevenTriggerPercent) {
              if (grossRet <= cand.breakevenLockNetPercent) {
                return `BREAKEVEN_PROFIT_LOCKED_${Math.round(cand.breakevenTriggerPercent)}_${Math.round(cand.breakevenLockNetPercent)}`;
              }
            }
          }

          // 3. NOMINAL TAKE PROFIT CEILING
          if (cand.nominalTargetPercent !== undefined) {
            if (grossRet >= cand.nominalTargetPercent) {
              return `TAKE_PROFIT_CEILING_${Math.round(cand.nominalTargetPercent)}`;
            }
          }

          // 4. DYNAMIC TRAILING PROFIT
          if (cand.trailingStartPercent !== undefined && cand.trailingDrawdownPercent !== undefined) {
            if (this.peakGrossSeen >= cand.trailingStartPercent) {
              const ddFromPeak = this.peakGrossSeen - grossRet;
              if (ddFromPeak >= cand.trailingDrawdownPercent) {
                return `TRAILING_PROFIT_ABOVE_${Math.round(cand.trailingStartPercent)}_DD${Math.round(cand.trailingDrawdownPercent)}`;
              }
            }
          }

          // 5. MAX HOLD TIMEOUT
          const holdSec = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          const maxHold = cand.maxHoldSeconds ?? 600;
          if (holdSec >= maxHold) {
            return `MAX_HOLD_TIMEOUT_${Math.round(maxHold / 60)}M`;
          }

          return null;
        },
      }
    );
  }
}

class FastMomentumRuntime extends DistributionProfit4Runtime {
  override evaluate(now: number) {
    if (now - (this as any).lastEvaluationAt < 1000) return;
    (this as any).lastEvaluationAt = now;

    const factsCache = new Map<string, any>();
    const toDelete: string[] = [];

    for (const state of (this as any).states.values()) {
      if (!state.active) {
        toDelete.push(state.key);
        continue;
      }

      let facts = factsCache.get(state.transfer.mint);
      if (!facts) {
        facts = state.observation.facts(now, [], state.transfer.from);
        factsCache.set(state.transfer.mint, facts);
      }
      state.facts = facts;

      const waitStart = state.registeredAt ?? facts.firstAt;
      if (state.lane.entryAt === null && waitStart !== null && now - waitStart > 1800 * 1000) {
        state.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
        state.active = false;
        toDelete.push(state.key);
      } else {
        state.lane.step(facts);
        if (state.lane.phase === 'CLOSED' || state.lane.phase === 'CENSORED') {
          state.active = false;
          if (state.lane.entryAt !== null) {
            (this as any).closedPositions.set(state.key, (this as any).serializeState(state, now));
          }
          toDelete.push(state.key);
        }
      }
    }

    for (const key of toDelete) {
      (this as any).states.delete(key);
    }
  }

  saveAll(now: number) {
    (this as any).persist(now);
  }

  override register(transfer: Transfer, now: number) {
    const mcap = transfer.marketCapUsd ?? (transfer.priceUsd ? transfer.priceUsd * 1_000_000_000 : null);
    if (!mcap || mcap < 10000 || mcap > 100000) return;

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

      const lane = new CustomMomentumLane(transfer.mint, cand, makeOnEvent(key, cand.label));
      this.states.set(key, {
        key,
        transfer,
        observation,
        lane,
        facts: null,
        active: true,
        registeredAt: now,
        laneLabel: cand.label as any,
        version: `momentum-${cand.label.toLowerCase()}`,
        lastDecision: null,
        lastEvent: null,
      });
    }
  }
}

async function main() {
  console.log('='.repeat(100));
  console.log('🚀 MEMULAI TICK REPLAY BACKTEST & LOOP ENGINEERING KHUSUS MOMENTUM (FAST ENGINE)');
  console.log(`Menguji ${CANDIDATES.length} variasi strategi pada dataset tick granular (Oct 21-22)`);
  console.log('='.repeat(100));

  if (existsSync(SANDBOX_DIR)) rmSync(SANDBOX_DIR, { recursive: true, force: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

  // 1. Ekstrak mint & transfer waktu registrasi dari live chunks (hanya untuk token yang masuk profit4-state.json)
  console.log('[1/4] Mengumpulkan token mint & exact registered timestamp dari live events...');
  const targetMints = new Set<string>();
  for (const dir of LIVE_RUN_DIRS) {
    const sf = join(dir, 'profit4-state.json');
    if (!existsSync(sf)) continue;
    try {
      const data = JSON.parse(readFileSync(sf, 'utf8'));
      for (const p of data.positions || []) {
        if (p.mint) targetMints.add(p.mint);
      }
    } catch {}
  }
  console.log(`-> Ditemukan ${targetMints.size} target mint dari live state.`);

  const transfers = new Map<string, { registeredAt: number; transfer: Transfer }>();

  for (const dir of LIVE_RUN_DIRS) {
    const chunksDir = join(dir, 'chunks');
    if (!existsSync(chunksDir)) continue;
    for (const cf of readdirSync(chunksDir).sort()) {
      const ef = join(chunksDir, cf, 'profit4-events.jsonl');
      if (!existsSync(ef)) continue;
      const lines = readFileSync(ef, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.includes('PAPER_ENTRY_DECISION')) continue;
        try {
          const e = JSON.parse(line);
          const t: Transfer = e.transfer;
          const at = Number(e.observedAt || e.at);
          if (t && t.mint && targetMints.has(t.mint) && at > 0) {
            const existing = transfers.get(t.mint);
            if (!existing || at < existing.registeredAt) {
              transfers.set(t.mint, { registeredAt: at, transfer: t });
            }
          }
        } catch {}
      }
    }
  }

  // Lengkapi dari state jika ada yang belum dapat transfer
  for (const dir of LIVE_RUN_DIRS) {
    const sf = join(dir, 'profit4-state.json');
    if (!existsSync(sf)) continue;
    try {
      const data = JSON.parse(readFileSync(sf, 'utf8'));
      for (const p of data.positions || []) {
        const m = p.mint;
        if (!m || transfers.has(m)) continue;
        const at = p.timestamp ? p.timestamp * 1000 : (p.entryAt || 0);
        const t: Transfer = {
          mint: m,
          wallet: p.wallet,
          symbol: p.symbol,
          timestamp: p.timestamp,
          from: p.from,
          source: p.source || 'gmgn_research_ws',
          priceUsd: p.priceUsd,
          marketCapUsd: p.marketCapUsd,
        };
        transfers.set(m, { registeredAt: at, transfer: t });
      }
    } catch {}
  }

  const mintSet = new Set(transfers.keys());
  console.log(`-> Ditemukan ${transfers.size.toLocaleString()} kandidat token unik momentum.`);

  // 2. Load trades dari feed chunks
  console.log('[2/4] Memuat ticks WebSocket granular dari feed-hub chunks...');
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
        const mIdx = line.indexOf('"mint":"');
        if (mIdx === -1) continue;
        const endQuote = line.indexOf('"', mIdx + 8);
        if (endQuote === -1) continue;
        const m = line.slice(mIdx + 8, endQuote);
        if (!mintSet.has(m)) continue;

        try {
          const t: TargetTrade = JSON.parse(line);
          const time = Number(t.at || t.timestamp * 1000);
          if (time > 0 && t.price > 0) {
            tradeEvents.push({
              time,
              kind: 'TRADE',
              mint: m,
              trade: t,
            });
          }
        } catch {}
      }
    }
  }

  console.log(`-> ${loadedFiles} file chunk diproses.`);
  console.log(`-> ${tradeEvents.length.toLocaleString()} matching ticks dimuat ke memory.`);

  // 3. Gabungkan events & urutkan kronologis
  console.log('[3/4] Mengurutkan timeline event secara deterministik...');
  const allEvents: ReplayEvent[] = [];
  for (const [mint, info] of transfers) {
    allEvents.push({
      time: info.registeredAt,
      kind: 'REGISTER',
      mint,
      transfer: info.transfer,
    });
  }
  for (const te of tradeEvents) {
    allEvents.push(te);
  }
  allEvents.sort((a, b) => a.time - b.time);
  console.log(`-> Total ${allEvents.length.toLocaleString()} event siap di-replay.`);

  // 4. Inisialisasi runtime & replay
  console.log('[4/4] Menjalankan simulasi replay tick-by-tick paralel...');
  const write = (name: string, val: any) => {};
  const runtime = new FastMomentumRuntime(SANDBOX_DIR, write, SANDBOX_DIR, 'momentum');

  let processedCount = 0;
  const totalEvents = allEvents.length;
  let lastEvalTime = 0;
  const logStep = Math.max(1, Math.floor(totalEvents / 10));

  const startTime = Date.now();

  for (const ev of allEvents) {
    if (ev.kind === 'REGISTER' && ev.transfer) {
      runtime.register(ev.transfer, ev.time);
    } else if (ev.kind === 'TRADE' && ev.trade) {
      runtime.trade(ev.mint, ev.trade);
    }

    if (ev.time - lastEvalTime >= 1000) {
      runtime.evaluate(ev.time);
      lastEvalTime = ev.time;
    }

    processedCount++;
    if (processedCount % logStep === 0) {
      const pct = Math.round((processedCount / totalEvents) * 100);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const activeStates = (runtime as any).states.size;
      console.log(`   [Progress: ${pct}%] ${processedCount.toLocaleString()} / ${totalEvents.toLocaleString()} events (${elapsed}s, active states: ${activeStates})`);
    }
  }

  // Evaluasi final
  const finalTime = allEvents.length ? allEvents[allEvents.length - 1]!.time + 10000 : Date.now();
  runtime.evaluate(finalTime);
  for (const state of (runtime as any).states.values()) {
    if (state.lane.entryAt !== null) {
      state.lane.end(finalTime, 'BENCHMARK_END');
      (runtime as any).closedPositions.set(state.key, (runtime as any).serializeState(state, finalTime));
    }
  }
  runtime.saveAll(finalTime);

  // 5. Analisis Hasil Simulasi
  console.log('\n' + '='.repeat(110));
  console.log('🏆 HASIL LOOP ENGINEERING & TICK REPLAY BACKTEST GRUP MOMENTUM');
  console.log('='.repeat(110));
  console.log(
    `${'Label'.padEnd(24)} | ${'Trades'.padEnd(7)} | ${'Win'.padEnd(4)} | ${'Loss'.padEnd(5)} | ${'Win Rate'.padEnd(9)} | ${'Net PnL ($5)'.padEnd(14)} | ${'Profit Factor'.padEnd(14)} | ${'Avg Win'.padEnd(8)} | ${'Avg Loss'.padEnd(8)}`
  );
  console.log('-'.repeat(110));

  const closedMap = (runtime as any).closedPositions as Map<string, any>;
  const allClosed = Array.from(closedMap.values());

  const results: any[] = [];

  for (const cand of CANDIDATES) {
    const lanePositions = allClosed.filter((p) => p.laneLabel === cand.label);
    const wins = lanePositions.filter((p) => (p.pnlUsd || 0) > 0);
    const losses = lanePositions.filter((p) => (p.pnlUsd || 0) <= 0);
    const wr = lanePositions.length ? (wins.length / lanePositions.length) * 100 : 0;
    const totalPnl = lanePositions.reduce((acc, p) => acc + (p.pnlUsd || 0), 0);
    const grossWin = wins.reduce((acc, p) => acc + (p.pnlUsd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((acc, p) => acc + (p.pnlUsd || 0), 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99.0 : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;

    results.push({
      label: cand.label,
      desc: cand.desc,
      trades: lanePositions.length,
      wins: wins.length,
      losses: losses.length,
      wr,
      totalPnl,
      pf,
      avgWin,
      avgLoss,
    });

    const pnlStr = (totalPnl >= 0 ? '+' : '') + `$${totalPnl.toFixed(2)}`;
    console.log(
      `${cand.label.padEnd(24)} | ${String(lanePositions.length).padEnd(7)} | ${String(wins.length).padEnd(4)} | ${String(losses.length).padEnd(5)} | ${(wr.toFixed(1) + '%').padEnd(9)} | ${pnlStr.padEnd(14)} | ${(pf.toFixed(2) + 'x').padEnd(14)} | +$${avgWin.toFixed(2)} | -$${avgLoss.toFixed(2)}`
    );
  }

  console.log('='.repeat(110));

  // Tampilkan Top 5 Peringkat Tertinggi
  results.sort((a, b) => b.wr - a.wr || b.totalPnl - a.totalPnl);
  console.log('\n🌟 TOP 5 FORMULASI TERTINGGI WIN RATE:');
  for (let i = 0; i < Math.min(5, results.length); i++) {
    const r = results[i];
    console.log(`${i + 1}. [${r.label}] Win Rate: ${r.wr.toFixed(1)}% | Net PnL: ${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(2)} | Profit Factor: ${r.pf.toFixed(2)}x (${r.trades} trades: ${r.wins}W / ${r.losses}L)`);
    console.log(`   Konfigurasi: ${r.desc}`);
  }

  // Bersihkan sandbox
  try { rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error('Fatal fast replay error:', err);
  process.exit(1);
});
