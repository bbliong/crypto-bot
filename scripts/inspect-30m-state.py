import json
import time

now_ms = int(time.time() * 1000)
cutoff_30m = now_ms - (30 * 60 * 1000)

paths = [
    "/home/bbliong/project/crypto-bot/data/profit4-watch/2026-10-19T09-59-29-955Z/profit4-state.json",
    "/home/bbliong/project/crypto-bot/data/momentum-watch/2026-10-19T09-59-36-750Z/profit4-state.json",
    "/home/bbliong/project/crypto-bot/data/syndicate-watch/2026-10-19T09-59-36-967Z/profit4-state.json",
    "/home/bbliong/project/crypto-bot/data/smartmoney-watch/2026-10-19T09-59-36-930Z/profit4-state.json"
]

for p_path in paths:
    try:
        with open(p_path) as fp:
            d = json.load(fp)
            positions = d.get("positions", [])
            recent = [x for x in positions if (x.get("entryAt") or x.get("registeredAt") or (x.get("timestamp", 0) * 1000)) >= cutoff_30m]
            lanes = {}
            for pos in recent:
                lane = pos.get("laneLabel", "unknown")
                if lane not in lanes:
                    lanes[lane] = {"watched": 0, "open": 0, "closed": 0, "win": 0, "loss": 0, "pnl": 0.0}
                lanes[lane]["watched"] += 1
                phase = pos.get("phase", "")
                if phase in ["OPEN", "ENTRY_PENDING"]:
                    lanes[lane]["open"] += 1
                elif phase in ["CLOSED", "EXIT_SUBMITTED", "EXITED"]:
                    lanes[lane]["closed"] += 1
                    pnl = pos.get("pnlUsd") or 0.0
                    lanes[lane]["pnl"] += pnl
                    if pnl > 0 or (pos.get("netReturnPercent") or 0) > 0:
                        lanes[lane]["win"] += 1
                    else:
                        lanes[lane]["loss"] += 1
            tag = p_path.split("/")[-2]
            print(f"=== {tag} (Lanes: {len(lanes)}) ===")
            for l_name in sorted(lanes.keys()):
                st = lanes[l_name]
                wr = (st["win"] / st["closed"] * 100) if st["closed"] > 0 else 0
                w = st['watched']
                op = st['open']
                cl = st['closed']
                wn = st['win']
                ls = st['loss']
                pnl = st['pnl']
                print(f"  {l_name:12s}: watched={w:3d}, open={op:2d}, closed={cl:2d} ({wn}W/{ls}L {wr:4.1f}%), PnL=${pnl:+.2f}")
    except Exception as e:
        print(f"Error {p_path}: {e}")
