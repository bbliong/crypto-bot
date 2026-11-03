#!/usr/bin/env python3
import json
import glob
import os
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

def load_all_ledgers():
    ledger_files = glob.glob("/home/bbliong/project/crypto-bot/data/**/follower-real-ledger.jsonl", recursive=True)
    ledger_files.append("/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl")
    ledger_files = sorted(list(set(ledger_files)), key=lambda x: os.path.getmtime(x))
    
    all_entries = []
    seen_keys = set()
    
    for fpath in ledger_files:
        if not os.path.exists(fpath):
            continue
        with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    # Unique key by timestamp + type + mint
                    at = e.get("at", 0)
                    etype = e.get("type", "")
                    d = e.get("details", {})
                    sig = d.get("signal", {})
                    mint = sig.get("mint") or d.get("mint") or ""
                    key = (at, etype, mint)
                    if key not in seen_keys:
                        seen_keys.add(key)
                        all_entries.append(e)
                except Exception:
                    pass
    
    print(f"Total unique ledger events loaded across all history: {len(all_entries)}")
    return all_entries

def analyze_trades(entries):
    # Group by (scenarioId, mint)
    grouped = {}
    for e in entries:
        d = e.get("details", {})
        sig = d.get("signal", {})
        sc_id = d.get("scenarioId")
        mint = sig.get("mint") or d.get("mint")
        if not sc_id or not mint:
            continue
        key = (sc_id, mint)
        if key not in grouped:
            grouped[key] = []
        grouped[key].append(e)

    # We will analyze S6 primarily, and also S4
    results = []

    for (sc_id, mint), evts in grouped.items():
        # Sort by timestamp
        evts = sorted(evts, key=lambda x: x.get("at", 0))
        
        # 1. Find BUY event
        buy_evts = [e for e in evts if "BUY" in e.get("type", "")]
        if not buy_evts:
            continue
        
        b = buy_evts[0]
        bd = b.get("details", {})
        b_sig = bd.get("signal", {})
        b_swap = bd.get("response", {}).get("swap", {})
        b_quote = b_swap.get("quote", {})
        
        target_buy_price = b_sig.get("priceUsd", 0.0)
        target_buy_usd = b_sig.get("usdAmount", 0.0)
        target_buy_sol = b_sig.get("solAmount", 0.0)
        symbol = b_sig.get("symbol") or bd.get("symbol") or "UNKNOWN"
        exchange = b_swap.get("exchange") or "unknown"
        
        b_in_sol = int(b_quote.get("inAmount", 0)) / 1e9 if b_quote.get("inAmount") else 0.0
        b_out_tokens = int(b_quote.get("outAmount", 0)) / 1e6 if b_quote.get("outAmount") else 0.0 # assume 6 decimals
        
        if b_in_sol <= 0 or b_out_tokens <= 0:
            continue
        
        # Approximate SOL price at time of buy
        sol_price_usd = (target_buy_usd / target_buy_sol) if (target_buy_sol > 0 and target_buy_usd > 0) else 93.0
        
        # Bot Real Swap Entry Price in USD
        bot_buy_price_usd = (b_in_sol * sol_price_usd) / b_out_tokens if b_out_tokens > 0 else 0.0
        
        # Entry Slippage Premium (% bot bought higher than target)
        entry_premium_pct = ((bot_buy_price_usd - target_buy_price) / target_buy_price * 100) if target_buy_price > 0 else 0.0

        # 2. Find SELL events
        sell_evts = [e for e in evts if "SELL" in e.get("type", "") and "NO_ROUTE" not in e.get("type", "")]
        no_route_evts = [e for e in evts if "NO_ROUTE" in e.get("type", "")]

        # Dev rug pull check
        if not sell_evts and no_route_evts:
            results.append({
                "scenario": sc_id,
                "mint": mint,
                "symbol": symbol,
                "time": datetime.fromtimestamp(b.get("at", 0)/1000, tz=wib).strftime("%Y-%m-%d %H:%M:%S"),
                "exchange": exchange,
                "target_buy_price": target_buy_price,
                "bot_buy_price": bot_buy_price_usd,
                "entry_premium_pct": entry_premium_pct,
                "target_buy_usd": target_buy_usd,
                "target_sell_price": 0.0,
                "bot_sell_price": 0.0,
                "exit_gap_pct": -100.0,
                "real_swap_roi": -100.0,
                "target_signal_roi": -100.0,
                "hold_seconds": 30,
                "is_rug": True,
                "outcome": "LOSS_RUG"
            })
            continue

        if not sell_evts:
            continue

        # Calculate actual SOL returned across sells
        s_in_tokens_total = 0.0
        s_out_sol_total = 0.0
        target_sell_prices = []
        last_sell_at = b.get("at", 0)

        for s in sell_evts:
            sd = s.get("details", {})
            s_sig = sd.get("signal", {})
            s_swap = sd.get("response", {}).get("swap", {})
            s_quote = s_swap.get("quote", {})
            
            s_in_tokens = int(s_quote.get("inAmount", 0)) / 1e6 if s_quote.get("inAmount") else 0.0
            s_out_sol = int(s_quote.get("outAmount", 0)) / 1e9 if s_quote.get("outAmount") else 0.0
            
            s_in_tokens_total += s_in_tokens
            s_out_sol_total += s_out_sol
            
            p_usd = s_sig.get("priceUsd", 0.0)
            if p_usd > 0:
                target_sell_prices.append(p_usd)
            last_sell_at = max(last_sell_at, s.get("at", 0))

        # Real Swap ROI
        real_swap_roi = ((s_out_sol_total - b_in_sol) / b_in_sol * 100) if b_in_sol > 0 else 0.0
        
        # Weighted target sell price
        avg_target_sell_price = sum(target_sell_prices)/len(target_sell_prices) if target_sell_prices else 0.0
        target_signal_roi = ((avg_target_sell_price - target_buy_price) / target_buy_price * 100) if target_buy_price > 0 else 0.0
        
        # Bot average sell price USD
        bot_sell_price_usd = (s_out_sol_total * sol_price_usd) / s_in_tokens_total if s_in_tokens_total > 0 else 0.0
        exit_gap_pct = ((bot_sell_price_usd - avg_target_sell_price) / avg_target_sell_price * 100) if avg_target_sell_price > 0 else 0.0
        
        hold_seconds = max(1, round((last_sell_at - b.get("at", 0)) / 1000))
        
        outcome = "WIN" if real_swap_roi > 0 else "LOSS"
        
        results.append({
            "scenario": sc_id,
            "mint": mint,
            "symbol": symbol,
            "time": datetime.fromtimestamp(b.get("at", 0)/1000, tz=wib).strftime("%Y-%m-%d %H:%M:%S"),
            "exchange": exchange,
            "target_buy_price": target_buy_price,
            "bot_buy_price": bot_buy_price_usd,
            "entry_premium_pct": entry_premium_pct,
            "target_buy_usd": target_buy_usd,
            "target_sell_price": avg_target_sell_price,
            "bot_sell_price": bot_sell_price_usd,
            "exit_gap_pct": exit_gap_pct,
            "real_swap_roi": real_swap_roi,
            "target_signal_roi": target_signal_roi,
            "hold_seconds": hold_seconds,
            "is_rug": False,
            "outcome": outcome
        })

    return results

def print_forensic_report(results, sc_filter="SCENARIO_6_REDEPLOY_SNIPER"):
    sc_name = "SKENARIO 6 (Re-Deploy Sniper Split TP 50/50)" if "6" in sc_filter else "SKENARIO 4 (Single Buy 15%)"
    filtered = [r for r in results if r["scenario"] == sc_filter]
    
    print("\n" + "="*95)
    print(f"🔬 FORENSIK ROOT CAUSE LENGKAP: {sc_name}")
    print(f"   Total Sampel Trade Teranalisis: {len(filtered)} token")
    print("="*95)
    
    wins = [r for r in filtered if r["outcome"] == "WIN"]
    losses = [r for r in filtered if r["outcome"] != "WIN"]
    rugs = [r for r in filtered if r["is_rug"]]
    
    print(f"\n1. RINGKASAN OUTCOME RIIL:")
    print(f"   - Menang Riil (Real AMM Win) : {len(wins)} token ({len(wins)/len(filtered)*100:.1f}%)")
    print(f"   - Kalah Riil  (Real AMM Loss): {len(losses)} token ({len(losses)/len(filtered)*100:.1f}%)")
    print(f"   - Termasuk Kena Dev Rugpool  : {len(rugs)} token")
    
    # Analyze WIN vs LOSS Metrics
    def get_avg(lst, key):
        vals = [x[key] for x in lst if x[key] is not None]
        return sum(vals)/len(vals) if vals else 0.0

    print("\n" + "-"*95)
    print(f"{'PARAMETER METRIK':<35} | {'POLA TRADE MENANG (WIN)':<26} | {'POLA TRADE KALAH (LOSS)':<26}")
    print("-"*95)
    
    win_entry_prem = get_avg(wins, "entry_premium_pct")
    loss_entry_prem = get_avg(losses, "entry_premium_pct")
    print(f"{'Rata-rata Kemahalan Beli (Slippage)':<35} | {win_entry_prem:+6.1f}% (Jauh Lebih Murah)  | {loss_entry_prem:+6.1f}% (TERLALU MAHAL!)")
    
    win_target_price = get_avg(wins, "target_buy_price")
    loss_target_price = get_avg(losses, "target_buy_price")
    print(f"{'Rata-rata Harga Beli Target':<35} | ${win_target_price:.8f}           | ${loss_target_price:.8f}")

    win_target_roi = get_avg(wins, "target_signal_roi")
    loss_target_roi = get_avg(losses, "target_signal_roi")
    print(f"{'Target Signal ROI (Klaim Untung)':<35} | {win_target_roi:+6.1f}%                   | {loss_target_roi:+6.1f}%")

    win_real_roi = get_avg(wins, "real_swap_roi")
    loss_real_roi = get_avg(losses, "real_swap_roi")
    print(f"{'Real AMM Swap ROI (Hasil Nyata)':<35} | {win_real_roi:+6.1f}%                   | {loss_real_roi:+6.1f}%")

    win_exit_gap = get_avg(wins, "exit_gap_pct")
    loss_exit_gap = get_avg(losses, "exit_gap_pct")
    print(f"{'Exit Gap (% Jual Di Bawah Target)':<35} | {win_exit_gap:+6.1f}%                   | {loss_exit_gap:+6.1f}%")

    win_dur = get_avg(wins, "hold_seconds")
    loss_dur = get_avg(losses, "hold_seconds")
    print(f"{'Rata-rata Durasi Hold':<35} | {win_dur:4.1f} detik               | {loss_dur:4.1f} detik")

    win_target_usd = get_avg(wins, "target_buy_usd")
    loss_target_usd = get_avg(losses, "target_buy_usd")
    print(f"{'Rata-rata Modal Beli Target ($)':<35} | ${win_target_usd:<25.0f} | ${loss_target_usd:<25.0f}")

    # Cluster by Entry Slippage Thresholds
    print("\n" + "="*95)
    print("📈 ANALISIS BERDASARKAN BESARNYA KEMAHALAN BELI (ENTRY SLIPPAGE / PRICE IMPACT):")
    print("="*95)
    print(f"{'Rentang Kemahalan Beli':<25} | {'Total':<6} | {'Menang':<8} | {'Kalah':<8} | {'Win Rate Riil':<14} | {'Rata-rata Real ROI'}")
    print("-"*95)
    
    ranges = [
        ("Slippage <= +25% (Aman)", lambda x: x <= 25),
        ("Slippage +25% - +50% (Sedang)", lambda x: 25 < x <= 50),
        ("Slippage +50% - +100% (Bahaya)", lambda x: 50 < x <= 100),
        ("Slippage > +100% (Pucuk/Ekstrem)", lambda x: x > 100)
    ]
    
    for label, fn in ranges:
        subset = [r for r in filtered if fn(r["entry_premium_pct"]) and not r["is_rug"]]
        n = len(subset)
        if n == 0:
            continue
        w = len([r for r in subset if r["outcome"] == "WIN"])
        l = n - w
        wr = (w / n) * 100
        avg_r = sum(r["real_swap_roi"] for r in subset) / n
        print(f"{label:<25} | {n:<6} | {w:<8} | {l:<8} | {wr:5.1f}%        | {avg_r:+6.1f}%")

    # Cluster by AMM Exchange
    print("\n" + "="*95)
    print("🏛️ ANALISIS BERDASARKAN JENIS POOL / DEX AMM:")
    print("="*95)
    print(f"{'Exchange / Pool':<25} | {'Total':<6} | {'Menang':<8} | {'Kalah':<8} | {'Win Rate Riil':<14} | {'Rata-rata Real ROI'}")
    print("-"*95)
    exchanges = list(set(r["exchange"] for r in filtered))
    for ex in sorted(exchanges):
        subset = [r for r in filtered if r["exchange"] == ex and not r["is_rug"]]
        n = len(subset)
        if n == 0:
            continue
        w = len([r for r in subset if r["outcome"] == "WIN"])
        l = n - w
        wr = (w / n) * 100
        avg_r = sum(r["real_swap_roi"] for r in subset) / n
        print(f"{ex:<25} | {n:<6} | {w:<8} | {l:<8} | {wr:5.1f}%        | {avg_r:+6.1f}%")

    # Show 5 Worst Losses and 5 Best Wins
    print("\n" + "="*95)
    print("🏆 5 TRADE PALING UNTUNG RIIL:")
    sorted_wins = sorted(wins, key=lambda x: x["real_swap_roi"], reverse=True)[:5]
    for i, t in enumerate(sorted_wins, 1):
        print(f"  {i}. {t['symbol']:<10} ({t['time']}) | Real ROI: {t['real_swap_roi']:+6.1f}% | Target Buy: ${t['target_buy_price']:.8f} -> Bot Buy: ${t['bot_buy_price']:.8f} (Gap: {t['entry_premium_pct']:+5.1f}%) | Hold: {t['hold_seconds']}s")

    print("\n💀 5 TRADE PALING RUGI RIIL (NON-RUG):")
    non_rug_losses = [r for r in losses if not r["is_rug"]]
    sorted_losses = sorted(non_rug_losses, key=lambda x: x["real_swap_roi"])[:5]
    for i, t in enumerate(sorted_losses, 1):
        print(f"  {i}. {t['symbol']:<10} ({t['time']}) | Real ROI: {t['real_swap_roi']:+6.1f}% | Target Buy: ${t['target_buy_price']:.8f} -> Bot Buy: ${t['bot_buy_price']:.8f} (Gap: {t['entry_premium_pct']:+5.1f}%) | Target Gain: {t['target_signal_roi']:+5.1f}%")

if __name__ == "__main__":
    entries = load_all_ledgers()
    results = analyze_trades(entries)
    print_forensic_report(results, "SCENARIO_6_REDEPLOY_SNIPER")
    print_forensic_report(results, "SCENARIO_4_SINGLE_BUY_5USD")
