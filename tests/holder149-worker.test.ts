import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { loadHolder149Wallets, runHolder149Watch } from '../src/holder149-watch.js';

test('new worker polls 3 in parallel, captures only successful detail sockets and no activity responses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'holder149-worker-')), walletsFile = 'config/holder149-wallets.json';
  const wallets = loadHolder149Wallets(walletsFile), mints = wallets.slice(10, 16);
  const pages: FakePage[] = [], opened: string[] = [];
  let requests = 0, inFlight = 0, peakRequests = 0, peakTabs = 1;
  class FakePage extends EventEmitter {
    closed = false;
    socket = new EventEmitter() as EventEmitter & { url: () => string };
    constructor(readonly controller = false) { super(); this.socket.url = () => 'wss://gmgn.ai/ws?session=secret-not-saved'; }
    isClosed() { return this.closed; }
    async close() { this.closed = true; this.emit('close'); }
    async goto(url: string) {
      if (this.controller) return;
      opened.push(url); this.emit('websocket', this.socket);
      this.socket.emit('framereceived', { payload: JSON.stringify({ channel: 'token_activity', data: [] }) });
      if (url.endsWith(mints[2])) throw new Error('fake navigation failure');
    }
    async evaluate(_fn: unknown, url: string) {
      const query = new URL(url, 'https://gmgn.ai'); assert.ok(query.pathname.includes('/wallet_activity/')); assert.equal(query.searchParams.has('type'), false);
      const wallet = query.searchParams.get('wallet')!, index = wallets.indexOf(wallet);
      requests++; inFlight++; peakRequests = Math.max(peakRequests, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5)); inFlight--;
      if (index === 6) {
        const detail = pages[1];
        const packet = (actor: string) => ({ payload: JSON.stringify({ channel: 'token_activity', data: [
          { n: 'sol', e: 'sell', m: actor, a: mints[0], t: 500, h: `sell:${actor}` },
        ] }) });
        detail.socket.emit('framereceived', packet(wallets[100]));
        assert.equal(detail.closed, false, 'another trader cannot close the detail');
        detail.socket.emit('framereceived', packet(wallets[0]));
        assert.equal(detail.closed, true, 'tracked wallet Sell closes its detail');
      }
      if (index === 8) this.closed = true;
      const side = index === 5 ? 'sell' : index < 6 ? 'buy' : 'transfer';
      return { code: 0, data: { activities: [{ event_type: side, timestamp: 100 + index, token: { address: mints[index % 6], symbol: 'TEST' }, tx_hash: `tx:${index}` }] } };
    }
  }
  const controller = new FakePage(true); pages.push(controller);
  const launch = chromium.launchPersistentContext;
  chromium.launchPersistentContext = (async () => ({ pages: () => [...pages], newPage: async () => {
    const page = new FakePage(); pages.push(page); peakTabs = Math.max(peakTabs, pages.filter(p => !p.closed).length); return page;
  }, close: async () => { for (const page of pages) if (!page.closed) await page.close(); } })) as unknown as typeof launch;
  try {
    await runHolder149Watch({ walletsFile, dataDir: join(root, 'data'), profileDir: join(root, 'profile'), profileName: 'Test', batchMilliseconds: 20 });
    const state = JSON.parse(readFileSync(join(root, 'data', 'worker-control.json'), 'utf8'));
    assert.equal(state.status, 'stopped'); assert.equal(state.activityResponsesSaved, false);
    assert.equal(peakRequests, 3); assert.equal(requests, 9); assert.ok(peakTabs <= 4);
    assert.equal(state.metrics.skippedCapacity, 1); // one new Buy uses the freed slot, the next is skipped
    assert.equal(opened.length, 4); // 3 initial + 1 new Buy; top Sell did not open
    const files = readdirSync(state.run, { recursive: true }).map(String);
    assert.ok(files.every(file => !/api-responses|buys\.jsonl|sells\.jsonl|token-trades|watch-events/.test(file)));
    const frames = files.filter(file => file.endsWith('websocket-frames.jsonl')).flatMap(file => readFileSync(join(state.run, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    assert.equal(frames.length, 5); assert.ok(frames.every(frame => frame.mint !== mints[2]));
    assert.equal(state.metrics.soldSignals, 1);
    assert.ok(frames.some(frame => frame.body?.data?.some((row: { e: string; m: string }) => row.e === 'sell' && row.m === wallets[0])), 'Sell packet persisted before close');
    assert.ok(frames.every(frame => frame.role === 'token_detail' && !frame.socket.includes('?')));
  } finally { chromium.launchPersistentContext = launch; await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
