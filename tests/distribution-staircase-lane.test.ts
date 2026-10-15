import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionStaircaseLaneS1,
  DistributionStaircaseLaneS2,
  DistributionStaircaseLaneS3,
  DistributionStaircaseLaneS4,
  STAIRCASE_RULES_S1,
  STAIRCASE_RULES_S2,
  STAIRCASE_RULES_S3,
  STAIRCASE_RULES_S4,
} from '../src/distribution-staircase-lane.js';
import type { TargetEvent, TargetFacts, TargetTrade } from '../src/distribution-target-lane.js';

function mockFacts(now: number, price: number | null, overrides: Partial<TargetFacts> = {}): TargetFacts {
  return {
    now,
    firstAt: 100000,
    transferAt: 100000,
    price,
    priceAt: now,
    momentumPercent: 10,
    drawdownPercent: 1.0,
    entryReturnPercent: 8,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 100,
    meaningfulBuyers: 10,
    topBuyerSharePercent: 20,
    sellUsd: 50,
    largestSellUsd: 15,
    riskWalletsPresent: [],
    devHoldingSharePercent: 0,
    holderDeclineEverSeen: false,
    ...overrides,
  };
}

test('DistributionStaircaseLaneS1 waits for full 120s observation before entry', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionStaircaseLaneS1('mint-test-s1', e => events.push(e));

  // T0: 100000
  lane.onTrade({ at: 100000, timestamp: 100, price: 0.00100, side: 'buy', wallet: 'w1', usd: 20 });

  // T + 60s: still observing
  lane.step(mockFacts(160000, 0.00105));
  assert.equal(lane.phase, 'WATCHING');
  assert.ok(events.some(e => String(e.reasons || '').includes('STAIRCASE_OBSERVING_120S')));
});

test('DistributionStaircaseLaneS1 blocks entry if large sell > $60 or max drawdown > 2.2% occurs in 120s', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionStaircaseLaneS1('mint-test-s1-dump', e => events.push(e));

  // T0
  lane.onTrade({ at: 100000, timestamp: 100, price: 0.00100, side: 'buy', wallet: 'w1', usd: 20 });
  // Step 1: Good buy flow
  lane.onTrade({ at: 130000, timestamp: 130, price: 0.00105, side: 'buy', wallet: 'w2', usd: 1000 });
  // Large sell > $60
  lane.onTrade({ at: 140000, timestamp: 140, price: 0.00102, side: 'sell', wallet: 'w3', usd: 120 });
  // Step 2 trades
  lane.onTrade({ at: 190000, timestamp: 190, price: 0.00110, side: 'buy', wallet: 'w4', usd: 1000 });

  // Evaluate at T + 120s
  lane.step(mockFacts(220000, 0.00110));
  assert.equal(lane.phase, 'WATCHING');
  const lastDecision = events.filter(e => e.type === 'PAPER_ENTRY_DECISION').at(-1);
  assert.ok(String(lastDecision?.reasons).includes('LARGE_SELL_DETECTED'));
});

test('DistributionStaircaseLaneS1 enters on clean 2-step progression at 120s and hits +20% take profit', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionStaircaseLaneS1('mint-test-s1-winner', e => events.push(e));

  // T0: 100000, p = 0.00100
  lane.onTrade({ at: 100000, timestamp: 100, price: 0.00100, side: 'buy', wallet: 'w1', usd: 50 });

  // Minute 1: Steady buy accumulation, gain +5%, vol $1,200, sells micro
  lane.onTrade({ at: 120000, timestamp: 120, price: 0.00103, side: 'buy', wallet: 'w2', usd: 500 });
  lane.onTrade({ at: 140000, timestamp: 140, price: 0.00102, side: 'sell', wallet: 'w3', usd: 20 });
  lane.onTrade({ at: 159000, timestamp: 159, price: 0.00105, side: 'buy', wallet: 'w4', usd: 700 });

  // Minute 2: Higher High +6.6%, cumulative gain +12%, vol +$1,000 (total > $1,800)
  lane.onTrade({ at: 180000, timestamp: 180, price: 0.00108, side: 'buy', wallet: 'w5', usd: 500 });
  lane.onTrade({ at: 200000, timestamp: 200, price: 0.00107, side: 'sell', wallet: 'w6', usd: 25 });
  lane.onTrade({ at: 219000, timestamp: 219, price: 0.00112, side: 'buy', wallet: 'w7', usd: 500 });

  // Evaluate at 120s -> ENTRY_PENDING
  lane.step(mockFacts(220000, 0.00112));
  assert.equal(lane.phase, 'ENTRY_PENDING');

  // Execution delay 1s -> OPEN
  lane.step(mockFacts(221100, 0.00112));
  assert.equal(lane.phase, 'OPEN');

  // Token rallies above net target price -> TARGET_NET
  const targetPrice = 0.00112 * 1.30;
  lane.step(mockFacts(240000, targetPrice));
  assert.equal(lane.phase, 'EXIT_PENDING');

  // Execution fill
  lane.step(mockFacts(241100, targetPrice));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'TARGET_NET');
});

test('DistributionStaircaseLaneS2 enters clean staircase and aims for +50% TP', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionStaircaseLaneS2('mint-test-s2', e => events.push(e));

  // T0
  lane.onTrade({ at: 100000, timestamp: 100, price: 0.00100, side: 'buy', wallet: 'w1', usd: 50 });
  lane.onTrade({ at: 120000, timestamp: 120, price: 0.00104, side: 'buy', wallet: 'w2', usd: 800 });
  lane.onTrade({ at: 180000, timestamp: 180, price: 0.00109, side: 'buy', wallet: 'w3', usd: 800 });

  lane.step(mockFacts(220000, 0.00109));
  assert.equal(lane.phase, 'ENTRY_PENDING');
  lane.step(mockFacts(221100, 0.00109));
  assert.equal(lane.phase, 'OPEN');

  // +55% rally to hit +50% net
  const targetPrice = 0.00109 * 1.55;
  lane.step(mockFacts(260000, targetPrice));
  assert.equal(lane.phase, 'EXIT_PENDING');
  lane.step(mockFacts(261100, targetPrice));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'TARGET_NET');
});

test('DistributionStaircaseLaneS4 enforces volume acceleration and enters runner token', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionStaircaseLaneS4('mint-test-s4', e => events.push(e));

  // T0
  lane.onTrade({ at: 100000, timestamp: 100, price: 0.00100, side: 'buy', wallet: 'w1', usd: 100 });
  // Step 1: Buy $500, gain +3%
  lane.onTrade({ at: 130000, timestamp: 130, price: 0.00103, side: 'buy', wallet: 'w2', usd: 500 });
  // Step 2: Buy $600 (accel 1.2x), gain +3.8%
  lane.onTrade({ at: 180000, timestamp: 180, price: 0.00107, side: 'buy', wallet: 'w3', usd: 600 });

  lane.step(mockFacts(220000, 0.00107));
  assert.equal(lane.phase, 'ENTRY_PENDING');
  lane.step(mockFacts(221100, 0.00107));
  assert.equal(lane.phase, 'OPEN');
});
