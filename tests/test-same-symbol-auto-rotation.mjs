import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Same-Symbol Auto-Rotation (Buy first, then rotate old token)...');

  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-autorotate-'));
  saveFollowerLiveConfig(testDir, {
    stakeUsdS4: 0.25,
    stakeUsdS6Pool1: 5.0,
    stakeUsdS6Pool2: 7.0,
    enabled: true,
    autobuyScenario: 'S4'
  });

  const engine = new MultiScenarioDryRunEngine(testDir);
  const actions = [];
  engine.onTradeAction = (action, scId, sig, det) => {
    actions.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason });
  };

  const signalMint1 = {
    action: 'buy',
    mint: 'Mint11111111111111111111111111111111111111111',
    symbol: 'faucet',
    tokenName: 'faucet',
    tokenAmount: 1000000,
    remainingHolding: 1000000,
    solAmount: 10,
    usdAmount: 1000,
    priceUsd: 0.00001,
    txHash: 'Tx1',
    timestamp: Math.floor(Date.now() / 1000) - 100,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  // Step 1: Target buys Mint 1
  console.log('1. Target buys Mint 1 (faucet)...');
  engine.handleTargetBuy(signalMint1, true);

  assert.strictEqual(engine.scenarios.s4.openPositions.length, 1, 'S4 should have 1 open position');
  assert.strictEqual(engine.scenarios.s4.openPositions[0].mint, signalMint1.mint, 'S4 open position should be Mint 1');
  console.log('   ✅ Mint 1 successfully opened in S4');

  // Step 2: Target buys Mint 2 with SAME SYMBOL "faucet"
  console.log('\n2. Target buys Mint 2 (faucet, new contract)...');
  const signalMint2 = {
    action: 'buy',
    mint: 'Mint22222222222222222222222222222222222222222',
    symbol: 'faucet',
    tokenName: 'faucet',
    tokenAmount: 1500000,
    remainingHolding: 1500000,
    solAmount: 15,
    usdAmount: 1500,
    priceUsd: 0.00002,
    txHash: 'Tx2',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  const actionsBefore = actions.length;
  engine.handleTargetBuy(signalMint2, true);

  // Check actions order: BUY Mint 2 MUST execute BEFORE SELL Mint 1!
  const s4ActionsMint2 = actions.slice(actionsBefore).filter(a => a.scId.includes('4'));
  console.log('   S4 Actions triggered:', s4ActionsMint2.map(a => `${a.action} ${a.mint.slice(0, 8)}... (${a.reason})`));

  assert.strictEqual(s4ActionsMint2.length, 2, 'Should trigger 2 actions for S4: BUY new, then SELL old');
  assert.strictEqual(s4ActionsMint2[0].action, 'BUY', 'First action MUST be BUY (Zero Delay entry)');
  assert.strictEqual(s4ActionsMint2[0].mint, signalMint2.mint, 'First action must buy Mint 2');
  assert.strictEqual(s4ActionsMint2[1].action, 'SELL', 'Second action MUST be SELL (Rotation exit)');
  assert.strictEqual(s4ActionsMint2[1].mint, signalMint1.mint, 'Second action must sell old Mint 1');

  // Verify S4 open positions: MUST contain ONLY Mint 2!
  assert.strictEqual(engine.scenarios.s4.openPositions.length, 1, 'Only 1 active position allowed with same symbol');
  assert.strictEqual(engine.scenarios.s4.openPositions[0].mint, signalMint2.mint, 'Active position must be Mint 2');
  console.log('   ✅ S4 open positions verified: Only Mint 2 active');

  // Verify Mint 1 was moved to closedTrades
  const closedMint1 = engine.scenarios.s4.closedTrades.find(t => t.mint === signalMint1.mint);
  assert(closedMint1, 'Mint 1 must be recorded in closedTrades');
  assert(closedMint1.exitReason.includes('AUTO_ROTATION_SAME_NAME'), 'Exit reason must indicate auto-rotation');
  console.log('   ✅ Mint 1 closed trade verified:', closedMint1.exitReason);

  // Step 3: Target buys different token DOGE (Mint 3)
  console.log('\n3. Target buys different token DOGE (Mint 3)...');
  const signalMint3 = {
    action: 'buy',
    mint: 'Mint33333333333333333333333333333333333333333',
    symbol: 'DOGE',
    tokenName: 'DOGE',
    tokenAmount: 2000000,
    remainingHolding: 2000000,
    solAmount: 20,
    usdAmount: 2000,
    priceUsd: 0.000015,
    txHash: 'Tx3',
    timestamp: Math.floor(Date.now() / 1000) + 10,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(signalMint3, true);

  // Both faucet (Mint 2) and DOGE (Mint 3) should be open now because different symbols
  assert.strictEqual(engine.scenarios.s4.openPositions.length, 2, 'Should now hold both faucet and DOGE');
  console.log('   ✅ Both faucet (Mint 2) and DOGE (Mint 3) active simultaneously (different tickers)');

  console.log('\n🎉 ALL SAME-SYMBOL AUTO-ROTATION TESTS PASSED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
