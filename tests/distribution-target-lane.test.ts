import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TARGET_RULES, DistributionTargetLane, TargetObservation, assessTargetEntry, validateTargetRules, type TargetFacts, type TargetEvent } from '../src/distribution-target-lane.js';
const rules = () => ({ ...DEFAULT_TARGET_RULES, confirmSeconds: 1 });
const facts = (now = 100000, price = 1): TargetFacts => ({
  now, transferAt: 0, firstAt: 1000, price, priceAt: now, momentumPercent: 1,
  drawdownPercent: 0, entryReturnPercent: 1, holderCount: 100, holderGrowth15s: 2,
  buyShareUsdPercent: 80, meaningfulBuyUsd: 80, meaningfulBuyers: 4,
  topBuyerSharePercent: 40, sellUsd: 20, largestSellUsd: 5, riskWalletsPresent: [],
});
test('observation, late opening, missing holder and weak real buy value block entry', () => {
  assert.ok(assessTargetEntry(facts(20000), rules()).includes('OBSERVATION_NOT_COMPLETE'));
  assert.ok(assessTargetEntry({ ...facts(), firstAt: 40000 }, rules()).includes('MONITOR_STARTED_TOO_LATE'));
  assert.ok(assessTargetEntry({ ...facts(), holderGrowth15s: null }, rules()).includes('HOLDER_HISTORY_MISSING_OR_STALE'));
  assert.ok(assessTargetEntry({ ...facts(), meaningfulBuyers: 100, meaningfulBuyUsd: 1 }, rules()).includes('MEANINGFUL_BUY_FLOW_WEAK'));
});
test('paper entry waits for an actual later quote and rechecks risk', () => {
  const a = new DistributionTargetLane('mint', rules());
  a.step(facts()); assert.equal(a.phase, 'ENTRY_PENDING');
  a.step({ ...facts(101000), priceAt: 100000 }); assert.equal(a.entryAt, null);
  a.step({ ...facts(102000), riskWalletsPresent: ['known'] }); assert.equal(a.entryAt, null);
  assert.equal(a.phase, 'WATCHING');
});
test('net target includes costs; exit fill uses future available price without clamping the loss', () => {
  const events: TargetEvent[] = [], a = new DistributionTargetLane('mint', rules(), e => events.push(e));
  a.step(facts()); a.step(facts(101000));
  a.step(facts(102000, 1.20)); assert.equal(a.phase, 'OPEN'); // gross +20 is below net +20
  a.step(facts(103000, 1.25)); assert.equal(a.phase, 'EXIT_PENDING');
  a.step(facts(104000, 0.1)); assert.equal(a.phase, 'CLOSED');
  assert.ok(a.netReturnPercent! < -90);
  assert.equal(events.at(-1)?.reason, 'TARGET_NET');
});
test('stop loss gaps can exceed five percent and missing exit quotes are censored', () => {
  const a = new DistributionTargetLane('mint', rules()); a.step(facts()); a.step(facts(101000));
  a.step(facts(102000, 0.5)); a.step(facts(103000, 0.2)); assert.ok(a.netReturnPercent! < -80);
  const b = new DistributionTargetLane('other', rules()); b.step(facts()); b.step(facts(101000)); b.step(facts(102000, 0.5));
  b.step({ ...facts(108000), price: null, priceAt: null });
  assert.equal(b.phase, 'CENSORED'); assert.equal(b.netReturnPercent, null);
});
test('rule version and parameters are frozen for an existing position', () => {
  const r = rules(), a = new DistributionTargetLane('mint', r);
  r.targetPercent = 25; r.version = 'new'; assert.equal(a.rules.targetPercent, 20); assert.equal(a.rules.version, DEFAULT_TARGET_RULES.version);
  assert.throws(() => validateTargetRules({ ...r, paperOnly: false }));
});

test('additional holder policy rechecks on fill, is frozen, and exits with the same delayed quote rules', () => {
  const policy = { name: 'holder-research', entryReasons: (f: TargetFacts) => f.meaningfulBuyers < 3 ? ['UNIQUE_BUYERS_LOW'] : [],
    exitReason: (f: TargetFacts) => f.holderGrowth15s! < 0 ? 'HOLDER_EXIT' : null };
  const events: TargetEvent[] = [], a = new DistributionTargetLane('mint', rules(), e => events.push(e), policy);
  policy.entryReasons = () => ['MUTATED'];
  a.step(facts()); a.step({ ...facts(101000), meaningfulBuyers: 2 });
  assert.equal(a.entryAt, null); assert.equal(a.phase, 'WATCHING');
  a.step(facts(102000)); a.step(facts(103000)); assert.equal(a.entryAt, 103000);
  a.step({ ...facts(104000, 1.1), holderGrowth15s: -1 }); assert.equal(a.phase, 'EXIT_PENDING');
  a.step({ ...facts(105000, .9), priceAt: 104000 }); assert.equal(a.exitAt, null);
  a.step(facts(106000, .8)); assert.equal(a.exitAt, 106000); assert.ok(a.netReturnPercent! < -20);
  assert.equal(events.at(-1)?.reason, 'HOLDER_EXIT'); assert.equal(events.at(-1)?.policyName, 'holder-research');
  const b = new DistributionTargetLane('target', rules(), e => events.push(e), { name: 'alarm', exitReason: () => 'ALARM' });
  b.step(facts()); b.step(facts(101000)); b.step(facts(102000, 1.25)); b.step(facts(103000, 1.25));
  assert.equal(events.at(-1)?.reason, 'TARGET_NET');
});
test('future trades, stale counts and not-yet-known seller identities do not authorize entry', () => {
  const s = new TargetObservation(0);
  s.trade({ at: 100000, timestamp: 100, wallet: 'risk', price: 1, usd: 5, side: 'buy' });
  const baseline = s.facts(100000, [{ wallet: 'risk', knownAt: 100001 }]);
  s.trades.push({ at: 100001, timestamp: 100, wallet: 'future', price: 100, usd: 100000, side: 'buy' });
  s.count({ at: 100001, count: 10000 });
  assert.deepEqual(s.facts(100000, [{ wallet: 'risk', knownAt: 100001 }]), baseline);
  assert.equal(baseline.holderCount, null); assert.deepEqual(baseline.riskWalletsPresent, []);
  s.holding('risk', { at: 99000, amount: 100, sells: 0 });
  const held = s.facts(100000, [{ wallet: 'risk', knownAt: 99000 }]);
  s.holding('risk', { at: 100001, amount: 0, sells: 1 });
  assert.deepEqual(s.facts(100000, [{ wallet: 'risk', knownAt: 99000 }]), held);
});
