import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RotatingJsonlWriter, LOG_CHUNK_MS } from '../src/rotating-jsonl.ts';
import { listRunLogFiles, readRunLogRecords } from '../scripts/lib/distribution-logs.mjs';

test('all log streams rotate at the half-hour boundary without losing or duplicating records', t => {
  const run = mkdtempSync(join(tmpdir(), 'distribution-chunk-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 7, 17, 29, 59, 999);
  const writer = new RotatingJsonlWriter(run, () => now);
  const names = ['websocket-frames.jsonl', 'api-responses.jsonl', 'token-trades.jsonl', 'watch-events.jsonl', 'transfers.jsonl'];
  for (const name of names) writer.write(name, { observedAt: now, value: 'sebelum — 測試' });
  now++;
  for (const name of names) writer.write(name, { observedAt: now, value: 'sesudah' });
  writer.close();
  const chunks = readdirSync(join(run, 'chunks')).sort();
  assert.deepEqual(chunks, ['2026-10-08T00-00-00-000-WIB', '2026-10-08T00-30-00-000-WIB']);
  for (const name of names) {
    assert.equal(listRunLogFiles(run, name).length, 2);
    assert.deepEqual([...readRunLogRecords(run, name)].map(x => x.value), ['sebelum — 測試', 'sesudah']);
  }
  const metadata = JSON.parse(readFileSync(join(run, 'chunks', chunks[1], 'chunk.json'), 'utf8'));
  assert.equal(Date.parse(metadata.endUtc) - Date.parse(metadata.startUtc), LOG_CHUNK_MS);
});

test('event readers combine legacy files and all chunks, tolerating an incomplete live last line', t => {
  const run = mkdtempSync(join(tmpdir(), 'distribution-chunk-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  writeFileSync(join(run, 'watch-events.jsonl'), '{"type":"READY"}\n');
  let now = Date.UTC(2026, 9, 7, 17, 29, 59);
  const writer = new RotatingJsonlWriter(run, () => now);
  writer.write('watch-events.jsonl', { type: 'TOKEN_DETAIL_OPENED', wallet: 'A' });
  now += 2000;
  writer.write('watch-events.jsonl', { type: 'TRACKED_WALLET_SOLD', wallet: 'A' });
  writer.close();
  const paths = listRunLogFiles(run, 'watch-events.jsonl');
  const last = paths.at(-1);
  writeFileSync(last, readFileSync(last, 'utf8') + '{"unfinished":');
  assert.deepEqual([...readRunLogRecords(run, 'watch-events.jsonl')].map(x => x.type), ['READY', 'TOKEN_DETAIL_OPENED', 'TRACKED_WALLET_SOLD']);
  assert.deepEqual(listRunLogFiles(run, 'transfers.jsonl'), []);
});

test('late timestamps and a clock adjustment keep new writes in the current chunk', t => {
  const run = mkdtempSync(join(tmpdir(), 'distribution-chunk-'));
  t.after(() => rmSync(run, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 7, 17, 30);
  const writer = new RotatingJsonlWriter(run, () => now);
  writer.write('token-trades.jsonl', { observedAt: now });
  now -= 1000;
  writer.write('token-trades.jsonl', { observedAt: now - LOG_CHUNK_MS });
  assert.throws(() => writer.write('../other.jsonl', {}), /Invalid log filename/);
  writer.close();
  assert.equal(listRunLogFiles(run, 'token-trades.jsonl').length, 1);
  assert.equal([...readRunLogRecords(run, 'token-trades.jsonl')].length, 2);
});
