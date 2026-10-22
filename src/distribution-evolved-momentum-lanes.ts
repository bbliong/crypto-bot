/**
 * AUTONOMOUSLY EVOLVED MOMENTUM LANES
 * Generated via scripts/momentum-auto-optimizer.py
 * Generated at: 2026-10-19 08:05:06 WIB
 * Evaluated across Oct 14-18 Historical Data + Walk-Forward Validation.
 * Hard Filter: Market Cap >= $10,000 USD.
 */

import {
  DistributionTargetLane,
  TargetRules,
  validateTargetRules,
  DEFAULT_TARGET_RULES,
  TargetEvent
} from './distribution-target-lane.js';
import { evaluateResearchMomentumEntry } from './distribution-research-lanes.js';

export interface EvolvedMomentumRules extends TargetRules {
  readonly minMarketCapUsd?: number;
  readonly maxMarketCapUsd?: number;
  readonly maxLargestSellUsd?: number;
  readonly takeProfitCeilingPercent?: number;
  readonly breakevenTriggerPercent?: number;
  readonly breakevenLockNetPercent?: number;
}

function createEvolvedRules(overrides: Partial<TargetRules> & {
  version: string;
  targetPercent: number;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  maxLargestSellUsd?: number;
  takeProfitCeilingPercent?: number;
  breakevenTriggerPercent?: number;
  breakevenLockNetPercent?: number;
}): Readonly<EvolvedMomentumRules> {
  return Object.freeze({
    ...validateTargetRules({
      ...DEFAULT_TARGET_RULES,
      paperOnly: true,
      enabled: true,
      observationSeconds: 15,
      minTransferAgeSeconds: 30,
      maxTransferLagSeconds: 60,
      maxEntryWaitSeconds: 1800,
      confirmSeconds: 2,
      feePercentPerSide: 1,
      slippagePercentPerSide: 0.5,
      fixedFeeUsdPerSide: 0.005,
      stakeUsd: 5.0,
      maxEntryReturnPercent: 45.0,
      ...overrides,
    }),
    minMarketCapUsd: overrides.minMarketCapUsd,
    maxMarketCapUsd: overrides.maxMarketCapUsd,
    maxLargestSellUsd: overrides.maxLargestSellUsd,
    takeProfitCeilingPercent: overrides.takeProfitCeilingPercent,
    breakevenTriggerPercent: overrides.breakevenTriggerPercent,
    breakevenLockNetPercent: overrides.breakevenLockNetPercent,
  } as any);
}

export class DistributionMomentumBaseLane extends DistributionTargetLane {
  readonly momentumRules: EvolvedMomentumRules;
  private peakGrossSeen = -Infinity;

  constructor(
    mint: string,
    rules: EvolvedMomentumRules,
    laneLabel: string,
    emit: (event: TargetEvent) => void = () => {}
  ) {
    super(
      mint,
      rules,
      (e) =>
        emit({
          ...e,
          targetPercent: rules.targetPercent,
          version: rules.version,
          laneLabel: laneLabel as any,
        }),
      {
        name: laneLabel.toLowerCase().replace(/[^a-z0-9]/g, '_'),
        paperLane: rules.version,
        trailingEnabled: true,
        prioritizeCustomExit: true,
        overrideEntryReasons: evaluateResearchMomentumEntry,
        exitReason: (f: TargetFacts, net: number) => {
          if (this.entryPrice === null || this.entryPrice <= 0 || f.price === null) return null;

          const grossRet = ((f.price - this.entryPrice) / this.entryPrice) * 100;
          if (grossRet > this.peakGrossSeen) {
            this.peakGrossSeen = grossRet;
          }

          // 1. HARD STOP LOSS
          if (grossRet <= -rules.stopLossPercent) {
            return `STOP_LOSS_${Math.round(rules.stopLossPercent)}PCT`;
          }

          // 2. NET PROFIT BREAKEVEN LOCK (Kunci profit saat sentuh trigger)
          if (
            rules.breakevenTriggerPercent !== undefined &&
            rules.breakevenLockNetPercent !== undefined
          ) {
            if (this.peakGrossSeen >= rules.breakevenTriggerPercent) {
              if (grossRet <= rules.breakevenLockNetPercent) {
                return `BREAKEVEN_PROFIT_LOCKED_${Math.round(rules.breakevenTriggerPercent)}_${Math.round(rules.breakevenLockNetPercent)}`;
              }
            }
          }

          // 3. HARD TAKE PROFIT CEILING (Amankan profit sebelum dev dump mikro)
          if (
            rules.takeProfitCeilingPercent !== undefined &&
            grossRet >= rules.takeProfitCeilingPercent
          ) {
            return `TAKE_PROFIT_CEILING_${Math.round(rules.takeProfitCeilingPercent)}`;
          }

          // 4. TIMEOUT MAXIMUM HOLDING
          const holdSec = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          if (holdSec >= rules.maxHoldSeconds) {
            return `MAX_HOLD_TIMEOUT_${Math.round(rules.maxHoldSeconds / 60)}M`;
          }

          // 5. DYNAMIC TRAILING PROFIT
          if (this.peakGrossSeen >= rules.trailingStartPercent) {
            const ddFromPeak = this.peakGrossSeen - grossRet;
            if (ddFromPeak >= rules.trailingDrawdownPercent) {
              return `TRAILING_PROFIT_ABOVE_${Math.round(rules.trailingStartPercent)}_DD${Math.round(rules.trailingDrawdownPercent)}`;
            }
          }

          return null;
        },
      }
    );
    this.momentumRules = rules;
  }
}

// ============================================================================
// [ACTIVE STREAMLINED LANES] M-Scalp, M-Trend, M-Golden (Evolved High Win Rate)
// Evolved via Tick Replay Loop Engineering across 686k granular ticks
// Guard Whale Sell < $60, Anti-FOMO < 45%, Breakeven Lock @ +6%, TP Ceiling
// ============================================================================

export const M_SCALP_RULES = createEvolvedRules({
  version: 'distribution-m-scalp-v2',
  targetPercent: 18.0,
  takeProfitCeilingPercent: 18.0,
  minMarketCapUsd: 15000,
  maxMarketCapUsd: 100000,
  minBuySharePercent: 65.0,
  minMeaningfulBuyUsd: 50,
  minMeaningfulBuyers: 4,
  maxBuyerSharePercent: 65.0,
  minMomentumPercent: 2.0,
  maxMomentumPercent: 30.0,
  maxEntryReturnPercent: 45.0,
  maxDrawdownPercent: 3.0,
  maxLargestSellUsd: 60,
  breakevenTriggerPercent: 6.0,
  breakevenLockNetPercent: 3.0,
  stopLossPercent: 7.0,
  trailingStartPercent: 8.0,
  trailingDrawdownPercent: 2.0,
  maxHoldSeconds: 180,
});

export class DistributionMomentumScalpLane extends DistributionMomentumBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_SCALP_RULES, 'M-Scalp', emit);
  }
}

export const M_TREND_RULES = createEvolvedRules({
  version: 'distribution-m-trend-v2',
  targetPercent: 20.0,
  takeProfitCeilingPercent: 20.0,
  minMarketCapUsd: 20000,
  maxMarketCapUsd: 100000,
  minBuySharePercent: 65.0,
  minMeaningfulBuyUsd: 100,
  minMeaningfulBuyers: 5,
  maxBuyerSharePercent: 60.0,
  minMomentumPercent: 3.0,
  maxMomentumPercent: 40.0,
  maxEntryReturnPercent: 45.0,
  maxDrawdownPercent: 3.5,
  maxLargestSellUsd: 60,
  breakevenTriggerPercent: 6.0,
  breakevenLockNetPercent: 3.0,
  stopLossPercent: 7.0,
  trailingStartPercent: 8.0,
  trailingDrawdownPercent: 2.0,
  maxHoldSeconds: 300,
});

export class DistributionMomentumTrendLane extends DistributionMomentumBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_TREND_RULES, 'M-Trend', emit);
  }
}

export const M_GOLDEN_RULES = createEvolvedRules({
  version: 'distribution-m-golden-v2',
  targetPercent: 18.0,
  takeProfitCeilingPercent: 18.0,
  minMarketCapUsd: 20000,
  maxMarketCapUsd: 100000,
  minBuySharePercent: 65.0,
  minMeaningfulBuyUsd: 100,
  minMeaningfulBuyers: 6,
  maxBuyerSharePercent: 60.0,
  minMomentumPercent: 2.0,
  maxMomentumPercent: 35.0,
  maxEntryReturnPercent: 45.0,
  maxDrawdownPercent: 3.0,
  maxLargestSellUsd: 60,
  breakevenTriggerPercent: 6.0,
  breakevenLockNetPercent: 3.0,
  stopLossPercent: 7.0,
  trailingStartPercent: 8.0,
  trailingDrawdownPercent: 2.0,
  maxHoldSeconds: 450,
});

export class DistributionMomentumGoldenLane extends DistributionMomentumBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_GOLDEN_RULES, 'M-Golden', emit);
  }
}

// ============================================================================
// [ARCHIVED LEGACY LANES] Inactive Reference
// ============================================================================

// ============================================================================
// Momentum Apex (Sweet Spot: Mcap >= $10k)
// ============================================================================
export const M_APEX10K_RULES = createEvolvedRules({
  version: 'distribution-m-apex10k',
  targetPercent: 35.0,
  minMarketCapUsd: 10000,
  minBuySharePercent: 60.0,
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 70.0,
  minMomentumPercent: 2.5,
  maxMomentumPercent: 35.0,
  maxDrawdownPercent: 3.5,
  stopLossPercent: 4.5,
  trailingStartPercent: 10.0,
  trailingDrawdownPercent: 4.0,
  maxHoldSeconds: 600,
});

export class DistributionMApex10kLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_APEX10K_RULES, e => emit({
      ...e,
      targetPercent: M_APEX10K_RULES.targetPercent,
      version: M_APEX10K_RULES.version,
      laneLabel: 'M-Apex10k' as any,
    }), {
      name: 'm-apex10k',
      paperLane: M_APEX10K_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// ============================================================================
// Momentum Safe Scalper (High Quality: Mcap >= $12k)
// ============================================================================
export const M_SAFE10K_RULES = createEvolvedRules({
  version: 'distribution-m-safe10k',
  targetPercent: 35.0,
  minMarketCapUsd: 12000,
  minBuySharePercent: 65.0,
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: 3,
  maxBuyerSharePercent: 65.0,
  minMomentumPercent: 3.5,
  maxMomentumPercent: 35.0,
  maxDrawdownPercent: 3.0,
  stopLossPercent: 4.5,
  trailingStartPercent: 10.0,
  trailingDrawdownPercent: 4.0,
  maxHoldSeconds: 600,
});

export class DistributionMSafe10kLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_SAFE10K_RULES, e => emit({
      ...e,
      targetPercent: M_SAFE10K_RULES.targetPercent,
      version: M_SAFE10K_RULES.version,
      laneLabel: 'M-Safe10k' as any,
    }), {
      name: 'm-safe10k',
      paperLane: M_SAFE10K_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// ============================================================================
// Momentum Trend Runner (Breakout: Mcap >= $15k)
// ============================================================================
export const M_RUNNER15K_RULES = createEvolvedRules({
  version: 'distribution-m-runner15k',
  targetPercent: 35.0,
  minMarketCapUsd: 15000,
  minBuySharePercent: 60.0,
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 75.0,
  minMomentumPercent: 2.0,
  maxMomentumPercent: 35.0,
  maxDrawdownPercent: 4.0,
  stopLossPercent: 4.5,
  trailingStartPercent: 10.0,
  trailingDrawdownPercent: 4.0,
  maxHoldSeconds: 600,
});

export class DistributionMRunner15kLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_RUNNER15K_RULES, e => emit({
      ...e,
      targetPercent: M_RUNNER15K_RULES.targetPercent,
      version: M_RUNNER15K_RULES.version,
      laneLabel: 'M-Runner15k' as any,
    }), {
      name: 'm-runner15k',
      paperLane: M_RUNNER15K_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}
