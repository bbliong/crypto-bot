import json
import glob
import os
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# 1. Kumpulkan semua event ledger dari follower-real-ledger.jsonl
ledger_events = []
ledger_path = "/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"
if os.path.exists(ledger_path):
    with open(ledger_path) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    ledger_events.append(json.loads(line))
                except Exception:
                    pass

# Map mint to ledger signals
mint_ledger = {}
for e in ledger_events:
    d = e.get("details", {})
    sig = d.get("signal", {})
    m = sig.get("mint") or d.get("mint")
    if m:
        if m not in mint_ledger:
            mint_ledger[m] = []
        mint_ledger[m].append(e)

# 2. Kumpulkan semua closed trades dari file aktif dan semua backup
files = ["/home/bbliong/project/crypto-bot/data/dryrun-3scenarios-live.json"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/dryrun-3scenarios-live.json")

all_trades = []
seen = set()

for fpath in files:
    if not os.path.exists(fpath): continue
    try:
        with open(fpath) as f:
            d = json.load(f)
        for sc in ["s4", "s6"]:
            for t in d.get(sc, {}).get("closedTrades", []):
                key = (sc, t.get("mint"), t.get("openedAt"))
                if key not in seen:
                    seen.add(key)
                    t_copy = dict(t)
                    t_copy["scenario"] = sc
                    all_trades.append(t_copy)
    except Exception as e:
        pass

print(f"Total historical closed trades collected: {len(all_trades)}")

# Filter trades: identify Ground-Zero trades
# Ground-Zero criteria:
# Entry price <= $0.000020 (or entryCount == 1)
gz_trades = []
for t in all_trades:
    gz_trades.append(t)

# Categorize into WIN vs LOSS / RUGPULL
wins = [t for t in gz_trades if t.get("isWin") is True or t.get("roiPct", 0) >= 0]
losses = [t for t in gz_trades if t.get("isWin") is False and t.get("roiPct", 0) < 0]

# Rugpulls: losses with ROI <= -30% or exitReason mentioning crash, liquidation, emergency, no route
rugpulls = [t for t in losses if t.get("roiPct", 0) <= -30 or any(k in t.get("exitReason", "").upper() for k in ["CRASH", "EMERGENCY", "BURN", "LIQUIDATION", "NO_ROUTE", "RUG"])]

print(f"\n=======================================================")
print(f"Ringkasan Ground-Zero Trades:")
print(f"  Total Trades : {len(gz_trades)}")
print(f"  Wins         : {len(wins)} ({len(wins)/len(gz_trades)*100:.1f}%)")
print(f"  Losses       : {len(losses)} ({len(losses)/len(gz_trades)*100:.1f}%)")
print(f"  Rugpulls/Catastrophic Losses (ROI <= -30% atau crash): {len(rugpulls)}")
print(f"=======================================================\n")

# Analisis detail rugpulls
rugpull_details = []
for r in rugpulls:
    m = r.get("mint")
    sym = r.get("symbol")
    dur_s = int((r.get("closedAt", 0) - r.get("openedAt", 0)) / 1000)
    roi = r.get("roiPct")
    reason = r.get("exitReason")
    opened_dt = datetime.fromtimestamp(r.get("openedAt")/1000, tz=wib).strftime("%H:%M:%S")
    
    # Periksa aktivitas target di ledger
    evts = mint_ledger.get(m, [])
    target_sells = [e for e in evts if e.get("details", {}).get("signal", {}).get("action") == "sell"]
    target_buys = [e for e in evts if e.get("details", {}).get("signal", {}).get("action") == "buy"]
    
    did_target_sell = len(target_sells) > 0
    target_first_sell_ratio = 0.0
    if did_target_sell:
        first_sell_sig = target_sells[0].get("details", {}).get("signal", {})
        target_first_sell_ratio = first_sell_sig.get("tokenAmount", 0) / (first_sell_sig.get("remainingHolding", 0) + first_sell_sig.get("tokenAmount", 0)) * 100 if (first_sell_sig.get("remainingHolding", 0) + first_sell_sig.get("tokenAmount", 0)) > 0 else 0.0

    rugpull_details.append({
        "symbol": sym,
        "mint": m,
        "time": opened_dt,
        "duration_s": dur_s,
        "roi": roi,
        "reason": reason,
        "did_target_sell": did_target_sell,
        "target_sells_count": len(target_sells),
        "target_first_sell_ratio": target_first_sell_ratio
    })

print(f"{'No':<3} | {'Symbol':<10} | {'Time WIB':<8} | {'Dur(s)':<6} | {'ROI':<8} | {'Target Sell?':<12} | {'Exit Reason'}")
print("-" * 90)
for idx, rd in enumerate(rugpull_details, 1):
    ts_str = f"YES ({rd['target_sells_count']}x)" if rd['did_target_sell'] else "NO (0x)"
    print(f"{idx:<3} | {rd['symbol']:<10} | {rd['time']:<8} | {rd['duration_s']:<6} | {rd['roi']:+6.1f}% | {ts_str:<12} | {rd['reason'][:40]}")

# Hitung statistik rata-rata
if rugpull_details:
    avg_dur = sum(rd["duration_s"] for rd in rugpull_details) / len(rugpull_details)
    no_target_sell_count = sum(1 for rd in rugpull_details if not rd["did_target_sell"])
    print(f"\n📊 Statistik Pola Rugpull:")
    print(f"  1. Rata-rata waktu sampai rugpull/crash : {avg_dur:.1f} detik ({avg_dur/60:.2f} menit)")
    print(f"  2. Rugpull saat target BELUM PERNAH sell (0x sell) : {no_target_sell_count}/{len(rugpull_details)} ({no_target_sell_count/len(rugpull_details)*100:.1f}%)")
    print(f"  3. Rugpull setelah target sell sebagian            : {len(rugpull_details)-no_target_sell_count}/{len(rugpull_details)} ({(len(rugpull_details)-no_target_sell_count)/len(rugpull_details)*100:.1f}%)")
