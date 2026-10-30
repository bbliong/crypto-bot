import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

export function renderDnaScannerHtml() {
  const storeFile = join(dataDir, 'dna-clone-wallets.json');
  let wallets = [];
  if (existsSync(storeFile)) {
    try {
      wallets = JSON.parse(readFileSync(storeFile, 'utf8'));
    } catch {}
  }

  const totWallets = wallets.length;
  const multiHit = wallets.filter(w => w.hitCount >= 2);
  const totalCuan = wallets.reduce((acc, w) => acc + (w.totalRealizedProfitUsd || 0), 0);
  const avgHold = wallets.length
    ? Math.round(wallets.reduce((acc, w) => acc + (w.avgHoldSec || 0), 0) / wallets.length)
    : 0;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DNA Clone Hunter Radar (Wallets with 3azG8rmt... Pattern) | cr.bbliong.io</title>
  <style>
    :root {
      --bg-dark: #070a13;
      --bg-panel: #0d1322;
      --card-bg: #131b2e;
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
    .container { max-width: 1550px; margin: 0 auto; }
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
      background: linear-gradient(135deg, #f59e0b, #ec4899, #38bdf8);
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
    .nav-btn.active { background: var(--amber); color: #090d16; font-weight: 700; border-color: var(--amber); }

    .live-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--amber);
      box-shadow: 0 0 10px var(--amber); animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
    }
    .stat-label { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; letter-spacing: 0.05em; }
    .stat-val { font-size: 1.5rem; font-weight: 700; margin-top: 2px; }
    .stat-sub { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
    .val-amber { color: var(--amber); }
    .val-emerald { color: var(--emerald); }
    .val-cyan { color: var(--cyan); }
    .mono { font-family: ui-monospace, monospace; }

    .info-banner {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.08), rgba(15, 23, 42, 0.6));
      border: 1px solid rgba(245, 158, 11, 0.3);
      border-left: 4px solid var(--amber);
      border-radius: 10px;
      padding: 18px 22px;
      margin-bottom: 24px;
      font-size: 0.88rem;
    }
    .info-banner h3 { color: var(--amber); margin-bottom: 8px; font-size: 1.05rem; }

    .table-toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .search-input {
      background: #0f172a;
      border: 1px solid #334155;
      color: #f1f5f9;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 0.85rem;
      width: 340px;
    }
    .filter-btn {
      background: #1e293b; color: #94a3b8; border: 1px solid #334155;
      padding: 6px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer;
    }
    .filter-btn.active { background: var(--amber); color: #090d16; font-weight: 700; border-color: var(--amber); }

    .table-wrap {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow-x: auto;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.84rem; }
    th {
      background: #0d1527; color: #94a3b8; font-weight: 600;
      padding: 12px 14px; border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
    }
    td {
      padding: 10px 14px; border-bottom: 1px solid rgba(30, 41, 59, 0.5);
      color: #e2e8f0; vertical-align: top;
    }
    tr.wallet-row:hover { background: rgba(30, 41, 59, 0.5); cursor: pointer; }

    .badge-hit {
      display: inline-block; padding: 2px 8px; border-radius: 12px;
      font-size: 0.72rem; font-weight: 700;
    }
    .badge-gold { background: rgba(245, 158, 11, 0.2); color: var(--amber); border: 1px solid var(--amber); }
    .badge-single { background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3); }
    .badge-serial { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid #10b981; }

    .token-chip-container {
      display: flex; flex-direction: column; gap: 6px; max-height: 120px; overflow-y: auto;
    }
    .token-chip {
      background: #070a13; border: 1px solid #1e293b; border-radius: 6px;
      padding: 4px 8px; font-size: 0.75rem; display: flex; justify-content: space-between; gap: 8px;
    }
    .tx-link { color: #818cf8; text-decoration: none; font-size: 0.75rem; }
    .tx-link:hover { text-decoration: underline; }
    .copy-btn {
      background: transparent; border: none; color: #94a3b8; cursor: pointer; font-size: 0.75rem;
    }
    .copy-btn:hover { color: #fff; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="header-title">
        <div>
          <h1>
            <span class="live-dot"></span>
            🧬 DNA Clone Hunter Radar
          </h1>
          <div class="header-subtitle">
            Pelacak Dompet Bot Kloningan Target <strong>3azG8rmt...</strong> &bull; Saring Otomatis dari Token Baru (Pump.fun & Swaps 1h)
          </div>
        </div>
      </div>
      <div class="nav-group">
        <a href="/add-fol" class="nav-btn">⚡ Live Follower</a>
        <a href="/add-fol/3scenarios" class="nav-btn">📡 Live 4 Skenario</a>
        <a href="/add-fol/backtest-dynamic2" class="nav-btn">🚀 Backtest V2</a>
        <a href="/add-fol/liquidity-audit" class="nav-btn">🛡️ Audit Likuiditas</a>
        <a href="/clone-radar" class="nav-btn active">🧬 Clone Hunter Radar</a>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Dompet Kloningan</div>
        <div class="stat-val val-amber">${totWallets} Dompet</div>
        <div class="stat-sub">Sesuai DNA Target 3azG...</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Konsistensi Tinggi (Multi-Hit)</div>
        <div class="stat-val val-emerald">${multiHit.length} Dompet</div>
        <div class="stat-sub">Menang di &ge; 2 Koin Berbeda</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Realized Cuan Scalping</div>
        <div class="stat-val val-emerald">+$${totalCuan.toLocaleString('en-US', {maximumFractionDigits: 0})} USD</div>
        <div class="stat-sub">Akumulasi laba bersih seluruh koin</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Rata-rata Waktu Hold</div>
        <div class="stat-val val-cyan">${avgHold}s (${(avgHold / 60).toFixed(1)}m)</div>
        <div class="stat-sub">Ultra-fast momentum scalping</div>
      </div>
    </div>

    <div class="info-banner">
      <h3>🎯 Pola DNA Spesifik Target 3azG8rmt... yang Sedang Disaring Otomatis:</h3>
      <p>
        1. <strong>Ukuran Beli:</strong> $80 – $450 USD (~1 – 4.5 SOL) per entry.<br>
        2. <strong>Kecepatan Hold:</strong> 4 detik hingga 360 detik (keluar cepat begitu momentum pump selesai).<br>
        3. <strong>Gaya Jual:</strong> Menjual bertahap (sell count &ge; 1–2x) dengan cuan nyata (&ge; +$15 USD).<br>
        4. <strong>Fokus 1 Token (Strict Serial Execution):</strong> Tidak pernah spray banyak token sekaligus. Menahan 1 koin sampai tuntas (exit 0), baru membuka posisi di koin baru.<br>
        5. <strong>Bukan Airdrop Dev:</strong> Bebas transfer-in dan bukan pencipta koin (non-dev). Dompet memiliki saldo aktif &ge; 0.3 SOL.
      </p>
    </div>

    <div class="table-toolbar">
      <input type="text" id="walletSearch" class="search-input" placeholder="🔍 Cari alamat wallet atau nama token..." onkeyup="filterWallets()">
      <div style="display:flex; gap:8px;">
        <button class="filter-btn active" onclick="setFilter('all')">Semua (${totWallets})</button>
        <button class="filter-btn" onclick="setFilter('multi')">👑 Multi-Hit (${multiHit.length})</button>
        <button class="filter-btn" onclick="setFilter('serial')">🎯 Strict Serial Only</button>
      </div>
    </div>

    <div class="table-wrap">
      <table id="cloneTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Alamat Wallet</th>
            <th>Konsistensi</th>
            <th>Skor Conviction</th>
            <th>Total Cuan Scalp ($)</th>
            <th>Rata-rata Hold</th>
            <th>Rata-rata Stake</th>
            <th>Saldo Kas SOL</th>
            <th>Token yang Dimasuki &amp; Hasil Trade</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${wallets.map((w, idx) => {
            const isMulti = w.hitCount >= 2;
            const isSerial = w.isStrictSerial !== false;
            const badgeClass = isMulti ? 'badge-gold' : 'badge-single';
            const badgeText = isMulti ? `👑 ${w.hitCount}x HIT` : `1x Hit`;
            const serialBadge = isSerial ? `<span class="badge-hit badge-serial" title="Strict Serial: Hanya pegang 1 koin dalam 1 waktu">🎯 SERIAL</span>` : `<span class="badge-hit" style="background:#334155;color:#94a3b8;">MULTI</span>`;
            return `
              <tr class="wallet-row" data-multi="${isMulti}" data-serial="${isSerial}" data-addr="${w.address.toLowerCase()}" data-tokens="${w.tokensTraded.map(t => t.symbol.toLowerCase()).join(' ')}">
                <td class="mono" style="color:#64748b;">${idx + 1}</td>
                <td>
                  <strong>${w.address.slice(0, 6)}...${w.address.slice(-4)}</strong>
                  <button class="copy-btn" onclick="navigator.clipboard.writeText('${w.address}'); alert('Address copied!');" title="Salin Address">📋</button>
                  <div class="mono" style="font-size:0.75rem; color:#64748b;">${w.address}</div>
                </td>
                <td>
                  <span class="badge-hit ${badgeClass}">${badgeText}</span>
                  <div style="margin-top:4px;">${serialBadge}</div>
                </td>
                <td class="mono font-semibold" style="color:var(--amber);">${w.score}/100</td>
                <td class="mono font-semibold val-emerald">+$${w.totalRealizedProfitUsd.toLocaleString()}</td>
                <td class="mono val-cyan">${w.avgHoldSec}s</td>
                <td class="mono">$${w.avgStakeUsd}</td>
                <td class="mono font-semibold">${w.solBalance.toFixed(2)} SOL</td>
                <td>
                  <div class="token-chip-container">
                    ${w.tokensTraded.map(t => `
                      <div class="token-chip">
                        <span><strong>${t.symbol}</strong> ($${t.stakeUsd} stake &bull; hold ${t.holdSec}s)</span>
                        <span class="val-emerald font-semibold">+${t.roiPct}% (+$${t.profitUsd})</span>
                      </div>
                    `).join('')}
                  </div>
                </td>
                <td>
                  <a href="https://gmgn.ai/sol/address/${w.address}" target="_blank" class="tx-link">GMGN ↗</a><br>
                  <a href="https://solscan.io/account/${w.address}" target="_blank" class="tx-link">Solscan ↗</a>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>

    <footer style="margin-top: 32px; text-align: center; font-size: 0.8rem; color: #64748b;">
      cr.bbliong.io/clone-radar &bull; DNA Smart Wallet Scanner &bull; Auto-Refresh setiap 5s
    </footer>
  </div>

  <script>
    let currentFilter = 'all';

    function setFilter(type) {
      currentFilter = type;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      filterWallets();
    }

    function filterWallets() {
      const q = document.getElementById('walletSearch').value.toLowerCase().trim();
      const rows = document.querySelectorAll('.wallet-row');
      rows.forEach(r => {
        const addr = r.getAttribute('data-addr');
        const toks = r.getAttribute('data-tokens');
        const isMulti = r.getAttribute('data-multi') === 'true';

        let matchSearch = !q || addr.includes(q) || toks.includes(q);
        let matchFilter = true;
        if (currentFilter === 'multi') matchFilter = isMulti;
        if (currentFilter === 'serial') matchFilter = (r.getAttribute('data-serial') === 'true');

        if (matchSearch && matchFilter) {
          r.style.display = '';
        } else {
          r.style.display = 'none';
        }
      });
    }

    setTimeout(() => { window.location.reload(); }, 5000);
  </script>
</body>
</html>`;
}
