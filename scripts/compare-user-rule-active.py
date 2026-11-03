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

# Ambil token yang punya data tick lengkap (minimal 1 sell tick dari target)
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

print(f"Total Token Aktif yang Ditradingkan: {len(active_tokens)}")

# Test pada active tokens:
# 1. Aturan Lama S4 (Tunggu Target Sell >= 15%)
# 2. Aturan Lama S6 (Stage 1 @ 5%, Stage 2 @ 15%)
# 3. Usulan User: Jika target sell < 20s kita sell, jika sudah 20s LANGSUNG SELL!

def test_on_active(strategy_type, max_sec=20):
    wins = 0
    losses = 0
    total_pnl = 0.0

    for m, fb, sig_list in active_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_in = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens = 1.0 / bot_in
        t_entry = fb.get("timestamp", 0)

        cum_sell = 0.0
        exited = False
        p_out = 0.0

        if strategy_type == "S4":
            for s in sig_list:
                if s.get("action") == "sell":
                    t_amt = s.get("tokenAmount", 0.0)
                    r_h = s.get("remainingHolding", 0.0)
                    tot = t_amt + r_h
                    cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                    is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0
                    if cum_sell >= 15.0 or is_full:
                        exited = True
                        p_out = s.get("priceUsd", 0.0)
                        break

        elif strategy_type == "USER_RULE":
            # Jika target sell < max_sec: sell juga!
            # Jika sudah max_sec: langsung sell!
            evts = [s for s in sig_list if s.get("timestamp", 0) >= t_entry]
            for s in evts:
                dt = s.get("timestamp", 0) - t_entry
                if s.get("action") == "sell":
                    t_amt = s.get("tokenAmount", 0.0)
                    r_h = s.get("remainingHolding", 0.0)
                    tot = t_amt + r_h
                    cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                    is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0
                    if dt < max_sec and (cum_sell >= 5.0 or is_full):
                        exited = True
                        p_out = s.get("priceUsd", 0.0)
                        break
            
            # Jika belum exit di < max_sec: Force sell di detik ke-max_sec!
            if not exited:
                t_max = t_entry + max_sec
                cands = [s for s in evts if abs(s.get("timestamp", 0) - t_max) <= 12]
                if cands:
                    cands.sort(key=lambda s: abs(s.get("timestamp", 0) - t_max))
                    p_out = cands[0].get("priceUsd", 0.0)
                    if p_out > 0: exited = True

        if exited and p_out > 0:
            gross = tokens * p_out
            net = max(0.0, gross - (2 * FEE))
            pnl = net - 1.0
            total_pnl += pnl
            if pnl >= 0: wins += 1
            else: losses += 1
        else:
            total_pnl += -1.0
            losses += 1

    wr = wins / len(active_tokens) * 100
    roi = total_pnl / len(active_tokens) * 100
    return {"wins": wins, "losses": losses, "wr": wr, "pnl": total_pnl, "roi": roi}

res_s4 = test_on_active("S4")
res_u15 = test_on_active("USER_RULE", max_sec=15)
res_u20 = test_on_active("USER_RULE", max_sec=20)
res_u25 = test_on_active("USER_RULE", max_sec=25)
res_u30 = test_on_active("USER_RULE", max_sec=30)

print("\n" + "=" * 90)
print("HASIL PERBANDINGAN PADA TOKEN AKTIF (221 TOKEN):")
print("=" * 90)
print(f"{'Strategi':<35} | {'Win Rate':<10} | {'Win - Loss':<12} | {'Net PnL ($)':<12} | {'ROI %':<8}")
print("-" * 90)
print(f"Aturan S4 Lama (Tunggu Target >= 15%)| {res_s4['wr']:5.1f}%    | {res_s4['wins']:3d}W - {res_s4['losses']:3d}L  | ${res_s4['pnl']:+8.2f}    | {res_s4['roi']:+5.1f}%")
print(f"Usulan User: Force Exit @ 15 Detik  | {res_u15['wr']:5.1f}%    | {res_u15['wins']:3d}W - {res_u15['losses']:3d}L  | ${res_u15['pnl']:+8.2f}    | {res_u15['roi']:+5.1f}%")
print(f"Usulan User: Force Exit @ 20 Detik  | {res_u20['wr']:5.1f}%    | {res_u20['wins']:3d}W - {res_u20['losses']:3d}L  | ${res_u20['pnl']:+8.2f}    | {res_u20['roi']:+5.1f}%")
print(f"Usulan User: Force Exit @ 25 Detik  | {res_u25['wr']:5.1f}%    | {res_u25['wins']:3d}W - {res_u25['losses']:3d}L  | ${res_u25['pnl']:+8.2f}    | {res_u25['roi']:+5.1f}%")
print(f"Usulan User: Force Exit @ 30 Detik  | {res_u30['wr']:5.1f}%    | {res_u30['wins']:3d}W - {res_u30['losses']:3d}L  | ${res_u30['pnl']:+8.2f}    | {res_u30['roi']:+5.1f}%")
