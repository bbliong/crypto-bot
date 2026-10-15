import json, datetime

with open("data/profit4-watch/2026-10-13T16-35-27-642Z/profit4-state.json") as f:
    state = json.load(f)

v6_entered = [p for p in state.get("positions", []) if p.get("laneLabel") == "V6" and p.get("entryAt") is not None]
print(f"Total V6 entered: {len(v6_entered)}")
for i, p in enumerate(v6_entered, 1):
    ts = (p.get("entryAt") or (p.get("timestamp") * 1000)) / 1000
    wib = datetime.datetime.fromtimestamp(ts, tz=datetime.timezone.utc) + datetime.timedelta(hours=7)
    sym = p.get("symbol", "UNKNOWN")
    mint = p["mint"][:8]
    net = p.get("netReturnPercent", 0)
    pnl = p.get("pnlUsd", 0)
    entry_p = p.get("entryPrice", 0)
    exit_p = p.get("exitPrice", 0)
    reason = p.get("lastEvent", {}).get("reason", "UNKNOWN")
    time_str = wib.strftime("%Y-%m-%d %H:%M:%S")
    print(f"{i:2d}. {sym:10} | {mint} | Net: {net:+6.2f}% | PnL: ${pnl:+5.2f} | In: {entry_p:.8f} | Out: {exit_p:.8f} | {reason:28} | {time_str}")
