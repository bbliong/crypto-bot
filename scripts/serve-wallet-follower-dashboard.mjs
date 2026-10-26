import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4192;
const ROOT = process.cwd();
const POS_FILE = join(ROOT, 'data', 'wallet-follower-positions.json');
const TRADES_FILE = join(ROOT, 'data', 'wallet-follower-trades.json');
const EVENTS_FILE = join(ROOT, 'data', 'wallet-follower-events.json');

const SMART_DIP_POS_FILE = join(ROOT, 'data', 'smart-dip-positions.json');
const SMART_DIP_TRADES_FILE = join(ROOT, 'data', 'smart-dip-trades.json');
const SMART_DIP_EVENTS_FILE = join(ROOT, 'data', 'smart-dip-events.json');

const TARGET_WALLET = '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34';
const SWAP_WALLET = 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6';

function safeReadJson(filePath, fallback = []) {
  if (existsSync(filePath)) {
    try {
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      return data;
    } catch {}
  }
  return fallback;
}

function loadDashboardState() {
  const positions = safeReadJson(POS_FILE, []);
  const closedTrades = safeReadJson(TRADES_FILE, []);
  const events = safeReadJson(EVENTS_FILE, []);

  const openPositions = positions.filter((p) => p.status === 'OPEN');
  const totalRealizedPnl = positions.reduce((acc, p) => acc + (p.realizedPnlUsd || 0), 0);
  const totalCostBasis = openPositions.reduce((acc, p) => acc + (p.remainingCostBasisUsd || 0), 0);

  // Hitung win rate dari closed trades Lane 1
  const tradesWithPnl = closedTrades.filter((t) => t.exits && t.exits.length > 0);
  const winTrades = tradesWithPnl.filter((t) => (t.realizedPnlUsd || 0) > 0);
  const winRate = tradesWithPnl.length > 0 ? (winTrades.length / tradesWithPnl.length) * 100 : 0;

  // Lane 2: Smart Dip $5 Stake
  const smartPositions = safeReadJson(SMART_DIP_POS_FILE, []);
  const smartClosedTrades = safeReadJson(SMART_DIP_TRADES_FILE, []);
  const smartEvents = safeReadJson(SMART_DIP_EVENTS_FILE, []);

  const smartOpen = smartPositions.filter((p) => p.status === 'OPEN');
  const smartRealizedPnl = smartClosedTrades.reduce((acc, t) => acc + (t.realizedPnlUsd || 0), 0) + smartPositions.reduce((acc, p) => acc + (p.realizedPnlUsd || 0), 0);
  const smartCostBasis = smartOpen.reduce((acc, p) => acc + (p.remainingCostBasisUsd || 0), 0);
  const smartWinTrades = smartClosedTrades.filter((t) => (t.realizedPnlUsd || 0) > 0);
  const smartWinRate = smartClosedTrades.length > 0 ? (smartWinTrades.length / smartClosedTrades.length) * 100 : 0;

  return {
    targetWallet: TARGET_WALLET,
    swapWallet: SWAP_WALLET,
    rule: {
      stakePerEntryUsd: 2.0,
      maxEntriesPerToken: 5,
      maxTotalStakeUsd: 10.0,
      sellMode: 'PROPORTIONAL_FOLLOW',
    },
    summary: {
      openPositionsCount: openPositions.length,
      totalCapitalInvested: Number(totalCostBasis.toFixed(2)),
      totalRealizedPnlUsd: Number(totalRealizedPnl.toFixed(4)),
      closedTradesCount: closedTrades.length,
      winRatePct: Number(winRate.toFixed(1)),
      totalEventsCaptured: events.length,
      lastEventTime: events.length > 0 ? events[0].timeWib : '-',
    },
    openPositions,
    recentEvents: events.slice(0, 300),
    closedTrades: closedTrades.slice(0, 50),
    smartDip: {
      rule: {
        stakeUsd: 5.0,
        initialTpRange: '+30% to +50% (100% Full Exit)',
        moonbagRule: '>+50% (70% Sell, 30% Moonbag)',
        reboundRule: 'Target 2x Buys/Large Buy on Dip Rebound -> Quick TP +20%',
        targetExitRule: 'Target Full Exit -> 100% Exit',
      },
      summary: {
        openPositionsCount: smartOpen.length,
        totalCapitalInvested: Number(smartCostBasis.toFixed(2)),
        totalRealizedPnlUsd: Number(smartRealizedPnl.toFixed(4)),
        closedTradesCount: smartClosedTrades.length,
        winRatePct: Number(smartWinRate.toFixed(1)),
        totalEventsCaptured: smartEvents.length,
        lastEventTime: smartEvents.length > 0 ? smartEvents[0].timeWib : '-',
      },
      openPositions: smartOpen,
      recentEvents: smartEvents.slice(0, 300),
      closedTrades: smartClosedTrades.slice(0, 50),
    },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // API Status JSON endpoint (support /api/status, /add-fol/api/status, etc.)
  if (pathname.includes('/api/status')) {
    const data = loadDashboardState();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    return res.end(JSON.stringify(data));
  }

  // Default: HTML Dashboard pre-rendered with stored data (handles /, /add-fol, etc.)
  const state = loadDashboardState();
  const html = renderHtmlDashboard(state);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

function renderHtmlDashboard(initialState = {}) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Wallet Follower & Swap Comparison Radar | cr.bbliong.io</title>
  <style>
    :root {
      --bg-dark: #090d16;
      --bg-panel: #0f172a;
      --card-bg: #141e33;
      --card-border: #1e293b;
      --primary: #818cf8;
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.2);
      --rose: #f43f5e;
      --rose-glow: rgba(244, 63, 94, 0.2);
      --amber: #f59e0b;
      --cyan: #06b6d4;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      line-height: 1.5;
      padding: 20px;
    }
    .container { max-width: 1440px; margin: 0 auto; }
    
    /* Top Header */
    header {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 20px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .header-left h1 {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge-pulse {
      display: inline-block;
      width: 10px;
      height: 10px;
      background: var(--emerald);
      border-radius: 50%;
      box-shadow: 0 0 10px var(--emerald);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }
    .header-sub {
      font-size: 13px;
      color: var(--text-muted);
      margin-top: 4px;
      font-family: ui-monospace, monospace;
    }
    .header-sub a { color: var(--primary); text-decoration: none; }
    .header-sub a:hover { text-decoration: underline; }
    .header-badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .badge {
      font-size: 11px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border: 1px solid transparent;
    }
    .badge-rule { background: rgba(129, 140, 248, 0.15); color: var(--primary); border-color: rgba(129, 140, 248, 0.4); }
    .badge-live { background: rgba(16, 185, 129, 0.15); color: var(--emerald); border-color: rgba(16, 185, 129, 0.4); }

    /* Metrics Grid */
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      padding: 16px 20px;
    }
    .metric-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; margin-bottom: 6px; }
    .metric-value { font-size: 24px; font-weight: 800; font-family: ui-monospace, monospace; }
    .metric-sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

    /* Open Positions Bar */
    .positions-panel {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 24px;
    }
    .positions-header {
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--primary);
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .positions-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .pos-chip {
      background: #1a2540;
      border: 1px solid rgba(129, 140, 248, 0.3);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      min-width: 260px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .pos-chip-top {
      display: flex;
      justify-content: space-between;
      font-weight: 700;
      font-size: 14px;
    }
    .pos-chip-sub {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
    }

    /* Comparison Section */
    .section-title {
      font-size: 16px;
      font-weight: 800;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .filter-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .filter-btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .filter-btn.active, .filter-btn:hover {
      background: rgba(129, 140, 248, 0.2);
      border-color: var(--primary);
      color: #fff;
    }

    /* Side-by-side Comparison Cards */
    .events-list {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .compare-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 10px;
      overflow: hidden;
      display: grid;
      grid-template-columns: 140px 1fr 1fr;
      transition: transform 0.15s, border-color 0.2s;
    }
    .compare-card:hover {
      border-color: rgba(129, 140, 248, 0.4);
    }
    @media (max-width: 900px) {
      .compare-card { grid-template-columns: 1fr; }
    }

    /* Column 1: Time & Token */
    .col-meta {
      background: #111a2e;
      padding: 16px;
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
    }
    .meta-time {
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .meta-time-sec {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-main);
    }
    .meta-symbol {
      font-size: 15px;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .meta-mint {
      font-size: 10px;
      font-family: ui-monospace, monospace;
      color: var(--primary);
      text-decoration: none;
      word-break: break-all;
    }

    /* Column 2: Target Wallet (KIRI) */
    .col-target {
      padding: 16px 20px;
      border-right: 1px solid var(--card-border);
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(15, 23, 42, 0.6);
    }
    .side-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-buy {
      background: rgba(16, 185, 129, 0.18);
      color: var(--emerald);
      border: 1px solid rgba(16, 185, 129, 0.4);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 800;
    }
    .badge-sell {
      background: rgba(244, 63, 94, 0.18);
      color: var(--rose);
      border: 1px solid rgba(244, 63, 94, 0.4);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 800;
    }
    .trade-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-family: ui-monospace, monospace;
    }
    .trade-val { font-weight: 700; color: #fff; }
    .ratio-pill {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(245, 158, 11, 0.15);
      color: var(--amber);
      font-weight: 700;
    }

    /* Column 3: Bot Action & Swap (KANAN) */
    .col-bot {
      padding: 16px 20px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(20, 30, 51, 0.6);
    }
    .bot-pnl-win { color: var(--emerald); font-weight: 800; }
    .bot-pnl-loss { color: var(--rose); font-weight: 800; }
    .swap-badge {
      font-size: 10px;
      background: rgba(6, 182, 212, 0.15);
      color: var(--cyan);
      border: 1px solid rgba(6, 182, 212, 0.3);
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-block;
    }
    .tx-link { color: #60a5fa; text-decoration: none; font-size: 11px; }
    .tx-link:hover { text-decoration: underline; }

    /* Footer */
    footer {
      margin-top: 30px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Top Header -->
    <header>
      <div class="header-left">
        <h1>
          <span class="badge-pulse"></span>
          Wallet Follower & Swap Comparison Radar
        </h1>
        <div class="header-sub">
          Target: <a href="https://gmgn.ai/sol/address/${TARGET_WALLET}" target="_blank"><strong>${TARGET_WALLET}</strong></a>
          <span class="badge" style="background: linear-gradient(135deg, rgba(6,182,212,0.3), rgba(236,72,153,0.3)); color: #38bdf8; border: 1px solid #38bdf8; box-shadow: 0 0 10px rgba(56,189,248,0.5); font-weight: 800; font-size: 11px; padding: 2px 8px; border-radius: 6px; margin-left: 6px;">⚡ TIER SUPERULTRA</span>
          &nbsp;|&nbsp;
          Bot Wallet: <strong>${SWAP_WALLET}</strong>
        </div>
      </div>
      <div class="header-badges">
        <span class="badge" style="background: rgba(236, 72, 153, 0.2); color: #f472b6; border: 1px solid rgba(236, 72, 153, 0.4);">🍎 Apple to Apple: Fresh Tokens Only</span>
        <span class="badge badge-rule">Stake: $2.00 / Entry</span>
        <span class="badge badge-rule" style="border-color: rgba(99, 102, 241, 0.5); color: #a5b4fc;">Modal Pool: $20.00 (Max 10x Buy Bersamaan)</span>
        <span class="badge badge-rule">Sell: Proporsional & Daur Ulang Modal</span>
        <span class="badge badge-live">Live CDP 9223</span>
      </div>
    </header>

    <!-- Dual Lane Comparison Switcher -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 24px;">
      <!-- Lane 1 Card -->
      <div id="lane1-card" onclick="switchLane(1)" style="background: var(--card-bg); border: 2px solid var(--primary); border-radius: 12px; padding: 18px; cursor: pointer; transition: all 0.2s;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <strong style="color: var(--primary); font-size: 16px;">🏁 Lane 1: Direct Scalper Follower</strong>
          <span class="badge badge-rule">Pool: $20 ($2/Buy)</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Direct proportional follow, max 5x akumulasi per koin.
        </div>
        <div style="display: flex; gap: 16px; font-family: ui-monospace, monospace; font-size: 13px;">
          <div><span style="color: var(--text-muted);">Realized:</span> <strong id="l1-pnl" style="color: var(--emerald);">+$0.00</strong></div>
          <div><span style="color: var(--text-muted);">Win Rate:</span> <strong id="l1-wr">0%</strong></div>
          <div><span style="color: var(--text-muted);">Active:</span> <strong id="l1-open">0 pos</strong></div>
        </div>
      </div>

      <!-- Lane 2 Card -->
      <div id="lane2-card" onclick="switchLane(2)" style="background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 18px; cursor: pointer; transition: all 0.2s;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <strong style="color: #f59e0b; font-size: 16px;">🎯 Lane 2: Smart TP $5 & Dip Rebound</strong>
          <span class="badge" style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4);">Modal: $5 / Trade</span>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          TP +30%-50% (100% Sell), &gt;50% (70% Sell), Serok Dip Target 2x Buy &rarr; Quick TP +20%.
        </div>
        <div style="display: flex; gap: 16px; font-family: ui-monospace, monospace; font-size: 13px;">
          <div><span style="color: var(--text-muted);">Realized:</span> <strong id="l2-pnl" style="color: var(--emerald);">+$0.00</strong></div>
          <div><span style="color: var(--text-muted);">Win Rate:</span> <strong id="l2-wr">0%</strong></div>
          <div><span style="color: var(--text-muted);">Active:</span> <strong id="l2-open">0 pos</strong></div>
        </div>
      </div>
    </div>

    <!-- Metrics Row -->
    <div class="metrics-grid">
      <div class="metric-card">
        <div class="metric-label">Open Positions</div>
        <div class="metric-value" id="m-open">0</div>
        <div class="metric-sub" id="m-invested">Modal: $0.00 terpasang</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Realized Profit</div>
        <div class="metric-value" id="m-pnl" style="color: var(--emerald);">$0.00</div>
        <div class="metric-sub" id="m-trades">0 closed trades</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Win Rate</div>
        <div class="metric-value" id="m-winrate">0.0%</div>
        <div class="metric-sub">Berdasarkan exit token</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Event Stream</div>
        <div class="metric-value" id="m-events">0</div>
        <div class="metric-sub" id="m-last-time">Menunggu trade...</div>
      </div>
    </div>

    <!-- Active Positions Panel -->
    <div class="positions-panel" id="pos-panel" style="display: none;">
      <div class="positions-header">
        <span>Koin Sedang Di-Hold Bot (Active Positions)</span>
        <span id="pos-count" style="font-size: 12px; color: var(--text-muted);">0 token</span>
      </div>
      <div class="positions-chips" id="pos-chips"></div>
    </div>

    <!-- Main Comparison Stream -->
    <div class="section-title">
      <span>Komparasi Side-by-Side: Target Wallet vs Bot Paper Swap</span>
      <div class="filter-bar">
        <button class="filter-btn active" onclick="setFilter('all')">Semua Trade</button>
        <button class="filter-btn" onclick="setFilter('buy')">Hanya Buy</button>
        <button class="filter-btn" onclick="setFilter('sell')">Hanya Sell</button>
      </div>
    </div>

    <div class="events-list" id="events-list">
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        Memuat riwayat transaksi komparasi tersimpan...
      </div>
    </div>

    <footer>
      cr.bbliong.io/add-fol &bull; Dedicated 1-Wallet Follower &bull; Sub-Second WebSocket & AMM Swap Router
    </footer>
  </div>

  <script>
    let currentFilter = 'all';
    let currentLane = 1;
    let latestData = null;
    let allEvents = [];

    function switchLane(laneNum) {
      currentLane = laneNum;
      const c1 = document.getElementById('lane1-card');
      const c2 = document.getElementById('lane2-card');
      if (laneNum === 1) {
        c1.style.border = '2px solid var(--primary)';
        c2.style.border = '1px solid var(--card-border)';
      } else {
        c1.style.border = '1px solid var(--card-border)';
        c2.style.border = '2px solid #f59e0b';
      }
      if (latestData) updateDashboard(latestData);
    }

    function setFilter(f) {
      currentFilter = f;
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.toggle('active', b.innerText.toLowerCase().includes(f));
      });
      renderEvents();
    }

    function renderEvents() {
      const container = document.getElementById('events-list');
      if (!allEvents || allEvents.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">Belum ada trade yang ditangkap. Memantau target wallet...</div>';
        return;
      }

      const filtered = allEvents.filter(ev => {
        if (currentFilter === 'buy') {
          return (ev.target && ev.target.action === 'BUY') || (ev.action && ev.action.includes('BUY'));
        }
        if (currentFilter === 'sell') {
          return (ev.target && ev.target.action === 'SELL') || (ev.action && ev.action.includes('SELL'));
        }
        return true;
      });

      if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">Tidak ada transaksi untuk filter ini.</div>';
        return;
      }

      if (currentLane === 2) {
        container.innerHTML = filtered.map(ev => {
          const isBuy = ev.action && ev.action.includes('BUY');
          const isSell = ev.action && ev.action.includes('SELL');
          let actionBadge = '';
          if (ev.action === 'BUY_INITIAL') actionBadge = '<span class="badge-buy">BUY INITIAL ($5.00)</span>';
          else if (ev.action === 'BUY_REBOUND') actionBadge = '<span class="badge-buy" style="background: rgba(16,185,129,0.25);">BUY REBOUND ($5.00)</span>';
          else if (ev.action === 'SELL_TP_FULL') actionBadge = '<span class="badge-sell">TP +30%-50% (FULL 100%)</span>';
          else if (ev.action === 'SELL_TP_70') actionBadge = '<span class="badge-sell" style="background: rgba(245,158,11,0.2); color: #f59e0b;">TP >50% (SELL 70%)</span>';
          else if (ev.action === 'SELL_REBOUND_TP20') actionBadge = '<span class="badge-sell">REBOUND TP +20%</span>';
          else actionBadge = '<span class="badge-sell">TARGET EXIT (100%)</span>';

          const dateParts = (ev.timeWib || '').split(' ');
          const dateStr = dateParts[0] || '';
          const timeSecStr = (dateParts[1] || '') + ' ' + (dateParts[2] || '');

          return `
          <div class="compare-card">
            <div class="col-meta">
              <div class="meta-time">${dateStr}</div>
              <div class="meta-time-sec">${timeSecStr}</div>
              <div class="meta-symbol">${ev.tokenSymbol || 'TOKEN'}</div>
              <a href="https://solscan.io/token/${ev.tokenMint}" target="_blank" class="meta-mint">
                ${ev.tokenMint ? ev.tokenMint.slice(0, 6) + '...' + ev.tokenMint.slice(-4) : ''}
              </a>
            </div>
            <div class="col-side col-target" style="border-right: 1px solid var(--card-border);">
              <div class="side-header">
                <span>🎯 Lane 2: Smart Rule Trigger</span>
                ${actionBadge}
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Alasan Trigger:</span>
                <span class="trade-val" style="color: #a5b4fc;">${ev.reason || '-'}</span>
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Nilai Transaksi:</span>
                <span class="trade-val">$${(ev.stakeOrProceedsUsd || 0).toFixed(2)} USD</span>
              </div>
            </div>
            <div class="col-side col-bot">
              <div class="side-header">
                <span>Eksekusi AMM Swap</span>
                <span class="swap-badge">Raydium/Pump AMM</span>
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Tokens:</span>
                <span class="trade-val">${(ev.tokens || 0).toLocaleString()} ${ev.tokenSymbol || ''}</span>
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Harga Eksekusi:</span>
                <span class="trade-val">$${ev.executionPriceUsd || 0}</span>
              </div>
              ${isSell ? `
              <div class="trade-row">
                <span style="color: var(--text-muted);">Realized PnL:</span>
                <span class="${(ev.pnlUsd || 0) >= 0 ? 'bot-pnl-win' : 'bot-pnl-loss'}">
                  ${(ev.pnlUsd || 0) >= 0 ? '+' : ''}$${(ev.pnlUsd || 0).toFixed(4)} (${ev.roiPct || 0}%)
                </span>
              </div>
              ` : `
              <div class="trade-row">
                <span style="color: var(--text-muted);">Status Posisi:</span>
                <span style="color: var(--emerald); font-weight: 700;">${ev.positionStatus || 'OPEN'}</span>
              </div>
              `}
            </div>
          </div>
          `;
        }).join('');
        return;
      }

      container.innerHTML = filtered.map(ev => {
        const isTargetBuy = ev.target.action === 'BUY';
        const targetBadge = isTargetBuy 
          ? '<span class="badge-buy">TARGET BUY</span>' 
          : '<span class="badge-sell">TARGET SELL</span>';

        const isBotBuy = ev.bot.action === 'BUY';
        const isBotSell = ev.bot.action === 'SELL';
        let botBadge = '';
        if (isBotBuy) {
          botBadge = '<span class="badge-buy">BOT BUY #' + (ev.bot.entryNum || 1) + '</span>';
        } else if (isBotSell) {
          botBadge = '<span class="badge-sell">BOT SELL' + (ev.bot.isFullExit ? ' (100% EXIT)' : '') + '</span>';
        } else if (ev.bot.action === 'HOLD_MAX_CAP') {
          botBadge = '<span style="background: rgba(245, 158, 11, 0.2); color: #f59e0b; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800;">HOLD (CAP 5x)</span>';
        } else {
          botBadge = '<span style="color: var(--text-muted); font-size: 11px;">SKIP (NO POS)</span>';
        }

        const dateParts = (ev.timeWib || '').split(' ');
        const dateStr = dateParts[0] || '';
        const timeSecStr = (dateParts[1] || '') + ' ' + (dateParts[2] || '');

        return \`
        <div class="compare-card">
          <!-- Kolom 1: Waktu Detik & Koin -->
          <div class="col-meta">
            <div class="meta-time">\${dateStr}</div>
            <div class="meta-time-sec">\${timeSecStr}</div>
            <div class="meta-symbol">
              \${ev.tokenSymbol || 'TOKEN'}
            </div>
            <a href="https://solscan.io/token/\${ev.tokenMint}" target="_blank" class="meta-mint">
              \${ev.tokenMint ? ev.tokenMint.slice(0, 6) + '...' + ev.tokenMint.slice(-4) : ''}
            </a>
          </div>

          <!-- Kolom 2: TARGET WALLET (KIRI) -->
          <div class="col-target">
            <div class="side-header">
              <span>Sisi Kiri: Target Smart Wallet <span style="font-size: 9px; padding: 1px 5px; border-radius: 4px; background: linear-gradient(135deg, rgba(6,182,212,0.3), rgba(236,72,153,0.3)); color: #38bdf8; border: 1px solid #38bdf8; font-weight: 800;">⚡ SUPERULTRA</span></span>
              \${targetBadge}
            </div>
            <div class="trade-row">
              <span style="color: var(--text-muted);">Volume:</span>
              <span class="trade-val">\${ev.target.tokenAmountFormatted || ev.target.tokenAmount} tokens (\$\${Number(ev.target.usdAmount || 0).toFixed(2)})</span>
            </div>
            <div class="trade-row">
              <span style="color: var(--text-muted);">Spot Price:</span>
              <span class="trade-val">\$\${ev.target.priceUsd}</span>
            </div>
            <div class="trade-row">
              <span style="color: var(--text-muted);">Sisa di Dompet:</span>
              <span class="trade-val">\${ev.target.remainingHoldingFormatted || ev.target.remainingHolding} tokens \${ev.target.sellRatioPct ? '<span class="ratio-pill">Jual ' + ev.target.sellRatioPct + '%</span>' : ''}</span>
            </div>
            \${ev.target.txHash ? '<div style="margin-top: 4px;"><a href="https://solscan.io/tx/' + ev.target.txHash + '" target="_blank" class="tx-link">Solscan TX &nearr;</a></div>' : ''}
          </div>

          <!-- Kolom 3: BOT PAPER SWAP (KANAN) -->
          <div class="col-bot">
            <div class="side-header">
              <span>Sisi Kanan: Bot Follower & Swap Route</span>
              \${botBadge}
            </div>
            <div class="trade-row">
              <span style="color: var(--text-muted);">Eksekusi Bot:</span>
              <span class="trade-val">\${isBotBuy ? '\$' + (ev.bot.stakeUsd || 2).toFixed(2) + ' USD (' + (ev.bot.tokensFormatted || '0') + ' token)' : (isBotSell ? (ev.bot.tokensFormatted || '0') + ' token' : ev.bot.reason)}</span>
            </div>
            <div class="trade-row">
              <span style="color: var(--text-muted);">AMM Route Price:</span>
              <span class="trade-val">\$\${ev.bot.executionPriceUsd || ev.target.priceUsd} \${ev.bot.swapAmm ? '<span class="swap-badge">Raydium AMM</span>' : ''}</span>
            </div>
            \${isBotSell ? \`
            <div class="trade-row">
              <span style="color: var(--text-muted);">Realized PnL:</span>
              <span class="\${(ev.bot.pnlUsd || 0) >= 0 ? 'bot-pnl-win' : 'bot-pnl-loss'}">
                \${
                  Math.abs(ev.bot.tokensBoughtOrSold || 0) < 0.01 && Math.abs(ev.bot.pnlUsd || 0) < 0.001
                    ? '+$0.0000 (Dust Cleanup)'
                    : ((ev.bot.pnlUsd || 0) >= 0 ? '+' : '') + '\$' + (ev.bot.pnlUsd || 0).toFixed(4) + ' (' + (ev.bot.roiPct || 0) + '%)'
                }
              </span>
            </div>
            \` : \`
            <div class="trade-row">
              <span style="color: var(--text-muted);">Status Posisi:</span>
              <span style="color: var(--emerald); font-weight: 700;">\${ev.bot.positionStatus || 'OPEN'}</span>
            </div>
            \`}
          </div>
        </div>
        \`;
      }).join('');
    }

    function updateDashboard(data) {
      if (!data) return;
      latestData = data;

      // Update Top Comparison Cards
      const l1Pnl = (data.summary && data.summary.totalRealizedPnlUsd) || 0;
      const l1El = document.getElementById('l1-pnl');
      l1El.innerText = (l1Pnl >= 0 ? '+' : '') + '$' + l1Pnl.toFixed(2);
      l1El.style.color = l1Pnl >= 0 ? 'var(--emerald)' : 'var(--rose)';
      document.getElementById('l1-wr').innerText = ((data.summary && data.summary.winRatePct) || 0).toFixed(1) + '%';
      document.getElementById('l1-open').innerText = ((data.summary && data.summary.openPositionsCount) || 0) + ' pos';

      const sData = data.smartDip || { summary: {}, openPositions: [], recentEvents: [] };
      const l2Pnl = (sData.summary && sData.summary.totalRealizedPnlUsd) || 0;
      const l2El = document.getElementById('l2-pnl');
      l2El.innerText = (l2Pnl >= 0 ? '+' : '') + '$' + l2Pnl.toFixed(2);
      l2El.style.color = l2Pnl >= 0 ? 'var(--emerald)' : 'var(--rose)';
      document.getElementById('l2-wr').innerText = ((sData.summary && sData.summary.winRatePct) || 0).toFixed(1) + '%';
      document.getElementById('l2-open').innerText = ((sData.summary && sData.summary.openPositionsCount) || 0) + ' pos';

      // Pick active lane dataset
      const curSummary = currentLane === 1 ? data.summary : sData.summary;
      const curOpenPositions = currentLane === 1 ? (data.openPositions || []) : (sData.openPositions || []);
      const curEvents = currentLane === 1 ? (data.recentEvents || []) : (sData.recentEvents || []);

      document.getElementById('m-open').innerText = curSummary.openPositionsCount || 0;
      document.getElementById('m-invested').innerText = 'Modal: $' + (curSummary.totalCapitalInvested || 0).toFixed(2) + ' terpasang';

      const pnlEl = document.getElementById('m-pnl');
      const pnlVal = curSummary.totalRealizedPnlUsd || 0;
      pnlEl.innerText = (pnlVal >= 0 ? '+' : '') + '$' + pnlVal.toFixed(4);
      pnlEl.style.color = pnlVal >= 0 ? 'var(--emerald)' : 'var(--rose)';
      document.getElementById('m-trades').innerText = (curSummary.closedTradesCount || 0) + ' closed trades';

      document.getElementById('m-winrate').innerText = (curSummary.winRatePct || 0).toFixed(1) + '%';
      document.getElementById('m-events').innerText = curSummary.totalEventsCaptured || 0;
      document.getElementById('m-last-time').innerText = curSummary.lastEventTime || 'Menunggu trade...';

      // Active positions panel
      const posPanel = document.getElementById('pos-panel');
      const posChips = document.getElementById('pos-chips');

      if (curOpenPositions.length > 0) {
        posPanel.style.display = 'block';
        document.getElementById('pos-count').innerText = curOpenPositions.length + ' token aktif';
        posChips.innerHTML = curOpenPositions.map(p => {
          const curVal = p.totalTokens * (p.lastObservedPriceUsd || p.avgEntryPriceUsd);
          const unPnl = curVal - p.remainingCostBasisUsd;
          const roi = p.remainingCostBasisUsd > 0 ? (unPnl / p.remainingCostBasisUsd) * 100 : 0;
          return `
          <div class="pos-chip">
            <div class="pos-chip-top">
              <span>${p.symbol} ${p.phase ? '<small style="color: #f59e0b; margin-left: 4px;">[' + p.phase + ']</small>' : ''}</span>
              <span style="color: ${unPnl >= 0 ? 'var(--emerald)' : 'var(--rose)'};">
                ${unPnl >= 0 ? '+' : ''}$${unPnl.toFixed(2)} (${roi.toFixed(1)}%)
              </span>
            </div>
            <div class="pos-chip-sub">
              <span>Stake: $${p.remainingCostBasisUsd.toFixed(2)}</span>
              <span>Harga: $${p.lastObservedPriceUsd || p.avgEntryPriceUsd}</span>
            </div>
          </div>
          `;
        }).join('');
      } else {
        posPanel.style.display = 'none';
      }

      allEvents = curEvents;
      renderEvents();
    }

    // Render data langsung dari initial state yang disimpan di server (tanpa websocket)
    const INITIAL_STATE = ${JSON.stringify(initialState)};
    if (INITIAL_STATE && INITIAL_STATE.summary) {
      updateDashboard(INITIAL_STATE);
    }

    // Polling HTTP berkala dari disk data yang disimpan (setiap 3 detik)
    function pollStoredData() {
      const curPath = window.location.pathname;
      const cleanPath = curPath.endsWith('/') ? curPath.slice(0, -1) : curPath;
      const pathsToTry = [
        cleanPath + '/api/status',
        '/add-fol/api/status',
        '/api/status'
      ];

      function tryFetch(idx) {
        if (idx >= pathsToTry.length) return;
        fetch(pathsToTry[idx])
          .then(r => {
            if (!r.ok) throw new Error('Not ok');
            return r.json();
          })
          .then(data => {
            if (data && data.summary) updateDashboard(data);
          })
          .catch(() => tryFetch(idx + 1));
      }

      tryFetch(0);
    }

    setInterval(pollStoredData, 3000);
  </script>
</body>
</html>`;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DASHBOARD-FOLLOWER] Berjalan di port ${PORT} (http://127.0.0.1:${PORT})`);
});
