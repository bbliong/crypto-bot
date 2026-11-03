import assert from 'node:assert/strict';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { saveFollowerLiveConfig, readFollowerLiveConfig } from '../src/follower-live-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

console.log('Testing dynamic buy stake execution in MultiScenarioDryRunEngine...');

// Setup temporary test data dir
const testDataDir = mkdtempSync(join(tmpdir(), 'crypto-test-engine-'));

// Save custom stakes
saveFollowerLiveConfig(testDataDir, {
  stakeUsdS4: 9.5,
  stakeUsdS6Pool1: 4.5,
  stakeUsdS6Pool2: 11.5,
  enabled: true,
  autobuyScenario: 'BOTH'
});

const engine = new MultiScenarioDryRunEngine(testDataDir);

const interceptedActions = [];
engine.onTradeAction = (action, scenarioId, signal, details) => {
  interceptedActions.push({ action, scenarioId, stakeUsd: details.stakeUsd, tokens: details.tokens });
};

// 1. First Buy for Token A (Generation 1: Pool 1)
const mockSignalA = {
  action: 'buy',
  mint: 'TokenMintA111111111111111111111111111111111',
  symbol: 'TESTCOIN',
  tokenName: 'Test Coin',
  tokenAmount: 1000000,
  remainingHolding: 1000000,
  solAmount: 10,
  usdAmount: 1000,
  priceUsd: 0.000010,
  txHash: 'MockTxHashA',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true
};

engine.handleTargetBuy(mockSignalA, true);

// Check S4 received stakeUsd = 9.5
const s4Action = interceptedActions.find(a => a.scenarioId.includes('4'));
assert(s4Action, 'S4 action must be triggered');
assert.equal(s4Action.stakeUsd, 9.5, 'S4 stakeUsd must be 9.5');

// Check S6 received Pool 1 stakeUsd = 4.5
const s6ActionP1 = interceptedActions.find(a => a.scenarioId.includes('6'));
assert(s6ActionP1, 'S6 action must be triggered');
assert.equal(s6ActionP1.stakeUsd, 4.5, 'S6 Pool 1 stakeUsd must be 4.5');

// 2. Second Buy for Same Name with Different Mint within 5 minutes (Generation 2: Pool 2 Re-deploy)
const mockSignalB = {
  action: 'buy',
  mint: 'TokenMintB222222222222222222222222222222222',
  symbol: 'TESTCOIN',
  tokenName: 'Test Coin',
  tokenAmount: 1000000,
  remainingHolding: 1000000,
  solAmount: 10,
  usdAmount: 1000,
  priceUsd: 0.000010,
  txHash: 'MockTxHashB',
  timestamp: Math.floor(Date.now() / 1000) + 120, // 2 minutes later
  isOpenOrClose: true,
  isFirstBuy: true
};

interceptedActions.length = 0;
engine.handleTargetBuy(mockSignalB, true);

const s6ActionP2 = interceptedActions.find(a => a.scenarioId.includes('6'));
assert(s6ActionP2, 'S6 action must be triggered on Pool 2');
assert.equal(s6ActionP2.stakeUsd, 11.5, 'S6 Pool 2 stakeUsd must be 11.5');

console.log('✅ Dynamic buy stakes verified: S4 = $9.50, S6 Pool 1 = $4.50, S6 Pool 2 = $11.50!');
