import { getScenarioTokenTimeline, getScenarioTokensList, SCENARIO_META, normalizeScenarioId } from './scenarios-timeline-aggregator.mjs';

export async function renderScenarioTimelineHtml({ scenarioId = 'sce4', tokenQuery = '' } = {}) {
  const scId = normalizeScenarioId(scenarioId);
  const data = await getScenarioTokenTimeline(scId, tokenQuery);
  const meta = data.scenarioMeta || SCENARIO_META[scId];
  const summary = data.summary || {};
  const activeToken = data.token || {};
  const tokensList = data.tokensList || [];
  const steps = data.steps || [];

  const isS4 = scId === 'sce4';
  const otherScId = isS4 ? 'sce6' : 'sce4';
  const otherScName = isS4 ? 'Skenario 6 (Sniper V2)' : 'Skenario 4 (Single Buy)';

  const pnlIsPositive = (summary.realizedPnlUsd || 0) >= 0;
  const pnlColor = pnlIsPositive ? 'var(--emerald)' : 'var(--rose)';
  const pnlSign = pnlIsPositive ? '+' : '';

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Detail Transaksi & Timeline API - ${activeToken.symbol || 'Token'} (${meta.shortName}) | cr.bbliong.io</title>
  <style>
    :root {
      --bg-dark: #090d16;
      --bg-panel: #0f172a;
      --card-bg: #141e33;
      --card-border: #1e293b;
      --card-hover: #1a2744;
      --primary: #818cf8;
      --emerald: #10b981;
      --rose: #f43f5e;
      --amber: #f59e0b;
      --cyan: #06b6d4;
      --purple: #a855f7;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --sc-color: ${meta.color};
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 16px;
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; }

    /* Header */
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
      font-size: 1.5rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
      color: #f8fafc;
    }
    .header-subtitle { color: var(--text-muted); font-size: 0.88rem; margin-top: 4px; }
    .nav-group { display: flex; gap: 8px; flex-wrap: wrap; }
    .nav-btn {
      display: inline-flex; align-items: center; gap: 6px;
      background: #1e293b; color: #cbd5e1; padding: 8px 14px;
      border-radius: 8px; text-decoration: none; font-size: 0.82rem;
      font-weight: 600; border: 1px solid #334155; transition: all 0.2s;
    }
    .nav-btn:hover { background: #334155; color: #fff; }
    .nav-btn.active { background: var(--sc-color); color: #000; font-weight: 700; border-color: var(--sc-color); }

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

    /* Token Selector Bar */
    .token-bar {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px 20px;
      margin-bottom: 24px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .token-bar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
    }
    .token-bar-title {
      font-size: 0.92rem;
      font-weight: 700;
      color: #cbd5e1;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .token-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      max-height: 120px;
      overflow-y: auto;
      padding-right: 4px;
    }
    .token-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #141e33;
      border: 1px solid #1e293b;
      padding: 6px 12px;
      border-radius: 8px;
      text-decoration: none;
      color: #cbd5e1;
      font-size: 0.8rem;
      font-weight: 600;
      transition: all 0.15s;
    }
    .token-chip:hover {
      background: #1e293b;
      border-color: #3b82f6;
      color: #fff;
    }
    .token-chip.active {
      background: rgba(129, 140, 248, 0.2);
      border-color: var(--primary);
      color: #a5b4fc;
      font-weight: 700;
      box-shadow: 0 0 10px rgba(129, 140, 248, 0.25);
    }
    .chip-badge {
      font-size: 0.65rem;
      padding: 1px 5px;
      border-radius: 4px;
      font-weight: 700;
    }
    .badge-profit { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-loss { background: rgba(244, 63, 94, 0.2); color: #fb7185; }
    .badge-sim { background: rgba(148, 163, 184, 0.2); color: #94a3b8; }
    .badge-open { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }

    /* Summary Card */
    .summary-card {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-left: 5px solid var(--sc-color);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 30px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }
    .summary-box {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .summary-label {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .summary-val {
      font-size: 1.15rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .summary-sub {
      font-size: 0.75rem;
      color: #64748b;
    }

    /* Timeline Container */
    .timeline-container {
      position: relative;
      padding: 20px 0 20px 40px;
      margin-bottom: 40px;
    }
    .timeline-container::before {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: 17px;
      width: 4px;
      background: linear-gradient(180deg, var(--sc-color) 0%, #38bdf8 50%, var(--emerald) 100%);
      border-radius: 2px;
    }

    .timeline-item {
      position: relative;
      margin-bottom: 28px;
    }
    .timeline-item:last-child {
      margin-bottom: 0;
    }

    .timeline-node {
      position: absolute;
      left: -40px;
      top: 14px;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--card-bg);
      border: 3px solid var(--sc-color);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.78rem;
      font-weight: 800;
      color: #fff;
      box-shadow: 0 0 12px rgba(0, 0, 0, 0.8);
      z-index: 2;
    }

    .timeline-card {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px 22px;
      transition: all 0.2s;
    }
    .timeline-card:hover {
      border-color: #3b82f6;
      background: var(--card-hover);
    }

    .card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 10px;
    }
    .card-title-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-tag {
      font-size: 0.68rem;
      font-weight: 800;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 6px;
      letter-spacing: 0.05em;
    }
    .card-title {
      font-size: 1.05rem;
      font-weight: 700;
      color: #f8fafc;
    }
    .card-time {
      font-family: ui-monospace, monospace;
      font-size: 0.85rem;
      color: #38bdf8;
      font-weight: 700;
      background: rgba(56, 189, 248, 0.1);
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid rgba(56, 189, 248, 0.25);
    }

    .card-desc {
      font-size: 0.86rem;
      color: #cbd5e1;
      margin-bottom: 14px;
      line-height: 1.45;
    }

    .metrics-pills {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    .metric-pill {
      background: #090d16;
      border: 1px solid #1e293b;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 0.75rem;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .metric-pill-label { color: #94a3b8; }
    .metric-pill-val { font-weight: 700; font-family: ui-monospace, monospace; }

    /* Accordion / Payload Details */
    details.payload-drawer {
      margin-top: 12px;
      background: #090d16;
      border: 1px solid #1e293b;
      border-radius: 8px;
      overflow: hidden;
    }
    details.payload-drawer summary {
      padding: 10px 14px;
      font-size: 0.8rem;
      font-weight: 600;
      color: #94a3b8;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      justify-content: space-between;
      transition: background 0.2s;
    }
    details.payload-drawer summary:hover {
      background: #141e33;
      color: #cbd5e1;
    }
    .payload-content {
      padding: 14px;
      border-top: 1px solid #1e293b;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
    }
    .payload-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .payload-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.72rem;
      text-transform: uppercase;
      font-weight: 700;
      color: #94a3b8;
    }
    .copy-btn {
      background: #1e293b;
      color: #94a3b8;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 0.68rem;
      cursor: pointer;
    }
    .copy-btn:hover { color: #fff; background: #334155; }

    pre.code-json {
      background: #060910;
      border: 1px solid #1e293b;
      border-radius: 6px;
      padding: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.74rem;
      color: #38bdf8;
      max-height: 240px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .empty-state {
      background: var(--bg-panel);
      border: 1px dashed var(--card-border);
      border-radius: 12px;
      padding: 40px 20px;
      text-align: center;
      color: var(--text-muted);
    }

    footer {
      text-align: center;
      font-size: 0.8rem;
      color: #64748b;
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--card-border);
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header class="header">
      <div class="header-title">
        <div>
          <h1>
            <span class="live-dot"></span>
            Detail Transaksi & Timeline API: ${activeToken.symbol || 'Token'}
          </h1>
          <div class="header-subtitle">
            ${meta.name} &bull; ${meta.ruleBadge} &bull; Real-time Correlation GMGN Swap & Submit APIs
          </div>
        </div>
      </div>
      <div class="nav-group">
        <a href="/add-fol" class="nav-btn">⚡ Live Dashboard</a>
        <a href="/add-fol/3scenarios" class="nav-btn">📡 Multi-Skenario</a>
        <a href="/add-fol/3scenarios/sce4?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce4' ? 'active' : ''}">🔍 S4 (Single)</a>
        <a href="/add-fol/3scenarios/sce5?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce5' ? 'active' : ''}">🌊 S5 (Runner)</a>
        <a href="/add-fol/3scenarios/sce6?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce6' ? 'active' : ''}">🚀 S6 (Split TP)</a>
        <a href="/add-fol/3scenarios/sce7?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce7' ? 'active' : ''}">⏱️ S7 (Time-Stop)</a>
        <a href="/add-fol/3scenarios/sce8?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce8' ? 'active' : ''}">⚡ S8 (Front-Run)</a>
        <a href="/add-fol/3scenarios/sce9?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce9' ? 'active' : ''}">🔄 S9 (2-Way Sync)</a>
        <a href="/add-fol/3scenarios/sce9_5?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce9_5' ? 'active' : ''}">🌙 S9.5 (Moonbag)</a>
        <a href="/add-fol/3scenarios/sce10?token=${encodeURIComponent(activeToken.symbol || '')}" class="nav-btn ${scId === 'sce10' ? 'active' : ''}">🌊 S10 (Runner)</a>
      </div>
    </header>

    <!-- Token Selector Bar -->
    <div class="token-bar">
      <div class="token-bar-header">
        <div class="token-bar-title">
          <span>🪙 PILIH KOIN YANG DITRANSAKSIKAN (${tokensList.length} Koin Terdeteksi):</span>
        </div>
        <div style="font-size: 0.78rem; color: #64748b;">
          Diurutkan dari transaksi paling baru (Terbaru: <strong>${tokensList[0]?.symbol || '-'}</strong>)
        </div>
      </div>
      <div class="token-chips">
        ${tokensList.map(t => {
          const isActive = t.symbol.toUpperCase() === (activeToken.symbol || '').toUpperCase();
          const badgeClass = t.status === 'CLOSED' ? (t.realizedPnlUsd >= 0 ? 'badge-profit' : 'badge-loss') : (t.status === 'OPEN' ? 'badge-open' : 'badge-sim');
          return `
            <a href="/add-fol/3scenarios/${scId}?token=${encodeURIComponent(t.symbol)}" class="token-chip ${isActive ? 'active' : ''}">
              <span>${t.symbol}</span>
              <span class="chip-badge ${badgeClass}">${t.status}</span>
              <span style="font-size:0.68rem; color:#64748b;">${t.timeAgoMinutes > 0 ? `${t.timeAgoMinutes}m ago` : 'just now'}</span>
            </a>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Summary KPI Card -->
    <div class="summary-card">
      <div class="summary-box">
        <div class="summary-label">Koin & Token Mint</div>
        <div class="summary-val" style="display:flex; align-items:center; gap:6px;">
          ${summary.symbol || '-'}
          ${summary.solscanMintUrl ? `<a href="${summary.solscanMintUrl}" target="_blank" style="color:#38bdf8; text-decoration:none; font-size:0.8rem;" title="Lihat di Solscan">↗</a>` : ''}
        </div>
        <div class="summary-sub" style="font-family:ui-monospace, monospace; word-break:break-all;">
          ${summary.mint ? `${summary.mint.slice(0, 8)}...${summary.mint.slice(-6)}` : '-'}
        </div>
      </div>

      <div class="summary-box">
        <div class="summary-label">Status Posisi</div>
        <div class="summary-val" style="color: ${summary.status === 'CLOSED' ? 'var(--emerald)' : (summary.status === 'OPEN' ? 'var(--amber)' : '#94a3b8')};">
          ${summary.status || 'UNKNOWN'}
        </div>
        <div class="summary-sub">${meta.shortName}</div>
      </div>

      <div class="summary-box">
        <div class="summary-label">Modal Masuk (Basis)</div>
        <div class="summary-val">$${(summary.investedUsd || 0).toFixed(2)}</div>
        <div class="summary-sub">Entry Time: ${summary.openedAtWib ? summary.openedAtWib.slice(11, 19) : '-'}</div>
      </div>

      <div class="summary-box">
        <div class="summary-label">Realized PnL / ROI</div>
        <div class="summary-val" style="color:${pnlColor};">
          ${pnlSign}$${(summary.realizedPnlUsd || 0).toFixed(2)}
        </div>
        <div class="summary-sub" style="color:${pnlColor}; font-weight:700;">
          ${pnlSign}${(summary.roiPct || 0).toFixed(1)}% ROI
        </div>
      </div>

      <div class="summary-box">
        <div class="summary-label">Kondisi Exit Rule</div>
        <div class="summary-val" style="font-size:0.95rem; color:#cbd5e1;">
          ${summary.exitReason || '-'}
        </div>
        <div class="summary-sub">Exit Time: ${summary.closedAtWib ? summary.closedAtWib.slice(11, 19) : '-'}</div>
      </div>
    </div>

    <!-- Section Title -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
      <h3 style="font-size: 1.15rem; font-weight: 700; color: #f8fafc; display: flex; align-items: center; gap: 8px;">
        <span>⏱️ Rangkaian Kronologis Transaksi & API GMGN</span>
        <span style="font-size: 0.75rem; color: #94a3b8; font-weight: 400;">(${steps.length} Langkah Terverifikasi)</span>
      </h3>
      <div style="font-size: 0.8rem; color: #94a3b8;">
        Auto-Refresh setiap 5s (Pause otomatis saat membaca JSON)
      </div>
    </div>

    <!-- Timeline Steps -->
    ${steps.length === 0 ? `
      <div class="empty-state">
        <h4>Tidak ada log transaksi timeline untuk koin "${activeToken.symbol}".</h4>
        <p style="margin-top: 8px;">Silakan pilih koin lain pada daftar di atas atau tunggu trigger target wallet berikutnya.</p>
      </div>
    ` : `
      <div class="timeline-container">
        ${steps.map(s => {
          const badgeBg = s.badgeColor ? `${s.badgeColor}25` : 'rgba(255,255,255,0.1)';
          const badgeText = s.badgeColor || '#cbd5e1';
          return `
            <div class="timeline-item">
              <div class="timeline-node" style="border-color: ${s.badgeColor || 'var(--sc-color)'};">
                ${s.stepNumber}
              </div>
              <div class="timeline-card">
                <div class="card-top">
                  <div class="card-title-group">
                    <span class="card-tag" style="background:${badgeBg}; color:${badgeText}; border: 1px solid ${badgeText}40;">
                      ${s.category || 'EVENT'}
                    </span>
                    <span class="card-title">${s.title}</span>
                  </div>
                  <div class="card-time">
                    🕒 ${s.timeShort} WIB
                  </div>
                </div>

                <div class="card-desc">
                  ${s.description}
                </div>

                <!-- Key Metrics Pills -->
                ${s.metrics && s.metrics.length > 0 ? `
                  <div class="metrics-pills">
                    ${s.metrics.map(m => `
                      <div class="metric-pill">
                        <span class="metric-pill-label">${m.label}:</span>
                        ${m.link 
                          ? `<a href="${m.link}" target="_blank" class="metric-pill-val" style="color:${m.color || '#38bdf8'}; text-decoration:none;">${m.val} ↗</a>` 
                          : `<span class="metric-pill-val" style="color:${m.color || '#f1f5f9'};">${m.val}</span>`
                        }
                      </div>
                    `).join('')}
                  </div>
                ` : ''}

                <!-- Payload Accordion -->
                ${s.request || s.response ? `
                  <details class="payload-drawer">
                    <summary>
                      <span>📦 Lihat Request & Response API Asli (JSON)</span>
                      <span style="font-size:0.7rem;">KLIK UNTUK MEMBUKA ▾</span>
                    </summary>
                    <div class="payload-content">
                      ${s.request ? `
                        <div class="payload-block">
                          <div class="payload-header">
                            <span>Request Payload</span>
                            <button class="copy-btn" onclick="copyJson(this, 'req_${s.id}')">Copy JSON</button>
                          </div>
                          <pre class="code-json" id="req_${s.id}">${escapeHtml(JSON.stringify(s.request, null, 2))}</pre>
                        </div>
                      ` : ''}

                      ${s.response ? `
                        <div class="payload-block">
                          <div class="payload-header">
                            <span>Response Body</span>
                            <button class="copy-btn" onclick="copyJson(this, 'res_${s.id}')">Copy JSON</button>
                          </div>
                          <pre class="code-json" id="res_${s.id}">${escapeHtml(JSON.stringify(s.response, null, 2))}</pre>
                        </div>
                      ` : ''}
                    </div>
                  </details>
                ` : ''}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `}

    <footer>
      cr.bbliong.io/add-fol/3scenarios/${scId} &bull; Real-time API Timeline Inspector &bull; ${meta.name}
    </footer>
  </div>

  <script>
    function copyJson(btn, elId) {
      const el = document.getElementById(elId);
      if (!el) return;
      navigator.clipboard.writeText(el.innerText).then(() => {
        const orig = btn.innerText;
        btn.innerText = 'Copied! ✓';
        setTimeout(() => btn.innerText = orig, 1500);
      });
    }

    // Auto-refresh setiap 5s jika tidak ada accordion yang sedang terbuka
    setInterval(() => {
      const openDrawers = document.querySelectorAll('details.payload-drawer[open]');
      if (openDrawers.length === 0) {
        window.location.reload();
      }
    }, 5000);
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
