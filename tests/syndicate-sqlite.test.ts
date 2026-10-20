import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SyndicateSqliteStorage, type TransferRecord } from '../src/storage/syndicate-sqlite.js';

test('SyndicateSqliteStorage: inserts transfers, computes ranked candidates, exports JSON, and marks watched', () => {
  const testDbPath = path.join('/home/bbliong/.hermes/cache/scratch', `test-syndicate-${Date.now()}.sqlite`);
  const storage = new SyndicateSqliteStorage(testDbPath);

  const cycleId = '2026-10-20T00-00-00';
  const sampleTransfers: TransferRecord[] = [
    {
      txSignature: 'tx1',
      mint: 'MINT_FOMO',
      tokenName: 'FOMO',
      symbol: 'FOMO',
      fromAddress: 'DEPLOYER_1',
      toAddress: 'WALLET_FOMO_1',
      amount: '1000',
      blockTime: 1729350000,
      timeWib: '2026-10-19 22:26:00 WIB',
      syndicateId: 'syn1',
      syndicateName: 'FOMO Syndicate',
    },
    {
      txSignature: 'tx2',
      mint: 'MINT_FOMO',
      tokenName: 'FOMO',
      symbol: 'FOMO',
      fromAddress: 'DEPLOYER_1',
      toAddress: 'WALLET_FOMO_2',
      amount: '2000',
      blockTime: 1729350100,
      timeWib: '2026-10-19 22:27:00 WIB',
      syndicateId: 'syn1',
      syndicateName: 'FOMO Syndicate',
    },
    {
      txSignature: 'tx3',
      mint: 'MINT_NVIDIA',
      tokenName: 'NVIDIA SSI',
      symbol: 'NVIDIA',
      fromAddress: 'DEPLOYER_2',
      toAddress: 'WALLET_NV_1',
      amount: '500',
      blockTime: 1729350200,
      timeWib: '2026-10-19 22:28:00 WIB',
      syndicateId: 'syn2',
      syndicateName: 'NVIDIA Syndicate',
    }
  ];

  // 1. Insert transfers
  storage.insertTransfers(sampleTransfers, cycleId);

  // 2. Recompute candidates
  const candidates = storage.recomputeCandidates(cycleId);
  assert.strictEqual(candidates.length, 2);

  // NVIDIA is newer (timestamp 1729350200 vs 1729350100)
  assert.strictEqual(candidates[0].mint, 'MINT_NVIDIA');
  assert.strictEqual(candidates[0].walletsCount, 1);
  assert.strictEqual(candidates[0].sampleWallet, 'WALLET_NV_1');

  assert.strictEqual(candidates[1].mint, 'MINT_FOMO');
  assert.strictEqual(candidates[1].walletsCount, 2);

  // 3. Mark watched
  storage.markWatchedTokens(['MINT_FOMO']);
  const watched = storage.getWatchedCandidates();
  assert.strictEqual(watched.length, 1);
  assert.strictEqual(watched[0].mint, 'MINT_FOMO');
  assert.strictEqual(watched[0].isWatched, 1);

  // 4. Export JSON
  const jsonPath = path.join('/home/bbliong/.hermes/cache/scratch', `export-test-${Date.now()}.json`);
  storage.exportAllCandidatesJson(jsonPath);
  assert.ok(fs.existsSync(jsonPath));
  const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  assert.strictEqual(parsed.cycleId, cycleId);
  assert.strictEqual(parsed.totalCandidates, 2);

  storage.close();
  try {
    fs.unlinkSync(testDbPath);
    fs.unlinkSync(jsonPath);
  } catch {}
});
