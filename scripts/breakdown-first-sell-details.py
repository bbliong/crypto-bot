import json
import glob
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# Load all signals from ledger and backups
files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/*.jsonl")

signals = []
seen = set()
for f in files:
    with open(f) as fp:
        for line in fp:
            if not line.strip(): continue
            try:
                obj = json.loads(line)
                sig = obj.get("details", {}).get("signal")
                if sig and sig.get("txHash") and sig.get("txHash") not in seen:
                    seen.add(sig.get("txHash"))
                    ts = sig.get("timestamp", 0)
                    if ts > 1e11: ts /= 1000
                    sig["timestamp"] = ts
                    sig["type"] = obj.get("type", "")
                    # Ambil quote swap nyata bot jika ada
                    q = obj.get("details", {}).get("response", {}).get("swap", {}).get("quote")
                    sig["quote"] = q
                    signals.append(sig)
            except: pass

signals.sort(key=lambda s: s.get("timestamp", 0))

tokens = {}
for s in signals:
    m = s.get("mint")
    if not m: continue
    if m not in tokens:
        tokens[m] = []
    tokens[m].append(s)

breakdown_items = []

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

    # Ambil quote nyata bot saat buy jika ada
    bot_buy_price = 0.0
    for b in buys:
        q = b.get("quote")
        if q and q.get("outAmount") and q.get("inAmount"):
            sol_in = int(q["inAmount"]) / 1e9
            tokens_out = int(q["outAmount"]) / 1e6
            bot_buy_price = (sol_in * 92.5) / tokens_out
            break
    if bot_buy_price <= 0:
        bot_buy_price = p_in_target * 1.234 # 23.4% AMM slippage

    fs = sells[0]
    p_first_sell = fs.get("priceUsd", 0.0)
    if p_first_sell <= 0: continue

    buy_ts = fb.get("timestamp", 0)
    sell_ts = fs.get("timestamp", 0)
    dur_sec = int(sell_ts - buy_ts)

    # % Kenaikan
    gain_from_target = ((p_first_sell - p_in_target) / p_in_target) * 100.0
    gain_from_bot = ((p_first_sell - bot_buy_price) / bot_buy_price) * 100.0

    # Porsi sell
    s_tok = fs.get("tokenAmount", 0.0)
    s_rem = fs.get("remainingHolding", 0.0)
    tot = s_tok + s_rem
    sell_ratio_pct = (s_tok / tot * 100.0) if tot > 0 else 0.0

    breakdown_items.append({
        "symbol": fb.get("symbol", "UNKNOWN"),
        "mint": m,
        "buy_ts": buy_ts,
        "sell_ts": sell_ts,
        "buy_time_wib": datetime.fromtimestamp(buy_ts, tz=wib).strftime("%H:%M:%S"),
        "sell_time_wib": datetime.fromtimestamp(sell_ts, tz=wib).strftime("%H:%M:%S"),
        "dur_sec": dur_sec,
        "target_in": p_in_target,
        "bot_in": bot_buy_price,
        "first_sell_p": p_first_sell,
        "gain_chart_pct": gain_from_target,
        "gain_bot_pct": gain_from_bot,
        "sell_ratio_pct": sell_ratio_pct
    })

# Urutkan koin dari yang terbaru ke terlama
breakdown_items.sort(key=lambda x: x["buy_ts"], reverse=True)

print(f"Total token Ground-Zero teridentifikasi: {len(breakdown_items)}")
print("\n" + "=" * 120)
print(f"{'No':<3} | {'Token':<8} | {'Buy Bot':<8} | {'1st Sell':<8} | {'Durasi':<7} | {'Harga Bot In':<14} | {'Harga 1st Sell':<14} | {'Kenaikan Bot %':<14} | {'Kenaikan Chart':<14} | {'Porsi Sell'}")
print("=" * 120)

for idx, item in enumerate(breakdown_items[:20], 1):
    dur_str = f"{item['dur_sec']}s"
    print(f"{idx:<3} | {item['symbol']:<8} | {item['buy_time_wib']:<8} | {item['sell_time_wib']:<8} | {dur_str:<7} | ${item['bot_in']:.8f} | ${item['first_sell_p']:.8f} | {item['gain_bot_pct']:+6.1f}% (Net)   | {item['gain_chart_pct']:+6.1f}% (DEX)   | {item['sell_ratio_pct']:4.1f}% bag")
