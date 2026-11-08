import assert from 'node:assert/strict';
import { SingleDevWalletWatcher, KNOWN_AMM_PROGRAMS } from '../src/dev-wallet-watcher.js';

async function run() {
  console.log('Testing Dev Radar Pool vs Trade/Swap Filter...');

  const watcher = new SingleDevWalletWatcher();

  // Pasang mock active target
  const mockDev = 'P5ormJ7h8HkW2Ctgr2szhEzW7Bq6y4HB4ZbMAwiff9X';
  const mockMint = '6fu8GGkZjnJo7FL5RzNCxzrCJ7JVyuVBU9wYPDmtF7Qo';
  watcher.activeTarget = {
    mint: mockMint,
    symbol: 'HABIBI',
    devWallet: mockDev,
    subscribedAt: Date.now()
  };

  let redeployEvent = null;
  watcher.on('redeploy_detected', (evt) => {
    redeployEvent = evt;
  });

  // Track logs
  const logsCaptured = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logsCaptured.push(args.join(' '));
    originalLog(...args);
  };

  // Test Case 1: Whale 30 SOL Buy pada PumpAMM (Bundled Tx dengan Dev sebagai Co-Signer)
  // Berisi Program ID PumpAMM dan "Instruction: Buy" TANPA instruksi pembuatan kolam
  console.log('\n--- Test 1: Whale 30 SOL Buy (Co-Signed by Dev) ---');
  redeployEvent = null;
  logsCaptured.length = 0;

  const whaleBuyNotification = {
    signature: '4mCW3zm6TestWhaleBuySignature11111111111111111111111111111111',
    logs: [
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]',
      'Program log: Instruction: Buy',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success',
      'Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success'
    ]
  };

  await watcher.handleLogsNotification(whaleBuyNotification);

  assert.equal(redeployEvent, null, 'Whale Buy must NOT emit redeploy_detected');
  const hasTradeIgnoreLog = logsCaptured.some(l => l.includes('adalah transaksi swap/perdagangan Whale/Dev'));
  assert(hasTradeIgnoreLog, 'Must explicitly log that Whale buy is ignored as trade/swap');
  console.log('   ✅ Test 1 PASSED: Transaksi Buy 30 SOL Whale sukses ditolak & tidak memicu false pool!');

  // Test Case 2: Dev Rug-pull / Remove Liquidity
  console.log('\n--- Test 2: Dev RemoveAllLiquidity / Withdraw ---');
  redeployEvent = null;
  logsCaptured.length = 0;

  const devDrainNotification = {
    signature: 'DrainSig2222222222222222222222222222222222222222222222222222',
    logs: [
      'Program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG invoke [1]',
      'Program log: Instruction: RemoveAllLiquidity',
      'Program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG success'
    ]
  };

  await watcher.handleLogsNotification(devDrainNotification);

  assert.equal(redeployEvent, null, 'Dev Drain must NOT emit redeploy_detected');
  const hasDrainIgnoreLog = logsCaptured.some(l => l.includes('transaksi penarikan/kuras kas Dev'));
  assert(hasDrainIgnoreLog, 'Must explicitly log that dev drain is ignored');
  console.log('   ✅ Test 2 PASSED: Transaksi Drain/Withdraw Dev sukses ditolak!');

  // Test Case 3: Pure Swap on Meteora/Raydium
  console.log('\n--- Test 3: Pure Swap / Route ---');
  redeployEvent = null;
  logsCaptured.length = 0;

  const pureSwapNotification = {
    signature: 'SwapSig33333333333333333333333333333333333333333333333333333',
    logs: [
      'Program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG invoke [1]',
      'Program log: Instruction: Swap',
      'Program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG success'
    ]
  };

  await watcher.handleLogsNotification(pureSwapNotification);

  assert.equal(redeployEvent, null, 'Pure Swap must NOT emit redeploy_detected');
  console.log('   ✅ Test 3 PASSED: Transaksi Swap murni sukses ditolak!');

  // Test Case 4: Dev Genesis Buy bundled with Pool Creation (e.g. Pump.fun Create + Buy)
  // Harus LOLOS filter karena mengandung instruksi pembuatan pool otentik ('Instruction: Create')
  console.log('\n--- Test 4: Dev Genesis Buy bundled with Pool Creation ---');
  logsCaptured.length = 0;

  const bundledCreateAndBuy = {
    signature: 'CreateAndBuySig44444444444444444444444444444444444444444444444',
    logs: [
      'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]',
      'Program log: Instruction: Create',
      'Program log: Instruction: Buy',
      'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success'
    ]
  };

  await watcher.handleLogsNotification(bundledCreateAndBuy);

  const passedTriggerGate = logsCaptured.some(l => l.includes('[DEV-RADAR TRIGGER]'));
  assert(passedTriggerGate, 'Bundled genesis create+buy MUST pass the trigger gate');
  console.log('   ✅ Test 4 PASSED: Bundled Genesis Create + Buy sukses lolos trigger gate!');

  // Pulihkan console.log
  console.log = originalLog;
  watcher.unwatch();

  console.log('\n🎉 ALL POOL VS TRADE FILTER TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
