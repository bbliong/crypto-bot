import json
import glob
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# Load all signals from ledger and backups
files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/*.jsonl")

signals = []
seen_tx = set()
for f in files:
    with open(f) as fp:
        for line in fp:
            if not line.strip(): continue
            try:
                obj = json.loads(line)
                sig = obj.get("details", {}).get("signal")
                if sig and sig.get("txHash") and sig.get("txHash") not in seen_tx:
                    seen_tx.add(sig.get("txHash"))
                    ts = sig.get("timestamp", 0)
                    if ts > 1e11: ts /= 1000
                    sig["timestamp"] = int(ts)
                    signals.append(sig)
            except: pass

signals.sort(key=lambda s: s.get("timestamp", 0))

tokens = defaultdict(list)
for s in signals:
    m = s.get("mint")
    if m: tokens[m].append(s)

detailed_token_sells = []

for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    sells = [s for s in sig_list if s.get("action") == "sell"]
    if not buys or not sells: continue

    fb = buys[0]
    p_in = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if not (is_gz and p_in <= 0.000020): continue

    t_entry = fb.get("timestamp", 0)
    cum_sell = 0.0
    sell_steps = []

    for s in sells:
        ts = s.get("timestamp", 0)
        dt = ts - t_entry
        t_amt = s.get("tokenAmount", 0.0)
        r_h = s.get("remainingHolding", 0.0)
        tot = t_amt + r_h
        pct = (t_amt / tot * 100.0) if tot > 0 else 0.0
        cum_sell += pct
        p_sell = s.get("priceUsd", 0.0)
        gain_chart = ((p_sell - p_in) / p_in * 100.0) if p_in > 0 else 0.0

        sell_steps.append({
            "dt_sec": dt,
            "pct": pct,
            "cum_pct": cum_sell,
            "p_sell": p_sell,
            "gain_chart": gain_chart
        })

    detailed_token_sells.append({
        "symbol": fb.get("symbol", "UNKNOWN"),
        "mint": m,
        "entry_time_wib": datetime.fromtimestamp(t_entry, tz=wib).strftime("%H:%M:%S"),
        "entry_ts": t_entry,
        "entry_p": p_in,
        "sell_steps": sell_steps
    })

# Urutkan dari token terbaru ke terlama
detailed_token_sells.sort(key=lambda x: x["entry_ts"], reverse=True)

print(f"Total token Ground-Zero dengan sell berurutan: {len(detailed_token_sells)}")
print("\n" + "=" * 120)
print("DETAIL URUTAN SELL TARGET PER KOIN (WAKTU DETIK KEBERAPA vs PERSENTASE SELL TARGET)")
print("=" * 120)

for idx, t in enumerate(detailed_token_sells[:15], 1):
    sym = t["symbol"]
    m_short = t["mint"][:10]
    t_in = t["entry_time_wib"]
    p_in = t["entry_p"]
    print(f"\n🪙 {idx}. TOKEN: {sym} (Mint: {m_short}...) | Buy Masuk: {t_in} WIB @ ${p_in:.8f}")
    print(f"   {'Urutan':<12} | {'Detik (Jeda)':<15} | {'Porsi Sell Transaksi':<22} | {'Total Kumulatif Sell':<22} | {'Kenaikan Harga (Chart)':<22}")
    print("   " + "-" * 98)
    for s_idx, st in enumerate(t["sell_steps"][:5], 1):
        dt_str = f"detik ke +{st['dt_sec']:2d}s"
        porsi_str = f"{st['pct']:4.1f}% bag"
        cum_str = f"{st['cum_pct']:4.1f}% bag"
        chart_str = f"{st['gain_chart']:+6.1f}% @ ${st['p_sell']:.8f}"
        
        # Tag pemicu
        tag = ""
        if st['cum_pct'] >= 15.0:
            tag = " 🎯 [TRIGGER FULL EXIT S4/S6]"
        elif st['cum_pct'] >= 5.0:
            tag = " ⚡ [TRIGGER STAGE 1 TP 50%]"
            
        print(f"   Sell #{s_idx:<6} | {dt_str:<15} | {porsi_str:<22} | {cum_str:<22} | {chart_str:<22}{tag}")

    if len(t["sell_steps"]) > 5:
        print(f"   ... ({len(t['sell_steps']) - 5} sell berikutnya tidak ditampilkan)")

# Statistik agregat
s1_times = [t["sell_steps"][0]["dt_sec"] for t in detailed_token_sells if len(t["sell_steps"]) >= 1]
s1_pcts = [t["sell_steps"][0]["pct"] for t in detailed_token_sells if len(t["sell_steps"]) >= 1]
s1_gains = [t["sell_steps"][0]["gain_chart"] for t in detailed_token_sells if len(t["sell_steps"]) >= 1]

s2_times = [t["sell_steps"][1]["dt_sec"] for t in detailed_token_sells if len(t["sell_steps"]) >= 2]
s2_cums = [t["sell_steps"][1]["cum_pct"] for t in detailed_token_sells if len(t["sell_steps"]) >= 2]
s2_gains = [t["sell_steps"][1]["gain_chart"] for t in detailed_token_sells if len(t["sell_steps"]) >= 2]

print("\n" + "=" * 90)
print("STATISTIK AGREGAT SELL #1 vs SELL #2 DARI 223 TOKEN GROUND ZERO:")
print("=" * 90)
print(f"1. TRANSAKSI JUAL PERTAMA (SELL #1):")
print(f"   • Waktu Terjadi       : Rata-rata detik ke +{sum(s1_times)/len(s1_times):.1f}s (Median: detik ke +{sorted(s1_times)[len(s1_times)//2]}s)")
print(f"   • Porsi yang Dijual   : Rata-rata {sum(s1_pcts)/len(s1_pcts):.1f}% bag (Median: {sorted(s1_pcts)[len(s1_pcts)//2]:.1f}% bag)")
print(f"   • Kenaikan Harga Chart: Rata-rata +{sum(s1_gains)/len(s1_gains):.1f}% (Median: +{sorted(s1_gains)[len(s1_gains)//2]:.1f}%)")

print(f"\n2. TRANSAKSI JUAL KEDUA (SELL #2) - Tercapai pada {len(s2_times)}/{len(detailed_token_sells)} koin ({len(s2_times)/len(detailed_token_sells)*100:.1f}%):")
print(f"   • Waktu Terjadi       : Rata-rata detik ke +{sum(s2_times)/len(s2_times):.1f}s (Median: detik ke +{sorted(s2_times)[len(s2_times)//2]}s)")
print(f"   • Total Akumulasi Jual: Rata-rata {sum(s2_cums)/len(s2_cums):.1f}% bag (Median: {sorted(s2_cums)[len(s2_cums)//2]:.1f}% bag)")
print(f"   • Kenaikan Harga Chart: Rata-rata +{sum(s2_gains)/len(s2_gains):.1f}% (Median: +{sorted(s2_gains)[len(s2_gains)//2]:.1f}%)")

