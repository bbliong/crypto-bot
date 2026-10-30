import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

export function render3ScenariosLiveHtml() {
  const liveFile = join(dataDir, 'dryrun-3scenarios-live.json');
  let data = { s1: null, s2: null, s3: null };
  if (existsSync(liveFile)) {
    try {
      data = JSON.parse(readFileSync(liveFile, 'utf8'));
    } catch {}
  }

  const s1 = data.s1 || { name: 'Skenario 1 (Statis $2, Pool $20)', availableCash: 20.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s2 = data.s2 || { name: 'Skenario 2 (Dynamic V1 $1-$5, Pool $20)', availableCash: 20.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };
  const s3 = data.s3 || { name: 'Skenario 3 (Dynamic V2 $1-$5 Bertingkat, Pool $20)', availableCash: 20.0, investedCash: 0, realizedPnl: 0, wins: 0, losses: 0, totalTrades: 0, openPositions: [], closedTrades: [], recentEvents: [] };

  function renderScenarioCard(s, color) {
    const isPnlPositive = s.realizedPnl >= 0;
    const pnlSign = isPnlPositive ? '+' : '';
    const pnlClass = isPnlPositive ? 'val-emerald' : 'val-rose';
    const winRate = s.totalTrades > 0 ? ((s.wins / s.totalTrades) * 100).toFixed(1) : '0';

    return `
      <div class="scenario-panel" style="border-top: 4px solid ${color};">
        <div class="panel-header">
          <div class="panel-title">${s.name}</div>
          <div class="panel-desc">${s.description || ''}</div>
        </div>

        <div class="stat-mini-grid">
          <div class="mini-stat">
            <div class="mini-label">Kas Tersedia (Pool $20)</div>
            <div class="mini-val" style="color:${color};">$${s.availableCash.toFixed(2)}</div>
            <div class="mini-sub">Tertahan: $${s.investedCash.toFixed(2)}</div>
          </div>
          <div class="mini-stat">
            <div class="mini-label">Realized PnL</div>
            <div class="mini-val ${pnlClass}">${pnlSign}$${s.realizedPnl.toFixed(2)}</div>
            <div class="mini-sub">${s.wins}W / ${s.losses}L (${winRate}%)</div>
          </div>
          <div class="mini-stat">
            <div class="mini-label">Total Portfolio</div>
            <div class="mini-val">$${s.totalPortfolioValue ? s.totalPortfolioValue.toFixed(2) : (s.availableCash + s.investedCash).toFixed(2)}</div>
            <div class="mini-sub">Modal Awal $20.00</div>
          </div>
        </div>

        <!-- Open Positions -->
        <div class="sub-section">
          <h5>🟡 Posisi Sedang Berjalan (${s.openPositions.length})</h5>
          ${s.openPositions.length === 0 ? '<div class="empty-hint">Tidak ada posisi terbuka (Kas bebas)</div>' : `
            <table class="pos-table">
              <thead><tr><th>Token</th><th>Entry</th><th>Basis $</th><th>Koin</th><th>Floating PnL</th></tr></thead>
              <tbody>
                ${s.openPositions.map(p => {
                  const pPnl = p.unrealizedPnlUsd >= 0 ? '+' : '';
                  const cClass = p.unrealizedPnlUsd >= 0 ? 'val-emerald' : 'val-rose';
                  return `
                    <tr>
                      <td><strong>${p.symbol}</strong></td>
                      <td>${p.entryCount}x Buy</td>
                      <td class="mono">$${p.costBasisUsd.toFixed(2)}</td>
                      <td class="mono">${p.tokens.toLocaleString()}</td>
                      <td class="mono ${cClass}">${pPnl}$${p.unrealizedPnlUsd.toFixed(2)}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          `}
        </div>

        <!-- Recent Logs -->
        <div class="sub-section">
          <h5>📜 5 Aktivitas Terakhir</h5>
          ${s.recentEvents.slice(0, 5).map(ev => {
            const actColor = ev.action === 'BUY' ? 'var(--emerald)' : (ev.action === 'SELL' ? 'var(--cyan)' : '#94a3b8');
            return `
              <div class="event-row">
                <span style="color:${actColor}; font-weight:700;">${ev.action} ${ev.symbol}</span>
                <span class="mono" style="font-size:0.75rem; color:#cbd5e1;">
                  ${ev.stakeUsd ? `$${ev.stakeUsd.toFixed(2)}` : (ev.usdReceived ? `+$${ev.usdReceived.toFixed(2)}` : '')}
                </span>
                <span style="font-size:0.7rem; color:#64748b;">${ev.timeWib ? ev.timeWib.slice(11, 19) : ''}</span>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Dry-Run 3 Skenario Simultan (Pool $20) | cr.bbliong.io</title>
  <style>
    :root {
      --bg-dark: #090d16;
      --bg-panel: #0f172a;
      --card-bg: #141e33;
      --card-border: #1e293b;
      --primary: #818cf8;
      --emerald: #10b981;
      --rose: #f43f5e;
      --amber: #f59e0b;
      --cyan: #06b6d4;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 16px;
      line-height: 1.5;
    }
    .container { max-width: 1500px; margin: 0 auto; }
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--card-border);
    }
    .header-title h1 {
      font-size: 1.6rem;
      font-weight: 700;
      background: linear-gradient(135deg, #a5b4fc, #38bdf8, #f472b6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-subtitle { color: #94a3b8; font-size: 0.9rem; margin-top: 4px; }
    .nav-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .nav-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: #1e293b; color: #cbd5e1; padding: 8px 14px;
      border-radius: 8px; text-decoration: none; font-size: 0.82rem;
      font-weight: 600; border: 1px solid #334155; transition: all 0.2s;
    }
    .nav-btn:hover { background: #334155; color: #fff; }
    .nav-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }

    .live-badge {
      display: inline-flex; align-items: center; gap: 6px;
      background: rgba(16, 185, 129, 0.15); color: var(--emerald);
      border: 1px solid rgba(16, 185, 129, 0.4);
      padding: 4px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 700;
    }
    .live-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--emerald);
      box-shadow: 0 0 8px var(--emerald); animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* 3 Scenarios Grid */
    .scenarios-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }
    .scenario-panel {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .panel-header { border-bottom: 1px solid #1e293b; padding-bottom: 10px; }
    .panel-title { font-size: 1.1rem; font-weight: 700; color: #f8fafc; }
    .panel-desc { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }

    .stat-mini-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
    }
    .mini-stat {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 10px;
    }
    .mini-label { font-size: 0.7rem; color: #94a3b8; text-transform: uppercase; }
    .mini-val { font-size: 1.2rem; font-weight: 700; margin-top: 2px; }
    .mini-sub { font-size: 0.7rem; color: #64748b; margin-top: 2px; }

    .val-emerald { color: var(--emerald); }
    .val-rose { color: var(--rose); }
    .mono { font-family: ui-monospace, monospace; }

    .sub-section h5 { font-size: 0.82rem; color: #cbd5e1; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    .empty-hint { font-size: 0.8rem; color: #64748b; font-style: italic; padding: 6px 0; }

    .pos-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .pos-table th { background: #1e293b; color: #94a3b8; padding: 4px 8px; text-align: left; }
    .pos-table td { padding: 6px 8px; border-bottom: 1px solid rgba(30, 41, 59, 0.5); }

    .event-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 6px 0; border-bottom: 1px dashed rgba(30, 41, 59, 0.4); font-size: 0.8rem;
    }
    .event-row:last-child { border-bottom: none; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="header-title">
        <div>
          <h1>
            <span class="live-dot"></span>
            Live 3-Way Dry-Run Comparison Radar
          </h1>
          <div class="header-subtitle">
            Simulasi Aktif Real-Time 3 Skenario Sekaligus &bull; Modal Pool <strong>$20.00</strong> Masing-Masing &bull; Wajib <strong>First Buy Ground Zero</strong>
          </div>
        </div>
      </div>
      <div class="nav-group">
        <a href="/add-fol" class="nav-btn">⚡ Live Dashboard</a>
        <a href="/add-fol/backtest-dynamic" class="nav-btn">📊 Backtest V1 ($5 Cap)</a>
        <a href="/add-fol/backtest-dynamic2" class="nav-btn">🚀 Backtest V2 ($20 Pool)</a>
        <a href="/add-fol/3scenarios" class="nav-btn active">📡 Live 3 Skenario</a>
      </div>
    </header>

    <div class="scenarios-grid">
      ${renderScenarioCard(s1, 'var(--primary)')}
      ${renderScenarioCard(s2, 'var(--cyan)')}
      ${renderScenarioCard(s3, 'var(--purple)')}
    </div>

    <footer style="text-align: center; font-size: 0.8rem; color: #64748b; margin-top: 24px;">
      cr.bbliong.io/add-fol/3scenarios &bull; Real-time 3-Way Parallel Dry-Run Engine &bull; Auto-Refresh setiap 5s
    </footer>
  </div>

  <script>
    setTimeout(() => { window.location.reload(); }, 5000);
  </script>
</body>
</html>`;
}
