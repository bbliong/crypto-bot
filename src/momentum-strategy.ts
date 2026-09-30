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
  holderEvidenceMaxAgeMs: 30_000, profitFloorPercent: 1,
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
  breakevenActivationPercent: 5.0,
  breakevenFloorPercent: 0.5,
  runnerActivationPercent: 8.0,
  runnerTrailingPercent: 7.0,
  runnerLockPercent: 4.0,
  stagnationSeconds: 15,
  stagnationThreshold: 2.5,
  flowExit: false,
  minMarketCap: 5_500,
  maxMarketCap: 15_000,
});

export type MomentumAggressiveExitReason =
  | 'AGGRESSIVE_HARD_STOP'
  | 'AGGRESSIVE_BREAKEVEN_STOP'
  | 'AGGRESSIVE_PROFIT_TRAIL'
  | 'AGGRESSIVE_RUNNER_TRAIL'
  | 'AGGRESSIVE_STAGNATION'
  | 'AGGRESSIVE_FLOW_EXIT'
  | 'AGGRESSIVE_OBSERVATION_END';

export type MomentumExitReason = 'V2_HARD_STOP' | 'V2_CONFIRMED_CRASH' | 'V2_MAJOR_HOLDER_SELL' | 'V2_PROFIT_LOCK' | 'V2_TARGET_40' | 'V2_TARGET_50' | 'V2_MOMENTUM_FADE' | 'V2_SELL_PRESSURE' | MomentumAggressiveExitReason;
export type MomentumPosition = { openedAt: number; entry: number; peak: number; lastId: string | null; entryEventAt: number; lastEventAt: number;
  breachAt: number | null; breachTicks: number; recoveryUntil: number; recoverySampleAt: number; closed: boolean };
export function createMomentumPosition(openedAt: number, entry: number, entryEventAt = openedAt): MomentumPosition {
  if (!positive(entry)) throw new Error('Invalid entry price');
  return { openedAt, entry, peak: entry, lastId: null, entryEventAt, lastEventAt: entryEventAt, breachAt: null, breachTicks: 0, recoveryUntil: 0, recoverySampleAt: 0, closed: false };
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
  if (!reason && r >= 3 && m.ready && (m.return5s ?? 0) <= 0 && (m.slope5s ?? 0) <= 0 && (m.buyShare ?? 1) < 0.5 && h.fresh && !h.significant) reason = 'V2_MOMENTUM_FADE';
  if (!reason && now >= p.recoveryUntil && r <= -8 && m.ready && m.sellers >= 3 && m.trades >= 10 && (m.buyShare ?? 1) <= 0.3 && (m.slope5s ?? 0) < 0) reason = 'V2_SELL_PRESSURE';
  if (reason) p.closed = true;
  return { reason, observedAt: now, priceUsd: tick.priceUsd, returnPercent: r, peakReturnPercent: peakReturn, drawdownPercent: drawdown,
    trailPercent, lockReturn, majorSell, metrics: m, holders: h, recoveryUntil: p.recoveryUntil,
    breachTicks: p.breachTicks, version: MOMENTUM_RULES.version };
}

export function assessMomentumAggressiveEntry(tape: TapeTrade[], now: number) {
  const m = momentumMetrics(tape, now);
  const reasons: string[] = [];
  if (!m.ready) reasons.push('MOMENTUM_INSUFFICIENT_FRESH_HISTORY');
  if (m.return5s === null || m.return5s < MOMENTUM_AGGRESSIVE_RULES.minimumReturn5s || (m.slope5s ?? 0) <= 0) reasons.push('MOMENTUM_NOT_RISING');
  if ((m.return5s ?? 0) > MOMENTUM_AGGRESSIVE_RULES.maximumReturn5s) reasons.push('MOMENTUM_SPIKE_CHASING');
  if ((m.drawdown5s ?? Infinity) > MOMENTUM_AGGRESSIVE_RULES.maximumEntryDrawdown) reasons.push('MOMENTUM_PULLBACK');
  if (m.buyers < MOMENTUM_AGGRESSIVE_RULES.minBuyers || (m.buyShare ?? 0) < MOMENTUM_AGGRESSIVE_RULES.minBuyShare) reasons.push('MOMENTUM_WEAK_BUY_FLOW');
  if (m.topBuyerShare === null || m.topBuyerShare > MOMENTUM_AGGRESSIVE_RULES.maximumBuyerShare) reasons.push('MOMENTUM_SINGLE_BUYER_DOMINANCE');
  if (m.buyUsd < MOMENTUM_AGGRESSIVE_RULES.minBuyUsd) reasons.push('MOMENTUM_INSUFFICIENT_BUY_USD');
  return { allowed: reasons.length === 0, reasons, metrics: m, version: MOMENTUM_AGGRESSIVE_RULES.version };
}

export function assessMomentumAggressiveExit(p: MomentumPosition, tick: TapeTrade, tape: TapeTrade[]) {
  const now = tick.observedAt;
  if (p.closed || tick.id === p.lastId || now <= p.openedAt || tick.occurredAt < p.entryEventAt || tick.occurredAt < p.lastEventAt || !positive(tick.priceUsd)) return null;
  p.lastId = tick.id; p.lastEventAt = tick.occurredAt;
  const r = pct(tick.priceUsd, p.entry);
  p.peak = Math.max(p.peak, tick.priceUsd);
  const peakReturn = pct(p.peak, p.entry);
  const m = momentumMetrics(tape, now);

  let reason: MomentumAggressiveExitReason | null = null;

  // 1. Dynamic Stop Loss (Breakeven Protection if peak >= 5%, otherwise Hard Stop -3%)
  const effectiveStopLoss = peakReturn >= MOMENTUM_AGGRESSIVE_RULES.breakevenActivationPercent
    ? MOMENTUM_AGGRESSIVE_RULES.breakevenFloorPercent
    : -MOMENTUM_AGGRESSIVE_RULES.hardStopPercent;

  if (r <= effectiveStopLoss) {
    reason = peakReturn >= MOMENTUM_AGGRESSIVE_RULES.breakevenActivationPercent
      ? 'AGGRESSIVE_BREAKEVEN_STOP'
      : 'AGGRESSIVE_HARD_STOP';
  }
  // 2. High Runner Tier Trailing Stop (Peak >= 8%)
  else if (peakReturn >= MOMENTUM_AGGRESSIVE_RULES.runnerActivationPercent) {
    const trailFloor = (100 + peakReturn) * (1 - MOMENTUM_AGGRESSIVE_RULES.runnerTrailingPercent / 100) - 100;
    const lockFloor = MOMENTUM_AGGRESSIVE_RULES.runnerLockPercent;
    if (r <= Math.max(lockFloor, trailFloor)) {
      reason = 'AGGRESSIVE_RUNNER_TRAIL';
    }
  }

  // 3. Stagnation exit (momentum stalled > stagnationSeconds)
  if (!reason && (now - p.openedAt) >= MOMENTUM_AGGRESSIVE_RULES.stagnationSeconds * 1000) {
    if (peakReturn < MOMENTUM_AGGRESSIVE_RULES.stagnationThreshold) {
      reason = 'AGGRESSIVE_STAGNATION';
    }
  }

  // 4. Flow exit (sell flow takes over, if enabled)
  if (!reason && MOMENTUM_AGGRESSIVE_RULES.flowExit && m.trades >= 4 && (m.sellUsd ?? 0) >= 100 && m.buyShare !== null && m.buyShare < 0.25 && (m.slope5s ?? 0) < 0) {
    reason = 'AGGRESSIVE_FLOW_EXIT';
  }

  if (reason) p.closed = true;
  const drawdown = (1 - tick.priceUsd / p.peak) * 100;
  const activeTrailPercent = peakReturn >= MOMENTUM_AGGRESSIVE_RULES.runnerActivationPercent
    ? MOMENTUM_AGGRESSIVE_RULES.runnerTrailingPercent
    : 0;
  const activeLockReturn = peakReturn >= MOMENTUM_AGGRESSIVE_RULES.runnerActivationPercent
    ? MOMENTUM_AGGRESSIVE_RULES.runnerLockPercent
    : peakReturn >= MOMENTUM_AGGRESSIVE_RULES.breakevenActivationPercent
    ? MOMENTUM_AGGRESSIVE_RULES.breakevenFloorPercent
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
    version: MOMENTUM_AGGRESSIVE_RULES.version,
  };
}

