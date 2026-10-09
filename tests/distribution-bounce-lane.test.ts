import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributionBounceLane, DistributionBounceLaneV2, BOUNCE_RULES, BOUNCE_RULES_V2, BOUNCE_TARGET_PERCENT } from '../src/distribution-bounce-lane.js';
import type { TargetEvent, TargetFacts } from '../src/distribution-target-lane.js';

const mockFacts = (now = 100000, price = 1, extra: Partial<TargetFacts> = {}): TargetFacts => ({
  now,
  transferAt: 0,
  firstAt: 1000,
  price,
  priceAt: now,
  momentumPercent: 1,
  drawdownPercent: 0,
  entryReturnPercent: 0,
  holderCount: 100,
  holderGrowth15s: 1,
  buyShareUsdPercent: 60,
  meaningfulBuyUsd: 10,
  meaningfulBuyers: 2,
  topBuyerSharePercent: 50,
  sellUsd: 5,
  largestSellUsd: 0,
  riskWalletsPresent: [],
  bounceFromTroughPercent: 0,
  ...extra,
});

test('DistributionBounceLane waits for severe dump and bounce before entering', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLane('mint1', e => events.push(e));

  // 1. Initial observation: No dump yet -> rejected
  lane.step(mockFacts(100000, 1.0, { drawdownPercent: 10, bounceFromTroughPercent: 0 }));
  assert.equal(lane.phase, 'WATCHING');
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), false);

  // 2. Token dumps severely (drawdown 60%), but still at bottom without bounce -> rejected
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 0.5 }));
  assert.equal(lane.phase, 'WATCHING');

  // 3. Token starts to bounce (+4% from trough) with good buy flow -> ENTRY triggered
  lane.step(mockFacts(102000, 0.42, { drawdownPercent: 58, bounceFromTroughPercent: 5.0, buyShareUsdPercent: 70, meaningfulBuyUsd: 15 }));
  lane.step(mockFacts(103000, 0.42, { drawdownPercent: 58, bounceFromTroughPercent: 5.0, buyShareUsdPercent: 70, meaningfulBuyUsd: 15 }));

  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, 0.42);
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), true);
});

test('DistributionBounceLane takes profit at 30-40% gain', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLane('mint2', e => events.push(e));

  // Setup entry after dump
  lane.step(mockFacts(100000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  assert.equal(lane.phase, 'OPEN');

  // Price surges by +35% net (e.g. from 0.40 to 0.55)
  lane.step(mockFacts(102000, 0.55));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(103000, 0.56));
  assert.equal(lane.phase, 'CLOSED');
  assert.ok(lane.netReturnPercent! >= 30);
  assert.equal(events.at(-1)?.reason, 'TARGET_BOUNCE_30_40');
});

test('DistributionBounceLane exits when stagnant without movement after dump', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLane('mint3', e => events.push(e));

  // Enter
  lane.step(mockFacts(100000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  assert.equal(lane.phase, 'OPEN');

  // Hold past 90 seconds with no price change (<1% move)
  lane.step(mockFacts(150000, 0.401)); // 50s
  assert.equal(lane.phase, 'OPEN');

  lane.step(mockFacts(200000, 0.401)); // 100s, stagnant for >60s
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(201000, 0.401));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'STAGNANT_NO_MOVEMENT_AFTER_DUMP');
});

test('DistributionBounceLaneV2 blocks entry if whale sell >= 300 USD is present', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV2('mint-v2-whale', e => events.push(e));

  // Bounce conditions met, but whale sell is $350
  lane.step(mockFacts(100000, 0.42, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 5.0,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
    largestSellUsd: 350,
  }));
  lane.step(mockFacts(101000, 0.42, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 5.0,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
    largestSellUsd: 350,
  }));

  assert.equal(lane.phase, 'WATCHING');
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), false);
});

test('DistributionBounceLaneV2 triggers emergency exit on large whale sell >= 250 USD during hold', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV2('mint-v2-dump', e => events.push(e));

  // Valid entry (clean sell flow)
  lane.step(mockFacts(100000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 20 }));
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 20 }));
  assert.equal(lane.phase, 'OPEN');

  // Whale sells $300 while holding
  lane.step(mockFacts(102000, 0.41, { largestSellUsd: 300 }));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(103000, 0.41));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'LARGE_SELL_WHALE_DUMP_EXIT');
});

test('DistributionBounceLaneV2 triggers profit lock 20 exit when peak >= 20% reverses', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV2('mint-v2-lock', e => events.push(e));

  // Entry at 0.40
  lane.step(mockFacts(100000, 0.40, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 10 }));
  lane.step(mockFacts(101000, 0.40, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 10 }));
  assert.equal(lane.phase, 'OPEN');

  // Price surges to 0.50 (+25% gain) -> peak records +25%
  lane.step(mockFacts(102000, 0.50, { largestSellUsd: 10 }));
  assert.equal(lane.phase, 'OPEN');

  // Price pulls back to 0.47 (+17.5% gain, pulled back 7.5% from peak >= 20%)
  lane.step(mockFacts(103000, 0.47, { largestSellUsd: 10 }));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(104000, 0.46, { largestSellUsd: 10 }));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'PROFIT_LOCK_20_EXIT');
});
