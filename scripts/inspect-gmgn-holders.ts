import { chromium, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read-only GMGN holder inspection. No order endpoint is called. */
const { values } = parseArgs({ options: {
  mint: { type: 'string' }, profileDir: { type: 'string', default: 'profiles/research-vps' }, profileName: { type: 'string', default: 'Default' },
  pages: { type: 'string', default: '3' }, limit: { type: 'string', default: '100' }, seconds: { type: 'string', default: '20' }, output: { type: 'string' }, headless: { type: 'boolean', default: false },
} });
const mint = values.mint, pages = Number(values.pages), limit = Number(values.limit), seconds = Number(values.seconds);
if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('Gunakan --mint <alamat token Solana yang valid>.');
if (!Number.isInteger(pages) || pages < 1 || pages > 10 || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isFinite(seconds) || seconds < 3 || seconds > 120) throw new Error('pages harus 1..10, limit 1..100, dan seconds 3..120.');
if (!existsSync(values.profileDir)) throw new Error('Profile browser tidak ditemukan: ' + values.profileDir);

type Json = Record<string, unknown>;
type ApiProbe = { variant: string; url: string; status: number; dataKeys: string[]; listLength: number; wallets: string[]; firstWallet: string | null; lastWallet: string | null; totalHint: number | null };
type SocketFrame = { observedAt: number; channel: string; rowCount: number; holderRowCounts: number[]; wallets: string[]; raw: unknown };
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
function listFrom(value: unknown): Json[] {
  const root = object(value), data = object(root.data), candidate = [data.list, data.holders, data.items, root.list, root.holders].find(Array.isArray);
  return (candidate as unknown[] | undefined ?? []).map(object);
}
function wallet(row: Json): string | null { const value = row.wallet_address ?? row.wallet ?? row.address ?? row.wa; return typeof value === 'string' && value.length >= 32 ? value : null; }
function numberHint(value: unknown): number | null {
  for (const key of ['total', 'total_count', 'holder_count', 'holders', 'count']) {
    const candidate = object(object(value).data)[key] ?? object(value)[key], n = Number(candidate);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}
function short(value: string | null) { return value ? value.slice(0, 6) + '…' + value.slice(-5) : null; }
async function browserFetch(page: Page, path: string) {
  return page.evaluate(async requestPath => {
    const response = await fetch(requestPath, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, path);
}
async function gmgnHolderQuery(page: Page, extra: Record<string, string>) {
  return page.evaluate(async ({ tokenMint, extraParams }) => {
    let deviceId = '', fpDid = '', clientId = '', appVer = '20260922-4775-0d0463e';
    try {
      const did = document.cookie.match(/_did=([^;]+)/)?.[1] || '';
      deviceId = localStorage.getItem('device_id') || localStorage.getItem('gmgn_device_id') || did;
      fpDid = localStorage.getItem('fp_did') || did;
      clientId = localStorage.getItem('client_id') || '';
      appVer = localStorage.getItem('app_ver') || appVer;
    } catch { /* use the browser-visible defaults below */ }
    const query = new URLSearchParams({
      device_id: deviceId || '2d9248c7-3137-4fc1-bae6-a9d70136d48e', fp_did: fpDid || 'aaa4fd49dbd9a8cb1b32059bd5b6b375',
      client_id: clientId || `gmgn_web_${appVer}`, app_ver: appVer, tab_id: Math.random().toString(36).slice(2, 14),
      from_app: 'gmgn', tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone.replace('/', '_'), tz_offset: String(-new Date().getTimezoneOffset() * 60),
      app_lang: navigator.language || 'en-US', os: 'web', worker: '0', ...extraParams,
    });
    const path = '/vas/api/v1/token_holders/sol/' + encodeURIComponent(tokenMint) + '?' + query;
    const response = await fetch(path, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*', 'accept-language': navigator.language || 'en-US,en;q=0.9', priority: 'u=1, i' } });
    return { path, status: response.status, body: await response.json().catch(() => null) };
  }, { tokenMint: mint, extraParams: extra });
}

const runId = new Date().toISOString().replace(/[:.]/g, '-'), output = values.output ?? join('research', 'holder-inspection-' + runId);
mkdirSync(output, { recursive: true });
const socketFrames: SocketFrame[] = [];
const passiveHolderResponses: { observedAt: number; url: string; status: number; listLength: number; wallets: string[] }[] = [];
const context = await chromium.launchPersistentContext(values.profileDir, { channel: 'chrome', headless: values.headless, viewport: null, args: ['--start-maximized', '--profile-directory=' + values.profileName, '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = context.pages()[0] ?? await context.newPage();
  page.on('response', async response => {
    if (!response.url().includes('/vas/api/v1/token_holders/sol/')) return;
    const rows = listFrom(await response.json().catch(() => null)), wallets = rows.map(wallet).filter((value): value is string => !!value);
    passiveHolderResponses.push({ observedAt: Date.now(), url: response.url(), status: response.status(), listLength: rows.length, wallets });
  });
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    try {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8'), message = JSON.parse(text) as Json, channel = message.channel;
      if ((channel !== 'token_holding' && channel !== 'token_tag_holding') || !Array.isArray(message.data)) return;
      const matching = (message.data as unknown[]).map(object).filter(row => row.ta === mint && Array.isArray(row.h));
      if (!matching.length) return;
      const rows = matching.flatMap(row => Array.isArray(row.h) ? row.h.map(object) : []), wallets = rows.map(row => typeof row.wa === 'string' ? row.wa : null).filter((value): value is string => !!value);
      socketFrames.push({ observedAt: Date.now(), channel, rowCount: matching.length, holderRowCounts: matching.map(row => (row.h as unknown[]).length), wallets, raw: message });
    } catch { /* non-JSON/ping frames are irrelevant */ }
  }));
  console.log('[holder-inspection] membuka token', mint);
  await page.goto('https://gmgn.ai/sol/token/' + encodeURIComponent(mint), { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(5_000);
  const variants: { variant: string; params: Record<string, string> }[] = [];
  for (let index = 1; index <= pages; index++) variants.push({ variant: 'page=' + index, params: { limit: String(limit), cost: '20', orderby: 'amount_percentage', direction: 'desc', page: String(index) } });
  if (pages > 1) variants.push({ variant: 'offset=' + limit, params: { limit: String(limit), cost: '20', orderby: 'amount_percentage', direction: 'desc', offset: String(limit) } });
  const api: ApiProbe[] = [], rawApi: { variant: string; url: string; status: number; body: unknown }[] = [];
  for (const candidate of variants) {
    const result = await gmgnHolderQuery(page, candidate.params), path = result.path, rows = listFrom(result.body), wallets = rows.map(wallet).filter((value): value is string => !!value), data = object(object(result.body).data);
    api.push({ variant: candidate.variant, url: path, status: result.status, dataKeys: Object.keys(data), listLength: rows.length, wallets, firstWallet: wallets[0] ?? null, lastWallet: wallets.at(-1) ?? null, totalHint: numberHint(result.body) });
    rawApi.push({ variant: candidate.variant, url: path, status: result.status, body: result.body });
    await page.waitForTimeout(350);
  }
  // GMGN returns an opaque `next` cursor. Test that cursor explicitly; unlike
  // page/offset this is discovered from the actual response, not guessed.
  let next = object(object(rawApi[0]?.body).data).next;
  for (let index = 2; index <= pages && typeof next === 'string' && next.length > 0; index++) {
    const result = await gmgnHolderQuery(page, { limit: String(limit), cost: '20', orderby: 'amount_percentage', direction: 'desc', next });
    const rows = listFrom(result.body), wallets = rows.map(wallet).filter((value): value is string => !!value), data = object(object(result.body).data);
    api.push({ variant: 'next cursor #' + index, url: result.path, status: result.status, dataKeys: Object.keys(data), listLength: rows.length, wallets, firstWallet: wallets[0] ?? null, lastWallet: wallets.at(-1) ?? null, totalHint: numberHint(result.body) });
    rawApi.push({ variant: 'next cursor #' + index, url: result.path, status: result.status, body: result.body });
    next = data.next;
    await page.waitForTimeout(350);
  }
  const initialCursor = object(object(rawApi[0]?.body).data).next;
  if (typeof initialCursor === 'string' && initialCursor.length > 0) {
    const result = await gmgnHolderQuery(page, { limit: String(limit), cost: '20', orderby: 'amount_percentage', direction: 'desc', cursor: initialCursor });
    const rows = listFrom(result.body), wallets = rows.map(wallet).filter((value): value is string => !!value), data = object(object(result.body).data);
    api.push({ variant: 'cursor=' + 'next', url: result.path, status: result.status, dataKeys: Object.keys(data), listLength: rows.length, wallets, firstWallet: wallets[0] ?? null, lastWallet: wallets.at(-1) ?? null, totalHint: numberHint(result.body) });
    rawApi.push({ variant: 'cursor=' + 'next', url: result.path, status: result.status, body: result.body });
  }
  console.log('[holder-inspection] memantau socket selama', seconds, 'detik');
  await page.waitForTimeout(seconds * 1_000);
  const first = api[0], apiWallets = new Set(first?.wallets ?? []), socketWallets = new Set(socketFrames.flatMap(frame => frame.wallets)), overlap = [...socketWallets].filter(address => apiWallets.has(address));
  const paginationComparison = api.slice(1).map(probe => ({ variant: probe.variant, sameWalletOrderAsFirst: JSON.stringify(probe.wallets) === JSON.stringify(first?.wallets ?? []), overlapWithFirst: probe.wallets.filter(address => apiWallets.has(address)).length }));
  const cursorPages = api.filter(probe => probe.variant.startsWith('next cursor') || probe.variant === 'cursor=next');
  const summary = { mint, observedAt: new Date().toISOString(), api: { probes: api.map(({ wallets, ...probe }) => ({ ...probe, firstWallet: short(probe.firstWallet), lastWallet: short(probe.lastWallet) })), firstPageUniqueWallets: apiWallets.size, paginationComparison, interpretation: 'Jika page=2 atau offset=limit sama dengan page=1, parameter tersebut diabaikan. Baris next cursor menguji cursor opaque yang benar-benar diberikan GMGN.' }, socket: { framesForMint: socketFrames.length, holderRowsReceived: socketFrames.reduce((sum, frame) => sum + frame.wallets.length, 0), uniqueWalletsReceived: socketWallets.size, overlapWithApiFirstPage: overlap.length, firstFrameHolderRows: socketFrames[0]?.holderRowCounts ?? [], interpretation: 'Socket dianggap snapshot lengkap hanya bila jumlah/isi wallet satu frame cocok dengan total holder yang diketahui. Kalau tidak, ia diperlakukan sebagai update parsial.' }, passiveBrowserHolderResponses: passiveHolderResponses.map(row => ({ ...row, wallets: row.wallets.length })), conclusion: { apiTotalHint: first?.totalHint ?? null, apiPageRows: first?.listLength ?? 0, cursorPaginationWorks: cursorPages.some(probe => probe.status === 200 && probe.wallets.length > 0 && probe.wallets.some(address => !apiWallets.has(address))), socketLooksComplete: !!first?.totalHint && socketFrames.some(frame => new Set(frame.wallets).size >= first.totalHint) } };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(output, 'api-responses.json'), JSON.stringify(rawApi, null, 2));
  writeFileSync(join(output, 'socket-holder-frames.json'), JSON.stringify(socketFrames, null, 2));
  console.log('[holder-inspection] selesai:', output);
  console.log(JSON.stringify(summary.conclusion));
} finally { await context.close(); }
