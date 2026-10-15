import importlib.util

spec = importlib.util.spec_from_file_location("sim3", "/home/bbliong/project/crypto-bot/scripts/simulate-3-s1-versions.py")
sim3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim3)

v3_matched = [t for t in sim3.all_tokens if (
    t["tot_buy"] >= 900 and
    t["max_dd"] <= 2.2 and
    t["max_sell"] <= 40 and
    t["bs_ratio"] >= 4.0 and
    t["gain_step1"] >= 2.0 and
    t["gain_step2"] >= 2.0 and
    t["gain_120"] >= 5.0 and
    t["gain_120"] <= 35.0
)]

print(f"\n--- VERSI 3 ULTRA CLEAN ({len(v3_matched)} TRADES) ---")
runners_count = 0
for t in v3_matched:
    max_p = max([p for p, ts in t["futs"]]) if t["futs"] else t["p_120"]
    pk = (max_p - t["p_120"]) / t["p_120"] * 100
    hit_50 = "YA (>+50%)" if pk >= 50.0 else "TIDAK"
    if pk >= 50.0:
        runners_count += 1
    sym = t['sym']
    bv = t['tot_buy']
    sv = t['tot_sell']
    ms = t['max_sell']
    print(f"  {sym:10} | Peak: +{pk:5.1f}% | Meledak >50%: {hit_50:<10} | BuyVol: ${bv:4.0f} | Sell: ${sv:3.0f} | MaxSell: ${ms:2.0f}")

print(f"\nAkurasi Pola Super Runner: {runners_count} dari {len(v3_matched)} ({runners_count/len(v3_matched)*100:.1f}%)!")

wins = 0
losses = 0
tot = 0.0
for t in v3_matched:
    hit = None
    for p, ts in t["futs"]:
        r = (p - t["p_120"]) / t["p_120"] * 100
        if r >= 50.0:
            hit = ("WIN", 50.0)
            break
        if r <= -8.0:
            hit = ("LOSS", -8.0)
            break
    if not hit:
        hit = ("LOSS", -8.0)
    net = sim3.STAKE_USD * (hit[1] / 100.0) - sim3.FEE_USD
    tot += net
    if hit[0] == "WIN":
        wins += 1
    else:
        losses += 1

wr = wins / len(v3_matched) * 100
ev = tot / len(v3_matched)
print(f"Hasil Simulasi TP +50% / SL -8%: {wins}W / {losses}L ({wr:.1f}%) | Net: +${tot:.2f} USD | EV: +${ev:.2f}")
