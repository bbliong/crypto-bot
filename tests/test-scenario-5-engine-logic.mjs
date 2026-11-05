import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Scenario 5 Engine Logic (Anti-Shakeout Runner)...');

  const testDataDir = path.resolve(process.cwd(), 'data/test-s5-logic');
  fs.mkdirSync(testDataDir, { recursive: true });
  const testFile = path.join(testDataDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDataDir);

  assert(engine.scenarios.s5, 'Scenario 5 must be defined in engine');
  assert.equal(engine.scenarios.s5.availableCash, 20.0, 'S5 initial cash must be $20.00');

  // --- Case A: Target Dumps at second +2s (Shakeout) -> S5 Ignores -> Price Pumps to +26% -> S5 Exits at TP +25% ---
  console.log('\n--- Case A: Anti-Shakeout (Ignore dump at 2s) -> TP +25% Harvest ---');
  const mintA = 'MintA555555555555555555555555555555555555555';
  const t0 = Math.floor(Date.now() / 1000);

  // 1. Target First Buy
  const buySignalA = {
    action: 'buy',
    mint: mintA,
    symbol: 'WAVE',
    tokenName: 'Wave Coin',
    tokenAmount: 10000000,
    remainingHolding: 10000000,
    solAmount: 20,
    usdAmount: 1900,
    priceUsd: 0.000010,
    txHash: 'TxBuyA',
    timestamp: t0,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(buySignalA, true);

  assert.equal(engine.scenarios.s5.openPositions.length, 1, 'S5 must open position on Mint A');
  console.log('   ✅ S5 opened position at Ground Zero ($1.00 stake)');

  // 2. Target dumps 85% at second +2s (Shakeout)
  const sellSignalA1 = {
    action: 'sell',
    mint: mintA,
    symbol: 'WAVE',
    tokenName: 'Wave Coin',
    tokenAmount: 8500000,
    remainingHolding: 1500000,
    solAmount: 16,
    usdAmount: 1500,
    priceUsd: 0.0000102,
    txHash: 'TxSellA1',
    timestamp: t0 + 2,
    isOpenOrClose: false,
    isFirstBuy: false
  };

  engine.handleTargetSell(sellSignalA1);

  // S4 would have panicked and exited. S5 must HOLD!
  assert.equal(engine.scenarios.s5.openPositions.length, 1, 'S5 must IGNORE the dump at second 2s and keep holding!');
  const skipEvent = engine.scenarios.s5.recentEvents[0];
  assert.ok(skipEvent.reason.includes('ANTI_SHAKEOUT_HOLD'), 'S5 recent event must indicate ANTI_SHAKEOUT_HOLD');
  console.log('   ✅ S5 ignored target dump at 2s: ' + skipEvent.reason);

  // 3. Retail inflow pushes price to +26% ($0.0000126) at second +20s
  engine.updatePriceTick(mintA, 0.0000126);

  assert.equal(engine.scenarios.s5.openPositions.length, 0, 'S5 must auto-harvest and exit at TP +25%!');
  assert.equal(engine.scenarios.s5.closedTrades.length, 1, 'S5 closed trade must be recorded');
  const tradeA = engine.scenarios.s5.closedTrades[0];
  assert.ok(tradeA.exitReason.includes('AUTO_TAKE_PROFIT_25%'), 'Exit reason must be AUTO_TAKE_PROFIT_25%');
  assert.ok(tradeA.realizedPnlUsd > 0.15, 'Realized profit must be positive (> +15% net)');
  console.log(`   ✅ S5 harvested profit at TP +25%: Returned $${tradeA.totalReturnedUsd}, PnL: +$${tradeA.realizedPnlUsd} (${tradeA.roiPct}%)`);

  // --- Case B: Token doesn't reach +25% -> Time-Stop 35s Safely Exits ---
  console.log('\n--- Case B: Time-Stop 35s Force Exit before Rugpull ---');
  const mintB = 'MintB555555555555555555555555555555555555555';
  const tB0 = Math.floor(Date.now() / 1000) - 36; // 36 seconds ago

  const buySignalB = {
    action: 'buy',
    mint: mintB,
    symbol: 'SLOW',
    tokenName: 'Slow Coin',
    tokenAmount: 10000000,
    remainingHolding: 10000000,
    solAmount: 20,
    usdAmount: 1900,
    priceUsd: 0.000010,
    txHash: 'TxBuyB',
    timestamp: tB0,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(buySignalB, true);
  assert.equal(engine.scenarios.s5.openPositions.length, 1, 'S5 opened position on Mint B');

  // Time-stop check runs
  engine.checkTimeStopExits(28000);

  assert.equal(engine.scenarios.s5.openPositions.length, 0, 'S5 must force-exit at 35s time stop!');
  const tradeB = engine.scenarios.s5.closedTrades[0];
  assert.ok(tradeB.exitReason.includes('TIME_STOP'), 'Exit reason must indicate TIME_STOP_36S_WAVE_EXIT');
  console.log(`   ✅ S5 exited safely at 35s time-stop: ${tradeB.exitReason}`);

  // Cleanup
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('\n🎉 ALL SCENARIO 5 ENGINE LOGIC TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
