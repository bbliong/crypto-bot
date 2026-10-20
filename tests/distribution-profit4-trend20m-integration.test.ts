import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Runtime } from '../src/distribution-profit4-runtime.js';

const testDir = join(process.cwd(), 'data', 'test-trend20m-integration');

test('DistributionProfit4Runtime integrates Trend20m lane pipeline correctly', () => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const writtenRecords: any[] = [];
  const write = (name: string, val: any) => {
    writtenRecords.push({ name, val });
  };

  const runtime = new DistributionProfit4Runtime(testDir, write, testDir, 'trend20m');
  assert.equal(runtime.laneType, 'trend20m');
  assert.equal(runtime.targetPercent, 20.0);

  const mint = 'TrendMintIntegration11111111111111111111111';
  const now = 1_700_000_000_000;

  // Register transfer dari gmgn_trend_ws
  runtime.register({
    mint,
    wallet: 'gmgn_trend',
    symbol: 'TREND',
    timestamp: Math.floor((now - 1_500_000) / 1000), // Usia 25 menit (> 20m)
    source: 'gmgn_trend_ws',
    priceUsd: 0.000015,
  }, now);

  // Check state registered
  assert.equal(runtime.isMintActive(mint), true);
  assert.ok(runtime.states.has(`${mint}:t_cons`));
  assert.ok(runtime.states.has(`${mint}:t_bal`));
  assert.ok(runtime.states.has(`${mint}:t_wide`));
  assert.ok(runtime.states.has(`${mint}:t_run`));

  // Trade ticks
  runtime.trade(mint, {
    at: now,
    timestamp: Math.floor(now / 1000),
    price: 0.000015,
    side: 'buy',
    wallet: 'Trader1',
    usd: 50,
    signature: 'sig_1',
  });

  // Holder frame
  runtime.holderFrame(mint, {
    channel: 'token_general_stat_num',
    data: [{ t: 'holder_count', v: '250', ta: mint }],
  }, now);

  // Evaluate runtime
  runtime.evaluate(now + 1000);

  // Cleanup test dir
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});
