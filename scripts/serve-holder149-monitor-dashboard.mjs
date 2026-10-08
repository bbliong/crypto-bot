import { createServer } from 'node:http';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url)), exec = promisify(execFile);
const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const json = (res, code, body) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
export function createHolder149Dashboard({ root = defaultRoot,
  profileDir = process.env.HOLDER149_PROFILE_DIR ?? join(root, 'profiles', 'holder149-watch'),
  profileName = process.env.HOLDER149_PROFILE_NAME ?? 'Profile 12',
  manageWorker = (process.env.HOLDER149_MANAGE_WORKER ?? 'on') === 'on' } = {}) {
  if (typeof profileDir !== 'string' || !profileDir.trim() || typeof profileName !== 'string' || !profileName.trim())
    throw new Error('Konfigurasi profil Chrome tidak valid.');
  profileDir = resolve(root, profileDir);
  const dataRoot = join(root, 'data', 'holder149-watch'), controlFile = join(dataRoot, 'worker-control.json');
  const runner = join(root, 'scripts', 'run-holder149-watch.mjs'), walletsFile = join(root, 'config', 'holder149-wallets.json');
  mkdirSync(dataRoot, { recursive: true });
  let transition = false;
  function wallets() {
    const config = readJson(walletsFile, null);
    if (!Array.isArray(config?.addresses) || config.addresses.length !== 149 || new Set(config.addresses).size !== 149
      || config.addresses.some(wallet => typeof wallet !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)))
      throw new Error('Daftar 149 wallet historis tidak tersedia/valid.');
    return config.addresses;
  }
  async function verifyWorker(state) {
    if (state?.mode !== 'holder149-watch') throw new Error('PID bukan milik worker holder149.');
    let command;
    if (process.platform === 'win32') {
      const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}').CommandLine`], { windowsHide: true });
      command = stdout.trim();
    } else { const { stdout } = await exec('ps', ['-p', String(state.pid), '-o', 'args=']); command = stdout.trim(); }
    if (!command) return false;
    if (!command.replaceAll('\\', '/').toLowerCase().includes(runner.replaceAll('\\', '/').toLowerCase()))
      throw new Error('PID bukan worker holder149 project ini; tidak dihentikan.');
    return true;
  }
  async function stopWorker() {
    const state = readJson(controlFile, null);
    if (!alive(state?.pid)) return false;
    if (!await verifyWorker(state)) return false;
    writeFileSync(join(dataRoot, 'stop-request.json'), JSON.stringify({ pid: state.pid, requestedAt: new Date().toISOString() }));
    for (let attempt = 0; attempt < 80 && alive(state.pid); attempt++) await delay(100);
    if (alive(state.pid) && await verifyWorker(state)) {
      if (process.platform === 'win32') await exec('taskkill', ['/pid', String(state.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(state.pid, 'SIGTERM');
    }
    const current = readJson(controlFile, state);
    if (current.pid === state.pid) writeFileSync(controlFile, JSON.stringify({ ...current, status: 'stopped', stopping: true,
      stoppedAt: new Date().toISOString(), details: [] }, null, 2));
    return true;
  }
  async function startWorker() {
    const previous = readJson(controlFile, null);
    if (alive(previous?.pid)) {
      await verifyWorker(previous);
      return previous; // Start is idempotent and does not restart a live worker.
    }
    const addresses = wallets();
    const args = [runner, '--walletsFile', walletsFile, '--dataDir', dataRoot,
      '--profileDir', profileDir, '--profileName', profileName, '--batchMilliseconds', '3000'];
    const fd = openSync(join(dataRoot, 'worker.log'), 'a');
    let child;
    try { child = spawn(process.execPath, args, { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    if (!Number.isSafeInteger(child.pid)) throw new Error('Proses worker gagal dibuat.');
    const record = { pid: child.pid, mode: 'holder149-watch', startedAt: new Date().toISOString(), status: 'starting',
      addresses, batchSize: 3, batchMilliseconds: 3000, maxDetails: 3, maxTabs: 4,
      activityResponsesSaved: false, simulationEnabled: false, run: null };
    // Child has not executed its first JS yet, so establish ownership first.
    writeFileSync(controlFile, JSON.stringify(record, null, 2));
    child.on('error', error => {
      const state = readJson(controlFile, record);
      if (state.pid === child.pid) writeFileSync(controlFile, JSON.stringify({ ...state, status: 'failed', lastError: error.message }, null, 2));
    });
    child.on('exit', code => {
      const state = readJson(controlFile, null);
      if (state?.pid === child.pid && !['stopped', 'failed'].includes(state.status))
        writeFileSync(controlFile, JSON.stringify({ ...state, status: code ? 'failed' : 'stopped', details: [],
          lastError: code ? state.lastError || `Worker keluar dengan kode ${code}; lihat worker.log.` : state.lastError }, null, 2));
    });
    child.unref(); return record;
  }
  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
        return json(res, 403, { error: 'Origin tidak diizinkan.' });
      if (req.method === 'GET' && path === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(join(root, 'dist', 'holder149-monitor-dashboard.html')));
      if (req.method === 'GET' && path === '/api/state') {
        const current = readJson(controlFile, null), active = alive(current?.pid);
        const worker = current ? { ...current, active, details: active ? current.details ?? [] : [],
          status: active ? current.status : current.status === 'failed' ? 'failed' : 'stopped' } : { active: false, status: 'stopped', details: [] };
        return json(res, 200, { mode: 'HOLDER149', managementEnabled: manageWorker, wallets: wallets(), worker });
      }
      if (req.method === 'POST' && ['/api/worker/start', '/api/worker/stop'].includes(path)) {
        if (!manageWorker) return json(res, 403, { error: 'Worker dikelola service server. Gunakan systemctl untuk start/stop.' });
        if (transition) return json(res, 409, { error: 'Worker sedang start/stop.' });
        transition = true;
        try { return json(res, 200, path.endsWith('/start') ? await startWorker() : { stopped: await stopWorker() }); }
        finally { transition = false; }
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) { return json(res, 500, { error: error.message }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!['on', 'off'].includes(process.env.HOLDER149_MANAGE_WORKER ?? 'on')) throw new Error('HOLDER149_MANAGE_WORKER harus on atau off.');
  const port = Number(process.env.HOLDER149_DASHBOARD_PORT ?? 4176);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port dashboard tidak valid.');
  const server = createHolder149Dashboard();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Holder149 dashboard: http://127.0.0.1:${port}`));
}
