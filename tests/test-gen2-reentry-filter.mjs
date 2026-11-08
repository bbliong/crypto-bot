import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Strict Gen-2 Re-Entry Gate (Only for TARGET_SKIPPED_DEV_POOL)...');

  const testDir = path.resolve(process.cwd(), 'data/test-gen2-reentry');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDir);
  const now = Date.now();

  // --- Test 1: Trade Take Profit (+500%) -> MUST BE TERMINATED, NO RE-ENTRY ---
  console.log('\n--- Test 1: S9 Take Profit (+500%) Wave Peak ---');
  const mintTp = 'MintTp11111111111111111111111111111111111111';
  
  // Daftarkan koin Gen-2
  engine.handleEarlyRedeployBuy({
    oldMint: 'OldMint001',
    newMint: mintTp,
    symbol: 'COIN_TP',
    devWallet: 'DevWallet001',
    signature: 'SigTp001',
    timestamp: now - 70000,
    mainExchange: 'pumpswap',
    mainPairAddress: 'PairTp001',
    isSameSymbol: true
  }, 0.25);

  assert.equal(engine.scenarios.s9.openPositions.length, 1, 'S9 must hold open position');

  // Simulasi Target Whale Masuk & S9 Take Profit
  engine.executeScenarioExit(
    engine.scenarios.s9,
    0,
    0.000060, // exit price (+500%)
    now - 65000,
    '2026-11-08 12:24:53 WIB',
    'AUTO_TAKE_PROFIT_25% (Gain: +500% >= +25% | Mengunci cuan puncak wave)'
  );

  assert.equal(engine.scenarios.s9.openPositions.length, 0, 'S9 position closed');

  // Periksa status di gen2CycleTracker
  const trackerTp = engine.gen2CycleTracker.get(mintTp);
  assert(trackerTp, 'Tracker must exist');
  assert.equal(trackerTp.status, 'TERMINATED', 'Trade that hit Take Profit MUST be TERMINATED immediately');

  // Trigger checkGen2ReEntry dengan harga spot lebih tinggi
  engine.lastObservedPrices.set(mintTp, 0.000075);
  engine.checkGen2ReEntry(mintTp, 0.000075);

  assert.equal(engine.scenarios.s9.openPositions.length, 0, 'S9 must NOT re-enter on token that already took profit!');
  console.log('   ✅ Test 1 PASSED: Token yang sudah Take Profit sukses di-TERMINATED & tidak re-entry!');

  // --- Test 2: Trade keluar via TARGET_SKIPPED_DEV_POOL (Whale telat masuk) ---
  console.log('\n--- Test 2: S9 Exit via TARGET_SKIPPED_DEV_POOL (Whale Delayed) ---');
  const mintSkipped = 'MintSkipped22222222222222222222222222222222';

  engine.handleEarlyRedeployBuy({
    oldMint: 'OldMint002',
    newMint: mintSkipped,
    symbol: 'COIN_DELAYED',
    devWallet: 'DevWallet002',
    signature: 'SigSkipped002',
    timestamp: now - 65000,
    mainExchange: 'pumpswap',
    mainPairAddress: 'PairSkipped002',
    isSameSymbol: true
  }, 0.25);

  const posIdxSkipped = engine.scenarios.s9.openPositions.findIndex(p => p.mint === mintSkipped);
  assert(posIdxSkipped !== -1, 'Position must exist');

  // Exit aman karena whale belum masuk dalam 60s
  engine.executeScenarioExit(
    engine.scenarios.s9,
    posIdxSkipped,
    0.0000095,
    now - 62000,
    '2026-11-08 12:24:53 WIB',
    'TARGET_SKIPPED_DEV_POOL (Dev Deploy Pool tapi Target TIDAK Beli dalam 60s)'
  );

  const trackerSkipped = engine.gen2CycleTracker.get(mintSkipped);
  assert(trackerSkipped, 'Tracker must exist');
  assert.equal(trackerSkipped.status, 'COOLDOWN', 'TARGET_SKIPPED_DEV_POOL must enter COOLDOWN status');

  // Cooldown 60s sudah lewat, harga spot naik (+50% kenaikan karena whale baru masuk telat)
  trackerSkipped.cooldownUntil = now - 1000; // paksa cooldown selesai
  engine.lastObservedPrices.set(mintSkipped, 0.000015);
  engine.checkGen2ReEntry(mintSkipped, 0.000015);

  const reEnteredPos = engine.scenarios.s9.openPositions.find(p => p.mint === mintSkipped);
  assert(reEnteredPos, 'Must re-enter Siklus 2 when target enters late after TARGET_SKIPPED_DEV_POOL');
  console.log('   ✅ Test 2 PASSED: Token yang keluar aman via TARGET_SKIPPED_DEV_POOL sukses re-entry saat ombak telat muncul!');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n🎉 ALL GEN-2 RE-ENTRY FILTER TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
