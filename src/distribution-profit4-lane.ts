import { DistributionTargetLane, validateTargetRules, type TargetEvent, type TargetFacts, type TargetRules } from './distribution-target-lane.js';

export const PROFIT4_LANE = 'distribution-profit4';
export const PROFIT4_TARGET_PERCENT = 4;
/** Matches the single-round historical candidate, including its cost assumptions. */
export const PROFIT4_RULES: Readonly<TargetRules> = Object.freeze(validateTargetRules({
  version: 'distribution-profit4-v1', paperOnly: true, enabled: true, targetPercent: 25,
  observationSeconds: 30, minTransferAgeSeconds: 30, maxTransferLagSeconds: 15,
  maxEntryWaitSeconds: 180, confirmSeconds: 1, minBuySharePercent: 50,
  minMeaningfulBuyUsd: 5, minMeaningfulBuyers: 1, maxBuyerSharePercent: 100,
  minMomentumPercent: 0.3, maxMomentumPercent: 5, maxEntryReturnPercent: 15,
  maxDrawdownPercent: 5, stopLossPercent: 5, trailingStartPercent: 10,
  trailingDrawdownPercent: 4, maxHoldSeconds: 300, executionDelayMs: 1000,
  maxFillWaitMs: 5000, feePercentPerSide: 1, slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005, stakeUsd: 5, blockKnownDumpSellers: false,
}));

export class DistributionProfit4Lane extends DistributionTargetLane {
  private dumpObserved = false;
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, { ...PROFIT4_RULES }, e => emit({ ...e, targetPercent: PROFIT4_TARGET_PERCENT }), {
      name: 'single-round-net4', paperLane: PROFIT4_LANE,
      trailingEnabled: false, flowExitEnabled: false,
      exitReason: (_f, net) => net >= PROFIT4_TARGET_PERCENT ? 'TARGET_NET_4' : null,
    });
  }
  override step(f: TargetFacts) {
    if (f.drawdownPercent !== null && f.drawdownPercent >= 70) this.dumpObserved = true;
    if (this.dumpObserved && this.entryAt === null) { this.end(f.now, 'DUMP_ALREADY_OBSERVED'); return; }
    // Don't fill pending orders using a quote from after this decision.
    if (f.priceAt !== null && f.priceAt > f.now) f = { ...f, price: null, priceAt: null };
    super.step(f);
  }
}
