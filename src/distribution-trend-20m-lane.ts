import {
  DistributionTargetLane,
  TargetRules,
  validateTargetRules,
  DEFAULT_TARGET_RULES,
  TargetEvent,
  TargetFacts,
} from './distribution-target-lane.js';

export const TREND_20M_LANE_NAME = 'distribution-trend-20m';

export interface Trend20mRules extends TargetRules {
  minMarketCapUsd: number;
  maxMarketCapUsd: number; // 0 = tanpa batas
  minHolderCount: number;
  minTokenAgeSeconds: number;
  profitFloorPercent: number;
  nominalTargetPercent?: number;
  maxLargestSellUsd?: number;
}

// -------------------------------------------------------------
// 1. Opsi A: Conservative Scalper (T-Cons)
// Max Mcap $15k, TP +20%, Trailing +15% (DD 4%), SL -6%, Hold 30m
// -------------------------------------------------------------
export const TREND_20M_CONS_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-cons-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 6.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 4.0,
    maxHoldSeconds: 1800, // 30 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200, // 20 menit
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 50.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 1,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 0, // Tanpa batas Mcap (dihapus sesuai arahan)
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 15.0,
  nominalTargetPercent: 20.0,
});

// -------------------------------------------------------------
// 2. Opsi B: Balanced Scalper-Runner (T-Bal)
// Max Mcap $25k, TP +25%, Trailing +18% (DD 4%), SL -8%, Hold 45m
// -------------------------------------------------------------
export const TREND_20M_BAL_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-bal-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 8.0,
    trailingStartPercent: 18.0,
    trailingDrawdownPercent: 4.0,
    maxHoldSeconds: 2700, // 45 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 50.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 1,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 0, // Tanpa batas Mcap (dihapus sesuai arahan)
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 18.0,
  nominalTargetPercent: 25.0,
});

// -------------------------------------------------------------
// 3. Opsi C: Wide Aggressive (T-Wide)
// Tanpa batas Mcap, TP +35%, Trailing +20% (DD 5%), SL -8%, Hold 45m
// -------------------------------------------------------------
export const TREND_20M_WIDE_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-wide-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 8.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 5.0,
    maxHoldSeconds: 2700, // 45 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 50.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 1,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 0, // Tanpa batas Mcap
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 20.0,
  nominalTargetPercent: 35.0,
});

// -------------------------------------------------------------
// 4. Opsi D: Moonbag Runner (T-Run)
// Tanpa batas Mcap, TP +60%, Trailing +60% (DD 6%), SL -10%, Hold 120m
// -------------------------------------------------------------
export const TREND_20M_RUN_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-run-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 10.0,
    trailingStartPercent: 60.0,
    trailingDrawdownPercent: 6.0,
    maxHoldSeconds: 7200, // 120 menit (2 jam)
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 50.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 1,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 0, // Tanpa batas Mcap
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 25.0,
  nominalTargetPercent: 60.0,
});

// -------------------------------------------------------------
// 5. Opsi E: Evolved Golden Runner (T-Golden)
// Hasil Loop Engineering 340.200 Kombinasi terhadap 36 Token Live
// Mcap $50k-$500k, Buyers >= 5, BuyShare >= 40%, TP +35%, Trailing +18% (DD 4%), SL -10%, Hold 45m
// -------------------------------------------------------------
export const TREND_20M_GOLDEN_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-golden-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 10.0,
    trailingStartPercent: 18.0,
    trailingDrawdownPercent: 4.0,
    maxHoldSeconds: 2700, // 45 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 40.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 5,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 50000,
  maxMarketCapUsd: 500000,
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 15.0,
  nominalTargetPercent: 35.0,
});

// -------------------------------------------------------------
// 6. Opsi F: Sniper Scalper (T-Sniper)
// Juara Win Rate Loop Engineering Replay (50.0% WR, PnL +$7.35)
// Mcap $30k-$500k, Buyers >= 7, BuyShare >= 50%, TP +40%, Trailing +20% (DD 4%), SL -14%, Hold 45m
// -------------------------------------------------------------
export const TREND_20M_SNIPER_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-sniper-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 14.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    maxHoldSeconds: 2700, // 45 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 50.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 7,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 30000,
  maxMarketCapUsd: 500000,
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 18.0,
  nominalTargetPercent: 40.0,
});

// -------------------------------------------------------------
// 7. Opsi G: Phoenix Runner (T-Phoenix)
// Juara Net PnL Tertinggi Loop Engineering Replay 2.28M Ticks (PnL +$19.43, PF 1.65x)
// Mcap $30k-$600k, Buyers >= 6, BuyShare >= 40%, TP +60%, Trailing +25% (DD 6%), SL -15%, Hold 60m
// -------------------------------------------------------------
export const TREND_20M_PHOENIX_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-phoenix-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    maxHoldSeconds: 3600, // 60 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 40.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 6,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 30000,
  maxMarketCapUsd: 600000,
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 20.0,
  nominalTargetPercent: 60.0,
});

// -------------------------------------------------------------
// 8. Opsi H: Anti-Dump Defender (T-AntiDump)
// Juara Win Rate Tertinggi Loop Engineering Replay 2.28M Ticks (51.2% WR, PnL +$8.61)
// Menolak token jika ada dump seller >= $100 sebelum entry
// Mcap $30k-$600k, Buyers >= 6, BuyShare >= 40%, Sell < $100, TP +60%, Trailing +25% (DD 6%), SL -15%, Hold 60m
// -------------------------------------------------------------
export const TREND_20M_ANTIDUMP_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-antidump-v1',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    maxHoldSeconds: 3600, // 60 menit
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 40.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 6,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 30000,
  maxMarketCapUsd: 600000,
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 20.0,
  nominalTargetPercent: 60.0,
  maxLargestSellUsd: 100,
});

// Legacy singleton baseline v2 (dipakai untuk backward compatibility)
export const TREND_20M_RULES: Readonly<Trend20mRules> = Object.freeze({
  ...validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    version: 'distribution-trend-20m-v2',
    paperOnly: true,
    enabled: true,
    targetPercent: 1000.0,
    stopLossPercent: 7.0,
    trailingStartPercent: 15.0,
    trailingDrawdownPercent: 4.0,
    maxHoldSeconds: 2400,
    observationSeconds: 30,
    minTransferAgeSeconds: 1200,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 7200,
    confirmSeconds: 3,
    minBuySharePercent: 50.0,
    minMeaningfulBuyUsd: 15,
    minMeaningfulBuyers: 1,
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
    stakeUsd: 5.0,
    blockKnownDumpSellers: true,
  }),
  minMarketCapUsd: 10000,
  maxMarketCapUsd: 0,
  minHolderCount: 100,
  minTokenAgeSeconds: 1200,
  profitFloorPercent: 15.0,
  nominalTargetPercent: 20.0,
});

// -------------------------------------------------------------
// Base Trend 20m Lane Class
// -------------------------------------------------------------
export class DistributionTrendBaseLane extends DistributionTargetLane {
  protected peakGrossSeen = -Infinity;
  protected peakNetSeen = -Infinity;
  protected entryTime: number | null = null;
  protected entryBuyPrice: number | null = null;
  protected reachedTargetAt: number | null = null;
  protected readonly trendRules: Trend20mRules;

  constructor(
    mint: string,
    rules: Trend20mRules,
    laneLabel: string,
    displayTargetPercent: number,
    emit: (event: TargetEvent) => void = () => {}
  ) {
    super(
      mint,
      { ...rules },
      (e) =>
        emit({
          ...e,
          targetPercent: displayTargetPercent,
          version: rules.version,
          laneLabel: laneLabel as any,
        }),
      {
        name: `trend-20m-${laneLabel.toLowerCase()}`,
        paperLane: TREND_20M_LANE_NAME,
        prioritizeCustomExit: true,
        trailingEnabled: true,
        flowExitEnabled: false,
        overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
          const reasons: string[] = [];
          if (!r.enabled) reasons.push('LANE_DISABLED');

          // Validasi harga & filter dummy tick
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

          // 1. Usia koin minimal 20 menit (1200 detik)
          const transferAgeSec = f.transferAt > 0 ? (f.now - f.transferAt) / 1000 : 0;
          if (transferAgeSec < rules.minTokenAgeSeconds) {
            reasons.push('TOKEN_AGE_LESS_THAN_20M');
          }

          // 2. Pemegang (Holder) minimal 100
          if (f.holderCount !== null && f.holderCount < rules.minHolderCount) {
            reasons.push('HOLDERS_LESS_THAN_100');
          }

          // 3. Batasi Entry Market Cap jika dikonfigurasi
          if (
            rules.minMarketCapUsd > 0 &&
            f.price !== null &&
            f.price * 1_000_000_000 < rules.minMarketCapUsd
          ) {
            reasons.push('ENTRY_MCAP_TOO_LOW');
          }
          if (
            rules.maxMarketCapUsd > 0 &&
            f.price !== null &&
            f.price * 1_000_000_000 > rules.maxMarketCapUsd
          ) {
            reasons.push('ENTRY_MCAP_TOO_HIGH');
          }

          // 4. Deteksi flight risk / dump holder drastis
          if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) {
            reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');
          }

          // 5. Standar buy share & buyer breadth
          if (f.buyShareUsdPercent !== null && f.buyShareUsdPercent < r.minBuySharePercent) {
            reasons.push('BUY_SHARE_TOO_LOW');
          }
          if (f.meaningfulBuyers < r.minMeaningfulBuyers) {
            reasons.push('NOT_ENOUGH_BUYERS');
          }
          if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > r.maxBuyerSharePercent) {
            reasons.push('SINGLE_BUYER_DOMINATES');
          }

          // 6. FITUR ANTI-DUMP: Deteksi Largest Sell Whale/Dev Sebelum Entry
          if (
            rules.maxLargestSellUsd !== undefined &&
            rules.maxLargestSellUsd > 0 &&
            f.largestSellUsd >= rules.maxLargestSellUsd
          ) {
            reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
          }

          // 7. Batas waktu window observasi (maksimal 120 menit)
          const waitStart = f.firstAt ?? f.now;
          if (f.now - waitStart > r.maxEntryWaitSeconds * 1000) {
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
          if (net > this.peakNetSeen) {
            this.peakNetSeen = net;
          }

          // 1. HARD STOP LOSS
          if (grossRet <= -rules.stopLossPercent) {
            return `STOP_LOSS_${Math.round(rules.stopLossPercent)}PCT`;
          }

          // 2. TIMEOUT MAXIMUM HOLDING
          const holdSeconds = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
          if (holdSeconds >= rules.maxHoldSeconds) {
            return `MAX_HOLD_TIMEOUT_${Math.round(rules.maxHoldSeconds / 60)}M`;
          }

          // 3. FASE DYNAMIC TRAILING PROFIT
          if (this.peakGrossSeen >= rules.trailingStartPercent) {
            const drawdownFromPeak = this.peakGrossSeen - grossRet;
            if (drawdownFromPeak >= rules.trailingDrawdownPercent) {
              if (this.peakGrossSeen >= 60.0) {
                return 'TRAILING_PROFIT_ABOVE_60';
              } else if (this.peakGrossSeen >= 35.0) {
                return 'TRAILING_PROFIT_ABOVE_35';
              } else if (this.peakGrossSeen >= 20.0) {
                return 'TRAILING_PROFIT_ABOVE_20';
              } else {
                return `TRAILING_PROFIT_ABOVE_${Math.round(rules.trailingStartPercent)}`;
              }
            }
          }

          // 4. KUNCI LANTAI CUAN (PROFIT FLOOR LOCK)
          const targetThreshold = (rules.nominalTargetPercent || 20.0);
          if (this.peakGrossSeen >= targetThreshold) {
            if (this.reachedTargetAt === null) {
              this.reachedTargetAt = f.now;
            }

            if (grossRet <= rules.profitFloorPercent) {
              return `PROFIT_FLOOR_SECURED_${Math.round(rules.profitFloorPercent)}`;
            }

            // Jika holder mendadak turun / dump setelah target profit tercapai
            const isHolderDeclining = (f.holderGrowth15s !== null && f.holderGrowth15s < 0) || f.holderDeclineEverSeen;
            if (isHolderDeclining && grossRet >= (targetThreshold - 2.0)) {
              return `HOLDER_DECLINING_TAKE_PROFIT_${Math.round(targetThreshold)}`;
            }
          }

          // 5. STAGNASI PARAH SETELAH 20 MENIT TANPA VOLUME
          if (holdSeconds >= 1200 && Math.abs(grossRet) < 3.0 && f.sellUsd === 0 && f.meaningfulBuyUsd === 0) {
            return 'STAGNANT_NO_VOLUME_20M';
          }

          return null;
        },
      }
    );
    this.trendRules = rules;
  }

  override step(f: TargetFacts) {
    if (this.entryAt !== null && this.entryTime === null) {
      this.entryTime = this.entryAt;
      this.entryBuyPrice = this.entryPrice;
    }
    super.step(f);
  }
}

// -------------------------------------------------------------
// Ekspor 4 Kelas Lane Khusus Trend 20m
// -------------------------------------------------------------
export class DistributionTrendConsLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_CONS_RULES, 'T-Cons', 20.0, emit);
  }
}

export class DistributionTrendBalLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_BAL_RULES, 'T-Bal', 25.0, emit);
  }
}

export class DistributionTrendWideLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_WIDE_RULES, 'T-Wide', 35.0, emit);
  }
}

export class DistributionTrendRunLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_RUN_RULES, 'T-Run', 60.0, emit);
  }
}

export class DistributionTrendGoldenLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_GOLDEN_RULES, 'T-Golden', 35.0, emit);
  }
}

export class DistributionTrendSniperLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_SNIPER_RULES, 'T-Sniper', 40.0, emit);
  }
}

export class DistributionTrendPhoenixLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_PHOENIX_RULES, 'T-Phoenix', 60.0, emit);
  }
}

export class DistributionTrendAntiDumpLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_ANTIDUMP_RULES, 'T-AntiDump', 60.0, emit);
  }
}

// Legacy alias untuk kompatibilitas test & runtime
export class DistributionTrend20mLane extends DistributionTrendBaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, TREND_20M_RULES, 'Trend20m', 20.0, emit);
  }
}
