import json, glob

# Let us find facts or rejection events for these tokens in chunks
chunks = sorted(glob.glob("data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/*/*.jsonl"))
print(f"Found {len(chunks)} chunk files")

mints_to_check = {
    "BvippEDS": "Hermès",
    "b93TfxUw": "CocaCola",
    "qqa2WCV2": "Haaland",
    "fHTLFcX6": "Taylor",
    "URFczBsm": "Kim (Rugpull)",
    "d7WFEQbd": "Simpsons (Dump)",
}

# Scan chunk files for facts or events related to these mints
events_found = {}
for ch in chunks:
    with open(ch) as f:
        for line in f:
            if not line.strip(): continue
            try:
                rec = json.loads(line)
                m = rec.get("mint", "")[:8]
                if m in mints_to_check:
                    events_found.setdefault(m, []).append(rec)
            except:
                pass

for m, sym in mints_to_check.items():
    evs = events_found.get(m, [])
    print(f"\n=== {sym} ({m}) - {len(evs)} events ===")
    v6_evs = [e for e in evs if e.get("lane") == "V6" or "v6" in (e.get("version") or "").lower()]
    for e in v6_evs:
        print("  Event:", e.get("type"), e.get("reason"), "price:", e.get("price"), "drawdown:", e.get("drawdownPercent"), "devShare:", e.get("devHoldingSharePercent"))
