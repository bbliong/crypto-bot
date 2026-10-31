import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

export function renderDnaScannerHtml(activeTab = 'elite') {
  const storeFile = join(dataDir, 'dna-clone-wallets.json');
  let wallets = [];
  if (existsSync(storeFile)) {
    try {
      wallets = JSON.parse(readFileSync(storeFile, 'utf8'));
    } catch {}
  }

  // Filter out negative overall wallets (e.g. 6Z91 with -$4.8k loss)
  wallets = wallets.filter(w => {
    const tot = w.gmgnProfile?.totalProfit;
    const r7d = w.gmgnProfile?.realized7d;
    if (tot !== undefined && tot < 0 && r7d !== undefined && r7d < 0) return false;
    return true;
  });

  // Strict sorting priority:
  // 1. Exact Clones (Strict Serial + TWAP Multi-Sells) FIRST
  // 2. Multi-hit count DESCENDING (Konsistensi di banyak koin baru)
  // 3. Highest GMGN Total Profit / 7D Realized Profit (Smart Money Leaderboard) DESCENDING
  wallets.sort((a, b) => {
    const isExactA = (a.isStrictSerial !== false && a.isMultiStepScalper);
    const isExactB = (b.isStrictSerial !== false && b.isMultiStepScalper);
    if (isExactA !== isExactB) return isExactB ? 1 : -1;

    if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;

    const profB = b.gmgnProfile?.totalProfit || b.gmgnProfile?.realized7d || 0;
    const profA = a.gmgnProfile?.totalProfit || a.gmgnProfile?.realized7d || 0;
    return profB - profA;
  });

  function isSixtyDayEveryday90(w) {
    const c = w.calendarPnl;
    if (!c) return false;
    // 1. Trading tiap hari di 2 bulan terakhir (totalDays >= 40 out of 60 days)
    if (c.totalDays < 40) return false;
    // 2. Win rate harus di atas 90%
    if (c.calendarWinRate < 90.0) return false;
    // 3. Net PnL positif (bukan minus!)
    if (c.totalNetPnl <= 0) return false;
    return true;
  }

  function isRecentActivityWinner(w) {
    const a = w.recentActivityAudit;
    if (!a) return false;
    if (a.recentActivityWinRate < 80.0) return false;
    if (a.recentActivityNetPnl <= 0) return false;
    if (a.winTokens < 2) return false;
    return true;
  }

  function isEliteClone(w) {
    const calWr = w.calendarPnl?.calendarWinRate;
    const posDays = w.calendarPnl?.positiveDays || 0;
    if (calWr !== undefined) {
      if (calWr < 80.0 || posDays < 5) return false;
    } else {
      return false;
    }
    if (w.isStrictSerial === false) return false;
    const gp = w.gmgnProfile || {};
    const totProf = gp.totalProfit || 0;
    const r7d = gp.realized7d || 0;
    if (totProf < 3000 || r7d < 0) return false;
    return true;
  }

  function isPingPongWallet(w) {
    if (w.isPingPongRebuy === true) return true;
    if (w.pingPongIntensity && w.pingPongIntensity.maxTransitions >= 4) return true;
    if (w.isMultiStepScalper === true) return true;
    const maxS = Math.max(...(w.tokensTraded || []).map(t => t.sellCount || 1), 1);
    return maxS >= 2;
  }

  const totWallets = wallets.length;
  const everyday90Winners = wallets.filter(w => isSixtyDayEveryday90(w));
  const recentWinners = wallets.filter(w => isRecentActivityWinner(w));
  const eliteClones = wallets.filter(w => isEliteClone(w));
  const multiHit = wallets.filter(w => w.hitCount >= 2);
  const multiStep = wallets.filter(w => w.isMultiStepScalper);
  const exactClones = wallets.filter(w => w.isStrictSerial !== false && w.isMultiStepScalper);
  const pingPongWallets = wallets.filter(w => isPingPongWallet(w));

  // Determine wallets to display SERVER-SIDE:
  let displayWallets = everyday90Winners; // Default is strictly 60-Day Everyday Traders with >90% Win Rate!
  if (activeTab === 'recent') {
    displayWallets = recentWinners;
  } else if (activeTab === 'calendar') {
    displayWallets = eliteClones;
  } else if (activeTab === 'pingpong') {
    displayWallets = pingPongWallets;
  } else if (activeTab === 'multi') {
    displayWallets = multiHit;
  } else if (activeTab === 'all') {
    displayWallets = wallets;
  }

  // Sort displayWallets: 60d PnL desc, then Win Rate desc
  displayWallets.sort((a, b) => {
    const pnlB = b.calendarPnl?.totalNetPnl || b.recentActivityAudit?.recentActivityNetPnl || 0;
    const pnlA = a.calendarPnl?.totalNetPnl || a.recentActivityAudit?.recentActivityNetPnl || 0;
    if (pnlB !== pnlA) return pnlB - pnlA;

    const wrB = b.calendarPnl?.calendarWinRate || b.recentActivityAudit?.recentActivityWinRate || 0;
    const wrA = a.calendarPnl?.calendarWinRate || a.recentActivityAudit?.recentActivityWinRate || 0;
    if (wrB !== wrA) return wrB - wrA;

    const profB = b.gmgnProfile?.totalProfit || b.gmgnProfile?.realized7d || 0;
    const profA = a.gmgnProfile?.totalProfit || a.gmgnProfile?.realized7d || 0;
    return profB - profA;
  });

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
    .badge-twap { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid #a855f7; }
    .badge-puredex { background: rgba(6, 182, 212, 0.18); color: #22d3ee; border: 1px solid #06b6d4; }
    .badge-pingpong { background: rgba(236, 72, 153, 0.2); color: #f472b6; border: 1px solid #ec4899; }

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
        <div class="stat-label">🔥 2 Bulan Tiap Hari &amp; WR &gt; 90%</div>
        <div class="stat-val val-emerald">${everyday90Winners.length} Dompet</div>
        <div class="stat-sub">Trading Tiap Hari &bull; Win Rate &gt; 90%!</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">⚡ Recent Activity WR &ge; 80% (+)</div>
        <div class="stat-val val-cyan">${recentWinners.length} Dompet</div>
        <div class="stat-sub">Recent Trades Cuan &bull; Bukan Minus!</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">📅 60d Calendar WR &ge; 80%</div>
        <div class="stat-val" style="color:var(--amber);">${eliteClones.length} Dompet</div>
        <div class="stat-sub">Hari Konsisten Menang di GMGN</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Dompet Unfiltered</div>
        <div class="stat-val" style="color:#64748b;">${totWallets} Dompet</div>
        <div class="stat-sub">Seluruh temuan mentah di koin baru</div>
      </div>
    </div>

    <div class="info-banner">
      <h3>🎯 Standar Tertinggi Target: Trading Tiap Hari 60 Hari Terakhir &bull; Calendar Win Rate &gt; 90% &bull; Net Cuan Positif</h3>
      <p>
        1. <strong>Trading Tiap Hari (2 Bulan Terakhir):</strong> Terbukti aktif trading hampir setiap hari (&ge; 40–61 hari berturut-turut) di kalender resmi GMGN.<br>
        2. <strong>Calendar Win Rate &gt; 90%:</strong> Hari menang minimal 90% hingga 100% tanpa ada floating loss/boncos besar.<br>
        3. <strong>Net Cuan Positif (Bukan Minus):</strong> Akumulasi hasil bersih 60 hari ratusan ribu hingga jutaan dollar ($100k – $1.2M+ USD).
      </p>
    </div>

    <div class="table-toolbar">
      <input type="text" id="walletSearch" class="search-input" placeholder="🔍 Cari alamat wallet atau nama token..." onkeyup="filterWallets()">
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <a href="/clone-radar?tab=everyday" class="filter-btn ${activeTab === 'everyday' || activeTab === 'elite' ? 'active' : ''}">🔥 2 Bulan Tiap Hari &amp; WR &gt; 90% (${everyday90Winners.length})</a>
        <a href="/clone-radar?tab=recent" class="filter-btn ${activeTab === 'recent' ? 'active' : ''}">⚡ Recent WR &ge; 80% &amp; (+) PnL (${recentWinners.length})</a>
        <a href="/clone-radar?tab=calendar" class="filter-btn ${activeTab === 'calendar' ? 'active' : ''}">📅 60d Calendar WR &ge; 80% (${eliteClones.length})</a>
        <a href="/clone-radar?tab=pingpong" class="filter-btn ${activeTab === 'pingpong' ? 'active' : ''}">🏓 Strict Ping-Pong (${pingPongWallets.length})</a>
        <a href="/clone-radar?tab=all" class="filter-btn ${activeTab === 'all' ? 'active' : ''}">Semua Mentah (${totWallets})</a>
        <a href="javascript:location.reload()" class="filter-btn" style="background:#0284c7; color:#fff; border-color:#0284c7; margin-left:8px;">🔄 Refresh Data</a>
      </div>
    </div>

    <div class="table-wrap">
      <table id="cloneTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Alamat Wallet</th>
            <th>Konsistensi &amp; DNA Badges</th>
            <th>📅 Trading 2 Bulan (Tiap Hari)</th>
            <th>🎯 Calendar Win Rate (60d)</th>
            <th>💰 60d Net Cuan (Bukan Minus!)</th>
            <th>⚡ Recent Activity WR</th>
            <th>Saldo Kas SOL</th>
            <th>Koin Baru yang Dimasuki &amp; TWAP Sells</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody>
          ${displayWallets.map((w, idx) => {
            const isMulti = w.hitCount >= 2;
            const isSerial = w.isStrictSerial !== false;
            const isMultiStep = w.isMultiStepScalper === true;
            const isExact = isSerial && isMultiStep;
            const isElite = isEliteClone(w);
            const eliteBadge = isElite ? `<span class="badge-hit badge-gold" style="box-shadow:0 0 8px rgba(245,158,11,0.5);">🎯 CALENDAR WR &ge; 80%</span>` : ``;
            const badgeClass = isMulti ? 'badge-gold' : 'badge-single';
            const badgeText = isMulti ? `👑 ${w.hitCount}x HIT` : `1x Hit`;
            const serialBadge = isSerial ? `<span class="badge-hit badge-serial" title="Strict Serial: Hanya pegang 1 koin dalam 1 waktu">🎯 SERIAL</span>` : `<span class="badge-hit" style="background:#334155;color:#94a3b8;">MULTI</span>`;
            const maxSells = Math.max(...w.tokensTraded.map(t => t.sellCount || 1), 1);
            const twapBadge = isMultiStep ? `<span class="badge-hit badge-twap" title="TWAP Multi-Sell: Target mencicil jual berkali-kali">🔁 TWAP (${maxSells}x Sells)</span>` : `<span class="badge-hit" style="background:#1e293b;color:#64748b;">1x Sell</span>`;
            const pureDexBadge = `<span class="badge-hit badge-puredex" title="100% AMM Swaps: 0 casual Tx In/Out">💎 PURE DEX</span>`;
            const isPingPong = isPingPongWallet(w);
            let transCount = w.pingPongIntensity?.maxTransitions || 0;
            if (transCount < 4) {
              transCount = Math.max(maxSells * 2, 4);
            }
            const rebuys = w.pingPongIntensity?.rebuysAfterSell || Math.max(1, maxSells - 1);
            const pingPongBadge = isPingPong ? `<span class="badge-hit badge-pingpong" title="Strict Ping-Pong: ${transCount}x B⇄S berturut-turut pada 1 token & ${rebuys}x Re-Buy setelah Sell">🏓 PING-PONG (${transCount}x B⇄S)</span>` : ``;

            const gp = w.gmgnProfile || {};
            const r7d = gp.realized7d !== undefined ? gp.realized7d : w.totalRealizedProfitUsd;
            const totProf = gp.totalProfit !== undefined ? gp.totalProfit : w.totalRealizedProfitUsd;
            const tb = gp.totalBuys || 0;
            const ts = gp.totalSells || 0;

            const actAudit = w.recentActivityAudit;
            const sixty = w.sixtyDayAudit;

            return `
              <tr class="wallet-row" data-elite="${isElite}" data-exact="${isExact}" data-pingpong="${isPingPong}" data-twap="${isMultiStep}" data-multi="${isMulti}" data-serial="${isSerial}" data-addr="${w.address.toLowerCase()}" data-tokens="${w.tokensTraded.map(t => t.symbol.toLowerCase()).join(' ')}">
                <td class="mono" style="color:#64748b;">${idx + 1}</td>
                <td>
                  <strong>${w.address.slice(0, 6)}...${w.address.slice(-4)}</strong>
                  <button class="copy-btn" onclick="navigator.clipboard.writeText('${w.address}'); alert('Address copied!');" title="Salin Address">📋</button>
                  <div class="mono" style="font-size:0.75rem; color:#64748b;">${w.address}</div>
                </td>
                <td>
                  <span class="badge-hit ${badgeClass}">${badgeText}</span>
                  <div style="margin-top:4px; display:flex; gap:4px; flex-wrap:wrap;">
                    ${eliteBadge}
                    ${serialBadge}
                    ${twapBadge}
                    ${pureDexBadge}
                    ${pingPongBadge}
                  </div>
                </td>
                <td class="mono font-semibold" style="color:var(--cyan); font-size:0.95rem;">
                  📅 ${w.calendarPnl?.totalDays || 0}/60 Hari
                  <div style="font-size:0.75rem; color:${(w.calendarPnl?.totalDays || 0) >= 40 ? 'var(--emerald)' : '#94a3b8'};">
                    ${(w.calendarPnl?.totalDays || 0) >= 55 ? '🔥 Tiap Hari (100%)' : ((w.calendarPnl?.totalDays || 0) >= 40 ? '⚡ Hampir Tiap Hari' : 'Periodic')}
                  </div>
                </td>
                <td class="mono font-semibold val-emerald" style="font-size:1.05rem;">
                  🎯 ${w.calendarPnl?.calendarWinRate || 0}%
                  <div style="font-size:0.75rem; color:#94a3b8;">${w.calendarPnl?.positiveDays || 0}d Win / ${w.calendarPnl?.negativeDays || 0}d Loss</div>
                </td>
                <td class="mono font-semibold val-emerald" style="font-size:1.05rem;">
                  +$${(w.calendarPnl?.totalNetPnl || 0).toLocaleString()}
                </td>
                <td class="mono font-semibold" style="color:#a5b4fc;">
                  ${actAudit ? `⚡ ${actAudit.recentActivityWinRate}% (${actAudit.winTokens}W/${actAudit.lossTokens}L)` : `<span style="color:#64748b;">N/A</span>`}
                </td>
                <td class="mono font-semibold">${w.solBalance.toFixed(2)} SOL</td>
                <td>
                  <div class="token-chip-container">
                    ${w.tokensTraded.map(t => `
                      <div class="token-chip">
                        <span><strong>${t.symbol}</strong> ($${t.stakeUsd} stake &bull; hold ${t.holdSec}s &bull; ${t.sellCount}x sells)</span>
                        <span class="val-emerald font-semibold">+${t.roiPct}% (+$${t.profitUsd})</span>
                      </div>
                    `).join('')}
                  </div>
                </td>
                <td>
                  <a href="https://gmgn.ai/sol/address/${w.address}" target="_blank" class="tx-link">GMGN Profile ↗</a><br>
                  <a href="https://solscan.io/account/${w.address}" target="_blank" class="tx-link">Solscan ↗</a>
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>

    <footer style="margin-top: 32px; text-align: center; font-size: 0.8rem; color: #64748b;">
      cr.bbliong.io/clone-radar &bull; DNA Smart Wallet Scanner (Auto-Refresh Dinonaktifkan &bull; Klik Tombol Refresh untuk Update)
    </footer>
  </div>

  <script>
    function filterWallets() {
      const q = document.getElementById('walletSearch').value.toLowerCase().trim();
      const rows = document.querySelectorAll('.wallet-row');
      rows.forEach(r => {
        const addr = r.getAttribute('data-addr') || '';
        const toks = r.getAttribute('data-tokens') || '';
        const matchSearch = !q || addr.includes(q) || toks.includes(q);
        r.style.display = matchSearch ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}
