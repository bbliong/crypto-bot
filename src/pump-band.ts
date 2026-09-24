export const PUMP_BAND_RULES = {
  version: 'pump-band-3k-10k-v2',
  minimumMarketCapUsd: 3_000,
  maximumMarketCapUsd: 10_000,
  observationSeconds: 60,
  maximumSlots: 5,
  dumpFromPeakPercent: 20,
  holderPollMs: 5_000,
  flowWindowMs: 5_000,
  simulationStakeUsdc: 0.25,
} as const;

export type PumpBandTick = {
  observedAt: number;
  marketCapUsd: number | null;
  priceUsd: number | null;
};

// One WebSocket frame can contain historical trades. At receipt time only the
// latest priced trade in that frame is actionable as a current-price proxy.
export function latestPricedTradeInFrame<T extends { occurredAt: number; priceUsd?: number | null }>(rows: readonly T[]): (T & { priceUsd: number }) | null {
  let latest: (T & { priceUsd: number }) | null = null;
  for (const row of rows) {
    if (typeof row.priceUsd !== 'number' || !Number.isFinite(row.priceUsd) || row.priceUsd <= 0) continue;
    if (!latest || row.occurredAt >= latest.occurredAt) latest = row as T & { priceUsd: number };
  }
  return latest;
}

export function isInPumpBand(marketCapUsd: number | null | undefined) {
  return typeof marketCapUsd === 'number'
    && Number.isFinite(marketCapUsd)
    && marketCapUsd >= PUMP_BAND_RULES.minimumMarketCapUsd
    && marketCapUsd <= PUMP_BAND_RULES.maximumMarketCapUsd;
}

export function percentChange(from: number, to: number) {
  return from > 0 && Number.isFinite(from) && Number.isFinite(to) ? ((to / from) - 1) * 100 : null;
}

export function assessPumpBandDump(entryMarketCapUsd: number, peakMarketCapUsd: number, currentMarketCapUsd: number, thresholdPercent: number = PUMP_BAND_RULES.dumpFromPeakPercent) {
  const drawdownPercent = percentChange(peakMarketCapUsd, currentMarketCapUsd);
  return {
    dump: drawdownPercent !== null && drawdownPercent <= -thresholdPercent,
    drawdownPercent,
    entryReturnPercent: percentChange(entryMarketCapUsd, currentMarketCapUsd),
  };
}

export function pumpMilestones(ticks: PumpBandTick[], startedAt: number) {
  const result: Record<'6000' | '8000' | '10000', number | null> = { '6000': null, '8000': null, '10000': null };
  for (const tick of ticks) {
    if (tick.marketCapUsd === null) continue;
    for (const [label, threshold] of [['6000', 6_000], ['8000', 8_000], ['10000', 10_000]] as const) {
      if (result[label] === null && tick.marketCapUsd >= threshold) result[label] = Math.max(0, tick.observedAt - startedAt);
    }
  }
  return result;
}
