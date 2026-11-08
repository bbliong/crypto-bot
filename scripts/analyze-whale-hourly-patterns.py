import json, glob, os
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

files = ["/home/bbliong/project/crypto-bot/data/wallet-follower-events.json"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/wallet-follower-events.json")

seen_tx = set()
hourly_stats = defaultdict(lambda: {"large": 0, "small": 0, "mid": 0, "total_usd_large": 0, "total_usd_small": 0, "tokens": set()})

for f in files:
    if not os.path.exists(f): continue
    try:
        with open(f) as fp:
            for ev in json.load(fp):
                tgt = ev.get("target") or {}
                if tgt.get("action") != "BUY": continue
                tx = tgt.get("txHash")
                if tx and tx in seen_tx: continue
                if tx: seen_tx.add(tx)
                
                ts = ev.get("timestamp") or 0
                if ts < 1e12 and ts > 0: ts *= 1000
                if not ts: continue
                
                dt = datetime.fromtimestamp(ts/1000, tz=wib)
                h = dt.hour
                usd = float(tgt.get("usdAmount") or 0)
                if usd <= 0: continue
                
                mint = ev.get("tokenMint")
                hourly_stats[h]["tokens"].add(mint)
                
                if usd >= 500:
                    hourly_stats[h]["large"] += 1
                    hourly_stats[h]["total_usd_large"] += usd
                elif usd < 300:
                    hourly_stats[h]["small"] += 1
                    hourly_stats[h]["total_usd_small"] += usd
                else:
                    hourly_stats[h]["mid"] += 1
    except:
        pass

print("=== BREAKDOWN JAM WIB: POLA WHALE MASUK BESAR (>= $500) vs MASUK KECIL (< $300) ===")
header = f"{'Jam WIB':<15} | {'Total Buys':<10} | {'Besar (>= $500)':<18} | {'Kecil (< $300)':<18} | {'Rata2 Masuk Besar':<18} | {'Status Jam'}"
print(header)
print("-" * 115)

for h in range(24):
    st = hourly_stats[h]
    tot = st["large"] + st["small"] + st["mid"]
    jam_str = f"{h:02d}:00 - {h:02d}:59"
    if tot == 0:
        print(f"{jam_str:<15} | {'0':<10} | {'0':<18} | {'0':<18} | {'-':<18} | 💤 WHALE SLEEP (TIDUR TOTAL)")
        continue
    
    large_pct = (st["large"] / tot) * 100
    small_pct = (st["small"] / tot) * 100
    avg_large = st["total_usd_large"] / st["large"] if st["large"] > 0 else 0
    
    large_str = f"{st['large']} ({large_pct:.1f}%)"
    small_str = f"{st['small']} ({small_pct:.1f}%)"
    avg_large_str = f"${avg_large:.1f} USD"
    
    note = ""
    if tot < 10 and (h in [2, 3, 4, 5, 6]):
        note = "💤 SLEEP / QUIET WINDOW"
    elif large_pct >= 70:
        note = "🔥 PRIME PUMP ZONE (Dominan Pompa Besar)"
    elif small_pct >= 50:
        note = "⚠️ MICRO SCALP / PROBING ZONE"
    else:
        note = "⚡ ACTIVE PUMP & SCALP"
        
    print(f"{jam_str:<15} | {tot:<10} | {large_str:<18} | {small_str:<18} | {avg_large_str:<18} | {note}")
