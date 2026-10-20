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
export const SMART_MONEY_TARGET_PERCENT = 25;
export const SMART_MONEY_STOP_LOSS_PERCENT = 10;

export interface SmartWalletMeta {
  address: string;
  tags: string[];
  trades30d: number;
  realizedProfit30dUsd: number;
  totalProfitUsd: number;
  solBalance: number;
  isConviction: boolean; // trades30d < 500 && not pure sniper
  isSniper: boolean;     // trades30d >= 500 || tags.includes('sniper')
}

// Load Watchlist Smart Money (117 Wallets) & Metadata
let cachedSmartWallets: Set<string> | null = null;
let cachedWalletMeta: Map<string, SmartWalletMeta> | null = null;

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

export function getSmartWalletMetaMap(): Map<string, SmartWalletMeta> {
  if (cachedWalletMeta) return cachedWalletMeta;
  const path = '/home/bbliong/project/crypto-bot/data/smart-wallets-watchlist.json';
  cachedWalletMeta = new Map();
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      for (const w of (data.wallets || [])) {
        if (!w.address) continue;
        const txs = Number(w.trades30d || 0);
        const tags = Array.isArray(w.tags) ? w.tags : [];
        const isSniper = txs >= 500 || tags.includes('sniper');
        const isConviction = !isSniper && txs < 500;
        cachedWalletMeta.set(w.address, {
          address: w.address,
          tags,
          trades30d: txs,
          realizedProfit30dUsd: Number(w.realizedProfit30dUsd || 0),
          totalProfitUsd: Number(w.totalProfitUsd || 0),
          solBalance: Number(w.solBalance || 0),
          isConviction,
          isSniper,
        });
      }
    } catch {
      // ignore read error
    }
  }
  return cachedWalletMeta;
}

// Rules G2.1: Single Smart Whale High-Conviction (Optimal Revamp)
export const SMART_MONEY_RULES_G2_1: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...DEFAULT_TARGET_RULES,
  version: 'distribution-smart-money-g2.1-v2',
  paperOnly: true,
  enabled: true,
  targetPercent: SMART_MONEY_TARGET_PERCENT, // 25% target profit
  observationSeconds: 5,
  minTransferAgeSeconds: 10,
  maxTransferLagSeconds: 180,
  maxEntryWaitSeconds: 3600,
  confirmSeconds: 1,
  minBuySharePercent: 45,
  minMeaningfulBuyUsd: 50,                  // Minimum buy smart money $50 USD
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0.0,
  maxMomentumPercent: 100.0,
  maxEntryReturnPercent: 40.0,
  maxDrawdownPercent: 10.0,
  stopLossPercent: SMART_MONEY_STOP_LOSS_PERCENT, // 10% stop loss
  trailingStartPercent: 15,                 // Mulai trailing di +15%
  trailingDrawdownPercent: 5,               // Trailing 5% dari peak
  maxHoldSeconds: 3600,                     // 1 Jam (menghindari timeout prematur 20 menit)
  executionDelayMs: 400,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 10,
  blockKnownDumpSellers: false,
}));

// Rules G2.2: Multi-Whale Convergence (>= 2 Wallets)
export const SMART_MONEY_RULES_G2_2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...DEFAULT_TARGET_RULES,
  version: 'distribution-smart-money-g2.2-v2',
  paperOnly: true,
  enabled: true,
  targetPercent: SMART_MONEY_TARGET_PERCENT,
  observationSeconds: 5,
  minTransferAgeSeconds: 10,
  maxTransferLagSeconds: 180,
  maxEntryWaitSeconds: 3600,
  confirmSeconds: 1,
  minBuySharePercent: 45,
  minMeaningfulBuyUsd: 50,
  minMeaningfulBuyers: 2,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0.0,
  maxMomentumPercent: 100.0,
  maxEntryReturnPercent: 50.0,
  maxDrawdownPercent: 10.0,
  stopLossPercent: SMART_MONEY_STOP_LOSS_PERCENT,
  trailingStartPercent: 15,
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 3600,
  executionDelayMs: 400,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 10,
  blockKnownDumpSellers: false,
}));

export const SMART_MONEY_RULES_G2 = SMART_MONEY_RULES_G2_2;

// G2.1: Single Smart Whale High-Conviction
export class DistributionSmartMoneyLaneG2_1 extends DistributionTargetLane {
  private smartBuyersSeen = new Map<string, number>();

  constructor(mint: string, onEvent: (event: TargetEvent) => void) {
    super(
      mint,
      { ...SMART_MONEY_RULES_G2_1 },
      e => onEvent({ ...e, laneLabel: 'G2.1' as any, targetPercent: SMART_MONEY_TARGET_PERCENT }),
      {
        name: SMART_MONEY_LANE_G2_1,
        flowExitEnabled: false,      // NONAKTIFKAN PANIC EXIT $250!
        trailingEnabled: true,
        prioritizeCustomExit: true,
        overrideEntryReasons: (facts: TargetFacts, rules: TargetRules) => this.evaluateSmartMoneyEntry(facts, rules),
      }
    );
  }

  public registerSmartWallet(wallet?: string, buyUsd?: number) {
    if (!wallet) return;
    const watchlist = getSmartWalletsWatchlist();
    if (watchlist.has(wallet)) {
      const cur = this.smartBuyersSeen.get(wallet) ?? 0;
      this.smartBuyersSeen.set(wallet, Math.max(cur, buyUsd ?? 50));
    }
  }

  public setInitialTrades(trades: TargetTrade[]) {
    const watchlist = getSmartWalletsWatchlist();
    for (const t of trades) {
      if (t.side === 'buy' && t.wallet && watchlist.has(t.wallet)) {
        const cur = this.smartBuyersSeen.get(t.wallet) ?? 0;
        this.smartBuyersSeen.set(t.wallet, Math.max(cur, t.usd ?? 0));
      }
    }
  }

  public recordLiveTrade(trade: TargetTrade) {
    const watchlist = getSmartWalletsWatchlist();
    if (trade.side === 'buy' && trade.wallet && watchlist.has(trade.wallet)) {
      const cur = this.smartBuyersSeen.get(trade.wallet) ?? 0;
      this.smartBuyersSeen.set(trade.wallet, Math.max(cur, trade.usd ?? 0));
    }
  }

  public onTrade(trade: TargetTrade) {
    this.recordLiveTrade(trade);
  }

  public evaluateSmartMoneyEntry(f: TargetFacts, r: TargetRules): string[] {
    const reasons: string[] = [];
    if (!r.enabled) reasons.push('LANE_DISABLED');

    if (this.smartBuyersSeen.size < 1) {
      reasons.push('NO_SMART_MONEY_BUYER(0/1)');
      return reasons;
    }

    const metaMap = getSmartWalletMetaMap();
    let hasConvictionWhale = false;
    let maxBuyUsd = 0;

    for (const [wallet, usd] of this.smartBuyersSeen.entries()) {
      if (usd > maxBuyUsd) maxBuyUsd = usd;
      const meta = metaMap.get(wallet);
      if (!meta || meta.isConviction) {
        hasConvictionWhale = true;
      }
    }

    // Filter 1: Anti-Sniper Bot (Tolak jika SEMUA smart buyer adalah sniper bot)
    if (!hasConvictionWhale) {
      reasons.push('HFT_SNIPER_BOT_IGNORED');
    }

    // Filter 2: Min Buy Size $50 USD
    if (maxBuyUsd < r.minMeaningfulBuyUsd) {
      reasons.push(`INSUFFICIENT_SMART_MONEY_SIZE($${maxBuyUsd.toFixed(1)}<$${r.minMeaningfulBuyUsd})`);
    }

    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 3000 || f.price < 0.0000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
      reasons.push('PRICE_MISSING_OR_STALE');
    }

    if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 8.0) {
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
  private smartBuyersSeen = new Map<string, number>();

  constructor(mint: string, onEvent: (event: TargetEvent) => void, customLabel: string = 'G2.2') {
    super(
      mint,
      { ...SMART_MONEY_RULES_G2_2 },
      e => onEvent({ ...e, laneLabel: customLabel as any, targetPercent: SMART_MONEY_TARGET_PERCENT }),
      {
        name: SMART_MONEY_LANE_G2_2,
        flowExitEnabled: false,      // NONAKTIFKAN PANIC EXIT $250!
        trailingEnabled: true,
        prioritizeCustomExit: true,
        overrideEntryReasons: (facts: TargetFacts, rules: TargetRules) => this.evaluateSmartMoneyEntry(facts, rules),
      }
    );
  }

  public registerSmartWallet(wallet?: string, buyUsd?: number) {
    if (!wallet) return;
    const watchlist = getSmartWalletsWatchlist();
    if (watchlist.has(wallet)) {
      const cur = this.smartBuyersSeen.get(wallet) ?? 0;
      this.smartBuyersSeen.set(wallet, Math.max(cur, buyUsd ?? 50));
    }
  }

  public setInitialTrades(trades: TargetTrade[]) {
    const watchlist = getSmartWalletsWatchlist();
    for (const t of trades) {
      if (t.side === 'buy' && t.wallet && watchlist.has(t.wallet)) {
        const cur = this.smartBuyersSeen.get(t.wallet) ?? 0;
        this.smartBuyersSeen.set(t.wallet, Math.max(cur, t.usd ?? 0));
      }
    }
  }

  public recordLiveTrade(trade: TargetTrade) {
    const watchlist = getSmartWalletsWatchlist();
    if (trade.side === 'buy' && trade.wallet && watchlist.has(trade.wallet)) {
      const cur = this.smartBuyersSeen.get(trade.wallet) ?? 0;
      this.smartBuyersSeen.set(trade.wallet, Math.max(cur, trade.usd ?? 0));
    }
  }

  public onTrade(trade: TargetTrade) {
    this.recordLiveTrade(trade);
  }

  public evaluateSmartMoneyEntry(f: TargetFacts, r: TargetRules): string[] {
    const reasons: string[] = [];
    if (!r.enabled) reasons.push('LANE_DISABLED');

    if (this.smartBuyersSeen.size < 2) {
      reasons.push(`INSUFFICIENT_SMART_MONEY_CONVERGENCE(${this.smartBuyersSeen.size}/2)`);
      return reasons;
    }

    const metaMap = getSmartWalletMetaMap();
    let convictionWhaleCount = 0;
    let totalSmartBuyUsd = 0;

    for (const [wallet, usd] of this.smartBuyersSeen.entries()) {
      totalSmartBuyUsd += usd;
      const meta = metaMap.get(wallet);
      if (!meta || meta.isConviction) {
        convictionWhaleCount++;
      }
    }

    if (convictionWhaleCount < 1) {
      reasons.push('NO_CONVICTION_WHALE_IN_CONVERGENCE');
    }

    if (totalSmartBuyUsd < 100) {
      reasons.push(`INSUFFICIENT_CONVERGENCE_VOLUME($${totalSmartBuyUsd.toFixed(1)}<$100)`);
    }

    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 3000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
      reasons.push('PRICE_MISSING_OR_STALE');
    }

    if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 8.0) {
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
