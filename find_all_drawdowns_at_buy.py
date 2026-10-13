import json, os

base_dir = "data/profit4-watch/2026-10-12T17-09-10-368Z/chunks"
chunks = sorted(os.listdir(base_dir))

# Cari semua PAPER_BUY di semua lane
buys = []
for c in chunks:
    pe = os.path.join(base_dir, c, "profit4-events.jsonl")
    if not os.path.exists(pe): continue
    with open(pe) as f:
        for line in f:
            if not line.strip(): continue
            ev = json.loads(line)
            if ev.get("type") == "PAPER_BUY":
                buys.append(ev)

# Group by mint
mints = {}
for b in buys:
    m = b.get("mint")
    if m not in mints: mints[m] = []
    mints[m].append(b)

print(f"Total tokens bought across lanes: {len(mints)}")

for m, blist in mints.items():
    symbol = blist[0].get("transfer", {}).get("symbol", "N/A")
    first_buy = blist[0]
    buy_time = first_buy.get("observedAt")
    buy_price = first_buy.get("priceUsd")
    lanes = list(set(b.get("laneLabel") for b in blist))
    
    # Cari semua trade sebelum buy_time untuk hitung peak & drawdown
    prices = []
    for c in chunks:
        p = os.path.join(base_dir, c, "token-trades.jsonl")
        if not os.path.exists(p): continue
        with open(p) as f:
            for line in f:
                if not line.strip(): continue
                t = json.loads(line)
                if t.get("mint") == m and t.get("observedAt") <= buy_time:
                    prices.append(t.get("price"))
    
    if prices:
        peak = max(prices)
        trough = min(prices)
        dd = (1 - buy_price / peak) * 100
        print(f"\nToken: {symbol} ({m[:6]}...) | Bought by lanes: {lanes}")
        print(f"  Peak before buy: {peak:.8f}")
        print(f"  Buy price:       {buy_price:.8f}")
        print(f"  Drawdown at buy: {dd:.2f}%")
