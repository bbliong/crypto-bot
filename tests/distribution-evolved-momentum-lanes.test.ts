import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionMomentumScalpLane,
  DistributionMomentumTrendLane,
  DistributionMomentumGoldenLane,
  M_SCALP_RULES,
  M_TREND_RULES,
  M_GOLDEN_RULES,
} from '../src/distribution-evolved-momentum-lanes.js';
import type { TargetFacts, TargetEvent } from '../src/distribution-target-lane.js';

function baseFacts(overrides: Partial<TargetFacts> = {}): TargetFacts {
  const now = 1_700_000_000_000;
  return {
    now,
    firstAt: now - 20_000,
    transferAt: now - 35_000,
    price: 0.000025, // $25k Market Cap
    priceAt: now,
    momentumPercent: 5.0,
    drawdownPercent: 1.0,
    entryReturnPercent: 10.0,
    holderCount: 120,
    holderGrowth15s: 3,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 150,
    meaningfulBuyers: 7,
    topBuyerSharePercent: 30,
    sellUsd: 10,
    largestSellUsd: 15, // Aman (< $60)
    riskWalletsPresent: [],
    holderDeclineEverSeen: false,
    ...overrides,
  };
}

function establishOpenPosition(
  lane: DistributionMomentumScalpLane | DistributionMomentumTrendLane | DistributionMomentumGoldenLane,
  startNow = 1_700_000_000_000,
  price = 0.000025
): number {
  let now = startNow;
  lane.step(baseFacts({ now, price, priceAt: now }));
  now += 1000;
  lane.step(baseFacts({ now, price, priceAt: now }));
  now += 1100;
  lane.step(baseFacts({ now, price, priceAt: now })); // ENTRY_PENDING
  now += 1200; // > executionDelayMs (1000ms)
  lane.step(baseFacts({ now, price, priceAt: now })); // Fills and enters OPEN
  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, price);
  return now;
}

test('Momentum Scalp Lane rejects entry when largest sell >= $60 (Whale Dump Guard)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumScalpLane('MintWhaleDump111111111111111111111111111', (e) => events.push(e));

  const now = 1_700_000_000_000;
  const f = baseFacts({ now, largestSellUsd: 65 }); // Melebihi $60
  lane.step(f);

  assert.equal(lane.phase, 'WATCHING');
  const decision = events.find((e) => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok(decision);
  assert.equal(decision.allowed, false);
  assert.ok(
    (decision.reasons as string[]).includes('LARGEST_SELL_TOO_HIGH_WHALE_DUMP')
  );
});

test('Momentum Scalp Lane rejects entry when entry return > 45% (Anti-FOMO Guard)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumScalpLane('MintFomoTop11111111111111111111111111111', (e) => events.push(e));

  const now = 1_700_000_000_000;
  const f = baseFacts({ now, entryReturnPercent: 55.0 }); // Sudah naik 55%
  lane.step(f);

  assert.equal(lane.phase, 'WATCHING');
  const decision = events.find((e) => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok(decision);
  assert.equal(decision.allowed, false);
  assert.ok(
    (decision.reasons as string[]).includes('FOMO_GAIN_TOO_HIGH_TOP_BUY')
  );
});

test('Momentum Scalp Lane enters OPEN and triggers Take Profit Ceiling @ +18%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumScalpLane('MintCeiling11111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Harga naik +18.5%
  const tpPrice = 0.000025 * 1.185;
  now += 1000;
  lane.step(baseFacts({ now, price: tpPrice, priceAt: now }));

  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitSignal = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitSignal);
  assert.equal(exitSignal.reason, 'TAKE_PROFIT_CEILING_18');
});

test('Momentum Trend Lane triggers Breakeven Profit Lock after +6% gain drops to +3%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumTrendLane('MintBreakeven111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // 1. Harga melonjak ke +6.5% (memicu trigger breakeven)
  const peakPrice = 0.000025 * 1.065;
  now += 1000;
  lane.step(baseFacts({ now, price: peakPrice, priceAt: now }));
  assert.equal(lane.phase, 'OPEN');

  // 2. Harga retrace turun ke +2.8% (di bawah kunci +3.0%)
  const dropPrice = 0.000025 * 1.028;
  now += 1000;
  lane.step(baseFacts({ now, price: dropPrice, priceAt: now }));

  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitSignal = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitSignal);
  assert.equal(exitSignal.reason, 'BREAKEVEN_PROFIT_LOCKED_6_3');
});

test('Momentum Golden Lane triggers Hard Stop Loss @ -7%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumGoldenLane('MintStopLoss111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Harga anjlok -7.5%
  const slPrice = 0.000025 * 0.925;
  now += 1000;
  lane.step(baseFacts({ now, price: slPrice, priceAt: now }));

  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitSignal = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitSignal);
  assert.equal(exitSignal.reason, 'STOP_LOSS_7PCT');
});
