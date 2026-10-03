/** Codex-only research lane. No broker, wallet, collector or Gemini lane imports. */
export const CODEX_GUARDED_WAVE_ID = 'codex-guarded-wave-v1';
export type EntryRules = {
  id: string; historyMs: number; holderFreshMs: number; devFreshMs: number; countFreshMs: number;
  minReturn: number; maxReturn: number; maxDrawdown: number; buyShare5: number; buyShare20: number; buyers: number;
};
const entryBase: EntryRules = { id: 'frozen', historyMs: 20_000, holderFreshMs: 10_000, devFreshMs: 10_000,
  countFreshMs: 10_000, minReturn: .25, maxReturn: 20, maxDrawdown: 2.5, buyShare5: .6, buyShare20: .65, buyers: 4 };
// A small, declared research family, not an open-ended search for a winning backtest.
export const CODEX_ENTRY_PROFILES: readonly EntryRules[] = Object.freeze([
  { ...entryBase },
  { ...entryBase, id: 'cadence', holderFreshMs: 15_000, devFreshMs: 35_000, countFreshMs: 15_000 },
  { ...entryBase, id: 'snapshot30', holderFreshMs: 30_000, devFreshMs: 35_000, countFreshMs: 30_000 },
  { ...entryBase, id: 'quality', holderFreshMs: 15_000, devFreshMs: 35_000, countFreshMs: 15_000,
    minReturn: .5, maxReturn: 12, buyShare5: .65, buyShare20: .7, buyers: 5 },
  { ...entryBase, id: 'recovery', holderFreshMs: 15_000, devFreshMs: 35_000, countFreshMs: 15_000,
    minReturn: .5, maxReturn: 10, maxDrawdown: 1.5, buyShare5: .65 },
  { ...entryBase, id: 'continuation', holderFreshMs: 15_000, devFreshMs: 35_000, countFreshMs: 15_000,
    minReturn: 2, maxReturn: 15, buyShare5: .7, buyShare20: .7 },
].map(profile => Object.freeze(profile)));
export type Features = {
  at: number; price: number | null; ready: boolean; historyMs: number; socketAgeMs: number;
  tokenAgeSec: number | null; holderAgeMs: number | null; devAgeMs: number | null; countAgeMs: number | null;
  holderValid: boolean; devValid: boolean; count: number | null; mc: number | null;
  top1: number | null; top5: number | null; dev: number | null;
  return5: number | null; slope5: number | null; drawdown5: number | null; trades5: number;
  buyers5: number; buyUsd5: number; topBuyerShare: number | null; buyShare5: number | null; buyShare20: number | null;
  devSell30: number; majorSell: boolean; candleValid: boolean; solUsd: number | null; solAgeMs: number | null;
};
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const fresh = (age: number | null, max: number) => finite(age) && age >= 0 && age <= max;

/** Observable setup ONLY. This is not permission to submit a transaction. */
export function assessCodexSetup(f: Features, r: EntryRules = CODEX_ENTRY_PROFILES[0]!) {
  const reasons: string[] = [];
  if (!f.ready || !finite(f.historyMs) || f.historyMs < r.historyMs) reasons.push('HISTORY');
  if (!finite(f.price) || f.price <= 0 || !fresh(f.socketAgeMs, 750)) reasons.push('SOCKET');
  if (!finite(f.tokenAgeSec) || f.tokenAgeSec < 60) reasons.push('AGE');
  if (!f.holderValid || !fresh(f.holderAgeMs, r.holderFreshMs)) reasons.push('HOLDER');
  if (!f.devValid || !fresh(f.devAgeMs, r.devFreshMs)) reasons.push('DEV');
  if (!finite(f.count) || f.count < 100 || !fresh(f.countAgeMs, r.countFreshMs)) reasons.push('HOLDER_COUNT');
  if (!finite(f.mc) || f.mc < 10_000 || f.mc > 100_000) reasons.push('MC');
  if (!finite(f.top1) || !finite(f.top5) || !finite(f.dev) || f.top1 < 0 || f.top5 < f.top1 || f.dev < 0 ||
    f.top1 > 8 || f.top5 > 25 || f.dev > 2.5) reasons.push('DISTRIBUTION');
  if (!finite(f.return5) || !finite(f.slope5) || !finite(f.drawdown5) || f.return5 < r.minReturn ||
    f.return5 > r.maxReturn || f.slope5 <= 0 || f.drawdown5 < 0 || f.drawdown5 > r.maxDrawdown) reasons.push('MOMENTUM');
  if (!Number.isInteger(f.trades5) || f.trades5 < 5 || !Number.isInteger(f.buyers5) || f.buyers5 < r.buyers ||
    !finite(f.buyUsd5) || f.buyUsd5 < 300 || !finite(f.topBuyerShare) || f.topBuyerShare < 0 || f.topBuyerShare > .5 ||
    !finite(f.buyShare5) || f.buyShare5 < r.buyShare5 || f.buyShare5 > 1 ||
    !finite(f.buyShare20) || f.buyShare20 < r.buyShare20 || f.buyShare20 > 1) reasons.push('FLOW');
  if (!finite(f.devSell30) || f.devSell30 >= 25 || f.majorSell) reasons.push('MAJOR_SELL');
  if (!f.candleValid) reasons.push('CANDLE');
  if (!finite(f.solUsd) || f.solUsd <= 0 || !fresh(f.solAgeMs, 120_000)) reasons.push('SOL_SPOT');
  return { allowed: reasons.length === 0, reasons };
}

export type Arm = { at: number; price: number; tickId: string } | null;
/** Re-evaluated on each received observation; duplicate ticks never confirm an order. */
export function confirmCodexSetup(arm: Arm, allowed: boolean, at: number, price: number, tickId: string) {
  if (!allowed || !finite(price) || price <= 0) return { arm: null, confirmed: false };
  if (!arm || at < arm.at || at - arm.at > 500 || Math.abs(price / arm.price - 1) > .02)
    return { arm: { at, price, tickId }, confirmed: false };
  if (at - arm.at < 150 || tickId === arm.tickId) return { arm, confirmed: false };
  return { arm: null, confirmed: true };
}

export type ExecutionEvidence = {
  now: number; stakeUsd: number; liquidEquityUsd: number | null; unresolvedPosition: boolean;
  mintVerified: boolean | null; poolVerified: boolean | null; sellSimulationOk: boolean | null;
  quoteReceivedAt: number | null; quoteSlot: number | null; quoteRttMs: number | null;
  quantityMatches: boolean; quoteImpactPct: number | null; quoteSocketDeviationPct: number | null;
  buyAllInSol: number | null; immediateSellNetSol: number | null; minimumSellNetSol: number | null;
};
/** Fail closed. Caller supplies exact-quantity, fee-reconciled SOL amounts, not socket proxies. */
export function assessCodexExecution(e: ExecutionEvidence) {
  const reasons: string[] = [];
  if (e.mintVerified !== true || e.poolVerified !== true || e.sellSimulationOk !== true) reasons.push('STRUCTURAL_EVIDENCE');
  if (!finite(e.quoteReceivedAt) || !fresh(e.now - e.quoteReceivedAt, 750) || !finite(e.quoteSlot) || e.quoteSlot <= 0 ||
    !finite(e.quoteRttMs) || e.quoteRttMs < 0 || e.quoteRttMs > 1_000 || !e.quantityMatches) reasons.push('QUOTE');
  if (!finite(e.quoteImpactPct) || Math.abs(e.quoteImpactPct) > 1 || !finite(e.quoteSocketDeviationPct) ||
    Math.abs(e.quoteSocketDeviationPct) > 2) reasons.push('IMPACT_OR_DIVERGENCE');
  const expected = finite(e.buyAllInSol) && e.buyAllInSol > 0 && finite(e.immediateSellNetSol)
    ? (e.immediateSellNetSol / e.buyAllInSol - 1) * 100 : null;
  const minimum = finite(e.buyAllInSol) && e.buyAllInSol > 0 && finite(e.minimumSellNetSol)
    ? (e.minimumSellNetSol / e.buyAllInSol - 1) * 100 : null;
  if (expected === null || expected < -3 || minimum === null || minimum < -6 || minimum > expected) reasons.push('COST');
  if (!finite(e.stakeUsd) || e.stakeUsd <= 0 || !finite(e.liquidEquityUsd) || e.liquidEquityUsd <= 0 ||
    e.stakeUsd > e.liquidEquityUsd * .01 || e.unresolvedPosition) reasons.push('CAPITAL');
  return { allowed: reasons.length === 0, reasons, expectedReturnPct: expected, minimumReturnPct: minimum };
}

export type ExitRules = { id: string; hardNet: number; hardSocket: number; floorActivate: number; floor: number;
  runnerActivate: number; runnerFloor: number; trail: number; stagnationMs: number; maxHoldMs: number };
export const CODEX_EXIT_PROFILES: readonly ExitRules[] = Object.freeze([
  { id: 'balanced', hardNet: -6, hardSocket: -8, floorActivate: 8, floor: 1.5,
    runnerActivate: 12, runnerFloor: 3, trail: 5, stagnationMs: 20_000, maxHoldMs: 90_000 },
  { id: 'defensive', hardNet: -4, hardSocket: -6, floorActivate: 6, floor: 1,
    runnerActivate: 8, runnerFloor: 2, trail: 4, stagnationMs: 15_000, maxHoldMs: 45_000 },
  { id: 'runner', hardNet: -6, hardSocket: -8, floorActivate: 8, floor: 1.5,
    runnerActivate: 12, runnerFloor: 3, trail: 7, stagnationMs: 25_000, maxHoldMs: 90_000 },
].map(profile => Object.freeze(profile)));
export type ExitState = { openedAt: number; peakNet: number; floorNet: number | null; breachAt: number | null; lastTickId: string | null };
export function codexExitState(openedAt: number): ExitState {
  return { openedAt, peakNet: -Infinity, floorNet: null, breachAt: null, lastTickId: null };
}
export type ExitObservation = { at: number; net: number | null; socket: number | null; stale: boolean;
  structuralDanger: boolean; collapse1s: number | null; buyShare5: number | null; sellUsd5: number;
  sellers5: number; slope5: number | null; tickId: string; newTick: boolean };
/** Returns an EXIT REQUEST. The caller must not interpret it as a fill or CLOSED position. */
export function assessCodexExit(s: ExitState, o: ExitObservation, r: ExitRules = CODEX_EXIT_PROFILES[0]!) {
  if (o.structuralDanger) return 'STRUCTURAL_DANGER';
  if (o.stale || !finite(o.net) || !finite(o.socket)) return 'DATA_STALE';
  s.peakNet = Math.max(s.peakNet, o.net);
  if (finite(o.collapse1s) && o.collapse1s <= -8 && finite(o.buyShare5) && o.buyShare5 <= .3) return 'FLASH_CRASH';
  if (o.net <= r.hardNet || o.socket <= r.hardSocket) return 'HARD_RISK';
  const broken = finite(o.buyShare5) && o.buyShare5 <= .3 && o.sellUsd5 >= 150 && o.sellers5 >= 3 &&
    finite(o.slope5) && o.slope5 < 0;
  if (!broken) s.breachAt = null;
  else if (o.newTick && o.tickId !== s.lastTickId) {
    if (s.breachAt !== null && o.at > s.breachAt && o.at - s.breachAt <= 500) return 'FLOW_BROKEN';
    s.breachAt = o.at; s.lastTickId = o.tickId;
  }
  if (s.peakNet >= r.floorActivate) s.floorNet = Math.max(s.floorNet ?? -Infinity, r.floor);
  if (s.peakNet >= r.runnerActivate) s.floorNet = Math.max(s.floorNet ?? -Infinity, r.runnerFloor, (100 + s.peakNet) * (1 - r.trail / 100) - 100);
  if (s.floorNet !== null && o.net <= s.floorNet) return 'PROFIT_FLOOR';
  if (o.net >= 20 && ((o.buyShare5 ?? 0) < .65 || (o.slope5 ?? 0) <= 0)) return 'SOFT_TARGET';
  if (o.at - s.openedAt >= r.stagnationMs && s.peakNet < 3 && ((o.buyShare5 ?? 0) < .6 || (o.slope5 ?? 0) <= 0)) return 'STAGNATION';
  if (o.at - s.openedAt >= r.maxHoldMs) return 'TIME_LIMIT';
  return null;
}
