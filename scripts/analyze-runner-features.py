import glob
import json

files = glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl") + \
        glob.glob("/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl")

super_runners = ["ROT", "HPotter", "Anthropic", "MEDUSA", "Simpsons", "ConConAI", "Hermès", "Mr Beast"]

runners_hit50 = []
runners_fizzled = []

for f in files:
    with open(f) as fp:
        try:
            l1 = json.loads(fp.readline())
            sym = l1.get("trackedFrom", {}).get("symbol")
            if sym in super_runners:
                trades = [l1]
                for l in fp:
                    try: trades.append(json.loads(l))
                    except: pass
                t0 = trades[0].get("timestamp") or int(trades[0].get("observedAt", 0) / 1000)
                p0 = float(trades[0].get("price") or 0)
                if p0 <= 0: continue
                
                # Check hit 50%
                hit_50 = False
                for t in trades:
                    p = float(t.get("price") or 0)
                    if (p - p0) / p0 * 100 >= 50.0:
                        hit_50 = True
                        break
                        
                # Extract 120s features
                w1 = [t for t in trades if (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 60]
                w2 = [t for t in trades if 60 < (t.get("timestamp") or int(t.get("observedAt", 0) / 1000)) - t0 <= 120]
                if len(w1) < 5 or len(w2) < 5: continue
                
                p_60 = float(w1[-1].get("price") or p0)
                p_120 = float(w2[-1].get("price") or p_60)
                g1 = (p_60 - p0) / p0 * 100
                g2 = (p_120 - p_60) / p_60 * 100
                
                vol1_buy = sum(float(t.get("usd") or 0) for t in w1 if t.get("side") == "buy")
                vol2_buy = sum(float(t.get("usd") or 0) for t in w2 if t.get("side") == "buy")
                
                sells120 = [float(t.get("usd") or 0) for t in w1 + w2 if t.get("side") == "sell"]
                max_sell = max(sells120) if sells120 else 0
                tot_sell = sum(sells120)
                
                p120_all = [float(t.get("price") or 0) for t in w1 + w2 if float(t.get("price") or 0) > 0]
                pk = p120_all[0]
                max_dd = 0.0
                for p in p120_all:
                    if p > pk: pk = p
                    elif pk > 0:
                        dd = (pk - p) / pk * 100
                        if dd > max_dd: max_dd = dd
                        
                item = {
                    "sym": sym,
                    "hit_50": hit_50,
                    "tot_buy": vol1_buy + vol2_buy,
                    "tot_sell": tot_sell,
                    "max_sell": max_sell,
                    "g1": g1,
                    "g2": g2,
                    "max_dd": max_dd,
                    "accel": vol2_buy / max(1.0, vol1_buy)
                }
                if hit_50: runners_hit50.append(item)
                else: runners_fizzled.append(item)
        except: pass

print(f"RUNNERS THAT HIT > +50% ({len(runners_hit50)} tokens):")
for r in runners_hit50:
    s = r['sym']
    bv = r['tot_buy']
    sv = r['tot_sell']
    ms = r['max_sell']
    g1 = r['g1']
    g2 = r['g2']
    dd = r['max_dd']
    ac = r['accel']
    print(f"  {s:10} | BuyVol: ${bv:5.0f} | SellVol: ${sv:4.0f} | MaxSell: ${ms:3.0f} | G1: {g1:+5.1f}% | G2: {g2:+5.1f}% | DD: {dd:3.1f}% | Accel: {ac:3.1f}x")

print(f"\nRUNNERS THAT FIZZLED (< +50%) ({len(runners_fizzled)} tokens):")
for r in runners_fizzled:
    s = r['sym']
    bv = r['tot_buy']
    sv = r['tot_sell']
    ms = r['max_sell']
    g1 = r['g1']
    g2 = r['g2']
    dd = r['max_dd']
    ac = r['accel']
    print(f"  {s:10} | BuyVol: ${bv:5.0f} | SellVol: ${sv:4.0f} | MaxSell: ${ms:3.0f} | G1: {g1:+5.1f}% | G2: {g2:+5.1f}% | DD: {dd:3.1f}% | Accel: {ac:3.1f}x")
