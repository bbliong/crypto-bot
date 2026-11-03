import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Scenario 8 Engine Logic...');
  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-s8-'));
  saveFollowerLiveConfig(testDir, {
    stakeUsdS8: 1.0,
    enabled: true,
    autobuyScenario: 'S8'
  });

  const engine = new MultiScenarioDryRunEngine(testDir);
  assert(engine.scenarios.s8, 'Scenario 8 must exist in engine');
  assert.equal(engine.scenarios.s8.availableCash, 20.0);

  const actions = [];
  engine.onTradeAction = (action, scId, sig, det) => {
    actions.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason });
  };

  // =========================================================================
  // Test Case A: Dev deploys -> S8 buys -> Target enters 25s later -> S8 dumps into target!
  // =========================================================================
  console.log('\n--- Case A: Normal Dump on Target Entry ---');
  const genesisEvtA = {
    oldMint: 'MintOld11111111111111111111111111111111111',
    newMint: 'MintNew22222222222222222222222222222222222',
    symbol: 'PANDO',
    devWallet: 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa',
    signature: 'TxGenesisA',
    timestamp: Date.now()
  };

  engine.handleEarlyRedeployBuy(genesisEvtA, 1.0);
  assert.equal(engine.scenarios.s8.openPositions.length, 1, 'S8 must hold newly deployed token');
  assert.equal(engine.scenarios.s8.openPositions[0].costBasisUsd, 1.0);
  assert.equal(engine.scenarios.s8.openPositions[0].boughtAtGenesis, true);
  console.log('   ✅ S8 bought at Dev Genesis floor ($1.00)');

  // Target arrives 25s later with 20 SOL buy, pumping price to $0.0000144 (+50%)
  const targetBuySignal = {
    action: 'buy',
    mint: genesisEvtA.newMint,
    symbol: 'PANDO',
    tokenName: 'Pando',
    tokenAmount: 140000000,
    remainingHolding: 140000000,
    solAmount: 20,
    usdAmount: 1840,
    priceUsd: 0.0000144, // +50% pumped by target
    txHash: 'TxTargetBuy20Sol',
    timestamp: Math.floor(Date.now() / 1000) + 25,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  actions.length = 0;
  engine.handleTargetBuy(targetBuySignal, true);
  assert.equal(engine.scenarios.s8.openPositions.length, 0, 'S8 must be 100% closed when target buys');
  assert.equal(engine.scenarios.s8.closedTrades.length, 1, 'Trade must be closed in S8');
  const tradeA = engine.scenarios.s8.closedTrades[0];
  assert(tradeA.exitReason.includes('TARGET_BUY_INFLOW_EXIT'), 'Exit reason must mention target buy inflow exit');
  assert(tradeA.isWin, 'Trade must be a WIN');
  assert(tradeA.roiPct >= 20.0, 'ROI must be positive profit from target pump');
  console.log('   ✅ S8 successfully dumped into target buy inflow! Return: $' + tradeA.totalReturnedUsd + ', PnL: $' + tradeA.realizedPnlUsd + ' (' + tradeA.roiPct + '%)');

  // =========================================================================
  // Test Case B: Target No-Show (Target did not enter within 45s) -> Safety Exit!
  // =========================================================================
  console.log('\n--- Case B: Target No-Show Safety Timeout (45s) ---');
  const nowB = Date.now();
  const genesisEvtB = {
    oldMint: 'MintOldB1111111111111111111111111111111111',
    newMint: 'MintNewB2222222222222222222222222222222222',
    symbol: 'NOSHOW',
    devWallet: 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa',
    signature: 'TxGenesisB',
    timestamp: nowB
  };

  engine.handleEarlyRedeployBuy(genesisEvtB, 1.0);
  assert.equal(engine.scenarios.s8.openPositions.length, 1);

  // Simulasikan waktu bergeser 46 detik tanpa target buy
  const originalNow = Date.now;
  Date.now = () => nowB + 46000;
  try {
    engine.checkTimeStopExits(28000);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(engine.scenarios.s8.openPositions.length, 0, 'S8 must be closed by 45s safety timeout');
  assert.equal(engine.scenarios.s8.closedTrades.length, 2);
  const tradeB = engine.scenarios.s8.closedTrades[0];
  assert(tradeB.exitReason.includes('S8_NO_TARGET_ENTRY_TIMEOUT'), 'Must exit due to target no-show');
  console.log('   ✅ S8 safely exited on 45s timeout:', tradeB.exitReason);

  console.log('\n🎉 ALL SCENARIO 8 ENGINE LOGIC TESTS (CASES A & B) PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
