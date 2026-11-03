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
        mints[m] = {
            "symbol": sig.get("symbol") or d.get("symbol") or "UNKNOWN",
            "events": []
        }
    mints[m]["events"].append(e)

print(f"Total entries: {len(lines)}, Total tokens: {len(mints)}")

total_buy_sol = 0.0
total_sell_sol = 0.0
trades_count = 0

for m, data in mints.items():
    sym = data["symbol"]
    evts = data["events"]
    
    # Check if real buy happened
    real_buys = [e for e in evts if "BUY" in e.get("type", "") and e.get("details", {}).get("submit", {}).get("ok") is True]
    if not real_buys:
        continue
    
    trades_count += 1
    first_time = datetime.fromtimestamp(evts[0]["at"] / 1000, tz=wib).strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n🪙 [{trades_count}] {sym:<10} ({m[:10]}...) | Waktu: {first_time} WIB")
    
    token_buy_sol = 0.0
    token_sell_sol = 0.0
    
    for b in real_buys:
        d = b.get("details", {})
        q = d.get("response", {}).get("swap", {}).get("quote", {})
        in_amt = q.get("inAmount")
        stk = d.get("stakeUsd", 1.0)
        sol_amt = int(in_amt) / 1e9 if in_amt else 0.0
        token_buy_sol += sol_amt
        total_buy_sol += sol_amt
        sub_hash = d.get("submit", {}).get("hash", "")[:12]
        print(f"  🛒 BUY  : ${stk:.2f} | -{sol_amt:.6f} SOL (~${sol_amt * 92.5:.3f}) | Hash: {sub_hash}...")

    real_sells = [e for e in evts if "SELL" in e.get("type", "") and e.get("details", {}).get("submit", {}).get("ok") is True]
    for s in real_sells:
        d = s.get("details", {})
        q = d.get("response", {}).get("swap", {}).get("quote", {})
        out_amt = q.get("outAmount")
        reason = d.get("reason", "")[:35]
        sol_out = int(out_amt) / 1e9 if out_amt else 0.0
        token_sell_sol += sol_out
        total_sell_sol += sol_out
        sub_hash = d.get("submit", {}).get("hash", "")[:12]
        print(f"  💰 SELL : +{sol_out:.6f} SOL (~${sol_out * 92.5:.3f}) | Hash: {sub_hash}... | {reason}")

    no_routes = [e for e in evts if "NO_ROUTE" in e.get("type", "")]
    for nr in no_routes:
        d = nr.get("details", {})
        print(f"  ⚠️ NO ROUTE / DEV RUG: {d.get('reason', '')[:40]}")

    net_token_sol = token_sell_sol - token_buy_sol
    net_token_usd = net_token_sol * 92.5
    status_icon = "🟢 UNTUNG" if net_token_sol > 0 else "🔴 RUGI"
    print(f"  👉 HASIL: {status_icon} | Net: {net_token_sol:+.6f} SOL ({net_token_usd:+.2f} USD)")

print("\n" + "=" * 60)
print(f"RINGKASAN TOTAL DARI {trades_count} KOIN YANG DIBELI NYATA:")
print(f"Total Modal Beli : -{total_buy_sol:.6f} SOL (~${total_buy_sol * 92.5:.2f})")
print(f"Total Hasil Jual : +{total_sell_sol:.6f} SOL (~${total_sell_sol * 92.5:.2f})")
net_all = total_sell_sol - total_buy_sol
print(f"Net Total Bersih : {net_all:+.6f} SOL (~${net_all * 92.5:+.2f} USD)")
