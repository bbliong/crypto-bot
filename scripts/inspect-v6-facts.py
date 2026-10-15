import urllib.request, json

url = 'http://127.0.0.1:4178/api/state'
data = json.loads(urllib.request.urlopen(url).read().decode())

executed_mints = [
    ('FOMO', 'oMwi1TXU'),
    ('Mercedes', 'X8cdZQpB'),
    ('FOMO', 'dQtqzpM2'),
    ('MarsX', 'LJsYibsU'),
    ('SHH', 'sTCGTLUC'),
    ('MarsX', 'Rfbbs4Dz'),
    ('Samsung', 'YAp9iyhe'),
    ('TRALA', 'bRBYoeuq'),
    ('Muse AI', 'sYmxtQmj')
]

for sym, m_prefix in executed_mints:
    for p in data.get('positions', []):
        if p.get('laneLabel') == 'V6' and p.get('mint', '').startswith(m_prefix):
            f = p.get('facts', {})
            ret = p.get('netReturnPercent', 0)
            dd = f.get('drawdownPercent') or 0
            bc = f.get('bounceFromTroughPercent') or 0
            bs = f.get('buyShareUsdPercent') or 0
            mb = f.get('meaningfulBuyers') or 0
            mu = f.get('meaningfulBuyUsd') or 0
            dev = f.get('devHoldingSharePercent') or 0
            ls = f.get('largestSellUsd') or 0
            print(f"=== {sym:10s} ({m_prefix}) [Return: {ret:+6.2f}%] ===")
            print(f"  drawdown: {dd:.2f}% | bounce: {bc:.2f}%")
            print(f"  buyShare: {bs:.1f}% | meaningfulBuyers: {mb} | meaningfulBuyUsd: ${mu:.2f}")
            print(f"  devHoldingShare: {dev:.2f}% | largestSell: ${ls:.2f}")
