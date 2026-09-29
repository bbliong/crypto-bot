import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Offline only. This script never publishes active-formula.json or starts a worker.
export const baseline = { entryReturn: 8, return5: 0, maxDrawdown: -3, maxMarketCap: 100000, requireTop1Safe: true, hardStop: 2, activation: 4, lock: 0, trailing: 5, negativeWindows: 2 };
export const previousCandidate = { ...baseline, entryReturn: 8.25, return5: 0.5, maxDrawdown: -2, maxMarketCap: 80000 };
const range = (a, b, step) => Array.from({ length: Math.round((b - a) / step) + 1 }, (_, i) => +(a + step * i).toFixed(3));
const finite = x => typeof x === 'number' && Number.isFinite(x);
const readLines = file => readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const groupMint = rows => {
  const map = new Map();
  for (const row of rows) { const group = map.get(row.mint) ?? []; group.push(row); map.set(row.mint, group); }
  for (const group of map.values()) group.sort((a, b) => a.observedAt - b.observedAt);
  return map;
};

export function prepareSession(s, ticks, holders, causal, observationSeconds = 30, holderScope = 'recorded') {
  if (!ticks.length) return null;
  const boundary = s.startedAt + observationSeconds * 1000;
  const decision = ticks.filter(t => t.observedAt <= boundary).at(-1) ?? (!causal ? ticks.find(t => t.observedAt > boundary) : null);
  if (!decision || (causal && (s.endedAt < boundary || boundary - decision.observedAt > 5000))) return null;
  const prior = ticks.filter(t => t.observedAt <= decision.observedAt - 5000).at(-1);
  const before = ticks.filter(t => t.observedAt <= decision.observedAt);
  // The collector fallback requests tag=dev. That cannot establish the largest
  // overall user holder. Unknown query scope is also rejected in strict mode.
  const h = holders.filter(h => h.observedAt >= s.startedAt && h.observedAt <= boundary && h.status === 200 && finite(h.top1Percent)
    && (holderScope !== 'unfiltered' || (Array.isArray(h.queryKeys) && !h.queryKeys.includes('tag')))).at(-1);
  const decisionAt = causal ? boundary : decision.observedAt;
  // Precompute trailing momentum on the entire observed history (not only post-buy).
  let pointer = -1;
  const after = [];
  for (const tick of ticks) {
    while (pointer + 1 < ticks.length && ticks[pointer + 1].observedAt <= tick.observedAt - 5000) pointer++;
    if (tick.observedAt <= decisionAt) continue;
    after.push({ at: tick.observedAt, r: (tick.priceUsd / decision.priceUsd - 1) * 100, r5: pointer >= 0 ? (tick.priceUsd / ticks[pointer].priceUsd - 1) * 100 : null });
  }
  return {
    id: `${s.mint}:${s.startedAt}`, symbol: s.metadata?.symbol ?? s.mint, mint: s.mint, startedAt: s.startedAt,
    buyPrice: decision.priceUsd, buyAt: decisionAt, priceObservedAt: decision.observedAt, observationSeconds,
    r30: (decision.priceUsd / ticks[0].priceUsd - 1) * 100,
    r5: prior ? (decision.priceUsd / prior.priceUsd - 1) * 100 : null,
    dd: (decision.priceUsd / Math.max(...before.map(t => t.priceUsd)) - 1) * 100,
    mc: s.entryMarketCapUsd, top: causal ? !!h && h.top1Percent <= 50 : s.top1Safe === true,
    top1AtDecision: h?.top1Percent ?? null, holderSnapshotAt: h?.observedAt ?? null,
    holderQueryKeys: h?.queryKeys ?? null, holderSource: h?.source ?? null, holderScope, endTop1Safe: s.top1Safe, after,
    // A spectacular upward jump is retained but its profit is assigned zero in
    // conservative scoring. Losses, including -100%, are never clipped away.
    upwardJumpSuspect: ticks.some((t, i) => i > 0 && t.priceUsd / ticks[i - 1].priceUsd > 100),
  };
}

export function exitReplay(row, f) {
  let peak = 0, negative = 0, lastWindow = -Infinity;
  for (const point of row.after) {
    peak = Math.max(peak, point.r);
    let reason = null;
    if (peak < f.activation && point.r <= -f.hardStop) reason = 'HARD_STOP';
    else if (peak >= f.activation && point.r <= Math.max(f.lock, (100 + peak) * (1 - f.trailing / 100) - 100)) reason = 'PROFIT_LOCK_TRAILING';
    if (!reason && f.negativeWindows > 0 && point.at - lastWindow >= 4500 && point.r5 !== null) {
      negative = point.r5 < 0 ? negative + 1 : 0;
      lastWindow = point.at;
      if (negative >= f.negativeWindows && point.r > 0) reason = 'NEGATIVE_MOMENTUM';
    }
    if (!reason && finite(f.maxHoldSeconds) && point.at >= row.buyAt + f.maxHoldSeconds * 1000) reason = 'TIME_LIMIT_FIRST_OBSERVED_TICK';
    if (reason) return { ret: point.r, reason, at: point.at };
  }
  return { ret: row.after.at(-1)?.r ?? 0, reason: 'CAPTURE_END_MARK_ONLY', at: row.after.at(-1)?.at ?? row.buyAt };
}

const eligible = (row, f) => row.top && finite(row.mc) && row.mc <= f.maxMarketCap && row.r30 >= f.entryReturn && row.r5 !== null && row.r5 >= f.return5 && row.dd >= f.maxDrawdown;
const guarded = (row, result) => row.upwardJumpSuspect && result.ret > 0 ? 0 : result.ret;
function summary(trades) {
  const values = trades.map(t => t.ret), sorted = [...values].sort((a, b) => a - b);
  const n = values.length, total = values.reduce((a, b) => a + b, 0);
  const loss = values.filter(x => x < 0), gain = values.filter(x => x > 0);
  const grossLoss = -loss.reduce((a, b) => a + b, 0), grossProfit = gain.reduce((a, b) => a + b, 0);
  return { buys: n, wins: gain.length, losses: loss.length, flat: n - gain.length - loss.length,
    winRate: n ? gain.length / n * 100 : null, mean: n ? total / n : null,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    totalReturnPoints: total, grossLossPoints: grossLoss, grossProfitPoints: grossProfit,
    lossPerBuy: n ? grossLoss / n : null, meanLosingTrade: loss.length ? -grossLoss / loss.length : null,
    worst: n ? sorted[0] : null, worstFivePercentMean: n ? sorted.slice(0, Math.max(1, Math.ceil(n * 0.05))).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(n * 0.05)) : null,
    withoutLargestWinnerMean: n > 1 ? (total - Math.max(...values)) / (n - 1) : null,
    meanAfterAssumedOnePercentCost: n ? total / n - 1 : null,
  };
}

function assess(rows, f, splitAt) {
  const trades = rows.filter(row => eligible(row, f)).map(row => {
    const result = exitReplay(row, f);
    return { symbol: row.symbol, mint: row.mint, startedAt: row.startedAt, buyAt: row.buyAt, buyPrice: row.buyPrice,
      r30: row.r30, r5: row.r5, dd: row.dd, mc: row.mc, top1AtDecision: row.top1AtDecision, observationSeconds: row.observationSeconds,
      holderSnapshotAt: row.holderSnapshotAt, holderQueryKeys: row.holderQueryKeys, holderSource: row.holderSource, holderScope: row.holderScope,
      suspect: row.upwardJumpSuspect, rawRet: result.ret, ret: guarded(row, result), reason: result.reason, exitAt: result.at };
  });
  return { rules: f, all: summary(trades), firstTwoThirds: summary(trades.filter(t => t.startedAt < splitAt)), lastThird: summary(trades.filter(t => t.startedAt >= splitAt)),
    signalExits: summary(trades.filter(t => t.reason !== 'CAPTURE_END_MARK_ONLY')),
    captureEndMarks: summary(trades.filter(t => t.reason === 'CAPTURE_END_MARK_ONLY')),
    rawIncludingSuspect: summary(trades.map(t => ({ ret: t.rawRet }))), trades };
}

function search(rows, splitAt, minTrainBuys = 12, allowNegativeFit = false) {
  const grid = { entryReturn: range(0, 12, .25), return5: range(0, 3, .25), maxDrawdown: range(-5, 0, .25), maxMarketCap: [45000,50000,55000,60000,65000,70000,75000,80000,85000,90000,95000,100000,120000,150000,200000,300000] };
  const endGrid = { hardStop: [.5,.75,1,1.25,1.5,2,2.5,3], activation: [1,1.5,2,2.5,3,4,5,6], lock: [0,.25,.5,1], trailing: [.5,1,1.5,2,2.5,3,4,5,6], negativeWindows: [0,1,2,3], maxHoldSeconds: [null,10,20,30,60] };
  const trainRows = rows.filter(row => row.startedAt < splitAt);
  const baselineExit = trainRows.map(row => guarded(row, exitReplay(row, baseline)));
  const masks = new Map(); let entryCount = 0;
  for (const entryReturn of grid.entryReturn) for (const return5 of grid.return5) for (const maxDrawdown of grid.maxDrawdown) for (const maxMarketCap of grid.maxMarketCap) {
    entryCount++;
    const f = { entryReturn, return5, maxDrawdown, maxMarketCap, requireTop1Safe: true };
    const indices = [];
    for (let i = 0; i < trainRows.length; i++) if (eligible(trainRows[i], f)) indices.push(i);
    if (indices.length < minTrainBuys) continue;
    const key = indices.join(',');
    if (!masks.has(key)) masks.set(key, { rules: f, indices, initial: summary(indices.map(i => ({ ret: baselineExit[i] }))) });
  }
  const sets = [...masks.values()];
  const picked = new Map();
  // Keep diverse entry sets: lowest loss, best mean without a single winner,
  // best net mean, and best win rate. Every choice here uses only the earlier period.
  const ranks = [
    (a,b) => a.initial.lossPerBuy - b.initial.lossPerBuy,
    (a,b) => b.initial.withoutLargestWinnerMean - a.initial.withoutLargestWinnerMean,
    (a,b) => b.initial.mean - a.initial.mean,
    (a,b) => b.initial.winRate - a.initial.winRate,
  ];
  for (const rank of ranks) for (const set of [...sets].sort(rank).slice(0, 32)) picked.set(set.indices.join(','), set);
  // Always include the already-discussed entry rules in exit optimization.
  for (const f of [baseline, previousCandidate]) {
    const indices = trainRows.flatMap((r,i) => eligible(r,f) ? [i] : []);
    if (indices.length >= minTrainBuys) picked.set(indices.join(','), {rules: f, indices});
  }
  const entrySets = [...picked.values()], union = [...new Set(entrySets.flatMap(s => s.indices))];
  let tested = 0, exitsTested = 0;
  const leaders = [], leaderSignatures = new Set();
  const compare = (a,b) => b.train.worst - a.train.worst || a.train.lossPerBuy - b.train.lossPerBuy || b.train.mean - a.train.mean;
  for (const hardStop of endGrid.hardStop) for (const activation of endGrid.activation) for (const lock of endGrid.lock) for (const trailing of endGrid.trailing) for (const negativeWindows of endGrid.negativeWindows) for (const maxHoldSeconds of endGrid.maxHoldSeconds) {
    if (lock >= activation) continue;
    const e = { hardStop, activation, lock, trailing, negativeWindows, maxHoldSeconds };
    exitsTested++;
    const returns = new Map(union.map(i => [i, guarded(trainRows[i], exitReplay(trainRows[i], e))]));
    for (const set of entrySets) {
      tested++;
      const train = summary(set.indices.map(i => ({ret: returns.get(i)})));
      // Avoid the trivial answer of barely trading, or minimizing loss by
      // selecting a strategy with negative total expectancy on its fitting data.
      if (!allowNegativeFit && (train.mean <= 0 || train.withoutLargestWinnerMean < 0)) continue;
      const candidate = { rules: {...set.rules, ...e, observationSeconds: rows[0]?.observationSeconds ?? 30}, train };
      if (leaders.length < 100 || compare(candidate, leaders.at(-1)) < 0) {
        // Deduplicate using earlier-period outcomes only; never use the later
        // period to choose among fitting candidates with identical results.
        candidate.signature = set.indices.map(i => `${i}:${returns.get(i)}`).join('|');
        if (leaderSignatures.has(candidate.signature)) continue;
        leaders.push(candidate); leaderSignatures.add(candidate.signature); leaders.sort(compare);
        if (leaders.length > 100) leaderSignatures.delete(leaders.pop().signature);
      }
    }
  }
  const unique = new Map();
  for (const candidate of leaders) {
    const detail = assess(rows, candidate.rules, splitAt);
    const signature = detail.trades.map(t => `${t.mint}:${t.exitAt}:${t.ret}`).join('|');
    if (!unique.has(signature)) unique.set(signature, detail);
  }
  return { entryGrid: grid, exitGrid: endGrid, entryCombinations: entryCount, distinctTrainEntrySets: sets.length,
    selectedEntrySets: entrySets.length, exitCombinations: exitsTested, jointComparisons: tested,
    baseline: assess(rows, baseline, splitAt), previousCandidate: assess(rows, previousCandidate, splitAt),
    rankedByEarlierPeriod: [...unique.values()].slice(0,15).map(detail => ({...detail,
      sameEntriesBaselineExit: assess(rows, {...detail.rules, hardStop: baseline.hardStop, activation: baseline.activation,
        lock: baseline.lock, trailing: baseline.trailing, negativeWindows: baseline.negativeWindows, maxHoldSeconds: null}, splitAt),
    })) };
}

async function main() {
  const input = process.argv[2] ?? 'research/pump-band-12h-paused-optimizer-2026-09-28T14-50-00Z';
  const output = process.argv[3] ?? `research/mc-low-loss-${new Date().toISOString().replace(/[:.]/g,'-')}`;
  // Safe replay is the default. Reproducing the old interpretation must be
  // explicitly requested and remains labelled diagnostic-only in the output.
  const strictHolders = !process.argv.includes('--legacy-diagnostics');
  if (!strictHolders && process.argv.includes('--strict-holders')) throw new Error('Choose strict holders or legacy diagnostics, not both');
  const minTrainBuys = Number(process.argv.find(arg => arg.startsWith('--min-train='))?.split('=')[1] ?? 12);
  if (!Number.isInteger(minTrainBuys) || minTrainBuys < 2) throw new Error('--min-train must be an integer >= 2');
  const allowNegativeFit = process.argv.includes('--allow-negative-fit');
  const summaries = readLines(join(input, 'token-summary.jsonl')).sort((a,b) => a.startedAt - b.startedAt);
  const tickMap = groupMint(readLines(join(input, 'socket-ticks.jsonl')).filter(t => String(t.source ?? '').startsWith('detail_socket_activity') && finite(t.priceUsd) && t.priceUsd > 0 && finite(t.observedAt)));
  const holderMap = groupMint(readLines(join(input, 'holder-snapshots.jsonl')));
  const splitAt = summaries[Math.floor(summaries.length * 2 / 3)].startedAt;
  const result = { generatedAt: new Date().toISOString(), input, sessions: summaries.length, splitAt, minTrainBuys, allowNegativeFit, holderScope: strictHolders ? 'unfiltered' : 'recorded (includes dev-filtered requests; diagnostic only, not validated holder protection)',
    method: `Retrospective search, not unseen validation. Buy uses the decision price at observationSeconds (r30 is the historical field name for return since first observed price even when observationSeconds differs). Causal modes reject stale/missing prices and use only holder snapshots timestamped at/before decision. Prices and holder snapshots are as recorded; no fees in gross returns. Capture-end marks are not executed sells. Positive returns on sessions with an upward tick >100x are assigned zero for ranking; raw results retained. All losses retained. At least ${minTrainBuys} earlier-period buys to search; chronology last third not used to rank. Earlier period may itself have been explored in previous analyses. Selection minimizes worst loss, then mean loss per buy, then maximizes mean. ${allowNegativeFit ? 'Exploratory defensive search: negative-mean fitting candidates are retained, NOT considered profitable.' : 'Zero/negative mean or dependency on one largest winner is rejected.'} A hard stop is a trigger, not a guaranteed execution price. MC is at session start, not refreshed at decision.`, modes: {} };
  mkdirSync(output, { recursive: true });
  const modes = [...(!strictHolders ? [{causal:false,observationSeconds:30,mode:'legacyEndHolderComparison'}] : []), ...[10,15,20,25,30,45,60].map(observationSeconds => ({causal:true,observationSeconds,mode:`asKnownAtBuy${observationSeconds}s`}))];
  for (const {causal, observationSeconds, mode} of modes) {
    const rows = summaries.flatMap(s => {
      const ticks = (tickMap.get(s.mint) ?? []).filter(t => t.observedAt >= s.startedAt && t.observedAt <= s.endedAt);
      const row = prepareSession(s, ticks, holderMap.get(s.mint) ?? [], causal, observationSeconds, strictHolders ? 'unfiltered' : 'recorded');
      return row ? [row] : [];
    });
    console.log(JSON.stringify({phase:'search',mode,priceUsable:rows.length,top1Safe:rows.filter(r=>r.top).length}));
    const run = search(rows, splitAt, minTrainBuys, allowNegativeFit);
    result.modes[mode] = { observationSeconds, priceUsable: rows.length, top1Safe: rows.filter(r=>r.top).length,
      suspectSessions: rows.filter(r=>r.upwardJumpSuspect).map(r=>({symbol:r.symbol,mint:r.mint})), ...run };
    writeFileSync(join(output, 'low-loss-search.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({mode,entryCombinations:run.entryCombinations,jointComparisons:run.jointComparisons,baseline:run.baseline.all,
      selected:run.rankedByEarlierPeriod.slice(0,3).map(r=>({rules:r.rules,all:r.all,late:r.lastThird,exits:r.signalExits}))}));
  }
  console.log(JSON.stringify({output}));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
