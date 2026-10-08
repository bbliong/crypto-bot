import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createHolder149Dashboard } from '../scripts/serve-holder149-monitor-dashboard.mjs';

test('separate dashboard loads 149 wallets, launches own worker and protects unrelated processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'holder149-dashboard-'));
  for (const dir of ['config', 'scripts', 'dist']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'config', 'holder149-wallets.json'), readFileSync('config/holder149-wallets.json'));
  writeFileSync(join(root, 'dist', 'holder149-monitor-dashboard.html'), '<title>Holder149</title>');
  writeFileSync(join(root, 'scripts', 'run-holder149-watch.mjs'), `import fs from 'node:fs';
fs.writeFileSync('args.json',JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
setInterval(()=>{try{if(JSON.parse(fs.readFileSync('data/holder149-watch/stop-request.json')).pid===process.pid)process.exit(0);}catch{}},50);`);
  const profileDir = join(root, 'profiles', 'holder149-vps');
  const server = createHolder149Dashboard({ root, profileDir, profileName: 'Default' }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`, post = path => fetch(url + path, { method: 'POST' });
  let pid;
  try {
    const initial = await (await fetch(url + '/api/state')).json(); assert.equal(initial.wallets.length, 149); assert.equal(initial.worker.active, false);
    assert.equal((await fetch(url + '/')).status, 200);
    assert.equal((await fetch(url + '/api/worker/start', { method: 'POST', headers: { origin: 'https://example.com' } })).status, 403);
    const started = await (await post('/api/worker/start')).json(); pid = started.pid; assert.equal(started.maxDetails, 3); assert.equal(started.batchSize, 3);
    let args;
    for (let i = 0; i < 50; i++) { try { args = JSON.parse(readFileSync(join(root, 'args.json'), 'utf8')); } catch {} if (args) break; await delay(50); }
    assert.equal(args.pid, pid);
    assert.equal(args.args[args.args.indexOf('--batchMilliseconds') + 1], '3000');
    assert.equal(args.args[args.args.indexOf('--profileDir') + 1], profileDir);
    assert.equal(args.args[args.args.indexOf('--profileName') + 1], 'Default');
    assert.equal((await (await post('/api/worker/start')).json()).pid, pid, 'start does not duplicate/restart');
    assert.deepEqual(await (await post('/api/worker/stop')).json(), { stopped: true }); pid = undefined;
    const control = join(root, 'data', 'holder149-watch', 'worker-control.json');
    writeFileSync(control, JSON.stringify({ pid: process.pid, mode: 'holder149-watch', status: 'running', details: [{ mint: 'should-not-show' }] }));
    assert.equal((await post('/api/worker/stop')).status, 500, 'same mode with wrong command line is protected');
    writeFileSync(control, JSON.stringify({ pid: 2147483647, mode: 'holder149-watch', status: 'running', details: [{ mint: 'stale' }] }));
    const stale = await (await fetch(url + '/api/state')).json(); assert.equal(stale.worker.status, 'stopped'); assert.deepEqual(stale.worker.details, []);
    assert.equal((await post('/api/wallets')).status, 404, 'fixed cohort is separate from editable six-wallet dashboard');
  } finally {
    if (pid) { try { process.kill(pid, 'SIGTERM'); await delay(100); } catch {} }
    server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('systemd-managed dashboard is read-only and refuses worker start/stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'holder149-systemd-'));
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'holder149-wallets.json'), readFileSync('config/holder149-wallets.json'));
  const server = createHolder149Dashboard({ root, manageWorker: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const state = await (await fetch(url + '/api/state')).json();
    assert.equal(state.managementEnabled, false);
    for (const action of ['start', 'stop'])
      assert.equal((await fetch(url + '/api/worker/' + action, { method: 'POST' })).status, 403);
  } finally { server.close(); await once(server, 'close'); rmSync(root, { recursive: true, force: true }); }
});
