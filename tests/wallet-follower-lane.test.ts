import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WalletFollowerLane, WalletTradeSignal } from '../src/wallet-follower-lane.js';

const TEST_DIR = path.resolve(process.cwd(), 'data/test-follower');
const POS_FILE = path.join(TEST_DIR, 'test-positions.json');
const TRADES_FILE = path.join(TEST_DIR, 'test-trades.json');

function cleanup() {
  if (fs.existsSync(POS_FILE)) fs.unlinkSync(POS_FILE);
  if (fs.existsSync(TRADES_FILE)) fs.unlinkSync(TRADES_FILE);
  if (fs.existsSync(TEST_DIR)) fs.rmdirSync(TEST_DIR);
}

test('WalletFollowerLane: Entry #1 allowed with $2.0 stake', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  const signal: WalletTradeSignal = {
    action: 'buy',
    mint: 'TokenTest1111111111111111111111111111111111',
    symbol: 'TEST',
    tokenName: 'Test Token',
    tokenAmount: 10000,
    remainingHolding: 10000,
    solAmount: 0.5,
    usdAmount: 75,
    priceUsd: 0.0075,
    txHash: 'tx1',
    timestamp: 1700000000,
  };

  const evalBuy = lane.evaluateBuySignal(signal);
  assert.equal(evalBuy.canEnter, true);
  assert.equal(evalBuy.stakeUsd, 2.0);
  assert.equal(evalBuy.entryNum, 1);

  // Record execution: bot buys 266.66 tokens with $2.0
  const pos = lane.recordBuyExecution(signal, 2.0, 266.66, 0.0075);
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.entryCount, 1);
  assert.equal(pos.totalStakeUsd, 2.0);
  assert.equal(pos.totalTokens, 266.66);
  assert.equal(pos.remainingCostBasisUsd, 2.0);
  cleanup();
});

test('WalletFollowerLane: Accumulation up to $20 capital (10x buys without sell), 11th blocked, sell frees up capital', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    maxCapitalExposureUsd: 20.0,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  const mint = 'TokenTest2222222222222222222222222222222222';
  // 10 entries without sell -> $20 capital consumed
  for (let i = 1; i <= 10; i++) {
    const signal: WalletTradeSignal = {
      action: 'buy',
      mint,
      symbol: 'TEST2',
      tokenName: 'Test Token 2',
      tokenAmount: 5000,
      remainingHolding: 5000 * i,
      solAmount: 0.1,
      usdAmount: 15,
      priceUsd: 0.003,
      txHash: `tx_${i}`,
      timestamp: 1700000000 + i * 10,
    };

    const evalBuy = lane.evaluateBuySignal(signal);
    assert.equal(evalBuy.canEnter, true, `Entry ${i} should be allowed`);
    assert.equal(evalBuy.stakeUsd, 2.0);
    assert.equal(evalBuy.entryNum, i);

    lane.recordBuyExecution(signal, 2.0, 666.66, 0.003);
  }

  const pos = lane.getPosition(mint);
  assert.ok(pos);
  assert.equal(pos.entryCount, 10);
  assert.equal(pos.totalStakeUsd, 20.0);
  assert.equal(pos.remainingCostBasisUsd, 20.0);

  // Attempt 11th entry without any sell -> Should be blocked!
  const eleventhSignal: WalletTradeSignal = {
    action: 'buy',
    mint,
    symbol: 'TEST2',
    tokenName: 'Test Token 2',
    tokenAmount: 5000,
    remainingHolding: 55000,
    solAmount: 0.1,
    usdAmount: 15,
    priceUsd: 0.003,
    txHash: 'tx_11',
    timestamp: 1700000110,
  };

  const evalEleventh = lane.evaluateBuySignal(eleventhSignal);
  assert.equal(evalEleventh.canEnter, false);
  assert.equal(evalEleventh.stakeUsd, 0);
  assert.match(evalEleventh.reason, /CAPITAL_EXHAUSTED_MAX_EXPOSURE/);

  // Target sells 50% -> Bot sells 50% of tokens -> Cost basis drops to $10!
  const sellSignal: WalletTradeSignal = {
    action: 'sell',
    mint,
    symbol: 'TEST2',
    tokenName: 'Test Token 2',
    tokenAmount: 25000,
    remainingHolding: 25000, // 50% sold
    solAmount: 0.5,
    usdAmount: 75,
    priceUsd: 0.003,
    txHash: 'tx_sell_50',
    timestamp: 1700000120,
  };

  const evalSell = lane.evaluateSellSignal(sellSignal);
  assert.equal(evalSell.canSell, true);
  lane.recordSellExecution(sellSignal, evalSell.botTokensToSell, 10.0, 0.003, false);

  const posAfterSell = lane.getPosition(mint);
  assert.ok(posAfterSell);
  assert.equal(posAfterSell.remainingCostBasisUsd, 10.0);

  // Now, 11th entry (with freed capital) SUCCEEDS!
  const evalEleventhRetry = lane.evaluateBuySignal(eleventhSignal);
  assert.equal(evalEleventhRetry.canEnter, true);
  assert.equal(evalEleventhRetry.stakeUsd, 2.0);
  assert.equal(evalEleventhRetry.entryNum, 11);

  cleanup();
});

test('WalletFollowerLane: Proportional Sell calculation (Target sells 30%)', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  const mint = 'TokenTest3333333333333333333333333333333333';
  // Bot buys 1,000 tokens for $2.0 (avg price $0.002)
  lane.recordBuyExecution(
    {
      action: 'buy',
      mint,
      symbol: 'TEST3',
      tokenName: 'Test Token 3',
      tokenAmount: 100000,
      remainingHolding: 100000,
      solAmount: 1.0,
      usdAmount: 150,
      priceUsd: 0.002,
      txHash: 'tx_b1',
      timestamp: 1700000000,
    },
    2.0,
    1000,
    0.002
  );

  // Target sells 30,000 tokens, remaining is 70,000 tokens (Sell Ratio = 30,000 / (70,000 + 30,000) = 30%)
  const sellSignal: WalletTradeSignal = {
    action: 'sell',
    mint,
    symbol: 'TEST3',
    tokenName: 'Test Token 3',
    tokenAmount: 30000,
    remainingHolding: 70000,
    solAmount: 0.4,
    usdAmount: 60,
    priceUsd: 0.003, // +50% price increase
    txHash: 'tx_s1',
    timestamp: 1700000020,
  };

  const evalSell = lane.evaluateSellSignal(sellSignal);
  assert.equal(evalSell.canSell, true);
  assert.equal(evalSell.sellRatioPct, 30);
  assert.equal(evalSell.isFullExit, false);
  // Bot should sell 30% of 1000 tokens = 300 tokens
  assert.equal(evalSell.botTokensToSell, 300);

  // Execute sell: 300 tokens sold at $0.003 = $0.90 USD received
  // Cost basis for 300 tokens (30% of $2.0) = $0.60
  // Realized PnL = $0.90 - $0.60 = +$0.30 USD (+50% ROI)
  const sellResult = lane.recordSellExecution(sellSignal, 300, 0.90, 0.003, false);
  assert.ok(sellResult);
  assert.equal(sellResult.exitRecord.pnlUsd, 0.3);
  assert.equal(sellResult.exitRecord.roiPct, 50);
  assert.equal(sellResult.exitRecord.isFullExit, false);

  const pos = lane.getPosition(mint);
  assert.ok(pos);
  assert.equal(pos.status, 'OPEN');
  assert.equal(pos.totalTokens, 700);
  assert.equal(pos.remainingCostBasisUsd, 1.4);
  assert.equal(pos.realizedPnlUsd, 0.3);
  cleanup();
});

test('WalletFollowerLane: Blocks entry when target already held pre-existing bag (onlyNewTokens = true)', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    onlyNewTokens: true,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  // Target buys 100K tokens, but remainingHolding is 500K tokens (target held 400K tokens before!)
  const oldBagSignal: WalletTradeSignal = {
    action: 'buy',
    mint: 'TokenOldBag111111111111111111111111111111',
    symbol: 'OLDBAG',
    tokenName: 'Old Bag Token',
    tokenAmount: 100000,
    remainingHolding: 500000,
    solAmount: 1.0,
    usdAmount: 150,
    priceUsd: 0.0015,
    txHash: 'tx_old',
    timestamp: 1700000000,
  };

  const evalBuy = lane.evaluateBuySignal(oldBagSignal);
  assert.equal(evalBuy.canEnter, false);
  assert.match(evalBuy.reason, /REJECT_PRE_EXISTING_BAG/);

  // Target buys 200K tokens on a FRESH new token (holding before was 0!)
  const freshSignal: WalletTradeSignal = {
    action: 'buy',
    mint: 'TokenFresh2222222222222222222222222222222',
    symbol: 'FRESH',
    tokenName: 'Fresh Token',
    tokenAmount: 200000,
    remainingHolding: 200000, // exact match -> held 0 before
    solAmount: 2.0,
    usdAmount: 300,
    priceUsd: 0.0015,
    txHash: 'tx_fresh',
    timestamp: 1700000005,
  };

  const evalFresh = lane.evaluateBuySignal(freshSignal);
  assert.equal(evalFresh.canEnter, true);
  assert.equal(evalFresh.stakeUsd, 2.0);
  assert.equal(evalFresh.entryNum, 1);
  assert.match(evalFresh.reason, /NEW_TOKEN_FRESH_ENTRY_1/);

  cleanup();
});

test('WalletFollowerLane: Target Full Exit (100% or Dust remaining)', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  const mint = 'TokenTest4444444444444444444444444444444444';
  lane.recordBuyExecution(
    {
      action: 'buy',
      mint,
      symbol: 'TEST4',
      tokenName: 'Test Token 4',
      tokenAmount: 50000,
      remainingHolding: 50000,
      solAmount: 0.5,
      usdAmount: 75,
      priceUsd: 0.001,
      txHash: 'tx_b1',
      timestamp: 1700000000,
    },
    2.0,
    2000,
    0.001
  );

  // Target dumps almost everything, leaving only 5 dust tokens (remaining < 100)
  const dumpSignal: WalletTradeSignal = {
    action: 'sell',
    mint,
    symbol: 'TEST4',
    tokenName: 'Test Token 4',
    tokenAmount: 49995,
    remainingHolding: 5, // Dust
    solAmount: 0.6,
    usdAmount: 90,
    priceUsd: 0.0012,
    txHash: 'tx_dump',
    timestamp: 1700000030,
  };

  const evalDump = lane.evaluateSellSignal(dumpSignal);
  assert.equal(evalDump.canSell, true);
  assert.equal(evalDump.isFullExit, true);
  assert.equal(evalDump.botTokensToSell, 2000); // Sells all 2000 tokens

  const res = lane.recordSellExecution(dumpSignal, 2000, 2.40, 0.0012, true);
  assert.ok(res);
  assert.equal(res.exitRecord.isFullExit, true);
  assert.equal(res.exitRecord.pnlUsd, 0.4); // $2.40 - $2.00 = +$0.40

  const pos = lane.getPosition(mint);
  assert.ok(pos);
  assert.equal(pos.status, 'CLOSED');
  assert.equal(pos.totalTokens, 0);

  // Check trade was archived
  assert.equal(fs.existsSync(TRADES_FILE), true);
  const archived = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
  assert.equal(archived.length, 1);
  assert.equal(archived[0].mint, mint);
  cleanup();
});

test('WalletFollowerLane: Fresh pool entry allowed despite initial bag when isFreshToken is true, old pool rejected', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    onlyNewTokens: true,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  const mintFresh = 'TokenYoungPool1111111111111111111111111111';
  // Target buys 100K tokens, but already held 300K tokens before due to indexing delay
  const signalLag: WalletTradeSignal = {
    action: 'buy',
    mint: mintFresh,
    symbol: 'YOUNG',
    tokenName: 'Young Token',
    tokenAmount: 100000,
    remainingHolding: 400000,
    solAmount: 1.0,
    usdAmount: 100,
    priceUsd: 0.001,
    txHash: 'tx_young_lag',
    timestamp: 1700000000,
  };

  // 1. Without isFreshToken -> rejected due to pre-existing bag
  const evalWithoutFresh = lane.evaluateBuySignal(signalLag);
  assert.equal(evalWithoutFresh.canEnter, false);
  assert.match(evalWithoutFresh.reason, /REJECT_PRE_EXISTING_BAG/);

  // 2. With isFreshToken: true (verified token age <= 10m) -> allowed entry!
  const evalWithFresh = lane.evaluateBuySignal(signalLag, { isFreshToken: true, tokenAgeMinutes: 8.5 });
  assert.equal(evalWithFresh.canEnter, true);
  assert.equal(evalWithFresh.stakeUsd, 2.0);
  assert.equal(evalWithFresh.entryNum, 1);
  assert.match(evalWithFresh.reason, /NEW_TOKEN_YOUNG_POOL_ENTRY_1/);

  // 3. Old token (> 10m) -> rejected even if ground zero
  const signalOldZero: WalletTradeSignal = {
    action: 'buy',
    mint: 'TokenOldZero222222222222222222222222222222222',
    symbol: 'OLDZERO',
    tokenName: 'Old Zero Token',
    tokenAmount: 50000,
    remainingHolding: 50000, // Ground zero holding
    solAmount: 0.5,
    usdAmount: 50,
    priceUsd: 0.001,
    txHash: 'tx_old_zero',
    timestamp: 1700000010,
  };
  const evalOldZero = lane.evaluateBuySignal(signalOldZero, { isFreshToken: false, tokenAgeMinutes: 120 });
  assert.equal(evalOldZero.canEnter, false);
  assert.match(evalOldZero.reason, /REJECT_OLD_TOKEN_AGE_120M/);

  // 4. Token age 15m (> 10m) -> rejected
  const eval15m = lane.evaluateBuySignal(signalLag, { isFreshToken: false, tokenAgeMinutes: 15.2 });
  assert.equal(eval15m.canEnter, false);
  assert.match(eval15m.reason, /REJECT_OLD_TOKEN_AGE_15M/);

  // 5. Accumulation blocked if token age > 10m
  lane.recordBuyExecution(signalLag, 2.0, 1000, 0.002);
  const evalAccumulateOld = lane.evaluateBuySignal(signalLag, { tokenAgeMinutes: 14 });
  assert.equal(evalAccumulateOld.canEnter, false);
  assert.match(evalAccumulateOld.reason, /REJECT_ACCUMULATE_TOKEN_AGE_14M/);

  cleanup();
});
