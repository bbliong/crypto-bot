// Pure research mechanics. This module never submits transactions.
export const valid = x => typeof x === 'number' && Number.isFinite(x);
export const INITIAL = Object.freeze({ platformFee: .01, networkFeeSol: .000205, failedFeeSol: .000105,
  latencyMs: 1000, maxFillWaitMs: 2000, buySlippageCap: .02, sellSlippageCap: .05 });

export function asOf(rows, now, timeKey = 'at') {
  let lo = 0, hi = rows.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >>> 1; if (rows[mid][timeKey] <= now) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found < 0 ? null : rows[found];
}
export function firstAfter(rows, now, deadline, timeKey = 'observedAt') {
  let lo = 0, hi = rows.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (rows[mid][timeKey] < now) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < rows.length && rows[i][timeKey] <= deadline; i++) {
    const t = rows[i];
    if (t.priceUsd > 0 && t.observedAt - t.occurredAt <= 2000 && t.occurredAt <= t.observedAt + 3000) return t;
  }
  return null;
}
export function immediateNetReturn(stakeUsd, solUsd, settings = INITIAL) {
  const input = stakeUsd / solUsd;
  return ((input * (1 - settings.platformFee) ** 2 - settings.networkFeeSol) / (input + settings.networkFeeSol) - 1) * 100;
}
export function makeFill(stakeUsd, solUsd, priceUsd, at, settings = INITIAL) {
  const input = stakeUsd / solUsd;
  return { openedAt: at, priceUsd, quantity: stakeUsd * (1 - settings.platformFee) / priceUsd,
    buyCostSol: input + settings.networkFeeSol, buySolUsd: solUsd, stakeUsd, peak: -Infinity, floor: null,
    flowBreach: null, lastFlowId: null, settings };
}
export function netReturn(position, priceUsd, solUsd) {
  const proceeds = position.quantity * priceUsd * (1 - position.settings.platformFee) / solUsd - position.settings.networkFeeSol;
  return (proceeds / position.buyCostSol - 1) * 100;
}
export function exitReason(position, input) {
  const { now, priceUsd, solUsd, metrics, stale, majorSell, collapse1s, tickId, newTick } = input;
  if (stale) return 'DATA_STALE';
  const r = netReturn(position, priceUsd, solUsd);
  const socket = (priceUsd / position.priceUsd - 1) * 100;
  position.peak = Math.max(position.peak, r);
  if (majorSell) return 'MAJOR_OR_DEV_DUMP';
  if (collapse1s <= -8 && (metrics.buyShare ?? 1) <= .3) return 'FLASH_CRASH';
  if (r <= -6 || socket <= -8) return 'HARD_RISK';
  const broken = (metrics.buyShare ?? 1) <= .3 && metrics.sellUsd >= 150 && metrics.sellers >= 3 && (metrics.slope5s ?? 0) < 0;
  if (!broken) position.flowBreach = null;
  else if (newTick && tickId !== position.lastFlowId) {
    if (position.flowBreach !== null && now > position.flowBreach && now - position.flowBreach <= 500) return 'FLOW_BROKEN';
    position.flowBreach = now; position.lastFlowId = tickId;
  }
  if (position.peak >= 8) position.floor = Math.max(position.floor ?? -Infinity, 1.5);
  if (position.peak >= 12) position.floor = Math.max(position.floor ?? -Infinity, 3, (100 + position.peak) * .95 - 100);
  if (position.floor !== null && r <= position.floor) return 'NET_PROFIT_FLOOR';
  if (r >= 20 && ((metrics.buyShare ?? 0) < .65 || (metrics.slope5s ?? 0) <= 0)) return 'SOFT_TARGET';
  if (now - position.openedAt >= 20000 && position.peak < 3 && ((metrics.buyShare ?? 0) < .6 || (metrics.slope5s ?? 0) <= 0)) return 'STAGNATION';
  if (now - position.openedAt >= 90000) return 'TIME_LIMIT';
  return null;
}

export function portfolio(outcomes, stakeUsd, dayEnd) {
  // Diagnostic capital assumption: stake = 1% of initial equity. No wallet queried.
  const initialEquityUsd = stakeUsd * 100;
  let busyUntil = -Infinity, pauseUntil = -Infinity, lossStreak = 0, pnl = 0, stopped = false;
  const used = new Set(), selected = [], skipped = { concurrency: 0, alreadyEntered: 0, cooldown: 0, dailyStop: 0 };
  for (const r of [...outcomes].sort((a,b)=>a.signalAt-b.signalAt)) {
    if (stopped) { skipped.dailyStop++; continue; }
    if (r.signalAt < busyUntil) { skipped.concurrency++; continue; }
    if (r.signalAt < pauseUntil) { skipped.cooldown++; continue; }
    if (used.has(r.mint)) { skipped.alreadyEntered++; continue; }
    if (r.buyAt != null) used.add(r.mint);
    selected.push(r);
    busyUntil = r.resolvedAt ?? dayEnd + 1;
    if (valid(r.pnlUsd)) {
      pnl += r.pnlUsd;
      if (r.status === 'CLOSED') lossStreak = r.pnlUsd < 0 ? lossStreak + 1 : 0;
      if (lossStreak >= 3) { pauseUntil = busyUntil + 900000; lossStreak = 0; }
      if (pnl <= -initialEquityUsd * .02) stopped = true;
    } else if (r.status.includes('UNRESOLVED')) stopped = true;
  }
  return { initialEquityUsd, selected, skipped, knownPnlUsd: pnl, stopped };
}
