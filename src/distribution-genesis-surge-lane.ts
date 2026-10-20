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
export const GENESIS_SURGE_STOP_LOSS_PERCENT = 10;

// --- G1: Core Genesis Surge (TP +50%, SL 10%, Trailing 25%/6%) ---
export const GENESIS_SURGE_RULES: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-genesis-surge-g1-v2',
  paperOnly: true,
  enabled: true,
  targetPercent: GENESIS_SURGE_TARGET_PERCENT,
  observationSeconds: 5,
  minTransferAgeSeconds: 10,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 90,
  confirmSeconds: 1,
  minBuySharePercent: 50,
  minMeaningfulBuyUsd: 25,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 80,
  minMomentumPercent: 0.1,
  maxMomentumPercent: 300,
  maxEntryReturnPercent: 80,
  maxDrawdownPercent: 10.0,
  stopLossPercent: GENESIS_SURGE_STOP_LOSS_PERCENT, // Stop loss 10% (menghindari cutloss palsu bonding curve)
  trailingStartPercent: 25,                        // Kunci profit mulai +25%
  trailingDrawdownPercent: 6,                      // Toleransi pullback 6% dari ATH
  maxHoldSeconds: 900,                             // Maksimal 15 menit hold
  executionDelayMs: 400,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// --- G1.2: Aggressive Runner Surge (TP +80%, SL 10%, Trailing 30%/7%) ---
export const GENESIS_SURGE_LANE_G1_2 = 'distribution-genesis-surge-g1-2';
export const GENESIS_SURGE_TARGET_PERCENT_G1_2 = 80;
export const GENESIS_SURGE_STOP_LOSS_PERCENT_G1_2 = 10;

export const GENESIS_SURGE_RULES_G1_2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-genesis-surge-g1-2-v2',
  paperOnly: true,
  enabled: true,
  targetPercent: GENESIS_SURGE_TARGET_PERCENT_G1_2,
  observationSeconds: 5,
  minTransferAgeSeconds: 10,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 120,
  confirmSeconds: 1,
  minBuySharePercent: 50,
  minMeaningfulBuyUsd: 50,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 85,
  minMomentumPercent: 0.1,
  maxMomentumPercent: 350,
  maxEntryReturnPercent: 90,
  maxDrawdownPercent: 10.0,
  stopLossPercent: GENESIS_SURGE_STOP_LOSS_PERCENT_G1_2,
  trailingStartPercent: 30, // Trailing stop mulai aktif saat +30%
  trailingDrawdownPercent: 7, // Toleransi pullback 7% untuk tangkap runner masif
  maxHoldSeconds: 1200,     // Maksimal 20 menit hold
  executionDelayMs: 400,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionGenesisSurgeLaneG1 extends DistributionTargetLane {
  private firstPrice: number | null = null;
  protected peakPrice: number = 0;
  private devDumpDetected = false;
  private dumpReason = '';
  public lastEvaluatedReasons: string[] = [];
  public cumulativeBuyVolumeUsd = 0;
  public maxSingleBuyUsd = 0;
  public totalTradesCount = 0;
  public dustTradesCount = 0;
  public whaleBuysCount = 0;

  constructor(
    mint: string,
    emit: (event: TargetEvent) => void = () => {},
    customRules: TargetRules = GENESIS_SURGE_RULES,
    customLabel: string = 'G1'
  ) {
    super(mint, { ...customRules }, e => emit({
      ...e,
      targetPercent: customRules.targetPercent,
      version: customRules.version,
      laneLabel: customLabel as any
    }), {
      name: customRules.version,
      paperLane: customRules.version,
      prioritizeCustomExit: true,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts) => this.evaluateEntryReasons(f),
      exitReason: (f: TargetFacts, netReturnPercent: number) => {
        // Emergency Exit jika ada dump dari cluster / dev
        if (this.devDumpDetected) {
          return `EMERGENCY_EXIT_${this.dumpReason}`;
        }

        // Tracking ATH peak price untuk multi-tier trailing profit
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

    // Gate 3: Sweet-spot Market Cap ($3k - $35k) - baseline pump.fun adalah ~$3k
    const mc = (f as any).marketCapUsd ?? (f.price !== null ? f.price * 1_000_000_000 : null);
    if (mc !== null && mc !== undefined) {
      if (mc < 3000) reasons.push('MARKET_CAP_BELOW_GENESIS_FLOOR');
      if (mc > 35000) reasons.push('MARKET_CAP_TOO_HIGH_FOR_EARLY_SURGE');
    }

    // Gate 4: Real Sniper / Whale Buy Requirement (Min $100 USD single buy)
    const maxBuy = (f as any).maxBuyUsd ?? this.maxSingleBuyUsd;
    if (maxBuy < 100.0) {
      reasons.push('INSUFFICIENT_SNIPER_WHALE_BUY(max<$100)');
    }

    // Gate 5: Anti Micro-Dust Wash Trading Ratio (Max 40% dust trades if >= 5 trades)
    if (this.totalTradesCount >= 5) {
      const dustRatio = (this.dustTradesCount / this.totalTradesCount) * 100;
      if (dustRatio > 40.0) {
        reasons.push(`WASH_TRADING_MICRO_BOTS_DETECTED(${dustRatio.toFixed(0)}%>40%)`);
      }
    }

    // Gate 6: Minimum Cumulative Volume 30s ($200 USD)
    const totalBuy = (f as any).totalBuyUsd ?? (this.cumulativeBuyVolumeUsd > 0 ? this.cumulativeBuyVolumeUsd : f.meaningfulBuyUsd);
    if (totalBuy !== null && totalBuy < 200) {
      reasons.push(`INSUFFICIENT_SNIPER_BUY_VOLUME($${totalBuy.toFixed(0)}<$200)`);
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

  public setInitialTrades(trades: TargetTrade[]) {
    for (const t of trades) {
      this.recordInternalTrade(t);
    }
  }

  public recordInternalTrade(trade: TargetTrade) {
    const usd = trade.usd ?? 0;
    this.totalTradesCount++;
    if (usd > 0 && usd < 2.0) {
      this.dustTradesCount++;
    }
    if (trade.side === 'buy' && Number.isFinite(usd) && usd > 0) {
      this.cumulativeBuyVolumeUsd += usd;
      if (usd > this.maxSingleBuyUsd) {
        this.maxSingleBuyUsd = usd;
      }
      if (usd >= 100.0) {
        this.whaleBuysCount++;
      }
    }
  }

  public onTrade(trade: TargetTrade) {
    this.recordInternalTrade(trade);
  }
}

export class DistributionGenesisSurgeLaneG1_2 extends DistributionGenesisSurgeLaneG1 {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, emit, GENESIS_SURGE_RULES_G1_2, 'G1.2');
  }
}
