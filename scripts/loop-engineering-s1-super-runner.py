import glob
import json
import os
from statistics import median

files = glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl") + \
        glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl")

runners_50 = []
non_runners = []

for f in files:
    trades = []
    with open(f) as fp:
        for l in fp:
            try:
                trades.append(json.loads(l))
            except:
                pass
    if len(trades) < 40:
        continue
    
    t0 = trades[0].get("timestamp") or int(trades[0].get("observedAt", 0) / 1000)
    w1 = [t for t in trades if (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 60]
    w2 = [t for t in trades if 60 < (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 120]
    w_post = [t for t in trades if (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 > 120]
    
    if len(w1) < 5 or len(w2) < 5 or len(w_post) < 10:
        continue
    
    p_start = float(trades[0].get("price") or 0)
    p_120 = float(w2[-1].get("price") or 0)
    if p_120 <= 0 or p_start <= 0:
        continue
    
    post_prices = [float(t.get("price") or 0) for t in w_post if float(t.get("price") or 0) > 0]
    if not post_prices:
        continue
    
    max_post_p = max(post_prices)
    max_gain_from_120 = (max_post_p - p_120) / p_120 * 100
    
    sym = trades[0].get("trackedFrom", {}).get("symbol") or os.path.basename(f).split(".")[0][:8]
    
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
        if p > pk:
            pk = p
        elif pk > 0:
            dd = (pk - p) / pk * 100
            if dd > max_dd:
                max_dd = dd
            
    gain_120 = (p_120 - p_start) / p_start * 100
    p_60 = float(w1[-1].get("price") or p_start)
    gain_step1 = (p_60 - p_start) / p_start * 100
    gain_step2 = (p_120 - p_60) / p_60 * 100 if p_60 > 0 else 0
    
    # Largest single sell in 120s
    sells = [float(t.get("usd") or 0) for t in w1 + w2 if t.get("side") == "sell"]
    max_sell = max(sells) if sells else 0.0
    
    # Buy to Sell ratio
    tot_buy = vol1_buy + vol2_buy
    tot_sell = vol1_sell + vol2_sell
    bs_ratio = tot_buy / max(1.0, tot_sell)
    
    item = {
        "sym": sym,
        "max_gain": max_gain_from_120,
        "tot_buy": tot_buy,
        "tot_sell": tot_sell,
        "vol1_buy": vol1_buy,
        "vol2_buy": vol2_buy,
        "gain_step1": gain_step1,
        "gain_step2": gain_step2,
        "gain_120": gain_120,
        "max_dd_120": max_dd,
        "max_sell": max_sell,
        "bs_ratio": bs_ratio,
        "unique_buyers": unique_buyers,
        "trade_count": len(w1) + len(w2),
        "post_prices": post_prices,
        "p_120": p_120
    }
    
    if max_gain_from_120 >= 50.0:
        runners_50.append(item)
    else:
        non_runners.append(item)

print(f"Total Valid Tokens: {len(runners_50) + len(non_runners)}")
print(f"Super Runners (>= +50% Gain): {len(runners_50)} token ({len(runners_50)/(len(runners_50)+len(non_runners))*100:.1f}%)")
print(f"Non-Runners (< +50%): {len(non_runners)} token")

print("\n" + "="*80)
print("15 SUPER RUNNER TERBESAR (PUNCAK > +50%):")
print("="*80)
print(f"{'Symbol':<12} | {'Peak Gain':<9} | {'Buy Vol ($)':<11} | {'Sell Vol':<8} | {'B/S Ratio':<9} | {'Buyers':<6} | {'Step1 %':<7} | {'Step2 %':<7} | {'Max DD':<6} | {'Max Sell':<8}")
print("-" * 95)
for r in sorted(runners_50, key=lambda x: -x["max_gain"])[:20]:
    sym = r["sym"]
    pk = f"+{r['max_gain']:.1f}%"
    bv = f"${r['tot_buy']:.0f}"
    sv = f"${r['tot_sell']:.0f}"
    bs = f"{r['bs_ratio']:.1f}x"
    ub = f"{r['unique_buyers']}"
    s1 = f"{r['gain_step1']:+.1f}%"
    s2 = f"{r['gain_step2']:+.1f}%"
    dd = f"{r['max_dd_120']:.1f}%"
    ms = f"${r['max_sell']:.0f}"
    print(f"{sym:<12} | {pk:<9} | {bv:<11} | {sv:<8} | {bs:<9} | {ub:<6} | {s1:<7} | {s2:<7} | {dd:<6} | {ms:<8}")

print("\n" + "="*80)
print("PERBANDINGAN KARAKTERISTIK (MEDIAN): SUPER RUNNER VS NON-RUNNER")
print("="*80)
def med(arr, key):
    return median([x[key] for x in arr])

print(f"Total Buy Volume ($)   : Runner ${med(runners_50, 'tot_buy'):.0f} vs Non-Runner ${med(non_runners, 'tot_buy'):.0f}")
print(f"Buy/Sell Ratio         : Runner {med(runners_50, 'bs_ratio'):.1f}x vs Non-Runner {med(non_runners, 'bs_ratio'):.1f}x")
print(f"Jumlah Unique Buyers   : Runner {med(runners_50, 'unique_buyers'):.0f} vs Non-Runner {med(non_runners, 'unique_buyers'):.0f}")
print(f"Gain Step 1 (0-60s)    : Runner {med(runners_50, 'gain_step1'):+.1f}% vs Non-Runner {med(non_runners, 'gain_step1'):+.1f}%")
print(f"Gain Step 2 (60-120s)  : Runner {med(runners_50, 'gain_step2'):+.1f}% vs Non-Runner {med(non_runners, 'gain_step2'):+.1f}%")
print(f"Max Drawdown 120s      : Runner {med(runners_50, 'max_dd_120'):.1f}% vs Non-Runner {med(non_runners, 'max_dd_120'):.1f}%")
print(f"Max Single Sell ($)    : Runner ${med(runners_50, 'max_sell'):.0f} vs Non-Runner ${med(non_runners, 'max_sell'):.0f}")
