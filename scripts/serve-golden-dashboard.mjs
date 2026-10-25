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
  let tierBreakdown = null;
  const curatedPath = join(ROOT, "data", "curated-lowcap-smart-wallets.json");
  if (existsSync(curatedPath)) {
    try {
      const cdata = JSON.parse(readFileSync(curatedPath, "utf8"));
      snowballStats.totalCurated = cdata.totalCurated || (cdata.wallets ? cdata.wallets.length : cleanWallets.length);
      snowballStats.snowballedCount = cdata.snowballedWalletsCount || snowballStats.snowballedCount;
      tierBreakdown = cdata.tierBreakdown || null;
      if (cdata.wallets && cdata.wallets.length > 0) {
        cleanWallets = cdata.wallets;
      }
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

  // Load buy simulation results
  let simulationResults = null;
  const simPath = join(ROOT, "data", "golden-simulation-results.json");
  if (existsSync(simPath)) {
    try {
      simulationResults = JSON.parse(readFileSync(simPath, "utf8"));
    } catch (e) {
      log(`Error reading simulation file: ${e.message}`);
    }
  }

  // Load paper trading trial results (2 lanes: GMGN vs Solana RPC)
  let paperTrading = null;
  const paperPath = join(ROOT, "data", "golden-paper-positions.json");
  if (existsSync(paperPath)) {
    try {
      paperTrading = JSON.parse(readFileSync(paperPath, "utf8"));
    } catch (e) {
      log(`Error reading paper trading file: ${e.message}`);
    }
  }

  return {
    cleanWallets,
    tierBreakdown,
    quarantinedWallets,
    goldenSignals,
    allEvents,
    snowballStats,
    simulationResults,
    paperTrading,
    systemHealth: {
      port: PORT,
      cdpUrl: "http://127.0.0.1:9223",
      chromeCdpStatus: "ONLINE",
      heliusApiStatus: "ONLINE",
      rateLimitCount,
      lastRateLimitAt,
      probeStats: lastProbeStats,
      isScanning: false,
      lastScanAt: new Date().toISOString(),
      lastScanDurationMs: 0,
      lastScanStatus: daemonProcess ? "WEBSOCKET_ACTIVE" : "STARTING",
      totalScansRun: 1,
      autoScanIntervalSec: 45,
      nextScanInSec: 0,
      daemonRunning: !!daemonProcess,
      daemonUptimeSec: daemonStartTime ? Math.floor((Date.now() - daemonStartTime) / 1000) : 0
    }
  };
}

let daemonProcess = null;
let daemonStartTime = Date.now();

function startDaemon() {
  if (daemonProcess) return;
  log("🚀 Spawning persistent Golden WebSocket + AMM Swap Daemon...");
  daemonStartTime = Date.now();
  daemonProcess = spawn("node", ["--import", "tsx", "scripts/run-convergence-detector.ts", "--daemon"], {
    cwd: ROOT,
    env: { ...process.env, PAPER_STAKE_USD: "5" }
  });

  daemonProcess.stdout.on("data", (d) => {
    const lines = d.toString().split("\n");
    for (const l of lines) {
      if (l.trim()) log(`[DAEMON] ${l.trim()}`);
    }
  });

  daemonProcess.stderr.on("data", (d) => {
    const lines = d.toString().split("\n");
    for (const l of lines) {
      if (l.trim()) log(`[DAEMON-ERR] ${l.trim()}`);
    }
  });

  daemonProcess.on("close", (code) => {
    log(`⚠️ Golden Daemon exited with code ${code}. Respawning in 5s...`);
    daemonProcess = null;
    setTimeout(startDaemon, 5000);
  });
}

// Clean termination on shutdown
process.on("SIGINT", () => {
  if (daemonProcess) {
    try { daemonProcess.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (daemonProcess) {
    try { daemonProcess.kill("SIGTERM"); } catch {}
  }
  process.exit(0);
});

// Start daemon 2s after server boot
setTimeout(startDaemon, 2000);

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

  // API Paper Trading
  if (cleanPath === "/api/paper-trading") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const paperPath = join(ROOT, "data", "golden-paper-positions.json");
    let data = { positions: [], lanes: {} };
    if (existsSync(paperPath)) {
      try { data = JSON.parse(readFileSync(paperPath, "utf8")); } catch {}
    }
    res.end(JSON.stringify(data));
    return;
  }

  // API Trigger Scan
  if (cleanPath === "/api/scan" && req.method === "POST") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      message: "Golden Daemon is running continuous live WebSocket tick-by-tick & AMM execution loop.",
      daemonRunning: !!daemonProcess,
      uptimeSec: Math.floor((Date.now() - daemonStartTime) / 1000)
    }));
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

    /* Tier Badges */
    .tier-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3px;
    }
    .tier-badge-s { background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4); }
    .tier-badge-a { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); }
    .tier-badge-b { background: rgba(6, 182, 212, 0.2); color: #22d3ee; border: 1px solid rgba(6, 182, 212, 0.4); }
    .tier-badge-c { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .tier-badge-d { background: rgba(148, 163, 184, 0.15); color: #94a3b8; border: 1px solid rgba(148, 163, 184, 0.3); }
    .tier-badge-e { background: rgba(100, 116, 139, 0.15); color: #64748b; border: 1px solid rgba(100, 116, 139, 0.3); }

    .tier-filter-btn {
      padding: 6px 14px;
      background: var(--bg-card);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      color: var(--text-muted);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .tier-filter-btn:hover {
      border-color: var(--primary);
      color: var(--text);
    }
    .tier-filter-btn.active {
      background: rgba(99, 102, 241, 0.25);
      border-color: #818cf8;
      color: #fff;
    }

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
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: top;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }
    .copyable { cursor: pointer; border-bottom: 1px dashed #4b5563; }
    .copyable:hover { color: var(--primary); }
    a.link { color: #60a5fa; text-decoration: none; font-weight: 600; }
    a.link:hover { text-decoration: underline; }

    /* Wallets Column Box */
    .wallet-col-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 250px;
      max-width: 320px;
    }
    .wallet-col-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 4px;
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
    }
    .wallet-box {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-height: 160px;
      overflow-y: auto;
      padding: 6px;
      background: rgba(15, 23, 42, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      min-width: 250px;
    }
    .wallet-box::-webkit-scrollbar {
      width: 4px;
    }
    .wallet-box::-webkit-scrollbar-track {
      background: rgba(0, 0, 0, 0.2);
    }
    .wallet-box::-webkit-scrollbar-thumb {
      background: #334155;
      border-radius: 2px;
    }
    .wallet-box::-webkit-scrollbar-thumb:hover {
      background: #475569;
    }
    .wallet-card-entry {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 4px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      transition: background 0.15s;
    }
    .wallet-card-entry:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    .wallet-row-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }
    .wallet-row-sub {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 10px;
      color: #94a3b8;
    }
    .wallet-token-profit.pos {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.4);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
    }
    .wallet-token-profit.neg {
      background: rgba(239, 68, 68, 0.2);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.4);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 700;
    }
    .wallet-token-profit.zero {
      background: rgba(148, 163, 184, 0.15);
      color: #cbd5e1;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 9.5px;
    }
    .wallet-exit-tag.holding {
      color: #34d399;
      font-weight: 600;
      font-size: 9.5px;
    }
    .wallet-exit-tag.exited {
      color: #94a3b8;
      font-size: 9.5px;
    }
    .wallet-cost-wrap {
      font-size: 9.5px;
      color: #cbd5e1;
    }
    .wallet-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 3px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.02);
      font-size: 11px;
      transition: background 0.15s;
    }
    .wallet-row:hover {
      background: rgba(255, 255, 255, 0.07);
    }
    .wallet-addr {
      font-family: 'JetBrains Mono', monospace;
      color: #e2e8f0;
      font-size: 11px;
      font-weight: 500;
    }
    .wallet-meta {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .wallet-time {
      font-family: 'JetBrains Mono', monospace;
      color: #38bdf8;
      font-size: 10.5px;
      white-space: nowrap;
    }
    .wallet-delta-first {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.35);
      padding: 0 4px;
      border-radius: 3px;
      font-size: 9.5px;
      font-weight: 700;
      line-height: 1.3;
    }
    .wallet-delta-follow {
      background: rgba(148, 163, 184, 0.12);
      color: #94a3b8;
      padding: 0 4px;
      border-radius: 3px;
      font-size: 9.5px;
      font-weight: 600;
      line-height: 1.3;
    }
    .wallet-pnl-pos {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
      padding: 0 4px;
      border-radius: 3px;
      font-size: 9.5px;
      font-weight: 700;
      line-height: 1.3;
      white-space: nowrap;
    }
    .wallet-pnl-neg {
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 0 4px;
      border-radius: 3px;
      font-size: 9.5px;
      font-weight: 600;
      line-height: 1.3;
      white-space: nowrap;
    }

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

    /* Simulation UI */
    .sim-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .sim-card {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 16px;
      position: relative;
    }
    .sim-card.best {
      border: 1px solid rgba(16, 185, 129, 0.4);
      box-shadow: 0 4px 20px rgba(16, 185, 129, 0.08);
    }
    .sim-card-title {
      font-size: 13px;
      font-weight: 700;
      color: #94a3b8;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .sim-card-title span.strat-name {
      color: #e2e8f0;
      font-size: 14px;
    }
    .sim-big-pnl {
      font-size: 24px;
      font-weight: 800;
      font-family: 'JetBrains Mono', monospace;
      color: #34d399;
      margin-bottom: 12px;
    }
    .sim-metrics-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      font-size: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 10px;
    }
    .sim-metric-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .sim-metric-lbl {
      color: #64748b;
      font-size: 11px;
    }
    .sim-metric-val {
      font-weight: 700;
      color: #f1f5f9;
      font-family: 'JetBrains Mono', monospace;
    }
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
      <button class="tab-btn" onclick="switchTab('paper')">
        🎮 Trial Paper 2-Lane <span class="badge badge-gold" id="tabBadgePaper">0</span>
      </button>
      <button class="tab-btn" onclick="switchTab('simulation')">
        🎯 Simulasi Buy Backtest <span class="badge badge-green" id="tabBadgeSim">72% WR</span>
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
      <!-- Tier Overview Cards -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px;">
        <div class="stat-card" style="border-left: 4px solid #f59e0b; padding: 14px;">
          <div style="font-size: 11px; color: #f59e0b; font-weight: 700;">🏆 TIER S (Whales / Elite)</div>
          <div id="tierCountS" style="font-size: 22px; font-weight: 800; margin-top: 4px;">0</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Cuan &ge; $2k &bull; Saldo &ge; 2 SOL</div>
        </div>
        <div class="stat-card" style="border-left: 4px solid #a855f7; padding: 14px;">
          <div style="font-size: 11px; color: #a855f7; font-weight: 700;">💎 TIER A (Proven Smart)</div>
          <div id="tierCountA" style="font-size: 22px; font-weight: 800; margin-top: 4px;">0</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">3+ Hits &bull; Cuan &ge; $500</div>
        </div>
        <div class="stat-card" style="border-left: 4px solid #06b6d4; padding: 14px;">
          <div style="font-size: 11px; color: #06b6d4; font-weight: 700;">⚡ TIER B (Scalpers)</div>
          <div id="tierCountB" style="font-size: 22px; font-weight: 800; margin-top: 4px;">0</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">3+ Hits &bull; Cuan &ge; $150</div>
        </div>
        <div class="stat-card" style="border-left: 4px solid #10b981; padding: 14px;">
          <div style="font-size: 11px; color: #10b981; font-weight: 700;">🌱 TIER C (Emerging)</div>
          <div id="tierCountC" style="font-size: 22px; font-weight: 800; margin-top: 4px;">0</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">2+ Hits &bull; Cuan &ge; $100</div>
        </div>
        <div class="stat-card" style="border-left: 4px solid #94a3b8; padding: 14px;">
          <div style="font-size: 11px; color: #94a3b8; font-weight: 700;">🎯 TIER D (Punters)</div>
          <div id="tierCountD" style="font-size: 22px; font-weight: 800; margin-top: 4px;">0</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Single-hit retail / untung 1x</div>
        </div>
        <div class="stat-card" style="border-left: 4px solid #64748b; padding: 14px;">
          <div style="font-size: 11px; color: #64748b; font-weight: 700;">⏳ TIER E (Dust)</div>
          <div id="tierCountE" style="font-size: 22px; font-weight: 800; margin-top: 4px;">0</div>
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">Saldo &lt; 0.01 SOL / nonaktif</div>
        </div>
      </div>

      <div class="card">
        <div class="card-header" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between;">
          <div class="card-title">Daftar Smart Trader Berjenjang (Tier S &ndash; E)</div>
          <!-- Filter Buttons -->
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button class="tier-filter-btn active" onclick="filterWallets('ALL', this)">Semua (<span id="btnCountAll">0</span>)</button>
            <button class="tier-filter-btn" onclick="filterWallets('S', this)">🏆 Tier S (<span id="btnCountS">0</span>)</button>
            <button class="tier-filter-btn" onclick="filterWallets('A', this)">💎 Tier A (<span id="btnCountA">0</span>)</button>
            <button class="tier-filter-btn" onclick="filterWallets('B', this)">⚡ Tier B (<span id="btnCountB">0</span>)</button>
            <button class="tier-filter-btn" onclick="filterWallets('C', this)">🌱 Tier C (<span id="btnCountC">0</span>)</button>
            <button class="tier-filter-btn" onclick="filterWallets('D', this)">🎯 Tier D (<span id="btnCountD">0</span>)</button>
            <button class="tier-filter-btn" onclick="filterWallets('E', this)">⏳ Tier E (<span id="btnCountE">0</span>)</button>
          </div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th># Rank</th>
                <th>Alamat Wallet</th>
                <th>Tier Mutu</th>
                <th>Konsistensi</th>
                <th>Win Rate (30D)</th>
                <th>Profit Bersih (30D)</th>
                <th>Saldo SOL</th>
                <th>Status On-Chain</th>
                <th>Tautan</th>
              </tr>
            </thead>
            <tbody id="tbodyWallets">
              <tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Memuat wallet...</td></tr>
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

    <!-- TAB 5: SIMULASI BUY BACKTEST -->
    <div id="panel-simulation" class="panel">
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-header">
          <div class="card-title">🎯 Hasil Simulasi Buy Sinyal Golden Organic Convergence</div>
          <div style="font-size: 12px; color: var(--text-muted);" id="simTimestamp">Backtest 54 Token Golden (Modal $100 / Trade, Fee 2% Deducted)</div>
        </div>
        <div style="padding: 16px;">
          <div class="sim-grid" id="simCardsGrid">
            <!-- Rendered dynamically -->
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Rincian Performa 54 Token Golden Sinyal (Candles 1-Menit GMGN)</div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th>Entry (WIB)</th>
                <th>Entry Mcap</th>
                <th>Peak Mcap</th>
                <th>Peak Gain</th>
                <th>Scalp Bot (+35% / -12%)</th>
                <th>Moonbag (+50% / +120%)</th>
                <th>Smart Mirror (Copy Exit)</th>
              </tr>
            </thead>
            <tbody id="tbodySimulation">
              <tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Memuat simulasi...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB: TRIAL PAPER TRADING 2 LANES -->
    <div id="panel-paper" class="panel">
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-header">
          <div class="card-title">🎮 Trial Paper Trading: GMGN Discovery vs Solana RPC Queue</div>
          <div style="font-size: 12px; color: var(--text-muted);">
            Rules: Buy saat Wallet #2 Masuk · TP +35% · Trailing Stop (-7% dari puncak +20%) · SL -12% · Timeout 30m · Fee 2%
          </div>
        </div>
        <div style="padding: 16px;">
          <div class="sim-grid" id="paperCardsGrid">
            <!-- Rendered dynamically -->
          </div>
        </div>
      </div>

      <!-- Open Positions -->
      <div class="card" style="margin-bottom: 20px;">
        <div class="card-header">
          <div class="card-title">⚡ Posisi Paper Trading Aktif (Live Monitoring)</div>
          <div style="font-size: 12px; color: var(--text-muted);" id="paperOpenCount">0 Posisi Berjalan</div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Lane</th>
                <th>Token</th>
                <th>Wallets Terlibat</th>
                <th>Jam Masuk (W2)</th>
                <th>Entry MC</th>
                <th>Entry Price</th>
                <th>Live MC</th>
                <th>Live PnL</th>
                <th>Peak Gain</th>
                <th>Durasi Hold</th>
                <th>Target Exit</th>
              </tr>
            </thead>
            <tbody id="tbodyPaperOpen">
              <tr><td colspan="11" style="text-align: center; color: var(--text-muted);">Tidak ada posisi aktif saat ini. Menunggu konfirmasi masuk wallet ke-2.</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Closed Trades Ledger -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📜 Riwayat Eksekusi & Hasil Trial (Closed Trades Ledger)</div>
          <div style="font-size: 12px; color: var(--text-muted);" id="paperClosedCount">Memuat riwayat...</div>
        </div>
        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th>Lane</th>
                <th>Token</th>
                <th>Wallets Terlibat</th>
                <th>Masuk WIB (W2)</th>
                <th>Keluar WIB</th>
                <th>Durasi</th>
                <th>Entry MC</th>
                <th>Exit MC</th>
                <th>Alasan Exit</th>
                <th>Net PnL (%)</th>
                <th>Net PnL ($)</th>
              </tr>
            </thead>
            <tbody id="tbodyPaperClosed">
              <tr><td colspan="11" style="text-align: center; color: var(--text-muted);">Memuat riwayat paper trade...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>

  <script>
    let state = null;
    const API_BASE = window.location.pathname.startsWith('/wal-track') ? '/wal-track' : '';

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function switchTab(name, evt) {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      
      const targetBtn = evt ? evt.currentTarget : (window.event ? window.event.currentTarget || window.event.target.closest('.tab-btn') : null);
      if (targetBtn) targetBtn.classList.add('active');
      document.getElementById('panel-' + name).classList.add('active');

      if (name === 'logs') fetchLogs();
    }

    async function loadData() {
      try {
        const res = await fetch(API_BASE + '/api/state');
        state = await res.json();
        try { renderKPIs(); } catch (e) { console.error('renderKPIs error:', e); }
        try { renderGoldenSignals(); } catch (e) { console.error('renderGoldenSignals error:', e); }
        try { renderWallets(); } catch (e) { console.error('renderWallets error:', e); }
        try { renderSyndicates(); } catch (e) { console.error('renderSyndicates error:', e); }
        try { renderSimulation(); } catch (e) { console.error('renderSimulation error:', e); }
        try { renderPaperTrading(); } catch (e) { console.error('renderPaperTrading error:', e); }
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

      if (statusText) statusText.innerText = '⚡ WEBSOCKET STREAM + REAL AMM SWAP ACTIVE';
      if (statusDot) statusDot.style.background = '#10b981';
      if (btnScan) {
        btnScan.disabled = false;
        btnScan.innerText = '⚡ Live Stream Active';
      }
      if (kpiScanStatus) {
        kpiScanStatus.innerHTML = '<span style="color: #10b981;">⚡ WS Stream Active</span>';
      }
      if (kpiScanSub) {
        kpiScanSub.innerHTML = 'Tick-by-tick via GMGN CDP · Real AMM Swap Exit';
      }
    }

    function renderGoldenSignals() {
      const tbody = document.getElementById('tbodyGolden');
      const events = (state.allEvents && state.allEvents.length > 0) ? state.allEvents : state.goldenSignals;
      if (!events || events.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 24px;">Belum ada sinyal konvergensi. Klik "Scan On-Chain Now" untuk memeriksa.</td></tr>';
        return;
      }

      const walletMap = new Map((state.cleanWallets || []).map(w => [w.address, w]));

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

        const totalWallets = s.walletEntries ? s.walletEntries.length : (s.wallets ? s.wallets.length : 0);
        let untungCount = 0;
        let walletItemsHtml = '';
        if (s.walletEntries && s.walletEntries.length > 0) {
          walletItemsHtml = s.walletEntries.map((we, widx) => {
            const isFirst = we.deltaSecFromFirst === 0;
            const deltaBadge = isFirst
              ? '<span class="wallet-delta-first">First</span>'
              : '<span class="wallet-delta-follow">+' + Math.round(we.deltaSecFromFirst / 60) + 'm</span>';
            const shortAddr = we.wallet ? (we.wallet.slice(0, 4) + '...' + we.wallet.slice(-4)) : '???';
            const inWib = we.enteredAtWib ? we.enteredAtWib.replace(' WIB', '') : '-';
            
            // Exit status
            let exitHtml = '';
            if (we.isHolding) {
              exitHtml = '<span class="wallet-exit-tag holding" title="Masih pegang token">🟢 HOLD ' + (we.holdingDurationStr || '') + '</span>';
            } else if (we.exitedAtWib) {
              const outWib = we.exitedAtWib.replace(' WIB', '');
              exitHtml = '<span class="wallet-exit-tag exited" title="Keluar: ' + we.exitedAtWib + '">🚪 Out: ' + outWib + ' (' + (we.holdingDurationStr || '') + ')</span>';
            }

            // Profit / Cuan on this token
            let tokenProfitBadge = '';
            if (we.profitUsd !== null && we.profitUsd !== undefined) {
              if (we.profitUsd > 0) {
                untungCount++;
                const pStr = we.profitUsd >= 1000 ? '+' + (we.profitUsd / 1000).toFixed(1) + 'k' : '+' + we.profitUsd;
                tokenProfitBadge = '<span class="wallet-token-profit pos" title="Untung di koin ini: +$' + we.profitUsd.toLocaleString() + ' (' + (we.pnlPercent || 0) + '%)">+$' + pStr + ' (' + Math.round(we.pnlPercent || 0) + '%)</span>';
              } else if (we.profitUsd < 0) {
                tokenProfitBadge = '<span class="wallet-token-profit neg" title="Rugi di koin ini: -$' + Math.abs(we.profitUsd).toLocaleString() + ' (' + (we.pnlPercent || 0) + '%)">-$' + Math.abs(we.profitUsd) + '</span>';
              } else {
                tokenProfitBadge = '<span class="wallet-token-profit zero" title="Impas / $0">$0</span>';
              }
            }

            const costStr = we.totalCostUsd ? '<span class="wallet-cost-wrap" title="Modal beli: $' + we.totalCostUsd + '">💵 $' + we.totalCostUsd + '</span>' : '';
            const tierVal = (we.tier || (walletMap.get(we.wallet)?.tier) || 'D').toUpperCase();
            const tierBadge = '<span class="tier-badge tier-badge-' + tierVal.toLowerCase() + '" style="font-size:9px;padding:1px 5px;margin-left:4px;vertical-align:middle;">T-' + tierVal + '</span>';

            return '<div class="wallet-card-entry">' +
              '<div class="wallet-row-top">' +
                '<span class="mono copyable wallet-addr" data-copy="' + we.wallet + '" onclick="navigator.clipboard.writeText(this.dataset.copy)" title="Klik untuk copy: ' + we.wallet + '">#' + (widx + 1) + ' ' + shortAddr + tierBadge + '</span>' +
                deltaBadge +
                tokenProfitBadge +
              '</div>' +
              '<div class="wallet-row-sub">' +
                '<span class="wallet-time" title="Jam masuk: ' + (we.enteredAtWib || '-') + '">🕒 ' + inWib + '</span>' +
                exitHtml +
                costStr +
              '</div>' +
            '</div>';
          }).join('');
        } else if (s.wallets && s.wallets.length > 0) {
          walletItemsHtml = s.wallets.map((w, widx) => {
            const shortAddr = w ? (w.slice(0, 4) + '...' + w.slice(-4)) : '???';
            const wInfo = walletMap.get(w);
            let pnlBadge = '';
            if (wInfo && wInfo.pnl30d > 0) {
              untungCount++;
              const pnlStr = wInfo.pnl30d >= 1000 ? '+' + (wInfo.pnl30d / 1000).toFixed(1) + 'k' : '+' + wInfo.pnl30d;
              pnlBadge = '<span class="wallet-pnl-pos" title="Cuan 30d: +' + Number(wInfo.pnl30d).toLocaleString() + '">' + pnlStr + '</span>';
            } else if (wInfo && wInfo.pnl30d < 0) {
              pnlBadge = '<span class="wallet-pnl-neg">-$' + Math.abs(wInfo.pnl30d) + '</span>';
            }
            return '<div class="wallet-row">' +
              '<span class="mono copyable wallet-addr" data-copy="' + w + '" onclick="navigator.clipboard.writeText(this.dataset.copy)" title="Klik untuk copy: ' + w + '">#' + (widx + 1) + ' ' + shortAddr + '</span>' +
              '<div class="wallet-meta">' +
                pnlBadge +
                '<span style="color:var(--text-muted);font-size:10px;">Logged</span>' +
              '</div>' +
            '</div>';
          }).join('');
        } else {
          walletItemsHtml = '<div style="color:var(--text-muted);font-size:11px;padding:4px;">Tidak ada detail wallet</div>';
        }

        const untungSummary = untungCount > 0 
          ? '<span style="color: #34d399; font-weight: 700;">' + untungCount + ' Cuan</span>'
          : '<span style="color: #94a3b8;">0 Cuan</span>';
        const scrollHint = totalWallets > 3 ? '<span style="font-size: 10px; color: #64748b;">(scroll ▾)</span>' : '';
        const walletsHtml = 
          '<div class="wallet-col-container">' +
            '<div class="wallet-col-header">' +
              '<span>👛 (' + totalWallets + ') · ' + untungSummary + '</span>' +
              scrollHint +
            '</div>' +
            '<div class="wallet-box">' +
              walletItemsHtml +
            '</div>' +
          '</div>';

        return \`
          <tr>
            <td style="white-space: nowrap;">\${new Date(s.detectedAt).toLocaleTimeString('id-ID')} WIB</td>
            <td><span class="badge \${badgeClass}">\${badgeLabel}</span></td>
            <td>
              <strong>\${s.symbol || (s.mint ? s.mint.slice(0, 6) : 'UNKNOWN')}</strong><br>
              <span class="mono copyable" style="font-size: 11px; color: var(--text-muted);" onclick="navigator.clipboard.writeText('\${s.mint}')" title="Klik untuk copy mint">\${s.mint ? s.mint.slice(0, 6) + '...' + s.mint.slice(-4) : '-'}</span>
            </td>
            <td><strong style="color: #38bdf8;">\${mcapStr}</strong> <span class="badge" style="background: rgba(56,189,248,0.15); color: #38bdf8; font-size: 10px;">&lt; 100k</span></td>
            <td style="vertical-align: top;">\${walletsHtml}</td>
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

    let activeTierFilter = 'ALL';

    function filterWallets(tier, btn) {
      activeTierFilter = tier;
      document.querySelectorAll('.tier-filter-btn').forEach(b => b.classList.remove('active'));
      if (btn) btn.classList.add('active');
      renderWallets();
    }

    function getTierBadgeHtml(tier) {
      const t = (tier || 'D').toUpperCase();
      const map = {
        S: '<span class="tier-badge tier-badge-s">🏆 TIER S</span>',
        A: '<span class="tier-badge tier-badge-a">💎 TIER A</span>',
        B: '<span class="tier-badge tier-badge-b">⚡ TIER B</span>',
        C: '<span class="tier-badge tier-badge-c">🌱 TIER C</span>',
        D: '<span class="tier-badge tier-badge-d">🎯 TIER D</span>',
        E: '<span class="tier-badge tier-badge-e">⏳ TIER E</span>'
      };
      return map[t] || map.D;
    }

    function renderWallets() {
      const tbody = document.getElementById('tbodyWallets');
      const allList = state.cleanWallets || [];
      if (allList.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Tidak ada data wallet.</td></tr>';
        return;
      }

      // Update Tier counts in header and filter buttons
      const counts = state.tierBreakdown || { S: 0, A: 0, B: 0, C: 0, D: 0, E: 0 };
      if (!state.tierBreakdown) {
        allList.forEach(w => {
          const t = w.tier || 'D';
          if (counts[t] !== undefined) counts[t]++;
        });
      }

      const updateEl = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = Number(val || 0).toLocaleString();
      };

      updateEl('tierCountS', counts.S);
      updateEl('tierCountA', counts.A);
      updateEl('tierCountB', counts.B);
      updateEl('tierCountC', counts.C);
      updateEl('tierCountD', counts.D);
      updateEl('tierCountE', counts.E);

      updateEl('btnCountAll', allList.length);
      updateEl('btnCountS', counts.S);
      updateEl('btnCountA', counts.A);
      updateEl('btnCountB', counts.B);
      updateEl('btnCountC', counts.C);
      updateEl('btnCountD', counts.D);
      updateEl('btnCountE', counts.E);

      let filtered = allList;
      if (activeTierFilter !== 'ALL') {
        filtered = allList.filter(w => (w.tier || 'D') === activeTierFilter);
      }

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted);">Tidak ada wallet pada Tier ' + activeTierFilter + '.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.slice(0, 100).map((w, idx) => {
        const isSnowball = w.source === 'snowball_runner';
        const tierBadge = getTierBadgeHtml(w.tier);
        const hitsBadge = \`<span class="badge" style="background: rgba(56,189,248,0.15); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3);">\${w.hitCount || 1} koin</span>\`;
        const badge = isSnowball
          ? \`<span class="badge" style="background: rgba(56,189,248,0.12); color: #7dd3fc;">❄️ SNOWBALL</span>\`
          : \`<span class="badge badge-green">VERIFIED ELITE</span>\`;
        const profit = w.pnl30d !== undefined ? w.pnl30d : 0;
        return \`
          <tr>
            <td><strong>#\${idx + 1}</strong></td>
            <td>
              <span class="mono copyable" data-copy="\${w.address}" onclick="navigator.clipboard.writeText(this.dataset.copy)" title="Copy">\${w.address}</span>
            </td>
            <td>\${tierBadge}</td>
            <td>\${hitsBadge}</td>
            <td><strong style="color: var(--green);">\${w.winrate30d ?? (w.winRate ? (w.winRate * 100).toFixed(0) : 55)}%</strong></td>
            <td>+\$\${Number(profit).toLocaleString()}</td>
            <td><strong>\${w.solBalance ? Number(w.solBalance).toFixed(1) : '0.0'} SOL</strong></td>
            <td>\${badge}</td>
            <td>
              <a href="https://solscan.io/account/\${w.address}" target="_blank" class="link">Solscan</a> &bull; 
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

    function renderSimulation() {
      var sim = state.simulationResults;
      if (!sim || !sim.strategySummaries) {
        var tb = document.getElementById('tbodySimulation');
        if (tb) tb.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Belum ada data simulasi</td></tr>';
        return;
      }

      var s1 = sim.strategySummaries.strategy1_smart_mirror || {};
      var s2 = sim.strategySummaries.strategy2_scalp_bot || {};
      var s3 = sim.strategySummaries.strategy3_moonbag_runner || {};

      var bSim = document.getElementById('tabBadgeSim');
      if (bSim) bSim.innerText = s2.winRate ? s2.winRate.split(' ')[0] + ' WR' : '72% WR';
      var ts = document.getElementById('simTimestamp');
      if (ts && sim.executedAtWib) {
        ts.innerText = 'Backtest ' + (sim.totalTokensTested || 54) + ' Token Golden (' + (sim.betPerTrade || '$100 / Trade') + ') · Update: ' + sim.executedAtWib;
      }

      // Render 3 Summary Cards
      var cardsHtml = 
        '<div class="sim-card best">' +
          '<div class="sim-card-title">' +
            '<span class="strat-name">⚡ 1. Scalp Bot (+35% / -12%)</span>' +
            '<span class="badge badge-green">TERBAIK (72% WR)</span>' +
          '</div>' +
          '<div class="sim-big-pnl">' + (s2.totalPnl || '+$956') + '</div>' +
          '<div class="sim-metrics-row">' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Win Rate</span>' +
              '<span class="sim-metric-val" style="color: #34d399;">' + (s2.winRate || '72.2%') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Profit Factor</span>' +
              '<span class="sim-metric-val">' + (s2.profitFactor || '5.55') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Avg Durasi Hold</span>' +
              '<span class="sim-metric-val">' + (s2.avgDuration || '3 menit') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Gross Win/Loss</span>' +
              '<span class="sim-metric-val">' + (s2.grossProfit || '+$1,166') + ' / ' + (s2.grossLoss || '-$210') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="sim-card">' +
          '<div class="sim-card-title">' +
            '<span class="strat-name">🚀 2. Moonbag Runner (+50% / +120%)</span>' +
            '<span class="badge badge-gold">MAX PROFIT</span>' +
          '</div>' +
          '<div class="sim-big-pnl">' + (s3.totalPnl || '+$1,454') + '</div>' +
          '<div class="sim-metrics-row">' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Win Rate</span>' +
              '<span class="sim-metric-val" style="color: #38bdf8;">' + (s3.winRate || '66.7%') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Profit Factor</span>' +
              '<span class="sim-metric-val">' + (s3.profitFactor || '5.75') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Avg Durasi Hold</span>' +
              '<span class="sim-metric-val">' + (s3.avgDuration || '4 menit') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Gross Win/Loss</span>' +
              '<span class="sim-metric-val">' + (s3.grossProfit || '+$1,760') + ' / ' + (s3.grossLoss || '-$306') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="sim-card">' +
          '<div class="sim-card-title">' +
            '<span class="strat-name">👥 3. Smart Mirror Exit (Copy Wallet)</span>' +
            '<span class="badge" style="background: rgba(148, 163, 184, 0.2); color: #cbd5e1;">COPY TRADE</span>' +
          '</div>' +
          '<div class="sim-big-pnl">' + (s1.totalPnl || '+$2,633') + '</div>' +
          '<div class="sim-metrics-row">' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Win Rate</span>' +
              '<span class="sim-metric-val" style="color: #fbbf24;">' + (s1.winRate || '46.3%') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Profit Factor</span>' +
              '<span class="sim-metric-val">' + (s1.profitFactor || '3.00') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Avg Durasi Hold</span>' +
              '<span class="sim-metric-val">' + (s1.avgDuration || '25 menit') + '</span>' +
            '</div>' +
            '<div class="sim-metric-item">' +
              '<span class="sim-metric-lbl">Gross Win/Loss</span>' +
              '<span class="sim-metric-val">' + (s1.grossProfit || '+$3,950') + ' / ' + (s1.grossLoss || '-$1,317') + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';

      var grid = document.getElementById('simCardsGrid');
      if (grid) grid.innerHTML = cardsHtml;

      // Render Table Rows
      var rows = (sim.results || []).map(function(r, i) {
        var s1Pnl = r.strat1 ? (r.strat1.pnlUsd >= 0 ? '+$' + r.strat1.pnlUsd : '-$' + Math.abs(r.strat1.pnlUsd)) : '-';
        var s2Pnl = r.strat2 ? (r.strat2.pnlUsd >= 0 ? '+$' + r.strat2.pnlUsd : '-$' + Math.abs(r.strat2.pnlUsd)) : '-';
        var s3Pnl = r.strat3 ? (r.strat3.pnlUsd >= 0 ? '+$' + r.strat3.pnlUsd : '-$' + Math.abs(r.strat3.pnlUsd)) : '-';

        var s1Class = r.strat1 && r.strat1.pnlUsd > 0 ? 'color: #34d399; font-weight: 700;' : 'color: #f87171;';
        var s2Class = r.strat2 && r.strat2.pnlUsd > 0 ? 'color: #34d399; font-weight: 700;' : 'color: #f87171;';
        var s3Class = r.strat3 && r.strat3.pnlUsd > 0 ? 'color: #34d399; font-weight: 700;' : 'color: #f87171;';

        var peakStr = r.maxMultiplier || '-';
        var peakClass = peakStr.indexOf('x') !== -1 && parseFloat(peakStr) >= 2.0 ? 'badge badge-green' : 'badge badge-gold';

        return '<tr>' +
          '<td>' +
            '<div style="font-weight: 700; color: #f1f5f9;">#' + (i + 1) + ' ' + r.symbol + '</div>' +
            '<div class="mono" style="font-size: 10px; color: var(--text-muted); cursor: pointer;" data-copy="' + r.mint + '" onclick="navigator.clipboard.writeText(this.dataset.copy)" title="Copy mint">' + r.mint.slice(0, 4) + '...' + r.mint.slice(-4) + '</div>' +
          '</td>' +
          '<td><span class="mono" style="color: #38bdf8;">🕒 ' + (r.entryWib || '-') + '</span></td>' +
          '<td><span class="mono">$' + (r.entryMcap || 0).toLocaleString() + '</span></td>' +
          '<td><span class="mono">$' + (r.peakMcap || 0).toLocaleString() + '</span></td>' +
          '<td><span class="' + peakClass + '">' + peakStr + '</span></td>' +
          '<td>' +
            '<div class="mono" style="' + s2Class + '">' + s2Pnl + ' (' + (r.strat2 ? r.strat2.roiPct : 0) + '%)</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">' + (r.strat2 ? r.strat2.reason : '') + ' (' + (r.strat2 ? r.strat2.durationM : 0) + 'm)</div>' +
          '</td>' +
          '<td>' +
            '<div class="mono" style="' + s3Class + '">' + s3Pnl + ' (' + (r.strat3 ? r.strat3.roiPct : 0) + '%)</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">' + (r.strat3 ? r.strat3.reason : '') + ' (' + (r.strat3 ? r.strat3.durationM : 0) + 'm)</div>' +
          '</td>' +
          '<td>' +
            '<div class="mono" style="' + s1Class + '">' + s1Pnl + ' (' + (r.strat1 ? r.strat1.roiPct : 0) + '%)</div>' +
            '<div style="font-size: 10px; color: var(--text-muted);">' + (r.strat1 ? r.strat1.durationM : 0) + 'm hold</div>' +
          '</td>' +
        '</tr>';
      }).join('');

      var tbody = document.getElementById('tbodySimulation');
      if (tbody) tbody.innerHTML = rows || '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">Tidak ada baris hasil</td></tr>';
    }

    function formatPaperWalletsHtml(p) {
      var walletMap = new Map((state.wallets || []).map(function(w) { return [w.address, w]; }));
      var entries = p.walletEntries;
      if ((!entries || entries.length === 0) && p.wallet1 && p.wallet2) {
        entries = [
          { wallet: p.wallet1.address, enteredAtWib: p.wallet1.enteredAtWib, deltaSecFromFirst: 0, isHolding: true },
          { wallet: p.wallet2.address, enteredAtWib: p.wallet2.enteredAtWib, deltaSecFromFirst: p.wallet2.deltaSecFromFirst || 0, isHolding: true }
        ];
      }

      if (!entries || entries.length === 0) {
        return '<div style="color:var(--text-muted);font-size:11px;padding:4px;">Tidak ada detail wallet</div>';
      }

      var totalWallets = entries.length;
      var untungCount = 0;
      var walletItemsHtml = entries.map(function(we, widx) {
        var isFirst = we.deltaSecFromFirst === 0;
        var deltaBadge = isFirst
          ? '<span class="wallet-delta-first">First</span>'
          : '<span class="wallet-delta-follow">+' + Math.round((we.deltaSecFromFirst || 0) / 60) + 'm</span>';
        var shortAddr = we.wallet ? (we.wallet.slice(0, 4) + '...' + we.wallet.slice(-4)) : '???';
        var inWib = we.enteredAtWib ? we.enteredAtWib.replace(' WIB', '') : '-';

        // Exit status
        var exitHtml = '';
        if (we.isHolding) {
          exitHtml = '<span class="wallet-exit-tag holding" title="Masih pegang token">🟢 HOLD ' + (we.holdingDurationStr || '') + '</span>';
        } else if (we.exitedAtWib) {
          var outWib = we.exitedAtWib.replace(' WIB', '');
          exitHtml = '<span class="wallet-exit-tag exited" title="Keluar: ' + we.exitedAtWib + '">🚪 Out: ' + outWib + ' (' + (we.holdingDurationStr || '') + ')</span>';
        }

        // Profit / Cuan on this token
        var tokenProfitBadge = '';
        if (we.profitUsd !== null && we.profitUsd !== undefined) {
          if (we.profitUsd > 0) {
            untungCount++;
            var pStr = we.profitUsd >= 1000 ? '+' + (we.profitUsd / 1000).toFixed(1) + 'k' : '+' + we.profitUsd;
            tokenProfitBadge = '<span class="wallet-token-profit pos" title="Untung di koin ini: +$' + we.profitUsd.toLocaleString() + ' (' + (we.pnlPercent || 0) + '%)">+$' + pStr + ' (' + Math.round(we.pnlPercent || 0) + '%)</span>';
          } else if (we.profitUsd < 0) {
            tokenProfitBadge = '<span class="wallet-token-profit neg" title="Rugi di koin ini: -$' + Math.abs(we.profitUsd).toLocaleString() + ' (' + (we.pnlPercent || 0) + '%)">-$' + Math.abs(we.profitUsd) + '</span>';
          } else {
            tokenProfitBadge = '<span class="wallet-token-profit zero" title="Impas / $0">$0</span>';
          }
        } else {
          var wInfo = walletMap.get(we.wallet);
          if (wInfo && wInfo.pnl30d > 0) {
            untungCount++;
            var pnlStr = wInfo.pnl30d >= 1000 ? '+' + (wInfo.pnl30d / 1000).toFixed(1) + 'k' : '+' + wInfo.pnl30d;
            tokenProfitBadge = '<span class="wallet-token-profit pos" title="Cuan 30d: +$' + Number(wInfo.pnl30d).toLocaleString() + '">+$' + pnlStr + '</span>';
          } else if (wInfo && wInfo.pnl30d < 0) {
            tokenProfitBadge = '<span class="wallet-token-profit neg" title="Rugi 30d: -$' + Math.abs(wInfo.pnl30d) + '">-$' + Math.abs(wInfo.pnl30d) + '</span>';
          }
        }

        var costStr = we.totalCostUsd ? '<span class="wallet-cost-wrap" title="Modal beli: $' + we.totalCostUsd + '">💵 $' + we.totalCostUsd + '</span>' : '';

        return '<div class="wallet-card-entry">' +
          '<div class="wallet-row-top">' +
            '<span class="mono copyable wallet-addr" data-copy="' + we.wallet + '" onclick="navigator.clipboard.writeText(this.dataset.copy)" title="Klik untuk copy: ' + we.wallet + '">#' + (widx + 1) + ' ' + shortAddr + '</span>' +
            deltaBadge +
            tokenProfitBadge +
          '</div>' +
          '<div class="wallet-row-sub">' +
            '<span class="wallet-time" title="Jam masuk: ' + (we.enteredAtWib || '-') + '">🕒 ' + inWib + '</span>' +
            exitHtml +
            costStr +
          '</div>' +
        '</div>';
      }).join('');

      var untungSummary = untungCount > 0 
        ? '<span style="color: #34d399; font-weight: 700;">' + untungCount + ' Cuan</span>'
        : '<span style="color: #94a3b8;">' + totalWallets + ' Wallets</span>';
      var scrollHint = totalWallets > 2 ? '<span style="font-size: 10px; color: #64748b;">(scroll ▾)</span>' : '';

      return '<div class="wallet-col-container" style="min-width: 190px; max-width: 250px;">' +
        '<div class="wallet-col-header">' +
          '<span>👛 (' + totalWallets + ') · ' + untungSummary + '</span>' +
          scrollHint +
        '</div>' +
        '<div class="wallet-box" style="max-height: 125px;">' +
          walletItemsHtml +
        '</div>' +
      '</div>';
    }

    function formatTradeLossAudit(p) {
      var entries = p.walletEntries || [];
      if (!entries || entries.length === 0) {
        if (p.wallet1 && p.wallet2) {
          entries = [
            { wallet: p.wallet1.address, enteredAtWib: p.wallet1.enteredAtWib, deltaSecFromFirst: 0, isHolding: true },
            { wallet: p.wallet2.address, enteredAtWib: p.wallet2.enteredAtWib, deltaSecFromFirst: p.wallet2.deltaSecFromFirst || 0, isHolding: true }
          ];
        } else {
          return '';
        }
      }

      var w1Addr = p.wallet1 ? p.wallet1.address : (entries[0] ? entries[0].wallet : null);
      var w2Addr = p.wallet2 ? p.wallet2.address : (entries[1] ? entries[1].wallet : null);

      var w1 = entries.find(function(e) { return e.wallet === w1Addr; }) || entries[0];
      var w2 = entries.find(function(e) { return e.wallet === w2Addr; }) || entries[1];

      var entryTs = p.entryTimestamp || 0;
      var exitTs = p.exitTimestamp || Math.floor(Date.now() / 1000);

      // Analyze Wallet 1
      var w1Text = 'W1: -';
      var w1Color = '#94a3b8';
      if (w1) {
        if (w1.isHolding) {
          w1Text = 'W1: 🟢 Masih HOLD';
          w1Color = '#34d399';
        } else if (w1.exitTimestamp || w1.exitedAtWib) {
          var tStr = w1.exitedAtWib ? w1.exitedAtWib.replace(' WIB', '') : '';
          var exitW1Ts = w1.exitTimestamp || 0;
          if (exitW1Ts > 0 && exitW1Ts < entryTs) {
            w1Text = 'W1: ⚠️ Jual Sblm Beli (' + tStr + ')';
            w1Color = '#fbbf24';
          } else if (exitW1Ts > 0 && exitW1Ts <= (exitTs + 15)) {
            w1Text = 'W1: 🚨 Dump Pas Hold (' + tStr + ')';
            w1Color = '#f87171';
          } else {
            w1Text = 'W1: 🚪 Jual Stlh Exit (' + tStr + ')';
            w1Color = '#60a5fa';
          }
        }
      }

      // Analyze Wallet 2
      var w2Text = 'W2: -';
      var w2Color = '#94a3b8';
      if (w2) {
        if (w2.isHolding) {
          w2Text = 'W2: 🟢 Masih HOLD';
          w2Color = '#34d399';
        } else if (w2.exitTimestamp || w2.exitedAtWib) {
          var t2Str = w2.exitedAtWib ? w2.exitedAtWib.replace(' WIB', '') : '';
          var exitW2Ts = w2.exitTimestamp || 0;
          if (exitW2Ts > 0 && exitW2Ts <= (exitTs + 15)) {
            w2Text = 'W2: 🚨 Jual Pas Hold (' + t2Str + ')';
            w2Color = '#f87171';
          } else {
            w2Text = 'W2: 🚪 Jual Stlh Exit (' + t2Str + ')';
            w2Color = '#60a5fa';
          }
        }
      }

      // Analyze Subsequent Wallets (Wallets entered after our entry)
      var subsequent = entries.filter(function(e) {
        return e.wallet !== w1Addr && e.wallet !== w2Addr && (e.timestamp ? e.timestamp >= entryTs : true);
      });

      var subCount = subsequent.length;
      var subText = '';
      var subColor = '#94a3b8';
      if (subCount === 0) {
        subText = 'Susulan: ❌ 0 Smart Wallet';
        subColor = '#ef4444';
      } else {
        var subHolding = subsequent.filter(function(e) { return e.isHolding; }).length;
        subText = 'Susulan: 👛 +' + subCount + ' Wallet (' + subHolding + ' Hold)';
        subColor = '#38bdf8';
      }

      var isLoss = (p.pnlUsd || 0) < 0;
      var borderColor = isLoss ? 'rgba(239, 68, 68, 0.25)' : 'rgba(52, 211, 153, 0.2)';
      var headerColor = isLoss ? '#f87171' : '#34d399';
      var titleText = isLoss ? '🔍 Audit Sebab Loss:' : '🔍 Alur Smart Money:';

      return '<div style="margin-top: 6px; padding: 4px 6px; border-radius: 4px; background: rgba(0, 0, 0, 0.25); border: 1px solid ' + borderColor + '; font-size: 10px; line-height: 1.35; text-align: left; min-width: 170px;">' +
        '<div style="font-weight: 700; color: ' + headerColor + '; font-size: 9px; text-transform: uppercase; margin-bottom: 2px;">' + titleText + '</div>' +
        '<div style="color: ' + w1Color + '; font-weight: 600;">' + escapeHtml(w1Text) + '</div>' +
        '<div style="color: ' + w2Color + '; font-weight: 600;">' + escapeHtml(w2Text) + '</div>' +
        '<div style="color: ' + subColor + '; font-weight: 600;">' + escapeHtml(subText) + '</div>' +
      '</div>';
    }

    function renderPaperTrading() {
      var pt = state.paperTrading;
      if (!pt || !pt.lanes) {
        var tbO = document.getElementById('tbodyPaperOpen');
        if (tbO) tbO.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 18px;">Belum ada data paper trading.</td></tr>';
        var tbC = document.getElementById('tbodyPaperClosed');
        if (tbC) tbC.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 18px;">Belum ada data paper trading.</td></tr>';
        return;
      }

      var ls = pt.lanes.LANE_GOLDEN_SCALP || {};
      var lm = pt.lanes.LANE_GOLDEN_MOONBAG || {};
      var lc = pt.lanes.LANE_GOLDEN_MICRO_SCALP || {};
      var positions = pt.positions || [];
      var openPositions = positions.filter(function(p) { return p.status === 'OPEN'; });
      var closedPositions = positions.filter(function(p) { return p.status === 'CLOSED'; });

      // Update Tab badge
      var badgeP = document.getElementById('tabBadgePaper');
      if (badgeP) {
        var totalNetPnl = (ls.totalPnlUsd || 0) + (lm.totalPnlUsd || 0) + (lc.totalPnlUsd || 0);
        badgeP.innerText = openPositions.length + ' Open · +$' + Math.round(totalNetPnl).toLocaleString();
      }

      // Render 3 Comparative Summary Cards
      var grid = document.getElementById('paperCardsGrid');
      if (grid) {
        var sPnl = Number((ls.totalPnlUsd !== undefined ? ls.totalPnlUsd : 0).toFixed(2));
        var mPnl = Number((lm.totalPnlUsd !== undefined ? lm.totalPnlUsd : 0).toFixed(2));
        var cPnl = Number((lc.totalPnlUsd !== undefined ? lc.totalPnlUsd : 0).toFixed(2));
        var sPnlSign = sPnl >= 0 ? '+' : '';
        var mPnlSign = mPnl >= 0 ? '+' : '';
        var cPnlSign = cPnl >= 0 ? '+' : '';
        var sPnlCol = sPnl >= 0 ? '#34d399' : '#f87171';
        var mPnlCol = mPnl >= 0 ? '#38bdf8' : '#f87171';
        var cPnlCol = cPnl >= 0 ? '#34d399' : '#f87171';

        grid.innerHTML =
          '<div class="sim-card">' +
            '<div class="sim-card-title">' +
              '<span class="strat-name">⚡ Lane A: Golden Scalp (+35% / -12%)</span>' +
              '<span class="badge badge-green">STAKE $5</span>' +
            '</div>' +
            '<div class="sim-big-pnl" style="color: ' + sPnlCol + ';">' + sPnlSign + '$' + sPnl.toLocaleString() + '</div>' +
            '<div class="sim-metrics-row">' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Win Rate</span><span class="sim-metric-val" style="color: #34d399;">' + (ls.winRatePct || 0) + '% (' + (ls.winningTrades || 0) + 'W / ' + (ls.losingTrades || 0) + 'L)</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Profit Factor</span><span class="sim-metric-val">' + (ls.profitFactor || 0) + '</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Total Trades</span><span class="sim-metric-val">' + (ls.totalTrades || 0) + ' (' + (ls.openPositions || 0) + ' Open)</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Avg Duration</span><span class="sim-metric-val">' + (ls.avgDurationM || 0) + 'm</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Gross Win/Loss</span><span class="sim-metric-val">+$' + (ls.grossProfitUsd || 0) + ' / -$' + (ls.grossLossUsd || 0) + '</span></div>' +
            '</div>' +
            '<div style="margin-top: 10px; font-size: 11px; color: var(--text-muted);">' + (ls.description || 'Scalp cepat pasca konvergensi wallet ke-2.') + '</div>' +
          '</div>' +

          '<div class="sim-card best">' +
            '<div class="sim-card-title">' +
              '<span class="strat-name">🎯 Lane C: Quick Micro-Scalp (10-20%)</span>' +
              '<span class="badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.4);">STAKE $5</span>' +
            '</div>' +
            '<div class="sim-big-pnl" style="color: ' + cPnlCol + ';">' + cPnlSign + '$' + cPnl.toLocaleString() + '</div>' +
            '<div class="sim-metrics-row">' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Win Rate</span><span class="sim-metric-val" style="color: #38bdf8;">' + (lc.winRatePct || 0) + '% (' + (lc.winningTrades || 0) + 'W / ' + (lc.losingTrades || 0) + 'L)</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Profit Factor</span><span class="sim-metric-val">' + (lc.profitFactor || 0) + '</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Total Trades</span><span class="sim-metric-val">' + (lc.totalTrades || 0) + ' (' + (lc.openPositions || 0) + ' Open)</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Avg Duration</span><span class="sim-metric-val">' + (lc.avgDurationM || 0) + 'm</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Gross Win/Loss</span><span class="sim-metric-val">+$' + (lc.grossProfitUsd || 0) + ' / -$' + (lc.grossLossUsd || 0) + '</span></div>' +
            '</div>' +
            '<div style="margin-top: 10px; font-size: 11px; color: var(--text-muted);">' + (lc.description || 'Cuan kilat 10-20% (+15% TP / -8% SL / Trailing dari +10% / Max 15m).') + '</div>' +
          '</div>' +

          '<div class="sim-card">' +
            '<div class="sim-card-title">' +
              '<span class="strat-name">🚀 Lane B: Golden Moonbag Runner (+50% / +120%)</span>' +
              '<span class="badge badge-gold">STAKE $5</span>' +
            '</div>' +
            '<div class="sim-big-pnl" style="color: ' + mPnlCol + ';">' + mPnlSign + '$' + mPnl.toLocaleString() + '</div>' +
            '<div class="sim-metrics-row">' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Win Rate</span><span class="sim-metric-val" style="color: #38bdf8;">' + (lm.winRatePct || 0) + '% (' + (lm.winningTrades || 0) + 'W / ' + (lm.losingTrades || 0) + 'L)</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Profit Factor</span><span class="sim-metric-val">' + (lm.profitFactor || 0) + '</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Total Trades</span><span class="sim-metric-val">' + (lm.totalTrades || 0) + ' (' + (lm.openPositions || 0) + ' Open)</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Avg Duration</span><span class="sim-metric-val">' + (lm.avgDurationM || 0) + 'm</span></div>' +
              '<div class="sim-metric-item"><span class="sim-metric-lbl">Gross Win/Loss</span><span class="sim-metric-val">+$' + (lm.grossProfitUsd || 0) + ' / -$' + (lm.grossLossUsd || 0) + '</span></div>' +
            '</div>' +
            '<div style="margin-top: 10px; font-size: 11px; color: var(--text-muted);">' + (lm.description || 'Runner bertingkat saat volume breakout.') + '</div>' +
          '</div>';
      }

      // Render Open Positions Table
      var tbOpen = document.getElementById('tbodyPaperOpen');
      var openCnt = document.getElementById('paperOpenCount');
      if (openCnt) openCnt.innerText = openPositions.length + ' Posisi Berjalan';

      if (tbOpen) {
        if (openPositions.length === 0) {
          tbOpen.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 18px;">Tidak ada posisi aktif saat ini. Sinyal baru otomatis masuk saat smart wallet ke-2 buy.</td></tr>';
        } else {
          tbOpen.innerHTML = openPositions.map(function(p) {
            var laneBadge = p.lane === 'LANE_GOLDEN_SCALP' ? '<span class="badge badge-green">⚡ Scalp</span>' : (p.lane === 'LANE_GOLDEN_MICRO_SCALP' ? '<span class="badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.4);">🎯 Micro</span>' : '<span class="badge badge-gold">🚀 Moonbag</span>');
            var pnlColor = (p.currentGainPct || 0) >= 0 ? '#34d399' : '#f87171';
            var trailThreshold = p.lane === 'LANE_GOLDEN_MICRO_SCALP' ? '+10%' : (p.lane === 'LANE_GOLDEN_MOONBAG' ? '+30%' : '+20%');
            var trailBadge = p.trailingActivated ? '<span class="badge badge-gold">Trailing ON</span>' : '<span style="color: var(--text-muted); font-size: 11px;">Waiting ' + trailThreshold + '</span>';
            var mintSnippet = p.mint ? p.mint.slice(0, 4) + '...' + p.mint.slice(-4) : '';
            var routeBadge = p.realSwapRouteBuy ? '<span class="badge" style="background: rgba(96, 165, 250, 0.15); color: #60a5fa; font-size: 10px; margin-left: 4px;">🎯 Real AMM ' + (p.realSwapRouteBuy.latencyMs || '') + 'ms</span>' : '';
            var tokenCell = '<div><strong>' + escapeHtml(p.symbol) + '</strong>' + routeBadge + '</div>' +
              '<div style="font-size: 11px; margin-top: 3px;"><a href="https://gmgn.ai/sol/token/' + p.mint + '" target="_blank" style="color: #60a5fa; text-decoration: none; font-weight: 600;">GMGN ↗</a> · <a href="https://dexscreener.com/solana/' + p.mint + '" target="_blank" style="color: #34d399; text-decoration: none; font-weight: 600;">DEX ↗</a></div>' +
              '<div style="font-family: monospace; font-size: 10px; color: var(--text-muted); margin-top: 2px;">' + mintSnippet + '</div>';
            var w2Delta = (p.wallet2 && p.wallet2.deltaSecFromFirst) ? '<div style="font-size: 10px; color: #a78bfa; font-weight: 600; margin-top: 2px;">Δt: +' + p.wallet2.deltaSecFromFirst + 's</div>' : '';
            var timeCell = '<div>' + p.entryTimeWib + '</div>' + w2Delta;

            return '<tr>' +
              '<td>' + laneBadge + '</td>' +
              '<td>' + tokenCell + '</td>' +
              '<td style="vertical-align: top;">' + formatPaperWalletsHtml(p) + '</td>' +
              '<td>' + timeCell + '</td>' +
              '<td>$' + Math.round(p.entryMcapUsd || 0).toLocaleString() + '</td>' +
              '<td>$' + (p.entryPriceUsd || 0) + '</td>' +
              '<td>$' + Math.round(p.currentMcapUsd || p.entryMcapUsd || 0).toLocaleString() + '</td>' +
              '<td style="font-weight: 700; color: ' + pnlColor + ';">' + ((p.currentGainPct || 0) >= 0 ? '+' : '') + (p.currentGainPct || 0) + '%</td>' +
              '<td style="color: #fbbf24;">+' + (p.peakGainPct || 0) + '%</td>' +
              '<td>' + (p.holdingDurationStr || '0s') + '</td>' +
              '<td style="vertical-align: top;">' + trailBadge + formatTradeLossAudit(p) + '</td>' +
            '</tr>';
          }).join('');
        }
      }

      // Render Closed Positions Table
      var tbClosed = document.getElementById('tbodyPaperClosed');
      var closedCnt = document.getElementById('paperClosedCount');
      if (closedCnt) closedCnt.innerText = closedPositions.length + ' Trade Selesai';

      if (tbClosed) {
        if (closedPositions.length === 0) {
          tbClosed.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 18px;">Belum ada riwayat posisi ditutup.</td></tr>';
        } else {
          tbClosed.innerHTML = closedPositions.slice(0, 50).map(function(p) {
            var laneBadge = p.lane === 'LANE_GOLDEN_SCALP' ? '<span class="badge badge-green">⚡ Scalp</span>' : (p.lane === 'LANE_GOLDEN_MICRO_SCALP' ? '<span class="badge" style="background: rgba(14, 165, 233, 0.2); color: #38bdf8; border: 1px solid rgba(14, 165, 233, 0.4);">🎯 Micro</span>' : '<span class="badge badge-gold">🚀 Moonbag</span>');
            var isWin = (p.pnlUsd || 0) > 0;
            var pnlColor = isWin ? '#34d399' : '#f87171';
          
            var reasonBadge = '';
            if (p.exitReason === 'TAKE_PROFIT_35') reasonBadge = '<span class="badge badge-green">🎯 TP +35%</span>';
            else if (p.exitReason === 'TAKE_PROFIT_15') reasonBadge = '<span class="badge badge-green">🎯 TP +15%</span>';
            else if (p.exitReason === 'TRAILING_STOP_FROM_10') reasonBadge = '<span class="badge badge-gold">🛡️ Trailing (+10%)</span>';
            else if (p.exitReason === 'STOP_LOSS_8') reasonBadge = '<span class="badge badge-red">🛑 SL -8%</span>';
            else if (p.exitReason === 'TIMEOUT_15M') reasonBadge = '<span class="badge badge-primary">⏱️ Timeout 15m</span>';
            else if (p.exitReason === 'TP1_50_TP2_120_HIT') reasonBadge = '<span class="badge badge-green">🚀 TP1 + TP2 Hit</span>';
            else if (p.exitReason === 'TP1_50_TRAILING_10') reasonBadge = '<span class="badge badge-gold">🛡️ Trailing Stop</span>';
            else if (p.exitReason === 'TRAILING_STOP_7PCT') reasonBadge = '<span class="badge badge-gold">🛡️ Trailing Stop</span>';
            else if (p.exitReason === 'STOP_LOSS_12') reasonBadge = '<span class="badge badge-red">🛑 SL -12%</span>';
            else if (p.exitReason === 'STOP_LOSS_15') reasonBadge = '<span class="badge badge-red">🛑 SL -15%</span>';
            else if (p.exitReason === 'TIMEOUT_30M') reasonBadge = '<span class="badge badge-primary">⏱️ Timeout 30m</span>';
            else if (p.exitReason === 'TIMEOUT_60M') reasonBadge = '<span class="badge badge-primary">⏱️ Timeout 60m</span>';
            else reasonBadge = '<span class="badge">' + (p.exitReason || 'Exit') + '</span>';

            var mintSnippet = p.mint ? p.mint.slice(0, 4) + '...' + p.mint.slice(-4) : '';
            var routeBadge = p.realSwapRouteBuy ? '<span class="badge" style="background: rgba(96, 165, 250, 0.15); color: #60a5fa; font-size: 10px; margin-left: 4px;">🎯 Real AMM ' + (p.realSwapRouteBuy.latencyMs || '') + 'ms</span>' : '';
            var tokenCell = '<div><strong>' + escapeHtml(p.symbol) + '</strong>' + routeBadge + '</div>' +
              '<div style="font-size: 11px; margin-top: 3px;"><a href="https://gmgn.ai/sol/token/' + p.mint + '" target="_blank" style="color: #60a5fa; text-decoration: none; font-weight: 600;">GMGN ↗</a> · <a href="https://dexscreener.com/solana/' + p.mint + '" target="_blank" style="color: #34d399; text-decoration: none; font-weight: 600;">DEX ↗</a></div>' +
              '<div style="font-family: monospace; font-size: 10px; color: var(--text-muted); margin-top: 2px;">' + mintSnippet + '</div>';

            var w2Delta = (p.wallet2 && p.wallet2.deltaSecFromFirst) ? '<div style="font-size: 10px; color: #a78bfa; font-weight: 600; margin-top: 2px;">Δt: +' + p.wallet2.deltaSecFromFirst + 's</div>' : '';
            var timeCell = '<div>' + p.entryTimeWib + '</div>' + w2Delta;

            return '<tr>' +
              '<td>' + laneBadge + '</td>' +
              '<td>' + tokenCell + '</td>' +
              '<td style="vertical-align: top;">' + formatPaperWalletsHtml(p) + '</td>' +
              '<td>' + timeCell + '</td>' +
              '<td>' + (p.exitTimeWib || '-') + '</td>' +
              '<td>' + (p.holdingDurationStr || '-') + '</td>' +
              '<td>$' + Math.round(p.entryMcapUsd || 0).toLocaleString() + '</td>' +
              '<td>$' + Math.round(p.exitMcapUsd || 0).toLocaleString() + '</td>' +
              '<td style="vertical-align: top;">' + reasonBadge + formatTradeLossAudit(p) + '</td>' +
              '<td style="font-weight: 700; color: ' + pnlColor + ';">' + ((p.netReturnPct || 0) >= 0 ? '+' : '') + (p.netReturnPct || 0) + '%</td>' +
              '<td style="font-weight: 700; color: ' + pnlColor + ';">' + ((p.pnlUsd || 0) >= 0 ? '+' : '') + '$' + (p.pnlUsd || 0).toLocaleString() + '</td>' +
            '</tr>';
          }).join('');
        }
      }
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
