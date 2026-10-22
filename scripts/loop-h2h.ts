import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Runtime, Transfer } from '../src/distribution-profit4-runtime.js';
import { DistributionTargetLane, DEFAULT_TARGET_RULES, validateTargetRules, TargetEvent, TargetFacts, TargetRules, TargetTrade } from '../src/distribution-target-lane.js';

interface StrategyCandidate {
  label: string;
  desc: string;
  minMeaningfulBuyers?: number;
  minBuySharePercent?: number;
  stopLossPercent?: number;
  trailingStartPercent?: number;
  trailingDrawdownPercent?: number;
  nominalTargetPercent?: number;
  maxLargestSellUsd?: number;
}

const CANDIDATES: StrategyCandidate[] = [
  {
    label: 'T-Phoenix-V1',
    desc: 'Phoenix V1 Live (SL 15%, Trail 25/6, TP 60%, Buyers 6, Share 40%)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 25.0,
    trailingDrawdownPercent: 6.0,
    nominalTargetPercent: 60.0,
  },
  {
    label: 'T-Phoenix-V2',
    desc: 'Phoenix V2 (Anti-Dump Sell < $100 + SL 15% + Trail 22/5 + TP 60%)',
    minMeaningfulBuyers: 6,
    minBuySharePercent: 40.0,
    stopLossPercent: 15.0,
    trailingStartPercent: 22.0,
    trailingDrawdownPercent: 5.0,
    nominalTargetPercent: 60.0,
    maxLargestSellUsd: 100,
  },
  {
    label: 'T-Sniper-V1',
    desc: 'Sniper V1 Live (SL 12%, Trail 20/4, TP 40%, Buyers 7, Share 50%)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 12.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 40.0,
  },
  {
    label: 'T-Sniper-V2',
    desc: 'Sniper V2 (SL 14% + Trail 20/4 + TP 40% + Buyers 7, Share 50%)',
    minMeaningfulBuyers: 7,
    minBuySharePercent: 50.0,
    stopLossPercent: 14.0,
    trailingStartPercent: 20.0,
    trailingDrawdownPercent: 4.0,
    nominalTargetPercent: 40.0,
  },
];

const PROJECT_DIR = '/home/bbliong/project/crypto-bot';
const LIVE_RUN_DIRS = [
  join(PROJECT_DIR, 'data/trend20m-watch/2026-10-20T22-06-10-886Z'),
  join(PROJECT_DIR, 'data/trend20m-watch/2026-10-21T11-42-54-227Z'),
  join(PROJECT_DIR, 'data/trend20m-watch/2026-10-21T20-30-33-166Z'),
];
const FEED_DIRS = [
  join(PROJECT_DIR, 'data/feed-hub/2026-10-20T22-06-07-165Z/chunks'),
  join(PROJECT_DIR, 'data/feed-hub/2026-10-21T03-57-38-424Z/chunks'),
  join(PROJECT_DIR, 'data/feed-hub/2026-10-21T11-42-44-751Z/chunks'),
];
const SANDBOX_DIR = join(PROJECT_DIR, 'data/verify-replay-head-to-head');

class CustomLane extends DistributionTargetLane {
  protected peakGrossSeen = -Infinity;
  constructor(mint: string, readonly cand: StrategyCandidate, rules: TargetRules, emit: (event: TargetEvent) => void = () => {}) {
    super(mint, rules, (e) => emit({ ...e, targetPercent: cand.nominalTargetPercent || 40.0, version: rules.version, laneLabel: cand.label as any }), {
      name: `h2h-${cand.label.toLowerCase()}`,
      paperLane: 'distribution-trend-20m',
      prioritizeCustomExit: true,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f: TargetFacts, r: TargetRules) => {
        const reasons: string[] = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 5000 || f.price <= 0.000004 || f.price > 10.0 || !Number.isFinite(f.price)) {
          reasons.push('PRICE_MISSING_OR_STALE');
        }
        const transferAgeSec = f.transferAt > 0 ? (f.now - f.transferAt) / 1000 : 0;
        if (transferAgeSec < 1200) reasons.push('TOKEN_AGE_LESS_THAN_20M');
        if (f.price !== null && f.price * 1_000_000_000 < 30000) reasons.push('ENTRY_MCAP_TOO_LOW');
        if (f.price !== null && f.price * 1_000_000_000 > 600000) reasons.push('ENTRY_MCAP_TOO_HIGH');
        if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');
        if (f.buyShareUsdPercent !== null && f.buyShareUsdPercent < (cand.minBuySharePercent ?? 40.0)) reasons.push('BUY_SHARE_TOO_LOW');
        if (f.meaningfulBuyers < (cand.minMeaningfulBuyers ?? 6)) reasons.push('NOT_ENOUGH_BUYERS');
        if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 80.0) reasons.push('SINGLE_BUYER_DOMINATES');
        if (cand.maxLargestSellUsd !== undefined && f.largestSellUsd >= cand.maxLargestSellUsd) {
          reasons.push('LARGEST_SELL_TOO_HIGH_WHALE_DUMP');
        }
        if (f.now - (f.firstAt ?? f.now) > 7200 * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        return reasons;
      },
      exitReason: (f: TargetFacts, net: number) => {
        if (this.entryPrice === null || this.entryPrice <= 0 || f.price === null) return null;
        const grossRet = ((f.price - this.entryPrice) / this.entryPrice) * 100;
        if (grossRet > this.peakGrossSeen) this.peakGrossSeen = grossRet;
        const sl = cand.stopLossPercent ?? 15.0;
        if (grossRet <= -sl) return `STOP_LOSS_${Math.round(sl)}PCT`;
        const holdSeconds = this.entryAt !== null ? (f.now - this.entryAt) / 1000 : 0;
        if (holdSeconds >= 3600) return 'MAX_HOLD_TIMEOUT_60M';
        const trailStart = cand.trailingStartPercent ?? 25.0;
        const trailDrop = cand.trailingDrawdownPercent ?? 6.0;
        if (this.peakGrossSeen >= trailStart) {
          if (this.peakGrossSeen - grossRet >= trailDrop) {
            if (this.peakGrossSeen >= 60.0) return 'TRAILING_PROFIT_ABOVE_60';
            if (this.peakGrossSeen >= 35.0) return 'TRAILING_PROFIT_ABOVE_35';
            if (this.peakGrossSeen >= 20.0) return 'TRAILING_PROFIT_ABOVE_20';
            return `TRAILING_PROFIT_ABOVE_${Math.round(trailStart)}`;
          }
        }
        if (grossRet >= (cand.nominalTargetPercent ?? 60.0)) return `TAKE_PROFIT_CEILING_${Math.round(cand.nominalTargetPercent ?? 60.0)}`;
        return null;
      },
    });
  }
}

class ExtendedRuntimeH2H extends DistributionProfit4Runtime {
  override evaluate(now: number) {
    if (now - (this as any).lastEvaluationAt < 1000) return;
    (this as any).lastEvaluationAt = now;
    const factsCache = new Map<string, any>();
    for (const state of (this as any).states.values()) {
      if (!state.active) continue;
      let facts = factsCache.get(state.transfer.mint);
      if (!facts) {
        facts = state.observation.facts(now, [], state.transfer.from);
        factsCache.set(state.transfer.mint, facts);
      }
      state.facts = facts;
      const waitStart = state.registeredAt ?? facts.firstAt;
      if (state.lane.entryAt === null && waitStart !== null && now - waitStart > 7200 * 1000) {
        state.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
        state.active = false;
        (this as any).states.delete(state.key);
      } else {
        state.lane.step(facts);
        if (state.lane.phase === 'CLOSED' || state.lane.phase === 'CENSORED') {
          state.active = false;
          if (state.lane.entryAt !== null) {
            (this as any).closedPositions.set(state.key, (this as any).serializeState(state, now));
          } else {
            (this as any).states.delete(state.key);
          }
        }
      }
    }
  }

  saveAll(now: number) { (this as any).persist(now); }

  override register(transfer: Transfer, now: number) {
    let observation = (this as any).observations.get(transfer.mint);
    if (!observation) {
      super.register(transfer, now);
      observation = (this as any).observations.get(transfer.mint);
    }
    if (!observation) return;

    for (const cand of CANDIDATES) {
      const key = `${transfer.mint}:${cand.label.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
      if (this.states.has(key)) continue;
      const makeOnEvent = (laneKey: string) => (event: TargetEvent) => {
        const state = this.states.get(laneKey);
        if (state) {
          state.lastEvent = event;
          if (event.type === 'PAPER_ENTRY_DECISION') state.lastDecision = { allowed: event.allowed, reasons: event.reasons, observedAt: event.observedAt };
        }
      };
      const rules = validateTargetRules({ ...DEFAULT_TARGET_RULES, version: `h2h-${cand.label.toLowerCase()}`, paperOnly: true, enabled: true });
      const lane = new CustomLane(transfer.mint, cand, rules, makeOnEvent(key));
      this.states.set(key, { key, transfer, observation, lane, facts: null, active: true, registeredAt: now, laneLabel: cand.label as any, version: rules.version, lastDecision: null, lastEvent: null });
    }
  }
}

function runH2H() {
  if (existsSync(SANDBOX_DIR)) rmSync(SANDBOX_DIR, { recursive: true, force: true });
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(join(SANDBOX_DIR, 'bought-mints.json'), JSON.stringify({ updatedAt: Date.now(), mints: [] }));

  const transfers = new Map<string, { registeredAt: number; transfer: Transfer }>();
  for (const ld of LIVE_RUN_DIRS) {
    const chunksDir = join(ld, 'chunks');
    if (!existsSync(chunksDir)) continue;
    for (const cf of readdirSync(chunksDir).sort()) {
      const ef = join(chunksDir, cf, 'profit4-events.jsonl');
      if (!existsSync(ef)) continue;
      for (const line of readFileSync(ef, 'utf8').trim().split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          const t: Transfer = e.transfer;
          const at = Number(e.observedAt || e.at);
          if (t && t.mint && at > 0) {
            const ex = transfers.get(t.mint);
            if (!ex || at < ex.registeredAt) transfers.set(t.mint, { registeredAt: at, transfer: t });
          }
        } catch {}
      }
    }
  }
  const mints = new Set(transfers.keys());

  const tradeEvents: any[] = [];
  for (const fd of FEED_DIRS) {
    if (!existsSync(fd)) continue;
    for (const cn of readdirSync(fd).sort()) {
      const tf = join(fd, cn, 'token-trades.jsonl');
      if (!existsSync(tf)) continue;
      for (const line of readFileSync(tf, 'utf8').trim().split('\n')) {
        if (!line.trim()) continue;
        let match = false;
        for (const m of mints) { if (line.includes(m)) { match = true; break; } }
        if (!match) continue;
        try {
          const t = JSON.parse(line);
          if (!mints.has(t.mint)) continue;
          const price = Number(t.price);
          const at = Number(t.observedAt || t.at || (t.timestamp ? t.timestamp * 1000 : 0));
          if (price > 0.000004 && at > 0) {
            tradeEvents.push({ time: at, kind: 'TRADE', mint: t.mint, trade: { at, timestamp: Math.floor(at / 1000), price, side: t.side === 'sell' ? 'sell' : 'buy', wallet: t.wallet || 'trader', usd: Number(t.usd || 25), signature: t.signature || `sig_${at}` } });
          }
        } catch {}
      }
    }
  }

  const allEvents = [...tradeEvents];
  for (const [mint, item] of transfers.entries()) {
    allEvents.push({ time: item.registeredAt, kind: 'REGISTER', mint, transfer: item.transfer });
  }
  allEvents.sort((a, b) => a.time - b.time);

  const runtime = new ExtendedRuntimeH2H(SANDBOX_DIR, () => {}, SANDBOX_DIR, 'trend20m');
  let lastEvalAt = allEvents[0].time;

  for (const ev of allEvents) {
    if (ev.time - lastEvalAt >= 1000) {
      if (ev.time - lastEvalAt > 30000) {
        runtime.evaluate(lastEvalAt + 1000);
        lastEvalAt = ev.time;
        runtime.evaluate(lastEvalAt);
      } else {
        while (ev.time - lastEvalAt >= 1000) { lastEvalAt += 1000; runtime.evaluate(lastEvalAt); }
      }
    }
    if (ev.kind === 'REGISTER') runtime.register(ev.transfer, ev.time);
    else if (ev.kind === 'TRADE') runtime.trade(ev.mint, ev.trade);
  }

  runtime.evaluate(allEvents[allEvents.length - 1].time + 5000);
  runtime.saveAll(allEvents[allEvents.length - 1].time + 5000);

  const replayPositions = JSON.parse(readFileSync(join(SANDBOX_DIR, 'profit4-state.json'), 'utf8')).positions || [];
  console.log('='.repeat(95));
  console.log('HEAD-TO-HEAD: V1 LIVE vs V2 UPGRADED (36 JAM BENCHMARK / 2.28 JUTA TICKS)');
  console.log('='.repeat(95));
  for (const cand of CANDIDATES) {
    const pos = replayPositions.filter((p: any) => p.laneLabel === cand.label && p.phase === 'CLOSED');
    const wins = pos.filter((p: any) => (p.pnlUsd || 0) > 0);
    const losses = pos.filter((p: any) => (p.pnlUsd || 0) <= 0);
    const wr = pos.length > 0 ? (wins.length / pos.length) * 100 : 0;
    const pnl = pos.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);
    const grossWins = wins.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0));
    const pf = grossLoss > 0 ? grossWins / grossLoss : 0;
    console.log(`${cand.label.padEnd(16)} | Trades: ${pos.length} (${wins.length}W/${losses.length}L) | WR: ${wr.toFixed(1)}% | Net PnL: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} | PF: ${pf.toFixed(2)}x`);
  }
  console.log('='.repeat(95));
}
runH2H();
