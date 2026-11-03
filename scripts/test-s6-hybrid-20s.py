import json
import glob
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

SLIPPAGE_BUY_GAP = 0.234
FEE = 0.025

active_tokens = []
for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    sells = [s for s in sig_list if s.get("action") == "sell"]
    if not buys or not sells: continue
    fb = buys[0]
    p_in = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if is_gz and p_in <= 0.000020:
        active_tokens.append((m, fb, sig_list))

def test_s6_hybrid(force_sec=20):
    wins = 0
    losses = 0
    total_pnl = 0.0

    for m, fb, sig_list in active_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_in = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens_tot = 1.0 / bot_in
        tokens_s1 = tokens_tot * 0.5
        tokens_s2 = tokens_tot * 0.5
        t_entry = fb.get("timestamp", 0)

        cum_sell = 0.0
        s1_done = False
        s2_done = False
        s1_cash = 0.0
        s2_cash = 0.0

        evts = [s for s in sig_list if s.get("timestamp", 0) >= t_entry]

        # Stage 1: target sells >= 5% sebelum force_sec
        for s in evts:
            dt = s.get("timestamp", 0) - t_entry
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_h = s.get("remainingHolding", 0.0)
                tot = t_amt + r_h
                cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                p = s.get("priceUsd", 0.0)
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0

                if not s1_done and dt < force_sec and (cum_sell >= 5.0 or is_full):
                    s1_done = True
                    gross1 = tokens_s1 * p
                    s1_cash = max(0.0, gross1 - FEE)

                # Jika target sudah sell >= 15% sebelum force_sec
                if s1_done and not s2_done and dt < force_sec and (cum_sell >= 15.0 or is_full):
                    s2_done = True
                    gross2 = tokens_s2 * p
                    s2_cash = max(0.0, gross2 - FEE)
                    break

        # Di detik force_sec: Force Sell sisa posisi!
        if not s2_done:
            t_force = t_entry + force_sec
            cands = [s for s in evts if abs(s.get("timestamp", 0) - t_force) <= 12]
            if cands:
                cands.sort(key=lambda s: abs(s.get("timestamp", 0) - t_force))
                p_force = cands[0].get("priceUsd", 0.0)
                if p_force > 0:
                    if s1_done:
                        # s1 sudah selesai, jual sisa s2
                        s2_done = True
                        gross2 = tokens_s2 * p_force
                        s2_cash = max(0.0, gross2 - FEE)
                    else:
                        # s1 belum selesai, jual 100%
                        s1_done = True
                        s2_done = True
                        gross_all = tokens_tot * p_force
                        s1_cash = max(0.0, gross_all - (2 * FEE))

        net = s1_cash + s2_cash
        pnl = net - 1.0
        total_pnl += pnl
        if pnl >= 0: wins += 1
        else: losses += 1

    wr = wins / len(active_tokens) * 100
    roi = total_pnl / len(active_tokens) * 100
    return {"wins": wins, "losses": losses, "wr": wr, "pnl": total_pnl, "roi": roi}

for s in [15, 20, 25, 30]:
    r = test_s6_hybrid(s)
    print(f"S6 Hybrid + Force Sell @ {s:2d}s | WR: {r['wr']:5.1f}% ({r['wins']}W - {r['losses']}L) | Net PnL: ${r['pnl']:+7.2f} | ROI: {r['roi']:+5.1f}%")
