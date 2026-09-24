import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

test('dashboard honors configurable bind host and port', async () => {
  const host = '127.0.0.2';
  const port = await freePort();
  const child = spawn(process.execPath, ['scripts/serve-dashboard.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DASHBOARD_HOST: host, DASHBOARD_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dashboard did not report configured bind address: ${output}`)), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', () => {
        if (output.includes(`http://${host}:${port}`)) { clearTimeout(timer); resolve(); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`dashboard exited ${code}: ${output}`)); });
    });
    const response = await fetch(`http://${host}:${port}/`);
    assert.equal(response.status, 200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
