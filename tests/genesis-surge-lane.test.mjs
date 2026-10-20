import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionGenesisSurgeLaneG1,
  DistributionGenesisSurgeLaneG1_2,
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
    meaningfulBuyUsd: 250,
    meaningfulBuyers: 10,
    topBuyerSharePercent: 20,
    sellUsd: 50,
    largestSellUsd: 15,
    riskWalletsPresent: [],
    devHoldingSharePercent: 0,
    holderDeclineEverSeen: false,
    maxBuyUsd: 150,
    totalBuyUsd: 500,
    ...overrides
  };
}

test('DistributionGenesisSurgeLaneG1 enforces initial observation and sweet spot market cap', () => {
  const events = [];
  const lane = new DistributionGenesisSurgeLaneG1('Mint111111111111111111111111111111111111111', e => events.push(e));

  const t0 = 1792000000000;
  // 1. Initial observation period (under 5s, at 2s)
  lane.step(mockFacts(t0 + 2000, 0.00001, {
    marketCapUsd: 12000,
    totalBuyUsd: 1200,
    devHoldingSharePercent: 0.5,
    maxBuyUsd: 150
  }));

  assert.equal(lane.phase, 'WATCHING');
  assert.ok(lane.getReasons().some(r => r.includes('GENESIS_SURGE_OBSERVING')));

  // 2. High Dev holdings block
  lane.step(mockFacts(t0 + 25000, 0.000012, {
    marketCapUsd: 15000,
    totalBuyUsd: 2500,
    devHoldingSharePercent: 3.5, // > 2%
    maxBuyUsd: 150
  }));
  assert.ok(lane.getReasons().includes('DEV_HOLDINGS_TOO_HIGH_FOR_SURGE'));

  // 3. Market cap too high block
  lane.step(mockFacts(t0 + 26000, 0.000015, {
    marketCapUsd: 45000, // > 35k
    totalBuyUsd: 2500,
    devHoldingSharePercent: 0.5,
    maxBuyUsd: 150
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
    devHoldingSharePercent: 0.8,
    maxBuyUsd: 150
  }));

  // Cluster sell occurs
  lane.registerClusterOrDevSell('5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT', 120, 'sig123');

  lane.step(mockFacts(t0 + 25000, 0.000011, {
    marketCapUsd: 11000,
    totalBuyUsd: 1500,
    devHoldingSharePercent: 0.8,
    maxBuyUsd: 150
  }));

  assert.ok(lane.getReasons().some(r => r.includes('DEV_OR_CLUSTER_DUMP_ACTIVE')));
});

test('DistributionGenesisSurgeLaneG1: blocks token if max single buy < $100 USD', () => {
  const events = [];
  const lane = new DistributionGenesisSurgeLaneG1('Mint333333333333333333333333333333333333333', e => events.push(e));

  const t0 = 1792000000000;
  // Simulated trades with only $15 micro-buys
  lane.onTrade({ at: t0 + 1000, timestamp: Math.floor(t0/1000), price: 0.00001, side: 'buy', wallet: 'w1', usd: 15 });
  lane.onTrade({ at: t0 + 2000, timestamp: Math.floor(t0/1000), price: 0.00001, side: 'buy', wallet: 'w2', usd: 20 });

  const reasons = lane.evaluateEntryReasons(mockFacts(t0 + 10000, 0.00001, {
    marketCapUsd: 10000,
    totalBuyUsd: 35,
    maxBuyUsd: 20
  }));

  assert.ok(reasons.some(r => r.includes('INSUFFICIENT_SNIPER_WHALE_BUY')), `Expected whale buy block: ${reasons.join(', ')}`);
});

test('DistributionGenesisSurgeLaneG1: blocks token if wash-trading micro-bot ratio > 40%', () => {
  const events = [];
  const lane = new DistributionGenesisSurgeLaneG1('Mint444444444444444444444444444444444444444', e => events.push(e));

  const t0 = 1792000000000;
  // 6 micro-buys of $0.50 (dust wash trading) + 1 whale buy of $120
  for (let i = 0; i < 6; i++) {
    lane.onTrade({ at: t0 + i * 500, timestamp: Math.floor(t0/1000), price: 0.00001, side: 'buy', wallet: `w${i}`, usd: 0.5 });
  }
  lane.onTrade({ at: t0 + 3500, timestamp: Math.floor(t0/1000), price: 0.00001, side: 'buy', wallet: 'whale', usd: 120 });

  const reasons = lane.evaluateEntryReasons(mockFacts(t0 + 10000, 0.00001, {
    marketCapUsd: 10000,
    totalBuyUsd: 300,
    maxBuyUsd: 120
  }));

  assert.ok(reasons.some(r => r.includes('WASH_TRADING_MICRO_BOTS_DETECTED')), `Expected wash trading block: ${reasons.join(', ')}`);
});

test('DistributionGenesisSurgeLaneG1: enters on real whale surge (>= $100) and hits +50% target', () => {
  const events = [];
  const lane = new DistributionGenesisSurgeLaneG1('Mint555555555555555555555555555555555555555', e => events.push(e));

  const t0 = 1792000000000;
  // Real whale sniper buys
  lane.onTrade({ at: t0 + 1000, timestamp: Math.floor(t0/1000), price: 0.00001, side: 'buy', wallet: 'whale1', usd: 250 });
  lane.onTrade({ at: t0 + 2000, timestamp: Math.floor(t0/1000), price: 0.00001, side: 'buy', wallet: 'whale2', usd: 180 });

  const facts = mockFacts(t0 + 6000, 0.00001, {
    marketCapUsd: 10000,
    totalBuyUsd: 430,
    maxBuyUsd: 250,
    devHoldingSharePercent: 0.5
  });

  lane.step(facts);
  assert.equal(lane.phase, 'ENTRY_PENDING');

  // Fill entry
  lane.step({ ...facts, now: t0 + 6500, priceAt: t0 + 6500 });
  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, 0.00001);

  // Pump +60% (hits +50% target)
  const pumpPrice = 0.00001 * 1.60;
  lane.step({ ...facts, now: t0 + 15000, price: pumpPrice, priceAt: t0 + 15000 });
  assert.equal(lane.phase, 'EXIT_PENDING');

  const exitSignal = events.find(e => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitSignal);
  assert.equal(exitSignal.reason, 'TARGET_NET');

  // Fill sell
  lane.step({ ...facts, now: t0 + 16000, price: pumpPrice, priceAt: t0 + 16000 });
  assert.equal(lane.phase, 'CLOSED');
  const sellEvent = events.find(e => e.type === 'PAPER_SELL');
  assert.ok(sellEvent);
  assert.equal(sellEvent.reason, 'TARGET_NET');
  assert.ok(Number(sellEvent.netReturnPercent) >= 50);
});
