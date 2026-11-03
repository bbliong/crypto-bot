import json
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

lines = []
with open("/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            lines.append(json.loads(line))
        except Exception:
            pass

mints = {}
for e in lines:
    d = e.get("details", {})
    sig = d.get("signal", {})
    m = sig.get("mint") or d.get("mint")
    if not m:
        continue
    if m not in mints:
        mints[m] = {"symbol": sig.get("symbol") or d.get("symbol"), "events": []}
    mints[m]["events"].append(e)

real_trades = []
for m, data in mints.items():
    evts = data["events"]
    real_buys = [e for e in evts if "BUY" in e.get("type", "") and e.get("details", {}).get("submit", {}).get("ok") is True]
    if not real_buys:
        continue
    
    b = real_buys[0]
    bd = b.get("details", {})
    b_sig = bd.get("signal", {})
    b_quote = bd.get("response", {}).get("swap", {}).get("quote", {})
    
    b_sol = int(b_quote.get("inAmount", 0)) / 1e9 if b_quote.get("inAmount") else 0.0
    t_buy_price = b_sig.get("priceUsd", 0.0)
    t_buy_sol = b_sig.get("solAmount", 0.0)
    
    # check actual tokens
    p_buys = [e for e in evts if "POST_BUY_VERIFIED" in e.get("type", "") and e.get("details", {}).get("mint") == m]
    act_tokens = p_buys[0].get("details", {}).get("actualTokens", 0.0) if p_buys else 0.0
    
    # sells
    real_sells = [e for e in evts if "SELL" in e.get("type", "") and e.get("details", {}).get("submit", {}).get("ok") is True]
    s_sol_total = 0.0
    for s in real_sells:
        sq = s.get("details", {}).get("response", {}).get("swap", {}).get("quote", {})
        s_sol_total += int(sq.get("outAmount", 0)) / 1e9 if sq.get("outAmount") else 0.0
    
    no_route = any("NO_ROUTE" in e.get("type", "") for e in evts)
    
    net_sol = s_sol_total - b_sol
    roi_sol = (net_sol / b_sol * 100) if b_sol > 0 else -100.0
    
    sol_usd = 92.5
    bot_buy_price = (b_sol * sol_usd) / act_tokens if act_tokens > 0 else 0.0
    entry_gap = ((bot_buy_price - t_buy_price) / t_buy_price * 100) if t_buy_price > 0 else 0.0
    
    real_trades.append({
        "symbol": data["symbol"],
        "mint": m,
        "time": datetime.fromtimestamp(b.get("at", 0) / 1000, tz=wib).strftime("%H:%M:%S"),
        "b_sol": b_sol,
        "s_sol": s_sol_total,
        "net_sol": net_sol,
        "roi_sol": roi_sol,
        "t_buy_price": t_buy_price,
        "bot_buy_price": bot_buy_price,
        "entry_gap": entry_gap,
        "t_buy_sol": t_buy_sol,
        "is_rug": no_route and s_sol_total == 0,
        "partial_rug": no_route and s_sol_total > 0
    })

print(f"Total REAL TRADES executed: {len(real_trades)}")
hdr = f"{'Token':<10} | {'Waktu':<8} | {'Target Price':<14} | {'Bot Entry Price':<16} | {'Entry Gap':<10} | {'Beli SOL':<10} | {'Jual SOL':<10} | {'Net SOL':<10} | {'ROI %':<8} | {'Hasil'}"
print(hdr)
print("-" * len(hdr))

for r in real_trades:
    res = "🟢 WIN" if r["net_sol"] > 0 else ("🔴 RUG" if r["is_rug"] else "🔴 LOSS")
    row = f"{r['symbol']:<10} | {r['time']} | ${r['t_buy_price']:.8f} | ${r['bot_buy_price']:.8f} | {r['entry_gap']:+6.1f}%   | {r['b_sol']:.6f} | {r['s_sol']:.6f} | {r['net_sol']:+.6f} | {r['roi_sol']:+6.1f}% | {res}"
    print(row)

wins = [r for r in real_trades if r["net_sol"] > 0]
losses = [r for r in real_trades if r["net_sol"] <= 0]
print("\n" + "=" * 80)
print(f"REAL ON-CHAIN RESULTS: {len(wins)} WIN / {len(losses)} LOSS ({len(wins)/len(real_trades)*100:.1f}% Win Rate)")
tot_b = sum(r["b_sol"] for r in real_trades)
tot_s = sum(r["s_sol"] for r in real_trades)
print(f"Total SOL Beli : {tot_b:.6f} SOL")
print(f"Total SOL Jual : {tot_s:.6f} SOL")
print(f"Net Real Hasil : {tot_s - tot_b:+.6f} SOL (~${(tot_s - tot_b)*92.5:+.2f} USD)")
