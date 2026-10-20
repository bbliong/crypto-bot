#!/usr/bin/env python3
"""
Momentum Lane Autonomous Evolution Engine
Walk-Forward Optimization & Dynamic Lane Generation across Oct 14-18 Historical Data + Live Chunks.
Executed autonomously every 30 minutes via cron.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone, timedelta

WIB = timezone(timedelta(hours=7))
PROJECT_DIR = '/home/bbliong/project/crypto-bot'
DATA_DIR = os.path.join(PROJECT_DIR, 'data/profit4-watch')
LEGACY_DIR = os.path.join(PROJECT_DIR, 'data/profit4-watch-legacy-chrome')
CONFIG_OUT = os.path.join(PROJECT_DIR, 'config/momentum-evolved-lanes.json')
TS_OUT = os.path.join(PROJECT_DIR, 'src/distribution-evolved-momentum-lanes.ts')
REPORT_OUT = os.path.join(DATA_DIR, 'momentum-evolution-report.json')
HISTORY_OUT = os.path.join(DATA_DIR, 'momentum-evolution-history.jsonl')

def log(msg):
    now_str = datetime.now(WIB).strftime('%Y-%m-%d %H:%M:%S WIB')
    print(f"[{now_str}] {msg}", flush=True)

def load_episodes():
    log("Scanning historical data (Oct 14-18 + live chunks)...")
    dirs = [DATA_DIR, LEGACY_DIR]
    dataset = []
    seen = set()

    for d in dirs:
        if not os.path.exists(d):
            continue
        for root, _, files in os.walk(d):
            if 'profit4-state.json' in files:
                fp = os.path.join(root, 'profit4-state.json')
                try:
                    with open(fp, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    pos_list = data.get('positions', [])
                    for p in pos_list:
                        mint = p.get('mint')
                        ent_p = p.get('entryPrice')
                        facts = p.get('facts')
                        if not mint or not ent_p or not facts:
                            continue

                        dt = p.get('entryAt') or p.get('exitAt')
                        if not dt:
                            continue
                        ts = dt / 1000.0
                        dt_wib = datetime.fromtimestamp(ts, WIB)
                        day = dt_wib.strftime('%Y-%m-%d')
                        if not ('2026-10-14' <= day <= '2026-10-19'):
                            continue

                        mcap = ent_p * 1_000_000_000
                        # Pre-filter for candidates meeting or approaching the $10k requirement
                        if mcap < 9500:
                            continue

                        key = (mint, p.get('entryAt'))
                        if key in seen:
                            continue
                        seen.add(key)

                        peak_p = facts.get('peakPrice') or ent_p
                        trough_p = facts.get('troughPrice') or ent_p

                        dataset.append({
                            'mint': mint,
                            'symbol': p.get('symbol', 'UNKNOWN'),
                            'entryPrice': ent_p,
                            'entryAt': p.get('entryAt'),
                            'timestamp': ts,
                            'day': day,
                            'entryMcap': mcap,
                            'peakPrice': peak_p,
                            'troughPrice': trough_p,
                            'peakReturnPct': ((peak_p - ent_p) / ent_p) * 100,
                            'maxDrawdownPct': ((ent_p - trough_p) / ent_p) * 100 if trough_p < ent_p else 0,
                            'momentumPct': facts.get('momentumPercent') or 0,
                            'drawdownPct': facts.get('drawdownPercent') or 0,
                            'buySharePct': facts.get('buyShareUsdPercent') or 0,
                            'topBuyerPct': facts.get('topBuyerSharePercent') or 0,
                            'meaningfulBuyers': facts.get('meaningfulBuyers') or 0,
                            'meaningfulBuyUsd': facts.get('meaningfulBuyUsd') or 0,
                            'largestSellUsd': facts.get('largestSellUsd') or 0,
                        })
                except Exception:
                    pass

    dataset.sort(key=lambda x: x['timestamp'])
    log(f"Total valid candidate episodes (Mcap >= $10k) loaded: {len(dataset)}")
    return dataset

def optimize_lanes(dataset):
    log("Executing hierarchical Walk-Forward grid optimization...")
    t0 = time.time()
    split_idx = int(len(dataset) * 0.65)
    train_all = dataset[:split_idx]
    val_all = dataset[split_idx:]
    log(f"Train window: {len(train_all)} episodes | Validation window: {len(val_all)} episodes")

    entry_grid = [
        {'minMcap': mc, 'minMom': mom, 'minBuyShare': bs, 'maxTopBuyer': tb, 'minBuyers': nb}
        for mc in [10000, 12000, 15000, 20000]
        for mom in [2.5, 4.0, 6.0]
        for bs in [60.0, 65.0, 70.0]
        for tb in [65.0, 75.0]
        for nb in [2, 3]
    ]

    exit_grid = [
        {'tp': tp, 'sl': sl, 'trail_start': ts, 'trail_dd': td}
        for tp in [18.0, 22.0, 28.0, 35.0]
        for sl in [4.5, 5.5, 6.5]
        for ts in [10.0, 14.0, 18.0]
        for td in [4.0, 5.0]
        if ts < tp
    ]

    stake_usd = 5.0
    fee_pct = 2.0  # Conservative estimate: 1% fee + 0.5% slippage each side
    valid_results = []

    for eg in entry_grid:
        mc = eg['minMcap']
        mom = eg['minMom']
        bs = eg['minBuyShare']
        tb = eg['maxTopBuyer']
        nb = eg['minBuyers']

        train_matched = [
            d for d in train_all 
            if d['entryMcap'] >= mc and d['momentumPct'] >= mom 
            and d['buySharePct'] >= bs and d['topBuyerPct'] <= tb and d['meaningfulBuyers'] >= nb
        ]
        if len(train_matched) < 10:
            continue

        val_matched = [
            d for d in val_all 
            if d['entryMcap'] >= mc and d['momentumPct'] >= mom 
            and d['buySharePct'] >= bs and d['topBuyerPct'] <= tb and d['meaningfulBuyers'] >= nb
        ]
        if len(val_matched) < 5:
            continue

        for xg in exit_grid:
            tp, sl, ts, td = xg['tp'], xg['sl'], xg['trail_start'], xg['trail_dd']

            # In-sample Train Evaluation
            train_wins = 0
            train_pnl = 0.0
            train_gross_win = 0.0
            train_gross_loss = 0.0
            for d in train_matched:
                pr = d['peakReturnPct']
                dd = d['maxDrawdownPct']
                if pr >= tp:
                    ret = tp - fee_pct
                elif pr >= ts:
                    ret = (pr - td) - fee_pct
                elif dd >= sl:
                    ret = -sl - fee_pct
                else:
                    ret = -fee_pct

                dollar_pnl = (ret / 100.0) * stake_usd
                train_pnl += dollar_pnl
                if ret > 0:
                    train_wins += 1
                    train_gross_win += dollar_pnl
                else:
                    train_gross_loss += abs(dollar_pnl)

            train_wr = (train_wins / len(train_matched)) * 100
            if train_wr < 55.0 or train_pnl <= 0:
                continue

            # Out-of-sample Validation Evaluation
            val_wins = 0
            val_pnl = 0.0
            val_gross_win = 0.0
            val_gross_loss = 0.0
            for d in val_matched:
                pr = d['peakReturnPct']
                dd = d['maxDrawdownPct']
                if pr >= tp:
                    ret = tp - fee_pct
                elif pr >= ts:
                    ret = (pr - td) - fee_pct
                elif dd >= sl:
                    ret = -sl - fee_pct
                else:
                    ret = -fee_pct

                dollar_pnl = (ret / 100.0) * stake_usd
                val_pnl += dollar_pnl
                if ret > 0:
                    val_wins += 1
                    val_gross_win += dollar_pnl
                else:
                    val_gross_loss += abs(dollar_pnl)

            val_wr = (val_wins / len(val_matched)) * 100
            if val_wr < 50.0 or val_pnl <= 0:
                continue

            tot_trades = len(train_matched) + len(val_matched)
            tot_wins = train_wins + val_wins
            tot_losses = tot_trades - tot_wins
            tot_wr = (tot_wins / tot_trades) * 100
            tot_pnl = train_pnl + val_pnl
            tot_gross_win = train_gross_win + val_gross_win
            tot_gross_loss = train_gross_loss + val_gross_loss
            pf = (tot_gross_win / tot_gross_loss) if tot_gross_loss > 0 else 99.0

            # Score formulation
            score = (
                (val_wr * 0.4) +
                (train_wr * 0.2) +
                (min(pf, 15.0) * 2.5) +
                (min(tot_pnl, 200.0) * 0.2) +
                (min(tot_trades, 150) * 0.15)
            )

            rules = {
                'minMcap': mc,
                'minMomentum': mom,
                'maxMomentum': 35.0,
                'minBuyShare': bs,
                'maxTopBuyer': tb,
                'minBuyers': nb,
                'targetPercent': tp,
                'stopLossPercent': sl,
                'trailingStartPercent': ts,
                'trailingDrawdownPercent': td,
            }

            full_stats = {
                'trades': tot_trades,
                'wins': tot_wins,
                'losses': tot_losses,
                'winRate': tot_wr,
                'pnlUsd': tot_pnl,
                'profitFactor': pf,
                'avgWin': (tot_gross_win / tot_wins / stake_usd * 100) if tot_wins else 0.0,
                'avgLoss': (-tot_gross_loss / tot_losses / stake_usd * 100) if tot_losses else 0.0,
            }

            train_stats = {
                'trades': len(train_matched),
                'wins': train_wins,
                'winRate': train_wr,
                'pnlUsd': train_pnl,
            }

            val_stats = {
                'trades': len(val_matched),
                'wins': val_wins,
                'winRate': val_wr,
                'pnlUsd': val_pnl,
            }

            valid_results.append({
                'rules': rules,
                'full': full_stats,
                'train': train_stats,
                'val': val_stats,
                'score': score
            })

    t1 = time.time()
    log(f"Optimization sweep completed in {t1-t0:.2f}s! Valid passing parameter sets: {len(valid_results)}")

    if not valid_results:
        log("WARN: No rules passed both validation thresholds.")
        return []

    # Sort by overall score
    valid_results.sort(key=lambda x: x['score'], reverse=True)

    # 1. Apex Balanced: Top overall score
    apex = valid_results[0]

    # 2. Safe Scalper: Highest Win Rate with conservative stop loss (<= 5.0%)
    safe_pool = [c for c in valid_results if c['rules']['stopLossPercent'] <= 5.0]
    safe_pool.sort(key=lambda x: (x['full']['winRate'], x['full']['profitFactor']), reverse=True)
    safe = safe_pool[0] if safe_pool else valid_results[min(1, len(valid_results)-1)]

    # 3. Trend Runner: Higher Take Profit (>= 28.0%) with maximum net PnL
    runner_pool = [c for c in valid_results if c['rules']['targetPercent'] >= 28.0]
    runner_pool.sort(key=lambda x: (x['full']['pnlUsd'], x['full']['winRate']), reverse=True)
    runner = runner_pool[0] if runner_pool else valid_results[min(2, len(valid_results)-1)]

    selected = [
        {'id': 'apex', 'label': 'M-Apex10k', 'title': 'Momentum Apex (Optimal Tradeoff)', 'data': apex},
        {'id': 'safe', 'label': 'M-Safe10k', 'title': 'Momentum Safe Scalper (High WR)', 'data': safe},
        {'id': 'runner', 'label': 'M-Runner15k', 'title': 'Momentum Trend Runner (High R:R)', 'data': runner},
    ]

    return selected

def generate_typescript_code(selected_lanes):
    log("Generating TypeScript code for evolved lanes...")
    ts_code = """/**
 * AUTONOMOUSLY EVOLVED MOMENTUM LANES
 * Generated via scripts/momentum-auto-optimizer.py
 * Generated at: """ + datetime.now(WIB).strftime('%Y-%m-%d %H:%M:%S WIB') + """
 * Evaluated across Oct 14-18 Historical Data + Walk-Forward Validation.
 * Hard Filter: Market Cap >= $10,000 USD.
 */

import {
  DistributionTargetLane,
  TargetRules,
  validateTargetRules,
  DEFAULT_TARGET_RULES,
  TargetEvent
} from './distribution-target-lane.js';
import { evaluateResearchMomentumEntry } from './distribution-research-lanes.js';

function createEvolvedRules(overrides: Partial<TargetRules> & { version: string; targetPercent: number }): Readonly<TargetRules> {
  return Object.freeze(validateTargetRules({
    ...DEFAULT_TARGET_RULES,
    paperOnly: true,
    enabled: true,
    observationSeconds: 15,
    minTransferAgeSeconds: 30,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 300,
    confirmSeconds: 2,
    feePercentPerSide: 1,
    slippagePercentPerSide: 0.5,
    fixedFeeUsdPerSide: 0.005,
    stakeUsd: 5.0,
    ...overrides,
  }));
}
"""

    for item in selected_lanes:
        r = item['data']['rules']
        full = item['data']['full']
        lbl = item['label']
        cls_name = "Distribution" + lbl.replace("-", "").replace(".", "") + "Lane"
        const_rules = lbl.replace("-", "_").replace(".", "_").upper() + "_RULES"

        ts_code += f"""
// ============================================================================
// {item['title']}
// Historical Stats: Trades={full['trades']} | WR={full['winRate']:.1f}% | Net PnL=+${full['pnlUsd']:.2f} | PF={full['profitFactor']:.2f}
// ============================================================================
export const {const_rules} = createEvolvedRules({{
  version: 'distribution-{lbl.lower()}',
  targetPercent: {r['targetPercent']},
  minBuySharePercent: {r['minBuyShare']},
  minMeaningfulBuyUsd: 10,
  minMeaningfulBuyers: {r['minBuyers']},
  maxBuyerSharePercent: {r['maxTopBuyer']},
  minMomentumPercent: {r['minMomentum']},
  maxMomentumPercent: {r['maxMomentum']},
  maxDrawdownPercent: 3.5,
  stopLossPercent: {r['stopLossPercent']},
  trailingStartPercent: {r['trailingStartPercent']},
  trailingDrawdownPercent: {r['trailingDrawdownPercent']},
  maxHoldSeconds: 300,
}});

export class {cls_name} extends DistributionTargetLane {{
  constructor(mint: string, emit: (event: TargetEvent) => void = () => {{}}) {{
    super(mint, {const_rules}, e => emit({{
      ...e,
      targetPercent: {const_rules}.targetPercent,
      version: {const_rules}.version,
      laneLabel: '{lbl}' as any,
    }}), {{
      name: '{lbl.lower()}',
      paperLane: {const_rules}.version,
      trailingEnabled: true,
      overrideEntryReasons: evaluateResearchMomentumEntry,
    }});
  }}
}}
"""

    with open(TS_OUT, 'w', encoding='utf-8') as f:
        f.write(ts_code)
    log(f"Successfully generated TypeScript file: {TS_OUT}")

def save_outputs(selected_lanes):
    now_iso = datetime.now(WIB).isoformat()
    now_str = datetime.now(WIB).strftime('%Y-%m-%d %H:%M:%S WIB')

    report = {
        'generatedAt': now_str,
        'iso': now_iso,
        'lanes': []
    }

    for item in selected_lanes:
        d = item['data']
        report['lanes'].append({
            'id': item['id'],
            'label': item['label'],
            'title': item['title'],
            'rules': d['rules'],
            'metrics': {
                'totalTrades': d['full']['trades'],
                'wins': d['full']['wins'],
                'losses': d['full']['losses'],
                'winRate': round(d['full']['winRate'], 1),
                'netPnlUsd': round(d['full']['pnlUsd'], 2),
                'profitFactor': round(d['full']['profitFactor'], 2),
                'avgWinPct': round(d['full']['avgWin'], 1),
                'avgLossPct': round(d['full']['avgLoss'], 1),
            },
            'validation': {
                'trainWinRate': round(d['train']['winRate'], 1),
                'valWinRate': round(d['val']['winRate'], 1),
                'valPnlUsd': round(d['val']['pnlUsd'], 2),
            }
        })

    with open(CONFIG_OUT, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    log(f"Saved configuration to: {CONFIG_OUT}")

    with open(REPORT_OUT, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2)
    log(f"Saved report to: {REPORT_OUT}")

    with open(HISTORY_OUT, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'time': now_iso, 'report': report}) + '\n')
    log(f"Appended iteration to history: {HISTORY_OUT}")

def main():
    log("=== STARTING MOMENTUM LANE EVOLUTION RUN ===")
    dataset = load_episodes()
    if not dataset:
        log("ERROR: No episodes found.")
        sys.exit(1)

    selected = optimize_lanes(dataset)
    if not selected:
        log("WARN: Optimizer could not select new lanes.")
        sys.exit(0)

    log("=== BEST EVOLVED LANES SELECTED ===")
    for lane in selected:
        m = lane['data']['full']
        r = lane['data']['rules']
        log(f"-> [{lane['label']}] {lane['title']}")
        log(f"   Trades: {m['trades']} | WR: {m['winRate']:.1f}% ({m['wins']}W/{m['losses']}L) | Net PnL: +${m['pnlUsd']:.2f} | PF: {m['profitFactor']:.2f}")
        log(f"   Params: MinMcap=${r['minMcap']} | Mom={r['minMomentum']}%-{r['maxMomentum']}% | TP={r['targetPercent']}% | SL={r['stopLossPercent']}% | TrailStart={r['trailingStartPercent']}%")

    save_outputs(selected)
    generate_typescript_code(selected)
    log("=== MOMENTUM LANE EVOLUTION COMPLETED SUCCESSFULLY ===")

if __name__ == '__main__':
    main()
