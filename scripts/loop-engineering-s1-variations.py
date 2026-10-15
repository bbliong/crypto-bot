import glob
import json
import os
from statistics import median

files = glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl") + \
        glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl")

FEE_USD = 0.12
STAKE_USD = 5.0

# Pre-parse all tokens
token_records = []
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
    
    post_prices = [float(t.get("price") or 0) for t in w_post if float(t.get("price") or 0) > 0]
    if not post_prices: continue
    
    vol1_buy = sum(float(t.get("usd") or 0) for t in w1 if t.get("side") == "buy")
    vol1_sell = sum(float(t.get("usd") or 0) for t in w1 if t.get("side") == "sell")
    vol2_buy = sum(float(t.get("usd") or 0) for t in w2 if t.get("side") == "buy")
    vol2_sell = sum(float(t.get("usd") or 0) for t in w2 if t.get("side") == "sell")
    
    buyers_1 = set(t.get("wallet") for t in w1 if t.get("side") == "buy" and t.get("wallet"))
    buyers_2 = set(t.get("wallet") for t in w2 if t.get("side") == "buy" and t.get("wallet"))
    unique_buyers = len(buyers_1 | buyers_2)
    
    p120_all = [float(t.get("price") or 0) for t in w1 + w2 if float(t.get("price") or 0) > 0]
    pk = p120_all[0]
    max_dd = 0.0
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
    
    sym = trades[0].get("trackedFrom", {}).get("symbol") or os.path.basename(f).split(".")[0][:8]
    
    token_records.append({
        "sym": sym,
        "p_120": p_120,
        "post_prices": post_prices,
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
        "unique_buyers": unique_buyers,
        "trade_count": len(w1) + len(w2)
    })

print(f"Pre-parsed {len(token_records)} valid streaming tokens.")

# Grid Search Simulation Engine
results = []

min_vol_candidates = [600, 1000, 1500, 2000, 2500]
max_dd_candidates = [2.0, 2.5, 3.2]
max_sell_candidates = [45, 60, 100]
min_ratio_candidates = [2.5, 3.5, 5.0]
accel_candidates = [0.0, 0.8, 1.1] # Step 2 volume acceleration
tp_candidates = [35, 40, 50, 60, 75]
sl_candidates = [8, 10]

for min_v in min_vol_candidates:
    for m_dd in max_dd_candidates:
        for m_s in max_sell_candidates:
            for b_r in min_ratio_candidates:
                for acc in accel_candidates:
                    # Filter candidates
                    matched = []
                    for tok in token_records:
                        if tok["tot_buy"] < min_v: continue
                        if tok["max_dd"] > m_dd: continue
                        if tok["max_sell"] > m_s: continue
                        if tok["bs_ratio"] < b_r: continue
                        if tok["vol_accel"] < acc: continue
                        # Clean stair progression: both steps must be non-negative
                        if tok["gain_step1"] < 1.0 or tok["gain_step2"] < 1.0: continue
                        # Total gain in 120s must be healthy but not blown out (>40% is overextended)
                        if tok["gain_120"] < 4.0 or tok["gain_120"] > 35.0: continue
                        
                        matched.append(tok)
                        
                    if len(matched) < 4: continue
                    
                    for tp in tp_candidates:
                        for sl in sl_candidates:
                            wins = 0
                            losses = 0
                            net_tot = 0.0
                            runners_50_caught = 0
                            
                            for m in matched:
                                p_entry = m["p_120"]
                                futs = m["post_prices"]
                                
                                max_p = max(futs)
                                max_ret = (max_p - p_entry) / p_entry * 100
                                if max_ret >= 50.0:
                                    runners_50_caught += 1
                                    
                                hit = None
                                for p in futs:
                                    ret = (p - p_entry) / p_entry * 100
                                    if ret >= tp:
                                        hit = ("WIN", tp)
                                        break
                                    if ret <= -sl:
                                        hit = ("LOSS", -sl)
                                        break
                                if not hit:
                                    fr = (futs[-1] - p_entry) / p_entry * 100
                                    hit = ("WIN" if fr > 0 else "LOSS", fr)
                                    
                                net = STAKE_USD * (hit[1] / 100.0) - FEE_USD
                                net_tot += net
                                if hit[0] == "WIN": wins += 1
                                else: losses += 1
                                
                            wr = wins / (wins + losses) * 100
                            ev = net_tot / (wins + losses)
                            
                            results.append({
                                "min_vol": min_v,
                                "max_dd": m_dd,
                                "max_sell": m_s,
                                "bs_ratio": b_r,
                                "accel": acc,
                                "tp": tp,
                                "sl": sl,
                                "trades": len(matched),
                                "wins": wins,
                                "losses": losses,
                                "wr": wr,
                                "net_tot": net_tot,
                                "ev": ev,
                                "runners_caught": runners_50_caught,
                                "matched_symbols": [m["sym"] for m in matched]
                            })

print(f"Evaluated {len(results)} parameter variations.")

# Sort by Net Profit (Untung Terbesar)
results_by_profit = sorted(results, key=lambda x: -x["net_tot"])
# Sort by Win Rate (Win Terbanyak / Min 6 Trades)
results_by_wr = sorted([r for r in results if r["trades"] >= 6], key=lambda x: (-x["wr"], -x["net_tot"]))
# Sort by Highest EV & Runners Caught
results_by_runner = sorted(results, key=lambda x: (-x["runners_caught"], -x["net_tot"]))

with open("/home/bbliong/project/crypto-bot/data/profit4-watch/loop-s1-results.json", "w") as fp:
    json.dump({
        "top_profit": results_by_profit[:20],
        "top_wr": results_by_wr[:20],
        "top_runners": results_by_runner[:20]
    }, fp, indent=2)

print("\nSaved loop engineering results to data/profit4-watch/loop-s1-results.json")
