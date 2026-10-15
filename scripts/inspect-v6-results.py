import json
import urllib.request
from datetime import datetime

url = "http://127.0.0.1:4178/api/state"
req = urllib.request.urlopen(url)
data = json.loads(req.read().decode('utf-8'))

positions = data.get("positions", [])
print(f"Total positions in system: {len(positions)}")

# Filter positions with v6
v6_positions = [p for p in positions if "v6" in (p.get("version") or "").lower() or p.get("laneLabel") == "V6"]
print(f"\n--- V6 POSITIONS ({len(v6_positions)}) ---")
for p in v6_positions:
    symbol = p.get("symbol", "UNKNOWN")
    mint = p.get("mint", "")[:8]
    phase = p.get("phase")
    net_pct = p.get("netReturnPercent")
    net_usd = p.get("netReturnUsd")
    reason = p.get("exitReason")
    entry_ts = p.get("entryAt")
    exit_ts = p.get("exitAt")
    entry_str = datetime.fromtimestamp(entry_ts/1000).strftime('%Y-%m-%d %H:%M:%S') if entry_ts else '-'
    exit_str = datetime.fromtimestamp(exit_ts/1000).strftime('%Y-%m-%d %H:%M:%S') if exit_ts else '-'
    pct_str = f"{net_pct:+.2f}%" if net_pct is not None else "N/A"
    usd_str = f"${net_usd:+.4f}" if net_usd is not None else "N/A"
    print(f"[{symbol} - {mint}] {phase} | Net%: {pct_str} | PnL: {usd_str} | Exit: {reason} | Entry: {entry_str} -> Exit: {exit_str}")

# Filter trades that occurred during the same timeframe as V6 (after the first V6 entry)
if v6_positions:
    first_v6_time = min(p.get("entryAt") or 9999999999999 for p in v6_positions)
    print(f"\nComparing all lanes since V6 first entry ({datetime.fromtimestamp(first_v6_time/1000).strftime('%Y-%m-%d %H:%M:%S')}):")
    
    lanes = ["V1", "V2", "V3", "V4", "V5", "V6"]
    for lane in lanes:
        lane_items = [p for p in positions if ((p.get("laneLabel") == lane) or (lane.lower() in (p.get("version") or "").lower())) and (p.get("entryAt") or 0) >= first_v6_time - 60000]
        closed = [p for p in lane_items if p.get("phase") == "CLOSED" and p.get("netReturnPercent") is not None]
        wins = [p for p in closed if p.get("netReturnPercent", 0) > 0]
        losses = [p for p in closed if p.get("netReturnPercent", 0) <= 0]
        tot_pnl = sum(p.get("netReturnUsd", 0) for p in closed)
        avg_pct = sum(p.get("netReturnPercent", 0) for p in closed) / len(closed) if closed else 0
        wr = (len(wins) / len(closed) * 100) if closed else 0
        print(f"  {lane}: {len(closed)} closed trades | {len(wins)} Win, {len(losses)} Loss | WR: {wr:.1f}% | Net PnL: ${tot_pnl:+.4f} | Avg Return: {avg_pct:+.2f}%")
