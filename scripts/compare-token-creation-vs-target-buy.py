import json
import urllib.request
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

with open("/home/bbliong/project/crypto-bot/data/dryrun-3scenarios-live.json") as f:
    d = json.load(f)

trades = d["s4"]["closedTrades"]

print("=" * 115)
print("PERBANDINGAN DETAIL WAKTU: KELAHIRAN TOKEN/POOL OLEH DEV vs WAKTU TARGET BELI")
print("=" * 115)
print(f"{'No':<3} | {'Symbol':<8} | {'Waktu Lahir Pool (Dev)':<24} | {'Waktu Target Beli':<24} | {'Selisih Waktu':<15} | {'Mint':<16}")
print("-" * 115)

for idx, t in enumerate(reversed(trades), 1):
    mint = t["mint"]
    sym = t["symbol"]
    bot_buy_ms = t["openedAt"]
    bot_buy_str = datetime.fromtimestamp(bot_buy_ms/1000, tz=wib).strftime("%H:%M:%S.%f")[:-3]

    # Query DexScreener pairCreatedAt
    url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
    pair_created_ms = None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
        pairs = data.get("pairs") or []
        if pairs:
            pair_created_ms = pairs[0].get("pairCreatedAt")
    except Exception:
        pass

    if pair_created_ms:
        pair_created_str = datetime.fromtimestamp(pair_created_ms/1000, tz=wib).strftime("%H:%M:%S.%f")[:-3]
        diff_sec = (bot_buy_ms - pair_created_ms) / 1000.0
        diff_str = f"+{diff_sec:.1f} detik"
    else:
        pair_created_str = "N/A"
        diff_str = "N/A"

    print(f"{idx:<3} | {sym:<8} | {pair_created_str:<24} | {bot_buy_str:<24} | {diff_str:<15} | {mint[:16]}...")
