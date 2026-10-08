import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchWalletActivityPair } from '../src/wallet-activity-poll.js';

test('wallet requests never overlap and wait after the previous response body finishes', async t => {
  let active = 0;
  let maximumActive = 0;
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    active++;
    maximumActive = Math.max(maximumActive, active);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"data":{"activities":[');
    await delay(35);
    active--;
    res.end(JSON.stringify({ event_type: req.url === '/in' ? 'transfer_in' : 'sell' }) + ']}}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const result = await fetchWalletActivityPair({ incomingUrl: `http://127.0.0.1:${port}/in`, sellUrl: `http://127.0.0.1:${port}/sell`, requestGapMs: 30 });
  assert.equal(maximumActive, 1);
  assert.deepEqual(paths, ['/in', '/sell']);
  assert.equal(result.complete, true);
  assert.equal(result.body.data.activities.length, 2);
  assert.ok(result.requests[1].startedAt - result.requests[0].finishedAt >= 30);
});

test('HTML is preserved and a partial poll cannot be treated as complete wallet activity', async t => {
  const html = '<!DOCTYPE html><html><body>Temporary error</body></html>';
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    res.writeHead(503, { 'content-type': 'text/html' }).end(html);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const result = await fetchWalletActivityPair({ incomingUrl: `http://127.0.0.1:${port}/in`, sellUrl: `http://127.0.0.1:${port}/sell`, requestGapMs: 30 });
  assert.equal(result.complete, false);
  assert.equal(result.status, 503);
  assert.equal(result.requests[0].rawBody, html);
  assert.deepEqual(paths, ['/in']);
});
