import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DistributionProfit4Lane, PROFIT4_RULES } from '../src/distribution-profit4-lane.js';
import { DistributionProfit4Runtime } from '../src/distribution-profit4-runtime.js';
import type { TargetEvent, TargetFacts } from '../src/distribution-target-lane.js';
const facts = (now = 100000, price = 1): TargetFacts => ({ now, transferAt: 0, firstAt: 1000, price, priceAt: now,
  momentumPercent: 1, drawdownPercent: 0, entryReturnPercent: 1, holderCount: 100, holderGrowth15s: 1,
  buyShareUsdPercent: 80, meaningfulBuyUsd: 80, meaningfulBuyers: 4, topBuyerSharePercent: 40,
  sellUsd: 20, largestSellUsd: 0, riskWalletsPresent: [] });
test('Profit4 uses net4 rather than engine fallback25, preserves delayed fills and cannot reenter', () => {
  const events: TargetEvent[] = [], a = new DistributionProfit4Lane('mint', e => events.push(e));
  a.step(facts()); a.step(facts(101000)); a.step(facts(102000, 1.08));
  assert.equal(a.phase, 'EXIT_PENDING'); assert.equal(a.exitAt, null);
  a.step(facts(103000, 1.09)); assert.equal(a.phase, 'CLOSED'); assert.ok(a.netReturnPercent! >= 4);
  assert.equal(events.at(-1)?.reason, 'TARGET_NET_4'); assert.equal(events.at(-1)?.targetPercent, 4);
  a.step(facts(150000)); assert.equal(events.filter(e => e.type === 'PAPER_BUY').length, 1);
  assert.equal(a.rules.version, PROFIT4_RULES.version);
});
test('Profit4 rejects missing holder history and future quotes on pending fills; observed dumps latch', () => {
  const a = new DistributionProfit4Lane('mint'); a.step({ ...facts(), holderGrowth15s: null }); assert.equal(a.phase, 'WATCHING');
  a.step(facts(101000)); a.step({ ...facts(102000), priceAt: 103000 }); assert.equal(a.entryAt, null);
  a.step(facts(103000)); assert.equal(a.entryAt, 103000);
  const b = new DistributionProfit4Lane('dump'); b.step({ ...facts(), drawdownPercent: 80 }); b.step(facts(101000));
  assert.equal(b.entryAt, null); assert.equal(b.phase, 'CLOSED');
});
test('stop gaps are recorded honestly and missing delayed exits remain unknown', () => {
  const a = new DistributionProfit4Lane('gap'); a.step(facts()); a.step(facts(101000));
  a.step(facts(102000, .5)); a.step(facts(103000, .1)); assert.ok(a.netReturnPercent! < -90);
  const b = new DistributionProfit4Lane('missing'); b.step(facts()); b.step(facts(101000)); b.step(facts(102000, 1.1));
  b.step({ ...facts(108000), price: null, priceAt: null }); assert.equal(b.phase, 'CENSORED'); assert.equal(b.netReturnPercent, null);
});
test('runtime accepts socket holder history, keeps quotes causal and persists one-round ledger across restart', () => {
  const data = mkdtempSync(join(tmpdir(), 'profit4-runtime-')), run = join(data, 'one'); mkdirSync(run);
  const events: any[] = [], a = new DistributionProfit4Runtime(run, (_n, e) => events.push(e), data);
  a.register({ mint: 'mint', wallet: 'receiver', timestamp: 1 }, 1000);
  a.trade('mint', { at: 2000, timestamp: 2, price: 1, side: 'buy', wallet: 'buyer', usd: 5, signature: 'initial' });
  for (let at = 2000; at <= 34000; at += 1000) {
    a.holderFrame('mint', { channel: 'token_general_stat_num', data: [{ a: 'other', t: 'holder_count', v: 1 }, { a: 'mint', t: 'holder_count', v: 100 + at / 1000 }] }, at);
    if (at > 2000) a.trade('mint', { at, timestamp: at / 1000, price: 1 + (at - 2000) / 1000000,
      side: 'buy', wallet: 'buyer', usd: 5, signature: String(at) });
    a.evaluate(at);
  }
  const first = JSON.parse(readFileSync(join(run, 'profit4-state.json'), 'utf8'));
  assert.ok(first.positions[0].entryAt !== null); assert.equal(first.positions[0].targetPercent, 4);
  assert.equal(first.positions[0].facts.holderCount, 134);
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'bought-mints.json'), 'utf8')).mints, ['mint']);
  a.shutdown(35000); assert.equal(events.at(-1).type, 'PAPER_EXIT_DATA_MISSING');
  const secondRun = join(data, 'two'); mkdirSync(secondRun);
  const b = new DistributionProfit4Runtime(secondRun, () => {}, data); b.register({ mint: 'mint', wallet: 'receiver', timestamp: 35 }, 35000);
  const second = JSON.parse(readFileSync(join(secondRun, 'profit4-state.json'), 'utf8'));
  assert.equal(second.positions[0].lastEvent.reason, 'ONE_ROUND_ALREADY_ENTERED'); assert.equal(second.positions[0].entryAt, null);
});
