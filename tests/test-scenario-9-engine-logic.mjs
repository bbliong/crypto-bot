import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Scenario 9 Engine Logic (Dev Front-Run & 2-Way Target Sync)...');

  const testDataDir = path.resolve(process.cwd(), 'data/test-s9-logic');
  fs.mkdirSync(testDataDir, { recursive: true });
  const testFile = path.join(testDataDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDataDir);

  assert(engine.scenarios.s9, 'Scenario 9 must be defined in engine');
  assert.equal(engine.scenarios.s9.availableCash, 20.0, 'S9 initial cash must be $20.00');

  // --- Case A: Front-Run Detik 0 -> Target Masuk -> Anti-Shakeout -> Wave/Target Exit ---
  console.log('\n--- Case A: Dev Deploy Pool (Any Symbol) -> S9 Front-Run -> Target Enters -> Profitable Exit ---');
  const mintA = 'MintA999999999999999999999999999999999999999';
  const devA = 'DevA999999999999999999999999999999999999999';
  const t0 = Math.floor(Date.now() / 1000);

  // 1. Dev deploy pool baru 'ALPHA' (berbeda nama sekalipun)
  const redeployEvtA = {
    oldMint: 'OldMint000000000000000000000000000000000000',
    newMint: mintA,
    symbol: 'ALPHA',
    devWallet: devA,
    signature: 'TxGenesisA',
    timestamp: t0 * 1000,
    initialMeteoraSol: 2.0,
    mainExchange: 'meteora',
    isSameSymbol: false // Simbol baru! S9 harus tetap front-run!
  };

  engine.handleEarlyRedeployBuy(redeployEvtA, 1.0);

  assert.equal(engine.scenarios.s9.openPositions.length, 1, 'S9 must buy at Genesis Floor');
  const posA = engine.scenarios.s9.openPositions[0];
  assert.equal(posA.mint, mintA);
  assert.equal(posA.boughtAtGenesis, true);
  assert.equal(posA.targetEnteredAt, undefined, 'Target has not entered yet');
  console.log('   ✅ S9 entered at Detik 0 Floor Price ($1.00 stake)');

  // 2. Target whale masuk pada detik +15s
  const targetBuyA = {
    action: 'buy',
    mint: mintA,
    symbol: 'ALPHA',
    tokenName: 'Alpha Coin',
    tokenAmount: 10000000,
    remainingHolding: 10000000,
    solAmount: 25,
    usdAmount: 2250,
    priceUsd: 0.000015, // Melonjak dari harga lantai 0.0000096
    txHash: 'TxTargetBuyA',
    timestamp: t0 + 15,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(targetBuyA, true);

  assert.ok(posA.targetEnteredAt > 0, 'S9 must record targetEnteredAt');
  console.log('   ✅ Target entered at second 15s, S9 synced targetEnteredAt');

  // 3. Target shakeout dump di detik +17s (2 detik setelah target masuk) -> S9 harus HOLD
  const targetSellA1 = {
    action: 'sell',
    mint: mintA,
    symbol: 'ALPHA',
    tokenName: 'Alpha Coin',
    tokenAmount: 5000000,
    remainingHolding: 5000000,
    solAmount: 12,
    usdAmount: 1100,
    priceUsd: 0.0000152,
    txHash: 'TxTargetSellA1',
    timestamp: t0 + 17,
    isOpenOrClose: false,
    isFirstBuy: false
  };

  engine.handleTargetSell(targetSellA1);
  assert.equal(engine.scenarios.s9.openPositions.length, 1, 'S9 must HOLD during initial shakeout');
  console.log('   ✅ S9 held position during target shakeout');

  // 4. Update harga naik +26% -> S9 Take Profit
  engine.updatePriceTick(mintA, 0.0000195);
  assert.equal(engine.scenarios.s9.openPositions.length, 0, 'S9 must exit at Take Profit +25%');
  assert.equal(engine.scenarios.s9.closedTrades.length, 1, 'S9 must have 1 closed trade');
  const tradeA = engine.scenarios.s9.closedTrades[0];
  assert.ok(tradeA.isWin, 'Trade A must be a win');
  console.log(`   ✅ S9 exited in profit: Net +$${tradeA.realizedPnlUsd} (${tradeA.roiPct}%) | Reason: ${tradeA.exitReason}`);

  // --- Case B: Target TIDAK Kunjung Masuk dalam 60 Detik (Time-Stop 60s Safety Exit) ---
  console.log('\n--- Case B: Dev Deploy Pool -> Target Does NOT Enter in 60s -> Force Sell ---');
  const mintB = 'MintB999999999999999999999999999999999999999';
  const tB0 = Date.now() - 65000; // 65 seconds ago

  const redeployEvtB = {
    oldMint: 'OldMintB',
    newMint: mintB,
    symbol: 'GHOST',
    devWallet: devA,
    signature: 'TxGenesisB',
    timestamp: tB0,
    initialMeteoraSol: 2.0,
    mainExchange: 'meteora',
    isSameSymbol: false
  };

  engine.handleEarlyRedeployBuy(redeployEvtB, 1.0);
  assert.equal(engine.scenarios.s9.openPositions.length, 1, 'S9 opened position on GHOST');
  // Backdate openedAt to 65s ago
  engine.scenarios.s9.openPositions[0].openedAt = tB0;

  // Run timeout checks
  engine.checkTimeStopExits(28000);

  assert.equal(engine.scenarios.s9.openPositions.length, 0, 'S9 must force exit GHOST after 60s without target');
  const tradeB = engine.scenarios.s9.closedTrades[0];
  assert.ok(tradeB.exitReason.includes('TARGET_SKIPPED_DEV_POOL') || tradeB.exitReason.includes('60S'), 
    'Exit reason must indicate target skipped dev pool in 60s: ' + tradeB.exitReason);
  console.log(`   ✅ S9 safely force-exited GHOST: ${tradeB.exitReason}`);

  // --- Case C: 2-Way Cross-Check (Target Switched Dev) ---
  console.log('\n--- Case C: S9 Holding Pool from Dev A -> Target Buys Pool from Dev B -> S9 Emergency Exits Old Pool ---');
  const mintC_Old = 'MintC_Old_9999999999999999999999999999999999';
  const mintC_New = 'MintC_New_9999999999999999999999999999999999';

  const redeployEvtC = {
    oldMint: 'OldMintC',
    newMint: mintC_Old,
    symbol: 'WAITING',
    devWallet: devA,
    signature: 'TxGenesisC',
    timestamp: Date.now(),
    initialMeteoraSol: 2.0,
    mainExchange: 'meteora',
    isSameSymbol: false
  };

  engine.handleEarlyRedeployBuy(redeployEvtC, 1.0);
  assert.equal(engine.scenarios.s9.openPositions.length, 1, 'S9 holding WAITING');

  // Target unexpectedly buys a COMPLETELY DIFFERENT token 'NEWDEV'
  const targetBuyNew = {
    action: 'buy',
    mint: mintC_New,
    symbol: 'NEWDEV',
    tokenName: 'New Dev Coin',
    tokenAmount: 10000000,
    remainingHolding: 10000000,
    solAmount: 20,
    usdAmount: 1800,
    priceUsd: 0.000010,
    txHash: 'TxBuyNew',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(targetBuyNew, true);

  assert.equal(engine.scenarios.s9.openPositions.length, 0, 'S9 must have liquidated WAITING because target switched token/dev');
  const tradeC = engine.scenarios.s9.closedTrades[0];
  assert.ok(tradeC.exitReason.includes('TARGET_SWITCHED_DEV'), 'Exit reason must indicate target switched dev: ' + tradeC.exitReason);
  console.log(`   ✅ S9 detected dev mismatch and exited old pool: ${tradeC.exitReason}`);

  // Cleanup test directory
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('\n🎉 ALL SCENARIO 9 ENGINE LOGIC TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
