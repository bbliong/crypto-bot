import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionGenesisSurgeLaneG1,
  GENESIS_SURGE_TARGET_PERCENT,
  GENESIS_SURGE_STOP_LOSS_PERCENT
} from '../src/distribution-genesis-surge-lane.js';

function mockFacts(now, price, overrides = {}) {
  const t0 = 1792000000000;
  return {
    now,
    firstAt: t0,
    transferAt: t0 - 35000,
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
    ...overrides
  };
}

test('DistributionGenesisSurgeLaneG1 enforces initial observation and sweet spot market cap', () => {
  const events = [];
  const lane = new DistributionGenesisSurgeLaneG1('Mint111111111111111111111111111111111111111', e => events.push(e));

  const t0 = 1792000000000;
  // 1. Initial observation period (under 20s)
  lane.step(mockFacts(t0 + 5000, 0.00001, {
    marketCapUsd: 12000,
    totalBuyUsd: 1200,
    devHoldingSharePercent: 0.5
  }));

  assert.equal(lane.phase, 'WATCHING');
  assert.ok(lane.getReasons().some(r => r.includes('GENESIS_SURGE_OBSERVING')));

  // 2. High Dev holdings block
  lane.step(mockFacts(t0 + 25000, 0.000012, {
    marketCapUsd: 15000,
    totalBuyUsd: 2500,
    devHoldingSharePercent: 3.5 // > 2%
  }));
  assert.ok(lane.getReasons().includes('DEV_HOLDINGS_TOO_HIGH_FOR_SURGE'));

  // 3. Market cap too high block
  lane.step(mockFacts(t0 + 26000, 0.000015, {
    marketCapUsd: 45000, // > 35k
    totalBuyUsd: 2500,
    devHoldingSharePercent: 0.5
  }));
  assert.ok(lane.getReasons().includes('MARKET_CAP_TOO_HIGH_FOR_EARLY_SURGE'));
});

test('DistributionGenesisSurgeLaneG1 triggers emergency cut on cluster dump sell', () => {
  const events = [];
  const lane = new DistributionGenesisSurgeLaneG1('Mint222222222222222222222222222222222222222', e => events.push(e));

  const t0 = 1792000000000;
  lane.step(mockFacts(t0 + 1000, 0.00001, {
    marketCapUsd: 10000,
    totalBuyUsd: 1500,
    devHoldingSharePercent: 0.8
  }));

  // Cluster sell occurs
  lane.registerClusterOrDevSell('5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT', 120, 'sig123');

  lane.step(mockFacts(t0 + 25000, 0.000011, {
    marketCapUsd: 11000,
    totalBuyUsd: 1500,
    devHoldingSharePercent: 0.8
  }));

  assert.ok(lane.getReasons().some(r => r.includes('DEV_OR_CLUSTER_DUMP_ACTIVE')));
});
