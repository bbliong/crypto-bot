#!/usr/bin/env python3
"""
Trend 20m Loop Engineering Engine v2
Comprehensive Parameter Optimization across 36 Live GMGN Trend Pairs (Oct 20-21, 2026)
Simulates Entry Filters, Stop Loss, Trailing Profit, Take Profit, and Max Hold with 2.5% Friction
"""

import json
import glob
import os
import sys

PROJECT_DIR = '/home/bbliong/project/crypto-bot'
STATE_FILE = os.path.join(PROJECT_DIR, 'data/trend20m-watch/2026-10-20T22-06-10-886Z/profit4-state.json')
CHUNKS_DIR = os.path.join(PROJECT_DIR, 'data/trend20m-watch/2026-10-20T22-06-10-886Z/chunks')

def load_episodes():
    if not os.path.exists(STATE_FILE):
        print(f"Error: State file not found: {STATE_FILE}")
        sys.exit(1)

    with open(STATE_FILE, 'r', encoding='utf-8') as f:
        state = json.load(f)

    # Collect unique entered tokens
    unique_tokens = {}
    for p in state.get('positions', []):
        if not p.get('entryAt') or not p.get('entryPrice'):
            continue
        m = p['mint']
        if m not in unique_tokens:
            f_facts = p.get('facts', {})
            ep = p['entryPrice']
            peak = f_facts.get('peakPrice') or ep
            trough = f_facts.get('troughPrice') or ep
            unique_tokens[m] = {
                'mint': m,
                'symbol': p.get('symbol', m[:8]),
                'entryAt': p['entryAt'],
                'entryPrice': ep,
                'peakPrice': peak,
                'troughPrice': trough,
                'mcap': p.get('marketCapUsd') or (ep * 1e9),
                'buyShare': f_facts.get('buyShareUsdPercent') or 0.0,
                'meaningfulBuyers': f_facts.get('meaningfulBuyers') or 0,
                'meaningfulBuyUsd': f_facts.get('meaningfulBuyUsd') or 0,
                'topBuyerShare': f_facts.get('topBuyerSharePercent') or 0.0,
                'ticks': []
            }

    # Load ticks from chunks
    chunk_files = sorted(glob.glob(os.path.join(CHUNKS_DIR, '*/profit4-events.jsonl')))
    for cf in chunk_files:
        with open(cf, 'r', encoding='utf-8') as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    e = json.loads(line)
                    m = e.get('mint')
                    if m in unique_tokens:
                        ts = e.get('observedAt')
                        facts = e.get('facts') or {}
                        p_val = e.get('priceUsd') or facts.get('price')
                        if ts and p_val and ts >= unique_tokens[m]['entryAt']:
                            unique_tokens[m]['ticks'].append((ts, p_val))
                except:
                    continue

    # Sort ticks chronologically
    for t in unique_tokens.values():
        t['ticks'].sort(key=lambda x: x[0])

    return list(unique_tokens.values())

def simulate_strategy(episodes, min_buy_share, min_buyers, min_mcap, max_mcap,
                      sl_pct, tp_pct, trail_start_pct, trail_pullback_pct, max_hold_sec,
                      fee_pct=2.5, stake_usd=5.0):
    trades = 0
    wins = 0
    losses = 0
    total_pnl = 0.0
    gross_win = 0.0
    gross_loss = 0.0
    win_pcts = []
    loss_pcts = []
    trade_details = []

    for ep in episodes:
        # 1. Entry Filter Gating
        if min_buy_share > 0 and ep['buyShare'] < min_buy_share:
            continue
        if min_buyers > 0 and ep['meaningfulBuyers'] < min_buyers:
            continue
        if min_mcap > 0 and ep['mcap'] < min_mcap:
            continue
        if max_mcap > 0 and ep['mcap'] > max_mcap:
            continue

        trades += 1
        entry_price = ep['entryPrice']
        entry_at = ep['entryAt']
        ticks = ep['ticks']

        # Simulation state
        peak_seen = entry_price
        exit_price = None
        exit_reason = None
        exit_at = None

        if len(ticks) > 0:
            for ts, cur_price in ticks:
                hold_sec = (ts - entry_at) / 1000.0
                if cur_price > peak_seen:
                    peak_seen = cur_price

                gross_ret = ((cur_price - entry_price) / entry_price) * 100.0
                peak_ret = ((peak_seen - entry_price) / entry_price) * 100.0

                # A. Stop Loss
                if gross_ret <= -sl_pct:
                    exit_price = cur_price
                    exit_reason = 'STOP_LOSS'
                    exit_at = ts
                    break

                # B. Take Profit
                if gross_ret >= tp_pct:
                    exit_price = cur_price
                    exit_reason = 'TAKE_PROFIT'
                    exit_at = ts
                    break

                # C. Trailing Stop
                if trail_start_pct < 900 and peak_ret >= trail_start_pct:
                    drawdown = peak_ret - gross_ret
                    if drawdown >= trail_pullback_pct:
                        exit_price = cur_price
                        exit_reason = 'TRAILING_PROFIT'
                        exit_at = ts
                        break

                # D. Max Hold Timeout
                if hold_sec >= max_hold_sec:
                    exit_price = cur_price
                    exit_reason = 'MAX_HOLD'
                    exit_at = ts
                    break

        # Fallback to terminal facts if ticks didn't trigger exit
        if exit_price is None:
            peak_ret = ((ep['peakPrice'] - entry_price) / entry_price) * 100.0
            trough_ret = ((ep['troughPrice'] - entry_price) / entry_price) * 100.0

            if peak_ret >= tp_pct:
                exit_price = entry_price * (1.0 + tp_pct / 100.0)
                exit_reason = 'TAKE_PROFIT_PEAK'
            elif trail_start_pct < 900 and peak_ret >= trail_start_pct:
                trail_price = ep['peakPrice'] * (1.0 - trail_pullback_pct / 100.0)
                exit_price = max(trail_price, entry_price * 1.02)
                exit_reason = 'TRAILING_PROFIT_PEAK'
            elif trough_ret <= -sl_pct:
                exit_price = entry_price * (1.0 - sl_pct / 100.0)
                exit_reason = 'STOP_LOSS_FALLBACK'
            else:
                # Flat exit
                exit_price = ep['troughPrice']
                exit_reason = 'TIMED_EXIT'

        # Financial Calculations (with realistic roundtrip friction fee_pct)
        gross_return_pct = ((exit_price - entry_price) / entry_price) * 100.0
        net_return_pct = gross_return_pct - fee_pct
        pnl_usd = (net_return_pct / 100.0) * stake_usd

        total_pnl += pnl_usd
        if net_return_pct > 0:
            wins += 1
            gross_win += pnl_usd
            win_pcts.append(net_return_pct)
        else:
            losses += 1
            gross_loss += abs(pnl_usd)
            loss_pcts.append(net_return_pct)

        trade_details.append({
            'symbol': ep['symbol'],
            'mint': ep['mint'],
            'mcap': ep['mcap'],
            'entryPrice': entry_price,
            'exitPrice': exit_price,
            'grossReturnPct': gross_return_pct,
            'netReturnPct': net_return_pct,
            'pnlUsd': pnl_usd,
            'reason': exit_reason
        })

    win_rate = (wins / trades * 100.0) if trades > 0 else 0.0
    profit_factor = (gross_win / gross_loss) if gross_loss > 0 else (999.0 if gross_win > 0 else 0.0)
    avg_win = (sum(win_pcts) / len(win_pcts)) if win_pcts else 0.0
    avg_loss = (sum(loss_pcts) / len(loss_pcts)) if loss_pcts else 0.0
    expected_value = (total_pnl / trades) if trades > 0 else 0.0

    return {
        'minBuyShare': min_buy_share,
        'minBuyers': min_buyers,
        'minMcap': min_mcap,
        'maxMcap': max_mcap,
        'sl': sl_pct,
        'tp': tp_pct,
        'trailStart': trail_start_pct,
        'trailPullback': trail_pullback_pct,
        'maxHold': max_hold_sec,
        'trades': trades,
        'wins': wins,
        'losses': losses,
        'winRate': win_rate,
        'totalPnlUsd': total_pnl,
        'profitFactor': profit_factor,
        'avgWinPct': avg_win,
        'avgLossPct': avg_loss,
        'expectedValue': expected_value,
        'tradeDetails': trade_details
    }

def run_loop_engineering():
    episodes = load_episodes()
    print(f"Loaded {len(episodes)} episodes with full tick series and facts.")

    # Grid definition
    min_buy_shares = [0.0, 40.0, 50.0, 55.0, 60.0]
    min_buyers_list = [1, 2, 5, 10]
    min_mcaps = [10000, 20000, 50000]
    max_mcaps = [0, 500000, 1000000] # 0 = unlimited

    sl_options = [5.0, 7.0, 8.0, 10.0, 12.0]
    tp_options = [20.0, 25.0, 30.0, 35.0, 40.0, 50.0]
    trail_start_options = [10.0, 12.0, 15.0, 18.0, 20.0, 25.0, 999.0]
    trail_pullback_options = [2.0, 3.0, 4.0]
    max_hold_options = [900, 1800, 2700]

    total_combos = (len(min_buy_shares) * len(min_buyers_list) * len(min_mcaps) * len(max_mcaps) *
                    len(sl_options) * len(tp_options) * len(trail_start_options) *
                    len(trail_pullback_options) * len(max_hold_options))
    print(f"Evaluating {total_combos:,} parameter combinations...")

    results = []
    combo_count = 0

    for mbs in min_buy_shares:
        for mb in min_buyers_list:
            for min_mc in min_mcaps:
                for max_mc in max_mcaps:
                    for sl in sl_options:
                        for tp in tp_options:
                            for ts in trail_start_options:
                                for tpb in trail_pullback_options:
                                    for mh in max_hold_options:
                                        combo_count += 1
                                        res = simulate_strategy(
                                            episodes,
                                            min_buy_share=mbs,
                                            min_buyers=mb,
                                            min_mcap=min_mc,
                                            max_mcap=max_mc,
                                            sl_pct=sl,
                                            tp_pct=tp,
                                            trail_start_pct=ts,
                                            trail_pullback_pct=tpb,
                                            max_hold_sec=mh
                                        )
                                        # Only retain meaningful configurations with >= 10 trades
                                        if res['trades'] >= 10:
                                            # remove tradeDetails from list to save memory
                                            details = res.pop('tradeDetails')
                                            results.append((res, details))

    print(f"Evaluated {combo_count:,} combinations. Valid qualifying results (trades >= 10): {len(results):,}")

    # Baseline comparison (Current live settings: SL 6-8%, TP 20-35%, Trail 15-20%, Buyers 1, BuyShare 50%)
    baseline = simulate_strategy(
        episodes,
        min_buy_share=50.0,
        min_buyers=1,
        min_mcap=10000,
        max_mcap=0,
        sl_pct=8.0,
        tp_pct=25.0,
        trail_start_pct=18.0,
        trail_pullback_pct=4.0,
        max_hold_sec=2700
    )

    print("\n" + "=" * 90)
    print("BASELINE LIVE SETTINGS (T-Bal equivalent: SL 8%, TP 25%, Trail 18%/4%, Buyers 1, BuyShare 50%)")
    print("=" * 90)
    print(f"Trades: {baseline['trades']} | Win Rate: {baseline['winRate']:.1f}% | Net PnL: ${baseline['totalPnlUsd']:.2f} | PF: {baseline['profitFactor']:.2f} | EV: ${baseline['expectedValue']:.2f}/trade")

    # Sort results
    # 1. Best PnL with WinRate >= 50%
    sorted_by_pnl = sorted([r for r in results if r[0]['winRate'] >= 50.0], key=lambda x: -x[0]['totalPnlUsd'])

    # 2. Best Profit Factor with WinRate >= 60%
    sorted_by_pf = sorted([r for r in results if r[0]['winRate'] >= 60.0 and r[0]['trades'] >= 12], key=lambda x: -x[0]['profitFactor'])

    print("\n" + "=" * 90)
    print("TOP 5 STRATEGIES BY NET PnL (Win Rate >= 50%):")
    print("=" * 90)
    for idx, (r, det) in enumerate(sorted_by_pnl[:5], 1):
        mcap_max_str = f"${r['maxMcap']:,}" if r['maxMcap'] > 0 else 'Unl'
        print(f"#{idx} PnL: ${r['totalPnlUsd']:+.2f} | WR: {r['winRate']:.1f}% ({r['wins']}/{r['trades']}) | PF: {r['profitFactor']:.2f} | EV: ${r['expectedValue']:+.2f}/trade")
        print(f"   Filters: BuyShare >= {r['minBuyShare']}% | Buyers >= {r['minBuyers']} | Mcap: ${r['minMcap']:,} - {mcap_max_str}")
        print(f"   Exits  : SL: -{r['sl']}% | TP: +{r['tp']}% | Trail: +{r['trailStart']}% / -{r['trailPullback']}% | Hold: {r['maxHold']}s")
        print("-" * 90)

    print("\n" + "=" * 90)
    print("TOP 5 HIGH-WINRATE / HIGH-PROFIT-FACTOR STRATEGIES (Win Rate >= 60%, Trades >= 12):")
    print("=" * 90)
    for idx, (r, det) in enumerate(sorted_by_pf[:5], 1):
        mcap_max_str = f"${r['maxMcap']:,}" if r['maxMcap'] > 0 else 'Unl'
        print(f"#{idx} PF: {r['profitFactor']:.2f} | WR: {r['winRate']:.1f}% ({r['wins']}/{r['trades']}) | PnL: ${r['totalPnlUsd']:+.2f} | EV: ${r['expectedValue']:+.2f}/trade")
        print(f"   Filters: BuyShare >= {r['minBuyShare']}% | Buyers >= {r['minBuyers']} | Mcap: ${r['minMcap']:,} - {mcap_max_str}")
        print(f"   Exits  : SL: -{r['sl']}% | TP: +{r['tp']}% | Trail: +{r['trailStart']}% / -{r['trailPullback']}% | Hold: {r['maxHold']}s")
        print("-" * 90)

    # Save champion result
    champion_res, champion_details = sorted_by_pnl[0]
    output_data = {
        'generatedAt': '2026-10-21T15:40:00.000Z',
        'totalEpisodes': len(episodes),
        'totalCombinationsEvaluated': total_combos,
        'baseline': {
            'label': 'Baseline Live T-Bal (Current)',
            'trades': baseline['trades'],
            'wins': baseline['wins'],
            'losses': baseline['losses'],
            'winRate': baseline['winRate'],
            'totalPnlUsd': baseline['totalPnlUsd'],
            'profitFactor': baseline['profitFactor'],
            'expectedValue': baseline['expectedValue']
        },
        'champion': champion_res,
        'championDetails': champion_details,
        'topStrategies': [r[0] for r in sorted_by_pnl[:10]]
    }

    out_file = os.path.join(PROJECT_DIR, 'data', 'trend20m-optimization-results.json')
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, indent=2)
    print(f"\nSaved optimization results to: {out_file}")

if __name__ == '__main__':
    run_loop_engineering()
