import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Early Redeploy Buy (Buy Before Target) & Auto-Liquidation...');

  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-early-buy-'));
  saveFollowerLiveConfig(testDir, {
    stakeUsdS4: 1.0,
    stakeUsdS6Pool1: 1.0,
    stakeUsdS6Pool2: 2.0,
    enabled: true,
    autobuyScenario: 'DRY_RUN'
  });

  const engine = new MultiScenarioDryRunEngine(testDir);
  const actions = [];
  engine.onTradeAction = (action, scId, sig, det) => {
    actions.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason, stakeUsd: det.stakeUsd });
  };

  // Step 1: Target buys Token A1 (Pando #1) at Ground Zero
  console.log('1. Target buys Pando #1 (Ground Zero)...');
  const signalA1 = {
    action: 'buy',
    mint: 'MintA111111111111111111111111111111111111111',
    symbol: 'PANDO',
    tokenName: 'Pando',
    tokenAmount: 190000000,
    remainingHolding: 190000000,
    solAmount: 20,
    usdAmount: 1840,
    priceUsd: 0.0000096,
    txHash: 'TxA1',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(signalA1, true);
  assert.equal(engine.scenarios.s6.openPositions.length, 1, 'S6 must hold Pando #1');
  assert.equal(engine.scenarios.s6.openPositions[0].costBasisUsd, 1.0, 'S6 Pool 1 stake must be $1.00');
  console.log('   ✅ Pando #1 bought in S6 (Stake $1.00)');

  // Step 2: Dev-Radar triggers Early Buy on Pando #2 BEFORE target buys!
  console.log('\n2. Dev Radar detects Pando #2 pool creation (BEFORE Target Buys)...');
  actions.length = 0;
  engine.handleEarlyRedeployBuy({
    oldMint: signalA1.mint,
    newMint: 'MintA222222222222222222222222222222222222222',
    symbol: 'PANDO',
    ipfsUri: 'https://ipfs.io/ipfs/bafkreic3lgnfczlyjizqp274vacpn45lxye677ymhbvlbxeeszlnpc5rum',
    devWallet: 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa',
    signature: 'TxGenesisA2',
    timestamp: Date.now() + 1000
  }, 2.0);

  // Check: Pando #2 should be in openPositions with Pool 2 stake ($2.00)
  assert.equal(engine.scenarios.s6.openPositions.length, 1, 'Only Pando #2 must be open in S6');
  assert.equal(engine.scenarios.s6.openPositions[0].mint, 'MintA222222222222222222222222222222222222222', 'Mint must be Pando #2');
  assert.equal(engine.scenarios.s6.openPositions[0].costBasisUsd, 2.0, 'Pando #2 stake must be $2.00');

  // Check: Pando #1 should be in closedTrades (auto-rotated)
  const closedA1 = engine.scenarios.s6.closedTrades.find(t => t.mint === signalA1.mint);
  assert(closedA1, 'Pando #1 must be closed and rotated');
  assert(closedA1.exitReason.includes('AUTO_ROTATION_SAME_NAME'), 'Exit reason must be AUTO_ROTATION_SAME_NAME');
  console.log('   ✅ Early Buy executed for Pando #2 ($2.00) and Pando #1 auto-rotated before target buy!');

  // Step 3: Target buy arrives 2 seconds later for Pando #2
  console.log('\n3. Target buy arrives 2s later for Pando #2...');
  actions.length = 0;
  engine.handleTargetBuy({
    action: 'buy',
    mint: 'MintA222222222222222222222222222222222222222',
    symbol: 'PANDO',
    tokenName: 'Pando',
    tokenAmount: 190000000,
    remainingHolding: 190000000,
    solAmount: 20,
    usdAmount: 1840,
    priceUsd: 0.0000145, // target price is already pumped
    txHash: 'TxTargetA2',
    timestamp: Math.floor(Date.now() / 1000) + 2,
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  // Bot should NOT double buy (still 1 position, stake still $2.00)
  assert.equal(engine.scenarios.s6.openPositions.length, 1, 'Must still hold 1 position');
  assert.equal(engine.scenarios.s6.openPositions[0].costBasisUsd, 2.0, 'Stake must not double');
  console.log('   ✅ Bot preserved early entry at ground zero without double buying when target buy arrived!');

  // Step 4: Target buys a completely DIFFERENT token (Mint C: DOGE)
  console.log('\n4. Target buys a completely DIFFERENT token (DOGE)...');
  actions.length = 0;
  engine.handleTargetBuy({
    action: 'buy',
    mint: 'MintDoge3333333333333333333333333333333333333',
    symbol: 'DOGE',
    tokenName: 'Doge Coin',
    tokenAmount: 190000000,
    remainingHolding: 190000000,
    solAmount: 20,
    usdAmount: 1840,
    priceUsd: 0.0000095,
    txHash: 'TxDoge',
    timestamp: Math.floor(Date.now() / 1000) + 120,
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  // Pando #2 should now be IMMEDIATELY closed because target moved to DOGE
  const closedA2 = engine.scenarios.s6.closedTrades.find(t => t.mint === 'MintA222222222222222222222222222222222222222');
  assert(closedA2, 'Pando #2 must be closed');
  assert(closedA2.exitReason.includes('AUTO_LIQUIDATE_TARGET_MOVED'), 'Exit reason must indicate target moved to new token');
  console.log('   ✅ Old token Pando #2 auto-liquidated because target moved to different token DOGE:', closedA2.exitReason);

  console.log('\n🎉 ALL EARLY REDEPLOY & AUTO-LIQUIDATION TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
