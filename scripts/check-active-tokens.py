#!/usr/bin/env python3
import json
import urllib.request
import time
import glob
import os
from collections import defaultdict

BASE_DIR = '/home/bbliong/project/crypto-bot'

def main():
    # 1. Kumpulkan semua mint yang ada di research dan profit4
    print("Mengumpulkan semua mint dari research dan profit4...")
    all_mints = set()
    
    # Dari smart-money curation
    try:
        with open(os.path.join(BASE_DIR, 'reports/smart-money-curation/smart-money-wallets.json')) as f:
            wallets = json.load(f)
        for w in wallets:
            for entry in w.get('win_entries', []):
                all_mints.add(entry['mint'])
    except Exception as e:
        print("Error loading curation:", e)

    # Dari token-summary.jsonl
    for p in glob.glob(os.path.join(BASE_DIR, 'research/**/token-summary.jsonl'), recursive=True):
        with open(p) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    t = json.loads(line)
                    m = t.get('mint')
                    if m: all_mints.add(m)
                except: pass

    # Dari profit4 transfers
    for p in glob.glob(os.path.join(BASE_DIR, 'data/profit4-watch/**/transfers.jsonl'), recursive=True):
        with open(p) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    t = json.loads(line)
                    m = t.get('mint')
                    if m: all_mints.add(m)
                except: pass

    mints_list = sorted(list(all_mints))
    print(f"Total mints terdaftar di database kita: {len(mints_list)}")

    # 2. Cek ke DexScreener API secara batch (30 token per request)
    chunks = [mints_list[i:i+30] for i in range(0, len(mints_list), 30)]
    print(f"Mengirim {len(chunks)} batch request ke DexScreener API...")

    active_pairs = []
    for idx, chunk in enumerate(chunks):
        chunk_str = ",".join(chunk)
        url = f"https://api.dexscreener.com/latest/dex/tokens/{chunk_str}"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                pairs = data.get('pairs') or []
                if pairs:
                    active_pairs.extend(pairs)
        except Exception as e:
            print(f"Batch {idx+1}/{len(chunks)} error: {e}")
        time.sleep(0.3)

    print(f"\nSelesai pengecekan DexScreener. Ditemukan {len(active_pairs)} pairs aktif!")

    # 3. Kelompokkan per mint (ambil pair dengan likuiditas / volume terbesar jika ada multi pair)
    tokens_by_mint = defaultdict(list)
    for p in active_pairs:
        base = p.get('baseToken', {})
        addr = base.get('address')
        if addr:
            tokens_by_mint[addr].append(p)

    active_tokens = []
    for mint, pairs in tokens_by_mint.items():
        # sort by liquidity desc
        pairs.sort(key=lambda x: (x.get('liquidity', {}) or {}).get('usd', 0) or 0, reverse=True)
        best = pairs[0]
        base = best.get('baseToken', {})
        quote = best.get('quoteToken', {})
        liq = (best.get('liquidity', {}) or {}).get('usd', 0) or 0
        vol24 = (best.get('volume', {}) or {}).get('h24', 0) or 0
        mc = best.get('marketCap', 0) or 0
        fdv = best.get('fdv', 0) or 0
        txns24 = (best.get('txns', {}) or {}).get('h24', {}) or {}
        buys24 = txns24.get('buys', 0) or 0
        sells24 = txns24.get('sells', 0) or 0
        price = best.get('priceUsd', '0')
        dex = best.get('dexId', '')
        url = best.get('url', '')

        # Kategori keaktifan:
        # HIGH_ACTIVE: Volume 24h > $1,000 dan Liq > $5,000
        # MODERATE_ACTIVE: Volume 24h > $100 atau Liq > $1,000
        # LOW_OR_ZOMBIE: Volume 24h < $100
        if vol24 >= 1000 and liq >= 2000:
            status = "SANGAT_AKTIF"
        elif vol24 >= 50 or liq >= 500:
            status = "MASIH_BERTAHAN"
        else:
            status = "ZOMBIE_RENDAH"

        active_tokens.append({
            'mint': mint,
            'name': base.get('name'),
            'symbol': base.get('symbol'),
            'status': status,
            'dex': dex,
            'price_usd': float(price) if price else 0.0,
            'liquidity_usd': round(liq, 2),
            'volume_24h': round(vol24, 2),
            'market_cap': round(mc or fdv, 2),
            'txns_24h': buys24 + sells24,
            'buys_24h': buys24,
            'sells_24h': sells24,
            'url': url
        })

    # Sort berdasarkan volume 24h
    active_tokens.sort(key=lambda x: (x['volume_24h'], x['liquidity_usd']), reverse=True)

    print(f"\nRingkasan Status Keaktifan:")
    print(f"- Total token yang terdaftar pairs di DEX: {len(active_tokens)}")
    sangat_aktif = [t for t in active_tokens if t['status'] == 'SANGAT_AKTIF']
    masih_ada = [t for t in active_tokens if t['status'] == 'MASIH_BERTAHAN']
    zombie = [t for t in active_tokens if t['status'] == 'ZOMBIE_RENDAH']
    print(f"- Sangat Aktif (Vol > $1k, Liq > $2k): {len(sangat_aktif)}")
    print(f"- Masih Bertahan (Vol $50 - $1k): {len(masih_ada)}")
    print(f"- Zombie/Mati Suri (Vol < $50): {len(zombie)}")

    print("\n--- TOP TOKEN YANG MASIH AKTIF HARI INI ---")
    for t in active_tokens[:15]:
        print(f"[{t['status']}] {t['symbol']} ({t['name']})")
        print(f"  Mint: {t['mint']}")
        print(f"  MC: ${t['market_cap']:,.0f} | 24h Vol: ${t['volume_24h']:,.0f} | Liq: ${t['liquidity_usd']:,.0f} | Txns 24h: {t['txns_24h']}")
        print(f"  Dex: {t['dex']} | DexScreener: {t['url']}")
        print()

    # Simpan laporan json
    out_path = os.path.join(BASE_DIR, 'reports/smart-money-curation/active-tokens-today.json')
    with open(out_path, 'w') as f:
        json.dump({
            'checked_at': time.strftime('%Y-%m-%d %H:%M:%S WIB'),
            'total_checked': len(mints_list),
            'total_found_on_dex': len(active_tokens),
            'active_count': len(sangat_aktif),
            'tokens': active_tokens
        }, f, indent=2)
    print(f"Hasil disimpan di: {out_path}")

if __name__ == '__main__':
    main()
