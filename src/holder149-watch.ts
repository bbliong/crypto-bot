import { chromium, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeFrame, validMint } from './parser.js';
import { BuySellCaptureStorage } from './buy-sell-capture-storage.js';
import { CohortCursor, Holder149Engine, type CohortDetail, type CohortEvent } from './holder149-engine.js';
import { prepareHolder149Profile } from './holder149-profile.js';

export type Holder149Options = { walletsFile: string; dataDir: string; profileDir: string; profileName: string; batchMilliseconds: number };
export function loadHolder149Wallets(file: string): string[] {
  const { addresses } = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(addresses) || addresses.length !== 149 || addresses.some(address => !validMint(address)) || new Set(addresses).size !== 149)
    throw new Error('Konfigurasi harus memuat tepat 149 wallet Solana unik.');
  return addresses;
}
export async function runHolder149Watch(options: Holder149Options) {
  const wallets = loadHolder149Wallets(options.walletsFile);
  const dataRoot = resolve(options.dataDir), controlFile = join(dataRoot, 'worker-control.json'), stopFile = join(dataRoot, 'stop-request.json');
  try {
    const old = JSON.parse(readFileSync(controlFile, 'utf8'));
    if (old.pid !== process.pid && Number.isSafeInteger(old.pid) && old.pid > 0) {
      let alive = false; try { process.kill(old.pid, 0); alive = true; } catch {}
      if (alive) throw new Error('Worker holder149 sebelumnya masih aktif.');
    }
  } catch (error) { if (String(error).includes('sebelumnya masih aktif')) throw error; }
  const startedAt = new Date().toISOString(), run = join(dataRoot, startedAt.replace(/[:.]/g, '-'));
  mkdirSync(run, { recursive: true });
  const storage = new BuySellCaptureStorage(run);
  const cursor = new CohortCursor(wallets, 3);
  const resources = new Map<string, { page: Page; pending: Array<{ socket: string; body: unknown; observedAt: number }> }>();
  const pendingPages = new Map<string, Promise<Page>>();
  const metrics = { batches: 0, requests: 0, successfulRequests: 0, errors: 0, rateLimits: 0,
    opened: 0, soldSignals: 0, skippedCapacity: 0, frames: 0 };
  const events: CohortEvent[] = [];
  const finished: Record<string, unknown>[] = [];
  let status = 'starting', stopping = false, lastError: string | null = null, retryAt: string | null = null;
  let lastBatch: string[] = [], lastBatchAt: string | null = null, lastPollAt: string | null = null;
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const abort = new AbortController();
  const metadata = { mode: 'holder149-watch', pid: process.pid, startedAt, run, addresses: wallets,
    batchSize: 3, batchMilliseconds: options.batchMilliseconds, maxDetails: 3, maxTabs: 4,
    profileDir: options.profileDir, profileName: options.profileName, walletsFile: resolve(options.walletsFile),
    simulationEnabled: false, activityResponsesSaved: false, captureChunkMinutes: 30 };
  function control() {
    const temp = `${controlFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...metadata, status, stopping, updatedAt: new Date().toISOString(),
      lastError, retryAt, lastBatch, lastBatchAt, lastPollAt, nextIndex: cursor.index, round: cursor.round,
      metrics, details: engine.snapshot(), finished, events }, null, 2));
    renameSync(temp, controlFile);
  }
  function event(value: CohortEvent) {
    if (value.type === 'TOKEN_DETAIL_OPENED') metrics.opened++;
    if (value.type === 'BUY_SKIPPED_CAPACITY') metrics.skippedCapacity++;
    if (value.type === 'TRACKED_WALLET_SOLD') {
      metrics.soldSignals++;
      // No separate Buy/Sell activity log: just compact lifecycle metadata.
      finished.unshift({ observedAt: value.observedAt, wallet: value.wallet, mint: value.mint,
        symbol: (value.buy as { symbol?: string })?.symbol, reason: 'wallet_sold', source: value.source });
      finished.length = Math.min(finished.length, 20);
    }
    const { sell: _sell, ...small } = value;
    events.unshift(small);
    events.length = Math.min(events.length, 40);
    if (value.type.includes('FAILED')) lastError = String(value.error);
    control();
  }
  function receive(detail: CohortDetail, frame: { socket: string; body: unknown; observedAt: number }) {
    if (engine.details.get(detail.mint) !== detail || detail.phase !== 'tracking' || stopping) return;
    storage.write('websocket-frames.jsonl', { ...frame, direction: 'received', role: 'token_detail',
      detailId: detail.id, mint: detail.mint, trackedWallets: [...detail.watchers.keys()] });
    metrics.frames++;
    // The entire Sell-bearing packet is persisted before closing the tab.
    void engine.socket(detail, frame.body).catch(error => { lastError = String(error); control(); });
  }
  const engine = new Holder149Engine({ event,
    open: async detail => {
      const creating = context!.newPage();
      pendingPages.set(detail.id, creating);
      const page = await creating;
      if (stopping || detail.phase === 'closing') throw new Error('Pembukaan detail dibatalkan.');
      const resource = { page, pending: [] as Array<{ socket: string; body: unknown; observedAt: number }> };
      resources.set(detail.id, resource);
      page.on('close', () => { resources.delete(detail.id); pendingPages.delete(detail.id); engine.pageClosed(detail); });
      page.on('websocket', socket => {
        const endpoint = new URL(socket.url());
        socket.on('framereceived', ({ payload }) => {
          if (engine.details.get(detail.mint) !== detail || detail.phase === 'closing' || stopping) return;
          const decoded = decodeFrame(payload);
          const frame = { observedAt: Date.now(), socket: endpoint.origin + endpoint.pathname,
            body: decoded ?? { undecodable: true } };
          if (detail.phase === 'opening') {
            if (resource.pending.length >= 1000) { lastError = 'Buffer socket pembukaan detail penuh; menutup detail agar data tidak dianggap lengkap.'; void page.close(); return; }
            resource.pending.push(frame);
          } else receive(detail, frame);
        });
      });
      await page.goto(`https://gmgn.ai/sol/token/${detail.mint}`, { waitUntil: 'commit', timeout: 30_000 });
      if (page.isClosed()) throw new Error('Detail tertutup saat navigasi.');
    },
    ready: detail => {
      const resource = resources.get(detail.id);
      for (const frame of resource?.pending.splice(0) ?? []) receive(detail, frame);
    },
    close: async detail => {
      const page = resources.get(detail.id)?.page ?? await pendingPages.get(detail.id)?.catch(() => undefined);
      if (page && !page.isClosed()) await page.close();
      resources.delete(detail.id);
      pendingPages.delete(detail.id);
    },
  });
  const stop = () => { if (stopping) return; stopping = true; engine.stopping = true; abort.abort(); void context?.close().catch(() => {}); };
  const stopRequested = () => {
    try { return JSON.parse(readFileSync(stopFile, 'utf8')).pid === process.pid; } catch { return false; }
  };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  control();
  writeFileSync(join(run, 'manifest.json'), JSON.stringify({ ...metadata,
    execution: 'READ_ONLY', purpose: '149 historical holder candidates; 3 parallel activity GETs per batch, max 3 unique token details. Newest unfiltered Buy only. No activity response storage; socket detail frames only.' }, null, 2));
  try {
    if (resolve(options.profileDir) === resolve('profiles/holder149-watch') && options.profileName === 'Profile 12') await prepareHolder149Profile();
    else mkdirSync(options.profileDir, { recursive: true });
    context = await chromium.launchPersistentContext(options.profileDir, { channel: 'chrome', headless: false, viewport: null,
      args: ['--start-maximized', `--profile-directory=${options.profileName}`] });
    const controller = context.pages()[0] ?? await context.newPage();
    for (const page of context.pages()) if (page !== controller) await page.close();
    await controller.goto(`https://gmgn.ai/sol/address/${wallets[0]}`, { waitUntil: 'commit', timeout: 30_000 });
    status = 'running'; control();
    console.log(`Holder149 ready: ${wallets.length} wallets, batch 3 / ${options.batchMilliseconds}ms, max 3 details; ${run}`);
    let backoff = 0;
    while (!stopping && !controller.isClosed() && !stopRequested()) {
      const batchStart = Date.now(), batch = cursor.next();
      lastBatch = batch.wallets; lastBatchAt = new Date(batchStart).toISOString(); metrics.batches++;
      control();
      let rateLimited = false;
      await Promise.all(batch.wallets.map(async wallet => {
        metrics.requests++;
        try {
          const query = new URLSearchParams({ wallet, limit: '100', cost: 'usd' });
          const body = await controller.evaluate(async url => {
            const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15_000) });
            if (!response.ok) throw new Error(`GMGN HTTP ${response.status}`);
            const body = await response.json();
            if (body.code != null && Number(body.code) !== 0) throw new Error(`GMGN API: ${body.msg ?? body.message ?? body.code}`);
            if (!Array.isArray(body?.data?.activities)) throw new Error('Activities tidak tersedia. Periksa login profil holder149.');
            return body;
          }, `/vas/api/v1/wallet_activity/sol?${query}`);
          metrics.successfulRequests++; lastPollAt = new Date().toISOString();
          await engine.activity(wallet, body);
          // body is deliberately not written, logged or retained.
        } catch (error) {
          if (stopping || controller.isClosed()) return;
          metrics.errors++;
          lastError = error instanceof Error ? error.message : String(error);
          if (lastError.includes('HTTP 429')) { rateLimited = true; metrics.rateLimits++; }
          events.unshift({ type: 'ACTIVITY_ERROR', observedAt: Date.now(), wallet, error: lastError });
          events.length = Math.min(events.length, 40);
        }
      }));
      if (stopping || controller.isClosed() || stopRequested()) break;
      backoff = rateLimited ? Math.min(60_000, backoff ? backoff * 2 : 15_000) : 0;
      const wait = backoff || Math.max(0, options.batchMilliseconds - (Date.now() - batchStart));
      retryAt = backoff ? new Date(Date.now() + wait).toISOString() : null;
      control();
      const until = Date.now() + wait;
      while (Date.now() < until && !stopping && !stopRequested())
        await delay(Math.min(1000, until - Date.now()), undefined, { signal: abort.signal }).catch(() => {});
    }
    status = 'stopped';
  } catch (error) {
    status = stopping ? 'stopped' : 'failed';
    if (!stopping) { lastError = String(error); console.error(lastError); process.exitCode = 1; }
  } finally {
    stopping = true; engine.stopping = true;
    await context?.close().catch(() => {});
    await engine.shutdown(); storage.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    try { if (JSON.parse(readFileSync(controlFile, 'utf8')).pid === process.pid) control(); } catch {}
    if (stopRequested() && existsSync(stopFile)) rmSync(stopFile);
  }
}
export async function main() {
  const { values } = parseArgs({ options: {
    walletsFile: { type: 'string', default: 'config/holder149-wallets.json' },
    dataDir: { type: 'string', default: 'data/holder149-watch' },
    profileDir: { type: 'string', default: 'profiles/holder149-watch' },
    profileName: { type: 'string', default: 'Profile 12' },
    batchMilliseconds: { type: 'string', default: '3000' },
  } });
  const batchMilliseconds = Number(values.batchMilliseconds);
  if (!Number.isInteger(batchMilliseconds) || batchMilliseconds < 3000) throw new Error('Jeda batch minimal 3000ms.');
  await runHolder149Watch({ walletsFile: values.walletsFile!, dataDir: values.dataDir!, profileDir: values.profileDir!, profileName: values.profileName!, batchMilliseconds });
}
