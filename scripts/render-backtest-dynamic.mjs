import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

export function renderBacktestDynamicHtml() {
  const detailsPath = join(dataDir, 'backtest-dynamic-details.json');
  let data = [];
  if (existsSync(detailsPath)) {
    try {
      data = JSON.parse(readFileSync(detailsPath, 'utf8'));
    } catch {}
  }

  const totTokens = data.length;
  const totSpent = data.reduce((acc, r) => acc + r.cashSpent, 0);
  const totRec = data.reduce((acc, r) => acc + r.cashReceived, 0);
  const totBurned = data.reduce((acc, r) => acc + r.burnedUsd, 0);
  const wins = data.filter(r => r.netPnl > 0).length;
  const losses = data.filter(r => r.netPnl < 0).length;
  const winRate = totTokens > 0 ? ((wins / totTokens) * 100).toFixed(1) : '0';

  // Capped net profit (anti-outlier max +500% ROI)
  const cappedNetPnl = data.reduce((acc, r) => {
    const cappedRoi = Math.min(500, Math.max(-100, r.roiPct));
    return acc + r.cashSpent * (cappedRoi / 100);
  }, 0);
  const avgProfitPerToken = totTokens > 0 ? (cappedNetPnl / totTokens).toFixed(2) : '0';

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dynamic Proportional Copy-Trading Backtest (Min $1 - Max $5) | cr.bbliong.io</title>
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
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg-dark);
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px 16px;
      line-height: 1.5;
    }
    .container { max-width: 1400px; margin: 0 auto; }
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
      background: linear-gradient(135deg, #a5b4fc, #38bdf8);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .header-subtitle {
      color: #94a3b8;
      font-size: 0.9rem;
      margin-top: 4px;
    }
    .nav-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #1e293b;
      color: #cbd5e1;
      padding: 8px 16px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 0.85rem;
      font-weight: 600;
      border: 1px solid #334155;
      transition: all 0.2s;
    }
    .nav-btn:hover { background: #334155; color: #fff; }

    /* Summary Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
      position: relative;
      overflow: hidden;
    }
    .stat-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 4px; }
    .stat-val { font-size: 1.5rem; font-weight: 700; }
    .stat-sub { font-size: 0.75rem; color: #64748b; margin-top: 4px; }
    .val-emerald { color: var(--emerald); }
    .val-rose { color: var(--rose); }
    .val-primary { color: var(--primary); }
    .val-amber { color: var(--amber); }

    /* Explanation Accordion / Banner */
    .info-panel {
      background: rgba(15, 23, 42, 0.7);
      border: 1px solid #1e293b;
      border-left: 4px solid var(--primary);
      border-radius: 10px;
      padding: 16px 20px;
      margin-bottom: 24px;
    }
    .info-panel h3 { font-size: 1rem; color: #e2e8f0; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
    .info-panel p, .info-panel li { font-size: 0.85rem; color: #94a3b8; margin-bottom: 6px; }
    .info-panel ul { padding-left: 20px; margin-bottom: 8px; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-win { background: rgba(16, 185, 129, 0.15); color: var(--emerald); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-loss { background: rgba(244, 63, 94, 0.15); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.3); }
    .badge-entry { background: rgba(129, 140, 248, 0.15); color: var(--primary); border: 1px solid rgba(129, 140, 248, 0.3); }

    /* Table Toolbar */
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
      width: 280px;
    }
    .filter-tabs {
      display: flex;
      gap: 8px;
    }
    .tab-btn {
      background: #1e293b;
      border: 1px solid #334155;
      color: #94a3b8;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .tab-btn.active {
      background: var(--primary);
      color: #fff;
      border-color: var(--primary);
    }

    /* Table Styles */
    .table-wrap {
      background: var(--bg-panel);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.85rem;
    }
    th {
      background: #0d1527;
      color: #94a3b8;
      font-weight: 600;
      padding: 12px 14px;
      border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid rgba(30, 41, 59, 0.5);
      color: #e2e8f0;
      vertical-align: middle;
    }
    tr.token-row {
      cursor: pointer;
      transition: background 0.15s;
    }
    tr.token-row:hover {
      background: rgba(30, 41, 59, 0.6);
    }
    .expand-btn {
      background: #1e293b;
      color: #94a3b8;
      border: 1px solid #334155;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 0.8rem;
      margin-right: 6px;
    }
    .token-subname {
      font-size: 0.75rem;
      color: #64748b;
    }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

    /* Nested Details Row */
    tr.detail-row {
      display: none;
      background: #090e1a;
    }
    tr.detail-row.open {
      display: table-row;
    }
    .detail-container {
      padding: 16px 20px;
      border-left: 3px solid var(--primary);
    }
    .detail-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 16px;
    }
    .detail-box {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 12px;
    }
    .detail-box h4 {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
      color: #94a3b8;
      border-bottom: 1px solid #1e293b;
      padding-bottom: 4px;
    }
    .log-item {
      display: flex;
      justify-content: space-between;
      font-size: 0.8rem;
      padding: 4px 0;
      border-bottom: 1px dashed rgba(30, 41, 59, 0.4);
    }
    .log-item:last-child { border-bottom: none; }
    .tx-link {
      color: var(--primary);
      text-decoration: none;
      font-size: 0.75rem;
    }
    .tx-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="header-title">
        <div>
          <h1>📊 Backtest Engine: Dynamic Proportional Copy-Trading</h1>
          <div class="header-subtitle">
            Audit On-Chain Lengkap: Min Entry <strong>$1.00</strong> &bull; Plafon Max Exposure <strong>$5.00</strong> &bull; Entry Wajib <strong>Ground Zero</strong> &bull; Jual Proporsional
          </div>
        </div>
      </div>
      <div>
        <a href="/add-fol" class="nav-btn">⬅️ Kembali ke Dashboard Live</a>
      </div>
    </header>

    <!-- Stats Overview -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-val val-emerald">${winRate}%</div>
        <div class="stat-sub">${wins} Menang &bull; ${losses} Kalah</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Net Profit (Capped +500%)</div>
        <div class="stat-val val-emerald">+$${cappedNetPnl.toFixed(2)}</div>
        <div class="stat-sub">ROI Bersih: +${((cappedNetPnl/totSpent)*100).toFixed(1)}%</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Rata-Rata Profit / Koin</div>
        <div class="stat-val val-emerald">+$${avgProfitPerToken}</div>
        <div class="stat-sub">Dari 85 token First Buy</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Modal Diputar</div>
        <div class="stat-val val-primary">$${totSpent.toFixed(2)}</div>
        <div class="stat-sub">Rata-rata $${(totSpent/totTokens).toFixed(2)} / koin</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Kas Ditarik</div>
        <div class="stat-val val-emerald">+$${totRec.toFixed(2)}</div>
        <div class="stat-sub">Hasil cair ke kas SOL</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Sisa Koin Terbakar (Burn)</div>
        <div class="stat-val val-rose">-$${totBurned.toFixed(2)}</div>
        <div class="stat-sub">Hanya ${(totBurned/totSpent*100).toFixed(2)}% dari modal</div>
      </div>
    </div>

    <!-- Methodology Explanation -->
    <div class="info-panel">
      <h3>🔍 Metodologi & Penjelasan Rumus Matematis:</h3>
      <ul>
        <li><strong>Dari Mana Angka Berasal?</strong> Seluruh data diambil dari transaksi on-chain Solana aktual pada dompet target (<code>3azG8rmt...</code>). Setiap transaksi buy dan sell dicek harga eksekusi riilnya melalui quote AMM / on-chain pre & post balance.</li>
        <li><strong>Aturan Ground Zero:</strong> Hanya koin di mana target memulai beli dari saldo 0 (atau First Buy resmi GMGN) yang diizinkan masuk. Koin yang sudah berjalan (mid-flight) 100% ditolak.</li>
        <li><strong>Kenapa Frekuensi Beli Berbeda-beda?</strong> 
          Target scalper sering kali masuk bertahap (mencicil). Jika target beli lagi sebelum menjual, bot ikut menambah posisi <em>selama modal aktif belum menyentuh plafon $5.00</em>. 
          Koin dengan frekuensi 1x artinya target langsung pompa dan keluar tanpa menambah muatan. Koin dengan frekuensi 2x–5x artinya target melakukan akumulasi bertahap.
        </li>
        <li><strong>Formula Ukuran Beli ($1 s/d $5):</strong> Setiap kali target membeli, ukuran beli bot mengikuti ukuran target (rasio $1.00 per 1 SOL target), dengan batas minimum $1.00 dan batas plafon $5.00.</li>
        <li><strong>Kapan Sell Dieksekusi?</strong> Setiap kali target menjual X% dari saldonya, bot seketika menjual X% dari koinnya secara proporsional. Saat target Full Exit (>=85% atau saldo sisa 0), bot langsung Full Exit 100%.</li>
      </ul>
      <p style="color: #cbd5e1; font-weight: 500;">
        💡 <em>Klik pada baris koin di bawah untuk membuka rincian lengkap tiap-tiap transaksi Beli (Buy #1, Buy #2, dst.) dan Jual (Sell #1, Sell #2, dst.) beserta tautan Solscan!</em>
      </p>
    </div>

    <!-- Table Toolbar -->
    <div class="table-toolbar">
      <input type="text" id="tokenSearch" class="search-input" placeholder="🔍 Cari nama token atau mint..." onkeyup="filterTokens()">
      <div class="filter-tabs">
        <button class="tab-btn active" onclick="setFilter('all')">Semua (${totTokens})</button>
        <button class="tab-btn" onclick="setFilter('win')">Menang (${wins})</button>
        <button class="tab-btn" onclick="setFilter('loss')">Kalah (${losses})</button>
        <button class="tab-btn" onclick="setFilter('multi')">Multi-Buy</button>
      </div>
    </div>

    <!-- Backtest Table -->
    <div class="table-wrap">
      <table id="backtestTable">
        <thead>
          <tr>
            <th>Token</th>
            <th>Waktu Entry (WIB)</th>
            <th>Frekuensi</th>
            <th>Modal Diputar</th>
            <th>Kas Masuk</th>
            <th>Sisa Burn</th>
            <th>Net PnL</th>
            <th>ROI</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${data.map((r, idx) => {
            const isWin = r.netPnl >= 0;
            const pnlSign = isWin ? '+' : '';
            const pnlClass = isWin ? 'val-emerald' : 'val-rose';
            const badgeClass = isWin ? 'badge-win' : 'badge-loss';
            const badgeText = isWin ? 'WIN' : 'LOSS';
            return `
              <tr class="token-row" onclick="toggleDetails(${idx})" data-symbol="${r.symbol.toLowerCase()}" data-mint="${r.mint.toLowerCase()}" data-win="${isWin}" data-multibuy="${r.buysCount > 1}">
                <td>
                  <span class="expand-btn" id="btn-${idx}">+</span>
                  <strong>${r.symbol}</strong>
                  <div class="token-subname mono">${r.mint.slice(0, 6)}...${r.mint.slice(-4)}</div>
                </td>
                <td style="font-size: 0.8rem; color: #94a3b8;">${r.timeWib}</td>
                <td>
                  <span class="badge badge-entry">${r.buysCount}x Buy</span>
                  <span class="badge" style="background:#1e293b; color:#cbd5e1;">${r.sellsCount}x Sell</span>
                </td>
                <td class="mono font-semibold">$${r.cashSpent.toFixed(2)}</td>
                <td class="mono font-semibold val-emerald">+$${r.cashReceived.toFixed(2)}</td>
                <td class="mono ${r.burnedUsd > 0 ? 'val-rose' : 'text-slate-500'}">$${r.burnedUsd.toFixed(2)}</td>
                <td class="mono font-semibold ${pnlClass}">${pnlSign}$${r.netPnl.toFixed(2)}</td>
                <td class="mono font-semibold ${pnlClass}">${pnlSign}${r.roiPct.toFixed(1)}%</td>
                <td><span class="badge ${badgeClass}">${badgeText}</span></td>
              </tr>
              <tr class="detail-row" id="detail-${idx}">
                <td colspan="9">
                  <div class="detail-container">
                    <div class="detail-grid">
                      <!-- Buys Log -->
                      <div class="detail-box">
                        <h4>🛒 Rincian Beli (${r.buys.length} Transaksi)</h4>
                        ${r.buys.map(b => `
                          <div class="log-item">
                            <div>
                              <strong>Buy #${b.buyNum}:</strong> <span class="mono">$${b.stakeUsd.toFixed(2)}</span>
                              <span style="color:#64748b;">(@ $${b.priceUsd < 0.0001 ? b.priceUsd.toFixed(8) : b.priceUsd.toFixed(5)})</span>
                              <div style="font-size:0.75rem; color:#94a3b8;">Dapat: ${b.tokensBought.toLocaleString()} koin &bull; Plafon Sisa: $${b.remCapAfter.toFixed(2)}</div>
                            </div>
                            <div style="text-align:right;">
                              ${b.txHash ? `<a href="https://solscan.io/tx/${b.txHash}" target="_blank" class="tx-link">Solscan ↗</a>` : ''}
                            </div>
                          </div>
                        `).join('')}
                      </div>

                      <!-- Sells Log -->
                      <div class="detail-box">
                        <h4>💰 Rincian Jual (${r.sells.length} Transaksi)</h4>
                        ${r.sells.map(s => `
                          <div class="log-item">
                            <div>
                              <strong>Sell #${s.sellNum} (${s.sellRatioPct}% porsi):</strong>
                              <span class="val-emerald mono font-semibold">+$${s.usdReceived.toFixed(2)}</span>
                              <span style="color:#64748b;">(@ $${s.priceUsd < 0.0001 ? s.priceUsd.toFixed(8) : s.priceUsd.toFixed(5)})</span>
                              <div style="font-size:0.75rem; color:#94a3b8;">Terjual: ${s.tokensSold.toLocaleString()} koin &bull; ${s.isFullExit ? '<span style="color:#f59e0b;">Full Exit</span>' : 'Parsial'}</div>
                            </div>
                            <div style="text-align:right;">
                              ${s.txHash ? `<a href="https://solscan.io/tx/${s.txHash}" target="_blank" class="tx-link">Solscan ↗</a>` : ''}
                            </div>
                          </div>
                        `).join('')}
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>

    <footer style="margin-top: 32px; text-align: center; font-size: 0.8rem; color: #64748b;">
      cr.bbliong.io/add-fol/backtest-dynamic &bull; Verified On-Chain Solana Backtest Engine &bull; Dedicated Follower
    </footer>
  </div>

  <script>
    let currentFilter = 'all';

    function toggleDetails(idx) {
      const row = document.getElementById('detail-' + idx);
      const btn = document.getElementById('btn-' + idx);
      if (row.classList.contains('open')) {
        row.classList.remove('open');
        btn.innerText = '+';
      } else {
        row.classList.add('open');
        btn.innerText = '−';
      }
    }

    function setFilter(type) {
      currentFilter = type;
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      event.target.classList.add('active');
      filterTokens();
    }

    function filterTokens() {
      const q = document.getElementById('tokenSearch').value.toLowerCase().trim();
      const rows = document.querySelectorAll('.token-row');
      rows.forEach(r => {
        const sym = r.getAttribute('data-symbol');
        const mint = r.getAttribute('data-mint');
        const isWin = r.getAttribute('data-win') === 'true';
        const isMulti = r.getAttribute('data-multibuy') === 'true';

        let matchesSearch = !q || sym.includes(q) || mint.includes(q);
        let matchesFilter = true;
        if (currentFilter === 'win') matchesFilter = isWin;
        if (currentFilter === 'loss') matchesFilter = !isWin;
        if (currentFilter === 'multi') matchesFilter = isMulti;

        if (matchesSearch && matchesFilter) {
          r.style.display = '';
        } else {
          r.style.display = 'none';
          // Also hide detail row if open
          const nextRow = r.nextElementSibling;
          if (nextRow && nextRow.classList.contains('detail-row')) {
            nextRow.classList.remove('open');
          }
        }
      });
    }
  </script>
</body>
</html>`;
}
