export type SimulationExitReason = import('./momentum-strategy.js').MomentumExitReason | 'V3_EXIT_DEV_DUMP' | 'V3_EXIT_IMMEDIATE_WHALE_SELL' | 'V3_EXIT_CONFIRMED_WHALE_SELL' | 'V3_EXIT_PROFIT_TRAIL' | 'TARGET_40' | 'TARGET_40_HOLDER_FLAT' | 'TARGET_DYNAMIC' | 'TRAILING_10' | 'TRAILING_TIERED' | 'BREAKEVEN_GUARD' | 'EARLY_CUT_LOSS' | 'STOP_LOSS_20' | 'SELL_PRESSURE' | 'PROFIT_STAGNATION_10S' | 'PROFIT_STAGNATION_25S' | 'MOMENTUM_EXHAUSTION_5S' | 'DEV_DUMP_EXIT' | 'TOP_HOLDER_DUMP' | 'OBSERVATION_END' | 'PUMP_DUMP_20' | 'PUMP_OBSERVATION_END';

export interface SimulationPosition {
  mint: string;
  openedAt: number;
  entryPriceUsd: number;
  stakeUsd: number;
  quantity: number;
  peakPriceUsd: number;
  pressureWindows: number;
  lastPressureWindowStart: number | null;
}

export interface TradeWindow {
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  uniqueSellers: number;
  /** Start of the completed 5-second socket window, when available. */
  windowStart?: number;
}

export interface SimulationDecision {
  returnPercent: number;
  peakReturnPercent: number;
  drawdownFromPeakPercent: number;
  sellSharePercent: number | null;
  pressureWindow: boolean;
  exitReason: SimulationExitReason | null;
}

export interface SimulationGuards {
  suppressSellPressure?: boolean;
  deferTargetForHolderMomentum?: boolean;
  /** The collector performs the two-source hard-stop confirmation itself. */
  suppressHardStop?: boolean;
}

export interface PriceSample {
  observedAt: number;
  priceUsd: number;
}

export interface EntryStability {
  stable: boolean;
  reason: 'INSUFFICIENT_PRICE_DATA' | 'INSUFFICIENT_PRICE_CONFIRMATION' | 'CONTINUING_PRICE_DROP' | 'STABLE_OR_RECOVERING';
  momentum5sPercent: number | null;
  consecutiveDeclines: number;
  distinctPriceCount: number;
}

export interface McapCandle {
  time: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

export interface CandleHistoryDecision {
  allowed: boolean;
  reason: 'NO_CANDLE_DATA' | 'SINGLE_CANDLE_ONLY' | 'INSUFFICIENT_CANDLES' | 'PUMP_THEN_DUMP' | 'SHARP_CANDLE_CRASH' | 'THREE_RED_CANDLES' | 'CANDLE_HISTORY_OK';
  peakToLastDrawdownPercent: number | null;
  consecutiveRedCandles: number;
  largestGreenCandlePercent: number | null;
  largestRedCandlePercent: number | null;
}

export interface CandleEntryFlowDecision {
  allowed: boolean;
  reason: 'INSUFFICIENT_COMPLETED_CANDLES' | 'CURRENT_CANDLE_DROP' | 'CANDLE_ENTRY_FLOW_OK';
  completedCandles: number;
  currentCandleReturnPercent: number | null;
}

export interface SingleCandleHolderOverrideDecision {
  allowed: boolean;
  reason: 'SINGLE_CANDLE_HOLDER_GROWTH_OK' | 'NOT_SINGLE_CANDLE' | 'HOLDERS_NOT_ABOVE_100' | 'HOLDER_GROWTH_NOT_SIGNIFICANT_OR_FRESH';
}

export interface BlindProtectionDecision {
  allowed: boolean;
  reason: 'HOLDERS_VERIFIED' | 'BLIND_PROTECTION_HOLDERS_429' | 'BLIND_PROTECTION_NO_HOLDERS' | 'MATURE_TOKEN_EXEMPT';
  holderStatus: number | null;
  holderCount: number;
}

export interface EarlyCandleRisingDecision {
  allowed: boolean;
  reason: 'NOT_EARLY_CANDLE' | 'CANDLE_NOT_RISING' | 'CURRENT_CANDLE_DROP' | 'INSUFFICIENT_HOLDERS' | 'EARLY_CANDLE_RISING_OK';
  returnPercent: number | null;
}

/**
 * Newly launched tokens with only 1 or 2 candles can be allowed if the candle
 * data is actively rising (green candle, return >= 0%, no dump) and the token has
 * at least the minimum required holders (default: 20). Realtime price stability and
 * trade flow gates in the collector still apply.
 */
export function assessEarlyCandleRising(
  candles: McapCandle[],
  candleDecision: CandleHistoryDecision | null,
  candleEntryFlow: CandleEntryFlowDecision | null,
  holderCount: number | null,
  minHolders = 20,
): EarlyCandleRisingDecision {
  const isEarly = candleDecision?.reason === 'SINGLE_CANDLE_ONLY' || candleDecision?.reason === 'INSUFFICIENT_CANDLES';
  if (!isEarly) return { allowed: false, reason: 'NOT_EARLY_CANDLE', returnPercent: null };
  if (candleEntryFlow?.reason === 'CURRENT_CANDLE_DROP') {
    return { allowed: false, reason: 'CURRENT_CANDLE_DROP', returnPercent: candleEntryFlow.currentCandleReturnPercent };
  }
  if (!candles || candles.length === 0) return { allowed: false, reason: 'CANDLE_NOT_RISING', returnPercent: null };
  const latest = candles.at(-1)!;
  const returnPercent = latest.open > 0 ? ((latest.close / latest.open) - 1) * 100 : 0;
  if (latest.close < latest.open || returnPercent < 0) {
    return { allowed: false, reason: 'CANDLE_NOT_RISING', returnPercent };
  }
  if (candles.length === 2 && latest.close < candles[0]!.open) {
    return { allowed: false, reason: 'CANDLE_NOT_RISING', returnPercent };
  }
  if (holderCount === null || holderCount < minHolders) {
    return { allowed: false, reason: 'INSUFFICIENT_HOLDERS', returnPercent };
  }
  return { allowed: true, reason: 'EARLY_CANDLE_RISING_OK', returnPercent };
}

/**
 * A very early launch has no meaningful candle history yet. It may enter only
 * when a fresh GMGN token-stat sample proves broadening demand: more than 100
 * holders and a verified significant holder increase. Price and trade-flow
 * gates in the collector still apply.
 */
export function assessSingleCandleHolderOverride(
  candleHistory: CandleHistoryDecision | null,
  holderCount: number | null,
  hasFreshSignificantHolderGrowth: boolean,
): SingleCandleHolderOverrideDecision {
  if (candleHistory?.reason !== 'SINGLE_CANDLE_ONLY') return { allowed: false, reason: 'NOT_SINGLE_CANDLE' };
  if (holderCount === null || holderCount <= 100) return { allowed: false, reason: 'HOLDERS_NOT_ABOVE_100' };
  if (!hasFreshSignificantHolderGrowth) return { allowed: false, reason: 'HOLDER_GROWTH_NOT_SIGNIFICANT_OR_FRESH' };
  return { allowed: true, reason: 'SINGLE_CANDLE_HOLDER_GROWTH_OK' };
}

/**
 * Safety Rule: Blind Protection
 * For young tokens (candle 1-2 / relying on early candle rising or single candle override),
 * buying without verified Top Holders and Developer data is a blind risk.
 * If the holder API returned 429 or returned 0 holders, buying is FORBIDDEN.
 */
export function assessBlindProtection(
  isYoungToken: boolean,
  holderStatus: number | null,
  holderCount: number,
): BlindProtectionDecision {
  if (!isYoungToken) {
    return { allowed: true, reason: 'MATURE_TOKEN_EXEMPT', holderStatus, holderCount };
  }
  if (holderStatus === 429) {
    return { allowed: false, reason: 'BLIND_PROTECTION_HOLDERS_429', holderStatus, holderCount };
  }
  if (holderCount <= 0 || holderStatus !== 200) {
    return { allowed: false, reason: 'BLIND_PROTECTION_NO_HOLDERS', holderStatus, holderCount };
  }
  return { allowed: true, reason: 'HOLDERS_VERIFIED', holderStatus, holderCount };
}

export interface HolderDistributionDecision {
  allowed: boolean;
  action: 'BUY' | 'WAIT_FOR_DILUTION' | 'REJECT';
  reason: string;
  holderCount: number;
  top1Percent: number;
  top5Percent: number;
  devPercent: number;
}

/**
 * Tiered Holder Distribution Gate:
 * Range 1 (20 - 39 holders): Very early. Must be highly balanced/decentralized (Top 1 <= 10%, Top 5 <= 32%, Dev <= 2%).
 *   If dominated, returns action: 'WAIT_FOR_DILUTION' ("Nanti Dulu"), continuing observation.
 * Range 2 (>= 40 holders): Established holder base. Standard thresholds (Top 1 <= 20%, Top 5 <= 50%, Dev <= 5%).
 *   If concentrated, returns action: 'REJECT'.
 */
export function assessHolderDistribution(
  holderCount: number,
  top1Percent: number,
  top5Percent: number,
  devPercent = 0
): HolderDistributionDecision {
  if (holderCount < 20) {
    return {
      allowed: false,
      action: 'REJECT',
      reason: 'HOLDERS_BELOW_20',
      holderCount,
      top1Percent,
      top5Percent,
      devPercent,
    };
  }

  // RANGE 1: 20 - 39 HOLDER (Wajib Sangat Merata)
  if (holderCount < 40) {
    if (top1Percent > 10 || top5Percent > 32 || devPercent > 2) {
      return {
        allowed: false,
        action: 'WAIT_FOR_DILUTION',
        reason: `EARLY_HOLDERS_DOMINATED (Top1: ${top1Percent.toFixed(1)}%, Top5: ${top5Percent.toFixed(1)}%, Dev: ${devPercent.toFixed(1)}%)`,
        holderCount,
        top1Percent,
        top5Percent,
        devPercent,
      };
    }
    return {
      allowed: true,
      action: 'BUY',
      reason: 'EARLY_DISTRIBUTION_BALANCED',
      holderCount,
      top1Percent,
      top5Percent,
      devPercent,
    };
  }

  // RANGE 2: >= 40 HOLDER (Standar)
  if (top1Percent > 20 || top5Percent > 50 || devPercent > 5) {
    return {
      allowed: false,
      action: 'REJECT',
      reason: `CONCENTRATED_SUPPLY (Top1: ${top1Percent.toFixed(1)}%, Top5: ${top5Percent.toFixed(1)}%, Dev: ${devPercent.toFixed(1)}%)`,
      holderCount,
      top1Percent,
      top5Percent,
      devPercent,
    };
  }

  return {
    allowed: true,
    action: 'BUY',
    reason: 'ESTABLISHED_DISTRIBUTION_OK',
    holderCount,
    top1Percent,
    top5Percent,
    devPercent,
  };
}

/**
 * Historical candles are useful only after their minute has closed.  The
 * current candle is treated separately so a fresh down-candle cannot satisfy
 * the “three candles” requirement by itself.
 */
export function assessCandleEntryFlow(candles: McapCandle[], now = Date.now()): CandleEntryFlowDecision {
  const currentBucket = Math.floor(now / 60_000) * 60_000;
  const completed = candles.filter(candle => candle.time < currentBucket);
  const live = candles.filter(candle => candle.time >= currentBucket).at(-1);
  const currentCandleReturnPercent = live && live.open > 0 ? (live.close / live.open - 1) * 100 : null;
  if (completed.length < 3) return { allowed: false, reason: 'INSUFFICIENT_COMPLETED_CANDLES', completedCandles: completed.length, currentCandleReturnPercent };
  if (currentCandleReturnPercent !== null && currentCandleReturnPercent <= -5) return { allowed: false, reason: 'CURRENT_CANDLE_DROP', completedCandles: completed.length, currentCandleReturnPercent };
  return { allowed: true, reason: 'CANDLE_ENTRY_FLOW_OK', completedCandles: completed.length, currentCandleReturnPercent };
}

/** Reject only a clear post-pump dump, while preserving fast but still rising launches. */
export function assessCandleHistory(candles: McapCandle[]): CandleHistoryDecision {
  const recent = candles.slice(-10);
  if (!recent.length) return { allowed: false, reason: 'NO_CANDLE_DATA', peakToLastDrawdownPercent: null, consecutiveRedCandles: 0, largestGreenCandlePercent: null, largestRedCandlePercent: null };
  // Fewer than three one-minute candles do not establish sustained demand.
  if (recent.length === 1) return { allowed: false, reason: 'SINGLE_CANDLE_ONLY', peakToLastDrawdownPercent: null, consecutiveRedCandles: 0, largestGreenCandlePercent: null, largestRedCandlePercent: null };
  if (recent.length === 2) return { allowed: false, reason: 'INSUFFICIENT_CANDLES', peakToLastDrawdownPercent: null, consecutiveRedCandles: 0, largestGreenCandlePercent: null, largestRedCandlePercent: null };
  const last = recent.at(-1)!, peak = Math.max(...recent.map(candle => candle.high));
  const peakToLastDrawdownPercent = (last.close / peak - 1) * 100;
  let consecutiveRedCandles = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    if (recent[index]!.close < recent[index]!.open) consecutiveRedCandles++;
    else break;
  }
  const largestGreenCandlePercent = Math.max(...recent.map(candle => (candle.close / candle.open - 1) * 100));
  const largestRedCandlePercent = Math.min(...recent.map(candle => (candle.close / candle.open - 1) * 100));
  const pumpedThenDumped = largestGreenCandlePercent >= 100 && peakToLastDrawdownPercent <= -20;
  const sharpCandleCrash = largestRedCandlePercent <= -30;
  const threeRedCandles = consecutiveRedCandles >= 3;
  const reason = pumpedThenDumped ? 'PUMP_THEN_DUMP' : sharpCandleCrash ? 'SHARP_CANDLE_CRASH' : threeRedCandles ? 'THREE_RED_CANDLES' : 'CANDLE_HISTORY_OK';
  return { allowed: reason === 'CANDLE_HISTORY_OK', reason, peakToLastDrawdownPercent, consecutiveRedCandles, largestGreenCandlePercent, largestRedCandlePercent };
}

/**
 * A paper buy needs several fresh detail-price updates. This prevents a buy
 * merely because the first detail packet happened to arrive during a dump.
 */
export function assessEntryStability(samples: PriceSample[]): EntryStability {
  if (samples.length < 3) return { stable: false, reason: 'INSUFFICIENT_PRICE_DATA', momentum5sPercent: null, consecutiveDeclines: 0, distinctPriceCount: new Set(samples.map(sample => sample.priceUsd)).size };
  const distinctPriceCount = new Set(samples.map(sample => sample.priceUsd)).size;
  const baseline = samples[0]!.priceUsd, latest = samples.at(-1)!.priceUsd;
  const momentum5sPercent = (latest / baseline - 1) * 100;
  let consecutiveDeclines = 0;
  for (let index = samples.length - 1; index > 0; index--) {
    if (samples[index]!.priceUsd < samples[index - 1]!.priceUsd) consecutiveDeclines++;
    else break;
  }
  // Require an actual noticeable drop (momentum <= -3%, or consecutive declines with momentum <= -2%).
  // Micro-sells or tiny noise dips when overall momentum is flat or positive should not block entry.
  const falling = momentum5sPercent <= -3 || (consecutiveDeclines >= 2 && momentum5sPercent <= -2);
  if (distinctPriceCount < 2) return { stable: false, reason: 'INSUFFICIENT_PRICE_CONFIRMATION', momentum5sPercent, consecutiveDeclines, distinctPriceCount };
  return { stable: !falling, reason: falling ? 'CONTINUING_PRICE_DROP' : 'STABLE_OR_RECOVERING', momentum5sPercent, consecutiveDeclines, distinctPriceCount };
}

/** Exact entry stability thresholds from the archived flow-3 run. */
export function assessFlow3EntryStability(samples: PriceSample[]): EntryStability {
  if (samples.length < 3) return { stable: false, reason: 'INSUFFICIENT_PRICE_DATA', momentum5sPercent: null, consecutiveDeclines: 0, distinctPriceCount: new Set(samples.map(sample => sample.priceUsd)).size };
  const distinctPriceCount = new Set(samples.map(sample => sample.priceUsd)).size;
  const baseline = samples[0]!.priceUsd, latest = samples.at(-1)!.priceUsd;
  const momentum5sPercent = (latest / baseline - 1) * 100;
  let consecutiveDeclines = 0;
  for (let index = samples.length - 1; index > 0; index--) {
    if (samples[index]!.priceUsd < samples[index - 1]!.priceUsd) consecutiveDeclines++;
    else break;
  }
  const falling = momentum5sPercent <= -2 || consecutiveDeclines >= 2;
  if (distinctPriceCount < 2) return { stable: false, reason: 'INSUFFICIENT_PRICE_CONFIRMATION', momentum5sPercent, consecutiveDeclines, distinctPriceCount };
  return { stable: !falling, reason: falling ? 'CONTINUING_PRICE_DROP' : 'STABLE_OR_RECOVERING', momentum5sPercent, consecutiveDeclines, distinctPriceCount };
}

export function openSimulation(mint: string, openedAt: number, entryPriceUsd: number, stakeUsd = 0.25): SimulationPosition {
  if (!(entryPriceUsd > 0) || !(stakeUsd > 0)) throw new Error('Simulation requires a positive price and stake');
  return { mint, openedAt, entryPriceUsd, stakeUsd, quantity: stakeUsd / entryPriceUsd, peakPriceUsd: entryPriceUsd, pressureWindows: 0, lastPressureWindowStart: null };
}

export function assessSimulation(position: SimulationPosition, currentPriceUsd: number, recent: TradeWindow, guards: SimulationGuards = {}): SimulationDecision {
  if (!(currentPriceUsd > 0)) throw new Error('Simulation requires a positive current price');
  position.peakPriceUsd = Math.max(position.peakPriceUsd, currentPriceUsd);
  const returnPercent = (currentPriceUsd / position.entryPriceUsd - 1) * 100;
  const peakReturnPercent = (position.peakPriceUsd / position.entryPriceUsd - 1) * 100;
  const drawdownFromPeakPercent = (position.peakPriceUsd - currentPriceUsd) / position.peakPriceUsd * 100;
  const totalUsd = recent.buyUsd + recent.sellUsd;
  const sellSharePercent = totalUsd > 0 ? recent.sellUsd / totalUsd * 100 : null;
  const pressureWindow = recent.buys + recent.sells >= 10 && recent.uniqueSellers >= 3 &&
    (sellSharePercent ?? 0) >= 70 && returnPercent <= -5;
  // The collector samples every 500 ms. Count a pressure signal once per
  // completed five-second window, so two checks of the same data cannot sell.
  const newPressureWindow = recent.windowStart === undefined || recent.windowStart !== position.lastPressureWindowStart;
  if (newPressureWindow) {
    position.pressureWindows = pressureWindow ? position.pressureWindows + 1 : 0;
    if (recent.windowStart !== undefined) position.lastPressureWindowStart = recent.windowStart;
  }
  const targetReached = currentPriceUsd >= position.entryPriceUsd * 1.4 - 1e-12;
  const exitReason: SimulationExitReason | null = targetReached && !guards.deferTargetForHolderMomentum ? 'TARGET_40'
    : !guards.suppressHardStop && currentPriceUsd <= position.entryPriceUsd * 0.8 + 1e-12 ? 'STOP_LOSS_20'
    : peakReturnPercent >= 5 && returnPercent <= 0.5 ? 'BREAKEVEN_GUARD'
    : peakReturnPercent >= 20 && drawdownFromPeakPercent >= 10 ? 'TRAILING_10'
    : peakReturnPercent >= 20 && drawdownFromPeakPercent >= 6 ? 'TRAILING_TIERED'
    : peakReturnPercent >= 10 && drawdownFromPeakPercent >= 8 ? 'TRAILING_TIERED'
    : returnPercent <= -8 && position.pressureWindows >= 1 ? 'EARLY_CUT_LOSS'
    : !guards.suppressSellPressure && position.pressureWindows >= 2 ? 'SELL_PRESSURE' : null;
  return { returnPercent, peakReturnPercent, drawdownFromPeakPercent, sellSharePercent, pressureWindow, exitReason };
}

/**
 * Exit model used by the archived flow-3 experiment.  It deliberately keeps
 * only the exits documented in that run: +40% target, -20% stop, 10% trailing
 * from a +20% peak, and two completed sell-pressure windows.  Later dynamic
 * targets and holder/whale exits belong to newer strategies.
 */
export function assessFlow3Simulation(position: SimulationPosition, currentPriceUsd: number, recent: TradeWindow, guards: SimulationGuards = {}): SimulationDecision {
  if (!(currentPriceUsd > 0)) throw new Error('Simulation requires a positive current price');
  position.peakPriceUsd = Math.max(position.peakPriceUsd, currentPriceUsd);
  const returnPercent = (currentPriceUsd / position.entryPriceUsd - 1) * 100;
  const peakReturnPercent = (position.peakPriceUsd / position.entryPriceUsd - 1) * 100;
  const drawdownFromPeakPercent = (position.peakPriceUsd - currentPriceUsd) / position.peakPriceUsd * 100;
  const totalUsd = recent.buyUsd + recent.sellUsd;
  const sellSharePercent = totalUsd > 0 ? recent.sellUsd / totalUsd * 100 : null;
  const pressureWindow = recent.buys + recent.sells >= 10 && recent.uniqueSellers >= 3
    && (sellSharePercent ?? 0) >= 70 && returnPercent <= -5;
  const newPressureWindow = recent.windowStart === undefined || recent.windowStart !== position.lastPressureWindowStart;
  if (newPressureWindow) {
    position.pressureWindows = pressureWindow ? position.pressureWindows + 1 : 0;
    if (recent.windowStart !== undefined) position.lastPressureWindowStart = recent.windowStart;
  }
  const targetReached = currentPriceUsd >= position.entryPriceUsd * 1.4 - 1e-12;
  const exitReason: SimulationExitReason | null = targetReached && !guards.deferTargetForHolderMomentum ? 'TARGET_40'
    : !guards.suppressHardStop && currentPriceUsd <= position.entryPriceUsd * 0.8 + 1e-12 ? 'STOP_LOSS_20'
    : peakReturnPercent >= 20 && drawdownFromPeakPercent >= 10 ? 'TRAILING_10'
    : !guards.suppressSellPressure && position.pressureWindows >= 2 ? 'SELL_PRESSURE' : null;
  return { returnPercent, peakReturnPercent, drawdownFromPeakPercent, sellSharePercent, pressureWindow, exitReason };
}

export function closeSimulation(position: SimulationPosition, exitPriceUsd: number) {
  const grossProceedsUsd = position.quantity * exitPriceUsd;
  const pnlUsd = grossProceedsUsd - position.stakeUsd;
  return { grossProceedsUsd, pnlUsd, pnlPercent: pnlUsd / position.stakeUsd * 100 };
}

export type ObservationDumpReason =
  | 'PRICE_DROP_FROM_OPEN'
  | 'PRICE_DROP_FROM_PEAK'
  | 'CANDLE_DUMP'
  | 'PUMP_THEN_DUMP'
  | 'THREE_RED_CANDLES_DUMP'
  | 'HEAVY_SELL_AVALANCHE';

export interface ObservationDumpDecision {
  shouldAbort: boolean;
  reason: ObservationDumpReason | null;
  drawdownPercent: number | null;
  details: string | null;
}

/**
 * Auto-close detail monitoring for unbought tokens when a severe dump occurs.
 * Prevents workers from being stuck for 10 minutes observing dead/crashing tokens.
 */
export function assessObservationDump(params: {
  currentPriceUsd: number | null;
  openingPriceUsd: number | null;
  peakPriceUsd: number | null;
  stopLossPercent?: number;
  candleDecision?: CandleHistoryDecision | null;
  candleEntryFlow?: CandleEntryFlowDecision | null;
  tradeFlow?: { trades: number; buys: number; sells: number; buyUsd: number; sellUsd: number; buySharePercent: number | null } | null;
  sampleCount?: number;
  tradesCount?: number;
}): ObservationDumpDecision {
  const {
    currentPriceUsd,
    openingPriceUsd,
    peakPriceUsd,
    stopLossPercent = 20,
    candleDecision,
    candleEntryFlow,
    tradeFlow,
    sampleCount = 0,
    tradesCount = 0,
  } = params;

  // 1. Current live 1-minute candle severe crash (e.g. 1m candle crashed >= 25%, like locus at -52%)
  if (candleEntryFlow && typeof candleEntryFlow.currentCandleReturnPercent === 'number' && candleEntryFlow.currentCandleReturnPercent <= -25) {
    const drop = Math.abs(candleEntryFlow.currentCandleReturnPercent);
    return {
      shouldAbort: true,
      reason: 'CANDLE_DUMP',
      drawdownPercent: drop,
      details: `Candle 1m live dump parah: -${drop.toFixed(1)}%`,
    };
  }

  // 2. Candle history pump then dump or sharp candle crash
  if (candleDecision) {
    if (candleDecision.reason === 'PUMP_THEN_DUMP') {
      const drop = candleDecision.peakToLastDrawdownPercent ? Math.abs(candleDecision.peakToLastDrawdownPercent) : null;
      return {
        shouldAbort: true,
        reason: 'PUMP_THEN_DUMP',
        drawdownPercent: drop,
        details: `Pola pump-then-dump terkonfirmasi pada candle (drawdown -${drop?.toFixed(1) ?? '—'}%)`,
      };
    }
    if (candleDecision.reason === 'SHARP_CANDLE_CRASH') {
      const drop = candleDecision.largestRedCandlePercent ? Math.abs(candleDecision.largestRedCandlePercent) : null;
      return {
        shouldAbort: true,
        reason: 'CANDLE_DUMP',
        drawdownPercent: drop,
        details: `Crash candle tajam: -${drop?.toFixed(1) ?? '—'}%`,
      };
    }
    if (candleDecision.consecutiveRedCandles >= 3 && candleDecision.peakToLastDrawdownPercent !== null && candleDecision.peakToLastDrawdownPercent <= -25) {
      const drop = Math.abs(candleDecision.peakToLastDrawdownPercent);
      return {
        shouldAbort: true,
        reason: 'THREE_RED_CANDLES_DUMP',
        drawdownPercent: drop,
        details: `3 candle merah berturut-turut dengan penurunan total -${drop.toFixed(1)}%`,
      };
    }
  }

  // 3. Price drop from opening price >= stopLossPercent (default 20%)
  if (currentPriceUsd && openingPriceUsd && openingPriceUsd > 0 && (sampleCount >= 2 || tradesCount >= 3)) {
    const rawOpenDrawdown = (1 - currentPriceUsd / openingPriceUsd) * 100;
    const openDrawdown = Number(rawOpenDrawdown.toFixed(2));
    if (openDrawdown >= stopLossPercent) {
      return {
        shouldAbort: true,
        reason: 'PRICE_DROP_FROM_OPEN',
        drawdownPercent: openDrawdown,
        details: `Harga anjlok -${openDrawdown.toFixed(1)}% dari harga awal observasi ($${openingPriceUsd} -> $${currentPriceUsd})`,
      };
    }
  }

  // 4. Price drop from peak observed price >= 25%
  if (currentPriceUsd && peakPriceUsd && peakPriceUsd > 0 && (sampleCount >= 2 || tradesCount >= 3)) {
    const rawPeakDrawdown = (1 - currentPriceUsd / peakPriceUsd) * 100;
    const peakDrawdown = Number(rawPeakDrawdown.toFixed(2));
    if (peakDrawdown >= 25) {
      return {
        shouldAbort: true,
        reason: 'PRICE_DROP_FROM_PEAK',
        drawdownPercent: peakDrawdown,
        details: `Harga anjlok -${peakDrawdown.toFixed(1)}% dari harga puncak observasi ($${peakPriceUsd} -> $${currentPriceUsd})`,
      };
    }
  }

  // 5. Heavy sell avalanche (overwhelming sell flow with price failing to recover)
  if (tradeFlow && tradeFlow.trades >= 15 && tradeFlow.sellUsd >= 500 && (tradeFlow.buySharePercent ?? 0) <= 15 && tradeFlow.sellUsd >= tradeFlow.buyUsd * 4) {
    return {
      shouldAbort: true,
      reason: 'HEAVY_SELL_AVALANCHE',
      drawdownPercent: null,
      details: `Arus dump masif: ${tradeFlow.sells} sell ($${tradeFlow.sellUsd.toFixed(0)}) vs ${tradeFlow.buys} buy ($${tradeFlow.buyUsd.toFixed(0)})`,
    };
  }

  return { shouldAbort: false, reason: null, drawdownPercent: null, details: null };
}
