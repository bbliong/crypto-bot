import json, subprocess

cmd = "journalctl --user-unit=crypto-bot-wallet-follower.service --since=\"2026-11-08 00:00:00\" --grep=\"GMGN WS RAW ITEM\" --no-pager"
p = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

events = []
for line in p.stdout:
    if "Raw: " in line:
        try:
            raw_json = line[line.index("Raw: ") + 5:].strip()
            data = json.loads(raw_json)
            events.append(data)
        except:
            pass

tokens = {}
for e in events:
    mint = e.get("a")
    if not mint: continue
    if mint not in tokens: tokens[mint] = []
    tokens[mint].append(e)

high_conviction = {mint: evs for mint, evs in tokens.items() if any(e.get("e") == "buy" and float(e.get("qa") or 0) >= 20 for e in evs)}

consecutive_gaps = []
consecutive_details = []

for mint, evs in high_conviction.items():
    evs.sort(key=lambda x: x.get("t", 0))
    sym = evs[0].get("bs") or evs[0].get("bn") or mint[:8]
    
    current_streak = []
    for e in evs:
        if e.get("e") == "sell":
            current_streak.append(e)
            if len(current_streak) == 3:
                t1 = current_streak[0].get("t", 0)
                t2 = current_streak[1].get("t", 0)
                t3 = current_streak[2].get("t", 0)
                gap1 = t2 - t1
                gap2 = t3 - t2
                total_span = t3 - t1
                usd1 = float(current_streak[0].get("au") or 0)
                usd2 = float(current_streak[1].get("au") or 0)
                usd3 = float(current_streak[2].get("au") or 0)
                consecutive_gaps.append(total_span)
                consecutive_details.append({
                    "symbol": sym,
                    "gap1": gap1,
                    "gap2": gap2,
                    "total_span": total_span,
                    "amounts": [usd1, usd2, usd3]
                })
        else:
            current_streak = []

print(f"Total kemunculan 3 Consecutive Sells: {len(consecutive_details)} kejadian")
print("\nContoh 15 Kejadian dari Berbagai Koin:")
for d in consecutive_details[:15]:
    s_sym = d['symbol']
    g1 = d['gap1']
    g2 = d['gap2']
    sp = d['total_span']
    a1, a2, a3 = d['amounts']
    print(f"Token {s_sym:<10}: Jeda Sell 1->2: {g1}s | Jeda Sell 2->3: {g2}s | Total Durasi 3 Sell: {sp}s | Nominal: ${a1:.0f}, ${a2:.0f}, ${a3:.0f}")

avg_gap1 = sum(d["gap1"] for d in consecutive_details) / len(consecutive_details) if consecutive_details else 0
avg_gap2 = sum(d["gap2"] for d in consecutive_details) / len(consecutive_details) if consecutive_details else 0
avg_span = sum(consecutive_gaps) / len(consecutive_gaps) if consecutive_gaps else 0
median_span = sorted(consecutive_gaps)[len(consecutive_gaps)//2] if consecutive_gaps else 0

print(f"\n--- Rata-Rata Statistik Kecepatan Sell Beruntun ---")
print(f"Rata-rata jeda Sell 1 ke Sell 2 : {avg_gap1:.1f} detik")
print(f"Rata-rata jeda Sell 2 ke Sell 3 : {avg_gap2:.1f} detik")
print(f"Rata-rata total rentang 3 Sell  : {avg_span:.1f} detik (Median: {median_span} detik)")
print(f"Persentase sell terjadi <= 10s  : {sum(1 for s in consecutive_gaps if s <= 10) / len(consecutive_gaps) * 100:.1f}%")
