import json
import glob
from collections import defaultdict
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))

# Load all signals
files = ["/home/bbliong/project/crypto-bot/data/follower-real-ledger.jsonl"]
files += glob.glob("/home/bbliong/project/crypto-bot/data/backup-evaluation-*/*.jsonl")

signals = []
seen_tx = set()
for f in files:
    with open(f) as fp:
        for line in fp:
            if not line.strip(): continue
            try:
                obj = json.loads(line)
                sig = obj.get("details", {}).get("signal")
                if sig and sig.get("txHash") and sig.get("txHash") not in seen_tx:
                    seen_tx.add(sig.get("txHash"))
                    ts = sig.get("timestamp", 0)
                    if ts > 1e11: ts /= 1000
                    sig["timestamp"] = int(ts)
                    signals.append(sig)
            except: pass

signals.sort(key=lambda s: s.get("timestamp", 0))

# Group target buys by token symbol/name
symbols = defaultdict(list)
for s in signals:
    if s.get("action") == "buy":
        sym = (s.get("symbol") or "UNKNOWN").upper().strip()
        m = s.get("mint")
        # only first buy of mint
        if not any(x["mint"] == m for x in symbols[sym]):
            symbols[sym].append({
                "mint": m,
                "tokenName": s.get("tokenName"),
                "timestamp": s.get("timestamp"),
                "time_wib": datetime.fromtimestamp(s.get("timestamp", 0), tz=wib).strftime("%Y-%m-%d %H:%M:%S"),
                "priceUsd": s.get("priceUsd")
            })

# Filter symbols that have >= 2 different mint contracts (Re-Deploy Waves!)
redeploy_chains = {sym: mints for sym, mints in symbols.items() if len(mints) >= 2}

print(f"Total Ticker/Simbol yang Di-ReDeploy Berulang Kali oleh Target: {len(redeploy_chains)} grup token!\n")

# Mari kita periksa dev address untuk setiap pool di setiap grup
# Kita simpan mints to query
sample_chains = ["ascend", "VAUBAN", "Pando", "OMBRO", "VALOR", "Polarbear", "CAPY"]
for sym, mint_list in list(redeploy_chains.items()):
    if sym in ["ASCEND", "VAUBAN", "PANDO", "OMBRO", "VALOR", "POLARBEAR", "CAPY", "AI"]:
        print(f"=========================================================================================")
        print(f"🪙 GRUP TOKEN: {sym} (Total {len(mint_list)} Pool Berurutan)")
        print(f"=========================================================================================")
        for idx, m_info in enumerate(mint_list, 1):
            print(f"  Pool #{idx}: Mint={m_info['mint'][:16]}... | Waktu Target Beli: {m_info['time_wib']} WIB | Harga: ${m_info['priceUsd']:.8f}")
