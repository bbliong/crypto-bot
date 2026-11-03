import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig, readFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Scenario 7 Time-Stop Hybrid Engine...');

  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-s7-'));
  saveFollowerLiveConfig(testDir, {
    stakeUsdS4: 1.0,
    stakeUsdS6Pool1: 1.0,
    stakeUsdS6Pool2: 2.0,
    stakeUsdS7Pool1: 1.0,
    stakeUsdS7Pool2: 2.0,
    enabled: true,
    autobuyScenario: 'S7'
  });

  const cfg = readFollowerLiveConfig(testDir);
  assert.equal(cfg.autobuyScenario, 'S7', 'Config must accept S7');
  assert.equal(cfg.stakeUsdS7Pool1, 1.0);
  assert.equal(cfg.stakeUsdS7Pool2, 2.0);
  console.log('   ✅ Follower live config S7 verified');

  const engine = new MultiScenarioDryRunEngine(testDir);
  assert(engine.scenarios.s7, 'Scenario 7 must exist in engine');
  assert.equal(engine.scenarios.s7.availableCash, 20.0);
  console.log('   ✅ Scenario 7 initial state verified ($20.00 cash)');

  const actions = [];
  engine.onTradeAction = (action, scId, sig, det) => {
    actions.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason });
  };

  // 1. Target first buy token TEST at Ground Zero
  console.log('\n1. Target First Buy TEST at Ground Zero ($0.0000096)...');
  const now = Date.now();
  const buySignal = {
    action: 'buy',
    mint: 'MintS7Test11111111111111111111111111111111',
    symbol: 'S7TEST',
    tokenName: 'S7 Test Coin',
    tokenAmount: 190000000,
    remainingHolding: 190000000,
    solAmount: 20,
    usdAmount: 1840,
    priceUsd: 0.0000096,
    txHash: 'TxBuyS7',
    timestamp: Math.floor(now / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(buySignal, true);
  assert.equal(engine.scenarios.s7.openPositions.length, 1, 'S7 must open position');
  const pos = engine.scenarios.s7.openPositions[0];
  assert.equal(pos.symbol, 'S7TEST');
  assert.equal(pos.costBasisUsd, 1.0, 'S7 Pool 1 stake must be $1.00');
  console.log('   ✅ S7 position opened successfully ($1.00)');

  // 2. Target sells 6% at second +18s -> Triggers Stage 1 TP 50%
  console.log('\n2. Target sells 6% at second +18s (Triggers Stage 1 TP 50%)...');
  actions.length = 0;
  engine.handleTargetSell({
    action: 'sell',
    mint: buySignal.mint,
    symbol: 'S7TEST',
    tokenName: 'S7 Test Coin',
    tokenAmount: 11400000, // 6% of 190M
    remainingHolding: 178600000,
    solAmount: 1.5,
    usdAmount: 138,
    priceUsd: 0.0000125, // +30% pump
    txHash: 'TxSell6pct',
    timestamp: Math.floor(now / 1000) + 18,
    isOpenOrClose: false,
    isFirstBuy: false
  });

  const posAfterS1 = engine.scenarios.s7.openPositions[0];
  assert(posAfterS1, 'Position must remain open with 50% runner');
  assert.equal(posAfterS1.stage1Exited, true, 'Stage 1 must be marked exited');
  assert.equal(posAfterS1.costBasisUsd, 0.5, 'Cost basis must be halved to $0.50');
  console.log('   ✅ Stage 1 TP 50% triggered at second +18s');

  // 3. Second +28s arrives without target selling 15% -> Time-Stop Force Sell 100%!
  console.log('\n3. Second +28s arrives (Time-Stop Force Sell 100%)...');
  actions.length = 0;
  // Simulasikan waktu bergeser +28500ms
  const originalNow = Date.now;
  Date.now = () => now + 28500;
  try {
    engine.checkTimeStopExits(28000);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(engine.scenarios.s7.openPositions.length, 0, 'S7 position must be 100% closed by Time-Stop');
  assert.equal(engine.scenarios.s7.closedTrades.length, 1, 'Closed trade must be recorded');
  const closedT = engine.scenarios.s7.closedTrades[0];
  assert(closedT.exitReason.includes('TIME_STOP_'), 'Exit reason must mention TIME_STOP');
  assert(closedT.isWin, 'Must be marked as WIN');
  console.log('   ✅ Time-Stop 28s Force Sell verified:', closedT.exitReason);
  console.log('   ✅ Trade result: Returned $' + closedT.totalReturnedUsd + ', PnL: $' + closedT.realizedPnlUsd + ' (ROI: ' + closedT.roiPct + '%)');

  console.log('\n🎉 ALL SCENARIO 7 TIME-STOP TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
