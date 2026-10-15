#!/usr/bin/env python3
"""
update-smart-money-with-capital.py

Mengekstrak dan membedah Smart Money dengan memfilter modal riil (Real Capital)
vs Micro-Dust / Sybil Bot. Menghitung:
- Median modal beli (USD)
- Estimasi real profit (USD)
- Win rate token (>=2x)
- Pemisahan kategori: REAL_SMART_MONEY vs MICRO_DUST_BOT
"""

import os
import glob
import json
import time
from collections import defaultdict

BASE_DIR = '/home/bbliong/project/crypto-bot'
REPORT_DIR = os.path.join(BASE_DIR, 'reports/smart-money-curation')
DIST_HTML = os.path.join(BASE_DIR, 'dist/smart-money-wallets.html')
REPORT_HTML = os.path.join(REPORT_DIR, 'smart-money-wallets.html')

def main():
    print("=== [1/5] Load Metadata & Transaksi ===")
    symbols = {}
    for path in glob.glob(os.path.join(BASE_DIR, 'research/**/token-summary.jsonl'), recursive=True):
        with open(path) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    t = json.loads(line)
                    m = t.get('mint')
                    sym = t.get('metadata', {}).get('symbol') or t.get('fields', {}).get('symbol')
                    if m and sym: symbols[m] = sym
                except Exception: pass

    for path in glob.glob(os.path.join(BASE_DIR, 'data/profit4-watch/**/transfers.jsonl'), recursive=True):
        with open(path) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    t = json.loads(line)
                    m = t.get('mint')
                    sym = t.get('symbol')
                    if m and sym: symbols[m] = sym
                except Exception: pass

    trades_by_mint = defaultdict(list)
    raw_wallet_txs = defaultdict(list)

    # Research
    for path in glob.glob(os.path.join(BASE_DIR, 'research/**/trades.jsonl'), recursive=True):
        with open(path) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    t = json.loads(line)
                    m, w, p, s = t.get('mint'), t.get('wallet'), t.get('priceUsd'), t.get('side')
                    ts = t.get('occurredAt') or t.get('observedAt') or (t.get('raw', {}).get('t', 0) * 1000)
                    sig = t.get('signature')
                    usd = t.get('amount') if t.get('amount') else 0
                    if m and w and p and ts:
                        item = (int(ts), s, w, float(p), float(usd) if usd else 0.0, sig)
                        trades_by_mint[m].append(item)
                        raw_wallet_txs[w].append((int(ts), s, m, float(usd) if usd else 0.0))
                except Exception: pass

    # Profit4
    for path in glob.glob(os.path.join(BASE_DIR, 'data/profit4-watch/**/token-trades.jsonl'), recursive=True):
        with open(path) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    t = json.loads(line)
                    m, w, p, s = t.get('mint'), t.get('wallet'), t.get('price'), t.get('side')
                    ts = (t.get('timestamp') or 0) * 1000 or t.get('observedAt')
                    sig = t.get('signature')
                    usd = t.get('usd', 0)
                    if m and w and p and ts:
                        item = (int(ts), s, w, float(p), float(usd) if usd else 0.0, sig)
                        trades_by_mint[m].append(item)
                        raw_wallet_txs[w].append((int(ts), s, m, float(usd) if usd else 0.0))
                except Exception: pass

    print("=== [2/5] Evaluasi Token Pemenang & Early Buyers ===")
    mint_summary = {}
    for m, trades in trades_by_mint.items():
        seen = set()
        deduped = []
        for t in trades:
            ts, s, w, p, usd, sig = t
            key = sig if sig else (ts, w, s, round(p, 8))
            if key not in seen:
                seen.add(key)
                deduped.append(t)
        deduped.sort(key=lambda x: x[0])
        buys = [t for t in deduped if t[1] == 'buy' and t[3] > 0]
        if len(buys) < 3: continue
        first_p = buys[0][3]
        max_p = max(t[3] for t in deduped)
        gain = max_p / first_p if first_p > 0 else 1.0
        mint_summary[m] = {
            'mint': m,
            'symbol': symbols.get(m, m[:8]),
            'gain': gain,
            'first_p': first_p,
            'max_p': max_p,
            'buys': buys,
            'trades': deduped
        }

    winners = {m: d for m, d in mint_summary.items() if d['gain'] >= 2.0}
    print(f"Token pemenang: {len(winners)}")

    # Ekstrak 30 pembeli pertama
    wallet_winner_entries = defaultdict(list)
    for m, wdata in winners.items():
        seen_w = set()
        for b in wdata['buys']:
            ts, s, w, p, usd, sig = b
            if w not in seen_w:
                seen_w.add(w)
                wallet_winner_entries[w].append({
                    'mint': m,
                    'symbol': wdata['symbol'],
                    'token_gain': wdata['gain'],
                    'buy_price': p,
                    'timestamp': ts,
                    'usd': usd
                })
                if len(seen_w) >= 30: break

    repeat_wallets = {w: entries for w, entries in wallet_winner_entries.items() if len(entries) >= 2}
    print(f"Repeat early buyers: {len(repeat_wallets)}")

    print("=== [3/5] Analisis Ukuran Modal, PnL Riil, & Kategori Trader ===")
    wallet_all_tokens = defaultdict(list)
    for m, data in mint_summary.items():
        for b in data['buys']:
            w = b[2]
            if w in repeat_wallets:
                wallet_all_tokens[w].append({
                    'mint': m,
                    'symbol': data['symbol'],
                    'token_gain': data['gain'],
                    'usd': b[4],
                    'price': b[3]
                })

    wallet_profiles = []
    for w, win_entries in repeat_wallets.items():
        all_buys = wallet_all_tokens.get(w, [])
        txs = raw_wallet_txs.get(w, [])
        txs.sort(key=lambda x: x[0])

        deltas = []
        for i in range(1, len(txs)):
            d = (txs[i][0] - txs[i-1][0]) / 1000.0
            if d >= 0: deltas.append(d)

        med_delta = sorted(deltas)[len(deltas)//2] if deltas else 9999.0
        sub_sec_count = sum(1 for d in deltas if d < 1.0)
        sub_sec_ratio = (sub_sec_count / len(deltas)) if deltas else 0.0

        # Modal per transaksi
        usd_buys = [b['usd'] for b in all_buys if b['usd'] > 0]
        if not usd_buys: usd_buys = [0.0]
        usd_buys.sort()
        min_usd = min(usd_buys)
        med_usd = usd_buys[len(usd_buys)//2]
        max_usd = max(usd_buys)
        total_volume = sum(usd_buys)

        # Token metrics
        mints_seen = set()
        token_stats = []
        for b in all_buys:
            if b['mint'] not in mints_seen:
                mints_seen.add(b['mint'])
                token_stats.append(b)

        total_tokens = len(token_stats)
        wins_2x = sum(1 for t in token_stats if t['token_gain'] >= 2.0)
        wins_3x = sum(1 for t in token_stats if t['token_gain'] >= 3.0)
        wins_5x = sum(1 for t in token_stats if t['token_gain'] >= 5.0)
        max_token_gain = max(t['token_gain'] for t in token_stats) if token_stats else 0.0
        win_rate = (wins_2x / total_tokens * 100) if total_tokens else 0.0

        # Estimasi Profit Riil (USD) pada token pemenang
        est_real_profit_usd = 0.0
        for entry in win_entries:
            buy_usd = entry['usd']
            gain = entry['token_gain']
            profit = buy_usd * (gain - 1.0)
            est_real_profit_usd += profit

        # Klasifikasi Kategori Dompet
        if med_usd < 1.0:
            category = "DUST_SYBIL_BOT"
            cat_label = "Micro-Dust / Sybil Bot"
            cat_desc = f"Beli receh (${med_usd:.4f}), profit nominal cuma sen (${est_real_profit_usd:.2f})"
            cat_score_penalty = -4.0
        elif med_usd < 10.0:
            category = "SMALL_RETAIL"
            cat_label = "Small Retail Trader"
            cat_desc = f"Modal kecil (${med_usd:.2f}/buy)"
            cat_score_penalty = 0.0
        else:
            category = "REAL_SMART_MONEY"
            cat_label = "Real Smart Capital"
            cat_desc = f"Modal riil bermakna (${med_usd:.2f}/buy, est profit ${est_real_profit_usd:,.0f})"
            cat_score_penalty = 2.0

        # Bot speed
        if sub_sec_ratio > 0.3:
            speed_tag = "HFT_SNIPER"
        elif med_delta < 5.0:
            speed_tag = "SEMI_AUTO"
        else:
            speed_tag = "MANUAL_HUMAN"

        # Composite Score disesuaikan dengan modal riil!
        base_score = min(3.0, len(win_entries) * 0.7) + (win_rate / 100.0) * 3.0
        capital_score = min(3.0, (med_usd / 50.0) * 2.0)
        final_score = max(1.0, min(10.0, base_score + capital_score + cat_score_penalty))

        wallet_profiles.append({
            'wallet': w,
            'category': category,
            'cat_label': cat_label,
            'speed_tag': speed_tag,
            'score': round(final_score, 2),
            'win_entries_count': len(win_entries),
            'total_tokens': total_tokens,
            'win_rate_2x': round(win_rate, 1),
            'wins_2x': wins_2x,
            'wins_3x': wins_3x,
            'wins_5x': wins_5x,
            'min_buy_usd': round(min_usd, 4),
            'med_buy_usd': round(med_usd, 2),
            'max_buy_usd': round(max_usd, 2),
            'total_volume_usd': round(total_volume, 2),
            'est_profit_usd': round(est_real_profit_usd, 2),
            'max_gain': round(max_token_gain, 1),
            'median_interval_sec': round(med_delta, 1),
            'sub_second_ratio': round(sub_sec_ratio * 100, 1),
            'win_entries': win_entries
        })

    wallet_profiles.sort(key=lambda x: (x['category'] == 'REAL_SMART_MONEY', x['score'], x['med_buy_usd']), reverse=True)

    print("\n=== [4/5] Generate Rich Interactive HTML ===")
    generate_html(wallet_profiles, len(mint_summary), len(winners))

    print("\n=== [5/5] Update JSON & Watchlist ===")
    real_capital_wallets = [w['wallet'] for w in wallet_profiles if w['category'] == 'REAL_SMART_MONEY' and w['win_rate_2x'] >= 50.0]
    out_rec = os.path.join(REPORT_DIR, 'recommended-watchlist.json')
    with open(out_rec, 'w') as f:
        json.dump({
            'updated_at': time.strftime('%Y-%m-%d %H:%M:%S WIB'),
            'description': 'Daftar Smart Money bermodal riil (Real Capital >= $10 - $500+) untuk dashboard-config.json',
            'addresses': real_capital_wallets[:15]
        }, f, indent=2)

    with open(os.path.join(REPORT_DIR, 'smart-money-wallets.json'), 'w') as f:
        json.dump(wallet_profiles, f, indent=2)

    print(f"Selesai! File diperbarui di:")
    print(f" - {DIST_HTML}")
    print(f" - {out_rec}")

def generate_html(profiles, total_mints, total_winners):
    real_count = sum(1 for p in profiles if p['category'] == 'REAL_SMART_MONEY')
    dust_count = sum(1 for p in profiles if p['category'] == 'DUST_SYBIL_BOT')

    html = f"""<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Money vs Micro-Dust Bot Curation — On-Chain Analysis</title>
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
      --purple: #a855f7;
      --purple-bg: rgba(168, 85, 247, 0.15);
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

    /* Alert Banner for Explaining Dust Bots */
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
        🎯 Kurasi Smart Money Wallets: Real Capital vs Dust Bot
        <span class="badge-method">Bedah Modal & Profit Riil</span>
      </h1>
      <div class="subtitle">
        Membedakan <strong>Trader Bermodal Riil ($10 - $500+)</strong> dengan <strong>Bot Dust Receh (&lt;$0.10)</strong> dari 903.380 transaksi on-chain.
      </div>
    </div>
    <div style="display: flex; gap: 8px;">
      <button class="btn-action" onclick="copyRealJson()">📋 Salin JSON Smart Money Riil</button>
      <button class="btn-action" onclick="exportCsv()">📥 Ekspor CSV</button>
    </div>
  </header>

  <!-- Explanation Banner -->
  <div class="banner-warning">
    <div style="font-size: 20px;">💡</div>
    <div>
      <strong>Mengapa ada dompet yang win rate tokennya tinggi tapi profit di GMGN hanya $0.00xx?</strong><br>
      Dompet seperti <code>7nwPXZ...</code> hanya membeli receh sebesar <strong>$0.0009 – $0.04 (sekitar 0.000007 SOL)</strong>. Meskipun tokennya naik 20x (+2000%), profit uang riilnya hanya beberapa sen! Ini adalah karakteristik <em>Micro-Dust / Sybil Bot</em> yang dipakai pembuat token untuk memalsukan jumlah holder. Gunakan filter <strong>⭐ Real Smart Capital</strong> untuk menyaring hanya trader yang mempertaruhkan modal nyata.
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
      <div class="stat-label">Micro-Dust / Sybil Bot Terdeteksi</div>
      <div class="stat-val" style="color:var(--red);">{dust_count} Dompet</div>
      <div class="stat-sub" style="color:var(--red)">Modal &lt; $1.00 (profit semu $0.00xx)</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Token Pemenang Terlacak</div>
      <div class="stat-val">{total_winners} Token</div>
      <div class="stat-sub">Gain kenaikan &ge; 2x hingga ribuan x</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Sampel Transaksi</div>
      <div class="stat-val">903.380 tx</div>
      <div class="stat-sub">Gabungan Research & Profit4</div>
    </div>
  </div>

  <!-- Controls -->
  <div class="controls">
    <input type="text" id="searchInput" class="search-input" placeholder="Cari wallet, token, atau kategori..." oninput="filterTable()">
    
    <div style="display: flex; gap: 6px;">
      <button class="tab-btn active" id="tab-real" onclick="setFilter('real')">⭐ Real Smart Capital (Modal Riil)</button>
      <button class="tab-btn" id="tab-all" onclick="setFilter('all')">Semua ({len(profiles)})</button>
      <button class="tab-btn" id="tab-dust" onclick="setFilter('dust')">⚠️ Micro-Dust Bot ({dust_count})</button>
      <button class="tab-btn" id="tab-100" onclick="setFilter('100')">100% Win Rate</button>
    </div>
  </div>

  <!-- Table -->
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
"""

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

        html += f"""
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
"""

    real_json_str = json.dumps(real_wallets_json, indent=2)

    html += f"""
      </tbody>
    </table>
  </div>
</div>

<div id="toast">Notifikasi</div>

<script>
  const realSmartWallets = {real_json_str};
  let currentFilter = 'real';

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

  function exportCsv() {{
    const rows = document.querySelectorAll('#walletTable tbody tr');
    let csv = 'Rank,Wallet,Category,MedBuyUSD,EstProfitUSD,WinRate2x,Wins,TotalTokens\\n';
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
    if (type === 'real') document.getElementById('tab-real').classList.add('active');
    else if (type === 'all') document.getElementById('tab-all').classList.add('active');
    else if (type === 'dust') document.getElementById('tab-dust').classList.add('active');
    else if (type === '100') document.getElementById('tab-100').classList.add('active');
    filterTable();
  }}

  function filterTable() {{
    const query = document.getElementById('searchInput').value.toLowerCase();
    const rows = document.querySelectorAll('.wallet-row');

    rows.forEach(r => {{
      const wallet = r.getAttribute('data-wallet').toLowerCase();
      const cat = r.getAttribute('data-cat');
      const winrate = parseFloat(r.getAttribute('data-winrate') || 0);
      const text = r.innerText.toLowerCase();

      let matchFilter = true;
      if (currentFilter === 'real' && cat !== 'REAL_SMART_MONEY') matchFilter = false;
      if (currentFilter === 'dust' && cat !== 'DUST_SYBIL_BOT') matchFilter = false;
      if (currentFilter === '100' && winrate < 99.9) matchFilter = false;

      const matchSearch = text.includes(query) || wallet.includes(query);

      r.style.display = (matchFilter && matchSearch) ? '' : 'none';
    }});
  }}

  document.addEventListener('DOMContentLoaded', () => {{
    filterTable();
  }});
</script>

</body>
</html>
"""

    with open(DIST_HTML, 'w') as f:
        f.write(html)
    with open(REPORT_HTML, 'w') as f:
        f.write(html)

if __name__ == '__main__':
    main()
