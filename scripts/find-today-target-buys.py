import subprocess
import json
import re

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 00:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

raw_buys = []
for line in out.splitlines():
    if "[GMGN WS RAW ITEM] Event: buy" in line and "Raw: " in line:
        try:
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            raw_buys.append(d)
        except:
            pass

print(f"Total GMGN WS Buy Events caught today: {len(raw_buys)}")

first_buys = {}
for b in raw_buys:
    m = b.get("a")
    if m and m not in first_buys:
        first_buys[m] = b

print(f"Total Unique Mints bought by Target Whale today: {len(first_buys)}")
for m, b in first_buys.items():
    sym = b.get("bs")
    t = b.get("t")
    tx = b.get("h")
    usd = b.get("au")
    sol = b.get("qa")
    print(f"Mint: {m} | Sym: {sym} | Sol: {sol} | Usd: {usd} | Tx: {tx}")
