import { chromium, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read-only completeness simulation for GMGN holders.
 * GMGN's observed endpoint caps one request at 100 rows and its cursor format
 * is not publicly reproducible. We therefore merge the top and bottom 100;
 * this is exact only when the resulting unique wallet count matches token_stat.
 */
const { values } = parseArgs({ options: {
  mint: { type: 'string' }, profileDir: { type: 'string', default: 'profiles/research-vps' }, profileName: { type: 'string', default: 'Default' },
  limit: { type: 'string', default: '100' }, output: { type: 'string' }, headless: { type: 'boolean', default: false },
} });
const mint = values.mint, limit = Number(values.limit);
if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('Gunakan --mint <alamat token Solana yang valid>.');
if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit harus 1..100.');
if (!existsSync(values.profileDir)) throw new Error('Profile browser tidak ditemukan: ' + values.profileDir);

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const rows = (value: unknown) => {
  const root = object(value), data = object(root.data), list = [data.list, data.holders, data.items, root.list, root.holders].find(Array.isArray) as unknown[] | undefined;
  return (list ?? []).map(object);
};
const address = (row: Json) => {
  const value = row.wallet_address ?? row.wallet ?? row.address ?? row.wa;
  return typeof value === 'string' && value.length >= 32 ? value : null;
};
const totalHolderCount = (value: unknown) => {
  const root = object(value), data = object(root.data);
  for (const key of ['holder_count', 'holders', 'holder_num', 'holderCount']) {
    const n = Number(data[key] ?? root[key]); if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
};
async function holderRequest(page: Page, direction: 'asc' | 'desc') {
  return page.evaluate(async ({ tokenMint, pageLimit, sortDirection }) => {
    let deviceId = '', fpDid = '', clientId = '', appVer = '20260922-4775-0d0463e';
    try {
      const did = document.cookie.match(/_did=([^;]+)/)?.[1] || '';
      deviceId = localStorage.getItem('device_id') || localStorage.getItem('gmgn_device_id') || did;
      fpDid = localStorage.getItem('fp_did') || did; clientId = localStorage.getItem('client_id') || '';
      appVer = localStorage.getItem('app_ver') || appVer;
    } catch { /* browser defaults are sufficient for this read-only request */ }
    const query = new URLSearchParams({ device_id: deviceId || '2d9248c7-3137-4fc1-bae6-a9d70136d48e', fp_did: fpDid || 'aaa4fd49dbd9a8cb1b32059bd5b6b375', client_id: clientId || `gmgn_web_${appVer}`, app_ver: appVer, tab_id: Math.random().toString(36).slice(2, 14), from_app: 'gmgn', tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone.replace('/', '_'), tz_offset: String(-new Date().getTimezoneOffset() * 60), app_lang: navigator.language || 'en-US', os: 'web', worker: '0', limit: String(pageLimit), cost: '20', orderby: 'amount_percentage', direction: sortDirection });
    const path = '/vas/api/v1/token_holders/sol/' + encodeURIComponent(tokenMint) + '?' + query;
    const response = await fetch(path, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*', 'accept-language': navigator.language || 'en-US,en;q=0.9', priority: 'u=1, i' } });
    return { path, status: response.status, body: await response.json().catch(() => null) };
  }, { tokenMint: mint, pageLimit: limit, sortDirection: direction });
}
async function tokenStat(page: Page) {
  return page.evaluate(async tokenMint => {
    const response = await fetch('/api/v1/token_stat/sol/' + encodeURIComponent(tokenMint), { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, mint);
}

const output = values.output ?? join('research', 'all-holder-simulation-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const context = await chromium.launchPersistentContext(values.profileDir, { channel: 'chrome', headless: values.headless, viewport: null, args: ['--start-maximized', '--profile-directory=' + values.profileName, '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://gmgn.ai/sol/token/' + encodeURIComponent(mint), { waitUntil: 'commit', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(4_000);
  const [stat, descending, ascending] = await Promise.all([tokenStat(page), holderRequest(page, 'desc'), holderRequest(page, 'asc')]);
  const descRows = rows(descending.body), ascRows = rows(ascending.body);
  const descWallets = new Set(descRows.map(address).filter((value): value is string => !!value));
  const ascWallets = new Set(ascRows.map(address).filter((value): value is string => !!value));
  const union = new Set([...descWallets, ...ascWallets]);
  const overlap = [...descWallets].filter(wallet => ascWallets.has(wallet));
  const expected = stat.status === 200 ? totalHolderCount(stat.body) : null;
  const complete = expected !== null && union.size === expected;
  const report = { mint, observedAt: new Date().toISOString(), readOnly: true, tokenStat: { status: stat.status, holderCount: expected }, requests: { descending: { status: descending.status, rows: descRows.length, uniqueWallets: descWallets.size, path: descending.path }, ascending: { status: ascending.status, rows: ascRows.length, uniqueWallets: ascWallets.size, path: ascending.path } }, result: { unionUniqueWallets: union.size, overlapWallets: overlap.length, expectedHolderCount: expected, complete, missingEstimate: expected === null ? null : Math.max(0, expected - union.size), method: 'top-100 + bottom-100 by amount_percentage' }, interpretation: complete ? 'Lengkap untuk snapshot ini: jumlah alamat unik sama dengan holder_count GMGN.' : 'Belum boleh disebut lengkap. Untuk token di atas 200 holder atau bila ada respons gagal, perlu pagination UI/cursor asli.' };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(output, 'holders.json'), JSON.stringify({ descending: descRows, ascending: ascRows, uniqueWallets: [...union] }, null, 2));
  console.log('[all-holder-simulation]', output);
  console.log(JSON.stringify(report.result));
} finally { await context.close(); }
