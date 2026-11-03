import json
import glob
import os
import re
from collections import defaultdict

# 1. Kumpulkan semua signal dari semua jsonl
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

# Kumpulkan closed trades dari S4
files_json = ["/home/bbliong/project/crypto-bot/data/dryrun-3scenarios-live.json"]
files_json += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/dryrun-3scenarios-live.json")

seen_trades = set()
s4_trades = []
for f in files_json:
    if not os.path.exists(f): continue
    try:
        with open(f) as fp: d = json.load(fp)
        for t in d.get("s4", {}).get("closedTrades", []):
            key = (t.get("mint"), t.get("openedAt"))
            if key not in seen_trades:
                seen_trades.add(key)
                s4_trades.append(t)
    except: pass

print(f"Total S4 Closed Trades: {len(s4_trades)}")

# Cek setiap trade S4:
# Berapa total max sell percentage yang PERNAH dicapai target sebelum token mati?
trade_stats = []
for t in s4_trades:
    m = t.get("mint")
    sym = t.get("symbol")
    sig_list = tokens.get(m, [])
    
    # hitung total cumulative sell target seumur hidup token
    tot_cum_sell = 0.0
    sells = [s for s in sig_list if s.get("action") == "sell"]
    for s in sells:
        t_amt = s.get("tokenAmount", 0.0)
        r_hold = s.get("remainingHolding", 0.0)
        tot_b = r_hold + t_amt
        if tot_b > 0:
            tot_cum_sell += (t_amt / tot_b * 100.0)

    trade_stats.append({
        "symbol": sym,
        "mint": m,
        "roi": t.get("roiPct", 0),
        "is_win": t.get("isWin", False),
        "total_target_cum_sell": tot_cum_sell
    })

print(f"Total trade teranalisis: {len(trade_stats)}")
# Evaluasi jika threshold diubah ke: 15% vs 18% vs 20% vs 25%
for target_th in [15.0, 18.0, 20.0, 25.0, 30.0]:
    # Jika total target cum sell < target_th: trade TIDAK PERNAH trigger exit -> RUGPULL / STUCK!
    can_exit = sum(1 for ts in trade_stats if ts["total_target_cum_sell"] >= target_th)
    stuck_or_rugged = len(trade_stats) - can_exit
    pct_exit = can_exit / len(trade_stats) * 100
    print(f"Threshold >= {target_th:4.1f}% -> Berhasil Exit: {can_exit:3d}/{len(trade_stats)} ({pct_exit:5.1f}%) | Tersangkut / Rugpull: {stuck_or_rugged:3d}")
