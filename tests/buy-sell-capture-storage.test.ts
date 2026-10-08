import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuySellCaptureStorage, captureBucket, partitionedCaptureFiles } from '../src/buy-sell-capture-storage.js';

test('captures rotate at UTC :00/:30 by receipt time, append within a chunk and preserve old root logs', async () => {
  const run = mkdtempSync(join(tmpdir(), 'buy-sell-chunks-'));
  const start = Date.parse('2026-10-07T17:00:00Z');
  const storage = new BuySellCaptureStorage(run, () => start);
  try {
    writeFileSync(join(run, 'websocket-frames.jsonl'), '{"legacy":true}\n');
    const received = [start, start + 30 * 60_000 - 1, start + 30 * 60_000, start + 60 * 60_000];
    for (const [index, observedAt] of received.entries())
      storage.write('websocket-frames.jsonl', { observedAt, index, body: { timestamp: 1 } });
    const first = join(run, 'chunks', captureBucket(start), 'websocket-frames.jsonl');
    assert.deepEqual(readFileSync(first, 'utf8').trim().split('\n').map(line => JSON.parse(line).index), [0, 1]);
    assert.equal(JSON.parse(readFileSync(join(run, 'chunks', captureBucket(received[2]), 'websocket-frames.jsonl'), 'utf8')).index, 2);
    assert.equal(JSON.parse(readFileSync(join(run, 'chunks', captureBucket(received[3]), 'websocket-frames.jsonl'), 'utf8')).index, 3);
    assert.equal(readFileSync(join(run, 'websocket-frames.jsonl'), 'utf8'), '{"legacy":true}\n');
    assert.equal(captureBucket(Date.parse('2026-10-08T00:29:59+07:00')), '2026-10-07T17-00-00-000Z');
    assert.equal(captureBucket(Date.parse('2026-10-08T00:30:00+07:00')), '2026-10-07T17-30-00-000Z');
    assert.equal(readdirSync(join(run, 'chunks')).length, 3);
    // A late observation goes back to its original chunk without overwriting it.
    storage.write('websocket-frames.jsonl', { observedAt: start, index: 4 });
    assert.equal(readFileSync(first, 'utf8').trim().split('\n').length, 3);
  } finally { storage.close(); await rm(run, { recursive: true, force: true }); }
});

test('all capture streams share time partitions; control events stay flat and file handles flush before close', async () => {
  const run = mkdtempSync(join(tmpdir(), 'buy-sell-chunks-'));
  const start = Date.parse('2026-10-07T23:59:59Z');
  const storage = new BuySellCaptureStorage(run, () => start);
  try {
    for (const name of partitionedCaptureFiles) {
      storage.write(name, { observedAt: start, stream: name });
      storage.write(name, { observedAt: start + 1000, stream: name });
    }
    storage.write('watch-events.jsonl', { type: 'READY' });
    storage.write('watch-events.jsonl', { type: 'TOKEN_DETAIL_OPENED', observedAt: start + 1000 });
    assert.equal(readFileSync(join(run, 'watch-events.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(readdirSync(run).includes('websocket-frames.jsonl'), false);
    assert.equal(readdirSync(join(run, 'chunks', captureBucket(start))).length, 5);
    assert.equal(readdirSync(join(run, 'chunks', captureBucket(start + 1000))).length, 5);
    assert.throws(() => storage.write('../escape.jsonl', {}));
    assert.throws(() => captureBucket(NaN));
    storage.close(); storage.close();
    assert.throws(() => storage.write('websocket-frames.jsonl', {}));
    // Reopening the same run appends rather than truncating a chunk.
    const restarted = new BuySellCaptureStorage(run, () => start);
    restarted.write('websocket-frames.jsonl', { resumed: true }); restarted.close();
    assert.equal(readFileSync(join(run, 'chunks', captureBucket(start), 'websocket-frames.jsonl'), 'utf8').trim().split('\n').length, 2);
  } finally { storage.close(); await rm(run, { recursive: true, force: true }); }
});
