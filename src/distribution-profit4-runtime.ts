import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Lane, PROFIT4_LANE, PROFIT4_RULES, PROFIT4_TARGET_PERCENT } from './distribution-profit4-lane.js';
import { DistributionBounceLane, DistributionBounceLaneV2, DistributionBounceLaneV3, DistributionBounceLaneV4, DistributionBounceLaneV5, DistributionBounceLaneV6, DistributionBounceLaneV7, BOUNCE_DUMP_LANE, BOUNCE_DUMP_LANE_V2, BOUNCE_DUMP_LANE_V3, BOUNCE_DUMP_LANE_V4, BOUNCE_DUMP_LANE_V5, BOUNCE_DUMP_LANE_V6, BOUNCE_DUMP_LANE_V7, BOUNCE_RULES, BOUNCE_RULES_V2, BOUNCE_RULES_V3, BOUNCE_RULES_V4, BOUNCE_RULES_V5, BOUNCE_RULES_V6, BOUNCE_RULES_V7, BOUNCE_TARGET_PERCENT, BOUNCE_TARGET_PERCENT_V3, BOUNCE_TARGET_PERCENT_V4, BOUNCE_TARGET_PERCENT_V5, BOUNCE_TARGET_PERCENT_V6, BOUNCE_TARGET_PERCENT_V7 } from './distribution-bounce-lane.js';
import {
  DistributionStaircaseLaneS1,
  DistributionStaircaseLaneS2,
  DistributionStaircaseLaneS3,
  DistributionStaircaseLaneS4,
  STAIRCASE_LANE_S1,
  STAIRCASE_LANE_S2,
  STAIRCASE_LANE_S3,
  STAIRCASE_LANE_S4,
  STAIRCASE_RULES_S1,
  STAIRCASE_RULES_S2,
  STAIRCASE_RULES_S3,
  STAIRCASE_RULES_S4,
  STAIRCASE_TARGET_PERCENT,
  DistributionStaircaseLaneS1_v2,
  STAIRCASE_RULES_S1_V2,
  DistributionStaircaseLaneS5,
  STAIRCASE_RULES_S5,
  STAIRCASE_LANE_S5,
} from './distribution-staircase-lane.js';
import {
  DistributionGenesisSurgeLaneG1,
  DistributionGenesisSurgeLaneG1_2,
  GENESIS_SURGE_LANE,
  GENESIS_SURGE_RULES,
  GENESIS_SURGE_RULES_G1_2,
  GENESIS_SURGE_TARGET_PERCENT,
} from './distribution-genesis-surge-lane.js';
import {
  DistributionSmartMoneyLaneG2_1,
  DistributionSmartMoneyConvergenceLaneG2_2,
  DistributionSmartMoneyConvergenceLaneG2,
  SMART_MONEY_RULES_G2_1,
  SMART_MONEY_RULES_G2_2,
  SMART_MONEY_RULES_G2,
  SMART_MONEY_LANE_G2,
  SMART_MONEY_LANE_G2_1,
  SMART_MONEY_LANE_G2_2,
} from './distribution-smart-money-lane.js';
import {
  DistributionOezankLaneOZ1,
  OEZANK_RULES_OZ1,
  OEZANK_LANE_OZ1,
  OEZANK_WALLET,
  COPY_TRADING_WALLETS,
  isCopyTradingWallet
} from './distribution-oezank-lane.js';
import {
  DistributionMomentumSafeLane,
  DistributionMomentumOptimalLane,
  DistributionMomentumWideLane,
  DistributionMomentumSwing100kLane,
  DistributionMomentumWaveLane,
  DistributionMomentumV2Lane,
  DistributionMomentumV3Lane,
  DistributionMomentumR5BandLane,
  DistributionMomentumR5BandLaneV2,
  SAFE_LANE_RULES,
  OPTIMAL_LANE_RULES,
  WIDE_LANE_RULES,
  SWING_100K_LANE_RULES,
  WAVE_LANE_RULES,
  MOMENTUM_V2_LANE_RULES,
  MOMENTUM_V3_LANE_RULES,
  R5_BAND_LANE_RULES,
  R5_BAND_LANE_RULES_V2,
} from './distribution-research-lanes.js';
import {
  DistributionMomentumScalpLane,
  DistributionMomentumTrendLane,
  DistributionMomentumGoldenLane,
  M_SCALP_RULES,
  M_TREND_RULES,
  M_GOLDEN_RULES,
  DistributionMApex10kLane,
  DistributionMSafe10kLane,
  DistributionMRunner15kLane,
  M_APEX10K_RULES,
  M_SAFE10K_RULES,
  M_RUNNER15K_RULES,
} from './distribution-evolved-momentum-lanes.js';
import {
  DistributionTrendConsLane,
  DistributionTrendBalLane,
  DistributionTrendWideLane,
  DistributionTrendRunLane,
  DistributionTrendGoldenLane,
  DistributionTrend20mLane,
  TREND_20M_CONS_RULES,
  TREND_20M_BAL_RULES,
  TREND_20M_WIDE_RULES,
  TREND_20M_RUN_RULES,
  TREND_20M_GOLDEN_RULES,
  TREND_20M_RULES,
} from './distribution-trend-20m-lane.js';
import { TargetObservation, type TargetEvent, type TargetFacts, type TargetTrade } from './distribution-target-lane.js';
import type { SwapRouteResult, DualSellSwapResult } from './browser-swap-route.js';

export type Transfer = {
  mint: string;
  wallet: string;
  symbol?: string;
  timestamp?: number;
  from?: string;
  source?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  amount?: string | number;
  costUsd?: number;
  solSpent?: number;
  tx?: string;
  syndicateWalletsCount?: number;
  syndicateTier?: string;
};

export interface SwapProbeHandlers {
  getBuyQuote?: (mint: string) => Promise<SwapRouteResult | null>;
  getSellQuotes?: (mint: string, inputTokensBaseUnits?: string, decimals?: number) => Promise<DualSellSwapResult | null>;
}

export function atomicProfit4Json(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, path);
}

type RuntimeState = {
  key: string;
  transfer: Transfer;
  observation: TargetObservation;
  lane:
    | DistributionProfit4Lane
    | DistributionBounceLane
    | DistributionBounceLaneV2
    | DistributionBounceLaneV3
    | DistributionBounceLaneV4
    | DistributionBounceLaneV5
    | DistributionBounceLaneV6
    | DistributionBounceLaneV7
    | DistributionStaircaseLaneS1
    | DistributionStaircaseLaneS2
    | DistributionStaircaseLaneS3
    | DistributionStaircaseLaneS4
    | DistributionStaircaseLaneS1_v2
    | DistributionStaircaseLaneS5
    | DistributionGenesisSurgeLaneG1
    | DistributionGenesisSurgeLaneG1_2
    | DistributionOezankLaneOZ1
    | DistributionSmartMoneyLaneG2_1
    | DistributionSmartMoneyConvergenceLaneG2_2
    | DistributionSmartMoneyConvergenceLaneG2
    | DistributionMomentumSafeLane
    | DistributionMomentumOptimalLane
    | DistributionMomentumWideLane
    | DistributionMomentumSwing100kLane
    | DistributionMomentumWaveLane
    | DistributionMomentumV2Lane
    | DistributionMomentumV3Lane
    | DistributionMomentumR5BandLane
    | DistributionMomentumR5BandLaneV2
    | DistributionMApex10kLane
    | DistributionMSafe10kLane
    | DistributionMRunner15kLane
    | DistributionMomentumScalpLane
    | DistributionMomentumTrendLane
    | DistributionMomentumGoldenLane
    | DistributionTrendGoldenLane
    | DistributionTrend20mLane;
  facts: TargetFacts | null;
  active: boolean;
  registeredAt?: number;
  laneLabel: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'S1' | 'S2' | 'S3' | 'S4' | 'S1.2' | 'S5' | 'OZ1' | 'G1' | 'G1.2' | 'G2' | 'G2.1' | 'G2.2' | 'P4' | 'Safe' | 'Opt' | 'Wide' | 'Swing' | 'Wave' | 'V2M' | 'V3M' | 'R5' | 'R5.1' | 'M-Apex10k' | 'M-Safe10k' | 'M-Runner15k' | 'M-Scalp' | 'M-Trend' | 'M-Golden' | 'Trend20m' | 'T-Cons' | 'T-Bal' | 'T-Wide' | 'T-Run' | 'T-Golden';
  version: string;
  lastDecision: unknown;
  lastEvent: TargetEvent | null;
  swapBuy?: SwapRouteResult | null;
  swapSell1?: SwapRouteResult | null;
  swapSell2?: SwapRouteResult | null;
  swapSellDeltaPct?: number | null;
  swapBuyPending?: boolean;
  swapSellPending?: boolean;
};

export class DistributionProfit4Runtime {
  private states = new Map<string, RuntimeState>();
  private readonly closedPositions = new Map<string, any>();
  private observations = new Map<string, TargetObservation>();
  private liveSignalHandler?: (signal: any) => void;
  setLiveSignalHandler(handler: (signal: any) => void) { this.liveSignalHandler = handler; }
  private lastEvaluationAt = -Infinity;
  private bought: Set<string>;
  private recentEvents: TargetEvent[] = [];
  private readonly boughtFile: string;
  private swapHandlers: SwapProbeHandlers | null = null;
  readonly laneType: 'profit4' | 'bounce' | 'momentum' | 'syndicate' | 'smartmoney' | 'trend20m';
  readonly targetPercent: number;
  readonly laneRules: typeof PROFIT4_RULES | typeof BOUNCE_RULES | typeof TREND_20M_RULES;
  readonly laneName: string;

  constructor(private readonly run: string, private readonly write: (name: string, value: unknown) => void,
    private readonly dataDirectory: string, laneType: 'profit4' | 'bounce' | 'momentum' | 'syndicate' | 'smartmoney' | 'trend20m' = 'profit4') {
    this.laneType = laneType;
    this.targetPercent = laneType === 'trend20m' ? 20.0 : (laneType === 'profit4' ? PROFIT4_TARGET_PERCENT : BOUNCE_TARGET_PERCENT);
    this.laneRules = laneType === 'trend20m' ? TREND_20M_RULES : (laneType === 'profit4' ? PROFIT4_RULES : BOUNCE_RULES);
    this.laneName = laneType === 'profit4' ? PROFIT4_LANE : (laneType === 'bounce' ? BOUNCE_DUMP_LANE : laneType);
    this.boughtFile = join(dataDirectory, 'bought-mints.json');
    const saved = existsSync(this.boughtFile) ? JSON.parse(readFileSync(this.boughtFile, 'utf8')) : { mints: [] };
    if (!Array.isArray(saved.mints) || saved.mints.some((s: unknown) => typeof s !== 'string')) throw new Error('Ledger bought-mints tidak valid.');
    this.bought = new Set(saved.mints);

    // Preload closed/entered positions from existing state or chunks if present
    const stateFile = join(this.run, 'profit4-state.json');
    if (existsSync(stateFile)) {
      try {
        const existing = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (Array.isArray(existing?.positions)) {
          for (const p of existing.positions) {
            if (p.entryAt !== null) {
              const k = `${p.mint}:${(p.laneLabel || p.lane || 'v1').toLowerCase()}`;
              this.closedPositions.set(k, p);
            }
          }
        }
      } catch {}
    }
    const chunksDir = join(this.run, 'chunks');
    if (existsSync(chunksDir)) {
      try {
        const chunkEntries = readdirSync(chunksDir);
        const buys = new Map<string, any>();
        const sells = new Map<string, any>();
        for (const c of chunkEntries) {
          const evFile = join(chunksDir, c, 'profit4-events.jsonl');
          if (!existsSync(evFile)) continue;
          const lines = readFileSync(evFile, 'utf8').split('\n').filter(l => l.trim());
          for (const l of lines) {
            try {
              const ev = JSON.parse(l);
              const k = `${ev.mint}:${(ev.laneLabel || 'v1').toLowerCase()}`;
              if (ev.type === 'PAPER_BUY') buys.set(k, ev);
              else if (ev.type === 'PAPER_SELL') sells.set(k, ev);
            } catch {}
          }
        }
        for (const [k, buy] of buys.entries()) {
          const sell = sells.get(k);
          if (!this.closedPositions.has(k)) {
            this.closedPositions.set(k, {
              ...(buy.transfer || {}),
              mint: buy.mint,
              captureActive: !sell,
              laneLabel: buy.laneLabel,
              phase: sell ? 'CLOSED' : 'OPEN',
              version: buy.version,
              targetPercent: buy.targetPercent,
              entryAt: buy.observedAt,
              entryPrice: buy.priceUsd,
              exitAt: sell?.observedAt || null,
              exitPrice: sell?.priceUsd || null,
              netReturnPercent: sell?.netReturnPercent ?? null,
              pnlUsd: sell?.pnlUsd ?? null,
              estimatedOpenNetPercent: null,
              lastDecision: null,
              lastEvent: sell ? { type: 'PAPER_SELL', observedAt: sell.observedAt, reason: sell.reason } : { type: 'PAPER_BUY', observedAt: buy.observedAt },
              facts: null,
            });
          }
        }
      } catch {}
    }

    const getDualLanes = (type: string) => {
      if (type === 'momentum') return ['M-Scalp', 'M-Trend', 'M-Golden'];
      if (type === 'syndicate') return ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'S1', 'S2', 'S3', 'S4', 'S1.2', 'S5'];
      if (type === 'smartmoney') return ['G2', 'G2.1', 'G2.2', 'OZ1'];
      if (type === 'bounce') return ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'S1', 'S2', 'S3', 'S4', 'G1', 'Safe', 'Opt', 'Wide', 'Swing', 'Wave', 'V2M', 'V3M', 'R5', 'R5.1', 'M-Apex10k', 'M-Safe10k', 'M-Runner15k'];
      if (type === 'trend20m') return ['T-Cons', 'T-Bal', 'T-Wide', 'T-Run', 'T-Golden'];
      return ['P4'];
    };

    this.write('profit4-events.jsonl', { type: 'PAPER_LANE_READY', observedAt: Date.now(), paperLane: this.laneName,
      rules: this.laneRules, targetPercent: this.targetPercent, execution: 'PAPER_QUOTE', rounds: 1, dualLanes: getDualLanes(this.laneType) });
    this.persist(Date.now());
  }

  setSwapProbeHandlers(handlers: SwapProbeHandlers) {
    this.swapHandlers = handlers;
  }

  private triggerSwapBuy(mint: string) {
    const statesForMint = [...this.states.values()].filter(s => s.transfer.mint === mint);
    if (!statesForMint.length || statesForMint.some(s => s.swapBuyPending) || statesForMint.some(s => s.swapBuy) || !this.swapHandlers?.getBuyQuote) return;
    statesForMint.forEach(s => { s.swapBuyPending = true; });
    this.swapHandlers.getBuyQuote(mint).then(quote => {
      statesForMint.forEach(s => {
        s.swapBuyPending = false;
        if (quote) s.swapBuy = quote;
      });
      if (quote) {
        this.write('profit4-events.jsonl', {
          type: 'SWAP_BUY_QUOTE',
          mint,
          observedAt: Date.now(),
          transfer: statesForMint[0].transfer,
          quote: quote.quote,
          impliedPriceUsd: quote.impliedPriceUsd,
          latencyMs: quote.latencyMs,
          status: quote.status,
          ok: quote.ok,
          error: quote.error,
        });
        this.persist(Date.now());
      }
    }).catch(() => { statesForMint.forEach(s => { s.swapBuyPending = false; }); });
  }

  private triggerSwapSell(key: string) {
    const state = this.states.get(key);
    if (!state || state.swapSellPending || state.swapSell1 || !this.swapHandlers?.getSellQuotes) return;
    state.swapSellPending = true;
    const outAmount = state.swapBuy?.quote?.outAmount;
    let tokenUnits = outAmount;
    if (!tokenUnits && state.lane.entryPrice && state.lane.entryPrice > 0) {
      const r = this.laneRules;
      const tokens = (r.stakeUsd * (1 - r.feePercentPerSide / 100) - r.fixedFeeUsdPerSide) / (state.lane.entryPrice * (1 + r.slippagePercentPerSide / 100));
      tokenUnits = Math.floor(tokens * 1_000_000).toString();
    }
    tokenUnits = tokenUnits || '1000000000';
    const decimals = state.swapBuy?.quote?.outDecimals ?? 6;

    this.swapHandlers.getSellQuotes(state.transfer.mint, tokenUnits, decimals).then(dual => {
      state.swapSellPending = false;
      if (dual) {
        state.swapSell1 = dual.quote1;
        state.swapSell2 = dual.quote2;
        state.swapSellDeltaPct = dual.priceDeltaPct;
        this.write('profit4-events.jsonl', {
          type: 'SWAP_SELL_QUOTES',
          mint: state.transfer.mint,
          laneLabel: state.laneLabel,
          observedAt: Date.now(),
          transfer: state.transfer,
          quote1: dual.quote1.quote,
          impliedPriceUsd1: dual.quote1.impliedPriceUsd,
          latencyMs1: dual.quote1.latencyMs,
          quote2: dual.quote2.quote,
          impliedPriceUsd2: dual.quote2.impliedPriceUsd,
          latencyMs2: dual.quote2.latencyMs,
          priceDeltaPct: dual.priceDeltaPct,
        });
        this.persist(Date.now());
      }
    }).catch(() => { state.swapSellPending = false; });
  }

  register(transfer: Transfer, now: number) {
    let observation = this.observations.get(transfer.mint);
    if (!observation) {
      observation = new TargetObservation((transfer.timestamp ?? now / 1000) * 1000);
      this.observations.set(transfer.mint, observation);
    }

    const makeOnEvent = (laneKey: string, laneLabel: RuntimeState['laneLabel']) => (event: TargetEvent) => {
      const state = this.states.get(laneKey);
      if (state) {
        state.lastEvent = event;
        if (event.type === 'PAPER_ENTRY_DECISION') state.lastDecision = { allowed: event.allowed, reasons: event.reasons, observedAt: event.observedAt };
      }
      if (event.type === 'PAPER_ENTRY_SIGNAL') {
        this.triggerSwapBuy(transfer.mint);
      }
      if (event.type === 'PAPER_BUY') {
        this.bought.add(this.laneType !== 'profit4' ? `${transfer.mint}:${laneLabel.toLowerCase()}` : transfer.mint);
        atomicProfit4Json(this.boughtFile, { updatedAt: event.observedAt, mints: [...this.bought] });
        this.triggerSwapBuy(transfer.mint);
      }
      if (event.type === 'PAPER_EXIT_SIGNAL' || event.type === 'PAPER_SELL') {
        this.triggerSwapSell(laneKey);
      }
      const { facts: _facts, ...small } = event;
      const record = {
        ...small,
        transfer,
        laneLabel,
        ...(state?.swapBuy?.impliedPriceUsd ? { swapBuyPrice: state.swapBuy.impliedPriceUsd } : {}),
        ...(state?.swapSell2?.impliedPriceUsd ? { swapSellPrice2: state.swapSell2.impliedPriceUsd } : {}),
      };
      this.recentEvents.push(record); if (this.recentEvents.length > 60) this.recentEvents.shift();
      this.write('profit4-events.jsonl', record);
      this.liveSignalHandler?.({ ...record, rules: state ? { ...state.lane.rules } : null });
    };

    if (this.laneType !== 'profit4') {
      const source = transfer.source || (
        transfer.wallet === 'creator' || transfer.wallet === 'gmgn_research' ? 'gmgn_research_ws' : 'syndicate_inflow'
      );
      const invalidTime = !Number.isFinite(transfer.timestamp) || !transfer.timestamp || transfer.timestamp * 1000 > now + 2000;

      // ==========================================
      // PIPELINE 1: SYNDICAT WALLETS (Bounce & Staircase)
      // ==========================================
      if (source === 'syndicate_inflow' && (this.laneType === 'bounce' || this.laneType === 'syndicate')) {
        const isAlreadyTracked = Array.from(this.states.keys()).some(k => k.startsWith(`${transfer.mint}:`)) ||
          Array.from(this.closedPositions.keys()).some(k => k.startsWith(`${transfer.mint}:`));
        if (isAlreadyTracked) {
          if (transfer.syndicateWalletsCount) {
            const s5State = this.states.get(`${transfer.mint}:s5`);
            if (s5State) {
              (s5State.lane as any).updateAirdropMeta?.(transfer.syndicateWalletsCount, transfer.syndicateTier);
            }
          }
          return;
        }

        const keyV1 = `${transfer.mint}:v1`;
        const keyV2 = `${transfer.mint}:v2`;
        const keyV3 = `${transfer.mint}:v3`;
        const keyV4 = `${transfer.mint}:v4`;
        const keyV5 = `${transfer.mint}:v5`;
        const keyV6 = `${transfer.mint}:v6`;
        const keyV7 = `${transfer.mint}:v7`;
        const keyS1 = `${transfer.mint}:s1`;
        const keyS2 = `${transfer.mint}:s2`;
        const keyS3 = `${transfer.mint}:s3`;
        const keyS4 = `${transfer.mint}:s4`;
        const keyS1_2 = `${transfer.mint}:s1_2`;
        const keyS5 = `${transfer.mint}:s5`;

        const laneV1 = new DistributionBounceLane(transfer.mint, makeOnEvent(keyV1, 'V1'));
        const laneV2 = new DistributionBounceLaneV2(transfer.mint, makeOnEvent(keyV2, 'V2'));
        const laneV3 = new DistributionBounceLaneV3(transfer.mint, makeOnEvent(keyV3, 'V3'));
        const laneV4 = new DistributionBounceLaneV4(transfer.mint, makeOnEvent(keyV4, 'V4'));
        const laneV5 = new DistributionBounceLaneV5(transfer.mint, makeOnEvent(keyV5, 'V5'));
        const laneV6 = new DistributionBounceLaneV6(transfer.mint, makeOnEvent(keyV6, 'V6'));
        const laneV7 = new DistributionBounceLaneV7(transfer.mint, makeOnEvent(keyV7, 'V7'));
        const laneS1 = new DistributionStaircaseLaneS1(transfer.mint, makeOnEvent(keyS1, 'S1'));
        const laneS2 = new DistributionStaircaseLaneS2(transfer.mint, makeOnEvent(keyS2, 'S2'));
        const laneS3 = new DistributionStaircaseLaneS3(transfer.mint, makeOnEvent(keyS3, 'S3'));
        const laneS4 = new DistributionStaircaseLaneS4(transfer.mint, makeOnEvent(keyS4, 'S4'));
        const laneS1_2 = new DistributionStaircaseLaneS1_v2(transfer.mint, makeOnEvent(keyS1_2, 'S1.2'));
        const laneS5 = new DistributionStaircaseLaneS5(transfer.mint, makeOnEvent(keyS5, 'S5'), {
          walletsCount: transfer.syndicateWalletsCount,
          tier: transfer.syndicateTier
        });

        const transferMs = (transfer.timestamp ? transfer.timestamp * 1000 : now);
        const recentTrades = observation.trades.filter((t) => (t.timestamp ? t.timestamp * 1000 : t.at) >= transferMs - 30000);

        laneS1.setInitialTrades(recentTrades);
        laneS2.setInitialTrades(recentTrades);
        laneS3.setInitialTrades(recentTrades);
        laneS4.setInitialTrades(recentTrades);
        laneS1_2.setInitialTrades(recentTrades);
        laneS5.setInitialTrades(recentTrades);

        const setLaneState = (key: string, label: string, version: string, lane: any) => {
          if (this.closedPositions.has(key)) return;
          const existing = this.states.get(key);
          if (existing && existing.lane.entryAt !== null) return;
          this.states.set(key, { key, transfer, observation, lane, facts: null, active: true, registeredAt: now, laneLabel: label, version, lastDecision: null, lastEvent: null });
        };

        setLaneState(keyV1, 'V1', BOUNCE_RULES.version, laneV1);
        setLaneState(keyV2, 'V2', BOUNCE_RULES_V2.version, laneV2);
        setLaneState(keyV3, 'V3', BOUNCE_RULES_V3.version, laneV3);
        setLaneState(keyV4, 'V4', BOUNCE_RULES_V4.version, laneV4);
        setLaneState(keyV5, 'V5', BOUNCE_RULES_V5.version, laneV5);
        setLaneState(keyV6, 'V6', BOUNCE_RULES_V6.version, laneV6);
        setLaneState(keyV7, 'V7', BOUNCE_RULES_V7.version, laneV7);
        setLaneState(keyS1, 'S1', STAIRCASE_RULES_S1.version, laneS1);
        setLaneState(keyS2, 'S2', STAIRCASE_RULES_S2.version, laneS2);
        setLaneState(keyS3, 'S3', STAIRCASE_RULES_S3.version, laneS3);
        setLaneState(keyS4, 'S4', STAIRCASE_RULES_S4.version, laneS4);
        setLaneState(keyS1_2, 'S1.2', STAIRCASE_RULES_S1_V2.version, laneS1_2);
        setLaneState(keyS5, 'S5', STAIRCASE_RULES_S5.version, laneS5);

        if (this.bought.has(`${transfer.mint}:v1`)) { if (!this.closedPositions.has(keyV1)) laneV1.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v2`)) { if (!this.closedPositions.has(keyV2)) laneV2.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v3`)) { if (!this.closedPositions.has(keyV3)) laneV3.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV3.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v4`)) { if (!this.closedPositions.has(keyV4)) laneV4.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV4.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v5`)) { if (!this.closedPositions.has(keyV5)) laneV5.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV5.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v6`)) { if (!this.closedPositions.has(keyV6)) laneV6.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV6.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v7`)) { if (!this.closedPositions.has(keyV7)) laneV7.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneV7.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s1`)) { if (!this.closedPositions.has(keyS1)) laneS1.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneS1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s2`)) { if (!this.closedPositions.has(keyS2)) laneS2.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneS2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s3`)) { if (!this.closedPositions.has(keyS3)) laneS3.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneS3.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s4`)) { if (!this.closedPositions.has(keyS4)) laneS4.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneS4.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s1_2`)) { if (!this.closedPositions.has(keyS1_2)) laneS1_2.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneS1_2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s5`)) { if (!this.closedPositions.has(keyS5)) laneS5.end(now, 'ONE_ROUND_ALREADY_ENTERED'); }
        else if (invalidTime) laneS5.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
      }

      // ==========================================
      // PIPELINE 2: GMGN RESEARCH NEW PAIR (Momentum Lanes)
      // ==========================================
      else if ((source === 'gmgn_research_ws' || source === 'new_pair') && this.laneType === 'momentum') {
        const mcap = transfer.marketCapUsd ?? (transfer.priceUsd ? transfer.priceUsd * 1_000_000_000 : null);
        if (!mcap || mcap < 10000 || mcap > 100000) return;

        const keyScalp = `${transfer.mint}:mscalp`;
        if (this.states.has(keyScalp)) return;

        const keyTrend = `${transfer.mint}:mtrend`;
        const keyGolden = `${transfer.mint}:mgolden`;

        const laneScalp = new DistributionMomentumScalpLane(transfer.mint, makeOnEvent(keyScalp, 'M-Scalp'));
        const laneTrend = new DistributionMomentumTrendLane(transfer.mint, makeOnEvent(keyTrend, 'M-Trend'));
        const laneGolden = new DistributionMomentumGoldenLane(transfer.mint, makeOnEvent(keyGolden, 'M-Golden'));

        this.states.set(keyScalp, { key: keyScalp, transfer, observation, lane: laneScalp, facts: null, active: true, registeredAt: now, laneLabel: 'M-Scalp', version: M_SCALP_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyTrend, { key: keyTrend, transfer, observation, lane: laneTrend, facts: null, active: true, registeredAt: now, laneLabel: 'M-Trend', version: M_TREND_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyGolden, { key: keyGolden, transfer, observation, lane: laneGolden, facts: null, active: true, registeredAt: now, laneLabel: 'M-Golden', version: M_GOLDEN_RULES.version, lastDecision: null, lastEvent: null });

        if (this.bought.has(`${transfer.mint}:mscalp`)) laneScalp.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneScalp.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:mtrend`)) laneTrend.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneTrend.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:mgolden`)) laneGolden.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneGolden.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
      }

      // ==========================================
      // PIPELINE 3: SMART MONEY INFLOW (G2.1 Single Whale & G2.2 Multi-Whale Convergence)
      // ==========================================
      else if ((source === 'smart_money_inflow' || source === 'oezank_inflow') && (this.laneType === 'bounce' || this.laneType === 'smartmoney')) {
        const keyG2 = `${transfer.mint}:g2`;
        const numAmount = typeof transfer.amount === 'string' ? parseFloat(transfer.amount) : (transfer.amount ?? 0);
        const costUsd = transfer.costUsd ?? (numAmount > 0 && transfer.priceUsd ? numAmount * transfer.priceUsd : 50);
        if (this.states.has(keyG2)) {
          (this.states.get(keyG2)?.lane as any)?.registerSmartWallet?.(transfer.wallet, costUsd);
          (this.states.get(`${transfer.mint}:g2_1`)?.lane as any)?.registerSmartWallet?.(transfer.wallet, costUsd);
          (this.states.get(`${transfer.mint}:g2_2`)?.lane as any)?.registerSmartWallet?.(transfer.wallet, costUsd);
        } else {
          const keyG2_1 = `${transfer.mint}:g2_1`;
          const keyG2_2 = `${transfer.mint}:g2_2`;

          const laneG2_1 = new DistributionSmartMoneyLaneG2_1(transfer.mint, makeOnEvent(keyG2_1, 'G2.1'));
          const laneG2_2 = new DistributionSmartMoneyConvergenceLaneG2_2(transfer.mint, makeOnEvent(keyG2_2, 'G2.2'));
          const laneG2 = new DistributionSmartMoneyConvergenceLaneG2(transfer.mint, makeOnEvent(keyG2, 'G2'));

          laneG2_1.registerSmartWallet(transfer.wallet, costUsd);
          laneG2_2.registerSmartWallet(transfer.wallet, costUsd);
          laneG2.registerSmartWallet(transfer.wallet, costUsd);

          const transferMs = (transfer.timestamp ? transfer.timestamp * 1000 : now);
          const recentTrades = observation.trades.filter((t) => (t.timestamp ? t.timestamp * 1000 : t.at) >= transferMs - 60000);

          laneG2_1.setInitialTrades(recentTrades);
          laneG2_2.setInitialTrades(recentTrades);
          laneG2.setInitialTrades(recentTrades);

          this.states.set(keyG2_1, { key: keyG2_1, transfer, observation, lane: laneG2_1, facts: null, active: true, registeredAt: now, laneLabel: 'G2.1', version: SMART_MONEY_RULES_G2_1.version, lastDecision: null, lastEvent: null });
          this.states.set(keyG2_2, { key: keyG2_2, transfer, observation, lane: laneG2_2, facts: null, active: true, registeredAt: now, laneLabel: 'G2.2', version: SMART_MONEY_RULES_G2_2.version, lastDecision: null, lastEvent: null });
          this.states.set(keyG2, { key: keyG2, transfer, observation, lane: laneG2, facts: null, active: true, registeredAt: now, laneLabel: 'G2', version: SMART_MONEY_RULES_G2.version, lastDecision: null, lastEvent: null });

          if (this.bought.has(`${transfer.mint}:g2_1`)) laneG2_1.end(now, 'ONE_ROUND_ALREADY_ENTERED');
          else if (invalidTime) laneG2_1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
          if (this.bought.has(`${transfer.mint}:g2_2`)) laneG2_2.end(now, 'ONE_ROUND_ALREADY_ENTERED');
          else if (invalidTime) laneG2_2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
          if (this.bought.has(`${transfer.mint}:g2`)) laneG2.end(now, 'ONE_ROUND_ALREADY_ENTERED');
          else if (invalidTime) laneG2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        }

        // COPY TRADING / OEZANK MIRROR INFLOW (Lane OZ1)
        if (source === 'oezank_inflow' || isCopyTradingWallet(transfer.wallet)) {
          const keyOZ1 = `${transfer.mint}:oz1`;
          if (!this.states.has(keyOZ1)) {
            const laneOZ1 = new DistributionOezankLaneOZ1(transfer.mint, makeOnEvent(keyOZ1, 'OZ1'));
            const transferMs = (transfer.timestamp ? transfer.timestamp * 1000 : now);
            const recentTrades = observation.trades.filter((t) => (t.timestamp ? t.timestamp * 1000 : t.at) >= transferMs - 30000);
            laneOZ1.setInitialTrades(recentTrades);

            this.states.set(keyOZ1, {
              key: keyOZ1,
              transfer,
              observation,
              lane: laneOZ1,
              facts: null,
              active: true,
              registeredAt: now,
              laneLabel: 'OZ1',
              version: OEZANK_RULES_OZ1.version,
              lastDecision: null,
              lastEvent: null
            });

            if (this.bought.has(keyOZ1)) laneOZ1.end(now, 'ONE_ROUND_ALREADY_ENTERED');
            else if (invalidTime) laneOZ1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
          }
        }
      }

      // ==========================================
      // PIPELINE 5: GMGN TREND 20M (4 Lanes: T-Cons, T-Bal, T-Wide, T-Run)
      // ==========================================
      else if (source === 'gmgn_trend_ws' || this.laneType === 'trend20m') {
        const mcap = transfer.marketCapUsd ?? (transfer.priceUsd ? transfer.priceUsd * 1_000_000_000 : null);
        if (!mcap || mcap < 10000) return;

        const keyCons = `${transfer.mint}:t_cons`;
        if (this.states.has(keyCons)) return;

        const keyBal = `${transfer.mint}:t_bal`;
        const keyWide = `${transfer.mint}:t_wide`;
        const keyRun = `${transfer.mint}:t_run`;
        const keyGolden = `${transfer.mint}:t_golden`;

        const laneCons = new DistributionTrendConsLane(transfer.mint, makeOnEvent(keyCons, 'T-Cons'));
        const laneBal = new DistributionTrendBalLane(transfer.mint, makeOnEvent(keyBal, 'T-Bal'));
        const laneWide = new DistributionTrendWideLane(transfer.mint, makeOnEvent(keyWide, 'T-Wide'));
        const laneRun = new DistributionTrendRunLane(transfer.mint, makeOnEvent(keyRun, 'T-Run'));
        const laneGolden = new DistributionTrendGoldenLane(transfer.mint, makeOnEvent(keyGolden, 'T-Golden'));

        this.states.set(keyCons, {
          key: keyCons,
          transfer,
          observation,
          lane: laneCons,
          facts: null,
          active: true,
          registeredAt: now,
          laneLabel: 'T-Cons',
          version: TREND_20M_CONS_RULES.version,
          lastDecision: null,
          lastEvent: null,
        });

        this.states.set(keyBal, {
          key: keyBal,
          transfer,
          observation,
          lane: laneBal,
          facts: null,
          active: true,
          registeredAt: now,
          laneLabel: 'T-Bal',
          version: TREND_20M_BAL_RULES.version,
          lastDecision: null,
          lastEvent: null,
        });

        this.states.set(keyWide, {
          key: keyWide,
          transfer,
          observation,
          lane: laneWide,
          facts: null,
          active: true,
          registeredAt: now,
          laneLabel: 'T-Wide',
          version: TREND_20M_WIDE_RULES.version,
          lastDecision: null,
          lastEvent: null,
        });

        this.states.set(keyRun, {
          key: keyRun,
          transfer,
          observation,
          lane: laneRun,
          facts: null,
          active: true,
          registeredAt: now,
          laneLabel: 'T-Run',
          version: TREND_20M_RUN_RULES.version,
          lastDecision: null,
          lastEvent: null,
        });

        this.states.set(keyGolden, {
          key: keyGolden,
          transfer,
          observation,
          lane: laneGolden,
          facts: null,
          active: true,
          registeredAt: now,
          laneLabel: 'T-Golden',
          version: TREND_20M_GOLDEN_RULES.version,
          lastDecision: null,
          lastEvent: null,
        });

        if (this.bought.has(keyCons)) laneCons.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneCons.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');

        if (this.bought.has(keyBal)) laneBal.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneBal.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');

        if (this.bought.has(keyWide)) laneWide.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneWide.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');

        if (this.bought.has(keyRun)) laneRun.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneRun.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');

        if (this.bought.has(keyGolden)) laneGolden.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneGolden.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
      }
    } else {
      const key = transfer.mint;
      const lane = new DistributionProfit4Lane(transfer.mint, makeOnEvent(key, 'P4'));
      this.states.set(key, { key, transfer, observation, lane, facts: null, active: true, registeredAt: now, laneLabel: 'P4', version: PROFIT4_RULES.version, lastDecision: null, lastEvent: null });
      if (this.bought.has(transfer.mint)) lane.end(now, 'ONE_ROUND_ALREADY_ENTERED');
      else if (!Number.isFinite(transfer.timestamp) || !transfer.timestamp || transfer.timestamp * 1000 > now + 2000) lane.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
    }
    this.persist(now);
  }

  trade(mint: string, trade: TargetTrade) {
    this.observations.get(mint)?.trade(trade);
    for (const state of this.states.values()) {
      if (state.transfer.mint === mint && state.active) {
        (state.lane as any).onTrade?.(trade);
      }
    }
  }
  holderFrame(mint: string, body: unknown, at: number) {
    const obs = this.observations.get(mint), frame = body as { channel?: string; data?: any[] } | null;
    if (!obs || !Array.isArray(frame?.data)) return;
    for (const row of frame.data) {
      if ((row.ta ?? row.token_address ?? row.a ?? mint) !== mint) continue;
      if (frame.channel === 'token_general_stat_num' && row.t === 'holder_count' && Number.isFinite(Number(row.v))) {
        obs.count({ at, count: Number(row.v) });
      } else if (frame.channel === 'token_holding' || frame.channel === 'token_tag_holding') {
        for (const holder of row.h ?? []) if (holder.wa && Number.isFinite(Number(holder.b))) {
          obs.holding(holder.wa, { at, amount: Number(holder.b), sells: Number.isFinite(holder.ts) ? holder.ts : null });
        }
      }
    }
  }

  evaluate(now: number) {
    if (now - this.lastEvaluationAt < 1000) return;
    this.lastEvaluationAt = now;
    for (const state of this.states.values()) {
      if (!state.active) continue;
      const facts = state.observation.facts(now, [], state.transfer.from); state.facts = facts;
      const waitStart = state.registeredAt ?? facts.firstAt;
      if (state.lane.entryAt === null && waitStart !== null && now - waitStart > state.lane.rules.maxEntryWaitSeconds * 1000) {
        state.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
        state.active = false;
        this.states.delete(state.key);
      } else {
        state.lane.step(facts);
        if (state.lane.phase === 'CLOSED' || state.lane.phase === 'CENSORED') {
          state.active = false;
          if (state.lane.entryAt !== null) {
            this.closedPositions.set(state.key, this.serializeState(state, now));
          } else {
            this.states.delete(state.key);
          }
        } else if (state.lane.phase === 'ENTRY_PENDING') {
          this.triggerSwapBuy(state.transfer.mint);
        } else if (state.lane.phase === 'EXIT_PENDING') {
          this.triggerSwapSell(state.key);
        }
      }
    }
    this.persist(now);
  }

  isMintActive(mint: string): boolean {
    for (const state of this.states.values()) {
      if (
        state.transfer.mint === mint &&
        state.active &&
        state.lane.phase !== 'CLOSED' &&
        state.lane.phase !== 'CENSORED'
      ) {
        return true;
      }
    }
    return false;
  }

  onTrackedWalletSold(mint: string, wallet: string, now: number) {
    for (const state of this.states.values()) {
      if (state.transfer.mint === mint && state.active) {
        const laneLabel = state.laneLabel || '';
        // 1. STAIRCASE LANES: S1, S2, S3, S4, S1.2 -> Abort entry or emergency exit!
        if (laneLabel.startsWith('S')) {
          if (state.lane.entryAt === null) {
            // Abort entry immediately: do NOT buy because syndicate wallet is dumping!
            state.lane.end(now, 'TRACKED_WALLET_SOLD_ABORT_ENTRY');
            state.active = false;
            this.states.delete(state.key);
          } else {
            // Already holding position: Emergency exit on syndicate dump
            state.lane.end(now, 'TRACKED_WALLET_SOLD_EMERGENCY_EXIT');
            state.active = false;
          }
        }
        // 2. BOUNCE LANES: V1 - V7 -> Inform that syndicate selling has begun
        else if (laneLabel.startsWith('V')) {
          (state.lane as any).onSyndicateSell?.(wallet, now);
        }
        // 3. COPY TRADING / OEZANK TRADER MIRROR: If tracked copy trader wallet sold, mirror exit immediately!
        else if (laneLabel === 'OZ1' && (wallet === state.transfer.wallet || isCopyTradingWallet(wallet))) {
          (state.lane as any).onOezankSold?.(now);
          state.active = false;
        }
      }
    }
    this.persist(now);
  }

  end(mint: string, now: number, reason: string) {
    for (const state of this.states.values()) {
      if (state.transfer.mint === mint && state.active) {
        state.lane.end(now, reason);
        state.active = false;
      }
    }
    this.persist(now);
  }

  shutdown(now: number) {
    for (const state of this.states.values()) {
      if (state.active) {
        state.lane.end(now, 'WORKER_STOPPED');
        state.active = false;
      }
    }
    this.persist(now);
  }

  private serializeState(s: RuntimeState, now: number): any {
    return {
      ...s.transfer,
      captureActive: s.active,
      laneLabel: s.laneLabel,
      phase: s.lane.phase,
      version: s.lane.rules.version,
      targetPercent: this.targetPercent,
      entryAt: s.lane.entryAt,
      entryPrice: s.lane.entryPrice,
      exitAt: s.lane.exitAt,
      exitPrice: s.lane.exitPrice,
      netReturnPercent: s.lane.netReturnPercent,
      pnlUsd: s.lane.netReturnPercent === null ? null : (s.lane.netReturnPercent / 100) * s.lane.rules.stakeUsd,
      estimatedOpenNetPercent:
        s.lane.entryAt !== null && s.lane.exitAt === null && s.active && s.facts?.price !== null && s.facts?.price !== undefined
          ? s.lane.net(s.facts.price)
          : null,
      lastDecision: s.lastDecision,
      lastEvent: s.lastEvent
        ? { type: s.lastEvent.type, observedAt: s.lastEvent.observedAt, reason: s.lastEvent.reason, reasons: s.lastEvent.reasons }
        : null,
      facts: s.facts,
      swapBuyPrice: s.swapBuy?.impliedPriceUsd ?? null,
      swapBuyOk: s.swapBuy?.ok ?? null,
      swapBuyError: s.swapBuy?.error ?? null,
      swapBuySpreadPct:
        s.swapBuy?.impliedPriceUsd && s.lane.entryPrice
          ? ((s.swapBuy.impliedPriceUsd - s.lane.entryPrice) / s.lane.entryPrice) * 100
          : null,
      swapBuyLatencyMs: s.swapBuy?.latencyMs ?? null,
      swapSellPrice1: s.swapSell1?.impliedPriceUsd ?? null,
      swapSellPrice2: s.swapSell2?.impliedPriceUsd ?? null,
      swapSellOk1: s.swapSell1?.ok ?? null,
      swapSellOk2: s.swapSell2?.ok ?? null,
      swapSellDeltaPct: s.swapSellDeltaPct ?? null,
      swapSellSpreadPct:
        s.swapSell2?.impliedPriceUsd && s.lane.exitPrice
          ? ((s.swapSell2.impliedPriceUsd - s.lane.exitPrice) / s.lane.exitPrice) * 100
          : null,
      swapSellLatencyMs: (s.swapSell1?.latencyMs ?? 0) + (s.swapSell2?.latencyMs ?? 0),
    };
  }

  private persist(now: number) {
    const relevantStates = [...this.states.values()].filter(s => s.lane.entryAt !== null || s.active);
    const combinedPositions = new Map<string, any>();
    for (const [k, p] of this.closedPositions.entries()) {
      combinedPositions.set(k, p);
    }
    for (const s of relevantStates) {
      combinedPositions.set(s.key, this.serializeState(s, now));
    }
    const positions = Array.from(combinedPositions.values());

    atomicProfit4Json(join(this.run, 'profit4-state.json'), {
      observedAt: now,
      paperLane: this.laneName,
      rounds: 1,
      execution: 'PAPER_QUOTE',
      status: 'EXPERIMENTAL',
      targetPercent: this.targetPercent,
      rules: this.laneRules,
      recentEvents: this.recentEvents,
      positions,
    });
  }
}
