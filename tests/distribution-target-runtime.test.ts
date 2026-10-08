import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistributionTargetRuntime } from '../src/distribution-target-runtime.js';
import { DEFAULT_TARGET_RULES } from '../src/distribution-target-lane.js';

test('runtime parses holder channel addresses, retains capture after paper exits and freezes the loaded rule', () => {
  const root = mkdtempSync(join(tmpdir(), 'distribution-paper-')), run = join(root, 'run'), cfg = join(root, 'config');
  mkdirSync(run); mkdirSync(cfg);
  writeFileSync(join(cfg, 'active-rule.json'), JSON.stringify({ rules: DEFAULT_TARGET_RULES }));
  const records: any[] = [], runtime = new DistributionTargetRuntime(run, (_name, row) => records.push(row), cfg);
  runtime.register({ mint: 'mint', wallet: 'receiver', timestamp: 1 }, 1000);
  runtime.holderFrame('mint', { channel: 'token_general_stat_num', data: [{ a: 'other', t: 'holder_count', v: 9 }, { a: 'mint', t: 'holder_count', v: 100 }] }, 2000);
  runtime.holderFrame('mint', { channel: 'token_general_stat_num', data: [{ a: 'mint', t: 'holder_count', v: 101 }] }, 18000);
  runtime.trade('mint', { at: 19000, timestamp: 19, price: 1, side: 'buy', wallet: 'buyer', usd: 5, signature: 'one' });
  runtime.evaluate(20000);
  const s = JSON.parse(readFileSync(join(run, 'distribution-target-state.json'), 'utf8'));
  assert.equal(s.positions[0].facts.holderCount, 101);
  assert.equal(s.positions[0].facts.holderGrowth15s, 1);
  writeFileSync(join(cfg, 'active-rule.json'), JSON.stringify({ rules: { ...DEFAULT_TARGET_RULES, targetPercent: 25 } }));
  runtime.evaluate(21000); assert.equal(runtime.rules.targetPercent, 20);
  runtime.end('mint', 22000, 'DETAIL_CLOSED');
  assert.equal(records.at(-1).type, 'PAPER_NO_ENTRY');
});
