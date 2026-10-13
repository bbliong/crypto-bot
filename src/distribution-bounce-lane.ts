import { DistributionTargetLane, validateTargetRules, type TargetEvent, type TargetFacts, type TargetRules } from './distribution-target-lane.js';

export const BOUNCE_DUMP_LANE = 'distribution-bounce-dump-35';
export const BOUNCE_TARGET_PERCENT = 35; // Target keuntungan 30% - 40% (default 35% net)
export const BOUNCE_MIN_TARGET_PERCENT = 30;
export const BOUNCE_MAX_TARGET_PERCENT = 40;

export const BOUNCE_RULES: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-bounce-dump-v1',
  paperOnly: true,
  enabled: true,
  targetPercent: BOUNCE_MAX_TARGET_PERCENT,
  observationSeconds: 20,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 600, // Memberi waktu observasi sampai dump selesai dan bounce mulai terbentuk
  confirmSeconds: 1,
  minBuySharePercent: 50, // Saat mulai rebound, buy volume mendominasi sell volume
  minMeaningfulBuyUsd: 3,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 50,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 99, // Diizinkan drawdown tinggi karena memang mengincar token yang dump parah
  stopLossPercent: 12, // Stop loss terukur jika bounce gagal dan breakdown lagi
  trailingStartPercent: 25,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 300, // 5 menit batas maksimal
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionBounceLane extends DistributionTargetLane {
  private dumpObserved = false;
  private maxDrawdownSeen = 0;
  private entryTime: number | null = null;
  private entryBuyPrice: number | null = null;
  private lastPriceMoveTime: number | null = null;
  private lastPriceMove: number | null = null;

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...BOUNCE_RULES }, e => emit({ ...e, targetPercent: BOUNCE_TARGET_PERCENT }), {
      name: 'dump-bounce-35',
      paperLane: BOUNCE_DUMP_LANE,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
        if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');
        if (f.holderGrowth15s !== null && f.holderGrowth15s < -5) reasons.push('HOLDERS_DECLINING_RAPIDLY');

        // Syarat 1: Token harus sudah pernah mengalami DUMP PARAH (drawdown >= 60% dari peak)
        const dd = f.drawdownPercent ?? 0;
        if (dd >= 60) {
          this.dumpObserved = true;
        }
        if (dd > this.maxDrawdownSeen) {
          this.maxDrawdownSeen = dd;
        }

        if (!this.dumpObserved && this.maxDrawdownSeen < 60) {
          reasons.push('NOT_YET_DUMPED_SEVERELY');
        }

        // Syarat 2: Harus ada tanda-tanda MULAI BERANJAK NAIK (Bounce dari titik terendah / trough >= 4.0%)
        const bounce = f.bounceFromTroughPercent ?? 0;
        if (bounce < 4.0) {
          reasons.push('BOUNCE_FROM_TROUGH_TOO_SMALL');
        }

        // Syarat 3: Harus ada aliran BUY baru masuk (reversal flow dominan)
        if ((f.buyShareUsdPercent ?? 0) < 50 || f.meaningfulBuyUsd < 2) {
          reasons.push('BUY_FLOW_NOT_RECOVERED');
        }

        return reasons;
      },
      exitReason: (f: TargetFacts, net: number) => {
        // Target Take Profit: 30% - 40%
        if (net >= BOUNCE_MIN_TARGET_PERCENT) {
          return 'TARGET_BOUNCE_30_40';
        }

        // Exit jika Stagnan / Tidak ada pergerakan setelah dump
        if (this.entryTime !== null && f.price !== null) {
          const holdSeconds = (f.now - this.entryTime) / 1000;

          // Track pergerakan harga
          if (this.lastPriceMove === null || Math.abs(f.price - this.lastPriceMove) / (this.lastPriceMove || 1) >= 0.01) {
            this.lastPriceMove = f.price;
            this.lastPriceMoveTime = f.now;
          }

          // Jika sudah di-hold >= 90 detik, dan dalam 60 detik terakhir harga macet/tidak bergerak (<1% move)
          const stagnationTimeMs = this.lastPriceMoveTime ? f.now - this.lastPriceMoveTime : 0;
          if (holdSeconds >= 90 && stagnationTimeMs >= 60_000 && net < 10) {
            return 'STAGNANT_NO_MOVEMENT_AFTER_DUMP';
          }
        }

        return null;
      },
    });
  }

  override step(f: TargetFacts) {
    if (this.entryAt !== null && this.entryTime === null) {
      this.entryTime = this.entryAt;
      this.entryBuyPrice = this.entryPrice;
      this.lastPriceMoveTime = this.entryAt;
      this.lastPriceMove = this.entryPrice;
    }

    // Don't fill pending orders using a quote from after this decision.
    if (f.priceAt !== null && f.priceAt > f.now) {
      f = { ...f, price: null, priceAt: null };
    }
    super.step(f);
  }
}

export const BOUNCE_DUMP_LANE_V2 = 'distribution-bounce-dump-v2';

export const BOUNCE_RULES_V2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...BOUNCE_RULES,
  version: 'distribution-bounce-dump-v2',
  trailingStartPercent: 20,
  trailingDrawdownPercent: 4,
  blockKnownDumpSellers: true,
}));

export class DistributionBounceLaneV2 extends DistributionTargetLane {
  private dumpObserved = false;
  private maxDrawdownSeen = 0;
  private entryTime: number | null = null;
  private entryBuyPrice: number | null = null;
  private peakNetSeen = -Infinity;
  private lastPriceMoveTime: number | null = null;
  private lastPriceMove: number | null = null;

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...BOUNCE_RULES_V2 }, e => emit({ ...e, targetPercent: BOUNCE_TARGET_PERCENT, version: 'distribution-bounce-dump-v2' }), {
      name: 'dump-bounce-v2',
      paperLane: BOUNCE_DUMP_LANE_V2,
      trailingEnabled: false,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
        if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');
        if (f.holderGrowth15s !== null && f.holderGrowth15s < -5) reasons.push('HOLDERS_DECLINING_RAPIDLY');

        // Syarat 1: Token harus sudah pernah mengalami DUMP PARAH (drawdown >= 60% dari peak)
        const dd = f.drawdownPercent ?? 0;
        if (dd >= 60) this.dumpObserved = true;
        if (dd > this.maxDrawdownSeen) this.maxDrawdownSeen = dd;

        if (!this.dumpObserved && this.maxDrawdownSeen < 60) {
          reasons.push('NOT_YET_DUMPED_SEVERELY');
        }

        // Syarat 2: Rebound dari trough minimal 4.0%
        const bounce = f.bounceFromTroughPercent ?? 0;
        if (bounce < 4.0) {
          reasons.push('BOUNCE_FROM_TROUGH_TOO_SMALL');
        }

        // Syarat 3: Buy flow memadai
        if ((f.buyShareUsdPercent ?? 0) < 50 || f.meaningfulBuyUsd < 2) {
          reasons.push('BUY_FLOW_NOT_RECOVERED');
        }

        // V2 KHUSUS: Filter Anti-Whale Dump Sebelum Entry
        if (f.largestSellUsd >= 300) {
          reasons.push('WHALE_SELL_PRESENT_BEFORE_ENTRY');
        }
        if (f.sellUsd > (f.meaningfulBuyUsd * 3.5) && f.sellUsd >= 500) {
          reasons.push('SELL_VOLUME_OVERWHELMING');
        }

        return reasons;
      },
      exitReason: (f: TargetFacts, net: number) => {
        // Target Take Profit: 30% - 40%
        if (net >= BOUNCE_MIN_TARGET_PERCENT) {
          return 'TARGET_BOUNCE_30_40';
        }

        // V2 KHUSUS: Trailing Lock di +20% (kunci profit agar tidak berbalik rugi)
        if (net > this.peakNetSeen) this.peakNetSeen = net;
        if (this.peakNetSeen >= 20 && (this.peakNetSeen - net >= 4 || net <= 12)) {
          return 'PROFIT_LOCK_20_EXIT';
        }

        // V2 KHUSUS: Emergency Exit saat terdeteksi order sell whale besar saat posisi terbuka
        if (f.largestSellUsd >= 250 && net > -10) {
          return 'LARGE_SELL_WHALE_DUMP_EXIT';
        }

        // Exit jika Stagnan setelah dump
        if (this.entryTime !== null && f.price !== null) {
          const holdSeconds = (f.now - this.entryTime) / 1000;
          if (this.lastPriceMove === null || Math.abs(f.price - this.lastPriceMove) / (this.lastPriceMove || 1) >= 0.01) {
            this.lastPriceMove = f.price;
            this.lastPriceMoveTime = f.now;
          }
          const stagnationTimeMs = this.lastPriceMoveTime ? f.now - this.lastPriceMoveTime : 0;
          if (holdSeconds >= 90 && stagnationTimeMs >= 60_000 && net < 10) {
            return 'STAGNANT_NO_MOVEMENT_AFTER_DUMP';
          }
        }

        return null;
      },
    });
  }

  override step(f: TargetFacts) {
    if (this.entryAt !== null && this.entryTime === null) {
      this.entryTime = this.entryAt;
      this.entryBuyPrice = this.entryPrice;
      this.lastPriceMoveTime = this.entryAt;
      this.lastPriceMove = this.entryPrice;
    }
    if (f.priceAt !== null && f.priceAt > f.now) {
      f = { ...f, price: null, priceAt: null };
    }
    super.step(f);
  }
}

export const BOUNCE_DUMP_LANE_V3 = 'distribution-bounce-dump-v3';
export const BOUNCE_TARGET_PERCENT_V3 = 20; // Target keuntungan +18% s/d +20% net

export const BOUNCE_RULES_V3: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-bounce-dump-v3',
  paperOnly: true,
  enabled: true,
  targetPercent: BOUNCE_TARGET_PERCENT_V3,
  observationSeconds: 20,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 600,
  confirmSeconds: 1,
  minBuySharePercent: 50,
  minMeaningfulBuyUsd: 3,
  minMeaningfulBuyers: 8, // Broad demand: minimal 8 buyers riil
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 50,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 99,
  stopLossPercent: 10, // Stop loss terukur -10%
  trailingStartPercent: 14,
  trailingDrawdownPercent: 4,
  maxHoldSeconds: 240, // 4 menit batas hold
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionBounceLaneV3 extends DistributionTargetLane {
  private dumpObserved = false;
  private maxDrawdownSeen = 0;
  private entryTime: number | null = null;
  private entryBuyPrice: number | null = null;
  private peakNetSeen = -Infinity;
  private lastPriceMoveTime: number | null = null;
  private lastPriceMove: number | null = null;

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...BOUNCE_RULES_V3 }, e => emit({ ...e, targetPercent: BOUNCE_TARGET_PERCENT_V3, version: 'distribution-bounce-dump-v3' }), {
      name: 'dump-bounce-v3',
      paperLane: BOUNCE_DUMP_LANE_V3,
      trailingEnabled: false,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
        if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');

        // V3 Guard 1: Token harus pernah mengalami DUMP PARAH (>= 60%)
        const dd = f.drawdownPercent ?? 0;
        if (dd >= 60) this.dumpObserved = true;
        if (dd > this.maxDrawdownSeen) this.maxDrawdownSeen = dd;
        if (!this.dumpObserved && this.maxDrawdownSeen < 60) {
          reasons.push('NOT_YET_DUMPED_SEVERELY');
        }

        // V3 Guard 2: EARLY REVERSAL ZONE ONLY (4% <= bounce <= 15%)
        // Menolak jika belum memantul (<4%) ATAU sudah memantul terlalu tinggi (>15%) agar tidak beli di pucuk
        const bounce = f.bounceFromTroughPercent ?? 0;
        if (bounce < 4.0) {
          reasons.push('BOUNCE_FROM_TROUGH_TOO_SMALL');
        } else if (bounce > 15.0) {
          reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
        }

        // V3 Guard 3: GENUINE BROAD BUYERS (minimal 8 pembeli riil)
        // Menolak token manipulasi wash trading 1-3 wallet (seperti LEGO & Muse AI)
        if ((f.meaningfulBuyers ?? 0) < 8) {
          reasons.push('INSUFFICIENT_BUYERS');
        }

        // V3 Guard 4: RECOVERY FLOW & SELL PRESSURE
        if ((f.buyShareUsdPercent ?? 0) < 50 || (f.meaningfulBuyUsd ?? 0) < 3) {
          reasons.push('BUY_FLOW_NOT_RECOVERED');
        }
        if (f.sellUsd > (f.meaningfulBuyUsd ?? 1) * 3 && f.sellUsd > 100) {
          reasons.push('SELL_PRESSURE_OVERWHELMING');
        }

        // V3 Guard 5: HOLDER HEALTH
        if (f.holderGrowth15s !== null && f.holderGrowth15s < 0) {
          reasons.push('HOLDERS_DECLINING');
        }

        return reasons;
      },
      exitReason: (f: TargetFacts, net: number) => {
        // V3 Target Take Profit: +18% s/d +20% (eksekusi cepat sebelum tersenggol dump)
        if (net >= 18) {
          return 'TARGET_BOUNCE_20';
        }

        // V3 Early Profit Lock: Kunci keuntungan jika floating sudah >= +14%
        if (net > this.peakNetSeen) this.peakNetSeen = net;
        if (this.peakNetSeen >= 14 && (this.peakNetSeen - net >= 3.5 || net <= 8)) {
          return 'PROFIT_LOCK_14_EXIT';
        }

        // V3 Emergency Exit: Order sell tunggal besar >= $200 saat posisi terbuka
        if (f.largestSellUsd >= 200 && net > -8) {
          return 'EMERGENCY_WHALE_SELL_EXIT';
        }

        // V3 Stagnation Cut: Jika sudah hold >= 60s dan tidak bergerak dalam 45s terakhir
        if (this.entryTime !== null && f.price !== null) {
          const holdSeconds = (f.now - this.entryTime) / 1000;
          if (this.lastPriceMove === null || Math.abs(f.price - this.lastPriceMove) / (this.lastPriceMove || 1) >= 0.01) {
            this.lastPriceMove = f.price;
            this.lastPriceMoveTime = f.now;
          }
          const stagnationTimeMs = this.lastPriceMoveTime ? f.now - this.lastPriceMoveTime : 0;
          if (holdSeconds >= 60 && stagnationTimeMs >= 45_000 && net < 5) {
            return 'STAGNANT_NO_MOVEMENT_AFTER_DUMP';
          }
        }

        return null;
      },
    });
  }

  override step(f: TargetFacts) {
    if (this.entryAt !== null && this.entryTime === null) {
      this.entryTime = this.entryAt;
      this.entryBuyPrice = this.entryPrice;
      this.lastPriceMoveTime = this.entryAt;
      this.lastPriceMove = this.entryPrice;
    }
    if (f.priceAt !== null && f.priceAt > f.now) {
      f = { ...f, price: null, priceAt: null };
    }
    super.step(f);
  }
}

export const BOUNCE_DUMP_LANE_V4 = 'distribution-bounce-dump-v4';
export const BOUNCE_TARGET_PERCENT_V4 = 35; // Target keuntungan besar V1: 30% - 40% (default 35% net)
export const BOUNCE_MIN_TARGET_PERCENT_V4 = 30;
export const BOUNCE_MAX_TARGET_PERCENT_V4 = 40;

export const BOUNCE_RULES_V4: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-bounce-dump-v4',
  paperOnly: true,
  enabled: true,
  targetPercent: BOUNCE_MAX_TARGET_PERCENT_V4,
  observationSeconds: 20,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 600,
  confirmSeconds: 1,
  minBuySharePercent: 50,
  minMeaningfulBuyUsd: 2,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 50,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 99,
  stopLossPercent: 12,
  trailingStartPercent: 25,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 300,
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionBounceLaneV4 extends DistributionTargetLane {
  private dumpObserved = false;
  private maxDrawdownSeen = 0;
  private entryTime: number | null = null;
  private entryBuyPrice: number | null = null;
  private lastPriceMoveTime: number | null = null;
  private lastPriceMove: number | null = null;

  // Progressive Staircase Confirmation Tracking
  private initialStep: { price: number; time: number; troughAtStep: number } | null = null;
  private staircaseConfirmed = false;
  private staircaseInvalidated = false;
  private staircaseInvalidReason = '';

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...BOUNCE_RULES_V4 }, e => emit({ ...e, targetPercent: BOUNCE_TARGET_PERCENT_V4, version: 'distribution-bounce-dump-v4' }), {
      name: 'dump-bounce-v4',
      paperLane: BOUNCE_DUMP_LANE_V4,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
        if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');
        if (f.holderGrowth15s !== null && f.holderGrowth15s < -5) reasons.push('HOLDERS_DECLINING_RAPIDLY');

        // Syarat 1 Dasar V1: Token harus sudah pernah mengalami DUMP PARAH (>= 60%)
        const dd = f.drawdownPercent ?? 0;
        if (dd >= 60) {
          this.dumpObserved = true;
        }
        if (dd > this.maxDrawdownSeen) {
          this.maxDrawdownSeen = dd;
        }

        if (!this.dumpObserved && this.maxDrawdownSeen < 60) {
          reasons.push('NOT_YET_DUMPED_SEVERELY');
        }

        // Syarat 2 Dasar V1: Buy flow memadai
        if ((f.buyShareUsdPercent ?? 0) < 50 || f.meaningfulBuyUsd < 2) {
          reasons.push('BUY_FLOW_NOT_RECOVERED');
        }

        const bounce = f.bounceFromTroughPercent ?? 0;
        const currentPrice = f.price ?? 0;
        const currentTrough = f.troughPrice ?? currentPrice;

        // Progressive Staircase Logic:
        // Jika belum ada initial step, cari pantulan awal (3.5% s/d 15%)
        if (!this.initialStep) {
          if (bounce < 3.5) {
            reasons.push('BOUNCE_FROM_TROUGH_TOO_SMALL');
          } else if (bounce > 15.0) {
            reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
          } else if (currentPrice > 0) {
            // Catat Step 1
            this.initialStep = {
              price: currentPrice,
              time: f.now,
              troughAtStep: currentTrough,
            };
            reasons.push('STAIRCASE_WAITING_CONFIRMATION');
          }
        } else if (!this.staircaseConfirmed) {
          // Sedang dalam proses observasi staircase
          const dtSeconds = (f.now - this.initialStep.time) / 1000;

          if (currentPrice < this.initialStep.troughAtStep * 0.98) {
            // Tembus trough baru -> breakdown
            this.staircaseInvalidated = true;
            this.staircaseInvalidReason = 'BREAKDOWN_BELOW_TROUGH';
            // Reset step agar bisa deteksi trough baru di masa depan
            this.initialStep = null;
            reasons.push('STAIRCASE_BREAKDOWN_BELOW_TROUGH');
          } else if (dtSeconds < 2.0) {
            // Masih dalam jeda 2 detik pertama -> tunggu konfirmasi bertahap
            reasons.push('STAIRCASE_WAITING_CONFIRMATION');
          } else if (dtSeconds >= 2.0 && dtSeconds <= 6.0) {
            // Jendela konfirmasi tercapai:
            if (currentPrice < this.initialStep.price * 0.90) {
              // Spike ambruk >10%
              this.initialStep = null;
              reasons.push('STAIRCASE_SPIKE_COLLAPSED');
            } else if (bounce > 18.0) {
              // Overextended pucuk
              this.initialStep = null;
              reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
            } else if (currentPrice >= this.initialStep.price * 0.97) {
              // Terkonfirmasi bertahap!
              this.staircaseConfirmed = true;
            } else {
              reasons.push('STAIRCASE_WAITING_CONFIRMATION');
            }
          } else {
            // Kadaluarsa >6 detik tanpa konfirmasi bertahap
            this.initialStep = null;
            reasons.push('STAIRCASE_CONFIRMATION_TIMEOUT');
          }
        }

        return reasons;
      },
      exitReason: (f: TargetFacts, net: number) => {
        // Target Take Profit Lane V1: 30% - 40% (default min 30%)
        if (net >= BOUNCE_MIN_TARGET_PERCENT_V4) {
          return 'TARGET_BOUNCE_30_40';
        }

        // Exit jika Stagnan setelah dump
        if (this.entryTime !== null && f.price !== null) {
          const holdSeconds = (f.now - this.entryTime) / 1000;

          if (this.lastPriceMove === null || Math.abs(f.price - this.lastPriceMove) / (this.lastPriceMove || 1) >= 0.01) {
            this.lastPriceMove = f.price;
            this.lastPriceMoveTime = f.now;
          }

          const stagnationTimeMs = this.lastPriceMoveTime ? f.now - this.lastPriceMoveTime : 0;
          if (holdSeconds >= 90 && stagnationTimeMs >= 60_000 && net < 10) {
            return 'STAGNANT_NO_MOVEMENT_AFTER_DUMP';
          }
        }

        return null;
      },
    });
  }

  override step(f: TargetFacts) {
    if (this.entryAt !== null && this.entryTime === null) {
      this.entryTime = this.entryAt;
      this.entryBuyPrice = this.entryPrice;
      this.lastPriceMoveTime = this.entryAt;
      this.lastPriceMove = this.entryPrice;
    }
    if (f.priceAt !== null && f.priceAt > f.now) {
      f = { ...f, price: null, priceAt: null };
    }
    super.step(f);
  }
}

export const BOUNCE_DUMP_LANE_V5 = 'distribution-bounce-dump-v5';
export const BOUNCE_TARGET_PERCENT_V5 = 35; // Target keuntungan besar: 30% - 40% (default 35% net)
export const BOUNCE_MIN_TARGET_PERCENT_V5 = 30;
export const BOUNCE_MAX_TARGET_PERCENT_V5 = 40;

export const BOUNCE_RULES_V5: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-bounce-dump-v5',
  paperOnly: true,
  enabled: true,
  targetPercent: BOUNCE_MAX_TARGET_PERCENT_V5,
  observationSeconds: 20,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 600,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 5, // Filter quant: Naikkan dari $2 ke $5 untuk menyaring debu/fake bot pump
  minMeaningfulBuyers: 2, // Filter quant: Wajib minimal 2 distinct buyers (bukan single dev buy)
  maxBuyerSharePercent: 80, // Filter quant: Maksimal 80% per buyer agar terdistribusi organik
  minMomentumPercent: 0,
  maxMomentumPercent: 50,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 99,
  stopLossPercent: 12,
  trailingStartPercent: 20, // Filter quant: Aktifkan trailing lebih awal di +20%
  trailingDrawdownPercent: 4,
  maxHoldSeconds: 300,
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionBounceLaneV5 extends DistributionTargetLane {
  private dumpObserved = false;
  private maxDrawdownSeen = 0;
  private entryTime: number | null = null;
  private entryBuyPrice: number | null = null;
  private lastPriceMoveTime: number | null = null;
  private lastPriceMove: number | null = null;
  private peakNetSeen = -Infinity;
  private lastWhaleSellSeenAt: number | null = null;

  // Progressive Staircase Confirmation Tracking
  private initialStep: { price: number; time: number; troughAtStep: number } | null = null;
  private staircaseConfirmed = false;
  private staircaseInvalidated = false;
  private staircaseInvalidReason = '';

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...BOUNCE_RULES_V5 }, e => emit({ ...e, targetPercent: BOUNCE_TARGET_PERCENT_V5, version: 'distribution-bounce-dump-v5' }), {
      name: 'dump-bounce-v5',
      paperLane: BOUNCE_DUMP_LANE_V5,
      prioritizeCustomExit: true,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
        if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');

        // Solusi 2 Gate 1: Dev Supply Dump Check (Anti-Rugpull Dev Trap)
        // Jika dev (transfer.from) terdeteksi masih memegang > 2% supply (> 20M token), dev belum dump tuntas!
        if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.0) {
          reasons.push('DEV_STILL_HOLDING_SUPPLY_DUMP_RISK');
        } else if (f.devBalance != null && f.devBalance > 20_000_000) {
          reasons.push('DEV_BALANCE_TOO_LARGE');
        }

        // Solusi 2 Gate 2: Rapid Holder Flight / Bundler Scam Check
        // Jika token pernah mengalami penurunan holder drastis (holderGrowth15s < -3), tolak entry!
        if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) {
          reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');
        }

        // Solusi 2 Gate 3: Whale Dump Active Protection & Cooldown 45s
        // Catat whale sell terakhir >= $150
        if (f.largestSellUsd >= 150) {
          this.lastWhaleSellSeenAt = f.now;
          reasons.push('WHALE_SELL_ACTIVE_IN_WINDOW');
        }
        // Wajib cooldown minimal 45 detik setelah whale sell besar agar selling pressure benar-benar reda
        if (this.lastWhaleSellSeenAt !== null && (f.now - this.lastWhaleSellSeenAt) < 45_000) {
          reasons.push('WHALE_SELL_COOLDOWN_ACTIVE');
        }

        // Syarat 1 Dasar V5: Token harus sudah pernah mengalami DUMP TUNTAS (drawdown >= 75% dari peak)
        const dd = f.drawdownPercent ?? 0;
        if (dd >= 75) {
          this.dumpObserved = true;
        }
        if (dd > this.maxDrawdownSeen) {
          this.maxDrawdownSeen = dd;
        }

        if (!this.dumpObserved && this.maxDrawdownSeen < 75) {
          reasons.push('NOT_YET_DUMPED_SEVERELY');
        }

        // Syarat 2 Dasar V5 Quant: Multi-buyer filter & volume memadai
        if ((f.buyShareUsdPercent ?? 0) < r.minBuySharePercent || f.meaningfulBuyUsd < r.minMeaningfulBuyUsd) {
          reasons.push('BUY_FLOW_NOT_RECOVERED');
        }
        if (f.meaningfulBuyers < r.minMeaningfulBuyers) {
          reasons.push('INSUFFICIENT_BUYERS_NEED_MULTI_WALLET');
        }
        if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > r.maxBuyerSharePercent) {
          reasons.push('BUYER_CONCENTRATION_TOO_HIGH_SINGLE_WALLET');
        }

        const bounce = f.bounceFromTroughPercent ?? 0;
        const currentPrice = f.price ?? 0;
        const currentTrough = f.troughPrice ?? currentPrice;

        // Progressive Staircase Logic dengan Trough Stabilization Dwell Time (min 3.0 - 7.0 detik):
        if (!this.initialStep) {
          if (bounce < 3.5) {
            reasons.push('BOUNCE_FROM_TROUGH_TOO_SMALL');
          } else if (bounce > 15.0) {
            reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
          } else if (currentPrice > 0) {
            this.initialStep = {
              price: currentPrice,
              time: f.now,
              troughAtStep: currentTrough,
            };
            reasons.push('STAIRCASE_WAITING_CONFIRMATION');
          }
        } else if (!this.staircaseConfirmed) {
          const dtSeconds = (f.now - this.initialStep.time) / 1000;

          if (currentPrice < this.initialStep.troughAtStep * 0.98) {
            this.staircaseInvalidated = true;
            this.staircaseInvalidReason = 'BREAKDOWN_BELOW_TROUGH';
            this.initialStep = null;
            reasons.push('STAIRCASE_BREAKDOWN_BELOW_TROUGH');
          } else if (dtSeconds < 3.0) {
            // Dwell time: Tunggu minimal 3.0 detik untuk membuktikan dasar harga tidak langsung roboh
            reasons.push('STAIRCASE_WAITING_CONFIRMATION');
          } else if (dtSeconds >= 3.0 && dtSeconds <= 7.0) {
            if (currentPrice < this.initialStep.price * 0.90) {
              this.initialStep = null;
              reasons.push('STAIRCASE_SPIKE_COLLAPSED');
            } else if (bounce > 16.0) {
              this.initialStep = null;
              reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
            } else if (currentPrice >= this.initialStep.price * 0.97) {
              this.staircaseConfirmed = true;
            } else {
              reasons.push('STAIRCASE_WAITING_CONFIRMATION');
            }
          } else {
            this.initialStep = null;
            reasons.push('STAIRCASE_CONFIRMATION_TIMEOUT');
          }
        }

        return reasons;
      },
      exitReason: (f: TargetFacts, net: number) => {
        if (net > this.peakNetSeen) {
          this.peakNetSeen = net;
        }

        // Solusi 2 Gate 5: Hard-Cap Rugpull Loss Protection
        // Jika terjadi jurang gap down slippage AMM, batasi eksekusi kerugian
        if (net <= -25) {
          return 'HARD_CAP_RUGPULL_PROTECTION';
        }

        // 1. Target Take Profit Penuh: 30% - 40% (default 30-35% net)
        if (net >= BOUNCE_MIN_TARGET_PERCENT_V5) {
          return 'TARGET_BOUNCE_30_40';
        }

        // 2. V5 KHUSUS - Profit Lock & Breakeven Bertingkat:
        // Level 2: Jika sudah pernah mencapai profit >= +20%, kunci profit minimal di +12% atau trailing -4% dari pucuk
        if (this.peakNetSeen >= 20) {
          if (this.peakNetSeen - net >= 4 || net <= 12) {
            return 'PROFIT_LOCK_20_EXIT';
          }
        }

        // Level 1 Quant: Jika sudah pernah mencapai profit >= +15%, kunci profit minimal di +10% atau trailing -4% dari pucuk
        if (this.peakNetSeen >= 15) {
          if (this.peakNetSeen - net >= 4 || net <= 10) {
            return 'PROFIT_LOCK_15_EXIT';
          }
        }

        // 3. V5 KHUSUS - Early Warning Whale Sell saat Sedang Untung:
        // Jika sedang floating profit >= +8% dan whale mulai buang barang (>= $80), segera amankan profit
        if (net >= 8 && f.largestSellUsd >= 80) {
          return 'PROFIT_SECURED_ON_WHALE_SELL';
        }

        // 4. Exit jika Stagnan setelah dump
        if (this.entryTime !== null && f.price !== null) {
          const holdSeconds = (f.now - this.entryTime) / 1000;

          if (this.lastPriceMove === null || Math.abs(f.price - this.lastPriceMove) / (this.lastPriceMove || 1) >= 0.01) {
            this.lastPriceMove = f.price;
            this.lastPriceMoveTime = f.now;
          }

          const stagnationTimeMs = this.lastPriceMoveTime ? f.now - this.lastPriceMoveTime : 0;
          if (holdSeconds >= 90 && stagnationTimeMs >= 60_000 && net < 10) {
            return 'STAGNANT_NO_MOVEMENT_AFTER_DUMP';
          }
        }

        return null;
      },
    });
  }

  override step(f: TargetFacts) {
    if (this.entryAt !== null && this.entryTime === null) {
      this.entryTime = this.entryAt;
      this.entryBuyPrice = this.entryPrice;
      this.lastPriceMoveTime = this.entryAt;
      this.lastPriceMove = this.entryPrice;
      this.peakNetSeen = 0;
    }
    if (f.priceAt !== null && f.priceAt > f.now) {
      f = { ...f, price: null, priceAt: null };
    }
    super.step(f);
  }
}



