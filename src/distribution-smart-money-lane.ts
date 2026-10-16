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
export const SMART_MONEY_TARGET_PERCENT = 30;
export const SMART_MONEY_STOP_LOSS_PERCENT = 6;

// Load Watchlist Smart Money
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

export const SMART_MONEY_RULES_G2: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...DEFAULT_TARGET_RULES,
  version: 'distribution-smart-money-g2',
  paperOnly: true,
  enabled: true,
  targetPercent: SMART_MONEY_TARGET_PERCENT,
  observationSeconds: 10,
  minTransferAgeSeconds: 30,
  maxTransferLagSeconds: 120,
  maxEntryWaitSeconds: 3600, // Smart money bisa akumulasi hingga 1 jam
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
  trailingStartPercent: 15, // Kunci trailing jika sudah naik +15%
  trailingDrawdownPercent: 5,
  maxHoldSeconds: 1200, // Hold maksimal 20 menit
  executionDelayMs: 500,
  maxFillWaitMs: 3000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 5,
  blockKnownDumpSellers: false,
}));

export class DistributionSmartMoneyConvergenceLaneG2 extends DistributionTargetLane {
  private initialTrades: TargetTrade[] = [];
  private smartBuyersSeen = new Set<string>();

  constructor(mint: string, onEvent: (event: TargetEvent) => void) {
    super(
      mint,
      { ...SMART_MONEY_RULES_G2 },
      e => onEvent({ ...e, laneLabel: 'G2' as any, targetPercent: SMART_MONEY_TARGET_PERCENT }),
      {
        name: SMART_MONEY_LANE_G2,
        overrideEntryReasons: (facts: TargetFacts, rules: TargetRules) => this.evaluateSmartMoneyEntry(facts, rules),
      }
    );
  }

  public setInitialTrades(trades: TargetTrade[]) {
    this.initialTrades = [...trades];
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

    // 1. Validasi Smart Money Convergence: Minimal 2 wallet pintar akumulasi
    if (this.smartBuyersSeen.size < 2) {
      reasons.push(`INSUFFICIENT_SMART_MONEY_CONVERGENCE(${this.smartBuyersSeen.size}/2)`);
    }

    // 2. Proteksi Harga Realistis
    if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 3000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
      reasons.push('PRICE_MISSING_OR_STALE');
    }

    // 3. Proteksi Anti Dev Dump: Dev tidak boleh pegang > 5% supply saat Smart Money masuk
    if (typeof f.devHoldingSharePercent === 'number' && f.devHoldingSharePercent > 5.0) {
      reasons.push('DEV_HOLDING_TOO_HIGH_FOR_SMART_ENTRY');
    }

    // 4. Syarat Buy Flow
    if (f.buyShareUsdPercent === null || f.buyShareUsdPercent < r.minBuySharePercent) {
      reasons.push('BUY_FLOW_WEAK');
    }

    // 5. Drawdown guard
    if (f.drawdownPercent !== null && f.drawdownPercent > r.maxDrawdownPercent) {
      reasons.push('DRAWDOWN_EXCEEDED');
    }

    return reasons;
  }
}
