import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GmgnWalletInflowMonitor, type InflowEvent } from '../src/gmgn-wallet-inflow-monitor.js';

test('GmgnWalletInflowMonitor: parses activities, detects transfer_in, deduplicates seen txs, and fires callback', async () => {
  const scratchDir = '/home/bbliong/.hermes/cache/scratch';
  const testConfigFile = path.join(scratchDir, `test-wallets-${Date.now()}.json`);
  const testInflowLog = path.join(scratchDir, `test-inflows-${Date.now()}.jsonl`);

  const sampleConfig = {
    updatedAt: new Date().toISOString(),
    selectionRule: 'test',
    watchingTargetsCount: 2,
    targets: [
      {
        tokenName: 'FOMO',
        tokenMint: '6mdVwPt9zEqr3a378UQegzEFxU7JgKVqbXvGGcDpump',
        symbol: 'FOMO',
        totalSyndicateWallets: 15,
        latestTransferWib: '2026-10-19 22:26:08 WIB',
        monitoredWallet: 'WALLET_1'
      },
      {
        tokenName: 'NVIDIA SSI',
        tokenMint: 'HmioaUhV12ZiyQT18BcUp6G3L2ZaxBDH9jyYiGipump',
        symbol: 'NVIDIA',
        totalSyndicateWallets: 15,
        latestTransferWib: '2026-10-19 22:17:48 WIB',
        monitoredWallet: 'WALLET_2'
      }
    ]
  };

  fs.writeFileSync(testConfigFile, JSON.stringify(sampleConfig, null, 2), 'utf8');

  const detected: InflowEvent[] = [];
  const monitor = new GmgnWalletInflowMonitor({
    configPath: testConfigFile,
    inflowLogPath: testInflowLog,
  });

  monitor.onInflow((event) => {
    detected.push(event);
  });

  // Test processing activities with 1 buy, 1 transfer_in, 1 sell
  const sampleActivities = [
    {
      event_type: 'buy',
      tx_hash: 'tx_buy_1',
      timestamp: 1729350000,
      token: { address: 'MINT_A', symbol: 'A' },
      amount: '10'
    },
    {
      event_type: 'transfer_in',
      tx_hash: 'tx_in_1',
      timestamp: 1729350100,
      token: { address: '6mdVwPt9zEqr3a378UQegzEFxU7JgKVqbXvGGcDpump', symbol: 'FOMO' },
      amount: '360500'
    },
    {
      event_type: 'sell',
      tx_hash: 'tx_sell_1',
      timestamp: 1729350200,
      token: { address: 'MINT_B', symbol: 'B' },
      amount: '50'
    }
  ];

  monitor.processWalletActivities('WALLET_1', sampleActivities);

  // Exactly 1 transfer_in detected
  assert.strictEqual(detected.length, 1);
  assert.strictEqual(detected[0].wallet, 'WALLET_1');
  assert.strictEqual(detected[0].mint, '6mdVwPt9zEqr3a378UQegzEFxU7JgKVqbXvGGcDpump');
  assert.strictEqual(detected[0].txHash, 'tx_in_1');

  // Re-processing the same activities should deduplicate and NOT fire again
  monitor.processWalletActivities('WALLET_1', sampleActivities);
  assert.strictEqual(detected.length, 1);

  // Verify log written to JSONL
  assert.ok(fs.existsSync(testInflowLog));
  const lines = fs.readFileSync(testInflowLog, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 1);
  const parsedLog = JSON.parse(lines[0]);
  assert.strictEqual(parsedLog.txHash, 'tx_in_1');

  try {
    fs.unlinkSync(testConfigFile);
    fs.unlinkSync(testInflowLog);
  } catch {}
});
