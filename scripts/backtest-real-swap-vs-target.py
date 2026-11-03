#!/usr/bin/env python3
import json
import glob
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

def run_backtest(ledger_path):
    print(f"\n{'='*90}")
    print(f"📂 MEMPROSES FILE LEDGER: {ledger_path}")
    print(f"{'='*90}")

    lines = []
    with open(ledger_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                lines.append(json.loads(line))
            except Exception:
                pass

    # Group by (scenarioId, mint)
    scenarios = {}
    for e in lines:
        d = e.get("details", {})
        sig = d.get("signal", {})
        sc_id = d.get("scenarioId")
        mint = sig.get("mint") or d.get("mint")
        if not sc_id or not mint:
            continue
        key = (sc_id, mint)
        if key not in scenarios:
            scenarios[key] = {
                "scenarioId": sc_id,
                "mint": mint,
                "symbol": sig.get("symbol") or d.get("symbol") or "UNKNOWN",
                "events": []
            }
        scenarios[key]["events"].append(e)

    # We will evaluate S6 and S4
    for target_sc in ["SCENARIO_6_REDEPLOY_SNIPER", "SCENARIO_4_SINGLE_BUY_5USD"]:
        sc_name_short = "S6 (Re-Deploy Sniper Split TP)" if "6" in target_sc else "S4 (Single Buy 15%)"
        print(f"\n-----------------------------------------------------------------------------------------")
        print(f"📊 HASIL BACKTEST UNTUK: {sc_name_short}")
        print(f"-----------------------------------------------------------------------------------------")
        print(f"{'Token':<10} | {'Waktu':<8} | {'Target PnL %':<14} | {'REAL SWAP PnL %':<16} | {'Slippage Gap':<14} | {'Status':<10}")
        print(f"{'-'*89}")

        total_tokens = 0
        target_win = 0
        real_win = 0
        total_target_pnl_usd = 0.0
        total_real_pnl_sol = 0.0
        total_real_buy_sol = 0.0
        total_real_sell_sol = 0.0

        for (sc_id, mint), data in scenarios.items():
            if sc_id != target_sc:
                continue

            evts = data["events"]
            sym = data["symbol"][:10]

            # Find BUY event with swap quote
            buy_evts = [e for e in evts if "BUY" in e.get("type", "")]
            if not buy_evts:
                continue

            b = buy_evts[0]
            bd = b.get("details", {})
            b_swap = bd.get("response", {}).get("swap", {})
            b_quote = b_swap.get("quote", {})
            b_sol_in = int(b_quote.get("inAmount", 0)) / 1e9 if b_quote.get("inAmount") else 0.0
            b_tok_out = int(b_quote.get("outAmount", 0)) if b_quote.get("outAmount") else 0
            b_target_price = bd.get("signal", {}).get("priceUsd", 0.0)

            if b_sol_in <= 0 or b_tok_out <= 0:
                continue

            # Real swap entry price in SOL per token
            real_entry_price_sol = b_sol_in / b_tok_out

            # Find SELL events with swap quotes
            sell_evts = [e for e in evts if "SELL" in e.get("type", "") and "NO_ROUTE" not in e.get("type", "")]
            no_route_evts = [e for e in evts if "NO_ROUTE" in e.get("type", "")]

            # If dev rugged (no route)
            if not sell_evts and no_route_evts:
                total_tokens += 1
                t_str = datetime.fromtimestamp(evts[0]["at"] / 1000, tz=wib).strftime("%H:%M:%S")
                print(f"{sym:<10} | {t_str} | -100.0% (Rug)  | -100.0% (Rug)    |      0.0%    | 🔴 RUG DEV")
                total_real_buy_sol += b_sol_in
                total_real_pnl_sol -= b_sol_in
                continue

            if not sell_evts:
                continue

            total_tokens += 1
            t_str = datetime.fromtimestamp(evts[0]["at"] / 1000, tz=wib).strftime("%H:%M:%S")

            # Calculate Target ROI % (based on target signal prices)
            # In S6, sell 1 is 50%, sell 2 is 50%
            target_pnl_sum = 0.0
            target_weights = 0.0
            for s in sell_evts:
                sd = s.get("details", {})
                s_target_price = sd.get("signal", {}).get("priceUsd", 0.0)
                reason = sd.get("reason", "")
                weight = 0.5 if "STAGE_1" in reason else (0.5 if "STAGE_2" in reason else 1.0)
                if b_target_price > 0:
                    trade_roi = ((s_target_price - b_target_price) / b_target_price) * 100
                    target_pnl_sum += trade_roi * weight
                    target_weights += weight

            target_roi_final = (target_pnl_sum / target_weights) if target_weights > 0 else 0.0

            # Calculate Real Swap PnL % (actual SOL received from AMM quotes vs SOL spent)
            s_sol_out_total = 0.0
            s_tok_in_total = 0
            for s in sell_evts:
                sd = s.get("details", {})
                s_swap = sd.get("response", {}).get("swap", {})
                s_quote = s_swap.get("quote", {})
                sol_out = int(s_quote.get("outAmount", 0)) / 1e9 if s_quote.get("outAmount") else 0.0
                tok_in = int(s_quote.get("inAmount", 0)) if s_quote.get("inAmount") else 0
                s_sol_out_total += sol_out
                s_tok_in_total += tok_in

            total_real_buy_sol += b_sol_in
            total_real_sell_sol += s_sol_out_total

            # Real swap ROI
            real_roi_pct = ((s_sol_out_total - b_sol_in) / b_sol_in) * 100
            diff_gap = real_roi_pct - target_roi_final

            if target_roi_final > 0:
                target_win += 1
            if real_roi_pct > 0:
                real_win += 1

            status = "🟢 WIN" if real_roi_pct > 0 else "🔴 LOSS"
            print(f"{sym:<10} | {t_str} | {target_roi_final:+6.1f}%        | {real_roi_pct:+6.1f}%          | {diff_gap:+6.1f}%       | {status}")

        if total_tokens > 0:
            print(f"{'-'*89}")
            print(f"Total Selesai Ditradingkan: {total_tokens} token")
            print(f"Win Rate Menurut Target Signal: {target_win}/{total_tokens} ({(target_win/total_tokens)*100:.1f}%)")
            print(f"Win Rate MENURUT REAL AMM SWAP: {real_win}/{total_tokens} ({(real_win/total_tokens)*100:.1f}%)")
            net_sol = total_real_sell_sol - total_real_buy_sol
            print(f"Total SOL Beli Riil : {total_real_buy_sol:.6f} SOL")
            print(f"Total SOL Jual Riil : {total_real_sell_sol:.6f} SOL")
            print(f"Net Real Swap Hasil : {net_sol:+.6f} SOL (~${net_sol * 92.5:+.2f} USD)")

if __name__ == "__main__":
    # Test on the active ledger first
    run_backtest("/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl")
