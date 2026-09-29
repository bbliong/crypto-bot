import test from 'node:test';
import assert from 'node:assert/strict';
import { assessPreBuyHolderGate } from '../src/prebuy-holder-gate.js';

const status = (observedAt: number, state = 200) => ({ status: state, observedAt, source: 'replayed_xhr' as const });
const holder = (percentage: number | null, isDev = false, raw: Record<string, string | number | boolean | null> = {}) => ({ amountPercentage: percentage, isDev, raw });

test('requires fresh full-holder and independent fresh dev-tag responses', () => {
  const data = { now: 100_000, holders: [holder(20), holder(10, true)], holderStatus: status(70_001), developerStatus: status(70_001) };
  assert.equal(assessPreBuyHolderGate(data).allowed, true);
  assert.equal(assessPreBuyHolderGate({ ...data, developerStatus: status(69_999) }).reason, 'HOLDER_DEV_TAG_STALE');
  assert.equal(assessPreBuyHolderGate({ ...data, holderStatus: status(70_000, 429) }).reason, 'HOLDER_FULL_RESPONSE_NOT_200');
});

test('requires a non-empty full-holder collection in addition to dev-tag status', () => {
  const result = assessPreBuyHolderGate({ now: 10_000, holders: [holder(.001, true)], holderStatus: status(9_000), developerStatus: status(9_000) });
  // The full-holder collection determines concentration; dev-tag status is
  // passed independently and cannot make an empty full response acceptable.
  assert.equal(result.top1Percent, .001);
  assert.equal(assessPreBuyHolderGate({ now: 10_000, holders: [], holderStatus: status(9_000), developerStatus: status(9_000) }).reason, 'HOLDER_FULL_RESPONSE_EMPTY');
});

test('excludes LP/pool from Top-1 and rejects concentrated full-holder data', () => {
  const base = { now: 10_000, holderStatus: status(9_000), developerStatus: status(9_000) };
  assert.equal(assessPreBuyHolderGate({ ...base, holders: [holder(90, false, { addr_type: 2 }), holder(49), holder(1)] }).allowed, true);
  const rejected = assessPreBuyHolderGate({ ...base, holders: [holder(51), holder(49)] });
  assert.equal(rejected.reason, 'HOLDER_TOP1_ABOVE_LIMIT');
  assert.equal(rejected.top1Percent, 51);
});

test('fails closed when a full response lacks ownership percentages', () => {
  const result = assessPreBuyHolderGate({ now: 10_000, holders: [holder(null)], holderStatus: status(9_000), developerStatus: status(9_000) });
  assert.equal(result.reason, 'HOLDER_PERCENTAGE_INCOMPLETE');
});
