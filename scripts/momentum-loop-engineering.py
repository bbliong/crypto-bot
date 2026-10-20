import glob
import json
import itertools
import os

print("=== LOAD HISTORICAL MOMENTUM DATA ===")
files = sorted(glob.glob('data/momentum-watch/*/profit4-state.json'))
seen = set()
positions = []

for fpath in files:
    try:
        with open(fpath) as f:
            d = json.load(f)
        for p in d.get('positions', []):
            ep = p.get('entryPrice')
            eat = p.get('entryAt')
            mint = p.get('mint')
            if not ep or not eat or not mint:
                continue
            # Filter unique trade attempts
            key = (mint, eat)
            if key in seen:
                continue
            seen.add(key)
            
            # Clean fake tick 0.000004
            facts = p.get('facts', {}) or {}
            peak = facts.get('peakPrice') or ep
            trough = facts.get('troughPrice') or ep
            exit_p = p.get('exitPrice') or ep
            
            # Jika trough tercemar bug 0.000004
            if trough in [4e-06, 0.000004]:
                trough = exit_p if exit_p not in [4e-06, 0.000004] else ep * 0.95
            if exit_p in [4e-06, 0.000004]:
                exit_p = ep * 0.95
                
            duration_sec = ((p.get('exitAt') or eat) - eat) / 1000
            if duration_sec <= 0:
                duration_sec = 300
                
            mcap = ep * 1_000_000_000
            
            positions.append({
                'mint': mint,
                'entryPrice': ep,
                'entryAt': eat,
                'mcap': mcap,
                'peakPrice': peak,
                'troughPrice': trough,
                'exitPrice': exit_p,
                'durationSec': duration_sec,
                'peakGainPct': ((peak - ep) / ep) * 100,
                'maxDropPct': ((ep - trough) / ep) * 100,
                'finalReturnPct': ((exit_p - ep) / ep) * 100,
                'facts': facts,
            })
    except Exception as e:
        print(f"Error reading {fpath}: {e}")

print(f"Total Unique Valid Token Positions: {len(positions)}")

# GRID SEARCH PARAMETERS
# Stake $5, roundtrip fee 2%, slippage 1% (total 3%)
FEE_SLIPPAGE_PCT = 2.5
STAKE = 5.0

grid_tp = [10.0, 12.0, 15.0, 18.0, 20.0, 25.0]
grid_trail_start = [8.0, 10.0, 12.0, 15.0]
grid_trail_dd = [2.5, 3.5, 4.0]
grid_sl = [6.0, 7.5, 9.0, 11.0]
grid_max_hold = [90, 150, 240, 360, 600] # detik: 1.5m, 2.5m, 4m, 6m, 10m
grid_mcap_max = [0, 25000, 35000, 50000] # 0 = no limit

total_combos = (len(grid_tp) * len(grid_trail_start) * len(grid_trail_dd) * 
                len(grid_sl) * len(grid_max_hold) * len(grid_mcap_max))
print(f"Total Parameter Combinations: {total_combos}")

def simulate_trade(p, tp, trail_start, trail_dd, sl, max_hold_sec, mcap_max):
    # 1. Filter Mcap
    if mcap_max > 0 and p['mcap'] > mcap_max:
        return None # skipped
        
    ep = p['entryPrice']
    peak_pct = p['peakGainPct']
    drop_pct = p['maxDropPct']
    dur_sec = p['durationSec']
    
    # Model pergerakan harga intra-trade (apakah SL atau TP tercapai duluan):
    # Jika drop_pct >= sl: apakah kena SL duluan?
    # Koin new pair sering rally dulu lalu dump, atau dump langsung.
    # Secara empiris: jika peak_pct >= trail_start dan drop terjadi kemudian, trailing take profit menang.
    
    # Skenario 1: Kena Stop Loss langsung
    # Jika drop dalam dan peak tidak pernah mencapai trail_start
    if drop_pct >= sl and peak_pct < trail_start:
        net_ret = -sl - FEE_SLIPPAGE_PCT
        return {'pnl': (net_ret / 100) * STAKE, 'win': False, 'reason': f'SL_{int(sl)}'}
        
    # Skenario 2: Rally mencapai Target Profit atau Trailing Start
    if peak_pct >= tp:
        # Reached hard target
        net_ret = tp - FEE_SLIPPAGE_PCT
        return {'pnl': (net_ret / 100) * STAKE, 'win': True, 'reason': f'TP_{int(tp)}'}
    elif peak_pct >= trail_start:
        # Reached trailing zone
        net_ret = (peak_pct - trail_dd) - FEE_SLIPPAGE_PCT
        return {'pnl': (net_ret / 100) * STAKE, 'win': (net_ret > 0), 'reason': f'TRAIL_{int(trail_start)}'}
        
    # Skenario 3: Kena Stop Loss setelah mencoba naik sedikit (< trail_start)
    if drop_pct >= sl:
        net_ret = -sl - FEE_SLIPPAGE_PCT
        return {'pnl': (net_ret / 100) * STAKE, 'win': False, 'reason': f'SL_{int(sl)}'}
        
    # Skenario 4: Timeout Max Hold (Price Bleed)
    # Jika ditahan lebih dari max_hold_sec, harga biasanya turun 0.5% per 30 detik
    time_factor = min(dur_sec / max_hold_sec, 2.0)
    decay_pct = max(-sl, p['finalReturnPct'] - (time_factor * 2.0))
    net_ret = decay_pct - FEE_SLIPPAGE_PCT
    return {'pnl': (net_ret / 100) * STAKE, 'win': (net_ret > 0), 'reason': 'TIMEOUT'}

results = []

for tp, t_start, t_dd, sl, m_hold, m_cap in itertools.product(
    grid_tp, grid_trail_start, grid_trail_dd, grid_sl, grid_max_hold, grid_mcap_max
):
    if t_start > tp:
        continue # invalid combo
        
    trades = 0
    wins = 0
    total_pnl = 0.0
    gross_win = 0.0
    gross_loss = 0.0
    
    for p in positions:
        res = simulate_trade(p, tp, t_start, t_dd, sl, m_hold, m_cap)
        if res is None:
            continue
        trades += 1
        pnl = res['pnl']
        total_pnl += pnl
        if res['win']:
            wins += 1
            gross_win += pnl
        else:
            gross_loss += abs(pnl)
            
    if trades < 50:
        continue
        
    wr = (wins / trades) * 100
    pf = (gross_win / gross_loss) if gross_loss > 0 else 99.0
    
    results.append({
        'tp': tp,
        'trail_start': t_start,
        'trail_dd': t_dd,
        'sl': sl,
        'max_hold': m_hold,
        'mcap_max': m_cap,
        'trades': trades,
        'wins': wins,
        'losses': trades - wins,
        'win_rate': wr,
        'total_pnl': total_pnl,
        'profit_factor': pf,
    })

# Sort by total PnL
results.sort(key=lambda x: -x['total_pnl'])

print("\n" + "="*80)
print("TOP 10 KONFIGURASI PARAMETER MOMENTUM HASIL LOOP ENGINEERING:")
print("="*80)
print(f"{'Rank':<4} | {'TP':<4} | {'Trail':<6} | {'SL':<4} | {'Hold':<5} | {'Mcap':<7} | {'Trades':<6} | {'WR':<6} | {'Net PnL':<8} | {'PF':<5}")
print("-"*80)

for i, r in enumerate(results[:15], 1):
    mcap_str = f"<{int(r['mcap_max']/1000)}k" if r['mcap_max'] > 0 else "ALL"
    trail_str = f"+{int(r['trail_start'])}/-{r['trail_dd']}"
    print(f"{i:<4} | +{int(r['tp'])}% | {trail_str:<6} | -{r['sl']}% | {r['max_hold']}s  | {mcap_str:<7} | {r['trades']:>6} | {r['win_rate']:>5.1f}% | ${r['total_pnl']:>7.2f} | {r['profit_factor']:>4.2f}")

# Simpan hasil terbaik ke json
with open('.hermes/cache/scratch/top_momentum_rules.json', 'w') as f:
    json.dump(results[:10], f, indent=2)
