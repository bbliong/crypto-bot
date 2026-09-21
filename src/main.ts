import { chromium, type BrowserContext, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { attachCapture, type CaptureEvent } from './capture.js';
import { parseCandidates, parseTokenMetadata, validMint } from './parser.js';
import { parseTokenActivities } from './activity.js';
import { Store } from './store.js';
import { CandidateQueue } from './queue.js';
import { evaluate } from './risk.js';
import { verifyMint } from './solana.js';
import { writeReport } from './report.js';
import { writeDashboardData } from './dashboard-data.js';
import type { Candidate, Report } from './model.js';

const { values } = parseArgs({ options: {
  probe: { type: 'boolean' }, config: { type: 'string', default: 'config/rules.yaml' },
  seconds: { type: 'string' }, cdpUrl: { type: 'string' }, keepOpen: { type: 'boolean' }, inspect: { type: 'boolean' }, token: { type: 'string' }, detailOnly: { type: 'boolean' },
} });
const config = loadConfig(values.config);
if (values.probe) config.mode = 'observation';
const seconds = values.seconds === undefined ? undefined : Number(values.seconds);
if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error('--seconds must be positive');
if (values.token && !validMint(values.token)) throw new Error('--token must be a valid Solana mint');
if (values.detailOnly && !values.token) throw new Error('--detailOnly requires --token');
if (values.cdpUrl) {
  const endpoint = new URL(values.cdpUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('--cdpUrl must be a local HTTP endpoint');
}

const store = new Store();
const queue = new CandidateQueue(config.queueCapacity, config.candidateTtlMs);
const stopping = new AbortController();
const fingerprints = new Map<string, string>();
const sentToFomo = new Set<string>();
const rpcActive = new Set<string>();
const inspected = new Set<string>();
let context: BrowserContext | undefined;
let ownsContext = false;
let spawnedChrome: ChildProcess | undefined;
let fomoPage: Page | undefined;
let frames = 0, received = 0, socketsOpened = 0, activeSockets = 0, invalid = 0, candidateUpdates = 0;
let blocked = false;
let outputTimer: ReturnType<typeof setInterval> | undefined;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
const stop = () => stopping.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);

function writeStatus() {
  mkdirSync('reports', { recursive: true });
  const payload = { capturedAt: new Date().toISOString(), source: values.cdpUrl ? 'playwright-cdp' : 'playwright-launch',
    mode: config.mode, socketsOpened, activeSockets, frames, received, invalid, candidateUpdates, blocked, schemas: store.schemas() };
  writeFileSync('reports/live-status.json', JSON.stringify(payload, null, 2));
  writeDashboardData(store.db);
  return payload;
}
async function loadCookieFile(file: string | undefined, allowedDomain: string) {
  if (!file || !existsSync(file)) return 0;
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain a cookie array`);
  const cookies = parsed.filter((item): item is Record<string, unknown> => {
    if (!item || typeof item !== 'object') return false;
    const cookie = item as Record<string, unknown>;
    return typeof cookie.name === 'string' && typeof cookie.value === 'string' &&
      typeof cookie.domain === 'string' && cookie.domain.replace(/^\./, '').endsWith(allowedDomain);
  }).map(cookie => ({
    name: cookie.name as string, value: cookie.value as string, domain: cookie.domain as string,
    path: typeof cookie.path === 'string' ? cookie.path : '/',
    ...(typeof cookie.expires === 'number' ? { expires: cookie.expires } : {}),
    ...(typeof cookie.httpOnly === 'boolean' ? { httpOnly: cookie.httpOnly } : {}),
    ...(typeof cookie.secure === 'boolean' ? { secure: cookie.secure } : {}),
    ...(typeof cookie.sameSite === 'string' && ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? { sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None' } : {}),
  }));
  await context!.addCookies(cookies);
  return cookies.length;
}
function recordCapture(event: CaptureEvent) {
  store.capture(event);
  if (event.kind === 'open') { socketsOpened++; activeSockets++; }
  if (event.kind === 'close') activeSockets = Math.max(0, activeSockets - 1);
  if (event.kind === 'invalid') invalid++;
  if (event.kind === 'frame') { frames++; if (event.direction === 'received') received++; }
}
function attach(page: Page, feed: boolean) {
  attachCapture(page, recordCapture, (payload, now, source) => {
    if (stopping.signal.aborted || blocked) return;
    for (const activity of parseTokenActivities(payload, now)) store.activity(activity);
    for (const meta of parseTokenMetadata(payload)) {
      const candidate = store.get(meta.mint);
      if (candidate) store.merge({ mint: meta.mint, firstSeenAt: candidate.firstSeenAt, updatedAt: now, fields: {}, metadata: meta.metadata });
    }
    if (values.inspect) inspectPayload(payload);
    for (const update of parseCandidates(payload, config.mappings, now, source)) {
      // Detail pages may update only their own previously discovered token.
      // Do not let their global broadcasts create a second discovery stream.
      if (!feed && !store.get(update.mint)) continue;
      candidateUpdates++;
      const candidate = store.merge(update);
      const fast = evaluate(candidate, config, now, false);
      if (fast.status === 'REJECT' || fast.status === 'INSUFFICIENT_EVIDENCE') store.report(fast);
      if (!feed) continue;
      // Phase 1 fields are all delivered by the feed WebSocket.  Opening a
      // token page is reserved for a passing token, whose trader activity is
      // then kept alive in the active monitoring slot.
      const feedChecks = new Set(['age', 'holders', 'liquidityUsd', 'top10Percent']);
      const passesFeedScreen = fast.checks.filter(check => feedChecks.has(check.name)).every(check => check.status === 'PASS');
      const shouldInspect = config.phase === 1 ? passesFeedScreen : true;
      if (shouldInspect && !inspected.has(candidate.mint)) {
        inspected.add(candidate.mint);
        if (queue.push(candidate.mint, now) === 'full') store.event('QUEUE_FULL', { mint: candidate.mint });
      }
    }
  });
  page.on('response', response => {
    let url: URL; try { url = new URL(response.url()); } catch { return; }
    if (url.hostname.endsWith('gmgn.ai') && [401, 403, 429].includes(response.status())) {
      blocked = true;
      store.event('BLOCKED_AUTH', { status: response.status() });
      console.log('BLOCKED_AUTH: GMGN menolak akses. Otomasi dihentikan tanpa bypass.');
    }
  });
}
function inspectPayload(payload: unknown) {
  const frame = payload as { channel?: unknown; data?: unknown };
  if (frame.channel === 'token_stat' && Array.isArray(frame.data)) {
    for (const item of frame.data) {
      const stat = item as Record<string, unknown>;
      // These are public market-stat fields only.  Their semantics are logged
      // for verification before a drawdown rule is enabled.
      console.log(JSON.stringify({ inspect: 'token_stat', chain: stat.n, mint: stat.a,
        price: stat.p, price1m: stat.p1m, price5m: stat.p5m, price1h: stat.p1h,
        buys1m: stat.b1m, sells1m: stat.s1m }));
    }
  }
  if (frame.channel !== 'public_broadcast' || !Array.isArray(frame.data)) return;
  for (const item of frame.data) {
    const event = item as { et?: unknown; ed?: { c?: unknown; d?: Record<string, unknown> } };
    if (event.et !== 'signal' || !event.ed?.d) continue;
    const d = event.ed.d;
    // Public token fields only; excludes the event id and all session/credential data.
    console.log(JSON.stringify({ inspect: 'public_broadcast.signal', chain: event.ed.c,
      mint: d.a, created: d.ct, holders: d.hd, liquidity: d.lq, marketCap: d.mc,
      buys1m: d.b1m, sells1m: d.s1m, top10: d.t10, bundle: d.btp, dev: d.bdrr }));
  }
}
async function goto(page: Page, url: string) {
  // GMGN is an app shell with long-running resources. Waiting for
  // DOMContentLoaded can leave a newly launched profile on about:blank even
  // though navigation and the WebSocket have already started. Commit is
  // enough for capture; the page itself continues loading normally.
  await page.goto(url, { waitUntil: 'commit', timeout: config.workerTimeoutMs });
  await delay(750);
  if (/just a moment|attention required|verify you are human|access denied/i.test(await page.title())) {
    blocked = true; store.event('BLOCKED_AUTH', { reason: 'challenge' });
    console.log('BLOCKED_AUTH: challenge terdeteksi. Selesaikan sendiri di Chrome lalu jalankan ulang.');
  }
}
async function launchExistingChromeProfile() {
  const userDataDir = config.browserUserDataDir!;
  const profile = config.browserProfileDirectory || 'Default';
  const port = config.browserRemoteDebuggingPort || 9222;
  const chromePath = process.env.LOCALAPPDATA ? `${process.env.PROGRAMFILES || 'C:/Program Files'}/Google/Chrome/Application/chrome.exe` : 'chrome.exe';
  spawnedChrome = spawn(chromePath, [
    `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check', '--start-maximized',
    `--user-data-dir=${userDataDir}`, `--profile-directory=${profile}`, 'about:blank',
  ], { detached: false, stdio: 'ignore', windowsHide: false });
  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return chromium.connectOverCDP(endpoint);
    } catch { /* Chrome is still starting */ }
    await delay(500);
  }
  throw new Error(`Chrome CDP tidak siap pada ${endpoint}`);
}
async function routeToFomo(report: Report) {
  if (config.mode !== 'manual' || report.status !== 'ENTRY_READY' || sentToFomo.has(report.mint) || !config.fomoUrlTemplate || blocked) return;
  const latest = store.get(report.mint);
  if (!latest || evaluate(latest, config).status !== 'ENTRY_READY') return;
  sentToFomo.add(report.mint);
  fomoPage ??= await context!.newPage();
  await goto(fomoPage, config.fomoUrlTemplate.replaceAll('{mint}', report.mint));
  console.log(`\u0007ENTRY_READY — Fomo dibuka: ${report.mint}`);
}
function reportCandidate(candidate: Candidate) {
  const report = evaluate(candidate, config);
  const fingerprint = JSON.stringify([report.status, report.checks.map(check => [check.name, check.status])]);
  if (fingerprints.get(candidate.mint) !== fingerprint) {
    fingerprints.set(candidate.mint, fingerprint);
    store.report(report); writeReport(report);
  }
  return report;
}
async function worker(index: number) {
  const page = await context!.newPage();
  attach(page, false);
  while (!stopping.signal.aborted) {
    const mint = blocked ? undefined : queue.take();
    if (!mint) { await delay(150, undefined, { signal: stopping.signal }).catch(() => {}); continue; }
    try {
      // The dashboard follows the token currently open in this detail tab,
      // even before it is accepted for the longer active-monitor window.
      store.event('DETAIL_INSPECT', { mint, until: Date.now() + config.activeMonitorSeconds * 1000 });
      await goto(page, config.tokenUrlTemplate.replaceAll('{mint}', mint));
      if (blocked) continue;
      if (!store.get(mint)) continue;
      if (process.env.SOLANA_RPC_URL && !rpcActive.has(mint)) {
        rpcActive.add(mint);
        try { store.merge(await verifyMint(mint, process.env.SOLANA_RPC_URL, stopping.signal)); }
        catch { store.event('RPC_UNAVAILABLE', { mint }); }
        finally { rpcActive.delete(mint); }
      }
      // Token stats can arrive a few seconds after navigation.  Wait only
      // until the current and historical reference prices are available, or
      // until the configured timeout expires.
      const deadline = Date.now() + config.workerTimeoutMs;
      while (!stopping.signal.aborted && !blocked && Date.now() < deadline) {
        const latest = store.get(mint);
        if (latest?.fields.priceUsd && latest.fields.price1mUsd && latest.fields.price5mUsd && latest.fields.price1hUsd) break;
        await delay(250, undefined, { signal: stopping.signal }).catch(() => {});
      }
      const current = store.get(mint);
      if (current && !blocked && !stopping.signal.aborted) {
        const report = reportCandidate(current);
        await routeToFomo(report);
        if (report.status === 'ENTRY_READY') {
          store.event('ACTIVE_MONITOR', { mint, until: Date.now() + config.activeMonitorSeconds * 1000 });
          // Keep this tab and its WebSocket alive.  The next queue item is not
          // opened until this configured monitoring window ends.
          await delay(config.activeMonitorSeconds * 1000, undefined, { signal: stopping.signal }).catch(() => {});
        }
      }
    } catch {
      if (!stopping.signal.aborted) store.event('WORKER_ERROR', { worker: index, mint });
    } finally { queue.done(mint); }
  }
  await page.close().catch(() => {});
}

try {
  const initialUrl = values.detailOnly && values.token ? config.tokenUrlTemplate.replaceAll('{mint}', values.token) : config.feedUrl;
  let feed: Page;
  if (values.cdpUrl) {
    const browser = await chromium.connectOverCDP(values.cdpUrl);
    context = browser.contexts()[0];
    if (!context) throw new Error('No browser context at CDP endpoint');
    feed = context.pages().find(page => {
      try { return /(^|\.)gmgn\.ai$/.test(new URL(page.url()).hostname); } catch { return false; }
    }) ?? await context.newPage();
    attach(feed, true);
  } else {
    const userDataDir = config.browserUserDataDir || 'profiles/gmgn';
    if (config.browserUserDataDir && !existsSync(config.browserUserDataDir)) {
      throw new Error(`Chrome user-data directory tidak ditemukan: ${config.browserUserDataDir}`);
    }
    const args = ['--start-maximized'];
    if (config.browserProfileDirectory) args.push(`--profile-directory=${config.browserProfileDirectory}`);
    console.log(`PLAYWRIGHT launching profile ${config.browserProfileDirectory || 'default'} at ${userDataDir}`);
    if (config.browserUserDataDir && config.browserRemoteDebuggingPort) {
      const browser = await launchExistingChromeProfile();
      context = browser.contexts()[0];
      if (!context) throw new Error('Chrome CDP context tidak tersedia');
    } else {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: config.browserChannel || undefined, headless: false, viewport: null, args,
      });
      ownsContext = true;
    }
    console.log('PLAYWRIGHT profile launched');
    feed = context.pages()[0] ?? await context.newPage();
    attach(feed, true);
  }
  await loadCookieFile(config.gmgnCookiesFile, 'gmgn.ai');
  await loadCookieFile(config.fomoCookiesFile, 'fomo.family');
  console.log(`PLAYWRIGHT navigating feed ${initialUrl}`);
  // Reload the feed after cookies are installed so the first requests use the
  // authenticated session. Cookie values are never logged.
  if (values.detailOnly || !values.cdpUrl || !/gmgn\.ai/.test(feed.url())) await goto(feed, initialUrl);
  console.log(`PLAYWRIGHT feed ready ${feed.url()}`);
  console.log(`PLAYWRIGHT ${values.cdpUrl ? 'attached to existing Chrome' : 'launched Chrome'}; profile=${config.browserProfileDirectory || 'default'}; mode=${config.mode}; mappings=${config.mappings.length}; workers=${config.workers}`);
  if (values.token) {
    const now = Date.now();
    store.merge({ mint: values.token, firstSeenAt: now, updatedAt: now, fields: {} });
    inspected.add(values.token);
    if (!values.detailOnly) queue.push(values.token, now);
  }
  const workers = values.probe || values.detailOnly ? [] : Array.from({ length: config.workers }, (_, index) => worker(index + 1));
  outputTimer = setInterval(() => {
    const status = writeStatus();
    console.log(JSON.stringify({ capturedAt: status.capturedAt, activeSockets, socketsOpened, frames, received, candidateUpdates, blocked }));
  }, 10_000);
  if (seconds) stopTimer = setTimeout(stop, seconds * 1000);
  await new Promise<void>(resolve => stopping.signal.addEventListener('abort', () => resolve(), { once: true }));
  await Promise.allSettled(workers);
} finally {
  stopping.abort();
  if (outputTimer) clearInterval(outputTimer);
  if (stopTimer) clearTimeout(stopTimer);
  const final = writeStatus();
  writeFileSync('reports/probe-summary.json', JSON.stringify(final, null, 2));
  if (ownsContext && !values.keepOpen) await context?.close().catch(() => {});
  store.close();
}
