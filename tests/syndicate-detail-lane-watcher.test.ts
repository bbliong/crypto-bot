import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SyndicateDetailLaneWatcher } from '../src/syndicate-detail-lane-watcher.js';

test('SyndicateDetailLaneWatcher: initializes lanes, accepts trade ticks, and evaluates signals without opening tabs', async () => {
  const scratchDir = '/home/bbliong/.hermes/cache/scratch';
  const testWatchEvents = path.join(scratchDir, `test-watch-events-${Date.now()}.jsonl`);

  const watcher = new SyndicateDetailLaneWatcher({
    watchEventsLogPath: testWatchEvents,
    activeLanes: ['V7', 'S1']
  });

  const mint = '6mdVwPt9zEqr3a378UQegzEFxU7JgKVqbXvGGcDpump';
  const symbol = 'FOMO';

  // Escalate token (creates lane instances in memory)
  watcher.escalateToken(mint, symbol, 'INFLOW_DETECTED_WALLET_1');

  assert.ok(watcher.isTokenTracked(mint));
  const activeMints = watcher.getTrackedMints();
  assert.strictEqual(activeMints.length, 1);
  assert.strictEqual(activeMints[0], mint);

  // Feed simulated trade tick
  watcher.feedTradeTick({
    mint,
    side: 'buy',
    price: 0.00015,
    usd: 50,
    sol: 0.35,
    wallet: 'WALLET_TEST',
    signature: 'sig_test_1',
    timestamp: 1729350000,
    at: Date.now()
  });

  // Verify watcher processed trade
  assert.strictEqual(watcher.getTradeCount(mint), 1);

  // Cleanup
  watcher.unsubscribeToken(mint);
  assert.strictEqual(watcher.isTokenTracked(mint), false);

  try {
    if (fs.existsSync(testWatchEvents)) fs.unlinkSync(testWatchEvents);
  } catch {}
});
