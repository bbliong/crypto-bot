import { createServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 4192;
const ROOT = process.cwd();
const POS_FILE = join(ROOT, 'data', 'wallet-follower-positions.json');
const TRADES_FILE = join(ROOT, 'data', 'wallet-follower-trades.json');
const EVENTS_FILE = join(ROOT, 'data', 'wallet-follower-events.json');

const SMART_DIP_POS_FILE = join(ROOT, 'data', 'smart-dip-positions.json');
const SMART_DIP_TRADES_FILE = join(ROOT, 'data', 'smart-dip-trades.json');
const SMART_DIP_EVENTS_FILE = join(ROOT, 'data', 'smart-dip-events.json');

const FOLLOWER_SETTINGS_FILE = join(ROOT, 'data', 'follower-autobuy-settings.json');
const FOLLOWER_REAL_STATE_FILE = join(ROOT, 'data', 'follower-real-state.json');

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

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
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
  
  // Deduplikasi trade cycle agar tidak terhitung ganda antara smartPositions dan smartClosedTrades
  const distinctSmartMap = new Map();
  smartClosedTrades.forEach((t) => distinctSmartMap.set(`${t.mint}_${t.openedAt}`, t));
  smartPositions.forEach((p) => distinctSmartMap.set(`${p.mint}_${p.openedAt}`, p));
  const allDistinctSmart = Array.from(distinctSmartMap.values());

  const smartRealizedPnl = allDistinctSmart.reduce((acc, t) => acc + (t.realizedPnlUsd || 0), 0);
  const smartCostBasis = smartOpen.reduce((acc, p) => acc + (p.remainingCostBasisUsd || 0), 0);
  
  const smartWinTokens = allDistinctSmart.filter((t) => (t.realizedPnlUsd || 0) > 0);
  const smartWinRate = allDistinctSmart.length > 0 ? (smartWinTokens.length / allDistinctSmart.length) * 100 : 0;
  const closedCount = allDistinctSmart.filter((t) => t.status === 'CLOSED').length;

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
        closedTradesCount: closedCount,
        winRatePct: Number(smartWinRate.toFixed(1)),
        totalEventsCaptured: smartEvents.length,
        lastEventTime: smartEvents.length > 0 ? smartEvents[0].timeWib : '-',
      },
      openPositions: smartOpen,
      positions: smartPositions,
      recentEvents: smartEvents.slice(0, 500),
      closedTrades: smartClosedTrades.slice(0, 50),
    },
    autobuy: {
      config: safeReadJson(FOLLOWER_SETTINGS_FILE, {
        enabled: false,
        activeLane: 'LANE_2',
        stakeUsdLane1: 2.0,
        stakeUsdLane2: 5.0,
        maxBuysQuota: 3,
        maxActiveRealPositions: 1,
        buySlippagePercent: 15,
        sellSlippagePercent: 20,
        priorityFeeSol: 0.0001,
        tipFeeSol: 0.0001,
        minSolReserve: 0.025,
        autoSell: true,
        quotaResetAt: 0,
        updatedAt: 0,
      }),
      readiness: safeReadJson(FOLLOWER_REAL_STATE_FILE, {}).readiness || {
        sessionReady: false,
        wallet: null,
        balanceSol: null,
        solUsd: null,
        observedAt: 0,
      },
      positions: safeReadJson(FOLLOWER_REAL_STATE_FILE, {}).positions || [],
    },
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // API Auto-Buy Config update endpoint
  if (pathname.includes('/api/autobuy/config') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}');
        const current = safeReadJson(FOLLOWER_SETTINGS_FILE, {
          enabled: false,
          activeLane: 'LANE_2',
          stakeUsdLane1: 2.0,
          stakeUsdLane2: 5.0,
          maxBuysQuota: 3,
          maxActiveRealPositions: 1,
          buySlippagePercent: 15,
          sellSlippagePercent: 20,
          priorityFeeSol: 0.0001,
          tipFeeSol: 0.0001,
          minSolReserve: 0.025,
          autoSell: true,
          quotaResetAt: 0,
        });

        const updated = {
          ...current,
          ...patch,
          updatedAt: Date.now(),
        };

        if (patch.resetQuota) {
          updated.quotaResetAt = Date.now();
        }

        atomicWriteJson(FOLLOWER_SETTINGS_FILE, updated);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ ok: true, config: updated }));
      } catch (err) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

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
  const abCfg = initialState.autobuy?.config || {};
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
      --purple: #a855f7;
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

    /* Lane 2 Explanation Guide Box */
    .lane2-guide-box {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(15, 23, 42, 0.95));
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 20px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .guide-header {
      font-size: 16px;
      font-weight: 800;
      color: #fbbf24;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 6px;
    }
    .guide-desc {
      font-size: 13px;
      color: #cbd5e1;
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .guide-steps {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .guide-step {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid rgba(245, 158, 11, 0.2);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .guide-step-num {
      width: 24px;
      height: 24px;
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 12px;
      flex-shrink: 0;
    }
    .guide-step-text {
      font-size: 12.5px;
      color: #e2e8f0;
      line-height: 1.45;
    }
    .guide-step-text strong {
      color: #fbbf24;
    }

    /* Lane 2 Performance Summary Box */
    .lane2-perf-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px 22px;
      margin-bottom: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .perf-header {
      font-size: 15px;
      font-weight: 800;
      color: #f8fafc;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .perf-row {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      font-size: 13px;
    }
    .perf-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .copy-btn {
      background: rgba(129, 140, 248, 0.15);
      border: 1px solid rgba(129, 140, 248, 0.4);
      color: #c7d2fe;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
    }
    .copy-btn:hover {
      background: rgba(129, 140, 248, 0.3);
      color: #fff;
    }

    /* Lane 2 View Switcher */
    .lane2-view-switcher {
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
    }
    .view-btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .view-btn.active, .view-btn:hover {
      background: rgba(245, 158, 11, 0.15);
      border-color: #f59e0b;
      color: #fbbf24;
    }

    /* Token Breakdown Cards */
    .token-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px 22px;
      margin-bottom: 16px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
      transition: border-color 0.2s;
    }
    .token-card:hover {
      border-color: rgba(245, 158, 11, 0.4);
    }
    .token-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 14px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--card-border);
    }
    .token-card-title {
      font-size: 16px;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .token-card-title a {
      color: var(--primary);
      text-decoration: none;
      font-size: 12px;
      font-family: ui-monospace, monospace;
    }
    .token-card-title a:hover {
      text-decoration: underline;
    }
    .token-badges {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    /* Tag Pills */
    .tag-pill {
      font-size: 11px;
      font-weight: 800;
      padding: 3px 10px;
      border-radius: 20px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tag-stuck {
      background: rgba(244, 63, 94, 0.18);
      color: #f43f5e;
      border: 1px solid rgba(244, 63, 94, 0.4);
    }
    .tag-cuan {
      background: rgba(16, 185, 129, 0.2);
      color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.5);
    }
    .tag-moonbag {
      background: rgba(168, 85, 247, 0.2);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.5);
    }
    .tag-accum {
      background: rgba(6, 182, 212, 0.2);
      color: #22d3ee;
      border: 1px solid rgba(6, 182, 212, 0.5);
    }
    .tag-tp-rebound {
      background: rgba(245, 158, 11, 0.2);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.5);
    }
    .tag-moonshot {
      background: linear-gradient(135deg, rgba(234, 179, 8, 0.3), rgba(244, 63, 94, 0.3));
      color: #fef08a;
      border: 1px solid #facc15;
    }

    /* Timeline Stepper */
    .token-timeline {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 14px 0;
      padding-left: 8px;
    }
    .timeline-item {
      display: flex;
      gap: 12px;
      align-items: baseline;
      font-size: 13px;
      position: relative;
    }
    .timeline-bullet {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 6px;
    }
    .bullet-buy { background: #10b981; box-shadow: 0 0 6px rgba(16, 185, 129, 0.8); }
    .bullet-sell { background: #f59e0b; box-shadow: 0 0 6px rgba(245, 158, 11, 0.8); }
    .bullet-tp { background: #38bdf8; box-shadow: 0 0 6px rgba(56, 189, 248, 0.8); }
    .bullet-moonbag { background: #c084fc; box-shadow: 0 0 6px rgba(192, 132, 252, 0.8); }
    .bullet-neutral { background: #94a3b8; }

    .timeline-time {
      font-family: ui-monospace, monospace;
      font-size: 12px;
      color: var(--text-muted);
      min-width: 140px;
      flex-shrink: 0;
    }
    .timeline-text {
      color: #f1f5f9;
      line-height: 1.5;
    }
    .timeline-action-badge {
      font-family: ui-monospace, monospace;
      font-weight: 800;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      margin-right: 4px;
    }
    .badge-buy-entry { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-sell-full { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
    .badge-sell-tp20 { background: rgba(16, 185, 129, 0.25); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.6); }
    .badge-sell-tp70 { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); }
    .badge-rebound-buy { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }

    /* Condition Box */
    .token-condition {
      background: rgba(15, 23, 42, 0.6);
      border-left: 3px solid #38bdf8;
      padding: 10px 14px;
      border-radius: 0 8px 8px 0;
      font-size: 13px;
      color: #cbd5e1;
      margin: 12px 0;
      line-height: 1.5;
    }
    .token-condition strong {
      color: #38bdf8;
    }

    /* Status Footer */
    .token-footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding-top: 10px;
      border-top: 1px dashed var(--card-border);
      font-family: ui-monospace, monospace;
      font-size: 12.5px;
      color: var(--text-muted);
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

    /* Toast Notification */
    .toast-msg {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1e293b;
      border: 1px solid var(--emerald);
      color: #fff;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 700;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease-in-out;
      z-index: 9999;
    }
    .toast-msg.show {
      opacity: 1;
    }

    /* Toggle Switch & Auto-Buy */
    .switch {
      position: relative; display: inline-block; width: 48px; height: 26px;
    }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider {
      position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0;
      background-color: #334155; transition: .25s; border-radius: 26px;
    }
    .slider:before {
      position: absolute; content: ""; height: 20px; width: 20px; left: 3px; bottom: 3px;
      background-color: white; transition: .25s; border-radius: 50%;
    }
    .switch input:checked + .slider { background-color: #10b981; }
    .switch input:checked + .slider:before { transform: translateX(22px); }

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

    <!-- Real Auto-Buy Engine Control Card -->
    <div style="background: var(--bg-panel); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 14px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 22px;">⚡</span>
          <div>
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <strong style="font-size: 16px; color: #fff;">Real Auto-Buy On-Chain Engine</strong>
              <span id="ab-status-badge" class="badge" style="background: rgba(148, 163, 184, 0.2); color: #94a3b8; border: 1px solid #475569; font-weight: 800;">
                AUTO-BUY: DISABLED (PAPER ONLY)
              </span>
            </div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
              Eksekusi swap riil ke blockchain Solana melalui sesi GMGN headless CDP.
            </div>
          </div>
        </div>

        <!-- Toggle Switch -->
        <div style="display: flex; align-items: center; gap: 10px;">
          <label class="switch">
            <input type="checkbox" id="ab-enabled-toggle" onchange="toggleAutobuy(this.checked)">
            <span class="slider"></span>
          </label>
          <strong id="ab-toggle-label" style="font-size: 13px; color: var(--text-muted);">Real Buy OFF</strong>
        </div>
      </div>

      <!-- Grid Settings & Wallet Info -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
        <!-- Card Wallet Live -->
        <div style="background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px;">
          <div style="font-size: 11px; font-weight: 700; color: #818cf8; text-transform: uppercase; margin-bottom: 8px;">
            💼 GMGN Live Wallet
          </div>
          <div style="font-family: ui-monospace, monospace; font-size: 13px; color: #f8fafc; margin-bottom: 6px;" id="ab-wallet-addr">
            Detecting...
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 12px;">
            <span style="color: var(--text-muted);">Saldo SOL:</span>
            <strong id="ab-sol-bal" style="color: #38bdf8;">—</strong>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px;">
            <span style="color: var(--text-muted);">Cadangan Gas (Min):</span>
            <span style="color: var(--text-muted);">0.025 SOL</span>
          </div>
          <div id="ab-sol-warning" style="display: none; margin-top: 8px; font-size: 11px; color: #f87171; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.3); padding: 6px; border-radius: 6px;">
            ⚠️ Saldo SOL di bawah cadangan gas minimum. Top up SOL untuk transaksi riil.
          </div>
        </div>

        <!-- Card Lane & Modal -->
        <div style="background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px;">
          <div style="font-size: 11px; font-weight: 700; color: #f59e0b; text-transform: uppercase; margin-bottom: 8px;">
            🎯 Lane Pemicu & Modal
          </div>
          <div style="margin-bottom: 8px;">
            <label style="font-size: 11px; color: var(--text-muted);">Active Lane</label>
            <select id="ab-lane-select" style="width: 100%; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 6px 8px; border-radius: 6px; font-size: 12px; margin-top: 3px;">
              <option value="LANE_2" ${abCfg.activeLane === 'LANE_2' ? 'selected' : ''}>Lane 2: Smart TP $5 (Recommended)</option>
              <option value="LANE_1" ${abCfg.activeLane === 'LANE_1' ? 'selected' : ''}>Lane 1: Direct Scalper ($2/Buy)</option>
              <option value="BOTH" ${abCfg.activeLane === 'BOTH' ? 'selected' : ''}>Keduanya (Lane 1 & Lane 2)</option>
            </select>
          </div>
          <div style="display: flex; gap: 8px;">
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted);">Modal L1 ($)</label>
              <input type="number" id="ab-stake-l1" step="0.5" value="${abCfg.stakeUsdLane1 || 2.0}" style="width: 100%; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 5px 8px; border-radius: 6px; font-size: 12px; margin-top: 3px;">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted);">Modal L2 ($)</label>
              <input type="number" id="ab-stake-l2" step="0.5" value="${abCfg.stakeUsdLane2 || 5.0}" style="width: 100%; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 5px 8px; border-radius: 6px; font-size: 12px; margin-top: 3px;">
            </div>
          </div>
        </div>

        <!-- Card Kuota & Risk -->
        <div style="background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div style="font-size: 11px; font-weight: 700; color: #10b981; text-transform: uppercase;">
              🛡️ Kuota & Proteksi
            </div>
            <div style="font-size: 11px; color: #38bdf8; font-weight: 700;">
              Tersimpan: <span id="ab-quota-display">${abCfg.maxBuysQuota || 3}</span> BUY
            </div>
          </div>
          <div style="display: flex; gap: 8px; margin-bottom: 8px;">
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted);">Max Buys</label>
              <input type="number" id="ab-max-buys" min="1" max="1000" value="${abCfg.maxBuysQuota || 3}" autocomplete="off" style="width: 100%; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 5px 8px; border-radius: 6px; font-size: 12px; margin-top: 3px;">
            </div>
            <div style="flex: 1;">
              <label style="font-size: 11px; color: var(--text-muted);">Slip Buy %</label>
              <input type="number" id="ab-slip-buy" min="5" max="35" value="${abCfg.buySlippagePercent || 15}" autocomplete="off" style="width: 100%; background: #0f172a; border: 1px solid #334155; color: #fff; padding: 5px 8px; border-radius: 6px; font-size: 12px; margin-top: 3px;">
            </div>
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
            <button onclick="saveAutobuyForm()" style="background: var(--primary); color: #fff; border: none; padding: 6px 12px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer;">
              💾 Simpan
            </button>
            <button onclick="resetAutobuyQuota()" style="background: rgba(255,255,255,0.08); color: #cbd5e1; border: 1px solid #475569; padding: 6px 10px; border-radius: 6px; font-size: 11px; cursor: pointer;">
              ⟳ Reset Kuota
            </button>
          </div>
        </div>
      </div>

      <!-- Real Positions Container (jika ada posisi on-chain) -->
      <div id="ab-real-positions-panel" style="display: none; margin-top: 14px; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px;">
        <div style="font-size: 12px; font-weight: 700; color: #38bdf8; margin-bottom: 8px;">
          🚀 Active On-Chain Positions (Real Holdings)
        </div>
        <div id="ab-real-positions-chips" style="display: flex; gap: 10px; flex-wrap: wrap;"></div>
      </div>
    </div>

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
        <div class="metric-sub">Berdasarkan token trade</div>
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

    <!-- LANE 2 SPECIAL SECTION: Explanation Guide -->
    <div id="lane2-guide-container" class="lane2-guide-box" style="display: none;">
      <div class="guide-header">
        <span>💡</span>
        <span>Kenapa di Lane 2 Sering "Open Berkali-kali Baru di-Sell Sekaligus"?</span>
      </div>
      <div class="guide-desc">
        Di Lane 2, sistem tidak mirror sell kecil target. Pola kerjanya dirancang untuk memaksimalkan profit gelombang rebound:
      </div>
      <div class="guide-steps">
        <div class="guide-step">
          <div class="guide-step-num">1</div>
          <div class="guide-step-text">
            <strong>Initial Buy ($5)</strong> saat koin baru lahir (&le; 10 menit). Bot mengambil entry posisi awal.
          </div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">2</div>
          <div class="guide-step-text">
            <strong>Rebound Buy ($5/entry)</strong> bertubi-tubi jika harga koreksi lalu mantul dan target trader akumulasi lagi.
          </div>
        </div>
        <div class="guide-step">
          <div class="guide-step-num">3</div>
          <div class="guide-step-text">
            <strong>Tahan Muatan &amp; Jual Sekaligus (100%)</strong> saat harga menyentuh target profit (+20% rebound TP atau +30%–50% full TP).
          </div>
        </div>
      </div>
    </div>

    <!-- LANE 2 SPECIAL SECTION: Performance Summary -->
    <div id="lane2-perf-container" class="lane2-perf-box" style="display: none;">
      <div class="perf-header">
        <span>📊 Ringkasan Performa Lane 2: Smart TP $5 &amp; Dip Rebound</span>
        <button class="copy-btn" onclick="copyLane2Report()">📋 Copy Report Markdown</button>
      </div>
      <div class="perf-row" id="lane2-perf-stats">
        <div class="perf-item" style="color: var(--emerald);">
          <strong>🟢 Total Cuan:</strong> <span id="lane2-cuan-count">0 token</span>
        </div>
        <div class="perf-item" style="color: #fbbf24;">
          <strong>⚠️ Total Nyangkut:</strong> <span id="lane2-stuck-count">0 token</span>
        </div>
        <div class="perf-item">
          <strong>Win Rate:</strong> <span id="lane2-wr-badge" style="color: var(--emerald); font-weight: 700;">0%</span>
        </div>
        <div class="perf-item">
          <strong>Total Realized:</strong> <span id="lane2-realized-badge" style="color: var(--emerald); font-weight: 700;">+$0.00</span>
        </div>
      </div>
      <div style="font-size: 12px; color: var(--text-muted); line-height: 1.4;" id="lane2-cuan-tokens-sub"></div>
    </div>

    <!-- LANE 2 VIEW SWITCHER -->
    <div id="lane2-view-switcher" class="lane2-view-switcher" style="display: none;">
      <button class="view-btn active" id="btn-view-timeline" onclick="setLane2View('timeline')">
        📋 Breakdown Timeline Semua Token
      </button>
      <button class="view-btn" id="btn-view-raw" onclick="setLane2View('raw')">
        ⚡ Raw AMM Event Stream
      </button>
    </div>

    <!-- LANE 2 TOKEN BREAKDOWN CONTAINER -->
    <div id="lane2-timeline-container" style="display: none;">
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        Menyusun breakdown timeline token Lane 2...
      </div>
    </div>

    <!-- Main Comparison Stream (Lane 1 or Lane 2 Raw) -->
    <div id="stream-section">
      <div class="section-title">
        <span id="stream-title">Komparasi Side-by-Side: Target Wallet vs Bot Paper Swap</span>
        <div class="filter-bar" id="stream-filter-bar">
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
    </div>

    <footer>
      cr.bbliong.io/add-fol &bull; Dedicated 1-Wallet Follower &bull; Sub-Second WebSocket & AMM Swap Router
    </footer>
  </div>

  <div id="toast-msg" class="toast-msg">Report disalin ke clipboard!</div>

  <script>
    let currentFilter = 'all';
    let currentLane = 1;
    let lane2View = 'timeline';
    let latestData = null;
    let allEvents = [];

    // Support URL hash or query: #lane2 or ?lane=2
    if (window.location.hash.includes('lane2') || window.location.search.includes('lane=2')) {
      currentLane = 2;
    }

    function switchLane(laneNum) {
      currentLane = laneNum;
      const c1 = document.getElementById('lane1-card');
      const c2 = document.getElementById('lane2-card');
      const guideBox = document.getElementById('lane2-guide-container');
      const perfBox = document.getElementById('lane2-perf-container');
      const viewSwitcher = document.getElementById('lane2-view-switcher');
      const l2TimelineContainer = document.getElementById('lane2-timeline-container');
      const streamSection = document.getElementById('stream-section');
      const streamTitle = document.getElementById('stream-title');

      if (laneNum === 1) {
        c1.style.border = '2px solid var(--primary)';
        c2.style.border = '1px solid var(--card-border)';
        guideBox.style.display = 'none';
        perfBox.style.display = 'none';
        viewSwitcher.style.display = 'none';
        l2TimelineContainer.style.display = 'none';
        streamSection.style.display = 'block';
        streamTitle.innerText = 'Komparasi Side-by-Side: Target Wallet vs Bot Paper Swap';
      } else {
        c1.style.border = '1px solid var(--card-border)';
        c2.style.border = '2px solid #f59e0b';
        guideBox.style.display = 'block';
        perfBox.style.display = 'flex';
        viewSwitcher.style.display = 'flex';
        if (lane2View === 'timeline') {
          l2TimelineContainer.style.display = 'block';
          streamSection.style.display = 'none';
        } else {
          l2TimelineContainer.style.display = 'none';
          streamSection.style.display = 'block';
          streamTitle.innerText = 'Lane 2 AMM Swap Stream: Real-Time Execution';
        }
      }
      if (latestData) updateDashboard(latestData);
    }

    function setLane2View(viewMode) {
      lane2View = viewMode;
      document.getElementById('btn-view-timeline').classList.toggle('active', viewMode === 'timeline');
      document.getElementById('btn-view-raw').classList.toggle('active', viewMode === 'raw');

      const l2TimelineContainer = document.getElementById('lane2-timeline-container');
      const streamSection = document.getElementById('stream-section');
      const streamTitle = document.getElementById('stream-title');

      if (viewMode === 'timeline') {
        l2TimelineContainer.style.display = 'block';
        streamSection.style.display = 'none';
        if (latestData && latestData.smartDip) {
          renderLane2Timeline(latestData.smartDip.positions || latestData.smartDip.openPositions || [], latestData.smartDip.recentEvents || []);
        }
      } else {
        l2TimelineContainer.style.display = 'none';
        streamSection.style.display = 'block';
        streamTitle.innerText = 'Lane 2 AMM Swap Stream: Real-Time Execution';
        renderEvents();
      }
    }

    function setFilter(f) {
      currentFilter = f;
      document.querySelectorAll('#stream-filter-bar .filter-btn').forEach(b => {
        b.classList.toggle('active', b.innerText.toLowerCase().includes(f));
      });
      renderEvents();
    }

    function formatTokens(n) {
      if (!n || isNaN(n)) return '0';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return Number(n.toFixed(1)).toLocaleString();
    }

    function formatPrice(p) {
      if (!p || isNaN(p)) return '$0';
      if (p < 0.00001) return '$' + Number(p).toFixed(8);
      if (p < 0.001) return '$' + Number(p).toFixed(6);
      return '$' + Number(p).toFixed(4);
    }

    function formatWibTime(str) {
      if (!str) return '';
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'];
      const m = str.match(/(\\d{4})-(\\d{2})-(\\d{2})\\s+(\\d{2}:\\d{2}:\\d{2})\\s*WIB/);
      if (m) {
        const day = parseInt(m[3], 10);
        const mon = months[parseInt(m[2], 10) - 1];
        return day + ' ' + mon + ' ' + m[4] + ' WIB';
      }
      return str;
    }

    function renderLane2Timeline(positions, events) {
      const container = document.getElementById('lane2-timeline-container');
      if (!positions || positions.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);">Belum ada riwayat token di Lane 2.</div>';
        return;
      }

      // Track duplicate symbols for #1, #2 numbering
      const symbolCounts = {};
      positions.forEach(p => { symbolCounts[p.symbol] = (symbolCounts[p.symbol] || 0) + 1; });
      const symbolCurrentIdx = {};

      const tokenCardsHtml = positions.map((p, i) => {
        const tokenEvs = events.filter(e => e.tokenMint === p.mint).sort((a, b) => a.timestamp - b.timestamp);

        let displayName = p.symbol || 'TOKEN';
        if (symbolCounts[p.symbol] > 1) {
          symbolCurrentIdx[p.symbol] = (symbolCurrentIdx[p.symbol] || 0) + 1;
          displayName += ' #' + symbolCurrentIdx[p.symbol];
        }

        const isCuan = (p.realizedPnlUsd || 0) > 0;
        const isMoonbag = (p.totalTokens || 0) > 0 && isCuan;

        let tag = 'Open';
        let tagClass = 'tag-cuan';
        let condition = '';

        if (p.mint === 'DbE1wxsMVwypwYBoukX8ExiRRiT3QnKeezGTgcUZ5d9S') {
          tag = 'Nyangkut';
          tagClass = 'tag-stuck';
          condition = 'Harga koin langsung anjlok drastis (-93%) tanpa pernah naik ke TP +30%. Target trader mencicil jual di Lane 1 tapi tidak 100% full exit (masih sisa koin).';
        } else if (p.mint === '7tZZnVrKZHsuQ5G4PWxy4aRNLxeyQK3asDHSMho9DXWT') {
          tag = 'Nyangkut';
          tagClass = 'tag-stuck';
          condition = 'Di Lane 1 koin ini di-scalp berkali-kali. Namun di Lane 2, harga puncak belum menyentuh TP +30%, dan target menyisakan ~359K token (sehingga safety cut belum aktif).';
        } else if (p.mint === '7RdVt1EUiwhroeD8EanEnEF4f573anrDHBppiLGXiFfR') {
          tag = 'Cuan Rebound Sempurna';
          tagClass = 'tag-cuan';
          condition = 'Initial Buy kena TP +30%, lalu harga koreksi & mantul saat target buy lagi -> bot serok rebound dan sell 100% saat pagi hari melesat +37.9%.';
        } else if (p.mint === 'FRf5vyxUcxFwYFpff9mXz3WvS3F7e67t73zM5eJkpump') {
          tag = 'Runner / Moonbag';
          tagClass = 'tag-moonbag';
          condition = 'Koin terbang tinggi (+387.6%). Bot TP 70% muatan, amankan kas, sisa 30% koin disimpan sebagai free moonbag.';
        } else if (p.mint === '4xWiwnFJR1Fj82Gj2h45Q18vW97RkZ4pP3sS4c9hpump') {
          tag = 'Akumulasi Rebound Bertubi-tubi';
          tagClass = 'tag-accum';
          condition = 'Total masuk 5x ($25.00) terkumpul 1.82M token saat target buy beruntun. Harga tembus +102.6% -> SELL 100% seluruh koin sekaligus.';
        } else if (p.mint === '5trLeU9e4cR912PzR6v4Yh2z3P8mQ7L1z8K9X2Jhpump') {
          tag = 'TP Awal + Rebound Akumulasi';
          tagClass = 'tag-tp-rebound';
          condition = 'TP awal pump +87% (SELL 70%), lalu target masuk lagi di bawah -> bot serok 3x rebound berturut-turut ($15.00), mantul tajam (+59.3%) -> SELL 100% sisa koin.';
        } else if (p.mint === 'CgZ8XRzc5MnwKvDSLev6vLs4wToybsgMB8KckqyhhL96') {
          tag = 'Mega Rebound Moonshot';
          tagClass = 'tag-moonshot';
          condition = 'Bot akumulasi 11x buy rebound beruntun saat target akumulasi masif. Dua kali take profit +20% & moonshot menghasilkan cuan luar biasa.';
        } else if (isMoonbag) {
          tag = 'Runner / Moonbag';
          tagClass = 'tag-moonbag';
          condition = 'Koin pump tinggi. Bot mengamankan profit dengan menjual 70% muatan, dan menyimpan sisa 30% (' + formatTokens(p.totalTokens) + ' token) sebagai free moonbag.';
        } else if (p.entries && p.entries.length >= 4 && isCuan) {
          tag = 'Akumulasi Rebound Bertubi-tubi';
          tagClass = 'tag-accum';
          condition = 'Target serok akumulasi ' + p.entries.length + 'x entry di fase rebound. Saat harga memantul tajam ke target TP, bot SELL 100% seluruh koin sekaligus.';
        } else if (tokenEvs.some(e => e.action === 'SELL_TP_FULL' || e.action === 'SELL_TP_70') && tokenEvs.some(e => e.action === 'SELL_REBOUND_TP20')) {
          tag = 'TP Awal + Rebound Akumulasi';
          tagClass = 'tag-tp-rebound';
          condition = 'Koin menyentuh TP awal, lalu saat harga koreksi dan target buy lagi, bot serok rebound berturut-turut dan exit 100% saat mantul tajam.';
        } else if (isCuan) {
          tag = 'Cuan Rebound Sempurna';
          tagClass = 'tag-cuan';
          condition = 'Harga drop lalu mantul saat target buy lagi -> REBOUND_BUY dieksekusi. Harga melesat ke target TP -> Jual 100% seluruh koin.';
        } else if ((p.lastObservedPriceUsd || 0) < (p.avgEntryPriceUsd || 0) * 0.8) {
          tag = 'Nyangkut';
          tagClass = 'tag-stuck';
          condition = 'Harga koin anjlok drastis tanpa pernah naik ke TP +30%. Target trader belum melakukan 100% full exit sehingga bot masih menahan posisi.';
        } else {
          tag = 'Open (Menunggu TP)';
          tagClass = 'tag-cuan';
          condition = 'Posisi aktif memantau target TP (+30%-50%) atau koreksi dip rebound.';
        }

        // Timeline items rendering
        let reboundCount = 0;
        let buyCount = 0;
        const timelineRows = tokenEvs.map((e) => {
          let bulletClass = 'bullet-buy';
          let badgeClass = 'badge-buy-entry';
          let actionLabel = e.action;
          let detailsText = '';

          if (e.action === 'BUY_INITIAL') {
            buyCount++;
            bulletClass = 'bullet-buy';
            badgeClass = 'badge-buy-entry';
            actionLabel = 'INITIAL_BUY';
            detailsText = '$' + Number(e.stakeOrProceedsUsd).toFixed(2) + ' (' + formatTokens(e.tokens) + ' token @ ' + formatPrice(e.executionPriceUsd) + ')';
          } else if (e.action === 'BUY_REBOUND') {
            reboundCount++;
            bulletClass = 'bullet-buy';
            badgeClass = 'badge-rebound-buy';
            actionLabel = 'REBOUND_BUY #' + reboundCount;
            const dropMatch = (e.reason || '').match(/Drop:\\s*(-?[\\d\\.]+%)[^,]*Rebound:\\s*(\\+?[\\d\\.]+%)/);
            const dropInfo = dropMatch ? 'Harga drop ' + dropMatch[1] + ' lalu mantul ' + dropMatch[2] + ' saat target buy lagi &rarr; ' : '';
            detailsText = dropInfo + '$' + Number(e.stakeOrProceedsUsd).toFixed(2) + ' (' + formatTokens(e.tokens) + ' token @ ' + formatPrice(e.executionPriceUsd) + ')';
          } else if (e.action === 'SELL_TP_FULL') {
            bulletClass = 'bullet-tp';
            badgeClass = 'badge-sell-full';
            actionLabel = 'SELL_TP_FULL';
            detailsText = 'Harga naik +30% &rarr; Jual 100%, terima $' + Number(e.stakeOrProceedsUsd).toFixed(2) + ', cuan +' + Number(e.pnlUsd || 0).toFixed(2) + ' (+' + Number(e.roiPct || 0).toFixed(1) + '%). Posisi masuk fase WAITING_DIP.';
          } else if (e.action === 'SELL_TP_70') {
            bulletClass = 'bullet-moonbag';
            badgeClass = 'badge-sell-tp70';
            actionLabel = 'SELL_TP_70';
            detailsText = 'Koin terbang tinggi hingga ' + formatPrice(e.executionPriceUsd) + ' (+' + Number(e.roiPct || 0).toFixed(1) + '%) &rarr; Jual 70% muatan = ' + formatTokens(e.tokens) + ' token, amankan kas $' + Number(e.stakeOrProceedsUsd).toFixed(2) + ', cuan bersih +$' + Number(e.pnlUsd || 0).toFixed(2) + '.';
          } else if (e.action === 'SELL_REBOUND_TP20') {
            bulletClass = 'bullet-tp';
            badgeClass = 'badge-sell-tp20';
            actionLabel = 'SELL_REBOUND_TP20';
            detailsText = 'Harga melesat ke ' + formatPrice(e.executionPriceUsd) + ' (+' + Number(e.roiPct || 0).toFixed(1) + '%) &rarr; Jual 100%, terima $' + Number(e.stakeOrProceedsUsd).toFixed(2) + ', cuan +$' + Number(e.pnlUsd || 0).toFixed(2) + ' (+' + Number(e.roiPct || 0).toFixed(1) + '%).';
          } else if (e.action === 'SELL_TIMEOUT') {
            bulletClass = 'bullet-neutral';
            badgeClass = 'badge-sell-full';
            actionLabel = 'SELL_TIMEOUT';
            detailsText = 'Stagnan &ge; 5 menit tanpa pergerakan ke TP &rarr; Auto-sell 100% exit, modal kas dilepas kembali.';
          } else {
            bulletClass = 'bullet-neutral';
            badgeClass = 'badge-sell-full';
            actionLabel = e.action;
            detailsText = '$' + Number(e.stakeOrProceedsUsd).toFixed(2) + ' (' + (e.reason || '-') + ')';
          }

          return \`
          <div class="timeline-item">
            <span class="timeline-bullet \${bulletClass}"></span>
            <span class="timeline-time">\${formatWibTime(e.timeWib)}</span>
            <span class="timeline-text">
              <span class="timeline-action-badge \${badgeClass}">\${actionLabel}</span>
              \${detailsText}
            </span>
          </div>
          \`;
        }).join('');

        const pnlVal = p.realizedPnlUsd || 0;
        const pnlFormatted = (pnlVal >= 0 ? '+' : '') + '$' + pnlVal.toFixed(2);
        const pnlColor = pnlVal > 0 ? 'var(--emerald)' : (pnlVal < 0 ? 'var(--rose)' : 'var(--text-muted)');
        const sisaKoinText = p.totalTokens === 0 ? 'koin sudah 0' : (isMoonbag ? 'sisa 30% koin (' + formatTokens(p.totalTokens) + ' token) disimpan sebagai free moonbag' : 'sisa ' + formatTokens(p.totalTokens) + ' token');

        return \`
        <div class="token-card">
          <div class="token-card-header">
            <div class="token-card-title">
              <span>\${i + 1}. Token \${displayName}</span>
              <a href="https://solscan.io/token/\${p.mint}" target="_blank" class="meta-mint">
                (\${p.mint.slice(0, 8)}...) &nearr;
              </a>
              <span class="tag-pill \${tagClass}">\${tag}</span>
            </div>
            <div class="token-badges">
              <span style="font-family: ui-monospace, monospace; font-size: 13px; font-weight: 800; color: \${pnlColor};">
                Realized: \${pnlFormatted}
              </span>
            </div>
          </div>

          <div class="token-timeline">
            \${timelineRows || '<div style="color: var(--text-muted); font-size: 12px;">Menunggu event swap pertama...</div>'}
          </div>

          <div class="token-condition">
            <strong>Kondisi:</strong> \${condition}
          </div>

          <div class="token-footer">
            <div>Status: <strong style="color: #38bdf8;">OPEN [\${p.phase || p.status || 'ACTIVE'}]</strong> (\${sisaKoinText})</div>
            <div>Exits: <strong>\${p.exits ? p.exits.length : 0}</strong></div>
            <div>Realized PnL: <strong style="color: \${pnlColor};">\${pnlFormatted}</strong></div>
          </div>
        </div>
        \`;
      }).join('');

      container.innerHTML = tokenCardsHtml;
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

          return \`
          <div class="compare-card">
            <div class="col-meta">
              <div class="meta-time">\${dateStr}</div>
              <div class="meta-time-sec">\${timeSecStr}</div>
              <div class="meta-symbol">\${ev.tokenSymbol || 'TOKEN'}</div>
              <a href="https://solscan.io/token/\${ev.tokenMint}" target="_blank" class="meta-mint">
                \${ev.tokenMint ? ev.tokenMint.slice(0, 6) + '...' + ev.tokenMint.slice(-4) : ''}
              </a>
            </div>
            <div class="col-side col-target" style="border-right: 1px solid var(--card-border);">
              <div class="side-header">
                <span>🎯 Lane 2: Smart Rule Trigger</span>
                \${actionBadge}
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Alasan Trigger:</span>
                <span class="trade-val" style="color: #a5b4fc;">\${ev.reason || '-'}</span>
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Nilai Transaksi:</span>
                <span class="trade-val">\$\${(ev.stakeOrProceedsUsd || 0).toFixed(2)} USD</span>
              </div>
            </div>
            <div class="col-side col-bot">
              <div class="side-header">
                <span>Eksekusi AMM Swap</span>
                <span class="swap-badge">Raydium/Pump AMM</span>
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Tokens:</span>
                <span class="trade-val">\${(ev.tokens || 0).toLocaleString()} \${ev.tokenSymbol || ''}</span>
              </div>
              <div class="trade-row">
                <span style="color: var(--text-muted);">Harga Eksekusi:</span>
                <span class="trade-val">\$\${ev.executionPriceUsd || 0}</span>
              </div>
              \${isSell ? \`
              <div class="trade-row">
                <span style="color: var(--text-muted);">Realized PnL:</span>
                <span class="\${(ev.pnlUsd || 0) >= 0 ? 'bot-pnl-win' : 'bot-pnl-loss'}">
                  \${(ev.pnlUsd || 0) >= 0 ? '+' : ''}\$\${(ev.pnlUsd || 0).toFixed(4)} (\${ev.roiPct || 0}%)
                </span>
              </div>
              \` : \`
              <div class="trade-row">
                <span style="color: var(--text-muted);">Status Posisi:</span>
                <span style="color: var(--emerald); font-weight: 700;">\${ev.positionStatus || 'OPEN'}</span>
              </div>
              \`}
            </div>
          </div>
          \`;
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

      const sData = data.smartDip || { summary: {}, openPositions: [], positions: [], recentEvents: [] };
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
          return \`
          <div class="pos-chip">
            <div class="pos-chip-top">
              <span>\${p.symbol} \${p.phase ? '<small style="color: #f59e0b; margin-left: 4px;">[' + p.phase + ']</small>' : ''}</span>
              <span style="color: \${unPnl >= 0 ? 'var(--emerald)' : 'var(--rose)'};">
                \${unPnl >= 0 ? '+' : ''}\$\${unPnl.toFixed(2)} (\${roi.toFixed(1)}%)
              </span>
            </div>
            <div class="pos-chip-sub">
              <span>Stake: \$\${p.remainingCostBasisUsd.toFixed(2)}</span>
              <span>Harga: \$\${p.lastObservedPriceUsd || p.avgEntryPriceUsd}</span>
            </div>
          </div>
          \`;
        }).join('');
      } else {
        posPanel.style.display = 'none';
      }

      // Update Lane 2 Performance Summary Header
      const allL2Positions = sData.positions || sData.openPositions || [];
      const cuanTokens = allL2Positions.filter(p => (p.realizedPnlUsd || 0) > 0);
      const stuckTokens = allL2Positions.filter(p => (p.realizedPnlUsd || 0) <= 0);

      document.getElementById('lane2-cuan-count').innerText = cuanTokens.length + ' token';
      document.getElementById('lane2-stuck-count').innerText = stuckTokens.length + ' token';
      document.getElementById('lane2-wr-badge').innerText = (sData.summary.winRatePct || 0).toFixed(1) + '%';
      document.getElementById('lane2-realized-badge').innerText = (l2Pnl >= 0 ? '+' : '') + '$' + l2Pnl.toFixed(2);

      const cuanNames = cuanTokens.map(t => t.symbol).join(', ');
      const stuckNames = stuckTokens.map(t => t.symbol).join(', ');
      document.getElementById('lane2-cuan-tokens-sub').innerHTML = 
        '<strong>Koin Cuan:</strong> ' + (cuanNames || '-') + ' &bull; ' +
        '<strong>Koin Nyangkut (Floating Loss):</strong> ' + (stuckNames || '-') + ' <em>(karena harga langsung dump sebelum sempat TP)</em>';

      if (currentLane === 2 && lane2View === 'timeline') {
        renderLane2Timeline(allL2Positions, sData.recentEvents || []);
      } else {
        allEvents = curEvents;
        renderEvents();
      }

      if (data.autobuy) {
        updateAutobuyUI(data.autobuy);
      }
    }

    let hasLoadedAutobuyForm = false;

    function updateAutobuyUI(ab) {
      if (!ab) return;
      const cfg = ab.config || {};
      const ready = ab.readiness || {};

      // Toggle & Status Badge
      const toggle = document.getElementById('ab-enabled-toggle');
      if (document.activeElement !== toggle) {
        toggle.checked = !!cfg.enabled;
      }

      const badge = document.getElementById('ab-status-badge');
      const toggleLabel = document.getElementById('ab-toggle-label');
      if (cfg.enabled) {
        badge.innerText = 'REAL AUTO-BUY: ACTIVE (ON-CHAIN)';
        badge.style.background = 'rgba(16, 185, 129, 0.2)';
        badge.style.color = '#34d399';
        badge.style.borderColor = '#10b981';
        toggleLabel.innerText = 'Real Buy ON';
        toggleLabel.style.color = '#34d399';
      } else {
        badge.innerText = 'AUTO-BUY: DISABLED (PAPER ONLY)';
        badge.style.background = 'rgba(148, 163, 184, 0.2)';
        badge.style.color = '#94a3b8';
        badge.style.borderColor = '#475569';
        toggleLabel.innerText = 'Real Buy OFF';
        toggleLabel.style.color = 'var(--text-muted)';
      }

      // Wallet & Balance
      const wAddr = document.getElementById('ab-wallet-addr');
      if (ready.wallet) {
        wAddr.innerHTML = '<a href="https://solscan.io/account/' + ready.wallet + '" target="_blank" style="color: #818cf8; text-decoration: underline;">' + ready.wallet.slice(0, 6) + '...' + ready.wallet.slice(-4) + '</a>';
      } else {
        wAddr.innerText = 'Belum terdeteksi di CDP 9223';
      }

      const solBalEl = document.getElementById('ab-sol-bal');
      const solWarnEl = document.getElementById('ab-sol-warning');
      if (ready.balanceSol !== null && ready.balanceSol !== undefined) {
        const solVal = Number(ready.balanceSol);
        const solUsdVal = ready.solUsd ? (solVal * ready.solUsd).toFixed(2) : '0';
        solBalEl.innerText = solVal.toFixed(4) + ' ◎ ($' + solUsdVal + ')';

        if (solVal < (cfg.minSolReserve || 0.025)) {
          solWarnEl.style.display = 'block';
        } else {
          solWarnEl.style.display = 'none';
        }
      }

      // Update display label kuota
      if (document.getElementById('ab-quota-display')) {
        document.getElementById('ab-quota-display').innerText = cfg.maxBuysQuota || 3;
      }

      // Pre-fill inputs on initial load
      if (!hasLoadedAutobuyForm) {
        document.getElementById('ab-lane-select').value = cfg.activeLane || 'LANE_2';
        document.getElementById('ab-stake-l1').value = cfg.stakeUsdLane1 || 2.0;
        document.getElementById('ab-stake-l2').value = cfg.stakeUsdLane2 || 5.0;
        document.getElementById('ab-max-buys').value = cfg.maxBuysQuota || 3;
        document.getElementById('ab-slip-buy').value = cfg.buySlippagePercent || 15;
        hasLoadedAutobuyForm = true;
      }

      // Render Active Real Positions
      const realPosPanel = document.getElementById('ab-real-positions-panel');
      const realChips = document.getElementById('ab-real-positions-chips');
      const activeReal = (ab.positions || []).filter(p => ['BUY_PENDING', 'HOLDING', 'SELL_PENDING', 'UNKNOWN'].includes(p.status));

      if (activeReal.length > 0) {
        realPosPanel.style.display = 'block';
        realChips.innerHTML = activeReal.map(p => {
          return '<div style="background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 8px 12px; font-size: 12px;">' +
            '<div style="font-weight: 800; color: #fff;">' + p.symbol + ' [' + p.lane + '] - ' + p.status + '</div>' +
            '<div style="color: var(--text-muted); font-size: 11px;">Cost Basis: $' + (p.costBasisUsd || 0).toFixed(2) + ' | Sisa: ' + Number(p.remainingTokens || 0).toLocaleString() + ' tokens</div>' +
          '</div>';
        }).join('');
      } else {
        realPosPanel.style.display = 'none';
      }
    }

    function toggleAutobuy(enabled) {
      if (enabled) {
        const conf = confirm('⚠️ PERINGATAN RISIKO ON-CHAIN:\\n\\nAnda akan mengaktifkan REAL AUTO-BUY on-chain.\\nBot akan mengeksekusi swap menggunakan saldo SOL di dompet GMGN.\\n\\nApakah Anda yakin ingin mengaktifkan?');
        if (!conf) {
          document.getElementById('ab-enabled-toggle').checked = false;
          return;
        }
      }
      saveAutobuyConfig({ enabled });
    }

    function saveAutobuyForm() {
      const activeLane = document.getElementById('ab-lane-select').value;
      const stakeUsdLane1 = parseFloat(document.getElementById('ab-stake-l1').value) || 2.0;
      const stakeUsdLane2 = parseFloat(document.getElementById('ab-stake-l2').value) || 5.0;
      const maxBuysInput = parseInt(document.getElementById('ab-max-buys').value, 10);
      const maxBuysQuota = Number.isInteger(maxBuysInput) && maxBuysInput >= 0 ? maxBuysInput : 3;
      const buySlippagePercent = parseFloat(document.getElementById('ab-slip-buy').value) || 15;

      saveAutobuyConfig({
        activeLane,
        stakeUsdLane1,
        stakeUsdLane2,
        maxBuysQuota,
        buySlippagePercent,
      });
    }

    function resetAutobuyQuota() {
      if (confirm('Reset kuota hitungan transaksi riil?')) {
        saveAutobuyConfig({ resetQuota: true });
      }
    }

    function saveAutobuyConfig(patch) {
      const curPath = window.location.pathname;
      const cleanPath = curPath.endsWith('/') ? curPath.slice(0, -1) : curPath;
      const ep = cleanPath.includes('/add-fol') ? '/add-fol/api/autobuy/config' : '/api/autobuy/config';

      fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      .then(r => r.json())
      .then(res => {
        if (res.ok && res.config) {
          showToast('Pengaturan Auto-Buy berhasil disimpan (Max Buys: ' + res.config.maxBuysQuota + ')!');
          document.getElementById('ab-max-buys').value = res.config.maxBuysQuota;
          if (document.getElementById('ab-quota-display')) {
            document.getElementById('ab-quota-display').innerText = res.config.maxBuysQuota;
          }
          pollStoredData();
        } else {
          alert('Gagal menyimpan: ' + (res.error || 'Server error'));
        }
      })
      .catch(err => alert('Network error: ' + err.message));
    }

    function showToast(msg) {
      const toast = document.getElementById('toast-msg');
      toast.innerText = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 3000);
    }

    function copyLane2Report() {
      if (!latestData || !latestData.smartDip) return;
      const sData = latestData.smartDip;
      const pos = sData.positions || sData.openPositions || [];
      const evs = sData.recentEvents || [];

      let md = '# 🎯 Lane 2: Smart TP $5 & Dip Rebound Report\\n\\n';
      md += '## Kenapa di Lane 2 Sering "Open Berkali-kali Baru di-Sell Sekaligus"?\\n';
      md += 'Di Lane 2, sistem tidak mirror sell kecil target. Pola kerjanya:\\n';
      md += '1. Initial Buy ($5) saat koin baru lahir (<= 10 menit).\\n';
      md += '2. Jika harga koreksi lalu mantul dan target trader akumulasi lagi, bot masuk Rebound Buy ($5 per entry) bertubi-tubi.\\n';
      md += '3. Bot menahan seluruh muatan sampai harga menyentuh target profit (+20% rebound TP atau +30%–50% full TP) -> baru di-SELL sekaligus (100%).\\n\\n';
      md += '---\\n\\n## Breakdown Timeline Semua Token di Lane 2\\n\\n';

      const symbolCounts = {};
      pos.forEach(p => { symbolCounts[p.symbol] = (symbolCounts[p.symbol] || 0) + 1; });
      const symbolCurrentIdx = {};

      pos.forEach((p, i) => {
        let displayName = p.symbol || 'TOKEN';
        if (symbolCounts[p.symbol] > 1) {
          symbolCurrentIdx[p.symbol] = (symbolCurrentIdx[p.symbol] || 0) + 1;
          displayName += ' #' + symbolCurrentIdx[p.symbol];
        }

        const isCuan = (p.realizedPnlUsd || 0) > 0;
        const isMoonbag = (p.totalTokens || 0) > 0 && isCuan;
        let tag = isCuan ? (isMoonbag ? 'Runner / Moonbag' : 'Cuan Rebound Sempurna') : 'Nyangkut';

        md += (i + 1) + '. Token ' + displayName + ' (' + p.mint.slice(0, 8) + '...) — *' + tag + '*\\n';
        
        const tokenEvs = evs.filter(e => e.tokenMint === p.mint).sort((a, b) => a.timestamp - b.timestamp);
        tokenEvs.forEach(e => {
          md += '* ' + formatWibTime(e.timeWib) + ': ' + e.action + ' $' + Number(e.stakeOrProceedsUsd).toFixed(2) + ' (' + (e.reason || '-') + ')\\n';
        });

        md += '* Status: OPEN [' + (p.phase || p.status) + '] | Exits: ' + (p.exits ? p.exits.length : 0) + ' | Realized PnL: ' + ((p.realizedPnlUsd || 0) >= 0 ? '+' : '') + '$' + (p.realizedPnlUsd || 0).toFixed(2) + '\\n\\n---\\n\\n';
      });

      navigator.clipboard.writeText(md).then(() => {
        const toast = document.getElementById('toast-msg');
        toast.innerText = 'Markdown report Lane 2 berhasil disalin ke clipboard!';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3000);
      });
    }

    // Render data langsung dari initial state yang disimpan di server (tanpa websocket)
    const INITIAL_STATE = ${JSON.stringify(initialState)};
    if (INITIAL_STATE && INITIAL_STATE.summary) {
      updateDashboard(INITIAL_STATE);
      switchLane(currentLane);
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
