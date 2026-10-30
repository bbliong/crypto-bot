import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

export function renderBacktestDynamic2Html() {
  const detailsPath = join(dataDir, 'backtest-dynamic2-details.json');
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
  const totFees = data.reduce((acc, r) => acc + (r.feesPaid || 0), 0);
  const wins = data.filter(r => r.netPnl > 0).length;
  const losses = data.filter(r => r.netPnl < 0).length;
  const winRate = totTokens > 0 ? ((wins / totTokens) * 100).toFixed(1) : '0';

  // Saldo Awal & Saldo Akhir Berjalan
  const startingCash = 20.0;
  // Newest record is data[0], so its cashAfter is the final ending balance
  const endingCash = data.length > 0 ? data[0].cashAfter : startingCash;
  const netGrowth = endingCash - startingCash;

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tiered Dynamic Copy-Trading Backtest (Pool $20 Dinamis + Potong Fee) | cr.bbliong.io</title>
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
    .container { max-width: 1450px; margin: 0 auto; }
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
      background: linear-gradient(135deg, #f472b6, #c084fc, #38bdf8);
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
    .nav-group {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .nav-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #1e293b;
      color: #cbd5e1;
      padding: 8px 14px;
      border-radius: 8px;
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
      border: 1px solid #334155;
      transition: all 0.2s;
    }
    .nav-btn:hover { background: #334155; color: #fff; }
    .nav-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }

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

    /* Strategy Comparison Banner */
    .compare-banner {
      background: linear-gradient(135deg, rgba(30, 41, 59, 0.8), rgba(15, 23, 42, 0.9));
      border: 1px solid rgba(192, 132, 252, 0.3);
      border-left: 4px solid var(--purple);
      border-radius: 10px;
      padding: 18px 22px;
      margin-bottom: 24px;
    }
    .compare-banner h3 { font-size: 1.05rem; color: #f8fafc; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
    .tier-table {
      width: 100%;
      border-collapse: collapse;
      margin: 12px 0;
      font-size: 0.82rem;
    }
    .tier-table th { background: #1e293b; color: #94a3b8; padding: 6px 12px; border: 1px solid #334155; }
    .tier-table td { padding: 6px 12px; border: 1px solid #334155; color: #e2e8f0; }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-win { background: rgba(16, 185, 129, 0.15); color: var(--emerald); border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-loss { background: rgba(244, 63, 94, 0.15); color: var(--rose); border: 1px solid rgba(244, 63, 94, 0.3); }
    .badge-entry { background: rgba(192, 132, 252, 0.15); color: var(--purple); border: 1px solid rgba(192, 132, 252, 0.3); }

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
    .filter-tabs { display: flex; gap: 8px; }
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
      background: var(--purple);
      color: #fff;
      border-color: var(--purple);
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
    tr.token-row:hover { background: rgba(30, 41, 59, 0.6); }
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
    .token-subname { font-size: 0.75rem; color: #64748b; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }

    /* Nested Details Row */
    tr.detail-row { display: none; background: #090e1a; }
    tr.detail-row.open { display: table-row; }
    .detail-container { padding: 16px 20px; border-left: 3px solid var(--purple); }
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
    .tx-link { color: #a855f7; text-decoration: none; font-size: 0.75rem; }
    .tx-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="header-title">
        <div>
          <h1>🚀 Backtest V2: Tiered Dynamic Copy-Trading</h1>
          <div class="header-subtitle">
            Saldo Awal <strong>$20.00</strong> &bull; Saldo Dinamis Berkembang &bull; Potong Fee Riil <strong>$0.025/swap</strong> &bull; Ukuran Beli <strong>$1-$5</strong>
          </div>
        </div>
      </div>
      <div class="nav-group">
        <a href="/add-fol" class="nav-btn">⚡ Live Dashboard</a>
        <a href="/add-fol/backtest-dynamic" class="nav-btn">📊 Backtest V1 ($5 Cap)</a>
        <a href="/add-fol/backtest-dynamic2" class="nav-btn active">🚀 Backtest V2 ($20 Pool Dinamis)</a>
        <a href="/add-fol/3scenarios" class="nav-btn">📡 Live 3 Skenario</a>
      </div>
    </header>

    <!-- Stats Overview -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Saldo Awal Kas</div>
        <div class="stat-val" style="color:#94a3b8;">$${startingCash.toFixed(2)}</div>
        <div class="stat-sub">Modal Kas Pertama</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Saldo Kas Berjalan Terkini</div>
        <div class="stat-val val-emerald">$${endingCash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        <div class="stat-sub">Cuan Bersih: +$${netGrowth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Fee Swap & Gas</div>
        <div class="stat-val val-rose">-$${totFees.toFixed(2)}</div>
        <div class="stat-sub">Dipenggal $0.025 / transaksi swap</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Win Rate</div>
        <div class="stat-val val-emerald">${winRate}%</div>
        <div class="stat-sub">${wins} Menang &bull; ${losses} Kalah</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Modal Beli Diputar</div>
        <div class="stat-val val-primary">$${totSpent.toFixed(2)}</div>
        <div class="stat-sub">Inc. fee buy $0.025</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Kas Masuk</div>
        <div class="stat-val val-emerald">+$${totRec.toFixed(2)}</div>
        <div class="stat-sub">Net setelah potong fee sell</div>
      </div>
    </div>

    <!-- Strategy Rule Banner -->
    <div class="compare-banner">
      <h3>🎯 Mekanisme Saldo Dinamis & Potongan Fee Riil yang Anda Minta:</h3>
      <ul>
        <li><strong>Saldo Dinamis Berjalan:</strong> Saldo kas dimulai dari <strong>$20.00 USD</strong>. Setiap kali transaksi untung, kas bertambah dan saldo berkembang (compounding). Jika rugi atau terpotong fee, saldo kas berkurang secara alami.</li>
        <li><strong>Potongan Fee Swap Nyata ($0.025 / Transaksi):</strong> Berdasarkan transaksi Solana riil bot kita, gas fee on-chain + compute priority fee rata-rata <code>0.000105 SOL</code> ($0.0105) ditambah tip fee dan DEX AMM fee (~$0.0145), total fee riil ditetapkan <strong>$0.025 USD per swap</strong>. Setiap Buy memotong <code>+$0.025 fee</code> dan setiap Sell memotong <code>-$0.025 fee</code>.</li>
        <li><strong>Kapasitas Pool Dinamis:</strong> Plafon per koin adalah <code>min(Saldo Kas Berjalan, $20.00)</code>. Modal terkunci aman dan tidak akan pernah over-buying!</li>
      </ul>
      <table class="tier-table">
        <thead>
          <tr>
            <th>Pembelian Target (USD)</th>
            <th>Pembelian Target (SOL)</th>
            <th>Ukuran Beli Bot (USD)</th>
            <th>Biaya Fee per Swap</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>$200 – $250+ USD</strong></td>
            <td>&ge; 2.0 – 2.5 SOL</td>
            <td><strong style="color:var(--emerald);">+$5.00 USD</strong></td>
            <td class="mono">-$0.025 USD</td>
          </tr>
          <tr>
            <td><strong>$150 – $200 USD</strong></td>
            <td>1.5 – 2.0 SOL</td>
            <td><strong style="color:var(--cyan);">+$4.00 USD</strong></td>
            <td class="mono">-$0.025 USD</td>
          </tr>
          <tr>
            <td><strong>$100 – $150 USD</strong></td>
            <td>1.0 – 1.5 SOL</td>
            <td><strong style="color:var(--primary);">+$3.00 USD</strong></td>
            <td class="mono">-$0.025 USD</td>
          </tr>
          <tr>
            <td><strong>$50 – $100 USD</strong></td>
            <td>0.5 – 1.0 SOL</td>
            <td><strong style="color:var(--amber);">+$2.00 USD</strong></td>
            <td class="mono">-$0.025 USD</td>
          </tr>
          <tr>
            <td><strong>&lt; $50 USD</strong></td>
            <td>&lt; 0.5 SOL</td>
            <td><strong>+$1.00 USD</strong> (Minimal)</td>
            <td class="mono">-$0.025 USD</td>
          </tr>
        </tbody>
      </table>
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
            <th>Saldo Sebelum</th>
            <th>Modal Beli (+Fee)</th>
            <th>Kas Masuk (-Fee)</th>
            <th>Total Fee</th>
            <th>Net PnL</th>
            <th>Saldo Kas Sesudah</th>
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
                <td class="mono font-semibold" style="color:#94a3b8;">$${r.cashBefore.toFixed(2)}</td>
                <td class="mono font-semibold">$${r.cashSpent.toFixed(2)}</td>
                <td class="mono font-semibold val-emerald">+$${r.cashReceived.toFixed(2)}</td>
                <td class="mono val-rose">-$${r.feesPaid ? r.feesPaid.toFixed(3) : '0.050'}</td>
                <td class="mono font-semibold ${pnlClass}">${pnlSign}$${r.netPnl.toFixed(2)}</td>
                <td class="mono font-semibold" style="color:#38bdf8;">$${r.cashAfter.toFixed(2)}</td>
                <td><span class="badge ${badgeClass}">${badgeText}</span></td>
              </tr>
              <tr class="detail-row" id="detail-${idx}">
                <td colspan="10">
                  <div class="detail-container">
                    <div class="detail-grid">
                      <!-- Buys Log -->
                      <div class="detail-box">
                        <h4>🛒 Rincian Beli (${r.buys.length} Transaksi) &bull; Dipotong Fee $0.025</h4>
                        ${r.buys.map(b => `
                          <div class="log-item">
                            <div>
                              <strong>Buy #${b.buyNum}:</strong> <span class="mono" style="color:#c084fc; font-weight:700;">$${b.stakeUsd.toFixed(2)}</span>
                              <span style="color:#f43f5e; font-size:0.75rem;">(+$${b.feeUsd || 0.025} fee)</span>
                              <span style="color:#64748b;">(Target: ~$${b.targetUsd ? b.targetUsd.toFixed(0) : '150'} &bull; @ $${b.priceUsd < 0.0001 ? b.priceUsd.toFixed(8) : b.priceUsd.toFixed(5)})</span>
                              <div style="font-size:0.75rem; color:#94a3b8;">Dapat: ${b.tokensBought.toLocaleString()} koin &bull; Saldo Kas Sisa: $${b.cashWalletAfter.toFixed(2)}</div>
                            </div>
                            <div style="text-align:right;">
                              ${b.txHash ? `<a href="https://solscan.io/tx/${b.txHash}" target="_blank" class="tx-link">Solscan ↗</a>` : ''}
                            </div>
                          </div>
                        `).join('')}
                      </div>

                      <!-- Sells Log -->
                      <div class="detail-box">
                        <h4>💰 Rincian Jual (${r.sells.length} Transaksi) &bull; Dipotong Fee $0.025</h4>
                        ${r.sells.map(s => `
                          <div class="log-item">
                            <div>
                              <strong>Sell #${s.sellNum} (${s.sellRatioPct}% porsi):</strong>
                              <span class="val-emerald mono font-semibold">+$${s.usdReceived.toFixed(2)}</span>
                              <span style="color:#f43f5e; font-size:0.75rem;">(-$${s.feeUsd || 0.025} fee)</span>
                              <span style="color:#64748b;">(@ $${s.priceUsd < 0.0001 ? s.priceUsd.toFixed(8) : s.priceUsd.toFixed(5)})</span>
                              <div style="font-size:0.75rem; color:#94a3b8;">Terjual: ${s.tokensSold.toLocaleString()} koin &bull; Saldo Kas Bertambah ke: $${s.cashWalletAfter.toFixed(2)}</div>
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
      cr.bbliong.io/add-fol/backtest-dynamic2 &bull; Tiered Dynamic Compounding Copy-Trading Engine
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
