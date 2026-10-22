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

interface EvolvedConfig {
  label: string;
  minBuyers: number;
  minBuyShare: number;
  maxSellUsd: number;
  fomoCap?: number;
  beTrigger?: number;
  beLock?: number;
  tpCeiling?: number;
  stopLoss: number;
  minMcap: number;
  maxMcap: number;
  maxHoldSec: number;
  trailingStart: number;
  trailingDd: number;
}

const LANES: EvolvedConfig[] = [
  // --- BASELINE (OLD LANES) ---
  {
    label: 'M-Scalp (Baseline)',
    minBuyers: 4,
    minBuyShare: 65,
    maxSellUsd: 250,
    stopLoss: 5,
    minMcap: 15000,
    maxMcap: 100000,
    maxHoldSec: 180,
    tpCeiling: 20,
    trailingStart: 8,
    trailingDd: 2.5,
  },
  {
    label: 'M-Trend (Baseline)',
    minBuyers: 5,
    minBuyShare: 70,
    maxSellUsd: 250,
    stopLoss: 6,
    minMcap: 20000,
    maxMcap: 100000,
    maxHoldSec: 300,
    tpCeiling: 35,
    trailingStart: 12,
    trailingDd: 3.5,
  },
  {
    label: 'M-Golden (Baseline)',
    minBuyers: 12,
    minBuyShare: 65,
    maxSellUsd: 250,
    stopLoss: 5,
    minMcap: 20000,
    maxMcap: 100000,
    maxHoldSec: 600,
    tpCeiling: 30,
    trailingStart: 10,
    trailingDd: 2.0,
  },

  // --- UPGRADED EVOLVED LANES ---
  {
    label: 'M-Scalp (Evolved)',
    minBuyers: 4,
    minBuyShare: 65,
    maxSellUsd: 60,
    fomoCap: 45,
    beTrigger: 6.0,
    beLock: 3.0,
    tpCeiling: 18.0,
    stopLoss: 7.0,
    minMcap: 15000,
    maxMcap: 100000,
    maxHoldSec: 180,
    trailingStart: 8.0,
    trailingDd: 2.0,
  },
  {
    label: 'M-Trend (Evolved)',
    minBuyers: 5,
    minBuyShare: 65,
    maxSellUsd: 60,
    fomoCap: 45,
    beTrigger: 6.0,
    beLock: 3.0,
    tpCeiling: 20.0,
    stopLoss: 7.0,
    minMcap: 20000,
    maxMcap: 100000,
    maxHoldSec: 300,
    trailingStart: 8.0,
    trailingDd: 2.0,
  },
  {
    label: 'M-Golden (Evolved)',
    minBuyers: 6,
    minBuyShare: 65,
    maxSellUsd: 60,
    fomoCap: 45,
    beTrigger: 6.0,
    beLock: 3.0,
    tpCeiling: 18.0,
    stopLoss: 7.0,
    minMcap: 20000,
    maxMcap: 100000,
    maxHoldSec: 450,
    trailingStart: 8.0,
    trailingDd: 2.0,
  },
];

const root = '/home/bbliong/project/crypto-bot';
const SANDBOX_DIR = join(root, 'data', 'test-momentum-verify-sandbox');

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
    cand: EvolvedConfig,
    emit: (event: TargetEvent) => void
  ) {
    const rules = validateTargetRules({
      ...DEFAULT_TARGET_RULES,
      paperOnly: true,
      enabled: true,
      version: `momentum-${cand.label.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
      targetPercent: cand.tpCeiling ?? 20.0,
      stopLossPercent: cand.stopLoss,
      trailingStartPercent: cand.trailingStart,
      trailingDrawdownPercent: cand.trailingDd,
      observationSeconds: 15,
      minTransferAgeSeconds: 10,
      maxTransferLagSeconds: 60,
      maxEntryWaitSeconds: 1800,
      confirmSeconds: 2,
      feePercentPerSide: 1,
      slippagePercentPerSide: 0.5,
      fixedFeeUsdPerSide: 0.005,
      stakeUsd: 5.0,
      maxHoldSeconds: cand.maxHoldSec,
      minBuySharePercent: cand.minBuyShare,
      minMeaningfulBuyers: cand.minBuyers,
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
        name: cand.label.toLowerCase().replace(/[^a-z0-9]/g, '_'),
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

          // 1. Market Cap filter
          const estMcap = (f.price ?? 0) * 1_000_000_000;
          if (estMcap < cand.minMcap) reasons.push('MARKET_CAP_BELOW_MIN');
          if (estMcap > cand.maxMcap) reasons.push('MARKET_CAP_ABOVE_MAX');

          // 2. Buyer consensus & Buy share
          if (f.buyShareUsdPercent !== null && f.buyShareUsdPercent < cand.minBuyShare) {
            reasons.push('BUY_SHARE_TOO_LOW');
          }
          if (f.meaningfulBuyers < cand.minBuyers) {
            reasons.push('NOT_ENOUGH_BUYERS');
          }
          if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 75.0) {
            reasons.push('BUYER_CONCENTRATION_HIGH');
          }

          // 3. Anti-Whale Dump Guard
          if (f.largestSellUsd >= cand.maxSellUsd) {
            reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
          }

          // 4. Pre-Entry Drawdown Guard
          if (f.drawdownPercent !== null && f.drawdownPercent > 4.0) {
            reasons.push('PRICE_DRAWDOWN_EXCEEDED');
          }

          // 5. Anti-FOMO: Observation Pre-Entry Gain Cap
          if (cand.fomoCap !== undefined) {
            if (f.entryReturnPercent !== null && f.entryReturnPercent > cand.fomoCap) {
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
          if (grossRet <= -cand.stopLoss) {
            return `STOP_LOSS_${Math.round(cand.stopLoss)}PCT`;
          }

          // 2. NET PROFIT BREAKEVEN LOCK
          if (cand.beTrigger !== undefined && cand.beLock !== undefined) {
            if (this.peakGrossSeen >= cand.beTrigger) {
              if (grossRet <= cand.beLock) {
                return `BREAKEVEN_PROFIT_LOCKED_${Math.round(cand.beTrigger)}_${Math.round(cand.beLock)}`;
              }
            }
          }

          // 3. NOMINAL TAKE PROFIT CEILING
          if (cand.tpCeiling !== undefined) {
            if (grossRet >= cand.tpCeiling) {
              return `TAKE_PROFIT_CEILING_${Math.round(cand.tpCeiling)}`;
            }
          }

          // 4. DYNAMIC TRAILING PROFIT
          if (this.peakGrossSeen >= cand.trailingStart) {
            const ddFromPeak = this.peakGrossSeen - grossRet;
            if (ddFromPeak >= cand.trailingDd) {
              return `TRAILING_PROFIT_ABOVE_${Math.round(cand.trailingStart)}_DD${Math.round(cand.trailingDd)}`;
            }
          }

          // 5. MAX HOLD TIMEOUT
          const holdSec = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          if (holdSec >= cand.maxHoldSec) {
            return `MAX_HOLD_TIMEOUT_${Math.round(cand.maxHoldSec / 60)}M`;
          }

          return null;
        },
      }
    );
  }
}

class FastVerifyRuntime extends DistributionProfit4Runtime {
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

    for (const cand of LANES) {
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
        version: `momentum-${cand.label.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
        lastDecision: null,
        lastEvent: null,
      });
    }
  }
}

async function main() {
  console.log('='.repeat(110));
  console.log('⚔️  HEAD-TO-HEAD AUDIT: MOMENTUM BASELINE VS EVOLVED LANES (686.140 TICKS)');
  console.log('='.repeat(110));

  if (existsSync(SANDBOX_DIR)) rmSync(SANDBOX_DIR, { recursive: true, force: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });

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
  const tradeEvents: ReplayEvent[] = [];

  for (const fd of FEED_DIRS) {
    if (!existsSync(fd)) continue;
    for (const cn of readdirSync(fd).sort()) {
      const tf = join(fd, cn, 'token-trades.jsonl');
      if (!existsSync(tf)) continue;
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
            tradeEvents.push({ time, kind: 'TRADE', mint: m, trade: t });
          }
        } catch {}
      }
    }
  }

  const allEvents: ReplayEvent[] = [];
  for (const [mint, info] of transfers) {
    allEvents.push({ time: info.registeredAt, kind: 'REGISTER', mint, transfer: info.transfer });
  }
  for (const te of tradeEvents) {
    allEvents.push(te);
  }
  allEvents.sort((a, b) => a.time - b.time);

  const write = (name: string, val: any) => {};
  const runtime = new FastVerifyRuntime(SANDBOX_DIR, write, SANDBOX_DIR, 'momentum');

  let lastEvalTime = 0;
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
  }

  const finalTime = allEvents.length ? allEvents[allEvents.length - 1]!.time + 10000 : Date.now();
  runtime.evaluate(finalTime);
  for (const state of (runtime as any).states.values()) {
    if (state.lane.entryAt !== null) {
      state.lane.end(finalTime, 'BENCHMARK_END');
      (runtime as any).closedPositions.set(state.key, (runtime as any).serializeState(state, finalTime));
    }
  }

  const closedMap = (runtime as any).closedPositions as Map<string, any>;
  const allClosed = Array.from(closedMap.values());

  console.log('\n' + '='.repeat(115));
  console.log(
    `${'Strategy'.padEnd(24)} | ${'Trades'.padEnd(7)} | ${'Win'.padEnd(4)} | ${'Loss'.padEnd(5)} | ${'Win Rate'.padEnd(9)} | ${'Net PnL ($5)'.padEnd(14)} | ${'Profit Factor'.padEnd(14)} | ${'Avg Win'.padEnd(8)} | ${'Avg Loss'.padEnd(8)}`
  );
  console.log('-'.repeat(115));

  let basePnl = 0;
  let evolvedPnl = 0;

  for (const lane of LANES) {
    const lanePositions = allClosed.filter((p) => p.laneLabel === lane.label);
    const wins = lanePositions.filter((p) => (p.pnlUsd || 0) > 0);
    const losses = lanePositions.filter((p) => (p.pnlUsd || 0) <= 0);
    const wr = lanePositions.length ? (wins.length / lanePositions.length) * 100 : 0;
    const totalPnl = lanePositions.reduce((acc, p) => acc + (p.pnlUsd || 0), 0);
    const grossWin = wins.reduce((acc, p) => acc + (p.pnlUsd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((acc, p) => acc + (p.pnlUsd || 0), 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99.0 : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;

    if (lane.label.includes('Baseline')) basePnl += totalPnl;
    else evolvedPnl += totalPnl;

    const pnlStr = (totalPnl >= 0 ? '+' : '') + `$${totalPnl.toFixed(2)}`;
    console.log(
      `${lane.label.padEnd(24)} | ${String(lanePositions.length).padEnd(7)} | ${String(wins.length).padEnd(4)} | ${String(losses.length).padEnd(5)} | ${(wr.toFixed(1) + '%').padEnd(9)} | ${pnlStr.padEnd(14)} | ${(pf.toFixed(2) + 'x').padEnd(14)} | +$${avgWin.toFixed(2)} | -$${avgLoss.toFixed(2)}`
    );
  }

  console.log('='.repeat(115));
  console.log(`📊 TOTAL PnL BASELINE: ${basePnl >= 0 ? '+' : ''}$${basePnl.toFixed(2)}`);
  console.log(`🚀 TOTAL PnL EVOLVED:  ${evolvedPnl >= 0 ? '+' : ''}$${evolvedPnl.toFixed(2)} (Delta: +$${(evolvedPnl - basePnl).toFixed(2)})`);
  console.log('='.repeat(115));

  try { rmSync(SANDBOX_DIR, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error('Fatal verify replay error:', err);
  process.exit(1);
});
