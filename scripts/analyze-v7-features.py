import glob, json, subprocess, tarfile, os
from datetime import datetime

# Mints to test
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

# Get buy times from state
import urllib.request
state = json.loads(urllib.request.urlopen('http://127.0.0.1:4178/api/state').read().decode())
positions = state.get('positions', [])

buy_times = {}
for p in positions:
    if p.get('laneLabel') == 'V6' and p.get('entryAt'):
        for k in tokens:
            if p['mint'].startswith(k):
                buy_times[k] = p['entryAt']

print(f"{'Symbol':10s} | {'Mint':8s} | {'Status':4s} | {'Buy Time':19s} | {'Trades 5s':9s} | {'Micro 5s':8s} | {'Micro %':7s} | {'Whale Gap':10s}")
print("-" * 90)

for k, (sym, stat, src_type, src_path) in tokens.items():
    b_at = buy_times.get(k)
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

    # Sort trades
    trades.sort(key=lambda t: t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000))

    # Analyze trades around buy time
    t_str = datetime.fromtimestamp(b_at/1000).strftime('%Y-%m-%d %H:%M:%S') if b_at else 'N/A'
    
    # 5s before buy
    trades_5s = [t for t in trades if b_at - 5000 <= (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) <= b_at]
    micro_5s = [t for t in trades_5s if (t.get('usd') or (t.get('trade',{}).get('usd')) or 0) < 1.0]
    micro_pct = (len(micro_5s) / len(trades_5s) * 100) if trades_5s else 0

    # Whale sells before buy (>= $150 USD)
    sells_before = [t for t in trades if (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) < b_at and (t.get('side') == 'sell' or t.get('trade',{}).get('side') == 'sell')]
    whale_sells = [t for t in sells_before if (t.get('usd') or t.get('trade',{}).get('usd') or 0) >= 150]
    
    if whale_sells:
        last_whale_t = max(t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000) for t in whale_sells)
        whale_gap_s = (b_at - last_whale_t) / 1000
        whale_gap_str = f"{whale_gap_s:.1f}s ago"
    else:
        whale_gap_str = "None"

    print(f"{sym:10s} | {k:8s} | {stat:4s} | {t_str} | {len(trades_5s):9d} | {len(micro_5s):8d} | {micro_pct:6.1f}% | {whale_gap_str:10s}")
