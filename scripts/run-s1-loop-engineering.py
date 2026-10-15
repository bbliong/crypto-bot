import json
from statistics import median

with open("/home/bbliong/project/crypto-bot/data/profit4-watch/s1_parsed_tokens.json") as fp:
    token_records = json.load(fp)

FEE_USD = 0.12
STAKE_USD = 5.0

print(f"Loaded {len(token_records)} tokens. Running loop engineering...")

# Parameter Search Grid
results = []

# Volume thresholds
vols = [600, 1000, 1400, 1800, 2200]
# Max drawdowns in 120s
dds = [1.8, 2.2, 2.8, 3.5]
# Max single sell in 120s
max_sells = [35, 50, 75, 120]
# Buy to Sell ratio
bs_ratios = [2.0, 3.0, 4.5, 7.0]
# Step 2 volume acceleration (vol2 / vol1)
accels = [0.0, 0.7, 1.0, 1.3]
# Step 1 & 2 min gains
min_step_gains = [1.0, 2.0, 3.0]
# TP / SL combinations
exit_combos = [
    (20, 8),
    (25, 8),
    (30, 8),
    (35, 8),
    (40, 8),
    (50, 8),
    (50, 10),
    (60, 8),
    (65, 10),
    (75, 10)
]

for min_v in vols:
    for m_dd in dds:
        for m_s in max_sells:
            for b_r in bs_ratios:
                for acc in accels:
                    for msg in min_step_gains:
                        matched = []
                        for tok in token_records:
                            if tok["tot_buy"] < min_v: continue
                            if tok["max_dd"] > m_dd: continue
                            if tok["max_sell"] > m_s: continue
                            if tok["bs_ratio"] < b_r: continue
                            if tok["vol_accel"] < acc: continue
                            if tok["gain_step1"] < msg or tok["gain_step2"] < msg: continue
                            if tok["gain_120"] < 4.0 or tok["gain_120"] > 35.0: continue
                            matched.append(tok)
                            
                        if len(matched) < 5 or len(matched) > 25: continue
                        
                        for tp, sl in exit_combos:
                            wins = 0
                            losses = 0
                            net_tot = 0.0
                            runners_50 = 0
                            
                            for m in matched:
                                p_entry = m["p_120"]
                                futs = m["post_prices"]
                                
                                max_p = max(futs)
                                max_ret = (max_p - p_entry) / p_entry * 100
                                if max_ret >= 50.0:
                                    runners_50 += 1
                                    
                                hit = None
                                for p in futs:
                                    ret = (p - p_entry) / p_entry * 100
                                    if ret >= tp:
                                        hit = ("WIN", tp)
                                        break
                                    if ret <= -sl:
                                        hit = ("LOSS", -sl)
                                        break
                                if not hit:
                                    fr = (futs[-1] - p_entry) / p_entry * 100
                                    hit = ("WIN" if fr > 0 else "LOSS", fr)
                                    
                                net = STAKE_USD * (hit[1] / 100.0) - FEE_USD
                                net_tot += net
                                if hit[0] == "WIN": wins += 1
                                else: losses += 1
                                
                            wr = wins / (wins + losses) * 100
                            ev = net_tot / (wins + losses)
                            runner_pct = (runners_50 / len(matched)) * 100
                            
                            results.append({
                                "min_vol": min_v,
                                "max_dd": m_dd,
                                "max_sell": m_s,
                                "bs_ratio": b_r,
                                "accel": acc,
                                "min_step_gain": msg,
                                "tp": tp,
                                "sl": sl,
                                "trades": len(matched),
                                "wins": wins,
                                "losses": losses,
                                "wr": wr,
                                "net_tot": net_tot,
                                "ev": ev,
                                "runners_50": runners_50,
                                "runner_pct": runner_pct,
                                "symbols": [m["sym"] for m in matched]
                            })

print(f"Total configurations simulated: {len(results)}")

# 1. VERSI 1: UNTUNG TERBESAR (MAX NET PROFIT)
# Filter min 8 trades to ensure statistical significance
v1_candidates = sorted([r for r in results if r["trades"] >= 8], key=lambda x: -x["net_tot"])

# 2. VERSI 2: WIN RATE TERBESAR (MAX WIN RATE)
# Filter min 8 trades, min WR 75%
v2_candidates = sorted([r for r in results if r["trades"] >= 8 and r["wr"] >= 70], key=lambda x: (-x["wr"], -x["net_tot"]))

# 3. VERSI 3: POLA SPESIALIS SUPER RUNNER > 50%
# Filter min 6 trades, highest runner_pct (persentase token yang tembus >50%) and high net profit
v3_candidates = sorted([r for r in results if r["trades"] >= 6 and r["tp"] >= 40], key=lambda x: (-x["runner_pct"], -x["net_tot"]))

output = {
    "v1_max_profit": v1_candidates[0] if v1_candidates else None,
    "v2_high_win_rate": v2_candidates[0] if v2_candidates else None,
    "v3_super_runner_50": v3_candidates[0] if v3_candidates else None,
}

print("\n" + "="*80)
print("HASIL 3 VERSI PALING OPTIMAL S1:")
print("="*80)

print("\n🏆 VERSI 1: S1-MAX PROFIT (UNTUNG TERBESAR)")
v1 = output["v1_max_profit"]
print(f"  • Filter: MinVol ${v1['min_vol']}, MaxDD {v1['max_dd']}%, MaxSell ${v1['max_sell']}, B/S {v1['bs_ratio']}x, StepGain >=+{v1['min_step_gain']}%")
print(f"  • Exit  : TP +{v1['tp']}% / SL -{v1['sl']}%")
print(f"  • Hasil : {v1['trades']} Trades | {v1['wins']} Win / {v1['losses']} Loss | WR: {v1['wr']:.1f}%")
print(f"  • Net PnL: +${v1['net_tot']:.2f} USD | EV: +${v1['ev']:.2f}/trade")
print(f"  • Token yang lolos: {', '.join(v1['symbols'][:8])}")

print("\n🎯 VERSI 2: S1-HIGH WIN RATE (WIN TERBANYAK & KONSISTEN)")
v2 = output["v2_high_win_rate"]
print(f"  • Filter: MinVol ${v2['min_vol']}, MaxDD {v2['max_dd']}%, MaxSell ${v2['max_sell']}, B/S {v2['bs_ratio']}x, StepGain >=+{v2['min_step_gain']}%")
print(f"  • Exit  : TP +{v2['tp']}% / SL -{v2['sl']}%")
print(f"  • Hasil : {v2['trades']} Trades | {v2['wins']} Win / {v2['losses']} Loss | WR: {v2['wr']:.1f}%")
print(f"  • Net PnL: +${v2['net_tot']:.2f} USD | EV: +${v2['ev']:.2f}/trade")
print(f"  • Token yang lolos: {', '.join(v2['symbols'][:8])}")

print("\n🚀 VERSI 3: S1-SUPER RUNNER 50%+ (PEMBURU HOME RUN >50%)")
v3 = output["v3_super_runner_50"]
print(f"  • Filter: MinVol ${v3['min_vol']}, MaxDD {v3['max_dd']}%, MaxSell ${v3['max_sell']}, B/S {v3['bs_ratio']}x, Accel {v3['accel']}x, StepGain >=+{v3['min_step_gain']}%")
print(f"  • Exit  : TP +{v3['tp']}% / SL -{v3['sl']}%")
print(f"  • Hasil : {v3['trades']} Trades | {v3['wins']} Win / {v3['losses']} Loss | WR: {v3['wr']:.1f}%")
print(f"  • Token Naik >50%: {v3['runners_50']} dari {v3['trades']} token ({v3['runner_pct']:.1f}%)")
print(f"  • Net PnL: +${v3['net_tot']:.2f} USD | EV: +${v3['ev']:.2f}/trade")
print(f"  • Token yang lolos: {', '.join(v3['symbols'])}")

with open("/home/bbliong/project/crypto-bot/data/profit4-watch/s1-3-versions-discovered.json", "w") as fp:
    json.dump(output, fp, indent=2)
