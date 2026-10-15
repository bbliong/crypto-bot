#!/usr/bin/env python3
"""
LOOP ENGINEERING: MAXIMUM NET PROFIT OPTIMIZATION
Focus: Untung Terbesar (Cumulative Net USD Profit, Net ROI, & EV per trade on $5 stake)
Evaluates both Staircase (accumulative momentum) and Bounce (post-dump rebound).
Accounts for Solana gas/priority fee ($0.12 roundtrip) and realistic order-flow execution.
"""

import glob
import json
import os
import time

FEE_USD = 0.12
STAKE_USD = 5.0

def load_trades(file_path):
    trades = []
    with open(file_path, 'r', encoding='utf-8') as fp:
        for line in fp:
            try:
                trades.append(json.loads(line))
            except:
                pass
    if not trades or len(trades) < 40:
        return None
    trades.sort(key=lambda x: x.get('timestamp') or int(x.get('observedAt', 0)/1000))
    return trades

def evaluate_exit(p_entry, future_prices, tp, sl, ts_act=None, ts_trail=None):
    """
    Simulates tick-by-tick exit on future_prices.
    Returns: (hit: 'WIN'|'LOSS', net_pnl_usd, net_pct, peak_pct, hold_ticks)
    """
    peak = 0.0
    ts_activated = False
    
    for idx, p in enumerate(future_prices):
        ret = (p - p_entry) / p_entry * 100
        if ret > peak:
            peak = ret
            
        # 1. Trailing Stop logic if configured
        if ts_act is not None and ts_trail is not None:
            if not ts_activated and ret >= ts_act:
                ts_activated = True
            if ts_activated:
                if (peak - ret) >= ts_trail:
                    gross_usd = STAKE_USD * (ret / 100.0)
                    net_usd = gross_usd - FEE_USD
                    net_pct = (net_usd / STAKE_USD) * 100.0
                    return ('WIN' if net_usd > 0 else 'LOSS', net_usd, net_pct, peak, idx)
            else:
                if ret <= -sl:
                    gross_usd = STAKE_USD * (-sl / 100.0)
                    net_usd = gross_usd - FEE_USD
                    net_pct = (net_usd / STAKE_USD) * 100.0
                    return ('LOSS', net_usd, net_pct, peak, idx)
        else:
            # 2. Fixed TP / SL logic
            if ret >= tp:
                gross_usd = STAKE_USD * (tp / 100.0)
                net_usd = gross_usd - FEE_USD
                net_pct = (net_usd / STAKE_USD) * 100.0
                return ('WIN', net_usd, net_pct, peak, idx)
            if ret <= -sl:
                gross_usd = STAKE_USD * (-sl / 100.0)
                net_usd = gross_usd - FEE_USD
                net_pct = (net_usd / STAKE_USD) * 100.0
                return ('LOSS', net_usd, net_pct, peak, idx)
                
    # End of data: close at final price
    final_ret = (future_prices[-1] - p_entry) / p_entry * 100
    gross_usd = STAKE_USD * (final_ret / 100.0)
    net_usd = gross_usd - FEE_USD
    net_pct = (net_usd / STAKE_USD) * 100.0
    return ('WIN' if net_usd > 0 else 'LOSS', net_usd, net_pct, peak, len(future_prices))

def analyze_token(file_path):
    trades = load_trades(file_path)
    if not trades:
        return None
        
    t0 = trades[0].get('timestamp') or int(trades[0].get('observedAt', 0)/1000)
    sym = trades[0].get('trackedFrom', {}).get('symbol') or os.path.basename(file_path)[:8]
    mint = os.path.basename(file_path).replace('.jsonl', '')
    
    # We test multiple entry setups:
    # A) Staircase Setups at 60s, 90s, 120s
    # B) Bounce Setups (after 25%, 28%, 32% dump)
    
    entries = []
    
    # ---- A. STAIRCASE S1 CANDIDATE (Window 120s) ----
    w120_trades = []
    fut120_trades = []
    for t in trades:
        ts = (t.get('timestamp') or int(t.get('observedAt', 0)/1000)) - t0
        if ts <= 120:
            w120_trades.append(t)
        else:
            fut120_trades.append(t)
            
    if w120_trades and fut120_trades:
        m1_trades = [t for t in w120_trades if ((t.get('timestamp') or int(t.get('observedAt', 0)/1000)) - t0) <= 60]
        m2_trades = [t for t in w120_trades if ((t.get('timestamp') or int(t.get('observedAt', 0)/1000)) - t0) > 60]
        
        buys120 = [t for t in w120_trades if t.get('side') == 'buy']
        sells120 = [t for t in w120_trades if t.get('side') == 'sell']
        vol_buy120 = sum(float(t.get('usd') or 0) for t in buys120)
        vol_sell120 = sum(float(t.get('usd') or 0) for t in sells120)
        tot_vol120 = vol_buy120 + vol_sell120
        ratio120 = vol_buy120 / max(vol_sell120, 1.0)
        
        prices120 = [float(t.get('price') or 0) for t in w120_trades if float(t.get('price') or 0) > 0]
        fut120_prices = [float(t.get('price') or 0) for t in fut120_trades if float(t.get('price') or 0) > 0]
        
        if prices120 and fut120_prices:
            p_start = prices120[0]
            p_entry = prices120[-1]
            gain_120 = (p_entry - p_start) / p_start * 100
            
            # max drawdown in 120s
            peak = 0
            max_dd120 = 0
            for p in prices120:
                if p > peak: peak = p
                elif peak > 0:
                    dd = (peak - p) / peak * 100
                    if dd > max_dd120: max_dd120 = dd
            max_sell120 = max([float(t.get('usd') or 0) for t in sells120]) if sells120 else 0
            
            # check staircase rules (various strictness)
            entries.append({
                'type': 'staircase',
                'name': 'staircase_120s',
                'mint': mint,
                'symbol': sym,
                'p_entry': p_entry,
                'gain_120': gain_120,
                'tot_vol': tot_vol120,
                'vol_ratio': ratio120,
                'max_dd': max_dd120,
                'max_single_sell': max_sell120,
                'fut_prices': fut120_prices
            })
            
    # ---- B. BOUNCE V7 CANDIDATE (Post-dump 28-35% + rebound) ----
    prices_all = [float(t.get('price') or 0) for t in trades if float(t.get('price') or 0) > 0]
    if len(prices_all) > 50:
        ath = 0.0
        trough = 999999.0
        dump_found = False
        bounce_entry_idx = -1
        
        for idx, t in enumerate(trades):
            p = float(t.get('price') or 0)
            if p <= 0: continue
            if not dump_found:
                if p > ath:
                    ath = p
                    trough = p
                elif ath > 0:
                    dd = (ath - p) / ath * 100
                    if p < trough:
                        trough = p
                    if dd >= 28.0:
                        dump_found = True
            else:
                # Looking for rebound: +5% from trough and meaningful buy
                if trough > 0:
                    reb = (p - trough) / trough * 100
                    if reb >= 4.0 and reb <= 15.0:
                        # Check buy volume >= 22
                        recent_buys = [float(x.get('usd') or 0) for x in trades[max(0, idx-10):idx+1] if x.get('side') == 'buy']
                        if sum(recent_buys) >= 22.0:
                            bounce_entry_idx = idx
                            break
                            
        if bounce_entry_idx > 0 and bounce_entry_idx < len(trades) - 10:
            p_entry_b = float(trades[bounce_entry_idx].get('price') or 0)
            fut_b_prices = [float(t.get('price') or 0) for t in trades[bounce_entry_idx+1:] if float(t.get('price') or 0) > 0]
            if p_entry_b > 0 and len(fut_b_prices) > 10:
                entries.append({
                    'type': 'bounce',
                    'name': 'bounce_v7',
                    'mint': mint,
                    'symbol': sym,
                    'p_entry': p_entry_b,
                    'fut_prices': fut_b_prices
                })
                
    return entries

def main():
    files = glob.glob('/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl') + \
            glob.glob('/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl')
            
    print(f"Loaded {len(files)} token trade archives. Processing entries...")
    
    all_staircase = []
    all_bounce = []
    
    t0 = time.time()
    for f in files:
        res = analyze_token(f)
        if not res: continue
        for e in res:
            if e['type'] == 'staircase':
                all_staircase.append(e)
            elif e['type'] == 'bounce':
                all_bounce.append(e)
                
    print(f"Identified {len(all_staircase)} Staircase candidates and {len(all_bounce)} Bounce candidates in {time.time()-t0:.1f}s.")
    
    # -----------------------------------------------------------------
    # SIMULATION EXITS GRID
    # -----------------------------------------------------------------
    # We want to test exits designed for BIG WINS:
    # 1. High TP targets (+20%, +25%, +30%, +35%, +40%, +50%, +60%, +80%)
    # 2. Dynamic Trailing Runners (Let winners run!)
    
    exit_strategies = [
        # Fixed TP / SL
        {'name': 'Fixed TP +15% / SL -6%', 'type': 'fixed', 'tp': 15.0, 'sl': 6.0},
        {'name': 'Fixed TP +20% / SL -8%', 'type': 'fixed', 'tp': 20.0, 'sl': 8.0},
        {'name': 'Fixed TP +25% / SL -8%', 'type': 'fixed', 'tp': 25.0, 'sl': 8.0},
        {'name': 'Fixed TP +30% / SL -8%', 'type': 'fixed', 'tp': 30.0, 'sl': 8.0},
        {'name': 'Fixed TP +35% / SL -9%', 'type': 'fixed', 'tp': 35.0, 'sl': 9.0},
        {'name': 'Fixed TP +40% / SL -10%', 'type': 'fixed', 'tp': 40.0, 'sl': 10.0},
        {'name': 'Fixed TP +50% / SL -10%', 'type': 'fixed', 'tp': 50.0, 'sl': 10.0},
        {'name': 'Fixed TP +60% / SL -12%', 'type': 'fixed', 'tp': 60.0, 'sl': 12.0},
        {'name': 'Fixed TP +80% / SL -12%', 'type': 'fixed', 'tp': 80.0, 'sl': 12.0},
        
        # Trailing Runners (Activate at X%, trail Y%, SL Z%)
        {'name': 'Runner TS +20% (trail 5%, SL -8%)', 'type': 'ts', 'act': 20.0, 'trail': 5.0, 'sl': 8.0},
        {'name': 'Runner TS +25% (trail 6%, SL -8%)', 'type': 'ts', 'act': 25.0, 'trail': 6.0, 'sl': 8.0},
        {'name': 'Runner TS +30% (trail 7%, SL -9%)', 'type': 'ts', 'act': 30.0, 'trail': 7.0, 'sl': 9.0},
        {'name': 'Runner TS +35% (trail 8%, SL -10%)', 'type': 'ts', 'act': 35.0, 'trail': 8.0, 'sl': 10.0},
        {'name': 'Runner TS +40% (trail 8%, SL -10%)', 'type': 'ts', 'act': 40.0, 'trail': 8.0, 'sl': 10.0},
        {'name': 'Runner TS +50% (trail 10%, SL -12%)', 'type': 'ts', 'act': 50.0, 'trail': 10.0, 'sl': 12.0},
        {'name': 'Runner TS +60% (trail 12%, SL -12%)', 'type': 'ts', 'act': 60.0, 'trail': 12.0, 'sl': 12.0},
    ]
    
    # -----------------------------------------------------------------
    # EVALUATE STAIRCASE UNDER VARIOUS ENTRY FILTER STRICTNESS
    # -----------------------------------------------------------------
    filter_presets = [
        # (name, min_vol, min_ratio, max_dd, max_sell)
        ('Strict 85WR ($1800 vol, DD<=2.2%, sell<=$60)', 1800, 2.0, 2.2, 60),
        ('Moderate ($1200 vol, DD<=2.8%, sell<=$100)', 1200, 2.0, 2.8, 100),
        ('Wide ($800 vol, DD<=3.5%, sell<=$150)', 800, 1.8, 3.5, 150),
        ('Early ($500 vol, DD<=4.0%, sell<=$200)', 500, 1.5, 4.0, 200),
    ]
    
    staircase_eval_results = []
    
    for f_name, min_v, min_r, max_d, max_s in filter_presets:
        # filter candidates
        matched = []
        for e in all_staircase:
            if e['tot_vol'] < min_v: continue
            if e['vol_ratio'] < min_r: continue
            if e['max_dd'] > max_d: continue
            if e['max_single_sell'] > max_s: continue
            matched.append(e)
            
        if len(matched) < 4: continue
        
        for st in exit_strategies:
            wins = 0
            losses = 0
            total_net_usd = 0.0
            net_pcts = []
            gross_wins = 0.0
            gross_losses = 0.0
            trade_details = []
            
            for m in matched:
                if st['type'] == 'fixed':
                    hit, net_usd, net_pct, peak, ticks = evaluate_exit(m['p_entry'], m['fut_prices'], st['tp'], st['sl'])
                else:
                    hit, net_usd, net_pct, peak, ticks = evaluate_exit(m['p_entry'], m['fut_prices'], None, st['sl'], st['act'], st['trail'])
                    
                total_net_usd += net_usd
                net_pcts.append(net_pct)
                if net_usd > 0:
                    wins += 1
                    gross_wins += net_usd
                else:
                    losses += 1
                    gross_losses += abs(net_usd)
                trade_details.append({
                    'symbol': m['symbol'],
                    'hit': hit,
                    'net_usd': net_usd,
                    'net_pct': net_pct,
                    'peak': peak
                })
                
            n_trades = wins + losses
            wr = (wins / n_trades) * 100 if n_trades > 0 else 0
            ev_per_trade = total_net_usd / n_trades if n_trades > 0 else 0
            roi_pct = (total_net_usd / (STAKE_USD * n_trades)) * 100 if n_trades > 0 else 0
            profit_factor = (gross_wins / gross_losses) if gross_losses > 0 else 999.0
            
            staircase_eval_results.append({
                'category': 'Staircase S1',
                'filter_preset': f_name,
                'exit_name': st['name'],
                'trades': n_trades,
                'wins': wins,
                'losses': losses,
                'win_rate': wr,
                'total_net_usd': total_net_usd,
                'ev_per_trade_usd': ev_per_trade,
                'roi_pct': roi_pct,
                'profit_factor': profit_factor,
                'trade_details': trade_details
            })

    # -----------------------------------------------------------------
    # EVALUATE BOUNCE V7 UNDER ALL EXIT STRATEGIES
    # -----------------------------------------------------------------
    bounce_eval_results = []
    for st in exit_strategies:
        wins = 0
        losses = 0
        total_net_usd = 0.0
        gross_wins = 0.0
        gross_losses = 0.0
        trade_details = []
        
        for b in all_bounce:
            if st['type'] == 'fixed':
                hit, net_usd, net_pct, peak, ticks = evaluate_exit(b['p_entry'], b['fut_prices'], st['tp'], st['sl'])
            else:
                hit, net_usd, net_pct, peak, ticks = evaluate_exit(b['p_entry'], b['fut_prices'], None, st['sl'], st['act'], st['trail'])
                
            total_net_usd += net_usd
            if net_usd > 0:
                wins += 1
                gross_wins += net_usd
            else:
                losses += 1
                gross_losses += abs(net_usd)
            trade_details.append({
                'symbol': b['symbol'],
                'hit': hit,
                'net_usd': net_usd,
                'net_pct': net_pct,
                'peak': peak
            })
            
        n_trades = wins + losses
        wr = (wins / n_trades) * 100 if n_trades > 0 else 0
        ev_per_trade = total_net_usd / n_trades if n_trades > 0 else 0
        roi_pct = (total_net_usd / (STAKE_USD * n_trades)) * 100 if n_trades > 0 else 0
        profit_factor = (gross_wins / gross_losses) if gross_losses > 0 else 999.0
        
        bounce_eval_results.append({
            'category': 'Bounce V7',
            'filter_preset': 'V7 Standard (Dump >=28%, Buy >=$22)',
            'exit_name': st['name'],
            'trades': n_trades,
            'wins': wins,
            'losses': losses,
            'win_rate': wr,
            'total_net_usd': total_net_usd,
            'ev_per_trade_usd': ev_per_trade,
            'roi_pct': roi_pct,
            'profit_factor': profit_factor,
            'trade_details': trade_details
        })

    all_results = staircase_eval_results + bounce_eval_results
    
    # SORT BY TOTAL NET USD PROFIT (UNTUNG TERBESAR)
    all_results.sort(key=lambda x: x['total_net_usd'], reverse=True)
    
    print("\n" + "="*140)
    print("  HASIL LOOP ENGINEERING: PERINGKAT UNTUNG TERBESAR (TOTAL NET USD DENGAN MODAL $5 & FEE $0.12)")
    print("="*140)
    print(f"{'Rank':<4} | {'Strategy & Filter':<42} | {'Exit Strategy':<34} | {'Trades':<7} | {'WinRate':<8} | {'Total Net $':<12} | {'EV/Trade $':<11} | {'ROI %':<8} | {'ProfitFactor':<12}")
    print("-"*140)
    for idx, r in enumerate(all_results[:25]):
        strat_lbl = f"{r['category']} - {r['filter_preset']}"[:42]
        sign = "+" if r['total_net_usd'] > 0 else ""
        ev_sign = "+" if r['ev_per_trade_usd'] > 0 else ""
        print(f"#{idx+1:<3} | {strat_lbl:<42} | {r['exit_name']:<34} | {r['trades']:<7} | {r['win_rate']:<7.1f}% | {sign}${r['total_net_usd']:<10.2f} | {ev_sign}${r['ev_per_trade_usd']:<9.2f} | {r['roi_pct']:<7.1f}% | {r['profit_factor']:<12.2f}")
        
    # Save detailed JSON for top 30
    out_path = '/home/bbliong/project/crypto-bot/data/profit4-watch/loop-engineering-max-profit.json'
    with open(out_path, 'w') as fp:
        json.dump(all_results[:50], fp, indent=2)
    print(f"\nSaved top results to {out_path}")

if __name__ == '__main__':
    main()
