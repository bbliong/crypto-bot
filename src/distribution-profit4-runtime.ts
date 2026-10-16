import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  OEZANK_WALLET
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
    | DistributionMomentumR5BandLaneV2;
  facts: TargetFacts | null;
  active: boolean;
  registeredAt?: number;
  laneLabel: 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'S1' | 'S2' | 'S3' | 'S4' | 'S1.2' | 'S5' | 'OZ1' | 'G1' | 'G1.2' | 'G2' | 'G2.1' | 'G2.2' | 'P4' | 'Safe' | 'Opt' | 'Wide' | 'Swing' | 'Wave' | 'V2M' | 'V3M' | 'R5' | 'R5.1';
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
  private observations = new Map<string, TargetObservation>();
  private liveSignalHandler?: (signal: any) => void;
  setLiveSignalHandler(handler: (signal: any) => void) { this.liveSignalHandler = handler; }
  private lastEvaluationAt = -Infinity;
  private bought: Set<string>;
  private recentEvents: TargetEvent[] = [];
  private readonly boughtFile: string;
  private swapHandlers: SwapProbeHandlers | null = null;
  readonly laneType: 'profit4' | 'bounce';
  readonly targetPercent: number;
  readonly laneRules: typeof PROFIT4_RULES | typeof BOUNCE_RULES;
  readonly laneName: string;

  constructor(private readonly run: string, private readonly write: (name: string, value: unknown) => void,
    private readonly dataDirectory: string, laneType: 'profit4' | 'bounce' = 'profit4') {
    this.laneType = laneType;
    this.targetPercent = laneType === 'bounce' ? BOUNCE_TARGET_PERCENT : PROFIT4_TARGET_PERCENT;
    this.laneRules = laneType === 'bounce' ? BOUNCE_RULES : PROFIT4_RULES;
    this.laneName = laneType === 'bounce' ? BOUNCE_DUMP_LANE : PROFIT4_LANE;
    this.boughtFile = join(dataDirectory, 'bought-mints.json');
    const saved = existsSync(this.boughtFile) ? JSON.parse(readFileSync(this.boughtFile, 'utf8')) : { mints: [] };
    if (!Array.isArray(saved.mints) || saved.mints.some((s: unknown) => typeof s !== 'string')) throw new Error('Ledger bought-mints tidak valid.');
    this.bought = new Set(saved.mints);
    this.write('profit4-events.jsonl', { type: 'PAPER_LANE_READY', observedAt: Date.now(), paperLane: this.laneName,
      rules: this.laneRules, targetPercent: this.targetPercent, execution: 'PAPER_QUOTE', rounds: 1, dualLanes: laneType === 'bounce' ? ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'S1', 'S2', 'S3', 'S4', 'G1', 'Safe', 'Opt', 'Wide', 'Swing', 'Wave', 'V2M', 'V3M', 'R5'] : ['P4'] });
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
        this.bought.add(this.laneType === 'bounce' ? `${transfer.mint}:${laneLabel.toLowerCase()}` : transfer.mint);
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

    if (this.laneType === 'bounce') {
      const source = transfer.source || (
        transfer.wallet === 'creator' || transfer.wallet === 'gmgn_research' ? 'gmgn_research_ws' : 'syndicate_inflow'
      );
      const invalidTime = !Number.isFinite(transfer.timestamp) || !transfer.timestamp || transfer.timestamp * 1000 > now + 2000;

      // ==========================================
      // PIPELINE 1: SYNDICAT WALLETS (Bounce & Staircase)
      // ==========================================
      if (source === 'syndicate_inflow') {
        const keyV1 = `${transfer.mint}:v1`;
        if (this.states.has(keyV1)) {
          if (transfer.syndicateWalletsCount) {
            const s5State = this.states.get(`${transfer.mint}:s5`);
            if (s5State) {
              (s5State.lane as any).updateAirdropMeta?.(transfer.syndicateWalletsCount, transfer.syndicateTier);
            }
          }
          return;
        }

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

        this.states.set(keyV1, { key: keyV1, transfer, observation, lane: laneV1, facts: null, active: true, registeredAt: now, laneLabel: 'V1', version: BOUNCE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV2, { key: keyV2, transfer, observation, lane: laneV2, facts: null, active: true, registeredAt: now, laneLabel: 'V2', version: BOUNCE_RULES_V2.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV3, { key: keyV3, transfer, observation, lane: laneV3, facts: null, active: true, registeredAt: now, laneLabel: 'V3', version: BOUNCE_RULES_V3.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV4, { key: keyV4, transfer, observation, lane: laneV4, facts: null, active: true, registeredAt: now, laneLabel: 'V4', version: BOUNCE_RULES_V4.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV5, { key: keyV5, transfer, observation, lane: laneV5, facts: null, active: true, registeredAt: now, laneLabel: 'V5', version: BOUNCE_RULES_V5.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV6, { key: keyV6, transfer, observation, lane: laneV6, facts: null, active: true, registeredAt: now, laneLabel: 'V6', version: BOUNCE_RULES_V6.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV7, { key: keyV7, transfer, observation, lane: laneV7, facts: null, active: true, registeredAt: now, laneLabel: 'V7', version: BOUNCE_RULES_V7.version, lastDecision: null, lastEvent: null });
        this.states.set(keyS1, { key: keyS1, transfer, observation, lane: laneS1, facts: null, active: true, registeredAt: now, laneLabel: 'S1', version: STAIRCASE_RULES_S1.version, lastDecision: null, lastEvent: null });
        this.states.set(keyS2, { key: keyS2, transfer, observation, lane: laneS2, facts: null, active: true, registeredAt: now, laneLabel: 'S2', version: STAIRCASE_RULES_S2.version, lastDecision: null, lastEvent: null });
        this.states.set(keyS3, { key: keyS3, transfer, observation, lane: laneS3, facts: null, active: true, registeredAt: now, laneLabel: 'S3', version: STAIRCASE_RULES_S3.version, lastDecision: null, lastEvent: null });
        this.states.set(keyS4, { key: keyS4, transfer, observation, lane: laneS4, facts: null, active: true, registeredAt: now, laneLabel: 'S4', version: STAIRCASE_RULES_S4.version, lastDecision: null, lastEvent: null });
        this.states.set(keyS1_2, { key: keyS1_2, transfer, observation, lane: laneS1_2, facts: null, active: true, registeredAt: now, laneLabel: 'S1.2', version: STAIRCASE_RULES_S1_V2.version, lastDecision: null, lastEvent: null });
        this.states.set(keyS5, { key: keyS5, transfer, observation, lane: laneS5, facts: null, active: true, registeredAt: now, laneLabel: 'S5', version: STAIRCASE_RULES_S5.version, lastDecision: null, lastEvent: null });

        if (this.bought.has(`${transfer.mint}:v1`)) laneV1.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v2`)) laneV2.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v3`)) laneV3.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV3.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v4`)) laneV4.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV4.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v5`)) laneV5.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV5.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v6`)) laneV6.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV6.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v7`)) laneV7.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV7.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s1`)) laneS1.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneS1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s2`)) laneS2.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneS2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s3`)) laneS3.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneS3.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s4`)) laneS4.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneS4.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s1_2`)) laneS1_2.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneS1_2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:s5`)) laneS5.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneS5.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
      }

      // ==========================================
      // PIPELINE 2: GMGN RESEARCH NEW PAIR (Momentum Lanes)
      // ==========================================
      else if (source === 'gmgn_research_ws') {
        const keySafe = `${transfer.mint}:safe`;
        if (this.states.has(keySafe)) return;

        const keyOpt = `${transfer.mint}:opt`;
        const keyWide = `${transfer.mint}:wide`;
        const keySwing = `${transfer.mint}:swing`;
        const keyWave = `${transfer.mint}:wave`;
        const keyV2M = `${transfer.mint}:v2m`;
        const keyV3M = `${transfer.mint}:v3m`;
        const keyR5 = `${transfer.mint}:r5`;
        const keyR5_1 = `${transfer.mint}:r5_1`;

        const laneSafe = new DistributionMomentumSafeLane(transfer.mint, makeOnEvent(keySafe, 'Safe'));
        const laneOpt = new DistributionMomentumOptimalLane(transfer.mint, makeOnEvent(keyOpt, 'Opt'));
        const laneWide = new DistributionMomentumWideLane(transfer.mint, makeOnEvent(keyWide, 'Wide'));
        const laneSwing = new DistributionMomentumSwing100kLane(transfer.mint, makeOnEvent(keySwing, 'Swing'));
        const laneWave = new DistributionMomentumWaveLane(transfer.mint, makeOnEvent(keyWave, 'Wave'));
        const laneV2M = new DistributionMomentumV2Lane(transfer.mint, makeOnEvent(keyV2M, 'V2M'));
        const laneV3M = new DistributionMomentumV3Lane(transfer.mint, makeOnEvent(keyV3M, 'V3M'));
        const laneR5 = new DistributionMomentumR5BandLane(transfer.mint, makeOnEvent(keyR5, 'R5'));
        const laneR5_1 = new DistributionMomentumR5BandLaneV2(transfer.mint, makeOnEvent(keyR5_1, 'R5.1'));

        this.states.set(keySafe, { key: keySafe, transfer, observation, lane: laneSafe, facts: null, active: true, registeredAt: now, laneLabel: 'Safe', version: SAFE_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyOpt, { key: keyOpt, transfer, observation, lane: laneOpt, facts: null, active: true, registeredAt: now, laneLabel: 'Opt', version: OPTIMAL_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyWide, { key: keyWide, transfer, observation, lane: laneWide, facts: null, active: true, registeredAt: now, laneLabel: 'Wide', version: WIDE_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keySwing, { key: keySwing, transfer, observation, lane: laneSwing, facts: null, active: true, registeredAt: now, laneLabel: 'Swing', version: SWING_100K_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyWave, { key: keyWave, transfer, observation, lane: laneWave, facts: null, active: true, registeredAt: now, laneLabel: 'Wave', version: WAVE_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV2M, { key: keyV2M, transfer, observation, lane: laneV2M, facts: null, active: true, registeredAt: now, laneLabel: 'V2M', version: MOMENTUM_V2_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyV3M, { key: keyV3M, transfer, observation, lane: laneV3M, facts: null, active: true, registeredAt: now, laneLabel: 'V3M', version: MOMENTUM_V3_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyR5, { key: keyR5, transfer, observation, lane: laneR5, facts: null, active: true, registeredAt: now, laneLabel: 'R5', version: R5_BAND_LANE_RULES.version, lastDecision: null, lastEvent: null });
        this.states.set(keyR5_1, { key: keyR5_1, transfer, observation, lane: laneR5_1, facts: null, active: true, registeredAt: now, laneLabel: 'R5.1', version: R5_BAND_LANE_RULES_V2.version, lastDecision: null, lastEvent: null });

        if (this.bought.has(`${transfer.mint}:safe`)) laneSafe.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneSafe.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:opt`)) laneOpt.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneOpt.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:wide`)) laneWide.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneWide.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:swing`)) laneSwing.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneSwing.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:wave`)) laneWave.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneWave.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v2m`)) laneV2M.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV2M.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:v3m`)) laneV3M.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneV3M.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:r5`)) laneR5.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneR5.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
        if (this.bought.has(`${transfer.mint}:r5_1`)) laneR5_1.end(now, 'ONE_ROUND_ALREADY_ENTERED');
        else if (invalidTime) laneR5_1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
      }

      // ==========================================
      // PIPELINE 3: SMART MONEY INFLOW (117 Wallets: G2.1 Single Whale & G2.2 Multi-Whale)
      // ==========================================
      else if (source === 'smart_money_inflow') {
        const keyG2 = `${transfer.mint}:g2`;
        if (this.states.has(keyG2)) {
          (this.states.get(keyG2)?.lane as any)?.registerSmartWallet?.(transfer.wallet);
          (this.states.get(`${transfer.mint}:g2_1`)?.lane as any)?.registerSmartWallet?.(transfer.wallet);
          (this.states.get(`${transfer.mint}:g2_2`)?.lane as any)?.registerSmartWallet?.(transfer.wallet);
          return;
        }

        const keyG2_1 = `${transfer.mint}:g2_1`;
        const keyG2_2 = `${transfer.mint}:g2_2`;

        const laneG2_1 = new DistributionSmartMoneyLaneG2_1(transfer.mint, makeOnEvent(keyG2_1, 'G2.1'));
        const laneG2_2 = new DistributionSmartMoneyConvergenceLaneG2_2(transfer.mint, makeOnEvent(keyG2_2, 'G2.2'));
        const laneG2 = new DistributionSmartMoneyConvergenceLaneG2(transfer.mint, makeOnEvent(keyG2, 'G2'));

        laneG2_1.registerSmartWallet(transfer.wallet);
        laneG2_2.registerSmartWallet(transfer.wallet);
        laneG2.registerSmartWallet(transfer.wallet);

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

      // ==========================================
      // PIPELINE 4: OEZANK TRADER MIRROR INFLOW (Lane OZ1)
      // ==========================================
      else if (source === 'oezank_inflow') {
        const keyOZ1 = `${transfer.mint}:oz1`;
        if (this.states.has(keyOZ1)) return;

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
          if (state.lane.entryAt === null) {
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
        // 3. OEZANK TRADER MIRROR: If Oezank wallet sold, mirror exit immediately!
        else if (laneLabel === 'OZ1' && wallet === OEZANK_WALLET) {
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

  private persist(now: number) {
    const relevantStates = [...this.states.values()].filter(s => s.lane.entryAt !== null || s.active);
    atomicProfit4Json(join(this.run, 'profit4-state.json'), { observedAt: now, paperLane: this.laneName, rounds: 1,
      execution: 'PAPER_QUOTE', status: 'EXPERIMENTAL', targetPercent: this.targetPercent, rules: this.laneRules,
      recentEvents: this.recentEvents,
      positions: relevantStates.map(s => ({ ...s.transfer, captureActive: s.active,
        laneLabel: s.laneLabel, phase: s.lane.phase, version: s.lane.rules.version, targetPercent: this.targetPercent,
        entryAt: s.lane.entryAt, entryPrice: s.lane.entryPrice, exitAt: s.lane.exitAt, exitPrice: s.lane.exitPrice,
        netReturnPercent: s.lane.netReturnPercent, pnlUsd: s.lane.netReturnPercent === null ? null : s.lane.netReturnPercent / 100 * s.lane.rules.stakeUsd,
        estimatedOpenNetPercent: s.lane.entryAt !== null && s.lane.exitAt === null && s.active && s.facts?.price !== null && s.facts?.price !== undefined
          ? s.lane.net(s.facts.price) : null, lastDecision: s.lastDecision,
        lastEvent: s.lastEvent ? { type: s.lastEvent.type, observedAt: s.lastEvent.observedAt, reason: s.lastEvent.reason, reasons: s.lastEvent.reasons } : null,
        facts: s.facts,
        swapBuyPrice: s.swapBuy?.impliedPriceUsd ?? null,
        swapBuyOk: s.swapBuy?.ok ?? null,
        swapBuyError: s.swapBuy?.error ?? null,
        swapBuySpreadPct: (s.swapBuy?.impliedPriceUsd && s.lane.entryPrice)
          ? ((s.swapBuy.impliedPriceUsd - s.lane.entryPrice) / s.lane.entryPrice) * 100
          : null,
        swapBuyLatencyMs: s.swapBuy?.latencyMs ?? null,
        swapSellPrice1: s.swapSell1?.impliedPriceUsd ?? null,
        swapSellPrice2: s.swapSell2?.impliedPriceUsd ?? null,
        swapSellOk1: s.swapSell1?.ok ?? null,
        swapSellOk2: s.swapSell2?.ok ?? null,
        swapSellDeltaPct: s.swapSellDeltaPct ?? null,
        swapSellSpreadPct: (s.swapSell2?.impliedPriceUsd && s.lane.exitPrice)
          ? ((s.swapSell2.impliedPriceUsd - s.lane.exitPrice) / s.lane.exitPrice) * 100
          : null,
        swapSellLatencyMs: (s.swapSell1?.latencyMs ?? 0) + (s.swapSell2?.latencyMs ?? 0),
      })) });
  }
}
