import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Lane, PROFIT4_LANE, PROFIT4_RULES, PROFIT4_TARGET_PERCENT } from './distribution-profit4-lane.js';
import { DistributionBounceLane, DistributionBounceLaneV2, DistributionBounceLaneV3, BOUNCE_DUMP_LANE, BOUNCE_DUMP_LANE_V2, BOUNCE_DUMP_LANE_V3, BOUNCE_RULES, BOUNCE_RULES_V2, BOUNCE_RULES_V3, BOUNCE_TARGET_PERCENT, BOUNCE_TARGET_PERCENT_V3 } from './distribution-bounce-lane.js';
import { TargetObservation, type TargetEvent, type TargetFacts, type TargetTrade } from './distribution-target-lane.js';
import type { SwapRouteResult, DualSellSwapResult } from './browser-swap-route.js';

type Transfer = { mint: string; wallet: string; symbol?: string; timestamp?: number };

export interface SwapProbeHandlers {
  getBuyQuote?: (mint: string) => Promise<SwapRouteResult | null>;
  getSellQuotes?: (mint: string, inputTokensBaseUnits?: string, decimals?: number) => Promise<DualSellSwapResult | null>;
}

export function atomicProfit4Json(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, path);
}

type RuntimeState = {
  key: string;
  transfer: Transfer;
  observation: TargetObservation;
  lane: DistributionProfit4Lane | DistributionBounceLane | DistributionBounceLaneV2 | DistributionBounceLaneV3;
  facts: TargetFacts | null;
  active: boolean;
  laneLabel: 'V1' | 'V2' | 'V3' | 'P4';
  version: string;
  lastDecision: unknown;
  lastEvent: TargetEvent | null;
  swapBuy?: SwapRouteResult | null;
  swapSell1?: SwapRouteResult | null;
  swapSell2?: SwapRouteResult | null;
  swapSellDeltaPct?: number | null;
  swapBuyPending?: boolean;
  swapSellPending?: boolean;
};

export class DistributionProfit4Runtime {
  private states = new Map<string, RuntimeState>();
  private observations = new Map<string, TargetObservation>();
  private lastEvaluationAt = -Infinity;
  private bought: Set<string>;
  private recentEvents: TargetEvent[] = [];
  private readonly boughtFile: string;
  private swapHandlers: SwapProbeHandlers | null = null;
  readonly laneType: 'profit4' | 'bounce';
  readonly targetPercent: number;
  readonly laneRules: typeof PROFIT4_RULES | typeof BOUNCE_RULES;
  readonly laneName: string;

  constructor(private readonly run: string, private readonly write: (name: string, value: unknown) => void,
    private readonly dataDirectory: string, laneType: 'profit4' | 'bounce' = 'profit4') {
    this.laneType = laneType;
    this.targetPercent = laneType === 'bounce' ? BOUNCE_TARGET_PERCENT : PROFIT4_TARGET_PERCENT;
    this.laneRules = laneType === 'bounce' ? BOUNCE_RULES : PROFIT4_RULES;
    this.laneName = laneType === 'bounce' ? BOUNCE_DUMP_LANE : PROFIT4_LANE;
    this.boughtFile = join(dataDirectory, 'bought-mints.json');
    const saved = existsSync(this.boughtFile) ? JSON.parse(readFileSync(this.boughtFile, 'utf8')) : { mints: [] };
    if (!Array.isArray(saved.mints) || saved.mints.some((s: unknown) => typeof s !== 'string')) throw new Error('Ledger bought-mints tidak valid.');
    this.bought = new Set(saved.mints);
    this.write('profit4-events.jsonl', { type: 'PAPER_LANE_READY', observedAt: Date.now(), paperLane: this.laneName,
      rules: this.laneRules, targetPercent: this.targetPercent, execution: 'PAPER_QUOTE', rounds: 1, dualLanes: laneType === 'bounce' ? ['V1', 'V2'] : ['P4'] });
    this.persist(Date.now());
  }

  setSwapProbeHandlers(handlers: SwapProbeHandlers) {
    this.swapHandlers = handlers;
  }

  private triggerSwapBuy(mint: string) {
    const statesForMint = [...this.states.values()].filter(s => s.transfer.mint === mint);
    if (!statesForMint.length || statesForMint.some(s => s.swapBuyPending) || statesForMint.some(s => s.swapBuy) || !this.swapHandlers?.getBuyQuote) return;
    statesForMint.forEach(s => { s.swapBuyPending = true; });
    this.swapHandlers.getBuyQuote(mint).then(quote => {
      statesForMint.forEach(s => {
        s.swapBuyPending = false;
        if (quote) s.swapBuy = quote;
      });
      if (quote) {
        this.write('profit4-events.jsonl', {
          type: 'SWAP_BUY_QUOTE',
          mint,
          observedAt: Date.now(),
          transfer: statesForMint[0].transfer,
          quote: quote.quote,
          impliedPriceUsd: quote.impliedPriceUsd,
          latencyMs: quote.latencyMs,
          status: quote.status,
          ok: quote.ok,
          error: quote.error,
        });
        this.persist(Date.now());
      }
    }).catch(() => { statesForMint.forEach(s => { s.swapBuyPending = false; }); });
  }

  private triggerSwapSell(key: string) {
    const state = this.states.get(key);
    if (!state || state.swapSellPending || state.swapSell1 || !this.swapHandlers?.getSellQuotes) return;
    state.swapSellPending = true;
    const outAmount = state.swapBuy?.quote?.outAmount;
    let tokenUnits = outAmount;
    if (!tokenUnits && state.lane.entryPrice && state.lane.entryPrice > 0) {
      const r = this.laneRules;
      const tokens = (r.stakeUsd * (1 - r.feePercentPerSide / 100) - r.fixedFeeUsdPerSide) / (state.lane.entryPrice * (1 + r.slippagePercentPerSide / 100));
      tokenUnits = Math.floor(tokens * 1_000_000).toString();
    }
    tokenUnits = tokenUnits || '1000000000';
    const decimals = state.swapBuy?.quote?.outDecimals ?? 6;

    this.swapHandlers.getSellQuotes(state.transfer.mint, tokenUnits, decimals).then(dual => {
      state.swapSellPending = false;
      if (dual) {
        state.swapSell1 = dual.quote1;
        state.swapSell2 = dual.quote2;
        state.swapSellDeltaPct = dual.priceDeltaPct;
        this.write('profit4-events.jsonl', {
          type: 'SWAP_SELL_QUOTES',
          mint: state.transfer.mint,
          laneLabel: state.laneLabel,
          observedAt: Date.now(),
          transfer: state.transfer,
          quote1: dual.quote1.quote,
          impliedPriceUsd1: dual.quote1.impliedPriceUsd,
          latencyMs1: dual.quote1.latencyMs,
          quote2: dual.quote2.quote,
          impliedPriceUsd2: dual.quote2.impliedPriceUsd,
          latencyMs2: dual.quote2.latencyMs,
          priceDeltaPct: dual.priceDeltaPct,
        });
        this.persist(Date.now());
      }
    }).catch(() => { state.swapSellPending = false; });
  }

  register(transfer: Transfer, now: number) {
    if (this.observations.has(transfer.mint)) return;
    const observation = new TargetObservation((transfer.timestamp ?? now / 1000) * 1000);
    this.observations.set(transfer.mint, observation);

    const makeOnEvent = (laneKey: string, laneLabel: 'V1' | 'V2' | 'V3' | 'P4') => (event: TargetEvent) => {
      const state = this.states.get(laneKey);
      if (state) {
        state.lastEvent = event;
        if (event.type === 'PAPER_ENTRY_DECISION') state.lastDecision = { allowed: event.allowed, reasons: event.reasons, observedAt: event.observedAt };
      }
      if (event.type === 'PAPER_ENTRY_SIGNAL') {
        this.triggerSwapBuy(transfer.mint);
      }
      if (event.type === 'PAPER_BUY') {
        this.bought.add(this.laneType === 'bounce' ? `${transfer.mint}:${laneLabel.toLowerCase()}` : transfer.mint);
        atomicProfit4Json(this.boughtFile, { updatedAt: event.observedAt, mints: [...this.bought] });
        this.triggerSwapBuy(transfer.mint);
      }
      if (event.type === 'PAPER_EXIT_SIGNAL' || event.type === 'PAPER_SELL') {
        this.triggerSwapSell(laneKey);
      }
      const { facts: _facts, ...small } = event;
      const record = {
        ...small,
        transfer,
        laneLabel,
        ...(state?.swapBuy?.impliedPriceUsd ? { swapBuyPrice: state.swapBuy.impliedPriceUsd } : {}),
        ...(state?.swapSell2?.impliedPriceUsd ? { swapSellPrice2: state.swapSell2.impliedPriceUsd } : {}),
      };
      this.recentEvents.push(record); if (this.recentEvents.length > 60) this.recentEvents.shift();
      this.write('profit4-events.jsonl', record);
    };

    if (this.laneType === 'bounce') {
      const keyV1 = `${transfer.mint}:v1`;
      const keyV2 = `${transfer.mint}:v2`;
      const keyV3 = `${transfer.mint}:v3`;
      const laneV1 = new DistributionBounceLane(transfer.mint, makeOnEvent(keyV1, 'V1'));
      const laneV2 = new DistributionBounceLaneV2(transfer.mint, makeOnEvent(keyV2, 'V2'));
      const laneV3 = new DistributionBounceLaneV3(transfer.mint, makeOnEvent(keyV3, 'V3'));

      this.states.set(keyV1, { key: keyV1, transfer, observation, lane: laneV1, facts: null, active: true, laneLabel: 'V1', version: BOUNCE_RULES.version, lastDecision: null, lastEvent: null });
      this.states.set(keyV2, { key: keyV2, transfer, observation, lane: laneV2, facts: null, active: true, laneLabel: 'V2', version: BOUNCE_RULES_V2.version, lastDecision: null, lastEvent: null });
      this.states.set(keyV3, { key: keyV3, transfer, observation, lane: laneV3, facts: null, active: true, laneLabel: 'V3', version: BOUNCE_RULES_V3.version, lastDecision: null, lastEvent: null });

      const invalidTime = !Number.isFinite(transfer.timestamp) || !transfer.timestamp || transfer.timestamp * 1000 > now + 2000;
      if (this.bought.has(`${transfer.mint}:v1`)) laneV1.end(now, 'ONE_ROUND_ALREADY_ENTERED');
      else if (invalidTime) laneV1.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');

      if (this.bought.has(`${transfer.mint}:v2`)) laneV2.end(now, 'ONE_ROUND_ALREADY_ENTERED');
      else if (invalidTime) laneV2.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');

      if (this.bought.has(`${transfer.mint}:v3`)) laneV3.end(now, 'ONE_ROUND_ALREADY_ENTERED');
      else if (invalidTime) laneV3.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
    } else {
      const key = transfer.mint;
      const lane = new DistributionProfit4Lane(transfer.mint, makeOnEvent(key, 'P4'));
      this.states.set(key, { key, transfer, observation, lane, facts: null, active: true, laneLabel: 'P4', version: PROFIT4_RULES.version, lastDecision: null, lastEvent: null });
      if (this.bought.has(transfer.mint)) lane.end(now, 'ONE_ROUND_ALREADY_ENTERED');
      else if (!Number.isFinite(transfer.timestamp) || !transfer.timestamp || transfer.timestamp * 1000 > now + 2000) lane.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
    }
    this.persist(now);
  }

  trade(mint: string, trade: TargetTrade) { this.observations.get(mint)?.trade(trade); }
  holderFrame(mint: string, body: unknown, at: number) {
    const obs = this.observations.get(mint), frame = body as { channel?: string; data?: any[] } | null;
    if (!obs || !Array.isArray(frame?.data)) return;
    for (const row of frame.data) {
      if ((row.ta ?? row.token_address ?? row.a ?? mint) !== mint) continue;
      if (frame.channel === 'token_general_stat_num' && row.t === 'holder_count' && Number.isFinite(Number(row.v))) {
        obs.count({ at, count: Number(row.v) });
      } else if (frame.channel === 'token_holding' || frame.channel === 'token_tag_holding') {
        for (const holder of row.h ?? []) if (holder.wa && Number.isFinite(Number(holder.b))) {
          obs.holding(holder.wa, { at, amount: Number(holder.b), sells: Number.isFinite(holder.ts) ? holder.ts : null });
        }
      }
    }
  }

  evaluate(now: number) {
    if (now - this.lastEvaluationAt < 1000) return;
    this.lastEvaluationAt = now;
    for (const state of this.states.values()) {
      if (!state.active) continue;
      const facts = state.observation.facts(now, []); state.facts = facts;
      if (state.lane.entryAt === null && facts.firstAt !== null && now - facts.firstAt > state.lane.rules.maxEntryWaitSeconds * 1000)
        state.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
      else {
        state.lane.step(facts);
        if (state.lane.phase === 'ENTRY_PENDING') {
          this.triggerSwapBuy(state.transfer.mint);
        } else if (state.lane.phase === 'EXIT_PENDING') {
          this.triggerSwapSell(state.key);
        }
      }
    }
    this.persist(now);
  }

  end(mint: string, now: number, reason: string) {
    for (const state of this.states.values()) {
      if (state.transfer.mint === mint && state.active) {
        state.lane.end(now, reason);
        state.active = false;
      }
    }
    this.persist(now);
  }

  shutdown(now: number) {
    for (const state of this.states.values()) {
      if (state.active) {
        state.lane.end(now, 'WORKER_STOPPED');
        state.active = false;
      }
    }
    this.persist(now);
  }

  private persist(now: number) {
    atomicProfit4Json(join(this.run, 'profit4-state.json'), { observedAt: now, paperLane: this.laneName, rounds: 1,
      execution: 'PAPER_QUOTE', status: 'EXPERIMENTAL', targetPercent: this.targetPercent, rules: this.laneRules,
      recentEvents: this.recentEvents,
      positions: [...this.states.values()].map(s => ({ ...s.transfer, captureActive: s.active,
        laneLabel: s.laneLabel, phase: s.lane.phase, version: s.lane.rules.version, targetPercent: this.targetPercent,
        entryAt: s.lane.entryAt, entryPrice: s.lane.entryPrice, exitAt: s.lane.exitAt, exitPrice: s.lane.exitPrice,
        netReturnPercent: s.lane.netReturnPercent, pnlUsd: s.lane.netReturnPercent === null ? null : s.lane.netReturnPercent / 100 * s.lane.rules.stakeUsd,
        estimatedOpenNetPercent: s.lane.entryAt !== null && s.lane.exitAt === null && s.active && s.facts?.price !== null && s.facts?.price !== undefined
          ? s.lane.net(s.facts.price) : null, lastDecision: s.lastDecision,
        lastEvent: s.lastEvent ? { type: s.lastEvent.type, observedAt: s.lastEvent.observedAt, reason: s.lastEvent.reason, reasons: s.lastEvent.reasons } : null,
        facts: s.facts,
        swapBuyPrice: s.swapBuy?.impliedPriceUsd ?? null,
        swapBuyOk: s.swapBuy?.ok ?? null,
        swapBuyError: s.swapBuy?.error ?? null,
        swapBuySpreadPct: (s.swapBuy?.impliedPriceUsd && s.lane.entryPrice)
          ? ((s.swapBuy.impliedPriceUsd - s.lane.entryPrice) / s.lane.entryPrice) * 100
          : null,
        swapBuyLatencyMs: s.swapBuy?.latencyMs ?? null,
        swapSellPrice1: s.swapSell1?.impliedPriceUsd ?? null,
        swapSellPrice2: s.swapSell2?.impliedPriceUsd ?? null,
        swapSellOk1: s.swapSell1?.ok ?? null,
        swapSellOk2: s.swapSell2?.ok ?? null,
        swapSellDeltaPct: s.swapSellDeltaPct ?? null,
        swapSellSpreadPct: (s.swapSell2?.impliedPriceUsd && s.lane.exitPrice)
          ? ((s.swapSell2.impliedPriceUsd - s.lane.exitPrice) / s.lane.exitPrice) * 100
          : null,
        swapSellLatencyMs: (s.swapSell1?.latencyMs ?? 0) + (s.swapSell2?.latencyMs ?? 0),
      })) });
  }
}
