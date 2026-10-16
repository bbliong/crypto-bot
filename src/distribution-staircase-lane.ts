import { DistributionTargetLane, validateTargetRules, type TargetEvent, type TargetFacts, type TargetRules, type TargetTrade } from './distribution-target-lane.js';

// --- S1: Conservative Quick Strike (TP +25%) ---
export const STAIRCASE_LANE_S1 = 'distribution-staircase-s1';
export const STAIRCASE_TARGET_PERCENT_S1 = 25;
export const STAIRCASE_STOP_LOSS_PERCENT_S1 = 8;

export const STAIRCASE_RULES_S1: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s1',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S1,
  observationSeconds: 120, // Baseline S1 tetap 120s
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 180,
  confirmSeconds: 1,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S1,
  trailingStartPercent: 20,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 300, // 5 menit
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// Backward compatibility alias
export const STAIRCASE_TARGET_PERCENT = STAIRCASE_TARGET_PERCENT_S1;
export const STAIRCASE_STOP_LOSS_PERCENT = STAIRCASE_STOP_LOSS_PERCENT_S1;

// --- S2: Max Profit Runner (TP +50%) ---
export const STAIRCASE_LANE_S2 = 'distribution-staircase-s2';
export const STAIRCASE_TARGET_PERCENT_S2 = 50;
export const STAIRCASE_STOP_LOSS_PERCENT_S2 = 8;

export const STAIRCASE_RULES_S2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s2',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S2,
  observationSeconds: 120, // Baseline S2 tetap 120s
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 180,
  confirmSeconds: 1,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S2,
  trailingStartPercent: 40,
  trailingDrawdownPercent: 6,
  maxHoldSeconds: 900, // 15 menit runway
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// --- S3: Hybrid Trailing (TP +35% with Trail) ---
export const STAIRCASE_LANE_S3 = 'distribution-staircase-s3';
export const STAIRCASE_TARGET_PERCENT_S3 = 35;
export const STAIRCASE_STOP_LOSS_PERCENT_S3 = 8;

export const STAIRCASE_RULES_S3: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s3',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S3,
  observationSeconds: 120,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 180,
  confirmSeconds: 1,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S3,
  trailingStartPercent: 25, // Aktif di +25%
  trailingDrawdownPercent: 5, // Trail 5% dari peak
  maxHoldSeconds: 900, // 15 menit
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// --- S4: Super Runner >50% Momentum Acceleration ---
export const STAIRCASE_LANE_S4 = 'distribution-staircase-s4';
export const STAIRCASE_TARGET_PERCENT_S4 = 50;
export const STAIRCASE_STOP_LOSS_PERCENT_S4 = 8;

export const STAIRCASE_RULES_S4: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s4',
  paperOnly: true,
  enabled: true,
  targetPercent: STAIRCASE_TARGET_PERCENT_S4,
  observationSeconds: 120,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 180,
  confirmSeconds: 1,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 2.5,
  stopLossPercent: STAIRCASE_STOP_LOSS_PERCENT_S4,
  trailingStartPercent: 40,
  trailingDrawdownPercent: 6,
  maxHoldSeconds: 1200, // 20 menit runway
  executionDelayMs: 1000,
  maxFillWaitMs: 5000,
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
}

// --- Implementation S1 (Conservative Quick Strike) ---
export class DistributionStaircaseLaneS1 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S1 }, e => emit({ ...e, laneLabel: 'S1', targetPercent: STAIRCASE_TARGET_PERCENT_S1 }), {
      name: 'staircase-runner-s1',
      paperLane: STAIRCASE_LANE_S1,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');

        const t0 = this.firstTradeAt ?? f.firstAt;
        if (t0 === null) { reasons.push('AWAITING_FIRST_TRADE'); return reasons; }

        const elapsedMs = f.now - t0;
        if (elapsedMs < 120_000) {
          reasons.push(`STAIRCASE_OBSERVING_120S_${Math.floor(elapsedMs / 1000)}S`);
          return reasons;
        }
        if (elapsedMs > r.maxEntryWaitSeconds * 1000) { reasons.push('ENTRY_WINDOW_EXPIRED'); return reasons; }
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
          return reasons;
        }

        const startPrice = this.firstPrice ?? f.price;
        if (!startPrice || startPrice <= 0) { reasons.push('INVALID_START_PRICE'); return reasons; }

        const m1End = t0 + 60_000;
        const m2End = t0 + 120_000;
        const tradesM1 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time < m1End;
        });
        const tradesM2 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= m1End && time <= m2End;
        });
        const trades120 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time <= m2End;
        });

        const priceM1 = tradesM1.length ? tradesM1[tradesM1.length - 1].price : startPrice;
        const priceM2 = tradesM2.length ? tradesM2[tradesM2.length - 1].price : f.price;

        const gainM1 = ((priceM1 - startPrice) / startPrice) * 100;
        const gainM2 = ((priceM2 - priceM1) / priceM1) * 100;
        const gainTotal = ((priceM2 - startPrice) / startPrice) * 100;

        const sumVol = (ts: TargetTrade[], side?: string) =>
          ts.reduce((acc, t) => (!side || t.side === side ? acc + (t.usd ?? 0) : acc), 0);

        const volBuyM1 = sumVol(tradesM1, 'buy');
        const volSellM1 = sumVol(tradesM1, 'sell');
        const volBuyM2 = sumVol(tradesM2, 'buy');
        const volSellM2 = sumVol(tradesM2, 'sell');
        const totBuy = volBuyM1 + volBuyM2;
        const totSell = volSellM1 + volSellM2;
        const ratio120 = totBuy / Math.max(totSell, 1);

        let peak = startPrice;
        let maxDd = 0;
        let maxSingleSell = 0;
        for (const t of trades120) {
          if (t.price > peak) peak = t.price;
          else if (peak > 0) {
            const dd = ((peak - t.price) / peak) * 100;
            if (dd > maxDd) maxDd = dd;
          }
          if (t.side === 'sell' && (t.usd ?? 0) > maxSingleSell) {
            maxSingleSell = t.usd ?? 0;
          }
        }

        // S1 Gates: MinBuy $1500, MaxDD <= 2.2%, MaxSell <= $50, B/S >= 3.5x, Gain Step >= 2%
        if (gainM1 < 2.0) reasons.push('STEP1_GAIN_TOO_LOW');
        if (gainM1 > 20.0) reasons.push('STEP1_GAIN_TOO_HIGH_PUMP');
        if (gainM2 < 2.0) reasons.push('STEP2_HIGHER_HIGH_NOT_MET');
        if (gainTotal < 5.0) reasons.push('TOTAL_120S_GAIN_TOO_LOW');
        if (gainTotal > 30.0) reasons.push('TOTAL_120S_GAIN_OVEREXTENDED');

        if (totBuy < 1500) reasons.push('TOTAL_VOLUME_TOO_LOW');
        if (ratio120 < 3.5) reasons.push('BUY_SELL_RATIO_TOO_LOW');
        if (maxDd > 2.2) reasons.push('MAX_DRAWDOWN_EXCEEDED');
        if (maxSingleSell > 50) reasons.push('LARGE_SELL_DETECTED');

        if (f.holderDeclineEverSeen) reasons.push('HOLDER_DECLINE_EVER_SEEN');
        if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.5) {
          reasons.push('DEV_HOLDING_TOO_HIGH');
        }

        return reasons;
      },
    });
  }
}

// --- Implementation S2 (Max Profit Home-Run 50%) ---
export class DistributionStaircaseLaneS2 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S2 }, e => emit({ ...e, laneLabel: 'S2', targetPercent: STAIRCASE_TARGET_PERCENT_S2 }), {
      name: 'staircase-runner-s2',
      paperLane: STAIRCASE_LANE_S2,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');

        const t0 = this.firstTradeAt ?? f.firstAt;
        if (t0 === null) { reasons.push('AWAITING_FIRST_TRADE'); return reasons; }

        const elapsedMs = f.now - t0;
        if (elapsedMs < 120_000) {
          reasons.push(`STAIRCASE_OBSERVING_120S_${Math.floor(elapsedMs / 1000)}S`);
          return reasons;
        }
        if (elapsedMs > r.maxEntryWaitSeconds * 1000) { reasons.push('ENTRY_WINDOW_EXPIRED'); return reasons; }
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
          return reasons;
        }

        const startPrice = this.firstPrice ?? f.price;
        if (!startPrice || startPrice <= 0) { reasons.push('INVALID_START_PRICE'); return reasons; }

        const m1End = t0 + 60_000;
        const m2End = t0 + 120_000;
        const tradesM1 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time < m1End;
        });
        const tradesM2 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= m1End && time <= m2End;
        });
        const trades120 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time <= m2End;
        });

        const priceM1 = tradesM1.length ? tradesM1[tradesM1.length - 1].price : startPrice;
        const priceM2 = tradesM2.length ? tradesM2[tradesM2.length - 1].price : f.price;

        const gainM1 = ((priceM1 - startPrice) / startPrice) * 100;
        const gainM2 = ((priceM2 - priceM1) / priceM1) * 100;
        const gainTotal = ((priceM2 - startPrice) / startPrice) * 100;

        const sumVol = (ts: TargetTrade[], side?: string) =>
          ts.reduce((acc, t) => (!side || t.side === side ? acc + (t.usd ?? 0) : acc), 0);

        const volBuyM1 = sumVol(tradesM1, 'buy');
        const volSellM1 = sumVol(tradesM1, 'sell');
        const volBuyM2 = sumVol(tradesM2, 'buy');
        const volSellM2 = sumVol(tradesM2, 'sell');
        const totBuy = volBuyM1 + volBuyM2;
        const totSell = volSellM1 + volSellM2;
        const ratio120 = totBuy / Math.max(totSell, 1);

        let peak = startPrice;
        let maxDd = 0;
        let maxSingleSell = 0;
        for (const t of trades120) {
          if (t.price > peak) peak = t.price;
          else if (peak > 0) {
            const dd = ((peak - t.price) / peak) * 100;
            if (dd > maxDd) maxDd = dd;
          }
          if (t.side === 'sell' && (t.usd ?? 0) > maxSingleSell) {
            maxSingleSell = t.usd ?? 0;
          }
        }

        // S2 Gates: MinBuy $1500, MaxDD <= 2.2%, MaxSell <= $50, B/S >= 3.5x, Gain Step >= 2%
        if (gainM1 < 2.0) reasons.push('STEP1_GAIN_TOO_LOW');
        if (gainM1 > 20.0) reasons.push('STEP1_GAIN_TOO_HIGH_PUMP');
        if (gainM2 < 2.0) reasons.push('STEP2_HIGHER_HIGH_NOT_MET');
        if (gainTotal < 5.0) reasons.push('TOTAL_120S_GAIN_TOO_LOW');
        if (gainTotal > 35.0) reasons.push('TOTAL_120S_GAIN_OVEREXTENDED');

        if (totBuy < 1500) reasons.push('TOTAL_VOLUME_TOO_LOW');
        if (ratio120 < 3.5) reasons.push('BUY_SELL_RATIO_TOO_LOW');
        if (maxDd > 2.2) reasons.push('MAX_DRAWDOWN_EXCEEDED');
        if (maxSingleSell > 50) reasons.push('LARGE_SELL_DETECTED');

        if (f.holderDeclineEverSeen) reasons.push('HOLDER_DECLINE_EVER_SEEN');
        if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.5) {
          reasons.push('DEV_HOLDING_TOO_HIGH');
        }

        return reasons;
      },
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
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');

        const t0 = this.firstTradeAt ?? f.firstAt;
        if (t0 === null) { reasons.push('AWAITING_FIRST_TRADE'); return reasons; }

        const elapsedMs = f.now - t0;
        if (elapsedMs < 120_000) {
          reasons.push(`STAIRCASE_OBSERVING_120S_${Math.floor(elapsedMs / 1000)}S`);
          return reasons;
        }
        if (elapsedMs > r.maxEntryWaitSeconds * 1000) { reasons.push('ENTRY_WINDOW_EXPIRED'); return reasons; }
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
          return reasons;
        }

        const startPrice = this.firstPrice ?? f.price;
        if (!startPrice || startPrice <= 0) { reasons.push('INVALID_START_PRICE'); return reasons; }

        const m1End = t0 + 60_000;
        const m2End = t0 + 120_000;
        const tradesM1 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time < m1End;
        });
        const tradesM2 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= m1End && time <= m2End;
        });
        const trades120 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time <= m2End;
        });

        const priceM1 = tradesM1.length ? tradesM1[tradesM1.length - 1].price : startPrice;
        const priceM2 = tradesM2.length ? tradesM2[tradesM2.length - 1].price : f.price;

        const gainM1 = ((priceM1 - startPrice) / startPrice) * 100;
        const gainM2 = ((priceM2 - priceM1) / priceM1) * 100;
        const gainTotal = ((priceM2 - startPrice) / startPrice) * 100;

        const sumVol = (ts: TargetTrade[], side?: string) =>
          ts.reduce((acc, t) => (!side || t.side === side ? acc + (t.usd ?? 0) : acc), 0);

        const volBuyM1 = sumVol(tradesM1, 'buy');
        const volSellM1 = sumVol(tradesM1, 'sell');
        const volBuyM2 = sumVol(tradesM2, 'buy');
        const volSellM2 = sumVol(tradesM2, 'sell');
        const totBuy = volBuyM1 + volBuyM2;
        const totSell = volSellM1 + volSellM2;
        const ratio120 = totBuy / Math.max(totSell, 1);

        let peak = startPrice;
        let maxDd = 0;
        let maxSingleSell = 0;
        for (const t of trades120) {
          if (t.price > peak) peak = t.price;
          else if (peak > 0) {
            const dd = ((peak - t.price) / peak) * 100;
            if (dd > maxDd) maxDd = dd;
          }
          if (t.side === 'sell' && (t.usd ?? 0) > maxSingleSell) {
            maxSingleSell = t.usd ?? 0;
          }
        }

        // S3 Gates: MinBuy $1500, MaxDD <= 2.2%, MaxSell <= $50, B/S >= 3.5x
        if (gainM1 < 2.0) reasons.push('STEP1_GAIN_TOO_LOW');
        if (gainM1 > 20.0) reasons.push('STEP1_GAIN_TOO_HIGH_PUMP');
        if (gainM2 < 2.0) reasons.push('STEP2_HIGHER_HIGH_NOT_MET');
        if (gainTotal < 5.0) reasons.push('TOTAL_120S_GAIN_TOO_LOW');
        if (gainTotal > 35.0) reasons.push('TOTAL_120S_GAIN_OVEREXTENDED');

        if (totBuy < 1500) reasons.push('TOTAL_VOLUME_TOO_LOW');
        if (ratio120 < 3.5) reasons.push('BUY_SELL_RATIO_TOO_LOW');
        if (maxDd > 2.2) reasons.push('MAX_DRAWDOWN_EXCEEDED');
        if (maxSingleSell > 50) reasons.push('LARGE_SELL_DETECTED');

        if (f.holderDeclineEverSeen) reasons.push('HOLDER_DECLINE_EVER_SEEN');
        if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.5) {
          reasons.push('DEV_HOLDING_TOO_HIGH');
        }

        return reasons;
      },
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
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');

        const t0 = this.firstTradeAt ?? f.firstAt;
        if (t0 === null) { reasons.push('AWAITING_FIRST_TRADE'); return reasons; }

        const elapsedMs = f.now - t0;
        if (elapsedMs < 120_000) {
          reasons.push(`STAIRCASE_OBSERVING_120S_${Math.floor(elapsedMs / 1000)}S`);
          return reasons;
        }
        if (elapsedMs > r.maxEntryWaitSeconds * 1000) { reasons.push('ENTRY_WINDOW_EXPIRED'); return reasons; }
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
          return reasons;
        }

        const startPrice = this.firstPrice ?? f.price;
        if (!startPrice || startPrice <= 0) { reasons.push('INVALID_START_PRICE'); return reasons; }

        const m1End = t0 + 60_000;
        const m2End = t0 + 120_000;
        const tradesM1 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time < m1End;
        });
        const tradesM2 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= m1End && time <= m2End;
        });
        const trades120 = this.trades.filter(t => {
          const time = t.timestamp ? (t.timestamp * 1000) : t.at;
          return time >= t0 && time <= m2End;
        });

        const priceM1 = tradesM1.length ? tradesM1[tradesM1.length - 1].price : startPrice;
        const priceM2 = tradesM2.length ? tradesM2[tradesM2.length - 1].price : f.price;

        const gainM1 = ((priceM1 - startPrice) / startPrice) * 100;
        const gainM2 = ((priceM2 - priceM1) / priceM1) * 100;
        const gainTotal = ((priceM2 - startPrice) / startPrice) * 100;

        const sumVol = (ts: TargetTrade[], side?: string) =>
          ts.reduce((acc, t) => (!side || t.side === side ? acc + (t.usd ?? 0) : acc), 0);

        const volBuyM1 = sumVol(tradesM1, 'buy');
        const volSellM1 = sumVol(tradesM1, 'sell');
        const volBuyM2 = sumVol(tradesM2, 'buy');
        const volSellM2 = sumVol(tradesM2, 'sell');
        const totBuy = volBuyM1 + volBuyM2;
        const totSell = volSellM1 + volSellM2;
        const ratio120 = totBuy / Math.max(totSell, 1);
        const accel = volBuyM2 / Math.max(volBuyM1, 1);

        let peak = startPrice;
        let maxDd = 0;
        let maxSingleSell = 0;
        for (const t of trades120) {
          if (t.price > peak) peak = t.price;
          else if (peak > 0) {
            const dd = ((peak - t.price) / peak) * 100;
            if (dd > maxDd) maxDd = dd;
          }
          if (t.side === 'sell' && (t.usd ?? 0) > maxSingleSell) {
            maxSingleSell = t.usd ?? 0;
          }
        }

        // S4 Gates: MinBuy $900, Accel >= 0.8x, MaxDD <= 2.2%, MaxSell <= $40, B/S >= 4.0x
        if (gainM1 < 2.2) reasons.push('STEP1_GAIN_TOO_LOW');
        if (gainM1 > 20.0) reasons.push('STEP1_GAIN_TOO_HIGH_PUMP');
        if (gainM2 < 2.0) reasons.push('STEP2_HIGHER_HIGH_NOT_MET');
        if (gainTotal < 5.5) reasons.push('TOTAL_120S_GAIN_TOO_LOW');
        if (gainTotal > 35.0) reasons.push('TOTAL_120S_GAIN_OVEREXTENDED');

        if (totBuy < 900) reasons.push('TOTAL_VOLUME_TOO_LOW');
        if (accel < 0.8) reasons.push('STEP2_VOLUME_DECELERATING');
        if (ratio120 < 4.0) reasons.push('BUY_SELL_RATIO_TOO_LOW');
        if (maxDd > 2.2) reasons.push('MAX_DRAWDOWN_EXCEEDED');
        if (maxSingleSell > 40) reasons.push('LARGE_SELL_DETECTED');

        if (f.holderDeclineEverSeen) reasons.push('HOLDER_DECLINE_EVER_SEEN');
        if (f.devHoldingSharePercent != null && f.devHoldingSharePercent > 2.5) {
          reasons.push('DEV_HOLDING_TOO_HIGH');
        }

        return reasons;
      },
    });
  }
}

// --- Implementation S1.2: Fast Strike Staircase (TP +25%, Observation 30s) ---
export const STAIRCASE_LANE_S1_V2 = 'distribution-staircase-s1-v2';
export const STAIRCASE_RULES_S1_V2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-staircase-s1-v2',
  paperOnly: true,
  enabled: true,
  targetPercent: 25,
  observationSeconds: 30, // 30s observasi cepat
  minTransferAgeSeconds: 15,
  maxTransferLagSeconds: 60,
  maxEntryWaitSeconds: 90,
  confirmSeconds: 1,
  minBuySharePercent: 60,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 100,
  maxEntryReturnPercent: 100,
  maxDrawdownPercent: 5.0, // Toleransi 5% drawdown
  stopLossPercent: 8,
  trailingStartPercent: 15,
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

export class DistributionStaircaseLaneS1_v2 extends BaseDistributionStaircaseLane {
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...STAIRCASE_RULES_S1_V2 }, e => emit({ ...e, laneLabel: 'S1.2' as any, targetPercent: 25 }), {
      name: 'staircase-fast-s1-2',
      paperLane: STAIRCASE_LANE_S1_V2,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');

        const t0 = this.firstTradeAt ?? f.firstAt;
        if (t0 === null) { reasons.push('AWAITING_FIRST_TRADE'); return reasons; }

        const elapsedMs = f.now - t0;
        if (elapsedMs < 30_000) {
          reasons.push(`STAIRCASE_OBSERVING_30S_${Math.floor(elapsedMs / 1000)}S`);
          return reasons;
        }
        if (elapsedMs > r.maxEntryWaitSeconds * 1000) { reasons.push('ENTRY_WINDOW_EXPIRED'); return reasons; }
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
          return reasons;
        }

        // Higher Low check
        if (this.trades.length < 3) reasons.push('INSUFFICIENT_TRADES');
        return reasons;
      },
    });
  }
}
