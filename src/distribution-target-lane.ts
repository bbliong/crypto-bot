/** Read-only paper strategy; neither signals nor fills call an order API. */
export const DISTRIBUTION_TARGET_LANE = 'distribution-target-20-25';
export type TargetRules = {
  version: string; paperOnly: true; enabled: boolean; targetPercent: number;
  observationSeconds: number; minTransferAgeSeconds: number; maxTransferLagSeconds: number;
  maxEntryWaitSeconds: number; confirmSeconds: number; minBuySharePercent: number;
  minMeaningfulBuyUsd: number; minMeaningfulBuyers: number; maxBuyerSharePercent: number;
  minMomentumPercent: number; maxMomentumPercent: number; maxEntryReturnPercent: number;
  maxDrawdownPercent: number; stopLossPercent: number; trailingStartPercent: number;
  trailingDrawdownPercent: number; maxHoldSeconds: number; executionDelayMs: number;
  maxFillWaitMs: number; feePercentPerSide: number; slippagePercentPerSide: number;
  fixedFeeUsdPerSide: number; stakeUsd: number; blockKnownDumpSellers: boolean;
};
export const DEFAULT_TARGET_RULES: TargetRules = {
  version: 'distribution-target-v1', paperOnly: true, enabled: true, targetPercent: 20,
  observationSeconds: 30, minTransferAgeSeconds: 60, maxTransferLagSeconds: 15,
  maxEntryWaitSeconds: 180, confirmSeconds: 3, minBuySharePercent: 60,
  minMeaningfulBuyUsd: 30, minMeaningfulBuyers: 2, maxBuyerSharePercent: 75,
  minMomentumPercent: 0.1, maxMomentumPercent: 5, maxEntryReturnPercent: 15,
  maxDrawdownPercent: 5, stopLossPercent: 5, trailingStartPercent: 15,
  trailingDrawdownPercent: 4, maxHoldSeconds: 300, executionDelayMs: 1000,
  maxFillWaitMs: 5000, feePercentPerSide: 1, slippagePercentPerSide: 0.5,
  fixedFeeUsdPerSide: 0.005, stakeUsd: 5, blockKnownDumpSellers: true,
};
export function validateTargetRules(value: unknown): TargetRules {
  const r = value as TargetRules;
  if (!r || r.paperOnly !== true || typeof r.targetPercent !== 'number' || r.targetPercent <= 0) throw new Error('Lane hanya paper, targetPercent harus positif.');
  for (const k of Object.keys(DEFAULT_TARGET_RULES) as (keyof TargetRules)[]) {
    if (typeof DEFAULT_TARGET_RULES[k] === 'number' && (!Number.isFinite(r[k]) || Number(r[k]) < 0)) throw new Error(`Rule invalid: ${k}`);
  }
  if (typeof r.version !== 'string' || !r.version || typeof r.enabled !== 'boolean' || typeof r.blockKnownDumpSellers !== 'boolean'
    || r.stakeUsd <= 0 || r.executionDelayMs < 1000 || r.maxFillWaitMs < r.executionDelayMs
    || r.feePercentPerSide >= 100 || r.slippagePercentPerSide >= 100 || r.fixedFeeUsdPerSide * 2 >= r.stakeUsd
    || r.confirmSeconds < 1 || r.minBuySharePercent > 100 || r.maxBuyerSharePercent > 100
    || r.observationSeconds < 15 || r.minTransferAgeSeconds < 30) throw new Error('Rule risk/latency invalid.');
  return structuredClone(r);
}
export type TargetTrade = { at: number; timestamp: number; price: number; side: string; wallet: string; usd: number | null; signature?: string };
export type TargetHolding = { at: number; amount: number; sells: number | null };
export type TargetCount = { at: number; count: number };
export type RiskSeller = { wallet: string; knownAt: number };
export type TargetFacts = {
  now: number; firstAt: number | null; transferAt: number; price: number | null; priceAt: number | null;
  momentumPercent: number | null; drawdownPercent: number | null; entryReturnPercent: number | null;
  holderCount: number | null; holderGrowth15s: number | null;
  buyShareUsdPercent: number | null; meaningfulBuyUsd: number; meaningfulBuyers: number;
  topBuyerSharePercent: number | null; sellUsd: number; largestSellUsd: number;
  riskWalletsPresent: string[];
  peakPrice?: number | null;
  troughPrice?: number | null;
  bounceFromTroughPercent?: number | null;
};
const median = (rows: number[]) => {
  if (!rows.length) return null;
  const a = [...rows].sort((x, y) => x - y), n = a.length;
  return n % 2 ? a[(n - 1) / 2]! : (a[n / 2 - 1]! + a[n / 2]!) / 2;
};
export class TargetObservation {
  trades: TargetTrade[] = [];
  counts: TargetCount[] = [];
  holders = new Map<string, TargetHolding[]>();
  firstAt: number | null = null;
  private firstPrice: number | null = null;
  private peak = 0;
  private trough = Infinity;
  private ids = new Map<string, number>();
  constructor(readonly transferAt: number) {}
  trade(t: TargetTrade) {
    const lag = t.at - t.timestamp * 1000;
    if (!(t.price > 0) || !Number.isFinite(t.at) || !['buy', 'sell'].includes(t.side) || lag < -2000 || lag > 10000 || t.timestamp * 1000 < this.transferAt) return;
    const id = [t.signature || t.timestamp, t.wallet, t.side, t.price].join(':');
    if (this.ids.has(id)) return;
    this.ids.set(id, t.at); this.trades.push(t);
    if (this.firstAt === null) { this.firstAt = t.at; this.firstPrice = t.price; }
    const cutoff = t.at - 120000;
    while (this.trades.length && this.trades[0]!.at < cutoff) this.trades.shift();
    // Keep dedup identities longer than the accepted source replay interval.
    if (this.ids.size > 10000) for (const [key, at] of this.ids) if (at < cutoff) this.ids.delete(key);
  }
  count(t: TargetCount) {
    if (!Number.isInteger(t.count) || t.count < 0 || t.at < this.transferAt) return;
    this.counts.push(t);
    while (this.counts.length && this.counts[0]!.at < t.at - 60000) this.counts.shift();
  }
  holding(wallet: string, t: TargetHolding) {
    if (!wallet || !Number.isFinite(t.amount) || t.amount < 0 || t.at < this.transferAt) return;
    const rows = this.holders.get(wallet) ?? [];
    rows.push(t); rows.sort((a, b) => a.at - b.at);
    // Retain one older balance plus recent changes. A future row never erases the
    // last already-received positive balance used by an earlier decision.
    while (rows.length > 2 && rows[1]!.at < t.at - 60000) rows.shift();
    this.holders.set(wallet, rows);
  }
  facts(now: number, risks: RiskSeller[]): TargetFacts {
    const rows = this.trades.filter(t => t.at <= now);
    const recent = rows.filter(t => t.at > now - 5000);
    const before = rows.filter(t => t.at > now - 10000 && t.at <= now - 5000);
    const quotes = rows.filter(t => t.at > now - 1000 && now - t.timestamp * 1000 <= 5000);
    const last = rows.at(-1);
    const price = median(quotes.map(t => t.price)) ?? (last && now - last.at <= 2000 && now - last.timestamp * 1000 <= 5000 ? last.price : null);
    if (price !== null) {
      if (price > this.peak) {
        this.peak = price;
        this.trough = price; // reset trough when a new peak is reached
      } else if (price < this.trough) {
        this.trough = price;
      }
    }
    const a = median(recent.map(t => t.price)), b = median(before.map(t => t.price));
    const currentCount = this.counts.filter(t => t.at <= now && now - t.at <= 15000).at(-1);
    const priorCount = this.counts.filter(t => t.at <= now - 15000 && now - 15000 - t.at <= 15000).at(-1);
    const buy = recent.filter(t => t.side === 'buy'), sell = recent.filter(t => t.side === 'sell');
    const sum = (xs: TargetTrade[]) => xs.reduce((n, t) => n + (t.usd ?? 0), 0);
    const buyUsd = sum(buy), sellUsd = sum(sell), meaningful = buy.filter(t => (t.usd ?? 0) >= 1);
    const buyers = new Map<string, number>();
    for (const t of meaningful) if (t.wallet) buyers.set(t.wallet, (buyers.get(t.wallet) ?? 0) + t.usd!);
    const meaningfulUsd = sum(meaningful);
    const present = risks.filter(r => r.knownAt <= now && (
      (this.holders.get(r.wallet)?.filter(h => h.at <= now).at(-1)?.amount ?? 0) > 0
      || rows.some(t => t.wallet === r.wallet && t.at > now - 30000)
    )).map(r => r.wallet);
    const bounceFromTroughPercent = (price !== null && Number.isFinite(this.trough) && this.trough > 0 && price >= this.trough)
      ? ((price - this.trough) / this.trough) * 100
      : null;
    return { now, firstAt: this.firstAt !== null && this.firstAt <= now ? this.firstAt : null, transferAt: this.transferAt,
      price, priceAt: price !== null ? last?.at ?? null : null,
      momentumPercent: a !== null && b !== null && b > 0 ? (a / b - 1) * 100 : null,
      drawdownPercent: price !== null && this.peak > 0 ? (1 - price / this.peak) * 100 : null,
      entryReturnPercent: price !== null && this.firstPrice ? (price / this.firstPrice - 1) * 100 : null,
      holderCount: currentCount?.count ?? null, holderGrowth15s: currentCount && priorCount ? currentCount.count - priorCount.count : null,
      buyShareUsdPercent: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) * 100 : null,
      meaningfulBuyUsd: meaningfulUsd, meaningfulBuyers: buyers.size,
      topBuyerSharePercent: meaningfulUsd > 0 ? Math.max(0, ...buyers.values()) / meaningfulUsd * 100 : null,
      sellUsd, largestSellUsd: Math.max(0, ...sell.map(t => t.usd ?? 0)), riskWalletsPresent: [...new Set(present)],
      peakPrice: this.peak > 0 ? this.peak : null,
      troughPrice: Number.isFinite(this.trough) ? this.trough : null,
      bounceFromTroughPercent };
  }
}
export function assessTargetEntry(f: TargetFacts, r: TargetRules): string[] {
  const reasons: string[] = [];
  if (!r.enabled) reasons.push('LANE_DISABLED');
  if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
  if (f.firstAt !== null && f.firstAt - f.transferAt > r.maxTransferLagSeconds * 1000) reasons.push('MONITOR_STARTED_TOO_LATE');
  if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
  if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');
  if (f.holderCount === null || f.holderGrowth15s === null) reasons.push('HOLDER_HISTORY_MISSING_OR_STALE');
  else if (f.holderGrowth15s < 0) reasons.push('HOLDERS_DECLINING');
  if (f.buyShareUsdPercent === null || f.buyShareUsdPercent < r.minBuySharePercent || f.meaningfulBuyUsd < r.minMeaningfulBuyUsd || f.meaningfulBuyers < r.minMeaningfulBuyers) reasons.push('MEANINGFUL_BUY_FLOW_WEAK');
  if (f.topBuyerSharePercent === null || f.topBuyerSharePercent > r.maxBuyerSharePercent) reasons.push('BUYER_CONCENTRATION_HIGH');
  if (f.momentumPercent === null || f.momentumPercent < r.minMomentumPercent || f.momentumPercent > r.maxMomentumPercent) reasons.push('MOMENTUM_OUTSIDE_RANGE');
  if (f.drawdownPercent === null || f.drawdownPercent > r.maxDrawdownPercent || f.entryReturnPercent === null || f.entryReturnPercent > r.maxEntryReturnPercent) reasons.push('PRICE_UNSTABLE_OR_ENTRY_LATE');
  if (f.largestSellUsd >= 250) reasons.push('LARGE_SELL_ALREADY_PRESENT');
  if (r.blockKnownDumpSellers && f.riskWalletsPresent.length) reasons.push('KNOWN_DUMP_SELLER_PRESENT');
  return reasons;
}
export type TargetEvent = { type: string; observedAt: number; paperLane: string; version: string; mint: string; [key: string]: unknown };
/** Optional research policy. Runtime defaults keep the original behaviour. */
export type TargetPolicy = {
  name: string;
  paperLane?: string;
  exitMode?: 'default' | 'target-stop-time';
  trailingEnabled?: boolean;
  flowExitEnabled?: boolean;
  entryReasons?: (facts: TargetFacts) => string[];
  overrideEntryReasons?: (facts: TargetFacts, rules: TargetRules) => string[];
  exitReason?: (facts: TargetFacts, netReturnPercent: number) => string | null;
};
export class DistributionTargetLane {
  readonly rules: TargetRules;
  private readonly policy: Readonly<TargetPolicy>;
  phase: 'WATCHING' | 'ENTRY_PENDING' | 'OPEN' | 'EXIT_PENDING' | 'CLOSED' | 'CENSORED' = 'WATCHING';
  entryAt: number | null = null;
  entryPrice: number | null = null;
  exitAt: number | null = null;
  exitPrice: number | null = null;
  netReturnPercent: number | null = null;
  private confirmedAt: number | null = null;
  private lastConfirmAt: number | null = null;
  private pendingAt: number | null = null;
  private peakNet = -Infinity;
  private lastReasons = '';
  private exitReason = '';
  private lastStepAt = -Infinity;
  constructor(readonly mint: string, rules: TargetRules, private readonly emit: (event: TargetEvent) => void = () => {}, policy: TargetPolicy = { name: 'base' }) {
    this.rules = Object.freeze(validateTargetRules(rules));
    this.policy = Object.freeze({ ...policy });
  }
  private entryReasons(f: TargetFacts) {
    if (this.policy.overrideEntryReasons) {
      return this.policy.overrideEntryReasons(f, this.rules);
    }
    return [...assessTargetEntry(f, this.rules), ...(this.policy.entryReasons?.(f) ?? [])];
  }
  private event(type: string, now: number, data: Record<string, unknown> = {}) {
    this.emit({ type, observedAt: now, paperLane: this.policy.paperLane ?? DISTRIBUTION_TARGET_LANE, version: this.rules.version, mint: this.mint, paperOnly: true, policyName: this.policy.name, ...data });
  }
  net(price: number): number | null {
    if (!this.entryPrice) return null;
    const r = this.rules, fee = r.feePercentPerSide / 100, slip = r.slippagePercentPerSide / 100;
    const tokens = (r.stakeUsd * (1 - fee) - r.fixedFeeUsdPerSide) / (this.entryPrice * (1 + slip));
    const proceeds = tokens * price * (1 - slip) * (1 - fee) - r.fixedFeeUsdPerSide;
    return (proceeds / r.stakeUsd - 1) * 100;
  }
  end(now: number, reason: string) {
    if (this.phase === 'CLOSED' || this.phase === 'CENSORED') return;
    if (this.entryAt !== null) { this.phase = 'CENSORED'; this.event('PAPER_EXIT_DATA_MISSING', now, { reason, entryAt: this.entryAt, entryPrice: this.entryPrice }); }
    else { this.phase = 'CLOSED'; this.event('PAPER_NO_ENTRY', now, { reason }); }
  }
  step(f: TargetFacts) {
    if (f.now <= this.lastStepAt || this.phase === 'CLOSED' || this.phase === 'CENSORED') return;
    this.lastStepAt = f.now;
    const r = this.rules, now = f.now;
    if (this.phase === 'ENTRY_PENDING' || this.phase === 'EXIT_PENDING') {
      const deadline = this.pendingAt! + r.executionDelayMs;
      if (now > this.pendingAt! + r.maxFillWaitMs) {
        if (this.phase === 'EXIT_PENDING') this.end(now, 'EXIT_QUOTE_UNAVAILABLE_AFTER_DELAY');
        else { this.phase = 'WATCHING'; this.confirmedAt = null; this.event('PAPER_ENTRY_CANCELLED', now, { reason: 'ENTRY_QUOTE_UNAVAILABLE_AFTER_DELAY' }); }
        return;
      }
      if (now < deadline || f.price === null || f.priceAt === null || f.priceAt < deadline || now - f.priceAt > 2000) return;
      if (this.phase === 'ENTRY_PENDING') {
        const reasons = this.entryReasons(f);
        if (reasons.length) { this.phase = 'WATCHING'; this.confirmedAt = null; this.event('PAPER_ENTRY_CANCELLED', now, { reasons }); return; }
        this.entryAt = now; this.entryPrice = f.price; this.phase = 'OPEN';
        this.peakNet = this.net(f.price)!;
        this.event('PAPER_BUY', now, { priceUsd: f.price, stakeUsd: r.stakeUsd, rules: r, facts: f });
        return;
      }
      this.exitAt = now; this.exitPrice = f.price; this.netReturnPercent = this.net(f.price); this.phase = 'CLOSED';
      this.event('PAPER_SELL', now, { reason: this.exitReason, entryAt: this.entryAt, entryPriceUsd: this.entryPrice,
        priceUsd: f.price, netReturnPercent: this.netReturnPercent, pnlUsd: this.netReturnPercent! / 100 * r.stakeUsd,
        targetPercent: r.targetPercent, holdSeconds: (now - this.entryAt!) / 1000, rules: r });
      return;
    }
    if (this.phase === 'WATCHING') {
      const reasons = this.entryReasons(f), key = reasons.join('|');
      if (key !== this.lastReasons) { this.lastReasons = key; this.event('PAPER_ENTRY_DECISION', now, { allowed: !reasons.length, reasons, facts: f }); }
      if (reasons.length) { this.confirmedAt = null; this.lastConfirmAt = null; return; }
      if (this.lastConfirmAt === null || now - this.lastConfirmAt > 1500) this.confirmedAt = now;
      this.lastConfirmAt = now;
      if (now - this.confirmedAt! < (r.confirmSeconds - 1) * 1000) return;
      this.phase = 'ENTRY_PENDING'; this.pendingAt = now;
      this.event('PAPER_ENTRY_SIGNAL', now, { priceUsd: f.price, fillNotBefore: now + r.executionDelayMs });
      return;
    }
    if (f.price === null || f.priceAt === null || now - f.priceAt > 2000) return;
    const net = this.net(f.price)!;
    this.peakNet = Math.max(this.peakNet, net);
    let reason = '';
    if (net <= -r.stopLossPercent) reason = 'STOP_LOSS';
    else if (net >= r.targetPercent) reason = 'TARGET_NET';
    else if (this.policy.exitMode !== 'target-stop-time' && this.policy.trailingEnabled !== false && this.peakNet >= r.trailingStartPercent && this.peakNet - net >= r.trailingDrawdownPercent) reason = 'TRAILING_PROFIT';
    else if (this.policy.exitMode !== 'target-stop-time' && this.policy.exitReason) reason = this.policy.exitReason(f, net) ?? '';
    if (this.policy.exitMode !== 'target-stop-time' && this.policy.flowExitEnabled !== false && !reason && (f.largestSellUsd >= 250 || f.sellUsd >= 100 && (f.buyShareUsdPercent ?? 100) <= 15 && (f.momentumPercent ?? 0) < 0)) reason = 'FLOW_OR_LARGE_SELL';
    if (!reason && now - this.entryAt! >= r.maxHoldSeconds * 1000) reason = 'MAX_HOLD';
    if (!reason) return;
    this.phase = 'EXIT_PENDING'; this.pendingAt = now; this.exitReason = reason;
    this.event('PAPER_EXIT_SIGNAL', now, { reason, netReturnPercent: net, priceUsd: f.price, fillNotBefore: now + r.executionDelayMs });
  }
}
