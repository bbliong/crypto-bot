import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProfit4Dashboard, profit4Snapshot } from '../scripts/serve-profit4-dashboard.mjs';
const wallet = '5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT';
test('dashboard seeds saved wallets, separates live/history, does not zero-fill interrupted exits or stop unrelated workers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profit4-dashboard-'));
  const old = join(root, 'data', 'distribution-watch'); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'dashboard-config.json'), JSON.stringify({ addresses: [wallet] }));
  const originalControl = JSON.stringify({ pid: process.pid, mode: 'distribution-watch' });
  writeFileSync(join(old, 'worker-control.json'), originalControl);
  const server = createProfit4Dashboard({ root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const initial = await (await fetch(url + '/api/state')).json();
    assert.deepEqual(initial.config.addresses, [wallet]); assert.equal(initial.rules.targetPercent, 4); assert.equal(initial.rules.rounds, 1);
    const run = join(root, 'data', 'profit4-watch', 'sample'); mkdirSync(run);
    const position = { mint: wallet, phase: 'OPEN', entryAt: 10, exitAt: null, netReturnPercent: null, pnlUsd: null, estimatedOpenNetPercent: 5 };
    writeFileSync(join(run, 'profit4-state.json'), JSON.stringify({ positions: [position], observedAt: 20 }));
    const snapshot = profit4Snapshot(root, { active: false });
    assert.equal(snapshot.positions[0].phase, 'CENSORED'); assert.equal(snapshot.positions[0].estimatedOpenNetPercent, null);
    assert.equal(snapshot.summary.missing, 1); assert.equal(snapshot.summary.closed, 0); assert.equal(snapshot.summary.realizedPnlUsd, 0);
    const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/wallets', { addresses: ['invalid'] })).status, 400);
    assert.equal((await fetch(url + '/api/worker/start', { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403);
    assert.equal((await post('/api/worker/start', {})).status, 500); // protects running old monitor/profile
    writeFileSync(join(root, 'data', 'profit4-watch', 'worker-control.json'), JSON.stringify({ pid: process.pid, mode: 'distribution-watch' }));
    assert.equal((await post('/api/worker/stop', {})).status, 500);
    assert.equal(readFileSync(join(old, 'worker-control.json'), 'utf8'), originalControl);
  } finally { server.close(); await once(server, 'close'); }
});
test('saving wallet lists starts/restarts the dedicated worker and cooperative stop closes it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'profit4-control-')); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'run-profit4-watch.mjs'), `
    import {writeFileSync,readFileSync} from 'node:fs';
    writeFileSync('worker-args.json',JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
    setInterval(()=>{try{const s=JSON.parse(readFileSync('data/profit4-watch/stop-request.json','utf8'));if(s.pid===process.pid)process.exit(0)}catch{}},50);
  `);
  const server = createProfit4Dashboard({ root }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  let childPid;
  try {
    for (const addresses of [[wallet], [wallet, '3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD']]) {
      const response = await post('/api/wallets', { addresses }); assert.equal(response.status, 200);
      const saved = await response.json(); childPid = saved.worker.pid;
      assert.equal(saved.restarted, true); assert.equal(saved.worker.rounds, 1);
      let launched;
      for (let i = 0; i < 50; i++) {
        try { launched = JSON.parse(readFileSync(join(root, 'worker-args.json'), 'utf8')); } catch {}
        if (launched?.pid === childPid) break; await delay(50);
      }
      assert.equal(launched.pid, childPid);
      assert.equal(launched.args[launched.args.indexOf('--addresses') + 1], addresses.join(','));
      assert.equal(launched.args[launched.args.indexOf('--pollMilliseconds') + 1], '500');
      assert.equal(launched.args[launched.args.indexOf('--profileName') + 1], 'Profile 12');
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'data', 'profit4-watch', 'dashboard-config.json'), 'utf8')).addresses, addresses);
    }
    assert.deepEqual(await (await post('/api/worker/stop')).json(), { stopped: true }); childPid = undefined;
  } finally {
    if (childPid) { try { process.kill(childPid); } catch {} }
    server.close(); await once(server, 'close');
  }
});
