import json
import glob
from collections import defaultdict

# 1. Kumpulkan seluruh sinyal dari ledger dan backup
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

SLIPPAGE_BUY_GAP = 0.234 # 23.4% AMM slippage saat bot masuk
FEE = 0.025              # $0.025 fee per swap

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

print(f"Total Ground-Zero Tokens untuk Backtest: {len(gz_tokens)}")

# STRATEGI 1: Baseline S4 Aktif (Exit saat target jual akumulatif >= 15% atau target full exit)
def run_baseline_s4():
    wins = 0
    losses = 0
    total_pnl = 0.0
    for m, fb, sig_list in gz_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_in = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens = 1.0 / bot_in
        cum_sell = 0.0
        exited = False
        p_out = 0.0
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
    return {"name": "Baseline S4 (Target Sell >= 15%)", "wins": wins, "losses": losses, "pnl": total_pnl}

# STRATEGI 2: Baseline S6 Aktif (Stage 1 @ 5%, Stage 2 @ 15%)
def run_baseline_s6():
    wins = 0
    losses = 0
    total_pnl = 0.0
    for m, fb, sig_list in gz_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_in = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens = 1.0 / bot_in
        tokens_s1 = tokens * 0.5
        tokens_s2 = tokens * 0.5
        cum_sell = 0.0
        s1_done = False
        s2_done = False
        s1_cash = 0.0
        s2_cash = 0.0
        for s in sig_list:
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_h = s.get("remainingHolding", 0.0)
                tot = t_amt + r_h
                cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                p = s.get("priceUsd", 0.0)
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0
                if not s1_done and (cum_sell >= 5.0 or is_full):
                    s1_done = True
                    gross1 = tokens_s1 * p
                    s1_cash = max(0.0, gross1 - FEE)
                if s1_done and not s2_done and (cum_sell >= 15.0 or is_full):
                    s2_done = True
                    gross2 = tokens_s2 * p
                    s2_cash = max(0.0, gross2 - FEE)
                    break
        net = s1_cash + s2_cash
        pnl = net - 1.0
        total_pnl += pnl
        if pnl >= 0: wins += 1
        else: losses += 1
    return {"name": "Baseline S6 (Split TP 5% & 15%)", "wins": wins, "losses": losses, "pnl": total_pnl}

# STRATEGI 3: Usulan Baru User (Single Exit)
# "Jika target sell sebelum 20 detik kita sell juga, tapi jika sudah 20 detik kita langsung sell!"
def run_user_strategy_single_exit(target_sell_threshold=5.0, max_time_seconds=20):
    wins = 0
    losses = 0
    total_pnl = 0.0
    exited_by_target = 0
    exited_by_time_20s = 0
    rugged_before_20s = 0

    for m, fb, sig_list in gz_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_in = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens = 1.0 / bot_in
        t_entry = fb.get("timestamp", 0)

        cum_sell = 0.0
        exited = False
        p_out = 0.0
        exit_mode = ""

        # Urutkan sinyal setelah entry
        evts = [s for s in sig_list if s.get("timestamp", 0) >= t_entry]

        # Cek apakah ada target sell sebelum 20 detik
        for s in evts:
            dt = s.get("timestamp", 0) - t_entry
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_h = s.get("remainingHolding", 0.0)
                tot = t_amt + r_h
                cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0

                # Jika target sell sebelum 20 detik memenuhi syarat:
                if dt < max_time_seconds and (cum_sell >= target_sell_threshold or is_full):
                    exited = True
                    p_out = s.get("priceUsd", 0.0)
                    exit_mode = "TARGET_SELL_PRE_20S"
                    exited_by_target += 1
                    break

        # Jika target BELUM sell dan waktu mencapai 20 detik: LANGSUNG SELL!
        if not exited:
            # Cari harga pasar di sekitar detik ke-20
            # Ambil sinyal terdekat pada t_entry + 20s
            t_20s = t_entry + max_time_seconds
            cand_ticks = [s for s in evts if abs(s.get("timestamp", 0) - t_20s) <= 10]
            if cand_ticks:
                cand_ticks.sort(key=lambda s: abs(s.get("timestamp", 0) - t_20s))
                p_out = cand_ticks[0].get("priceUsd", 0.0)
                if p_out > 0:
                    exited = True
                    exit_mode = "FORCE_TIME_EXIT_20S"
                    exited_by_time_20s += 1
            else:
                # Token langsung mati / rugpull sebelum 20s
                rugged_before_20s += 1

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

    return {
        "name": f"Usulan User Single Exit (Target Sell < 20s ATAU Force 20s)",
        "wins": wins,
        "losses": losses,
        "pnl": total_pnl,
        "exited_by_target": exited_by_target,
        "exited_by_time_20s": exited_by_time_20s,
        "rugged_before_20s": rugged_before_20s
    }

# STRATEGI 4: Usulan User dengan Split TP (S6 Hybrid)
# Stage 1: Jika target sell < 20s, sell 50% @ 5%
# Stage 2: Begitu detik 20 tiba, LANGSUNG SELL 100% SISA TOKEN tanpa tunggu target!
def run_user_strategy_hybrid_split(max_time_seconds=20):
    wins = 0
    losses = 0
    total_pnl = 0.0

    for m, fb, sig_list in gz_tokens:
        p_in = fb.get("priceUsd", 0.0)
        bot_in = p_in * (1.0 + SLIPPAGE_BUY_GAP)
        tokens = 1.0 / bot_in
        tokens_s1 = tokens * 0.5
        tokens_s2 = tokens * 0.5
        t_entry = fb.get("timestamp", 0)

        cum_sell = 0.0
        s1_done = False
        s2_done = False
        s1_cash = 0.0
        s2_cash = 0.0

        evts = [s for s in sig_list if s.get("timestamp", 0) >= t_entry]

        for s in evts:
            dt = s.get("timestamp", 0) - t_entry
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_h = s.get("remainingHolding", 0.0)
                tot = t_amt + r_h
                cum_sell += (t_amt / tot * 100.0) if tot > 0 else 0.0
                p = s.get("priceUsd", 0.0)
                is_full = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_h <= 0

                # Stage 1 sebelum 20s
                if not s1_done and dt < max_time_seconds and (cum_sell >= 5.0 or is_full):
                    s1_done = True
                    gross1 = tokens_s1 * p
                    s1_cash = max(0.0, gross1 - FEE)

        # Di detik 20: Jual seluruh sisa token (baik sisa 50% atau masih 100%)
        t_20s = t_entry + max_time_seconds
        cand_ticks = [s for s in evts if abs(s.get("timestamp", 0) - t_20s) <= 10]
        if cand_ticks:
            cand_ticks.sort(key=lambda s: abs(s.get("timestamp", 0) - t_20s))
            p_20s = cand_ticks[0].get("priceUsd", 0.0)
            if p_20s > 0:
                if s1_done:
                    # Jual sisa 50%
                    s2_done = True
                    gross2 = tokens_s2 * p_20s
                    s2_cash = max(0.0, gross2 - FEE)
                else:
                    # Jual seluruh 100%
                    s1_done = True
                    s2_done = True
                    gross_all = tokens * p_20s
                    s1_cash = max(0.0, gross_all - (2 * FEE))

        net = s1_cash + s2_cash
        pnl = net - 1.0
        total_pnl += pnl
        if pnl >= 0: wins += 1
        else: losses += 1

    return {
        "name": f"Usulan User Hybrid S6 (Stage 1 @ 5% < 20s + Force Sell 100% @ 20s)",
        "wins": wins,
        "losses": losses,
        "pnl": total_pnl
    }

b_s4 = run_baseline_s4()
b_s6 = run_baseline_s6()
u_single = run_user_strategy_single_exit(target_sell_threshold=5.0, max_time_seconds=20)
u_hybrid = run_user_strategy_hybrid_split(max_time_seconds=20)

# Uji variasi detik: 15s, 20s, 25s, 30s untuk Usulan User
time_variations = {}
for sec in [15, 18, 20, 25, 30]:
    time_variations[sec] = run_user_strategy_single_exit(target_sell_threshold=5.0, max_time_seconds=sec)

print("\n" + "=" * 95)
print("HASIL KOMPARASI BACKTEST: ATURAN SAAT INI vs USULAN EXIT 20 DETIK (255 Koin Ground Zero)")
print("=" * 95)
print(f"{'Strategi':<45} | {'Win Rate':<10} | {'Win - Loss':<12} | {'Net PnL ($)':<12} | {'ROI %':<8}")
print("-" * 95)

for strat in [b_s4, b_s6, u_single, u_hybrid]:
    wr = strat['wins'] / 255 * 100
    roi = strat['pnl'] / 255 * 100
    print(f"{strat['name']:<45} | {wr:5.1f}%    | {strat['wins']:3d}W - {strat['losses']:3d}L  | ${strat['pnl']:+8.2f}    | {roi:+5.1f}%")

print("\n" + "=" * 95)
print("BEDAH DETAIL STRATEGI USULAN USER (Target Sell < 20s ATAU Force Exit @ 20s):")
print(f"  • Total Koin yang Menang      : {u_single['wins']} dari 255 koin ({u_single['wins']/255*100:.1f}% Win Rate)!")
print(f"  • Exit Karena Target Sell <20s: {u_single['exited_by_target']} koin")
print(f"  • Exit Karena Force Detik 20  : {u_single['exited_by_time_20s']} koin")
print(f"  • Rugpull Instan (<20s)       : {u_single['rugged_before_20s']} koin")

print("\n" + "=" * 95)
print("VARIASI BATAS WAKTU (TIME-STOP): MANA DETIK PALING OPTIMAL?")
print("=" * 95)
print(f"{'Batas Waktu':<15} | {'Win Rate':<10} | {'Win - Loss':<12} | {'Net PnL ($)':<12} | {'ROI %':<8}")
print("-" * 95)
for sec, res in time_variations.items():
    wr = res['wins'] / 255 * 100
    roi = res['pnl'] / 255 * 100
    print(f"Max {sec} Detik     | {wr:5.1f}%    | {res['wins']:3d}W - {res['losses']:3d}L  | ${res['pnl']:+8.2f}    | {roi:+5.1f}%")
