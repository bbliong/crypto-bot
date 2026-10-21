#!/usr/bin/env python3
"""
Momentum Loop Engineering & Strategy Simulator
Analisis komprehensif data trading momentum dari malam (20 Okt 23:10 WIB) hingga siang ini (21 Okt 13:53 WIB).
Mengevaluasi ribuan kombinasi parameter (TP, Trailing, SL, Max Hold, Entry Filters)
untuk menemukan logika trading paling menguntungkan.
"""

import json
import glob
import os
import sys
from datetime import datetime, timezone, timedelta

def load_data():
    files = sorted(glob.glob('data/momentum-watch/*/profit4-state.json'))
    positions = []
    seen = set()
    
    for fpath in files:
        try:
            with open(fpath, 'r') as fp:
                data = json.load(fp)
                for p in data.get('positions', []):
                    eat = p.get('entryAt')
                    ep = p.get('entryPrice')
                    mint = p.get('mint')
                    lane = p.get('laneLabel') or p.get('lane') or 'Unknown'
                    
                    if not eat or not ep or not mint:
                        continue
                    
                    # Dedupe key: mint + entry timestamp + lane
                    key = (mint, eat, lane)
                    if key in seen:
                        continue
                    seen.add(key)
                    
                    facts = p.get('facts', {}) or {}
                    peak = facts.get('peakPrice') or ep
                    trough = facts.get('troughPrice') or ep
                    exit_p = p.get('exitPrice') or ep
                    
                    # Handle known glitch quote 0.000004
                    if trough in [4e-06, 0.000004]:
                        trough = exit_p if exit_p not in [4e-06, 0.000004] else ep * 0.95
                    if exit_p in [4e-06, 0.000004]:
                        exit_p = ep * 0.95
                    if peak in [4e-06, 0.000004] or peak < ep:
                        peak = max(ep, exit_p)
                        
                    duration_sec = ((p.get('exitAt') or eat) - eat) / 1000
                    if duration_sec <= 0:
                        duration_sec = 300
                        
                    mcap = ep * 1_000_000_000
                    
                    # Facts extraction
                    buy_share = facts.get('buyShareUsdPercent')
                    meaningful_buyers = facts.get('meaningfulBuyers')
                    momentum_pct = facts.get('momentumPercent')
                    drawdown_pct = facts.get('drawdownPercent')
                    
                    peak_gain_pct = ((peak - ep) / ep) * 100
                    max_drop_pct = ((ep - trough) / ep) * 100
                    final_ret_pct = ((exit_p - ep) / ep) * 100
                    
                    actual_pnl = p.get('pnlUsd') or 0.0
                    actual_reason = (p.get('lastEvent') or {}).get('reason') or p.get('phase') or 'UNKNOWN'
                    
                    positions.append({
                        'mint': mint,
                        'lane': lane,
                        'entryPrice': ep,
                        'entryAt': eat,
                        'exitAt': p.get('exitAt'),
                        'mcap': mcap,
                        'peakPrice': peak,
                        'troughPrice': trough,
                        'exitPrice': exit_p,
                        'durationSec': duration_sec,
                        'peakGainPct': peak_gain_pct,
                        'maxDropPct': max_drop_pct,
                        'finalReturnPct': final_ret_pct,
                        'buyShare': buy_share,
                        'meaningfulBuyers': meaningful_buyers,
                        'momentumPct': momentum_pct,
                        'drawdownPct': drawdown_pct,
                        'actualPnl': actual_pnl,
                        'actualReason': actual_reason,
                    })
        except Exception as e:
            print(f"Error reading {fpath}: {e}")
            
    return positions

def simulate_trade(p, tp, trail_start, trail_dd, sl, max_hold_sec, fee_pct=2.5, stake=5.0):
    peak_pct = p['peakGainPct']
    drop_pct = p['maxDropPct']
    dur_sec = p['durationSec']
    
    # Skenario 1: Drop parah langsung kena SL tanpa sempat bounce
    if drop_pct >= sl and peak_pct < trail_start:
        net_ret = -sl - fee_pct
        return {
            'pnl': (net_ret / 100) * stake,
            'win': False,
            'ret_pct': net_ret,
            'reason': f'SL_{int(sl)}'
        }
        
    # Skenario 2: Rally kuat mencapai Target Profit
    if peak_pct >= tp:
        net_ret = tp - fee_pct
        return {
            'pnl': (net_ret / 100) * stake,
            'win': True,
            'ret_pct': net_ret,
            'reason': f'TP_{int(tp)}'
        }
        
    # Skenario 3: Mencapai zona trailing profit kemudian retrace
    if peak_pct >= trail_start:
        exit_gain = peak_pct - trail_dd
        net_ret = exit_gain - fee_pct
        return {
            'pnl': (net_ret / 100) * stake,
            'win': (net_ret > 0),
            'ret_pct': net_ret,
            'reason': f'TRAIL_{int(trail_start)}'
        }
        
    # Skenario 4: Kena SL setelah mencoba naik sedikit (< trail_start)
    if drop_pct >= sl:
        net_ret = -sl - fee_pct
        return {
            'pnl': (net_ret / 100) * stake,
            'win': False,
            'ret_pct': net_ret,
            'reason': f'SL_{int(sl)}'
        }
        
    # Skenario 5: Timeout Max Hold (Price Bleed)
    time_factor = min(dur_sec / max_hold_sec, 2.0)
    decay_pct = max(-sl, p['finalReturnPct'] - (time_factor * 1.5))
    net_ret = decay_pct - fee_pct
    return {
        'pnl': (net_ret / 100) * stake,
        'win': (net_ret > 0),
        'ret_pct': net_ret,
        'reason': 'TIMEOUT'
    }

def run_loop_engineering(positions):
    print("=" * 80)
    print("DATA GROUP MOMENTUM: RINGKASAN DATASET AKTUAL")
    print("=" * 80)
    
    wib = timezone(timedelta(hours=7))
    t_min = min(p['entryAt'] for p in positions) / 1000
    t_max = max(p['entryAt'] for p in positions) / 1000
    dt_min = datetime.fromtimestamp(t_min, tz=wib)
    dt_max = datetime.fromtimestamp(t_max, tz=wib)
    
    total_trades = len(positions)
    actual_wins = [p for p in positions if p['actualPnl'] > 0]
    actual_losses = [p for p in positions if p['actualPnl'] <= 0]
    actual_tot_pnl = sum(p['actualPnl'] for p in positions)
    actual_wr = len(actual_wins) / total_trades * 100
    
    print(f"Periode Data      : {dt_min.strftime('%d-%m-%Y %H:%M:%S WIB')} s/d {dt_max.strftime('%d-%m-%Y %H:%M:%S WIB')}")
    print(f"Total Trade Riil  : {total_trades} trade")
    print(f"  • M-Scalp       : {len([p for p in positions if p['lane'] == 'M-Scalp'])} trade")
    print(f"  • M-Trend       : {len([p for p in positions if p['lane'] == 'M-Trend'])} trade")
    print(f"Hasil Baseline    : Win Rate {actual_wr:.1f}% ({len(actual_wins)}W / {len(actual_losses)}L)")
    print(f"Total PnL Riil    : ${actual_tot_pnl:+.2f}")
    
    # ---------------------------------------------------------
    # DEFINE ENTRY FILTERS FOR LOOP ENGINEERING
    # ---------------------------------------------------------
    filter_presets = {
        'ALL (Tanpa Filter)': lambda p: True,
        'F1: BuyShare >= 60%': lambda p: (p['buyShare'] is not None and p['buyShare'] >= 60.0),
        'F2: BuyShare >= 65%': lambda p: (p['buyShare'] is not None and p['buyShare'] >= 65.0),
        'F3: Buyers >= 12 & BuyShare >= 65%': lambda p: (
            p['buyShare'] is not None and p['buyShare'] >= 65.0 and
            p['meaningfulBuyers'] is not None and p['meaningfulBuyers'] >= 12
        ),
        'F4: Mcap >= $20k & BuyShare >= 60%': lambda p: (
            p['mcap'] >= 20000 and
            p['buyShare'] is not None and p['buyShare'] >= 60.0
        ),
        'F5: Golden Sweet-Spot (Mcap >= $20k, Buyers >= 12, BuyShare >= 65%)': lambda p: (
            p['mcap'] >= 20000 and
            p['buyShare'] is not None and p['buyShare'] >= 65.0 and
            p['meaningfulBuyers'] is not None and p['meaningfulBuyers'] >= 12
        )
    }
    
    # Parameter Grid
    grid_tp = [12.0, 15.0, 18.0, 20.0, 25.0, 30.0]
    grid_trail_start = [6.0, 8.0, 10.0, 12.0, 15.0]
    grid_trail_dd = [2.0, 2.5, 3.0, 3.5]
    grid_sl = [5.0, 6.0, 7.5, 8.5, 10.0]
    grid_max_hold = [90, 150, 240, 360, 600]
    
    total_combos_per_filter = len(grid_tp) * len(grid_trail_start) * len(grid_trail_dd) * len(grid_sl) * len(grid_max_hold)
    total_evaluations = total_combos_per_filter * len(filter_presets)
    
    print(f"\nMemulai Loop Engineering pada {total_evaluations:,} kombinasi parameter...")
    
    filter_results = {}
    
    for f_name, f_fn in filter_presets.items():
        sub_positions = [p for p in positions if f_fn(p)]
        n_pos = len(sub_positions)
        if n_pos < 10:
            continue
            
        best_combo = None
        best_pnl = -999999.0
        all_combos_for_filter = []
        
        for tp in grid_tp:
            for trail_start in grid_trail_start:
                if trail_start >= tp:
                    continue  # trailing activation must be lower than hard TP
                for trail_dd in grid_trail_dd:
                    for sl in grid_sl:
                        for max_hold in grid_max_hold:
                            tot_pnl = 0.0
                            wins = 0
                            gross_win = 0.0
                            gross_loss = 0.0
                            
                            for p in sub_positions:
                                res = simulate_trade(p, tp, trail_start, trail_dd, sl, max_hold)
                                pnl = res['pnl']
                                tot_pnl += pnl
                                if pnl > 0:
                                    wins += 1
                                    gross_win += pnl
                                else:
                                    gross_loss += abs(pnl)
                                    
                            wr = (wins / n_pos) * 100
                            pf = (gross_win / gross_loss) if gross_loss > 0 else 99.0
                            ev = tot_pnl / n_pos
                            
                            combo_record = {
                                'filter': f_name,
                                'trades': n_pos,
                                'tp': tp,
                                'trail_start': trail_start,
                                'trail_dd': trail_dd,
                                'sl': sl,
                                'max_hold': max_hold,
                                'wr': wr,
                                'pnl': tot_pnl,
                                'pf': pf,
                                'ev': ev,
                                'gross_win': gross_win,
                                'gross_loss': gross_loss
                            }
                            all_combos_for_filter.append(combo_record)
                            
                            if tot_pnl > best_pnl:
                                best_pnl = tot_pnl
                                best_combo = combo_record
                                
        all_combos_for_filter.sort(key=lambda x: x['pnl'], reverse=True)
        filter_results[f_name] = {
            'best': best_combo,
            'top5': all_combos_for_filter[:5],
            'trades_count': n_pos
        }
        
    return filter_results, positions

if __name__ == '__main__':
    pos = load_data()
    filter_results, positions = run_loop_engineering(pos)
    
    print("\n" + "=" * 90)
    print("HASIL LOOP ENGINEERING: STRATEGI TERBAIK PER KATEGORI FILTER")
    print("=" * 90)
    print(f"{'Filter Preset':<40} | {'Trades':<6} | {'WR%':<6} | {'Net PnL':<10} | {'PF':<5} | {'EV/Tr':<7} | {'Best Param'}")
    print("-" * 90)
    
    for fname, data in filter_results.items():
        b = data['best']
        param_str = f"TP +{b['tp']:.0f}% | Tr +{b['trail_start']:.0f}/-{b['trail_dd']:.1f}% | SL -{b['sl']:.1f}% | {b['max_hold']}s"
        print(f"{fname:<40} | {b['trades']:<6} | {b['wr']:5.1f}% | ${b['pnl']:+8.2f} | {b['pf']:4.2f} | ${b['ev']:+5.2f} | {param_str}")
        
    print("\n" + "=" * 90)
    print("TOP 10 STRATEGI SECARA KESELURUHAN (GLOBAL RANKING BY NET PNL):")
    print("=" * 90)
    all_bests = []
    for data in filter_results.values():
        all_bests.extend(data['top5'])
    all_bests.sort(key=lambda x: x['pnl'], reverse=True)
    
    print(f"{'Rank':<4} | {'Filter':<32} | {'Trades':<6} | {'WR%':<6} | {'Net PnL':<10} | {'PF':<5} | {'EV/Tr':<7} | {'Parameter'}")
    print("-" * 90)
    for i, b in enumerate(all_bests[:10], 1):
        param_str = f"TP+{b['tp']:.0f}% | Tr+{b['trail_start']:.0f}/-{b['trail_dd']:.1f}% | SL-{b['sl']:.1f}% | {b['max_hold']}s"
        print(f"{i:<4} | {b['filter']:<32} | {b['trades']:<6} | {b['wr']:5.1f}% | ${b['pnl']:+8.2f} | {b['pf']:4.2f} | ${b['ev']:+5.2f} | {param_str}")
