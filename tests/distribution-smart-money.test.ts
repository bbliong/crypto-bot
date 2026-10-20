import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionSmartMoneyLaneG2_1,
  DistributionSmartMoneyConvergenceLaneG2_2,
  SMART_MONEY_RULES_G2_1,
  getSmartWalletMetaMap,
} from '../src/distribution-smart-money-lane.js';
import type { TargetEvent, TargetFacts } from '../src/distribution-target-lane.js';

test('Smart Money: metadata identifies conviction whales vs sniper bots', () => {
  const metaMap = getSmartWalletMetaMap();
  assert.ok(metaMap.size > 0, 'Metadata map should load wallets from watchlist');

  // Check top conviction wallet
  const topConviction = metaMap.get('GxkXGe3YcqBdUyg6WvY4pEwHqE9RKnFh6d7N7K65pump') || [...metaMap.values()].find(w => w.trades30d < 500);
  assert.ok(topConviction, 'Should find at least one conviction whale');
  assert.equal(topConviction.isConviction, true);
  assert.equal(topConviction.isSniper, false);

  // Check an HFT sniper bot
  const sniperBot = [...metaMap.values()].find(w => w.trades30d >= 500);
  if (sniperBot) {
    assert.equal(sniperBot.isSniper, true);
    assert.equal(sniperBot.isConviction, false);
  }
});

test('DistributionSmartMoneyLaneG2_1: blocks entry if buy is dust (< $50 USD)', () => {
  const mint = 'TEST_MINT_DUST';
  const events: TargetEvent[] = [];
  const lane = new DistributionSmartMoneyLaneG2_1(mint, e => events.push(e));

  const metaMap = getSmartWalletMetaMap();
  const conviction = [...metaMap.values()].find(w => w.isConviction);
  assert.ok(conviction);

  lane.registerSmartWallet(conviction.address, 15);

  const facts: TargetFacts = {
    now: 10000,
    firstAt: 1000,
    transferAt: 1000,
    price: 0.005,
    priceAt: 9900,
    momentumPercent: 10,
    drawdownPercent: 2,
    entryReturnPercent: 5,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 15,
    meaningfulBuyers: 1,
    topBuyerSharePercent: 50,
    sellUsd: 5,
    largestSellUsd: 5,
    riskWalletsPresent: [],
    devHoldingSharePercent: 2,
  };

  const reasons = lane.evaluateSmartMoneyEntry(facts, lane.rules);
  assert.ok(reasons.some(r => r.includes('INSUFFICIENT_SMART_MONEY_SIZE')), `Should reject dust buy: ${reasons.join(', ')}`);
});

test('DistributionSmartMoneyLaneG2_1: blocks entry if wallet is HFT sniper bot', () => {
  const mint = 'TEST_MINT_SNIPER';
  const events: TargetEvent[] = [];
  const lane = new DistributionSmartMoneyLaneG2_1(mint, e => events.push(e));

  const metaMap = getSmartWalletMetaMap();
  const sniper = [...metaMap.values()].find(w => w.isSniper);
  if (!sniper) return;

  lane.registerSmartWallet(sniper.address, 200);

  const facts: TargetFacts = {
    now: 10000,
    firstAt: 1000,
    transferAt: 1000,
    price: 0.005,
    priceAt: 9900,
    momentumPercent: 10,
    drawdownPercent: 2,
    entryReturnPercent: 5,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 200,
    meaningfulBuyers: 1,
    topBuyerSharePercent: 50,
    sellUsd: 5,
    largestSellUsd: 5,
    riskWalletsPresent: [],
    devHoldingSharePercent: 2,
  };

  const reasons = lane.evaluateSmartMoneyEntry(facts, lane.rules);
  assert.ok(reasons.includes('HFT_SNIPER_BOT_IGNORED'), `Should reject sniper bot: ${reasons.join(', ')}`);
});

test('DistributionSmartMoneyLaneG2_1: enters on conviction whale buy (>= $50) and hits +25% target without panic selling on $250 sells', () => {
  const mint = 'TEST_MINT_CONVICTION_WIN';
  const events: TargetEvent[] = [];
  const lane = new DistributionSmartMoneyLaneG2_1(mint, e => events.push(e));

  const metaMap = getSmartWalletMetaMap();
  const conviction = [...metaMap.values()].find(w => w.isConviction);
  assert.ok(conviction);

  lane.registerSmartWallet(conviction.address, 150);

  const baseFacts: TargetFacts = {
    now: 10000,
    firstAt: 1000,
    transferAt: 1000,
    price: 0.005,
    priceAt: 10000,
    momentumPercent: 10,
    drawdownPercent: 2,
    entryReturnPercent: 5,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 150,
    meaningfulBuyers: 1,
    topBuyerSharePercent: 50,
    sellUsd: 10,
    largestSellUsd: 10,
    riskWalletsPresent: [],
    devHoldingSharePercent: 2,
  };

  lane.step(baseFacts);
  assert.equal(lane.phase, 'ENTRY_PENDING');

  const fillTime = 10000 + SMART_MONEY_RULES_G2_1.executionDelayMs + 50;
  lane.step({ ...baseFacts, now: fillTime, priceAt: fillTime });
  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, 0.005);

  // Large sell in market — flowExitEnabled MUST NOT trigger!
  const sellTime = fillTime + 5000;
  lane.step({
    ...baseFacts,
    now: sellTime,
    price: 0.0051,
    priceAt: sellTime,
    largestSellUsd: 300,
    sellUsd: 400,
    buyShareUsdPercent: 10,
    momentumPercent: -2,
  });
  assert.equal(lane.phase, 'OPEN', 'Must NOT panic sell on FLOW_OR_LARGE_SELL');

  // Token surges by +30% -> hits target profit +25%
  const pumpPrice = 0.005 * 1.30;
  const pumpTime = sellTime + 10000;
  lane.step({
    ...baseFacts,
    now: pumpTime,
    price: pumpPrice,
    priceAt: pumpTime,
  });

  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find(e => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.equal(exitEvent.reason, 'TARGET_NET');

  // Fill exit
  const exitFillTime = pumpTime + SMART_MONEY_RULES_G2_1.executionDelayMs + 50;
  lane.step({
    ...baseFacts,
    now: exitFillTime,
    price: pumpPrice,
    priceAt: exitFillTime,
  });

  assert.equal(lane.phase, 'CLOSED');
  const sellEvent = events.find(e => e.type === 'PAPER_SELL');
  assert.ok(sellEvent);
  assert.equal(sellEvent.reason, 'TARGET_NET');
  assert.ok(Number(sellEvent.netReturnPercent) >= 25);
});

test('DistributionSmartMoneyLaneG2_1: locks profit with TRAILING_PROFIT when peak >= 15% drops 5%', () => {
  const mint = 'TEST_MINT_TRAILING';
  const events: TargetEvent[] = [];
  const lane = new DistributionSmartMoneyLaneG2_1(mint, e => events.push(e));

  const metaMap = getSmartWalletMetaMap();
  const conviction = [...metaMap.values()].find(w => w.isConviction);
  assert.ok(conviction);
  lane.registerSmartWallet(conviction.address, 100);

  const baseFacts: TargetFacts = {
    now: 10000,
    firstAt: 1000,
    transferAt: 1000,
    price: 0.010,
    priceAt: 10000,
    momentumPercent: 10,
    drawdownPercent: 2,
    entryReturnPercent: 5,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 100,
    meaningfulBuyers: 1,
    topBuyerSharePercent: 50,
    sellUsd: 10,
    largestSellUsd: 10,
    riskWalletsPresent: [],
    devHoldingSharePercent: 2,
  };

  lane.step(baseFacts);
  const fillTime = 10000 + SMART_MONEY_RULES_G2_1.executionDelayMs + 50;
  lane.step({ ...baseFacts, now: fillTime, priceAt: fillTime });
  assert.equal(lane.phase, 'OPEN');

  // Peak at +20%
  const peakTime = fillTime + 5000;
  const peakPrice = 0.010 * 1.23; // +23% gross (~+19.5% net)
  lane.step({ ...baseFacts, now: peakTime, price: peakPrice, priceAt: peakTime });
  assert.equal(lane.phase, 'OPEN');

  // Price drops by 6% from peak -> triggers TRAILING_PROFIT
  const dropTime = peakTime + 2000;
  const dropPrice = peakPrice * 0.94;
  lane.step({ ...baseFacts, now: dropTime, price: dropPrice, priceAt: dropTime });

  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find(e => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.equal(exitEvent.reason, 'TRAILING_PROFIT');
});

test('DistributionSmartMoneyLaneG2_1: triggers STOP_LOSS on -10% drawdown', () => {
  const mint = 'TEST_MINT_SL';
  const events: TargetEvent[] = [];
  const lane = new DistributionSmartMoneyLaneG2_1(mint, e => events.push(e));

  const metaMap = getSmartWalletMetaMap();
  const conviction = [...metaMap.values()].find(w => w.isConviction);
  assert.ok(conviction);
  lane.registerSmartWallet(conviction.address, 100);

  const baseFacts: TargetFacts = {
    now: 10000,
    firstAt: 1000,
    transferAt: 1000,
    price: 0.010,
    priceAt: 10000,
    momentumPercent: 10,
    drawdownPercent: 2,
    entryReturnPercent: 5,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 100,
    meaningfulBuyers: 1,
    topBuyerSharePercent: 50,
    sellUsd: 10,
    largestSellUsd: 10,
    riskWalletsPresent: [],
    devHoldingSharePercent: 2,
  };

  lane.step(baseFacts);
  const fillTime = 10000 + SMART_MONEY_RULES_G2_1.executionDelayMs + 50;
  lane.step({ ...baseFacts, now: fillTime, priceAt: fillTime });
  assert.equal(lane.phase, 'OPEN');

  // Price drops by -12% -> triggers STOP_LOSS
  const dumpTime = fillTime + 5000;
  const dumpPrice = 0.010 * 0.88;
  lane.step({ ...baseFacts, now: dumpTime, price: dumpPrice, priceAt: dumpTime });

  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find(e => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.equal(exitEvent.reason, 'STOP_LOSS');
});
