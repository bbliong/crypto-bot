import json
from datetime import datetime, timezone, timedelta

# Analisis 20 token Ground-Zero terbaru hari ini second-by-second
from collections import defaultdict

files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
with open(files[0]) as f:
    lines = [json.loads(l) for l in f if l.strip()]

mints = {}
for e in lines:
    sig = e.get("details", {}).get("signal", {})
    m = sig.get("mint")
    if m:
        if m not in mints: mints[m] = []
        mints[m].append(sig)

print(f"Total tokens in today's ledger: {len(mints)}")

# Test today's tokens across seconds: 15s, 20s, 25s, 28s, 30s, 33s, 35s
for sec in [15, 20, 25, 28, 30, 33, 35]:
    wins = 0
    losses = 0
    pnl = 0.0
    for m, sigs in mints.items():
        buys = [s for s in sigs if s.get("action") == "buy"]
        sells = [s for s in sigs if s.get("action") == "sell"]
        if not buys: continue
        fb = buys[0]
        p_in = fb.get("priceUsd", 0)
        if p_in > 0.000020 or p_in <= 0: continue
        bot_in = p_in * 1.234
        toks = 1.0 / bot_in
        t_entry = fb.get("timestamp", 0)
        
        # exit logic
        exited = False
        p_out = 0.0
        evts = [s for s in sigs if s.get("timestamp", 0) >= t_entry]
        for s in evts:
            dt = s.get("timestamp", 0) - t_entry
            if s.get("action") == "sell":
                r_h = s.get("remainingHolding", 0)
                t_amt = s.get("tokenAmount", 0)
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0
                if dt < sec and ((t_amt / (r_h + t_amt) >= 0.05) or is_full):
                    exited = True
                    p_out = s.get("priceUsd", 0)
                    break
        if not exited:
            # find price at sec
            cand = [s for s in evts if abs(s.get("timestamp", 0) - (t_entry + sec)) <= 8]
            if cand:
                cand.sort(key=lambda s: abs(s.get("timestamp", 0) - (t_entry + sec)))
                p_out = cand[0].get("priceUsd", 0)
                if p_out > 0: exited = True
        
        if exited and p_out > 0:
            trade_pnl = (toks * p_out - 0.05) - 1.0
            pnl += trade_pnl
            if trade_pnl >= 0: wins += 1
            else: losses += 1
        else:
            pnl -= 1.0
            losses += 1
            
    print(f"Hari ini @ {sec:2d}s: {wins}W - {losses}L (WR: {wins/(wins+losses)*100:.1f}%) | Net PnL: ${pnl:+.2f}")
