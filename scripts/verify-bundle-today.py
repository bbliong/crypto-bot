import json
import time
import subprocess
import re
from datetime import datetime, timezone, timedelta
from urllib import request

wib = timezone(timedelta(hours=7))

# 1. Baca journalctl untuk mencari pasangan (Dev Tx Genesis vs Target Whale First Buy)
cmd = ["journalctl", "--user-unit=crypto-bot-wallet-follower.service", "--since=2026-11-08 00:00:00", "--no-pager"]
out = subprocess.check_output(cmd, text=True, errors="ignore")

lines = out.splitlines()

# Cari semua event redeploy / genesis yang berhasil terdeteksi
# Format log:
# 🚀 [DEV-RADAR SUCCESS] DITEMUKAN TOKEN RE-DEPLOY GENERASI 2!
#    Mint Baru : ...
#    Tx Hash   : ...
# ATAU:
# 🚨 [DEV-RADAR TRIGGER] Terdeteksi Pool Baru Lahir dari Dev: ...
#    Tx Genesis   : ...

dev_geneses = {} # mint -> {tx, time_str, sym}
current_mint = None
current_tx = None
current_sym = None

for line in lines:
    if "Mint Baru :" in line:
        current_mint = line.split("Mint Baru :")[1].strip()
    if "Simbol    :" in line:
        current_sym = line.split("Simbol    :")[1].strip()
    if "Tx Hash   :" in line and current_mint:
        tx = line.split("Tx Hash   :")[1].strip()
        if tx and len(tx) > 20:
            dev_geneses[current_mint] = {"tx": tx, "sym": current_sym, "time": line[:15]}
        current_mint = None
        current_sym = None

# Tambahan cari dari: Tx Genesis   : ...
for i, line in enumerate(lines):
    if "Terdeteksi Pool Baru Lahir dari Dev:" in line:
        # ambil 5 baris ke bawah
        m_mint = re.search(r"\[([a-zA-Z0-9]+)\.\.\.\]", line)
        mint_prefix = m_mint.group(1) if m_mint else ""
        for j in range(i+1, min(i+10, len(lines))):
            if "Tx Genesis   :" in lines[j]:
                tx = lines[j].split("Tx Genesis   :")[1].strip()
                if tx and len(tx) > 20:
                    dev_geneses[mint_prefix] = {"tx": tx, "time": line[:15]}
                break

# Cari semua Target Buys
target_buys = []
for line in lines:
    if "[GMGN WS RAW ITEM] Event: buy" in line and "Raw: " in line:
        try:
            raw_str = line.split("Raw: ")[1].strip()
            d = json.loads(raw_str)
            target_buys.append(d)
        except:
            pass

first_target_buys = {}
for tb in target_buys:
    m = tb.get("a")
    if m and m not in first_target_buys:
        first_target_buys[m] = tb

print(f"Total Unique Mints bought by Whale today: {len(first_target_buys)}")
print(f"Total Dev Genesis Txs indexed: {len(dev_geneses)}")

# Query DexScreener dan RPC untuk setiap mint
rpc_url = "https://api.mainnet-beta.solana.com"

def get_tx_slot(sig):
    if not sig: return None
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getTransaction",
        "params": [sig, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}]
    }).encode("utf-8")
    req = request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with request.urlopen(req, timeout=10) as resp:
                res = json.loads(resp.read().decode())
                r = res.get("result")
                if r:
                    return {"slot": r.get("slot"), "blockTime": r.get("blockTime")}
        except:
            time.sleep(0.3)
    return None

results = []
for mint, tb in first_target_buys.items():
    sym = tb.get("bs")
    sol = float(tb.get("qa") or 0)
    whale_tx_sig = tb.get("h")
    whale_ts = tb.get("t")
    
    # Cari genesis tx dev
    dev_info = dev_geneses.get(mint) or dev_geneses.get(mint[:8])
    dev_tx_sig = dev_info["tx"] if dev_info else None
    
    # Ambil via RPC
    whale_rpc = get_tx_slot(whale_tx_sig)
    dev_rpc = get_tx_slot(dev_tx_sig) if dev_tx_sig else None
    
    # DexScreener pairCreatedAt
    dex_created_ms = None
    try:
        url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
        req_ds = request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with request.urlopen(req_ds, timeout=5) as resp_ds:
            ds_data = json.loads(resp_ds.read().decode())
            pairs = ds_data.get("pairs") or []
            if pairs:
                dex_created_ms = pairs[0].get("pairCreatedAt")
    except:
        pass
    
    results.append({
        "sym": sym,
        "mint": mint,
        "sol": sol,
        "whale_tx": whale_tx_sig,
        "dev_tx": dev_tx_sig,
        "whale_rpc": whale_rpc,
        "dev_rpc": dev_rpc,
        "dex_created_ms": dex_created_ms,
        "whale_ts": whale_ts
    })
    time.sleep(0.1)

print("\n=== HASIL ANALISIS DETAIL 28 TOKEN HARI INI ===")
print(f"{'No':<3} | {'Simbol':<12} | {'Whale SOL':<10} | {'Status Slot / Waktu':<35} | {'Selisih Waktu'}")
print("-" * 85)

same_count = 0
delayed_count = 0
unknown_count = 0

for i, r in enumerate(results, 1):
    sym = r["sym"]
    sol = f"{r['sol']:.1f} SOL"
    w_rpc = r["whale_rpc"]
    d_rpc = r["dev_rpc"]
    
    status_str = ""
    diff_str = ""
    
    if w_rpc and d_rpc:
        if w_rpc["slot"] == d_rpc["slot"]:
            same_count += 1
            status_str = "🔥 1 BLOK SAMA (JITO BUNDLE)"
            diff_str = "0 detik (0 ms, Slot sama!)"
        else:
            delayed_count += 1
            diff_sec = w_rpc["blockTime"] - d_rpc["blockTime"]
            slot_diff = w_rpc["slot"] - d_rpc["slot"]
            status_str = f"⏳ TERPISAH BLOK (+{slot_diff} slots)"
            diff_str = f"+{diff_sec} detik"
    elif r["dex_created_ms"] and r["whale_ts"]:
        diff_sec = r["whale_ts"] - (r["dex_created_ms"] / 1000.0)
        if abs(diff_sec) <= 1.0:
            same_count += 1
            status_str = "🔥 1 BLOK SAMA (JITO BUNDLE)"
            diff_str = f"{diff_sec:.1f} detik"
        else:
            delayed_count += 1
            status_str = "⏳ TERPISAH (DELAYED)"
            diff_str = f"+{diff_sec:.1f} detik"
    else:
        unknown_count += 1
        status_str = "❓ UNRESOLVED"
        diff_str = "-"
        
    print(f"{i:<3} | {sym:<12} | {sol:<10} | {status_str:<35} | {diff_str}")

print("\n=== RANGKUMAN AGREGAT ===")
print(f"Total Token Hari Ini : {len(results)}")
print(f"1 Blok Sama (Bundle) : {same_count} token ({same_count/len(results)*100:.1f}%)")
print(f"Terpisah (Delayed)   : {delayed_count} token ({delayed_count/len(results)*100:.1f}%)")
if unknown_count:
    print(f"Belum Ter-index      : {unknown_count} token")
