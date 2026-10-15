import json
import time

t0 = time.time()
with open("/home/bbliong/project/crypto-bot/data/profit4-watch/s1_parsed_tokens.json") as fp:
    token_records = json.load(fp)

FEE_USD = 0.12
STAKE_USD = 5.0

print(f"Loaded {len(token_records)} tokens. Pre-calculating exit outcomes...")

exit_combos = [
    (20, 8),
    (25, 8),
    (30, 8),
    (35, 8),
    (40, 8),
    (45, 8),
    (50, 8),
    (50, 10),
    (60, 8),
    (60, 10),
    (70, 10)
]

# Precompute exit outcome for every token and every (tp, sl) combo
for idx, tok in enumerate(token_records):
    p_entry = tok["p_120"]
    futs = tok["post_prices"]
    max_p = max(futs) if futs else p_entry
    tok["max_gain_pct"] = (max_p - p_entry) / p_entry * 100
    tok["is_runner_50"] = tok["max_gain_pct"] >= 50.0
    
    tok["exit_outcomes"] = {}
    for tp, sl in exit_combos:
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
        tok["exit_outcomes"][(tp, sl)] = {
            "win": hit[0] == "WIN",
            "pnl": net,
            "ret": hit[1]
        }

print(f"Pre-calculation done in {time.time() - t0:.2f}s! Running fast grid search...")

vols = [600, 1000, 1400, 1800, 2200]
dds = [1.8, 2.2, 2.8, 3.5]
max_sells = [35, 50, 75, 120]
bs_ratios = [2.0, 3.0, 4.5, 7.0]
accels = [0.0, 0.7, 1.0, 1.3]
min_step_gains = [1.0, 2.0, 3.0]

results = []

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
                        
                        runners_50 = sum(1 for m in matched if m["is_runner_50"])
                        runner_pct = (runners_50 / len(matched)) * 100
                        
                        for tp, sl in exit_combos:
                            wins = sum(1 for m in matched if m["exit_outcomes"][(tp, sl)]["win"])
                            losses = len(matched) - wins
                            net_tot = sum(m["exit_outcomes"][(tp, sl)]["pnl"] for m in matched)
                            wr = (wins / len(matched)) * 100
                            ev = net_tot / len(matched)
                            
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

print(f"Grid search completed in {time.time() - t0:.2f}s! Evaluated {len(results)} valid configurations.")

# 1. VERSI 1: UNTUNG TERBESAR (MAX PROFIT)
v1_candidates = sorted([r for r in results if r["trades"] >= 8], key=lambda x: -x["net_tot"])
# 2. VERSI 2: WIN RATE TERTINGGI (KONSISTEN)
v2_candidates = sorted([r for r in results if r["trades"] >= 8 and r["wr"] >= 75], key=lambda x: (-x["wr"], -x["net_tot"]))
if not v2_candidates:
    v2_candidates = sorted([r for r in results if r["trades"] >= 7], key=lambda x: (-x["wr"], -x["net_tot"]))
# 3. VERSI 3: POLA SPESIALIS SUPER RUNNER > 50%
v3_candidates = sorted([r for r in results if r["trades"] >= 6 and r["tp"] >= 45], key=lambda x: (-x["runner_pct"], -x["net_tot"]))

v1 = v1_candidates[0]
v2 = v2_candidates[0]
v3 = v3_candidates[0]

output = {
    "v1_max_profit": v1,
    "v2_high_win_rate": v2,
    "v3_super_runner_50": v3
}

print("\n" + "="*80)
print("HASIL 3 VERSI S1 LOOP ENGINEERING TERPILIH:")
print("="*80)

print("\n🏆 VERSI 1: S1-MAX PROFIT (UNTUNG TERBESAR)")
print(f"  • Filosofi : Menunggangi lonjakan token runner setinggi mungkin dengan R:R optimal.")
print(f"  • Kriteria Entri :")
print(f"    - Min 2-Step Buy Volume : ${v1['min_vol']}")
print(f"    - Max Drawdown (0-120s) : <={v1['max_dd']}%")
print(f"    - Max Single Sell Order : <${v1['max_sell']}")
print(f"    - Buy/Sell Ratio (120s) : >={v1['bs_ratio']}x")
print(f"    - Step Escalation Gain  : Step 1 >=+{v1['min_step_gain']}% & Step 2 >=+{v1['min_step_gain']}%")
print(f"  • Exit Target  : TP +{v1['tp']}% / SL -{v1['sl']}% (Risk/Reward 6.25 : 1)")
print(f"  • Performa     : {v1['trades']} Trades | {v1['wins']} Win / {v1['losses']} Loss (WR: {v1['wr']:.1f}%)")
print(f"  • Total Net PnL: +${v1['net_tot']:.2f} USD | EV: +${v1['ev']:.2f} per trade")
print(f"  • Token yang ditradingkan: {', '.join(v1['symbols'][:10])}")

print("\n🎯 VERSI 2: S1-HIGH WIN RATE (WIN TERBANYAK & PALING AMAN)")
print(f"  • Filosofi : Keluar cepat di target realistis sebelum dev/whale melakukan aksi jual.")
print(f"  • Kriteria Entri :")
print(f"    - Min 2-Step Buy Volume : ${v2['min_vol']}")
print(f"    - Max Drawdown (0-120s) : <={v2['max_dd']}%")
print(f"    - Max Single Sell Order : <${v2['max_sell']}")
print(f"    - Buy/Sell Ratio (120s) : >={v2['bs_ratio']}x")
print(f"    - Step Escalation Gain  : Step 1 >=+{v2['min_step_gain']}% & Step 2 >=+{v2['min_step_gain']}%")
print(f"  • Exit Target  : TP +{v2['tp']}% / SL -{v2['sl']}% (Quick Take Profit)")
print(f"  • Performa     : {v2['trades']} Trades | {v2['wins']} Win / {v2['losses']} Loss (WR: {v2['wr']:.1f}%)")
print(f"  • Total Net PnL: +${v2['net_tot']:.2f} USD | EV: +${v2['ev']:.2f} per trade")
print(f"  • Token yang ditradingkan: {', '.join(v2['symbols'][:10])}")

print("\n🚀 VERSI 3: S1-SUPER RUNNER 50%+ (POLA SPESIALIS MELEDAK >50%)")
print(f"  • Filosofi : Khusus menyaring pola yang hampir 100% terbang melampaui +50%.")
print(f"  • Kriteria Entri :")
print(f"    - Min 2-Step Buy Volume : ${v3['min_vol']}")
print(f"    - Max Drawdown (0-120s) : <={v3['max_dd']}% (Super Tight Micro-Pullback)")
print(f"    - Max Single Sell Order : <${v3['max_sell']} (Absolut Tidak Ada Sell Besar)")
print(f"    - Buy/Sell Ratio (120s) : >={v3['bs_ratio']}x")
print(f"    - Step 2 Acceleration  : >={v3['accel']}x volume Step 1")
print(f"    - Step Escalation Gain  : Step 1 >=+{v3['min_step_gain']}% & Step 2 >=+{v3['min_step_gain']}%")
print(f"  • Exit Target  : TP +{v3['tp']}% / SL -{v3['sl']}%")
print(f"  • Probabilitas Naik >50%: {v3['runners_50']} dari {v3['trades']} token lolos NAIK > +50% ({v3['runner_pct']:.1f}% Akurasi Pola!)")
print(f"  • Performa     : {v3['trades']} Trades | {v3['wins']} Win / {v3['losses']} Loss (WR: {v3['wr']:.1f}%)")
print(f"  • Total Net PnL: +${v3['net_tot']:.2f} USD | EV: +${v3['ev']:.2f} per trade")
print(f"  • Token yang ditradingkan: {', '.join(v3['symbols'])}")

with open("/home/bbliong/project/crypto-bot/data/profit4-watch/s1-3-versions-discovered.json", "w") as fp:
    json.dump(output, fp, indent=2)
