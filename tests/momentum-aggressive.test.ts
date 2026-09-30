import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMomentumAggressiveExit,
  createMomentumPosition,
  MOMENTUM_AGGRESSIVE_RULES,
  type TapeTrade
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

test('aggressive momentum exit: breakeven stop triggers at <= +0.5% when peak >= 5%', () => {
  const p = createMomentumPosition(1000, 100);
  const t1 = tick(2000, 106); // peak +6% (>= 5% breakeven threshold)
  assert.equal(assessMomentumAggressiveExit(p, t1, [t1])?.reason, null);

  const t2 = tick(3000, 100.4); // drops to +0.4% (<= +0.5% breakeven floor)
  const out = assessMomentumAggressiveExit(p, t2, [t1, t2]);
  assert.equal(out?.reason, 'AGGRESSIVE_BREAKEVEN_STOP');
  assert.equal(p.closed, true);
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
