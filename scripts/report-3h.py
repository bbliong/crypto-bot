import json, time, os, datetime

now = time.time()
cutoff_3h = now - (3 * 3600)
cutoff_ms = int(cutoff_3h * 1000)
now_ms = int(now * 1000)

now_dt = datetime.datetime.fromtimestamp(now)
cutoff_dt = datetime.datetime.fromtimestamp(cutoff_3h)

fmt = "%Y-%m-%d %H:%M:%S"
print(f"Periode Laporan: {cutoff_dt.strftime(fmt)} s/d {now_dt.strftime(fmt)} WIB\n")

def analyze_worker(path, name):
    if not os.path.exists(path):
        print(f"Path not found: {path}")
        return None
    with open(path) as f:
        d = json.load(f)
    positions = d.get("positions", [])
    
    closed_in_3h = [p for p in positions if (p.get("exitAt") or 0) >= cutoff_ms and (p.get("exitAt") or 0) <= now_ms]
    open_now = [p for p in positions if p.get("phase") in ["OPEN", "ENTRY_PENDING"]]
    
    lanes = {}
    for p in closed_in_3h:
        l = p.get("laneLabel") or p.get("lane") or "unknown"
        if l not in lanes:
            lanes[l] = {
                "closed": 0, "win": 0, "loss": 0, "pnl": 0.0, 
                "wins_pnl": 0.0, "loss_pnl": 0.0, 
                "tp_hits": 0, "sl_hits": 0, "trail_hits": 0, "timeout_hits": 0,
                "runners": []
            }
        lanes[l]["closed"] += 1
        pnl = p.get("pnlUsd") or 0.0
        ret = p.get("netReturnPercent") or 0.0
        reason = p.get("exitReason") or p.get("lastDecision") or ""
        
        if "TAKE_PROFIT" in reason or "TP" in reason:
            lanes[l]["tp_hits"] += 1
        elif "STOP_LOSS" in reason or "SL" in reason:
            lanes[l]["sl_hits"] += 1
        elif "TRAILING" in reason:
            lanes[l]["trail_hits"] += 1
        elif "TIMEOUT" in reason:
            lanes[l]["timeout_hits"] += 1

        lanes[l]["pnl"] += pnl
        if pnl > 0 or ret > 0:
            lanes[l]["win"] += 1
            lanes[l]["wins_pnl"] += pnl
            if pnl > 5.0 or ret > 50:
                lanes[l]["runners"].append((p.get("mint"), ret, pnl))
        else:
            lanes[l]["loss"] += 1
            lanes[l]["loss_pnl"] += pnl

    return {
        "name": name,
        "total_closed_3h": len(closed_in_3h),
        "open_now": len(open_now),
        "lanes": lanes
    }

mom = analyze_worker("/home/bbliong/project/crypto-bot/data/momentum-watch/2026-10-19T11-11-43-161Z/profit4-state.json", "Momentum")
syn = analyze_worker("/home/bbliong/project/crypto-bot/data/syndicate-watch/2026-10-19T11-11-43-536Z/profit4-state.json", "Syndicate")
sm  = analyze_worker("/home/bbliong/project/crypto-bot/data/smartmoney-watch/2026-10-19T11-11-43-674Z/profit4-state.json", "Smart Money")

print("=========================================================================================")
print(f"1. GROUP MOMENTUM (Total Closed 3 Jam: {mom['total_closed_3h']}, Open Saat Ini: {mom['open_now']})")
print("=========================================================================================")
tot_win = tot_loss = 0
tot_pnl = 0.0
for l, data in sorted(mom["lanes"].items(), key=lambda x: x[1]["pnl"], reverse=True):
    wr = (data["win"] / data["closed"] * 100) if data["closed"] > 0 else 0
    pf = (data["wins_pnl"] / abs(data["loss_pnl"])) if data["loss_pnl"] < 0 else (999.0 if data["wins_pnl"] > 0 else 0.0)
    tot_win += data["win"]
    tot_loss += data["loss"]
    tot_pnl += data["pnl"]
    print(f"• {l:12s} | {data['closed']:3d} trade | {data['win']:2d}W / {data['loss']:2d}L (WR {wr:4.1f}%) | PnL: ${data['pnl']:+7.2f} | PF: {pf:5.2f} | TP: {data['tp_hits']:2d}, SL: {data['sl_hits']:2d}, Trail: {data['trail_hits']:2d}, To: {data['timeout_hits']:2d}")
tot_wr = (tot_win / (tot_win + tot_loss) * 100) if (tot_win + tot_loss) > 0 else 0
print(f"--> Total Momentum: {tot_win}W / {tot_loss}L ({tot_wr:.1f}% WR) | Total PnL: ${tot_pnl:+.2f}")

print("\n=========================================================================================")
print(f"2. GROUP SINDIKAT (Total Closed 3 Jam: {syn['total_closed_3h']}, Open Saat Ini: {syn['open_now']})")
print("=========================================================================================")
syn_win = syn_loss = 0
syn_pnl = 0.0
for l, data in sorted(syn["lanes"].items(), key=lambda x: x[1]["pnl"], reverse=True):
    wr = (data["win"] / data["closed"] * 100) if data["closed"] > 0 else 0
    syn_win += data["win"]
    syn_loss += data["loss"]
    syn_pnl += data["pnl"]
    print(f"• {l:12s} | {data['closed']:3d} trade | {data['win']:2d}W / {data['loss']:2d}L (WR {wr:4.1f}%) | PnL: ${data['pnl']:+7.2f} | TP: {data['tp_hits']:2d}, SL: {data['sl_hits']:2d}, Trail: {data['trail_hits']:2d}")
syn_wr = (syn_win / (syn_win + syn_loss) * 100) if (syn_win + syn_loss) > 0 else 0
print(f"--> Total Sindikat: {syn_win}W / {syn_loss}L ({syn_wr:.1f}% WR) | Total PnL: ${syn_pnl:+.2f}")

print("\n=========================================================================================")
print(f"3. GROUP SMART MONEY (Total Closed 3 Jam: {sm['total_closed_3h']}, Open Saat Ini: {sm['open_now']})")
print("=========================================================================================")
sm_win = sm_loss = 0
sm_pnl = 0.0
for l, data in sorted(sm["lanes"].items(), key=lambda x: x[1]["pnl"], reverse=True):
    wr = (data["win"] / data["closed"] * 100) if data["closed"] > 0 else 0
    sm_win += data["win"]
    sm_loss += data["loss"]
    sm_pnl += data["pnl"]
    print(f"• {l:12s} | {data['closed']:3d} trade | {data['win']:2d}W / {data['loss']:2d}L (WR {wr:4.1f}%) | PnL: ${data['pnl']:+7.2f} | TP: {data['tp_hits']:2d}, SL: {data['sl_hits']:2d}, Trail: {data['trail_hits']:2d}")
sm_wr = (sm_win / (sm_win + sm_loss) * 100) if (sm_win + sm_loss) > 0 else 0
print(f"--> Total Smart Money: {sm_win}W / {sm_loss}L ({sm_wr:.1f}% WR) | Total PnL: ${sm_pnl:+.2f}")

print("\n=========================================================================================")
print("4. TOTAL PORTFOLIO 3 JAM TERAKHIR")
print("=========================================================================================")
all_closed = mom['total_closed_3h'] + syn['total_closed_3h'] + sm['total_closed_3h']
all_win = tot_win + syn_win + sm_win
all_loss = tot_loss + syn_loss + sm_loss
all_pnl = tot_pnl + syn_pnl + sm_pnl
all_wr = (all_win / all_closed * 100) if all_closed > 0 else 0
print(f"• Total Trades Closed: {all_closed}")
print(f"• Win Rate Gabungan  : {all_win}W / {all_loss}L ({all_wr:.1f}%)")
print(f"• Net PnL Gabungan   : ${all_pnl:+.2f} USD")
print(f"• Posisi Masih Open  : {mom['open_now'] + syn['open_now'] + sm['open_now']} token")
