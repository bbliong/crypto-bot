import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  filterGmgnCandidate,
  exportCuratedWallets,
  type RawGmgnWallet,
  type HeliusVerifiedWallet
} from '../src/smart-curator-pipeline.js';

test('filterGmgnCandidate: passes qualified human lowcap trader', () => {
  const now = 1_700_000_000;
  const raw: RawGmgnWallet = {
    wallet_address: 'HT5EVAzfn1CzBqbWtVKcC9CRdexcemactNQNt7tM7rSc',
    name: 'TopDegen',
    tags: ['launchpad_smart', 'padre', 'axiom'],
    sol_balance: '25.5',
    realized_profit_30d: '45000',
    realized_profit_7d: '8000',
    winrate_30d: 0.58,
    winrate_7d: 0.62,
    txs_30d: 450,
    last_active: now - 3600, // 1 hour ago
    avg_holding_period_30d: 1200
  };

  const res = filterGmgnCandidate(raw, now);
  assert.ok(res !== null);
  assert.strictEqual(res.address, raw.wallet_address);
  assert.strictEqual(res.pnl30d, 45000);
  assert.strictEqual(res.winrate30d, 58);
  assert.strictEqual(res.winrate7d, 62);
  assert.strictEqual(res.solBalance, 25.5);
  assert.strictEqual(res.gmgnLastActiveHoursAgo, 1.0);
});

test('filterGmgnCandidate: rejects toxic tags (wash_trader, sandwich_bot, mev_bot, scammer)', () => {
  const now = 1_700_000_000;
  const raw: RawGmgnWallet = {
    wallet_address: 'BadWallet11111111111111111111111111111111111',
    tags: ['launchpad_smart', 'wash_trader'],
    sol_balance: '100.0',
    realized_profit_30d: '999999',
    winrate_30d: 0.90,
    txs_30d: 500,
    last_active: now - 100
  };

  const res = filterGmgnCandidate(raw, now);
  assert.strictEqual(res, null, 'Should reject wash trader');
});

test('filterGmgnCandidate: rejects inactive wallet (> 48h ago)', () => {
  const now = 1_700_000_000;
  const raw: RawGmgnWallet = {
    wallet_address: 'OldWallet11111111111111111111111111111111111',
    tags: ['launchpad_smart'],
    sol_balance: '10.0',
    realized_profit_30d: '50000',
    winrate_30d: 0.60,
    txs_30d: 200,
    last_active: now - (50 * 3600) // 50 hours ago
  };

  const res = filterGmgnCandidate(raw, now);
  assert.strictEqual(res, null, 'Should reject stale wallet');
});

test('filterGmgnCandidate: rejects low winrate (< 45% both 30d and 7d)', () => {
  const now = 1_700_000_000;
  const raw: RawGmgnWallet = {
    wallet_address: 'LowWrWallet111111111111111111111111111111111',
    tags: ['launchpad_smart'],
    sol_balance: '10.0',
    realized_profit_30d: '50000',
    winrate_30d: 0.35,
    winrate_7d: 0.30,
    txs_30d: 200,
    last_active: now - 3600
  };

  const res = filterGmgnCandidate(raw, now);
  assert.strictEqual(res, null, 'Should reject low winrate');
});

test('filterGmgnCandidate: rejects high frequency bot (> 2500 txs in 30d)', () => {
  const now = 1_700_000_000;
  const raw: RawGmgnWallet = {
    wallet_address: 'BotWallet11111111111111111111111111111111111',
    tags: ['launchpad_smart'],
    sol_balance: '10.0',
    realized_profit_30d: '50000',
    winrate_30d: 0.70,
    txs_30d: 15000, // 15k trades
    last_active: now - 3600
  };

  const res = filterGmgnCandidate(raw, now);
  assert.strictEqual(res, null, 'Should reject HFT bot');
});

test('exportCuratedWallets: correctly outputs CSV and JSON', () => {
  const tmpDir = join(process.cwd(), 'data', 'test-curator-export');
  const sampleWallet: HeliusVerifiedWallet = {
    address: 'HT5EVAzfn1CzBqbWtVKcC9CRdexcemactNQNt7tM7rSc',
    name: 'AlphaDegen',
    tags: ['launchpad_smart', 'padre'],
    solBalance: 25.5,
    pnl30d: 45000,
    pnl7d: 8000,
    winrate30d: 58,
    winrate7d: 62,
    txs30d: 450,
    avgHoldingSeconds: 1200,
    gmgnLastActiveHoursAgo: 1.0,
    heliusActive: true,
    heliusLastTxSignature: '3myNbJcDKHkArWw7sample',
    heliusLastBlockTime: 1700000000,
    heliusLastTxHoursAgo: 0.5,
    hasPumpFunSwap: true,
    hasRaydiumSwap: true,
    recentTxTypes: ['SWAP'],
    recentSources: ['PUMP_FUN', 'RAYDIUM'],
    score: 87.5
  };

  const { jsonPath, csvPath } = exportCuratedWallets([sampleWallet], tmpDir);

  assert.ok(existsSync(jsonPath));
  assert.ok(existsSync(csvPath));

  const jsonContent = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(jsonContent.totalCurated, 1);
  assert.strictEqual(jsonContent.wallets[0].address, sampleWallet.address);

  const csvContent = readFileSync(csvPath, 'utf8');
  assert.ok(csvContent.includes('Rank,Score,Address,Name'));
  assert.ok(csvContent.includes('HT5EVAzfn1CzBqbWtVKcC9CRdexcemactNQNt7tM7rSc'));
  assert.ok(csvContent.includes('YES,YES')); // Pump.fun & Raydium

  // Cleanup test dir
  try {
    unlinkSync(jsonPath);
    unlinkSync(csvPath);
  } catch {}
});
