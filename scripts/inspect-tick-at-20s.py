import json
import glob
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# Load all signals from ledger and backups
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

SLIPPAGE_BUY_GAP = 0.234 # 23.4% AMM slippage

snapshot_20s = []

for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    if not buys: continue

    fb = buys[0]
    p_in_target = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if not (is_gz and p_in_target <= 0.000020): continue

    bot_entry_p = p_in_target * (1.0 + SLIPPAGE_BUY_GAP)
    t_entry = fb.get("timestamp", 0)
    t_target_20s = t_entry + 20

    # Cari tick harga terdekat dengan t_target_20s
    # Kumpulkan semua sinyal (buy/sell) pada token ini dengan timestamp >= t_entry
    events_after = [s for s in sig_list if s.get("timestamp", 0) >= t_entry]
    if not events_after: continue

    # Cari event yang paling dekat dengan t_entry + 20s
    closest_event = None
    min_diff = 999999
    cum_sell_at_20s = 0.0

    # Hitung juga apakah target sudah sell di detik ke-20
    sells_before_20s = [s for s in events_after if s.get("action") == "sell" and s.get("timestamp", 0) <= t_target_20s + 2]
    for s in sells_before_20s:
        t_amt = s.get("tokenAmount", 0.0)
        r_h = s.get("remainingHolding", 0.0)
        tot = t_amt + r_h
        if tot > 0:
            cum_sell_at_20s += (t_amt / tot * 100.0)

    for s in events_after:
        p = s.get("priceUsd", 0.0)
        if p <= 0: continue
        diff = abs(s.get("timestamp", 0) - t_target_20s)
        if diff < min_diff:
            min_diff = diff
            closest_event = s

    if not closest_event or min_diff > 15: # batasi deviasi maksimal 15 detik
        continue

    actual_tick_time = closest_event.get("timestamp", 0)
    actual_sec_diff = int(actual_tick_time - t_entry)
    p_at_20s = closest_event.get("priceUsd", 0.0)

    # % gain
    chart_gain_20s = ((p_at_20s - p_in_target) / p_in_target) * 100.0
    bot_gain_20s = ((p_at_20s - bot_entry_p) / bot_entry_p) * 100.0

    target_status = "HOLD (0% sell)"
    if cum_sell_at_20s >= 5.0:
        target_status = f"SUDAH SELL ({cum_sell_at_20s:.1f}%)"
    elif cum_sell_at_20s > 0:
        target_status = f"Mulai Sell ({cum_sell_at_20s:.1f}%)"

    snapshot_20s.append({
        "symbol": fb.get("symbol", "UNKNOWN"),
        "mint": m,
        "entry_ts": t_entry,
        "buy_time_wib": datetime.fromtimestamp(t_entry, tz=wib).strftime("%H:%M:%S"),
        "time_20s_wib": datetime.fromtimestamp(t_entry + 20, tz=wib).strftime("%H:%M:%S"),
        "actual_sec": actual_sec_diff,
        "target_in": p_in_target,
        "bot_in": bot_entry_p,
        "p_20s": p_at_20s,
        "chart_gain_20s": chart_gain_20s,
        "bot_gain_20s": bot_gain_20s,
        "target_status": target_status
    })

snapshot_20s.sort(key=lambda x: x["entry_ts"], reverse=True)

print(f"Total token dengan tick harga di sekitar 20 detik: {len(snapshot_20s)}")
print("\n" + "=" * 125)
print(f"{'No':<3} | {'Token':<8} | {'Buy Bot':<8} | {'Waktu +20s':<10} | {'Tick Detik':<10} | {'Harga Bot In':<13} | {'Harga @ 20s':<13} | {'Kenaikan Bot %':<14} | {'Kenaikan Chart':<14} | {'Status Target'}")
print("=" * 125)

for idx, item in enumerate(snapshot_20s[:20], 1):
    sec_label = f"detik +{item['actual_sec']}s"
    print(f"{idx:<3} | {item['symbol']:<8} | {item['buy_time_wib']:<8} | {item['time_20s_wib']:<10} | {sec_label:<10} | ${item['bot_in']:.8f} | ${item['p_20s']:.8f} | {item['bot_gain_20s']:+6.1f}% (Net)   | {item['chart_gain_20s']:+6.1f}% (DEX)   | {item['target_status']}")

# Summary stats
all_bot_gains = [s['bot_gain_20s'] for s in snapshot_20s]
all_chart_gains = [s['chart_gain_20s'] for s in snapshot_20s]
positive_bot = sum(1 for g in all_bot_gains if g > 0)
positive_chart = sum(1 for g in all_chart_gains if g > 0)

print("\n" + "=" * 80)
print("RINGKASAN STATISTIK DI DETIK KE-20 (DARI 187 TOKEN):")
print("=" * 80)
print(f"• Rata-rata Kenaikan di Chart DEX  : +{sum(all_chart_gains)/len(all_chart_gains):.1f}% (Median: +{sorted(all_chart_gains)[len(all_chart_gains)//2]:.1f}%)")
print(f"• Rata-rata Profit Bersih Bot (Net): +{sum(all_bot_gains)/len(all_bot_gains):.1f}% (Median: +{sorted(all_bot_gains)[len(all_bot_gains)//2]:.1f}%)")
print(f"• Persentase Token yang HIJAU/PROFIT di Detik 20: {positive_bot}/{len(all_bot_gains)} token ({positive_bot/len(all_bot_gains)*100:.1f}%)!")

