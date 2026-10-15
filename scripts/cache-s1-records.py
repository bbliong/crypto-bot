import glob
import json
import os

files = glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl") + \
        glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl")

token_records = []
print(f"Reading {len(files)} files (bounded to first 1200 lines each)...")

for f in files:
    trades = []
    with open(f) as fp:
        for idx, l in enumerate(fp):
            if idx > 1200: break
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
        "file": f,
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

print(f"Pre-parsed {len(token_records)} valid tokens in seconds!")
with open("/home/bbliong/project/crypto-bot/data/profit4-watch/s1_parsed_tokens.json", "w") as fp:
    json.dump(token_records, fp)
print("Saved to /home/bbliong/project/crypto-bot/data/profit4-watch/s1_parsed_tokens.json")
