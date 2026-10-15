import json, subprocess, tarfile, os
from datetime import datetime

tokens = {
    'oMwi1TXU': ('FOMO', 'WIN', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-13T23-30-00-000-WIB.tar.gz', 'DejDvfsu', 1791910283000),
    'X8cdZQpB': ('Mercedes', 'WIN', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T04-30-00-000-WIB.tar.gz', 'HfzLyTvZ', 1791927330000),
    'dQtqzpM2': ('FOMO', 'WIN', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-00-00-000-WIB.tar.gz', 'HfzLyTvZ', 1791933562000),
    'LJsYibsU': ('MarsX', 'LOSS', 's3', 'crypto/profit4-chunks/2026-10-13T16-35-27-642Z/2026-10-14T06-30-00-000-WIB.tar.gz', 'HfzLyTvZ', 1791935083000),
    'sTCGTLUC': ('SHH', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T07-00-00-000-WIB/token-trades.jsonl', None, 1791936684000),
    'Rfbbs4Dz': ('MarsX', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T07-00-00-000-WIB/token-trades.jsonl', None, 1791937557000),
    'YAp9iyhe': ('Samsung', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T08-30-00-000-WIB/token-trades.jsonl', 'HfzLyTvZ', 1791941901000),
    'bRBYoeuq': ('TRALA', 'LOSS', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-00-00-000-WIB/token-trades.jsonl', '8Ce376DS', 1791943469000),
    'sYmxtQmj': ('Muse AI', 'WIN', 'local', 'data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/2026-10-14T09-30-00-000-WIB/token-trades.jsonl', 'HfzLyTvZ', 1791946055000),
}

print(f"{'Symbol':10s} | {'Mint':8s} | {'Status':4s} | {'Big Seller':10s} | {'Sells Before Buy':16s} | {'Sold After Buy?':16s}")
print("-" * 85)

for k, (sym, stat, src_type, src_path, big_w, buy_t) in tokens.items():
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

    if not big_w:
        print(f"{sym:10s} | {k:8s} | {stat:4s} | {'None':10s} | {'N/A':16s} | {'N/A':16s}")
        continue

    sells_before = [t for t in trades if (t.get('wallet') or t.get('trade',{}).get('wallet') or '').startswith(big_w) and (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) <= buy_t and (t.get('side') == 'sell' or t.get('trade',{}).get('side') == 'sell')]
    sells_after = [t for t in trades if (t.get('wallet') or t.get('trade',{}).get('wallet') or '').startswith(big_w) and (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) > buy_t and (t.get('side') == 'sell' or t.get('trade',{}).get('side') == 'sell')]

    total_before_usd = sum(t.get('usd') or t.get('trade',{}).get('usd') or 0 for t in sells_before)
    total_after_usd = sum(t.get('usd') or t.get('trade',{}).get('usd') or 0 for t in sells_after)

    after_str = f"YES: ${total_after_usd:,.2f}" if sells_after else "NO (0)"
    before_str = f"{len(sells_before)} tx (${total_before_usd:,.0f})"

    print(f"{sym:10s} | {k:8s} | {stat:4s} | {big_w:10s} | {before_str:16s} | {after_str:16s}")
