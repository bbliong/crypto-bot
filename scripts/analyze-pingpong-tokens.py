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
                tx = tgt.get("txHash")
                if tx and tx in seen_tx: continue
                if tx: seen_tx.add(tx)
                ts = ev.get("timestamp") or 0
                if ts < 1e12 and ts > 0: ts *= 1000
                events_by_mint[ev.get("tokenMint")].append({
                    "ts": ts,
                    "action": tgt.get("action"),
                    "usd": float(tgt.get("usdAmount") or 0),
                    "price": float(tgt.get("priceUsd") or 0),
                    "tokens": float(tgt.get("tokenAmount") or 0),
                    "remaining": float(tgt.get("remainingHolding") or 0),
                    "sell_ratio": float(tgt.get("sellRatioPct") or 0),
                    "sym": ev.get("tokenSymbol")
                })
    except:
        pass

# Cari koin-koin dengan transaksi ping-pong (total trade >= 5)
pingpong_tokens = []
single_wave_tokens = []

for m, evs in events_by_mint.items():
    evs.sort(key=lambda x: x["ts"])
    buys = [e for e in evs if e["action"] == "BUY" and e["price"] > 0]
    sells = [e for e in evs if e["action"] == "SELL" and e["price"] > 0]
    
    if len(evs) >= 5 and len(buys) >= 2 and len(sells) >= 2:
        pingpong_tokens.append({
            "mint": m,
            "sym": evs[0]["sym"],
            "total_trades": len(evs),
            "buys_count": len(buys),
            "sells_count": len(sells),
            "events": evs,
            "duration_sec": (evs[-1]["ts"] - evs[0]["ts"]) / 1000 if len(evs) > 1 else 0
        })
    elif buys:
        single_wave_tokens.append({
            "mint": m,
            "sym": evs[0]["sym"],
            "total_trades": len(evs),
            "buys_count": len(buys),
            "sells_count": len(sells),
            "events": evs,
            "duration_sec": (evs[-1]["ts"] - evs[0]["ts"]) / 1000 if len(evs) > 1 else 0
        })

print(f"Total Token yang Dianalisis: {len(events_by_mint)}")
print(f"Total Token Ping-Pong (>= 5 trades, repeat buy/sell): {len(pingpong_tokens)} ({len(pingpong_tokens)/len(events_by_mint)*100:.1f}%)")
print(f"Total Token Single-Wave (Dump langsung kabur): {len(single_wave_tokens)} ({len(single_wave_tokens)/len(events_by_mint)*100:.1f}%)")

# Urutkan ping-pong berdasarkan jumlah trade terbanyak
pingpong_tokens.sort(key=lambda x: -x["total_trades"])

print("\n=== TOP 15 KOIN PING-PONG PALING INTENSIF ===")
print(f"{'No':<3} | {'Simbol':<10} | {'Total Trades':<13} | {'Buys':<6} | {'Sells':<6} | {'Durasi Pingpong':<16} | {'Mint'}")
print("-" * 95)
for i, pt in enumerate(pingpong_tokens[:15], 1):
    dur_min = pt["duration_sec"] / 60
    print(f"{i:<3} | {pt['sym']:<10} | {pt['total_trades']:<13} | {pt['buys_count']:<6} | {pt['sells_count']:<6} | {dur_min:.1f} menit ({pt['duration_sec']:.0f}s) | {pt['mint'][:16]}...")
