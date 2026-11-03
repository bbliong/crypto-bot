import json
import glob
import os
from collections import defaultdict

files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/*.jsonl")

signals = []
seen_tx = set()
for f in files:
    with open(f) as fp:
        for line in fp:
            if not line.strip(): continue
            try:
                obj = json.loads(line)
                sig = obj.get("details", {}).get("signal")
                if sig and sig.get("txHash") and sig.get("txHash") not in seen_tx:
                    seen_tx.add(sig.get("txHash"))
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

# Ambil token yang lolos Ground Zero (First Buy <= $0.000020)
gz_tokens = []
for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    if not buys: continue
    fb = buys[0]
    p_in = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if is_gz and p_in <= 0.000020:
        gz_tokens.append((m, fb, sig_list))

print(f"Total Ground-Zero Tokens: {len(gz_tokens)}")

SLIPPAGE_BUY_GAP = 0.23
FEE = 0.025

# Evaluasi S6 Split TP:
# Stage 1: Sell 50% @ 5%
# Stage 2: Test threshold 10%, 12%, 15%, 18%, 20%, 25%
for stage2_th in [10.0, 12.0, 15.0, 18.0, 20.0, 25.0]:
    total_invested = len(gz_tokens) * 1.0 # $1 per trade
    total_returned = 0.0
    wins = 0
    losses = 0
    stage1_wins = 0
    stage2_completions = 0

    for m, fb, sig_list in gz_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_entry_p = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens_total = 1.0 / bot_entry_p
        tokens_s1 = tokens_total * 0.5
        tokens_s2 = tokens_total * 0.5

        cum_sell = 0.0
        s1_done = False
        s2_done = False
        s1_cash = 0.0
        s2_cash = 0.0

        for s in sig_list:
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_hold = s.get("remainingHolding", 0.0)
                tot_b = r_hold + t_amt
                ratio_pct = (t_amt / tot_b * 100.0) if tot_b > 0 else 0.0
                cum_sell += ratio_pct
                p = s.get("priceUsd", 0.0)
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_hold <= 0

                if not s1_done and (cum_sell >= 5.0 or is_full):
                    s1_done = True
                    stage1_wins += 1
                    gross1 = tokens_s1 * p
                    s1_cash = max(0.0, gross1 - FEE)

                if s1_done and not s2_done and (cum_sell >= stage2_th or is_full):
                    s2_done = True
                    stage2_completions += 1
                    gross2 = tokens_s2 * p
                    s2_cash = max(0.0, gross2 - FEE)
                    break

        net_ret = s1_cash + s2_cash
        total_returned += net_ret
        pnl = net_ret - 1.0
        if pnl >= 0:
            wins += 1
        else:
            losses += 1

    net_pnl = total_returned - total_invested
    wr = wins / len(gz_tokens) * 100
    roi = net_pnl / total_invested * 100
    th_label = f"Stage 2 >= {stage2_th:.0f}%" + (" (AKTIF)" if stage2_th == 15.0 else "")
    print(f"{th_label:<22} | WR: {wr:5.1f}% ({wins}W - {losses}L) | Stage 2 Finish: {stage2_completions:3d}/{len(gz_tokens)} | Net PnL: ${net_pnl:+7.2f} | ROI: {roi:+6.1f}%")
