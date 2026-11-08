import subprocess
import json

cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 12:00:00", "--until=2026-11-08 13:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

coin_events = []
for line in out.splitlines():
    if "BUxR9iBgtbt19tSfNdwP7epsGNDCrJBdcdyEMn71Y5iJ" in line and "[GMGN WS RAW ITEM]" in line:
        try:
            ev_type = "buy" if "Event: buy" in line else "sell"
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            coin_events.append({
                "type": ev_type,
                "ts": int(d.get("t")),
                "usd": float(d.get("au") or 0),
                "sol": float(d.get("qa") or 0),
                "price": float(d.get("pu") or 0),
                "sell_ratio": float(d.get("bu") or 0),
                "remaining": float(d.get("b") or 0)
            })
        except:
            pass

coin_events.sort(key=lambda x: x["ts"])
print(f"Total events Coin 5: {len(coin_events)}")

# Simulasi Strategi Ping-Pong Multi-Cycle:
# Aturan:
# 1. Mulai aktif setelah initial pump stabil (misal pasca detik 20s)
# 2. Masuk saat Whale SELL (dip)
# 3. Keluar saat Whale BUY (pump) dengan target profit +10% s/d +15%
# 4. Ulangi siklus selama whale masih aktif pingpong

cycles = []
holding = False
entry_price = 0
entry_ts = 0
stake = 5.0 # misal modal $5

for i in range(1, len(coin_events)):
    e = coin_events[i]
    if not holding:
        # Beli saat Whale SELL (menampung di harga diskon)
        if e["type"] == "sell" and e["price"] > 0:
            holding = True
            entry_price = e["price"]
            entry_ts = e["ts"]
    else:
        # Tahan dan cari exit saat Whale BUY atau saat harga sudah naik >= +10%
        gain = ((e["price"] - entry_price) / entry_price) * 100
        elapsed = e["ts"] - entry_ts
        
        # Take profit jika gain >= 10% ATAU jika whale BUY dengan gain positif
        if gain >= 10.0 or (e["type"] == "buy" and gain >= 5.0) or elapsed >= 60:
            net_pnl = stake * (gain / 100.0) - 0.05 # dipotong fee roundtrip $0.05
            cycles.append({
                "cycle": len(cycles) + 1,
                "entry_p": entry_price,
                "exit_p": e["price"],
                "gain_pct": gain,
                "hold_sec": elapsed,
                "net_pnl": net_pnl,
                "exit_trigger": "TP_10%" if gain >= 10 else ("BUYBACK_POP" if e["type"] == "buy" else "TIMEOUT_60S")
            })
            holding = False
            # batasi maks 10 siklus
            if len(cycles) >= 10: break

print("\n=== HASIL SIMULASI 10 SIKLUS PING-PONG PADA KOIN COIN 5 ===")
print(f"{'Siklus':<8} | {'Harga Entry':<18} | {'Harga Exit':<18} | {'Gain %':<10} | {'Durasi':<8} | {'Net PnL ($5)':<14} | {'Exit Trigger'}")
print("-" * 100)

tot_pnl = 0
for c in cycles:
    tot_pnl += c["net_pnl"]
    print(f"Cycle #{c['cycle']:<2} | ${c['entry_p']:.8f}      | ${c['exit_p']:.8f}     | {c['gain_pct']:>+6.1f}%   | {c['hold_sec']:>3}s    | ${c['net_pnl']:>+6.2f}       | {c['exit_trigger']}")

print("-" * 100)
print(f"Total Cuan dari 10 Siklus Ping-Pong (Modal $5): +${tot_pnl:.2f} USD")
