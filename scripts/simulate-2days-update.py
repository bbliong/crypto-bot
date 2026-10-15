import glob
import json
import os
import datetime

FEE_USD = 0.12
STAKE_USD = 5.0
wib_tz = datetime.timezone(datetime.timedelta(hours=7))

# 1. Collect all 13-14 Oct files
files = glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl") + \
        glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl")

oct13_14_tokens = []
for f in files:
    trades = []
    with open(f) as fp:
        for l in fp:
            try:
                trades.append(json.loads(l))
            except:
                pass
    if not trades:
        continue
    ts = trades[0].get("timestamp") or int(trades[0].get("observedAt", 0) / 1000)
    if not ts:
        continue
    dt = datetime.datetime.fromtimestamp(ts, tz=wib_tz).strftime("%Y-%m-%d")
    if dt in ["2026-10-13", "2026-10-14"]:
        sym = trades[0].get("trackedFrom", {}).get("symbol") or os.path.basename(f).split(".")[0][:8]
        oct13_14_tokens.append({
            "file": f,
            "date": dt,
            "symbol": sym,
            "trades": trades
        })

print(f"Total 13-14 Oct tokens with full trades: {len(oct13_14_tokens)}")

# --- TEST LANE V7 (BOUNCE) ---
v7_old_results = []
v7_new_results = []

for item in oct13_14_tokens:
    trades = item["trades"]
    if len(trades) < 30:
        continue
    
    ath = 0
    trough = 999999
    dump_found = False
    bounce_idx = -1
    for idx, t in enumerate(trades):
        p = float(t.get("price") or 0)
        if p <= 0:
            continue
        if not dump_found:
            if p > ath:
                ath = p
                trough = p
            elif ath > 0:
                dd = (ath - p) / ath * 100
                if p < trough:
                    trough = p
                if dd >= 28.0:
                    dump_found = True
        else:
            reb = (p - trough) / trough * 100
            if 4.0 <= reb <= 15.0:
                recent_buys = [float(x.get("usd") or 0) for x in trades[max(0, idx - 10):idx + 1] if x.get("side") == "buy"]
                if sum(recent_buys) >= 22.0:
                    bounce_idx = idx
                    break
                    
    if 0 < bounce_idx < len(trades) - 5:
        p_entry = float(trades[bounce_idx].get("price") or 0)
        futs = [float(t.get("price") or 0) for t in trades[bounce_idx + 1:] if float(t.get("price") or 0) > 0]
        if p_entry > 0 and len(futs) > 5:
            max_gain = max([(p - p_entry) / p_entry * 100 for p in futs])
            min_dd = min([(p - p_entry) / p_entry * 100 for p in futs])
            
            # Old V7: TP +22%, SL -8%
            hit_old = None
            for p in futs:
                r = (p - p_entry) / p_entry * 100
                if r >= 22.0:
                    hit_old = ("WIN", 22.0)
                    break
                if r <= -8.0:
                    hit_old = ("LOSS", -8.0)
                    break
            if not hit_old:
                final_r = (futs[-1] - p_entry) / p_entry * 100
                hit_old = ("WIN" if final_r > 0 else "LOSS", final_r)
                
            # New V7: TP +35%, SL -8%
            hit_new = None
            for p in futs:
                r = (p - p_entry) / p_entry * 100
                if r >= 35.0:
                    hit_new = ("WIN", 35.0)
                    break
                if r <= -8.0:
                    hit_new = ("LOSS", -8.0)
                    break
            if not hit_new:
                final_r = (futs[-1] - p_entry) / p_entry * 100
                hit_new = ("WIN" if final_r > 0 else "LOSS", final_r)
                
            v7_old_results.append({
                "symbol": item["symbol"],
                "date": item["date"],
                "p_entry": p_entry,
                "hit": hit_old,
                "max_gain": max_gain,
                "min_dd": min_dd
            })
            v7_new_results.append({
                "symbol": item["symbol"],
                "date": item["date"],
                "p_entry": p_entry,
                "hit": hit_new,
                "max_gain": max_gain,
                "min_dd": min_dd
            })

# --- TEST LANE S1 (STAIRCASE) ---
s1_old_results = []
s1_new_results = []

for item in oct13_14_tokens:
    trades = item["trades"]
    if len(trades) < 30:
        continue
    t0 = trades[0].get("timestamp") or int(trades[0].get("observedAt", 0) / 1000)
    w1 = [t for t in trades if (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 60]
    w2 = [t for t in trades if 60 < (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 120]
    
    vol1 = sum(float(t.get("usd") or 0) for t in w1 if t.get("side") == "buy")
    vol2 = sum(float(t.get("usd") or 0) for t in w2 if t.get("side") == "buy")
    
    prices120 = [float(t.get("price") or 0) for t in w1 + w2 if float(t.get("price") or 0) > 0]
    if not prices120 or len(prices120) < 5:
        continue
    p_start = prices120[0]
    p_end = prices120[-1]
    
    peak = p_start
    max_dd = 0
    for p in prices120:
        if p > peak:
            peak = p
        elif peak > 0:
            dd = (peak - p) / peak * 100
            if dd > max_dd:
                max_dd = dd
            
    # S1 Filter
    if (vol1 + vol2 >= 1200) and (p_end > p_start * 1.08) and (max_dd <= 3.5):
        idx_entry = len(w1) + len(w2)
        if idx_entry < len(trades) - 5:
            p_entry = float(trades[idx_entry].get("price") or 0)
            futs = [float(t.get("price") or 0) for t in trades[idx_entry + 1:] if float(t.get("price") or 0) > 0]
            if p_entry > 0 and len(futs) > 5:
                max_gain = max([(p - p_entry) / p_entry * 100 for p in futs])
                min_dd = min([(p - p_entry) / p_entry * 100 for p in futs])
                
                # Old S1: TP +20%, SL -8%
                hit_old = None
                for p in futs:
                    r = (p - p_entry) / p_entry * 100
                    if r >= 20.0:
                        hit_old = ("WIN", 20.0)
                        break
                    if r <= -8.0:
                        hit_old = ("LOSS", -8.0)
                        break
                if not hit_old:
                    final_r = (futs[-1] - p_entry) / p_entry * 100
                    hit_old = ("WIN" if final_r > 0 else "LOSS", final_r)
                    
                # New S1: TP +40%, SL -8%
                hit_new = None
                for p in futs:
                    r = (p - p_entry) / p_entry * 100
                    if r >= 40.0:
                        hit_new = ("WIN", 40.0)
                        break
                    if r <= -8.0:
                        hit_new = ("LOSS", -8.0)
                        break
                if not hit_new:
                    final_r = (futs[-1] - p_entry) / p_entry * 100
                    hit_new = ("WIN" if final_r > 0 else "LOSS", final_r)
                    
                s1_old_results.append({
                    "symbol": item["symbol"],
                    "date": item["date"],
                    "p_entry": p_entry,
                    "hit": hit_old,
                    "max_gain": max_gain,
                    "min_dd": min_dd
                })
                s1_new_results.append({
                    "symbol": item["symbol"],
                    "date": item["date"],
                    "p_entry": p_entry,
                    "hit": hit_new,
                    "max_gain": max_gain,
                    "min_dd": min_dd
                })

print("\n" + "="*50)
print("HASIL SIMULASI DATA 2 HARI (13-14 OKTOBER 2026)")
print("Modal Stake: $5.00 USD | Gas Solana: $0.12 roundtrip")
print("="*50)

print(f"\n--- 1. LANE V7 (BOUNCE HUNTER) ---")
print(f"Total Sinyal Masuk: {len(v7_new_results)} trade")
w_old = sum(1 for x in v7_old_results if x["hit"][0] == "WIN")
l_old = sum(1 for x in v7_old_results if x["hit"][0] == "LOSS")
net_old = sum(STAKE_USD * (x["hit"][1] / 100.0) - FEE_USD for x in v7_old_results)
print(f"  • Sebelum Update (TP +22% / SL -8%):")
print(f"    - Win  : {w_old}")
print(f"    - Loss : {l_old}")
print(f"    - Win Rate   : {w_old/(w_old+l_old)*100:.1f}%")
print(f"    - Net Profit : +${net_old:.2f} USD")

w_new = sum(1 for x in v7_new_results if x["hit"][0] == "WIN")
l_new = sum(1 for x in v7_new_results if x["hit"][0] == "LOSS")
net_new = sum(STAKE_USD * (x["hit"][1] / 100.0) - FEE_USD for x in v7_new_results)
print(f"  • SETELAH UPDATE (TP +35% / SL -8%):")
print(f"    - Win  : {w_new}")
print(f"    - Loss : {l_new}")
print(f"    - Win Rate   : {w_new/(w_new+l_new)*100:.1f}%")
print(f"    - Net Profit : +${net_new:.2f} USD  (LONJAKAN PROFIT: +{(net_new-net_old)/net_old*100:+.1f}%)")

print("\nRincian Setiap Token V7 Setelah Update (TP +35%):")
for r in v7_new_results:
    h = r["hit"]
    net_usd = STAKE_USD * (h[1] / 100.0) - FEE_USD
    sym = r["symbol"]
    dt = r["date"]
    res = h[0]
    pct = h[1]
    pk = r["max_gain"]
    print(f"  - {sym:<12} ({dt}) | {res:<4} ({pct:+5.1f}%) | Peak: +{pk:5.1f}% | Net: {net_usd:+5.2f} USD")

print(f"\n--- 2. LANE S1 (STAIRCASE RUNNER) ---")
print(f"Total Sinyal Masuk: {len(s1_new_results)} trade")
w_s1_old = sum(1 for x in s1_old_results if x["hit"][0] == "WIN")
l_s1_old = sum(1 for x in s1_old_results if x["hit"][0] == "LOSS")
net_s1_old = sum(STAKE_USD * (x["hit"][1] / 100.0) - FEE_USD for x in s1_old_results)
print(f"  • Sebelum Update (TP +20% / SL -8%):")
print(f"    - Win  : {w_s1_old}")
print(f"    - Loss : {l_s1_old}")
print(f"    - Win Rate   : {w_s1_old/(w_s1_old+l_s1_old)*100:.1f}%")
print(f"    - Net Profit : +${net_s1_old:.2f} USD")

w_s1_new = sum(1 for x in s1_new_results if x["hit"][0] == "WIN")
l_s1_new = sum(1 for x in s1_new_results if x["hit"][0] == "LOSS")
net_s1_new = sum(STAKE_USD * (x["hit"][1] / 100.0) - FEE_USD for x in s1_new_results)
print(f"  • SETELAH UPDATE (TP +40% / SL -8%):")
print(f"    - Win  : {w_s1_new}")
print(f"    - Loss : {l_s1_new}")
print(f"    - Win Rate   : {w_s1_new/(w_s1_new+l_s1_new)*100:.1f}%")
print(f"    - Net Profit : +${net_s1_new:.2f} USD  (LONJAKAN PROFIT: +{(net_s1_new-net_s1_old)/net_s1_old*100:+.1f}%)")

print("\nRincian Setiap Token S1 Setelah Update (TP +40%):")
for r in s1_new_results:
    h = r["hit"]
    net_usd = STAKE_USD * (h[1] / 100.0) - FEE_USD
    sym = r["symbol"]
    dt = r["date"]
    res = h[0]
    pct = h[1]
    pk = r["max_gain"]
    print(f"  - {sym:<12} ({dt}) | {res:<4} ({pct:+5.1f}%) | Peak: +{pk:5.1f}% | Net: {net_usd:+5.2f} USD")
