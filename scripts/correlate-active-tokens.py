#!/usr/bin/env python3
import json

with open('/home/bbliong/project/crypto-bot/reports/smart-money-curation/active-tokens-today.json') as f:
    active_data = json.load(f)

with open('/home/bbliong/project/crypto-bot/reports/smart-money-curation/smart-money-wallets.json') as f:
    wallets = json.load(f)

active_map = {t['mint']: t for t in active_data['tokens']}

print("=== DOMPET SMART MONEY YANG MASUK KE TOKEN-TOKEN YANG MASIH AKTIF HARI INI ===")
found_wallets = []
for w in wallets:
    hit_active = []
    for win in w.get('win_entries', []):
        m = win['mint']
        if m in active_map:
            act = active_map[m]
            hit_active.append({
                'symbol': act['symbol'],
                'name': act['name'],
                'mc': act['market_cap'],
                'vol24': act['volume_24h'],
                'status': act['status'],
                'mint': m
            })
    if hit_active:
        found_wallets.append((w, hit_active))

# Sort by modal beli desc
found_wallets.sort(key=lambda x: (x[0]['category'] == 'REAL_SMART_MONEY', x[0]['med_buy_usd']), reverse=True)

for w, hits in found_wallets:
    cat = w['category']
    med = w['med_buy_usd']
    addr = w['wallet']
    print(f"\n[Wallet {addr[:8]}...{addr[-6:]}] - Kategori: {cat} (Med Buy: ${med})")
    for h in hits:
        print(f"  * Token: {h['symbol']} ({h['name']}) | Status: {h['status']} | MC: ${h['mc']:,.0f} | 24h Vol: ${h['vol24']:,.0f}")
