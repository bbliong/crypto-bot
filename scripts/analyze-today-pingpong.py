import subprocess
import json
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 00:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

# Parse all GMGN WS raw events (buy and sell)
all_events = []
for line in out.splitlines():
    if "[GMGN WS RAW ITEM] Event:" in line and "Raw: " in line:
        try:
            ev_type = "buy" if "Event: buy" in line else "sell"
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            all_events.append({
                "type": ev_type,
                "mint": d.get("a"),
                "sym": d.get("bs"),
                "sol": float(d.get("qa") or 0),
                "usd": float(d.get("au") or 0),
                "tokens": float(d.get("ba") or 0),
                "price": float(d.get("pu") or 0),
                "remaining": float(d.get("b") or 0),
                "sell_ratio": float(d.get("bu") or 0),
                "ts": int(d.get("t") or 0),
                "tx": d.get("h")
            })
        except:
            pass

events_by_mint = defaultdict(list)
for ev in all_events:
    events_by_mint[ev["mint"]].append(ev)

for m in events_by_mint:
    events_by_mint[m].sort(key=lambda x: x["ts"])

print(f"Total Unique Tokens Traded Today: {len(events_by_mint)}")

# Hitung token dengan pingpong
pingpong_list = []
for m, evs in events_by_mint.items():
    buys = [e for e in evs if e["type"] == "buy"]
    sells = [e for e in evs if e["type"] == "sell"]
    dur_sec = (evs[-1]["ts"] - evs[0]["ts"]) if len(evs) > 1 else 0
    sym = evs[0]["sym"]
    pingpong_list.append({
        "sym": sym,
        "mint": m,
        "total": len(evs),
        "buys": len(buys),
        "sells": len(sells),
        "dur_sec": dur_sec,
        "dur_min": dur_sec / 60.0,
        "first_buy_sol": buys[0]["sol"] if buys else 0,
        "events": evs
    })

pingpong_list.sort(key=lambda x: -x["total"])

print("\n" + "=" * 110)
print(f"{'No':<3} | {'Simbol':<10} | {'Total Tx':<9} | {'Buys':<6} | {'Sells':<6} | {'Durasi Main':<16} | {'First Buy SOL':<15} | {'Tipe Token'}")
print("-" * 110)

for i, p in enumerate(pingpong_list, 1):
    tipe = "🏓 PING-PONG INTENSIF" if p["total"] >= 20 else ("⚡ MEDIUM ACTIVITY" if p["total"] >= 5 else "💥 1-WAVE DUMP")
    print(f"{i:<3} | {p['sym']:<10} | {p['total']:<9} | {p['buys']:<6} | {p['sells']:<6} | {p['dur_min']:>5.1f}m ({p['dur_sec']:>4}s) | {p['first_buy_sol']:>5.1f} SOL        | {tipe}")
print("=" * 110)
