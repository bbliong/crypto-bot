import subprocess
import json
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

print("=" * 115)
print("🐎 INTELLIGENT BACKTEST V2: SCENARIO 13-CENTAUR (REALISTIC EXIT BEFORE WHALE DUMP)")
print("=" * 115)

cmd = ["journalctl", "--user", "-u", "crypto-bot-wallet-follower.service", "--since", "2026-11-08 00:00:00", "--grep=GMGN WS RAW ITEM", "--no-pager"]
proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
assert proc.stdout is not None

events_by_mint = {}
total_events = 0

for line in proc.stdout:
    if "Raw: " in line:
        total_events += 1
        try:
            raw_str = line[line.index("Raw: ") + 5:].strip()
            data = json.loads(raw_str)
            mint = data.get("a")
            if mint:
                if mint not in events_by_mint:
                    events_by_mint[mint] = []
                events_by_mint[mint].append(data)
        except:
            pass

high_conviction = []

for mint, evs in events_by_mint.items():
    evs.sort(key=lambda x: (x.get("t", 0), int(x.get("si", 0) or 0)))
    first_buy = next((e for e in evs if e.get("e") == "buy"), None)
    if not first_buy:
        continue
    qa = float(first_buy.get("qa") or 0)
    au = float(first_buy.get("au") or 0)
    p0 = float(first_buy.get("pu") or 0)
    
    if (qa >= 15.0 or au >= 1300.0) and p0 > 0:
        sym = first_buy.get("bs") or first_buy.get("bn") or mint[:8]
        high_conviction.append({
            "mint": mint,
            "symbol": sym,
            "events": evs,
            "t0": first_buy.get("t", 0),
            "p0": p0,
            "sol0": qa,
            "usd0": au,
            "whale_wallet": first_buy.get("ad", "")
        })

STAKE_USD = 5.00
FEE_USD = 0.05

backtest_results = []

for token in high_conviction:
    mint = token["mint"]
    sym = token["symbol"]
    evs = token["events"]
    t0 = token["t0"]
    p0 = token["p0"]
    whale_wallet = token["whale_wallet"]
    
    lifespan_sec = evs[-1].get("t", 0) - t0
    all_prices = [float(e.get("pu") or 0) for e in evs if float(e.get("pu") or 0) > 0]
    p_peak = max(all_prices) if all_prices else p0
    max_possible_gain = ((p_peak - p0) / p0) * 100
    
    # Deteksi order dump raksasa whale (>= 15 SOL)
    giant_dump = next((e for e in evs if e.get("e") == "sell" and e.get("ad") == whale_wallet and float(e.get("qa") or 0) >= 15.0), None)
    dump_age = (giant_dump.get("t", 0) - t0) if giant_dump else 999999
    
    # Aktivitas whale di detik 10-30
    evs_10_30s = [e for e in evs if 10 <= (e.get("t", 0) - t0) <= 30]
    whale_buys_10_30s = [e for e in evs_10_30s if e.get("e") == "buy" and e.get("ad") == whale_wallet]
    whale_buyback_count = len(whale_buys_10_30s)
    
    # Klasifikasi Runner vs Rugpull Cepat
    # Rugpull cepat: giant dump terjadi di detik <= 45s ATAU (whale 0 buyback dan lifespan < 120s)
    is_fast_rug = (dump_age <= 45) or (whale_buyback_count == 0 and lifespan_sec <= 120)
    
    exit_price = p0
    exit_time_sec = 0
    exit_reason = ""
    exit_path = ""
    
    if is_fast_rug:
        exit_path = "CENTAUR_PRE_RUG_SCALP"
        # Ambil harga sebelum giant dump (atau di sekitar 20-28s)
        cutoff_age = min(dump_age - 1, 28) if dump_age < 999999 else 25
        valid_evs = [e for e in evs if 0 < (e.get("t", 0) - t0) <= cutoff_age and float(e.get("pu") or 0) > 0]
        if valid_evs:
            # Ambil trade terakhir sebelum bom meledak
            target_ev = valid_evs[-1]
            exit_price = float(target_ev.get("pu"))
            exit_time_sec = target_ev.get("t", 0) - t0
            exit_reason = f"Pre-Rug Scalp di +{exit_time_sec}s sebelum dump ({giant_dump.get('qa') if giant_dump else 'pasif'} SOL)"
        else:
            # Jika tidak ada trade antara 0 dan cutoff, ambil harga awal
            exit_price = p0
            exit_time_sec = 0
            exit_reason = "No sub-25s event (breakeven)"
    else:
        # RUNNER WAVE RIDER
        exit_path = "CENTAUR_RUNNER_WAVE_RIDE"
        running_peak = p0
        consecutive_whale_sells = 0
        
        for e in evs[1:]:
            t_curr = e.get("t", 0)
            age = t_curr - t0
            p_curr = float(e.get("pu") or 0)
            if p_curr <= 0: continue
            if p_curr > running_peak: running_peak = p_curr
            
            cur_gain = ((p_curr - p0) / p0) * 100
            drawdown_from_peak = ((running_peak - p_curr) / running_peak) * 100
            
            if e.get("ad") == whale_wallet:
                if e.get("e") == "sell":
                    consecutive_whale_sells += 1
                elif e.get("e") == "buy":
                    consecutive_whale_sells = 0
            
            # 1. Trailing Stop -20% dari peak setelah gain >= +100%
            if cur_gain >= 100.0 and drawdown_from_peak >= 20.0:
                exit_price = p_curr
                exit_time_sec = age
                exit_reason = f"Trailing Stop -20% dari Peak (+{cur_gain:.1f}%)"
                break
                
            # 2. Whale Exhaustion (3x sell beruntun ATAU sell tunggal >= 15 SOL)
            sol_val = float(e.get("qa") or 0)
            if e.get("ad") == whale_wallet and e.get("e") == "sell" and (consecutive_whale_sells >= 3 or sol_val >= 15.0) and age >= 35:
                exit_price = p_curr
                exit_time_sec = age
                exit_reason = f"Whale Exhaustion ({consecutive_whale_sells}x sell / {sol_val:.1f} SOL)"
                break
                
            # 3. Max Runner Age 30m
            if age >= 1800:
                exit_price = p_curr
                exit_time_sec = age
                exit_reason = "Max Runner Age (30 Menit)"
                break
                
        if exit_time_sec == 0:
            last_ev = evs[-1]
            exit_price = float(last_ev.get("pu") or p0)
            exit_time_sec = last_ev.get("t", 0) - t0
            exit_reason = "Pool Close"

    roi_pct = ((exit_price - p0) / p0) * 100
    gross_return_usd = STAKE_USD * (exit_price / p0)
    net_pnl_usd = gross_return_usd - STAKE_USD - FEE_USD
    is_win = (net_pnl_usd > 0)
    t0_dt = datetime.fromtimestamp(t0, wib).strftime("%H:%M:%S")
    
    backtest_results.append({
        "symbol": sym,
        "mint": mint,
        "timeWib": t0_dt,
        "whale_sol": token["sol0"],
        "lifespan_sec": lifespan_sec,
        "exit_path": exit_path,
        "exit_time_sec": exit_time_sec,
        "p0": p0,
        "exit_price": exit_price,
        "p_peak": p_peak,
        "roi_pct": roi_pct,
        "gross_return_usd": gross_return_usd,
        "net_pnl_usd": net_pnl_usd,
        "is_win": is_win,
        "exit_reason": exit_reason
    })

with open("data/backtest_scenario_13_centaur.json", "w") as f:
    json.dump(backtest_results, f, indent=2)

total_pnl = sum(r["net_pnl_usd"] for r in backtest_results)
wins = sum(1 for r in backtest_results if r["is_win"])
losses = len(backtest_results) - wins
wr = (wins / len(backtest_results) * 100) if backtest_results else 0

print(f"Total Tokens Analyzed : {len(backtest_results)}")
print(f"Wins / Losses         : {wins} Menang / {losses} Kalah")
print(f"Win Rate              : {wr:.1f}%")
print(f"Total Net PnL         : ${total_pnl:+.2f} USD")
