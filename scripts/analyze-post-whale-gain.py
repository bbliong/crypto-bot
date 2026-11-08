import subprocess
import json
from collections import defaultdict

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 00:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

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
                "price": float(d.get("pu") or 0),
                "ts": int(d.get("t") or 0)
            })
        except:
            pass

events_by_mint = defaultdict(list)
for ev in all_events:
    events_by_mint[ev["mint"]].append(ev)

for m in events_by_mint:
    events_by_mint[m].sort(key=lambda x: x["ts"])

print("=== ANALISIS POTENSI CUAN 10-20% JIKA MASUK SETELAH WHALE MASUK ===")
print(f"{'No':<3} | {'Simbol':<10} | {'Whale In':<9} | {'Harga Pasca Whale':<18} | {'Peak Pasca Whale':<18} | {'Max Gain Pasca Whale':<20} | {'Bisa Cuan 15%?'}")
print("-" * 110)

success_15pct = 0
total_30sol = 0

for i, (m, evs) in enumerate(events_by_mint.items(), 1):
    buys = [e for e in evs if e["type"] == "buy"]
    if not buys: continue
    first_buy = buys[0]
    
    # Ambil hanya koin yang dimasuki Whale 30 SOL (high conviction)
    if first_buy["sol"] < 20: continue
    total_30sol += 1
    
    entry_ts = first_buy["ts"]
    whale_p = first_buy["price"]
    
    # Anggap follower masuk 1-5 detik setelah whale (misal pada event ke-2/3)
    after_events = [e for e in evs if e["ts"] >= entry_ts and e["price"] > 0]
    
    # Harga pasar persis setelah whale beli (biasanya di sekitar $0.000055 - $0.000065)
    post_whale_price = after_events[1]["price"] if len(after_events) > 1 else whale_p
    
    # Puncak harga setelah itu
    subsequent_prices = [e["price"] for e in after_events[1:]] if len(after_events) > 1 else [whale_p]
    peak_post = max(subsequent_prices) if subsequent_prices else post_whale_price
    
    gain_from_post = ((peak_post - post_whale_price) / post_whale_price) * 100 if post_whale_price > 0 else 0
    can_win_15 = gain_from_post >= 15.0
    if can_win_15: success_15pct += 1
    
    sol_str = f"{int(first_buy['sol'])} SOL"
    win_str = "✅ BISA (+15%++ LOLOS)" if can_win_15 else "❌ GAGAL (< 15%)"
    
    print(f"{total_30sol:<3} | {first_buy['sym']:<10} | {sol_str:<9} | ${post_whale_price:.8f}      | ${peak_post:.8f}     | +{gain_from_post:>6.1f}%              | {win_str}")

print("\n" + "=" * 110)
print(f"Total Koin Modal 30 SOL Whale Hari Ini: {total_30sol}")
print(f"Koin yang menghasilkan kenaikan >= +15% SETELAH Whale Masuk: {success_15pct} dari {total_30sol} ({success_15pct/total_30sol*100:.1f}%)")
