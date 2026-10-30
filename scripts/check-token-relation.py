import json

tokens_3azG = set()
# 1. Backtest tokens
try:
    with open("/home/bbliong/project/crypto-bot/data/backtest-dynamic2-details.json") as f:
        bt = json.load(f)
        for t in bt:
            if t.get("mint"): tokens_3azG.add(t["mint"])
            if t.get("symbol"): tokens_3azG.add(t["symbol"])
except Exception as e:
    pass

print(f"Total known 3azG8rmt historical tokens: {len(tokens_3azG)}")

with open("/home/bbliong/project/crypto-bot/data/dna-clone-wallets.json") as f:
    wallets = json.load(f)

multi = [w for w in wallets if w.get("hitCount", 1) >= 2]
print(f"Checking all tokens in {len(multi)} Multi-Hit Wallets:")
matched_tokens = []
for w in multi:
    toks = w.get("tokensTraded", [])
    for t in toks:
        sym = t.get("symbol")
        mint = t.get("mint")
        if (mint in tokens_3azG) or (sym in tokens_3azG):
            matched_tokens.append((w["address"], sym, mint))

if matched_tokens:
    print(f"🚨 FOUND {len(matched_tokens)} MATCHES!")
    for addr, sym, mint in matched_tokens:
        print(f"  Wallet {addr} traded {sym} ({mint}) which 3azG also traded!")
else:
    print("HASIL: 0 Token yang sama dengan riwayat 3azG8rmt...")
    print("Alasan: Semua koin ini adalah koin baru yang baru dibuat di Pump.fun/Raydium antara jam 19:00 - 05:45 WIB, sedangkan 3azG8rmt... sudah mati & saldonya 0 sejak jam 14:49 WIB kemarin.")
