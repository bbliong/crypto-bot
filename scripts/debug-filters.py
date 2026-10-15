import json

with open("data/profit4-watch/2026-10-13T16-35-27-642Z/profit4-state.json") as f:
    st = json.load(f)

positions = st.get("positions", [])
by_lane = {}
for p in positions:
    l = p.get("laneLabel") or "unknown"
    by_lane.setdefault(l, {})[p.get("mint")] = p

v1 = by_lane.get("V1", {})
v4 = by_lane.get("V4", {})
v5 = by_lane.get("V5", {})
v6 = by_lane.get("V6", {})

diff_mints = [m for m, p in v1.items() if (p.get("entryAt") is not None or v4.get(m, {}).get("entryAt") is not None) and v6.get(m, {}).get("entryAt") is None]

print("Total tokens entered in V1/V4 but filtered out by V6:", len(diff_mints))
for m in diff_mints:
    p1 = v1.get(m, {})
    p4 = v4.get(m, {})
    p6 = v6.get(m, {})
    sym = p1.get("symbol") or p4.get("symbol")
    p1_ret = p1.get("netReturnPercent")
    p4_ret = p4.get("netReturnPercent")
    r1 = f"{p1_ret:+.1f}%" if p1_ret is not None else "no entry"
    r4 = f"{p4_ret:+.1f}%" if p4_ret is not None else "no entry"
    p6_phase = p6.get("phase") if p6 else "NOT_FOUND"
    p6_ev = (p6.get("lastEvent") or {}) if p6 else {}
    reason = p6_ev.get("reason", "N/A")
    print(f"- {sym:12s} ({m[:8]}...): V1={r1}, V4={r4} | V6 phase={p6_phase}, reason={reason}")
