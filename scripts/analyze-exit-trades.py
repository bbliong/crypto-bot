import json, glob
from datetime import datetime

chunks = sorted(glob.glob("data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/*/*.jsonl"))
tokens = {"LJsYibsU": "MarsX", "bRBYoeuq": "TRALA"}

for m, sym in tokens.items():
    trades = []
    events = []
    for ch in chunks:
        with open(ch) as f:
            for l in f:
                if not l.strip(): continue
                try:
                    r = json.loads(l)
                    if r.get("mint", "").startswith(m):
                        if "trade" in r or "side" in r: trades.append(r)
                        if r.get("lane") == "V6" or "v6" in (r.get("version") or "").lower(): events.append(r)
                except: pass
    
    trades.sort(key=lambda x: x.get("at") or x.get("observedAt") or (x.get("timestamp",0)*1000))
    buy = next((e for e in events if e.get("type") == "PAPER_BUY"), None)
    sell = next((e for e in events if e.get("type") == "PAPER_SELL"), None)
    
    b_at = buy.get("observedAt") if buy else 0
    s_at = sell.get("observedAt") if sell else 0
    b_price = buy.get("price") if buy else 0
    s_price = sell.get("price") if sell else 0
    ret = sell.get("netReturnPercent") if sell else 0
    reason = sell.get("reason") if sell else ""
    
    b_str = datetime.fromtimestamp(b_at/1000).strftime("%H:%M:%S.%f")[:-3] if b_at else "N/A"
    s_str = datetime.fromtimestamp(s_at/1000).strftime("%H:%M:%S.%f")[:-3] if s_at else "N/A"

    print(f"\n=== TOKEN {sym} ({m}) ===")
    print(f"ENTRY: Price={b_price} at {b_str}")
    print(f"EXIT : Price={s_price} at {s_str}")
    print(f"RETURN: {ret:.2f}% | REASON: {reason}")
    
    exit_trades = [t for t in trades if s_at - 3000 <= (t.get("at") or t.get("observedAt") or (t.get("timestamp",0)*1000)) <= s_at + 1000]
    print(f"Trades around exit time ({len(exit_trades)}):")
    for t in exit_trades:
        to = t.get("trade") or t
        ts = t.get("at") or t.get("observedAt") or (t.get("timestamp",0)*1000)
        t_str = datetime.fromtimestamp(ts/1000).strftime("%H:%M:%S.%f")[:-3]
        usd = to.get("usd", 0)
        price = to.get("price", 0)
        side = to.get("side", "").upper()
        wallet = to.get("wallet", "")[:8]
        print(f"  [{t_str}] {side:4s} | ${usd:6.2f} | price: {price:.8f} | wallet: {wallet}")
