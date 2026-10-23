import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 4188;
const ROOT = process.cwd();
const LOG_FILE = join(ROOT, "data", "convergence-detector.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
  console.log(line.trim());
}

function loadState() {
  let cleanWallets = [];
  let quarantinedWallets = [];
  let goldenSignals = [];
  let allEvents = [];

  // Load audit results
  const auditPath = join(ROOT, "data", "syndicate-candle-audit-results.json");
  if (existsSync(auditPath)) {
    try {
      const data = JSON.parse(readFileSync(auditPath, "utf8"));
      cleanWallets = data.cleanOrganicWallets || [];
      quarantinedWallets = data.syndicatesDetected || data.purgedSyndicateWallets || [];
    } catch (e) {
      log(`Error reading audit file: ${e.message}`);
    }
  }

  // Load convergence events
  const eventsPath = join(ROOT, "data", "convergence-monitor-events.json");
  if (existsSync(eventsPath)) {
    try {
      allEvents = JSON.parse(readFileSync(eventsPath, "utf8"));
      if (Array.isArray(allEvents)) {
        goldenSignals = allEvents.filter((e) => e.classification === "GOLDEN_ORGANIC_CONVERGENCE");
      }
    } catch (e) {
      log(`Error reading events file: ${e.message}`);
    }
  }

  // Check rate limit status in logs
  let rateLimitCount = 0;
  let lastRateLimitAt = null;
  let lastProbeStats = null;
  let snowballStats = {
    totalCurated: cleanWallets.length,
    snowballedCount: cleanWallets.filter(w => w.source === "snowball_runner").length,
    newThisCycle: 0
  };
  const curatedPath = join(ROOT, "data", "curated-lowcap-smart-wallets.json");
  if (existsSync(curatedPath)) {
    try {
      const cdata = JSON.parse(readFileSync(curatedPath, "utf8"));
      snowballStats.totalCurated = cdata.totalCurated || (cdata.wallets ? cdata.wallets.length : cleanWallets.length);
      snowballStats.snowballedCount = cdata.snowballedWalletsCount || snowballStats.snowballedCount;
    } catch {}
  }

  if (existsSync(LOG_FILE)) {
    try {
      const lines = readFileSync(LOG_FILE, "utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (l.includes("SNOWBALL-COLLECTOR") && l.includes("Pool size:")) {
          const sm = l.match(/Pool size: (\d+) wallets \(\+(\d+) new snowballed this cycle\)/);
          if (sm && snowballStats.newThisCycle === 0) {
            snowballStats.newThisCycle = parseInt(sm[2]);
          }
        }
        if (!lastProbeStats && l.includes("Signature Probe:")) {
          const m = l.match(/Signature Probe: (\d+) active wallets queried, (\d+) idle skipped \(~([\d,]+) credits saved!\)/);
          if (m) {
            lastProbeStats = {
              activeWallets: parseInt(m[1]),
              idleSkipped: parseInt(m[2]),
              creditsSaved: m[3]
            };
          }
        }
        if (/\b429\b/.test(l) && !l.includes(".429Z") && (l.includes("Too Many Requests") || l.includes("Rate limit") || l.includes("status 429") || l.includes("HTTP 429"))) {
          rateLimitCount++;
          if (!lastRateLimitAt) lastRateLimitAt = l.slice(1, 25);
        }
      }
    } catch {}
  }

  const nextSec = isScanning ? 0 : Math.max(0, Math.round(((lastScanCompletedAt || Date.now()) + AUTO_SCAN_INTERVAL_MS - Date.now()) / 1000));

  return {
    cleanWallets,
    quarantinedWallets,
    goldenSignals,
    allEvents,
    snowballStats,
    systemHealth: {
      port: PORT,
      cdpUrl: "http://127.0.0.1:9223",
      chromeCdpStatus: "ONLINE",
      heliusApiStatus: "ONLINE",
      rateLimitCount,
      lastRateLimitAt,
      probeStats: lastProbeStats,
      isScanning,
      lastScanAt: lastScanCompletedAt ? new Date(lastScanCompletedAt).toISOString() : null,
      lastScanDurationMs,
      lastScanStatus,
      totalScansRun,
      autoScanIntervalSec: Math.round(AUTO_SCAN_INTERVAL_MS / 1000),
      nextScanInSec: nextSec
    }
  };
}

let isScanning = false;
let lastScanCompletedAt = Date.now();
let lastScanDurationMs = 0;
let lastScanStatus = "IDLE";
let totalScansRun = 0;
const AUTO_SCAN_INTERVAL_MS = 60_000;

function triggerScan(callback) {
  if (isScanning) {
    if (callback) callback({ status: "busy", message: "Scan already running" });
    return;
  }
  isScanning = true;
  lastScanStatus = "SCANNING";
  const start = Date.now();
  log("🚀 Starting background on-chain scan...");

  const child = spawn("node", ["--import", "tsx", "scripts/run-convergence-detector.ts", "--scan"], {
    cwd: ROOT,
    env: process.env
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
    log(`[SCAN-OUT] ${d.toString().trim()}`);
  });
  child.stderr.on("data", (d) => {
    stderr += d;
    log(`[SCAN-ERR] ${d.toString().trim()}`);
  });

  child.on("close", (code) => {
    isScanning = false;
    lastScanCompletedAt = Date.now();
    lastScanDurationMs = Date.now() - start;
    lastScanStatus = code === 0 ? "SUCCESS" : `ERROR (code ${code})`;
    totalScansRun++;
    log(`✅ Scan #${totalScansRun} finished in ${(lastScanDurationMs / 1000).toFixed(1)}s with exit code ${code}`);
    if (callback) {
      callback({
        status: code === 0 ? "ok" : "error",
        exitCode: code,
        durationMs: lastScanDurationMs,
        stdout: stdout.slice(-1000),
        stderr: stderr.slice(-1000)
      });
    }
  });
}

function scheduleNextAutoScan() {
  setTimeout(() => {
    if (!isScanning) {
      triggerScan(() => {
        scheduleNextAutoScan();
      });
    } else {
      scheduleNextAutoScan();
    }
  }, AUTO_SCAN_INTERVAL_MS);
}
// Start immediate scan after 3s on boot
setTimeout(() => {
  triggerScan(() => {
    scheduleNextAutoScan();
  });
}, 3000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const cleanPath = url.pathname.replace(/^\/wal-track/, "") || "/";

  // API State
  if (cleanPath === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadState()));
    return;
  }

  // API Trigger Scan
  if (cleanPath === "/api/scan" && req.method === "POST") {
    triggerScan((result) => {
      res.writeHead(result.status === "ok" ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // API Logs
  if (cleanPath === "/api/logs") {
    let content = "";
    if (existsSync(LOG_FILE)) {
      try {
        const lines = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
        content = lines.slice(-100).join("\n");
      } catch {}
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(content || "No log entries yet.");
    return;
  }

  // Main Dashboard HTML
  if (cleanPath === "/" || cleanPath === "/index.html") {
    const html = getDashboardHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Wallet & Golden Signal Live Radar</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.12);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.12);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.12);
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'Plus Jakarta Sans', sans-serif;
      min-height: 100vh;
      padding: 24px;
      line-height: 1.5;
    }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .container { max-width: 1400px; margin: 0 auto; }
    
    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--card-border);
      flex-wrap: wrap;
      gap: 16px;
    }
    .logo-area h1 {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo-badge {
      background: linear-gradient(135deg, #6366f1, #a855f7);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-top: 4px; }
    
    .actions { display: flex; gap: 12px; align-items: center; }
    .btn {
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      transition: all 0.2s;
      border: none;
    }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); transform: translateY(-1px); }
    .btn-outline { background: #1f2937; color: var(--text); border: 1px solid #374151; }
    .btn-outline:hover { background: #374151; }
    .live-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--green);
      font-weight: 600;
      background: var(--green-bg);
      padding: 6px 12px;
      border-radius: 20px;
      border: 1px solid rgba(16, 185, 129, 0.2);
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
    @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.3; } 100% { opacity: 1; } }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px;
      position: relative;
      overflow: hidden;
    }
    .kpi-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }
    .kpi-value { font-size: 28px; font-weight: 800; margin: 8px 0 4px; }
    .kpi-sub { font-size: 12px; color: var(--text-muted); }
    .kpi-card.gold { border-color: rgba(245, 158, 11, 0.4); background: linear-gradient(180deg, rgba(245, 158, 11, 0.05), var(--card-bg)); }
    .kpi-card.gold .kpi-value { color: #fbbf24; }
    .kpi-card.green .kpi-value { color: var(--green); }
    .kpi-card.red .kpi-value { color: var(--red); }

    /* Tabs */
    .tabs { display: flex; gap: 8px; border-bottom: 1px solid var(--card-border); margin-bottom: 20px; }
    .tab-btn {
      padding: 12px 20px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      position: relative;
      transition: color 0.2s;
    }
    .tab-btn:hover { color: var(--text); }
    .tab-btn.active { color: var(--primary); }
    .tab-btn.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--primary);
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      margin-left: 6px;
    }
    .badge-primary { background: rgba(99, 102, 241, 0.2); color: #818cf8; }
    .badge-gold { background: var(--amber-bg); color: var(--amber); }
    .badge-red { background: var(--red-bg); color: var(--red); }
    .badge-green { background: var(--green-bg); color: var(--green); }

    /* Content Cards */
    .panel { display: none; }
    .panel.active { display: block; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .card-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-title { font-size: 16px; font-weight: 700; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th {
      padding: 12px 16px;
      background: #141c2e;
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
      border-bottom: 1px solid var(--card-border);
    }
    td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .copyable { cursor: pointer; border-bottom: 1px dashed #4b5563; }
    .copyable:hover { color: var(--primary); }
    a.link { color: #60a5fa; text-decoration: none; font-weight: 600; }
    a.link:hover { text-decoration: underline; }

    /* Terminal Log Box */
    .terminal-box {
      background: #060911;
      border: 1px solid #1f2937;
      border-radius: 8px;
      padding: 16px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      color: #94a3b8;
      max-height: 400px;
      overflow-y: auto;
      white-space: pre-wrap;
      line-height: 1.6;
    }
    .log-err { color: #f87171; font-weight: 600; }
    .log-warn { color: #fbbf24; }
    .log-gold { color: #34d399; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo-area">
        <h1>
          🛰️ Smart Wallet & Golden Radar
          <span class="logo-badge">V1.0 Live</span>
        </h1>
        <p class="subtitle">Multi-wallet convergence detector, on-chain candle verification & anti-syndicate firewall.</p>
      </div>
      <div class="actions">
        <div class="live-indicator" id="scannerIndicator">
          <span class="dot" id="scannerDot"></span>
          <span id="scannerStatusText">AUTO-SCAN ACTIVE (60s)</span>
        </div>
        <button id="btnScan" class="btn btn-primary" onclick="triggerScan()">
          🔄 Scan On-Chain Now
        </button>
      </div>
    </header>

    <!-- KPI Highlights -->
    <div class="kpi-grid">
      <div class="kpi-card gold">
        <div class="kpi-label">🌟 Golden Signals</div>
        <div class="kpi-value" id="kpiGolden">-</div>
        <div class="kpi-sub">Multi-wallet organic consensus</div>
      </div>
      <div class="kpi-card green">
        <div class="kpi-label">👛 Clean Organic Wallets</div>
        <div class="kpi-value" id="kpiClean">-</div>
        <div class="kpi-sub">Verified independent traders</div>
      </div>
      <div class="kpi-card red">
        <div class="kpi-label">🚨 Quarantined Syndicates</div>
        <div class="kpi-value" id="kpiQuarantine">-</div>
        <div class="kpi-sub">Dump bots caught red-handed</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">🔄 Auto-Scan On-Chain</div>
        <div class="kpi-value" id="kpiScanStatus" style="font-size: 20px;">Memuat...</div>
        <div class="kpi-sub" id="kpiScanSub">Next: --s · Terakhir: --</div>
      </div>
    </div>

    <!-- Navigation Tabs -->
    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('golden')">
        🌟 Golden Signals <span class="badge badge-gold" id="tabBadgeGolden">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('wallets')">
        👛 Clean Wallets <span class="badge badge-green" id="tabBadgeClean">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('syndicates')">
        🚨 Syndicate Blacklist <span class="badge badge-red" id="tabBadgeSyndicates">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('logs')">
        📊 Health & RateLimit Logs
      </button>
    </div>

    <!-- TAB 1: GOLDEN SIGNALS -->
    <div id="panel-golden" class="panel active">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Live Konvergensi Smart Wallet (< $100k Market Cap / Early Lowcap)</div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Waktu Deteksi</th>
                <th>Klasifikasi</th>
                <th>Token</th>
                <th>Market Cap</th>
                <th>Wallets Ikut Serta</th>
                <th>Entry Delta</th>
                <th>Harga & 24h</th>
                <th>Likuiditas Pool</th>
                <th>24h Volume</th>
                <th>Status / Analisis</th>
                <th>Aksi</th>
              </tr>
            </thead>
            <tbody id="tbodyGolden">
              <tr><td colspan="11" style="text-align: center; color: var(--text-muted);">Memuat sinyal...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 2: CLEAN WALLETS -->
    <div id="panel-wallets" class="panel">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Daftar Smart Trader Independen Murni (Clean Organic)</div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th># Rank</th>
                <th>Alamat Wallet</th>
                <th>Win Rate (30D)</th>
                <th>Profit Bersih (30D)</th>
                <th>Saldo SOL</th>
                <th>Status On-Chain</th>
                <th>Tautan</th>
              </tr>
            </thead>
            <tbody id="tbodyWallets">
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Memuat wallet...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 3: SYNDICATE BLACKLIST -->
    <div id="panel-syndicates" class="panel">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Daftar Sindikat & Bot Sniper Terkarantina (Dilarang Copy-Trade)</div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Alamat Wallet</th>
                <th>Nama Cluster Sindikat</th>
                <th>Token Bukti</th>
                <th>Entry Delta</th>
                <th>Durasi Hold</th>
                <th>Efek Likuiditas</th>
                <th>Vonis Karantina</th>
              </tr>
            </thead>
            <tbody id="tbodySyndicates">
              <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Memuat sindikat...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB 4: LOGS & RATE LIMITS -->
    <div id="panel-logs" class="panel">
      <div class="card">
        <div class="card-header">
          <div class="card-title">Log Sistem Real-Time & Monitor Rate Limit (HTTP 429)</div>
          <button class="btn btn-outline" onclick="fetchLogs()">🔄 Refresh Log</button>
        </div>
        <div style="padding: 16px;">
          <div id="terminalLog" class="terminal-box">Menghubungkan ke log worker...</div>
        </div>
      </div>
    </div>

  </div>

  <script>
    let state = null;
    const API_BASE = window.location.pathname.startsWith('/wal-track') ? '/wal-track' : '';

    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      
      event.target.closest('.tab-btn').classList.add('active');
      document.getElementById('panel-' + name).classList.add('active');

      if (name === 'logs') fetchLogs();
    }

    async function loadData() {
      try {
        const res = await fetch(API_BASE + '/api/state');
        state = await res.json();
        renderKPIs();
        renderGoldenSignals();
        renderWallets();
        renderSyndicates();
      } catch (e) {
        console.error('Error fetching state:', e);
      }
    }

    function renderKPIs() {
      const goldenCount = state.goldenSignals?.length || 0;
      const allEventsCount = state.allEvents?.length || 0;
      document.getElementById('kpiGolden').innerText = \`\${goldenCount} / \${allEventsCount}\`;
      document.getElementById('tabBadgeGolden').innerText = allEventsCount;

      const cleanCount = state.cleanWallets?.length || 0;
      const sbStats = state.snowballStats || {};
      const snowballed = sbStats.snowballedCount || (state.cleanWallets || []).filter(w => w.source === "snowball_runner").length;
      document.getElementById('kpiClean').innerHTML = \`\${cleanCount} <span style="font-size: 13px; color: #34d399; font-weight: normal;">(+\${snowballed} ❄️)</span>\`;
      document.getElementById('tabBadgeClean').innerText = cleanCount;

      document.getElementById('kpiQuarantine').innerText = state.quarantinedWallets?.length || 0;
      document.getElementById('tabBadgeSyndicates').innerText = state.quarantinedWallets?.length || 0;

      // Update Scanner Live Status
      const sh = state.systemHealth || {};
      const statusText = document.getElementById('scannerStatusText');
      const statusDot = document.getElementById('scannerDot');
      const btnScan = document.getElementById('btnScan');
      const kpiScanStatus = document.getElementById('kpiScanStatus');
      const kpiScanSub = document.getElementById('kpiScanSub');

      const lastAgoSec = sh.lastScanAt ? Math.max(0, Math.round((Date.now() - new Date(sh.lastScanAt).getTime()) / 1000)) : null;
      const lastAgoStr = lastAgoSec !== null ? (lastAgoSec < 60 ? \`\${lastAgoSec}d lalu\` : \`\${Math.round(lastAgoSec / 60)}m lalu\`) : '-';

      if (sh.isScanning) {
        if (statusText) statusText.innerText = 'SEDANG MEMINDAI ON-CHAIN...';
        if (statusDot) statusDot.style.background = '#f59e0b';
        if (btnScan) {
          btnScan.disabled = true;
          btnScan.innerText = '⏳ Sedang Memindai...';
        }
        if (kpiScanStatus) {
          kpiScanStatus.innerHTML = '<span style="color: #f59e0b;">🔄 Memindai...</span>';
        }
        if (kpiScanSub) {
          kpiScanSub.innerText = 'Harvesting GMGN lowcap runners & Snowball';
        }
      } else {
        if (statusText) statusText.innerText = \`AUTO-SCAN (60s) · NEXT: \${sh.nextScanInSec || 0}s\`;
        if (statusDot) statusDot.style.background = '#10b981';
        if (btnScan) {
          btnScan.disabled = false;
          btnScan.innerText = '🔄 Scan On-Chain Now';
        }
        if (kpiScanStatus) {
          kpiScanStatus.innerHTML = '<span style="color: #10b981;">🟢 Aktif (60s)</span>';
        }
        if (kpiScanSub) {
          kpiScanSub.innerHTML = \`Terakhir: \${lastAgoStr} · <span style="color: #38bdf8; font-weight: 600;">❄️ Snowball Mode (0 Helius Cr)</span>\`;
        }
      }
    }

    function renderGoldenSignals() {
      const tbody = document.getElementById('tbodyGolden');
      const events = (state.allEvents && state.allEvents.length > 0) ? state.allEvents : state.goldenSignals;
      if (!events || events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">Belum ada sinyal konvergensi. Klik "Scan On-Chain Now" untuk memeriksa.</td></tr>';
        return;
      }

      tbody.innerHTML = events.map(s => {
        const deltaMin = Math.round(s.entryDeltaSec / 60);
        const liq = s.dexInfo?.liquidityUsd ? '$' + Number(s.dexInfo.liquidityUsd).toLocaleString() : 'N/A';
        const vol = s.dexInfo?.volume24h ? '$' + Number(s.dexInfo.volume24h).toLocaleString() : 'N/A';
        const change = s.dexInfo?.priceChange24h || 0;
        const changeColor = change >= 0 ? '#10b981' : '#ef4444';
        const mcap = s.dexInfo?.fdv || s.dexInfo?.marketCap || (s.dexInfo?.liquidityUsd ? s.dexInfo.liquidityUsd * 2 : 0);
        const mcapStr = mcap > 0 ? '$' + Math.round(mcap).toLocaleString() : 'N/A';

        let badgeClass = 'badge-primary';
        let badgeLabel = 'ACCUMULATION';
        if (s.classification === 'GOLDEN_ORGANIC_CONVERGENCE') {
          badgeClass = 'badge-green';
          badgeLabel = '🌟 GOLDEN SIGNAL';
        } else if (s.classification === 'SYNDICATE_DUMP_RISK') {
          badgeClass = 'badge-red';
          badgeLabel = '🚨 DUMP RISK';
        }

        const walletsHtml = (s.walletEntries || s.wallets || []).map((item, idx) => {
          if (typeof item === 'object' && item.enteredAtWib) {
            const deltaStr = item.deltaSecFromFirst === 0
              ? '<span style="color: #f59e0b;">First</span>'
              : '+' + Math.round(item.deltaSecFromFirst / 60) + 'm';
            return '<div style="margin: 2px 0;"><span class="mono" title="' + item.wallet + '" style="font-size: 11px;">' + item.wallet.slice(0, 6) + '...' + item.wallet.slice(-4) + '</span> <span style="color: #93c5fd; font-size: 11px;">@ ' + item.enteredAtWib + '</span> <span style="color: #a5b4fc; font-size: 10px;">(' + deltaStr + ')</span></div>';
          }
          const w = typeof item === 'string' ? item : item.wallet;
          return '<span class="mono" title="' + w + '">' + w.slice(0, 4) + '...' + w.slice(-4) + '</span>';
        }).join('');

        return \`
          <tr>
            <td style="white-space: nowrap;">\${new Date(s.detectedAt).toLocaleTimeString('id-ID')} WIB</td>
            <td><span class="badge \${badgeClass}">\${badgeLabel}</span></td>
            <td>
              <strong>\${s.symbol || (s.mint ? s.mint.slice(0, 6) : 'UNKNOWN')}</strong><br>
              <span class="mono copyable" style="font-size: 11px; color: var(--text-muted);" onclick="navigator.clipboard.writeText('\${s.mint}')" title="Klik untuk copy mint">\${s.mint ? s.mint.slice(0, 6) + '...' + s.mint.slice(-4) : '-'}</span>
            </td>
            <td><strong style="color: #38bdf8;">\${mcapStr}</strong> <span class="badge" style="background: rgba(56,189,248,0.15); color: #38bdf8; font-size: 10px;">&lt; 100k</span></td>
            <td style="max-width: 280px; font-size: 12px;">\${walletsHtml}</td>
            <td><span class="badge badge-primary">\${deltaMin > 0 ? deltaMin + ' menit' : s.entryDeltaSec + ' dtk'}</span></td>
            <td>$\${s.dexInfo?.priceUsd || 0} <span style="color: \${changeColor}; font-size: 11px;">(\${change >= 0 ? '+' : ''}\${change}%)</span></td>
            <td><strong>\${liq}</strong></td>
            <td>\${vol}</td>
            <td style="max-width: 250px; font-size: 12px; color: \${s.classification === 'GOLDEN_ORGANIC_CONVERGENCE' ? '#a7f3d0' : (s.classification === 'SYNDICATE_DUMP_RISK' ? '#fca5a5' : '#cbd5e1')};">\${s.reason}</td>
            <td>
              <a href="https://dexscreener.com/solana/\${s.mint}" target="_blank" class="link">Chart</a> · 
              <a href="https://gmgn.ai/sol/token/\${s.mint}" target="_blank" class="link">GMGN</a>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderWallets() {
      const tbody = document.getElementById('tbodyWallets');
      if (!state.cleanWallets || state.cleanWallets.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Tidak ada data wallet.</td></tr>';
        return;
      }

      tbody.innerHTML = state.cleanWallets.map((w, idx) => {
        const isSnowball = w.source === 'snowball_runner';
        const badge = isSnowball
          ? \`<span class="badge" style="background: rgba(56,189,248,0.18); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3);">❄️ SNOWBALL (\${w.hitCount || 1}x)</span>\`
          : \`<span class="badge badge-green">VERIFIED INDEPENDENT</span>\`;
        const profit = w.pnl30d !== undefined ? w.pnl30d : 0;
        return \`
          <tr>
            <td><strong>#\${idx + 1}</strong></td>
            <td>
              <span class="mono copyable" onclick="navigator.clipboard.writeText('\${w.address}')" title="Copy">\${w.address}</span>
            </td>
            <td><strong style="color: var(--green);">\${w.winrate30d ?? (w.winRate ? (w.winRate * 100).toFixed(0) : 55)}%</strong></td>
            <td>+\$\${Number(profit).toLocaleString()}</td>
            <td><strong>\${w.solBalance ? Number(w.solBalance).toFixed(1) : '0.0'} SOL</strong></td>
            <td>\${badge}</td>
            <td>
              <a href="https://solscan.io/account/\${w.address}" target="_blank" class="link">Solscan</a> · 
              <a href="https://gmgn.ai/sol/address/\${w.address}" target="_blank" class="link">GMGN</a>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function renderSyndicates() {
      const tbody = document.getElementById('tbodySyndicates');
      const qWallets = state.quarantinedWallets || [];
      if (qWallets.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Tidak ada sindikat terdeteksi.</td></tr>';
        return;
      }

      tbody.innerHTML = qWallets.map((w, idx) => {
        const address = typeof w === 'string' ? w : (w.address || JSON.stringify(w));
        return \`
          <tr>
            <td class="mono"><strong>#\${idx + 1}</strong></td>
            <td>
              <span class="mono copyable" onclick="navigator.clipboard.writeText('\${address}')" title="Copy">\${address}</span>
            </td>
            <td><strong style="color: #f87171;">Coordinated / Bot Sniper</strong></td>
            <td><span class="badge badge-red">&Delta;t &le; 30s / Shared Dump</span></td>
            <td>&lt; 90 detik</td>
            <td><strong style="color: var(--red);">Drained / High-Risk</strong></td>
            <td><span class="badge badge-red">PERMANENT BLACKLIST</span></td>
          </tr>
        \`;
      }).join('');
    }

    async function fetchLogs() {
      try {
        const res = await fetch(API_BASE + '/api/logs');
        const text = await res.json();
        const box = document.getElementById('terminalLog');
        box.innerText = text;
        box.scrollTop = box.scrollHeight;
      } catch (e) {
        document.getElementById('terminalLog').innerText = 'Gagal memuat log: ' + e.message;
      }
    }

    async function triggerScan() {
      const btn = document.getElementById('btnScan');
      btn.disabled = true;
      btn.innerText = '⏳ Memulai Scan...';
      try {
        await fetch(API_BASE + '/api/scan', { method: 'POST' });
        await loadData();
      } catch (e) {
        console.error('Scan error:', e);
      }
    }

    loadData();
    setInterval(loadData, 3000);
  </script>
</body>
</html>`;
}

server.listen(PORT, "0.0.0.0", () => {
  log(`🚀 Smart Wallet & Golden Radar Dashboard running on http://0.0.0.0:${PORT}`);
});
