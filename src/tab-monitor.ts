import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { attachCapture } from './capture.js';
import { parseCandidates, parseTokenMetadata, validMint } from './parser.js';
import { parseTokenActivities } from './activity.js';
import { CandidateQueue } from './queue.js';
import { evaluate } from './risk.js';
import { TabManager, type ActiveTabInfo, type ClosedTabHistory, type SlotState } from './tab-manager.js';
import { selectTradeSide, amountInput } from './gmgn-trade-ui.js';
import type { Candidate, Config } from './model.js';

const { values } = parseArgs({
  options: {
    maxTabs: { type: 'string', default: '5' },
    config: { type: 'string', default: 'config/rules.yaml' },
    profileDir: { type: 'string', default: 'profiles/research-aria-tele01' },
    profileName: { type: 'string', default: 'Profile 12' },
    enableExtensions: { type: 'boolean', default: true },
    amount: { type: 'string', default: '0.01' },
    buyAmount: { type: 'string' },
    sol: { type: 'string' },
    port: { type: 'string', default: '4174' },
    seconds: { type: 'string' },
  },
});

const config: Config = loadConfig(values.config);
const maxTabs = Math.max(1, Math.min(20, Number(values.maxTabs) || 5));
const buyAmountSol = values.buyAmount ?? values.sol ?? values.amount ?? '0.01';
const serverPort = Number(values.port) || 4174;
const tabManager = new TabManager(maxTabs);
const queue = new CandidateQueue(config.queueCapacity, config.candidateTtlMs);

const candidates = new Map<string, Candidate>();
const inspected = new Set<string>();
const openPages = new Map<string, Page>();
let context: BrowserContext | null = null;
let feedPage: Page | null = null;
let dashboardPage: Page | null = null;
let stopping = false;
let activeServer: ReturnType<typeof createServer> | null = null;

function num(candidate: Candidate | undefined, field: string): number | null {
  const value = candidate?.fields[field as keyof Candidate['fields']]?.value;
  return typeof value === 'number' ? value : null;
}

function merge(update: Partial<Candidate> & { mint: string; updatedAt: number }): Candidate {
  const current = candidates.get(update.mint);
  const candidate: Candidate = {
    mint: update.mint,
    firstSeenAt: current?.firstSeenAt ?? update.firstSeenAt ?? update.updatedAt,
    updatedAt: update.updatedAt,
    fields: { ...(current?.fields ?? {}), ...(update.fields ?? {}) },
    metadata: { ...(current?.metadata ?? {}), ...(update.metadata ?? {}) },
  };
  candidates.set(update.mint, candidate);
  return candidate;
}

function passesInitialScreen(candidate: Candidate, now: number): boolean {
  const report = evaluate(candidate, config, now, false);
  const keys = new Set(['age', 'holders', 'liquidityUsd', 'top10Percent']);
  return report.checks.filter(check => keys.has(check.name)).every(check => check.status === 'PASS');
}

function logStatus(): void {
  const active = tabManager.getActiveTabs();
  const closed = tabManager.getClosedHistory();
  const warningCount = active.filter(t => t.hasWarning).length;
  const warnIndicator = warningCount > 0 ? ` 🚨 [${warningCount} TOKEN WARNING SELL!]` : '';
  console.log(
    `[tabs-monitor] 📊 Status: ${tabManager.getActiveCount()}/${maxTabs} tab aktif` +
    (active.length ? ` [${active.map(t => t.symbol).join(', ')}]` : ' [kosong]') +
    ` | Antrean: ${queue['pending']?.size ?? 0} | Riwayat ditutup: ${closed.length}${warnIndicator}`
  );
}

function writeDashboardReport(): void {
  try {
    mkdirSync('reports', { recursive: true });
    mkdirSync('dist', { recursive: true });

    const summary = tabManager.getStatusSummary();
    const payload = {
      updatedAt: new Date().toISOString(),
      maxTabs,
      buyAmountSol,
      activeCount: summary.activeCount,
      availableSlots: summary.availableSlots,
      slots: summary.slots,
      activeTabs: summary.activeTabs,
      closedCount: summary.closedCount,
      closedHistory: summary.closedHistory,
      pendingQueueCount: queue['pending']?.size ?? 0,
    };

    writeFileSync('reports/tab-monitor-status.json', JSON.stringify(payload, null, 2));
    writeFileSync('dist/tab-monitor-data.json', JSON.stringify(payload, null, 2));
    writeFileSync('dist/tab-monitor.html', getDashboardHtml());
  } catch (err) {
    console.warn('[dashboard-write-error]', err instanceof Error ? err.message : err);
  }
}

async function safelySetAmount(page: Page, solAmount: string): Promise<void> {
  const input = await amountInput(page);
  const current = (await input.inputValue()).trim();
  if (current === solAmount) return;
  await input.click({ clickCount: 3 });
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await page.waitForTimeout(100);
  await input.fill(solAmount);
  const afterFill = (await input.inputValue()).trim();
  if (afterFill !== solAmount) {
    await input.evaluate((el: HTMLInputElement, val: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = val;
      }
    }, solAmount);
  }
}

async function prepareBuyPanel(page: Page, solAmount: string, symbol: string): Promise<void> {
  await selectTradeSide(page, 'buy');
  await safelySetAmount(page, solAmount);
  console.log(`[ui-prep] 💰 ${symbol}: Panel Buy disiapkan dengan nominal ${solAmount} SOL. (Siap untuk manual buy).`);
}

async function openDetailTab(mint: string, candidate?: Candidate): Promise<boolean> {
  if (!context) return false;
  if (!tabManager.canOpen()) return false;
  if (tabManager.isTabActive(mint)) return false;

  const symbol = candidate?.metadata?.symbol ?? 'Token';
  const name = candidate?.metadata?.name ?? undefined;
  const url = config.tokenUrlTemplate.replaceAll('{mint}', mint);
  const initialPrice = num(candidate, 'priceUsd') ?? undefined;
  const initialHolders = num(candidate, 'holders') ?? undefined;

  try {
    const page = await context.newPage();
    openPages.set(mint, page);
    tabManager.openTab(mint, symbol, url, name, Date.now(), initialPrice, initialHolders);

    // Listen to page close event triggered when user manually closes the tab in Chrome
    page.on('close', () => {
      openPages.delete(mint);
      const closed = tabManager.closeTab(mint);
      if (closed) {
        console.log(`\n============================================================`);
        console.log(`[tab-closed] ❌ Tab ${closed.symbol} (${closed.mint}) ditutup.`);
        console.log(`[tab-closed] ⏱️ Aktif selama: ${closed.durationSeconds} detik.`);
        console.log(`[tab-closed] 📌 Tersimpan di riwayat (#${closed.index}).`);
        console.log(`[tab-closed] 💡 Untuk membuka kembali: ketik 'reopen ${closed.index}' di terminal ini.`);
        console.log(`============================================================\n`);
        logStatus();
        writeDashboardReport();
        // Slot is now free, check if queue has pending candidate
        processNextInQueue();
      }
    });

    // Attach passive capture to record prices, holders, and transactions from socket
    attachCapture(page, () => {}, (payload, now) => {
      // 1. Holder updates from candidate payload
      for (const update of parseCandidates(payload, config.mappings, now, 'detail')) {
        if (update.mint === mint) {
          const c = merge(update);
          const holders = num(c, 'holders') ?? undefined;
          if (holders !== undefined) {
            tabManager.recordHolderSample(mint, holders, now);
          }
        }
      }

      // 2. Real-time trade transactions from socket activity stream
      for (const activity of parseTokenActivities(payload, now)) {
        if (activity.mint === mint && activity.priceUsd) {
          tabManager.recordTrade(mint, {
            side: activity.side,
            amountUsd: activity.amount ?? 0,
            priceUsd: activity.priceUsd,
            occurredAt: activity.occurredAt,
            wallet: activity.actorAddress,
          });
        }
      }
    });

    console.log(`\n[tab-opened] 🌐 Tab baru dibuka: ${symbol} (${mint}). Tab aktif: ${tabManager.getActiveCount()}/${maxTabs}`);
    logStatus();
    writeDashboardReport();

    // Navigate to the GMGN token page
    await page.goto(url, { waitUntil: 'commit', timeout: config.workerTimeoutMs });

    // Pre-fill amount buy 0.01 SOL (tanpa klik submit) agar pengguna bisa langsung manual buy
    await page.waitForTimeout(1000);
    await prepareBuyPanel(page, buyAmountSol, symbol).catch(err => {
      console.warn(`[ui-prep-warn] ${symbol} tidak dapat mengisi nominal buy:`, err instanceof Error ? err.message : err);
    });

    return true;
  } catch (error) {
    console.error(`[tab-open-error] Gagal membuka tab untuk ${mint}:`, error instanceof Error ? error.message : error);
    openPages.delete(mint);
    tabManager.closeTab(mint);
    return false;
  }
}

async function processNextInQueue(): Promise<void> {
  if (stopping) return;
  while (tabManager.canOpen()) {
    const mint = queue.take();
    if (!mint) break;
    const candidate = candidates.get(mint);
    console.log(`[queue-take] Mengambil token dari antrean: ${candidate?.metadata?.symbol ?? mint} (${mint})`);
    const success = await openDetailTab(mint, candidate);
    if (!success) {
      queue.done(mint);
    }
  }
}

async function focusTab(mint: string): Promise<boolean> {
  const page = openPages.get(mint);
  if (!page) return false;
  try {
    await page.bringToFront();
    console.log(`[focus-tab] Tab ${mint} dibawa ke depan di browser Chrome.`);
    return true;
  } catch {
    return false;
  }
}

async function reopenTabByQuery(query: string | number): Promise<void> {
  const result = tabManager.reopenTab(query);
  if (!result.success || !result.item) {
    console.log(`[reopen-failed] ⚠️ ${result.reason}`);
    return;
  }
  const item = result.item;
  console.log(`[reopen] 🔄 Membuka kembali ${item.symbol} (${item.mint}) di tab baru...`);
  const candidate = candidates.get(item.mint);
  const success = await openDetailTab(item.mint, candidate);
  if (!success) {
    console.log(`[reopen-error] Gagal membuka browser page untuk ${item.symbol}.`);
  }
}

function closeTabByQuery(query: string | number): void {
  let targetMint: string | null = null;
  const activeTabs = tabManager.getActiveTabs();

  if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
    const idx = Number(query) - 1;
    if (idx >= 0 && idx < activeTabs.length) {
      targetMint = activeTabs[idx].mint;
    }
  } else {
    const q = String(query).trim().toLowerCase();
    const found = activeTabs.find(t => t.mint.toLowerCase() === q || t.symbol.toLowerCase() === q);
    if (found) targetMint = found.mint;
  }

  if (!targetMint) {
    console.log(`[close-failed] ⚠️ Tab "${query}" tidak ditemukan di daftar tab aktif.`);
    return;
  }

  const page = openPages.get(targetMint);
  if (page) {
    console.log(`[close] Menutup tab ${targetMint}...`);
    page.close().catch(() => {});
  } else {
    tabManager.closeTab(targetMint);
    logStatus();
    writeDashboardReport();
    processNextInQueue();
  }
}

function printCliList(): void {
  const active = tabManager.getActiveTabs();
  const closed = tabManager.getClosedHistory();

  console.log(`\n========================================================================`);
  console.log(`🟢 TAB DETAIL AKTIF (${active.length}/${maxTabs}):`);
  if (!active.length) {
    console.log(`   (Tidak ada tab detail aktif saat ini)`);
  } else {
    active.forEach((t, i) => {
      const dur = Math.round((Date.now() - t.openedAt) / 1000);
      const warn = t.hasWarning ? ' 🚨 [WARNING SELL!]' : '';
      console.log(`   [#${i + 1}] ${t.symbol.padEnd(10)} | ${t.mint} | ${dur}s aktif | Harga: ${t.lastPriceUsd ? '$' + t.lastPriceUsd : '—'} | Holders: ${t.holders ?? '—'}${warn}`);
    });
  }

  console.log(`\n📁 RIWAYAT DETAIL DITUTUP (Dapat Dibuka Kembali):`);
  if (!closed.length) {
    console.log(`   (Belum ada riwayat tab yang ditutup)`);
  } else {
    closed.slice(0, 15).forEach(c => {
      const ago = Math.round((Date.now() - c.closedAt) / 1000);
      console.log(`   [#${c.index}] ${c.symbol.padEnd(10)} | ${c.mint} | ditutup ${ago}s lalu (durasi ${c.durationSeconds}s) -> ketik: reopen ${c.index}`);
    });
  }
  console.log(`========================================================================\n`);
}

function startCliInterface(): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case 'status':
        logStatus();
        break;
      case 'list':
      case 'ls':
        printCliList();
        break;
      case 'reopen':
      case 'open':
        if (!arg) {
          console.log(`Gunakan: reopen <#index | mint | symbol> (contoh: reopen 1)`);
        } else {
          reopenTabByQuery(arg);
        }
        break;
      case 'close':
        if (!arg) {
          console.log(`Gunakan: close <#no | mint | symbol> (contoh: close 1)`);
        } else {
          closeTabByQuery(arg);
        }
        break;
      case 'help':
        console.log(`
Perintah CLI yang tersedia:
  status               - Tampilkan jumlah tab aktif dan status antrean
  list / ls            - Tampilkan tabel detail tab aktif dan riwayat tab yang ditutup
  reopen <index|mint>  - Buka kembali detail token yang pernah ditutup (contoh: reopen 1)
  close <no|mint>      - Tutup tab aktif tertentu dari terminal (contoh: close 1)
  help                 - Tampilkan bantuan ini
`);
        break;
      default:
        console.log(`Perintah tidak dikenal: "${trimmed}". Ketik 'help' untuk daftar perintah.`);
        break;
    }
  });
}

function startHttpServer(port: number): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const urlObj = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const pathname = urlObj.pathname;

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      // API: Get current 5-slot live state
      if (pathname === '/api/state') {
        const summary = tabManager.getStatusSummary();
        const payload = {
          updatedAt: new Date().toISOString(),
          maxTabs,
          buyAmountSol,
          activeCount: summary.activeCount,
          availableSlots: summary.availableSlots,
          slots: summary.slots,
          activeTabs: summary.activeTabs,
          closedCount: summary.closedCount,
          closedHistory: summary.closedHistory,
          pendingQueueCount: queue['pending']?.size ?? 0,
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }

      // API: Focus browser tab by mint
      if (pathname.startsWith('/api/focus/')) {
        const mint = decodeURIComponent(pathname.slice('/api/focus/'.length));
        const ok = await focusTab(mint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok, mint }));
        return;
      }

      // API: Close browser tab by mint
      if (pathname.startsWith('/api/close/')) {
        const mint = decodeURIComponent(pathname.slice('/api/close/'.length));
        closeTabByQuery(mint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mint }));
        return;
      }

      // API: Reopen closed tab by index or mint
      if (pathname.startsWith('/api/reopen/')) {
        const query = decodeURIComponent(pathname.slice('/api/reopen/'.length));
        await reopenTabByQuery(query);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, query }));
        return;
      }

      // Serve Dashboard HTML
      if (pathname === '/' || pathname === '/index.html' || pathname === '/tab-monitor.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(getDashboardHtml());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[http-server] Port ${port} sedang digunakan. Mencoba port ${port + 1}...`);
        startHttpServer(port + 1).then(resolve);
      } else {
        console.error('[http-server-error]', err);
      }
    });

    server.listen(port, '127.0.0.1', () => {
      activeServer = server;
      console.log(`[http-server] 📡 Dashboard monitor socket berjalan di: http://127.0.0.1:${port}/`);
      resolve(port);
    });
  });
}

function getDashboardHtml(): string {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>📡 GMGN 5-Tab Live Socket Monitor</title>
<style>
:root{
  --bg:#070d18;
  --surface:#0e1828;
  --surface-border:#1e2e44;
  --text:#e8eff8;
  --muted:#8ea2be;
  --green:#58df9e;
  --red:#ff4d5a;
  --yellow:#ffb038;
  --blue:#4d97ff;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
header{background:#0a1322;border-bottom:1px solid var(--surface-border);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 4px 20px #0008}
.brand{display:flex;align-items:center;gap:12px}
.brand h1{margin:0;font-size:18px;font-weight:800;letter-spacing:0.5px;color:#fff}
.brand span{background:#1a3250;color:#7eb6f6;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700}
.stats-bar{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.badge{background:#111e2f;border:1px solid #233b58;padding:6px 12px;border-radius:8px;font-size:12px;display:inline-flex;align-items:center;gap:6px}
.badge b{color:#fff}
.badge.green{background:#0e291c;border-color:#1e5e3d;color:var(--green)}
.badge.green b{color:var(--green)}
.badge.red{background:#301115;border-color:#752129;color:var(--red)}
.btn-sound{background:#162b44;border:1px solid #2d4f79;color:#e8eff8;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
.btn-sound:hover{background:#1f3c60}

main{max-width:1800px;margin:auto;padding:20px}
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.section-head h2{margin:0;font-size:15px;color:#a3bad8;font-weight:700;text-transform:uppercase;letter-spacing:0.8px}

/* Grid 5 Kotak */
.five-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px;margin-bottom:28px}
@media(max-width:1450px){.five-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:900px){.five-grid{grid-template-columns:1fr}}

.slot-box{background:var(--surface);border:1px solid var(--surface-border);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;position:relative;transition:all .2s ease;box-shadow:0 8px 30px #0004}
.slot-box.has-warning{border-color:var(--red);animation:pulseBorder 1s infinite alternate}

@keyframes pulseBorder{
  0%{box-shadow:0 0 10px rgba(255,77,90,0.3),0 0 0 1px rgba(255,77,90,0.6)}
  100%{box-shadow:0 0 35px rgba(255,77,90,0.8),0 0 0 2px rgba(255,77,90,1)}
}

/* Empty Slot */
.slot-box.empty{border:2px dashed #20334a;background:#09121f66;min-height:380px;align-items:center;justify-content:center;text-align:center;padding:24px}
.slot-box.empty .empty-icon{font-size:36px;opacity:0.6;margin-bottom:12px}
.slot-box.empty .empty-title{font-size:15px;font-weight:700;color:#7e98ba}
.slot-box.empty .empty-sub{font-size:12px;color:#4c6687;margin-top:4px}

/* Active Slot Elements */
.slot-top{background:#132135;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--surface-border)}
.slot-num{background:#1d3554;color:#91c0f5;font-weight:800;font-size:11px;padding:3px 7px;border-radius:5px}
.slot-timer{color:var(--muted);font-size:11px;font-family:ui-monospace,monospace}
.slot-actions{display:flex;gap:6px}
.btn-mini{background:#1b324f;border:1px solid #33557e;color:#e8eff8;padding:3px 8px;border-radius:5px;font-size:11px;cursor:pointer;text-decoration:none}
.btn-mini:hover{background:#264872}
.btn-mini.danger{border-color:#7c242c;background:#381318;color:#ff9299}
.btn-mini.danger:hover{background:#541c23}

/* Big Warning Alert Banner */
.warning-banner{background:#4a0f15;border-bottom:2px solid var(--red);padding:10px 14px;animation:pulseBanner .8s infinite alternate}
@keyframes pulseBanner{
  0%{background:#420c12}
  100%{background:#66121b}
}
.warning-title{font-size:13px;font-weight:900;color:#fff;display:flex;align-items:center;gap:6px;letter-spacing:0.3px}
.warning-detail{font-size:11px;color:#ffc5c8;margin-top:3px;font-weight:600}
.warning-cta{margin-top:6px;background:var(--red);color:#fff;border:none;padding:5px 10px;border-radius:5px;font-weight:800;font-size:11px;cursor:pointer;width:100%;text-align:center}
.warning-cta:hover{background:#ff2938}

.slot-body{padding:14px;display:flex;flex-direction:column;gap:12px;flex:1}

/* Token Info Header */
.token-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.token-sym{font-size:18px;font-weight:800;color:#fff;line-height:1.2}
.token-name{font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:140px}
.token-mint{font:10px ui-monospace,monospace;color:#6782a2;cursor:pointer;margin-top:2px}
.token-mint:hover{color:var(--green)}

/* Price Card */
.price-row{background:#09121f;border:1px solid #1a2b40;border-radius:10px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between}
.price-val{font-size:20px;font-weight:800;color:#fff;letter-spacing:0.3px}
.price-chg{padding:3px 8px;border-radius:6px;font-size:12px;font-weight:700}
.price-chg.up{background:#0f3020;color:var(--green);border:1px solid #1f643f}
.price-chg.down{background:#381318;color:var(--red);border:1px solid #77242c}
.peak-row{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:4px;padding:0 4px}

/* Holders Metric */
.holder-card{background:#09121f;border:1px solid #1a2b40;border-radius:10px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between}
.holder-label{font-size:12px;color:var(--muted)}
.holder-val{font-size:18px;font-weight:800;color:#fff}
.holder-delta{font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px}
.holder-delta.up{background:#0f3020;color:var(--green)}
.holder-delta.down{background:#381318;color:var(--red);animation:pulseText 0.8s infinite alternate}
@keyframes pulseText{0%{opacity:0.6}100%{opacity:1}}

/* Volume / Ratio Bar */
.ratio-box{display:flex;flex-direction:column;gap:5px}
.ratio-labels{display:flex;justify-content:space-between;font-size:11px;font-weight:600}
.ratio-labels .b{color:var(--green)}
.ratio-labels .s{color:var(--red)}
.ratio-bar{height:6px;background:#381318;border-radius:3px;overflow:hidden;display:flex}
.ratio-fill-buy{height:100%;background:var(--green);transition:width .3s ease}

/* Live Trades Ticker */
.trades-ticker{background:#070d17;border:1px solid #142436;border-radius:8px;padding:8px;max-height:105px;overflow:hidden;display:flex;flex-direction:column;gap:4px}
.trade-row{display:flex;align-items:center;justify-content:space-between;font:11px ui-monospace,monospace;padding:2px 4px;border-radius:4px}
.trade-row.buy{color:var(--green);background:#08221644}
.trade-row.sell{color:var(--red);background:#33101444}
.trade-row.whale{background:#59141d;color:#fff;font-weight:700}

/* Closed History Panel */
.history-panel{background:var(--surface);border:1px solid var(--surface-border);border-radius:14px;padding:18px;box-shadow:0 8px 30px #0004}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #192a3e}
th{background:#08101d;color:#8ba2be;font-size:12px;font-weight:700}
td{font-size:13px}
.mono{font:11px ui-monospace,monospace;color:#6b87a8}
.btn-reopen{background:#173454;border:1px solid #2f5a89;color:#e8eff8;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600}
.btn-reopen:hover{background:#224c7b}
</style>
</head>
<body>

<header>
  <div class="brand">
    <h1>📡 GMGN SOCKET MONITOR</h1>
    <span>5 TAB LIVE</span>
  </div>
  <div class="stats-bar">
    <div class="badge" id="badge-active">Tab Aktif: <b>0 / 5</b></div>
    <div class="badge" id="badge-slots">Slot Kosong: <b>5</b></div>
    <div class="badge" id="badge-queue">Antrean: <b>0</b></div>
    <div class="badge red" id="badge-alerts" style="display:none">🚨 <b>0 WARNING SELL</b></div>
    <button class="btn-sound" id="btn-sound" onclick="toggleSound()">🔊 Suara: AKTIF</button>
  </div>
</header>

<main>
  <div class="section-head">
    <h2>🎯 5 Kotak Monitoring Socket (Live Trade, Holder, & Warning Sell)</h2>
    <span class="mono" id="last-ping" style="color:var(--muted)">Menghubungkan socket...</span>
  </div>

  <div class="five-grid" id="slots-grid">
    <!-- Render 5 Slot Boxes -->
  </div>

  <div class="history-panel">
    <div class="section-head" style="margin-bottom:8px">
      <h2>📁 Riwayat Tab Ditutup (Bisa Dibuka Kembali Kapan Saja)</h2>
      <span class="mono" id="closed-count" style="color:var(--muted)">0 riwayat</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Index</th>
            <th>Token</th>
            <th>Waktu Ditutup</th>
            <th>Durasi Aktif</th>
            <th>Harga Terakhir</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody id="history-body">
          <tr><td colspan="6" class="mono" style="text-align:center;padding:24px;color:var(--muted)">Belum ada tab yang ditutup. Tab yang Anda tutup di Chrome akan tersimpan di sini.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</main>

<script>
let isMuted = false;
let knownAlertSignatures = new Set();

function toggleSound() {
  isMuted = !isMuted;
  const btn = document.getElementById('btn-sound');
  if (isMuted) {
    btn.innerHTML = '🔇 Suara: MATI';
    btn.style.opacity = '0.7';
  } else {
    btn.innerHTML = '🔊 Suara: AKTIF';
    btn.style.opacity = '1';
    playWarningBeep();
  }
}

function playWarningBeep() {
  if (isMuted) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.35);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.38);
  } catch (e) {}
}

async function focusTab(mint) {
  try {
    await fetch('/api/focus/' + encodeURIComponent(mint), { method: 'POST' });
  } catch (e) {
    console.warn(e);
  }
}

async function closeTab(mint) {
  if (!confirm('Tutup tab untuk token ini? Token akan disimpan di riwayat dan slot baru akan terbuka.')) return;
  try {
    await fetch('/api/close/' + encodeURIComponent(mint), { method: 'POST' });
  } catch (e) {
    console.warn(e);
  }
}

async function reopenTab(indexOrMint) {
  try {
    await fetch('/api/reopen/' + encodeURIComponent(indexOrMint), { method: 'POST' });
  } catch (e) {
    console.warn(e);
  }
}

function fmtPrice(p) {
  if (!p) return '—';
  const n = Number(p);
  if (!Number.isFinite(n)) return '—';
  return '$' + (n < 0.0001 ? n.toFixed(8) : n.toFixed(6));
}

function fmtDur(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
}

function renderSlots(slots) {
  const container = document.getElementById('slots-grid');
  if (!container) return;

  let totalWarnings = 0;

  const html = slots.map(slot => {
    if (slot.isEmpty || !slot.tab) {
      return '<div class="slot-box empty">' +
        '<div class="empty-icon">📭</div>' +
        '<div class="empty-title">Slot #' + slot.slotNumber + ' Kosong</div>' +
        '<div class="empty-sub">Menunggu token lolos screening...</div>' +
      '</div>';
    }

    const t = slot.tab;
    const durSec = Math.max(0, Math.round((Date.now() - t.openedAt) / 1000));
    const chg = t.priceChangePercent ?? 0;
    const isUp = chg >= 0;
    const chgClass = isUp ? 'up' : 'down';
    const chgSign = isUp ? '+' : '';
    const chgStr = chgSign + chg.toFixed(2) + '%';
    const dd = t.drawdownPercent ?? 0;
    const ddStr = dd < 0 ? dd.toFixed(1) + '%' : '0%';

    const hDelta = t.holderDelta ?? 0;
    const hDeltaStr = hDelta > 0 ? ('+' + hDelta) : String(hDelta);
    const hDeltaClass = hDelta > 0 ? 'up' : hDelta < 0 ? 'down' : '';

    const bUsd = t.buyUsd ?? 0;
    const sUsd = t.sellUsd ?? 0;
    const totalVol = bUsd + sUsd;
    const buyPct = totalVol > 0 ? Math.round((bUsd / totalVol) * 100) : 50;

    // Check alerts
    const alerts = t.alerts ?? [];
    const hasWarn = t.hasWarning && alerts.length > 0;
    if (hasWarn) totalWarnings++;

    let alertBannerHtml = '';
    if (hasWarn) {
      const topAlert = alerts[0];
      alertBannerHtml = '<div class="warning-banner">' +
        '<div class="warning-title">' + topAlert.title + '</div>' +
        '<div class="warning-detail">' + topAlert.detail + '</div>' +
        '<button class="warning-cta" onclick="focusTab(\\'' + t.mint + '\\')">👉 KLIK UNTUK SELL DI TAB CHROME</button>' +
      '</div>';
    }

    // Trades ticker
    const recentTrades = (t.recentTrades ?? []).slice(0, 4);
    const tradesHtml = recentTrades.map(tr => {
      const isBig = tr.isBigSell;
      const rowClass = tr.side === 'buy' ? 'buy' : (isBig ? 'sell whale' : 'sell');
      const sideText = tr.side === 'buy' ? '🟢 BUY' : (isBig ? '🚨 WHALE SELL' : '🔴 SELL');
      const usdText = '$' + tr.amountUsd.toFixed(1);
      const timeAgo = Math.max(0, Math.round((Date.now() - tr.occurredAt) / 1000)) + 's';
      return '<div class="trade-row ' + rowClass + '">' +
        '<span>' + sideText + ' ' + usdText + '</span>' +
        '<span style="opacity:0.7">' + timeAgo + '</span>' +
      '</div>';
    }).join('') || '<div class="trade-row" style="color:var(--muted);justify-content:center">Belum ada trade...</div>';

    return '<div class="slot-box ' + (hasWarn ? 'has-warning' : '') + '">' +
      '<div class="slot-top">' +
        '<span class="slot-num">SLOT #' + slot.slotNumber + '</span>' +
        '<span class="slot-timer">⏱️ ' + fmtDur(durSec) + '</span>' +
        '<div class="slot-actions">' +
          '<button class="btn-mini" onclick="focusTab(\\'' + t.mint + '\\')">🎯 Chrome</button>' +
          '<button class="btn-mini danger" onclick="closeTab(\\'' + t.mint + '\\')">✕ Tutup</button>' +
        '</div>' +
      '</div>' +

      alertBannerHtml +

      '<div class="slot-body">' +
        '<div class="token-head">' +
          '<div>' +
            '<div class="token-sym">' + (t.symbol || 'Token') + '</div>' +
            '<div class="token-mint" title="Klik untuk fokus tab" onclick="focusTab(\\'' + t.mint + '\\')">' + t.mint.slice(0, 10) + '…' + t.mint.slice(-6) + '</div>' +
          '</div>' +
          '<a href="' + t.url + '" target="_blank" class="btn-mini" style="font-size:10px">Buka GMGN</a>' +
        '</div>' +

        '<div class="price-row">' +
          '<div class="price-val">' + fmtPrice(t.lastPriceUsd) + '</div>' +
          '<div class="price-chg ' + chgClass + '">' + chgStr + '</div>' +
        '</div>' +
        '<div class="peak-row">' +
          '<span>Puncak: ' + fmtPrice(t.peakPriceUsd) + '</span>' +
          '<span style="color:' + (dd < -5 ? 'var(--red)' : 'var(--muted)') + '">Drawdown: ' + ddStr + '</span>' +
        '</div>' +

        '<div class="holder-card">' +
          '<div>' +
            '<div class="holder-label">Jumlah Holder</div>' +
            '<div class="holder-val">' + (t.holders ?? '—') + '</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            (hDelta !== 0 ? '<span class="holder-delta ' + hDeltaClass + '">' + hDeltaStr + '</span>' : '<span style="color:var(--muted);font-size:11px">Tetap</span>') +
            (t.holderDeclineStreak ? '<div style="color:var(--red);font-size:10px;margin-top:2px">Turun ' + t.holderDeclineStreak + 'x</div>' : '') +
          '</div>' +
        '</div>' +

        '<div class="ratio-box">' +
          '<div class="ratio-labels">' +
            '<span class="b">Beli: $' + bUsd.toFixed(0) + ' (' + (t.buysCount ?? 0) + ')</span>' +
            '<span class="s">Jual: $' + sUsd.toFixed(0) + ' (' + (t.sellsCount ?? 0) + ')</span>' +
          '</div>' +
          '<div class="ratio-bar">' +
            '<div class="ratio-fill-buy" style="width:' + buyPct + '%"></div>' +
          '</div>' +
        '</div>' +

        '<div>' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:4px;display:flex;justify-content:space-between">' +
            '<span>Stream Trade Socket</span>' +
            '<span style="color:var(--green)">0.01 SOL Pre-filled</span>' +
          '</div>' +
          '<div class="trades-ticker">' + tradesHtml + '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  container.innerHTML = html;

  // Header badges update
  const alertBadge = document.getElementById('badge-alerts');
  if (totalWarnings > 0) {
    alertBadge.style.display = 'inline-flex';
    alertBadge.innerHTML = '🚨 <b>' + totalWarnings + ' WARNING SELL!</b>';
    document.title = '🚨 (' + totalWarnings + ' SELL ALERT) GMGN Socket Monitor';
  } else {
    alertBadge.style.display = 'none';
    document.title = '📡 GMGN 5-Tab Live Socket Monitor';
  }
}

function renderHistory(closedList) {
  const tbody = document.getElementById('history-body');
  if (!tbody) return;

  document.getElementById('closed-count').textContent = (closedList ? closedList.length : 0) + ' riwayat';

  if (!closedList || !closedList.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="mono" style="text-align:center;padding:24px;color:var(--muted)">Belum ada tab yang ditutup. Tab yang Anda tutup di Chrome akan tersimpan di sini.</td></tr>';
    return;
  }

  tbody.innerHTML = closedList.map(c => {
    const closedAgo = Math.max(0, Math.round((Date.now() - c.closedAt) / 1000));
    return '<tr>' +
      '<td><b>#' + c.index + '</b></td>' +
      '<td><b>' + (c.symbol || 'Token') + '</b><br><span class="mono">' + c.mint.slice(0, 10) + '…' + c.mint.slice(-6) + '</span></td>' +
      '<td>' + fmtDur(closedAgo) + ' lalu</td>' +
      '<td>' + fmtDur(c.durationSeconds) + '</td>' +
      '<td>' + fmtPrice(c.lastPriceUsd) + '</td>' +
      '<td>' +
        '<button class="btn-reopen" onclick="reopenTab(' + c.index + ')">🔄 Buka Kembali di Tab</button> ' +
        '<a href="' + c.url + '" target="_blank" class="btn-mini">Buka GMGN</a>' +
      '</td>' +
    '</tr>';
  }).join('');
}

async function pollState() {
  try {
    const res = await fetch('/api/state', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    document.getElementById('badge-active').innerHTML = 'Tab Aktif: <b>' + data.activeCount + ' / ' + data.maxTabs + '</b>';
    document.getElementById('badge-slots').innerHTML = 'Slot Kosong: <b>' + data.availableSlots + '</b>';
    document.getElementById('badge-queue').innerHTML = 'Antrean: <b>' + data.pendingQueueCount + '</b>';
    document.getElementById('last-ping').textContent = 'Live Socket OK • ' + new Date().toLocaleTimeString('id-ID');

    // Detect new DANGER alerts and beep
    let hasNewDanger = false;
    for (const tab of data.activeTabs || []) {
      for (const alert of tab.alerts || []) {
        const sig = tab.mint + ':' + alert.type + ':' + Math.floor(alert.occurredAt / 10000);
        if (!knownAlertSignatures.has(sig)) {
          knownAlertSignatures.add(sig);
          if (alert.level === 'DANGER') hasNewDanger = true;
        }
      }
    }

    if (hasNewDanger) playWarningBeep();

    renderSlots(data.slots || []);
    renderHistory(data.closedHistory || []);
  } catch (err) {
    document.getElementById('last-ping').textContent = '⚠️ Menghubungkan ulang...';
  }
  setTimeout(pollState, 1000);
}

// Start polling
pollState();
</script>
</body>
</html>`;
}

async function main(): Promise<void> {
  console.log(`\n====================================================================`);
  console.log(`🚀 MEMULAI TAB MONITOR & 5-KOTAK SOCKET MONITORING DASHBOARD`);
  console.log(`Maksimal Tab Aktif : ${maxTabs}`);
  console.log(`Pre-filled Buy     : ${buyAmountSol} SOL (manual buy)`);
  console.log(`Profil Browser     : ${values.profileDir} (${values.profileName})`);
  console.log(`Feed URL           : ${config.feedUrl}`);
  console.log(`====================================================================\n`);

  // Start internal HTTP server for the 5-box dashboard
  const runningPort = await startHttpServer(serverPort);
  const dashboardUrl = `http://127.0.0.1:${runningPort}/`;

  writeDashboardReport();

  // Launch Playwright Chrome context
  context = await chromium.launchPersistentContext(values.profileDir, {
    channel: config.browserChannel || undefined,
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--profile-directory=' + values.profileName],
    ignoreDefaultArgs: values.enableExtensions ? ['--disable-extensions'] : undefined,
  });

  // Open the 5-box Socket Monitor Dashboard in a dedicated, clean dashboard window
  try {
    dashboardPage = await context.newPage();
    await dashboardPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    console.log(`[dashboard-opened] 🖥️ Dashboard 5-Kotak Socket Monitor dibuka di browser: ${dashboardUrl}`);
  } catch (err) {
    console.warn('[dashboard-open-error]', err);
  }

  // Open feed page in tab 0
  feedPage = context.pages()[0] ?? (await context.newPage());
  attachCapture(feedPage, () => {}, (payload, now, source) => {
    for (const metadata of parseTokenMetadata(payload)) {
      const known = candidates.get(metadata.mint);
      if (known) merge({ mint: metadata.mint, firstSeenAt: known.firstSeenAt, updatedAt: now, fields: {}, metadata: metadata.metadata });
    }
    for (const update of parseCandidates(payload, config.mappings, now, source)) {
      const candidate = merge(update);
      if (!inspected.has(candidate.mint)) {
        if (passesInitialScreen(candidate, now)) {
          inspected.add(candidate.mint);
          console.log(`[screen-pass] ⭐ Token lolos screening: ${candidate.metadata?.symbol ?? candidate.mint} (${candidate.mint})`);
          if (tabManager.canOpen()) {
            openDetailTab(candidate.mint, candidate);
          } else {
            queue.push(candidate.mint, now);
            console.log(`[queue-push] ⏳ Tab penuh (${tabManager.getActiveCount()}/${maxTabs}). Token dimasukkan ke antrean.`);
            logStatus();
            writeDashboardReport();
          }
        }
      }
    }
  });

  await feedPage.goto(config.feedUrl, { waitUntil: 'commit', timeout: config.workerTimeoutMs });
  console.log(`[feed-connected] Feed GMGN terhubung di Tab GMGN. Memindai token lolos screening...\n`);

  // Start CLI interactive interface
  startCliInterface();

  // Periodic heartbeat log and report generation every 10 seconds
  const heartbeat = setInterval(() => {
    logStatus();
    writeDashboardReport();
  }, 10_000);

  // Handle termination signals
  const cleanup = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(heartbeat);
    console.log('\n[tab-monitor] Menghentikan monitor...');
    writeDashboardReport();
    if (activeServer) activeServer.close();
    if (context) await context.close().catch(() => {});
    process.exit(0);
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  if (values.seconds) {
    const runSeconds = Number(values.seconds);
    if (Number.isFinite(runSeconds) && runSeconds > 0) {
      setTimeout(cleanup, runSeconds * 1000);
    }
  }
}

main().catch(err => {
  console.error('[tab-monitor-fatal-error]', err);
  process.exitCode = 1;
});
