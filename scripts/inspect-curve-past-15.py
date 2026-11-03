import json
import glob
from collections import defaultdict
from datetime import datetime, timezone, timedelta

files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/*.jsonl")

signals = []
seen = set()
for f in files:
    with open(f) as fp:
        for line in fp:
            if not line.strip(): continue
            try:
                obj = json.loads(line)
                sig = obj.get("details", {}).get("signal")
                if sig and sig.get("txHash") and sig.get("txHash") not in seen:
                    seen.add(sig.get("txHash"))
                    ts = sig.get("timestamp", 0)
                    if ts > 1e11: ts /= 1000
                    sig["timestamp"] = ts
                    signals.append(sig)
            except: pass

signals.sort(key=lambda s: s.get("timestamp", 0))

tokens = defaultdict(list)
for s in signals:
    m = s.get("mint")
    if m: tokens[m].append(s)

# Analyze tokens that reached at least 15% sell
reachers = []
for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    if not buys: continue
    fb = buys[0]
    p_in = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if not (is_gz and p_in <= 0.000020): continue

    # Track prices at 5%, 10%, 15%, 20%, 25%, 30%
    cum_sell = 0.0
    p_at = {}
    reached_th = set()

    for s in sig_list:
        if s.get("action") == "sell":
            t_amt = s.get("tokenAmount", 0.0)
            r_hold = s.get("remainingHolding", 0.0)
            tot_before = r_hold + t_amt
            ratio_pct = (t_amt / tot_before * 100.0) if tot_before > 0 else 0.0
            cum_sell += ratio_pct
            p = s.get("priceUsd", 0.0)

            for th in [5, 10, 15, 20, 25, 30]:
                if cum_sell >= th and th not in reached_th:
                    reached_th.add(th)
                    p_at[th] = p

    if 15 in p_at:
        reachers.append({
            "symbol": fb.get("symbol", "UNKNOWN"),
            "mint": m,
            "entry_p": p_in,
            "p_5": p_at.get(5),
            "p_10": p_at.get(10),
            "p_15": p_at.get(15),
            "p_20": p_at.get(20),
            "p_25": p_at.get(25),
            "reached_20": 20 in p_at,
            "reached_25": 25 in p_at
        })

print(f"Total token yang mencapai threshold 15%: {len(reachers)}")
print(f"Dari {len(reachers)} token tersebut:")
print(f"  • Berhasil lanjut sampai >= 20% : {sum(1 for r in reachers if r['reached_20'])} token ({sum(1 for r in reachers if r['reached_20'])/len(reachers)*100:.1f}%)")
print(f"  • RUGPULL / BERHENTI sebelum 20%: {sum(1 for r in reachers if not r['reached_20'])} token ({sum(1 for r in reachers if not r['reached_20'])/len(reachers)*100:.1f}%)")
print(f"  • Berhasil lanjut sampai >= 25% : {sum(1 for r in reachers if r['reached_25'])} token ({sum(1 for r in reachers if r['reached_25'])/len(reachers)*100:.1f}%)")

# Untuk yang berhasil lanjut ke 20%, apakah harganya LEBIH TINGGI atau LEBIH RENDAH dibanding harga di 15%?
price_higher_at_20 = 0
price_lower_at_20 = 0
diffs_pct = []

for r in reachers:
    if r["reached_20"]:
        diff = (r["p_20"] - r["p_15"]) / r["p_15"] * 100.0
        diffs_pct.append(diff)
        if diff > 0:
            price_higher_at_20 += 1
        else:
            price_lower_at_20 += 1

print("\n" + "=" * 80)
print("ANALISIS HARGA PADA TOKEN YANG BERHASIL CAPAI 20%:")
print(f"  • Harga di 20% LEBIH TINGGI daripada 15% : {price_higher_at_20} token")
print(f"  • Harga di 20% LEBIH RENDAH (Dumping)    : {price_lower_at_20} token")
if diffs_pct:
    avg_diff = sum(diffs_pct) / len(diffs_pct)
    print(f"  • Rata-rata perubahan harga (15% -> 20%): {avg_diff:+.2f}%")
