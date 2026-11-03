import json
import glob
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# 1. Load all signals from all jsonl files
files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/*.jsonl")

signals = []
seen = set()
for f in files:
    with open(f) as fp:
        for line in fp:
            if not line.strip():
                continue
            try:
                obj = json.loads(line)
                sig = obj.get("details", {}).get("signal")
                if sig and sig.get("txHash") and sig.get("txHash") not in seen:
                    seen.add(sig.get("txHash"))
                    ts = sig.get("timestamp", 0)
                    if ts > 1e11:
                        ts /= 1000
                    sig["timestamp"] = ts
                    # attach quote info if available
                    quote = obj.get("details", {}).get("response", {}).get("swap", {}).get("quote")
                    sig["quote"] = quote
                    signals.append(sig)
            except Exception:
                pass

signals.sort(key=lambda s: s.get("timestamp", 0))

tokens = defaultdict(list)
for s in signals:
    m = s.get("mint")
    if m:
        tokens[m].append(s)

# Extract Ground-Zero Tokens
gz_tokens = {}
for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    if not buys:
        continue
    fb = buys[0]
    p_in = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if is_gz and p_in <= 0.000020:
        gz_tokens[m] = {
            "symbol": fb.get("symbol", "UNKNOWN"),
            "first_buy": fb,
            "signals": sig_list
        }

total_gz = len(gz_tokens)
print(f"Total Ground-Zero Tokens untuk Backtest: {total_gz}")

FEE_PER_SWAP_USD = 0.025
SLIPPAGE_BUY_GAP = 0.23  # Real AMM slippage gap rata-rata +23% dibanding target buy

def simulate_strategy_s4(threshold_pct, stake_usd=1.0):
    wins = 0
    losses = 0
    total_invested = 0.0
    total_returned = 0.0
    total_pnl = 0.0
    trades_detail = []

    for m, data in gz_tokens.items():
        fb = data["first_buy"]
        target_buy_p = fb.get("priceUsd", 0.0)
        bot_entry_p = target_buy_p * (1.0 + SLIPPAGE_BUY_GAP)
        tokens_bought = stake_usd / bot_entry_p if bot_entry_p > 0 else 0

        cum_sell_pct = 0.0
        exited = False
        exit_p = 0.0
        exit_reason = ""

        # Walk through sell signals
        for s in data["signals"]:
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_hold = s.get("remainingHolding", 0.0)
                tot_before = r_hold + t_amt
                ratio_pct = (t_amt / tot_before * 100.0) if tot_before > 0 else 0.0
                cum_sell_pct += ratio_pct
                
                is_full_exit = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_hold <= 0
                
                if cum_sell_pct >= threshold_pct or is_full_exit:
                    exited = True
                    exit_p = s.get("priceUsd", 0.0)
                    exit_reason = f"CUM_SELL_{cum_sell_pct:.1f}%_GTE_{threshold_pct}%" if not is_full_exit else "FULL_EXIT_100%"
                    break

        total_invested += stake_usd
        if exited and exit_p > 0:
            gross_return = tokens_bought * exit_p
            net_return = max(0.0, gross_return - (2 * FEE_PER_SWAP_USD))
            pnl = net_return - stake_usd
            is_win = pnl >= 0
            if is_win:
                wins += 1
            else:
                losses += 1
            total_returned += net_return
            total_pnl += pnl
        else:
            # Rugpull / Dead pool / Threshold never reached
            net_return = 0.0
            pnl = -stake_usd
            losses += 1
            total_returned += 0.0
            total_pnl += pnl

    wr = (wins / total_gz * 100.0) if total_gz > 0 else 0.0
    roi = (total_pnl / total_invested * 100.0) if total_invested > 0 else 0.0
    return {
        "threshold": threshold_pct,
        "wins": wins,
        "losses": losses,
        "win_rate": wr,
        "total_invested": total_invested,
        "total_returned": total_returned,
        "net_pnl": total_pnl,
        "roi_pct": roi
    }

def simulate_strategy_s6(stage2_threshold_pct, pool1_stake=1.0):
    stage1_th = 5.0 # Fixed stage 1 at 5%
    wins = 0
    losses = 0
    total_invested = 0.0
    total_returned = 0.0
    total_pnl = 0.0

    for m, data in gz_tokens.items():
        fb = data["first_buy"]
        target_buy_p = fb.get("priceUsd", 0.0)
        bot_entry_p = target_buy_p * (1.0 + SLIPPAGE_BUY_GAP)
        stake = pool1_stake
        tokens_bought = stake / bot_entry_p if bot_entry_p > 0 else 0

        tokens_s1 = tokens_bought * 0.5
        tokens_s2 = tokens_bought * 0.5
        stake_s1 = stake * 0.5
        stake_s2 = stake * 0.5

        cum_sell_pct = 0.0
        s1_exited = False
        s2_exited = False
        s1_return = 0.0
        s2_return = 0.0

        for s in data["signals"]:
            if s.get("action") == "sell":
                t_amt = s.get("tokenAmount", 0.0)
                r_hold = s.get("remainingHolding", 0.0)
                tot_before = r_hold + t_amt
                ratio_pct = (t_amt / tot_before * 100.0) if tot_before > 0 else 0.0
                cum_sell_pct += ratio_pct
                is_full_exit = s.get("isOpenOrClose") is True or s.get("ooc") == 1 or r_hold <= 0

                # Check Stage 1
                if not s1_exited and (cum_sell_pct >= stage1_th or is_full_exit):
                    s1_exited = True
                    p_out1 = s.get("priceUsd", 0.0)
                    gross1 = tokens_s1 * p_out1
                    s1_return = max(0.0, gross1 - FEE_PER_SWAP_USD)

                # Check Stage 2 (Runner)
                if s1_exited and not s2_exited and (cum_sell_pct >= stage2_threshold_pct or is_full_exit):
                    s2_exited = True
                    p_out2 = s.get("priceUsd", 0.0)
                    gross2 = tokens_s2 * p_out2
                    s2_return = max(0.0, gross2 - FEE_PER_SWAP_USD)
                    break

        total_invested += stake
        net_trade_return = s1_return + s2_return
        trade_pnl = net_trade_return - stake
        is_win = trade_pnl >= 0

        if is_win:
            wins += 1
        else:
            losses += 1

        total_returned += net_trade_return
        total_pnl += trade_pnl

    wr = (wins / total_gz * 100.0) if total_gz > 0 else 0.0
    roi = (total_pnl / total_invested * 100.0) if total_invested > 0 else 0.0
    return {
        "stage2_threshold": stage2_threshold_pct,
        "wins": wins,
        "losses": losses,
        "win_rate": wr,
        "total_invested": total_invested,
        "total_returned": total_returned,
        "net_pnl": total_pnl,
        "roi_pct": roi
    }

# Run tests
test_thresholds = [8.0, 10.0, 12.0, 15.0, 18.0, 20.0, 25.0, 30.0, 40.0, 50.0]

print("\n" + "=" * 90)
print("HASIL BACKTEST SKENARIO 4 (SINGLE BUY): MEMBANDINGKAN THRESHOLD EXIT %")
print("=" * 90)
print(f"{'Threshold':<11} | {'Win Rate':<10} | {'Win - Loss':<12} | {'Total Modal':<12} | {'Net PnL USD':<14} | {'ROI %':<10}")
print("-" * 90)
for th in test_thresholds:
    res = simulate_strategy_s4(th)
    th_label = f">= {th:.0f}%" + (" (AKTIF)" if th == 15.0 else "")
    print(f"{th_label:<11} | {res['win_rate']:5.1f}%    | {res['wins']}W - {res['losses']}L   | ${res['total_invested']:.2f}     | ${res['net_pnl']:+8.2f} USD   | {res['roi_pct']:+6.1f}%")

print("\n" + "=" * 90)
print("HASIL BACKTEST SKENARIO 6 (SPLIT TP 50/50: STAGE 1 @ 5% | STAGE 2 RUNNER %)")
print("=" * 90)
print(f"{'Stage 2 Th':<11} | {'Win Rate':<10} | {'Win - Loss':<12} | {'Total Modal':<12} | {'Net PnL USD':<14} | {'ROI %':<10}")
print("-" * 90)
for th in test_thresholds:
    res = simulate_strategy_s6(th)
    th_label = f">= {th:.0f}%" + (" (AKTIF)" if th == 15.0 else "")
    print(f"{th_label:<11} | {res['win_rate']:5.1f}%    | {res['wins']}W - {res['losses']}L   | ${res['total_invested']:.2f}     | ${res['net_pnl']:+8.2f} USD   | {res['roi_pct']:+6.1f}%")
