import subprocess
import json
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# Baca journalctl untuk mengambil semua transaksi buy & sell target whale hari ini
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

print(f"Total raw trade events parsed: {len(all_events)}")

# Group by mint
from collections import defaultdict
events_by_mint = defaultdict(list)
for ev in all_events:
    events_by_mint[ev["mint"]].append(ev)

# Sort each mint by timestamp
for m in events_by_mint:
    events_by_mint[m].sort(key=lambda x: x["ts"])

# Analisis 28 koin
results = []
for m, evs in events_by_mint.items():
    buys = [e for e in evs if e["type"] == "buy" and e["price"] > 0]
    if not buys: continue
    
    first_buy = buys[0]
    entry_p = first_buy["price"]
    entry_ts = first_buy["ts"]
    sym = first_buy["sym"]
    sol_in = first_buy["sol"]
    
    # Cari harga tertinggi setelah buy
    all_prices = [e["price"] for e in evs if e["ts"] >= entry_ts and e["price"] > 0]
    peak_p = max(all_prices) if all_prices else entry_p
    gain_pct = ((peak_p - entry_p) / entry_p) * 100 if entry_p > 0 else 0
    
    # Cari event dump (sell pertama besar >= 50% atau full exit / sell pertama jika dump)
    sells = [e for e in evs if e["type"] == "sell" and e["ts"] >= entry_ts]
    
    dump_ev = None
    if sells:
        # cari sell pertama yang >= 40% atau full exit
        major_sells = [s for s in sells if s["sell_ratio"] >= 40 or s["remaining"] < 1000]
        if major_sells:
            dump_ev = major_sells[0]
        else:
            dump_ev = sells[0]
            
    dump_sec = None
    dump_p = None
    dump_ratio = None
    
    if dump_ev:
        dump_sec = dump_ev["ts"] - entry_ts
        dump_p = dump_ev["price"]
        dump_ratio = dump_ev["sell_ratio"]
        
    results.append({
        "sym": sym,
        "mint": m,
        "sol_in": sol_in,
        "entry_p": entry_p,
        "peak_p": peak_p,
        "gain_pct": gain_pct,
        "dump_p": dump_p,
        "dump_sec": dump_sec,
        "dump_ratio": dump_ratio,
        "entry_time_wib": datetime.fromtimestamp(entry_ts, tz=wib).strftime("%H:%M:%S WIB"),
        "entry_ts": entry_ts
    })

# Sort secara kronologis
results.sort(key=lambda x: x["entry_ts"])

print("\n" + "=" * 135)
print(f"{'No':<3} | {'Koin':<10} | {'Waktu Masuk':<13} | {'Modal In':<9} | {'Harga Masuk (USD)':<18} | {'Harga Peak (USD)':<18} | {'Kenaikan':<10} | {'Harga Dump (USD)':<18} | {'Dump Setelah'}")
print("-" * 135)

for i, r in enumerate(results, 1):
    sol_str = f"{r['sol_in']:.1f} SOL" if r['sol_in'] < 10 else f"{int(r['sol_in'])} SOL"
    p_in_str = f"${r['entry_p']:.8f}"
    p_peak_str = f"${r['peak_p']:.8f}"
    gain_str = f"+{r['gain_pct']:.1f}%"
    p_dump_str = f"${r['dump_p']:.8f}" if r['dump_p'] else "-"
    dump_sec_str = f"{r['dump_sec']} detik" if r['dump_sec'] is not None else "-"
    
    print(f"{i:<3} | {r['sym']:<10} | {r['entry_time_wib']:<13} | {sol_str:<9} | {p_in_str:<18} | {p_peak_str:<18} | {gain_str:<10} | {p_dump_str:<18} | {dump_sec_str}")

print("=" * 135)

# Hitung rata-rata
valid_gains = [r["gain_pct"] for r in results]
valid_durations = [r["dump_sec"] for r in results if r["dump_sec"] is not None and r["dump_sec"] >= 0]

print(f"\nRANGKUMAN STATISTIK HARI INI:")
print(f" - Rata-rata Kenaikan Sejak Whale Masuk : +{sum(valid_gains)/len(valid_gains):.1f}% (Max: +{max(valid_gains):.1f}%)")
if valid_durations:
    print(f" - Rata-rata Durasi Dump Pasca Masuk   : {sum(valid_durations)/len(valid_durations):.1f} detik (Median: {sorted(valid_durations)[len(valid_durations)//2]} detik, Min: {min(valid_durations)} detik)")
