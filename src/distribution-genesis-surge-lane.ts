import {
  DistributionTargetLane,
  type TargetFacts,
  type TargetRules,
  type TargetEvent,
  type TargetTrade,
  validateTargetRules,
} from './distribution-target-lane.js';

export const GENESIS_SURGE_LANE = 'distribution-genesis-surge-g1';
export const GENESIS_SURGE_TARGET_PERCENT = 50;
export const GENESIS_SURGE_STOP_LOSS_PERCENT = 6;

export const GENESIS_SURGE_RULES: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-genesis-surge-g1',
  paperOnly: true,
  enabled: true,
  targetPercent: GENESIS_SURGE_TARGET_PERCENT,
  observationSeconds: 20, // Konfirmasi awal cepat (20 detik) untuk tangkap momentum surge
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 90, // Maksimal 90s setelah rilis
  confirmSeconds: 2,
  minBuySharePercent: 65, // Min 65% volume buy dari sniper luar
  minMeaningfulBuyUsd: 15,
  minMeaningfulBuyers: 5, // Minimal 5 buyer independen
  maxBuyerSharePercent: 50, // Tidak boleh dimonopoli 1 buyer saja
  minMomentumPercent: 5,
  maxMomentumPercent: 200,
  maxEntryReturnPercent: 80, // Jangan kejar jika sudah pump >80%
  maxDrawdownPercent: 3.5,
  stopLossPercent: GENESIS_SURGE_STOP_LOSS_PERCENT,
  trailingStartPercent: 35, // Trailing stop mulai aktif saat +35%
  trailingDrawdownPercent: 8, // Toleransi pullback 8% dari ATH
  maxHoldSeconds: 600, // Maksimal 10 menit hold
  executionDelayMs: 1000,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionGenesisSurgeLaneG1 extends DistributionTargetLane {
  private firstPrice: number | null = null;
  private peakPrice: number = 0;
  private devDumpDetected = false;
  private dumpReason = '';
  public lastEvaluatedReasons: string[] = [];
  public cumulativeBuyVolumeUsd = 0;

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...GENESIS_SURGE_RULES }, e => emit({
      ...e,
      targetPercent: GENESIS_SURGE_TARGET_PERCENT,
      version: 'distribution-genesis-surge-g1',
      laneLabel: 'G1'
    }), {
      name: 'genesis-surge-g1',
      paperLane: GENESIS_SURGE_LANE,
      prioritizeCustomExit: true,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts) => this.evaluateEntryReasons(f),
      exitReason: (f: TargetFacts, netReturnPercent: number) => {
        // Emergency Exit jika ada dump dari cluster / dev
        if (this.devDumpDetected) {
          return `EMERGENCY_EXIT_${this.dumpReason}`;
        }

        // Tracking ATH peak price untuk multi-tier trailing profit (+50% sampai +100%)
        if (f.price && f.price > this.peakPrice) {
          this.peakPrice = f.price;
        }

        return null;
      }
    });
  }

  public evaluateEntryReasons(f: TargetFacts): string[] {
    const reasons: string[] = [];
    if (!this.rules.enabled) reasons.push('LANE_DISABLED');
    if (f.firstAt === null || f.now - f.firstAt < this.rules.observationSeconds * 1000) {
      reasons.push('GENESIS_SURGE_OBSERVING_INITIAL_FLOW');
    }
    if (f.firstAt !== null && f.now - f.firstAt > this.rules.maxEntryWaitSeconds * 1000) {
      reasons.push('ENTRY_WINDOW_EXPIRED');
    }
    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 8000) {
      reasons.push('PRICE_MISSING_OR_STALE');
    }

    // Gate 1: Dev & Sybil Dump Risk Protection
    if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.0) {
      reasons.push('DEV_HOLDINGS_TOO_HIGH_FOR_SURGE');
    }
    if (this.devDumpDetected) {
      reasons.push(`DEV_OR_CLUSTER_DUMP_ACTIVE_${this.dumpReason}`);
    }

    // Gate 2: Rapid Holder Flight
    if (f.holderDeclineEverSeen) {
      reasons.push('HOLDERS_DECLINING');
    }

    // Gate 3: Sweet-spot Market Cap ($5k - $35k)
    const mc = (f as any).marketCapUsd ?? (f.price !== null ? f.price * 1_000_000_000 : null);
    if (mc !== null && mc !== undefined) {
      if (mc < 5000) reasons.push('MARKET_CAP_BELOW_GENESIS_FLOOR');
      if (mc > 35000) reasons.push('MARKET_CAP_TOO_HIGH_FOR_EARLY_SURGE');
    }

    // Gate 4: Volume Buy Flow Minimal $500 USD
    const totalBuy = (f as any).totalBuyUsd ?? (this.cumulativeBuyVolumeUsd > 0 ? this.cumulativeBuyVolumeUsd : f.meaningfulBuyUsd);
    if (totalBuy !== null && totalBuy < 500) {
      reasons.push('INSUFFICIENT_SNIPER_BUY_VOLUME');
    }

    this.lastEvaluatedReasons = reasons;
    return reasons;
  }

  public getReasons(): string[] {
    return this.lastEvaluatedReasons;
  }

  public registerClusterOrDevSell(wallet: string, amountUsd: number, tx: string = '') {
    if (amountUsd >= 50) {
      this.devDumpDetected = true;
      this.dumpReason = `CLUSTER_DUMP_${wallet.slice(0, 6)}_${Math.round(amountUsd)}USD`;
    }
  }

  public reportDevDump(wallet: string, amountUsd: number) {
    this.registerClusterOrDevSell(wallet, amountUsd, '');
  }

  public onTrade(trade: TargetTrade) {
    if (trade.side === 'buy' && Number.isFinite(trade.usd) && trade.usd! > 0) {
      this.cumulativeBuyVolumeUsd += trade.usd!;
    }
  }
}
