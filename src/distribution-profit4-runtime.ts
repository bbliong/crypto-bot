import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Lane, PROFIT4_LANE, PROFIT4_RULES, PROFIT4_TARGET_PERCENT } from './distribution-profit4-lane.js';
import { TargetObservation, type TargetEvent, type TargetFacts, type TargetTrade } from './distribution-target-lane.js';

type Transfer = { mint: string; wallet: string; symbol?: string; timestamp?: number };
export function atomicProfit4Json(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value)); renameSync(temp, path);
}
export class DistributionProfit4Runtime {
  private states = new Map<string, { transfer: Transfer; observation: TargetObservation; lane: DistributionProfit4Lane;
    facts: TargetFacts | null; active: boolean; lastDecision: unknown; lastEvent: TargetEvent | null }>();
  private lastEvaluationAt = -Infinity;
  private bought: Set<string>;
  private recentEvents: TargetEvent[] = [];
  private readonly boughtFile: string;
  constructor(private readonly run: string, private readonly write: (name: string, value: unknown) => void,
    private readonly dataDirectory: string) {
    this.boughtFile = join(dataDirectory, 'bought-mints.json');
    const saved = existsSync(this.boughtFile) ? JSON.parse(readFileSync(this.boughtFile, 'utf8')) : { mints: [] };
    if (!Array.isArray(saved.mints) || saved.mints.some((s: unknown) => typeof s !== 'string')) throw new Error('Ledger bought-mints tidak valid.');
    this.bought = new Set(saved.mints);
    this.write('profit4-events.jsonl', { type: 'PAPER_LANE_READY', observedAt: Date.now(), paperLane: PROFIT4_LANE,
      rules: PROFIT4_RULES, targetPercent: PROFIT4_TARGET_PERCENT, execution: 'PAPER_QUOTE', rounds: 1 });
    this.persist(Date.now());
  }
  register(transfer: Transfer, now: number) {
    if (this.states.has(transfer.mint)) return;
    const observation = new TargetObservation((transfer.timestamp ?? now / 1000) * 1000);
    const lane = new DistributionProfit4Lane(transfer.mint, event => {
      const state = this.states.get(transfer.mint);
      if (state) {
        state.lastEvent = event;
        if (event.type === 'PAPER_ENTRY_DECISION') state.lastDecision = { allowed: event.allowed, reasons: event.reasons, observedAt: event.observedAt };
      }
      if (event.type === 'PAPER_BUY') {
        this.bought.add(transfer.mint);
        // A restart cannot create another round on a mint already entered.
        atomicProfit4Json(this.boughtFile, { updatedAt: event.observedAt, mints: [...this.bought] });
      }
      const { facts: _facts, ...small } = event;
      const record = { ...small, transfer };
      this.recentEvents.push(record); if (this.recentEvents.length > 60) this.recentEvents.shift();
      this.write('profit4-events.jsonl', record);
    });
    this.states.set(transfer.mint, { transfer, observation, lane, facts: null, active: true, lastDecision: null, lastEvent: null });
    if (this.bought.has(transfer.mint)) lane.end(now, 'ONE_ROUND_ALREADY_ENTERED');
    else if (!Number.isFinite(transfer.timestamp) || !transfer.timestamp || transfer.timestamp * 1000 > now + 2000) lane.end(now, 'TRANSFER_TIME_MISSING_OR_FUTURE');
    this.persist(now);
  }
  trade(mint: string, trade: TargetTrade) { this.states.get(mint)?.observation.trade(trade); }
  holderFrame(mint: string, body: unknown, at: number) {
    const state = this.states.get(mint), frame = body as { channel?: string; data?: any[] } | null;
    if (!state || !Array.isArray(frame?.data)) return;
    for (const row of frame.data) {
      if ((row.ta ?? row.token_address ?? row.a ?? mint) !== mint) continue;
      if (frame.channel === 'token_general_stat_num' && row.t === 'holder_count' && Number.isFinite(Number(row.v))) {
        state.observation.count({ at, count: Number(row.v) });
      } else if (frame.channel === 'token_holding' || frame.channel === 'token_tag_holding') {
        for (const holder of row.h ?? []) if (holder.wa && Number.isFinite(Number(holder.b))) {
          state.observation.holding(holder.wa, { at, amount: Number(holder.b), sells: Number.isFinite(holder.ts) ? holder.ts : null });
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
      if (state.lane.entryAt === null && facts.firstAt !== null && now - facts.firstAt > PROFIT4_RULES.maxEntryWaitSeconds * 1000)
        state.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
      else state.lane.step(facts);
    }
    this.persist(now);
  }
  end(mint: string, now: number, reason: string) {
    const state = this.states.get(mint);
    if (state) { state.lane.end(now, reason); state.active = false; }
    this.persist(now);
  }
  shutdown(now: number) { for (const mint of this.states.keys()) this.end(mint, now, 'WORKER_STOPPED'); }
  private persist(now: number) {
    atomicProfit4Json(join(this.run, 'profit4-state.json'), { observedAt: now, paperLane: PROFIT4_LANE, rounds: 1,
      execution: 'PAPER_QUOTE', status: 'EXPERIMENTAL', targetPercent: PROFIT4_TARGET_PERCENT, rules: PROFIT4_RULES,
      recentEvents: this.recentEvents,
      positions: [...this.states.values()].map(s => ({ ...s.transfer, captureActive: s.active,
        phase: s.lane.phase, version: s.lane.rules.version, targetPercent: PROFIT4_TARGET_PERCENT,
        entryAt: s.lane.entryAt, entryPrice: s.lane.entryPrice, exitAt: s.lane.exitAt, exitPrice: s.lane.exitPrice,
        netReturnPercent: s.lane.netReturnPercent, pnlUsd: s.lane.netReturnPercent === null ? null : s.lane.netReturnPercent / 100 * PROFIT4_RULES.stakeUsd,
        estimatedOpenNetPercent: s.lane.entryAt !== null && s.lane.exitAt === null && s.active && s.facts?.price !== null && s.facts?.price !== undefined
          ? s.lane.net(s.facts.price) : null, lastDecision: s.lastDecision,
        lastEvent: s.lastEvent ? { type: s.lastEvent.type, observedAt: s.lastEvent.observedAt, reason: s.lastEvent.reason, reasons: s.lastEvent.reasons } : null,
        facts: s.facts })) });
  }
}
