import glob
import json

files = glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl") + \
        glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl")

FEE_USD = 0.12
STAKE_USD = 5.0

print(f"Testing 3 versions across {len(files)} files with full runway...")

all_tokens = []
for f in files:
    trades = []
    with open(f) as fp:
        for l in fp:
            try: trades.append(json.loads(l))
            except: pass
    if len(trades) < 40: continue
    
    t0 = trades[0].get("timestamp") or int(trades[0].get("observedAt", 0) / 1000)
    w1 = [t for t in trades if (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 60]
    w2 = [t for t in trades if 60 < (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 120]
    w_post = [t for t in trades if (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 > 120]
    
    if len(w1) < 5 or len(w2) < 5 or len(w_post) < 10: continue
    
    p_start = float(trades[0].get("price") or 0)
    p_60 = float(w1[-1].get("price") or p_start)
    p_120 = float(w2[-1].get("price") or p_60)
    if p_120 <= 0 or p_start <= 0 or p_60 <= 0: continue
    
    vol1_buy = sum(float(t.get("usd") or 0) for t in w1 if t.get("side") == "buy")
    vol1_sell = sum(float(t.get("usd") or 0) for t in w1 if t.get("side") == "sell")
    vol2_buy = sum(float(t.get("usd") or 0) for t in w2 if t.get("side") == "buy")
    vol2_sell = sum(float(t.get("usd") or 0) for t in w2 if t.get("side") == "sell")
    
    p120_all = [float(t.get("price") or 0) for t in w1 + w2 if float(t.get("price") or 0) > 0]
    pk = p120_all[0]; max_dd = 0.0
    for p in p120_all:
        if p > pk: pk = p
        elif pk > 0:
            dd = (pk - p) / pk * 100
            if dd > max_dd: max_dd = dd
            
    gain_step1 = (p_60 - p_start) / p_start * 100
    gain_step2 = (p_120 - p_60) / p_60 * 100
    gain_120 = (p_120 - p_start) / p_start * 100
    
    sells = [float(t.get("usd") or 0) for t in w1 + w2 if t.get("side") == "sell"]
    max_sell = max(sells) if sells else 0.0
    tot_buy = vol1_buy + vol2_buy
    tot_sell = vol1_sell + vol2_sell
    bs_ratio = tot_buy / max(1.0, tot_sell)
    vol_accel = vol2_buy / max(1.0, vol1_buy)
    
    sym = trades[0].get("trackedFrom", {}).get("symbol") or f.split("/")[-1].split(".")[0][:8]
    date_str = trades[0].get("trackedFrom", {}).get("date") or "2026-10-14"
    
    # Store future prices and timestamps
    futs = []
    for t in w_post:
        p = float(t.get("price") or 0)
        ts = t.get("timestamp") or int(t.get("observedAt", 0) / 1000)
        if p > 0:
            futs.append((p, ts - t0))
            
    all_tokens.append({
        "sym": sym,
        "date": date_str,
        "p_120": p_120,
        "tot_buy": tot_buy,
        "tot_sell": tot_sell,
        "vol1_buy": vol1_buy,
        "vol2_buy": vol2_buy,
        "vol_accel": vol_accel,
        "gain_step1": gain_step1,
        "gain_step2": gain_step2,
        "gain_120": gain_120,
        "max_dd": max_dd,
        "max_sell": max_sell,
        "bs_ratio": bs_ratio,
        "futs": futs
    })

print(f"Extracted {len(all_tokens)} valid tokens for simulation.")

# Define 3 Versions:
versions = [
    {
        "name": "Versi 1: S1-Max Profit (Untung Terbesar)",
        "tp": 45,
        "sl": 8,
        "max_hold": 900,
        "filter": lambda t: (
            t["tot_buy"] >= 1400 and
            t["max_dd"] <= 2.6 and
            t["max_sell"] <= 60 and
            t["bs_ratio"] >= 3.0 and
            t["gain_step1"] >= 1.8 and
            t["gain_step2"] >= 1.8 and
            t["gain_120"] >= 4.5 and
            t["gain_120"] <= 35.0
        )
    },
    {
        "name": "Versi 2: S1-High Win Rate (Win Terbanyak & Aman)",
        "tp": 25,
        "sl": 8,
        "max_hold": 600,
        "filter": lambda t: (
            t["tot_buy"] >= 1500 and
            t["max_dd"] <= 2.2 and
            t["max_sell"] <= 50 and
            t["bs_ratio"] >= 3.5 and
            t["gain_step1"] >= 2.0 and
            t["gain_step2"] >= 2.0 and
            t["gain_120"] >= 5.0 and
            t["gain_120"] <= 30.0
        )
    },
    {
        "name": "Versi 3: S1-Super Runner 50%+ (Pemburu Home-Run > +50%)",
        "tp": 50,
        "sl": 8,
        "max_hold": 1200,
        "filter": lambda t: (
            t["tot_buy"] >= 900 and
            t["max_dd"] <= 2.6 and
            t["max_sell"] <= 50 and
            t["bs_ratio"] >= 4.0 and
            t["vol_accel"] >= 0.8 and
            t["gain_step1"] >= 2.2 and
            t["gain_step2"] >= 2.0 and
            t["gain_120"] >= 5.5 and
            t["gain_120"] <= 35.0
        )
    }
]

for ver in versions:
    matched = [t for t in all_tokens if ver["filter"](t)]
    wins = 0
    losses = 0
    total_net = 0.0
    runner_50_count = 0
    details = []
    
    for m in matched:
        p_entry = m["p_120"]
        futs = m["futs"]
        max_p = max([p for p, ts in futs]) if futs else p_entry
        max_gain = (max_p - p_entry) / p_entry * 100
        if max_gain >= 50.0:
            runner_50_count += 1
            
        hit = None
        for p, el_sec in futs:
            if el_sec > ver["max_hold"]:
                # Max hold expired
                final_r = (p - p_entry) / p_entry * 100
                hit = ("EXPIRED_WIN" if final_r > 0 else "EXPIRED_LOSS", final_r)
                break
            ret = (p - p_entry) / p_entry * 100
            if ret >= ver["tp"]:
                hit = ("WIN", ver["tp"])
                break
            if ret <= -ver["sl"]:
                hit = ("LOSS", -ver["sl"])
                break
        if not hit:
            hit = ("LOSS", -ver["sl"])
            
        net = STAKE_USD * (hit[1] / 100.0) - FEE_USD
        total_net += net
        if hit[0].startswith("WIN"): wins += 1
        else: losses += 1
        
        details.append({
            "sym": m["sym"],
            "res": hit[0],
            "ret": hit[1],
            "net": net,
            "peak": max_gain
        })
        
    wr = (wins / len(matched) * 100) if matched else 0
    ev = (total_net / len(matched)) if matched else 0
    r50_pct = (runner_50_count / len(matched) * 100) if matched else 0
    
    print("\n" + "="*80)
    print(f"📊 {ver['name'].upper()}")
    print("="*80)
    print(f"  • Exit Strategy : TP +{ver['tp']}% / SL -{ver['sl']}% (Max Hold: {ver['max_hold']}s)")
    print(f"  • Total Trades  : {len(matched)} Trade")
    print(f"  • Win / Loss    : {wins} Win / {losses} Loss (WR: {wr:.1f}%)")
    print(f"  • Total Net PnL : +${total_net:.2f} USD (Stake $5.00 | Fee $0.12)")
    print(f"  • EV per Trade  : +${ev:.2f} USD")
    print(f"  • Token Meledak > +50%: {runner_50_count} dari {len(matched)} token ({r50_pct:.1f}% Akurasi)")
    print(f"  • Daftar Token  :")
    for d in details:
        print(f"    - {d['sym']:<10} | {d['res']:<12} ({d['ret']:+5.1f}%) | Peak: +{d['peak']:5.1f}% | Net: ${d['net']:+5.2f}")
