import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig } from '../src/follower-live-store.js';

async function run() {
  console.log('Testing Hard TP +200% Ceiling Gate in MultiScenarioDryRunEngine...');

  const testDir = mkdtempSync(join(tmpdir(), 'crypto-test-hardtp-'));
  saveFollowerLiveConfig(testDir, {
    stakeUsdS4: 1.0,
    stakeUsdS6Pool1: 1.0,
    stakeUsdS6Pool2: 2.0,
    enabled: true,
    autobuyScenario: 'S6'
  });

  const engine = new MultiScenarioDryRunEngine(testDir);
  const actions = [];
  engine.onTradeAction = (action, scId, sig, det) => {
    actions.push({ action, scId, mint: sig.mint, symbol: sig.symbol, reason: det.reason, stakeUsd: det.stakeUsd });
  };

  const entryPrice = 0.000010;
  const mockMint = 'HardTpTestMint111111111111111111111111111111';

  // 1. Initial Buy
  console.log('1. Target buy initial entry at $0.000010...');
  engine.handleTargetBuy({
    action: 'buy',
    mint: mockMint,
    symbol: 'ROCKET',
    tokenName: 'Rocket Coin',
    tokenAmount: 10000000,
    remainingHolding: 10000000,
    solAmount: 10,
    usdAmount: 1000,
    priceUsd: entryPrice,
    txHash: 'TxBuyInitial',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  assert.strictEqual(engine.scenarios.s6.openPositions.length, 1, 'S6 should have 1 open position');
  const pos = engine.scenarios.s6.openPositions[0];
  assert.strictEqual(pos.avgEntryPriceUsd, entryPrice, 'Entry price must match');
  console.log('   ✅ Position opened successfully. Cost basis: $' + pos.costBasisUsd + ', Tokens: ' + pos.tokens);

  // 2. Normal price tick (+30%, price = 0.000013)
  console.log('\n2. Price updates to $0.000013 (+30%)...');
  engine.updatePriceTick(mockMint, 0.000013);
  assert.strictEqual(engine.scenarios.s6.openPositions.length, 1, 'Position should remain open at +30%');
  console.log('   ✅ Position still open. Unrealized PnL: $' + engine.scenarios.s6.openPositions[0].unrealizedPnlUsd);

  // 3. Price jumps to +210% (price = 0.000031 >= 3.0x entry)
  console.log('\n3. Price explodes to $0.000031 (+210% >= +200%)...');
  const actionsBefore = actions.length;
  engine.updatePriceTick(mockMint, 0.000031);

  // Verify position was automatically closed!
  assert.strictEqual(engine.scenarios.s6.openPositions.length, 0, 'S6 open positions must be 0 after Hard TP trigger');
  assert.strictEqual(engine.scenarios.s4.openPositions.length, 0, 'S4 open positions must be 0 after Hard TP trigger');
  console.log('   ✅ Open positions successfully closed 100%!');

  // Check closed trade record in S6
  const closedTrade = engine.scenarios.s6.closedTrades.find(t => t.mint === mockMint);
  assert(closedTrade, 'Closed trade must exist for mockMint');
  assert(closedTrade.exitReason.includes('HARD_TP_200%_CEILING'), 'Exit reason must be HARD_TP_200%_CEILING');
  assert(closedTrade.roiPct >= 200, 'ROI must be >= 200%');
  assert.strictEqual(closedTrade.isWin, true, 'Trade must be counted as a WIN');
  console.log('   ✅ Closed trade verified:', closedTrade.exitReason, '| ROI:', closedTrade.roiPct + '% | Realized PnL: $' + closedTrade.realizedPnlUsd);

  // Check onTradeAction was called with SELL
  const sellActions = actions.slice(actionsBefore).filter(a => a.action === 'SELL' && a.mint === mockMint);
  assert.strictEqual(sellActions.length, 2, 'Should trigger SELL action for both S4 and S6');
  assert(sellActions[0].reason.includes('HARD_TP_200%_CEILING'), 'Action reason must be HARD_TP_200%_CEILING');
  console.log('   ✅ onTradeAction SELL triggered with reason:', sellActions[0].reason);

  console.log('\n🎉 ALL HARD TP +200% TESTS PASSED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
