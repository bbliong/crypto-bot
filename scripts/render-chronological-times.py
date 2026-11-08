import subprocess
import json
from datetime import datetime, timezone, timedelta
from urllib import request

wib = timezone(timedelta(hours=7))

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 00:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

# Kumpulkan semua raw buy event target whale dari GMGN WS
target_buys = {}
for line in out.splitlines():
    if "[GMGN WS RAW ITEM] Event: buy" in line and "Raw: " in line:
        try:
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            m = d.get("a")
            if m and m not in target_buys:
                target_buys[m] = d
        except:
            pass

print(f"Total Unique Tokens Bought by Target Whale: {len(target_buys)}")

data_rows = []

for mint, tb in target_buys.items():
    sym = tb.get("bs")
    sol = float(tb.get("qa") or 0)
    whale_ts = int(tb.get("t") or 0)
    whale_time_str = datetime.fromtimestamp(whale_ts, tz=wib).strftime("%H:%M:%S WIB") if whale_ts else "-"
    
    # Query DexScreener pairCreatedAt
    pool_ts = None
    try:
        url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
        req = request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            pairs = data.get("pairs") or []
            if pairs:
                ms = pairs[0].get("pairCreatedAt")
                if ms:
                    pool_ts = int(ms / 1000)
    except:
        pass
    
    pool_time_str = datetime.fromtimestamp(pool_ts, tz=wib).strftime("%H:%M:%S WIB") if pool_ts else "-"
    
    diff_str = "-"
    diff_sec = 0
    is_bundle = False
    if whale_ts and pool_ts:
        diff_sec = whale_ts - pool_ts
        if abs(diff_sec) <= 1:
            diff_str = "🔥 0 Detik (1 Blok Sama / Bundle)"
            is_bundle = True
        else:
            diff_str = f"⏳ +{diff_sec} Detik"
            
    data_rows.append({
        "sym": sym,
        "sol": sol,
        "pool_time": pool_time_str,
        "whale_time": whale_time_str,
        "diff": diff_str,
        "is_bundle": is_bundle,
        "diff_sec": diff_sec,
        "whale_ts": whale_ts
    })

# Sort secara kronologis berdasarkan waktu token lahir
data_rows.sort(key=lambda x: x["whale_ts"])

print("\n" + "=" * 105)
print(f"{'No':<3} | {'Koin / Simbol':<12} | {'Modal Whale':<11} | {'Waktu Token/Pool Dibuat':<24} | {'Waktu Whale Masuk':<20} | {'Jeda Waktu'}")
print("-" * 105)

for i, r in enumerate(data_rows, 1):
    sol_str = f"{r['sol']:.1f} SOL" if r['sol'] < 10 else f"{int(r['sol'])} SOL"
    print(f"{i:<3} | {r['sym']:<12} | {sol_str:>5}       | {r['pool_time']:<24} | {r['whale_time']:<20} | {r['diff']}")
print("=" * 105)

bundle_count = sum(1 for r in data_rows if r["is_bundle"])
delayed_count = len(data_rows) - bundle_count
print(f"\nRangkuman: Dari {len(data_rows)} koin:")
print(f" - {bundle_count} koin ({(bundle_count/len(data_rows)*100):.1f}%) Whale masuk di DETIK & BLOK YANG PERSIS SAMA (0 Detik Jito Bundle).")
print(f" - {delayed_count} koin ({(delayed_count/len(data_rows)*100):.1f}%) Whale masuk dengan JEDA WAKTU (Delayed).")
