import {
  DistributionTargetLane,
  DEFAULT_TARGET_RULES,
  validateTargetRules,
  type TargetEvent,
  type TargetFacts,
  type TargetRules,
  type TargetTrade
} from './distribution-target-lane.js';

export const OEZANK_WALLET = 'D24y1SsG8dkjUxbgdFK62FKEerviuq6iQsXXuG8TiXcy';
export const OEZANK_LANE_OZ1 = 'distribution-oezank-oz1';
export const OEZANK_TARGET_PERCENT = 15; // Target TP rata-rata Oezank (+15%)
export const OEZANK_STOP_LOSS_PERCENT = 8; // SL disiplin (-8%)

export const OEZANK_RULES_OZ1: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  ...DEFAULT_TARGET_RULES,
  version: 'distribution-oezank-oz1',
  paperOnly: true,
  enabled: true,
  targetPercent: OEZANK_TARGET_PERCENT,
  observationSeconds: 5,
  minTransferAgeSeconds: 10,
  maxTransferLagSeconds: 120,
  maxEntryWaitSeconds: 1800,
  confirmSeconds: 1,
  minBuySharePercent: 50,
  minMeaningfulBuyUsd: 1,
  minMeaningfulBuyers: 1,
  maxBuyerSharePercent: 100,
  minMomentumPercent: 0,
  maxMomentumPercent: 200,
  maxEntryReturnPercent: 200,
  maxDrawdownPercent: 10.0,
  stopLossPercent: OEZANK_STOP_LOSS_PERCENT,
  trailingStartPercent: 10, // Trailing aktif di +10%
  trailingDrawdownPercent: 3, // Trail 3% dari peak
  maxHoldSeconds: 2700, // Maksimal hold 45 menit (sebelum timeout 60m bot GMGN)
  executionDelayMs: 500,
  maxFillWaitMs: 5000,
  feePercentPerSide: 1,
  slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005,
  stakeUsd: 15, // Stake sebanding ~$15 - $25 USD (0.1 - 0.2 SOL)
  blockKnownDumpSellers: false,
}));

export class DistributionOezankLaneOZ1 extends DistributionTargetLane {
  private initialTrades: TargetTrade[] = [];
  private entryBuyPrice: number | null = null;
  private entryTime: number | null = null;

  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...OEZANK_RULES_OZ1 }, e => emit({ ...e, laneLabel: 'OZ1' as any, targetPercent: OEZANK_TARGET_PERCENT }), {
      name: 'oezank-mirror-oz1',
      paperLane: OEZANK_LANE_OZ1,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 3000 || f.price < 0.000001 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
        }
        return reasons;
      },
    });
  }

  setInitialTrades(trades: TargetTrade[]) {
    this.initialTrades = [...trades];
  }

  onTrade(trade: TargetTrade) {
    if (this.entryBuyPrice === null && this.entryAt !== null) {
      this.entryBuyPrice = this.entryPrice || trade.price;
      this.entryTime = trade.timestamp ? (trade.timestamp * 1000) : trade.at;
    }
  }

  onOezankSold(now: number) {
    // Mirror Exit: Jika Oezank menjual tokennya di Solana on-chain, bot ikut exit seketika!
    if (this.phase !== 'CLOSED' && this.phase !== 'CENSORED') {
      this.end(now, 'OEZANK_TRADER_SOLD_MIRROR_EXIT');
    }
  }
}
