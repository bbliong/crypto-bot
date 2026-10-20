import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HeliusScheduledCollector } from '../src/helius-scheduled-collector.js';
import { SyndicateSqliteStorage } from '../src/storage/syndicate-sqlite.js';

test('HeliusScheduledCollector: bounded run persists transfers and exports active-candidates.json', async () => {
  const scratchDir = '/home/bbliong/.hermes/cache/scratch';
  const testDb = path.join(scratchDir, `test-helius-${Date.now()}.sqlite`);
  const testOutputJson = path.join(scratchDir, `test-active-candidates-${Date.now()}.json`);
  const storage = new SyndicateSqliteStorage(testDb);

  const collector = new HeliusScheduledCollector({
    storage,
    outputCandidatesPath: testOutputJson,
    durationSeconds: 1, // fast bounded run for test
    mockTransfers: [
      {
        txSignature: 'tx_helius_1',
        mint: '6mdVwPt9zEqr3a378UQegzEFxU7JgKVqbXvGGcDpump',
        tokenName: 'FOMO',
        symbol: 'FOMO',
        fromAddress: 'DEPLOYER_FOMO',
        toAddress: '99ChGbcCQheYwUTva8SgZ2LvMijAceyN143Pp6PUPnYu',
        amount: '360500',
        blockTime: 1729351568,
        timeWib: '2026-10-19 22:26:08 WIB',
        syndicateId: 'syn-4',
        syndicateName: 'FOMO Syndicate'
      },
      {
        txSignature: 'tx_helius_2',
        mint: 'HmioaUhV12ZiyQT18BcUp6G3L2ZaxBDH9jyYiGipump',
        tokenName: 'NVIDIA SSI',
        symbol: 'NVIDIA',
        fromAddress: '8v7sPtDvabYEP2AyMa8e2fpQzKfSpsTsSCrrmtpPSsSf',
        toAddress: '3p35xvDnHX4geRMuy1pSFGSZquxKaUFYkY4qSkZBfSZB',
        amount: '360500',
        blockTime: 1729351068,
        timeWib: '2026-10-19 22:17:48 WIB',
        syndicateId: 'syn-4',
        syndicateName: 'FOMO Syndicate'
      }
    ]
  });

  const result = await collector.runWindow();
  assert.strictEqual(result.status, 'COMPLETED');
  assert.strictEqual(result.transfersSaved, 2);
  assert.strictEqual(result.totalCandidates, 2);

  assert.ok(fs.existsSync(testOutputJson));
  const exported = JSON.parse(fs.readFileSync(testOutputJson, 'utf8'));
  assert.strictEqual(exported.totalCandidates, 2);

  storage.close();
  try {
    fs.unlinkSync(testDb);
    fs.unlinkSync(testOutputJson);
  } catch {}
});
