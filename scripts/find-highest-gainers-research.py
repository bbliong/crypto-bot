import glob
import json
import os

BASE_DIR = '/home/bbliong/project/crypto-bot/research'

results = []
for p in glob.glob(os.path.join(BASE_DIR, '**/trades.jsonl'), recursive=True):
    mints = {}
    with open(p) as f:
        for line in f:
            if not line.strip(): continue
            try:
                t = json.loads(line)
                m = t.get('mint')
                price = float(t.get('priceUsd', 0))
                if m and price > 0:
                    if m not in mints:
                        mints[m] = {'min_p': price, 'max_p': price, 'first_p': price, 'last_p': price, 'count': 0}
                    mints[m]['min_p'] = min(mints[m]['min_p'], price)
                    mints[m]['max_p'] = max(mints[m]['max_p'], price)
                    mints[m]['last_p'] = price
                    mints[m]['count'] += 1
            except: pass
    for m, d in mints.items():
        gain = d['max_p'] / d['first_p'] if d['first_p'] > 0 else 1.0
        results.append((gain, m, d, p))

results.sort(key=lambda x: x[0], reverse=True)
print("Top 20 highest gainers in research:")
for g, m, d, p in results[:20]:
    dir_name = p.split('/')[-2]
    print(f"Gain: {g:,.1f}x | Mint: {m} | First: ${d['first_p']:.10f} | Max: ${d['max_p']:.8f} | Trades: {d['count']} | Dir: {dir_name}")
