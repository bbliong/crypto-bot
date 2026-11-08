import json, subprocess

cmd = "journalctl --user-unit=crypto-bot-wallet-follower.service --since=\"2026-11-08 00:00:00\" --grep=\"GMGN WS RAW ITEM\" --no-pager"
p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

events = []
for line in p.stdout:
    if "Raw: " in line:
        try:
            raw_json = line[line.index("Raw: ") + 5:].strip()
            data = json.loads(raw_json)
            events.append(data)
        except:
            pass

print(f"Total GMGN raw events collected: {len(events)}")

tokens = {}
for e in events:
    mint = e.get("a")
    if not mint: continue
    if mint not in tokens:
        tokens[mint] = []
    tokens[mint].append(e)

high_conviction = {}
for mint, ev_list in tokens.items():
    ev_list.sort(key=lambda x: x.get("t", 0))
    has_large_buy = any(e.get("e") == "buy" and (float(e.get("qa") or 0) >= 20 or float(e.get("au") or 0) >= 1800) for e in ev_list)
    if has_large_buy:
        symbol = ev_list[0].get("bs") or ev_list[0].get("bn") or mint[:8]
        high_conviction[mint] = {
            "symbol": symbol,
            "events": ev_list
        }

print(f"High conviction tokens found: {len(high_conviction)}")

summary_stats = []

for mint, info in high_conviction.items():
    evs = info["events"]
    first_buy = next((e for e in evs if e.get("e") == "buy"), None)
    t0 = first_buy.get("t", 0) if first_buy else 0
    t_end = evs[-1].get("t", 0)
    duration_sec = t_end - t0
    buys = [e for e in evs if e.get("e") == "buy"]
    sells = [e for e in evs if e.get("e") == "sell"]
    
    initial_holding = float(first_buy.get("ba") or 0) if first_buy else 0
    dump_t = None
    dump_trade_idx = None
    dump_reason = None
    
    consecutive_sells = 0
    consecutive_dump_idx = None
    cum_30_idx = None
    
    for idx, e in enumerate(evs):
        if idx == 0: continue
        is_sell = (e.get("e") == "sell")
        if is_sell:
            consecutive_sells += 1
            cur_bal = float(e.get("b") or 0)
            sold_pct = ((initial_holding - cur_bal) / initial_holding * 100) if initial_holding > 0 else 0
            if consecutive_sells >= 3 and consecutive_dump_idx is None:
                consecutive_dump_idx = idx
                dump_t = e.get("t", 0) - t0
                dump_reason = f"3 Consecutive Sells (Trade #{idx})"
            if sold_pct >= 30 and cum_30_idx is None:
                cum_30_idx = idx
                if not dump_t:
                    dump_t = e.get("t", 0) - t0
                    dump_reason = f"Cum Sold >= 30% ({sold_pct:.1f}% at Trade #{idx})"
        else:
            consecutive_sells = 0

    sym = info["symbol"]
    print(f"\n--- Token: {sym} ({mint[:8]}...) ---")
    print(f"   Total Ping-Pong Trades: {len(evs)} (Buys: {len(buys)}, Sells: {len(sells)})")
    print(f"   Durasi Total Sesi     : {duration_sec}s ({duration_sec/60:.1f}m)")
    if dump_t:
        print(f"   Dump Dimulai Pada     : Detik ke-{dump_t} ({dump_t/60:.1f}m) | Trade #{dump_trade_idx or consecutive_dump_idx or cum_30_idx}")
        print(f"   Indikator Dump Awal   : {dump_reason}")
    else:
        print(f"   Dump Dimulai Pada     : Tidak dump besar (> 30%) selama sesi termonitor")

    summary_stats.append({
        "symbol": sym,
        "total_trades": len(evs),
        "duration_sec": duration_sec,
        "dump_t": dump_t,
        "first_dump_trade": consecutive_dump_idx or cum_30_idx or len(evs)
    })

print("\n" + "="*60)
print("=== RANGKUMAN STATISTIK DUMP & PING-PONG WHALE 30 SOL ===")
print("="*60)
min_trades = min(s["total_trades"] for s in summary_stats)
max_trades = max(s["total_trades"] for s in summary_stats)
avg_trades = sum(s["total_trades"] for s in summary_stats) / len(summary_stats)

dump_times = [s["dump_t"] for s in summary_stats if s["dump_t"] is not None]
min_dump_t = min(dump_times) if dump_times else 0
avg_dump_t = sum(dump_times) / len(dump_times) if dump_times else 0

first_dump_trades = [s["first_dump_trade"] for s in summary_stats if s["first_dump_trade"] is not None]
min_safe_trades = min(first_dump_trades) if first_dump_trades else 0
avg_safe_trades = sum(first_dump_trades) / len(first_dump_trades) if first_dump_trades else 0

print(f"Jumlah Koin Dianalisis      : {len(summary_stats)}")
print(f"Minimal Transaksi Ping-Pong : {min_trades} transaksi")
print(f"Rata-rata Ping-Pong         : {avg_trades:.1f} transaksi (Max: {max_trades})")
print(f"Trade Tercepat Dump Muncul  : Trade ke-{min_safe_trades} (Rata-rata: Trade ke-{avg_safe_trades:.1f})")
print(f"Waktu Tercepat Dump Muncul  : {min_dump_t}s ({min_dump_t/60:.1f}m) (Rata-rata: {avg_dump_t:.1f}s / {avg_dump_t/60:.1f}m)")
