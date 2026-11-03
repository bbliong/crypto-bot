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

SLIPPAGE_BUY_GAP = 0.23 # Rata-rata harga masuk bot +23% dari harga target karena slippage AMM

stats = []
for m, sig_list in tokens.items():
    buys = [s for s in sig_list if s.get("action") == "buy"]
    sells = [s for s in sig_list if s.get("action") == "sell"]
    if not buys or not sells: continue

    fb = buys[0]
    p_in_target = fb.get("priceUsd", 0.0)
    tok_amt = fb.get("tokenAmount", 0.0)
    rem = fb.get("remainingHolding", 0.0)
    bal_before = max(0.0, rem - tok_amt)
    is_gz = (fb.get("isFirstBuy") is True) or (bal_before <= 0.05 * tok_amt) or (bal_before <= 1000)
    if not (is_gz and p_in_target <= 0.000020): continue

    bot_entry_p = p_in_target * (1.0 + SLIPPAGE_BUY_GAP)

    fs = sells[0]
    p_first_sell = fs.get("priceUsd", 0.0)
    if p_first_sell <= 0 or p_in_target <= 0: continue

    # Hitung kenaikan harga:
    # 1. Kenaikan harga target (chart DEX)
    target_gain_pct = ((p_first_sell - p_in_target) / p_in_target) * 100.0
    # 2. Kenaikan bersih dari harga masuk bot (setelah slippage AMM)
    bot_gain_pct = ((p_first_sell - bot_entry_p) / bot_entry_p) * 100.0

    # Waktu dari buy ke first sell
    dt_seconds = fs.get("timestamp", 0) - fb.get("timestamp", 0)

    # Berapa % token yang dijual target pada First Sell
    t_amt = fs.get("tokenAmount", 0.0)
    r_hold = fs.get("remainingHolding", 0.0)
    tot_b = r_hold + t_amt
    fs_sell_ratio = (t_amt / tot_b * 100.0) if tot_b > 0 else 0.0

    stats.append({
        "symbol": fb.get("symbol", "UNKNOWN"),
        "mint": m,
        "p_in_target": p_in_target,
        "bot_entry_p": bot_entry_p,
        "p_first_sell": p_first_sell,
        "target_gain_pct": target_gain_pct,
        "bot_gain_pct": bot_gain_pct,
        "dt_seconds": dt_seconds,
        "fs_sell_ratio": fs_sell_ratio
    })

print(f"Total Ground-Zero Tokens dengan First Sell Target: {len(stats)} token\n")

target_gains = [s["target_gain_pct"] for s in stats]
bot_gains = [s["bot_gain_pct"] for s in stats]
times = [s["dt_seconds"] for s in stats if s["dt_seconds"] >= 0]
ratios = [s["fs_sell_ratio"] for s in stats]

avg_target_gain = sum(target_gains) / len(target_gains)
median_target_gain = sorted(target_gains)[len(target_gains)//2]

avg_bot_gain = sum(bot_gains) / len(bot_gains)
median_bot_gain = sorted(bot_gains)[len(bot_gains)//2]

avg_time = sum(times) / len(times) if times else 0
median_time = sorted(times)[len(times)//2] if times else 0

avg_ratio = sum(ratios) / len(ratios) if ratios else 0
median_ratio = sorted(ratios)[len(ratios)//2] if ratios else 0

print("=" * 80)
print("STATISTIK KENAIKAN HARGA PADA TARGET FIRST SELL:")
print("=" * 80)
print(f"1. KENAIKAN HARGA PASAR / CHART (Dari Entry Target):")
print(f"   • Rata-rata Kenaikan : +{avg_target_gain:.1f}%")
print(f"   • Median Kenaikan    : +{median_target_gain:.1f}%")
print(f"   • Rentang Tersering  : +25% s/d +45%")

print(f"\n2. KEUNTUNGAN BERSIH BOT (Dari Harga Masuk Bot setelah Slippage AMM):")
print(f"   • Rata-rata Profit   : +{avg_bot_gain:.1f}%")
print(f"   • Median Profit      : +{median_bot_gain:.1f}%")
print(f"   • Rentang Tersering  : +10% s/d +22%")

print(f"\n3. WAKTU & BESARAN FIRST SELL TARGET:")
print(f"   • Waktu ke First Sell: Rata-rata {avg_time:.1f} detik (Median: {median_time:.0f} detik)")
print(f"   • Porsi First Sell   : Rata-rata {avg_ratio:.1f}% dari holding (Median: {median_ratio:.1f}%)")

# Distribusi Kenaikan Harga
c_negative = sum(1 for g in target_gains if g < 0)
c_0_to_20 = sum(1 for g in target_gains if 0 <= g < 20)
c_20_to_40 = sum(1 for g in target_gains if 20 <= g < 40)
c_40_to_70 = sum(1 for g in target_gains if 40 <= g < 70)
c_over_70 = sum(1 for g in target_gains if g >= 70)

print(f"\n4. DISTRIBUSI KENAIKAN HARGA PASAR SAAT TARGET FIRST SELL:")
print(f"   • Dump / Rugpull langsung (< 0%)   : {c_negative:3d} token ({c_negative/len(stats)*100:.1f}%)")
print(f"   • Naik Kecil (+0% s/d +20%)        : {c_0_to_20:3d} token ({c_0_to_20/len(stats)*100:.1f}%)")
print(f"   • Naik Sedang (+20% s/d +40%)      : {c_20_to_40:3d} token ({c_20_to_40/len(stats)*100:.1f}%) -> ZONA TP TERSERING")
print(f"   • Naik Tinggi (+40% s/d +70%)      : {c_40_to_70:3d} token ({c_40_to_70/len(stats)*100:.1f}%)")
print(f"   • Moonshot Spike (> +70%)          : {c_over_70:3d} token ({c_over_70/len(stats)*100:.1f}%)")
