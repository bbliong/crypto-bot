import json
import time
from urllib import request

rpc_url = "https://api.mainnet-beta.solana.com"

def get_parsed_tx(sig):
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getParsedTransaction",
        "params": [sig, {"maxSupportedTransactionVersion": 0}]
    }).encode("utf-8")
    req = request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with request.urlopen(req, timeout=10) as resp:
                res = json.loads(resp.read().decode())
                if "result" in res and res["result"]:
                    return res["result"]
        except Exception:
            time.sleep(0.3)
    return None

def get_signatures_for_address(addr):
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getSignaturesForAddress",
        "params": [addr, {"limit": 100}]
    }).encode("utf-8")
    req = request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with request.urlopen(req, timeout=10) as resp:
                res = json.loads(resp.read().decode())
                return res.get("result", [])
        except Exception:
            time.sleep(0.3)
    return []

# Test with HABIBI and Coin
for sym, mint, whale_tx in [
    ("HABIBI", "6fu8GGkZjnJo7FL5RzNCxzrCJ7JVyuVBU9wYPDmtF7Qo", "4mCW3zm6XQ2rjxw7vpdD6dRRLEPVLxEypqwXuAZrzQsrZCokdU8wiknsYcHPF8BMJ95MtvQ6QioAe478ShZREaBV"),
    ("Coin", "BUxR9iBgtbt19tSfNdwP7epsGNDCrJBdcdyEMn71Y5iJ", "5M9nmQTNeYgLFnoFQSdms1Swj3rZqDRBbcdXRakEpRd4vAqJvVK3keN2UZfLPWJkAiG3HNSpeH1NcFJqQ6tVb4Nf")
]:
    sigs = get_signatures_for_address(mint)
    oldest_sig = sigs[-1]["signature"] if sigs else ""
    tx_dev = get_parsed_tx(oldest_sig)
    tx_whale = get_parsed_tx(whale_tx)
    print(sym, "Dev slot:", tx_dev.get("slot") if tx_dev else None, "Whale slot:", tx_whale.get("slot") if tx_whale else None)
