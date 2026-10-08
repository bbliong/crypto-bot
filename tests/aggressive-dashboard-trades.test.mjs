import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createLiveTradesReader } from '../scripts/live-dashboard-trades.mjs';

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
function position(mint = 'token', time = 1000, lane = 'control') {
  const positionId = `${mint}:${time}:${lane}`;
  return [
    { type: 'SIMULATED_BUY', mint, observedAt: time, paperLane: lane, positionId, entryPriceUsd: 2, stakeUsd: 10, metadata: { symbol: 'TEST', name: 'Test token' } },
    { type: 'SIMULATED_SELL', mint, observedAt: time + 1000, paperLane: lane, positionId, entry: { openedAt: time }, exit: { priceUsd: 3 }, pnlPercent: 50, pnlUsd: 5, reason: 'TARGET' },
  ];
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-trades-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('live JSONL reader caches unchanged files and recovers after partial writes, replacement and truncation', t => {
  const dir = fixture(t);
  const file = join(dir, 'simulated-trades.jsonl');
  let reads = 0;
  const read = createLiveTradesReader({ readFile: (...args) => { reads++; return readFileSync(...args); } });
  assert.deepEqual(read(dir), []);
  writeFileSync(file, '');
  assert.deepEqual(read(dir), []);
  const [buy, sell] = position();
  const sellLine = JSON.stringify(sell);
  writeFileSync(file, jsonl([null, 42, [], {}, buy]) + 'malformed\n' + sellLine.slice(0, -8));
  assert.deepEqual(read(dir), []);
  const cachedReads = reads;
  assert.deepEqual(read(dir), []);
  assert.equal(reads, cachedReads);
  appendFileSync(file, sellLine.slice(-8) + '\n');
  const [trade] = read(dir, 99);
  assert.equal(trade.exitPrice, 3);
  assert.equal(trade.socketReturnPercent, 50);
  assert.equal(trade.tradePnlUsd, 5); // stake from BUY, not current config
  assert.equal(trade.realReturnPercent, 46.5);
  assert.equal(trade.swapPnlUsd, 5);
  assert.equal(trade.swapRoute.hasBuy, false);
  writeFileSync(file + '.new', jsonl(position('other')));
  renameSync(file + '.new', file);
  assert.equal(read(dir)[0].mint, 'other');
  writeFileSync(file, '');
  assert.deepEqual(read(dir), []);
  rmSync(file);
  assert.deepEqual(read(dir), []);
  writeFileSync(file, jsonl(position()));
  assert.equal(read(dir).length, 1);
});

test('a file changing during read is not cached as the newer snapshot', t => {
  const dir = fixture(t);
  const file = join(dir, 'simulated-trades.jsonl');
  const [buy, sell] = position();
  writeFileSync(file, jsonl([buy]));
  let mutate = true;
  const read = createLiveTradesReader({ readFile: (...args) => {
    const content = readFileSync(...args);
    if (mutate && args[0] === file) { mutate = false; appendFileSync(file, jsonl([sell])); }
    return content;
  } });
  assert.equal(read(dir).length, 0);
  assert.equal(read(dir).length, 1);
});

test('live matching isolates lanes and repeated positions, including legacy sells', t => {
  const dir = fixture(t);
  const first = position();
  const second = position('token', 4000);
  const otherLane = position('token', 1000, 'aggressive-safe');
  delete first[1].positionId;
  writeFileSync(join(dir, 'simulated-trades.jsonl'), jsonl([...first, second[0], otherLane[0]]));
  const trades = createLiveTradesReader()(dir);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].positionId, first[0].positionId);
});

test('quote enrichment refreshes independently and preserves swap columns', t => {
  const dir = fixture(t);
  const events = position();
  delete events[1].pnlPercent; // exercise nested exit.priceUsd fallback
  writeFileSync(join(dir, 'simulated-trades.jsonl'), jsonl(events));
  const read = createLiveTradesReader();
  assert.equal(read(dir)[0].socketReturnPercent, 50);
  writeFileSync(join(dir, 'quote-simulated-orders.jsonl'), jsonl([
    { type: 'QUOTE_BUY_COMPARISON', positionId: events[0].positionId, quote: { amountInUsd: 10 }, inputAmountBaseUnits: '100000000', routeTokenAmount: 5, latencyMs: 20 },
    { type: 'QUOTE_SELL_COMPARISON', positionId: events[0].positionId, quote: { amountOutUsd: 12, outAmount: '120000000' } },
  ]));
  const [trade] = read(dir);
  assert.ok(Math.abs(trade.realReturnPercent - 20) < 1e-10);
  assert.equal(trade.swapPnlUsd, 2);
  assert.equal(trade.swapRoute.buyInSol, '0.1000 SOL');
  assert.equal(trade.swapRoute.sellOutUsd, '$12.0000');
  assert.equal(trade.swapRoute.buyLatencyMs, 20);
});

test('only the aggressive supervisor owns archive SQLite sync', () => {
  const collector = readFileSync(resolve('src/research-collector.ts'), 'utf8');
  const supervisor = readFileSync(resolve('scripts/run-aggressive-momentum-agy.mjs'), 'utf8');
  assert.doesNotMatch(collector, /syncSingleRunToSqlite|SESSION-ARCHIVED|SESSION-ARCHIVE-ERROR/);
  assert.match(supervisor, /import \{ getWibSlot, syncSingleRunToSqlite \} from '\.\/crypto-db\.mjs';/);
  assert.equal((supervisor.match(/syncSingleRunToSqlite\(fullOutputDir\)/g) || []).length, 1);
  assert.match(supervisor, /currentChild\.on\('close'[\s\S]*?syncSingleRunToSqlite\(fullOutputDir\)/);
});

test('HTTP /api/trades reads fresh LIVE JSONL and keeps archive SQL pagination without reading network logs', async t => {
  const root = fixture(t);
  mkdirSync(join(root, 'scripts'));
  for (const file of ['serve-aggressive-dashboard-agy.mjs', 'crypto-db.mjs', 'live-dashboard-trades.mjs', 'simulation-cashflow.mjs']) {
    copyFileSync(resolve('scripts', file), join(root, 'scripts', file));
  }
  const dbModule = await import(pathToFileURL(join(root, 'scripts/crypto-db.mjs')).href);
  const db = dbModule.initCryptoDb();
  t.after(() => db.close());
  const liveId = dbModule.getWibSlot().runId;
  const liveDir = join(root, 'research', liveId);
  const archiveDir = join(root, 'research', 'archive-fixture');
  mkdirSync(liveDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, 'simulated-trades.jsonl'), jsonl([
    ...position('archived-1'), ...position('archived-2', 3000, 'aggressive-safe'), ...position('archived-3', 5000),
  ]));
  assert.equal(dbModule.syncSingleRunToSqlite(archiveDir).ok, true);
  assert.equal(dbModule.countTrades('archive-fixture', { status: 'CLOSED' }), 3);
  // Historical requests must continue to work after source files are removed.
  rmSync(archiveDir, { recursive: true });

  const guardFile = join(root, 'guard.mjs');
  const accessLog = join(root, 'file-access.jsonl');
  writeFileSync(guardFile, `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      const path = String(file);
      if (path.endsWith('.jsonl')) {
        fs.appendFileSync(${JSON.stringify(accessLog)}, JSON.stringify(path) + '\\n');
        if (path.endsWith('order-api-payloads.jsonl') || path.endsWith('order-api-audit.jsonl')) throw Error('Forbidden network log read');
      }
      return original.call(this, file, ...args);
    };
    syncBuiltinESMExports();
  `);
  // These exist so any attempted read is caught even behind an existsSync guard.
  for (const name of ['order-api-payloads.jsonl', 'order-api-audit.jsonl']) writeFileSync(join(liveDir, name), '{}\n');
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  const socketClosed = once(socket, 'close');
  socket.close();
  await socketClosed;
  const child = spawn(process.execPath, ['--import', guardFile, 'scripts/serve-aggressive-dashboard-agy.mjs', '--host', '127.0.0.1', '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(Error(`Server not ready: ${output}`)), 5000);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); });
    child.stdout.on('data', () => { if (output.includes('Web Dashboard URL')) { clearTimeout(timer); resolveReady(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  const request = async (params = '') => {
    const response = await fetch(`${base}/api/trades${params}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, true);
    return body;
  };
  assert.equal((await request()).total, 0); // LIVE has no file or SQLite trades
  const file = join(liveDir, 'simulated-trades.jsonl');
  writeFileSync(file, jsonl(position('fresh')));
  let result = await request();
  assert.equal(result.run, liveId);
  assert.equal(result.total, 1);
  assert.equal(result.trades[0].tradePnlUsd, 5);
  assert.equal(dbModule.countTrades(liveId), 0); // request did not upsert SQLite
  assert.deepEqual(Object.keys(result.trades[0]).sort(), Object.keys(dbModule.getTrades('archive-fixture')[0]).sort());

  // Seed deliberately stale LIVE SQLite, then append another trade only to disk.
  dbModule.upsertTrade({ ...result.trades[0], positionId: 'stale-sqlite-only', runId: liveId, mint: 'stale' });
  const next = position('newest', 9000, 'aggressive-safe');
  appendFileSync(file, 'bad-json\n' + jsonl([next[0]]) + JSON.stringify(next[1]).slice(0, -5));
  assert.equal((await request()).total, 1);
  appendFileSync(file, JSON.stringify(next[1]).slice(-5) + '\n');
  result = await request('?limit=1');
  assert.equal(result.total, 2);
  assert.equal(result.totalPages, 2);
  assert.equal(result.trades[0].mint, 'newest');
  assert.equal((await request('?page=99&limit=1')).page, 2);
  assert.equal((await request('?lane=aggressive-safe')).total, 1);
  assert.equal((await request(`?run=${liveId}&lane=control`)).trades[0].mint, 'fresh');
  writeFileSync(join(liveDir, 'live-trade-ledger.jsonl'), jsonl([
    { type: 'LIVE_ORDER_SUBMITTED', side: 'BUY', mint: 'on-chain-live', paperLane: 'control', observedAt: 20_000, ok: true, stakeUsd: 5 },
  ]));
  writeFileSync(join(liveDir, 'quote-simulated-orders.jsonl'), jsonl([
    { type: 'QUOTE_BUY_COMPARISON', mint: 'fresh', positionId: position('fresh')[0].positionId, observedAt: 2_000 },
  ]));
  await request(); // refresh the LIVE reader after adding a quote file
  const readsBefore = readFileSync(accessLog, 'utf8');
  await request();
  assert.equal(readFileSync(accessLog, 'utf8'), readsBefore); // unchanged files are cached

  const summaryResponse = await fetch(`${base}/api/summary`, { signal: AbortSignal.timeout(5000) });
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();
  assert.equal(summary.ok, true);
  assert.equal(summary.isLive, true);
  assert.equal(summary.summary.closedTrades, 2);
  assert.equal(summary.autoBuy.walletAddress, null);
  assert.equal(summary.autoBuy.walletBalance, null);
  const routeResponse = await fetch(`${base}/api/route-quotes`, { signal: AbortSignal.timeout(5000) });
  assert.equal(routeResponse.status, 200);
  assert.equal((await routeResponse.json()).total, 1);
  const realResponse = await fetch(`${base}/api/real-trades`, { signal: AbortSignal.timeout(5000) });
  assert.equal(realResponse.status, 200);
  const real = await realResponse.json();
  assert.equal(real.total, 1);
  assert.deepEqual(real.trades[0].buy.payloads, []);
  const readsAfterSummary = readFileSync(accessLog, 'utf8');
  assert.doesNotMatch(readsAfterSummary, /order-api-(payloads|audit)/);

  result = await request('?run=archive-fixture&limit=1&page=2');
  assert.equal(result.total, 3);
  assert.equal(result.trades[0].mint, 'archived-2');
  assert.equal((await request('?run=archive-fixture&lane=control')).total, 2);
  assert.equal(readFileSync(accessLog, 'utf8'), readsAfterSummary); // archive uses only SQLite
  assert.doesNotMatch(readsAfterSummary, /order-api-(payloads|audit)/);
  assert.equal((await fetch(base)).status, 200);
});
