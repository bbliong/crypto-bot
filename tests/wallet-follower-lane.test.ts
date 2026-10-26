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
    maxEntriesPerToken: 5,
    maxTotalStakeUsd: 10.0,
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

test('WalletFollowerLane: Accumulation up to 5x ($10 cap) and 6th entry blocked', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    maxEntriesPerToken: 5,
    maxTotalStakeUsd: 10.0,
    positionsFilePath: POS_FILE,
    tradesFilePath: TRADES_FILE,
  });

  const mint = 'TokenTest2222222222222222222222222222222222';
  for (let i = 1; i <= 5; i++) {
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
  assert.equal(pos.entryCount, 5);
  assert.equal(pos.totalStakeUsd, 10.0);
  assert.equal(pos.remainingCostBasisUsd, 10.0);

  // Attempt 6th entry
  const sixthSignal: WalletTradeSignal = {
    action: 'buy',
    mint,
    symbol: 'TEST2',
    tokenName: 'Test Token 2',
    tokenAmount: 5000,
    remainingHolding: 30000,
    solAmount: 0.1,
    usdAmount: 15,
    priceUsd: 0.003,
    txHash: 'tx_6',
    timestamp: 1700000060,
  };

  const evalSixth = lane.evaluateBuySignal(sixthSignal);
  assert.equal(evalSixth.canEnter, false);
  assert.equal(evalSixth.stakeUsd, 0);
  assert.match(evalSixth.reason, /CAP_REACHED/);
  cleanup();
});

test('WalletFollowerLane: Proportional Sell calculation (Target sells 30%)', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    maxEntriesPerToken: 5,
    maxTotalStakeUsd: 10.0,
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

test('WalletFollowerLane: Target Full Exit (100% or Dust remaining)', () => {
  cleanup();
  const lane = new WalletFollowerLane({
    targetWallet: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    stakePerEntryUsd: 2.0,
    maxEntriesPerToken: 5,
    maxTotalStakeUsd: 10.0,
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
