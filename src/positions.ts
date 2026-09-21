export interface Position {
  mint: string; kind: 'manual' | 'paper'; filledAt: number;
  quantity: number; fillPriceUsd: number; entryFeesUsd: number;
}
export interface ExitQuote {
  mint: string; observedAt: number; quantity: number;
  // Total proceeds AFTER price impact, fees, slippage.
  netProceedsUsd: number;
}
export function assessExit(p: Position, q: ExitQuote, now = Date.now(), maxAgeMs = 5000) {
  if (q.mint !== p.mint || q.quantity !== p.quantity || !Number.isFinite(q.observedAt) || !Number.isFinite(p.filledAt) || now - q.observedAt > maxAgeMs || q.observedAt > now || q.observedAt < p.filledAt) return { status: 'INSUFFICIENT_EVIDENCE' as const };
  if (![p.quantity, p.fillPriceUsd].every(v => Number.isFinite(v) && v > 0)
    || ![p.entryFeesUsd, q.netProceedsUsd].every(v => Number.isFinite(v) && v >= 0)) return { status: 'INSUFFICIENT_EVIDENCE' as const };
  const cost = p.quantity * p.fillPriceUsd + p.entryFeesUsd;
  const netPnlPercent = (q.netProceedsUsd / cost - 1) * 100;
  return { status: netPnlPercent >= 50 ? 'TARGET_REACHED' as const : 'POSITION_OPEN' as const, netPnlPercent };
}
