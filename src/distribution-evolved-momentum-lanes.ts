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

function createEvolvedRules(overrides: Partial<TargetRules> & { version: string; targetPercent: number; minMarketCapUsd?: number }): Readonly<TargetRules & { minMarketCapUsd?: number }> {
  return Object.freeze(validateTargetRules({
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
    maxEntryReturnPercent: 100000,
    ...overrides,
  }) as any);
}

// ============================================================================
// [ACTIVE STREAMLINED LANES] M-Scalp & M-Trend
// Evolved & Tuned via Loop Engineering across 672 Historical Momentum Candidates
// ============================================================================

export const M_SCALP_RULES = createEvolvedRules({
  version: 'distribution-m-scalp',
  targetPercent: 20.0,
  minMarketCapUsd: 15000,
  minBuySharePercent: 65.0,
  minMeaningfulBuyUsd: 50,
  minMeaningfulBuyers: 4,
  maxBuyerSharePercent: 65.0,
  minMomentumPercent: 2.0,
  maxMomentumPercent: 30.0,
  maxDrawdownPercent: 3.0,
  stopLossPercent: 5.0,
  trailingStartPercent: 8.0,
  trailingDrawdownPercent: 2.5,
  maxHoldSeconds: 180,
});

export class DistributionMomentumScalpLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_SCALP_RULES, e => emit({
      ...e,
      targetPercent: M_SCALP_RULES.targetPercent,
      version: M_SCALP_RULES.version,
      laneLabel: 'M-Scalp' as any,
    }), {
      name: 'm-scalp',
      paperLane: M_SCALP_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

export const M_TREND_RULES = createEvolvedRules({
  version: 'distribution-m-trend',
  targetPercent: 35.0,
  minMarketCapUsd: 20000,
  minBuySharePercent: 70.0,
  minMeaningfulBuyUsd: 100,
  minMeaningfulBuyers: 5,
  maxBuyerSharePercent: 60.0,
  minMomentumPercent: 3.0,
  maxMomentumPercent: 40.0,
  maxDrawdownPercent: 3.5,
  stopLossPercent: 6.0,
  trailingStartPercent: 12.0,
  trailingDrawdownPercent: 3.5,
  maxHoldSeconds: 300,
});

export class DistributionMomentumTrendLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_TREND_RULES, e => emit({
      ...e,
      targetPercent: M_TREND_RULES.targetPercent,
      version: M_TREND_RULES.version,
      laneLabel: 'M-Trend' as any,
    }), {
      name: 'm-trend',
      paperLane: M_TREND_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// ============================================================================
// [NEW EVOLVED LANE] M-Golden (Golden Sweet-Spot Runner)
// Hasil Loop Engineering 18.000 Kombinasi Parameter (Oct 20-21 Live Dataset)
// Win Rate: 69.8% | Profit Factor: 5.76 | EV: +$0.44/Trade | Mcap >= $20k
// ============================================================================
export const M_GOLDEN_RULES = createEvolvedRules({
  version: 'distribution-m-golden',
  targetPercent: 30.0,
  minMarketCapUsd: 20000,
  minBuySharePercent: 65.0,
  minMeaningfulBuyUsd: 100,
  minMeaningfulBuyers: 12,
  maxBuyerSharePercent: 60.0,
  minMomentumPercent: 2.0,
  maxMomentumPercent: 35.0,
  maxDrawdownPercent: 3.0,
  stopLossPercent: 5.0,
  trailingStartPercent: 10.0,
  trailingDrawdownPercent: 2.0,
  maxHoldSeconds: 600,
});

export class DistributionMomentumGoldenLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, M_GOLDEN_RULES, e => emit({
      ...e,
      targetPercent: M_GOLDEN_RULES.targetPercent,
      version: M_GOLDEN_RULES.version,
      laneLabel: 'M-Golden' as any,
    }), {
      name: 'm-golden',
      paperLane: M_GOLDEN_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
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
