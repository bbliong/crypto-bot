import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CohortCursor, Holder149Engine, type CohortDetail, type CohortEvent } from '../src/holder149-engine.js';
const wallets: string[] = JSON.parse(readFileSync('config/holder149-wallets.json', 'utf8')).addresses;
const mints = wallets.slice(10, 20);
const body = (side: string, timestamp: number, mint = mints[0]) => ({ data: { activities: [
  { event_type: side, timestamp, token: { address: mint, symbol: 'TEST' }, tx_hash: `${side}:${timestamp}:${mint}` },
] } });
const frame = (wallet: string, mint: string, t = 200) => ({ channel: 'token_activity', data: [{ n: 'sol', e: 'sell', m: wallet, a: mint, t, h: `sell:${wallet}` }] });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('149 wallets: 49 full batches plus one short batch, then wrap without duplicates', () => {
  const cursor = new CohortCursor(wallets);
  const scanned: string[] = [];
  for (let i = 0; i < 50; i++) { const batch = cursor.next(); assert.equal(batch.round, 1); assert.equal(batch.wallets.length, i === 49 ? 2 : 3); scanned.push(...batch.wallets); }
  assert.deepEqual(scanned, wallets);
  assert.equal(cursor.next().round, 2);
});

test('parallel openings reserve at most 3 slots; full capacity skips are not queued', async () => {
  const releases: Array<() => void> = [], events: CohortEvent[] = [];
  const engine = new Holder149Engine({ open: () => new Promise<void>(resolve => releases.push(resolve)), close: async () => {}, event: e => events.push(e) });
  await Promise.all(wallets.slice(0, 6).map((w, i) => engine.activity(w, body('buy', 100, mints[i]))));
  assert.equal(engine.details.size, 3); assert.equal(releases.length, 3);
  assert.equal(events.filter(e => e.type === 'BUY_SKIPPED_CAPACITY').length, 3);
  releases.forEach(release => release()); await tick();
  const first = engine.details.get(mints[0])!;
  await engine.socket(first, frame(wallets[0], mints[0]));
  assert.equal(engine.details.size, 2);
  await engine.activity(wallets[3], body('buy', 100, mints[3]));
  assert.equal(engine.details.size, 2, 'skipped stale Buy is consumed');
  await engine.activity(wallets[3], body('buy', 300, mints[3]));
  assert.equal(engine.details.size, 3);
  releases.at(-1)!(); await tick(); await engine.shutdown();
});

test('top Sell never opens historical Buy; shared mint closes only after watched wallets sell', async () => {
  const opens: CohortDetail[] = [], closes: CohortDetail[] = [];
  const engine = new Holder149Engine({ open: async d => { opens.push(d); }, close: async d => { closes.push(d); }, event: () => {} });
  await engine.activity(wallets[0], { data: { activities: [...body('sell', 200).data.activities, ...body('buy', 100).data.activities] } });
  assert.equal(opens.length, 0);
  await Promise.all([engine.activity(wallets[0], body('buy', 300)), engine.activity(wallets[1], body('buy', 301))]); await tick();
  assert.equal(opens.length, 1);
  const detail = opens[0]; assert.equal(detail.watchers.size, 2);
  await engine.socket(detail, frame(wallets[2], mints[0], 400)); assert.equal(closes.length, 0);
  await engine.socket(detail, frame(wallets[0], mints[0], 400)); assert.equal(closes.length, 0);
  await engine.socket(detail, frame(wallets[1], mints[0], 401)); assert.equal(closes.length, 1);
  await engine.activity(wallets[0], body('buy', 300)); assert.equal(opens.length, 1);
  await engine.activity(wallets[0], body('buy', 500)); await tick();
  // A repeated old socket sell cannot close a later Buy.
  await engine.socket(opens[1], frame(wallets[0], mints[0], 400)); assert.equal(engine.details.size, 1);
  await engine.activity(wallets[0], { data: { activities: [...body('buy', 700, mints[1]).data.activities, ...body('sell', 600).data.activities] } });
  await tick(); assert.equal(engine.details.has(mints[0]), false); assert.equal(engine.details.has(mints[1]), true);
  await engine.shutdown();
});

test('failed open releases its slot; failed close retains occupied slot until shutdown', async () => {
  const engine = new Holder149Engine({ open: async () => { throw new Error('navigation failed'); }, close: async () => {}, event: () => {} });
  await engine.activity(wallets[0], body('buy', 100)); await tick(); assert.equal(engine.details.size, 0);
  const closing = new Holder149Engine({ open: async () => {}, close: async () => { throw new Error('close failed'); }, event: () => {} }, 1);
  await closing.activity(wallets[0], body('buy', 100)); await tick();
  await closing.socket(closing.details.get(mints[0])!, frame(wallets[0], mints[0]));
  assert.equal(closing.details.size, 1); assert.equal(closing.details.get(mints[0])?.phase, 'closing');
  await closing.activity(wallets[1], body('buy', 300, mints[1])); assert.equal(closing.details.has(mints[1]), false);
  closing.pageClosed(closing.details.get(mints[0])!);
  assert.equal(closing.details.size, 0, 'a later actual page close frees the retained slot');
});
