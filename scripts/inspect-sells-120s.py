import json, subprocess, tarfile, os
from datetime import datetime

tokens = {
    'oMwi1TXU': ('FOMO', 1791910283000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-13T23-30-00-000-WIB.tar.gz'),
    'X8cdZQpB': ('Mercedes', 1791927330000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T04-30-00-000-WIB.tar.gz'),
    'dQtqzpM2': ('FOMO', 1791933562000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-00-00-000-WIB.tar.gz'),
    'LJsYibsU': ('MarsX', 1791935083000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-30-00-000-WIB.tar.gz'),
    'sTCGTLUC': ('SHH', 1791936684000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T07-00-00-000-WIB.tar.gz'),
    'Rfbbs4Dz': ('MarsX', 1791937557000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T07-00-00-000-WIB.tar.gz'),
    'YAp9iyhe': ('Samsung', 1791941901000, 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T08-30-00-000-WIB/token-trades.jsonl'),
    'bRBYoeuq': ('TRALA', 1791943469000, 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-00-00-000-WIB/token-trades.jsonl'),
    'sYmxtQmj': ('Muse AI', 1791946055000, 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-30-00-000-WIB/token-trades.jsonl'),
}

for k, (sym, buy_t, src_type, src_path) in tokens.items():
    trades = []
    if src_type == 's3':
        cmd = ['aws', '--profile', 'do-tor1', 's3', 'cp', f's3://missi/{src_path}', '-']
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with tarfile.open(fileobj=proc.stdout, mode='r|gz') as tar:
            for member in tar:
                if member.name.endswith('token-trades.jsonl'):
                    f = tar.extractfile(member)
                    if f:
                        for line in f:
                            if k.encode() in line:
                                trades.append(json.loads(line))
        proc.terminate()
    else:
        with open(src_path) as f:
            for line in f:
                if k in line:
                    trades.append(json.loads(line))

    trades.sort(key=lambda t: t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000))

    # Look at all sells > $50 in 120s before buy
    sells_120s = [t for t in trades if buy_t - 120000 <= (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) <= buy_t and (t.get('side') == 'sell' or t.get('trade',{}).get('side') == 'sell') and (t.get('usd') or t.get('trade',{}).get('usd') or 0) >= 50]

    b_str = datetime.fromtimestamp(buy_t/1000).strftime('%H:%M:%S')
    print(f"\n=== {sym} ({k}) Buy @ {b_str} | Sells >= $50 in 120s ({len(sells_120s)}) ===")
    for s in sells_120s:
        ts = s.get('at') or s.get('observedAt') or (s.get('timestamp',0)*1000)
        dt = (buy_t - ts) / 1000
        usd = s.get('usd') or s.get('trade',{}).get('usd') or 0
        w = (s.get('wallet') or s.get('trade',{}).get('wallet') or '')[:8]
        print(f"  [-{dt:5.1f}s ago] SELL ${usd:8.2f} | wallet: {w}")
