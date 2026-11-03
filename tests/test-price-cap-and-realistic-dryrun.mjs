import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Ground-Zero Price Cap & Realistic Swap Sync...');

  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-price-cap-'));
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
    actions.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason });
  };

  // 1. Test Ground-Zero Price Cap
  console.log('1. Testing Ground-Zero Price Cap ($0.000020 limit)...');
  
  // A. Pumped Token (price $0.000046 > $0.000020)
  const pumpedSignal = {
    action: 'buy',
    mint: 'PumpedMint11111111111111111111111111111111111',
    symbol: 'BWAH_PUMP',
    tokenName: 'Bwah Pumped',
    tokenAmount: 2000000,
    remainingHolding: 2000000,
    solAmount: 15,
    usdAmount: 1380,
    priceUsd: 0.0000464, // > $0.000020
    txHash: 'TxPumped',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(pumpedSignal, true);
  assert.equal(engine.scenarios.s4.openPositions.length, 0, 'S4 must NOT buy pumped token');
  assert.equal(engine.scenarios.s6.openPositions.length, 0, 'S6 must NOT buy pumped token');
  
  const skipEvent = engine.scenarios.s6.recentEvents.find(e => e.mint === pumpedSignal.mint);
  assert(skipEvent, 'Skip event must be recorded');
  assert(skipEvent.reason.includes('REJECT_NON_GROUND_ZERO_PRICE_CAP'), 'Reason must indicate price cap rejection');
  console.log('   ✅ Pumped token ($0.0000464) successfully rejected by Price Cap!');

  // B. Ground-Zero Token (price $0.0000096 <= $0.000020)
  const gzSignal = {
    action: 'buy',
    mint: 'GroundZeroMint1111111111111111111111111111111',
    symbol: 'FLOOR',
    tokenName: 'Floor Token',
    tokenAmount: 190475279,
    remainingHolding: 190475279,
    solAmount: 20,
    usdAmount: 1840,
    priceUsd: 0.00000965, // <= $0.000020
    txHash: 'TxFloor',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(gzSignal, true);
  assert.equal(engine.scenarios.s4.openPositions.length, 1, 'S4 must accept ground zero token');
  assert.equal(engine.scenarios.s6.openPositions.length, 1, 'S6 must accept ground zero token');
  console.log('   ✅ Ground-Zero token ($0.00000965) successfully accepted into open positions!');

  // 2. Test Realistic Sync Real Buy Execution (Swap Route #2 Quote)
  console.log('\n2. Testing syncRealBuyExecution (Double-Swap Route #2 Sync)...');
  const initialPos = engine.scenarios.s6.openPositions[0];
  console.log('   Initial pos entry price (target): $' + initialPos.avgEntryPriceUsd);

  // In realistic double-swap, route 2 quote arrives with realistic AMM entry price: $0.00001200
  const realSwapBuyPrice = 0.00001200; // 24% slippage impact
  const actualTokensFromSwap2 = 83333.33; // 1.0 USD / $0.00001200
  engine.syncRealBuyExecution('SCENARIO_6_REDEPLOY_SNIPER', gzSignal.mint, realSwapBuyPrice, actualTokensFromSwap2, 1.0);

  const syncedPos = engine.scenarios.s6.openPositions[0];
  assert.equal(syncedPos.avgEntryPriceUsd, realSwapBuyPrice, 'Entry price must be synced to real swap price');
  assert.equal(syncedPos.tokens, actualTokensFromSwap2, 'Tokens must be synced to real swap tokens');
  console.log('   ✅ Open position successfully synced to real swap price: $' + syncedPos.avgEntryPriceUsd + ' (' + syncedPos.tokens + ' tokens)');

  // 3. Test Realistic Sync Real Sell Execution
  console.log('\n3. Testing syncRealSellExecution (Real AMM Proceeds Sync)...');
  
  // Target sells with full exit (isOpenOrClose: true)
  engine.handleTargetSell({
    action: 'sell',
    mint: gzSignal.mint,
    symbol: 'FLOOR',
    tokenName: 'Floor Token',
    tokenAmount: 190475279,
    remainingHolding: 0,
    solAmount: 22.0,
    usdAmount: 2024,
    priceUsd: 0.00001087, // Target price says +12.6%
    txHash: 'TxSell',
    timestamp: Math.floor(Date.now() / 1000) + 30,
    isOpenOrClose: true, // Full exit
    isFirstBuy: false
  });

  // Now the AMM sell quote is processed with realistic proceeds
  // Real swap proceeds: $0.85 (meaning net loss due to slippage, despite target claiming +12.6%)
  const realReturnedUsd = 0.85;
  const realExitPriceUsd = 0.00001020;
  engine.syncRealSellExecution('SCENARIO_6_REDEPLOY_SNIPER', gzSignal.mint, realExitPriceUsd, realReturnedUsd, 'STAGE_2_RUNNER_FULL_EXIT');

  const closedTrade = engine.scenarios.s6.closedTrades.find(t => t.mint === gzSignal.mint);
  assert(closedTrade, 'Closed trade must exist');
  assert.equal(closedTrade.totalReturnedUsd, 0.85, 'Total returned must reflect real swap proceeds');
  assert.equal(closedTrade.realizedPnlUsd, -0.15, 'Realized PnL must be $0.85 - $1.00 = -$0.15');
  assert.equal(closedTrade.roiPct, -15.0, 'ROI must be -15%');
  assert.equal(closedTrade.isWin, false, 'Must be marked as loss based on real swap proceeds');
  console.log('   ✅ Closed trade successfully reflects honest AMM swap outcome: Returned $' + closedTrade.totalReturnedUsd + ', PnL $' + closedTrade.realizedPnlUsd + ' (' + closedTrade.roiPct + '%)');

  console.log('\n🎉 ALL PRICE CAP & REALISTIC DRY-RUN TESTS PASSED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
