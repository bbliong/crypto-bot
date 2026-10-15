import json, glob
from datetime import datetime

chunks = sorted(glob.glob("data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/*/*.jsonl"))
tokens = {"LJsYibsU": "MarsX", "bRBYoeuq": "TRALA"}

for m, sym in tokens.items():
    print(f"\n=================== ANALISIS FORENSIK TOKEN {sym} ({m}) ===================")
    mint_trades = []
    v6_events = []
    for ch in chunks:
        with open(ch) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    r = json.loads(line)
                    if r.get("mint", "").startswith(m):
                        if "trade" in r or "side" in r:
                            mint_trades.append(r)
                        if r.get("lane") == "V6" or "v6" in (r.get("version") or "").lower():
                            v6_events.append(r)
                except:
                    pass

    # Sort trades by time
    mint_trades.sort(key=lambda x: x.get("at") or x.get("observedAt") or (x.get("timestamp",0)*1000))
    
    # Find V6 buy and sell events
    v6_buy = next((e for e in v6_events if e.get("type") == "PAPER_BUY"), None)
    v6_sell = next((e for e in v6_events if e.get("type") == "PAPER_SELL"), None)

    buy_time = v6_buy.get("observedAt") if v6_buy else None
    sell_time = v6_sell.get("observedAt") if v6_sell else None

    print(f"V6 Buy Time : {datetime.fromtimestamp(buy_time/1000).strftime('%H:%M:%S.%f') if buy_time else 'N/A'}")
    print(f"V6 Sell Time: {datetime.fromtimestamp(sell_time/1000).strftime('%H:%M:%S.%f') if sell_time else 'N/A'}")
    print(f"V6 Buy Price: {v6_buy.get('price') if v6_buy else 'N/A'}")
    print(f"V6 Sell Price: {v6_sell.get('price') if v6_sell else 'N/A'}")
    print(f"V6 Sell Reason: {v6_sell.get('reason') if v6_sell else 'N/A'}")
    print(f"V6 Net Return: {v6_sell.get('netReturnPercent') if v6_sell else 'N/A'}%")

    # Look at trades occurring between buy_time and sell_time
    if buy_time and sell_time:
        during_trade = []
        for t in mint_trades:
            ts = t.get("at") or t.get("observedAt") or (t.get("timestamp", 0) * 1000)
            if buy_time - 1000 <= ts <= sell_time + 1000:
                during_trade.append((ts, t.get("trade") or t))

        print(f"\n--- Transaksi yang Terjadi Selama Posisi Terbuka ({len(during_trade)}) ---")
        for ts, t in during_trade:
            t_str = datetime.fromtimestamp(ts/1000).strftime('%H:%M:%S.%f')[:-3]
            side = t.get("side", "").upper()
            usd = t.get("usd", 0)
            price = t.get("price", 0)
            wallet = t.get("wallet", "N/A")[:8]
            print(f"[{t_str}] {side:4s} | ${usd:6.2f} USD | price: {price:.8f} | wallet: {wallet}...")
