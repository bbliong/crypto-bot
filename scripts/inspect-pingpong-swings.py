import subprocess
import json
from collections import defaultdict

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 12:00:00", "--until=2026-11-08 13:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

# Ambil trade koin Coin 5 (BUxR9iBg...)
coin_events = []
for line in out.splitlines():
    if "BUxR9iBgtbt19tSfNdwP7epsGNDCrJBdcdyEMn71Y5iJ" in line and "[GMGN WS RAW ITEM]" in line:
        try:
            ev_type = "buy" if "Event: buy" in line else "sell"
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            coin_events.append({
                "type": ev_type,
                "ts": int(d.get("t")),
                "usd": float(d.get("au") or 0),
                "sol": float(d.get("qa") or 0),
                "price": float(d.get("pu") or 0),
                "sell_ratio": float(d.get("bu") or 0),
                "remaining": float(d.get("b") or 0)
            })
        except:
            pass

coin_events.sort(key=lambda x: x["ts"])
print(f"Total events for Coin 5: {len(coin_events)}")

# Print 30 event pertama untuk melihat pola ayunan harga (swing)
print("\n=== POLA PING-PONG TRANSAKSI WHALE PADA KOIN COIN 5 ===")
print(f"{'No':<3} | {'Tipe':<4} | {'Jeda (s)':<8} | {'Modal USD':<11} | {'Harga Spot (USD)':<18} | {'Perubahan % dari Prev'}")
print("-" * 75)

prev_p = None
t0 = coin_events[0]["ts"] if coin_events else 0

for i, e in enumerate(coin_events[:30], 1):
    dt = e["ts"] - t0
    chg_str = "-"
    if prev_p and prev_p > 0:
        chg = ((e["price"] - prev_p) / prev_p) * 100
        chg_str = f"{chg:+.1f}%"
    
    sol_usd = f"${e['usd']:.1f} ({e['sol']:.1f}S)"
    p_str = f"${e['price']:.8f}"
    
    print(f"{i:<3} | {e['type'].upper():<4} | +{dt:>4}s   | {sol_usd:<11} | {p_str:<18} | {chg_str}")
    prev_p = e["price"]
