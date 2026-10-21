#!/usr/bin/env python3
"""
Deep Analysis of Trend 20m Historical Performance & Parameters
Data source: data/trend20m-watch/2026-10-20T22-06-10-886Z/profit4-state.json
"""

import json
import os
import sys

STATE_FILE = '/home/bbliong/project/crypto-bot/data/trend20m-watch/2026-10-20T22-06-10-886Z/profit4-state.json'

def main():
    with open(STATE_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)

    pos = data.get('positions', [])

    tokens = {}
    for p in pos:
        if not p.get('entryAt'):
            continue
        m = p['mint']
        if m not in tokens:
            f = p.get('facts', {})
            ep = p['entryPrice']
            peak = f.get('peakPrice') or ep
            trough = f.get('troughPrice') or ep
            pr = ((peak - ep) / ep) * 100 if ep else 0
            dd = ((ep - trough) / ep) * 100 if ep else 0
            tokens[m] = {
                'mint': m,
                'symbol': p.get('symbol', m[:8]),
                'mcap': p.get('marketCapUsd') or (ep * 1e9 if ep else 0),
                'entryPrice': ep,
                'peakPrice': peak,
                'troughPrice': trough,
                'peakReturn': pr,
                'maxDrawdown': dd,
                'buyShare': f.get('buyShareUsdPercent'),
                'buyers': f.get('meaningfulBuyers'),
                'buyUsd': f.get('meaningfulBuyUsd'),
                'topBuyerShare': f.get('topBuyerSharePercent'),
                'lanes': {}
            }
        tokens[m]['lanes'][p['laneLabel']] = {
            'pnl': p.get('pnlUsd'),
            'net': p.get('netReturnPercent'),
            'reason': p.get('lastEvent', {}).get('reason')
        }

    total_tokens = len(tokens)
    print("=" * 80)
    print(f"ANOLISIS DATASET TREND 20M (TOTAL TOKEN MASUK: {total_tokens})")
    print("=" * 80)

    # 1. Distribusi Peak Return
    p_over_50 = [t for t in tokens.values() if t['peakReturn'] >= 50]
    p_20_50 = [t for t in tokens.values() if 20 <= t['peakReturn'] < 50]
    p_10_20 = [t for t in tokens.values() if 10 <= t['peakReturn'] < 20]
    p_5_10 = [t for t in tokens.values() if 5 <= t['peakReturn'] < 10]
    p_under_5 = [t for t in tokens.values() if t['peakReturn'] < 5]

    syms_over_50 = [t['symbol'] for t in p_over_50]
    syms_20_50 = [t['symbol'] for t in p_20_50]

    print(f"1. Distribusi Peak Return:")
    print(f"  • Peak >= +50% : {len(p_over_50)} token ({len(p_over_50)/total_tokens*100:.1f}%) -> {', '.join(syms_over_50)}")
    print(f"  • Peak +20-50% : {len(p_20_50)} token ({len(p_20_50)/total_tokens*100:.1f}%) -> {', '.join(syms_20_50)}")
    print(f"  • Peak +10-20% : {len(p_10_20)} token ({len(p_10_20)/total_tokens*100:.1f}%)")
    print(f"  • Peak +5-10%  : {len(p_5_10)} token ({len(p_5_10)/total_tokens*100:.1f}%)")
    print(f"  • Peak < +5%   : {len(p_under_5)} token ({len(p_under_5)/total_tokens*100:.1f}%)")

    # 2. Korelasi BuyShare
    print("\n2. Korelasi Buy Share USD %:")
    for b_thresh in [30, 45, 50, 60]:
        valid = [t for t in tokens.values() if t['buyShare'] is not None and t['buyShare'] >= b_thresh]
        invalid = [t for t in tokens.values() if t['buyShare'] is not None and t['buyShare'] < b_thresh]
        v_peaks = [t['peakReturn'] for t in valid]
        inv_peaks = [t['peakReturn'] for t in invalid] if invalid else [0]
        avg_v = sum(v_peaks)/len(v_peaks) if valid else 0
        avg_inv = sum(inv_peaks)/len(inv_peaks) if invalid else 0
        print(f"  • BuyShare >= {b_thresh}%: {len(valid)} token (Avg Peak +{avg_v:.1f}%) | < {b_thresh}%: {len(invalid)} token (Avg Peak +{avg_inv:.1f}%)")

    # 3. Korelasi Meaningful Buyers
    print("\n3. Korelasi Meaningful Buyers:")
    for buy_cnt in [2, 5, 10, 20]:
        valid = [t for t in tokens.values() if t['buyers'] is not None and t['buyers'] >= buy_cnt]
        invalid = [t for t in tokens.values() if t['buyers'] is not None and t['buyers'] < buy_cnt]
        v_peaks = [t['peakReturn'] for t in valid]
        inv_peaks = [t['peakReturn'] for t in invalid] if invalid else [0]
        avg_v = sum(v_peaks)/len(v_peaks) if valid else 0
        avg_inv = sum(inv_peaks)/len(inv_peaks) if invalid else 0
        print(f"  • Buyers >= {buy_cnt}: {len(valid)} token (Avg Peak +{avg_v:.1f}%) | < {buy_cnt}: {len(invalid)} token (Avg Peak +{avg_inv:.1f}%)")

    # 4. Korelasi Market Cap
    print("\n4. Korelasi Market Cap:")
    mc_under_50k = [t for t in tokens.values() if t['mcap'] < 50000]
    mc_50k_200k = [t for t in tokens.values() if 50000 <= t['mcap'] < 200000]
    mc_200k_1m = [t for t in tokens.values() if 200000 <= t['mcap'] < 1000000]
    mc_over_1m = [t for t in tokens.values() if t['mcap'] >= 1000000]

    for label, group in [("Mcap < $50k", mc_under_50k), ("$50k - $200k", mc_50k_200k), ("$200k - $1M", mc_200k_1m), (">= $1M", mc_over_1m)]:
        peaks = [t['peakReturn'] for t in group]
        avg_p = sum(peaks)/len(peaks) if group else 0
        print(f"  • {label:15}: {len(group):2} token | Avg Peak +{avg_p:.1f}%")

if __name__ == '__main__':
    main()
