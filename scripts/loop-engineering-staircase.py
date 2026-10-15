#!/usr/bin/env python3
import glob
import json
import os
import time
from collections import defaultdict

def extract_token_profile(file_path):
    trades = []
    with open(file_path, 'r', encoding='utf-8') as fp:
        for line in fp:
            try:
                trades.append(json.loads(line))
            except:
                pass
    if not trades or len(trades) < 50:
        return None
        
    trades.sort(key=lambda x: x.get('timestamp') or int(x.get('observedAt', 0)/1000))
    t0 = trades[0].get('timestamp') or int(trades[0].get('observedAt', 0)/1000)
    sym = trades[0].get('trackedFrom', {}).get('symbol') or os.path.basename(file_path)[:8]
    mint = os.path.basename(file_path).replace('.jsonl', '')
    
    windows = [60, 90, 120, 150, 180]
    sl_levels = [6, 8, 10, 12, 15]
    tp_levels = [15, 20, 25, 30, 40, 50]
    
    token_profile = {
        'mint': mint,
        'symbol': sym,
        'total_trades': len(trades),
        'duration_s': (trades[-1].get('timestamp') or int(trades[-1].get('observedAt', 0)/1000)) - t0,
        'windows': {}
    }
    
    for W in windows:
        w_trades = []
        future_trades = []
        for t in trades:
            ts = (t.get('timestamp') or int(t.get('observedAt', 0)/1000)) - t0
            if ts <= W:
                w_trades.append(t)
            else:
                future_trades.append(t)
                
        if not w_trades or not future_trades:
            continue
            
        buys = [t for t in w_trades if t.get('side') == 'buy']
        sells = [t for t in w_trades if t.get('side') == 'sell']
        vol_buy = sum(float(t.get('usd') or 0) for t in buys)
        vol_sell = sum(float(t.get('usd') or 0) for t in sells)
        vol_ratio = vol_buy / max(vol_sell, 1.0)
        
        prices_w = [float(t.get('price') or 0) for t in w_trades if float(t.get('price') or 0) > 0]
        if not prices_w:
            continue
        p_start = prices_w[0]
        p_entry = prices_w[-1]
        
        # Max pullback during window
        peak = 0
        max_dd = 0
        for p in prices_w:
            if p > peak: peak = p
            elif peak > 0:
                dd = (peak - p) / peak * 100
                if dd > max_dd: max_dd = dd
                
        max_single_sell = max([float(t.get('usd') or 0) for t in sells]) if sells else 0
        unique_wallets = len(set(t.get('wallet') for t in buys if t.get('wallet')))
        gain_w = (p_entry - p_start) / p_start * 100 if p_start > 0 else 0
        
        # Evaluate future trajectory from p_entry
        future_prices = [float(t.get('price') or 0) for t in future_trades if float(t.get('price') or 0) > 0]
        if not future_prices:
            continue
            
        outcomes = {}
        # 1. Fixed TP and SL
        for sl in sl_levels:
            outcomes[f"sl_{sl}"] = {}
            for tp in tp_levels:
                hit = None
                pnl = 0.0
                max_up = 0.0
                for p in future_prices:
                    ret = (p - p_entry) / p_entry * 100
                    if ret > max_up: max_up = ret
                    if ret >= tp:
                        hit = 'WIN'
                        pnl = float(tp)
                        break
                    if ret <= -sl:
                        hit = 'LOSS'
                        pnl = -float(sl)
                        break
                if hit is None:
                    final_ret = (future_prices[-1] - p_entry) / p_entry * 100
                    hit = 'WIN' if final_ret > 0 else 'LOSS'
                    pnl = final_ret
                outcomes[f"sl_{sl}"][f"tp_{tp}"] = {
                    'hit': hit,
                    'pnl': pnl,
                    'max_up': max_up
                }
                
        # 2. Dynamic Trailing Stop options
        # TS1: activate at +15%, trail 5%, SL -8%
        # TS2: activate at +20%, trail 6%, SL -8%
        # TS3: activate at +25%, trail 7%, SL -10%
        ts_configs = [
            ("ts_act15_trail5_sl8", 15.0, 5.0, 8.0),
            ("ts_act20_trail6_sl8", 20.0, 6.0, 8.0),
            ("ts_act25_trail7_sl10", 25.0, 7.0, 10.0),
            ("ts_act20_trail5_sl10", 20.0, 5.0, 10.0)
        ]
        outcomes_ts = {}
        for ts_name, act, trail, sl in ts_configs:
            activated = False
            cur_peak = 0.0
            hit = None
            pnl = 0.0
            for p in future_prices:
                ret = (p - p_entry) / p_entry * 100
                if ret > cur_peak:
                    cur_peak = ret
                if not activated and ret >= act:
                    activated = True
                if activated:
                    # check trailing stop
                    if (cur_peak - ret) >= trail:
                        hit = 'WIN'
                        pnl = ret
                        break
                else:
                    if ret <= -sl:
                        hit = 'LOSS'
                        pnl = -sl
                        break
            if hit is None:
                final_ret = (future_prices[-1] - p_entry) / p_entry * 100
                hit = 'WIN' if final_ret > 0 else 'LOSS'
                pnl = final_ret
            outcomes_ts[ts_name] = {'hit': hit, 'pnl': pnl, 'peak': cur_peak}
            
        token_profile['windows'][W] = {
            'features': {
                'trades_count': len(w_trades),
                'buys': len(buys),
                'sells': len(sells),
                'vol_buy': vol_buy,
                'vol_sell': vol_sell,
                'vol_ratio': vol_ratio,
                'p_entry': p_entry,
                'gain_w': gain_w,
                'max_dd': max_dd,
                'max_single_sell': max_single_sell,
                'unique_wallets': unique_wallets
            },
            'outcomes': outcomes,
            'outcomes_ts': outcomes_ts
        }
    return token_profile

def main():
    print("==================================================================")
    print("  STAIRCASE PATTERN LOOP ENGINEERING & BACKTEST ENGINE")
    print("==================================================================")
    
    cached_files = glob.glob('/home/bbliong/project/crypto-bot/data/profit4-watch/cached-mints/*.jsonl')
    active_files = glob.glob('/home/bbliong/project/crypto-bot/data/profit4-watch/active-mints/*.jsonl')
    all_files = cached_files + active_files
    print(f"Total token files to analyze: {len(all_files)} ({len(cached_files)} cached + {len(active_files)} active)")
    
    t0 = time.time()
    profiles = []
    for idx, f in enumerate(all_files):
        p = extract_token_profile(f)
        if p and p['windows']:
            profiles.append(p)
        if (idx + 1) % 25 == 0 or (idx + 1) == len(all_files):
            print(f"  Processed {idx+1}/{len(all_files)} tokens ({time.time()-t0:.1f}s)...")
            
    print(f"\nExtracted profiles for {len(profiles)} valid tokens.")
    
    # Save profiles cache
    os.makedirs('/home/bbliong/project/crypto-bot/data/profit4-watch', exist_ok=True)
    cache_path = '/home/bbliong/project/crypto-bot/data/profit4-watch/staircase-profiles.json'
    with open(cache_path, 'w') as fp:
        json.dump(profiles, fp)
    print(f"Profiles cached to {cache_path} ({os.path.getsize(cache_path)/(1024*1024):.2f} MB)")
    
    # -------------------------------------------------------------
    # GRID SEARCH / PARAMETER LOOP
    # -------------------------------------------------------------
    print("\nStarting systematic grid search across parameters...")
    
    windows = [60, 90, 120, 150, 180]
    ratios = [1.8, 2.2, 2.6, 3.0, 3.5]
    max_dds = [2.5, 3.0, 3.5, 4.5, 6.0]
    max_sells = [50.0, 100.0, 200.0, 500.0]
    min_gains = [2.0, 3.0, 4.0, 6.0]
    min_wallets = [20, 50, 100]
    
    exit_configs = [
        ("Fixed TP 15% / SL 6%", False, ("sl_6", "tp_15")),
        ("Fixed TP 20% / SL 8%", False, ("sl_8", "tp_20")),
        ("Fixed TP 25% / SL 8%", False, ("sl_8", "tp_25")),
        ("Fixed TP 30% / SL 8%", False, ("sl_8", "tp_30")),
        ("Fixed TP 30% / SL 10%", False, ("sl_10", "tp_30")),
        ("Fixed TP 40% / SL 10%", False, ("sl_10", "tp_40")),
        ("Fixed TP 50% / SL 12%", False, ("sl_12", "tp_50")),
        ("Trailing TS 15% (trail 5%, SL 8%)", True, "ts_act15_trail5_sl8"),
        ("Trailing TS 20% (trail 6%, SL 8%)", True, "ts_act20_trail6_sl8"),
        ("Trailing TS 20% (trail 5%, SL 10%)", True, "ts_act20_trail5_sl10"),
        ("Trailing TS 25% (trail 7%, SL 10%)", True, "ts_act25_trail7_sl10"),
    ]
    
    results = []
    
    for W in windows:
        for R in ratios:
            for max_dd in max_dds:
                for max_sell in max_sells:
                    for min_gain in min_gains:
                        for min_w in min_wallets:
                            # Filter tokens matching entry criteria
                            matching_tokens = []
                            for p in profiles:
                                w_data = p['windows'].get(W)
                                if not w_data: continue
                                f = w_data['features']
                                if f['vol_ratio'] < R: continue
                                if f['max_dd'] > max_dd: continue
                                if f['max_single_sell'] > max_sell: continue
                                if f['gain_w'] < min_gain: continue
                                if f['unique_wallets'] < min_w: continue
                                matching_tokens.append(w_data)
                                
                            n_tokens = len(matching_tokens)
                            if n_tokens < 15: # Statistical significance threshold
                                continue
                                
                            for exit_name, is_ts, exit_key in exit_configs:
                                wins = 0
                                losses = 0
                                total_pnl = 0.0
                                win_pnls = []
                                loss_pnls = []
                                
                                for w_data in matching_tokens:
                                    if is_ts:
                                        outcome = w_data['outcomes_ts'].get(exit_key)
                                    else:
                                        sl_k, tp_k = exit_key
                                        outcome = w_data['outcomes'].get(sl_k, {}).get(tp_k)
                                        
                                    if not outcome: continue
                                    hit = outcome['hit']
                                    pnl = outcome['pnl']
                                    total_pnl += pnl
                                    if hit == 'WIN':
                                        wins += 1
                                        win_pnls.append(pnl)
                                    else:
                                        losses += 1
                                        loss_pnls.append(pnl)
                                        
                                total_trades = wins + losses
                                if total_trades < 15: continue
                                win_rate = (wins / total_trades) * 100
                                avg_win = sum(win_pnls)/len(win_pnls) if win_pnls else 0
                                avg_loss = sum(loss_pnls)/len(loss_pnls) if loss_pnls else 0
                                profit_factor = (sum(win_pnls) / abs(sum(loss_pnls))) if loss_pnls and sum(loss_pnls) != 0 else 999.0
                                
                                results.append({
                                    'window': W,
                                    'min_ratio': R,
                                    'max_dd': max_dd,
                                    'max_single_sell': max_sell,
                                    'min_gain': min_gain,
                                    'min_wallets': min_w,
                                    'exit_name': exit_name,
                                    'trades': total_trades,
                                    'wins': wins,
                                    'losses': losses,
                                    'win_rate': win_rate,
                                    'avg_win': avg_win,
                                    'avg_loss': avg_loss,
                                    'total_pnl': total_pnl,
                                    'profit_factor': profit_factor
                                })
                                
    print(f"Total parameter combinations evaluated: {len(results):,}")
    
    # Filter for win rate >= 80%
    high_win = [r for r in results if r['win_rate'] >= 80.0]
    print(f"Combinations with Win Rate >= 80%: {len(high_win):,}")
    
    # Sort by Win Rate desc, then profit factor desc, then trades desc
    high_win.sort(key=lambda x: (x['win_rate'], x['profit_factor'], x['trades']), reverse=True)
    
    print("\n" + "="*120)
    print("TOP 15 PARAMETER CONFIGURATIONS (WIN RATE >= 80%):")
    print("="*120)
    print(f"{'WinRate':<8} | {'Trades':<8} | {'W/L':<8} | {'Window':<7} | {'Ratio':<6} | {'MaxDD':<6} | {'MaxSell':<8} | {'MinGain':<8} | {'Exit Strategy':<32} | {'ProfitFactor':<12}")
    print("-"*120)
    for r in high_win[:20]:
        wl_str = f"{r['wins']}/{r['losses']}"
        print(f"{r['win_rate']:<7.1f}% | {r['trades']:<8} | {wl_str:<8} | {r['window']}s    | {r['min_ratio']}x   | {r['max_dd']}%   | ${r['max_single_sell']:<7.0f} | +{r['min_gain']}%    | {r['exit_name']:<32} | {r['profit_factor']:<12.2f}")
        
    # Save top results to JSON
    with open('/home/bbliong/project/crypto-bot/data/profit4-watch/staircase-top-rules.json', 'w') as fp:
        json.dump(high_win[:100], fp, indent=2)
    print(f"\nTop rules saved to /home/bbliong/project/crypto-bot/data/profit4-watch/staircase-top-rules.json")

if __name__ == '__main__':
    main()
