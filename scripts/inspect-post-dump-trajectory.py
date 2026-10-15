import json, subprocess, tarfile, os
from datetime import datetime

tokens = {
    'X8cdZQpB': ('Mercedes', 1791927330000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T04-30-00-000-WIB.tar.gz', 1791927280000), # dump ~ 04:34:40
    'dQtqzpM2': ('FOMO', 1791933562000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-00-00-000-WIB.tar.gz', 1791933511000), # dump ~ 06:18:31
    'sYmxtQmj': ('Muse AI', 1791946055000, 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-30-00-000-WIB/token-trades.jsonl', 1791946004000), # dump ~ 09:46:44
    'bRBYoeuq': ('TRALA', 1791943469000, 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-00-00-000-WIB/token-trades.jsonl', 1791943419000), # dump ~ 09:03:39
    'LJsYibsU': ('MarsX', 1791935083000, 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-30-00-000-WIB.tar.gz', 1791935026000), # dump ~ 06:43:46
}

for k, (sym, buy_t, src_type, src_path, dump_t) in tokens.items():
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

    # Trough price right after dump
    post_dump = [t for t in trades if dump_t <= (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) <= dump_t + 120000]
    if not post_dump: continue

    trough_price = min(t.get('price') or t.get('trade',{}).get('price') or 9999 for t in post_dump[:50])

    print(f"\n=== {sym} ({k}) Post-Dump Trajectory (Trough: ${trough_price:.8f}) ===")
    for sec in [45, 50, 55, 60, 65, 70, 75, 80, 90]:
        target_t = dump_t + (sec * 1000)
        near = [t for t in post_dump if abs((t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) - target_t) <= 1000]
        if near:
            p = near[-1].get('price') or near[-1].get('trade',{}).get('price') or 0
            bounce_pct = ((p - trough_price) / trough_price * 100) if trough_price > 0 else 0
            print(f"  +{sec:2d}s post-dump: price=${p:.8f} (Bounce from trough: {bounce_pct:+5.1f}%)")
