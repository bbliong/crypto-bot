import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TARGET_RULES, DISTRIBUTION_TARGET_LANE, DistributionTargetLane, TargetObservation, validateTargetRules,
  type TargetEvent, type TargetFacts, type TargetRules, type RiskSeller, type TargetTrade } from './distribution-target-lane.js';

type Transfer = { mint: string; wallet: string; symbol?: string; timestamp?: number };
export class DistributionTargetRuntime {
  private states = new Map<string, { transfer: Transfer; observation: TargetObservation; lane: DistributionTargetLane; facts: TargetFacts | null; active: boolean }>();
  private risks: RiskSeller[];
  private lastEvaluationAt = -Infinity;
  readonly rules: TargetRules;
  constructor(private readonly run: string, private readonly write: (name: string, value: unknown) => void,
    private readonly configurationDirectory = join('data', 'distribution-target')) {
    const path = join(configurationDirectory, 'active-rule.json');
    this.rules = validateTargetRules(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).rules : DEFAULT_TARGET_RULES);
    const riskPath = join(configurationDirectory, 'risk-sellers.json');
    this.risks = existsSync(riskPath) ? JSON.parse(readFileSync(riskPath, 'utf8')).wallets ?? [] : [];
    this.risks = this.risks.filter(r => typeof r.wallet === 'string' && Number.isFinite(r.knownAt));
    mkdirSync(configurationDirectory, { recursive: true });
    this.write('distribution-target-events.jsonl', { type: 'PAPER_LANE_READY', observedAt: Date.now(), paperLane: DISTRIBUTION_TARGET_LANE,
      rules: this.rules, status: 'EXPERIMENTAL', paperOnly: true });
  }
  register(transfer: Transfer, now: number) {
    if (this.states.has(transfer.mint)) return;
    const observation = new TargetObservation((transfer.timestamp ?? now / 1000) * 1000);
    const lane = new DistributionTargetLane(transfer.mint, this.rules, event => this.write('distribution-target-events.jsonl', { ...event, transfer }));
    this.states.set(transfer.mint, { transfer, observation, lane, facts: null, active: true });
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
        for (const holder of row.h ?? []) state.observation.holding(holder.wa, { at, amount: Number(holder.b), sells: Number.isFinite(holder.ts) ? holder.ts : null });
      }
    }
  }
  evaluate(now: number) {
    if (now - this.lastEvaluationAt < 1000) return;
    this.lastEvaluationAt = now;
    for (const [mint, state] of this.states) {
      if (!state.active) continue;
      const facts = state.observation.facts(now, this.risks); state.facts = facts;
      if ((facts.drawdownPercent ?? 0) >= 70) {
        const largest = state.observation.trades.filter(t => t.at <= now && t.at > now - 5000 && t.side === 'sell' && (t.usd ?? 0) >= 1000).sort((a, b) => b.usd! - a.usd!)[0];
        if (largest?.wallet && !this.risks.some(r => r.wallet === largest.wallet)) {
          this.risks.push({ wallet: largest.wallet, knownAt: now });
          this.write('distribution-target-events.jsonl', { type: 'PAPER_RISK_SELLER_LEARNED', mint, wallet: largest.wallet, observedAt: now, paperLane: DISTRIBUTION_TARGET_LANE });
          writeFileSync(join(this.configurationDirectory, 'risk-sellers.json'), JSON.stringify({ generatedAt: new Date(now).toISOString(), wallets: this.risks }, null, 2));
        }
      }
      state.lane.step(facts);
    }
    this.persist(now);
  }
  end(mint: string, now: number, reason: string) {
    const state = this.states.get(mint);
    if (state) { state.lane.end(now, reason); state.active = false; }
    this.persist(now);
  }
  shutdown(now: number) { for (const [mint] of this.states) this.end(mint, now, 'WORKER_STOPPED'); }
  private persist(now: number) {
    writeFileSync(join(this.run, 'distribution-target-state.json'), JSON.stringify({ observedAt: now, paperLane: DISTRIBUTION_TARGET_LANE,
      paperOnly: true, status: 'EXPERIMENTAL', rules: this.rules,
      positions: [...this.states.values()].map(s => ({ ...s.transfer, phase: s.lane.phase, version: s.lane.rules.version,
        entryAt: s.lane.entryAt, entryPrice: s.lane.entryPrice, exitAt: s.lane.exitAt, exitPrice: s.lane.exitPrice,
        netReturnPercent: s.lane.netReturnPercent, facts: s.facts })) }, null, 2));
  }
}
