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

sim_results = []
for mint, evs in high_conviction.items():
    evs.sort(key=lambda x: x.get("t", 0))
    first_buy = next((e for e in evs if e.get("e") == "buy"), None)
    if not first_buy: continue
    t0 = first_buy.get("t", 0)
    initial_tokens = float(first_buy.get("ba") or 0)
    sym = evs[0].get("bs") or evs[0].get("bn") or mint[:8]
    
    consecutive_sells = 0
    in_pos = False
    entry_p = 0
    cycles = 0
    wins = 0
    losses = 0
    total_pnl = 0
    stake = 5.0
    gas = 0.05
    status = "ACTIVE"
    term_reason = ""
    
    for idx, e in enumerate(evs):
        if idx == 0: continue
        t = e.get("t", 0)
        age = t - t0
        ev_type = e.get("e")
        price = float(e.get("pu") or 0)
        cur_bal = float(e.get("b") or 0)
        sold_pct = ((initial_tokens - cur_bal) / initial_tokens * 100) if initial_tokens > 0 else 0
        
        if status != "ACTIVE": break
        
        if age >= 600:
            status = "TERMINATED"
            term_reason = "10m_TIMEOUT"
            if in_pos:
                pnl = (stake * (price - entry_p) / entry_p) - gas if entry_p > 0 else -gas
                total_pnl += pnl
                if pnl >= 0: wins += 1
                else: losses += 1
                in_pos = False
            break
            
        if sold_pct >= 35.0:
            status = "TERMINATED"
            term_reason = f"CUM_SOLD_{sold_pct:.1f}%"
            if in_pos:
                pnl = (stake * (price - entry_p) / entry_p) - gas if entry_p > 0 else -gas
                total_pnl += pnl
                if pnl >= 0: wins += 1
                else: losses += 1
                in_pos = False
            break

        if ev_type == "sell":
            consecutive_sells += 1
            if consecutive_sells >= 3:
                status = "TERMINATED"
                term_reason = "3_CONSECUTIVE_SELLS"
                if in_pos:
                    pnl = (stake * (price - entry_p) / entry_p) - gas if entry_p > 0 else -gas
                    total_pnl += pnl
                    if pnl >= 0: wins += 1
                    else: losses += 1
                    in_pos = False
                break
                
            if in_pos:
                gain = (price - entry_p) / entry_p * 100 if entry_p > 0 else 0
                if gain <= -10:
                    pnl = (stake * gain / 100) - gas
                    total_pnl += pnl
                    losses += 1
                    in_pos = False
            else:
                if consecutive_sells == 1 and price > 0:
                    in_pos = True
                    entry_p = price
                    cycles += 1
        else: # BUY event
            consecutive_sells = 0
            if in_pos:
                gain = (price - entry_p) / entry_p * 100 if entry_p > 0 else 0
                if gain >= 4.0 or price >= entry_p:
                    pnl = (stake * gain / 100) - gas
                    total_pnl += pnl
                    wins += 1
                    in_pos = False
                elif gain <= -10.0:
                    pnl = (stake * gain / 100) - gas
                    total_pnl += pnl
                    losses += 1
                    in_pos = False

    if cycles > 0:
        sim_results.append({
            "symbol": sym,
            "cycles": cycles,
            "wins": wins,
            "losses": losses,
            "pnl": total_pnl,
            "term": term_reason
        })

print(f"Hasil Simulasi Dynamic S13 pada {len(sim_results)} Token Hari Ini:\n")
tot_cycles = sum(r["cycles"] for r in sim_results)
tot_wins = sum(r["wins"] for r in sim_results)
tot_losses = sum(r["losses"] for r in sim_results)
tot_pnl = sum(r["pnl"] for r in sim_results)

for r in sim_results:
    sym = r["symbol"]
    cyc = r["cycles"]
    w = r["wins"]
    l = r["losses"]
    p = r["pnl"]
    tm = r["term"]
    wr = (w / (w + l) * 100) if (w + l) > 0 else 0
    print(f"Token {sym:<10} | Siklus: {cyc:2d} | W/L: {w:2d}/{l:2d} (WR: {wr:3.0f}%) | Net PnL: ${p:+.2f} | Terminate: {tm}")

print("\n" + "="*60)
print(f"TOTAL SIKLUS DIPERIKSA : {tot_cycles}")
print(f"TOTAL MENANG / KALAH   : {tot_wins} WIN / {tot_losses} LOSS (Win Rate: {tot_wins/(tot_wins+tot_losses)*100:.1f}%)")
print(f"TOTAL NET PNL RIIL     : ${tot_pnl:+.2f} USD")
