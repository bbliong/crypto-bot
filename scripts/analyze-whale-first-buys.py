import json, glob, os
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

files = ["/home/bbliong/project/crypto-bot/data/wallet-follower-events.json"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/wallet-follower-events.json")

events_by_mint = defaultdict(list)
seen_tx = set()
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
                events_by_mint[ev.get("tokenMint")].append({
                    "ts": ts,
                    "dt": dt,
                    "hour": dt.hour,
                    "usd": float(tgt.get("usdAmount") or 0),
                    "price": float(tgt.get("priceUsd") or 0),
                    "sym": ev.get("tokenSymbol")
                })
    except:
        pass

# Ambil HANYA First Buy per Mint
first_buys = []
for mint, evs in events_by_mint.items():
    evs.sort(key=lambda x: x["ts"])
    if evs:
        first_buys.append(evs[0])

print(f"Total Unique Tokens Traded (First Buys): {len(first_buys)}")

hourly_first = defaultdict(lambda: {"large": 0, "small": 0, "mid": 0, "total_large": 0, "total_small": 0})
for fb in first_buys:
    h = fb["hour"]
    usd = fb["usd"]
    if usd >= 500:
        hourly_first[h]["large"] += 1
        hourly_first[h]["total_large"] += usd
    elif usd < 300:
        hourly_first[h]["small"] += 1
        hourly_first[h]["total_small"] += usd
    else:
        hourly_first[h]["mid"] += 1

print("\n=== BREAKDOWN JAM WIB: POLA FIRST BUY (MASUK TOKEN BARU) BESAR VS KECIL ===")
print(f"{'Jam WIB':<15} | {'Tokens Lahir':<12} | {'Masuk Besar (>= $500)':<22} | {'Masuk Kecil (< $300)':<22} | {'Rata2 Masuk Besar'}")
print("-" * 95)

for h in range(24):
    st = hourly_first[h]
    tot = st["large"] + st["small"] + st["mid"]
    jam_str = f"{h:02d}:00 - {h:02d}:59"
    if tot == 0:
        print(f"{jam_str:<15} | {'0':<12} | {'0':<22} | {'0':<22} | -")
        continue
    
    lp = (st["large"] / tot) * 100
    sp = (st["small"] / tot) * 100
    avg_l = st["total_large"] / st["large"] if st["large"] > 0 else 0
    
    l_str = f"{st['large']} ({lp:.1f}%)"
    s_str = f"{st['small']} ({sp:.1f}%)"
    
    print(f"{jam_str:<15} | {tot:<12} | {l_str:<22} | {s_str:<22} | ${avg_l:.1f} USD")
