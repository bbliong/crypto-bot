import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Scenario 8 End-to-End Simulation...');

  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-s8-e2e-'));
  saveFollowerLiveConfig(testDir, {
    stakeUsdS8: 2.0,
    enabled: true,
    autobuyScenario: 'S8'
  });

  const engine = new MultiScenarioDryRunEngine(testDir);
  assert(engine.scenarios.s8, 'S8 must be initialized');
  assert.equal(engine.scenarios.s8.availableCash, 20.0);

  const tradeEvents = [];
  engine.onTradeAction = (action, scId, sig, det) => {
    tradeEvents.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason, priceUsd: det.priceUsd });
  };

  // 1. Dev deploy pool genesis OMBRO #2
  console.log('\n1. Dev Deploys OMBRO #2 (InitializeCustomizablePool)...');
  const now = Date.now();
  const genesisEvt = {
    oldMint: 'MintOmbro111111111111111111111111111111111',
    newMint: 'MintOmbro222222222222222222222222222222222',
    symbol: 'OMBRO',
    devWallet: 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa',
    signature: 'TxGenesisOmbro2',
    timestamp: now
  };

  engine.handleEarlyRedeployBuy(genesisEvt, 2.0);
  assert.equal(engine.scenarios.s8.openPositions.length, 1, 'S8 must hold OMBRO #2');
  const pos = engine.scenarios.s8.openPositions[0];
  assert.equal(pos.symbol, 'OMBRO');
  assert.equal(pos.costBasisUsd, 2.0);
  assert.equal(pos.boughtAtGenesis, true);
  console.log('   ✅ S8 bought at Genesis floor ($2.00 stake)');

  // 2. Target arrives 30s later with 18.5 SOL buy, pumping curve to $0.0000140 (+45.8%)
  console.log('\n2. Target arrives at +30s with 18.5 SOL buy (Pumping price)...');
  tradeEvents.length = 0;
  const targetBuySignal = {
    action: 'buy',
    mint: genesisEvt.newMint,
    symbol: 'OMBRO',
    tokenName: 'OMBRO',
    tokenAmount: 130000000,
    remainingHolding: 130000000,
    solAmount: 18.5,
    usdAmount: 1700,
    priceUsd: 0.0000140, // Pumped price
    txHash: 'TxTargetBuy18Sol',
    timestamp: Math.floor(now / 1000) + 30,
    isOpenOrClose: true,
    isFirstBuy: true
  };

  engine.handleTargetBuy(targetBuySignal, true);
  assert.equal(engine.scenarios.s8.openPositions.length, 0, 'S8 position must be closed immediately on target buy');
  assert.equal(engine.scenarios.s8.closedTrades.length, 1, 'Trade must be closed');
  const closed = engine.scenarios.s8.closedTrades[0];
  assert(closed.exitReason.includes('TARGET_BUY_INFLOW_EXIT'), 'Exit reason must mention target buy inflow');
  assert(closed.isWin, 'Must be a WIN');
  assert(closed.realizedPnlUsd > 0.8, 'PnL must be significant (+40% on $2.00)');
  console.log('   ✅ S8 dumped into target buy! Return: $' + closed.totalReturnedUsd + ', PnL: +$' + closed.realizedPnlUsd + ' (' + closed.roiPct + '%)');

  // 3. State persistence test
  const rawSaved = readFileSync(join(testDir, 'dryrun-3scenarios-live.json'), 'utf8');
  const parsed = JSON.parse(rawSaved);
  assert(parsed.s8, 'S8 must be persisted to json file');
  assert.equal(parsed.s8.closedTrades.length, 1);
  assert.equal(parsed.s8.wins, 1);
  console.log('   ✅ S8 state persistence verified');

  console.log('\n🎉 ALL SCENARIO 8 E2E SIMULATION TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ E2E Test failed:', err);
  process.exit(1);
});
