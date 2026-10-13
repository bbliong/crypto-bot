import { createServer } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFIT4_RULES, PROFIT4_TARGET_PERCENT } from '../src/distribution-profit4-lane.ts';
import { validMint } from '../src/parser.ts';
import { createProfit4Admin } from '../src/profit4-admin.ts';
import { readProfit4WalletBalance } from '../src/profit4-wallet-balance.ts';
import { LIVE_ACTIVE, readLiveState, readLiveConfig, saveLiveConfig, buysCompleted, commandId, sanitizeAudit } from '../src/profit4-live-store.ts';

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
  const positions = [], runs = [], recentEvents = [], recentEventsByRun = {};
  for (const dir of readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const state = read(join(base, dir.name, 'profit4-state.json'));
    if (!state?.positions) continue;
    const runPath = join(base, dir.name), current = worker.run && resolve(root, worker.run) === resolve(runPath);
    const live = current && worker.active;
    const manifest = read(join(runPath, 'manifest.json'), {});
    runs.push({ id: dir.name, observedAt: state.observedAt, current: Boolean(current), live: Boolean(live),
      startedAt: manifest.startedAt ?? null, execution: state.execution ?? null,
      rules: state.rules ?? null, targetPercent: state.targetPercent ?? null, paperLane: state.paperLane ?? null });
    for (const p of state.positions) {
      const interrupted = !live && ['OPEN', 'EXIT_PENDING'].includes(p.phase);
      positions.push({ ...p, run: dir.name, live: Boolean(live),
        phase: interrupted ? 'CENSORED' : p.phase, estimatedOpenNetPercent: live ? p.estimatedOpenNetPercent : null,
        netReturnPercent: interrupted || p.phase === 'CENSORED' ? null : p.netReturnPercent,
        pnlUsd: interrupted || p.phase === 'CENSORED' ? null : p.pnlUsd,
        lastEvent: interrupted ? { type: 'PAPER_EXIT_DATA_MISSING', reason: 'WORKER_ENDED_WITHOUT_EXIT', observedAt: state.observedAt } : p.lastEvent });
    }
    const runEvents = (state.recentEvents ?? []).map(e => ({ ...e, run: dir.name }));
    recentEventsByRun[dir.name] = runEvents;
    recentEvents.push(...runEvents);
  }
  function summarize(items) {
    const ent = items.filter(p => p.entryAt != null), cls = ent.filter(p => p.phase === 'CLOSED' && Number.isFinite(p.netReturnPercent));
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
  const v1Positions = positions.filter(p => (p.version || '').includes('v1') || p.laneLabel === 'V1' || (!p.laneLabel && !p.version?.includes('v2') && !p.version?.includes('v3') && !p.version?.includes('v4') && !p.version?.includes('v5')));
  const v2Positions = positions.filter(p => (p.version || '').includes('v2') || p.laneLabel === 'V2');
  const v3Positions = positions.filter(p => (p.version || '').includes('v3') || p.laneLabel === 'V3');
  const v4Positions = positions.filter(p => (p.version || '').includes('v4') || p.laneLabel === 'V4');
  const v5Positions = positions.filter(p => (p.version || '').includes('v5') || p.laneLabel === 'V5');
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
      const v1 = items.filter(p => (p.version || '').includes('v1') || p.laneLabel === 'V1' || (!p.laneLabel && !p.version?.includes('v2') && !p.version?.includes('v3') && !p.version?.includes('v4') && !p.version?.includes('v5')));
      const v2 = items.filter(p => (p.version || '').includes('v2') || p.laneLabel === 'V2');
      const v3 = items.filter(p => (p.version || '').includes('v3') || p.laneLabel === 'V3');
      const v4 = items.filter(p => (p.version || '').includes('v4') || p.laneLabel === 'V4');
      const v5 = items.filter(p => (p.version || '').includes('v5') || p.laneLabel === 'V5');
      const d = new Date(hour), endD = new Date(hour + 3600000);
      const dayStr = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit' });
      const startH = d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
      const endH = endD.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
      return {
        hourTimestamp: hour,
        label: `${dayStr} ${startH} - ${endH} WIB`,
        v1: summarize(v1),
        v2: summarize(v2),
        v3: summarize(v3),
        v4: summarize(v4),
        v5: summarize(v5),
        total: summarize(items),
      };
    });
  return { positions, runs, recentEventsByRun, recentEvents: recentEvents.sort((a, b) => b.observedAt - a.observedAt).slice(0, 60),
    summary: summarize(positions),
    summaryV1: summarize(v1Positions),
    summaryV2: summarize(v2Positions),
    summaryV3: summarize(v3Positions),
    summaryV4: summarize(v4Positions),
    summaryV5: summarize(v5Positions),
    hourlyComparison,
  };
}
export function createProfit4Dashboard({ root = defaultRoot, adminPassword } = {}) {
  const data = join(root, 'data', 'profit4-watch'), configFile = join(data, 'dashboard-config.json'), controlFile = join(data, 'worker-control.json');
  mkdirSync(data, { recursive: true });
  const seed = read(join(root, 'data', 'distribution-watch', 'dashboard-config.json'), {}).addresses;
  if (!existsSync(configFile)) writeFileSync(configFile, JSON.stringify({ addresses: Array.isArray(seed) && seed.length && seed.every(validMint) ? seed : defaults, updatedAt: new Date().toISOString() }, null, 2));
  const config = () => read(configFile, { addresses: defaults });
  const admin = createProfit4Admin(data, adminPassword);
  const liveStatus = () => {
    const state = readLiveState(data), config = readLiveConfig(data), current = read(controlFile);
    const fresh = current && alive(current.pid) && state.readiness.workerPid === current.pid && Date.now() - state.readiness.observedAt < 20000;
    return { config, readiness: { ...state.readiness, sessionReady: Boolean(fresh && state.readiness.sessionReady), error: fresh ? state.readiness.error : 'Worker real belum siap atau heartbeat kedaluwarsa.' },
      buysCompleted: buysCompleted(state, config), activePositions: state.positions.filter(p => LIVE_ACTIVE.has(p.status)).length, positions: state.positions };
  };
  const requireNoPositions = () => { if (readLiveState(data).positions.some(p => LIVE_ACTIVE.has(p.status))) throw Error('Masih ada posisi/order real. Matikan entry dan selesaikan posisi sebelum stop/restart.'); };
  const managedService = async () => {
    if (resolve(root) !== resolve(defaultRoot)) return null;
    const current = read(controlFile), snapshot = current?.run ? read(join(resolve(root, current.run), 'profit4-state.json')) : null;
    const name = process.env.PROFIT4_WORKER_SERVICE || (snapshot?.paperLane?.includes('bounce') ? 'crypto-bot-bounce-worker.service' : 'crypto-bot-profit4-worker.service');
    try { const { stdout } = await exec('systemctl', ['--user', 'show', name, '--property=LoadState,MainPID']);
      if (!stdout.includes('LoadState=loaded')) return null;
      const pid = Number(stdout.match(/MainPID=(\d+)/)?.[1] || 0);
      return (!pid || current?.pid === pid) ? name : null;
    } catch { return null; }
  };
  const logs = [];
  const log = message => { logs.unshift({ at: Date.now(), message }); logs.splice(50); };
  let transition = false;
  async function verifyWorker(state) {
    if (state.mode !== 'profit4-watch') throw new Error('PID ini bukan worker Profit4.');
    const runner = join(root, 'scripts', 'run-profit4-watch.mjs').replaceAll('\\', '/').toLowerCase();
    const { stdout } = process.platform === 'win32'
      ? await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}').CommandLine`], { windowsHide: true })
      : await exec('ps', ['-p', String(state.pid), '-o', 'args=']);
    const args = stdout.replaceAll('\\', '/').toLowerCase();
    if (!args.includes(runner) && !args.includes(join(root, 'scripts', 'run-bounce-watch.mjs').replaceAll('\\', '/').toLowerCase())) throw new Error('PID tidak cocok dengan worker project ini.');
  }
  async function stop() {
    requireNoPositions();
    const state = read(controlFile);
    if (!alive(state?.pid)) return false;
    await verifyWorker(state);
    const service = await managedService();
    if (service) { await exec('systemctl', ['--user', 'stop', service]); return true; }
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
    requireNoPositions();
    const service = await managedService();
    if (service) { await exec('systemctl', ['--user', 'restart', service]); return read(controlFile, { status: 'starting' }); }
    const previous = read(controlFile), previousState = previous?.run ? read(join(resolve(root, previous.run), 'profit4-state.json')) : null;
    await stop();
    const oldWorker = read(join(root, 'data', 'distribution-watch', 'worker-control.json'));
    if (alive(oldWorker?.pid)) throw new Error('Chrome profil research masih dipakai worker distribusi. Stop worker itu dahulu melalui dashboard lamanya.');
    const addresses = config().addresses;
    const stopFile = join(data, 'stop-request.json'); if (existsSync(stopFile)) unlinkSync(stopFile);
    const fd = openSync(join(data, 'worker.log'), 'a'); let child;
    const profileDir = process.env.PROFIT4_PROFILE_DIR ?? (existsSync(join(root, 'profiles', 'research-vps')) ? join(root, 'profiles', 'research-vps') : join(root, 'profiles', 'research-aria-tele01'));
    const profileName = process.env.PROFIT4_PROFILE_NAME ?? (existsSync(join(root, 'profiles', 'research-vps')) ? 'Default' : 'Profile 12');
    try { child = spawn(process.execPath, [join(root, 'scripts', previousState?.paperLane?.includes('bounce') ? 'run-bounce-watch.mjs' : 'run-profit4-watch.mjs'), '--addresses', addresses.join(','),
      '--profileDir', profileDir, '--profileName', profileName, '--pollMilliseconds', '1200', '--walletPollMilliseconds', '6000'],
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
      const url = new URL(req.url ?? '/', 'http://127.0.0.1'), rawPath = url.pathname;
      const path = rawPath.startsWith('/profit4') ? (rawPath.slice('/profit4'.length) || '/') : rawPath;
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) return json(res, 403, { error: 'Origin tidak diizinkan.' });
      if (req.method === 'GET' && path === '/api/admin') return json(res, 200, { authenticated: admin.authenticated(req) });
      if (req.method === 'POST' && path === '/api/admin/login') {
        try { const b = await body(req); admin.login(req, res, b.password); return json(res, 200, { authenticated: true }); }
        catch (e) { return json(res, 401, { error: e.message }); }
      }
      if (req.method === 'POST' && path === '/api/admin/logout') { admin.logout(req, res); return json(res, 200, { authenticated: true }); }
      const protectedRequest = (req.method === 'POST' && ['/api/autobuy','/api/worker/start','/api/worker/stop','/api/wallets'].includes(path)) ||
        path.startsWith('/api/real-trades') || path.startsWith('/api/real-positions/');
      if (protectedRequest && !admin.authenticated(req)) return json(res, 401, { error: 'Login admin untuk kontrol real dan audit transaksi.' });
      if (path === '/api/autobuy' && req.method === 'GET') { const live = liveStatus(); return json(res, 200, { ...live, positions: undefined, authenticated: admin.authenticated(req) }); }
      if (path === '/api/autobuy' && req.method === 'POST') {
        try {
          const patch = await body(req), live = liveStatus();
          if (transition && (patch.enabled ?? live.config.enabled)) return json(res,409,{error:'Worker sedang start/stop.'});
          if ((patch.enabled ?? live.config.enabled) === true && (!live.readiness.sessionReady || !live.readiness.activeLanes?.includes(patch.activeLane || live.config.activeLane))) return json(res, 409, { error: 'Sesi GMGN atau lane trading belum siap.' });
          const config = saveLiveConfig(data, patch); return json(res, 200, { config, ...liveStatus() });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (path === '/api/real-trades' && req.method === 'GET') {
        const scope = url.searchParams.get('run'), lane = url.searchParams.get('lane'), status = url.searchParams.get('status'), search = (url.searchParams.get('search') || '').toLowerCase();
        let items = readLiveState(data).positions.filter(p => (!scope || p.run === scope) && (!lane || p.lane === lane) && (!status || p.status === status) && (!search || `${p.symbol} ${p.mint}`.toLowerCase().includes(search)));
        items.sort((a,b) => b.createdAt-a.createdAt);
        const known = items.filter(p => p.status === 'CLOSED' && p.pnlUsd != null), summary = { knownClosed: known.length, pnlUsd: known.reduce((n,p)=>n+p.pnlUsd,0) };
        const activePositions = readLiveState(data).positions.filter(p => LIVE_ACTIVE.has(p.status)).map(({audit,rules,...p}) => sanitizeAudit(p));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 25))), total = items.length, pages = Math.max(1, Math.ceil(total/limit)), page = Math.min(pages, Math.max(1, Number(url.searchParams.get('page')) || 1));
        return json(res, 200, { total, page, pages, summary, activePositions, trades: items.slice((page-1)*limit,page*limit).map(({audit,rules,...p}) => sanitizeAudit(p)) });
      }
      const detail = path.match(/^\/api\/real-trades\/([a-f0-9]{64})$/);
      if (detail && req.method === 'GET') { const p = readLiveState(data).positions.find(p=>p.id===detail[1]); return json(res,p?200:404,p?sanitizeAudit(p):{error:'Transaksi tidak ditemukan.'}); }
      const reconcile = path.match(/^\/api\/real-positions\/([a-f0-9]{64})\/reconcile$/);
      if (reconcile && req.method === 'POST') {
        try {
          const b = await body(req), state = readLiveState(data), p = state.positions.find(p => p.id === reconcile[1]);
          const pending = p && [...p.buys,...p.sells].find(o => ['SUBMITTING','SUBMITTED','UNKNOWN'].includes(o.status));
          if (!pending) return json(res,409,{error:'Tidak ada order yang perlu dikonfirmasi.'});
          if (typeof b.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(b.signature)) return json(res,400,{error:'Signature Solana tidak valid.'});
          if (state.positions.some(v => [...v.buys,...v.sells].some(o => o !== pending && o.hash === b.signature))) return json(res,409,{error:'Signature sudah dipakai oleh order lain.'});
          const id = commandId(p.id, 'reconcile-'+b.signature), commands = join(data,'real-commands'); mkdirSync(commands,{recursive:true});
          try { writeFileSync(join(commands,id+'.json'),JSON.stringify({type:'RECONCILE',positionId:p.id,signature:b.signature,requestedAt:Date.now()}),{flag:'wx',mode:0o600}); } catch(e) { if(e.code!=='EEXIST')throw e; }
          return json(res,202,{queued:true,commandId:id});
        } catch(e) { return json(res,400,{error:e.message}); }
      }
      const sell = path.match(/^\/api\/real-positions\/([a-f0-9]{64})\/sell$/);
      if (sell && req.method === 'POST') {
        try {
          const b = await body(req), p = readLiveState(data).positions.find(p => p.id === sell[1]);
          if (!p || !LIVE_ACTIVE.has(p.status)) return json(res, 409, { error: 'Posisi sudah selesai atau tidak ditemukan.' });
          if (!['HOLDING','BUY_PENDING','UNKNOWN'].includes(p.status)) return json(res, 409, { error: 'SELL sudah pending.' });
          if (typeof b.idempotencyKey !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(b.idempotencyKey)) return json(res,400,{error:'Idempotency key tidak valid.'});
          const id = commandId(p.id, b.idempotencyKey), commands = join(data,'real-commands'); mkdirSync(commands,{recursive:true});
          try { writeFileSync(join(commands,id+'.json'),JSON.stringify({ positionId:p.id, requestedAt:Date.now() }),{flag:'wx',mode:0o600}); } catch(e) { if(e.code!=='EEXIST')throw e; }
          return json(res,202,{queued:true,commandId:id});
        } catch(e) { return json(res,400,{error:e.message}); }
      }
      if (['GET', 'HEAD'].includes(req.method) && (path === '/' || path === '/dashboard')) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? '' : readFileSync(join(root, 'dist', 'profit4-dashboard.html')));
      if (['GET', 'HEAD'].includes(req.method) && (path === '/comparison' || path === '/v1-vs-v4' || rawPath === '/comparison')) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? '' : readFileSync(join(root, 'dist', 'profit4-v1-vs-v4.html')));
      if (['GET', 'HEAD'].includes(req.method) && (path === '/audit' || rawPath === '/audit' || path === '/audit-dashboard')) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? '' : readFileSync(join(root, 'dist', 'profit4-audit-dashboard.html')));
      if (['GET', 'HEAD'].includes(req.method) && (path === '/api/comparison-v1-v4' || path === '/comparison-v1-v4.json')) {
        const compPath = join(data, 'comparison-v1-v4.json');
        if (existsSync(compPath)) return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? '' : readFileSync(compPath));
        return json(res, 200, []);
      }
      if (['GET', 'HEAD'].includes(req.method) && (path === '/api/audit-data' || path === '/audit-cache.json')) {
        const cachePath = join(data, 'audit-cache.json');
        if (existsSync(cachePath)) return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? '' : readFileSync(cachePath));
        return json(res, 200, []);
      }
      if (req.method === 'GET' && path === '/api/state') {
        const current = read(controlFile), worker = current ? { ...current, active: alive(current.pid) } : { active: false, status: 'stopped' };
        const history = profit4Snapshot(root, worker);
        const historical = read(join(root, 'reports', 'distribution-profit-search', 'analysis.json'))?.bestKnownPnlDescriptive?.all ?? null;
        const live = liveStatus();
        if (live.readiness.wallet) Object.assign(live.readiness, await readProfit4WalletBalance(live.readiness.wallet));
        return json(res, 200, { mode: 'PROFIT4_PAPER', admin: { authenticated: admin.authenticated(req) }, autoBuy: { ...live, positions: undefined }, config: config(), worker, rules: { ...PROFIT4_RULES, targetPercent: PROFIT4_TARGET_PERCENT, trailingEnabled: false, flowExitEnabled: false, rounds: 1 },
          historical, ...history, logs, paths: { data, workerLog: join(data, 'worker.log') } });
      }
      if (req.method === 'POST' && ['/api/worker/start', '/api/worker/stop', '/api/wallets'].includes(path)) {
        if (transition) return json(res, 409, { error: 'Worker sedang start/stop. Tunggu sebentar.' });
        transition = true;
        try {
          saveLiveConfig(data, {enabled:false});
          if (path === '/api/wallets') {
            requireNoPositions();
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
