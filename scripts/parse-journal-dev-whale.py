import subprocess
import json
import re
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 00:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

dev_triggers = [] # {time, sig, mint, sym}
target_buys = []  # {time, sig, mint, sym, sol, usd, isFirst}

lines = out.splitlines()
for idx, line in enumerate(lines):
    if "[DEV-RADAR TRIGGER] Dev" in line and "tx:" in line:
        # ⚡ [DEV-RADAR TRIGGER] Dev P5ormJ7h... baru saja mendeploy token/pool baru (tx: 5zXQr33Ch9W3...)!
        m_sig = re.search(r"\(tx:\s*([a-zA-Z0-9]+)\)", line)
        t_str = line[:15]
        sig = m_sig.group(1) if m_sig else ""
        dev_triggers.append({"line_idx": idx, "time": t_str, "sig": sig})
    
    if "[DEV-RADAR SUCCESS] DITEMUKAN TOKEN RE-DEPLOY" in line or "[DEV-RADAR POOL]" in line:
        pass

    if "[GMGN WS RAW ITEM] Event: buy" in line and "Raw: " in line:
        try:
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            target_buys.append({
                "line_idx": idx,
                "time": line[:15],
                "mint": d.get("a"),
                "sym": d.get("bs"),
                "sol": float(d.get("qa") or 0),
                "usd": float(d.get("au") or 0),
                "tx": d.get("h"),
                "timestamp": d.get("t")
            })
        except:
            pass

print(f"Total Dev Triggers logged: {len(dev_triggers)}")
print(f"Total Target Buys logged: {len(target_buys)}")

# Kumpulkan first buy target per mint
first_buys_by_mint = {}
for tb in target_buys:
    m = tb["mint"]
    if m and m not in first_buys_by_mint:
        first_buys_by_mint[m] = tb

print(f"Unique tokens target bought: {len(first_buys_by_mint)}")
