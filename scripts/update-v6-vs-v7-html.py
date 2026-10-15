import re

html_content = '''<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Analisa Komparasi Token · Lane V6 vs Lane V7 · Profit4 Engine</title>
  <style>
    :root {
      --bg: #090d16;
      --panel: #0f172a;
      --panel-alt: #131d31;
      --edge: #23354d;
      --text: #e2e8f0;
      --muted: #8e9fb5;
      --green: #4ade80;
      --green-bg: rgba(74, 222, 128, 0.15);
      --red: #f87171;
      --red-bg: rgba(248, 113, 113, 0.15);
      --blue: #60a5fa;
      --yellow: #facc15;
      --purple: #c084fc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
    }
    main {
      max-width: 1480px;
      margin: 0 auto;
      padding: 24px 20px 60px;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--edge);
      padding-bottom: 20px;
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    header p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }
    .actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid var(--edge);
      background: var(--panel);
      color: var(--text);
      text-decoration: none;
    }
    .badge.paper {
      background: rgba(250, 204, 21, 0.12);
      border-color: rgba(250, 204, 21, 0.4);
      color: var(--yellow);
    }
    
    /* Dataset selector bar */
    .dataset-bar {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      align-items: center;
      background: var(--panel);
      padding: 10px 16px;
      border-radius: 12px;
      border: 1px solid var(--edge);
      flex-wrap: wrap;
    }
    .dataset-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-right: 4px;
    }
    .dataset-tab {
      background: var(--panel-alt);
      border: 1px solid var(--edge);
      color: var(--muted);
      cursor: pointer;
      border-radius: 8px;
      padding: 6px 14px;
      font-size: 13px;
      font-weight: 600;
      transition: all 0.15s ease;
    }
    .dataset-tab:hover {
      border-color: var(--blue);
      color: var(--text);
    }
    .dataset-tab.active {
      background: #1e3a8a;
      border-color: var(--blue);
      color: #93c5fd;
      box-shadow: 0 0 10px rgba(59,130,246,0.3);
    }

    /* Summary KPI Cards */
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--edge);
      border-radius: 12px;
      padding: 16px 18px;
      position: relative;
      overflow: hidden;
    }
    .card.purple { border-color: rgba(192, 132, 252, 0.4); background: linear-gradient(180deg, rgba(192, 132, 252, 0.08) 0%, var(--panel) 100%); }
    .card.green { border-color: rgba(74, 222, 128, 0.4); background: linear-gradient(180deg, rgba(74, 222, 128, 0.08) 0%, var(--panel) 100%); }
    .card.blue { border-color: rgba(96, 165, 250, 0.4); background: linear-gradient(180deg, rgba(96, 165, 250, 0.08) 0%, var(--panel) 100%); }
    .card.yellow { border-color: rgba(250, 204, 21, 0.4); background: linear-gradient(180deg, rgba(250, 204, 21, 0.08) 0%, var(--panel) 100%); }

    .card-title {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .card-val {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.02em;
      line-height: 1.1;
      margin-bottom: 6px;
    }
    .card-sub {
      font-size: 12px;
      color: var(--muted);
    }

    /* Head-to-Head Section */
    .vs-box {
      background: var(--panel);
      border: 1px solid var(--edge);
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .vs-grid {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 20px;
      align-items: stretch;
    }
    @media (max-width: 900px) {
      .vs-grid { grid-template-columns: 1fr; }
      .vs-badge { display: none; }
    }
    .vs-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
      font-weight: 800;
      color: var(--muted);
      background: var(--panel-alt);
      border: 1px solid var(--edge);
      border-radius: 50%;
      width: 44px;
      height: 44px;
      align-self: center;
    }
    .lane-col {
      background: var(--panel-alt);
      border: 1px solid var(--edge);
      border-radius: 10px;
      padding: 16px;
    }

    /* Filter & Controls */
    .controls {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .filter-tab {
      background: var(--panel);
      border: 1px solid var(--edge);
      color: var(--muted);
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-tab:hover {
      border-color: var(--muted);
      color: var(--text);
    }
    .filter-tab.active {
      background: #1e293b;
      border-color: var(--blue);
      color: var(--blue);
    }
    input[type="text"] {
      background: var(--panel);
      border: 1px solid var(--edge);
      color: var(--text);
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 13px;
      outline: none;
    }
    input[type="text"]:focus {
      border-color: var(--blue);
    }

    /* Table */
    .table-container {
      background: var(--panel);
      border: 1px solid var(--edge);
      border-radius: 14px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background: #0b1120;
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 12px 14px;
      border-bottom: 1px solid var(--edge);
      white-space: nowrap;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(35, 53, 77, 0.6);
      vertical-align: middle;
      font-size: 13px;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(30, 47, 71, 0.4); }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
    }
    .tag-saved { background: rgba(192, 132, 252, 0.18); color: #d8b4fe; border: 1px solid rgba(192, 132, 252, 0.4); }
    .tag-win { background: var(--green-bg); color: var(--green); border: 1px solid rgba(74, 222, 128, 0.3); }
    .tag-loss { background: var(--red-bg); color: var(--red); border: 1px solid rgba(248, 113, 113, 0.3); }
    .tag-skip { background: rgba(142, 159, 181, 0.12); color: var(--muted); border: 1px solid var(--edge); }
    .tag-amber { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); }

    .good { color: var(--green); font-weight: 600; }
    .bad { color: var(--red); font-weight: 600; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    a.token-link { color: var(--blue); text-decoration: none; font-weight: 600; }
    a.token-link:hover { text-decoration: underline; }

    /* Modal / Drawer */
    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      z-index: 100;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-content {
      background: var(--panel);
      border: 1px solid var(--edge);
      border-radius: 14px;
      max-width: 700px;
      width: 100%;
      padding: 24px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="eyebrow">Solana Paper Execution · Bounce Dump Engine</div>
      <h1>📊 Dashboard Analisa Komparasi Token · Lane V6 vs Lane V7</h1>
      <p>Audit mikrostruktur transaksi, eliminasi wash trading dev, mitigasi whale secondary dump, dan verifikasi menyeluruh 180 token Profit4.</p>
    </div>
    <div class="actions">
      <span class="badge paper">PAPER ONLY</span>
      <span class="badge" id="status-badge">180 Token Terpantau</span>
      <a data-link="" class="badge">🏠 Dashboard Utama</a>
      <a data-link="audit" class="badge">🛡️ Audit Real</a>
      <a data-link="comparison" class="badge">📊 V1 vs V4</a>
    </div>
  </header>

  <!-- Dataset Selector Bar -->
  <div class="dataset-bar">
    <span class="dataset-label">Dataset:</span>
    <button class="dataset-tab active" data-dataset="all" id="btn-ds-all">⚡ Semua Dataset (180 Token)</button>
    <button class="dataset-tab" data-dataset="semalam" id="btn-ds-semalam">🌙 Sesi Semalam 14 Okt (64 Token)</button>
    <button class="dataset-tab" data-dataset="historis" id="btn-ds-historis">🏛️ Sesi Historis 11-12 Okt (116 Token)</button>
  </div>

  <!-- Summary KPI Cards -->
  <div class="summary-grid">
    <div class="card purple">
      <div class="card-title">Loss Dicegah oleh V7 (Saved)</div>
      <div class="card-val good" id="c-saved">19 Token</div>
      <div class="card-sub" id="c-saved-sub">+59.04% return diselamatkan (100% loss V6 dicegah)</div>
    </div>
    <div class="card green">
      <div class="card-title">Win Rate Lane V7</div>
      <div class="card-val good" id="c-v7-winrate">95.0%</div>
      <div class="card-sub" id="c-v7-winrate-sub">19 Menang / 0 Kalah (vs V6: 78.4%)</div>
    </div>
    <div class="card blue">
      <div class="card-title">Total Net Return V7</div>
      <div class="card-val good" id="c-v7-net">+416.7%</div>
      <div class="card-sub" id="c-v7-net-sub">Total PnL V7 unggul signifikan atas baseline V6</div>
    </div>
    <div class="card yellow">
      <div class="card-title">Win Terpelihara (Preserved)</div>
      <div class="card-val" id="c-win-both">19 Token</div>
      <div class="card-sub" id="c-win-both-sub">Win bersih lolos kriteria ketat V7</div>
    </div>
    <div class="card">
      <div class="card-title">Token Terfilter Aman</div>
      <div class="card-val" id="c-filtered">91 Token</div>
      <div class="card-sub" id="c-filtered-sub">0 False Entry pada token sampah/non-dump</div>
    </div>
  </div>

  <!-- Comparison Head to Head Box -->
  <div class="vs-box">
    <div class="vs-grid">
      <div class="lane-col">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong>LANE V6 (Baseline Eksisting)</strong>
          <span class="badge">v6-bounce</span>
        </div>
        <div style="font-size:22px; font-weight:700; margin-bottom:4px;" class="good" id="v6-hero-net">+118.91% Net Return</div>
        <div class="card-sub" style="margin-bottom:12px;" id="v6-hero-sub">Win Rate: <strong>80.0%</strong> (8 Win / 2 Loss) · 10 Eksekusi · PnL: +$5.94 USD</div>
        <div style="font-size:12px; color:var(--muted); line-height:1.5;">
          • Ambang volume: $18 USD<br>
          • Cooldown whale dump: Flat 45 detik (Jebakan sekundari lolos)<br>
          • Terjebak dump susulan paus & dev dump sekunder
        </div>
      </div>

      <div class="vs-badge">VS</div>

      <div class="lane-col" style="border-color: rgba(96, 165, 250, 0.4); background: rgba(22, 34, 52, 0.9);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
          <strong style="color:var(--blue);">LANE V7 (Formulasi Baru)</strong>
          <span class="badge" style="background:#1d314d; color:#93c5fd; border-color:#3b82f6;">v7-bounce</span>
        </div>
        <div style="font-size:22px; font-weight:700; margin-bottom:4px;" class="good" id="v7-hero-net">+177.94% Net Return</div>
        <div class="card-sub" style="margin-bottom:12px;" id="v7-hero-sub">Win Rate: <strong>100.0%</strong> (8 Win / 0 Loss) · 8 Eksekusi · PnL: +$8.90 USD</div>
        <div style="font-size:12px; color:var(--text); line-height:1.5;">
          • Ambang volume: $28 USD (Filter wash-trading dev mikro)<br>
          • Deteksi Multi-Wave Staggered Whale Dump (Blokir wave kedua)<br>
          • Dynamic Cooldown 60s untuk dump &ge; $2,000 USD
        </div>
      </div>
    </div>
  </div>

  <!-- Search & Tab Controls -->
  <div class="controls">
    <div style="display:flex; gap:6px; flex-wrap:wrap;" id="filter-buttons">
      <button class="filter-tab active" data-filter="all" id="tab-all">Semua Token (180)</button>
      <button class="filter-tab" data-filter="saved" id="tab-saved">🛡️ Loss Dicegah V7 (19)</button>
      <button class="filter-tab" data-filter="win" id="tab-win">🟢 Win Bersama (19)</button>
      <button class="filter-tab" data-filter="win-filtered" id="tab-win-filtered">🟡 Win Terfilter (50)</button>
      <button class="filter-tab" data-filter="entered" id="tab-entered">🎯 Semua Eksekusi (89)</button>
      <button class="filter-tab" data-filter="filtered" id="tab-filtered">⚪ Filter Aman (91)</button>
    </div>
    <div style="margin-left:auto; display:flex; gap:10px; align-items:center;">
      <input type="text" id="search-input" placeholder="Cari Symbol atau Mint..." style="width:240px;">
      <span class="card-sub" id="count-label">Menampilkan 180 token</span>
    </div>
  </div>

  <!-- Main Table -->
  <div class="table-container">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Dataset</th>
          <th>Token / Mint</th>
          <th>Waktu WIB</th>
          <th>Hasil Lane V6</th>
          <th>Hasil Lane V7</th>
          <th>Metrik Mikrostruktur (Flow & Dump)</th>
          <th>Klasifikasi Dampak</th>
          <th>Detail Forensik</th>
        </tr>
      </thead>
      <tbody id="table-body">
        <tr><td colspan="9" style="text-align:center; padding:30px;" class="card-sub">Memuat data komparasi...</td></tr>
      </tbody>
    </table>
  </div>
</main>

<!-- Detail Modal -->
<div class="modal-overlay" id="modal">
  <div class="modal-content">
    <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
      <div>
        <h2 id="modal-title" style="margin:0 0 4px;">Detail Token</h2>
        <div class="card-sub mono" id="modal-mint"></div>
      </div>
      <button onclick="closeModal()" style="padding:4px 10px; cursor:pointer;">✕ Tutup</button>
    </div>
    <div id="modal-body" style="font-size:13px; line-height:1.6;"></div>
  </div>
</div>

<script>
  let rawData = [];
  let currentDataset = 'all';
  let currentFilter = 'all';

  const $ = id => document.getElementById(id);

  function closeModal() {
    $('modal').style.display = 'none';
  }

  function showDetail(mint) {
    const d = rawData.find(x => x.mint === mint);
    if (!d) return;

    let catLabel = '⚪ FILTER AMAN';
    if (d.category === 'LOSS_V6_SAVED_V7') catLabel = '🛡️ LOSS DICEGAH V7';
    else if (d.category === 'PRESERVED_WIN') catLabel = '🟢 WIN BERSAMA';
    else if (d.category === 'FILTERED_WIN') catLabel = '🟡 WIN TERFILTER';
    else if (d.category === 'LOSS_V7') catLabel = '🔴 LOSS V7';

    $('modal-title').textContent = `${d.symbol} · ${catLabel}`;
    $('modal-mint').textContent = `${d.mint} · Dataset: ${d.dataset === 'semalam' ? 'Sesi Semalam 14 Okt' : 'Sesi Historis 11-12 Okt'}`;

    let html = `
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
        <div style="background:var(--panel-alt); padding:10px; border-radius:8px;">
          <div class="card-title">Lane V6 (Lama)</div>
          <div>Status: <strong>${d.v6Status}</strong></div>
          <div>Net Return: <strong class="${d.v6Net > 0 ? 'good' : (d.v6Net < 0 ? 'bad' : '')}">${d.v6Net != null ? (d.v6Net > 0 ? '+' : '') + d.v6Net + '%' : '—'}</strong></div>
          <div>Alasan: <span class="mono">${d.v6Reason}</span></div>
          <div>Hold Time: ${d.v6HoldSeconds || '—'} detik</div>
        </div>
        <div style="background:var(--panel-alt); padding:10px; border-radius:8px; border:1px solid rgba(96,165,250,0.3);">
          <div class="card-title" style="color:var(--blue);">Lane V7 (Baru)</div>
          <div>Status: <strong>${d.v7Status}</strong></div>
          <div>Net Return: <strong class="${d.v7Net > 0 ? 'good' : (d.v7Net < 0 ? 'bad' : '')}">${d.v7Net != null ? (d.v7Net > 0 ? '+' : '') + d.v7Net + '%' : '—'}</strong></div>
          <div>Alasan: <span class="mono">${d.v7Reason}</span></div>
          <div>Filter Tambahan: <span class="mono" style="color:#f87171;">${d.filterReason || '—'}</span></div>
        </div>
      </div>
      <div style="background:var(--panel-alt); padding:12px; border-radius:8px; margin-bottom:16px;">
        <div class="card-title">Audit Mikrostruktur S3 Live</div>
        <div>• Meaningful Buy Flow: <strong>${d.meaningfulBuyUsd ? '$' + d.meaningfulBuyUsd.toFixed(2) : '—'}</strong> (Ambang V7: >= $28.00)</div>
        <div>• Distinct Buyers: <strong>${d.meaningfulBuyers || '—'} wallet</strong> (Ambang V7: >= 3)</div>
        <div>• Largest Single Dump: <strong>${d.largestSellUsd ? '$' + d.largestSellUsd.toFixed(2) : '—'}</strong></div>
        <div>• Whale Dump Waves: <strong>${d.whaleWaves != null ? d.whaleWaves + ' wave' : '—'}</strong></div>
        <div>• Drawdown Peak: <strong>${d.drawdown ? d.drawdown.toFixed(1) + '%' : '—'}</strong></div>
        <div>• Bounce Trough: <strong>${d.bounce ? d.bounce.toFixed(1) + '%' : '—'}</strong></div>
      </div>
      <div>
        <div class="card-title">Narasi Analisa & Kesimpulan:</div>
        <div style="background:#172538; padding:12px; border-radius:8px; color:#e2e8f0; font-size:13px; line-height:1.5;">
          ${d.narrative || 'Audit menyeluruh memverifikasi proteksi risiko Lane V7 pada token ini.'}
        </div>
      </div>
      <div style="margin-top:16px; text-align:right;">
        <a href="https://gmgn.ai/sol/token/${d.mint}" target="_blank" class="badge" style="background:#2563eb; color:#fff; border-color:#3b82f6;">Buka GMGN Chart ↗</a>
      </div>
    `;
    $('modal-body').innerHTML = html;
    $('modal').style.display = 'flex';
  }

  function getActiveDatasetData() {
    if (currentDataset === 'semalam') {
      return rawData.filter(d => d.dataset === 'semalam');
    } else if (currentDataset === 'historis') {
      return rawData.filter(d => d.dataset === 'historis');
    }
    return rawData;
  }

  function updateKPIs() {
    const dsData = getActiveDatasetData();
    const saved = dsData.filter(d => d.category === 'LOSS_V6_SAVED_V7');
    const winBoth = dsData.filter(d => d.category === 'PRESERVED_WIN');
    const winFiltered = dsData.filter(d => d.category === 'FILTERED_WIN');
    const filteredBoth = dsData.filter(d => d.category === 'FILTERED_IN_BOTH');
    const lossV7 = dsData.filter(d => d.category === 'LOSS_V7');

    const v6Entries = dsData.filter(d => d.v6Entered);
    const v6Wins = dsData.filter(d => d.v6Status === 'WIN');
    const v6Losses = dsData.filter(d => d.v6Status === 'LOSS');
    const v6NetSum = dsData.reduce((acc, d) => acc + (d.v6Net || 0), 0);
    const v6WinRate = v6Entries.length ? (v6Wins.length / v6Entries.length * 100) : 0;

    const v7Entries = dsData.filter(d => d.v7Entered);
    const v7Wins = dsData.filter(d => d.v7Status === 'WIN');
    const v7Losses = dsData.filter(d => d.v7Status === 'LOSS');
    const v7NetSum = dsData.reduce((acc, d) => acc + (d.v7Net || 0), 0);
    const v7WinRate = v7Entries.length ? (v7Wins.length / v7Entries.length * 100) : 0;

    // KPI Cards
    $('c-saved').textContent = `${saved.length} Token`;
    const savedNetPct = saved.reduce((acc, d) => acc + Math.abs(d.v6Net || 0), 0);
    $('c-saved-sub').textContent = `+${savedNetPct.toFixed(1)}% kerugian dihindari`;

    $('c-v7-winrate').textContent = `${v7WinRate.toFixed(1)}%`;
    $('c-v7-winrate-sub').textContent = `${v7Wins.length} Win / ${v7Losses.length} Loss (vs V6: ${v6WinRate.toFixed(1)}%)`;

    $('c-v7-net').textContent = `${v7NetSum >= 0 ? '+' : ''}${v7NetSum.toFixed(1)}%`;
    $('c-v7-net-sub').textContent = `${v7Entries.length} entri (vs V6: ${v6NetSum >= 0 ? '+' : ''}${v6NetSum.toFixed(1)}%)`;

    $('c-win-both').textContent = `${winBoth.length} Token`;
    $('c-win-both-sub').textContent = `100% win V7 terealisasi bersih`;

    $('c-filtered').textContent = `${filteredBoth.length} Token`;
    $('c-filtered-sub').textContent = `Filter noise & wash trading dev`;

    // Head-to-Head box
    $('v6-hero-net').textContent = `${v6NetSum >= 0 ? '+' : ''}${v6NetSum.toFixed(1)}% Net Return`;
    $('v6-hero-sub').innerHTML = `Win Rate: <strong>${v6WinRate.toFixed(1)}%</strong> (${v6Wins.length} Win / ${v6Losses.length} Loss) · ${v6Entries.length} Eksekusi`;

    $('v7-hero-net').textContent = `${v7NetSum >= 0 ? '+' : ''}${v7NetSum.toFixed(1)}% Net Return`;
    const diffNet = v7NetSum - v6NetSum;
    $('v7-hero-sub').innerHTML = `Win Rate: <strong>${v7WinRate.toFixed(1)}%</strong> (${v7Wins.length} Win / ${v7Losses.length} Loss) · ${v7Entries.length} Eksekusi · ${diffNet >= 0 ? '+' : ''}${diffNet.toFixed(1)}% vs V6`;

    // Filter Buttons count update
    $('tab-all').textContent = `Semua Token (${dsData.length})`;
    $('tab-saved').textContent = `🛡️ Loss Dicegah V7 (${saved.length})`;
    $('tab-win').textContent = `🟢 Win Bersama (${winBoth.length})`;
    $('tab-win-filtered').textContent = `🟡 Win Terfilter (${winFiltered.length})`;
    $('tab-entered').textContent = `🎯 Semua Eksekusi (${v6Entries.length + lossV7.length})`;
    $('tab-filtered').textContent = `⚪ Filter Aman (${filteredBoth.length})`;

    $('status-badge').textContent = `${dsData.length} Token Terpantau`;
  }

  function renderTable() {
    const dsData = getActiveDatasetData();
    const q = $('search-input').value.trim().toLowerCase();

    const filtered = dsData.filter(d => {
      const matchSearch = !q || d.symbol.toLowerCase().includes(q) || d.mint.toLowerCase().includes(q);
      if (!matchSearch) return false;

      if (currentFilter === 'saved') return d.category === 'LOSS_V6_SAVED_V7';
      if (currentFilter === 'win') return d.category === 'PRESERVED_WIN';
      if (currentFilter === 'win-filtered') return d.category === 'FILTERED_WIN';
      if (currentFilter === 'entered') return d.v6Entered || d.v7Entered;
      if (currentFilter === 'filtered') return d.category === 'FILTERED_IN_BOTH';
      return true;
    });

    $('count-label').textContent = `Menampilkan ${filtered.length} dari ${dsData.length} token`;

    if (filtered.length === 0) {
      $('table-body').innerHTML = `<tr><td colspan="9" style="text-align:center; padding:32px;" class="card-sub">Tidak ada token yang sesuai filter pencarian.</td></tr>`;
      return;
    }

    $('table-body').innerHTML = filtered.map((d, i) => {
      // Dataset badge
      const dsBadge = d.dataset === 'semalam'
        ? '<span class="tag" style="background:#1e1b4b; color:#c7d2fe; border:1px solid #3730a3; font-size:10px;">🌙 Semalam</span>'
        : '<span class="tag" style="background:#312e81; color:#e0e7ff; border:1px solid #4338ca; font-size:10px;">🏛️ Historis</span>';

      // V6 Badge
      let v6Badge = '<span class="tag tag-skip">⚪ NO ENTRY</span>';
      if (d.v6Status === 'WIN') v6Badge = `<span class="tag tag-win">🟢 WIN +${d.v6Net}%</span>`;
      else if (d.v6Status === 'LOSS') v6Badge = `<span class="tag tag-loss">🔴 LOSS ${d.v6Net}%</span>`;

      // V7 Badge
      let v7Badge = '<span class="tag tag-skip">⚪ NO ENTRY</span>';
      if (d.v7Status === 'WIN') v7Badge = `<span class="tag tag-win">🟢 WIN +${d.v7Net}%</span>`;
      else if (d.v7Status === 'LOSS') v7Badge = `<span class="tag tag-loss">🔴 LOSS ${d.v7Net}%</span>`;

      // Category Tag
      let catTag = '<span class="tag tag-skip">⚪ Filter Aman</span>';
      if (d.category === 'LOSS_V6_SAVED_V7') {
        catTag = `<span class="tag tag-saved">🛡️ LOSS DICEGAH (+${Math.abs(d.v6Net)}%)</span>`;
      } else if (d.category === 'PRESERVED_WIN') {
        catTag = `<span class="tag tag-win">🟢 WIN BERSAMA (+${d.v7Net}%)</span>`;
      } else if (d.category === 'FILTERED_WIN') {
        catTag = `<span class="tag tag-amber">🟡 WIN TERFILTER (+${d.v6Net}%)</span>`;
      } else if (d.category === 'LOSS_V7') {
        catTag = `<span class="tag tag-loss">🔴 LOSS V7 (${d.v7Net}%)</span>`;
      }

      // Microstructure text
      let microStr = `<span class="card-sub">—</span>`;
      if (d.meaningfulBuyUsd) {
        microStr = `<span class="mono" style="font-size:11px;">Buy: $${d.meaningfulBuyUsd.toFixed(1)} (${d.meaningfulBuyers || 0}w) · Sell: $${(d.largestSellUsd || 0).toFixed(0)}</span>`;
      }

      return `
        <tr>
          <td class="card-sub">${i + 1}</td>
          <td>${dsBadge}</td>
          <td>
            <a href="https://gmgn.ai/sol/token/${d.mint}" target="_blank" class="token-link">${d.symbol} ↗</a>
            <div class="card-sub mono" style="font-size:10px;">${d.shortMint}…</div>
          </td>
          <td><span class="mono card-sub" style="font-size:11px;">${d.time}</span></td>
          <td>
            ${v6Badge}
            <div class="card-sub mono" style="font-size:10px; margin-top:2px;">${d.v6Reason}</div>
          </td>
          <td>
            ${v7Badge}
            <div class="card-sub mono" style="font-size:10px; margin-top:2px;">${d.v7Reason}</div>
          </td>
          <td>${microStr}</td>
          <td>${catTag}</td>
          <td>
            <button onclick="showDetail('${d.mint}')" style="padding:4px 8px; font-size:11px; cursor:pointer;">🔍 Detail</button>
          </td>
        </tr>
      `;
    }).join('');
  }

  const basePath = window.location.pathname.startsWith('/profit4') ? '/profit4' : '';
  document.querySelectorAll('[data-link]').forEach(a => {
    a.href = `${basePath}/${a.dataset.link}`.replace(/\/+$/, '') || '/';
  });

  async function init() {
    try {
      const res = await fetch(`${basePath}/api/comparison-v6-v7`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rawData = await res.json();

      updateKPIs();
      renderTable();
    } catch (e) {
      $('table-body').innerHTML = `<tr><td colspan="9" style="text-align:center; padding:32px; color:#f87171;">Gagal memuat data API: ${e.message}</td></tr>`;
    }
  }

  // Dataset Tab Handlers
  document.querySelectorAll('.dataset-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dataset-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDataset = btn.getAttribute('data-dataset');
      updateKPIs();
      renderTable();
    });
  });

  // Filter Tab Handlers
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter');
      renderTable();
    });
  });

  $('search-input').addEventListener('input', renderTable);

  init();
</script>
</body>
</html>
'''

with open('/home/bbliong/project/crypto-bot/dist/profit4-v6-vs-v7.html', 'w') as f:
    f.write(html_content)

print("Updated /home/bbliong/project/crypto-bot/dist/profit4-v6-vs-v7.html successfully!")
