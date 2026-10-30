import json

with open("/home/bbliong/project/crypto-bot/data/dna-clone-wallets.json") as f:
    wallets = json.load(f)

multi = [w for w in wallets if w.get("hitCount", 1) >= 2]
print(f"Total Multi-Hit Wallets: {len(multi)}")

known_target_cluster = set([
  "3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34",
  "GKsj1yLsufUz8iUKiy1hoMM6PS5cgRS5QQwvtiJzERCF",
  "LqUDbCcDRD1fo4Mp7xYGPuuYpbmaZ5hq3KnXWxFTtJN",
  "CuLeCXCQPM8FxKdGUNqwvPVDGa4do3LwU8iDg8W7jR6o",
  "5WwzkPmveL9NRMQr2F4PzacuSsvWgFyvd5XHKwV5otr9",
  "6Ybi9DDVsJY3yD8gX8uwGALcm5PHxLV3msvdejaGfiSW",
  "DdbLYwpNQYhs28khLE28D8JYyWCL9XkpXzgu1r8estVd",
  "GH74zHdNZWcF9zRzw3KoNG8GNgUvtzokNwkSFMeWTvi6",
  "A3prJre8PiPWY9aPsgq7j4Nf5GFybMtuyL7eoEqjcfGj",
  "9YYKqhELGeKRCRF1M8qkQX33vxgteSNNZTWH1jRXW52F",
  "JBVWmDD5zzvTRjEzSG4H6aGozZiZYVKQadSXqeou87Bu",
  "D2Uf6C5p5UDMykpXSuGL5k3TTPzDXsu9SzMVu6cu42aN",
  "GcfYoBZ36cvjtaY7yfUiBhaBBVpvJ1LkWRtKQRwQY4Xq",
  "72xdpPb3LyVnUVzXLWf3wh1P4F9yMXz1xytTjj8fHuGQ"
])

for w in multi:
    addr = w["address"]
    is_in_cluster = addr in known_target_cluster
    status = "🚨 MATCHED DIRECT TARGET CLUSTER!" if is_in_cluster else "Bukan Direct Seed Cluster (Independen/Klon DNA)"
    print(f"  {addr} (Hit {w['hitCount']}x): {status}")
