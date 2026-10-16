import { readFileSync, existsSync } from 'fs';
import {
  DistributionTargetLane,
  type TargetFacts,
  type TargetRules,
  type TargetEvent,
  type TargetTrade,
  validateTargetRules,
  DEFAULT_TARGET_RULES,
} from './distribution-target-lane.js';

export const SMART_MONEY_LANE_G2 = 'distribution-smart-money-g2';
export const SMART_MONEY_LANE_G2_1 = 'distribution-smart-money-g2.1';
export const SMART_MONEY_LANE_G2_2 = 'distribution-smart-money-g2.2';
export const SMART_MONEY_TARGET_PERCENT = 30;
export const SMART_MONEY_STOP_LOSS_PERCENT = 6;

// Load Watchlist Smart Money (117 Wallets)
let cachedSmartWallets: Set<string> | null = null;
export function getSmartWalletsWatchlist(): Set<string> {
  if (cachedSmartWallets) return cachedSmartWallets;
  const path = '/home/bbliong/project/crypto-bot/data/smart-wallets-watchlist.json';
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const list = (data.wallets || []).map((w: any) => w.address).filter(Boolean);
      cachedSmartWallets = new Set(list);
      return cachedSmartWallets;
    } catch {
      cachedSmartWallets = new Set();
      return cachedSmartWallets;
    }
  }
  cachedSmartWallets = new Set();
  return cachedSmartWallets;
}

// Rules G2.1: Single Smart Whale High-Conviction
export const SMART_MONEY_RULES_G2_1: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...DEFAULT_TARGET_RULES,
  version: 'distribution-smart-money-g2.1',
  paperOnly: true,
  enabled: true,
  targetPercent: SMART_MONEY_TARGET_PERCENT,
  observationSeconds: 5,
  minTransferAgeSeconds: 15,
  maxTransferLagSeconds: 120,
  maxEntryWaitSeconds: 3600,
  confirmSeconds: 1,
  minBuySharePercent: 50,
  minMeaningfulBuyUsd: 25,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 85,
  minMomentumPercent: 0.5,
  maxMomentumPercent: 150,
  maxEntryReturnPercent: 80,
  maxDrawdownPercent: 6.0,
  stopLossPercent: SMART_MONEY_STOP_LOSS_PERCENT,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 1200,
  executionDelayMs: 500,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

// Rules G2.2: Multi-Whale Convergence (>= 2 Wallets)
export const SMART_MONEY_RULES_G2_2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...DEFAULT_TARGET_RULES,
  version: 'distribution-smart-money-g2.2',
  paperOnly: true,
  enabled: true,
  targetPercent: SMART_MONEY_TARGET_PERCENT,
  observationSeconds: 10,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 120,
  maxEntryWaitSeconds: 3600,
  confirmSeconds: 1,
  minBuySharePercent: 55,
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 75,
  minMomentumPercent: 0.5,
  maxMomentumPercent: 150,
  maxEntryReturnPercent: 80,
  maxDrawdownPercent: 6.0,
  stopLossPercent: SMART_MONEY_STOP_LOSS_PERCENT,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 1200,
  executionDelayMs: 500,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export const SMART_MONEY_RULES_G2 = SMART_MONEY_RULES_G2_2;

// G2.1: Single Smart Whale
export class DistributionSmartMoneyLaneG2_1 extends DistributionTargetLane {
  private smartBuyersSeen = new Set<string>();

  constructor(mint: string, onEvent: (event: TargetEvent) => void) {
    super(
      mint,
      { ...SMART_MONEY_RULES_G2_1 },
      e => onEvent({ ...e, laneLabel: 'G2.1' as any, targetPercent: SMART_MONEY_TARGET_PERCENT }),
      {
        name: SMART_MONEY_LANE_G2_1,
        overrideEntryReasons: (facts: TargetFacts, rules: TargetRules) => this.evaluateSmartMoneyEntry(facts, rules),
      }
    );
  }

  public registerSmartWallet(wallet?: string) {
    if (!wallet) return;
    const watchlist = getSmartWalletsWatchlist();
    if (watchlist.has(wallet)) {
      this.smartBuyersSeen.add(wallet);
    }
  }

  public setInitialTrades(trades: TargetTrade[]) {
    const watchlist = getSmartWalletsWatchlist();
    for (const t of trades) {
      if (t.side === 'buy' && t.wallet && watchlist.has(t.wallet)) {
        this.smartBuyersSeen.add(t.wallet);
      }
    }
  }

  public recordLiveTrade(trade: TargetTrade) {
    const watchlist = getSmartWalletsWatchlist();
    if (trade.side === 'buy' && trade.wallet && watchlist.has(trade.wallet)) {
      this.smartBuyersSeen.add(trade.wallet);
    }
  }

  public onTrade(trade: TargetTrade) {
    this.recordLiveTrade(trade);
  }

  private evaluateSmartMoneyEntry(f: TargetFacts, r: TargetRules): string[] {
    const reasons: string[] = [];
    if (!r.enabled) reasons.push('LANE_DISABLED');

    if (this.smartBuyersSeen.size < 1) {
      reasons.push('NO_SMART_MONEY_BUYER(0/1)');
    }

    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 3000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
      reasons.push('PRICE_MISSING_OR_STALE');
    }

    if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 10.0) {
      reasons.push('DEV_HOLDING_TOO_HIGH_FOR_SMART_ENTRY');
    }

    if (f.drawdownPercent !== null && f.drawdownPercent > r.maxDrawdownPercent) {
      reasons.push('DRAWDOWN_EXCEEDED');
    }

    return reasons;
  }
}

// G2.2: Multi-Whale Convergence
export class DistributionSmartMoneyConvergenceLaneG2_2 extends DistributionTargetLane {
  private smartBuyersSeen = new Set<string>();

  constructor(mint: string, onEvent: (event: TargetEvent) => void, customLabel: string = 'G2.2') {
    super(
      mint,
      { ...SMART_MONEY_RULES_G2_2 },
      e => onEvent({ ...e, laneLabel: customLabel as any, targetPercent: SMART_MONEY_TARGET_PERCENT }),
      {
        name: SMART_MONEY_LANE_G2_2,
        overrideEntryReasons: (facts: TargetFacts, rules: TargetRules) => this.evaluateSmartMoneyEntry(facts, rules),
      }
    );
  }

  public registerSmartWallet(wallet?: string) {
    if (!wallet) return;
    const watchlist = getSmartWalletsWatchlist();
    if (watchlist.has(wallet)) {
      this.smartBuyersSeen.add(wallet);
    }
  }

  public setInitialTrades(trades: TargetTrade[]) {
    const watchlist = getSmartWalletsWatchlist();
    for (const t of trades) {
      if (t.side === 'buy' && t.wallet && watchlist.has(t.wallet)) {
        this.smartBuyersSeen.add(t.wallet);
      }
    }
  }

  public recordLiveTrade(trade: TargetTrade) {
    const watchlist = getSmartWalletsWatchlist();
    if (trade.side === 'buy' && trade.wallet && watchlist.has(trade.wallet)) {
      this.smartBuyersSeen.add(trade.wallet);
    }
  }

  public onTrade(trade: TargetTrade) {
    this.recordLiveTrade(trade);
  }

  private evaluateSmartMoneyEntry(f: TargetFacts, r: TargetRules): string[] {
    const reasons: string[] = [];
    if (!r.enabled) reasons.push('LANE_DISABLED');

    if (this.smartBuyersSeen.size < 2) {
      reasons.push(`INSUFFICIENT_SMART_MONEY_CONVERGENCE(${this.smartBuyersSeen.size}/2)`);
    }

    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 3000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
      reasons.push('PRICE_MISSING_OR_STALE');
    }

    if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 5.0) {
      reasons.push('DEV_HOLDING_TOO_HIGH_FOR_SMART_ENTRY');
    }

    if (f.drawdownPercent !== null && f.drawdownPercent > r.maxDrawdownPercent) {
      reasons.push('DRAWDOWN_EXCEEDED');
    }

    return reasons;
  }
}

// Backward-compatible alias G2
export class DistributionSmartMoneyConvergenceLaneG2 extends DistributionSmartMoneyConvergenceLaneG2_2 {
  constructor(mint: string, onEvent: (event: TargetEvent) => void) {
    super(mint, onEvent, 'G2');
  }
}
