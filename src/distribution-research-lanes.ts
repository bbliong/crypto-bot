import {
  DistributionTargetLane,
  type TargetFacts,
  type TargetRules,
  type TargetEvent,
  type TargetTrade,
  validateTargetRules,
  DEFAULT_TARGET_RULES,
} from './distribution-target-lane.js';

// Evaluasi entry khusus momentum research: independen dari tab detail GMGN (hemat RAM VPS)
export function evaluateResearchMomentumEntry(f: TargetFacts, r: TargetRules): string[] {
  const reasons: string[] = [];
  if (!r.enabled) reasons.push('LANE_DISABLED');
  if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
  if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
  if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 5000) reasons.push('PRICE_MISSING_OR_STALE');
  if (f.buyShareUsdPercent === null || f.buyShareUsdPercent < r.minBuySharePercent || f.meaningfulBuyUsd < r.minMeaningfulBuyUsd || f.meaningfulBuyers < r.minMeaningfulBuyers) reasons.push('MEANINGFUL_BUY_FLOW_WEAK');
  if (f.topBuyerSharePercent === null || f.topBuyerSharePercent > r.maxBuyerSharePercent) reasons.push('BUYER_CONCENTRATION_HIGH');
  if (f.momentumPercent === null || f.momentumPercent < r.minMomentumPercent || f.momentumPercent > r.maxMomentumPercent) reasons.push('MOMENTUM_OUTSIDE_RANGE');
  if (f.drawdownPercent === null || f.drawdownPercent > r.maxDrawdownPercent || f.entryReturnPercent === null || f.entryReturnPercent > r.maxEntryReturnPercent) reasons.push('PRICE_UNSTABLE_OR_ENTRY_LATE');
  if (f.largestSellUsd >= 250) reasons.push('LARGE_SELL_ALREADY_PRESENT');
  if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 20) reasons.push('DEV_HOLDING_TOO_HIGH');
  return reasons;
}

// Base helper generator for research rules
function createResearchRules(overrides: Partial<TargetRules> & { version: string; targetPercent: number }): Readonly<TargetRules> {
  return Object.freeze(validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    paperOnly: true,
    enabled: true,
    observationSeconds: 15,
    minTransferAgeSeconds: 30,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 300,
    confirmSeconds: 2,
    minBuySharePercent: 60,
    minMeaningfulBuyUsd: 10,
    minMeaningfulBuyers: 2,
    maxBuyerSharePercent: 70,
    minMomentumPercent: 0.5,
    maxMomentumPercent: 25,
    maxEntryReturnPercent: 25,
    maxDrawdownPercent: 3.0,
    stopLossPercent: 5,
    trailingStartPercent: 12,
    trailingDrawdownPercent: 6,
    maxHoldSeconds: 300,
    executionDelayMs: 1000,
    maxFillWaitMs: 3000,
    feePercentPerSide: 1,
    slippagePercentPerSide: 0.5,
    fixedFeeUsdPerSide: 0.005,
    stakeUsd: 5,
    blockKnownDumpSellers: false,
    ...overrides,
  }));
}

// 1. Safe Lane
export const SAFE_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-safe',
  targetPercent: 30,
  minBuySharePercent: 75,
  minMeaningfulBuyUsd: 15,
  minMeaningfulBuyers: 3,
  maxBuyerSharePercent: 65,
  minMomentumPercent: 1.0,
  maxMomentumPercent: 30,
  maxDrawdownPercent: 2.5,
  stopLossPercent: 4,
  trailingStartPercent: 10,
  trailingDrawdownPercent: 7,
});

export class DistributionMomentumSafeLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, SAFE_LANE_RULES, e => emit({
      ...e,
      targetPercent: SAFE_LANE_RULES.targetPercent,
      version: SAFE_LANE_RULES.version,
      laneLabel: 'Safe' as any,
    }), {
      name: 'momentum-safe',
      paperLane: SAFE_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 2. Optimal Lane
export const OPTIMAL_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-optimal',
  targetPercent: 35,
  minBuySharePercent: 70,
  minMeaningfulBuyUsd: 20,
  minMeaningfulBuyers: 4,
  maxBuyerSharePercent: 50,
  minMomentumPercent: 1.0,
  maxMomentumPercent: 22,
  maxDrawdownPercent: 2.5,
  stopLossPercent: 3.5,
  trailingStartPercent: 10,
  trailingDrawdownPercent: 7,
});

export class DistributionMomentumOptimalLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, OPTIMAL_LANE_RULES, e => emit({
      ...e,
      targetPercent: OPTIMAL_LANE_RULES.targetPercent,
      version: OPTIMAL_LANE_RULES.version,
      laneLabel: 'Opt' as any,
    }), {
      name: 'momentum-optimal',
      paperLane: OPTIMAL_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 3. Wide Lane
export const WIDE_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-wide',
  targetPercent: 40,
  minBuySharePercent: 65,
  minMeaningfulBuyUsd: 15,
  minMeaningfulBuyers: 3,
  maxBuyerSharePercent: 60,
  minMomentumPercent: 1.0,
  maxMomentumPercent: 25,
  maxDrawdownPercent: 3.0,
  stopLossPercent: 6,
  trailingStartPercent: 12,
  trailingDrawdownPercent: 8,
});

export class DistributionMomentumWideLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, WIDE_LANE_RULES, e => emit({
      ...e,
      targetPercent: WIDE_LANE_RULES.targetPercent,
      version: WIDE_LANE_RULES.version,
      laneLabel: 'Wide' as any,
    }), {
      name: 'momentum-wide',
      paperLane: WIDE_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 4. Swing 100k Lane
export const SWING_100K_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-swing-100k',
  targetPercent: 50,
  minBuySharePercent: 65,
  minMeaningfulBuyUsd: 20,
  minMeaningfulBuyers: 4,
  maxBuyerSharePercent: 60,
  minMomentumPercent: 1.2,
  maxMomentumPercent: 25,
  maxDrawdownPercent: 3.5,
  stopLossPercent: 5,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 7,
  maxHoldSeconds: 600,
});

export class DistributionMomentumSwing100kLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, SWING_100K_LANE_RULES, e => emit({
      ...e,
      targetPercent: SWING_100K_LANE_RULES.targetPercent,
      version: SWING_100K_LANE_RULES.version,
      laneLabel: 'Swing' as any,
    }), {
      name: 'momentum-swing-100k',
      paperLane: SWING_100K_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 5. Wave Scalper Lane
export const WAVE_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-wave',
  targetPercent: 20,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 15,
  minMeaningfulBuyers: 3,
  maxBuyerSharePercent: 65,
  minMomentumPercent: 0.8,
  maxMomentumPercent: 35,
  maxDrawdownPercent: 4.0,
  stopLossPercent: 6,
  trailingStartPercent: 10,
  trailingDrawdownPercent: 5,
  confirmSeconds: 1,
});

export class DistributionMomentumWaveLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, WAVE_LANE_RULES, e => emit({
      ...e,
      targetPercent: WAVE_LANE_RULES.targetPercent,
      version: WAVE_LANE_RULES.version,
      laneLabel: 'Wave' as any,
    }), {
      name: 'momentum-wave',
      paperLane: WAVE_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 6. Momentum V2 Lane
export const MOMENTUM_V2_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-v2',
  targetPercent: 30,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 70,
  minMomentumPercent: 0.5,
  maxMomentumPercent: 20,
  maxDrawdownPercent: 3.0,
  stopLossPercent: 5,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 6,
});

export class DistributionMomentumV2Lane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, MOMENTUM_V2_LANE_RULES, e => emit({
      ...e,
      targetPercent: MOMENTUM_V2_LANE_RULES.targetPercent,
      version: MOMENTUM_V2_LANE_RULES.version,
      laneLabel: 'V2M' as any,
    }), {
      name: 'momentum-v2',
      paperLane: MOMENTUM_V2_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 7. Momentum V3 Lane
export const MOMENTUM_V3_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-v3',
  targetPercent: 35,
  minBuySharePercent: 65,
  minMeaningfulBuyUsd: 15,
  minMeaningfulBuyers: 3,
  maxBuyerSharePercent: 60,
  minMomentumPercent: 0.5,
  maxMomentumPercent: 25,
  maxDrawdownPercent: 3.0,
  stopLossPercent: 5,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 6,
});

export class DistributionMomentumV3Lane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, MOMENTUM_V3_LANE_RULES, e => emit({
      ...e,
      targetPercent: MOMENTUM_V3_LANE_RULES.targetPercent,
      version: MOMENTUM_V3_LANE_RULES.version,
      laneLabel: 'V3M' as any,
    }), {
      name: 'momentum-v3',
      paperLane: MOMENTUM_V3_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}

// 8. R5 Band Lane (Sweet Spot 5-10% return)
export const R5_BAND_LANE_RULES = createResearchRules({
  version: 'distribution-momentum-r5-band',
  targetPercent: 25,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 65,
  minMomentumPercent: 5.0,
  maxMomentumPercent: 10.0,
  maxDrawdownPercent: 2.5,
  stopLossPercent: 4,
  trailingStartPercent: 10,
  trailingDrawdownPercent: 5,
});

export class DistributionMomentumR5BandLane extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, R5_BAND_LANE_RULES, e => emit({
      ...e,
      targetPercent: R5_BAND_LANE_RULES.targetPercent,
      version: R5_BAND_LANE_RULES.version,
      laneLabel: 'R5' as any,
    }), {
      name: 'momentum-r5-band',
      paperLane: R5_BAND_LANE_RULES.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}
