import json
import urllib.request
from datetime import datetime, timezone, timedelta

wib = timezone(timedelta(hours=7))
RPC = "https://api.mainnet-beta.solana.com"

with open("/home/bbliong/project/crypto-bot/data/dryrun-3scenarios-live.json") as f:
    d = json.load(f)

trades = d["s4"]["closedTrades"]

print("=" * 115)
print("AUDIT BLOCKTIME SOLANA: KAPAN DEV LAHIRKAN TOKEN vs KAPAN TARGET BELI")
print("=" * 115)
print(f"{'No':<3} | {'Symbol':<8} | {'Genesis Dev Deploy (WIB)':<26} | {'Target First Buy (WIB)':<26} | {'Selisih Waktu':<15} | {'Mint':<16}")
print("-" * 115)

for idx, t in enumerate(reversed(trades), 1):
    mint = t["mint"]
    sym = t["symbol"]
    bot_buy_ms = t["openedAt"]
    target_buy_str = datetime.fromtimestamp(bot_buy_ms/1000, tz=wib).strftime("%H:%M:%S")

    # Ambil genesis tx dari mint via getSignaturesForAddress
    # Cek signature terakhir yang bisa dijangkau
    req = urllib.request.Request(
        RPC,
        data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "getSignaturesForAddress", "params": [mint, {"limit": 1000}]}).encode(),
        headers={"Content-Type": "application/json"}
    )
    dev_deploy_str = "-"
    diff_str = "-"
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            sigs = json.loads(resp.read().decode()).get("result", [])
        if sigs:
            # Cari signature tertua
            genesis_sig = sigs[-1]
            bt = genesis_sig.get("blockTime")
            if bt:
                dev_deploy_str = datetime.fromtimestamp(bt, tz=wib).strftime("%H:%M:%S")
                diff_sec = (bot_buy_ms / 1000) - bt
                if diff_sec >= 0:
                    diff_str = f"+{diff_sec:.0f} detik"
                else:
                    diff_str = f"{diff_sec:.0f} detik"
    except Exception as e:
        dev_deploy_str = f"Err: {str(e)[:15]}"

    print(f"{idx:<3} | {sym:<8} | {dev_deploy_str:<26} | {target_buy_str:<26} | {diff_str:<15} | {mint[:16]}...")
