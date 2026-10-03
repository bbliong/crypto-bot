export type PaperSignal = {
  type: 'PAPER_TRADE_SIGNAL';
  side: 'BUY' | 'SELL';
  paperLane: 'control' | 'aggressive-safe' | 'aggressive-optimal' | 'aggressive-wide' | 'aggressive-swing-100k' | 'aggressive-wave' | 'momentum-v2' | 'momentum-v3' | 'r5-band' | 'v3-v8' | 'v3-exit-confirmed';
  runId: string;
  mint: string;
  positionId: string;
  signalId: string;
  worker: number;
  reason: string;
  marketTradeAt: number | null;
  priceReceivedAt: number;
  decisionAt: number;
  paperRecordedAt: number;
  priceAgeMsAtDecision: number;
  sourceLagMs: number | null;
  recordingLagMs: number;
  plannedOrderAt: number;
  orderDeadlineAt: number;
  priceUsd: number;
  execution: 'PAPER_ONLY_NO_ORDER';
  actualOrderAt: null;
  actualFillAt: null;
};

export const PAPER_ORDER_TARGET_DELAY_MS = 900;
export const PAPER_ORDER_MAX_DELAY_MS = 1_000;

export type PaperOrderEvent = {
  type: 'PAPER_ORDER_SIMULATED' | 'PAPER_ORDER_DEADLINE_MISSED';
  signalId: string;
  positionId: string;
  side: 'BUY' | 'SELL';
  paperLane: 'control' | 'aggressive-safe' | 'aggressive-optimal' | 'aggressive-wide' | 'aggressive-swing-100k' | 'aggressive-wave' | 'momentum-v2' | 'momentum-v3' | 'r5-band' | 'v3-v8' | 'v3-exit-confirmed';
  mint: string;
  decisionAt: number;
  plannedOrderAt: number;
  orderDeadlineAt: number;
  simulatedOrderAt: number;
  delayMs: number;
  withinOneSecond: boolean;
  observedPriceProxyUsd: number | null;
  observedPriceProxyAt: number | null;
  actualOrderAt: null;
  actualFillAt: null;
};

/** Preserve each clock separately: market trade, local receipt, decision, and record. */
export function paperSignal(input: Omit<PaperSignal, 'type' | 'signalId' | 'priceAgeMsAtDecision' | 'sourceLagMs' | 'recordingLagMs' | 'plannedOrderAt' | 'orderDeadlineAt' | 'execution' | 'actualOrderAt' | 'actualFillAt'>): PaperSignal {
  if (!(input.priceUsd > 0) || !Number.isFinite(input.priceUsd)) throw new Error('Paper signal requires a positive observed price');
  if (input.priceReceivedAt > input.decisionAt || input.decisionAt > input.paperRecordedAt) {
    throw new Error('Paper signal local timestamps must be chronological');
  }
  return {
    ...input,
    type: 'PAPER_TRADE_SIGNAL',
    signalId: `${input.runId}:${input.positionId}:${input.side}`,
    priceAgeMsAtDecision: input.decisionAt - input.priceReceivedAt,
    sourceLagMs: input.marketTradeAt === null ? null : input.priceReceivedAt - input.marketTradeAt,
    recordingLagMs: input.paperRecordedAt - input.decisionAt,
    plannedOrderAt: input.decisionAt + PAPER_ORDER_TARGET_DELAY_MS,
    orderDeadlineAt: input.decisionAt + PAPER_ORDER_MAX_DELAY_MS,
    execution: 'PAPER_ONLY_NO_ORDER',
    actualOrderAt: null,
    actualFillAt: null,
  };
}

/** A clocked paper step, never evidence that a GMGN request was submitted. */
export function paperOrderEvent(signal: PaperSignal, simulatedOrderAt: number, price?: { observedAt: number; priceUsd: number } | null): PaperOrderEvent {
  if (simulatedOrderAt < signal.decisionAt) throw new Error('Paper order cannot precede its signal');
  const withinOneSecond = simulatedOrderAt <= signal.orderDeadlineAt;
  const freshPrice = price && price.observedAt >= signal.priceReceivedAt
    && price.observedAt <= simulatedOrderAt && simulatedOrderAt - price.observedAt <= 2_000 && price.priceUsd > 0
    ? price : null;
  return {
    type: withinOneSecond ? 'PAPER_ORDER_SIMULATED' : 'PAPER_ORDER_DEADLINE_MISSED',
    signalId: signal.signalId, positionId: signal.positionId, side: signal.side, paperLane: signal.paperLane, mint: signal.mint,
    decisionAt: signal.decisionAt, plannedOrderAt: signal.plannedOrderAt,
    orderDeadlineAt: signal.orderDeadlineAt, simulatedOrderAt,
    delayMs: simulatedOrderAt - signal.decisionAt, withinOneSecond,
    observedPriceProxyUsd: freshPrice?.priceUsd ?? null,
    observedPriceProxyAt: freshPrice?.observedAt ?? null,
    actualOrderAt: null, actualFillAt: null,
  };
}
