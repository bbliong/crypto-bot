import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSession,
  findEntry,
  simulate,
  priorEntry,
  priorExit,
  deduplicateTrades,
  agyBestWinRate,
  agyBestRunner,
} from '../scripts/search-websocket-momentum-agy.mjs';

const session = { mint: 'x', startedAt: 0, endedAt: 60000, entryMarketCapUsd: 50000 };
const holder = (at, top1 = 10, tag = false) => ({ observedAt: at, status: 200, top1Percent: top1, queryKeys: tag ? ['tag'] : ['limit'] });
const tick = (at, price) => ({ observedAt: at, priceUsd: price });

test('first matching websocket event triggers entry without a fixed 25-second timer', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 101), tick(7000, 103), tick(26000, 105)], [holder(500)], []);
  const i = findEntry(s, priorEntry);
  assert.equal(s.points[i].at, 7000);
  assert.equal(s.points[i].price, 103);
});

test('future or dev-filtered holder snapshots cannot authorize an earlier buy', () => {
  const ticks = [tick(1000, 100), tick(6000, 103), tick(8000, 104)];
  const s = buildSession(session, ticks, [holder(500, 1, true), holder(7000)], []);
  assert.equal(s.points[findEntry(s, priorEntry)].at, 8000);
  assert.equal(findEntry(buildSession(session, ticks, [holder(9000)], []), priorEntry), -1);
});

test('missing, stale holder and stale momentum anchors fail closed', () => {
  const s = buildSession(session, [tick(1000, 100), tick(40000, 110)], [holder(500)], []);
  assert.equal(findEntry(s, priorEntry), -1);
  assert.equal(s.points[1].returns[5], null);
});

test('exit starts after buy and records stop gaps, not the requested stop price', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(6100, 99)], [holder(500)], []);
  const r = simulate(s, findEntry(s, priorEntry), priorExit);
  assert.equal(r.reason, 'HARD_STOP');
  assert.equal(r.exitAt, 6100);
  assert.ok(Math.abs(r.ret - (99 / 103 - 1) * 100) < 1e-9);
});

test('end of recording is not a sell; delayed fills must use later observed prices', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(6300, 104), tick(7000, 105)], [holder(500)], []);
  const i = findEntry(s, priorEntry), r = simulate(s, i, priorExit, 250);
  assert.equal(r.buyAt, 6300);
  assert.equal(r.buyPrice, 104);
  assert.equal(r.reason, 'CAPTURE_END_MARK_ONLY');
  assert.equal(simulate(s, i, priorExit, 2000).unfilled, true);
});

test('duplicate received trades are not counted repeatedly and future trades do not enter flow', () => {
  const t = { mint: 'x', wallet: 'a', side: 'buy', occurredAt: 5000, observedAt: 5500, priceUsd: 100, amountUsd: 10 };
  assert.equal(deduplicateTrades([t, { ...t, observedAt: 5600 }]).length, 1);
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103)], [holder(500)], [t, { ...t, observedAt: 5600 }, { ...t, wallet: 'b', observedAt: 7000 }]);
  assert.equal(s.points[1].flowTrades, 1);
  assert.equal(s.points[1].uniqueBuyers, 1);
});

test('later bad holder snapshot can trigger an exit only on a subsequent websocket event', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(6500, 103.1), tick(7000, 103.2)], [holder(500), holder(6500, 80)], []);
  const r = simulate(s, findEntry(s, priorEntry), { ...priorExit, holderExit: true });
  assert.equal(r.reason, 'HOLDER_RISK');
  assert.equal(r.exitAt, 7000);
});

test('confirmation requires continuous qualifying events, and resets after a failure', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(6200, 101), tick(6500, 103), tick(6800, 104), tick(7100, 105)], [holder(500)], []);
  const f = { ...priorEntry, confirmMs: 500 };
  assert.equal(s.points[findEntry(s, f)].at, 7100);
});

test('rolling range uses only previous prices and rejects violent recent swings', () => {
  const s = buildSession(session, [tick(1000, 100), tick(5500, 90), tick(6000, 103), tick(6500, 110)], [holder(500)], []);
  assert.ok(s.points[2].range3 > 14 && s.points[2].range3 < 15);
  assert.equal(findEntry(s, { ...priorEntry, maxRange3: 5 }), -1);
});

test('delayed sell executes at the first price after the delay, not at the signal price', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(6300, 104), tick(6400, 102.9), tick(6700, 100)], [holder(500)], []);
  const r = simulate(s, findEntry(s, priorEntry), priorExit, 250);
  assert.equal(r.buyAt, 6300);
  assert.equal(r.exitSignalAt, 6400);
  assert.equal(r.exitAt, 6700);
  assert.equal(r.exitPrice, 100);
  assert.ok(Math.abs(r.ret - (100 / 104 - 1) * 100) < 1e-9);
});

test('adding future observations does not move an earlier first entry', () => {
  const ticks = [tick(1000, 100), tick(6000, 103), tick(6500, 104)];
  const a = buildSession(session, ticks, [holder(500)], []);
  const b = buildSession(session, [...ticks, tick(50000, 1)], [holder(500), holder(40000, 90)], []);
  assert.equal(a.points[findEntry(a, priorEntry)].at, b.points[findEntry(b, priorEntry)].at);
});

test('take-profit signals at an observed price, without inventing a target fill', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(6100, 105)], [holder(500)], []);
  const r = simulate(s, findEntry(s, priorEntry), { ...priorExit, takeProfit: 1 });
  assert.equal(r.reason, 'TAKE_PROFIT');
  assert.equal(r.exitPrice, 105);
  assert.ok(Math.abs(r.ret - (105 / 103 - 1) * 100) < 1e-9);
});

test('maxTop1 filter correctly excludes tokens with top1 holder concentration above threshold', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 103), tick(7000, 105)], [holder(500, 45)], []);
  assert.equal(findEntry(s, { ...priorEntry, maxTop1: 40 }), -1);
  assert.notEqual(findEntry(s, { ...priorEntry, maxTop1: 50 }), -1);
});

test('agyBestWinRate and agyBestRunner formulas execute successfully and produce valid simulation results', () => {
  const s = buildSession(session, [tick(1000, 100), tick(6000, 101), tick(7000, 102), tick(8000, 105)], [holder(500, 20)], [
    { mint: 'x', wallet: 'w1', side: 'buy', occurredAt: 6000, observedAt: 6500, priceUsd: 101, amountUsd: 100 },
    { mint: 'x', wallet: 'w2', side: 'buy', occurredAt: 6100, observedAt: 6600, priceUsd: 101.5, amountUsd: 100 },
  ]);
  const iWin = findEntry(s, agyBestWinRate.entry);
  assert.notEqual(iWin, -1);
  const rWin = simulate(s, iWin, agyBestWinRate.exit, 0);
  assert.ok(rWin !== null && typeof rWin.ret === 'number');

  const iRun = findEntry(s, agyBestRunner.entry);
  assert.notEqual(iRun, -1);
  const rRun = simulate(s, iRun, agyBestRunner.exit, 0);
  assert.ok(rRun !== null && typeof rRun.ret === 'number');
});

test('assessMomentumAggressiveEntry and assessMomentumAggressiveExit perform as specified', async () => {
  const { assessMomentumAggressiveEntry, assessMomentumAggressiveExit, createMomentumPosition } = await import('../src/momentum-strategy.js');
  
  const now = 10_000;
  const tape = [
    { id: '0', observedAt: 5000, occurredAt: 5000, priceUsd: 1.0, side: 'buy', wallet: 'w0', usd: 100, tokens: 100 },
    { id: '1', observedAt: 6000, occurredAt: 6000, priceUsd: 1.005, side: 'buy', wallet: 'w1', usd: 120, tokens: 120 },
    { id: '2', observedAt: 7000, occurredAt: 7000, priceUsd: 1.01, side: 'buy', wallet: 'w2', usd: 120, tokens: 118 },
    { id: '3', observedAt: 8000, occurredAt: 8000, priceUsd: 1.015, side: 'buy', wallet: 'w3', usd: 120, tokens: 117 },
    { id: '4', observedAt: 9500, occurredAt: 9500, priceUsd: 1.025, side: 'buy', wallet: 'w4', usd: 120, tokens: 116 },
  ];

  const entry = assessMomentumAggressiveEntry(tape, now);
  assert.equal(entry.allowed, true);
  assert.equal(entry.version, 'momentum-aggressive');

  const pos = createMomentumPosition(now, 1.02);
  
  // Test profit trail: price surges to +5%, then drops to +3%
  const surgeTick = { id: '4', observedAt: 12000, occurredAt: 12000, priceUsd: 1.071, side: 'buy', wallet: 'w4', usd: 50, tokens: 46 };
  const d1 = assessMomentumAggressiveExit(pos, surgeTick, [...tape, surgeTick]);
  assert.equal(d1?.reason, null);

  const pullTick = { id: '5', observedAt: 13000, occurredAt: 13000, priceUsd: 1.045, side: 'sell', wallet: 'w5', usd: 50, tokens: 47 };
  const d2 = assessMomentumAggressiveExit(pos, pullTick, [...tape, surgeTick, pullTick]);
  assert.equal(d2?.reason, 'AGGRESSIVE_PROFIT_TRAIL');

  // Test runner tier: position reaches +20% (runner tier), slight pullback of 3% does NOT exit, but 9% pullback exits with AGGRESSIVE_RUNNER_TRAIL
  const posRunner = createMomentumPosition(now, 1.00);
  const surgeRunner = { id: '6', observedAt: 14000, occurredAt: 14000, priceUsd: 1.20, side: 'buy', wallet: 'w6', usd: 200, tokens: 166 };
  const dRunner1 = assessMomentumAggressiveExit(posRunner, surgeRunner, [...tape, surgeRunner]);
  assert.equal(dRunner1?.reason, null);

  // Pullback from +20% to +15% (only 4.1% drawdown from peak 1.20) -> should NOT exit because runner trail is 8%
  const minorPullback = { id: '7', observedAt: 15000, occurredAt: 15000, priceUsd: 1.15, side: 'sell', wallet: 'w7', usd: 50, tokens: 43 };
  const dRunner2 = assessMomentumAggressiveExit(posRunner, minorPullback, [...tape, surgeRunner, minorPullback]);
  assert.equal(dRunner2?.reason, null);

  // Pullback from +20% to +1.09 (9.1% drawdown from peak 1.20 -> below 1.20 * 0.92 = 1.104) -> triggers AGGRESSIVE_RUNNER_TRAIL
  const majorPullback = { id: '8', observedAt: 16000, occurredAt: 16000, priceUsd: 1.09, side: 'sell', wallet: 'w8', usd: 50, tokens: 45 };
  const dRunner3 = assessMomentumAggressiveExit(posRunner, majorPullback, [...tape, surgeRunner, majorPullback]);
  assert.equal(dRunner3?.reason, 'AGGRESSIVE_RUNNER_TRAIL');
});
