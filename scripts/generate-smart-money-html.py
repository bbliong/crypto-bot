#!/usr/bin/env python3
"""
generate-smart-money-html.py

Menghasilkan tabel HTML interaktif untuk daftar dompet Smart Money hasil kurasi
lengkap dengan direct link ke GMGN dan Solscan, serta link token pemenang.
"""

import json
import os

BASE_DIR = '/home/bbliong/project/crypto-bot'
JSON_PATH = os.path.join(BASE_DIR, 'reports/smart-money-curation/smart-money-wallets.json')
DIST_HTML = os.path.join(BASE_DIR, 'dist/smart-money-wallets.html')
REPORT_HTML = os.path.join(BASE_DIR, 'reports/smart-money-curation/smart-money-wallets.html')

with open(JSON_PATH) as f:
    data = json.load(f)

wallets = data['wallets']
summary = data['summary']

html_content = f"""<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Money Wallets Curation — On-Chain Research</title>
  <style>
    :root {{
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.15);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.15);
      --purple: #a855f7;
      --purple-bg: rgba(168, 85, 247, 0.15);
      --red: #ef4444;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }}

    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{
      background-color: var(--bg);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 24px;
      line-height: 1.5;
    }}

    .container {{
      max-width: 1400px;
      margin: 0 auto;
    }}

    header {{
      margin-bottom: 24px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 20px;
    }}

    h1 {{
      font-size: 24px;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 10px;
    }}

    .badge-method {{
      font-size: 12px;
      font-weight: 600;
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      padding: 4px 10px;
      border-radius: 9999px;
      border: 1px solid rgba(56, 189, 248, 0.3);
    }}

    .subtitle {{
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 4px;
    }}

    .stats-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }}

    .stat-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
    }}

    .stat-label {{
      font-size: 12px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.5px;
    }}

    .stat-val {{
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      margin-top: 4px;
    }}

    .stat-sub {{
      font-size: 12px;
      color: var(--green);
      margin-top: 2px;
    }}

    /* Controls bar */
    .controls {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 14px 18px;
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }}

    .search-input {{
      flex: 1;
      min-width: 250px;
      background: #0b1120;
      border: 1px solid var(--card-border);
      border-radius: 8px;
      padding: 8px 14px;
      color: #fff;
      font-size: 14px;
      outline: none;
    }}
    .search-input:focus {{
      border-color: var(--accent);
    }}

    .tab-btn {{
      background: transparent;
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }}
    .tab-btn:hover {{
      color: #fff;
      border-color: #374151;
    }}
    .tab-btn.active {{
      background: var(--accent);
      color: #090d16;
      border-color: var(--accent);
    }}

    .btn-action {{
      background: #1e293b;
      border: 1px solid var(--card-border);
      color: #f1f5f9;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
    }}
    .btn-action:hover {{
      background: #334155;
      color: #fff;
    }}

    /* Table */
    .table-container {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow-x: auto;
    }}

    table {{
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 13px;
    }}

    th {{
      background: #0e1626;
      padding: 12px 16px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
    }}

    td {{
      padding: 14px 16px;
      border-bottom: 1px solid rgba(31, 41, 61, 0.6);
      vertical-align: middle;
    }}

    tr:hover td {{
      background: rgba(255, 255, 255, 0.02);
    }}

    .wallet-col {{
      font-family: var(--font-mono);
      font-size: 13px;
    }}

    .wallet-links {{
      display: flex;
      gap: 6px;
      margin-top: 5px;
    }}

    .link-badge {{
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      text-decoration: none;
      font-weight: 600;
      transition: opacity 0.15s;
    }}
    .link-badge:hover {{
      opacity: 0.85;
      text-decoration: underline;
    }}
    .link-gmgn {{
      background: #14532d;
      color: #4ade80;
    }}
    .link-solscan {{
      background: #1e1b4b;
      color: #818cf8;
    }}
    .link-copy {{
      background: #1e293b;
      color: #cbd5e1;
      border: none;
      cursor: pointer;
      font-family: inherit;
    }}

    .score-badge {{
      font-weight: 800;
      font-size: 14px;
      padding: 4px 10px;
      border-radius: 6px;
      display: inline-block;
    }}
    .score-high {{
      background: var(--green-bg);
      color: var(--green);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }}
    .score-mid {{
      background: var(--amber-bg);
      color: var(--amber);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }}

    .tag-trader {{
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
    }}
    .tag-human {{
      background: rgba(56, 189, 248, 0.15);
      color: #38bdf8;
    }}
    .tag-semi {{
      background: var(--amber-bg);
      color: var(--amber);
    }}
    .tag-bot {{
      background: var(--purple-bg);
      color: var(--purple);
    }}

    .token-pills {{
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      max-width: 380px;
    }}

    .token-pill {{
      background: #1e293b;
      border: 1px solid #334155;
      padding: 2px 7px;
      border-radius: 6px;
      font-size: 11px;
      text-decoration: none;
      color: #f8fafc;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: border-color 0.15s;
    }}
    .token-pill:hover {{
      border-color: var(--accent);
      color: var(--accent);
    }}

    .token-gain {{
      font-weight: 700;
      color: #34d399;
    }}

    /* Toast Notification */
    #toast {{
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #10b981;
      color: #042f2e;
      padding: 10px 18px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 13px;
      display: none;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5);
      z-index: 9999;
    }}
  </style>
</head>
<body>

<div class="container">
  <header>
    <div>
      <h1>
        🎯 Kurasi Smart Money Wallets
        <span class="badge-method">Metode 7 Langkah @crbpite8</span>
      </h1>
      <div class="subtitle">
        Diekstrak dari riwayat transaksi on-chain <strong>Research (575 token)</strong> & <strong>Profit4</strong> (Total 903.380 transaksi terverifikasi)
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn-action" onclick="copyRecommendedJson()">📋 Salin JSON 14 Wallet Terpilih</button>
      <button class="btn-action" onclick="exportCsv()">📥 Ekspor CSV</button>
    </div>
  </header>

  <!-- Stats Grid -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Token Pemenang Terlacak</div>
      <div class="stat-val">{summary['total_winners']} Token</div>
      <div class="stat-sub">Gain kenaikan &ge; 2x hingga ribuan kali lipat</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Dompet Early Pemenang Berulang</div>
      <div class="stat-val">{summary['repeat_winner_wallets']} Dompet</div>
      <div class="stat-sub">Masuk di 20 pembeli pertama &ge; 2 token pemenang</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Dompet Rekomendasi (Elite)</div>
      <div class="stat-val">14 Dompet</div>
      <div class="stat-sub">Lolos filter bot, win rate tinggi, human/semi-auto</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Akurasi Konvergensi (Overlap &ge;2)</div>
      <div class="stat-val">{summary['overlap_performance']['2']['win_2x_pct']}%</div>
      <div class="stat-sub">{summary['overlap_performance']['2']['win_5x_pct']}% tembus gain &ge; 5x saat &ge;2 dompet masuk</div>
    </div>
  </div>

  <!-- Controls -->
  <div class="controls">
    <input type="text" id="searchInput" class="search-input" placeholder="Cari alamat wallet, token, atau tipe trader..." oninput="filterTable()">
    
    <div style="display: flex; gap: 6px;">
      <button class="tab-btn active" id="tab-rec" onclick="setFilter('recommended')">⭐ 14 Rekomendasi</button>
      <button class="tab-btn" id="tab-all" onclick="setFilter('all')">Semua 37 Dompet</button>
      <button class="tab-btn" id="tab-human" onclick="setFilter('human')">Human Trader Only</button>
      <button class="tab-btn" id="tab-100" onclick="setFilter('100')">100% Win Rate</button>
    </div>
  </div>

  <!-- Table -->
  <div class="table-container">
    <table id="walletTable">
      <thead>
        <tr>
          <th>#</th>
          <th>Alamat Dompet Solana (Klik Langsung)</th>
          <th>Skor (0-10)</th>
          <th>Tipe Trader</th>
          <th>Win Rate (&ge;2x)</th>
          <th>Early Winners</th>
          <th>Token Pemenang yang Pernah Dibeli (Buka GMGN Token)</th>
          <th>Karakteristik Transaksi</th>
        </tr>
      </thead>
      <tbody>
"""

rec_wallets_json = []

for i, w in enumerate(wallets, 1):
    is_rec = w['score'] >= 6.0 and w['bot_tag'] in ('HUMAN_TRADER', 'FAST_BOT_SEMI_AUTO')
    if is_rec and len(rec_wallets_json) < 14:
        rec_wallets_json.append(w['wallet'])

    addr = w['wallet']
    short_addr = f"{addr[:6]}...{addr[-6:]}"
    score_cls = "score-high" if w['score'] >= 7.0 else "score-mid"
    
    tag_cls = "tag-human" if w['bot_tag'] == 'HUMAN_TRADER' else ("tag-semi" if w['bot_tag'] == 'FAST_BOT_SEMI_AUTO' else "tag-bot")
    tag_text = "Human Trader" if w['bot_tag'] == 'HUMAN_TRADER' else ("Semi-Auto" if w['bot_tag'] == 'FAST_BOT_SEMI_AUTO' else "Sniper/Bot")

    # Tokens badges
    token_pills = []
    for t in w['early_winner_tokens'][:6]:
        sym = t['symbol']
        g = t['token_gain']
        gain_str = f"{g:.1f}x" if g < 1000 else f"{g/1000:.0f}kx"
        mint = t['mint']
        token_pills.append(
            f'<a href="https://gmgn.ai/sol/token/{mint}" target="_blank" class="token-pill" title="Mint: {mint}">'
            f'<span>{sym}</span><span class="token-gain">+{gain_str}</span>'
            f'</a>'
        )
    if len(w['early_winner_tokens']) > 6:
        token_pills.append(f'<span class="token-pill" style="color:var(--text-muted)">+{len(w["early_winner_tokens"])-6} lainnya</span>')

    pills_html = "".join(token_pills)

    sub_sec = f"{w['sub_second_ratio_pct']}%"
    med_int = f"{w['median_interval_sec']}s" if w['median_interval_sec'] < 60 else f"{w['median_interval_sec']/60:.1f}m"

    html_content += f"""
        <tr class="wallet-row" 
            data-wallet="{addr}" 
            data-rec="{'true' if is_rec else 'false'}" 
            data-tag="{w['bot_tag']}" 
            data-winrate="{w['win_rate_2x_pct']}">
          <td style="color:var(--text-muted); font-weight:700;">{i}</td>
          <td class="wallet-col">
            <span style="font-weight:700; color:#fff;" title="{addr}">{short_addr}</span>
            <div class="wallet-links">
              <a href="https://gmgn.ai/sol/address/{addr}" target="_blank" class="link-badge link-gmgn">🔗 GMGN</a>
              <a href="https://solscan.io/account/{addr}" target="_blank" class="link-badge link-solscan">🔍 Solscan</a>
              <button class="link-badge link-copy" onclick="copyText('{addr}', 'Alamat wallet disalin!')">📋 Copy</button>
            </div>
          </td>
          <td>
            <span class="score-badge {score_cls}">{w['score']:.2f}</span>
          </td>
          <td>
            <span class="tag-trader {tag_cls}">{tag_text}</span>
          </td>
          <td>
            <div style="font-weight:700; font-size:14px; color:{'#10b981' if w['win_rate_2x_pct']>=60 else '#f59e0b'};">
              {w['win_rate_2x_pct']}%
            </div>
            <div style="color:var(--text-muted); font-size:11px;">{w['wins_2x']}/{w['total_tokens_traded']} token</div>
          </td>
          <td style="text-align:center; font-weight:700; font-size:15px; color:#fff;">
            {w['early_winners_count']}
          </td>
          <td>
            <div class="token-pills">
              {pills_html}
            </div>
          </td>
          <td style="font-size:12px; color:var(--text-muted);">
            <div>Jeda median: <strong style="color:#fff">{med_int}</strong></div>
            <div>Sub-detik tx: <strong style="color:{'#10b981' if w['sub_second_ratio_pct']<10 else '#f59e0b'}">{sub_sec}</strong></div>
            <div>Total histori: {w['total_transactions']} tx</div>
          </td>
        </tr>
"""

recommended_json_str = json.dumps(rec_wallets_json, indent=2)

html_content += f"""
      </tbody>
    </table>
  </div>
</div>

<div id="toast">Notifikasi</div>

<script>
  const recommendedAddresses = {recommended_json_str};
  let currentFilter = 'recommended';

  function showToast(msg) {{
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.style.display = 'block';
    setTimeout(() => {{ t.style.display = 'none'; }}, 2500);
  }}

  function copyText(text, successMsg) {{
    navigator.clipboard.writeText(text).then(() => {{
      showToast(successMsg || 'Disalin ke clipboard!');
    }});
  }}

  function copyRecommendedJson() {{
    copyText(JSON.stringify(recommendedAddresses, null, 2), 'JSON 14 Wallet Terpilih disalin!');
  }}

  function exportCsv() {{
    const rows = document.querySelectorAll('#walletTable tbody tr');
    let csv = 'Rank,Wallet,Score,Tag,WinRate2x,Wins,TotalTokens,EarlyWinners,MedianIntervalSec\\n';
    rows.forEach(r => {{
      if (r.style.display !== 'none') {{
        const cells = r.querySelectorAll('td');
        const rank = cells[0].innerText.trim();
        const wallet = r.getAttribute('data-wallet');
        const score = cells[2].innerText.trim();
        const tag = r.getAttribute('data-tag');
        const winrate = r.getAttribute('data-winrate');
        const early = cells[5].innerText.trim();
        csv += `${{rank}},"${{wallet}}",${{score}},${{tag}},${{winrate}}%,${{early}}\\n`;
      }}
    }});
    const blob = new Blob([csv], {{ type: 'text/csv' }});
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'smart-money-wallets.csv';
    a.click();
  }}

  function setFilter(type) {{
    currentFilter = type;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    if (type === 'recommended') document.getElementById('tab-rec').classList.add('active');
    else if (type === 'all') document.getElementById('tab-all').classList.add('active');
    else if (type === 'human') document.getElementById('tab-human').classList.add('active');
    else if (type === '100') document.getElementById('tab-100').classList.add('active');
    filterTable();
  }}

  function filterTable() {{
    const query = document.getElementById('searchInput').value.toLowerCase();
    const rows = document.querySelectorAll('.wallet-row');

    rows.forEach(r => {{
      const wallet = r.getAttribute('data-wallet').toLowerCase();
      const isRec = r.getAttribute('data-rec') === 'true';
      const tag = r.getAttribute('data-tag');
      const winrate = parseFloat(r.getAttribute('data-winrate') || 0);
      const text = r.innerText.toLowerCase();

      let matchFilter = true;
      if (currentFilter === 'recommended' && !isRec) matchFilter = false;
      if (currentFilter === 'human' && tag !== 'HUMAN_TRADER') matchFilter = false;
      if (currentFilter === '100' && winrate < 99.9) matchFilter = false;

      const matchSearch = text.includes(query) || wallet.includes(query);

      r.style.display = (matchFilter && matchSearch) ? '' : 'none';
    }});
  }}

  // Jalankan filter default saat load
  document.addEventListener('DOMContentLoaded', () => {{
    filterTable();
  }});
</script>

</body>
</html>
"""

# Tulis ke dist/smart-money-wallets.html dan reports/
with open(DIST_HTML, 'w') as f:
    f.write(html_content)

with open(REPORT_HTML, 'w') as f:
    f.write(html_content)

print(f"Berhasil membuat HTML:")
print(f" - {DIST_HTML}")
print(f" - {REPORT_HTML}")
