import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runScanHighWinrateWallets, processAndSaveWallets } from './scan-high-winrate-wallets.mjs';

const PORT = 4198;
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');
const storeFile = join(dataDir, 'high-winrate-wallets.json');

let isScanning = false;

function loadStore() {
  if (existsSync(storeFile)) {
    try {
      return JSON.parse(readFileSync(storeFile, 'utf8'));
    } catch (e) {}
  }
  return { updatedAt: new Date().toISOString(), totalDiscovered: 0, totalCurated: 0, wallets: [] };
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function renderHtml() {
  const store = loadStore();
  const wallets = store.wallets || [];
  const benchmark = wallets.find(w => w.isBenchmark) || {
    address: '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34',
    wr7d: 95.6,
    pnl7d: 430951,
    txs7d: 35075,
    avgHold7dSec: 153,
    solBalance: 10.35
  };

  const nonBenchmark = wallets.filter(w => !w.isBenchmark);
  const wr90Count = nonBenchmark.filter(w => (w.wr7d >= 89.9 || w.wr30d >= 89.9)).length;
  const bigPnlCount = nonBenchmark.filter(w => (w.pnl7d >= 10000 || w.pnl30d >= 20000)).length;
  const rotatorCount = nonBenchmark.filter(w => (w.avgHold7dSec > 0 && w.avgHold7dSec <= 900)).length;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🎯 High Win Rate (&gt;90%) Smart Wallet Radar | cr.bbliong.io</title>
  <style>
    :root {
      --bg: #070a13;
      --card-bg: #0f172a;
      --card-border: #1e293b;
      --accent-blue: #38bdf8;
      --accent-green: #10b981;
      --accent-gold: #f59e0b;
      --accent-purple: #a855f7;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --table-hover: #1e293b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      padding: 24px 20px;
      line-height: 1.5;
    }
    .container { max-width: 1440px; margin: 0 auto; }
    
    /* Header */
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .title-group h1 { font-size: 1.5rem; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 8px; }
    .title-group p { font-size: 0.88rem; color: var(--text-muted); margin-top: 4px; }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .btn {
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      text-decoration: none;
    }
    .btn-primary { background: #2563eb; color: #fff; }
    .btn-primary:hover { background: #1d4ed8; }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .badge-live {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.15);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: var(--accent-green);
      font-size: 0.75rem;
      font-weight: 700;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-green); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Benchmark Gold Banner */
    .benchmark-card {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.12) 0%, rgba(15, 23, 42, 0.8) 100%);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 20px rgba(245, 158, 11, 0.08);
    }
    .bm-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
    .bm-title { display: flex; align-items: center; gap: 10px; font-size: 1.1rem; font-weight: 700; color: #fbbf24; }
    .bm-addr { font-family: monospace; font-size: 0.9rem; color: #38bdf8; background: rgba(56, 189, 248, 0.1); padding: 4px 8px; border-radius: 6px; }
    .bm-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
    }
    .bm-stat-box { background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.06); padding: 12px 16px; border-radius: 8px; }
    .bm-stat-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
    .bm-stat-val { font-size: 1.35rem; font-weight: 800; color: #fff; }
    .bm-stat-val.good { color: var(--accent-green); }
    .bm-stat-val.gold { color: var(--accent-gold); }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
    }
    .sc-label { font-size: 0.8rem; color: var(--text-muted); font-weight: 600; margin-bottom: 6px; }
    .sc-val { font-size: 1.6rem; font-weight: 800; color: #fff; }
    .sc-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; }

    /* Filter Nav */
    .filter-bar {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .filter-btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-btn:hover { background: #1e293b; color: #fff; }
    .filter-btn.active {
      background: #2563eb;
      color: #fff;
      border-color: #3b82f6;
      box-shadow: 0 0 12px rgba(37, 99, 235, 0.4);
    }

    /* Table */
    .table-wrapper {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow-x: auto;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.85rem; }
    th {
      background: #0b1120;
      color: var(--text-muted);
      font-weight: 600;
      padding: 14px 16px;
      border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
      text-transform: uppercase;
      font-size: 0.72rem;
      letter-spacing: 0.5px;
    }
    td {
      padding: 14px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
      white-space: nowrap;
    }
    tr:hover td { background: var(--table-hover); }
    tr.is-benchmark td { background: rgba(245, 158, 11, 0.06); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .copy-btn {
      background: rgba(255,255,255,0.08);
      border: none;
      color: #94a3b8;
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.7rem;
      margin-left: 6px;
    }
    .copy-btn:hover { color: #fff; background: rgba(255,255,255,0.18); }
    
    /* Badges */
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.72rem;
      font-weight: 700;
    }
    .badge-wr-high { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); }
    .badge-wr-mid { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .badge-pnl { color: #34d399; font-weight: 700; }
    .badge-archetype {
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
      border: 1px solid rgba(56, 189, 248, 0.3);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-archetype.gold {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.4);
    }
    .progress-bar {
      width: 70px;
      height: 6px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-left: 6px;
    }
    .progress-fill { height: 100%; border-radius: 3px; background: var(--accent-green); }
    .progress-fill.gold { background: var(--accent-gold); }

    .tag-pill {
      font-size: 0.68rem;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      border: 1px solid rgba(255, 255, 255, 0.08);
      margin-right: 4px;
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header-bar">
      <div class="title-group">
        <h1>🎯 High Win Rate (&gt;90%) Smart Wallet Radar</h1>
        <p>Solana Discovery Engine Berdasarkan Pola Target Wallet Awal (<code>3azG8rmt...</code>)</p>
      </div>
      <div class="header-actions">
        <span class="badge-live"><span class="dot"></span> LIVE DATA</span>
        <button class="btn btn-primary" id="btn-scan" onclick="triggerScan()">🔄 Scan GMGN Sekarang</button>
      </div>
    </div>

    <!-- Benchmark Target Card -->
    <div class="benchmark-card">
      <div class="bm-header">
        <div class="bm-title">
          ⭐ TARGET WALLET BENCHMARK (Pola Acuan Utama)
          <span class="bm-addr">${benchmark.address}</span>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${benchmark.address}'); alert('Copied!');">Salin</button>
        </div>
        <div>
          <a href="https://gmgn.ai/sol/address/${benchmark.address}" target="_blank" class="btn btn-primary" style="padding: 4px 10px; font-size: 0.75rem; background: #d97706;">GMGN Profil ↗</a>
        </div>
      </div>
      <div class="bm-stats">
        <div class="bm-stat-box">
          <div class="bm-stat-label">Win Rate 7D / 30D</div>
          <div class="bm-stat-val good">${benchmark.wr7d}% <span style="font-size:0.8rem; color:var(--text-muted); font-weight:400;">(${benchmark.wr30d}%)</span></div>
        </div>
        <div class="bm-stat-box">
          <div class="bm-stat-label">7D Realized Profit</div>
          <div class="bm-stat-val good">+$${Number(benchmark.pnl7d).toLocaleString()}</div>
        </div>
        <div class="bm-stat-box">
          <div class="bm-stat-label">Total Trade (7D)</div>
          <div class="bm-stat-val gold">${Number(benchmark.txs7d).toLocaleString()} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400;">txs</span></div>
        </div>
        <div class="bm-stat-box">
          <div class="bm-stat-label">Avg Hold Period</div>
          <div class="bm-stat-val">${formatDuration(benchmark.avgHold7dSec)} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400;">(Rotator Cepat)</span></div>
        </div>
        <div class="bm-stat-box">
          <div class="bm-stat-label">Saldo Native</div>
          <div class="bm-stat-val">${benchmark.solBalance} <span style="font-size:0.75rem; color:var(--text-muted); font-weight:400;">SOL</span></div>
        </div>
      </div>
    </div>

    <!-- Quick Stats Cards -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="sc-label">Total Smart Wallets Terkumpul</div>
        <div class="sc-val">${wallets.length}</div>
        <div class="sc-sub">Hasil filter algoritmik multi-kategori GMGN</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Super Elite (WR &ge; 90%)</div>
        <div class="sc-val" style="color:var(--accent-green);">${wr90Count}</div>
        <div class="sc-sub">Win rate setara target acuan kita</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Whale Clones (Cuan &gt; $10k)</div>
        <div class="sc-val" style="color:var(--accent-gold);">${bigPnlCount}</div>
        <div class="sc-sub">Profit bersih riil di atas $10,000</div>
      </div>
      <div class="stat-card">
        <div class="sc-label">Micro-Rotators (&le; 15 menit)</div>
        <div class="sc-val" style="color:var(--accent-blue);">${rotatorCount}</div>
        <div class="sc-sub">Rotasi posisi kilat persis bot 3azG</div>
      </div>
    </div>

    <!-- Filter Buttons -->
    <div class="filter-bar">
      <button class="filter-btn active" onclick="applyFilter('all', this)">Semua Wallet (${wallets.length})</button>
      <button class="filter-btn" onclick="applyFilter('wr90', this)">🎯 Super Elite (WR &ge; 90%) (${wr90Count})</button>
      <button class="filter-btn" onclick="applyFilter('rotator', this)">⚡ Micro-Rotators (&le; 15m) (${rotatorCount})</button>
      <button class="filter-btn" onclick="applyFilter('whale', this)">💎 Big Profit (&gt; $10k) (${bigPnlCount})</button>
    </div>

    <!-- Leaderboard Table -->
    <div class="table-wrapper">
      <table id="wallet-table">
        <thead>
          <tr>
            <th>Rank / Match</th>
            <th>Wallet Address</th>
            <th>Archetype / Profil</th>
            <th>Win Rate (7D / 30D)</th>
            <th>Realized PnL (7D / 30D)</th>
            <th>Trades (Buy / Sell)</th>
            <th>Avg Hold</th>
            <th>Saldo SOL</th>
            <th>Tags GMGN</th>
          </tr>
        </thead>
        <tbody>
          ${wallets.map((w, idx) => {
            const isBm = w.isBenchmark;
            const maxWr = Math.max(w.wr7d || 0, w.wr30d || 0);
            const wrBadgeClass = maxWr >= 90 ? 'badge-wr-high' : 'badge-wr-mid';
            const progressColor = maxWr >= 90 ? '' : 'gold';
            const shortAddr = w.address.slice(0, 6) + '...' + w.address.slice(-4);
            const pnl7dFmt = w.pnl7d >= 0 ? `+$${w.pnl7d.toLocaleString()}` : `-$${Math.abs(w.pnl7d).toLocaleString()}`;
            const pnl30dFmt = w.pnl30d >= 0 ? `+$${w.pnl30d.toLocaleString()}` : `-$${Math.abs(w.pnl30d).toLocaleString()}`;
            
            return `
              <tr class="${isBm ? 'is-benchmark' : ''}" 
                  data-wr90="${maxWr >= 89.9}" 
                  data-whale="${(w.pnl7d >= 10000 || w.pnl30d >= 20000)}" 
                  data-rotator="${(w.avgHold7dSec > 0 && w.avgHold7dSec <= 900)}">
                <td>
                  ${isBm ? '⭐ <strong style="color:var(--accent-gold);">BENCHMARK</strong>' : `<strong>#${idx}</strong>`}
                  <span class="badge ${isBm ? 'badge-archetype gold' : ''}" style="margin-left:6px;">${w.similarityScore || 0}%</span>
                </td>
                <td>
                  <div style="display:flex; align-items:center;">
                    <a href="https://gmgn.ai/sol/address/${w.address}" target="_blank" class="mono" style="color:#38bdf8; text-decoration:none; font-weight:600;" title="${w.address}">
                      ${shortAddr}
                    </a>
                    <button class="copy-btn" onclick="navigator.clipboard.writeText('${w.address}'); alert('Address copied!');">📋</button>
                    <a href="https://gmgn.ai/sol/address/${w.address}" target="_blank" style="margin-left:6px; font-size:0.75rem; text-decoration:none;" title="Buka GMGN">↗</a>
                  </div>
                  ${w.name ? `<div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">${w.name}</div>` : ''}
                </td>
                <td>
                  <span class="badge-archetype ${isBm ? 'gold' : ''}">${w.archetype || 'Smart Trader'}</span>
                </td>
                <td>
                  <span class="badge ${wrBadgeClass}">${w.wr7d}%</span>
                  <div class="progress-bar"><div class="progress-fill ${progressColor}" style="width: ${Math.min(w.wr7d, 100)}%;"></div></div>
                  <div style="font-size:0.72rem; color:var(--text-muted); margin-top:3px;">30D: ${w.wr30d}%</div>
                </td>
                <td>
                  <div class="badge-pnl">${pnl7dFmt}</div>
                  <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">30D: ${pnl30dFmt}</div>
                </td>
                <td>
                  <div style="font-weight:600;">${w.txs7d} txs</div>
                  <div style="font-size:0.72rem; color:var(--text-muted); margin-top:2px;">${w.buy7d}B / ${w.sell7d}S</div>
                </td>
                <td>
                  <strong>${formatDuration(w.avgHold7dSec)}</strong>
                </td>
                <td>
                  <span class="mono">${(w.solBalance || 0).toFixed(1)} SOL</span>
                </td>
                <td>
                  ${(w.tags || []).slice(0, 3).map(t => `<span class="tag-pill">${t}</span>`).join('')}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    function applyFilter(filter, el) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');

      const rows = document.querySelectorAll('#wallet-table tbody tr');
      rows.forEach(r => {
        if (r.classList.contains('is-benchmark')) {
          r.style.display = '';
          return;
        }
        if (filter === 'all') {
          r.style.display = '';
        } else if (filter === 'wr90') {
          r.style.display = r.dataset.wr90 === 'true' ? '' : 'none';
        } else if (filter === 'whale') {
          r.style.display = r.dataset.whale === 'true' ? '' : 'none';
        } else if (filter === 'rotator') {
          r.style.display = r.dataset.rotator === 'true' ? '' : 'none';
        }
      });
    }

    async function triggerScan() {
      const btn = document.getElementById('btn-scan');
      btn.disabled = true;
      btn.innerText = '⏳ Sedang Scanning GMGN...';
      try {
        const res = await fetch('/api/scan', { method: 'POST' });
        const d = await res.json();
        if (d.ok) {
          alert('Scan Selesai! Ditemukan ' + d.count + ' Smart Wallets.');
          location.reload();
        } else {
          alert('Scan gagal: ' + (d.error || 'Unknown error'));
        }
      } catch (err) {
        alert('Gagal menghubungi server scan: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerText = '🔄 Scan GMGN Sekarang';
      }
    }
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // API Wallets
  if (pathname.endsWith('/api/wallets')) {
    const store = loadStore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(store));
  }

  // API Scan Trigger
  if (pathname.endsWith('/api/scan') && req.method === 'POST') {
    if (isScanning) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Scan currently in progress' }));
    }
    isScanning = true;
    try {
      const raw = await runScanHighWinrateWallets();
      const saved = processAndSaveWallets(raw);
      isScanning = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, count: saved.totalCurated }));
    } catch (err) {
      isScanning = false;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  // Serve Main Dashboard HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderHtml());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[WINRATE90-DASHBOARD] Berjalan di port ${PORT} (http://127.0.0.1:${PORT})`);
});
