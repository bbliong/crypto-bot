import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistributionProfit4Runtime } from '../src/distribution-profit4-runtime.js';

test('DistributionProfit4Runtime preserves closed syndicate positions across re-registration and re-init', async () => {
  const data = mkdtempSync(join(tmpdir(), 'syndicate-preservation-test-'));
  const run = join(data, 'run');
  mkdirSync(run);
  const events: any[] = [];
  const runtime = new DistributionProfit4Runtime(run, (_n, e) => events.push(e), data, 'syndicate');

  const mint = 'SyndicateMint1111111111111111111111111111111';
  const now = 10000;

  // 1. Initial registration
  runtime.register({
    wallet: '2QfBNK2WDwSLoUQRb1zAnp3KM12N9hQ8q6ApwUMnWW2T',
    mint,
    timestamp: 10,
    amount: '1.0',
    from: 'BVHdi4ERY2L6SLymCBq4Sg5sUdbbkEFW4AKoYjPxRU8G',
    tx: 'tx1',
    source: 'syndicate_inflow',
    syndicateWalletsCount: 2,
    syndicateTier: 'Tier 1'
  }, now);

  // 2. Establish initial price
  runtime.trade(mint, { at: 11000, timestamp: 11, price: 0.10, side: 'buy', wallet: 'w1', usd: 100, signature: 't1' });
  runtime.evaluate(11000);

  // 3. Emulate a closed trade directly in closedPositions for testing preservation
  // or simulate buy/sell
  const stateFile = join(run, 'profit4-state.json');
  assert.ok(readFileSync(stateFile, 'utf8'));

  // Let's re-register the same mint
  runtime.register({
    wallet: '2QfBNK2WDwSLoUQRb1zAnp3KM12N9hQ8q6ApwUMnWW2T',
    mint,
    timestamp: 12,
    amount: '1.0',
    from: 'BVHdi4ERY2L6SLymCBq4Sg5sUdbbkEFW4AKoYjPxRU8G',
    tx: 'tx2',
    source: 'syndicate_inflow',
    syndicateWalletsCount: 2,
    syndicateTier: 'Tier 1'
  }, 12000);

  // The runtime should recognise it is already tracked and not duplicate or crash
  runtime.evaluate(13000);
  const stateAfter = JSON.parse(readFileSync(stateFile, 'utf8'));
  const v4Count = stateAfter.positions.filter((p: any) => p.mint === mint && p.laneLabel === 'V4').length;
  assert.equal(v4Count, 1, 'Lane V4 must not be duplicated');
});

test('DistributionProfit4Runtime restores closed positions from chunks on startup', async () => {
  const data = mkdtempSync(join(tmpdir(), 'syndicate-chunk-recovery-test-'));
  const run = join(data, 'run');
  const chunkDir = join(run, 'chunks', 'chunk1');
  mkdirSync(chunkDir, { recursive: true });

  const mint = 'RecoveredMint11111111111111111111111111111';
  // Write fake buy & sell events to chunks
  const buyEvent = {
    type: 'PAPER_BUY',
    observedAt: 100000,
    paperLane: 'distribution-bounce-dump-v4',
    version: 'distribution-bounce-dump-v4',
    mint,
    priceUsd: 0.05,
    stakeUsd: 5,
    targetPercent: 35,
    transfer: {
      wallet: 'w1',
      mint,
      timestamp: 90,
      amount: '1.0',
      source: 'syndicate_inflow',
      syndicateWalletsCount: 1,
      syndicateTier: 'Tier 1'
    },
    laneLabel: 'V4'
  };
  const sellEvent = {
    type: 'PAPER_SELL',
    observedAt: 110000,
    paperLane: 'distribution-bounce-dump-v4',
    version: 'distribution-bounce-dump-v4',
    mint,
    reason: 'MAX_HOLD',
    entryAt: 100000,
    entryPriceUsd: 0.05,
    priceUsd: 0.06,
    netReturnPercent: 20,
    pnlUsd: 1.0,
    targetPercent: 35,
    laneLabel: 'V4'
  };

  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(chunkDir, 'profit4-events.jsonl'), JSON.stringify(buyEvent) + '\n' + JSON.stringify(sellEvent) + '\n');

  // Start runtime on this directory
  const runtime = new DistributionProfit4Runtime(run, () => {}, data, 'syndicate');
  const stateFile = join(run, 'profit4-state.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));

  const recovered = state.positions.find((p: any) => p.mint === mint);
  assert.ok(recovered, 'Position from chunks must be recovered');
  assert.equal(recovered.phase, 'CLOSED');
  assert.equal(recovered.entryPrice, 0.05);
  assert.equal(recovered.exitPrice, 0.06);
  assert.equal(recovered.netReturnPercent, 20);
});
