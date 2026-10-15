#!/usr/bin/env python3
"""
Tambahkan tab/tabel 'Token Masih Aktif Hari Ini' ke dist/smart-money-wallets.html
"""

import json
import os

BASE_DIR = '/home/bbliong/project/crypto-bot'
HTML_PATH = os.path.join(BASE_DIR, 'dist/smart-money-wallets.html')
REPORT_HTML_PATH = os.path.join(BASE_DIR, 'reports/smart-money-curation/smart-money-wallets.html')
ACTIVE_JSON = os.path.join(BASE_DIR, 'reports/smart-money-curation/active-tokens-today.json')

with open(ACTIVE_JSON) as f:
    active_data = json.load(f)

tokens = active_data['tokens']
# Sort by market cap / volume desc
tokens.sort(key=lambda x: (x['market_cap'], x['volume_24h']), reverse=True)

active_cards_html = []
for t in tokens:
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

    status_badge = '<span style="background:rgba(16,185,129,0.2); color:#10b981; padding:2px 8px; border-radius:4px; font-weight:700; font-size:11px;">🔥 SANGAT AKTIF</span>' if status == 'SANGAT_AKTIF' else '<span style="background:rgba(56,189,248,0.2); color:#38bdf8; padding:2px 8px; border-radius:4px; font-weight:700; font-size:11px;">⚡ MASIH AKTIF</span>'

    active_cards_html.append(f"""
      <tr class="token-row" data-mc="{mc}" data-vol="{vol}">
        <td style="font-weight:700;">
          <div style="font-size:14px; color:#fff;">{sym}</div>
          <div style="font-size:12px; color:var(--text-muted);">{name}</div>
        </td>
        <td>{status_badge}</td>
        <td style="font-weight:700; color:{'#10b981' if mc >= 100000 else '#f3f4f6'}; font-size:14px;">
          ${mc:,.0f}
        </td>
        <td style="font-weight:700; color:#38bdf8; font-size:14px;">
          ${vol:,.0f}
        </td>
        <td style="color:#cbd5e1;">${liq:,.0f}</td>
        <td style="color:#cbd5e1;">{txns:,} tx</td>
        <td>
          <div style="display:flex; gap:6px;">
            <a href="{url}" target="_blank" class="link-badge" style="background:#0284c7; color:#fff;">📈 DexScreener</a>
            <a href="{gmgn_url}" target="_blank" class="link-badge link-gmgn">🔗 GMGN</a>
          </div>
          <div style="font-family:var(--font-mono); font-size:11px; color:var(--text-muted); margin-top:4px;">
            {mint[:6]}...{mint[-6:]}
          </div>
        </td>
      </tr>
    """)

print(f"Generated {len(active_cards_html)} active token rows.")
