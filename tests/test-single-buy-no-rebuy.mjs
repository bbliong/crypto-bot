import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Strict 1-Token-1-Buy Rule (No Re-buy even if Target buys again)...');

  const testDataDir = path.resolve(process.cwd(), 'data/test-no-rebuy');
  fs.mkdirSync(testDataDir, { recursive: true });
  const testFile = path.join(testDataDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDataDir);

  const mintA = 'MintA111111111111111111111111111111111111111';

  // 1. Target First Buy on Mint A
  const buySignal1 = {
    action: 'buy',
    mint: mintA,
    symbol: 'MINTED',
    tokenName: 'Minted Hub',
    tokenAmount: 4000000,
    remainingHolding: 4000000,
    solAmount: 0.65,
    usdAmount: 62.0,
    priceUsd: 0.000014,
    txHash: 'Tx1',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(buySignal1, true);

  const s4 = engine.scenarios.s4;
  assert.strictEqual(s4.openPositions.length, 1, 'Mint A should be opened in S4');
  console.log('   ✅ Mint A successfully opened for S4');

  // 2. Target Sells Mint A (85% -> Full Exit)
  const sellSignal1 = {
    action: 'sell',
    mint: mintA,
    symbol: 'MINTED',
    tokenName: 'Minted Hub',
    tokenAmount: 3500000,
    remainingHolding: 500000,
    solAmount: 0.58,
    usdAmount: 56.0,
    priceUsd: 0.000015,
    txHash: 'Tx2',
    timestamp: Math.floor(Date.now() / 1000) + 8,
    isOpenOrClose: false,
    isFirstBuy: false
  };

  engine.handleTargetSell(sellSignal1);
  assert.strictEqual(s4.openPositions.length, 0, 'Mint A should be closed in S4');
  assert.strictEqual(s4.closedTrades.length, 1, 'Mint A should be recorded in closedTrades');
  console.log('   ✅ Mint A successfully closed in S4');

  // 3. Target Re-buys Mint A 1 minute later
  const buySignal2 = {
    action: 'buy',
    mint: mintA,
    symbol: 'MINTED',
    tokenName: 'Minted Hub',
    tokenAmount: 10000000,
    remainingHolding: 10500000,
    solAmount: 1.8,
    usdAmount: 174.0,
    priceUsd: 0.000016,
    txHash: 'Tx3',
    timestamp: Math.floor(Date.now() / 1000) + 68,
    isOpenOrClose: false,
    isFirstBuy: false
  };

  engine.handleTargetBuy(buySignal2, true); // Even if passed as ground zero

  assert.strictEqual(s4.openPositions.length, 0, 'Mint A must NOT be re-opened in S4!');
  assert.strictEqual(s4.closedTrades.length, 1, 'Closed trades should remain 1');

  const latestEvent = s4.recentEvents[0];
  assert.strictEqual(latestEvent.action, 'SKIP', 'Re-buy event must be skipped');
  assert.ok(latestEvent.reason.includes('REJECT_ALREADY_TRADED'), 'Reason must indicate REJECT_ALREADY_TRADED');
  console.log('   ✅ Mint A re-buy successfully REJECTED: ' + latestEvent.reason);

  // Clean up
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('\n🎉 ALL STRICT 1-TOKEN-1-BUY TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
