/** Deterministic research signals. All timestamps describe evidence available now. */
export const MOMENTUM_RULES = Object.freeze({
  version: 'momentum-v2', windowMs: 5_000, maxTickAgeMs: 2_000, maxSourceClockAheadMs: 3_000,
  minimumTrades: 5, minimumBuyers: 3, minimumBuyShare: 0.60, maximumBuyerShare: 0.50,
  minimumReturn5s: 0.25, maximumReturn5s: 20, maximumEntryDrawdown: 5,
  holderGrowthPercent: 10, holderGrowthAbsolute: 5, holderFreshMs: 6_000,
  holderSnapshotMaxGapMs: 8_000, holderSnapshotMinGapMs: 4_000,
  hardStopPercent: 20, emergencyStopPercent: 25, confirmStopMs: 1_500,
  targetPercent: 40, maximumTargetPercent: 50, recoveryHoldMs: 10_000,
  minimumMajorSellUsd: 25, whaleSellUsd: 150, topHolderPercent: 1.5,
  holderEvidenceMaxAgeMs: 30_000, profitFloorPercent: 3.5,
});
export const MOMENTUM_R5_BAND = Object.freeze({
  id: 'r5-band-5-to-10', minimumReturn5s: 5, maximumReturn5s: 10,
});
/** Earlier-entry paper hypothesis. V3 reuses V2's twelve validation groups. */
export const MOMENTUM_V3_RULES = Object.freeze({
  version: 'momentum-v3',
  totalValidations: 12,
  minimumPassedValidations: 8,
  hardRejections: [
    'MOMENTUM_NOT_RISING',
    'MOMENTUM_INSUFFICIENT_FRESH_HISTORY',
    'MOMENTUM_SINGLE_BUYER_DOMINANCE',
    'ENTRY_UNSTABLE',
    'CURRENT_CANDLE_DROP',
    'FLOW_SELL_USD_DOMINANT',
    'HOLDER_DISTRIBUTION_RISK',
  ],
});
// Narrow paper-only comparison hypotheses. Their exit behavior deliberately
// stays with the parent V3/V2 lane; only the entry cohort differs.
export const MOMENTUM_V3_CALM_V1_RULES = Object.freeze({
  version: 'momentum-v3-calm-v1',
  minimumBuyers: 3,
  maximumBuyersExclusive: 5,
  maximumVolatilityPercentExclusive: 1,
});
export const MOMENTUM_V2_BALANCED_FLOW_V1_RULES = Object.freeze({
  version: 'momentum-v2-balanced-flow-v1',
  buyShare5s: [0.80, 0.90] as const,
  buyShare20sPercent: [75, 85] as const,
});
export type MomentumEntryBand = { id: string; minimumReturn5s: number; maximumReturn5s: number };
export type TapeTrade = { id: string; observedAt: number; occurredAt: number; priceUsd: number | null;
  side: 'buy' | 'sell'; wallet: string | null; usd: number | null; tokens: number | null };
export type HolderSample = { observedAt: number; count: number };
export type OwnerSample = { observedAt: number; wallet: string; balance: number | null; percent: number | null; isDev: boolean };
const pct = (a: number, b: number) => (a / b - 1) * 100;
const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;
export function cleanTape(tape: TapeTrade[], now: number, windowMs = 10_000) {
  const seen = new Set<string>();
  let latestEventAt = -Infinity;
  return tape.filter(t => t.observedAt <= now && t.observedAt >= now - windowMs &&
    t.occurredAt <= now + MOMENTUM_RULES.maxSourceClockAheadMs && t.observedAt - t.occurredAt >= -MOMENTUM_RULES.maxSourceClockAheadMs && t.observedAt - t.occurredAt <= MOMENTUM_RULES.maxTickAgeMs)
    .sort((a, b) => a.observedAt - b.observedAt || a.occurredAt - b.occurredAt)
    .filter(t => { if (seen.has(t.id) || t.occurredAt < latestEventAt) return false; seen.add(t.id); latestEventAt = t.occurredAt; return true; });
}
export function holderGrowth(samples: HolderSample[], now: number) {
  const rows = samples.filter(s => s.observedAt <= now && Number.isInteger(s.count) && s.count > 0)
    .sort((a, b) => a.observedAt - b.observedAt).slice(-3);
  const steps = rows.slice(1).map((s, i) => ({ delta: s.count - rows[i]!.count,
    percent: pct(s.count, rows[i]!.count), gapMs: s.observedAt - rows[i]!.observedAt }));
  const latest = rows.at(-1);
  const fresh = !!latest && now - latest.observedAt <= MOMENTUM_RULES.holderFreshMs;
  const strong = (s: typeof steps[number]) => s.delta >= MOMENTUM_RULES.holderGrowthAbsolute &&
    s.percent >= MOMENTUM_RULES.holderGrowthPercent - 1e-9 && s.gapMs >= MOMENTUM_RULES.holderSnapshotMinGapMs && s.gapMs <= MOMENTUM_RULES.holderSnapshotMaxGapMs;
  return { fresh, count: latest?.count ?? null, observedAt: latest?.observedAt ?? null, steps,
    significant: fresh && steps.length > 0 && strong(steps.at(-1)!),
    sustained: fresh && steps.length === 2 && steps.every(strong) };
}
export function momentumMetrics(tape: TapeTrade[], now: number) {
  const clean = cleanTape(tape, now);
  const prices = clean.filter(t => positive(t.priceUsd));
  const latest = prices.at(-1);
  const anchor = prices.filter(t => t.observedAt <= now - 5_000).at(-1);
  const window = clean.filter(t => t.observedAt > now - 5_000);
  const buckets = new Map<number, TapeTrade>();
  for (const t of prices.filter(t => t.observedAt >= now - 5_000)) buckets.set(Math.floor(t.observedAt / 1000), t);
  const points = [...buckets.values()];
  const xs = points.map(t => (t.observedAt - now) / 1000), ys = points.map(t => Math.log(t.priceUsd!));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length, meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  const varianceX = xs.reduce((a, x) => a + (x - meanX) ** 2, 0);
  const slope = varianceX > 0 ? xs.reduce((a, x, i) => a + (x - meanX) * (ys[i]! - meanY), 0) / varianceX : null;
  const returns = points.slice(1).map((t, i) => Math.log(t.priceUsd! / points[i]!.priceUsd!));
  const sigma = returns.length ? Math.sqrt(returns.reduce((s, r) => s + r * r, 0) / returns.length) * 100 : 0;
  const buyUsd = window.filter(t => t.side === 'buy').reduce((s, t) => s + (positive(t.usd) ? t.usd : 0), 0);
  const sellUsd = window.filter(t => t.side === 'sell').reduce((s, t) => s + (positive(t.usd) ? t.usd : 0), 0);
  const buyerVolumes = new Map<string, number>();
  for (const t of window.filter(t => t.side === 'buy' && t.wallet && positive(t.usd))) buyerVolumes.set(t.wallet!, (buyerVolumes.get(t.wallet!) ?? 0) + t.usd!);
  const peak = Math.max(0, ...points.map(t => t.priceUsd!));
  return { priceUsd: latest?.priceUsd ?? null, priceAt: latest?.observedAt ?? null,
    ready: !!latest && !!anchor && now - latest.observedAt <= 2_000 && now - 5_000 - anchor.observedAt <= 2_000 && points.length >= 4,
    return5s: latest && anchor ? pct(latest.priceUsd!, anchor.priceUsd!) : null,
    slope5s: slope === null ? null : Math.expm1(5 * slope) * 100, volatilityPercent: sigma,
    drawdown5s: latest && peak > 0 ? (1 - latest.priceUsd! / peak) * 100 : null,
    trades: window.length, buyers: buyerVolumes.size, sellers: new Set(window.filter(t => t.side === 'sell' && t.wallet).map(t => t.wallet)).size,
    buyUsd, sellUsd, buyShare: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) : null,
    topBuyerShare: buyUsd > 0 ? Math.max(0, ...buyerVolumes.values()) / buyUsd : null };
}
export function assessMomentumEntry(tape: TapeTrade[], holders: HolderSample[], now: number, early: boolean, band?: MomentumEntryBand) {
  const m = momentumMetrics(tape, now), h = holderGrowth(holders, now), reasons: string[] = [];
  if (!m.ready) reasons.push('MOMENTUM_INSUFFICIENT_FRESH_HISTORY');
  if (m.return5s === null || m.return5s < MOMENTUM_RULES.minimumReturn5s || (m.slope5s ?? 0) <= 0) reasons.push('MOMENTUM_NOT_RISING');
  if ((m.return5s ?? 0) > MOMENTUM_RULES.maximumReturn5s) reasons.push('MOMENTUM_SPIKE_CHASING');
  if ((m.drawdown5s ?? Infinity) > MOMENTUM_RULES.maximumEntryDrawdown) reasons.push('MOMENTUM_PULLBACK');
  if (band && (m.return5s === null || m.return5s < band.minimumReturn5s)) reasons.push('MOMENTUM_R5_BELOW_BAND');
  if (band && m.return5s !== null && m.return5s >= band.maximumReturn5s) reasons.push('MOMENTUM_R5_ABOVE_BAND');
  if (m.trades < MOMENTUM_RULES.minimumTrades || m.buyers < MOMENTUM_RULES.minimumBuyers || (m.buyShare ?? 0) < MOMENTUM_RULES.minimumBuyShare) reasons.push('MOMENTUM_WEAK_BUY_FLOW');
  if (m.topBuyerShare === null || m.topBuyerShare > MOMENTUM_RULES.maximumBuyerShare) reasons.push('MOMENTUM_SINGLE_BUYER_DOMINANCE');
  if (early && !h.sustained) reasons.push('EARLY_HOLDERS_NEED_TWO_GROWING_SNAPSHOTS');
  return { allowed: reasons.length === 0, reasons, metrics: m, holders: h, version: MOMENTUM_RULES.version, band: band ?? null };
}

/** Extra cohort gate; the caller must also enforce the ordinary V3 gate. */
export function assessMomentumV3CalmEntry(tape: TapeTrade[], now: number) {
  const metrics = momentumMetrics(tape, now), reasons: string[] = [];
  if (!metrics.ready) reasons.push('CALM_V1_INSUFFICIENT_FRESH_HISTORY');
  if (metrics.buyers < MOMENTUM_V3_CALM_V1_RULES.minimumBuyers || metrics.buyers >= MOMENTUM_V3_CALM_V1_RULES.maximumBuyersExclusive) {
    reasons.push('CALM_V1_BUYERS_NOT_3_TO_4');
  }
  if (!Number.isFinite(metrics.volatilityPercent) || metrics.volatilityPercent >= MOMENTUM_V3_CALM_V1_RULES.maximumVolatilityPercentExclusive) {
    reasons.push('CALM_V1_VOLATILITY_NOT_BELOW_1');
  }
  return { allowed: reasons.length === 0, reasons, metrics, version: MOMENTUM_V3_CALM_V1_RULES.version };
}

/** Extra cohort gate; the caller must also enforce the ordinary V2 gate. */
export function assessMomentumV2BalancedFlowEntry(tape: TapeTrade[], now: number, buyShare20sPercent: number | null) {
  const metrics = momentumMetrics(tape, now), reasons: string[] = [];
  const [minBuyShare5s, maxBuyShare5s] = MOMENTUM_V2_BALANCED_FLOW_V1_RULES.buyShare5s;
  const [minBuyShare20s, maxBuyShare20s] = MOMENTUM_V2_BALANCED_FLOW_V1_RULES.buyShare20sPercent;
  if (!metrics.ready) reasons.push('BALANCED_FLOW_V1_INSUFFICIENT_FRESH_HISTORY');
  if (metrics.buyShare === null || metrics.buyShare < minBuyShare5s || metrics.buyShare >= maxBuyShare5s) {
    reasons.push('BALANCED_FLOW_V1_BUY_SHARE_5S_NOT_80_TO_90');
  }
  if (buyShare20sPercent === null || buyShare20sPercent < minBuyShare20s || buyShare20sPercent >= maxBuyShare20s) {
    reasons.push('BALANCED_FLOW_V1_BUY_SHARE_20S_NOT_75_TO_85');
  }
  return { allowed: reasons.length === 0, reasons, metrics, buyShare20sPercent, version: MOMENTUM_V2_BALANCED_FLOW_V1_RULES.version };
}

export const MOMENTUM_AGGRESSIVE_RULES = Object.freeze({
  version: 'momentum-aggressive',
  windowMs: 5_000,
  minBuyUsd: 300,
  minBuyShare: 0.95,
  minBuyers: 4,
  maximumBuyerShare: 0.70,
  minimumReturn5s: 1.0,
  maximumReturn5s: 30,
  maximumEntryDrawdown: 2.5,
  hardStopPercent: 3.0,
  breakevenActivationPercent: 8.0,
  breakevenFloorPercent: 3.5,
  runnerActivationPercent: 10.0,
  runnerTrailingPercent: 7.0,
  runnerLockPercent: 6.5,
  stagnationSeconds: 15,
  stagnationThreshold: 2.5,
  flowExit: false,
  minMarketCap: 5_500,
  maxMarketCap: 15_000,
});

export const MOMENTUM_AGGRESSIVE_SAFE_RULES = Object.freeze({
  ...MOMENTUM_AGGRESSIVE_RULES,
  version: 'momentum-aggressive-safe',
  breakevenActivationPercent: 7.5,
  maxDevPercent: 2.5,
});

export const MOMENTUM_AGGRESSIVE_OPTIMAL_RULES = Object.freeze({
  ...MOMENTUM_AGGRESSIVE_SAFE_RULES,
  version: 'momentum-aggressive-optimal',
  minBuyUsd: 400,
  maximumBuyerShare: 0.50,
  maximumReturn5s: 22.0,
  maxDevPercent: 2.0,
  maxTop1Percent: 6.0,
  minBuyShare20s: 65.0,
});

export const MOMENTUM_AGGRESSIVE_WIDE_RULES = Object.freeze({
  ...MOMENTUM_AGGRESSIVE_SAFE_RULES,
  version: 'momentum-aggressive-wide',
  minBuyUsd: 400,
  maximumBuyerShare: 0.50,
  maximumReturn5s: 22.0,
  hardStopPercent: 6.0,
});

export const MOMENTUM_AGGRESSIVE_SWING_100K_RULES = Object.freeze({
  version: 'momentum-aggressive-swing-100k',
  windowMs: 5_000,
  minBuyUsd: 400,
  minBuyShare: 0.70,
  minBuyers: 4,
  maximumBuyerShare: 0.60,
  minimumReturn5s: 1.2,
  maximumReturn5s: 25.0,
  maximumEntryDrawdown: 3.5,
  hardStopPercent: 4.0,
  breakevenActivationPercent: 6.5,
  breakevenFloorPercent: 3.5,
  runnerActivationPercent: 9.0,
  runnerTrailingPercent: 5.0,
  runnerLockPercent: 6.0,
  stagnationSeconds: 20,
  stagnationThreshold: 2.5,
  flowExit: true,
  minMarketCap: 10_000,
  maxMarketCap: 100_000,
  maxDevPercent: 2.5,
  maxTop1Percent: 8.0,
});

export const MOMENTUM_AGGRESSIVE_WAVE_RULES = Object.freeze({
  version: 'momentum-aggressive-wave',
  windowMs: 5_000,
  minBuyUsd: 300,
  minBuyShare: 0.60,
  minBuyers: 3,
  maximumBuyerShare: 0.65,
  minimumReturn5s: 0.8,
  maximumReturn5s: 35.0,
  maximumEntryDrawdown: 4.0,
  hardStopPercent: 6.0,
  minTargetPercent: 20.0,
  takeProfitPercent: 20.0,
  breakevenActivationPercent: 10.0,
  breakevenFloorPercent: 3.0,
  runnerActivationPercent: 18.0,
  runnerTrailingPercent: 5.0,
  runnerLockPercent: 14.0,
  stagnationSeconds: 45,
  stagnationThreshold: 2.0,
  flowExit: false,
  maxDevPercent: 3.5,
  maxTop1Percent: 25.0,
  minMarketCap: 10_000,
  maxMarketCap: 100_000,
});

export type McapCandleInput = {
  time: number;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
};

export function calculateDynamicWaveTarget(
  candles: McapCandleInput[] = [],
  entryMcap?: number | null
): { targetPercent: number; historicalMaxMcap: number; athUpsidePercent: number; rationale: string } {
  const minTarget = MOMENTUM_AGGRESSIVE_WAVE_RULES.minTargetPercent; // 20.0%

  if (!candles || candles.length === 0) {
    return {
      targetPercent: minTarget,
      historicalMaxMcap: 0,
      athUpsidePercent: 0,
      rationale: `Baseline minimal target ${minTarget}% (no candle history yet)`,
    };
  }

  const validCandles = candles.filter(c => c.high > 0 && c.low > 0);
  if (validCandles.length === 0) {
    return {
      targetPercent: minTarget,
      historicalMaxMcap: 0,
      athUpsidePercent: 0,
      rationale: `Baseline minimal target ${minTarget}% (invalid candle values)`,
    };
  }

  const historicalMaxMcap = Math.max(...validCandles.map(c => c.high));
  const historicalMinMcap = Math.min(...validCandles.map(c => c.low));
  const currentMcap = entryMcap && entryMcap > 0 ? entryMcap : (validCandles.at(-1)?.close ?? 0);

  let target: number = minTarget;
  let athUpsidePercent = 0;
  let rationale = `Minimal target ${minTarget}%`;

  if (currentMcap > 0 && historicalMaxMcap > currentMcap) {
    athUpsidePercent = ((historicalMaxMcap - currentMcap) / currentMcap) * 100;
    if (athUpsidePercent >= 25) {
      // Token pernah naik tinggi: target 70% dari jarak ke ATH, maksimal 150%
      target = Math.min(150, Math.max(minTarget, Math.round(athUpsidePercent * 0.70)));
      rationale = `Historical high $${Math.round(historicalMaxMcap)} (+${athUpsidePercent.toFixed(1)}% above entry $${Math.round(currentMcap)}) -> target dinaikkan ke +${target}%`;
    } else {
      target = minTarget;
      rationale = `Historical high $${Math.round(historicalMaxMcap)} (+${athUpsidePercent.toFixed(1)}% above entry) -> target minimal ${minTarget}%`;
    }
  } else if (currentMcap > 0 && historicalMinMcap > 0) {
    // Token saat ini berada di ATH atau mendekati ATH (breakout mode)
    const largestCandlePump = Math.max(...validCandles.map(c => c.open > 0 ? ((c.high - c.open) / c.open) * 100 : 0));
    const totalHistoricalSurge = ((historicalMaxMcap - historicalMinMcap) / historicalMinMcap) * 100;
    if (totalHistoricalSurge >= 50 || largestCandlePump >= 30) {
      target = Math.min(100, Math.max(minTarget, Math.round(Math.max(largestCandlePump * 0.8, totalHistoricalSurge * 0.4))));
      rationale = `Token breakout di ATH dengan lonjakan historis +${totalHistoricalSurge.toFixed(1)}% (candle tertinggi +${largestCandlePump.toFixed(1)}%) -> target dinaikkan ke +${target}%`;
    } else {
      target = minTarget;
      rationale = `Token breakout di ATH tetapi lonjakan rendah -> target minimal ${minTarget}%`;
    }
  }

  return {
    targetPercent: Math.max(minTarget, target),
    historicalMaxMcap,
    athUpsidePercent,
    rationale,
  };
}

export type MomentumAggressiveRules =
  | typeof MOMENTUM_AGGRESSIVE_RULES
  | typeof MOMENTUM_AGGRESSIVE_SAFE_RULES
  | typeof MOMENTUM_AGGRESSIVE_OPTIMAL_RULES
  | typeof MOMENTUM_AGGRESSIVE_WIDE_RULES
  | typeof MOMENTUM_AGGRESSIVE_SWING_100K_RULES
  | typeof MOMENTUM_AGGRESSIVE_WAVE_RULES;

export type MomentumAggressiveExitReason =
  | 'AGGRESSIVE_HARD_STOP'
  | 'AGGRESSIVE_BREAKEVEN_STOP'
  | 'AGGRESSIVE_PROFIT_TRAIL'
  | 'AGGRESSIVE_RUNNER_TRAIL'
  | 'AGGRESSIVE_STAGNATION'
  | 'AGGRESSIVE_FLOW_EXIT'
  | 'AGGRESSIVE_WAVE_TARGET_TP'
  | 'AGGRESSIVE_WAVE_QUICK_LOCK'
  | 'AGGRESSIVE_OBSERVATION_END';

export type MomentumExitReason = 'V2_HARD_STOP' | 'V2_CONFIRMED_CRASH' | 'V2_MAJOR_HOLDER_SELL' | 'V2_PROFIT_LOCK' | 'V2_TARGET_40' | 'V2_TARGET_50' | 'V2_MOMENTUM_FADE' | 'V2_SELL_PRESSURE' | MomentumAggressiveExitReason;
export type MomentumPosition = { openedAt: number; entry: number; peak: number; lastId: string | null; entryEventAt: number; lastEventAt: number;
  breachAt: number | null; breachTicks: number; recoveryUntil: number; recoverySampleAt: number; closed: boolean; dynamicTargetPercent?: number };
export function createMomentumPosition(openedAt: number, entry: number, entryEventAt = openedAt, dynamicTargetPercent?: number): MomentumPosition {
  if (!positive(entry)) throw new Error('Invalid entry price');
  return { openedAt, entry, peak: entry, lastId: null, entryEventAt, lastEventAt: entryEventAt, breachAt: null, breachTicks: 0, recoveryUntil: 0, recoverySampleAt: 0, closed: false, dynamicTargetPercent };
}
export function assessMomentumExit(p: MomentumPosition, tick: TapeTrade, tape: TapeTrade[], holders: HolderSample[], owners: OwnerSample[]) {
  const now = tick.observedAt;
  if (p.closed || tick.id === p.lastId || now <= p.openedAt || tick.occurredAt < p.entryEventAt || tick.occurredAt < p.lastEventAt || !positive(tick.priceUsd) ||
      now - tick.occurredAt < -MOMENTUM_RULES.maxSourceClockAheadMs || now - tick.occurredAt > MOMENTUM_RULES.maxTickAgeMs) return null;
  p.lastId = tick.id; p.lastEventAt = tick.occurredAt;
  const r = pct(tick.priceUsd, p.entry), m = momentumMetrics(tape, now), h = holderGrowth(holders, now);
  p.peak = Math.max(p.peak, tick.priceUsd);
  const peakReturn = pct(p.peak, p.entry), drawdown = (1 - tick.priceUsd / p.peak) * 100;
  const afterEntry = cleanTape(tape, now, 5_000).filter(t => t.observedAt > p.openedAt && t.occurredAt >= p.entryEventAt && t.side === 'sell');
  const groups = new Map<string, TapeTrade[]>();
  for (const t of afterEntry) if (t.wallet) groups.set(t.wallet, [...(groups.get(t.wallet) ?? []), t]);
  let majorSell: { wallet: string; usd: number; balanceSoldPercent: number | null; isDev: boolean } | null = null;
  for (const [wallet, sells] of groups) {
    const first = sells[0]!;
    const owner = owners.filter(o => o.wallet === wallet && o.observedAt <= first.observedAt && now - o.observedAt <= MOMENTUM_RULES.holderEvidenceMaxAgeMs).sort((a, b) => b.observedAt - a.observedAt)[0];
    const usd = sells.reduce((s, t) => s + (positive(t.usd) ? t.usd : 0), 0);
    const tokens = sells.reduce((s, t) => s + (positive(t.tokens) ? t.tokens : 0), 0);
    const soldPercent = owner && positive(owner.balance) && sells.every(t => positive(t.tokens)) ? tokens / owner.balance * 100 : null;
    const substantial = usd >= MOMENTUM_RULES.minimumMajorSellUsd;
    const devDump = owner?.isDev && substantial && (soldPercent ?? 0) >= 5;
    const holderDump = (owner?.percent ?? 0) >= MOMENTUM_RULES.topHolderPercent && substantial && (soldPercent ?? 0) >= 20;
    const whaleDump = usd >= MOMENTUM_RULES.whaleSellUsd && (m.buyShare ?? 1) <= 0.35;
    if (devDump || holderDump || whaleDump) { majorSell = { wallet, usd, balanceSoldPercent: soldPercent, isDev: owner?.isDev ?? false }; break; }
  }
  if (r <= -MOMENTUM_RULES.hardStopPercent) { p.breachAt ??= now; p.breachTicks++; }
  else { p.breachAt = null; p.breachTicks = 0; }
  const confirmedStop = p.breachAt !== null && p.breachTicks >= 2 && (now - p.breachAt >= MOMENTUM_RULES.confirmStopMs || r <= -MOMENTUM_RULES.emergencyStopPercent || majorSell !== null);
  const trailPercent = Math.min(8, Math.max(4, 2 * m.volatilityPercent));
  const lockReturn = peakReturn >= 10 ? Math.max(MOMENTUM_RULES.profitFloorPercent, (1 + peakReturn / 100) * (1 - trailPercent / 100) * 100 - 100) : peakReturn >= 5 ? MOMENTUM_RULES.profitFloorPercent : null;
  if (r <= -10 && r > -20 && h.significant && (h.observedAt ?? 0) > p.recoverySampleAt && m.buyUsd >= m.sellUsd && now >= p.recoveryUntil) {
    p.recoveryUntil = now + MOMENTUM_RULES.recoveryHoldMs; p.recoverySampleAt = h.observedAt!;
  }
  const strong = m.ready && (m.return5s ?? 0) >= 2 && (m.slope5s ?? 0) > 0 && (m.buyShare ?? 0) >= 0.6 && h.sustained;
  let reason: MomentumExitReason | null = confirmedStop ? (r <= -25 ? 'V2_CONFIRMED_CRASH' : 'V2_HARD_STOP') : majorSell ? 'V2_MAJOR_HOLDER_SELL' : null;
  if (!reason && lockReturn !== null && r <= lockReturn) reason = 'V2_PROFIT_LOCK';
  if (!reason && r >= 50) reason = 'V2_TARGET_50';
  if (!reason && r >= 40 && !strong) reason = 'V2_TARGET_40';
  if (!reason && r >= 6.0 && m.ready && (m.return5s ?? 0) <= 0 && (m.slope5s ?? 0) <= 0 && (m.buyShare ?? 1) < 0.5 && h.fresh && !h.significant) reason = 'V2_MOMENTUM_FADE';
  if (!reason && now >= p.recoveryUntil && r <= -8 && m.ready && m.sellers >= 3 && m.trades >= 10 && (m.buyShare ?? 1) <= 0.3 && (m.slope5s ?? 0) < 0) reason = 'V2_SELL_PRESSURE';
  if (reason) p.closed = true;
  return { reason, observedAt: now, priceUsd: tick.priceUsd, returnPercent: r, peakReturnPercent: peakReturn, drawdownPercent: drawdown,
    trailPercent, lockReturn, majorSell, metrics: m, holders: h, recoveryUntil: p.recoveryUntil,
    breachTicks: p.breachTicks, version: MOMENTUM_RULES.version };
}

export function assessMomentumAggressiveEntry(
  tape: TapeTrade[],
  now: number,
  rules: MomentumAggressiveRules = MOMENTUM_AGGRESSIVE_RULES
) {
  const m = momentumMetrics(tape, now);
  const reasons: string[] = [];
  if (!m.ready) reasons.push('MOMENTUM_INSUFFICIENT_FRESH_HISTORY');
  if (m.return5s === null || m.return5s < rules.minimumReturn5s || (m.slope5s ?? 0) <= 0) reasons.push('MOMENTUM_NOT_RISING');
  if ((m.return5s ?? 0) > rules.maximumReturn5s) reasons.push('MOMENTUM_SPIKE_CHASING');
  if ((m.drawdown5s ?? Infinity) > rules.maximumEntryDrawdown) reasons.push('MOMENTUM_PULLBACK');
  if (m.buyers < rules.minBuyers || (m.buyShare ?? 0) < rules.minBuyShare) reasons.push('MOMENTUM_WEAK_BUY_FLOW');
  if (m.topBuyerShare === null || m.topBuyerShare > rules.maximumBuyerShare) reasons.push('MOMENTUM_SINGLE_BUYER_DOMINANCE');
  if (m.buyUsd < rules.minBuyUsd) reasons.push('MOMENTUM_INSUFFICIENT_BUY_USD');
  return { allowed: reasons.length === 0, reasons, metrics: m, version: rules.version };
}

export function assessMomentumAggressiveSafeEntry(
  tape: TapeTrade[],
  now: number,
  holderDistribution: { allowed: boolean; reason?: string },
  devPercent: number,
  holders?: HolderSample[],
  early: boolean = false,
  buyShare20s?: number | null
) {
  const base = assessMomentumAggressiveEntry(tape, now, MOMENTUM_AGGRESSIVE_SAFE_RULES);
  const reasons = [...base.reasons];
  if (!holderDistribution.allowed) {
    reasons.push(holderDistribution.reason || 'HOLDER_DISTRIBUTION_NOT_ALLOWED');
  }
  if (devPercent > MOMENTUM_AGGRESSIVE_SAFE_RULES.maxDevPercent) {
    reasons.push(`DEV_HOLDING_TOO_HIGH (${devPercent.toFixed(2)}% > ${MOMENTUM_AGGRESSIVE_SAFE_RULES.maxDevPercent}%)`);
  }
  if (holders && early) {
    const h = holderGrowth(holders, now);
    if (!h.sustained) {
      reasons.push('EARLY_HOLDERS_NEED_TWO_GROWING_SNAPSHOTS');
    }
  }
  if (buyShare20s != null && buyShare20s < 50) {
    reasons.push(`FLOW_20S_SELL_DOMINANT (${buyShare20s.toFixed(1)}% < 50%)`);
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: base.metrics,
    version: MOMENTUM_AGGRESSIVE_SAFE_RULES.version,
  };
}

export function assessMomentumAggressiveOptimalEntry(
  tape: TapeTrade[],
  now: number,
  holderDistribution: { allowed: boolean; reason?: string },
  devPercent: number,
  top1Percent?: number | null,
  buyShare20s?: number | null
) {
  const base = assessMomentumAggressiveEntry(tape, now, MOMENTUM_AGGRESSIVE_OPTIMAL_RULES);
  const reasons = [...base.reasons];
  if (!holderDistribution.allowed) {
    reasons.push(holderDistribution.reason || 'HOLDER_DISTRIBUTION_NOT_ALLOWED');
  }
  if (devPercent > MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.maxDevPercent) {
    reasons.push(`DEV_HOLDING_TOO_HIGH (${devPercent.toFixed(2)}% > ${MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.maxDevPercent}%)`);
  }
  if (top1Percent != null && top1Percent > MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.maxTop1Percent) {
    reasons.push(`TOP1_HOLDER_CONCENTRATION (${top1Percent.toFixed(1)}% > ${MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.maxTop1Percent}%)`);
  }
  if (buyShare20s != null && buyShare20s < MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.minBuyShare20s) {
    reasons.push(`FLOW_20S_WEAK (${buyShare20s.toFixed(1)}% < ${MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.minBuyShare20s}%)`);
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: base.metrics,
    version: MOMENTUM_AGGRESSIVE_OPTIMAL_RULES.version,
  };
}

export function assessMomentumAggressiveWideEntry(
  tape: TapeTrade[],
  now: number,
  holderDistribution: { allowed: boolean; reason?: string },
  devPercent: number
) {
  const base = assessMomentumAggressiveEntry(tape, now, MOMENTUM_AGGRESSIVE_WIDE_RULES);
  const reasons = [...base.reasons];
  if (!holderDistribution.allowed) {
    reasons.push(holderDistribution.reason || 'HOLDER_DISTRIBUTION_NOT_ALLOWED');
  }
  if (devPercent > MOMENTUM_AGGRESSIVE_WIDE_RULES.maxDevPercent) {
    reasons.push(`DEV_HOLDING_TOO_HIGH (${devPercent.toFixed(2)}% > ${MOMENTUM_AGGRESSIVE_WIDE_RULES.maxDevPercent}%)`);
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: base.metrics,
    version: MOMENTUM_AGGRESSIVE_WIDE_RULES.version,
  };
}

export function assessMomentumAggressiveSwing100kEntry(
  tape: TapeTrade[],
  now: number,
  holderDistribution: { allowed: boolean; reason?: string },
  devPercent: number,
  top1Percent?: number | null,
  marketCapUsd?: number | null
) {
  const base = assessMomentumAggressiveEntry(tape, now, MOMENTUM_AGGRESSIVE_SWING_100K_RULES);
  const reasons = [...base.reasons];
  if (!holderDistribution.allowed) {
    reasons.push(holderDistribution.reason || 'HOLDER_DISTRIBUTION_NOT_ALLOWED');
  }
  if (devPercent > MOMENTUM_AGGRESSIVE_SWING_100K_RULES.maxDevPercent) {
    reasons.push(`DEV_HOLDING_TOO_HIGH (${devPercent.toFixed(2)}% > ${MOMENTUM_AGGRESSIVE_SWING_100K_RULES.maxDevPercent}%)`);
  }
  if (top1Percent != null && top1Percent > MOMENTUM_AGGRESSIVE_SWING_100K_RULES.maxTop1Percent) {
    reasons.push(`TOP1_HOLDER_CONCENTRATION (${top1Percent.toFixed(1)}% > ${MOMENTUM_AGGRESSIVE_SWING_100K_RULES.maxTop1Percent}%)`);
  }
  if (marketCapUsd != null) {
    if (marketCapUsd < MOMENTUM_AGGRESSIVE_SWING_100K_RULES.minMarketCap || marketCapUsd > MOMENTUM_AGGRESSIVE_SWING_100K_RULES.maxMarketCap) {
      reasons.push(`MC_OUTSIDE_SWING_BAND ($${marketCapUsd.toFixed(0)} outside $10k-$100k)`);
    }
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: base.metrics,
    version: MOMENTUM_AGGRESSIVE_SWING_100K_RULES.version,
  };
}

export function assessMomentumAggressiveWaveEntry(
  tape: TapeTrade[],
  now: number,
  holderDistribution: { allowed: boolean; reason?: string },
  devPercent: number,
  top1Percent?: number | null,
  marketCapUsd?: number | null,
  flowBuyShare?: number | null
) {
  const base = assessMomentumAggressiveEntry(tape, now, MOMENTUM_AGGRESSIVE_WAVE_RULES);
  const reasons = [...base.reasons];
  if (!holderDistribution.allowed) {
    reasons.push(holderDistribution.reason || 'HOLDER_DISTRIBUTION_NOT_ALLOWED');
  }
  if (devPercent > MOMENTUM_AGGRESSIVE_WAVE_RULES.maxDevPercent) {
    reasons.push(`DEV_HOLDING_TOO_HIGH (${devPercent.toFixed(2)}% > ${MOMENTUM_AGGRESSIVE_WAVE_RULES.maxDevPercent}%)`);
  }
  if (top1Percent != null && top1Percent > MOMENTUM_AGGRESSIVE_WAVE_RULES.maxTop1Percent) {
    reasons.push(`TOP1_HOLDER_CONCENTRATION (${top1Percent.toFixed(1)}% > ${MOMENTUM_AGGRESSIVE_WAVE_RULES.maxTop1Percent}%)`);
  }
  if (flowBuyShare != null && flowBuyShare < MOMENTUM_AGGRESSIVE_WAVE_RULES.minBuyShare * 100) {
    reasons.push(`ORDER_FLOW_BUY_DEFICIT (${flowBuyShare.toFixed(1)}% < ${(MOMENTUM_AGGRESSIVE_WAVE_RULES.minBuyShare * 100).toFixed(0)}%)`);
  }
  if (marketCapUsd != null) {
    if (marketCapUsd < MOMENTUM_AGGRESSIVE_WAVE_RULES.minMarketCap || marketCapUsd > MOMENTUM_AGGRESSIVE_WAVE_RULES.maxMarketCap) {
      reasons.push(`MC_OUTSIDE_WAVE_BAND ($${marketCapUsd.toFixed(0)} outside $10k-$100k)`);
    }
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: base.metrics,
    version: MOMENTUM_AGGRESSIVE_WAVE_RULES.version,
  };
}

export function assessMomentumAggressiveExit(
  p: MomentumPosition,
  tick: TapeTrade,
  tape: TapeTrade[],
  rules: MomentumAggressiveRules = MOMENTUM_AGGRESSIVE_RULES
) {
  const now = tick.observedAt;
  if (p.closed || tick.id === p.lastId || now <= p.openedAt || tick.occurredAt < p.entryEventAt || tick.occurredAt < p.lastEventAt || !positive(tick.priceUsd)) return null;
  p.lastId = tick.id; p.lastEventAt = tick.occurredAt;
  const r = pct(tick.priceUsd, p.entry);
  p.peak = Math.max(p.peak, tick.priceUsd);
  const peakReturn = pct(p.peak, p.entry);
  const m = momentumMetrics(tape, now);

  let reason: MomentumAggressiveExitReason | null = null;

  // 0. Dynamic Wave Target TP ("target minimal 20%, analisa dari history ATH")
  const waveTarget = p.dynamicTargetPercent ?? ('takeProfitPercent' in rules && typeof rules.takeProfitPercent === 'number' ? rules.takeProfitPercent : null);
  if (waveTarget !== null && r >= waveTarget) {
    reason = 'AGGRESSIVE_WAVE_TARGET_TP';
  }
  // 1. High Runner Tier Trailing Stop (Peak >= runnerActivationPercent)
  else if (peakReturn >= rules.runnerActivationPercent) {
    const trailFloor = (100 + peakReturn) * (1 - rules.runnerTrailingPercent / 100) - 100;
    const lockFloor = rules.runnerLockPercent;
    if (r <= Math.max(lockFloor, trailFloor)) {
      reason = 'AGGRESSIVE_RUNNER_TRAIL';
    } else if (peakReturn >= rules.breakevenActivationPercent && r <= rules.breakevenFloorPercent) {
      reason = 'AGGRESSIVE_BREAKEVEN_STOP';
    }
  }
  // 2. Dynamic Stop Loss (Breakeven Protection if peak >= breakevenActivationPercent)
  else if (peakReturn >= rules.breakevenActivationPercent) {
    if (r <= rules.breakevenFloorPercent) {
      reason = 'AGGRESSIVE_BREAKEVEN_STOP';
    }
  }
  // 3. Hard Stop Loss ("kalau turun ditunggu dulu", triggers only if r <= -hardStopPercent)
  else if (r <= -rules.hardStopPercent) {
    reason = 'AGGRESSIVE_HARD_STOP';
  }

  // 3. Stagnation exit (momentum stalled > stagnationSeconds)
  if (!reason && (now - p.openedAt) >= rules.stagnationSeconds * 1000) {
    if (peakReturn < rules.stagnationThreshold) {
      reason = 'AGGRESSIVE_STAGNATION';
    }
  }

  // 4. Flow exit (sell flow takes over, if enabled)
  if (!reason && rules.flowExit && m.trades >= 4 && (m.sellUsd ?? 0) >= 100 && m.buyShare !== null && m.buyShare < 0.25 && (m.slope5s ?? 0) < 0) {
    reason = 'AGGRESSIVE_FLOW_EXIT';
  }

  if (reason) p.closed = true;
  const drawdown = (1 - tick.priceUsd / p.peak) * 100;
  const activeTrailPercent = peakReturn >= rules.runnerActivationPercent
    ? rules.runnerTrailingPercent
    : 0;
  const activeLockReturn = peakReturn >= rules.runnerActivationPercent
    ? rules.runnerLockPercent
    : peakReturn >= rules.breakevenActivationPercent
    ? rules.breakevenFloorPercent
    : null;

  return {
    reason,
    observedAt: now,
    priceUsd: tick.priceUsd,
    returnPercent: r,
    peakReturnPercent: peakReturn,
    drawdownPercent: drawdown,
    trailPercent: activeTrailPercent,
    lockReturn: activeLockReturn,
    majorSell: null,
    metrics: m,
    holders: { count: 0, steps: [], fresh: false, significant: false, sustained: false, observedAt: null },
    recoveryUntil: 0,
    breachTicks: 0,
    version: rules.version,
  };
}


export const MOMENTUM_ADAPTIVE_WAVE_RULES = Object.freeze({
  version: 'adaptive-wave-v1',
  hardGates: {
    mcUsd: [10000, 100000],
    minAgeSec: 60,
    minHolders: 100,
    maxTop1Pct: 8.0,
    maxTop5Pct: 25.0,
    maxDevPct: 2.5,
    maxDevSell30sUsd: 25.0
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

export function assessMomentumAdaptiveWaveEntry(
  tape: TapeTrade[],
  now: number,
  holderDistribution: { allowed: boolean; reason?: string },
  devPercent: number,
  top1Percent?: number | null,
  top5Percent?: number | null,
  marketCapUsd?: number | null,
  tokenAgeSec?: number | null,
  holderCount?: number | null
) {
  const rules = MOMENTUM_ADAPTIVE_WAVE_RULES;
  const reasons: string[] = [];

  // Hard Gates
  if (marketCapUsd == null || marketCapUsd < rules.hardGates.mcUsd[0] || marketCapUsd > rules.hardGates.mcUsd[1]) {
    reasons.push('MC_OUT_OF_BOUNDS');
  }
  if (tokenAgeSec == null || tokenAgeSec < rules.hardGates.minAgeSec) reasons.push('AGE_LT_60S');
  if (holderCount != null && holderCount < rules.hardGates.minHolders) reasons.push('HOLDERS_LT_100');
  if (top1Percent != null && top1Percent > rules.hardGates.maxTop1Pct) reasons.push('TOP1_GT_LIMIT');
  if (top5Percent != null && top5Percent > rules.hardGates.maxTop5Pct) reasons.push('TOP5_GT_LIMIT');
  if (devPercent > rules.hardGates.maxDevPct) reasons.push('DEV_GT_LIMIT');
  if (!holderDistribution.allowed) reasons.push(holderDistribution.reason || 'HOLDER_DISTRIBUTION_NOT_ALLOWED');

  // Tape calculation for momentum features
  const windowMs = 5000;
  const t5s = tape.filter(t => t.occurredAt >= now - windowMs && t.occurredAt <= now);
  const t20s = tape.filter(t => t.occurredAt >= now - 20000 && t.occurredAt <= now);

  if (t5s.length < rules.momentumEntry.minTrades5s) {
    reasons.push('TRADES5S_LT_LIMIT');
  }

  const buyers = new Set(t5s.filter(t => t.side === 'buy' && t.wallet).map(t => t.wallet!));
  if (buyers.size < rules.momentumEntry.minBuyers5s) {
    reasons.push('BUYERS_LT_LIMIT');
  }

  let buyUsd = 0;
  let totalUsd5s = 0;
  let topBuyerVol = 0;
  const buyerVols = new Map<string, number>();

  let firstPrice = t5s[0]?.priceUsd;
  let lastPrice = t5s[t5s.length - 1]?.priceUsd;
  let maxPrice = firstPrice;
  
  for (const t of t5s) {
    if (!t.usd || !t.priceUsd) continue;
    totalUsd5s += t.usd;
    if (t.priceUsd > (maxPrice ?? 0)) maxPrice = t.priceUsd;
    if (t.side === 'buy') {
      buyUsd += t.usd;
      if (t.wallet) {
        const v = (buyerVols.get(t.wallet) ?? 0) + t.usd;
        buyerVols.set(t.wallet, v);
        if (v > topBuyerVol) topBuyerVol = v;
      }
    }
  }

  if (buyUsd < rules.momentumEntry.minBuyUsd5s) reasons.push('BUY_USD_LT_LIMIT');
  if (buyUsd > 0 && (topBuyerVol / buyUsd) > rules.momentumEntry.maxTopBuyerShare) reasons.push('TOP_BUYER_GT_LIMIT');

  const buyShare5s = totalUsd5s > 0 ? buyUsd / totalUsd5s : 0;
  if (buyShare5s < rules.momentumEntry.minBuyShare5s) reasons.push('BUY_SHARE_5S_LT_LIMIT');

  let return5s = 0;
  let slope5s = 0;
  let drawdown5s = 0;
  if (firstPrice && lastPrice && firstPrice > 0) {
    return5s = ((lastPrice - firstPrice) / firstPrice) * 100;
    slope5s = return5s / 5.0; // % per second over 5s
    if (maxPrice && maxPrice > 0) {
      drawdown5s = ((maxPrice - lastPrice) / maxPrice) * 100;
    }
  } else {
    reasons.push('PRICE_INVALID');
  }

  if (return5s < rules.momentumEntry.return5sPct[0] || return5s > rules.momentumEntry.return5sPct[1]) reasons.push('RETURN5S_OUT_OF_BOUNDS');
  if (slope5s <= 0) reasons.push('SLOPE_LE_0');
  if (drawdown5s > rules.momentumEntry.maxDrawdown5sPct) reasons.push('DRAWDOWN5S_GT_LIMIT');

  // Buy Share 20s
  let totalUsd20s = 0;
  let buyUsd20s = 0;
  for (const t of t20s) {
    if (!t.usd) continue;
    totalUsd20s += t.usd;
    if (t.side === 'buy') buyUsd20s += t.usd;
  }
  const buyShare20s = totalUsd20s > 0 ? buyUsd20s / totalUsd20s : 0;
  const req20s = return5s >= rules.momentumEntry.adaptiveBuyShare20s.highVolatilityThreshold
    ? rules.momentumEntry.adaptiveBuyShare20s.highVolatilityReq
    : rules.momentumEntry.adaptiveBuyShare20s.base;
  if (buyShare20s < req20s) reasons.push('ADAPTIVE_BUY_SHARE_20S_FAIL');

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: { return5s, slope5s, buyShare5s, buyShare20s, buyUsd, trades: t5s.length, buyers: buyers.size, drawdown5s },
    version: rules.version
  };
}

export function assessMomentumAdaptiveWaveExit(
  p: MomentumPosition,
  tick: TapeTrade,
  tape: TapeTrade[]
) {
  const now = tick.observedAt;
  if (!tick.priceUsd) return null;
  const rawRet = ((tick.priceUsd - p.entry) / p.entry) * 100;
  // Approximation of fees: 2% GMGN + 1% network = 3% total deduction to find net return
  const feeDeductionPct = 3.0;
  const netReturnPct = rawRet - feeDeductionPct;
  const rawPeak = ((p.peak - p.entry) / p.entry) * 100;
  const peakNetReturnPct = rawPeak - feeDeductionPct;

  const rules = MOMENTUM_ADAPTIVE_WAVE_RULES.adaptiveExit;
  const holdSec = (now - p.openedAt) / 1000;

  // Compute 5s tape properties for exit
  const windowMs = 5000;
  const t5s = tape.filter(t => t.occurredAt >= now - windowMs && t.occurredAt <= now);
  
  let totalUsd = 0;
  let sellUsd = 0;
  let sellers = new Set<string>();
  
  let firstPrice = t5s[0]?.priceUsd;
  let lastPrice = t5s[t5s.length - 1]?.priceUsd;
  let slope5s = 0;
  let sockCollapse1s = null;
  
  if (firstPrice && lastPrice && firstPrice > 0) {
    slope5s = ((lastPrice - firstPrice) / firstPrice) * 100 / 5.0;
  }
  
  const t1s = tape.filter(t => t.occurredAt >= now - 1000 && t.occurredAt <= now);
  if (t1s.length > 0 && t1s[0]?.priceUsd && t1s[t1s.length-1]?.priceUsd) {
    sockCollapse1s = ((t1s[t1s.length-1].priceUsd! - t1s[0].priceUsd!) / t1s[0].priceUsd!) * 100;
  }

  for (const t of t5s) {
    if (!t.usd) continue;
    totalUsd += t.usd;
    if (t.side === 'sell') {
      sellUsd += t.usd;
      if (t.wallet) sellers.add(t.wallet);
    }
  }

  const sellShare5s = totalUsd > 0 ? sellUsd / totalUsd : 0;
  const buyShare5s = totalUsd > 0 ? (totalUsd - sellUsd) / totalUsd : 0;

  // 1. Emergency Abort
  let reason: string | null = null;
  if (sockCollapse1s != null && sockCollapse1s <= rules.flashCrash1sPct && sellShare5s >= 0.70) reason = 'FLASH_CRASH_ABORT';
  else if (netReturnPct <= rules.hardStopNetPct) reason = 'HARD_RISK_LIMIT';
  // 2. Flow Broken
  else if (sellShare5s >= 0.70 && sellUsd >= 150 && sellers.size >= 3 && slope5s < 0) reason = 'FLOW_BROKEN';
  // 3. Stagnation
  else if (holdSec >= rules.stagnation.minHoldSec && peakNetReturnPct < rules.stagnation.maxPeakPct && buyShare5s < rules.stagnation.breakFlowShare) reason = 'STAGNATION_DECAY';
  // 4. Time Limit
  else if (holdSec >= 90) reason = 'MAX_HOLD_TIME';
  // 5. Contextual Take Profit
  else if (netReturnPct >= rules.contextualTp.minNetPct && buyShare5s < rules.contextualTp.flowReversalShare) reason = 'CONTEXTUAL_TP';
  // 6. Adaptive Runner Trailing
  else {
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
      reason = peakNetReturnPct >= 12.0 ? 'ADAPTIVE_TRAILING_STOP' : 'BREAKEVEN_FLOOR';
    }
  }

  if (reason) {
    return {
      reason,
      observedAt: now,
      priceUsd: tick.priceUsd,
      returnPercent: rawRet,
      peakReturnPercent: rawPeak,
    };
  }
  return null;
}
