import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMomentumAggressiveExit,
  assessMomentumAggressiveSafeEntry,
  assessMomentumAggressiveOptimalEntry,
  assessMomentumAggressiveWideEntry,
  assessMomentumAggressiveSwing100kEntry,
  assessMomentumAggressiveWaveEntry,
  calculateDynamicWaveTarget,
  createMomentumPosition,
  MOMENTUM_AGGRESSIVE_RULES,
  MOMENTUM_AGGRESSIVE_SAFE_RULES,
  MOMENTUM_AGGRESSIVE_OPTIMAL_RULES,
  MOMENTUM_AGGRESSIVE_WIDE_RULES,
  MOMENTUM_AGGRESSIVE_SWING_100K_RULES,
  MOMENTUM_AGGRESSIVE_WAVE_RULES,
  type TapeTrade,
  type HolderSample
} from '../src/momentum-strategy.js';

const tick = (at: number, price: number, extra: Partial<TapeTrade> = {}): TapeTrade => ({
  id: String(at),
  observedAt: at,
  occurredAt: at,
  priceUsd: price,
  side: 'buy',
  wallet: `w${at % 3}`,
  usd: 50,
  tokens: 1,
  ...extra
});

test('aggressive momentum exit: hard stop triggers at <= -3% when peak < 5%', () => {
  const p = createMomentumPosition(1000, 100);
  const t1 = tick(2000, 102); // peak +2%
  assert.equal(assessMomentumAggressiveExit(p, t1, [t1])?.reason, null);

  const t2 = tick(3000, 96.9); // -3.1%
  const out = assessMomentumAggressiveExit(p, t2, [t1, t2]);
  assert.equal(out?.reason, 'AGGRESSIVE_HARD_STOP');
  assert.equal(p.closed, true);
});

test('aggressive momentum exit: breakeven stop triggers at <= +3.5% when peak >= 8%', () => {
  const p = createMomentumPosition(1000, 100);
  const t1 = tick(2000, 109); // peak +9% (>= 8.0% breakeven threshold)
  assert.equal(assessMomentumAggressiveExit(p, t1, [t1])?.reason, null);

  const t2 = tick(3000, 103.4); // drops to +3.4% (<= +3.5% breakeven floor)
  const out = assessMomentumAggressiveExit(p, t2, [t1, t2]);
  assert.equal(out?.reason, 'AGGRESSIVE_BREAKEVEN_STOP');
  assert.equal(p.closed, true);
});

test('aggressive-safe exit: breakeven stop triggers at <= +3.5% once peak reaches +7.5%', () => {
  const p = createMomentumPosition(1000, 100);
  // Reaches +7.8% peak (>= 7.5% for safe lane, but < 8.0% for control lane)
  const t1 = tick(2000, 107.8);
  assert.equal(assessMomentumAggressiveExit(p, t1, [t1], MOMENTUM_AGGRESSIVE_SAFE_RULES)?.reason, null);

  // Drops to +3.4% (<= +3.5% breakeven floor)
  const t2 = tick(3000, 103.4);
  const out = assessMomentumAggressiveExit(p, t2, [t1, t2], MOMENTUM_AGGRESSIVE_SAFE_RULES);
  assert.equal(out?.reason, 'AGGRESSIVE_BREAKEVEN_STOP');
  assert.equal(p.closed, true);
});

test('aggressive-safe entry: rejects high dev holdings (>2.5%) and concentrated holder distribution', () => {
  const now = 10_000;
  const tape: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.005, side: 'buy', wallet: 'w1', usd: 120, tokens: 120 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.01, side: 'buy', wallet: 'w2', usd: 120, tokens: 118 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.015, side: 'buy', wallet: 'w3', usd: 120, tokens: 117 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.025, side: 'buy', wallet: 'w4', usd: 120, tokens: 116 },
  ];

  // 1. Rejected if holderDistribution.allowed is false
  const rejectedDist = assessMomentumAggressiveSafeEntry(tape, now, { allowed: false, reason: 'CONCENTRATED_SUPPLY' }, 1.5);
  assert.equal(rejectedDist.allowed, false);
  assert.ok(rejectedDist.reasons.includes('CONCENTRATED_SUPPLY'));

  // 2. Rejected if dev holding > 2.5% (e.g. 5.0%)
  const rejectedDev = assessMomentumAggressiveSafeEntry(tape, now, { allowed: true }, 5.42);
  assert.equal(rejectedDev.allowed, false);
  assert.ok(rejectedDev.reasons.some(r => r.includes('DEV_HOLDING_TOO_HIGH')));

  // 3. Allowed when dev holding <= 2.5% and holderDistribution.allowed is true
  const allowedSafe = assessMomentumAggressiveSafeEntry(tape, now, { allowed: true }, 1.06);
  assert.equal(allowedSafe.allowed, true);
  assert.equal(allowedSafe.version, 'momentum-aggressive-safe');

  // 4. Rejected if early token lacks sustained holder growth
  const flatHolders: HolderSample[] = [
    { observedAt: 1000, count: 20 },
    { observedAt: 5000, count: 20 },
  ];
  const rejectedEarlyHolders = assessMomentumAggressiveSafeEntry(tape, now, { allowed: true }, 1.06, flatHolders, true);
  assert.equal(rejectedEarlyHolders.allowed, false);
  assert.ok(rejectedEarlyHolders.reasons.includes('EARLY_HOLDERS_NEED_TWO_GROWING_SNAPSHOTS'));

  // 5. Allowed if early token has sustained holder growth (2 consecutive growing snapshots with gap)
  const growingHolders: HolderSample[] = [
    { observedAt: 1000, count: 20 },
    { observedAt: 5000, count: 25 },
    { observedAt: 9000, count: 32 },
  ];
  const allowedEarlyHolders = assessMomentumAggressiveSafeEntry(tape, now, { allowed: true }, 1.06, growingHolders, true);
  assert.equal(allowedEarlyHolders.allowed, true);

  // 6. Rejected if 20s flow is sell dominant (<50% buy share)
  const rejectedWeakFlow = assessMomentumAggressiveSafeEntry(tape, now, { allowed: true }, 1.06, undefined, false, 42.5);
  assert.equal(rejectedWeakFlow.allowed, false);
  assert.ok(rejectedWeakFlow.reasons.some(r => r.includes('FLOW_20S_SELL_DOMINANT')));
});

test('aggressive-optimal entry: enforces minBuyUsd >= 400, topBuyer <= 50%, and return5s <= 22%', () => {
  const now = 10_000;
  // Tape 1: Total volume = $350 (Allowed in safe, but rejected in optimal due to minBuyUsd $400)
  const tape350: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 50, tokens: 50 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.005, side: 'buy', wallet: 'w1', usd: 75, tokens: 75 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.01, side: 'buy', wallet: 'w2', usd: 75, tokens: 74 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.015, side: 'buy', wallet: 'w3', usd: 75, tokens: 74 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.025, side: 'buy', wallet: 'w4', usd: 75, tokens: 73 },
  ];
  const safeRes = assessMomentumAggressiveSafeEntry(tape350, now, { allowed: true }, 1.0);
  assert.equal(safeRes.allowed, true); // Safe allows >= $300
  const optRes350 = assessMomentumAggressiveOptimalEntry(tape350, now, { allowed: true }, 1.0);
  assert.equal(optRes350.allowed, false); // Optimal requires >= $400
  assert.ok(optRes350.reasons.some(r => r.includes('MOMENTUM_INSUFFICIENT_BUY_USD')));

  // Tape 2: Total volume = $500, but top buyer takes $300 (60% share). Rejected in optimal (>50%), allowed in safe (<=70%)
  const tapeTopBuyer60: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 50, tokens: 50 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.005, side: 'buy', wallet: 'w1', usd: 300, tokens: 298 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.01, side: 'buy', wallet: 'w2', usd: 50, tokens: 49 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.015, side: 'buy', wallet: 'w3', usd: 50, tokens: 49 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.025, side: 'buy', wallet: 'w4', usd: 50, tokens: 49 },
  ];
  const safeResTop = assessMomentumAggressiveSafeEntry(tapeTopBuyer60, now, { allowed: true }, 1.0);
  assert.equal(safeResTop.allowed, true); // Safe allows <= 70%
  const optResTop = assessMomentumAggressiveOptimalEntry(tapeTopBuyer60, now, { allowed: true }, 1.0);
  assert.equal(optResTop.allowed, false); // Optimal requires <= 50%
  assert.ok(optResTop.reasons.some(r => r.includes('MOMENTUM_SINGLE_BUYER_DOMINANCE')));

  // Tape 3: Total volume = $500, well distributed, but price jumped +30% (>22% max return5s). Overbought pump.
  const tapeOverbought: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.05, side: 'buy', wallet: 'w1', usd: 100, tokens: 95 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.10, side: 'buy', wallet: 'w2', usd: 100, tokens: 91 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.15, side: 'buy', wallet: 'w3', usd: 100, tokens: 87 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.30, side: 'buy', wallet: 'w4', usd: 100, tokens: 77 },
  ];
  const optResOverbought = assessMomentumAggressiveOptimalEntry(tapeOverbought, now, { allowed: true }, 1.0);
  assert.equal(optResOverbought.allowed, false);
  assert.ok(optResOverbought.reasons.some(r => r.includes('MOMENTUM_SPIKE_CHASING')));

  // Tape 4: Healthy $500 volume, max wallet $120 (24% <= 50%), return +5% (<= 22%), dev 1.0% (<= 2.0%) -> ALL PASS
  const tapeOptimalPass: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.01, side: 'buy', wallet: 'w1', usd: 100, tokens: 99 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.02, side: 'buy', wallet: 'w2', usd: 100, tokens: 98 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.03, side: 'buy', wallet: 'w3', usd: 100, tokens: 97 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.05, side: 'buy', wallet: 'w4', usd: 100, tokens: 95 },
  ];
  const optResPass = assessMomentumAggressiveOptimalEntry(tapeOptimalPass, now, { allowed: true }, 1.0, 4.5, 75.0);
  assert.equal(optResPass.allowed, true);
  assert.equal(optResPass.version, 'momentum-aggressive-optimal');

  // Test 5: Rejected if Top 1 Holder > 6.0% (Anti-Dump Gate)
  const optResTop1Dump = assessMomentumAggressiveOptimalEntry(tapeOptimalPass, now, { allowed: true }, 1.0, 7.8, 75.0);
  assert.equal(optResTop1Dump.allowed, false);
  assert.ok(optResTop1Dump.reasons.some(r => r.includes('TOP1_HOLDER_CONCENTRATION')));

  // Test 6: Rejected if 20s Buy Flow < 65% (Weak Flow Gate)
  const optResFlowWeak = assessMomentumAggressiveOptimalEntry(tapeOptimalPass, now, { allowed: true }, 1.0, 4.5, 55.0);
  assert.equal(optResFlowWeak.allowed, false);
  assert.ok(optResFlowWeak.reasons.some(r => r.includes('FLOW_20S_WEAK')));
});

test('aggressive momentum exit: runner trail triggers when peak >= 8%', () => {
  const p = createMomentumPosition(1000, 100);
  const t1 = tick(2000, 120); // peak +20% (runner active! trailFloor = 120 * 0.93 - 100 = 11.6%)
  assert.equal(assessMomentumAggressiveExit(p, t1, [t1])?.reason, null);

  const t2 = tick(3000, 111); // drops to +11% (<= 11.6%)
  const out = assessMomentumAggressiveExit(p, t2, [t1, t2]);
  assert.equal(out?.reason, 'AGGRESSIVE_RUNNER_TRAIL');
  assert.equal(p.closed, true);
});

test('aggressive momentum exit: stagnation triggers after 15s if peak < 2.5%', () => {
  const p = createMomentumPosition(1000, 100);
  const t1 = tick(5000, 101.5); // peak +1.5%
  assert.equal(assessMomentumAggressiveExit(p, t1, [t1])?.reason, null);

  const t2 = tick(16500, 101.0); // 15.5s after openedAt, peak < 2.5%
  const out = assessMomentumAggressiveExit(p, t2, [t1, t2]);
  assert.equal(out?.reason, 'AGGRESSIVE_STAGNATION');
  assert.equal(p.closed, true);
});

test('aggressive-wide entry: matches optimal filters (minBuyUsd >= 400, topBuyer <= 50%, return5s <= 22%)', () => {
  const now = 10_000;
  const tapeOptimalPass: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.01, side: 'buy', wallet: 'w1', usd: 100, tokens: 99 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.02, side: 'buy', wallet: 'w2', usd: 100, tokens: 98 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.03, side: 'buy', wallet: 'w3', usd: 100, tokens: 97 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.05, side: 'buy', wallet: 'w4', usd: 100, tokens: 95 },
  ];
  const wideResPass = assessMomentumAggressiveWideEntry(tapeOptimalPass, now, { allowed: true }, 1.0);
  assert.equal(wideResPass.allowed, true);
  assert.equal(wideResPass.version, 'momentum-aggressive-wide');
});

test('aggressive-wide exit: survives -3.5% micro-shakeout (unlike safe/optimal) and stops out at -6.0%', () => {
  const pOptimal = createMomentumPosition(1000, 100);
  const pWide = createMomentumPosition(1000, 100);

  // Micro pullback to -3.5% (like Yaniv and Hero early pullbacks)
  const tShakeout = tick(2000, 96.5);

  // Optimal stops out at -3.0%
  const optOut = assessMomentumAggressiveExit(pOptimal, tShakeout, [tShakeout], MOMENTUM_AGGRESSIVE_OPTIMAL_RULES);
  assert.equal(optOut?.reason, 'AGGRESSIVE_HARD_STOP');
  assert.equal(pOptimal.closed, true);

  // Wide holds through -3.5% (hard stop is -6.0%)
  const wideOut1 = assessMomentumAggressiveExit(pWide, tShakeout, [tShakeout], MOMENTUM_AGGRESSIVE_WIDE_RULES);
  assert.equal(wideOut1?.reason, null);
  assert.equal(pWide.closed, false);

  // Further drop to -6.1% triggers Wide hard stop
  const tStop = tick(3000, 93.9);
  const wideOut2 = assessMomentumAggressiveExit(pWide, tStop, [tShakeout, tStop], MOMENTUM_AGGRESSIVE_WIDE_RULES);
  assert.equal(wideOut2?.reason, 'AGGRESSIVE_HARD_STOP');
  assert.equal(pWide.closed, true);
});

test('aggressive-swing-100k entry: allows valid entry in $10k-$100k MC bracket and rejects outside', () => {
  const now = 10_000;
  const tape: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.01, side: 'buy', wallet: 'w1', usd: 100, tokens: 99 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.015, side: 'buy', wallet: 'w2', usd: 100, tokens: 98 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.02, side: 'buy', wallet: 'w3', usd: 100, tokens: 97 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.03, side: 'buy', wallet: 'w4', usd: 100, tokens: 96 },
  ];

  // 1. Passes inside $10k-$100k (e.g. $35k)
  const passRes = assessMomentumAggressiveSwing100kEntry(tape, now, { allowed: true }, 1.2, 5.0, 35_000);
  assert.equal(passRes.allowed, true);
  assert.equal(passRes.version, 'momentum-aggressive-swing-100k');

  // 2. Rejects if MC < $10k (e.g. $8k)
  const rejectLowMc = assessMomentumAggressiveSwing100kEntry(tape, now, { allowed: true }, 1.2, 5.0, 8_000);
  assert.equal(rejectLowMc.allowed, false);
  assert.ok(rejectLowMc.reasons.some(r => r.includes('MC_OUTSIDE_SWING_BAND')));

  // 3. Rejects if MC > $100k (e.g. $120k)
  const rejectHighMc = assessMomentumAggressiveSwing100kEntry(tape, now, { allowed: true }, 1.2, 5.0, 120_000);
  assert.equal(rejectHighMc.allowed, false);
  assert.ok(rejectHighMc.reasons.some(r => r.includes('MC_OUTSIDE_SWING_BAND')));

  // 4. Rejects if dev holding > 2.5%
  const rejectDev = assessMomentumAggressiveSwing100kEntry(tape, now, { allowed: true }, 3.5, 5.0, 35_000);
  assert.equal(rejectDev.allowed, false);
  assert.ok(rejectDev.reasons.some(r => r.includes('DEV_HOLDING_TOO_HIGH')));

  // 5. Rejects if Top1 holder > 8.0%
  const rejectTop1 = assessMomentumAggressiveSwing100kEntry(tape, now, { allowed: true }, 1.0, 9.5, 35_000);
  assert.equal(rejectTop1.allowed, false);
  assert.ok(rejectTop1.reasons.some(r => r.includes('TOP1_HOLDER_CONCENTRATION')));
});

test('aggressive-swing-100k exit: -4% hard stop, +6.5% breakeven activation, and +9% runner trail', () => {
  // 1. Hard stop triggers at <= -4.0%
  const pStop = createMomentumPosition(1000, 100);
  const tShake = tick(2000, 97.0); // -3.0% (survives)
  assert.equal(assessMomentumAggressiveExit(pStop, tShake, [tShake], MOMENTUM_AGGRESSIVE_SWING_100K_RULES)?.reason, null);

  const tHardStop = tick(3000, 95.8); // -4.2% (triggers hard stop)
  const outStop = assessMomentumAggressiveExit(pStop, tHardStop, [tShake, tHardStop], MOMENTUM_AGGRESSIVE_SWING_100K_RULES);
  assert.equal(outStop?.reason, 'AGGRESSIVE_HARD_STOP');
  assert.equal(pStop.closed, true);

  // 2. Breakeven lock at >= +6.5% peak, floor at +3.5%
  const pBreakeven = createMomentumPosition(1000, 100);
  const tPeakBe = tick(2000, 107.0); // peak +7.0%
  assert.equal(assessMomentumAggressiveExit(pBreakeven, tPeakBe, [tPeakBe], MOMENTUM_AGGRESSIVE_SWING_100K_RULES)?.reason, null);

  const tFloor = tick(3000, 103.4); // retraces to +3.4% (<= +3.5% floor)
  const outBe = assessMomentumAggressiveExit(pBreakeven, tFloor, [tPeakBe, tFloor], MOMENTUM_AGGRESSIVE_SWING_100K_RULES);
  assert.equal(outBe?.reason, 'AGGRESSIVE_BREAKEVEN_STOP');
  assert.equal(pBreakeven.closed, true);

  // 3. Runner trail at >= +9.0% peak
  const pRunner = createMomentumPosition(1000, 100);
  const tRunnerPeak = tick(2000, 115.0); // peak +15.0%
  assert.equal(assessMomentumAggressiveExit(pRunner, tRunnerPeak, [tRunnerPeak], MOMENTUM_AGGRESSIVE_SWING_100K_RULES)?.reason, null);

  // Trail is 5% from peak (115 * 0.95 - 100 = +9.25%)
  const tRunnerRetrace = tick(3000, 109.0); // +9.0% (below +9.25% trail floor)
  const outRunner = assessMomentumAggressiveExit(pRunner, tRunnerRetrace, [tRunnerPeak, tRunnerRetrace], MOMENTUM_AGGRESSIVE_SWING_100K_RULES);
  assert.equal(outRunner?.reason, 'AGGRESSIVE_RUNNER_TRAIL');
  assert.equal(pRunner.closed, true);
});

test('aggressive-wave entry: validates buy/sell order flow balance, holders distribution, dev holdings, and market cap', () => {
  const now = 10_000;
  const tape: TapeTrade[] = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.005, side: 'buy', wallet: 'w1', usd: 100, tokens: 100 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.01, side: 'buy', wallet: 'w2', usd: 100, tokens: 99 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.015, side: 'buy', wallet: 'w3', usd: 100, tokens: 98 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.025, side: 'buy', wallet: 'w4', usd: 100, tokens: 97 },
  ];

  // 1. Valid wave passes: flowBuyShare 70% (>= 60%), dev 2.0% (<= 3.5%), top1 15% (<= 25%), MC $35k
  const validRes = assessMomentumAggressiveWaveEntry(tape, now, { allowed: true }, 2.0, 15.0, 35_000, 70);
  assert.equal(validRes.allowed, true);
  assert.equal(validRes.version, 'momentum-aggressive-wave');

  // 2. Rejects if order flow buy share is under 60% (e.g. 50%)
  const rejectFlow = assessMomentumAggressiveWaveEntry(tape, now, { allowed: true }, 2.0, 15.0, 35_000, 50);
  assert.equal(rejectFlow.allowed, false);
  assert.ok(rejectFlow.reasons.some(r => r.includes('ORDER_FLOW_BUY_DEFICIT')));

  // 3. Rejects if dev holding > 3.5%
  const rejectDev = assessMomentumAggressiveWaveEntry(tape, now, { allowed: true }, 4.5, 15.0, 35_000, 70);
  assert.equal(rejectDev.allowed, false);
  assert.ok(rejectDev.reasons.some(r => r.includes('DEV_HOLDING_TOO_HIGH')));

  // 4. Rejects if top1 holding > 25.0%
  const rejectTop1 = assessMomentumAggressiveWaveEntry(tape, now, { allowed: true }, 2.0, 28.0, 35_000, 70);
  assert.equal(rejectTop1.allowed, false);
  assert.ok(rejectTop1.reasons.some(r => r.includes('TOP1_HOLDER_CONCENTRATION')));

  // 5. Rejects if MC outside $10k-$100k
  const rejectLowMc = assessMomentumAggressiveWaveEntry(tape, now, { allowed: true }, 2.0, 15.0, 5_000, 70);
  assert.equal(rejectLowMc.allowed, false);
  assert.ok(rejectLowMc.reasons.some(r => r.includes('MC_OUTSIDE_WAVE_BAND')));

  const rejectHighMc = assessMomentumAggressiveWaveEntry(tape, now, { allowed: true }, 2.0, 15.0, 150_000, 70);
  assert.equal(rejectHighMc.allowed, false);
  assert.ok(rejectHighMc.reasons.some(r => r.includes('MC_OUTSIDE_WAVE_BAND')));

  // 6. Rejects if holderDistribution.allowed is false
  const rejectDist = assessMomentumAggressiveWaveEntry(tape, now, { allowed: false, reason: 'CONCENTRATED_SUPPLY' }, 2.0, 15.0, 35_000, 70);
  assert.equal(rejectDist.allowed, false);
  assert.ok(rejectDist.reasons.includes('CONCENTRATED_SUPPLY'));
});

test('calculateDynamicWaveTarget: analyzes token candle history, ATH upside, and enforces minimal target 20%', () => {
  // 1. Empty or invalid candles fallback to minimal 20%
  const noCandlesRes = calculateDynamicWaveTarget([], 20_000);
  assert.equal(noCandlesRes.targetPercent, 20.0);
  assert.ok(noCandlesRes.rationale.includes('Baseline minimal target 20%'));

  // 2. Low ATH upside (e.g. entry 20k, ATH 22k -> +10% upside < 25%) -> minimal 20%
  const lowAthCandles = [
    { time: 1, open: 18_000, high: 22_000, low: 17_500, close: 20_000, volume: 1000 },
  ];
  const lowAthRes = calculateDynamicWaveTarget(lowAthCandles, 20_000);
  assert.equal(lowAthRes.targetPercent, 20.0);
  assert.equal(lowAthRes.historicalMaxMcap, 22_000);
  assert.equal(Math.round(lowAthRes.athUpsidePercent), 10);
  assert.ok(lowAthRes.rationale.includes('target minimal 20%'));

  // 3. High ATH token (e.g. entry 20k, historical ATH 40k -> +100% upside) -> target 70% of upside = +70%
  const highAthCandles = [
    { time: 1, open: 15_000, high: 40_000, low: 14_000, close: 25_000, volume: 5000 },
    { time: 2, open: 25_000, high: 26_000, low: 19_000, close: 20_000, volume: 2000 },
  ];
  const highAthRes = calculateDynamicWaveTarget(highAthCandles, 20_000);
  assert.equal(highAthRes.targetPercent, 70.0);
  assert.equal(highAthRes.historicalMaxMcap, 40_000);
  assert.equal(highAthRes.athUpsidePercent, 100.0);
  assert.ok(highAthRes.rationale.includes('target dinaikkan ke +70%'));

  // 4. Massive ATH token (e.g. entry 20k, historical ATH 100k -> +400% upside) -> target capped at 150%
  const massiveAthCandles = [
    { time: 1, open: 10_000, high: 100_000, low: 9_000, close: 30_000, volume: 10000 },
    { time: 2, open: 30_000, high: 30_000, low: 19_000, close: 20_000, volume: 3000 },
  ];
  const massiveAthRes = calculateDynamicWaveTarget(massiveAthCandles, 20_000);
  assert.equal(massiveAthRes.targetPercent, 150.0);
  assert.equal(massiveAthRes.historicalMaxMcap, 100_000);
  assert.equal(massiveAthRes.athUpsidePercent, 400.0);

  // 5. Breakout at ATH with massive historical surge (e.g. entry 30k at ATH, low was 10k -> +200% surge)
  const breakoutCandles = [
    { time: 1, open: 10_000, high: 18_000, low: 10_000, close: 17_000, volume: 4000 },
    { time: 2, open: 17_000, high: 30_000, low: 16_000, close: 30_000, volume: 8000 },
  ];
  const breakoutRes = calculateDynamicWaveTarget(breakoutCandles, 30_000);
  assert.ok(breakoutRes.targetPercent >= 60.0);
  assert.ok(breakoutRes.rationale.includes('breakout di ATH'));
});

test('aggressive-wave exit: Wave Maximizer maximizes profit (no early cut, min 20% target, runner trail 5%, patient downside)', () => {
  // 1. "Jangan langsung tarik": Does NOT exit at small profits like +3.5% or +10%
  const pStandard = createMomentumPosition(1000, 100);
  const tSmall1 = tick(2000, 103.5); // +3.5% (holds, no early cut!)
  assert.equal(assessMomentumAggressiveExit(pStandard, tSmall1, [tSmall1], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  const tSmall2 = tick(3000, 110.0); // +10.0% (holds, riding the wave!)
  assert.equal(assessMomentumAggressiveExit(pStandard, tSmall2, [tSmall1, tSmall2], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  // 2. Hits baseline minimal target at >= +20.0%
  const tTp = tick(4000, 120.5); // +20.5% (>= 20.0% wave target)
  const outTp = assessMomentumAggressiveExit(pStandard, tTp, [tSmall1, tSmall2, tTp], MOMENTUM_AGGRESSIVE_WAVE_RULES);
  assert.equal(outTp?.reason, 'AGGRESSIVE_WAVE_TARGET_TP');
  assert.equal(pStandard.closed, true);

  // 3. Dynamic target higher for high-history tokens (e.g. target +45%)
  const pDynamic = createMomentumPosition(1000, 100, 1000, 45.0);
  const tDyn1 = tick(2000, 125.0); // +25% (holds, target is +45%)
  assert.equal(assessMomentumAggressiveExit(pDynamic, tDyn1, [tDyn1], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  const tDyn2 = tick(3000, 145.2); // +45.2% (reaches dynamic target!)
  const outDyn = assessMomentumAggressiveExit(pDynamic, tDyn2, [tDyn1, tDyn2], MOMENTUM_AGGRESSIVE_WAVE_RULES);
  assert.equal(outDyn?.reason, 'AGGRESSIVE_WAVE_TARGET_TP');
  assert.equal(pDynamic.closed, true);

  // 4. Runner trailing stop: rides wave to peak +28%, trailing 5% protects profit
  const pRunner = createMomentumPosition(1000, 100, 1000, 80.0); // High target +80%
  const tPeakRunner = tick(2000, 128.0); // peak +28% (>= 18% runner active)
  assert.equal(assessMomentumAggressiveExit(pRunner, tPeakRunner, [tPeakRunner], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  // Trail is 5% from peak (128 * 0.95 - 100 = +21.6%)
  const tRetraceRunner = tick(3000, 121.0); // drops to +21.0% (below +21.6% trail floor)
  const outRunner = assessMomentumAggressiveExit(pRunner, tRetraceRunner, [tPeakRunner, tRetraceRunner], MOMENTUM_AGGRESSIVE_WAVE_RULES);
  assert.equal(outRunner?.reason, 'AGGRESSIVE_RUNNER_TRAIL');
  assert.equal(pRunner.closed, true);

  // 5. Breakeven protection if peaked >= +10% and retraces to floor (+3.0%)
  const pBe = createMomentumPosition(1000, 100, 1000, 30.0);
  const tPeakBe = tick(2000, 112.0); // peak +12%
  assert.equal(assessMomentumAggressiveExit(pBe, tPeakBe, [tPeakBe], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  const tRetraceBe = tick(3000, 102.8); // drops to +2.8% (<= +3.0% breakeven floor)
  const outBe = assessMomentumAggressiveExit(pBe, tRetraceBe, [tPeakBe, tRetraceBe], MOMENTUM_AGGRESSIVE_WAVE_RULES);
  assert.equal(outBe?.reason, 'AGGRESSIVE_BREAKEVEN_STOP');
  assert.equal(pBe.closed, true);

  // 6. "Kalau turun ditunggu dulu": Patient downside without panic selling on dips
  const pPatient = createMomentumPosition(1000, 100);
  const tDip1 = tick(2000, 98.0); // -2.0% (holds patient)
  assert.equal(assessMomentumAggressiveExit(pPatient, tDip1, [tDip1], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  const tDip2 = tick(3000, 96.0); // -4.0% (still holding, waiting for recovery)
  assert.equal(assessMomentumAggressiveExit(pPatient, tDip2, [tDip1, tDip2], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  const tDip3 = tick(4000, 94.5); // -5.5% (still holding within -6.0% wide stop)
  assert.equal(assessMomentumAggressiveExit(pPatient, tDip3, [tDip1, tDip2, tDip3], MOMENTUM_AGGRESSIVE_WAVE_RULES)?.reason, null);

  // 7. Hard stop only triggered if dip breaks wide stop <= -6.0%
  const tHardStop = tick(5000, 93.9); // -6.1%
  const outHardStop = assessMomentumAggressiveExit(pPatient, tHardStop, [tDip1, tDip2, tDip3, tHardStop], MOMENTUM_AGGRESSIVE_WAVE_RULES);
  assert.equal(outHardStop?.reason, 'AGGRESSIVE_HARD_STOP');
  assert.equal(pPatient.closed, true);
});

