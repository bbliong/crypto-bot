import test from 'node:test';
import assert from 'node:assert/strict';
import { assessFlowDistributionEntry, assessMomentumEntry, assessMomentumExit, createMomentumPosition, holderGrowth, momentumMetrics, MOMENTUM_R5_BAND, type TapeTrade } from '../src/momentum-strategy.js';
const tick = (at: number, price: number, extra: Partial<TapeTrade> = {}): TapeTrade => ({ id: String(at), observedAt: at, occurredAt: at, priceUsd: price, side: 'buy', wallet: `w${at % 3}`, usd: 20, tokens: 1, ...extra });
const rising = Array.from({ length: 11 }, (_, i) => tick(i * 1000, 100 + i));
test('momentum measures five seconds, ignores future/out-of-order frames and one-tick history', () => {
  const m = momentumMetrics(rising, 10000);
  assert.equal(m.ready, true);
  assert.ok(Math.abs(m.return5s! - (110 / 105 - 1) * 100) < 1e-8);
  assert.equal(momentumMetrics([tick(10000, 100)], 10000).ready, false);
  const withFuture = momentumMetrics([...rising, tick(11000, 900)], 10000);
  assert.deepEqual(m, withFuture);
  const late = tick(10001, 1, { occurredAt: 9000 });
  assert.equal(momentumMetrics([...rising, late], 10001).priceUsd, 110);
});
test('entry rejects flat, single-wallet pumping and requires two distinct growing holder intervals for early candles', () => {
  const hs = [{ observedAt: 0, count: 100 }, { observedAt: 5000, count: 110 }, { observedAt: 10000, count: 121 }];
  assert.equal(assessMomentumEntry(rising, hs, 10000, true).allowed, true);
  assert.equal(assessMomentumEntry(rising, hs.slice(1), 10000, true).allowed, false);
  assert.equal(holderGrowth(hs.map(s => ({ ...s, observedAt: s.observedAt / 10 })), 1000).sustained, false);
  assert.equal(holderGrowth(hs, 17000).fresh, false);
  assert.ok(assessMomentumEntry(rising.map(t => ({ ...t, wallet: 'one' })), hs, 10000, false).reasons.includes('MOMENTUM_SINGLE_BUYER_DOMINANCE'));
  assert.ok(assessMomentumEntry(rising.map(t => ({ ...t, priceUsd: 100 })), hs, 10000, false).reasons.includes('MOMENTUM_NOT_RISING'));
});
test('R5-band lane keeps the base gates and waits for momentum from 5% through below 10%', () => {
  const holders = [{ observedAt: 0, count: 100 }, { observedAt: 5000, count: 110 }, { observedAt: 10000, count: 121 }];
  const slow = Array.from({ length: 11 }, (_, i) => tick(i * 1000, 100 + i));
  assert.ok(assessMomentumEntry(slow, holders, 10000, false).allowed);
  assert.ok(assessMomentumEntry(slow, holders, 10000, false, MOMENTUM_R5_BAND).reasons.includes('MOMENTUM_R5_BELOW_BAND'));
  const fast = Array.from({ length: 11 }, (_, i) => tick(i * 1000, 100 + i * 3));
  assert.ok(assessMomentumEntry(fast, holders, 10000, false, MOMENTUM_R5_BAND).reasons.includes('MOMENTUM_R5_ABOVE_BAND'));
});
test('flow-distribution lane requires diverse, buy-led flow and a verified unconcentrated Top-10', () => {
  const holders = [{ observedAt: 0, count: 100 }, { observedAt: 5000, count: 110 }, { observedAt: 10000, count: 121 }];
  const tape = Array.from({ length: 11 }, (_, i) => tick(i * 1000, 100 + i, { wallet: `b${i}`, usd: 20 }));
  assert.equal(assessFlowDistributionEntry(tape, holders, 10000, false, 12).allowed, true);
  assert.ok(assessFlowDistributionEntry(tape, holders, 10000, false, 15).reasons.includes('FLOW_DISTRIBUTION_TOP10_CONCENTRATED'));
  assert.ok(assessFlowDistributionEntry([...tape, tick(9900, 109, { id: 'sell-1', side: 'sell', wallet: 'seller-1', usd: 20 }), tick(10000, 110, { id: 'sell-2', side: 'sell', wallet: 'seller-2', usd: 20 })], holders, 10000, false, 12).reasons.includes('FLOW_DISTRIBUTION_TOO_MANY_SELLERS'));
});
test('hard stop needs distinct evidence; gap exits record actual price, never an invented -20% fill', () => {
  const p = createMomentumPosition(1000, 100), one = tick(2000, 79);
  assert.equal(assessMomentumExit(p, one, [one], [], [])?.reason, null);
  assert.equal(assessMomentumExit(p, one, [one], [], []), null);
  const two = tick(2500, 65);
  const out = assessMomentumExit(p, two, [one, two], [], []);
  assert.equal(out?.reason, 'V2_CONFIRMED_CRASH'); assert.equal(out?.returnPercent, -35);
  assert.equal(assessMomentumExit(p, tick(3000, 50), [], [], []), null);
});
test('hard-stop timer resets on recovery and delayed historic trades cannot sell a new position', () => {
  const p = createMomentumPosition(1000, 100);
  assert.equal(assessMomentumExit(p, tick(2000, 60, { occurredAt: 900 }), [], [], []), null);
  for (const t of [tick(2200, 79), tick(2600, 90), tick(4100, 79)]) assert.equal(assessMomentumExit(p, t, [t], [], [])?.reason, null);
  assert.equal(p.breachTicks, 1);
});
test('tiny top-holder sale does not dump, substantial balance reduction exits even before price falls', () => {
  const p = createMomentumPosition(1000, 100), owners = [{ wallet: 'top', observedAt: 900, balance: 1000, percent: 2, isDev: false }];
  const dust = tick(2000, 101, { side: 'sell', wallet: 'top', usd: 0.02, tokens: 0.01 });
  assert.equal(assessMomentumExit(p, dust, [dust], [], owners)?.reason, null);
  const big = tick(2500, 102, { side: 'sell', wallet: 'top', usd: 40, tokens: 250 });
  assert.equal(assessMomentumExit(p, big, [dust, big], [], owners)?.reason, 'V2_MAJOR_HOLDER_SELL');
  const futureOwner = owners.map(o => ({ ...o, observedAt: 4000 }));
  assert.equal(assessMomentumExit(createMomentumPosition(1000, 100), big, [big], [], futureOwner)?.reason, null);
});
test('targets and profit locks are mutually exclusive and retain gap-through prices', () => {
  const p = createMomentumPosition(1000, 100);
  assert.equal(assessMomentumExit(p, tick(2000, 106), [], [], [])?.reason, null);
  const exit = assessMomentumExit(p, tick(2100, 91), [], [], []);
  assert.equal(exit?.reason, 'V2_PROFIT_LOCK'); assert.ok(Math.abs(exit!.returnPercent + 9) < 1e-8);
  assert.equal(assessMomentumExit(createMomentumPosition(1000, 100), tick(2000, 141), [], [], [])?.reason, 'V2_TARGET_40');
  assert.equal(assessMomentumExit(createMomentumPosition(1000, 100), tick(2000, 151), [], [], [])?.reason, 'V2_TARGET_50');
});
test('received frames tolerate bounded source clock skew without allowing unreceived future data', () => {
  const ahead = rising.map(t => ({ ...t, occurredAt: t.observedAt + 2000 }));
  assert.equal(momentumMetrics(ahead, 10000).ready, true);
  assert.equal(momentumMetrics(ahead.map(t => ({ ...t, occurredAt: t.observedAt + 4000 })), 10000).ready, false);
  const p = createMomentumPosition(1000, 100, 3000);
  const sell = tick(2000, 141, { occurredAt: 4000 });
  assert.equal(assessMomentumExit(p, sell, [sell], [], [])?.reason, 'V2_TARGET_40');
});
test('strong holder momentum defers +40% but never the +50% cap', () => {
  const tape = Array.from({ length: 11 }, (_, i) => tick(i * 1000, 135 + i));
  const hs = [{ observedAt: 0, count: 100 }, { observedAt: 5000, count: 110 }, { observedAt: 10000, count: 121 }];
  const p = createMomentumPosition(500, 100);
  assert.equal(assessMomentumExit(p, tape.at(-1)!, tape, hs, [])?.reason, null);
  const next = tick(11000, 151);
  assert.equal(assessMomentumExit(p, next, [...tape, next], hs, [])?.reason, 'V2_TARGET_50');
});
