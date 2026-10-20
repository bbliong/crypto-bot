import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SyndicateWalletSelector } from '../src/syndicate-wallet-selector.js';
import { SyndicateSqliteStorage, type TransferRecord } from '../src/storage/syndicate-sqlite.js';

test('SyndicateWalletSelector: selects top 5 newest tokens with >10 wallets, 1 wallet per token', () => {
  const scratchDir = '/home/bbliong/.hermes/cache/scratch';
  const testDb = path.join(scratchDir, `test-selector-${Date.now()}.sqlite`);
  const testConfigJson = path.join(scratchDir, `test-monitored-wallets-${Date.now()}.json`);
  const storage = new SyndicateSqliteStorage(testDb);

  const cycleId = '2026-10-20T00-00-00';
  const transfers: TransferRecord[] = [];

  // Generate 7 tokens with different wallet counts and timestamps
  // Token 1: 15 wallets, newest (ts: 1000) -> Should be selected (#1)
  // Token 2: 12 wallets, ts: 900 -> Should be selected (#2)
  // Token 3: 5 wallets, ts: 850 -> Should be SKIPPED (<= 10 wallets)
  // Token 4: 20 wallets, ts: 800 -> Should be selected (#3)
  // Token 5: 30 wallets, ts: 700 -> Should be selected (#4)
  // Token 6: 11 wallets, ts: 600 -> Should be selected (#5)
  // Token 7: 50 wallets, ts: 500 -> Should be excluded from top 5 (6th rank)

  const tokenConfigs = [
    { mint: 'MINT_1', name: 'Token 1', count: 15, baseTs: 1000 },
    { mint: 'MINT_2', name: 'Token 2', count: 12, baseTs: 900 },
    { mint: 'MINT_3', name: 'Token 3', count: 5, baseTs: 850 }, // <= 10 wallets
    { mint: 'MINT_4', name: 'Token 4', count: 20, baseTs: 800 },
    { mint: 'MINT_5', name: 'Token 5', count: 30, baseTs: 700 },
    { mint: 'MINT_6', name: 'Token 6', count: 11, baseTs: 600 },
    { mint: 'MINT_7', name: 'Token 7', count: 50, baseTs: 500 }, // 6th newest
  ];

  for (const cfg of tokenConfigs) {
    for (let i = 1; i <= cfg.count; i++) {
      transfers.push({
        txSignature: `tx_${cfg.mint}_${i}`,
        mint: cfg.mint,
        tokenName: cfg.name,
        symbol: cfg.name,
        fromAddress: `DEP_${cfg.mint}`,
        toAddress: `WALLET_${cfg.mint}_${i}`,
        amount: '100',
        blockTime: cfg.baseTs + i,
        timeWib: `2026-10-20 ${cfg.baseTs} WIB`
      });
    }
  }

  storage.insertTransfers(transfers, cycleId);
  storage.recomputeCandidates(cycleId);

  const selector = new SyndicateWalletSelector({
    storage,
    outputPath: testConfigJson,
    minWallets: 10,
    topLimit: 5
  });

  const targets = selector.selectAndExport();

  // Exactly 5 tokens selected
  assert.strictEqual(targets.length, 5);

  // Verifying token order: MINT_1, MINT_2, MINT_4, MINT_5, MINT_6
  assert.strictEqual(targets[0].tokenMint, 'MINT_1');
  assert.strictEqual(targets[0].monitoredWallet, 'WALLET_MINT_1_15');
  assert.strictEqual(targets[1].tokenMint, 'MINT_2');
  assert.strictEqual(targets[2].tokenMint, 'MINT_4');
  assert.strictEqual(targets[3].tokenMint, 'MINT_5');
  assert.strictEqual(targets[4].tokenMint, 'MINT_6');

  // Verify MINT_3 (<=10) and MINT_7 (rank 6) are not in targets
  assert.ok(!targets.some(t => t.tokenMint === 'MINT_3'));
  assert.ok(!targets.some(t => t.tokenMint === 'MINT_7'));

  // Verify JSON config export
  assert.ok(fs.existsSync(testConfigJson));
  const exported = JSON.parse(fs.readFileSync(testConfigJson, 'utf8'));
  assert.strictEqual(exported.watchingTargetsCount, 5);
  assert.strictEqual(exported.targets.length, 5);

  // Verify SQLite watched flag updated
  const watchedInDb = storage.getWatchedCandidates();
  assert.strictEqual(watchedInDb.length, 5);

  storage.close();
  try {
    fs.unlinkSync(testDb);
    fs.unlinkSync(testConfigJson);
  } catch {}
});
