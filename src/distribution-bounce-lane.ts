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
