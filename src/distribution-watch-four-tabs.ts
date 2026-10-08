import { chromium, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeFrame } from './parser.js';
import { fetchWalletActivityPair } from './wallet-activity-poll.js';
import { LOG_CHUNK_MS, RotatingJsonlWriter } from './rotating-jsonl.js';
import { DistributionTargetRuntime } from './distribution-target-runtime.js';
import { DistributionProfit4Runtime, atomicProfit4Json } from './distribution-profit4-runtime.js';

type Transfer = { wallet: string; mint: string; symbol?: string; timestamp?: number; priceUsd?: number; amount?: string; from?: string; tx?: string };
type Watch = { transfer: Transfer };
const defaults = ['5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT', '3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD', '2dVDVvzH4D3ihpUTbiG9yNSEsQBs8iFNRifcZP6TLqVK'];
const { values } = parseArgs({ options: { addresses: { type: 'string', default: defaults.join(',') }, pollMilliseconds: { type: 'string', default: '500' }, profileDir: { type: 'string', default: 'profiles/research-vps' }, profileName: { type: 'string', default: 'Default' }, paperLane: { type: 'string', default: 'target' }, dataDir: { type: 'string', default: 'data/distribution-watch' } } });
if (!['target', 'profit4', 'bounce'].includes(values.paperLane!)) throw new Error('paperLane tidak valid.');
const isPaperRunner = values.paperLane === 'profit4' || values.paperLane === 'bounce';
const profit4 = isPaperRunner;
const addresses = [...new Set(values.addresses!.split(',').map(x => x.trim()).filter(Boolean))];
const pollMilliseconds = Number(values.pollMilliseconds);
if (!addresses.length || addresses.some(x => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x))) throw new Error('Harus ada minimal satu address wallet Solana yang valid.');
if (!Number.isFinite(pollMilliseconds) || pollMilliseconds < 250) throw new Error('--pollMilliseconds minimal 250.');
if (!existsSync(values.profileDir!)) throw new Error('Profile Chrome research tidak ditemukan.');
const maxDetails = addresses.length;

const dataDirectory = values.dataDir!;
const output = join(dataDirectory, new Date().toISOString().replace(/[:.]/g, '-'));
const controlFile = join(dataDirectory, 'worker-control.json');
const stopFile = join(dataDirectory, 'stop-request.json');
const writeControl = (value: unknown) => profit4 ? atomicProfit4Json(controlFile, value) : writeFileSync(controlFile, JSON.stringify(value, null, 2));
mkdirSync(output, { recursive: true });
if (profit4 && existsSync(controlFile)) {
  const previous = JSON.parse(readFileSync(controlFile, 'utf8'));
  if (previous.pid !== process.pid && Number.isInteger(previous.pid)) {
    let active = false; try { process.kill(previous.pid, 0); active = true; } catch {}
    if (active) throw new Error('Worker Profit4/Bounce sudah berjalan. Gunakan dashboard untuk restart.');
  }
}
const logWriter = new RotatingJsonlWriter(output);
const write = (name: string, value: unknown) => logWriter.write(name, value);
const targetLane = isPaperRunner
  ? new DistributionProfit4Runtime(output, write, dataDirectory, values.paperLane === 'bounce' ? 'bounce' : 'profit4')
  : new DistributionTargetRuntime(output, write);
process.once('exit', () => logWriter.close());
const walk = (value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => { if (Array.isArray(value)) value.forEach(x => walk(x, out)); else if (value && typeof value === 'object') { const row = value as Record<string, unknown>; out.push(row); Object.values(row).forEach(x => walk(x, out)); } return out; };
function fields(row: Record<string, unknown>) { const token = row.token as Record<string, unknown> | undefined; return { event: String(row.event_type ?? row.e ?? '').toLowerCase(), mint: String(token?.address ?? row.token_address ?? row.a ?? ''), timestamp: Number(row.timestamp ?? row.t) || 0, token }; }
function transfer(row: Record<string, unknown>, wallet: string): Transfer | undefined { const f = fields(row); if (f.event !== 'transfer_in' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.mint)) return; return { wallet, mint: f.mint, symbol: String(f.token?.symbol ?? ''), timestamp: f.timestamp || undefined, priceUsd: Number(row.price_usd ?? row.pu) || undefined, amount: String(row.token_amount ?? row.ba ?? ''), from: String(row.from_address ?? ''), tx: String(row.tx_hash ?? row.h ?? '') }; }
function latestUnsold(body: unknown, wallet: string): Transfer | undefined { const rows = walk(body); const all = rows.map(fields); return rows.map(r => transfer(r, wallet)).filter((x): x is Transfer => Boolean(x)).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)).find(t => !all.some(a => (a.event === 'sell' || a.event === 'swap_sell') && a.mint === t.mint && a.timestamp > (t.timestamp ?? 0))); }

const context = await chromium.launchPersistentContext(values.profileDir!, { channel: 'chrome', headless: false, viewport: null, args: ['--start-maximized', `--profile-directory=${values.profileName}`] });
const controller = context.pages()[0] ?? await context.newPage();
const details = new Map<string, { page: Page; watch: Watch }>();
const seen = new Set<string>();
writeFileSync(join(output, 'manifest.json'), JSON.stringify({ addresses, pollMilliseconds, requestGapMs: pollMilliseconds, requestMode: 'sequential', maxTabs: 1 + maxDetails, maxDetails, startedAt: new Date().toISOString(), storage: { format: 'jsonl', directory: 'chunks', chunkMinutes: LOG_CHUNK_MS / 60_000, timezone: 'Asia/Jakarta' }, purpose: 'One controller address tab plus at most one token detail tab per monitored wallet. Each detail remains open until its receiving wallet sells the same mint. Read-only; no order is submitted.' }, null, 2));
let stopping = false;
const wait = async (ms: number) => {
  if (!profit4) { await delay(ms); return; }
  const until = Date.now() + ms;
  while (!stopping && Date.now() < until) await delay(Math.min(250, until - Date.now()));
};
const control = { pid: process.pid, mode: profit4 ? 'profit4-watch' : 'distribution-watch', status: 'running', startedAt: new Date().toISOString(), run: output, addresses, requestGapMs: pollMilliseconds, requestMode: 'sequential', logDirectory: join(output, 'chunks'), chunkMinutes: LOG_CHUNK_MS / 60_000 };
const health: { lastPollAt?: number; lastPollWallet?: string; lastPollComplete?: boolean; lastPollStatus?: number; lastError?: string | null; lastSocketAt?: number; backoffUntil?: number | null } = {};
writeControl(control);
const removeControlFile = () => { try { const state = JSON.parse(readFileSync(controlFile, 'utf8')); if (state.pid === process.pid) {
  if (profit4) writeControl({ ...state, status: state.status === 'failed' ? 'failed' : 'stopped', stoppedAt: new Date().toISOString() });
  else unlinkSync(controlFile);
} } catch {} };
process.once('SIGINT', removeControlFile); process.once('SIGTERM', removeControlFile); process.once('exit', removeControlFile);

function attachDetailSocket(page: Page, wallet: string) {
  if (profit4) page.on('response', async response => {
    if (!/gmgn\.ai\//.test(response.url()) || !/\/api\//.test(response.url())) return;
    try {
      const text = await response.text(); let body: unknown; try { body = JSON.parse(text); } catch { body = { rawBody: text }; }
      write('api-responses.jsonl', { observedAt: Date.now(), role: 'token_detail', mint: details.get(wallet)?.watch.transfer.mint,
        endpoint: response.url(), status: response.status(), contentType: response.headers()['content-type'], body });
    } catch { /* response may disappear while closing the detail */ }
  });
  page.on('websocket', socket => {
    socket.on('framesent', ({ payload }) => write('websocket-frames.jsonl', { observedAt: Date.now(), role: 'token_detail', wallet, mint: details.get(wallet)?.watch.transfer.mint, direction: 'sent', socket: socket.url(), body: decodeFrame(payload) ?? { undecodable: true } }));
    socket.on('framereceived', ({ payload }) => {
      const observedAt = Date.now();
      if (profit4) health.lastSocketAt = observedAt;
      const body = decodeFrame(payload); const state = details.get(wallet);
      write('websocket-frames.jsonl', { observedAt, role: 'token_detail', wallet, mint: state?.watch.transfer.mint, direction: 'received', socket: socket.url(), body: body ?? { undecodable: true } });
      if (!state) return;
      targetLane.holderFrame(state.watch.transfer.mint, body, observedAt);
      for (const row of walk(body)) {
        const f = fields(row), price = Number(row.pu ?? row.price_usd);
        if (f.mint !== state.watch.transfer.mint || !['buy', 'sell'].includes(f.event) || !Number.isFinite(price)) continue;
        const trade = { mint: f.mint, side: f.event, price, timestamp: f.timestamp || undefined, wallet: String(row.m ?? row.wallet ?? ''), usd: Number(row.au ?? row.cost_usd) || undefined, signature: String(row.h ?? row.tx_hash ?? '') };
        write('token-trades.jsonl', { observedAt, trackedFrom: state.watch.transfer, ...trade });
        if (trade.timestamp) targetLane.trade(trade.mint, { at: observedAt, timestamp: trade.timestamp, price: trade.price, side: trade.side,
          wallet: trade.wallet, usd: trade.usd ?? null, signature: trade.signature });
        if (profit4 && trade.side === 'sell' && trade.wallet === wallet && (trade.timestamp ?? 0) >= (state.watch.transfer.timestamp ?? Infinity)) {
          write('watch-events.jsonl', { type: 'TRACKED_WALLET_SOLD', observedAt, trackedWallet: wallet, transfer: state.watch.transfer, sell: trade, source: 'socket' });
          if (values.paperLane !== 'bounce') {
            details.delete(wallet);
            if (![...details.values()].some(d => d.watch.transfer.mint === trade.mint)) targetLane.end(trade.mint, observedAt, 'TRACKED_WALLET_SOLD_AND_DETAIL_CLOSED');
            void page.close(); break;
          }
        }
      }
    });
  });
  page.on('close', () => { if (details.get(wallet)?.page === page) {
    const mint = details.get(wallet)!.watch.transfer.mint; details.delete(wallet);
    if (![...details.values()].some(d => d.watch.transfer.mint === mint)) targetLane.end(mint, Date.now(), 'DETAIL_CLOSED');
  } });
}

async function openOrReplaceDetail(next: Transfer) {
  const key = `${next.wallet}:${next.mint}:${next.tx || next.timestamp || ''}`;
  if (seen.has(key)) return; seen.add(key); write('transfers.jsonl', { observedAt: Date.now(), ...next });
  const existing = details.get(next.wallet);
  if (existing?.watch.transfer.mint === next.mint) return;
  if (!existing && details.size >= maxDetails) { write('watch-events.jsonl', { type: 'DETAIL_SKIPPED_CAPACITY', observedAt: Date.now(), trackedWallet: next.wallet, transfer: next, maxDetails }); return; }
  const page = existing?.page ?? await context.newPage();
  if (!existing) attachDetailSocket(page, next.wallet);
  if (existing) {
    write('watch-events.jsonl', { type: 'DETAIL_REPLACED_BY_NEW_TRANSFER', observedAt: Date.now(), trackedWallet: next.wallet, previous: existing.watch.transfer, next });
    if (![...details.values()].some(d => d !== existing && d.watch.transfer.mint === existing.watch.transfer.mint)) targetLane.end(existing.watch.transfer.mint, Date.now(), 'DETAIL_REPLACED');
  }
  const watch: Watch = { transfer: next };
  details.set(next.wallet, { page, watch });
  targetLane.register(next, Date.now());
  write('watch-events.jsonl', { type: 'TOKEN_DETAIL_OPENED', observedAt: Date.now(), trackedWallet: next.wallet, transfer: next, closeRule: 'receiving wallet sells same mint' });
  await page.goto(`https://gmgn.ai/sol/token/${next.mint}`, { waitUntil: 'commit' });
}

await controller.goto(`https://gmgn.ai/sol/address/${addresses[0]}`, { waitUntil: 'commit' });
write('watch-events.jsonl', { type: 'READY', observedAt: Date.now(), controllerWallet: addresses[0], checkedWallets: addresses, maxTabs: 1 + maxDetails, maxDetails, execution: 'READ_ONLY' });
const targetTimer = setInterval(() => {
  targetLane.evaluate(Date.now());
  if (profit4 && !stopping) writeControl({ ...control, ...health, heartbeatAt: Date.now() });
  if (profit4 && existsSync(stopFile)) {
    try { const request = JSON.parse(readFileSync(stopFile, 'utf8')); if (request.pid === process.pid) {
      stopping = true; targetLane.shutdown(Date.now()); void context.close();
    } } catch {}
  }
}, 1000);
targetTimer.unref();
process.once('SIGINT', () => { clearInterval(targetTimer); targetLane.shutdown(Date.now()); });
process.once('SIGTERM', () => { clearInterval(targetTimer); targetLane.shutdown(Date.now()); });
let nextWallet = 0;
let rateLimitStreak = 0;
while (!controller.isClosed() && !stopping) {
  const wallet = addresses[nextWallet]; nextWallet = (nextWallet + 1) % addresses.length;
  try {
    const incoming = new URLSearchParams({ wallet, limit: '100', cost: 'usd', type: 'transferIn' });
    const sells = new URLSearchParams({ wallet, limit: '100', cost: 'usd', type: 'sell' });
    const result = await controller.evaluate(fetchWalletActivityPair, { incomingUrl: `/vas/api/v1/wallet_activity/sol?${incoming}`, sellUrl: `/vas/api/v1/wallet_activity/sol?${sells}`, requestGapMs: pollMilliseconds });
    write('api-responses.jsonl', { observedAt: Date.now(), wallet, endpoint: '/vas/api/v1/wallet_activity/sol', ...result });
    if (profit4) Object.assign(health, { lastPollAt: Date.now(), lastPollWallet: wallet,
      lastPollComplete: result.complete, lastPollStatus: result.status, backoffUntil: null, lastError: result.complete ? null : 'Respons GMGN bukan aktivitas JSON yang valid.' });
    if (!result.complete) {
      const failed = result.requests.find(request => !request.valid);
      write('watch-events.jsonl', { type: 'ACTIVITY_POLL_ERROR', observedAt: Date.now(), wallet, error: 'Respons aktivitas tidak valid; body asli disimpan di api-responses.jsonl.', status: failed?.status, contentType: failed?.contentType });
      if (profit4 && failed?.status === 429) {
        const pause = Math.min(60000, 15000 * 2 ** Math.min(rateLimitStreak++, 2));
        Object.assign(health, { backoffUntil: Date.now() + pause, lastError: `GMGN membatasi request (429). Menunggu ${pause / 1000} detik sebelum polling berikutnya; socket tetap direkam.` });
        write('watch-events.jsonl', { type: 'RATE_LIMIT_BACKOFF', observedAt: Date.now(), wallet, delayMs: pause });
        await wait(pause);
      } else await wait(5000);
      continue;
    }
    rateLimitStreak = 0;
    const tracked = details.get(wallet);
    if (tracked) {
      const sell = walk(result.body).find(row => {
        const activity = fields(row);
        return (activity.event === 'sell' || activity.event === 'swap_sell') && activity.mint === tracked.watch.transfer.mint && activity.timestamp > (tracked.watch.transfer.timestamp ?? 0);
      });
      if (sell) {
        write('watch-events.jsonl', { type: 'TRACKED_WALLET_SOLD', observedAt: Date.now(), trackedWallet: wallet, transfer: tracked.watch.transfer, sell });
        if (values.paperLane !== 'bounce') {
          details.delete(wallet);
          if (![...details.values()].some(d => d.watch.transfer.mint === tracked.watch.transfer.mint)) targetLane.end(tracked.watch.transfer.mint, Date.now(), 'TRACKED_WALLET_SOLD_AND_DETAIL_CLOSED');
          await tracked.page.close();
          await wait(pollMilliseconds);
          continue;
        }
      }
    }
    const candidate = latestUnsold(result.body, wallet); if (candidate) await openOrReplaceDetail(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write('watch-events.jsonl', { type: 'ACTIVITY_POLL_ERROR', observedAt: Date.now(), wallet, error: message });
    if (profit4 && !stopping) Object.assign(health, { lastPollAt: Date.now(), lastPollWallet: wallet, lastPollComplete: false, lastError: message });
  }
  await wait(pollMilliseconds);
}
clearInterval(targetTimer);
targetLane.shutdown(Date.now());
if (profit4) { await context.close(); logWriter.close(); }
