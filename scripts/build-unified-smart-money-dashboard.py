#!/usr/bin/env python3
"""
build-unified-smart-money-dashboard.py

Menghasilkan dashboard lengkap berisi 2 tab utama:
1. Dompet Smart Money (Real Capital vs Dust Bot)
2. Token Pemenang yang Masih Aktif Hari Ini (Data Live DexScreener: MC, 24h Vol, Liq, Link)
"""

import os
import json
import time

BASE_DIR = '/home/bbliong/project/crypto-bot'
DIST_HTML = os.path.join(BASE_DIR, 'dist/smart-money-wallets.html')
REPORT_HTML = os.path.join(BASE_DIR, 'reports/smart-money-curation/smart-money-wallets.html')
WALLETS_JSON = os.path.join(BASE_DIR, 'reports/smart-money-curation/smart-money-wallets.json')
ACTIVE_JSON = os.path.join(BASE_DIR, 'reports/smart-money-curation/active-tokens-today.json')

def main():
    with open(WALLETS_JSON) as f:
        profiles = json.load(f)

    with open(ACTIVE_JSON) as f:
        active_data = json.load(f)

    active_tokens = active_data.get('tokens', [])
    active_tokens.sort(key=lambda x: (x['market_cap'], x['volume_24h']), reverse=True)

    real_count = sum(1 for p in profiles if p['category'] == 'REAL_SMART_MONEY')
    dust_count = sum(1 for p in profiles if p['category'] == 'DUST_SYBIL_BOT')
    sangat_aktif = sum(1 for t in active_tokens if t['status'] == 'SANGAT_AKTIF')

    # Bangun baris dompet
    wallet_rows = []
    real_wallets_json = []

    for i, p in enumerate(profiles, 1):
        addr = p['wallet']
        short_addr = f"{addr[:6]}...{addr[-6:]}"
        cat = p['category']
        if cat == 'REAL_SMART_MONEY' and p['win_rate_2x'] >= 50.0:
            real_wallets_json.append(addr)

        cat_badge_cls = "cat-real" if cat == 'REAL_SMART_MONEY' else ("cat-small" if cat == 'SMALL_RETAIL' else "cat-dust")

        token_pills = []
        for t in p['win_entries'][:5]:
            sym = t['symbol']
            g = t['token_gain']
            gain_str = f"{g:.1f}x" if g < 1000 else f"{g/1000:.0f}kx"
            mint = t['mint']
            token_pills.append(
                f'<a href="https://gmgn.ai/sol/token/{mint}" target="_blank" class="token-pill" title="Mint: {mint}">'
                f'<span>{sym}</span><span class="token-gain">+{gain_str}</span>'
                f'</a>'
            )
        if len(p['win_entries']) > 5:
            token_pills.append(f'<span class="token-pill" style="color:var(--text-muted)">+{len(p["win_entries"])-5} lainnya</span>')

        pills_html = "".join(token_pills)
        med_usd_formatted = f"${p['med_buy_usd']:,.2f}" if p['med_buy_usd'] >= 1.0 else f"${p['med_buy_usd']:.4f}"
        est_profit_formatted = f"${p['est_profit_usd']:,.2f}" if p['est_profit_usd'] >= 1.0 else f"${p['est_profit_usd']:.4f}"

        wallet_rows.append(f"""
        <tr class="wallet-row" 
            data-wallet="{addr}" 
            data-cat="{cat}" 
            data-winrate="{p['win_rate_2x']}" 
            data-medusd="{p['med_buy_usd']}">
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
            <span class="badge-cat {cat_badge_cls}">{p['cat_label']}</span>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">{p['speed_tag']}</div>
          </td>
          <td>
            <div style="font-weight:700; font-size:14px; color:{'#10b981' if p['med_buy_usd']>=10 else ('#f59e0b' if p['med_buy_usd']>=1 else '#ef4444')};">
              {med_usd_formatted}
            </div>
            <div style="color:var(--text-muted); font-size:11px;">Rentang: ${p['min_buy_usd']} - ${p['max_buy_usd']}</div>
          </td>
          <td>
            <div style="font-weight:700; font-size:14px; color:{'#10b981' if p['est_profit_usd']>=50 else ('#f59e0b' if p['est_profit_usd']>=1 else '#ef4444')};">
              {est_profit_formatted}
            </div>
            <div style="color:var(--text-muted); font-size:11px;">Dari {p['win_entries_count']} token pemenang</div>
          </td>
          <td>
            <div style="font-weight:700; font-size:14px; color:{'#10b981' if p['win_rate_2x']>=60 else '#f59e0b'};">
              {p['win_rate_2x']}%
            </div>
            <div style="color:var(--text-muted); font-size:11px;">{p['wins_2x']}/{p['total_tokens']} token</div>
          </td>
          <td>
            <div class="token-pills">
              {pills_html}
            </div>
          </td>
          <td style="font-size:12px; color:var(--text-muted);">
            <div>Jeda median: <strong style="color:#fff">{p['median_interval_sec']}s</strong></div>
            <div>Sub-detik tx: <strong style="color:{'#10b981' if p['sub_second_ratio']<10 else '#ef4444'}">{p['sub_second_ratio']}%</strong></div>
          </td>
        </tr>
        """)

    # Bangun baris token aktif
    token_rows = []
    for i, t in enumerate(active_tokens, 1):
        sym = t['symbol']
        name = t['name']
        mc = t['market_cap']
        vol = t['volume_24h']
        liq = t['liquidity_usd']
        txns = t['txns_24h']
        mint = t['mint']
        url = t['url'] if t['url'] else f"https://dexscreener.com/solana/{mint}"
        gmgn_url = f"https://gmgn.ai/sol/token/{mint}"
        status = t['status']

        if status == 'SANGAT_AKTIF':
            status_badge = '<span class="badge-cat cat-real">🔥 SANGAT AKTIF</span>'
        else:
            status_badge = '<span class="badge-cat cat-small">⚡ MASIH BERTAHAN</span>'

        token_rows.append(f"""
        <tr class="token-row" data-mint="{mint}" data-sym="{sym.lower()}" data-name="{name.lower()}" data-mc="{mc}" data-vol="{vol}">
          <td style="color:var(--text-muted); font-weight:700;">{i}</td>
          <td>
            <div style="font-size:15px; font-weight:700; color:#fff;">{sym}</div>
            <div style="font-size:12px; color:var(--text-muted);">{name}</div>
          </td>
          <td>{status_badge}</td>
          <td>
            <div style="font-weight:700; font-size:15px; color:{'#10b981' if mc>=100000 else '#f3f4f6'};">
              ${mc:,.0f}
            </div>
          </td>
          <td>
            <div style="font-weight:700; font-size:15px; color:#38bdf8;">
              ${vol:,.0f}
            </div>
          </td>
          <td style="color:#cbd5e1; font-weight:600;">${liq:,.0f}</td>
          <td style="color:#cbd5e1;">{txns:,} tx</td>
          <td>
            <div style="display:flex; gap:6px; margin-bottom:4px;">
              <a href="{url}" target="_blank" class="link-badge" style="background:#0284c7; color:#fff;">📈 DexScreener</a>
              <a href="{gmgn_url}" target="_blank" class="link-badge link-gmgn">🔗 GMGN</a>
              <button class="link-badge link-copy" onclick="copyText('{mint}', 'Mint disalin!')">📋</button>
            </div>
            <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">{mint[:6]}...{mint[-6:]}</span>
          </td>
        </tr>
        """)

    wallet_tbody = "\n".join(wallet_rows)
    token_tbody = "\n".join(token_rows)
    real_json_str = json.dumps(real_wallets_json, indent=2)

    html = f"""<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Money & Active Tokens Radar — Live On-Chain</title>
  <style>
    :root {{
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --text-main: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #38bdf8;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.15);
      --amber: #f59e0b;
      --amber-bg: rgba(245, 158, 11, 0.15);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.15);
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

    .container {{ max-width: 1480px; margin: 0 auto; }}

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

    h1 {{ font-size: 24px; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 10px; }}
    .badge-method {{
      font-size: 12px; font-weight: 600; background: rgba(56, 189, 248, 0.15);
      color: var(--accent); padding: 4px 10px; border-radius: 9999px; border: 1px solid rgba(56, 189, 248, 0.3);
    }}
    .subtitle {{ color: var(--text-muted); font-size: 14px; margin-top: 4px; }}

    .banner-warning {{
      background: rgba(245, 158, 11, 0.08);
      border: 1px solid rgba(245, 158, 11, 0.3);
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 24px;
      font-size: 13px;
      color: #fef3c7;
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }}

    .main-nav {{
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
    }}

    .nav-btn {{
      background: #111827;
      border: 1px solid var(--card-border);
      color: var(--text-muted);
      padding: 10px 20px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      transition: all 0.15s;
    }}
    .nav-btn:hover {{ color: #fff; border-color: #38bdf8; }}
    .nav-btn.active {{
      background: #0284c7;
      color: #fff;
      border-color: #38bdf8;
      box-shadow: 0 4px 12px rgba(2, 132, 199, 0.3);
    }}

    .stats-grid {{
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }}

    .stat-card {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 16px;
    }}
    .stat-label {{ font-size: 12px; color: var(--text-muted); text-transform: uppercase; font-weight: 600; }}
    .stat-val {{ font-size: 22px; font-weight: 700; color: #fff; margin-top: 4px; }}
    .stat-sub {{ font-size: 12px; margin-top: 2px; }}

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
      flex: 1; min-width: 250px; background: #0b1120; border: 1px solid var(--card-border);
      border-radius: 8px; padding: 8px 14px; color: #fff; font-size: 14px; outline: none;
    }}
    .search-input:focus {{ border-color: var(--accent); }}

    .tab-btn {{
      background: transparent; border: 1px solid var(--card-border); color: var(--text-muted);
      padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 0.15s;
    }}
    .tab-btn:hover {{ color: #fff; border-color: #374151; }}
    .tab-btn.active {{ background: var(--accent); color: #090d16; border-color: var(--accent); }}

    .btn-action {{
      background: #1e293b; border: 1px solid var(--card-border); color: #f1f5f9;
      padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
      display: inline-flex; align-items: center; gap: 6px;
    }}
    .btn-action:hover {{ background: #334155; color: #fff; }}

    .table-container {{
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      overflow-x: auto;
    }}

    table {{ width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }}
    th {{
      background: #0e1626; padding: 12px 16px; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted);
      border-bottom: 1px solid var(--card-border); white-space: nowrap;
    }}
    td {{ padding: 14px 16px; border-bottom: 1px solid rgba(31, 41, 61, 0.6); vertical-align: middle; }}
    tr:hover td {{ background: rgba(255, 255, 255, 0.02); }}

    .wallet-col {{ font-family: var(--font-mono); font-size: 13px; }}
    .wallet-links {{ display: flex; gap: 6px; margin-top: 5px; }}
    .link-badge {{
      display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 4px;
      font-size: 11px; text-decoration: none; font-weight: 600;
    }}
    .link-gmgn {{ background: #14532d; color: #4ade80; }}
    .link-solscan {{ background: #1e1b4b; color: #818cf8; }}
    .link-copy {{ background: #1e293b; color: #cbd5e1; border: none; cursor: pointer; }}

    .badge-cat {{
      padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; display: inline-block;
    }}
    .cat-real {{ background: var(--green-bg); color: var(--green); border: 1px solid rgba(16, 185, 129, 0.3); }}
    .cat-dust {{ background: var(--red-bg); color: var(--red); border: 1px solid rgba(239, 68, 68, 0.3); }}
    .cat-small {{ background: var(--amber-bg); color: var(--amber); border: 1px solid rgba(245, 158, 11, 0.3); }}

    .token-pills {{ display: flex; flex-wrap: wrap; gap: 5px; max-width: 380px; }}
    .token-pill {{
      background: #1e293b; border: 1px solid #334155; padding: 2px 7px; border-radius: 6px;
      font-size: 11px; text-decoration: none; color: #f8fafc; display: inline-flex; align-items: center; gap: 4px;
    }}
    .token-pill:hover {{ border-color: var(--accent); color: var(--accent); }}
    .token-gain {{ font-weight: 700; color: #34d399; }}

    #toast {{
      position: fixed; bottom: 24px; right: 24px; background: #10b981; color: #042f2e;
      padding: 10px 18px; border-radius: 8px; font-weight: 700; font-size: 13px; display: none;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.5); z-index: 9999;
    }}
  </style>
</head>
<body>

<div class="container">
  <header>
    <div>
      <h1>
        🎯 Smart Money & Token Live Radar
        <span class="badge-method">Live On-Chain Engine</span>
      </h1>
      <div class="subtitle">
        Membedah Dompet Bermodal Riil vs Bot Dust, serta Memverifikasi <strong>Token yang Masih Hidup & Aktif di DEX Hari Ini</strong>.
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn-action" onclick="copyRealJson()">📋 Salin JSON Smart Money Riil</button>
      <button class="btn-action" onclick="exportCsv()">📥 Ekspor CSV</button>
    </div>
  </header>

  <!-- Main Navigation Switcher -->
  <div class="main-nav">
    <button class="nav-btn active" id="view-wallets-btn" onclick="switchView('wallets')">
      👥 Dompet Smart Money ({len(profiles)})
    </button>
    <button class="nav-btn" id="view-tokens-btn" onclick="switchView('tokens')">
      🔥 Token Masih Aktif Hari Ini ({len(active_tokens)})
    </button>
  </div>

  <!-- Explanation Banner -->
  <div class="banner-warning" id="banner-explanation">
    <div style="font-size: 20px;">💡</div>
    <div>
      <strong>Mengapa ada dompet yang win rate-nya 100% tapi profit di GMGN hanya $0.00xx?</strong><br>
      Dompet seperti <code>7nwPXZ...</code> hanya beli receh senilai <strong>$0.0009 – $0.04</strong>. Kenaikan 20x menghasilkan profit riil cuma 1–2 sen. Ini adalah ciri khas <em>Micro-Dust / Sybil Bot</em>. Gunakan tab <strong>⭐ Real Smart Capital</strong> untuk menyaring trader bermodal nyata ($10 – $500+).
    </div>
  </div>

  <!-- Stats Grid -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Real Smart Capital Wallets</div>
      <div class="stat-val" style="color:var(--green);">{real_count} Dompet</div>
      <div class="stat-sub" style="color:var(--green)">Modal beli $10 – $500+ per token</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Token Masih Aktif Hari Ini</div>
      <div class="stat-val" style="color:var(--accent);">{len(active_tokens)} Token</div>
      <div class="stat-sub" style="color:var(--accent)">4 Token Market Cap $370K - $1.14M</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Micro-Dust / Sybil Bot Tereliminasi</div>
      <div class="stat-val" style="color:var(--red);">{dust_count} Dompet</div>
      <div class="stat-sub" style="color:var(--red)">Modal &lt; $1.00 (profit semu $0.00xx)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Sampel Transaksi</div>
      <div class="stat-val">903.380 tx</div>
      <div class="stat-sub">Dari 586 Mint Terdata</div>
    </div>
  </div>

  <!-- SECTION 1: WALLET TABLE -->
  <div id="section-wallets">
    <div class="controls">
      <input type="text" id="walletSearchInput" class="search-input" placeholder="Cari alamat wallet atau token..." oninput="filterWallets()">
      
      <div style="display: flex; gap: 6px;">
        <button class="tab-btn active" id="tab-real" onclick="setWalletFilter('real')">⭐ Real Smart Capital (Modal Riil)</button>
        <button class="tab-btn" id="tab-all" onclick="setWalletFilter('all')">Semua ({len(profiles)})</button>
        <button class="tab-btn" id="tab-dust" onclick="setWalletFilter('dust')">⚠️ Micro-Dust Bot ({dust_count})</button>
        <button class="tab-btn" id="tab-100" onclick="setWalletFilter('100')">100% Win Rate</button>
      </div>
    </div>

    <div class="table-container">
      <table id="walletTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Alamat Dompet Solana</th>
            <th>Klasifikasi Modal</th>
            <th>Median Modal Beli (USD)</th>
            <th>Estimasi Profit Riil (USD)</th>
            <th>Win Rate (&ge;2x)</th>
            <th>Token Pemenang Awal (Klik GMGN)</th>
            <th>Karakteristik & Kecepatan</th>
          </tr>
        </thead>
        <tbody>
          {wallet_tbody}
        </tbody>
      </table>
    </div>
  </div>

  <!-- SECTION 2: ACTIVE TOKENS TABLE -->
  <div id="section-tokens" style="display: none;">
    <div class="controls">
      <input type="text" id="tokenSearchInput" class="search-input" placeholder="Cari nama token, simbol, atau mint..." oninput="filterTokens()">
      
      <div style="display: flex; gap: 6px;">
        <button class="tab-btn active" id="tab-token-all" onclick="setTokenFilter('all')">Semua Aktif ({len(active_tokens)})</button>
        <button class="tab-btn" id="tab-token-hot" onclick="setTokenFilter('hot')">🔥 Sangat Aktif ({sangat_aktif})</button>
        <button class="tab-btn" id="tab-token-mc" onclick="setTokenFilter('mc')">💎 MC &gt; $100K</button>
      </div>
    </div>

    <div class="table-container">
      <table id="tokenTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Token & Simbol</th>
            <th>Status Live</th>
            <th>Market Cap Live</th>
            <th>Volume 24 Jam</th>
            <th>Likuiditas USD</th>
            <th>Transaksi 24J</th>
            <th>Aksi & Link Cepat</th>
          </tr>
        </thead>
        <tbody>
          {token_tbody}
        </tbody>
      </table>
    </div>
  </div>

</div>

<div id="toast">Notifikasi</div>

<script>
  const realSmartWallets = {real_json_str};
  let currentWalletFilter = 'real';
  let currentTokenFilter = 'all';

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

  function copyRealJson() {{
    copyText(JSON.stringify(realSmartWallets, null, 2), 'JSON Smart Money Riil disalin!');
  }}

  function switchView(view) {{
    const secWallets = document.getElementById('section-wallets');
    const secTokens = document.getElementById('section-tokens');
    const btnWallets = document.getElementById('view-wallets-btn');
    const btnTokens = document.getElementById('view-tokens-btn');

    if (view === 'wallets') {{
      secWallets.style.display = 'block';
      secTokens.style.display = 'none';
      btnWallets.classList.add('active');
      btnTokens.classList.remove('active');
    }} else {{
      secWallets.style.display = 'none';
      secTokens.style.display = 'block';
      btnWallets.classList.remove('active');
      btnTokens.classList.add('active');
    }}
  }}

  function setWalletFilter(type) {{
    currentWalletFilter = type;
    document.querySelectorAll('#section-wallets .tab-btn').forEach(b => b.classList.remove('active'));
    if (type === 'real') document.getElementById('tab-real').classList.add('active');
    else if (type === 'all') document.getElementById('tab-all').classList.add('active');
    else if (type === 'dust') document.getElementById('tab-dust').classList.add('active');
    else if (type === '100') document.getElementById('tab-100').classList.add('active');
    filterWallets();
  }}

  function filterWallets() {{
    const query = document.getElementById('walletSearchInput').value.toLowerCase();
    const rows = document.querySelectorAll('.wallet-row');

    rows.forEach(r => {{
      const wallet = r.getAttribute('data-wallet').toLowerCase();
      const cat = r.getAttribute('data-cat');
      const winrate = parseFloat(r.getAttribute('data-winrate') || 0);
      const text = r.innerText.toLowerCase();

      let matchFilter = true;
      if (currentWalletFilter === 'real' && cat !== 'REAL_SMART_MONEY') matchFilter = false;
      if (currentWalletFilter === 'dust' && cat !== 'DUST_SYBIL_BOT') matchFilter = false;
      if (currentWalletFilter === '100' && winrate < 99.9) matchFilter = false;

      const matchSearch = text.includes(query) || wallet.includes(query);
      r.style.display = (matchFilter && matchSearch) ? '' : 'none';
    }});
  }}

  function setTokenFilter(type) {{
    currentTokenFilter = type;
    document.querySelectorAll('#section-tokens .tab-btn').forEach(b => b.classList.remove('active'));
    if (type === 'all') document.getElementById('tab-token-all').classList.add('active');
    else if (type === 'hot') document.getElementById('tab-token-hot').classList.add('active');
    else if (type === 'mc') document.getElementById('tab-token-mc').classList.add('active');
    filterTokens();
  }}

  function filterTokens() {{
    const query = document.getElementById('tokenSearchInput').value.toLowerCase();
    const rows = document.querySelectorAll('.token-row');

    rows.forEach(r => {{
      const sym = r.getAttribute('data-sym');
      const name = r.getAttribute('data-name');
      const mint = r.getAttribute('data-mint').toLowerCase();
      const mc = parseFloat(r.getAttribute('data-mc') || 0);
      const vol = parseFloat(r.getAttribute('data-vol') || 0);

      let matchFilter = true;
      if (currentTokenFilter === 'hot' && vol < 1000) matchFilter = false;
      if (currentTokenFilter === 'mc' && mc < 100000) matchFilter = false;

      const matchSearch = sym.includes(query) || name.includes(query) || mint.includes(query);
      r.style.display = (matchFilter && matchSearch) ? '' : 'none';
    }});
  }}

  function exportCsv() {{
    const isTokens = document.getElementById('section-tokens').style.display !== 'none';
    if (isTokens) {{
      const rows = document.querySelectorAll('#tokenTable tbody tr');
      let csv = 'Rank,Symbol,Name,MC_USD,Vol24h_USD,Liq_USD,Txns24h,Mint\\n';
      rows.forEach(r => {{
        if (r.style.display !== 'none') {{
          const cells = r.querySelectorAll('td');
          const rank = cells[0].innerText.trim();
          const symName = cells[1].innerText.split('\\n');
          const mc = r.getAttribute('data-mc');
          const vol = r.getAttribute('data-vol');
          const liq = cells[5].innerText.trim();
          const tx = cells[6].innerText.trim();
          const mint = r.getAttribute('data-mint');
          csv += `${{rank}},"${{symName[0]}}","${{symName[1]}}",${{mc}},${{vol}},"${{liq}}","${{tx}}",${{mint}}\\n`;
        }}
      }});
      downloadFile(csv, 'active-tokens-today.csv');
    }} else {{
      const rows = document.querySelectorAll('#walletTable tbody tr');
      let csv = 'Rank,Wallet,Category,MedBuyUSD,EstProfitUSD,WinRate2x\\n';
      rows.forEach(r => {{
        if (r.style.display !== 'none') {{
          const cells = r.querySelectorAll('td');
          const rank = cells[0].innerText.trim();
          const wallet = r.getAttribute('data-wallet');
          const cat = r.getAttribute('data-cat');
          const medusd = r.getAttribute('data-medusd');
          const estprofit = cells[4].innerText.split('\\n')[0].trim();
          const winrate = r.getAttribute('data-winrate');
          csv += `${{rank}},"${{wallet}}",${{cat}},${{medusd}},"${{estprofit}}",${{winrate}}%\\n`;
        }}
      }});
      downloadFile(csv, 'smart-money-wallets.csv');
    }}
  }}

  function downloadFile(content, fileName) {{
    const blob = new Blob([content], {{ type: 'text/csv' }});
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  }}

  document.addEventListener('DOMContentLoaded', () => {{
    filterWallets();
  }});
</script>

</body>
</html>
"""

    with open(DIST_HTML, 'w') as f:
        f.write(html)
    with open(REPORT_HTML, 'w') as f:
        f.write(html)

    print("Dashboard terpadu berhasil dibuat!")
    print(f"- {DIST_HTML}")
    print(f"- {REPORT_HTML}")

if __name__ == '__main__':
    main()
