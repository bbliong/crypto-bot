import json, os, glob
from datetime import datetime

runs = [
    'data/profit4-watch/2026-10-12T17-09-10-368Z',
    'data/profit4-watch/2026-10-13T10-14-24-007Z'
]

trades = []

# Collect from state files
for r in runs:
    state_file = os.path.join(r, 'profit4-state.json')
    if os.path.exists(state_file):
        try:
            d = json.load(open(state_file))
            for pos in d.get('positions', []):
                if pos.get('laneLabel') == 'V5':
                    if pos.get('entryAt') or pos.get('netReturnPercent') is not None:
                        trades.append(pos)
        except Exception as e:
            pass

# Also collect from all chunks profit4-events.jsonl
events_by_mint = {}
for r in runs:
    for ev_file in glob.glob(f'{r}/**/profit4-events.jsonl', recursive=True):
        with open(ev_file) as f:
            for line in f:
                if not line.strip(): continue
                try:
                    ev = json.loads(line)
                    if ev.get('laneLabel') == 'V5':
                        m = ev.get('mint')
                        if m not in events_by_mint: events_by_mint[m] = []
                        events_by_mint[m].append(ev)
                except Exception:
                    pass

all_mints = set([t['mint'] for t in trades] + list(events_by_mint.keys()))

v5_completed = {}
for m in all_mints:
    evs = events_by_mint.get(m, [])
    buys = [e for e in evs if e.get('type') == 'PAPER_BUY']
    sells = [e for e in evs if e.get('type') == 'PAPER_SELL']
    
    pos_match = next((t for t in trades if t['mint'] == m), None)
    
    if buys or (pos_match and pos_match.get('entryAt')):
        buy_ev = buys[0] if buys else None
        sell_ev = sells[0] if sells else None
        
        sym = (pos_match and pos_match.get('symbol')) or (buy_ev and buy_ev.get('transfer', {}).get('symbol')) or 'N/A'
        net = (sell_ev and sell_ev.get('netReturnPercent')) or (pos_match and pos_match.get('netReturnPercent'))
        pnl = (sell_ev and sell_ev.get('pnlUsd')) or (pos_match and pos_match.get('pnlUsd'))
        reason = (sell_ev and sell_ev.get('reason')) or (pos_match and pos_match.get('lastEvent', {}).get('reason')) or 'OPEN'
        entry_time = (buy_ev and buy_ev.get('observedAt')) or (pos_match and pos_match.get('entryAt'))
        
        v5_completed[m] = {
            'symbol': sym,
            'mint': m,
            'net': net,
            'pnl': pnl,
            'reason': reason,
            'entryTime': entry_time,
            'events': evs,
            'pos': pos_match
        }

print('=' * 80)
print('EVALUASI SEMUA TRADE LANE V5 HARI INI (13 OKTOBER 2026)')
print('=' * 80)

wins = []
losses = []
opens = []

for m, tr in v5_completed.items():
    net = tr['net']
    if net is not None:
        if net > 0: wins.append(tr)
        else: losses.append(tr)
    else:
        opens.append(tr)

print(f"Total Trade Masuk V5 : {len(v5_completed)} token")
print(f"  - Menang (Wins)    : {len(wins)} token")
print(f"  - Kalah (Losses)   : {len(losses)} token")
print(f"  - Open/Censored    : {len(opens)} token")
if len(wins) + len(losses) > 0:
    print(f"Win Rate Hari Ini    : {len(wins)/(len(wins)+len(losses))*100:.1f}%")
print()

print(f"DETAIL TOKEN LOSS HARI INI ({len(losses)} token):")
print("-" * 80)
for i, l in enumerate(losses, 1):
    t_str = datetime.fromtimestamp(l['entryTime']/1000).strftime('%H:%M:%S WIB') if l['entryTime'] else 'N/A'
    sym = l['symbol']
    mint = l['mint'][:8]
    net_val = l['net']
    pnl_val = l['pnl']
    net_str = f"{net_val:+6.1f}%" if net_val is not None else "N/A"
    pnl_str = f"(${pnl_val:+.2f})" if pnl_val is not None else ""
    reason = l['reason']
    print(f"{i:2d}. {sym:<15} ({mint}) | Net: {net_str} {pnl_str:<9} | Jam: {t_str} | Alasan: {reason}")

print()
print(f"DETAIL TOKEN WIN HARI INI ({len(wins)} token):")
print("-" * 80)
for i, w in enumerate(wins, 1):
    t_str = datetime.fromtimestamp(w['entryTime']/1000).strftime('%H:%M:%S WIB') if w['entryTime'] else 'N/A'
    sym = w['symbol']
    mint = w['mint'][:8]
    net_val = w['net']
    pnl_val = w['pnl']
    net_str = f"{net_val:+6.1f}%" if net_val is not None else "N/A"
    pnl_str = f"(${pnl_val:+.2f})" if pnl_val is not None else ""
    reason = w['reason']
    print(f"{i:2d}. {sym:<15} ({mint}) | Net: {net_str} {pnl_str:<9} | Jam: {t_str} | Alasan: {reason}")
