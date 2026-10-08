import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HolderProfiler, pairTradesFromActivities } from '../src/holder149-profiler.js';

test('pairTradesFromActivities pairs buys and sells correctly and computes PnL %', () => {
  const activities = [
    { event_type: 'buy', timestamp: 100, price_usd: 2.0, token: { address: 'Mint1', symbol: 'SOL1' } },
    { event_type: 'sell', timestamp: 200, price_usd: 3.0, token: { address: 'Mint1', symbol: 'SOL1' } },
    { event_type: 'buy', timestamp: 300, price_usd: 10.0, token: { address: 'Mint2', symbol: 'SOL2' } },
    { event_type: 'sell', timestamp: 400, price_usd: 8.0, token: { address: 'Mint2', symbol: 'SOL2' } },
  ];
  const trades = pairTradesFromActivities({ data: { activities } });
  assert.equal(trades.length, 2);

  const t1 = trades.find(t => t.mint === 'Mint1')!;
  assert.equal(t1.pnlPercent, 50); // (3 - 2) / 2 * 100
  assert.equal(t1.isWin, true);
  assert.equal(t1.holdSeconds, 100);

  const t2 = trades.find(t => t.mint === 'Mint2')!;
  assert.equal(t2.pnlPercent, -20); // (8 - 10) / 10 * 100
  assert.equal(t2.isWin, false);
});

test('HolderProfiler tracks win rate, tiering, and saves/loads snapshot', () => {
  const wallets = ['WalletA', 'WalletB'];
  const profiler = new HolderProfiler(wallets);

  const now = Math.floor(Date.now() / 1000);
  // WalletA: Active within last 15 min (900s), 2 wins -> Tier 1 Hot
  profiler.recordActivities('WalletA', {
    data: {
      activities: [
        { event_type: 'buy', timestamp: now - 900, price_usd: 1.0, token: { address: 'M1', symbol: 'M1' } },
        { event_type: 'sell', timestamp: now - 800, price_usd: 2.0, token: { address: 'M1', symbol: 'M1' } },
        { event_type: 'buy', timestamp: now - 600, price_usd: 5.0, token: { address: 'M2', symbol: 'M2' } },
        { event_type: 'sell', timestamp: now - 500, price_usd: 6.0, token: { address: 'M2', symbol: 'M2' } },
      ],
    },
  }, now);

  const sA = profiler.snapshot().find(s => s.wallet === 'WalletA')!;
  assert.equal(sA.tier, 'tier1');
  assert.equal(sA.totalTrades, 2);
  assert.equal(sA.wins, 2);
  assert.equal(sA.winRate, 100);
  assert.equal(sA.recommendation, 'SMART_MONEY');

  // WalletB: Active 2 days ago, 2 losses -> Tier 3 Cool
  profiler.recordActivities('WalletB', {
    data: {
      activities: [
        { event_type: 'buy', timestamp: now - 180000, price_usd: 10.0, token: { address: 'M3', symbol: 'M3' } },
        { event_type: 'sell', timestamp: now - 179000, price_usd: 5.0, token: { address: 'M3', symbol: 'M3' } },
        { event_type: 'buy', timestamp: now - 175000, price_usd: 10.0, token: { address: 'M4', symbol: 'M4' } },
        { event_type: 'sell', timestamp: now - 174000, price_usd: 7.0, token: { address: 'M4', symbol: 'M4' } },
      ],
    },
  }, now);

  const sB = profiler.snapshot().find(s => s.wallet === 'WalletB')!;
  assert.equal(sB.tier, 'tier3');
  assert.equal(sB.totalTrades, 2);
  assert.equal(sB.losses, 2);
  assert.equal(sB.winRate, 0);
  assert.equal(sB.recommendation, 'AVOID');

  // Persistence test
  const dir = mkdtempSync(join(tmpdir(), 'holder-profiler-'));
  const file = join(dir, 'stats.json');
  profiler.save(file);

  const reloaded = new HolderProfiler(wallets);
  reloaded.load(file);
  const reloadedA = reloaded.snapshot().find(s => s.wallet === 'WalletA')!;
  assert.equal(reloadedA.winRate, 100);
  assert.equal(reloadedA.tier, 'tier1');
  rmSync(dir, { recursive: true, force: true });
});
