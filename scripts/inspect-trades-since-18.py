import json
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

lines = []
with open("/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl") as f:
    for line in f:
        if line.strip():
            try:
                lines.append(json.loads(line))
            except: pass

print(f"Total lines in follower-real-ledger: {len(lines)}")

# Filter trades since 18:00 WIB (timestamp >= 1793704800000 or today 18:00)
# 18:00 WIB today:
# Nov 03 18:00:00 WIB = timestamp 1793703600
trades_since_18 = []
seen_tx = set()

for e in lines:
    sig = e.get("details", {}).get("signal", {})
    tx = sig.get("txHash")
    if not tx or tx in seen_tx: continue
    seen_tx.add(tx)
    
    ts = sig.get("timestamp", 0)
    if ts > 1e11: ts /= 1000
    
    dt = datetime.fromtimestamp(ts, tz=wib)
    if dt.hour >= 18:
        trades_since_18.append({
            "action": sig.get("action"),
            "symbol": sig.get("symbol"),
            "mint": sig.get("mint"),
            "time_wib": dt.strftime("%H:%M:%S"),
            "priceUsd": sig.get("priceUsd"),
            "solAmount": sig.get("solAmount"),
            "isFirstBuy": sig.get("isFirstBuy"),
            "remainingHolding": sig.get("remainingHolding"),
            "tokenAmount": sig.get("tokenAmount")
        })

print(f"Total transactions target executed since 18:00 WIB: {len(trades_since_18)}")
for t in trades_since_18:
    act = t["action"].upper()
    sym = t["symbol"]
    m = t["mint"][:12] if t["mint"] else "-"
    tm = t["time_wib"]
    sol = t["solAmount"]
    fb = "FIRST_BUY 🟢" if t.get("isFirstBuy") else "BUY_MORE / SELL"
    print(f"  {tm} | {act:<4} {sym:<10} ({m}...) | {sol:6.2f} SOL | Tag: {fb} | Price: ${t['priceUsd']}")
