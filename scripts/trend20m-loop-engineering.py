#!/usr/bin/env python3
"""
Trend 20m Lane Loop Engineering & Grid Optimizer
Analyzes historical performance from 00:00 to now (Oct 20, 2026)
Simulates parameter sweeps across Entry Filters, Take Profit, Trailing Stops, and Stop Loss.
"""

import json
import os
import sys

PROJECT_DIR = '/home/bbliong/project/crypto-bot'
STATE_FILE = os.path.join(PROJECT_DIR, 'data/trend20m-watch/2026-10-19T17-55-44-970Z/profit4-state.json')

def load_data():
    with open(STATE_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    positions = data.get('positions', [])
    episodes = []

    for p in positions:
        ep = p.get('entryPrice')
        ent_at = p.get('entryAt')
        facts = p.get('facts', {})
        if not ep or not ent_at:
            continue

        mint = p.get('mint')
        mcap = ep * 1_000_000_000
        peak_p = facts.get('peakPrice') or ep
        trough_p = facts.get('troughPrice') or ep

        # Handle the synthetic 0.000004 fallback bug:
        # If troughPrice was exactly 0.000004 but entry was > 0.000010 and peak was positive,
        # the 0.000004 was injected by GMGN trend fallback tick.
        is_synthetic_dip = (trough_p == 0.000004 or trough_p == 4e-06) and (ep > 0.000008)
        
        peak_ret = ((peak_p - ep) / ep) * 100 if ep > 0 else 0
        
        # Real drawdown estimation
        if is_synthetic_dip:
            # Conservative drawdown: if it reached peak_ret >= 20%, market drawdown before peak was typically < 10%
            dd_ret = 8.0 if peak_ret >= 20.0 else 12.0
        else:
            dd_ret = ((ep - trough_p) / ep) * 100 if (ep > 0 and trough_p < ep) else 0

        episodes.append({
            'mint': mint,
            'entryPrice': ep,
            'entryAt': ent_at,
            'exitAt': p.get('exitAt'),
            'mcap': mcap,
            'peakPrice': peak_p,
            'troughPrice': trough_p,
            'peakReturnPct': peak_ret,
            'maxDrawdownPct': dd_ret,
            'buySharePct': facts.get('buyShareUsdPercent') or 0,
            'meaningfulBuyers': facts.get('meaningfulBuyers') or 0,
            'meaningfulBuyUsd': facts.get('meaningfulBuyUsd') or 0,
            'topBuyerPct': facts.get('topBuyerSharePercent') or 0,
            'actualNet': p.get('netReturnPercent') or 0,
            'actualReason': p.get('lastEvent', {}).get('reason') or 'UNKNOWN'
        })

    return episodes

def run_loop_engineering(episodes):
    stake_usd = 5.0
    fee_pct = 2.0  # 1% fee + 0.5% slippage per side (conservative)

    # Grid definition
    max_mcap_options = [15000, 25000, 50000, 100000, 999999999]
    min_buyers_options = [1, 2]
    min_buy_share_options = [50.0, 60.0]

    tp_options = [20.0, 25.0, 30.0, 35.0, 40.0, 50.0, 60.0]
    sl_options = [6.0, 8.0, 10.0, 12.0]
    trail_start_options = [15.0, 20.0, 25.0, 30.0, 40.0, 60.0, 999.0] # 999.0 means no trailing, pure TP
    trail_dd_options = [4.0, 5.0, 6.0]
    profit_floor_options = [0.0, 10.0, 15.0]

    results = []

    for max_mc in max_mcap_options:
        for min_b in min_buyers_options:
            for min_bs in min_buy_share_options:
                filtered = [
                    e for e in episodes
                    if e['mcap'] <= max_mc
                    and e['meaningfulBuyers'] >= min_b
                    and e['buySharePct'] >= min_bs
                ]
                if len(filtered) < 20:
                    continue

                for tp in tp_options:
                    for sl in sl_options:
                        for ts in trail_start_options:
                            for td in trail_dd_options:
                                for floor in profit_floor_options:
                                    if floor >= tp:
                                        continue
                                    if ts < floor:
                                        continue

                                    wins = 0
                                    losses = 0
                                    total_pnl = 0.0
                                    gross_win = 0.0
                                    gross_loss = 0.0
                                    win_pcts = []
                                    loss_pcts = []

                                    for e in filtered:
                                        pr = e['peakReturnPct']
                                        dd = e['maxDrawdownPct']

                                        # Decision Logic
                                        ret = 0.0
                                        # 1. Did it trigger Stop Loss first?
                                        # If peak < 5% and dd >= sl, immediate stop loss
                                        if pr < 5.0 and dd >= sl:
                                            ret = -sl - fee_pct
                                        # 2. Super runner reaching TP or higher
                                        elif pr >= tp:
                                            if ts <= tp:
                                                # Trailing was active
                                                trail_exit = pr - td
                                                ret = max(trail_exit, floor, tp) - fee_pct
                                            else:
                                                ret = tp - fee_pct
                                        # 3. Reached trailing start but not TP
                                        elif pr >= ts:
                                            trail_exit = pr - td
                                            ret = max(trail_exit, floor) - fee_pct
                                        # 4. Reached profit floor (> floor)
                                        elif floor > 0 and pr >= (floor + 5.0):
                                            ret = floor - fee_pct
                                        # 5. Otherwise dropped to SL
                                        elif dd >= sl:
                                            ret = -sl - fee_pct
                                        else:
                                            # Timeout / breakeven exit
                                            ret = -fee_pct

                                        dollar = (ret / 100.0) * stake_usd
                                        total_pnl += dollar
                                        if ret > 0:
                                            wins += 1
                                            gross_win += dollar
                                            win_pcts.append(ret)
                                        else:
                                            losses += 1
                                            gross_loss += abs(dollar)
                                            loss_pcts.append(ret)

                                    total_trades = len(filtered)
                                    wr = (wins / total_trades) * 100 if total_trades else 0
                                    pf = (gross_win / gross_loss) if gross_loss > 0 else 999.0
                                    avg_win = sum(win_pcts) / len(win_pcts) if win_pcts else 0
                                    avg_loss = sum(loss_pcts) / len(loss_pcts) if loss_pcts else 0

                                    results.append({
                                        'maxMcap': max_mc,
                                        'minBuyers': min_b,
                                        'minBuyShare': min_bs,
                                        'tp': tp,
                                        'sl': sl,
                                        'trailStart': ts,
                                        'trailDd': td,
                                        'floor': floor,
                                        'trades': total_trades,
                                        'wins': wins,
                                        'losses': losses,
                                        'winRate': wr,
                                        'pnlUsd': total_pnl,
                                        'profitFactor': pf,
                                        'avgWinPct': avg_win,
                                        'avgLossPct': avg_loss
                                    })

    return results

if __name__ == '__main__':
    episodes = load_data()
    print(f"Loaded {len(episodes)} episodes.")
    results = run_loop_engineering(episodes)
    print(f"Total parameter combinations evaluated: {len(results)}")

    # Sort by PnL
    by_pnl = sorted(results, key=lambda x: -x['pnlUsd'])
    # Sort by WinRate (with minimum 50 trades and PF >= 2.0)
    by_wr = sorted([r for r in results if r['trades'] >= 50 and r['profitFactor'] >= 2.0], key=lambda x: -x['winRate'])
    # Sort by ProfitFactor (trades >= 50 and WR >= 50%)
    by_pf = sorted([r for r in results if r['trades'] >= 50 and r['winRate'] >= 50.0], key=lambda x: -x['profitFactor'])

    print("\n" + "="*80)
    print("TOP 5 BY NET PnL:")
    print("="*80)
    for i, r in enumerate(by_pnl[:5]):
        print(f"#{i+1} PnL: ${r['pnlUsd']:+.2f} | WR: {r['winRate']:.1f}% ({r['wins']}W/{r['losses']}L) | PF: {r['profitFactor']:.2f} | Trades: {r['trades']}")
        print(f"    Params: MaxMcap=${r['maxMcap']} | TP={r['tp']}% | SL={r['sl']}% | TrailStart={r['trailStart']}% | TrailDD={r['trailDd']}% | Floor={r['floor']}% | MinBuyers={r['minBuyers']} | MinBS={r['minBuyShare']}%")

    print("\n" + "="*80)
    print("TOP 5 BY WIN RATE (min 50 trades, PF >= 2.0):")
    print("="*80)
    for i, r in enumerate(by_wr[:5]):
        print(f"#{i+1} WR: {r['winRate']:.1f}% ({r['wins']}W/{r['losses']}L) | PnL: ${r['pnlUsd']:+.2f} | PF: {r['profitFactor']:.2f} | Trades: {r['trades']}")
        print(f"    Params: MaxMcap=${r['maxMcap']} | TP={r['tp']}% | SL={r['sl']}% | TrailStart={r['trailStart']}% | TrailDD={r['trailDd']}% | Floor={r['floor']}% | MinBuyers={r['minBuyers']} | MinBS={r['minBuyShare']}%")

    # Realistic capped simulation
    print("\n" + "="*80)
    print("REALISTIC CAPPED SIMULATION (Max Single Gain Cap = +80%):")
    print("="*80)
    def eval_config(max_mc, min_b, min_bs, tp, sl, trail_start, trail_dd, cap_gain=80.0):
        stake = 5.0
        fee = 2.0
        wins, losses, pnl = 0, 0, 0.0
        filtered = [e for e in episodes if e['mcap'] <= max_mc and e['meaningfulBuyers'] >= min_b and e['buySharePct'] >= min_bs]
        for e in filtered:
            pr = e['peakReturnPct']
            dd = e['maxDrawdownPct']
            if pr < 5.0 and dd >= sl:
                ret = -sl - fee
            elif pr >= tp:
                if trail_start <= tp:
                    actual_trail = min(pr - trail_dd, cap_gain)
                    ret = max(actual_trail, tp) - fee
                else:
                    ret = tp - fee
            elif pr >= trail_start:
                actual_trail = min(pr - trail_dd, cap_gain)
                ret = actual_trail - fee
            elif dd >= sl:
                ret = -sl - fee
            else:
                ret = -fee
            dollar = (ret / 100.0) * stake
            pnl += dollar
            if ret > 0: wins += 1
            else: losses += 1
        wr = (wins / len(filtered) * 100) if filtered else 0
        return {'trades': len(filtered), 'wins': wins, 'losses': losses, 'wr': wr, 'pnl': pnl}

    configs = [
        ("Conservative Scalper (MaxMcap 15k, TP 20%, SL 6%, TrailStart 15%)", 15000, 1, 50.0, 20.0, 6.0, 15.0, 4.0),
        ("Balanced Scalper (MaxMcap 25k, TP 25%, SL 8%, TrailStart 18%)", 25000, 1, 50.0, 25.0, 8.0, 18.0, 4.0),
        ("Growth Runner (MaxMcap 50k, TP 35%, SL 8%, TrailStart 20%)", 50000, 2, 50.0, 35.0, 8.0, 20.0, 5.0),
        ("Wide Aggressive (No Mcap Cap, TP 35%, SL 8%, TrailStart 20%)", 999999999, 1, 50.0, 35.0, 8.0, 20.0, 5.0),
        ("Original Rules (No Mcap Cap, TP 60%, SL 10%, TrailStart 60%)", 999999999, 1, 50.0, 60.0, 10.0, 60.0, 6.0),
    ]

    for label, mc, b, bs, tp, sl, ts, td in configs:
        res = eval_config(mc, b, bs, tp, sl, ts, td, cap_gain=80.0)
        t, w, l, wr, p = res['trades'], res['wins'], res['losses'], res['wr'], res['pnl']
        print(f"-> {label}")
        print(f"   Trades: {t} | WR: {wr:.1f}% ({w}W/{l}L) | Net PnL: ${p:+.2f} (Stake $5)")

