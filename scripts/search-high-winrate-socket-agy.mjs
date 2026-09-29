import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTokenSocketSession, deduplicateTrades } from './evaluate-socket-rules-agy.mjs';

const finite = x => typeof x === 'number' && Number.isFinite(x);
const readLines = p => readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);

/**
 * High-speed streaming evaluation with custom exit rules (stagnation, tiered, etc.)
 */
export function evaluateFast(session, buyRules, sellRules, latencyMs = 500) {
  const points = session.points;
  if (!points || points.length < 2) return null;

  let since = null, prevPoint = null, entryIndex = -1;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];

    // Filter MC
    if (finite(buyRules.minMarketCap) && (!finite(session.mc) || session.mc < buyRules.minMarketCap)) continue;
    if (finite(buyRules.maxMarketCap) && (!finite(session.mc) || session.mc > buyRules.maxMarketCap)) continue;

    // Filter Entry return
    if (finite(buyRules.entryReturn) && p.ret < buyRules.entryReturn) continue;

    // Filter Momentum
    if (finite(buyRules.momentum1s) && (p.returns[1] === null || p.returns[1] < buyRules.momentum1s)) continue;
    if (finite(buyRules.momentum3s) && (p.returns[3] === null || p.returns[3] < buyRules.momentum3s)) continue;
    if (finite(buyRules.momentum5s) && (p.returns[5] === null || p.returns[5] < buyRules.momentum5s)) continue;

    // Filter Drawdown & Rising ticks
    if (finite(buyRules.maxDrawdown) && p.dd < buyRules.maxDrawdown) continue;
    if (finite(buyRules.risingTicks) && p.up < buyRules.risingTicks) continue;
    if (finite(buyRules.maxRange3) && p.range3 > buyRules.maxRange3) continue;

    // Filter Order Flow
    if (finite(buyRules.minBuyShare) && (p.buyShare === null || p.buyShare < buyRules.minBuyShare)) continue;
    if (finite(buyRules.minBuyers) && p.uniqueBuyers < buyRules.minBuyers) continue;
    if (finite(buyRules.minTrades) && p.flowTrades < buyRules.minTrades) continue;

    // Filter Top1 holder
    if (finite(buyRules.maxTop1)) {
      if (p.top1 === null || p.top1 > buyRules.maxTop1) continue;
    }

    // Debounce / Confirm time
    if (since === null || !prevPoint || p.i !== prevPoint.i + 1 || p.at - prevPoint.at > 2000) {
      since = p.at;
    }

    if (p.at - since >= (buyRules.confirmMs ?? 0)) {
      entryIndex = i;
      break;
    }
    prevPoint = p;
  }

  if (entryIndex < 0) return null;

  const signal = points[entryIndex];
  let buyIndex = entryIndex;
  if (latencyMs > 0) {
    buyIndex = points.findIndex((p, idx) => idx >= entryIndex && p.at >= signal.at + latencyMs);
    if (buyIndex < 0) return { unfilled: true };
  }

  const buy = points[buyIndex];
  let peak = 0;

  const makeResult = (exitPoint, reason) => {
    const rawRet = (exitPoint.price / buy.price - 1) * 100;
    const ret = session.suspect && rawRet > 0 ? 0 : rawRet;
    return {
      symbol: session.symbol,
      mint: session.mint,
      ret,
      netReal: ret - 5.43,
      reason,
      heldSeconds: (exitPoint.at - buy.at) / 1000,
    };
  };

  for (let j = buyIndex + 1; j < points.length; j++) {
    const p = points[j];
    const r = (p.price / buy.price - 1) * 100;
    peak = Math.max(peak, r);
    let reason = null;

    // 1. Hard Stop
    if (finite(sellRules.hardStop) && peak < sellRules.activation && r <= -sellRules.hardStop) {
      reason = 'HARD_STOP';
    }
    // 2. Trailing stop / profit lock
    else if (finite(sellRules.activation) && peak >= sellRules.activation) {
      const trailFloor = (100 + peak) * (1 - (sellRules.trailing ?? 1) / 100) - 100;
      const lockFloor = sellRules.lock ?? 0.5;
      if (r <= Math.max(lockFloor, trailFloor)) {
        reason = 'PROFIT_LOCK_TRAILING';
      }
    }

    // 3. Take profit cap
    if (!reason && finite(sellRules.takeProfit) && r >= sellRules.takeProfit) {
      reason = 'TAKE_PROFIT';
    }

    // 4. Stagnation exit
    if (!reason && finite(sellRules.stagnationSeconds) && (p.at - buy.at) >= sellRules.stagnationSeconds * 1000) {
      if (peak < (sellRules.stagnationThreshold ?? 2.5)) {
        reason = 'STAGNATION_EXIT';
      }
    }

    // 5. Flow reversal exit
    if (!reason && sellRules.flowExit && p.flowTrades >= 3 && p.buyShare !== null && p.buyShare < 0.35 && p.returns[3] !== null && p.returns[3] < 0) {
      reason = 'SELL_FLOW_DOMINATES';
    }

    if (reason) {
      const fill = points.find((v, k) => k >= j && v.at >= p.at + latencyMs);
      return fill ? makeResult(fill, reason) : makeResult(points.at(-1), 'CAPTURE_END_PENDING_SELL');
    }
  }

  return makeResult(points.at(-1), 'CAPTURE_END_MARK');
}

async function main() {
  const input = process.argv[2] ?? 'research/pump-band-12h-paused-optimizer-2026-09-28T14-50-00Z';
  console.log(`[SEARCH-80] Loading sessions from ${input}...`);

  const group = rows => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.mint)) m.set(r.mint, []); m.get(r.mint).push(r); }
    for (const a of m.values()) a.sort((x, y) => x.observedAt - y.observedAt);
    return m;
  };

  const summaries = readLines(join(input, 'token-summary.jsonl')).sort((a, b) => a.startedAt - b.startedAt);
  const tickMap = group(readLines(join(input, 'socket-ticks.jsonl')).filter(t => t.source?.startsWith('detail_socket_activity')));
  const holderMap = group(readLines(join(input, 'holder-snapshots.jsonl')));
  const tradeMap = group(readLines(join(input, 'trades.jsonl')));

  console.time('buildSessions');
  const sessions = summaries.map(s => buildTokenSocketSession(s, tickMap.get(s.mint) ?? [], holderMap.get(s.mint) ?? [], tradeMap.get(s.mint) ?? []));
  console.timeEnd('buildSessions');
  console.log(`[SEARCH-80] Precomputed ${sessions.length} sessions in memory.`);

  // Define parameter candidate arrays
  const entryReturns = [0.5, 0.8, 1.0, 1.2];
  const mom1sList = [0.5, 0.7, 1.0];
  const minBuyShares = [0.85, 0.90, 0.95, 1.00];
  const minBuyersList = [2, 3, 4];
  const maxTop1List = [35, 40];
  const maxMarketCaps = [180000, 300000];

  const sellConfigs = [
    { name: 'Act3.5_Lock2.0_Trail1.0', act: 3.5, lock: 2.0, trail: 1.0, stop: 3.0, stagSec: null, stagThresh: null, flow: true },
    { name: 'Act4.0_Lock2.5_Trail1.0', act: 4.0, lock: 2.5, trail: 1.0, stop: 3.0, stagSec: null, stagThresh: null, flow: true },
    { name: 'Act5.0_Lock3.0_Trail1.0', act: 5.0, lock: 3.0, trail: 1.0, stop: 3.0, stagSec: null, stagThresh: null, flow: true },
    { name: 'Act3.5_Lock2.0_Stag15s', act: 3.5, lock: 2.0, trail: 1.0, stop: 3.0, stagSec: 15, stagThresh: 2.5, flow: true },
    { name: 'Act3.5_Lock2.0_Stag12s', act: 3.5, lock: 2.0, trail: 1.0, stop: 3.0, stagSec: 12, stagThresh: 2.0, flow: true },
    { name: 'Act3.5_Lock2.0_Trail0.8', act: 3.5, lock: 2.0, trail: 0.8, stop: 3.0, stagSec: null, stagThresh: null, flow: true },
    { name: 'Act3.0_Lock1.5_Trail0.8', act: 3.0, lock: 1.5, trail: 0.8, stop: 2.5, stagSec: null, stagThresh: null, flow: true },
  ];

  console.log(`[SEARCH-80] Starting parameter search loop...`);
  const results = [];
  let evaluated = 0;

  for (const er of entryReturns) {
    for (const m1 of mom1sList) {
      for (const bs of minBuyShares) {
        for (const mb of minBuyersList) {
          for (const top1 of maxTop1List) {
            for (const maxMc of maxMarketCaps) {
              const buy = {
                entryReturn: er,
                momentum1s: m1,
                maxDrawdown: -3,
                minBuyShare: bs,
                minBuyers: mb,
                maxTop1: top1,
                maxRange3: 5,
                maxMarketCap: maxMc,
              };

              for (const sc of sellConfigs) {
                const sell = {
                  hardStop: sc.stop,
                  activation: sc.act,
                  lock: sc.lock,
                  trailing: sc.trail,
                  stagnationSeconds: sc.stagSec,
                  stagnationThreshold: sc.stagThresh,
                  flowExit: sc.flow,
                  takeProfit: null,
                };

                evaluated++;
                const trades = [];
                for (const s of sessions) {
                  const t = evaluateFast(s, buy, sell, 500);
                  if (t && !t.unfilled) trades.push(t);
                }

                if (trades.length < 3) continue;

                const n = trades.length;
                const socketWins = trades.filter(t => t.ret > 0).length;
                const socketWinRate = (socketWins / n) * 100;
                const realWins = trades.filter(t => t.netReal > 0).length;
                const realWinRate = (realWins / n) * 100;
                const meanSocket = trades.reduce((sum, t) => sum + t.ret, 0) / n;
                const meanNetReal = trades.reduce((sum, t) => sum + t.netReal, 0) / n;
                const totalNetReal = trades.reduce((sum, t) => sum + t.netReal, 0);

                results.push({
                  buy,
                  sellName: sc.name,
                  sell,
                  n,
                  socketWins,
                  socketWinRate,
                  realWins,
                  realWinRate,
                  meanSocket,
                  meanNetReal,
                  totalNetReal,
                  trades: trades.map(t => ({ symbol: t.symbol, ret: +t.ret.toFixed(2), net: +t.netReal.toFixed(2), reason: t.reason })),
                });
              }
            }
          }
        }
      }
    }
  }

  console.log(`[SEARCH-80] Evaluated ${evaluated} candidate formulas across 916 tokens.`);
  console.log(`[SEARCH-80] Formulas with at least 3 trades: ${results.length}`);

  // Sort by Real Win Rate descending, then by Mean Net Real descending
  results.sort((a, b) => b.realWinRate - a.realWinRate || b.totalNetReal - a.totalNetReal || b.socketWinRate - a.socketWinRate);

  console.log('\n=============================================================================');
  console.log('TOP 15 FORMULAS RANKED BY REAL WIN RATE (AFTER -5.43% SWAP DRAG):');
  console.log('=============================================================================');
  for (let i = 0; i < Math.min(results.length, 15); i++) {
    const r = results[i];
    console.log(`\nRank #${i + 1} | Real WR: ${r.realWinRate.toFixed(1)}% (${r.realWins}W / ${r.n - r.realWins}L) | Socket WR: ${r.socketWinRate.toFixed(1)}% | MeanNet: ${r.meanNetReal >= 0 ? '+' : ''}${r.meanNetReal.toFixed(2)}% | TotalNet: ${r.totalNetReal >= 0 ? '+' : ''}${r.totalNetReal.toFixed(2)}% | Trades: ${r.n}`);
    console.log(`  BUY:  entryRet >= ${r.buy.entryReturn}%, mom1s >= ${r.buy.momentum1s}%, buyShare >= ${(r.buy.minBuyShare * 100).toFixed(0)}%, buyers >= ${r.buy.minBuyers}, top1 <= ${r.buy.maxTop1}%, maxMC: $${r.buy.maxMarketCap}`);
    console.log(`  SELL: ${r.sellName}`);
    console.log(`  Trades: ${r.trades.map(t => `${t.symbol}(${t.net >= 0 ? '+' : ''}${t.net}%)`).join(', ')}`);
  }

  // Also check top formulas ranked by Socket Win Rate (where Win Rate >= 80%)
  const topSocket = [...results].filter(r => r.n >= 5).sort((a, b) => b.socketWinRate - a.socketWinRate || b.totalNetReal - a.totalNetReal);
  console.log('\n=============================================================================');
  console.log('TOP 10 FORMULAS WITH SOCKET WIN RATE >= 80% (N >= 5 TRADES):');
  console.log('=============================================================================');
  for (let i = 0; i < Math.min(topSocket.length, 10); i++) {
    const r = topSocket[i];
    console.log(`\nRank #${i + 1} | Socket WR: ${r.socketWinRate.toFixed(1)}% (${r.socketWins}W / ${r.n - r.socketWins}L) | Real WR: ${r.realWinRate.toFixed(1)}% | MeanSocket: +${r.meanSocket.toFixed(2)}% | MeanNet: ${r.meanNetReal >= 0 ? '+' : ''}${r.meanNetReal.toFixed(2)}% | Trades: ${r.n}`);
    console.log(`  BUY:  entryRet >= ${r.buy.entryReturn}%, mom1s >= ${r.buy.momentum1s}%, buyShare >= ${(r.buy.minBuyShare * 100).toFixed(0)}%, buyers >= ${r.buy.minBuyers}, top1 <= ${r.buy.maxTop1}%, maxMC: $${r.buy.maxMarketCap}`);
    console.log(`  SELL: ${r.sellName}`);
    console.log(`  Trades: ${r.trades.map(t => `${t.symbol}(socket:${t.ret >= 0 ? '+' : ''}${t.ret}% / net:${t.net >= 0 ? '+' : ''}${t.net}%)`).join(', ')}`);
  }

  // Save top results to JSON
  writeFileSync('research/ws-event-search-agy-final/search-80-results.json', JSON.stringify(results.slice(0, 50), null, 2));
  console.log('\n[SEARCH-80] Top 50 results saved to research/ws-event-search-agy-final/search-80-results.json');
}

main().catch(err => { console.error(err); process.exit(1); });
