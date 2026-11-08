import json
import time
from datetime import datetime, timezone, timedelta
from urllib import request

wib = timezone(timedelta(hours=7))

# Data 28 koin hari ini
with open("/home/bbliong/project/crypto-bot/scripts/find-today-target-buys.py") as f:
    pass

tokens_today = [
    {"sym": "HERO", "mint": "CXSNwE97iCWfV9hdN55Xbp9kbHCGkupmEaDkMeym8Gk2", "whale_tx": "517UWMQQ8MSZ6VNQCq64CcmKDYzeChMazjWE4aP9mXnGDza4WDsnj3goWxmqyaagKrPrPMpgc1zwvy1LXnCD1mm3", "sol": 30},
    {"sym": "GOOBLO #1", "mint": "2zZB6AVPPsf4AvMtR42WC6LdCxe2EKNep8h1qmj9Dx7B", "whale_tx": "2NSouoFhBxLMJ5LkVys1iK13tcG8dnbKnA234JjZRTYxK8g7jTDaE8HTX3rLQSAjRGN1UAkHtusKW8AUVdAUPrZW", "sol": 30},
    {"sym": "GOOBLO #2", "mint": "1MvbBD6QvDACqG2tkjzT8tsahMWHcog4rMbrFrBxpvp", "whale_tx": "5f4asWvKrtejaQLYbmKUNDmSAqJ8JQCWGHm3J2gfvjBhbSqGbgnEEwJ8cUkrfMMujg2mWX6HZxL2hJym7BpoDSbm", "sol": 30},
    {"sym": "HIGHCAP", "mint": "HEwbHSRbZsLAnzCYcu8ahFgExLPP6qbSCd9cjpkAa4h5", "whale_tx": "AjV1Khy52NM3p9KM2Ecm11UkX1afWompjjTh2fXvAgm3mnmAHfcjZNXv1J4uNBxY6MTU3FtrveRLU82GoTKcMQm", "sol": 0.12},
    {"sym": "MAGGIE #1", "mint": "J93j7nDgyRqqkJkY2rx9ETsPkYTFXGdWTUAwoEk14cgS", "whale_tx": "26PETSx6MgiRG57w9xXMayqLu5HpdKpoLuAZmCpFXE7aYrBr8uvRfNDpJ1Rgte9VdMqvhQs1up5jwqPHqfdxojiu", "sol": 30},
    {"sym": "Tungmas #1", "mint": "FLiWCNE6PTMRdgU3kPwj4mzkKxG2bT8DKkXXmzRiXxNN", "whale_tx": "4pGapABcUJT6eaXGgsNkvCuHz9pTJGDajkZqW1jKT2wnkGVRu53qUQLVpFfjbRocRd4Ew3HWh1nQMdSvwFXnuYLj", "sol": 30},
    {"sym": "Tungmas #2", "mint": "FLySL9M8Wr3f5yGmZc58BY2gEkZqjTJ2rG7CYQCAHaR3", "whale_tx": "5UjVqMsmVjqWKGAKGXaFfQe2k7iJ2JGKY59kTb7iy3hQHr8fYeeuEfqa4anoRy9yg3euK24PC9Dyh7PAydukGK9o", "sol": 30},
    {"sym": "EVE #1", "mint": "4vtUt744p2W2YaqmPNExJJtsrQ3zBccC865GXuC4PWAN", "whale_tx": "2zNwwk2QNJxQnv1vHPFromLMEukYoSTmeytD9h3MDjajHVo7VB4ybDdd98iBiohswoMVohQjJhny4Wp5Z9ZdL1DJ", "sol": 30},
    {"sym": "EVE #2", "mint": "CmQhTEkditvCaYdeE1fMvZXJ8oxdMp7CYjUifpxaD6Em", "whale_tx": "h9w919N3JHvGGW5f6qhWfZb7J4p1JH2ZoqfTnnuCmn2B2xmyD8k3BSUQKLJ5fknhwxBSqpMuHbacTV511BJSuVb", "sol": 30},
    {"sym": "MAGGIE #2", "mint": "2diQ2tb4UFbJKrWkyNqyueQftXZYArA7xr1ivkdz3jjk", "whale_tx": "4cv9TkA2crm3n23ZXRyNaPsWYjZ5R5vq2tzDarGPwBf6iXyRUCQXsK5w737rsnVM25DRMWWUZ2BXLo7Xci5nmqsC", "sol": 30},
    {"sym": "HABIBI #1", "mint": "H6Xnza2agvBWACPJqskapvoW8NA4afTKjjWmujgdSFYd", "whale_tx": "4mCW3zm6XQ2rjxw7vpdD6dRRLEPVLxEypqwXuAZrzQsrZCokdU8wiknsYcHPF8BMJ95MtvQ6QioAe478ShZREaBV", "sol": 30},
    {"sym": "HABIBI #2", "mint": "AfXWK9zxJ2v8cUT48QKi21LtPDGZJURzbVDeRTgomAg7", "whale_tx": "34wtz9uzfC7m8H5kdHmmLoTb4k7Jy7r23ZKgifWCtywVZ3VPinwTSjKdScjdt2ZWoj5NbwDXJkNHeVrF1eKNmMaC", "sol": 30},
    {"sym": "HABIBI #3", "mint": "8qp1iXmnJyZ1wdfJCdKvmrWLkdw7Smk9HrntmMUb5ZJS", "whale_tx": "3S84k3Pv6k7iD1F56KkcTjE3NKXFKQC4ACiYA2D2z2XuZavdvCP41W3GE9Y2PtSocX62SZg7kiPYnTe7MdzWiSjb", "sol": 30},
    {"sym": "HABIBI #4", "mint": "6fu8GGkZjnJo7FL5RzNCxzrCJ7JVyuVBU9wYPDmtF7Qo", "whale_tx": "4JcJbMpws5sJ9gEhXAxQwZ5kNWsQPV1yfK2sG8KngHmQuadD5fV3BtNSG8YojLfU6XuGeT6cSePMw8V3Q2eDBXot", "sol": 30},
    {"sym": "MAGGIE #3", "mint": "4GcJCBpwcYGzrYcDg2F2nRiF1e6TNufWb99Q5bGtgX3z", "whale_tx": "cnRDVyWnFZjSAnaCoSJ8wHFffGghwjiF4y9a564x1mddnczdZJL7xojkqrV28qaEEGjCQyRKK6sKfEpH38s4Vxm", "sol": 30},
    {"sym": "MAGGIE #4", "mint": "BPoC6xbSUXHxa6t8YLoCVumBxE6nNusLsziBiZazA1hg", "whale_tx": "36f3XeoHnM73YxXv23vvx2muv9ZLiUffAQvZRjKbQ6jPQFBBMCi2Y2GCR4cdeKUfu52Nsxm4W4RDRkjMDSbf1LLp", "sol": 30},
    {"sym": "SATORI", "mint": "EVi9zRqrvJZNo9ezTtY8CJavgKTqUvCoDSExUYvrgTep", "whale_tx": "3pWUsPwKVYQAGMWGbVmYqEqsgW6TN3sXwCSzD7hRs4p4cn5GQB5Ku2AAGRytYr1RzyDHGyhaNjgDGVaCDnYy9GRN", "sol": 30},
    {"sym": "ber", "mint": "tQMys1MvcTctAZHgGct5XeoKe8vQ9HpUP1hrLewdM1w", "whale_tx": "3ep3uiDCvU4Jd1syEJRv5Lw9FMsLxqN6nSyH4bJLidCNt9KgTUPAg4TGTuqWDj7FdnGdCqmPQaVpvAdVfD6WjjCW", "sol": 1.33},
    {"sym": "Slingpad", "mint": "3w3CLR1HA2seQZvZDp3qz7D8pjEwK2jnpw5e1kj9mEce", "whale_tx": "4ZkvvcXmrETM6bX9ohVs48KZiwxW1sTDJLfwyxJmscqSuMF67zsk8hb6VGcoK74pyyemH9avmUPnNRTEUWEkqB7n", "sol": 1.33},
    {"sym": "onkey #1", "mint": "2rcSscT6qRZ64kHQmJYU9zW5eW8rDAvRNc6MDve9LNui", "whale_tx": "4CTTH5xZHbNjNXik7pC5o72YeEtwLzyPUj1L6FeD9bJpAGEde2ENSbsmhguwZqSQgfNGuQae3gqYmfNVPaTa4Ehb", "sol": 1.7},
    {"sym": "onkey #2", "mint": "BTiszBHrDzNjn99XJPXHhzhbLyMP2t6jQW874V5egpGe", "whale_tx": "2uxX9hNXZo9pBDZf9aBKJGzXNtKXGshyhRVdy6sqwtCKoaxZmVEfDDM5ikNMsSFwRRMassMBvHV7ctVXMyQKh3gq", "sol": 30},
    {"sym": "Cоin #1", "mint": "J8ocRXBPFPNFhvnSf1rEXmwjZsDY2PghKaKeQPChB63S", "whale_tx": "Dm3U4c3SjrgQW4iFcv7dLeVVoiRjXtUfwodQEfjgabN98WK6eX5BYpwxY4o1veiT82DGxLJ5VadPxAST9v4yNEJ", "sol": 30},
    {"sym": "Cоin #2", "mint": "Gasfp1vsTVQUcjT7tJCrrj8wd5bakCvVV4jmo15cZtLm", "whale_tx": "3boTq9waT8fcRY7DwEihGXcDoAwEh5nCsp2ejGC5hqg5ZfzfvVF9KKk71ro4os2Kx1KMMVgx9bgZYozeiEMDuoQz", "sol": 30},
    {"sym": "Cоin #3", "mint": "5rwcmxREeahxm3BpZKkRfctFSpcBoEv4ioWeaqHeMaxK", "whale_tx": "2NENYi39n6AvqneXTAnzDp1fsiEdXVGy8mb24PmmBgFhR7hFoDmNegxTLR4rNh3zrjHUnnCrxuysQ7neuvtFre1m", "sol": 30},
    {"sym": "Cоin #4", "mint": "Eeij4rYKqqDK8sFowJmMQB3uCTjJ5PNzxeEkUdHEYoie", "whale_tx": "2rVmTpmFrV1FPCwc3x9uVqCWfkk3xERXn4mTXXjqq5kFVvFhw5RunQGEyPUQo1y9QmaYFgqyVB4HQ5WWEhGnCoKD", "sol": 30},
    {"sym": "Cоin #5", "mint": "BUxR9iBgtbt19tSfNdwP7epsGNDCrJBdcdyEMn71Y5iJ", "whale_tx": "5M9nmQTNeYgLFnoFQSdms1Swj3rZqDRBbcdXRakEpRd4vAqJvVK3keN2UZfLPWJkAiG3HNSpeH1NcFJqQ6tVb4Nf", "sol": 30},
    {"sym": "MARS #1", "mint": "8R8a1QfHvcWXeuz2EXfqaL9YqJZswzCtRGu2pYPbSJB2", "whale_tx": "2DpcXXgh9u7GNq4MmmCD7XHgMETCHrEsNmkKewmVffqBZnDvhv93JsdRqa1NpGM28WuV5WG7hkQRNyCn36ocLCrz", "sol": 30},
    {"sym": "MARS #2", "mint": "CkBHcVyT1gFcKgX65nn1QLjETzSEzdimNFKp1dAYK8qp", "whale_tx": "2bTjg6CCDoihMTvH7u99yy4VJaR1RkPDrNtq4g7AedKR4jCvxVVyrMDjvRJsdnQ4YMfhuSd4Bi7fTVhArh8fNc3U", "sol": 0.42}
]

rpc_url = "https://api.mainnet-beta.solana.com"

def rpc_call(method, params):
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode("utf-8")
    req = request.Request(rpc_url, data=payload, headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"})
    for attempt in range(4):
        try:
            with request.urlopen(req, timeout=10) as resp:
                res = json.loads(resp.read().decode())
                return res.get("result")
        except Exception as e:
            time.sleep(0.5 * (attempt + 1))
    return None

results = []

print(f"Menganalisis {len(tokens_today)} koin dari jam 00:00 WIB hari ini via Solana RPC...")

for idx, item in enumerate(tokens_today, 1):
    mint = item["mint"]
    sym = item["sym"]
    whale_tx_sig = item["whale_tx"]
    sol_amt = item["sol"]
    
    # 1. Ambil transaksi genesis (tertua) dari mint
    sigs = rpc_call("getSignaturesForAddress", [mint, {"limit": 1000}])
    if not sigs:
        print(f"[{idx}/{len(tokens_today)}] {sym:<12}: Gagal ambil signatures")
        continue
    
    genesis_sig = sigs[-1]["signature"]
    
    # 2. Ambil detail Genesis Tx dan Whale Tx
    # Batch atau single
    gen_tx = rpc_call("getTransaction", [genesis_sig, {"maxSupportedTransactionVersion": 0}])
    whale_tx = rpc_call("getTransaction", [whale_tx_sig, {"maxSupportedTransactionVersion": 0}])
    
    if not gen_tx or not whale_tx:
        print(f"[{idx}/{len(tokens_today)}] {sym:<12}: Gagal ambil tx detail")
        continue
    
    gen_slot = gen_tx.get("slot")
    gen_time = gen_tx.get("blockTime")
    whale_slot = whale_tx.get("slot")
    whale_time = whale_tx.get("blockTime")
    
    is_exact_same = (gen_slot == whale_slot)
    slot_diff = (whale_slot - gen_slot) if (whale_slot and gen_slot) else 0
    time_diff_sec = (whale_time - gen_time) if (whale_time and gen_time) else 0
    
    results.append({
        "sym": sym,
        "mint": mint,
        "sol": sol_amt,
        "is_same": is_exact_same,
        "slot_diff": slot_diff,
        "time_diff_sec": time_diff_sec,
        "gen_time_wib": datetime.fromtimestamp(gen_time, tz=wib).strftime("%H:%M:%S") if gen_time else "-",
        "whale_time_wib": datetime.fromtimestamp(whale_time, tz=wib).strftime("%H:%M:%S") if whale_time else "-",
        "gen_slot": gen_slot,
        "whale_slot": whale_slot
    })
    
    status_str = "🔥 SAMA PERSIS (JITO BUNDLE / 0s)" if is_exact_same else f"⏳ DELAY ({time_diff_sec}s / +{slot_diff} slots)"
    print(f"[{idx}/{len(tokens_today)}] {sym:<12} ({sol_amt:>4} SOL) | {status_str} | Dev: {results[-1]['gen_time_wib']} | Whale: {results[-1]['whale_time_wib']}")
    time.sleep(0.1)

# Simpan hasil analisis
with open("/home/bbliong/project/crypto-bot/data/analysis-today-bundle-vs-delayed.json", "w") as f:
    json.dump(results, f, indent=2)

print("\nSelesai! Menganalisis agregat...")
