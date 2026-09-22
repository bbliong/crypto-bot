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
    maxTabs: { type: 'string', default: '1' },
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
const maxTabs = Math.max(1, Math.min(20, Number(values.maxTabs) || 1));
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
let userActivePage: Page | null = null;
let isOpeningBackgroundTab = false;

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
    const pendingMints = queue.getPendingMints();
    const queueItems = pendingMints.map(m => {
      const c = candidates.get(m);
      return {
        mint: m,
        symbol: c?.metadata?.symbol || 'Token',
        name: c?.metadata?.name || '',
        imageUrl: c?.metadata?.imageUrl || '',
        priceUsd: num(c, 'priceUsd') || 0,
        marketCapUsd: num(c, 'marketCapUsd') || 0,
        liquidityUsd: num(c, 'liquidityUsd') || 0,
        top10Percent: num(c, 'top10Percent') || 0,
        holders: num(c, 'holders') || 0,
        createdAt: num(c, 'createdAt') || Date.now(),
      };
    });

    const payload = {
      updatedAt: new Date().toISOString(),
      maxTabs,
      buyAmountSol,
      activeCount: summary.activeCount,
      availableSlots: summary.availableSlots,
      slots: summary.slots,
      activeTab: summary.activeTabs[0] || null,
      activeTabs: summary.activeTabs,
      closedCount: summary.closedCount,
      closedHistory: summary.closedHistory,
      pendingQueueCount: queueItems.length,
      queueItems,
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
  const current = (await input.inputValue().catch(() => '')).trim();
  if (current === solAmount) return;

  // Background-safe update using native HTMLInputElement property setter and events.
  // This avoids clicking or firing keypresses that could interfere with active windows.
  await input.evaluate((el: HTMLInputElement, val: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.value = val;
    }
  }, solAmount).catch(() => {});

  const afterEval = (await input.inputValue().catch(() => '')).trim();
  if (afterEval !== solAmount) {
    await input.fill(solAmount).catch(() => {});
  }
}

async function prepareBuyPanel(page: Page, solAmount: string, symbol: string): Promise<void> {
  await selectTradeSide(page, 'buy');
  await safelySetAmount(page, solAmount);
  console.log(`[ui-prep] 💰 ${symbol}: Panel Buy disiapkan dengan nominal ${solAmount} SOL. (Siap untuk manual buy).`);
}

async function getCurrentlyActivePage(): Promise<Page | null> {
  if (userActivePage && !userActivePage.isClosed()) {
    try {
      const isVisible = await userActivePage.evaluate(() => document.visibilityState === 'visible' && !document.hidden).catch(() => false);
      if (isVisible) return userActivePage;
    } catch {}
  }
  if (context) {
    const pages = context.pages();
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i];
      if (p.isClosed()) continue;
      try {
        const isVisible = await p.evaluate(() => document.visibilityState === 'visible' && !document.hidden).catch(() => false);
        if (isVisible) {
          userActivePage = p;
          return p;
        }
      } catch {}
    }
  }
  return userActivePage && !userActivePage.isClosed() ? userActivePage : null;
}

async function createBackgroundPage(targetUrl = 'about:blank'): Promise<Page> {
  if (!context) throw new Error('Browser context not initialized');

  const activePage = await getCurrentlyActivePage();
  isOpeningBackgroundTab = true;

  let newPage: Page | null = null;

  try {
    const sessionHost = (activePage && !activePage.isClosed())
      ? activePage
      : (feedPage && !feedPage.isClosed() ? feedPage : context.pages().find(p => !p.isClosed()));

    if (sessionHost) {
      const cdp = await context.newCDPSession(sessionHost);
      const pagePromise = context.waitForEvent('page', { timeout: 10_000 });
      try {
        await cdp.send('Target.createTarget', {
          url: targetUrl,
          background: true,
        });
        newPage = await pagePromise;
      } finally {
        await cdp.detach().catch(() => {});
      }
    }
  } catch (err) {
    console.warn('[background-tab-warn] CDP Target.createTarget gagal, fallback ke context.newPage():', err instanceof Error ? err.message : err);
  }

  if (!newPage) {
    newPage = await context.newPage();
  }

  // Restore focus to user's active tab if Chromium shifted focus
  if (activePage && !activePage.isClosed() && activePage !== newPage) {
    try {
      await activePage.bringToFront();
    } catch {}
  }

  isOpeningBackgroundTab = false;
  return newPage;
}

function applyDetailApiResponse(mint: string, url: string, json: any): void {
  if (!json || typeof json !== 'object') return;

  if (url.includes('token_holders') || url.includes('top_holders')) {
    const list = Array.isArray(json?.data?.list) ? json.data.list
      : (Array.isArray(json?.data?.holders) ? json.data.holders : (Array.isArray(json?.data) ? json.data : []));

    if (list.length > 0) {
      let top10Sum = 0;
      let top5Sum = 0;
      let top1 = 0;
      let devPct = 0;

      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        let pct = Number(item.amount_percentage ?? item.percentage ?? item.hold_ratio ?? 0);
        if (pct > 0 && pct <= 1) pct = pct * 100;

        if (i === 0) top1 = pct;
        if (i < 5) top5Sum += pct;
        if (i < 10) top10Sum += pct;

        const tag = String(item.wallet_tag_v2 ?? item.tag ?? item.tags ?? '').toUpperCase();
        if (tag.includes('DEV') || tag.includes('CREATOR')) {
          devPct += pct;
        }
      }

      tabManager.updateTokenMetrics(mint, {
        top10Percent: Math.round(top10Sum * 10) / 10,
        top5Percent: Math.round(top5Sum * 10) / 10,
        singlePercent: Math.round(top1 * 10) / 10,
        developerPercent: Math.round(devPct * 10) / 10,
      });
      writeDashboardReport();
    }
  }

  if (url.includes('token_security')) {
    const sec = json?.data;
    if (sec) {
      const top10 = Number(sec.top_10_holder_rate ?? sec.top10_holder_rate);
      const devHold = Number(sec.dev_holder_rate ?? sec.dev_hold_rate ?? sec.dev_token_burn_ratio);
      const updates: Record<string, number> = {};
      if (Number.isFinite(top10) && top10 > 0) {
        updates.top10Percent = top10 > 1 ? top10 : top10 * 100;
      }
      if (Number.isFinite(devHold) && devHold >= 0) {
        updates.developerPercent = devHold > 1 ? devHold : devHold * 100;
      }
      if (Object.keys(updates).length > 0) {
        tabManager.updateTokenMetrics(mint, updates);
        writeDashboardReport();
      }
    }
  }
}

async function openDetailTab(mint: string, candidate?: Candidate): Promise<boolean> {
  if (!context) return false;
  if (!tabManager.canOpen()) return false;
  if (tabManager.isTabActive(mint)) return false;

  const symbol = candidate?.metadata?.symbol ?? 'Token';
  const name = candidate?.metadata?.name ?? undefined;
  const imageUrl = candidate?.metadata?.imageUrl ?? undefined;
  const url = config.tokenUrlTemplate.replaceAll('{mint}', mint);
  const initialPrice = num(candidate, 'priceUsd') ?? undefined;
  const initialHolders = num(candidate, 'holders') ?? undefined;
  const top10 = num(candidate, 'top10Percent') ?? undefined;
  const top5 = num(candidate, 'top5Percent') ?? undefined;
  const single = num(candidate, 'singlePercent') ?? undefined;
  const dev = num(candidate, 'developerPercent') ?? undefined;
  const mcap = num(candidate, 'marketCapUsd') ?? undefined;
  const liq = num(candidate, 'liquidityUsd') ?? undefined;
  const createdAt = num(candidate, 'createdAt') ?? undefined;

  // Remember the user's current active tab so focus is never lost
  const activeBefore = await getCurrentlyActivePage();

  try {
    const page = await createBackgroundPage('about:blank');
    openPages.set(mint, page);
    tabManager.openTab(mint, symbol, url, name, Date.now(), initialPrice, initialHolders, {
      imageUrl,
      marketCapUsd: mcap,
      liquidityUsd: liq,
      createdAt,
      top10Percent: top10,
      top5Percent: top5,
      singlePercent: single,
      developerPercent: dev,
    });

    // Listen to HTTP responses from GMGN for holders and token stats
    page.on('response', async res => {
      const u = res.url();
      if (u.includes('token_holders') || u.includes('top_holders') || u.includes('token_security') || u.includes('token_stat')) {
        try {
          const json = await res.json();
          applyDetailApiResponse(mint, u, json);
        } catch {}
      }
    });

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
      // 1. Holder updates and token metrics from candidate payload
      for (const update of parseCandidates(payload, config.mappings, now, 'detail')) {
        if (update.mint === mint) {
          const c = merge(update);
          const holders = num(c, 'holders') ?? undefined;
          if (holders !== undefined) {
            tabManager.recordHolderSample(mint, holders, now);
          }
          tabManager.updateTokenMetrics(mint, {
            holders,
            lastPriceUsd: num(c, 'priceUsd') ?? undefined,
            marketCapUsd: num(c, 'marketCapUsd') ?? undefined,
            liquidityUsd: num(c, 'liquidityUsd') ?? undefined,
            top10Percent: num(c, 'top10Percent') ?? undefined,
          });
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

    console.log(`\n[tab-opened] 🌐 Tab baru dibuka di latar belakang (background): ${symbol} (${mint}). Tab aktif: ${tabManager.getActiveCount()}/${maxTabs}`);
    logStatus();
    writeDashboardReport();

    // Navigate to the GMGN token page in the background
    await page.goto(url, { waitUntil: 'commit', timeout: config.workerTimeoutMs });

    // Pre-fill amount buy 0.01 SOL (tanpa klik submit) secara background-safe
    await page.waitForTimeout(1000);
    await prepareBuyPanel(page, buyAmountSol, symbol).catch(err => {
      console.warn(`[ui-prep-warn] ${symbol} tidak dapat mengisi nominal buy:`, err instanceof Error ? err.message : err);
    });

    // Query token holders API in the browser session after page load
    setTimeout(async () => {
      if (page.isClosed()) return;
      try {
        const holderData = await page.evaluate(async (m: string) => {
          try {
            const res = await fetch(`/vas/api/v1/token_holders/sol/${encodeURIComponent(m)}?limit=20&cost=20&orderby=amount_percentage&direction=desc`, { credentials: 'include' });
            if (res.ok) return await res.json();
          } catch {}
          return null;
        }, mint);
        if (holderData) applyDetailApiResponse(mint, 'token_holders', holderData);
      } catch {}
    }, 2500);

    // Ensure user's active tab is still in front
    if (activeBefore && !activeBefore.isClosed()) {
      await activeBefore.bringToFront().catch(() => {});
    }

    return true;
  } catch (error) {
    console.error(`[tab-open-error] Gagal membuka tab untuk ${mint}:`, error instanceof Error ? error.message : error);
    openPages.delete(mint);
    tabManager.closeTab(mint);
    if (activeBefore && !activeBefore.isClosed()) {
      await activeBefore.bringToFront().catch(() => {});
    }
    return false;
  }
}

async function processNextInQueue(): Promise<void> {
  if (stopping) return;
  while (tabManager.canOpen()) {
    const mint = queue.take();
    if (!mint) break;
    const candidate = candidates.get(mint);
    console.log(`[queue-take] 🎯 Mengambil token paling terakhir dipilih dari antrean: ${candidate?.metadata?.symbol ?? mint} (${mint})`);
    const success = await openDetailTab(mint, candidate);
    if (!success) {
      queue.done(mint);
    }
  }
}

async function focusTab(mint: string): Promise<boolean> {
  const page = openPages.get(mint);
  if (!page || page.isClosed()) return false;
  try {
    userActivePage = page;
    await page.bringToFront();
    console.log(`[focus-tab] Tab ${mint} dibawa ke depan di browser Chrome.`);
    return true;
  } catch {
    return false;
  }
}

async function reopenTabByQuery(query: string | number): Promise<void> {
  // If single active tab is already occupied, close it first so reopened tab can take the active slot
  if (!tabManager.canOpen()) {
    const active = tabManager.getActiveTabs()[0];
    if (active) {
      const page = openPages.get(active.mint);
      if (page) {
        await page.close().catch(() => {});
      } else {
        queue.done(active.mint);
        tabManager.closeTab(active.mint);
      }
    }
  }

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

function closeTabByQuery(query?: string | number): void {
  let targetMint: string | null = null;
  const activeTabs = tabManager.getActiveTabs();

  if (!query || String(query).trim() === '' || String(query).trim() === '1') {
    if (activeTabs.length > 0) targetMint = activeTabs[0].mint;
  } else if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
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
    console.log(`[close-failed] ⚠️ Tidak ada tab aktif yang dapat ditutup.`);
    return;
  }

  const page = openPages.get(targetMint);
  if (page) {
    console.log(`[close] Menutup tab ${targetMint}... Sistem akan otomatis mengambil token paling terakhir dipilih dari antrean.`);
    page.close().catch(() => {});
  } else {
    queue.done(targetMint);
    tabManager.closeTab(targetMint);
    logStatus();
    writeDashboardReport();
    processNextInQueue();
  }
}

function printCliList(): void {
  const active = tabManager.getActiveTabs();
  const closed = tabManager.getClosedHistory();
  const pendingCount = queue.getPendingCount();

  console.log(`\n========================================================================`);
  console.log(`🟢 TAB DETAIL AKTIF (${active.length}/${maxTabs}):`);
  if (!active.length) {
    console.log(`   (Tidak ada tab detail aktif saat ini. Menunggu screening/antrean)`);
  } else {
    active.forEach((t, i) => {
      const dur = Math.round((Date.now() - t.openedAt) / 1000);
      const warn = t.hasWarning ? ' 🚨 [WARNING SELL!]' : '';
      console.log(`   [#${i + 1}] ${t.symbol.padEnd(10)} | ${t.mint} | ${dur}s aktif | Harga: ${t.lastPriceUsd ? '$' + t.lastPriceUsd : '—'} | Holders: ${t.holders ?? '—'}${warn}`);
    });
  }

  console.log(`\n⏳ ANTREAN TOKEN (${pendingCount} token menunggu):`);
  const topPending = queue.getPendingMints().slice(0, 5);
  if (!topPending.length) {
    console.log(`   (Antrean kosong)`);
  } else {
    topPending.forEach((m, idx) => {
      const c = candidates.get(m);
      console.log(`   [Next #${idx + 1}] ${c?.metadata?.symbol ?? 'Token'} (${m})`);
    });
  }

  console.log(`\n📁 RIWAYAT DETAIL DITUTUP (Dapat Dibuka Kembali):`);
  if (!closed.length) {
    console.log(`   (Belum ada riwayat tab yang ditutup)`);
  } else {
    closed.slice(0, 10).forEach(c => {
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
      case 'next':
        console.log(`[next] Menutup tab saat ini dan mengambil token paling terakhir dipilih dari antrean...`);
        closeTabByQuery();
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
        closeTabByQuery(arg);
        break;
      case 'help':
        console.log(`
Perintah CLI yang tersedia:
  status               - Tampilkan jumlah tab aktif dan status antrean
  list / ls            - Tampilkan tabel detail tab aktif, antrean, dan riwayat tab yang ditutup
  next                 - Tutup tab saat ini dan langsung buka token terbaru dari antrean
  reopen <index|mint>  - Buka kembali detail token yang pernah ditutup (contoh: reopen 1)
  close [no|mint]      - Tutup tab aktif dan buka token berikutnya dari antrean
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

      // API: Get current single-tab live state
      if (pathname === '/api/state') {
        const summary = tabManager.getStatusSummary();
        const pendingMints = queue.getPendingMints();
        const queueItems = pendingMints.map(m => {
          const c = candidates.get(m);
          return {
            mint: m,
            symbol: c?.metadata?.symbol || 'Token',
            name: c?.metadata?.name || '',
            imageUrl: c?.metadata?.imageUrl || '',
            priceUsd: num(c, 'priceUsd') || 0,
            marketCapUsd: num(c, 'marketCapUsd') || 0,
            liquidityUsd: num(c, 'liquidityUsd') || 0,
            top10Percent: num(c, 'top10Percent') || 0,
            holders: num(c, 'holders') || 0,
            createdAt: num(c, 'createdAt') || Date.now(),
          };
        });
        const payload = {
          updatedAt: new Date().toISOString(),
          maxTabs,
          buyAmountSol,
          activeCount: summary.activeCount,
          availableSlots: summary.availableSlots,
          slots: summary.slots,
          activeTab: summary.activeTabs[0] || null,
          activeTabs: summary.activeTabs,
          closedCount: summary.closedCount,
          closedHistory: summary.closedHistory,
          pendingQueueCount: queueItems.length,
          queueItems,
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

      // API: Close browser tab by mint (or active tab) and immediately open newest from queue
      if (pathname.startsWith('/api/close/')) {
        const mint = decodeURIComponent(pathname.slice('/api/close/'.length));
        closeTabByQuery(mint);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, mint }));
        return;
      }

      // API: Close current active tab and immediately take next token from queue
      if (pathname === '/api/next') {
        closeTabByQuery();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // API: Open specific token from queue
      if (pathname.startsWith('/api/open-queue/')) {
        const mint = decodeURIComponent(pathname.slice('/api/open-queue/'.length));
        if (tabManager.getActiveCount() > 0) {
          const active = tabManager.getActiveTabs()[0];
          const page = openPages.get(active.mint);
          if (page) await page.close().catch(() => {});
          else {
            queue.done(active.mint);
            tabManager.closeTab(active.mint);
          }
        }
        queue.remove(mint);
        const candidate = candidates.get(mint);
        const ok = await openDetailTab(mint, candidate);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: ok, mint }));
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
<title>🎯 GMGN 1-Tab Live Command Center</title>
<style>
:root{
  --bg:#060a12;
  --surface:#0c1422;
  --surface-border:#18283e;
  --surface-card:#0f1a2c;
  --text:#e8eff8;
  --muted:#8ea2be;
  --green:#3ee08f;
  --red:#ff4d5a;
  --yellow:#ffb536;
  --blue:#4d9bff;
  --purple:#a78bfa;
  --cyan:#22d3ee;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}
header{background:#09101c;border-bottom:1px solid var(--surface-border);padding:14px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;position:sticky;top:0;z-index:100;box-shadow:0 4px 25px #000a}
.brand{display:flex;align-items:center;gap:12px}
.brand h1{margin:0;font-size:18px;font-weight:900;letter-spacing:0.5px;color:#fff}
.brand span{background:#183658;color:#85c2ff;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:800}
.stats-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.badge{background:#101c2d;border:1px solid #1f3755;padding:6px 12px;border-radius:8px;font-size:12px;display:inline-flex;align-items:center;gap:6px}
.badge b{color:#fff}
.badge.green{background:#0b261a;border-color:#1c5a3b;color:var(--green)}
.badge.green b{color:var(--green)}
.badge.red{background:#301115;border-color:#752129;color:var(--red)}
.btn-sound{background:#162b44;border:1px solid #2d4f79;color:#e8eff8;padding:6px 12px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
.btn-sound:hover{background:#1f3c60}

main{max-width:1440px;margin:auto;padding:24px 20px 48px}
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.section-head h2{margin:0;font-size:15px;color:#a3bad8;font-weight:800;text-transform:uppercase;letter-spacing:0.8px}

/* Hero Active Tab Command Center Card */
.hero-card{background:var(--surface);border:1px solid var(--surface-border);border-radius:18px;overflow:hidden;box-shadow:0 12px 40px #0006;margin-bottom:28px;transition:border-color .2s ease}
.hero-card.has-warning{border-color:var(--red);box-shadow:0 0 35px rgba(255,77,90,0.4),0 0 0 1px rgba(255,77,90,0.8)}

/* Alert Banner */
.warning-banner{background:#4a0f15;border-bottom:2px solid var(--red);padding:14px 20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;animation:pulseBanner .8s infinite alternate}
@keyframes pulseBanner{0%{background:#3d0c11}100%{background:#611119}}
.warning-left{display:flex;flex-direction:column;gap:3px}
.warning-title{font-size:14px;font-weight:900;color:#fff;display:flex;align-items:center;gap:8px;letter-spacing:0.3px}
.warning-detail{font-size:12px;color:#ffc5c8;font-weight:600}
.warning-cta{background:var(--red);color:#fff;border:none;padding:8px 18px;border-radius:8px;font-weight:900;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;box-shadow:0 4px 15px rgba(255,77,90,0.5);transition:background .2s ease}
.warning-cta:hover{background:#ff2938}

/* Profile Bar */
.profile-bar{padding:18px 24px;background:#0d1828;border-bottom:1px solid var(--surface-border);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px}
.profile-left{display:flex;align-items:center;gap:16px;min-width:0}
.token-avatar-wrap{position:relative;width:56px;height:56px;flex-shrink:0}
.token-avatar{width:56px;height:56px;border-radius:14px;object-fit:cover;border:2px solid #233b58;background:#09121f}
.token-avatar-fallback{width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,#1e3e6b,#102847);border:2px solid #2d4f79;color:#91c0f5;font-weight:900;font-size:18px;display:flex;align-items:center;justify-content:center}
.profile-meta{display:flex;flex-direction:column;gap:3px;min-width:0}
.profile-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.token-sym{font-size:22px;font-weight:900;color:#fff;letter-spacing:0.5px}
.token-name{font-size:13px;color:var(--muted);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.profile-sub{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:11px}
.token-mint{font:11px ui-monospace,monospace;color:#7e9bc0;cursor:pointer;background:#09121f;border:1px solid #1a2c42;padding:2px 8px;border-radius:5px}
.token-mint:hover{color:var(--green);border-color:#2a507a}
.link-btn{color:#7cb3f6;text-decoration:none;background:#14273d;border:1px solid #24446a;padding:2px 8px;border-radius:5px;font-weight:600}
.link-btn:hover{background:#1d395d;color:#fff}
.token-timer{color:var(--muted);font-family:ui-monospace,monospace;background:#0a1420;padding:2px 8px;border-radius:5px}

.profile-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn-action{padding:7px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid transparent;display:inline-flex;align-items:center;gap:6px;transition:all .15s ease}
.btn-action.primary{background:#183a63;border-color:#2d5b94;color:#e8f1fc}
.btn-action.primary:hover{background:#224f85}
.btn-action.next{background:#133327;border-color:#22634a;color:#55e09f}
.btn-action.next:hover{background:#1a4534}
.btn-action.danger{background:#381318;border-color:#79232c;color:#ff9aa1}
.btn-action.danger:hover{background:#541c23}

/* 4-Box Key Metrics Row */
.metrics-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:20px 24px;border-bottom:1px solid var(--surface-border)}
@media(max-width:960px){.metrics-strip{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.metrics-strip{grid-template-columns:1fr}}

.m-cell{background:var(--surface-card);border:1px solid var(--surface-border);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
.m-lbl{font-size:11px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px}
.m-val{font-size:22px;font-weight:900;color:#fff;letter-spacing:0.3px}
.m-sub{display:flex;align-items:center;gap:6px;font-size:11px;margin-top:2px}
.tag-chg{padding:2px 7px;border-radius:5px;font-weight:800;font-size:11px}
.tag-chg.up{background:#0e3020;color:var(--green);border:1px solid #1c5e3a}
.tag-chg.down{background:#381318;color:var(--red);border:1px solid #75222a}

/* Deep Analytics 2-Column Grid */
.analytics-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:24px;border-bottom:1px solid var(--surface-border)}
@media(max-width:900px){.analytics-grid{grid-template-columns:1fr}}

.panel-card{background:var(--surface-card);border:1px solid var(--surface-border);border-radius:14px;padding:18px 20px;display:flex;flex-direction:column;gap:14px}
.panel-head{display:flex;align-items:center;justify-content:space-between}
.panel-title{font-size:13px;font-weight:900;color:#c0d5ee;display:flex;align-items:center;gap:6px;letter-spacing:0.4px}

/* Buy Ratio Pill & Gauge */
.buy-ratio-pill{padding:4px 12px;border-radius:8px;font-size:13px;font-weight:900;letter-spacing:0.4px}
.buy-ratio-pill.strong-buy{background:#0d3621;color:var(--green);border:1px solid #1e633d}
.buy-ratio-pill.heavy-sell{background:#3d1419;color:var(--red);border:1px solid #7e242d}
.buy-ratio-pill.neutral{background:#1e2a3a;color:#c0d2e8;border:1px solid #2d3e54}

.ratio-bar-wrap{width:100%}
.ratio-bar{height:12px;background:#2b1216;border-radius:6px;overflow:hidden;display:flex;box-shadow:inset 0 1px 3px #0008}
.ratio-fill-buy{height:100%;background:linear-gradient(90deg,#16a34a,#3ee08f);transition:width .3s ease}
.ratio-fill-sell{height:100%;background:linear-gradient(90deg,#dc2626,#f87171);transition:width .3s ease}

.ratio-labels{display:flex;justify-content:space-between;font-size:11px;font-weight:700;margin-top:4px}
.ratio-labels .left{color:var(--green)}
.ratio-labels .right{color:var(--red)}

.flow-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.flow-box{background:#08111e;border:1px solid #142236;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:2px}
.flow-lbl{font-size:10px;color:var(--muted);text-transform:uppercase}
.flow-val{font-size:15px;font-weight:800;color:#fff}
.flow-val.green{color:var(--green)}
.flow-val.red{color:var(--red)}

.netflow-strip{background:#08111e;border:1px solid #142236;border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between}
.netflow-strip.pos{border-color:#1c5237}
.netflow-strip.neg{border-color:#661e25}

/* Holder Distribution */
.holder-delta-tag{font-size:11px;font-weight:800;padding:2px 8px;border-radius:5px}
.holder-delta-tag.up{background:#0e3020;color:var(--green)}
.holder-delta-tag.down{background:#381318;color:var(--red);animation:pulseText 0.8s infinite alternate}

.dist-bar-wrap{width:100%}
.dist-bar{height:12px;background:#132032;border-radius:6px;overflow:hidden;display:flex;box-shadow:inset 0 1px 3px #0008}
.dist-seg.top10{background:linear-gradient(90deg,#7c3aed,#a78bfa);transition:width .3s ease}
.dist-seg.dev{background:linear-gradient(90deg,#d97706,#fbbf24);transition:width .3s ease}
.dist-seg.retail{background:linear-gradient(90deg,#0891b2,#22d3ee);transition:width .3s ease}

.dist-legend{display:flex;gap:14px;font-size:10px;margin-top:4px}
.dist-legend span{display:inline-flex;align-items:center;gap:4px}
.dist-legend .dot{width:8px;height:8px;border-radius:2px}

.holder-cards-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:600px){.holder-cards-grid{grid-template-columns:repeat(2,1fr)}}
.h-card{background:#08111e;border:1px solid #142236;border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;align-items:center;text-align:center}
.h-lbl{font-size:10px;color:var(--muted)}
.h-val{font-size:13px;font-weight:800;color:#fff;margin-top:2px}
.h-tag{font-size:9px;font-weight:800;padding:2px 6px;border-radius:4px;margin-top:4px}
.h-tag.safe{background:#0a2c1b;color:var(--green);border:1px solid #165634}
.h-tag.warn{background:#38270a;color:var(--yellow);border:1px solid #6b4e18}
.h-tag.danger{background:#3d1419;color:var(--red);border:1px solid #7c242d}

/* Live Trade Tape */
.trades-tape-wrap{padding:18px 24px}
.tape-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.tape-title{font-size:12px;font-weight:800;color:#a3bad8;text-transform:uppercase;letter-spacing:0.5px}
.trades-list{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
@media(max-width:1100px){.trades-list{grid-template-columns:repeat(2,1fr)}}
@media(max-width:600px){.trades-list{grid-template-columns:1fr}}

.t-item{background:#08111e;border:1px solid #142236;border-radius:8px;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;font-family:ui-monospace,monospace;font-size:11px}
.t-item.buy{border-left:3px solid var(--green)}
.t-item.sell{border-left:3px solid var(--red)}
.t-item.whale{background:#421118;border-left:3px solid #ff2938;box-shadow:0 0 10px rgba(255,77,90,0.3)}

/* Empty State Card */
.empty-hero{background:var(--surface);border:2px dashed #1a2f47;border-radius:18px;padding:48px 24px;text-align:center;margin-bottom:28px}
.empty-hero .e-icon{font-size:48px;opacity:0.7;margin-bottom:12px}
.empty-hero h3{margin:0 0 6px;font-size:18px;color:#91b8e4}
.empty-hero p{margin:0 auto 16px;max-width:540px;color:var(--muted);font-size:13px}

/* Incoming Queue Panel */
.queue-panel{background:var(--surface);border:1px solid var(--surface-border);border-radius:18px;padding:20px 24px;margin-bottom:28px;box-shadow:0 8px 30px #0004}
.queue-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:12px}
.queue-item{background:#0a1422;border:1px solid #18283e;border-radius:12px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;transition:border-color .2s ease}
.queue-item:hover{border-color:#2a4569}
.q-left{display:flex;align-items:center;gap:10px;min-width:0}
.q-sym{font-size:14px;font-weight:900;color:#fff}
.q-sub{font-size:10px;color:var(--muted);font-family:ui-monospace,monospace}
.btn-open-q{background:#163b2a;border:1px solid #236345;color:var(--green);padding:5px 10px;border-radius:6px;font-size:11px;font-weight:800;cursor:pointer;white-space:nowrap}
.btn-open-q:hover{background:#1d4d37}

/* History Table Panel */
.history-panel{background:var(--surface);border:1px solid var(--surface-border);border-radius:18px;padding:20px 24px;box-shadow:0 8px 30px #0004}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid #152438}
th{background:#09121f;color:#8ba2be;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px}
td{font-size:13px}
.mono{font:11px ui-monospace,monospace;color:#6b87a8}
.btn-reopen{background:#173454;border:1px solid #2f5a89;color:#e8eff8;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:11px;font-weight:700}
.btn-reopen:hover{background:#224c7b}
</style>
</head>
<body>

<header>
  <div class="brand">
    <h1>🎯 GMGN 1-TAB COMMAND CENTER</h1>
    <span>LIVE SOCKET MONITOR</span>
  </div>
  <div class="stats-bar">
    <div class="badge" id="badge-active">Tab Aktif: <b>0 / 1</b></div>
    <div class="badge" id="badge-queue">Antrean: <b>0</b></div>
    <div class="badge green" title="Sistem otomatis membuka token terakhir dari antrean saat tab ditutup">🔄 Auto-Pick Terakhir: <b>AKTIF</b></div>
    <div class="badge red" id="badge-alerts" style="display:none">🚨 <b>WARNING SELL!</b></div>
    <button class="btn-sound" id="btn-sound" onclick="toggleSound()">🔊 Suara: AKTIF</button>
  </div>
</header>

<main>
  <div class="section-head">
    <h2>📡 Tab Detail Aktif (Monitoring Transaksi, Holder & Warning Sell)</h2>
    <span class="mono" id="last-ping" style="color:var(--muted)">Menghubungkan socket...</span>
  </div>

  <div id="active-tab-container">
    <!-- Render Single Tab Command Center or Empty State -->
  </div>

  <div class="queue-panel">
    <div class="section-head" style="margin-bottom:4px">
      <h2>⏳ Antrean Token Lolos Screening (<span id="queue-count">0</span> token)</h2>
      <span class="mono" style="color:var(--muted);font-size:11px">Saat tab ditutup, token paling terakhir dipilih akan otomatis dibuka</span>
    </div>
    <div class="queue-list" id="queue-list">
      <div style="color:var(--muted);font-size:12px;padding:12px">Antrean kosong. Menunggu sinyal scanner GMGN...</div>
    </div>
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
            <th>Top 10</th>
            <th>Buy Ratio</th>
            <th>Waktu Ditutup</th>
            <th>Durasi</th>
            <th>Harga Terakhir</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody id="history-body">
          <tr><td colspan="8" class="mono" style="text-align:center;padding:24px;color:var(--muted)">Belum ada tab yang ditutup. Tab yang ditutup di Chrome akan tersimpan di sini.</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</main>

<div id="toast" style="display:none;position:fixed;bottom:24px;right:24px;background:#193a61;color:#fff;border:1px solid #336199;padding:10px 18px;border-radius:8px;font-weight:700;z-index:9999;box-shadow:0 8px 30px #000a"></div>

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
  if (!confirm('Tutup tab untuk token ini? Sistem akan otomatis membuka token paling terakhir dari antrean.')) return;
  try {
    await fetch('/api/close/' + encodeURIComponent(mint), { method: 'POST' });
  } catch (e) {
    console.warn(e);
  }
}

async function nextTab() {
  try {
    await fetch('/api/next', { method: 'POST' });
  } catch (e) {
    console.warn(e);
  }
}

async function openQueue(mint) {
  try {
    await fetch('/api/open-queue/' + encodeURIComponent(mint), { method: 'POST' });
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

function copyMint(text) {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(text).then(function() {
    const toast = document.getElementById('toast');
    if (toast) {
      toast.textContent = '✅ Mint disalin: ' + text.slice(0, 8) + '…';
      toast.style.display = 'block';
      setTimeout(function() { toast.style.display = 'none'; }, 2000);
    }
  }).catch(function() {});
}

function fmtPrice(p) {
  if (!p) return '—';
  const n = Number(p);
  if (!Number.isFinite(n)) return '—';
  return '$' + (n < 0.0001 ? n.toFixed(8) : n.toFixed(6));
}

function fmtUsd(v) {
  if (v === undefined || v === null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1000000) return '$' + (n / 1000000).toFixed(2) + 'M';
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function fmtDur(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
}

function fmtTimeAgo(ts) {
  if (!ts) return 'baru';
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return sec + 's lalu';
  const m = Math.floor(sec / 60);
  if (m < 60) return m + 'm lalu';
  const h = Math.floor(m / 60);
  return h + 'j lalu';
}

function renderActiveTab(t) {
  const container = document.getElementById('active-tab-container');
  if (!container) return;

  if (!t) {
    container.innerHTML = '<div class="empty-hero">' +
      '<div class="e-icon">📭</div>' +
      '<h3>Tidak Ada Tab Detail Aktif</h3>' +
      '<p>Mode 1 tab aktif. Sistem sedang memantau feed socket. Saat token lolos kriteria screening, tab akan otomatis terbuka, atau Anda dapat membuka salah satu token dari antrean di bawah.</p>' +
      '<button class="btn-action next" onclick="nextTab()">▶ Ambil Token Terakhir Dari Antrean</button>' +
    '</div>';
    return;
  }

  const durSec = Math.max(0, Math.round((Date.now() - t.openedAt) / 1000));
  const chg = t.priceChangePercent ?? 0;
  const isUp = chg >= 0;
  const chgClass = isUp ? 'up' : 'down';
  const chgSign = isUp ? '+' : '';
  const chgStr = chgSign + chg.toFixed(2) + '%';
  const dd = t.drawdownPercent ?? 0;
  const ddStr = dd < 0 ? dd.toFixed(1) + '%' : '0%';

  // Holder delta
  const hDelta = t.holderDelta ?? 0;
  const hDeltaStr = hDelta > 0 ? ('+' + hDelta) : String(hDelta);
  const hDeltaClass = hDelta > 0 ? 'up' : hDelta < 0 ? 'down' : '';

  // Buy / Sell statistics
  const bUsd = t.buyUsd ?? 0;
  const sUsd = t.sellUsd ?? 0;
  const bCount = t.buysCount || 0;
  const sCount = t.sellsCount || 0;
  const totalVol = bUsd + sUsd;
  const buyPct = totalVol > 0 ? Math.round((bUsd / totalVol) * 1000) / 10 : (t.buyRatioPercent ?? 50);
  const sellPct = Math.max(0, Math.round((100 - buyPct) * 10) / 10);
  const netFlow = bUsd - sUsd;
  const netSign = netFlow >= 0 ? '+' : '';
  const netFlowStr = netSign + fmtUsd(Math.abs(netFlow));
  const buyPillClass = buyPct >= 65 ? 'strong-buy' : (buyPct <= 35 ? 'heavy-sell' : 'neutral');
  const avgBuy = bCount > 0 ? fmtUsd(bUsd / bCount) : '—';
  const avgSell = sCount > 0 ? fmtUsd(sUsd / sCount) : '—';

  // Holder distribution metrics
  const top10 = t.top10Percent ?? 0;
  const devPct = t.developerPercent ?? 0;
  const singlePct = t.singlePercent ?? 0;
  const retailPct = t.retailPercent ?? Math.max(0, Math.round((100 - top10 - devPct) * 10) / 10);

  const top10StatusClass = top10 <= 0 ? '' : (top10 <= 25 ? 'safe' : (top10 <= 35 ? 'warn' : 'danger'));
  const top10StatusText = top10 <= 0 ? '—' : (top10 <= 25 ? 'Aman' : (top10 <= 35 ? 'Waspada' : 'Bahaya'));

  const devStatusClass = devPct <= 0 ? 'safe' : (devPct <= 3 ? 'warn' : 'danger');
  const devStatusText = devPct <= 0 ? 'Clean (0%)' : (devPct.toFixed(1) + '%');

  // Check alerts
  const alerts = t.alerts ?? [];
  const hasWarn = t.hasWarning && alerts.length > 0;

  let alertBannerHtml = '';
  if (hasWarn) {
    const topAlert = alerts[0];
    alertBannerHtml = '<div class="warning-banner">' +
      '<div class="warning-left">' +
        '<div class="warning-title">🚨 PERINGATAN: ' + topAlert.title + '</div>' +
        '<div class="warning-detail">' + topAlert.detail + '</div>' +
      '</div>' +
      '<button class="warning-cta" onclick="focusTab(\\'' + t.mint + '\\')">👉 KLIK UNTUK SELL DI TAB CHROME (0.01 SOL Pre-filled)</button>' +
    '</div>';
  }

  // Trades ticker
  const recentTrades = (t.recentTrades ?? []).slice(0, 8);
  const tradesHtml = recentTrades.map(function(tr) {
    const isBig = tr.isBigSell;
    const rowClass = tr.side === 'buy' ? 'buy' : (isBig ? 'whale' : 'sell');
    const sideText = tr.side === 'buy' ? '🟢 BUY' : (isBig ? '🚨 WHALE SELL' : '🔴 SELL');
    const usdText = '$' + tr.amountUsd.toFixed(1);
    const timeAgo = Math.max(0, Math.round((Date.now() - tr.occurredAt) / 1000)) + 's';
    const walletShort = tr.wallet ? tr.wallet.slice(0, 4) + '…' : '';
    return '<div class="t-item ' + rowClass + '">' +
      '<span><b>' + sideText + '</b> ' + usdText + '</span>' +
      '<span style="opacity:0.75">' + (walletShort ? walletShort + ' • ' : '') + timeAgo + '</span>' +
    '</div>';
  }).join('') || '<div class="t-item" style="color:var(--muted);grid-column:1/-1;justify-content:center">Menunggu trade stream socket...</div>';

  container.innerHTML = '<div class="hero-card ' + (hasWarn ? 'has-warning' : '') + '">' +
    alertBannerHtml +

    // Profile Bar
    '<div class="profile-bar">' +
      '<div class="profile-left">' +
        '<div class="token-avatar-wrap">' +
          (t.imageUrl ? '<img class="token-avatar" src="' + t.imageUrl + '" onerror="this.style.display=\\'none\\'; this.nextElementSibling.style.display=\\'flex\\';" />' : '') +
          '<div class="token-avatar-fallback" style="' + (t.imageUrl ? 'display:none' : 'display:flex') + '">' + (t.symbol || '?').slice(0, 2).toUpperCase() + '</div>' +
        '</div>' +
        '<div class="profile-meta">' +
          '<div class="profile-title">' +
            '<span class="token-sym">' + (t.symbol || 'Token') + '</span>' +
            '<span class="token-name" title="' + (t.name || '') + '">' + (t.name || '') + '</span>' +
          '</div>' +
          '<div class="profile-sub">' +
            '<span class="token-mint" onclick="copyMint(\\'' + t.mint + '\\')" title="Klik untuk copy mint address">' + t.mint + ' 📋</span>' +
            '<a href="' + t.url + '" target="_blank" class="link-btn">GMGN ↗</a>' +
            '<a href="https://solscan.io/token/' + t.mint + '" target="_blank" class="link-btn">Solscan ↗</a>' +
            '<span class="token-timer">⏱️ Aktif: ' + fmtDur(durSec) + '</span>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="profile-actions">' +
        '<button class="btn-action primary" onclick="focusTab(\\'' + t.mint + '\\')">🎯 Fokus di Chrome</button>' +
        '<button class="btn-action next" onclick="nextTab()" title="Tutup tab ini dan otomatis buka token terbaru di antrean">⏭️ Next (Ambil Terbaru)</button>' +
        '<button class="btn-action danger" onclick="closeTab(\\'' + t.mint + '\\')">✕ Tutup Tab</button>' +
      '</div>' +
    '</div>' +

    // Key Stats Strip (4 Cells)
    '<div class="metrics-strip">' +
      '<div class="m-cell">' +
        '<span class="m-lbl">Harga Saat Ini</span>' +
        '<span class="m-val">' + fmtPrice(t.lastPriceUsd) + '</span>' +
        '<div class="m-sub"><span class="tag-chg ' + chgClass + '">' + chgStr + '</span><span style="color:var(--muted)">sejak dibuka</span></div>' +
      '</div>' +
      '<div class="m-cell">' +
        '<span class="m-lbl">Puncak & Drawdown</span>' +
        '<span class="m-val">' + fmtPrice(t.peakPriceUsd) + '</span>' +
        '<div class="m-sub"><span class="tag-chg ' + (dd < -10 ? 'down' : '') + '">DD: ' + ddStr + '</span><span style="color:var(--muted)">dari titik tertinggi</span></div>' +
      '</div>' +
      '<div class="m-cell">' +
        '<span class="m-lbl">Market Cap</span>' +
        '<span class="m-val">' + fmtUsd(t.marketCapUsd) + '</span>' +
        '<div class="m-sub" style="color:var(--muted)">Valuasi sirkulasi token</div>' +
      '</div>' +
      '<div class="m-cell">' +
        '<span class="m-lbl">Liquidity Pool</span>' +
        '<span class="m-val">' + fmtUsd(t.liquidityUsd) + '</span>' +
        '<div class="m-sub" style="color:var(--muted)">Umur token: ' + fmtTimeAgo(t.createdAt) + '</div>' +
      '</div>' +
    '</div>' +

    // Deep Analytics 2-Column Grid
    '<div class="analytics-grid">' +
      // Left: Persentase Pembelian
      '<div class="panel-card">' +
        '<div class="panel-head">' +
          '<span class="panel-title">🛒 PERSENTASE PEMBELIAN & VOLUME FLOW</span>' +
          '<span class="buy-ratio-pill ' + buyPillClass + '">' + (buyPct >= 50 ? '🟢' : '🔴') + ' ' + buyPct.toFixed(1) + '% BUY</span>' +
        '</div>' +
        '<div class="ratio-bar-wrap">' +
          '<div class="ratio-bar">' +
            '<div class="ratio-fill-buy" style="width:' + buyPct + '%"></div>' +
            '<div class="ratio-fill-sell" style="width:' + sellPct + '%"></div>' +
          '</div>' +
          '<div class="ratio-labels">' +
            '<span class="left">🟢 ' + buyPct.toFixed(1) + '% Beli</span>' +
            '<span class="right">🔴 ' + sellPct.toFixed(1) + '% Jual</span>' +
          '</div>' +
        '</div>' +
        '<div class="flow-grid">' +
          '<div class="flow-box"><span class="flow-lbl">🟢 Total Volume Beli</span><span class="flow-val green">$' + fmtUsd(bUsd) + ' <small style="font-size:11px;color:var(--muted)">(' + bCount + 'x order)</small></span></div>' +
          '<div class="flow-box"><span class="flow-lbl">🔴 Total Volume Jual</span><span class="flow-val red">$' + fmtUsd(sUsd) + ' <small style="font-size:11px;color:var(--muted)">(' + sCount + 'x order)</small></span></div>' +
          '<div class="flow-box"><span class="flow-lbl">Rata-rata Order Beli</span><span class="flow-val">' + avgBuy + '</span></div>' +
          '<div class="flow-box"><span class="flow-lbl">Rata-rata Order Jual</span><span class="flow-val">' + avgSell + '</span></div>' +
        '</div>' +
        '<div class="netflow-strip ' + (netFlow >= 0 ? 'pos' : 'neg') + '">' +
          '<div><span style="font-size:11px;color:var(--muted)">NET INFLOW / OUTFLOW:</span> <b style="font-size:15px;color:' + (netFlow >= 0 ? 'var(--green)' : 'var(--red)') + '">' + netFlowStr + '</b></div>' +
          '<span style="font-size:11px;font-weight:700;color:' + (buyPct >= 60 ? 'var(--green)' : (buyPct <= 40 ? 'var(--red)' : 'var(--muted)')) + '">' + (buyPct >= 60 ? '🔥 Momentum Beli Kuat' : (buyPct <= 40 ? '🚨 Tekanan Jual Tinggi' : '⚖️ Seimbang')) + '</span>' +
        '</div>' +
      '</div>' +

      // Right: Pembagian Holder
      '<div class="panel-card">' +
        '<div class="panel-head">' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="panel-title">👥 PEMBAGIAN HOLDER & DISTRIBUSI</span>' +
            '<span style="background:#182e49;color:#91c0f5;font-weight:800;font-size:12px;padding:2px 8px;border-radius:5px">' + (t.holders ?? '—') + ' holders</span>' +
          '</div>' +
          '<div>' +
            (hDelta !== 0 ? '<span class="holder-delta-tag ' + hDeltaClass + '">' + hDeltaStr + '</span>' : '<span style="color:var(--muted);font-size:11px">Holder Stabil</span>') +
            (t.holderDeclineStreak ? '<span style="color:var(--red);font-size:11px;margin-left:4px;font-weight:700">(-' + t.holderDeclineStreak + 'x turun)</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="dist-bar-wrap" title="Top 10: ' + top10 + '% | Dev: ' + devPct + '% | Retail: ' + retailPct + '%">' +
          '<div class="dist-bar">' +
            '<div class="dist-seg top10" style="width:' + Math.min(100, top10) + '%"></div>' +
            '<div class="dist-seg dev" style="width:' + Math.min(100 - top10, devPct) + '%"></div>' +
            '<div class="dist-seg retail" style="width:' + Math.max(0, 100 - top10 - devPct) + '%"></div>' +
          '</div>' +
          '<div class="dist-legend">' +
            '<span><span class="dot" style="background:#a78bfa"></span> Top 10 (' + top10.toFixed(1) + '%)</span>' +
            '<span><span class="dot" style="background:#fbbf24"></span> Dev (' + devPct.toFixed(1) + '%)</span>' +
            '<span><span class="dot" style="background:#22d3ee"></span> Retail (' + retailPct.toFixed(1) + '%)</span>' +
          '</div>' +
        '</div>' +
        '<div class="holder-cards-grid">' +
          '<div class="h-card"><span class="h-lbl">🟣 Top 10</span><span class="h-val">' + (top10 > 0 ? top10.toFixed(1) + '%' : '—') + '</span><span class="h-tag ' + top10StatusClass + '">' + top10StatusText + '</span></div>' +
          '<div class="h-card"><span class="h-lbl">👨‍💻 Dev</span><span class="h-val">' + (devPct > 0 ? devPct.toFixed(1) + '%' : (t.developerPercent !== undefined ? '0%' : '—')) + '</span><span class="h-tag ' + devStatusClass + '">' + devStatusText + '</span></div>' +
          '<div class="h-card"><span class="h-lbl">🎯 Top 1</span><span class="h-val">' + (singlePct > 0 ? singlePct.toFixed(1) + '%' : '—') + '</span><span class="h-tag safe">Paus Max</span></div>' +
          '<div class="h-card"><span class="h-lbl">🌐 Retail</span><span class="h-val">' + (retailPct > 0 ? retailPct.toFixed(1) + '%' : '—') + '</span><span class="h-tag safe">Komunitas</span></div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--muted);background:#08111e;border:1px solid #142236;border-radius:8px;padding:8px 12px">' +
          '<span>Evaluasi: ' + (top10 > 35 ? '⚠️ <b>Konsentrasi Tinggi:</b> Top 10 menguasai lebih dari 35% suplai.' : (devPct > 5 ? '⚠️ <b>Peringatan Dev:</b> Dompet pengembang memegang persentase signifikan.' : '✅ <b>Distribusi Sehat:</b> Kepemilikan token tersebar relatif merata tanpa dominasi ekstrem.')) + '</span>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // Live Trade Tape Strip
    '<div class="trades-tape-wrap">' +
      '<div class="tape-head">' +
        '<span class="tape-title">⚡ Live Socket Activity Stream (Real-Time Trade Tape)</span>' +
        '<span style="font-size:11px;color:var(--green)">Pre-filled: 0.01 SOL di Tab Chrome (Siap Klik Manual)</span>' +
      '</div>' +
      '<div class="trades-list">' + tradesHtml + '</div>' +
    '</div>' +
  '</div>';
}

function renderQueue(queueItems) {
  const container = document.getElementById('queue-list');
  const countEl = document.getElementById('queue-count');
  if (!container) return;

  const count = queueItems ? queueItems.length : 0;
  if (countEl) countEl.textContent = String(count);

  if (!queueItems || !queueItems.length) {
    container.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px">Antrean kosong. Menunggu token baru lolos kriteria screening GMGN...</div>';
    return;
  }

  container.innerHTML = queueItems.map(function(item, idx) {
    return '<div class="queue-item">' +
      '<div class="q-left">' +
        '<div style="background:#132338;color:#91c0f5;font-weight:900;font-size:11px;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center">#' + (idx + 1) + '</div>' +
        '<div style="min-width:0">' +
          '<div class="q-sym">' + (item.symbol || 'Token') + ' <span style="font-size:11px;font-weight:normal;color:var(--muted)">' + (item.name ? '(' + item.name.slice(0, 14) + ')' : '') + '</span></div>' +
          '<div class="q-sub">' + item.mint.slice(0, 6) + '…' + item.mint.slice(-4) + ' • MCap: ' + fmtUsd(item.marketCapUsd) + ' • Holders: ' + (item.holders ?? '—') + '</div>' +
        '</div>' +
      '</div>' +
      '<button class="btn-open-q" onclick="openQueue(\\'' + item.mint + '\\')">▶ Buka Sekarang</button>' +
    '</div>';
  }).join('');
}

function renderHistory(closedList) {
  const tbody = document.getElementById('history-body');
  if (!tbody) return;

  document.getElementById('closed-count').textContent = (closedList ? closedList.length : 0) + ' riwayat';

  if (!closedList || !closedList.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="mono" style="text-align:center;padding:24px;color:var(--muted)">Belum ada tab yang ditutup. Tab yang ditutup di Chrome akan tersimpan di sini.</td></tr>';
    return;
  }

  tbody.innerHTML = closedList.map(function(c) {
    const closedAgo = Math.max(0, Math.round((Date.now() - c.closedAt) / 1000));
    const top10Str = c.top10Percent ? c.top10Percent.toFixed(1) + '%' : '—';
    const buyRatioStr = c.buyRatioPercent ? c.buyRatioPercent.toFixed(1) + '%' : '—';
    return '<tr>' +
      '<td><b>#' + c.index + '</b></td>' +
      '<td><b>' + (c.symbol || 'Token') + '</b><br><span class="mono">' + c.mint.slice(0, 8) + '…' + c.mint.slice(-6) + '</span></td>' +
      '<td><span style="color:var(--purple);font-weight:700">' + top10Str + '</span></td>' +
      '<td><span style="color:var(--green);font-weight:700">' + buyRatioStr + '</span></td>' +
      '<td>' + fmtDur(closedAgo) + ' lalu</td>' +
      '<td>' + fmtDur(c.durationSeconds) + '</td>' +
      '<td>' + fmtPrice(c.lastPriceUsd) + '</td>' +
      '<td>' +
        '<button class="btn-reopen" onclick="reopenTab(' + c.index + ')">🔄 Buka Kembali</button> ' +
        '<a href="' + c.url + '" target="_blank" class="btn-action primary" style="padding:3px 8px;font-size:11px;text-decoration:none">GMGN ↗</a>' +
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

    const alertBadge = document.getElementById('badge-alerts');
    const activeTab = data.activeTab || (data.activeTabs && data.activeTabs[0]) || null;
    if (activeTab && activeTab.hasWarning) {
      alertBadge.style.display = 'inline-flex';
      alertBadge.innerHTML = '🚨 <b>WARNING SELL!</b>';
      document.title = '🚨 (' + (activeTab.symbol || 'SELL') + ') GMGN Command Center';
    } else {
      alertBadge.style.display = 'none';
      document.title = (activeTab ? ('[' + (activeTab.symbol || 'TOKEN') + '] ') : '') + '🎯 GMGN 1-Tab Command Center';
    }

    renderActiveTab(activeTab);
    renderQueue(data.queueItems || []);
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
  console.log(`🚀 MEMULAI TAB MONITOR & 1-TAB LIVE COMMAND CENTER DASHBOARD`);
  console.log(`Maksimal Tab Aktif : ${maxTabs}`);
  console.log(`Pre-filled Buy     : ${buyAmountSol} SOL (manual buy)`);
  console.log(`Profil Browser     : ${values.profileDir} (${values.profileName})`);
  console.log(`Feed URL           : ${config.feedUrl}`);
  console.log(`====================================================================\n`);

  // Start internal HTTP server for the 1-tab dashboard
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

  // Track active tab focus so background tabs never steal focus
  await context.exposeBinding('__tabActivated', ({ page }) => {
    if (!isOpeningBackgroundTab && page) {
      userActivePage = page;
    }
  }).catch(() => {});

  await context.addInitScript(() => {
    const notify = () => {
      try {
        (window as any).__tabActivated?.();
      } catch {}
    };
    window.addEventListener('focus', notify, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') notify();
    }, true);
    window.addEventListener('pointerdown', notify, true);
  }).catch(() => {});

  // Open the 1-Tab Socket Monitor Dashboard in a dedicated, clean dashboard window
  try {
    dashboardPage = await context.newPage();
    userActivePage = dashboardPage;
    await dashboardPage.goto(dashboardUrl, { waitUntil: 'domcontentloaded' });
    console.log(`[dashboard-opened] 🖥️ Dashboard 1-Tab Live Command Center dibuka di browser: ${dashboardUrl}`);
  } catch (err) {
    console.warn('[dashboard-open-error]', err);
  }

  // Open feed page in tab 0
  feedPage = context.pages().find(p => p !== dashboardPage) ?? (await context.newPage());
  attachCapture(feedPage, () => {}, (payload, now, source) => {
    for (const metadata of parseTokenMetadata(payload)) {
      const known = candidates.get(metadata.mint);
      if (known) merge({ mint: metadata.mint, firstSeenAt: known.firstSeenAt, updatedAt: now, fields: {}, metadata: metadata.metadata });
      if (tabManager.isTabActive(metadata.mint)) {
        tabManager.updateTokenMetrics(metadata.mint, {
          name: metadata.metadata.name,
          symbol: metadata.metadata.symbol,
          imageUrl: metadata.metadata.imageUrl,
        });
      }
    }
    for (const update of parseCandidates(payload, config.mappings, now, source)) {
      const candidate = merge(update);
      if (tabManager.isTabActive(candidate.mint)) {
        tabManager.updateTokenMetrics(candidate.mint, {
          holders: num(candidate, 'holders') ?? undefined,
          lastPriceUsd: num(candidate, 'priceUsd') ?? undefined,
          marketCapUsd: num(candidate, 'marketCapUsd') ?? undefined,
          liquidityUsd: num(candidate, 'liquidityUsd') ?? undefined,
          top10Percent: num(candidate, 'top10Percent') ?? undefined,
        });
      }
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
