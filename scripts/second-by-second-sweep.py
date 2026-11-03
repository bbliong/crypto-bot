import json
import glob
from collections import defaultdict

# 1. Kumpulkan semua sinyal
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
                    sig["timestamp"] = int(ts)
                    signals.append(sig)
            except: pass

signals.sort(key=lambda s: s.get("timestamp", 0))

tokens = defaultdict(list)
for s in signals:
    m = s.get("mint")
    if m: tokens[m].append(s)

SLIPPAGE_BUY_GAP = 0.234 # 23.4% AMM slippage saat bot masuk
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

print(f"Total token Ground-Zero untuk backtest detik-demi-detik: {len(active_tokens)}")

# Fungsi simulasi per detik T (dari T = 10 detik s/d T = 35 detik)
def simulate_second(time_limit_sec):
    wins = 0
    losses = 0
    total_pnl = 0.0
    exit_target_count = 0
    exit_timer_count = 0

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

        # Cek apakah ada sell target sebelum time_limit_sec
        for s in evts:
            dt = s.get("timestamp", 0) - t_entry
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_h = s.get("remainingHolding", 0.0)
                tot = t_amt + r_h
                cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                p = s.get("priceUsd", 0.0)
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0

                # Stage 1: target sell >= 5% sebelum time_limit_sec
                if not s1_done and dt < time_limit_sec and (cum_sell >= 5.0 or is_full):
                    s1_done = True
                    gross1 = tokens_s1 * p
                    s1_cash = max(0.0, gross1 - FEE)

                # Stage 2: target sell >= 15% sebelum time_limit_sec
                if s1_done and not s2_done and dt < time_limit_sec and (cum_sell >= 15.0 or is_full):
                    s2_done = True
                    gross2 = tokens_s2 * p
                    s2_cash = max(0.0, gross2 - FEE)
                    exit_target_count += 1
                    break

        # Jika belum full exit (s2_done == False), di detik time_limit_sec LAKUKAN FORCE SELL!
        if not s2_done:
            t_force = t_entry + time_limit_sec
            # Cari harga pasar di sekitar detik time_limit_sec (toleransi +- 8 detik)
            cands = [s for s in evts if abs(s.get("timestamp", 0) - t_force) <= 8]
            if cands:
                cands.sort(key=lambda s: abs(s.get("timestamp", 0) - t_force))
                p_force = cands[0].get("priceUsd", 0.0)
                if p_force > 0:
                    exit_timer_count += 1
                    if s1_done:
                        # s1 sudah keluar, force sell sisa s2
                        s2_done = True
                        gross2 = tokens_s2 * p_force
                        s2_cash = max(0.0, gross2 - FEE)
                    else:
                        # s1 belum keluar, force sell seluruh 100%
                        s1_done = True
                        s2_done = True
                        gross_all = tokens_tot * p_force
                        s1_cash = max(0.0, gross_all - (2 * FEE))

        net = s1_cash + s2_cash
        pnl = net - 1.0
        total_pnl += pnl
        if pnl >= 0:
            wins += 1
        else:
            losses += 1

    wr = wins / len(active_tokens) * 100
    roi = total_pnl / len(active_tokens) * 100
    return {
        "sec": time_limit_sec,
        "wins": wins,
        "losses": losses,
        "wr": wr,
        "pnl": total_pnl,
        "roi": roi,
        "exit_target": exit_target_count,
        "exit_timer": exit_timer_count
    }

sweep_results = []
for s in range(10, 36): # 10 detik s/d 35 detik (setiap 1 detik!)
    sweep_results.append(simulate_second(s))

print("\n" + "=" * 100)
print("HASIL BACKTEST RUNUT SETIAP 1 DETIK (DARI DETIK KE-10 S/D DETIK KE-35):")
print("=" * 100)
print(f"{'Detik':<8} | {'Win Rate':<10} | {'Win - Loss':<12} | {'Net PnL USD':<13} | {'ROI %':<8} | {'Exit Target':<12} | {'Force Exit Timer':<16}")
print("-" * 100)

for r in sweep_results:
    mark = " 🏆 (PEAK PNL)" if r["sec"] == max(sweep_results, key=lambda x: x["pnl"])["sec"] else ""
    mark2 = " ⭐ (PEAK WR)" if r["sec"] == max(sweep_results, key=lambda x: x["wr"])["sec"] and not mark else mark
    print(f"{r['sec']:2d}s     | {r['wr']:5.1f}%    | {r['wins']:3d}W - {r['losses']:3d}L  | ${r['pnl']:+7.2f}     | {r['roi']:+5.1f}% | {r['exit_target']:3d} koin     | {r['exit_timer']:3d} koin{mark2}")

# Cari detik dengan performa terbaik
best_pnl = max(sweep_results, key=lambda x: x["pnl"])
best_wr = max(sweep_results, key=lambda x: x["wr"])

print("\n" + "=" * 80)
print(f"🎯 KESIMPULAN TITIK DETIK PALING OPTIMAL:")
print(f"  • Detik Paling Menguntungkan (Net PnL Tertinggi) : Detik ke-{best_pnl['sec']}s (${best_pnl['pnl']:+.2f} USD, Win Rate {best_pnl['wr']:.1f}%)")
print(f"  • Detik Win Rate Tertinggi                      : Detik ke-{best_wr['sec']}s ({best_wr['wr']:.1f}% WR, Net PnL ${best_wr['pnl']:+.2f} USD)")
