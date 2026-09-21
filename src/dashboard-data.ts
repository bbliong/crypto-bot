import { mkdirSync, writeFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

type Field = { value: number | boolean; observedAt: number; source: string };
type Candidate = { mint: string; firstSeenAt: number; updatedAt: number; fields: Record<string, Field>; metadata?: { name?: string; symbol?: string; imageUrl?: string } };
type Check = { name: string; status: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'; detail: string };
type Report = { mint: string; signalAt: number; status: string; checks: Check[] };
type Activity = { mint: string; side: 'buy' | 'sell'; occurred_at: number; price_usd: number | null; amount: number | null; actor_address: string | null };
const number = (fields: Record<string, Field>, key: string) => typeof fields[key]?.value === 'number' ? fields[key].value as number : null;
function delta(previous: Candidate | undefined, current: Candidate, key: string) {
  const a = previous && number(previous.fields, key), b = number(current.fields, key);
  return a === null || b === null || a === undefined || b === undefined ? null : b - a;
}
export function writeDashboardData(db: DatabaseSync, output = 'dist/dashboard-data.json') {
  const candidateRows = db.prepare('SELECT body FROM candidates ORDER BY updated_at DESC LIMIT 200').all() as Array<{ body: string }>;
  const reportRows = db.prepare(`SELECT r.body FROM reports r JOIN (SELECT mint, MAX(signal_at) signal_at FROM reports GROUP BY mint) l ON r.mint=l.mint AND r.signal_at=l.signal_at`).all() as Array<{ body: string }>;
  const observationRows = db.prepare('SELECT mint, body FROM observations ORDER BY id DESC LIMIT 1000').all() as Array<{ mint: string; body: string }>;
  const activityRows = db.prepare('SELECT mint,side,occurred_at,price_usd,amount,actor_address FROM token_activity ORDER BY id DESC LIMIT 5000').all() as Activity[];
  const activeEvents = db.prepare("SELECT kind,body FROM events WHERE kind IN ('ACTIVE_MONITOR','DETAIL_INSPECT') ORDER BY id DESC LIMIT 50").all() as Array<{ kind: string; body: string }>;
  let active: { mint: string; until: number; stage: 'ACTIVE_MONITOR' | 'DETAIL_INSPECT' } | null = null;
  for (const row of activeEvents) {
    try {
      const event = JSON.parse(row.body) as { mint?: unknown; until?: unknown };
      if (typeof event.mint === 'string' && typeof event.until === 'number' && event.until > Date.now()) {
        active = { mint: event.mint, until: event.until, stage: row.kind === 'ACTIVE_MONITOR' ? 'ACTIVE_MONITOR' : 'DETAIL_INSPECT' }; break;
      }
    } catch { /* ignore malformed historical event */ }
  }
  const reports = new Map(reportRows.map(row => { const report = JSON.parse(row.body) as Report; return [report.mint, report]; }));
  const previous = new Map<string, Candidate>();
  const activities = new Map<string, Activity[]>();
  for (const item of activityRows) {
    const list = activities.get(item.mint) ?? [];
    list.push(item); activities.set(item.mint, list);
  }
  for (const row of observationRows.reverse()) {
    const sample = JSON.parse(row.body) as Candidate;
    if (!previous.has(sample.mint)) previous.set(sample.mint, sample);
  }
  const tokens = candidateRows.map(row => {
    const candidate = JSON.parse(row.body) as Candidate;
    const report = reports.get(candidate.mint);
    const checks = report?.checks ?? [];
    const counts = {
      pass: checks.filter(check => check.status === 'PASS').length,
      warn: checks.filter(check => check.status === 'WARN').length,
      fail: checks.filter(check => check.status === 'FAIL').length,
      unknown: checks.filter(check => check.status === 'UNKNOWN').length,
    };
    const totalRules = checks.length;
    const pass = counts.pass;
    const trades = activities.get(candidate.mint) ?? [];
    const latestTrade = trades[0];
    const buyObserved = trades.filter(item => item.side === 'buy').length;
    const sellObserved = trades.filter(item => item.side === 'sell').length;
    const buyAmount = trades.filter(item => item.side === 'buy').reduce((sum, item) => sum + (item.amount ?? 0), 0);
    const sellAmount = trades.filter(item => item.side === 'sell').reduce((sum, item) => sum + (item.amount ?? 0), 0);
    const traders = new Set(trades.map(item => item.actor_address).filter(Boolean));
    return {
      mint: candidate.mint, firstSeenAt: candidate.firstSeenAt, updatedAt: candidate.updatedAt,
      name: candidate.metadata?.name ?? null, symbol: candidate.metadata?.symbol ?? null, imageUrl: candidate.metadata?.imageUrl ?? null,
      status: report?.status ?? 'INSUFFICIENT_EVIDENCE', validPercent: totalRules ? Math.round(pass / totalRules * 100) : 0,
      totalRules, ...counts,
      holders: number(candidate.fields, 'holders'), liquidityUsd: number(candidate.fields, 'liquidityUsd'),
      marketCapUsd: number(candidate.fields, 'marketCapUsd'), buys: number(candidate.fields, 'buys'),
      sells: number(candidate.fields, 'sells'), top10Percent: number(candidate.fields, 'top10Percent'),
      buyObserved, sellObserved,
      buyAmount, sellAmount, traderCount: traders.size,
      holderDistribution: {
        top5Percent: number(candidate.fields, 'top5Percent'),
        top10Percent: number(candidate.fields, 'top10Percent'),
        singlePercent: number(candidate.fields, 'singlePercent'),
        bundledPercent: number(candidate.fields, 'bundledPercent'),
      },
      latestTrade: latestTrade ? { side: latestTrade.side, occurredAt: latestTrade.occurred_at, priceUsd: latestTrade.price_usd, amount: latestTrade.amount, actorAddress: latestTrade.actor_address } : null,
      recentTrades: trades.slice(0, 12).map(item => ({ side: item.side, occurredAt: item.occurred_at, priceUsd: item.price_usd, actorAddress: item.actor_address })),
      holderChange: delta(previous.get(candidate.mint), candidate, 'holders'),
      liquidityChange: delta(previous.get(candidate.mint), candidate, 'liquidityUsd'),
      checks,
    };
  });
  const selectedToken = active ? tokens.find(token => token.mint === active!.mint) ?? null : null;
  const visibleTokens = selectedToken ? [selectedToken] : [];
  const summary = {
    total: visibleTokens.length,
    entryReady: visibleTokens.filter(token => token.status === 'ENTRY_READY').length,
    reject: visibleTokens.filter(token => token.status === 'REJECT').length,
    watch: visibleTokens.filter(token => token.status === 'WATCH').length,
    averageValid: visibleTokens.length ? Math.round(visibleTokens.reduce((sum, token) => sum + token.validPercent, 0) / visibleTokens.length) : 0,
    matchedRules: visibleTokens.reduce((sum, token) => sum + token.pass, 0),
    totalRules: visibleTokens.reduce((sum, token) => sum + token.totalRules, 0),
  };
  mkdirSync('dist', { recursive: true });
  writeFileSync(output, JSON.stringify({ generatedAt: new Date().toISOString(), summary,
    selection: active ? { mint: active.mint, until: active.until, stage: active.stage } : null,
    selectedToken, tokens: visibleTokens }, null, 2));
}
