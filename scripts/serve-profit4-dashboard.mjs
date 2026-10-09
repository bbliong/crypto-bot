import { createServer } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFIT4_RULES, PROFIT4_TARGET_PERCENT } from '../src/distribution-profit4-lane.ts';
import { validMint } from '../src/parser.ts';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url)), exec = promisify(execFile);
const defaults = ['5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT', '3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD', '2dVDVvzH4D3ihpUTbiG9yNSEsQBs8iFNRifcZP6TLqVK'];
const read = (p, fallback = null) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const alive = pid => { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const json = (res, status, value) => res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(value));
async function body(req) {
  let raw = '', bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 20000) throw new Error('Payload terlalu besar.'); raw += chunk; }
  const value = JSON.parse(raw || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON tidak valid.'); return value;
}
export function profit4Snapshot(root, worker) {
  const base = join(root, 'data', 'profit4-watch');
  const positions = [], runs = [], recentEvents = [];
  for (const dir of readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const state = read(join(base, dir.name, 'profit4-state.json'));
    if (!state?.positions) continue;
    const runPath = join(base, dir.name), current = worker.run && resolve(root, worker.run) === resolve(runPath);
    const live = current && worker.active;
    runs.push({ id: dir.name, observedAt: state.observedAt, current: Boolean(current) });
    for (const p of state.positions) {
      const interrupted = !live && ['OPEN', 'EXIT_PENDING'].includes(p.phase);
      positions.push({ ...p, run: dir.name, live: Boolean(live),
        phase: interrupted ? 'CENSORED' : p.phase, estimatedOpenNetPercent: live ? p.estimatedOpenNetPercent : null,
        lastEvent: interrupted ? { type: 'PAPER_EXIT_DATA_MISSING', reason: 'WORKER_ENDED_WITHOUT_EXIT', observedAt: state.observedAt } : p.lastEvent });
    }
    for (const e of state.recentEvents ?? []) recentEvents.push({ ...e, run: dir.name });
  }
  function summarize(items) {
    const ent = items.filter(p => p.entryAt !== null), cls = ent.filter(p => p.netReturnPercent !== null);
    return {
      tokensObserved: new Set(items.map(p => p.mint)).size, entries: ent.length, closed: cls.length,
      profit: cls.filter(p => p.netReturnPercent > 0).length, loss: cls.filter(p => p.netReturnPercent < 0).length,
      open: ent.filter(p => ['OPEN', 'EXIT_PENDING'].includes(p.phase)).length,
      missing: ent.filter(p => p.phase === 'CENSORED').length,
      realizedPnlUsd: cls.reduce((n, p) => n + (p.pnlUsd || 0), 0),
      meanNetPercent: cls.length ? cls.reduce((n, p) => n + (p.netReturnPercent || 0), 0) / cls.length : null,
      winRatePercent: cls.length ? cls.filter(p => p.netReturnPercent > 0).length / cls.length * 100 : null,
    };
  }
  const v1Positions = positions.filter(p => (p.version || '').includes('v1') || p.laneLabel === 'V1' || (!p.laneLabel && !p.version?.includes('v2')));
  const v2Positions = positions.filter(p => (p.version || '').includes('v2') || p.laneLabel === 'V2');
  const hourMap = new Map();
  for (const p of positions) {
    const time = p.entryAt ?? p.lastEvent?.observedAt ?? (p.timestamp ? p.timestamp * 1000 : null);
    if (!time) continue;
    const hour = Math.floor(time / 3600000) * 3600000;
    if (!hourMap.has(hour)) hourMap.set(hour, []);
    hourMap.get(hour).push(p);
  }
  const hourlyComparison = Array.from(hourMap.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([hour, items]) => {
      const v1 = items.filter(p => (p.version || '').includes('v1') || p.laneLabel === 'V1' || (!p.laneLabel && !p.version?.includes('v2')));
      const v2 = items.filter(p => (p.version || '').includes('v2') || p.laneLabel === 'V2');
      const d = new Date(hour), endD = new Date(hour + 3600000);
      const dayStr = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit' });
      const startH = d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
      const endH = endD.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
      return {
        hourTimestamp: hour,
        label: `${dayStr} ${startH} - ${endH} WIB`,
        v1: summarize(v1),
        v2: summarize(v2),
        total: summarize(items),
      };
    });
  return { positions, runs, recentEvents: recentEvents.sort((a, b) => b.observedAt - a.observedAt).slice(0, 60),
    summary: summarize(positions),
    summaryV1: summarize(v1Positions),
    summaryV2: summarize(v2Positions),
    hourlyComparison,
  };
}
export function createProfit4Dashboard({ root = defaultRoot } = {}) {
  const data = join(root, 'data', 'profit4-watch'), configFile = join(data, 'dashboard-config.json'), controlFile = join(data, 'worker-control.json');
  mkdirSync(data, { recursive: true });
  const seed = read(join(root, 'data', 'distribution-watch', 'dashboard-config.json'), {}).addresses;
  if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify({ addresses: Array.isArray(seed) && seed.length && seed.every(validMint) ? seed : defaults, updatedAt: new Date().toISOString() }, null, 2));
  const config = () => read(configFile, { addresses: defaults });
  const logs = [];
  const log = message => { logs.unshift({ at: Date.now(), message }); logs.splice(50); };
  let transition = false;
  async function verifyWorker(state) {
    if (state.mode !== 'profit4-watch') throw new Error('PID ini bukan worker Profit4.');
    const runner = join(root, 'scripts', 'run-profit4-watch.mjs').replaceAll('\\', '/').toLowerCase();
    const { stdout } = process.platform === 'win32'
      ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}').CommandLine`], { windowsHide: true })
      : await exec('ps', ['-p', String(state.pid), '-o', 'args=']);
    if (!stdout.replaceAll('\\', '/').toLowerCase().includes(runner)) throw new Error('PID tidak cocok dengan worker project ini.');
  }
  async function stop() {
    const state = read(controlFile);
    if (!alive(state?.pid)) return false;
    await verifyWorker(state);
    writeFileSync(join(data, 'stop-request.json'), JSON.stringify({ pid: state.pid, requestedAt: Date.now() }));
    // Cooperative stop closes Chrome and records missing exits before ending the process.
    for (let i = 0; i < 100 && alive(state.pid); i++) await new Promise(r => setTimeout(r, 100));
    if (alive(state.pid)) {
      await verifyWorker(state);
      if (process.platform === 'win32') await exec('taskkill', ['/pid', String(state.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(state.pid, 'SIGTERM');
    }
    const current = read(controlFile, state);
    if (current.pid === state.pid) writeFileSync(controlFile, JSON.stringify({ ...current, status: 'stopped', stoppedAt: Date.now() }));
    log(`Worker ${state.pid} dihentikan.`); return true;
  }
  async function start() {
    await stop();
    const oldWorker = read(join(root, 'data', 'distribution-watch', 'worker-control.json'));
    if (alive(oldWorker?.pid)) throw new Error('Chrome profil research masih dipakai worker distribusi. Stop worker itu dahulu melalui dashboard lamanya.');
    const addresses = config().addresses;
    const stopFile = join(data, 'stop-request.json'); if (existsSync(stopFile)) unlinkSync(stopFile);
    const fd = openSync(join(data, 'worker.log'), 'a'); let child;
    const profileDir = process.env.PROFIT4_PROFILE_DIR ?? (existsSync(join(root, 'profiles', 'research-vps')) ? join(root, 'profiles', 'research-vps') : join(root, 'profiles', 'research-aria-tele01'));
    const profileName = process.env.PROFIT4_PROFILE_NAME ?? (existsSync(join(root, 'profiles', 'research-vps')) ? 'Default' : 'Profile 12');
    try { child = spawn(process.execPath, [join(root, 'scripts', 'run-profit4-watch.mjs'), '--addresses', addresses.join(','),
      '--profileDir', profileDir, '--profileName', profileName, '--pollMilliseconds', '500'],
      { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] }); } finally { closeSync(fd); }
    const record = { pid: child.pid, mode: 'profit4-watch', status: 'starting', startedAt: Date.now(), addresses, paperOnly: true, rounds: 1, run: null };
    writeFileSync(controlFile, JSON.stringify(record));
    child.on('error', error => {
      const current = read(controlFile, record); if (current.pid === child.pid) writeFileSync(controlFile, JSON.stringify({ ...current, status: 'failed', lastError: error.message }));
    });
    child.on('exit', code => {
      const current = read(controlFile, record);
      if (code && current.pid === child.pid && current.status !== 'stopped') writeFileSync(controlFile, JSON.stringify({ ...current, status: 'failed', lastError: current.lastError ?? `Worker keluar ${code}. Lihat worker.log.` }));
    });
    child.unref(); log(`Worker paper Profit4 dimulai, PID ${child.pid}.`); return record;
  }
  return createServer(async (req, res) => {
    try {
      const rawPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const path = rawPath.startsWith('/profit4') ? (rawPath.slice('/profit4'.length) || '/') : rawPath;
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'Origin tidak diizinkan.' });
      if (req.method === 'GET' && path === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(readFileSync(join(root, 'dist', 'profit4-dashboard.html')));
      if (req.method === 'GET' && path === '/api/state') {
        const current = read(controlFile), worker = current ? { ...current, active: alive(current.pid) } : { active: false, status: 'stopped' };
        const history = profit4Snapshot(root, worker);
        const historical = read(join(root, 'reports', 'distribution-profit-search', 'analysis.json'))?.bestKnownPnlDescriptive?.all ?? null;
        return json(res, 200, { mode: 'PROFIT4_PAPER', config: config(), worker, rules: { ...PROFIT4_RULES, targetPercent: PROFIT4_TARGET_PERCENT, trailingEnabled: false, flowExitEnabled: false, rounds: 1 },
          historical, ...history, logs, paths: { data, workerLog: join(data, 'worker.log') } });
      }
      if (req.method === 'POST' && ['/api/worker/start', '/api/worker/stop', '/api/wallets'].includes(path)) {
        if (transition) return json(res, 409, { error: 'Worker sedang start/stop. Tunggu sebentar.' });
        transition = true;
        try {
          if (path === '/api/wallets') {
            let b; try { b = await body(req); } catch (e) { return json(res, 400, { error: e.message }); }
            if (!Array.isArray(b.addresses) || b.addresses.some(a => typeof a !== 'string')) return json(res, 400, { error: 'addresses harus daftar wallet.' });
            const addresses = [...new Set(b.addresses.map(a => a.trim()).filter(Boolean))];
            if (!addresses.length || !addresses.every(validMint)) return json(res, 400, { error: 'Masukkan minimal satu wallet Solana yang valid.' });
            writeFileSync(configFile, JSON.stringify({ addresses, updatedAt: Date.now() }, null, 2));
            const worker = await start(); return json(res, 200, { addresses, worker, restarted: true });
          }
          return json(res, 200, path.endsWith('/start') ? await start() : { stopped: await stop() });
        } finally { transition = false; }
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) { return json(res, 500, { error: error instanceof Error ? error.message : String(error) }); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PROFIT4_DASHBOARD_PORT ?? 4178);
  const host = process.env.PROFIT4_DASHBOARD_HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port tidak valid.');
  const server = createProfit4Dashboard();
  server.on('error', e => { console.error(e.message); process.exitCode = 1; });
  server.listen(port, host, () => console.log(`Profit4 paper dashboard: http://${host}:${port}`));
}
