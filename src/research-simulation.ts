export type SimulationExitReason = 'TARGET_40' | 'TARGET_40_HOLDER_FLAT' | 'TRAILING_10' | 'STOP_LOSS_20' | 'SELL_PRESSURE' | 'OBSERVATION_END';

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
  const falling = consecutiveDeclines >= 2 || momentum5sPercent < -2;
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
    : peakReturnPercent >= 20 && drawdownFromPeakPercent >= 10 ? 'TRAILING_10'
    : !guards.suppressSellPressure && position.pressureWindows >= 2 ? 'SELL_PRESSURE' : null;
  return { returnPercent, peakReturnPercent, drawdownFromPeakPercent, sellSharePercent, pressureWindow, exitReason };
}

export function closeSimulation(position: SimulationPosition, exitPriceUsd: number) {
  const grossProceedsUsd = position.quantity * exitPriceUsd;
  const pnlUsd = grossProceedsUsd - position.stakeUsd;
  return { grossProceedsUsd, pnlUsd, pnlPercent: pnlUsd / position.stakeUsd * 100 };
}
