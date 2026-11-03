import json
import glob
from collections import defaultdict

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

SLIPPAGE_BUY_GAP = 0.23
FEE = 0.025

# Cek performa jika exit di 10% vs 12% vs 15% pada token-token ini
results = {8: [], 10: [], 12: [], 15: [], 18: [], 20: []}

for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    if not buys: continue
    fb = buys[0]
    p_in = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if not (is_gz and p_in <= 0.000020): continue

    bot_entry_p = p_in * (1.0 + SLIPPAGE_BUY_GAP)
    tokens_bought = 1.0 / bot_entry_p

    # Track exit for each threshold
    for th in [8, 10, 12, 15, 18, 20]:
        cum_sell = 0.0
        exited = False
        p_exit = 0.0
        for s in sig_list:
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_hold = s.get("remainingHolding", 0.0)
                tot_before = r_hold + t_amt
                ratio_pct = (t_amt / tot_before * 100.0) if tot_before > 0 else 0.0
                cum_sell += ratio_pct
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_hold <= 0
                if cum_sell >= th or is_full:
                    exited = True
                    p_exit = s.get("priceUsd", 0.0)
                    break
        
        if exited and p_exit > 0:
            gross = tokens_bought * p_exit
            net = max(0.0, gross - (2 * FEE))
            pnl = net - 1.0
            results[th].append({"win": pnl >= 0, "pnl": pnl, "roi": pnl * 100.0})
        else:
            results[th].append({"win": False, "pnl": -1.0, "roi": -100.0})

print("=" * 85)
print("PERBANDINGAN HASIL THRESHOLD (BERDASARKAN DATA REAL TOKENS):")
print("=" * 85)
print(f"{'Threshold':<12} | {'Total Trades':<12} | {'Win Rate':<12} | {'Win / Loss':<12} | {'Net PnL ($)':<14} | {'Avg ROI':<10}")
print("-" * 85)
for th in [8, 10, 12, 15, 18, 20]:
    res = results[th]
    wins = sum(1 for r in res if r["win"])
    losses = len(res) - wins
    wr = wins / len(res) * 100.0
    tot_pnl = sum(r["pnl"] for r in res)
    avg_roi = sum(r["roi"] for r in res) / len(res)
    th_label = f">= {th}%" + (" (AKTIF)" if th == 15 else "")
    print(f"{th_label:<12} | {len(res):<12} | {wr:5.1f}%      | {wins}W - {losses}L    | ${tot_pnl:+8.2f}     | {avg_roi:+6.1f}%")
