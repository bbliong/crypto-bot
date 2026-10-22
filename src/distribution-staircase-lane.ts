import { DistributionTargetLane, validateTargetRules, type TargetEvent, type TargetFacts, type TargetRules, type TargetTrade } from './distribution-target-lane.js';

// --- S1: Conservative Quick Strike (TP +20%, Observation 45s) ---
export const STAIRCASE_LANE_S1 = 'distribution-staircase-s1';
export const STAIRCASE_TARGET_PERCENT_S1 = 20;
export const STAIRCASE_STOP_LOSS_PERCENT_S1 = 8;

export const STAIRCASE_RULES_S1: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s1',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S1,
  observationSeconds: 45, // Observasi cepat 45s
  minTransferAgeSeconds: 15,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 300,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S1,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 4,
  maxHoldSeconds: 300, // 5 menit runway
  executionDelayMs: 1000,
  maxFillWaitMs: 15000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// Backward compatibility alias
export const STAIRCASE_TARGET_PERCENT = STAIRCASE_TARGET_PERCENT_S1;
export const STAIRCASE_STOP_LOSS_PERCENT = STAIRCASE_STOP_LOSS_PERCENT_S1;

// --- S2: Max Profit Runner (TP +40%, Observation 60s) ---
export const STAIRCASE_LANE_S2 = 'distribution-staircase-s2';
export const STAIRCASE_TARGET_PERCENT_S2 = 40;
export const STAIRCASE_STOP_LOSS_PERCENT_S2 = 8;

export const STAIRCASE_RULES_S2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s2',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S2,
  observationSeconds: 60, // Observasi 60s
  minTransferAgeSeconds: 20,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 300,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S2,
  trailingStartPercent: 28,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 600, // 10 menit runway
  executionDelayMs: 1000,
  maxFillWaitMs: 15000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// --- S3: Hybrid Trailing (TP +30% with Trail, Observation 45s) ---
export const STAIRCASE_LANE_S3 = 'distribution-staircase-s3';
export const STAIRCASE_TARGET_PERCENT_S3 = 30;
export const STAIRCASE_STOP_LOSS_PERCENT_S3 = 8;

export const STAIRCASE_RULES_S3: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s3',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S3,
  observationSeconds: 45, // Observasi 45s
  minTransferAgeSeconds: 15,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 300,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S3,
  trailingStartPercent: 20, // Aktif di +20%
  trailingDrawdownPercent: 4, // Trail 4% dari peak
  maxHoldSeconds: 600, // 10 menit
  executionDelayMs: 1000,
  maxFillWaitMs: 15000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// --- S4: Super Runner >50% Momentum Acceleration (Observation 60s) ---
export const STAIRCASE_LANE_S4 = 'distribution-staircase-s4';
export const STAIRCASE_TARGET_PERCENT_S4 = 50;
export const STAIRCASE_STOP_LOSS_PERCENT_S4 = 8;

export const STAIRCASE_RULES_S4: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s4',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S4,
  observationSeconds: 60,
  minTransferAgeSeconds: 20,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 300,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S4,
  trailingStartPercent: 35,
  trailingDrawdownPercent: 6,
  maxHoldSeconds: 900, // 15 menit runway
  executionDelayMs: 1000,
  maxFillWaitMs: 15000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// --- Base Staircase Engine ---
export abstract class BaseDistributionStaircaseLane extends DistributionTargetLane {
  protected trades: TargetTrade[] = [];
  protected firstTradeAt: number | null = null;
  protected firstPrice: number | null = null;

  setInitialTrades(trades: TargetTrade[]) {
    for (const t of trades) {
      this.onTrade(t);
    }
  }

  onTrade(trade: TargetTrade) {
    if (this.firstTradeAt === null) {
      this.firstTradeAt = trade.timestamp ? (trade.timestamp * 1000) : trade.at;
      this.firstPrice = trade.price;
    }
    this.trades.push(trade);
    if (this.trades.length > 2000) {
      this.trades.shift();
    }
  }

  protected assessStaircaseEntry(
    f: TargetFacts,
    r: TargetRules,
    minGainPercent: number = 2.0,
  ): string[] {
    const reasons: string[] = [];
    if (!r.enabled) reasons.push('LANE_DISABLED');

    const t0 = (this.firstTradeAt ?? (f.firstAt && f.firstAt > 0 ? f.firstAt : null) ?? (f.transferAt > 0 ? f.transferAt : null));
    if (t0 === null) { reasons.push('AWAITING_FIRST_TRADE'); return reasons; }

    const elapsedMs = f.now - t0;
    if (elapsedMs < r.observationSeconds * 1000) {
      reasons.push(`STAIRCASE_OBSERVING_${r.observationSeconds}S_${Math.floor(elapsedMs / 1000)}S`);
      return reasons;
    }
    if (elapsedMs > r.maxEntryWaitSeconds * 1000) { reasons.push('ENTRY_WINDOW_EXPIRED'); return reasons; }
    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
      reasons.push('PRICE_MISSING_OR_STALE');
      return reasons;
    }

    // Drawdown guard: jika token sudah drop > 2.5% dari peak, batalkan entry!
    const dd = f.drawdownPercent ?? 0;
    if (dd > 2.5) {
      reasons.push('MAX_DRAWDOWN_EXCEEDED');
      return reasons;
    }

    // Anti-Rug Guard: Dev Supply Dump Check
    if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.0) {
      reasons.push('DEV_STILL_HOLDING_SUPPLY_DUMP_RISK');
      return reasons;
    }
    if (f.devBalance != null && f.devBalance > 20_000_000) {
      reasons.push('DEV_BALANCE_TOO_LARGE');
      return reasons;
    }

    // Anti-Whale / Large Sell
    if (f.largestSellUsd >= 100) {
      reasons.push('LARGE_SELL_DETECTED');
      return reasons;
    }

    // Multi-Buyer & Flow Dominance
    if (f.meaningfulBuyers < 2) {
      reasons.push('INSUFFICIENT_BUYERS_NEED_MULTI_WALLET');
      return reasons;
    }
    if ((f.buyShareUsdPercent ?? 0) < 55) {
      reasons.push('BUY_FLOW_NOT_DOMINANT');
      return reasons;
    }
    if (f.holderDeclineEverSeen) {
      reasons.push('HOLDER_DECLINE_EVER_SEEN');
      return reasons;
    }

    // Upward momentum: harga harus naik minimal minGainPercent dari startPrice
    const startPrice = this.firstPrice ?? f.price;
    if (startPrice && f.price < startPrice * (1 + minGainPercent / 100)) {
      reasons.push('STEP1_GAIN_TOO_LOW');
      return reasons;
    }

    // Higher Low check: minimal 5 trade on-chain untuk konfirmasi volume
    if (this.trades.length < 5) reasons.push('INSUFFICIENT_TRADES');
    return reasons;
  }
}

// --- Implementation S1 (Conservative Quick Strike) ---
export class DistributionStaircaseLaneS1 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S1 }, e => emit({ ...e, laneLabel: 'S1', targetPercent: STAIRCASE_TARGET_PERCENT_S1 }), {
      name: 'staircase-runner-s1',
      paperLane: STAIRCASE_LANE_S1,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => this.assessStaircaseEntry(f, r, 2.0),
    });
  }
}

// --- Implementation S2 (Max Profit Home-Run 40%) ---
export class DistributionStaircaseLaneS2 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S2 }, e => emit({ ...e, laneLabel: 'S2', targetPercent: STAIRCASE_TARGET_PERCENT_S2 }), {
      name: 'staircase-runner-s2',
      paperLane: STAIRCASE_LANE_S2,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => this.assessStaircaseEntry(f, r, 2.5),
    });
  }
}

// --- Implementation S3 (Hybrid Trailing Runner) ---
export class DistributionStaircaseLaneS3 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S3 }, e => emit({ ...e, laneLabel: 'S3', targetPercent: STAIRCASE_TARGET_PERCENT_S3 }), {
      name: 'staircase-runner-s3',
      paperLane: STAIRCASE_LANE_S3,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => this.assessStaircaseEntry(f, r, 2.0),
    });
  }
}

// --- Implementation S4 (Momentum Acceleration >50% Hunter) ---
export class DistributionStaircaseLaneS4 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S4 }, e => emit({ ...e, laneLabel: 'S4', targetPercent: STAIRCASE_TARGET_PERCENT_S4 }), {
      name: 'staircase-runner-s4',
      paperLane: STAIRCASE_LANE_S4,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => this.assessStaircaseEntry(f, r, 2.5),
    });
  }
}

// --- Implementation S1.2: Fast Strike Staircase (TP +25%, Observation 60s) ---
export const STAIRCASE_LANE_S1_V2 = 'distribution-staircase-s1-v2';
export const STAIRCASE_RULES_S1_V2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s1-v2',
  paperOnly: true,
  enabled: true,
  targetPercent: 25,
  observationSeconds: 60, // 60s observasi
  minTransferAgeSeconds: 15,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 300,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: 8,
  trailingStartPercent: 18,
  trailingDrawdownPercent: 4,
  maxHoldSeconds: 420, // 7 menit
  executionDelayMs: 1000,
  maxFillWaitMs: 15000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionStaircaseLaneS1_v2 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S1_V2 }, e => emit({ ...e, laneLabel: 'S1.2' as any, targetPercent: 25 }), {
      name: 'staircase-fast-s1-2',
      paperLane: STAIRCASE_LANE_S1_V2,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => this.assessStaircaseEntry(f, r, 2.0),
    });
  }
}

// --- Implementation S5: Syndicate Pre-Dump Rider (TP +25%, Hard Time Limit 420s / 7 Menit) ---
export const STAIRCASE_LANE_S5 = 'distribution-staircase-s5';
export const STAIRCASE_TARGET_PERCENT_S5 = 25;
export const STAIRCASE_STOP_LOSS_PERCENT_S5 = 8;

export const STAIRCASE_RULES_S5: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s5',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S5,
  observationSeconds: 45, // Observasi awal 45 detik
  minTransferAgeSeconds: 15,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 300, // Diperpanjang ke 5 menit pertama
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S5,
  trailingStartPercent: 18,
  trailingDrawdownPercent: 4,
  maxHoldSeconds: 420, // HARD TIME LIMIT 7 MENIT (Keluar sebelum jendela dump menit ke-15)
  executionDelayMs: 1000,
  maxFillWaitMs: 15000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionStaircaseLaneS5 extends BaseDistributionStaircaseLane {
  private syndicateWalletsCount: number = 0;
  private syndicateTier: string = '';

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}, meta?: { walletsCount?: number; tier?: string }) {
    super(mint, { ...STAIRCASE_RULES_S5 }, e => emit({ ...e, laneLabel: 'S5' as any, targetPercent: STAIRCASE_TARGET_PERCENT_S5 }), {
      name: 'staircase-tier4-rider-s5',
      paperLane: STAIRCASE_LANE_S5,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => this.assessStaircaseEntry(f, r, 2.5),
    });
    if (meta?.walletsCount) this.syndicateWalletsCount = meta.walletsCount;
    if (meta?.tier) this.syndicateTier = meta.tier;
  }

  public setSyndicateMeta(walletsCount: number, tier: string) {
    this.syndicateWalletsCount = walletsCount;
    this.syndicateTier = tier;
  }

  public updateAirdropMeta(walletsCount: number, tier: string) {
    this.setSyndicateMeta(walletsCount, tier);
  }
}
