import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmartDipFollowerLane } from '../src/smart-dip-follower-lane.js';
import type { WalletTradeSignal } from '../src/wallet-follower-lane.js';

function getTempPaths(prefix: string) {
  const rnd = Math.random().toString(36).substring(2, 8);
  return {
    positionsFilePath: `/tmp/test-smart-dip-pos-${prefix}-${rnd}.json`,
    tradesFilePath: `/tmp/test-smart-dip-trades-${prefix}-${rnd}.json`,
    eventsFilePath: `/tmp/test-smart-dip-events-${prefix}-${rnd}.json`,
  };
}

test('SmartDipFollowerLane: Rule 1 - Initial Buy $5.0 on fresh token (<=10m)', () => {
  const paths = getTempPaths('rule1');
  const lane = new SmartDipFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerTradeUsd: 5.0,
    ...paths,
  });

  const signal: WalletTradeSignal = {
    action: 'buy',
    mint: 'FreshTokenMint111111111111111111111111111111',
    symbol: 'FRESH',
    tokenName: 'Fresh Token',
    tokenAmount: 100000,
    remainingHolding: 100000,
    solAmount: 2.0,
    usdAmount: 200,
    priceUsd: 0.002,
    txHash: 'tx1',
    timestamp: 1000,
  };

  // Fresh token (age 3m <= 10m)
  const evalBuy = lane.evaluateBuySignal(signal, { isFreshToken: true, tokenAgeMinutes: 3 });
  assert.equal(evalBuy.canBuy, true);
  assert.equal(evalBuy.buyType, 'INITIAL_BUY');
  assert.equal(evalBuy.stakeUsd, 5.0);

  // Execute buy: $5.0 stake -> 2,500 tokens @ $0.002
  const pos = lane.recordBuyExecution(signal, 'INITIAL_BUY', 5.0, 2500, 0.002);
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.phase, 'INITIAL');
  assert.equal(pos.totalTokens, 2500);
  assert.equal(pos.remainingCostBasisUsd, 5.0);
  assert.equal(pos.initialEntryPriceUsd, 0.002);

  // Subsequent buy while still holding initial is rejected (prevents fee spam)
  const eval2 = lane.evaluateBuySignal(signal);
  assert.equal(eval2.canBuy, false);
  assert.equal(eval2.reason, 'ALREADY_HOLDING_INITIAL_AWAITING_TP');
});

test('SmartDipFollowerLane: Rule 2 - TP 30%-50% triggers 100% FULL EXIT', () => {
  const paths = getTempPaths('rule2');
  const lane = new SmartDipFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerTradeUsd: 5.0,
    ...paths,
  });

  const signal: WalletTradeSignal = {
    action: 'buy',
    mint: 'TPTokenMint11111111111111111111111111111111',
    symbol: 'TPCOIN',
    tokenName: 'TP Coin',
    tokenAmount: 100000,
    remainingHolding: 100000,
    solAmount: 2.0,
    usdAmount: 200,
    priceUsd: 0.002,
    txHash: 'tx1',
    timestamp: 1000,
  };

  lane.recordBuyExecution(signal, 'INITIAL_BUY', 5.0, 2500, 0.002);

  // Price rises to 0.0028 (+40% gain, between 30% and 50%)
  const tick = lane.evaluatePriceTick(signal.mint, 0.0028);
  assert.equal(tick.shouldSell, true);
  assert.equal(tick.sellType, 'TP_30_50_FULL');
  assert.equal(tick.sellRatioPct, 100);
  assert.equal(tick.tokensToSell, 2500);

  // Execute sell: 2,500 tokens sold for $7.00 ($2.00 profit)
  const res = lane.recordSellExecution(signal.mint, 'TP_30_50_FULL', 2500, 7.00, 0.0028, true, 'sell-tx1');
  assert.ok(res);
  assert.equal(res.realizedPnlUsd, 2.00);
  assert.equal(res.remainingCostBasisUsd, 0);
  assert.equal(res.totalTokens, 0);
  assert.equal(res.phase, 'WAITING_DIP'); // Ready for dip & rebound
});

test('SmartDipFollowerLane: Rule 3 - TP >50% triggers 70% EXIT, keeps 30% Moonbag', () => {
  const paths = getTempPaths('rule3');
  const lane = new SmartDipFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerTradeUsd: 5.0,
    ...paths,
  });

  const signal: WalletTradeSignal = {
    action: 'buy',
    mint: 'MoonbagMint1111111111111111111111111111111',
    symbol: 'MOON',
    tokenName: 'Moon Coin',
    tokenAmount: 100000,
    remainingHolding: 100000,
    solAmount: 2.0,
    usdAmount: 200,
    priceUsd: 0.002,
    txHash: 'tx1',
    timestamp: 1000,
  };

  lane.recordBuyExecution(signal, 'INITIAL_BUY', 5.0, 2500, 0.002);

  // Price surges to 0.0032 (+60% gain, >= 50%)
  const tick = lane.evaluatePriceTick(signal.mint, 0.0032);
  assert.equal(tick.shouldSell, true);
  assert.equal(tick.sellType, 'TP_OVER_50_PARTIAL_70');
  assert.equal(tick.sellRatioPct, 70);
  assert.equal(tick.tokensToSell, 1750); // 70% of 2500

  // Execute 70% sell: 1,750 tokens sold for $5.60
  // Cost basis portion: $5.00 * 70% = $3.50. PnL = $5.60 - $3.50 = +$2.10
  const res = lane.recordSellExecution(signal.mint, 'TP_OVER_50_PARTIAL_70', 1750, 5.60, 0.0032, false, 'sell-tx2');
  assert.ok(res);
  assert.equal(res.realizedPnlUsd, 2.10);
  assert.equal(res.remainingCostBasisUsd, 1.50); // 30% cost basis remaining
  assert.equal(res.totalTokens, 750); // 30% moonbag remaining
  assert.equal(res.phase, 'WAITING_DIP');
});

test('SmartDipFollowerLane: Rule 4 & 5 - Dip Rebound with Target Conviction + Quick Swing 20% TP', () => {
  const paths = getTempPaths('rule4');
  const lane = new SmartDipFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerTradeUsd: 5.0,
    ...paths,
  });

  const signal: WalletTradeSignal = {
    action: 'buy',
    mint: 'ReboundMint1111111111111111111111111111111',
    symbol: 'REBOUND',
    tokenName: 'Rebound Coin',
    tokenAmount: 100000,
    remainingHolding: 100000,
    solAmount: 2.0,
    usdAmount: 200,
    priceUsd: 0.002,
    txHash: 'tx1',
    timestamp: 1000,
  };

  // 1. Initial Buy & TP Full at 0.0028 (+40%)
  lane.recordBuyExecution(signal, 'INITIAL_BUY', 5.0, 2500, 0.002);
  lane.recordSellExecution(signal.mint, 'TP_30_50_FULL', 2500, 7.00, 0.0028, true, 'sell-tp');

  const posAfterTp = lane.getPosition(signal.mint);
  assert.equal(posAfterTp?.phase, 'WAITING_DIP');
  assert.equal(posAfterTp?.peakPriceUsd, 0.0028);

  // 2. Token dumps down to 0.0022 (-21.4% drop from peak)
  lane.evaluatePriceTick(signal.mint, 0.0022);
  assert.equal(posAfterTp?.lowestPriceSincePeakUsd, 0.0022);

  // 3. Price begins to bounce to 0.0023 (+4.5% rebound from lowest 0.0022)
  lane.evaluatePriceTick(signal.mint, 0.0023);

  // Target wallet shows conviction: Buy #1 in dip ($150)
  lane.recordTargetBuyActivity({
    ...signal,
    usdAmount: 150,
    solAmount: 1.5,
    priceUsd: 0.0023,
    timestamp: 2000,
  });

  // Target wallet executes Buy #2 (consecutive buy / large buy)
  const reboundSignal: WalletTradeSignal = {
    ...signal,
    usdAmount: 120,
    solAmount: 1.2,
    priceUsd: 0.00235,
    timestamp: 2050,
  };

  const evalRebound = lane.evaluateBuySignal(reboundSignal);
  assert.equal(evalRebound.canBuy, true);
  assert.equal(evalRebound.buyType, 'REBOUND_BUY');
  assert.equal(evalRebound.stakeUsd, 5.0);

  // Execute Rebound Buy: $5.0 @ 0.00235 -> ~2,127 tokens
  const posRebound = lane.recordBuyExecution(reboundSignal, 'REBOUND_BUY', 5.0, 2127.65, 0.00235);
  assert.equal(posRebound.phase, 'HOLDING_REBOUND');
  assert.equal(posRebound.reboundEntryPriceUsd, 0.00235);

  // 4. Price surges +21% to 0.00285 -> Quick Swing TP 20% triggers!
  const reboundTick = lane.evaluatePriceTick(signal.mint, 0.00285);
  assert.equal(reboundTick.shouldSell, true);
  assert.equal(reboundTick.sellType, 'REBOUND_TP_20_FULL');
  assert.equal(reboundTick.sellRatioPct, 100);

  // Execute Rebound TP: 2,127.65 tokens sold @ 0.00285 = $6.06 (+$1.06 profit)
  const posSold = lane.recordSellExecution(signal.mint, 'REBOUND_TP_20_FULL', 2127.65, 6.0638, 0.00285, true, 'sell-rebound-tp');
  assert.ok(posSold);
  assert.equal(posSold.realizedPnlUsd, 3.0638); // $2.00 from initial TP + $1.06 from rebound TP!
  assert.equal(posSold.phase, 'WAITING_DIP');
});
