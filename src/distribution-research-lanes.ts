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

  // Anti-Genesis Trap: Token minimal harus berusia r.minTransferAgeSeconds (default 30s) sejak pertama kali muncul
  if (f.transferAt > 0 && f.now - f.transferAt < (r.minTransferAgeSeconds ?? 30) * 1000) {
    reasons.push('TOKEN_TOO_FRESH_GENESIS_RISK');
  }

  // Hard Filter: Market Cap minimal untuk momentum (default $10k, menolak dev-dump genesis micro-cap)
  const estimatedMcapUsd = (f.price ?? 0) * 1_000_000_000;
  const requiredMcap = (r as any).minMarketCapUsd ?? 10000;
  if (estimatedMcapUsd < requiredMcap) reasons.push(requiredMcap <= 10000 ? 'MARKET_CAP_BELOW_10K' : 'MARKET_CAP_BELOW_THRESHOLD');
  if (f.buyShareUsdPercent === null || f.buyShareUsdPercent < r.minBuySharePercent || f.meaningfulBuyUsd < r.minMeaningfulBuyUsd || f.meaningfulBuyers < r.minMeaningfulBuyers) reasons.push('MEANINGFUL_BUY_FLOW_WEAK');
  if (f.topBuyerSharePercent === null || f.topBuyerSharePercent > r.maxBuyerSharePercent) reasons.push('BUYER_CONCENTRATION_HIGH');
  if (f.momentumPercent === null || f.momentumPercent < r.minMomentumPercent || f.momentumPercent > r.maxMomentumPercent) reasons.push('MOMENTUM_OUTSIDE_RANGE');
  // Proteksi drawdown: harga tidak boleh sedang anjlok dari peak lokal (maksimal r.maxDrawdownPercent)
  if (f.drawdownPercent === null || f.drawdownPercent > r.maxDrawdownPercent) reasons.push('PRICE_DRAWDOWN_EXCEEDED');
  
  // Proteksi Whale Sell Dump: tolak jika sell terbesar melebihi batas (default r.maxLargestSellUsd atau $60)
  const maxSell = typeof (r as any).maxLargestSellUsd === 'number' ? (r as any).maxLargestSellUsd : 60;
  if (f.largestSellUsd >= maxSell) {
    reasons.push(maxSell <= 100 ? 'LARGEST_SELL_TOO_HIGH_WHALE_DUMP' : 'LARGE_SELL_ALREADY_PRESENT');
  }

  // Sell Volume Overwhelming Guard: tolak jika tekanan jual melebihi 2.5x volume beli
  if (f.sellUsd > (f.meaningfulBuyUsd * 2.5) && f.sellUsd >= 100) {
    reasons.push('SELL_VOLUME_OVERWHELMING');
  }

  // Anti-FOMO Guard: tolak token yang return observasi sebelum masuk sudah melonjak terlalu tinggi
  if (typeof r.maxEntryReturnPercent === 'number' && r.maxEntryReturnPercent < 1000) {
    if (f.entryReturnPercent !== null && f.entryReturnPercent > r.maxEntryReturnPercent) {
      reasons.push('FOMO_GAIN_TOO_HIGH_TOP_BUY');
    }
  }

  // Anti-Rug Guard: Dev Supply Dump Check (diperketat dari 20% menjadi max 3%)
  if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 3.0) {
    reasons.push('DEV_STILL_HOLDING_SUPPLY_DUMP_RISK');
  } else if (typeof f.devBalance === 'number' && f.devBalance > 25_000_000) {
    reasons.push('DEV_BALANCE_TOO_LARGE');
  }

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
    maxEntryWaitSeconds: 1800,
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

// 8. R5 Band Lane (Sweet Spot 5-10% return - Baseline)
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

// 8.1 R5.1 Dynamic Band Lane (Improved Variant - Tidak Ditiban)
export const R5_BAND_LANE_RULES_V2 = createResearchRules({
  version: 'distribution-momentum-r5-band-v2',
  targetPercent: 25,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 5,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 85, // Diperlonggar dari 65% ke 85% untuk pump.fun sniper
  minMomentumPercent: 3.0, // Diperluas dari 5.0% ke 3.0%
  maxMomentumPercent: 25.0, // Diperluas dari 10.0% ke 25.0%
  maxDrawdownPercent: 5.0, // Dari 2.5% ke 5.0%
  stopLossPercent: 6,
  trailingStartPercent: 12,
  trailingDrawdownPercent: 5,
});

export class DistributionMomentumR5BandLaneV2 extends DistributionTargetLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, R5_BAND_LANE_RULES_V2, e => emit({
      ...e,
      targetPercent: R5_BAND_LANE_RULES_V2.targetPercent,
      version: R5_BAND_LANE_RULES_V2.version,
      laneLabel: 'R5.1' as any,
    }), {
      name: 'momentum-r5-band-v2',
      paperLane: R5_BAND_LANE_RULES_V2.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    });
  }
}
