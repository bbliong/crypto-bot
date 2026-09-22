import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { attachCapture } from './capture.js';
import { parseCandidates, parseTokenMetadata, validMint } from './parser.js';
import { CandidateQueue } from './queue.js';
import { evaluate } from './risk.js';
import { TabManager, type ActiveTabInfo, type ClosedTabHistory } from './tab-manager.js';
import type { Candidate, Config } from './model.js';

const { values } = parseArgs({
  options: {
    maxTabs: { type: 'string', default: '5' },
    config: { type: 'string', default: 'config/rules.yaml' },
    profileDir: { type: 'string', default: 'profiles/research-aria-tele01' },
    profileName: { type: 'string', default: 'Profile 12' },
    enableExtensions: { type: 'boolean', default: true },
    seconds: { type: 'string' },
  },
});

const config: Config = loadConfig(values.config);
const maxTabs = Math.max(1, Math.min(20, Number(values.maxTabs) || 5));
const tabManager = new TabManager(maxTabs);
const queue = new CandidateQueue(config.queueCapacity, config.candidateTtlMs);

const candidates = new Map<string, Candidate>();
const inspected = new Set<string>();
const openPages = new Map<string, Page>();
let context: BrowserContext | null = null;
let feedPage: Page | null = null;
let stopping = false;

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
  console.log(
    `[tabs-monitor] 📊 Status: ${tabManager.getActiveCount()}/${maxTabs} tab aktif` +
    (active.length ? ` [${active.map(t => t.symbol).join(', ')}]` : ' [kosong]') +
    ` | Antrean: ${queue['pending']?.size ?? 0} | Riwayat ditutup: ${closed.length}`
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
      activeCount: summary.activeCount,
      availableSlots: summary.availableSlots,
      activeTabs: summary.activeTabs,
      closedCount: summary.closedCount,
      closedHistory: summary.closedHistory,
      pendingQueueCount: queue['pending']?.size ?? 0,
    };

    writeFileSync('reports/tab-monitor-status.json', JSON.stringify(payload, null, 2));
    writeFileSync('dist/tab-monitor-data.json', JSON.stringify(payload, null, 2));

    const html = generateDashboardHtml(payload);
    writeFileSync('dist/tab-monitor.html', html);
  } catch (err) {
    console.warn('[dashboard-write-error]', err instanceof Error ? err.message : err);
  }
}

function generateDashboardHtml(data: {
  updatedAt: string;
  maxTabs: number;
  activeCount: number;
  availableSlots: number;
  activeTabs: ActiveTabInfo[];
  closedCount: number;
  closedHistory: ClosedTabHistory[];
  pendingQueueCount: number;
}): string {
  const activeRows = data.activeTabs.map((t, i) => {
    const duration = Math.round((Date.now() - t.openedAt) / 1000);
    const m = Math.floor(duration / 60), s = duration % 60;
    const durStr = `${m}m ${s}s`;
    return `<tr>
      <td><b>#${i + 1}</b></td>
      <td><b>${esc(t.symbol)}</b><br><small class="mono">${esc(t.mint)}</small></td>
      <td>${durStr}</td>
      <td>${t.lastPriceUsd ? '$' + t.lastPriceUsd.toFixed(8) : '—'}</td>
      <td>${t.holders ?? '—'}</td>
      <td><a href="${esc(t.url)}" target="_blank" class="btn">Buka di Browser</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">Belum ada tab detail yang aktif. Antrean sedang memindai token baru.</td></tr>';

  const closedRows = data.closedHistory.map(c => {
    const closedAgo = Math.round((Date.now() - c.closedAt) / 1000);
    const m = Math.floor(closedAgo / 60), s = closedAgo % 60;
    const agoStr = `${m}m ${s}s lalu`;
    const durM = Math.floor(c.durationSeconds / 60), durS = c.durationSeconds % 60;
    return `<tr>
      <td><b>#${c.index}</b></td>
      <td><b>${esc(c.symbol)}</b><br><small class="mono">${esc(c.mint)}</small></td>
      <td>${agoStr}</td>
      <td>${durM}m ${durS}s</td>
      <td>${c.lastPriceUsd ? '$' + c.lastPriceUsd.toFixed(8) : '—'}</td>
      <td>
        <a href="${esc(c.url)}" target="_blank" class="btn">Buka GMGN</a>
        <span class="tip">Ketik di CLI: <code>reopen ${c.index}</code></span>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="muted" style="text-align:center;padding:24px">Belum ada tab yang ditutup. Bila Anda menutup tab di browser, riwayatnya akan muncul di sini.</td></tr>';

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tab Monitor Live — ${data.activeCount}/${data.maxTabs} Aktif</title>
<style>
body{margin:0;background:#09111d;color:#e8eff8;font:15px/1.5 system-ui,Segoe UI,sans-serif}
main{max-width:1400px;margin:auto;padding:28px}
.header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:16px;border-bottom:1px solid #263950;padding-bottom:18px;margin-bottom:24px}
h1{margin:0;font-size:24px;font-weight:700}
.badge{background:#111e2e;border:1px solid #355375;border-radius:20px;padding:6px 14px;font-size:13px;display:inline-flex;align-items:center;gap:8px}
.badge.green{background:#0e291f;border-color:#2a7e58;color:#6be1b2}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:28px}
.card{background:#111e2e;border:1px solid #263950;border-radius:12px;padding:16px}
.label{color:#9cafc5;font-size:13px}
.value{font-size:28px;font-weight:700;margin-top:4px}
.value.green{color:#6be1b2}
.value.yellow{color:#f5a623}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{text-align:left;padding:11px 14px;border-bottom:1px solid #1e2e40}
th{background:#0d1827;color:#a9c1df;font-size:13px}
.mono{font:11px ui-monospace,Consolas,monospace;color:#7d9bb7}
.muted{color:#8899ac}
.btn{display:inline-block;padding:5px 10px;background:#1a3959;border:1px solid #35628c;color:#e8eff8;border-radius:6px;text-decoration:none;font-size:12px}
.btn:hover{background:#235282}
.tip{font-size:11px;color:#9cafc5;margin-left:8px}
.tip code{background:#18283a;padding:2px 5px;border-radius:4px;color:#6be1b2}
.panel{background:#111e2e;border:1px solid #263950;border-radius:12px;padding:20px;margin-bottom:28px}
.panel-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.panel-title h2{margin:0;font-size:18px}
.cli-box{background:#070d17;border:1px solid #1c2e42;border-radius:8px;padding:12px 16px;font:12px ui-monospace,Consolas,monospace;color:#a9c1df;margin-top:16px}
.cli-box b{color:#6be1b2}
</style>
</head>
<body>
<main>
  <div class="header">
    <div>
      <h1>🚀 GMGN Live Tab Monitor</h1>
      <p class="muted" style="margin:4px 0 0">Monitoring aktif 5 tab tanpa auto buy & auto sell. Tab tidak akan auto close; detail tab yang ditutup tersimpan dan bisa dibuka kembali.</p>
    </div>
    <div class="badge green">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#6be1b2"></span>
      Status Diperbarui: ${new Date(data.updatedAt).toLocaleTimeString('id-ID')} WIB
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">Tab Detail Aktif</div>
      <div class="value ${data.activeCount === data.maxTabs ? 'yellow' : 'green'}">${data.activeCount} / ${data.maxTabs}</div>
    </div>
    <div class="card">
      <div class="label">Slot Tab Tersedia</div>
      <div class="value">${data.availableSlots}</div>
    </div>
    <div class="card">
      <div class="label">Antrean Token Lolos</div>
      <div class="value">${data.pendingQueueCount}</div>
    </div>
    <div class="card">
      <div class="label">Riwayat Tab Ditutup</div>
      <div class="value">${data.closedCount}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-title">
      <h2>🟢 Tab yang Sedang Aktif di Browser (${data.activeCount}/${data.maxTabs})</h2>
      <span class="muted" style="font-size:12px">Tab tetap terbuka terus sampai Anda menutupnya secara manual.</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>No</th><th>Token</th><th>Lama Terbuka</th><th>Harga Terakhir</th><th>Holder</th><th>Aksi</th></tr>
        </thead>
        <tbody>
          ${activeRows}
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <div class="panel-title">
      <h2>📁 Riwayat Detail yang Pernah Ditutup (Bisa Dibuka Kembali)</h2>
      <span class="muted" style="font-size:12px">Tersedia ${data.closedCount} token di riwayat</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr><th>Index</th><th>Token</th><th>Kapan Ditutup</th><th>Durasi Dibuka</th><th>Harga Terakhir</th><th>Cara Buka Kembali</th></tr>
        </thead>
        <tbody>
          ${closedRows}
        </tbody>
      </table>
    </div>
    <div class="cli-box">
      <b>💡 Petunjuk Membuka Kembali Tab via Terminal CLI:</b><br>
      Ketik <code>reopen 1</code> untuk membuka kembali riwayat #1, atau ketik <code>reopen &lt;mint&gt;</code>.<br>
      Ketik <code>list</code> untuk melihat daftar lengkap tab aktif & riwayat ditutup.
    </div>
  </div>
</main>
<script>
// Auto reload halaman dashboard setiap 5 detik
setTimeout(() => location.reload(), 5000);
</script>
</body>
</html>`;
}

function esc(s: unknown): string {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c] || c));
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

    // Attach passive capture to record prices and holders without any automated trading
    attachCapture(page, () => {}, (payload, now) => {
      for (const update of parseCandidates(payload, config.mappings, now, 'detail')) {
        if (update.mint === mint) {
          const c = merge(update);
          const price = num(c, 'priceUsd') ?? undefined;
          const holders = num(c, 'holders') ?? undefined;
          tabManager.updateTab(mint, {
            lastPriceUsd: price,
            holders: holders,
          });
        }
      }
    });

    console.log(`\n[tab-opened] 🌐 Tab baru dibuka: ${symbol} (${mint}). Tab aktif: ${tabManager.getActiveCount()}/${maxTabs}`);
    logStatus();
    writeDashboardReport();

    // Navigate to the GMGN token page
    await page.goto(url, { waitUntil: 'commit', timeout: config.workerTimeoutMs });
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
      console.log(`   [#${i + 1}] ${t.symbol.padEnd(10)} | ${t.mint} | ${dur}s aktif | Harga: ${t.lastPriceUsd ? '$' + t.lastPriceUsd : '—'} | Holders: ${t.holders ?? '—'}`);
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

async function main(): Promise<void> {
  console.log(`\n====================================================================`);
  console.log(`🚀 MEMULAI TAB MONITOR (MANUAL / NO AUTO-BUY / NO AUTO-SELL)`);
  console.log(`Maksimal Tab Aktif: ${maxTabs}`);
  console.log(`Profil Browser    : ${values.profileDir} (${values.profileName})`);
  console.log(`Feed URL          : ${config.feedUrl}`);
  console.log(`Dashboard Live    : http://127.0.0.1:4173/tab-monitor.html`);
  console.log(`====================================================================\n`);

  writeDashboardReport();

  context = await chromium.launchPersistentContext(values.profileDir, {
    channel: config.browserChannel || undefined,
    headless: false,
    viewport: null,
    args: ['--start-maximized', '--profile-directory=' + values.profileName],
    ignoreDefaultArgs: values.enableExtensions ? ['--disable-extensions'] : undefined,
  });

  // Open feed page in the first tab
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
  console.log(`[feed-connected] Feed GMGN terhubung di Tab 1. Memindai token lolos screening...\n`);

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
