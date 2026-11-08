import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Scenario 13.5 Engine Logic (Adaptive Ping-Pong Runner / Dynamic Health Gates)...');

  const testDir = path.resolve(process.cwd(), 'data/test-s13-5-logic');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDir);
  const now = Date.now();

  assert(engine.scenarios.s13_5, 'Scenario 13.5 must be defined in engine');
  assert.equal(engine.scenarios.s13_5.availableCash, 20.0, 'S13.5 initial cash must be $20.00');

  // =========================================================================
  // Test 1: Whale Micro-Inflow ($100 / 1.1 SOL) -> Must NOT activate S13.5
  // =========================================================================
  console.log('\n--- Test 1: Whale Micro-Inflow ($100 / 1.1 SOL) -> Must NOT activate S13.5 ---');
  const mintMicro = 'MintMicro11111111111111111111111111111111';

  engine.handleTargetBuy({
    action: 'buy',
    mint: mintMicro,
    symbol: 'MICRO_COIN',
    tokenName: 'Micro Coin',
    tokenAmount: 1000000,
    remainingHolding: 1000000,
    solAmount: 1.1,
    usdAmount: 100,
    priceUsd: 0.000010,
    txHash: 'TxWhaleMicro',
    timestamp: Math.floor((now - 100000) / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  const trackerMicro = engine.s13_5PingPongTrackers.get(mintMicro);
  assert.equal(trackerMicro, undefined, 'S13.5 tracker must NOT be activated on micro-inflow');
  console.log('   ✅ Test 1 PASSED: Micro-inflow (< 20 SOL) diabaikan oleh S13.5!');

  // =========================================================================
  // Test 2: Whale High-Conviction Inflow (30 SOL / $2680) -> Activates S13.5
  // =========================================================================
  console.log('\n--- Test 2: Whale 30 SOL Inflow ($2680) -> Activates S13.5 Radar ---');
  const mintConviction = 'MintConviction333333333333333333333333333333';
  const t0 = now - 60000;

  engine.handleTargetBuy({
    action: 'buy',
    mint: mintConviction,
    symbol: 'ADAPTIVE_COIN',
    tokenName: 'Adaptive Coin',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2680,
    priceUsd: 0.000038,
    txHash: 'TxWhaleConviction',
    timestamp: Math.floor(t0 / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  const trackerConviction = engine.s13_5PingPongTrackers.get(mintConviction);
  assert(trackerConviction, 'S13.5 tracker MUST be activated for 30 SOL inflow');
  assert.equal(trackerConviction.status, 'ACTIVE');
  assert.equal(trackerConviction.cycleCount, 0);
  assert.equal(trackerConviction.consecutiveSells, 0);
  assert.equal(engine.scenarios.s13_5.openPositions.length, 0, 'S13.5 must NOT enter yet (waits for dip)');
  console.log('   ✅ Test 2 PASSED: 30 SOL Whale sukses mengaktifkan S13.5 Radar (Standby di Lembah)!');

  // =========================================================================
  // Test 3: Whale Micro-Sell #1 (Normal Dip) -> S13.5 BUYS CYCLE #1 ON DIP
  // =========================================================================
  console.log('\n--- Test 3: Whale Micro-Sell #1 -> S13.5 Buys Cycle #1 on Normal Dip ---');
  const t1 = t0 + 10000;

  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'ADAPTIVE_COIN',
    tokenName: 'Adaptive Coin',
    tokenAmount: 1400000, // 2% micro sell ($80)
    remainingHolding: 68600000,
    solAmount: 0.9,
    usdAmount: 80,
    priceUsd: 0.000058,
    txHash: 'TxWhaleSell1',
    timestamp: Math.floor(t1 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  assert.equal(trackerConviction.consecutiveSells, 1);
  assert.equal(engine.scenarios.s13_5.openPositions.length, 1, 'S13.5 must enter position on Whale dip #1');
  const posCycle1 = engine.scenarios.s13_5.openPositions[0];
  assert.equal(posCycle1.entryCount, 1);
  assert.equal(posCycle1.costBasisUsd, 5.0, 'Stake must be $5.00');
  console.log(`   ✅ Test 3 PASSED: S13.5 sukses beli Siklus #1 di harga diskon $${posCycle1.avgEntryPriceUsd}!`);

  // =========================================================================
  // Test 4: Price Bounces +12% -> S13.5 EXITS VIA TAKE PROFIT +10%
  // =========================================================================
  console.log('\n--- Test 4: Price Bounces +12% -> S13.5 Exits via TP +10% ---');
  const t2 = t1 + 8000;
  engine.updatePriceTick(mintConviction, 0.000065); // $0.000065 vs $0.000058 = +12.0%

  assert.equal(engine.scenarios.s13_5.openPositions.length, 0, 'Position must be closed at TP +10%');
  assert.equal(engine.scenarios.s13_5.closedTrades.length, 1);
  const trade1 = engine.scenarios.s13_5.closedTrades[0];
  assert(trade1.exitReason.includes('TP_10%_PINGPONG_SWING'));
  console.log(`   ✅ Test 4 PASSED: Siklus #1 Take Profit bersih +$${trade1.realizedPnlUsd} (${trade1.roiPct}%)!`);

  // =========================================================================
  // Test 5: Whale Buyback -> Resets consecutiveSells to 0
  // =========================================================================
  console.log('\n--- Test 5: Whale Buyback -> Resets consecutiveSells to 0 ---');
  const t3 = t2 + 4000;
  engine.handleTargetBuy({
    action: 'buy',
    mint: mintConviction,
    symbol: 'ADAPTIVE_COIN',
    tokenName: 'Adaptive Coin',
    tokenAmount: 1500000,
    remainingHolding: 70100000,
    solAmount: 1.1,
    usdAmount: 100,
    priceUsd: 0.000066,
    txHash: 'TxWhaleBuyback1',
    timestamp: Math.floor(t3 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  }, true);

  assert.equal(trackerConviction.consecutiveSells, 0, 'Consecutive sells must reset to 0 on buyback');
  console.log('   ✅ Test 5 PASSED: Buyback Whale sukses me-reset counter consecutive sells!');

  // =========================================================================
  // Test 6: Whale Sell #1 -> Enters Cycle #2 -> Whale Sell #2 -> Sell #3 (Consecutive Sells >= 3)
  // MUST TRIGGER S13_5_EMERGENCY_3_CONSECUTIVE_SELLS!
  // =========================================================================
  console.log('\n--- Test 6: 3 Consecutive Sells Pattern -> Triggers Emergency Exit & Terminate ---');
  trackerConviction.lastExitAt = t3;
  const t4 = t3 + 5000;

  // Sell 1 (Whale sells $90) -> S13.5 enters Cycle #2
  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'ADAPTIVE_COIN',
    tokenName: 'Adaptive Coin',
    tokenAmount: 1400000,
    remainingHolding: 68700000,
    solAmount: 1.0,
    usdAmount: 90,
    priceUsd: 0.000062,
    txHash: 'TxWhaleSellStreak1',
    timestamp: Math.floor(t4 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });
  assert.equal(engine.scenarios.s13_5.openPositions.length, 1);
  assert.equal(trackerConviction.consecutiveSells, 1);

  // Sell 2 (Whale sells again $100 without buyback! consecutiveSells = 2)
  const t5 = t4 + 7000; // 7s gap
  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'ADAPTIVE_COIN',
    tokenName: 'Adaptive Coin',
    tokenAmount: 1500000,
    remainingHolding: 67200000,
    solAmount: 1.1,
    usdAmount: 100,
    priceUsd: 0.000060,
    txHash: 'TxWhaleSellStreak2',
    timestamp: Math.floor(t5 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });
  assert.equal(trackerConviction.consecutiveSells, 2);
  assert.equal(engine.scenarios.s13_5.openPositions.length, 1, 'Still in position on sell 2');

  // Sell 3 (Whale sells again $120! consecutiveSells = 3 -> DANGER CONFIRMED!)
  const t6 = t5 + 6000; // 6s gap
  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'ADAPTIVE_COIN',
    tokenName: 'Adaptive Coin',
    tokenAmount: 1600000,
    remainingHolding: 65600000,
    solAmount: 1.3,
    usdAmount: 120,
    priceUsd: 0.000057,
    txHash: 'TxWhaleSellStreak3',
    timestamp: Math.floor(t6 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  assert.equal(trackerConviction.consecutiveSells, 3);
  assert.equal(engine.scenarios.s13_5.openPositions.length, 0, 'Position must be closed immediately on 3 consecutive sells');
  assert.equal(trackerConviction.status, 'TERMINATED', 'Tracker MUST be terminated');
  const trade2 = engine.scenarios.s13_5.closedTrades[0];
  assert(trade2.exitReason.includes('S13_5_EMERGENCY_3_CONSECUTIVE_SELLS'));
  console.log(`   ✅ Test 6 PASSED: S13.5 mendeteksi 3x Sell beruntun, langsung eksekusi Emergency Exit & Sesi di-TERMINATE!`);

  // =========================================================================
  // Test 7: Freeze Dip Entry on consecutiveSells >= 2 (When NOT in position)
  // =========================================================================
  console.log('\n--- Test 7: Freeze Dip Entry on consecutiveSells >= 2 (No Falling Knife) ---');
  const mintKnife = 'MintKnife4444444444444444444444444444444444';
  engine.handleTargetBuy({
    action: 'buy',
    mint: mintKnife,
    symbol: 'KNIFE_COIN',
    tokenName: 'Knife Coin',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2680,
    priceUsd: 0.000038,
    txHash: 'TxWhaleKnifeFirst',
    timestamp: Math.floor(now / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  const trackerKnife = engine.s13_5PingPongTrackers.get(mintKnife);
  // Simulasikan bot tidak sempat beli di sell 1 (misal cooldown), lalu muncul sell 2:
  trackerKnife.consecutiveSells = 1; // Sudah sell 1x
  trackerKnife.lastExitAt = now - 5000;

  // Muncul sell 2:
  engine.handleTargetSell({
    action: 'sell',
    mint: mintKnife,
    symbol: 'KNIFE_COIN',
    tokenName: 'Knife Coin',
    tokenAmount: 1500000,
    remainingHolding: 67000000,
    solAmount: 1.1,
    usdAmount: 100,
    priceUsd: 0.000055,
    txHash: 'TxWhaleKnifeSell2',
    timestamp: Math.floor((now + 5000) / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  assert.equal(trackerKnife.consecutiveSells, 2);
  assert.equal(engine.scenarios.s13_5.openPositions.length, 0, 'Must NOT buy dip when consecutiveSells >= 2');
  console.log('   ✅ Test 7 PASSED: Pembelian lembah sukses DIBEKUKAN pada sell ke-2 (anti-pisau jatuh)!');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n🎉 ALL SCENARIO 13.5 LOGIC TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
