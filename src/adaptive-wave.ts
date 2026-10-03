export const ADAPTIVE_WAVE_RULES = Object.freeze({
  version: 'adaptive-wave-v1',
  hardGates: {
    mcUsd: [10000, 100000],
    minAgeSec: 60,
    minHolders: 100,
    maxTop1Pct: 8.0,
    maxTop5Pct: 25.0,
    maxDevPct: 2.5,
    maxDevSell30sUsd: 25
  },
  momentumEntry: {
    return5sPct: [0.5, 15.0],
    minTrades5s: 5,
    minBuyers5s: 4,
    minBuyUsd5s: 300,
    maxTopBuyerShare: 0.50,
    minBuyShare5s: 0.60,
    adaptiveBuyShare20s: {
      base: 0.65,
      highVolatilityThreshold: 5.0,
      highVolatilityReq: 0.70
    },
    maxDrawdown5sPct: 2.5
  },
  adaptiveExit: {
    hardStopNetPct: -6.0,
    flashCrash1sPct: -8.0,
    stagnation: {
      minHoldSec: 15,
      maxPeakPct: 3.0,
      breakFlowShare: 0.50
    },
    breakeven: {
      activationPeakPct: 8.0,
      floorNetPct: 1.5
    },
    trailing: [
      { peakMin: 12.0, peakMax: 20.0, trailDistPct: 5.0 },
      { peakMin: 20.0, peakMax: 50.0, trailDistPct: 10.0 },
      { peakMin: 50.0, peakMax: 999.0, trailDistPct: 8.0 }
    ],
    contextualTp: {
      minNetPct: 20.0,
      flowReversalShare: 0.50
    }
  },
  riskManagement: {
    minStakeUsd: 5.0,
    maxCostRoundtripPct: 3.0
  }
});

// A pure function to evaluate entry
export function assessAdaptiveEntry(features: any) {
  const rules = ADAPTIVE_WAVE_RULES;
  const reasons: string[] = [];

  // 1. Hard Gates
  const mc = features.screenedMc;
  if (mc == null || mc < rules.hardGates.mcUsd[0] || mc > rules.hardGates.mcUsd[1]) reasons.push('MC_OUT_OF_BOUNDS');
  
  const age = features.tokenAgeSec;
  if (age == null || age < rules.hardGates.minAgeSec) reasons.push('AGE_LT_60S');

  const holders = features.holders;
  if (holders != null && holders < rules.hardGates.minHolders) reasons.push('HOLDERS_LT_100');

  const top1 = features.top1;
  if (top1 != null && top1 > rules.hardGates.maxTop1Pct) reasons.push('TOP1_GT_LIMIT');

  const top5 = features.top5;
  if (top5 != null && top5 > rules.hardGates.maxTop5Pct) reasons.push('TOP5_GT_LIMIT');

  const dev = features.dev;
  if (dev != null && dev > rules.hardGates.maxDevPct) reasons.push('DEV_GT_LIMIT');

  const devSell = features.developerSellUsd30s;
  if (devSell != null && devSell >= rules.hardGates.maxDevSell30sUsd) reasons.push('DEV_SELL_30S_GT_LIMIT');

  // 2. Momentum Gates
  const r5s = features.return5s;
  if (r5s == null || r5s < rules.momentumEntry.return5sPct[0] || r5s > rules.momentumEntry.return5sPct[1]) reasons.push('RETURN5S_OUT_OF_BOUNDS');

  const slope = features.slope5s;
  if (slope == null || slope <= 0) reasons.push('SLOPE_LE_0');

  const dd5s = features.drawdown5s;
  if (dd5s != null && dd5s > rules.momentumEntry.maxDrawdown5sPct) reasons.push('DRAWDOWN5S_GT_LIMIT');

  const trades = features.trades5s;
  if (trades != null && trades < rules.momentumEntry.minTrades5s) reasons.push('TRADES5S_LT_LIMIT');

  const buyers = features.buyers;
  if (buyers != null && buyers < rules.momentumEntry.minBuyers5s) reasons.push('BUYERS_LT_LIMIT');

  const buyUsd = features.buyUsd5s;
  if (buyUsd != null && buyUsd < rules.momentumEntry.minBuyUsd5s) reasons.push('BUY_USD_LT_LIMIT');

  const topBuyer = features.topBuyerShare;
  if (topBuyer != null && topBuyer > rules.momentumEntry.maxTopBuyerShare) reasons.push('TOP_BUYER_GT_LIMIT');

  const bs5 = features.buyShare5s;
  if (bs5 == null || bs5 < rules.momentumEntry.minBuyShare5s) reasons.push('BUY_SHARE_5S_LT_LIMIT');

  const bs20 = features.buyShare20s;
  // Adaptive Buy Share 20s
  if (r5s != null && bs20 != null) {
    const req = r5s >= rules.momentumEntry.adaptiveBuyShare20s.highVolatilityThreshold 
      ? rules.momentumEntry.adaptiveBuyShare20s.highVolatilityReq * 100
      : rules.momentumEntry.adaptiveBuyShare20s.base * 100;
    if (bs20 < req) reasons.push('ADAPTIVE_BUY_SHARE_20S_FAIL');
  } else if (bs20 == null) {
    reasons.push('BUY_SHARE_20S_MISSING');
  }

  return { allowed: reasons.length === 0, reasons };
}

// A pure function to evaluate dynamic exit on net returns
export function assessAdaptiveExit(
  now: number, 
  openedAt: number, 
  netReturnPct: number, 
  peakNetReturnPct: number, 
  socketReturnPct: number, 
  socketCollapse1s: number | null, 
  sellShare5s: number, 
  sellUsd5s: number, 
  sellers5s: number, 
  buyShare5s: number, 
  slope5s: number
): string | null {
  const rules = ADAPTIVE_WAVE_RULES.adaptiveExit;
  const holdSec = (now - openedAt) / 1000;

  // 1. Emergency Abort
  if (socketCollapse1s != null && socketCollapse1s <= rules.flashCrash1sPct && sellShare5s >= 0.70) return 'FLASH_CRASH_ABORT';
  if (netReturnPct <= rules.hardStopNetPct) return 'HARD_RISK_LIMIT';

  // 2. Flow Broken
  if (sellShare5s >= 0.70 && sellUsd5s >= 150 && sellers5s >= 3 && slope5s < 0) return 'FLOW_BROKEN';

  // 3. Stagnation
  if (holdSec >= rules.stagnation.minHoldSec && peakNetReturnPct < rules.stagnation.maxPeakPct && buyShare5s < rules.stagnation.breakFlowShare) return 'STAGNATION_DECAY';

  // 4. Time Limit
  if (holdSec >= 90) return 'MAX_HOLD_TIME';

  // 5. Contextual Take Profit
  if (netReturnPct >= rules.contextualTp.minNetPct && buyShare5s < rules.contextualTp.flowReversalShare) return 'CONTEXTUAL_TP';

  // 6. Adaptive Runner Trailing
  let activeFloor = -Infinity;
  if (peakNetReturnPct >= rules.breakeven.activationPeakPct) {
    activeFloor = Math.max(activeFloor, rules.breakeven.floorNetPct);
  }
  
  for (const t of rules.trailing) {
    if (peakNetReturnPct >= t.peakMin && peakNetReturnPct < t.peakMax) {
      const trailFloor = peakNetReturnPct - t.trailDistPct;
      activeFloor = Math.max(activeFloor, trailFloor);
    }
  }

  if (activeFloor !== -Infinity && netReturnPct <= activeFloor) {
    return peakNetReturnPct >= 12.0 ? 'ADAPTIVE_TRAILING_STOP' : 'BREAKEVEN_FLOOR';
  }

  return null;
}
