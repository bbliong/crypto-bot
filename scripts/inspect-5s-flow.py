import json, subprocess, tarfile, os

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

print(f"{'Symbol':10s} | {'Mint':8s} | {'Buys 5s':7s} | {'Buy$ 5s':9s} | {'Sells 5s':9s} | {'Sell$ 5s':9s} | {'Buy Share':9s} | {'Meaningful ($5+)':25s}")
print('-'*95)

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
    t_5s = [t for t in trades if buy_t - 5000 <= (t.get('at') or t.get('observedAt') or (t.get('timestamp',0)*1000)) <= buy_t]
    buys = [t for t in t_5s if (t.get('side') == 'buy' or t.get('trade',{}).get('side') == 'buy')]
    sells = [t for t in t_5s if (t.get('side') == 'sell' or t.get('trade',{}).get('side') == 'sell')]

    b_usd = sum(t.get('usd') or t.get('trade',{}).get('usd') or 0 for t in buys)
    s_usd = sum(t.get('usd') or t.get('trade',{}).get('usd') or 0 for t in sells)
    b_share = (b_usd / (b_usd + s_usd) * 100) if (b_usd + s_usd) > 0 else 0

    meaningful = [t for t in buys if (t.get('usd') or t.get('trade',{}).get('usd') or 0) >= 5.0]
    meaningful_wallets = set((t.get('wallet') or t.get('trade',{}).get('wallet') or '') for t in meaningful)
    meaningful_sum = sum(t.get('usd') or t.get('trade',{}).get('usd') or 0 for t in meaningful)

    m_str = f"{len(meaningful_wallets)} wallets (${meaningful_sum:,.1f})"
    print(f"{sym:10s} | {k:8s} | {len(buys):7d} | ${b_usd:8.2f} | {len(sells):9d} | ${s_usd:8.2f} | {b_share:8.1f}% | {m_str:25s}")
