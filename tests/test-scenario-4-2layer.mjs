import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Scenario 4 Engine Logic (2-Lapis Shakeout Trap: Hold 8s & Dump on Buyback)...');

  const testDataDir = path.resolve(process.cwd(), 'data/test-s4-2layer');
  fs.mkdirSync(testDataDir, { recursive: true });
  const testFile = path.join(testDataDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDataDir);

  assert(engine.scenarios.s4, 'Scenario 4 must be defined in engine');

  // --- Case A: Target Buy -> Target Dumps at +2s (Shakeout) -> S4 HOLDS -> Target Buyback at +6s -> S4 Dumps on Target Buyback ---
  console.log('\n--- Case A: Shakeout at 2s -> Hold -> Target Buyback at +6s -> S4 Dumps 100% ---');
  const mintA = 'MintA444444444444444444444444444444444444444';
  const t0 = Math.floor(Date.now() / 1000);

  // 1. Target First Buy
  const buySignalA = {
    action: 'buy',
    mint: mintA,
    symbol: 'TRAP',
    tokenName: 'Trap Coin',
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
  assert.equal(engine.scenarios.s4.openPositions.length, 1, 'S4 must open position on Mint A');
  console.log('   ✅ S4 opened position at Ground Zero ($5.00 stake)');

  // 2. Target dumps 60% at second +2s (Shakeout)
  const sellSignalA1 = {
    action: 'sell',
    mint: mintA,
    symbol: 'TRAP',
    tokenName: 'Trap Coin',
    tokenAmount: 6000000,
    remainingHolding: 4000000,
    solAmount: 12,
    usdAmount: 1200,
    priceUsd: 0.0000098,
    txHash: 'TxSellA1',
    timestamp: t0 + 2,
    isOpenOrClose: false,
    isFirstBuy: false
  };

  engine.handleTargetSell(sellSignalA1);

  // In old S4, it would exit and take a loss. With 2-layer flow, S4 MUST HOLD!
  assert.equal(engine.scenarios.s4.openPositions.length, 1, 'S4 must HOLD position during shakeout in <= 3s!');
  const posA = engine.scenarios.s4.openPositions[0];
  assert.ok(posA.waitingBuybackSince, 'S4 position must record waitingBuybackSince');
  console.log('   ✅ S4 held position in waitingBuybackSince mode');

  // 3. Target Buyback at second +6s (4s after sell, within 8s window) with higher price $0.000012
  const buybackSignalA = {
    action: 'buy',
    mint: mintA,
    symbol: 'TRAP',
    tokenName: 'Trap Coin',
    tokenAmount: 8000000,
    remainingHolding: 12000000,
    solAmount: 18,
    usdAmount: 1700,
    priceUsd: 0.000012, // +20% gain!
    txHash: 'TxBuybackA',
    timestamp: t0 + 6,
    isOpenOrClose: true,
    isFirstBuy: false
  };

  engine.handleTargetBuy(buybackSignalA, false);

  // S4 MUST HAVE EXITED IMMEDIATELY ON TARGET BUYBACK!
  assert.equal(engine.scenarios.s4.openPositions.length, 0, 'S4 must dump 100% on target buyback!');
  assert.equal(engine.scenarios.s4.closedTrades.length, 1, 'S4 must record closed trade');
  const tradeA = engine.scenarios.s4.closedTrades[0];
  assert.ok(tradeA.exitReason.includes('DUMP_ON_BUYBACK'), 'Exit reason must indicate DUMP_ON_BUYBACK: ' + tradeA.exitReason);
  assert.ok(tradeA.isWin, 'Trade A must be a win');
  console.log(`   ✅ S4 harvested profit on target buyback! PnL: +$${tradeA.realizedPnlUsd} (${tradeA.roiPct}%) | Reason: ${tradeA.exitReason}`);

  // --- Case B: Shakeout at 2s -> Target DOES NOT Buyback in 8s -> Safety Timeout Exit ---
  console.log('\n--- Case B: Shakeout at 2s -> Target Does NOT Buyback in 8s -> Safety Timeout Exit ---');
  const mintB = 'MintB444444444444444444444444444444444444444';
  const tB0 = Math.floor(Date.now() / 1000) - 15; // 15 seconds ago

  const buySignalB = {
    action: 'buy',
    mint: mintB,
    symbol: 'NOSHOW',
    tokenName: 'No Show Coin',
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
  assert.equal(engine.scenarios.s4.openPositions.length, 1, 'S4 opened position on NOSHOW');

  // Target dumps at +2s
  const sellSignalB = {
    action: 'sell',
    mint: mintB,
    symbol: 'NOSHOW',
    tokenName: 'No Show Coin',
    tokenAmount: 5000000,
    remainingHolding: 5000000,
    solAmount: 10,
    usdAmount: 950,
    priceUsd: 0.0000095,
    txHash: 'TxSellB',
    timestamp: tB0 + 2,
    isOpenOrClose: false,
    isFirstBuy: false
  };

  engine.handleTargetSell(sellSignalB);
  assert.equal(engine.scenarios.s4.openPositions.length, 1, 'S4 holding NOSHOW');
  // Backdate waitingBuybackSince to 9 seconds ago
  engine.scenarios.s4.openPositions[0].waitingBuybackSince = Date.now() - 9000;

  // Run timeout checks
  engine.checkTimeStopExits(28000);

  assert.equal(engine.scenarios.s4.openPositions.length, 0, 'S4 must safety exit NOSHOW after 8s timeout!');
  const tradeB = engine.scenarios.s4.closedTrades[0];
  assert.ok(tradeB.exitReason.includes('S4_BUYBACK_TIMEOUT') || tradeB.exitReason.includes('8S'), 'Exit reason must indicate 8s timeout: ' + tradeB.exitReason);
  console.log(`   ✅ S4 safely exited on 8s timeout: ${tradeB.exitReason}`);

  // Cleanup
  fs.rmSync(testDataDir, { recursive: true, force: true });
  console.log('\n🎉 ALL SCENARIO 4 2-LAYER LOGIC TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
