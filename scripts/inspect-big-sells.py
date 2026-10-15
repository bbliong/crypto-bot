import json, subprocess, tarfile, os
from datetime import datetime

tokens = {
    'oMwi1TXU': ('FOMO', 'WIN', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-13T23-30-00-000-WIB.tar.gz'),
    'X8cdZQpB': ('Mercedes', 'WIN', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T04-30-00-000-WIB.tar.gz'),
    'dQtqzpM2': ('FOMO', 'WIN', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-00-00-000-WIB.tar.gz'),
    'LJsYibsU': ('MarsX', 'LOSS', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-30-00-000-WIB.tar.gz'),
    'sTCGTLUC': ('SHH', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T07-00-00-000-WIB/token-trades.jsonl'),
    'Rfbbs4Dz': ('MarsX', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T07-00-00-000-WIB/token-trades.jsonl'),
    'YAp9iyhe': ('Samsung', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T08-30-00-000-WIB/token-trades.jsonl'),
    'bRBYoeuq': ('TRALA', 'LOSS', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-00-00-000-WIB/token-trades.jsonl'),
    'sYmxtQmj': ('Muse AI', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-30-00-000-WIB/token-trades.jsonl'),
}

# Inspect all whale sells before buy for each token:
for k, (sym, stat, src_type, src_path) in tokens.items():
    trades = []
    if src_type == 's3':
        cmd = ["aws", "--profile", "do-tor1", "s3", "cp", f"s3://missi/{src_path}", "-"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        with tarfile.open(fileobj=proc.stdout, mode="r|gz") as tar:
            for member in tar:
                if member.name.endswith("token-trades.jsonl"):
                    f = tar.extractfile(member)
                    if f:
                        for line in f:
                            if k.encode() in line:
                                trades.append(json.loads(line))
        proc.terminate()
    else:
        if os.path.exists(src_path):
            with open(src_path) as f:
                for line in f:
                    if k in line:
                        trades.append(json.loads(line))

    trades.sort(key=lambda t: t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000))
    
    # Sells with usd >= 100
    big_sells = [t for t in trades if (t.get('side') == 'sell' or t.get('trade',{}).get('side') == 'sell') and (t.get('usd') or t.get('trade',{}).get('usd') or 0) >= 100]
    
    print(f"\n=== {sym} ({k}) [{stat}] : Total big sells >= $100: {len(big_sells)} ===")
    for s in big_sells[:5]:
        ts = s.get('at') or s.get('observedAt') or (s.get('timestamp',0)*1000)
        t_str = datetime.fromtimestamp(ts/1000).strftime('%H:%M:%S')
        usd = s.get('usd') or s.get('trade',{}).get('usd') or 0
        w = (s.get('wallet') or s.get('trade',{}).get('wallet') or '')[:8]
        print(f"   [{t_str}] SELL ${usd:,.2f} | wallet: {w}")
