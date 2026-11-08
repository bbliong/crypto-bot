import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Scenario 13 Engine Logic (Multi-Cycle Ping-Pong Scalper)...');

  const testDir = path.resolve(process.cwd(), 'data/test-s13-logic');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDir);
  const now = Date.now();

  assert(engine.scenarios.s13, 'Scenario 13 must be defined in engine');
  assert.equal(engine.scenarios.s13.availableCash, 20.0, 'S13 initial cash must be $20.00');

  // =========================================================================
  // Test 1: Whale Micro-Inflow ($100 / 1 SOL) -> MUST NOT ACTIVATE S13
  // =========================================================================
  console.log('\n--- Test 1: Whale Micro-Inflow ($100 / 1 SOL) -> Must NOT activate S13 ---');
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

  const trackerMicro = engine.s13PingPongTrackers.get(mintMicro);
  assert.equal(trackerMicro, undefined, 'S13 tracker must NOT be activated on micro-inflow');
  console.log('   ✅ Test 1 PASSED: Micro-inflow (< 20 SOL) diabaikan oleh S13!');

  // =========================================================================
  // Test 2: Whale High-Conviction Inflow (30 SOL / $2600) -> ACTIVATES S13
  // =========================================================================
  console.log('\n--- Test 2: Whale 30 SOL Inflow ($2600) -> Activates S13 Ping-Pong Radar ---');
  const mintConviction = 'MintConviction222222222222222222222222222222';
  const t0 = now - 60000;

  engine.handleTargetBuy({
    action: 'buy',
    mint: mintConviction,
    symbol: 'PINGPONG_COIN',
    tokenName: 'PingPong Coin',
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

  const trackerConviction = engine.s13PingPongTrackers.get(mintConviction);
  assert(trackerConviction, 'S13 tracker MUST be activated for 30 SOL inflow');
  assert.equal(trackerConviction.status, 'ACTIVE');
  assert.equal(trackerConviction.cycleCount, 0);
  assert.equal(engine.scenarios.s13.openPositions.length, 0, 'S13 must NOT enter yet (waits for dip)');
  console.log('   ✅ Test 2 PASSED: 30 SOL Whale sukses mengaktifkan S13 Ping-Pong Radar (Standby di Lembah)!');

  // =========================================================================
  // Test 3: Whale Micro-Sell #1 -> S13 BUYS CYCLE #1 ON DIP
  // =========================================================================
  console.log('\n--- Test 3: Whale Micro-Sell #1 -> S13 Enters Cycle #1 on Dip ---');
  const t1 = t0 + 10000; // +10s

  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'PINGPONG_COIN',
    tokenName: 'PingPong Coin',
    tokenAmount: 1400000, // 2% micro sell
    remainingHolding: 68600000,
    solAmount: 0.9,
    usdAmount: 80,
    priceUsd: 0.000058, // Harga diskon pasca-pump
    txHash: 'TxWhaleSell1',
    timestamp: Math.floor(t1 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  assert.equal(engine.scenarios.s13.openPositions.length, 1, 'S13 must enter position on Whale dip');
  const posCycle1 = engine.scenarios.s13.openPositions[0];
  assert.equal(posCycle1.entryCount, 1);
  assert.equal(posCycle1.costBasisUsd, 5.0, 'Default stake must be $5.00');
  assert.equal(trackerConviction.cycleCount, 1);
  console.log(`   ✅ Test 3 PASSED: S13 sukses beli Siklus #1 di harga diskon $${posCycle1.avgEntryPriceUsd}!`);

  // =========================================================================
  // Test 4: Price Bounces +12% -> S13 EXITS VIA TAKE PROFIT +10%
  // =========================================================================
  console.log('\n--- Test 4: Price Bounces +12% -> S13 Exits Cycle #1 via TP +10% ---');
  const t2 = t1 + 8000; // +8s
  engine.updatePriceTick(mintConviction, 0.000065); // $0.000065 vs $0.000058 = +12.0%

  assert.equal(engine.scenarios.s13.openPositions.length, 0, 'Position must be closed at TP +10%');
  assert.equal(engine.scenarios.s13.closedTrades.length, 1, 'Trade must be closed');
  const trade1 = engine.scenarios.s13.closedTrades[0];
  assert(trade1.exitReason.includes('TP_10%_PINGPONG_SWING'));
  assert.ok(trade1.realizedPnlUsd > 0);
  console.log(`   ✅ Test 4 PASSED: Siklus #1 Take Profit bersih +$${trade1.realizedPnlUsd} (${trade1.roiPct}%)!`);

  // =========================================================================
  // Test 5: Whale Micro-Sell #2 -> S13 BUYS CYCLE #2 ON DIP
  // =========================================================================
  console.log('\n--- Test 5: Whale Micro-Sell #2 -> S13 Enters Cycle #2 on Dip ---');
  // Cooldown 3s lolos
  trackerConviction.lastExitAt = t2;
  const t3 = t2 + 10000; // +10s after exit

  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'PINGPONG_COIN',
    tokenName: 'PingPong Coin',
    tokenAmount: 1500000,
    remainingHolding: 67100000,
    solAmount: 1.0,
    usdAmount: 90,
    priceUsd: 0.000062,
    txHash: 'TxWhaleSell2',
    timestamp: Math.floor(t3 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  assert.equal(engine.scenarios.s13.openPositions.length, 1, 'S13 must enter Cycle #2');
  const posCycle2 = engine.scenarios.s13.openPositions[0];
  assert.equal(posCycle2.entryCount, 2);
  assert.equal(trackerConviction.cycleCount, 2);
  console.log(`   ✅ Test 5 PASSED: S13 sukses beli Siklus #2 di harga diskon $${posCycle2.avgEntryPriceUsd}!`);

  // =========================================================================
  // Test 6: Whale Buyback Pop (+6%) -> S13 DUMPS ON BUYBACK
  // =========================================================================
  console.log('\n--- Test 6: Whale Buyback Pop -> S13 Dumps into Whale Buyback Liquidity ---');
  const t4 = t3 + 7000; // +7s

  engine.handleTargetBuy({
    action: 'buy',
    mint: mintConviction,
    symbol: 'PINGPONG_COIN',
    tokenName: 'PingPong Coin',
    tokenAmount: 1800000,
    remainingHolding: 68900000,
    solAmount: 1.3,
    usdAmount: 120,
    priceUsd: 0.000066, // +6.4% gain from entry $0.000062
    txHash: 'TxWhaleBuyback2',
    timestamp: Math.floor(t4 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  }, true);

  assert.equal(engine.scenarios.s13.openPositions.length, 0, 'S13 must dump 100% on buyback');
  assert.equal(engine.scenarios.s13.closedTrades.length, 2);
  const trade2 = engine.scenarios.s13.closedTrades[0];
  assert(trade2.exitReason.includes('S13_PINGPONG_DUMP_ON_BUYBACK'));
  console.log(`   ✅ Test 6 PASSED: Siklus #2 sukses dump ke buyback whale (+${trade2.roiPct}%)!`);

  // =========================================================================
  // Test 7: Cycle #3 Enters Dip -> Whale DUMP 100% -> EMERGENCY EXIT & TERMINATE
  // =========================================================================
  console.log('\n--- Test 7: Whale Full Dump -> S13 Emergency Exit & Terminate ---');
  trackerConviction.lastExitAt = t4;
  const t5 = t4 + 10000; // +10s

  // S13 enters Cycle #3 on dip
  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'PINGPONG_COIN',
    tokenName: 'PingPong Coin',
    tokenAmount: 1200000,
    remainingHolding: 67700000,
    solAmount: 0.8,
    usdAmount: 75,
    priceUsd: 0.000064,
    txHash: 'TxWhaleSell3',
    timestamp: Math.floor(t5 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });
  assert.equal(engine.scenarios.s13.openPositions.length, 1);

  // Whale mendadak dump 100%!
  const t6 = t5 + 5000;
  engine.handleTargetSell({
    action: 'sell',
    mint: mintConviction,
    symbol: 'PINGPONG_COIN',
    tokenName: 'PingPong Coin',
    tokenAmount: 67700000,
    remainingHolding: 0, // FULL EXIT
    solAmount: 25,
    usdAmount: 2200,
    priceUsd: 0.000055,
    txHash: 'TxWhaleDumpAll',
    timestamp: Math.floor(t6 / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  assert.equal(engine.scenarios.s13.openPositions.length, 0, 'Position must be closed on emergency dump');
  assert.equal(trackerConviction.status, 'TERMINATED', 'Tracker MUST be terminated on full dump');
  const trade3 = engine.scenarios.s13.closedTrades[0];
  assert(trade3.exitReason.includes('S13_EMERGENCY_WHALE_DUMP_EXIT'));
  console.log(`   ✅ Test 7 PASSED: Whale Full Dump langsung ditanggapi dengan Emergency Exit & Ping-Pong di-TERMINATE!`);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n🎉 ALL SCENARIO 13 LOGIC TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
