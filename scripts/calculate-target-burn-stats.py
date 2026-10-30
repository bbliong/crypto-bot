import json, urllib.request, time, sys
from concurrent.futures import ThreadPoolExecutor

with open("/home/bbliong/project/crypto-bot/data/target-atas.json") as f:
    atas = json.load(f)

print(f"Loaded {len(atas)} token ATAs to audit on-chain...")

def analyze_token(item):
    symbol = item["symbol"]
    mint = item["mint"]
    spl_ata = item["splAta"]
    t22_ata = item["t22Ata"]
    
    url = "https://solana-rpc.publicnode.com"
    
    signatures = []
    target_ata = None
    for ata in [spl_ata, t22_ata]:
        d = json.dumps({"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":[ata, {"limit":100}]}).encode()
        req = urllib.request.Request(url, data=d, headers={"Content-Type":"application/json","User-Agent":"Mozilla/5.0"})
        for attempt in range(2):
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    res = json.loads(r.read().decode())
                    sigs = [s["signature"] for s in res.get("result", [])]
                    if sigs:
                        signatures = sigs
                        target_ata = ata
                        break
            except Exception:
                time.sleep(0.2)
        if signatures:
            break
            
    if not signatures:
        return {
            "symbol": symbol,
            "mint": mint,
            "hasTx": False,
            "txCount": 0,
            "bought": 0,
            "sold": 0,
            "burned": 0,
            "pctBurn": 0.0,
            "solNet": 0.0
        }
        
    total_bought_tokens = 0.0
    total_sold_tokens = 0.0
    burn_tokens = 0.0
    sol_in = 0.0
    sol_out = 0.0
    
    for s in signatures:
        d = json.dumps({"jsonrpc":"2.0","id":1,"method":"getTransaction","params":[s, {"maxSupportedTransactionVersion":0}]}).encode()
        req = urllib.request.Request(url, data=d, headers={"Content-Type":"application/json","User-Agent":"Mozilla/5.0"})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    res = json.loads(r.read().decode())
                    meta = res.get("result", {}).get("meta", {})
                    if not meta: break
                    
                    pre = [b for b in meta.get("preTokenBalances", []) if b.get("owner") == "3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34" and b.get("mint") == mint]
                    post = [b for b in meta.get("postTokenBalances", []) if b.get("owner") == "3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34" and b.get("mint") == mint]
                    
                    pre_amt = float(pre[0].get("uiTokenAmount", {}).get("uiAmount") or 0) if pre else 0.0
                    post_amt = float(post[0].get("uiTokenAmount", {}).get("uiAmount") or 0) if post else 0.0
                    diff = post_amt - pre_amt
                    
                    keys = [k.get("pubkey") if isinstance(k, dict) else k for k in res.get("result", {}).get("transaction", {}).get("message", {}).get("accountKeys", [])]
                    if "3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34" in keys:
                        idx = keys.index("3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34")
                        sol_diff = (meta["postBalances"][idx] - meta["preBalances"][idx]) / 1e9
                        if sol_diff < 0: sol_out += abs(sol_diff)
                        else: sol_in += sol_diff
                    
                    logs = " ".join(meta.get("logMessages", []))
                    if "Instruction: Burn" in logs and diff < 0:
                        burn_tokens += abs(diff)
                    elif diff > 0:
                        total_bought_tokens += diff
                    elif diff < 0:
                        total_sold_tokens += abs(diff)
                    break
            except Exception:
                time.sleep(0.3)
                
    unaccounted = max(0.0, total_bought_tokens - total_sold_tokens - burn_tokens)
    total_unrealized_burned = burn_tokens + unaccounted
    
    pct_burn = (total_unrealized_burned / total_bought_tokens * 100.0) if total_bought_tokens > 0 else 0.0
    sol_net = sol_in - sol_out
    
    return {
        "symbol": symbol,
        "mint": mint,
        "hasTx": True,
        "txCount": len(signatures),
        "bought": total_bought_tokens,
        "sold": total_sold_tokens,
        "burned": total_unrealized_burned,
        "pctBurn": pct_burn,
        "solNet": sol_net
    }

print("Running full on-chain audit across all tokens...")
t0 = time.time()
with ThreadPoolExecutor(max_workers=8) as executor:
    results = list(executor.map(analyze_token, atas))

print(f"Audit completed in {time.time()-t0:.1f}s")

with open("/home/bbliong/project/crypto-bot/data/target-burn-audit.json", "w") as f:
    json.dump(results, f, indent=2)

valid = [r for r in results if r["hasTx"] and r["bought"] > 0]
print(f"Total tokens with target trade activity: {len(valid)}")

clean = [r for r in valid if r["pctBurn"] <= 1.0] # <= 1% considered clean / dust
burned = [r for r in valid if r["pctBurn"] > 1.0]

avg_burn_all = sum(r["pctBurn"] for r in valid) / len(valid) if valid else 0
avg_burn_when_burned = sum(r["pctBurn"] for r in burned) / len(burned) if burned else 0

print(f"\n================ HASIL AUDIT ON-CHAIN SISA BURN TARGET ================")
print(f"1. Total Token yang Ditradingkan Target : {len(valid)} token")
print(f"2. Token Exit Bersih / Sisa 0%          : {len(clean)} token ({len(clean)/len(valid)*100:.1f}%)")
print(f"3. Token dengan Sisa Burn (>1%)         : {len(burned)} token ({len(burned)/len(valid)*100:.1f}%)")
print(f"4. RATA-RATA SISA BURN KESELURUHAN (ALL): {avg_burn_all:.2f}%")
print(f"5. Rata-Rata Sisa Burn Saat Token Rug   : {avg_burn_when_burned:.2f}%")
print(f"======================================================================\n")

# Print top tokens with burn
print("Daftar Token yang Memiliki Sisa Burn / Hangus:")
burned.sort(key=lambda r: r["pctBurn"], reverse=True)
for i, b in enumerate(burned):
    print(f"{i+1}. [{b['symbol']}] Mint: {b['mint'][:10]}... | Beli: {b['bought']:,.0f} | Jual: {b['sold']:,.0f} | Burn: {b['burned']:,.0f} ({b['pctBurn']:.1f}%) | Net SOL: {b['solNet']:+.4f} SOL")
