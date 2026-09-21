import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { attachCapture } from './capture.js';
import { at, parseCandidates, parseTokenMetadata, validMint } from './parser.js';
import { CandidateQueue } from './queue.js';
import { evaluate } from './risk.js';
import { assessCandleEntryFlow, assessCandleHistory, assessEntryStability, assessSimulation, closeSimulation, openSimulation, type McapCandle, type SimulationPosition, type SimulationExitReason } from './research-simulation.js';
import { DEFAULT_EXECUTION_SETTINGS } from './execution-settings.js';
import { amountInput, applyExecutionSettings, fetchSolUsdSpot, fetchSolUsdSpotInBrowser, selectSellPercent, selectTradeSide, usdcToSol } from './gmgn-trade-ui.js';
import type { Candidate } from './model.js';

const { values } = parseArgs({ options: {
  seconds: { type: 'string', default: '1800' }, detailSeconds: { type: 'string', default: '600' },
  workers: { type: 'string', default: '5' }, stopLossPercent: { type: 'string', default: '20' },
  simulationStakeUsd: { type: 'string', default: '0.25' },
  profileDir: { type: 'string', default: 'profiles/research-aria-tele01' },
  profileName: { type: 'string', default: 'Profile 12' }, output: { type: 'string' },
  prepareTradeUi: { type: 'boolean', default: true }, enableExtensions: { type: 'boolean', default: true },
  exitHoldSeconds: { type: 'string', default: '20' }, maxPaperBuys: { type: 'string' },
  config: { type: 'string', default: 'config/rules.yaml' },
} });
const config = loadConfig(values.config);
const runSeconds = Number(values.seconds), detailSeconds = Number(values.detailSeconds);
const workers = Number(values.workers), stopLossPercent = Number(values.stopLossPercent);
const simulationStakeUsd = Number(values.simulationStakeUsd);
const exitHoldSeconds = Number(values.exitHoldSeconds);
const maxPaperBuys = values.maxPaperBuys === undefined ? null : Number(values.maxPaperBuys);
if (![runSeconds, detailSeconds, workers, stopLossPercent, simulationStakeUsd, exitHoldSeconds].every(Number.isFinite) || runSeconds <= 0 || detailSeconds <= 0 || !Number.isInteger(workers) || workers < 1 || workers > 5 || stopLossPercent <= 0 || stopLossPercent >= 100 || simulationStakeUsd <= 0 || exitHoldSeconds < 0 || exitHoldSeconds > 300 || (maxPaperBuys !== null && (!Number.isInteger(maxPaperBuys) || maxPaperBuys < 1))) throw new Error('Invalid research options');
if (!existsSync(values.profileDir)) throw new Error('Research profile tidak ditemukan: ' + values.profileDir);

type Primitive = string | number | boolean | null;
type Trade = { mint: string; wallet: string | null; side: 'buy' | 'sell'; occurredAt: number; observedAt: number; priceUsd: number | null; amount: number | null; signature: string | null; raw: Record<string, Primitive> };
type Holder = { mint: string; wallet: string; observedAt: number; raw: Record<string, string | number | boolean | null> };
type DeveloperHolder = { mint: string; wallet: string; observedAt: number; amountPercentage: number | null; amount: number | null; raw: Record<string, Primitive> };
type SimulatedEvent = { type: 'SIMULATED_BUY' | 'SIMULATED_SELL' | 'SIMULATION_HOLD'; pnlUsd?: number; reason?: string };
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = values.output || join('research', runId);
mkdirSync(output, { recursive: true });
let reportRefreshTimer: NodeJS.Timeout | undefined;
let reportRefreshRunning = false;
let reportRefreshQueued = false;
const reportRelevantEventTypes = new Set([
  'DETAIL_STARTED',
  'SIMULATION_BUY_BLOCKED',
  'BUY_PREPARED',
  'BUY_PREPARATION_ERROR',
  'SELL_PREPARED',
  'SELL_PREPARATION_ERROR',
  'DETAIL_SLOT_RELEASED_AFTER_SELL_HOLD',
]);
function refreshLatestReport(): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/generate-simulation-report.mjs', output], {
      cwd: process.cwd(), stdio: 'ignore', windowsHide: true,
    });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
}
function scheduleReportRefresh() {
  if (reportRefreshTimer) clearTimeout(reportRefreshTimer);
  reportRefreshTimer = setTimeout(() => {
    if (reportRefreshRunning) { reportRefreshQueued = true; return; }
    reportRefreshRunning = true;
    void refreshLatestReport().finally(() => {
      reportRefreshRunning = false;
      if (reportRefreshQueued) { reportRefreshQueued = false; scheduleReportRefresh(); }
    });
  }, 250);
}
const write = (file: string, value: unknown) => {
  appendFileSync(join(output, file), JSON.stringify(value) + '\n');
  if (file === 'events.jsonl' && value && typeof value === 'object'
    && reportRelevantEventTypes.has((value as { type?: unknown }).type as string)) scheduleReportRefresh();
};
const simulatedEvents: SimulatedEvent[] = [];
const writeSimulation = (event: SimulatedEvent & Record<string, unknown>) => { simulatedEvents.push(event); write('simulated-trades.jsonl', event); scheduleReportRefresh(); };
const candidates = new Map<string, Candidate>(), trades = new Map<string, Trade[]>(), holders = new Map<string, Map<string, Holder>>();
const developerHolders = new Map<string, Map<string, DeveloperHolder>>();
const holderHistory = new Map<string, Map<string, Holder[]>>();
const queue = new CandidateQueue(500, 10 * 60_000), inspected = new Set<string>(), lastHolderWrite = new Map<string, number>(), lastComparisonWrite = new Map<string, number>();
const rejected = new Set<string>(), youngRejected = new Set<string>(), rejectionCounts = new Map<string, number>(), youngRejectionCounts = new Map<string, number>();
const stopping = new AbortController();
let context: BrowserContext | undefined, received = 0, sockets = 0;
let solSpotCache: { usd: number; observedAt: number } | undefined;
let paperBuyCount = 0;
// DEV-tag data is supplementary. Reserve one request globally so five detail
// workers never burst the endpoint and trigger a session-wide 429.
let nextDeveloperApiRequestAt = 0;

function merge(update: Candidate) {
  const candidate = candidates.get(update.mint) ?? { mint: update.mint, firstSeenAt: update.firstSeenAt, updatedAt: update.updatedAt, fields: {} };
  candidate.updatedAt = Math.max(candidate.updatedAt, update.updatedAt);
  if (update.metadata) candidate.metadata = { ...candidate.metadata, ...update.metadata };
  for (const [key, field] of Object.entries(update.fields)) {
    const old = candidate.fields[key as keyof Candidate['fields']];
    if (!old || field.observedAt >= old.observedAt) candidate.fields[key as keyof Candidate['fields']] = field;
  }
  candidates.set(candidate.mint, candidate); return candidate;
}
function num(candidate: Candidate | undefined, key: keyof Candidate['fields']) {
  const value = candidate?.fields[key]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function balance(holder: Holder | undefined) {
  const value = Number(holder?.raw.b);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function comparison(mint: string, now: number) {
  const history = holderHistory.get(mint);
  const rows = history ? [...history.entries()].map(([wallet, snapshots]) => {
    const first = snapshots[0]!, latest = snapshots[snapshots.length - 1]!, initialBalance = balance(first), currentBalance = balance(latest);
    const observedReduction = initialBalance !== null && currentBalance !== null ? Math.max(0, initialBalance - currentBalance) : null;
    return { wallet, firstObservedAt: first.observedAt, latestObservedAt: latest.observedAt, initialBalance, currentBalance, observedReduction,
      observedSoldOfInitialPercent: observedReduction !== null && initialBalance && initialBalance > 0 ? observedReduction / initialBalance * 100 : null,
      snapshotCount: snapshots.length };
  }) : [];
  const current = rows.filter(row => row.currentBalance !== null).sort((a, b) => (b.currentBalance ?? 0) - (a.currentBalance ?? 0));
  const recent = (trades.get(mint) ?? []).filter(trade => trade.occurredAt >= now - 60_000);
  const withWallet = recent.filter(trade => trade.wallet);
  const knownWallets = new Set(withWallet.map(trade => trade.wallet!));
  const recentSells = recent.filter(trade => trade.side === 'sell' && trade.wallet);
  const sellerUsd = new Map<string, number>();
  for (const trade of recentSells) sellerUsd.set(trade.wallet!, (sellerUsd.get(trade.wallet!) ?? 0) + (trade.amount ?? 0));
  const estimatedSupply = (() => { const candidate = candidates.get(mint), marketCap = num(candidate, 'marketCapUsd'), price = num(candidate, 'priceUsd'); return marketCap && price && price > 0 ? marketCap / price : null; })();
  const matchedSellers = [...sellerUsd.entries()].flatMap(([wallet, soldUsd]) => {
    const currentBalance = balance(holders.get(mint)?.get(wallet));
    if (currentBalance === null || !estimatedSupply) return [];
    return [{ wallet, soldUsd, estimatedOwnershipPercent: currentBalance / estimatedSupply * 100 }];
  }).sort((a, b) => b.estimatedOwnershipPercent - a.estimatedOwnershipPercent);
  return { mint, observedAt: now, observationScope: 'Only holder rows delivered by GMGN detail WebSocket. This is not an assertion that the full holder list was received.',
    observedHolderWallets: rows.length, observedCurrentBalance: current.reduce((sum, row) => sum + (row.currentBalance ?? 0), 0),
    topObservedHolders: current.slice(0, 10),
    recent60Seconds: { buys: recent.filter(trade => trade.side === 'buy').length, sells: recent.filter(trade => trade.side === 'sell').length,
      tradesWithKnownWallet: withWallet.length, activeKnownWallets: knownWallets.size,
      sellsPerActiveKnownWallet: knownWallets.size ? recent.filter(trade => trade.side === 'sell').length / knownWallets.size : null },
    sellerOwnership60Seconds: { uniqueSellers: sellerUsd.size, matchedHolderSellers: matchedSellers.length, ownershipCoveragePercent: sellerUsd.size ? matchedSellers.length / sellerUsd.size * 100 : null,
      topMatchedSellers: matchedSellers.slice(0, 5), note: 'Ownership is estimated only when the trade wallet also appears in a captured holder row.' } };
}
function writeComparison(mint: string, now: number) {
  if ((lastComparisonWrite.get(mint) ?? 0) + 5_000 > now) return;
  lastComparisonWrite.set(mint, now); write('monitor-comparison.jsonl', comparison(mint, now));
}
function recentTradeWindow(mint: string, now: number) {
  // Use the last *completed* socket window. The worker polls every 500 ms,
  // therefore an in-progress rolling window would otherwise be counted many times.
  const end = Math.floor(now / 5_000) * 5_000, start = end - 5_000;
  const rows = (trades.get(mint) ?? []).filter(trade => trade.occurredAt >= start && trade.occurredAt < end);
  const sells = rows.filter(row => row.side === 'sell');
  const value = (list: Trade[]) => list.reduce((sum, row) => sum + (row.amount ?? 0), 0);
  return { buys: rows.filter(row => row.side === 'buy').length, sells: sells.length, buyUsd: value(rows.filter(row => row.side === 'buy')),
    sellUsd: value(sells), uniqueSellers: new Set(sells.map(row => typeof row.raw.m === 'string' ? row.raw.m : row.wallet).filter(Boolean)).size, windowStart: start };
}
function entryTradeFlow(mint: string, now: number) {
  const rows = (trades.get(mint) ?? []).filter(trade => trade.occurredAt >= now - 20_000 && trade.occurredAt <= now);
  const value = (side: 'buy' | 'sell') => rows.filter(row => row.side === side).reduce((sum, row) => sum + (row.amount ?? 0), 0);
  const buyUsd = value('buy'), sellUsd = value('sell');
  return { windowSeconds: 20, trades: rows.length, buys: rows.filter(row => row.side === 'buy').length, sells: rows.filter(row => row.side === 'sell').length, buyUsd, sellUsd, buySharePercent: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) * 100 : null };
}
async function fetchMcapCandles(page: Page, mint: string) {
  const response = await page.evaluate(async ({ mint: tokenMint }) => {
    const url = '/api/v1/token_mcap_candles/sol/' + encodeURIComponent(tokenMint) + '?pool_type=tpool&resolution=1m&limit=501';
    const result = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
    const body: unknown = await result.json().catch(() => null);
    return { status: result.status, body };
  }, { mint }).catch(error => ({ status: 0, body: { error: error instanceof Error ? error.message : 'request failed' } }));
  const list = response.body && typeof response.body === 'object' ? (response.body as { data?: { list?: unknown } }).data?.list : null;
  const candles: McapCandle[] = Array.isArray(list) ? list.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const item = row as Record<string, unknown>, candle = { time: Number(item.time), open: Number(item.open), close: Number(item.close), high: Number(item.high), low: Number(item.low), volume: Number(item.volume) };
    return [candle.time, candle.open, candle.close, candle.high, candle.low, candle.volume].every(value => Number.isFinite(value) && value >= 0) ? [candle] : [];
  }) : [];
  return { status: response.status, candles };
}
async function refreshTokenStat(page: Page, mint: string, observedAt: number) {
  const response = await page.evaluate(async ({ mint: tokenMint }) => {
    const result = await fetch('/api/v1/token_stat/sol/' + encodeURIComponent(tokenMint), { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
    const body: unknown = await result.json().catch(() => null);
    return { status: result.status, body };
  }, { mint }).catch(error => ({ status: 0, body: { error: error instanceof Error ? error.message : 'request failed' } }));
  const data = response.body && typeof response.body === 'object' ? (response.body as { data?: unknown }).data : null;
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const holderCount = ['holder_count', 'holders', 'holder_num', 'holderCount'].map(key => Number(record[key])).find(value => Number.isFinite(value) && value >= 0) ?? null;
  write('token-stat.jsonl', { mint, observedAt, source: 'GMGN same-session /api/v1/token_stat', status: response.status, holderCount, availableFields: Object.keys(record).slice(0, 100) });
  if (holderCount !== null) {
    const existing = candidates.get(mint);
    merge({ mint, firstSeenAt: existing?.firstSeenAt ?? observedAt, updatedAt: observedAt, fields: { holders: { value: holderCount, observedAt, source: 'GMGN token_stat API' } } });
  }
  return { status: response.status, holderCount };
}
function numberFrom(record: Record<string, unknown>, keys: string[]) {
  return keys.map(key => Number(record[key])).find(value => Number.isFinite(value)) ?? null;
}
async function refreshDeveloperHolders(page: Page, mint: string, observedAt: number) {
  // This is the same endpoint GMGN calls after its DEV quick-tag is selected.
  // It is fetched inside the visible Chrome session, so no copied cookie is used.
  const response = await page.evaluate(async ({ mint: tokenMint }) => {
    const url = '/vas/api/v1/token_holders/sol/' + encodeURIComponent(tokenMint) + '?limit=100&cost=20&tag=dev&orderby=amount_percentage&direction=desc';
    const result = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
    const body: unknown = await result.json().catch(() => null);
    return { status: result.status, body };
  }, { mint }).catch(error => ({ status: 0, body: { error: error instanceof Error ? error.message : 'request failed' } }));
  const root = response.body && typeof response.body === 'object' ? response.body as { data?: unknown } : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  const values = [data.list, data.holders, data.data].find(Array.isArray) as unknown[] | undefined;
  const found: DeveloperHolder[] = [];
  for (const value of values ?? []) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const wallet = ['wallet_address', 'wallet', 'address', 'wa', 'owner_address'].map(key => item[key]).find(validMint);
    if (typeof wallet !== 'string') continue;
    const raw: Record<string, Primitive> = {};
    for (const [key, value] of Object.entries(item)) if (value === null || typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 500)) raw[key] = value;
    found.push({ mint, wallet, observedAt, amountPercentage: numberFrom(item, ['amount_percentage', 'percentage', 'percent', 'ownership_percentage']), amount: numberFrom(item, ['amount', 'balance', 'token_amount']), raw });
  }
  const previous = developerHolders.get(mint) ?? new Map<string, DeveloperHolder>();
  const map = new Map<string, DeveloperHolder>();
  for (const holder of found) {
    const before = previous.get(holder.wallet);
    if (before && before.amount !== null && holder.amount !== null && holder.amount < before.amount) {
      write('developer-balance-changes.jsonl', { mint, observedAt, event: holder.amount <= 0 ? 'DEVELOPER_FULL_SELL_OBSERVED' : 'DEVELOPER_PARTIAL_SELL_OBSERVED', wallet: holder.wallet, previousAmount: before.amount, currentAmount: holder.amount, amountReduced: before.amount - holder.amount, previousAmountPercentage: before.amountPercentage, currentAmountPercentage: holder.amountPercentage, note: 'This compares successive GMGN DEV-tag holder API snapshots.' });
    }
    map.set(holder.wallet, holder);
  }
  for (const before of previous.values()) if (!map.has(before.wallet)) {
    write('developer-balance-changes.jsonl', { mint, observedAt, event: 'DEVELOPER_HOLDER_NOT_RETURNED', wallet: before.wallet, previousAmount: before.amount, previousAmountPercentage: before.amountPercentage, note: 'The DEV-tag holder endpoint no longer returned this wallet. It can indicate a full exit, but is retained as an observation rather than asserted as a sale until a matching trade is seen.' });
  }
  if (found.length) developerHolders.set(mint, map);
  write('developer-holders.jsonl', { mint, observedAt, source: 'GMGN same-session /vas/api/v1/token_holders tag=dev', status: response.status, holders: found });
  return { status: response.status, holders: found };
}
async function maybeRefreshDeveloperHolders(page: Page, mint: string, observedAt: number) {
  if (Date.now() < nextDeveloperApiRequestAt) return { status: null, deferred: true };
  nextDeveloperApiRequestAt = Date.now() + 30_000;
  const response = await refreshDeveloperHolders(page, mint, observedAt);
  if (response.status === 429) nextDeveloperApiRequestAt = Date.now() + 60_000;
  return { status: response.status, deferred: false };
}
function developerMonitoring(mint: string) {
  const developerWallets = developerHolders.get(mint) ?? new Map<string, DeveloperHolder>();
  const activity = (trades.get(mint) ?? []).filter(trade => trade.wallet && developerWallets.has(trade.wallet));
  const sells = activity.filter(trade => trade.side === 'sell');
  return { taggedDeveloperWallets: [...developerWallets.values()].map(({ wallet, amountPercentage, amount, observedAt }) => ({ wallet, amountPercentage, amount, observedAt })),
    observedDeveloperTrades: activity.length, observedDeveloperSells: sells.length,
    firstDeveloperSellAt: sells.length ? Math.min(...sells.map(trade => trade.occurredAt)) : null,
    note: 'Developer activity is matched only when the GMGN activity wallet equals a wallet returned by the DEV-tag holder endpoint.' };
}
function writeSimulationExit(position: SimulationPosition, mint: string, now: number, exitPriceUsd: number, reason: SimulationExitReason, metadata: unknown, decision: Record<string, unknown> | null) {
  const result = closeSimulation(position, exitPriceUsd);
  writeSimulation({ type: 'SIMULATED_SELL', mint, observedAt: now, reason, entry: { openedAt: position.openedAt, priceUsd: position.entryPriceUsd, stakeUsd: position.stakeUsd, quantity: position.quantity },
    exit: { priceUsd: exitPriceUsd, grossProceedsUsd: result.grossProceedsUsd }, pnlUsd: result.pnlUsd, pnlPercent: result.pnlPercent,
    decision, assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper simulation only. Proceeds equal token quantity × observed GMGN price; no swap was submitted.' }, metadata });
  return result;
}
function captureTrades(payload: unknown, now: number, mint: string | undefined) {
  const channel = at(payload, 'channel'), rows = at(payload, 'data');
  if (!mint || (channel !== 'token_activity' && channel !== 'token_activity_info_all') || !Array.isArray(rows)) return;
  for (const row of rows) {
    const token = at(row, 'a'), side = at(row, 'e');
    if (token !== mint || !validMint(token) || (side !== 'buy' && side !== 'sell')) continue;
    const seconds = Number(at(row, 't')), signature = typeof at(row, 'h') === 'string' ? at(row, 'h') as string : null;
    const list = trades.get(mint) ?? [];
    if (signature && list.some(item => item.signature === signature)) continue;
    const raw: Record<string, Primitive> = {};
    if (row && typeof row === 'object') for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (value === null || typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 500)) raw[key] = value;
    }
    // GMGN's activity payload exposes `m` as the maker/trader candidate. It
    // matches holder rows more reliably than the auxiliary `ad` field.
    const wallet = ['m', 'ad', 'wa', 'w', 'u', 'user', 'trader', 'wallet'].map(key => at(row, key)).find(validMint);
    const trade: Trade = { mint, side, signature, observedAt: now, occurredAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now,
      wallet: typeof wallet === 'string' ? wallet : null,
      priceUsd: Number.isFinite(Number(at(row, 'pu'))) ? Number(at(row, 'pu')) : null,
      amount: Number.isFinite(Number(at(row, 'au'))) ? Number(at(row, 'au')) : null, raw };
    list.push(trade); trades.set(mint, list); write('trades.jsonl', trade);
    const developer = trade.wallet ? developerHolders.get(mint)?.get(trade.wallet) : undefined;
    if (developer) write('developer-activity.jsonl', { mint, observedAt: now, event: trade.side === 'sell' ? 'DEVELOPER_SELL_OBSERVED' : 'DEVELOPER_BUY_OBSERVED', trade, developer: { wallet: developer.wallet, amountPercentage: developer.amountPercentage, amount: developer.amount, observedAt: developer.observedAt } });
  }
  writeComparison(mint, now);
}
function captureHolders(payload: unknown, now: number, mint: string | undefined) {
  const channel = at(payload, 'channel'), rows = at(payload, 'data');
  if (!mint || (channel !== 'token_holding' && channel !== 'token_tag_holding') || !Array.isArray(rows) || (lastHolderWrite.get(mint) ?? 0) + 5_000 > now) return;
  for (const row of rows) {
    const token = at(row, 'ta'), entries = at(row, 'h');
    if (token !== mint || !validMint(token) || !Array.isArray(entries)) continue;
    const map = holders.get(mint) ?? new Map<string, Holder>(), snapshot: Holder[] = [];
    for (const item of entries) {
      const wallet = at(item, 'wa'); if (!validMint(wallet)) continue;
      const raw: Holder['raw'] = {};
      for (const key of ['b', 'aca', 'acc', 'acf', 'boa', 'boc', 'bof', 'soa', 'soi', 'sof', 'tia', 'tic', 'toa', 'toi', 'tof', 'rp', 'tb', 'ts', 'tti', 'tto', 'hba', 'hbc', 'hbf', 'hsa', 'hsf', 'hsi', 'htia', 'htic', 'htoa', 'htoi', 'htof', 'hrp', 'htb', 'hts', 'htti', 'htto', 'sha', 'eha', 'lb', 'lat', 'p', 'nb', 'st']) {
        const value = at(item, key);
        if (value === null || typeof value === 'boolean' || typeof value === 'number' || (typeof value === 'string' && value.length <= 200)) raw[key] = value;
      }
      const holder: Holder = { mint, wallet, observedAt: now, raw }; map.set(wallet, holder); snapshot.push(holder);
      const byWallet = holderHistory.get(mint) ?? new Map<string, Holder[]>(), history = byWallet.get(wallet) ?? [];
      if (!history.length || history.at(-1)!.observedAt !== now) history.push(holder);
      byWallet.set(wallet, history); holderHistory.set(mint, byWallet);
    }
    if (snapshot.length) { holders.set(mint, map); lastHolderWrite.set(mint, now); write('holder-snapshots.jsonl', { mint, observedAt: now, holders: snapshot }); writeComparison(mint, now); }
  }
}
function passesInitialScreen(candidate: Candidate, now: number) {
  const report = evaluate(candidate, config, now, false), keys = new Set(['age', 'holders', 'liquidityUsd', 'top10Percent']);
  return report.checks.filter(check => keys.has(check.name)).every(check => check.status === 'PASS');
}
function initialScreenChecks(candidate: Candidate, now: number) {
  const keys = new Set(['age', 'holders', 'liquidityUsd', 'top10Percent']);
  return evaluate(candidate, config, now, false).checks.filter(check => keys.has(check.name));
}
function recordRejectedScreen(candidate: Candidate, now: number) {
  if (rejected.has(candidate.mint)) return;
  const checks = initialScreenChecks(candidate, now), failures = checks.filter(check => check.status !== 'PASS');
  if (!failures.length) return;
  rejected.add(candidate.mint);
  for (const check of failures) rejectionCounts.set(check.name, (rejectionCounts.get(check.name) ?? 0) + 1);
  write('screening-rejected.jsonl', { observedAt: now, mint: candidate.mint, metadata: candidate.metadata ?? null, checks: failures, fields: candidate.fields });
  writeFileSync(join(output, 'screening-rejection-summary.json'), JSON.stringify({ observedAt: now, rejectedTokens: rejected.size, failedChecks: Object.fromEntries(rejectionCounts) }, null, 2));
  const age = checks.find(check => check.name === 'age');
  if (age?.status === 'PASS') {
    youngRejected.add(candidate.mint);
    for (const check of failures) youngRejectionCounts.set(check.name, (youngRejectionCounts.get(check.name) ?? 0) + 1);
    write('screening-rejected-young.jsonl', { observedAt: now, mint: candidate.mint, metadata: candidate.metadata ?? null, checks: failures, fields: candidate.fields });
    writeFileSync(join(output, 'screening-young-rejection-summary.json'), JSON.stringify({ observedAt: now, ageRangeSeconds: `0-${config.maximumAgeSeconds}`, rejectedYoungTokens: youngRejected.size, failedChecks: Object.fromEntries(youngRejectionCounts) }, null, 2));
  }
  console.log('[screen-rejected]', candidate.metadata?.symbol ?? candidate.mint, failures.map(check => check.name + ':' + check.status).join(','));
}
function walletBehavior(mint: string, candidate: Candidate) {
  const observed = new Map<string, { wallet: string; buys: number[]; sells: number[] }>();
  for (const trade of trades.get(mint) ?? []) {
    if (!trade.wallet) continue;
    const row = observed.get(trade.wallet) ?? { wallet: trade.wallet, buys: [], sells: [] };
    row[trade.side === 'buy' ? 'buys' : 'sells'].push(trade.occurredAt); observed.set(trade.wallet, row);
  }
  const marketCap = num(candidate, 'marketCapUsd'), price = num(candidate, 'priceUsd'), estimatedSupply = marketCap && price && price > 0 ? marketCap / price : null;
  return [...observed.values()].map(row => {
    const snapshot = holders.get(mint)?.get(row.wallet), balance = Number(snapshot?.raw.b);
    return { wallet: row.wallet, buyCount: row.buys.length, sellCount: row.sells.length, firstBuyAt: row.buys.length ? Math.min(...row.buys) : null, lastBuyAt: row.buys.length ? Math.max(...row.buys) : null, firstSellAt: row.sells.length ? Math.min(...row.sells) : null, lastSellAt: row.sells.length ? Math.max(...row.sells) : null, latestHolderSnapshot: snapshot?.raw ?? null, estimatedOwnershipPercent: estimatedSupply && Number.isFinite(balance) ? balance / estimatedSupply * 100 : null, ownershipMethod: estimatedSupply ? 'balance / (marketCapUsd / priceUsd); estimate only' : null };
  });
}
function attach(page: Page, feed: boolean, active: () => string | undefined) {
  page.on('response', response => { if (response.status() >= 400) console.log('[http-error]', response.status(), response.url()); });
  page.on('pageerror', error => console.log('[page-error]', error.message));
  attachCapture(page, event => { if (event.kind === 'open') { sockets++; console.log('[socket-open]', feed ? 'feed' : 'detail'); } if (event.kind === 'frame' && event.direction === 'received') received++; }, (payload, now, source) => {
    const mint = active(); captureTrades(payload, now, mint); captureHolders(payload, now, mint);
    for (const metadata of parseTokenMetadata(payload)) {
      const known = candidates.get(metadata.mint);
      if (known) merge({ mint: metadata.mint, firstSeenAt: known.firstSeenAt, updatedAt: now, fields: {}, metadata: metadata.metadata });
    }
    for (const update of parseCandidates(payload, config.mappings, now, source)) {
      if (!feed && update.mint !== mint) continue;
      const candidate = merge(update);
      if (feed && !inspected.has(candidate.mint)) {
        if (passesInitialScreen(candidate, now)) {
          inspected.add(candidate.mint); queue.push(candidate.mint, now);
          write('screened-tokens.jsonl', { observedAt: now, mint: candidate.mint, metadata: candidate.metadata ?? null, fields: candidate.fields });
          console.log('[screened]', candidate.metadata?.symbol ?? candidate.mint, candidate.mint);
        } else recordRejectedScreen(candidate, now);
      }
    }
  });
}
async function currentSolUsd(page: Page) {
  if (solSpotCache && Date.now() - solSpotCache.observedAt < 30_000) return solSpotCache.usd;
  let usd: number;
  try { usd = await fetchSolUsdSpot(); } catch { usd = await fetchSolUsdSpotInBrowser(page); }
  solSpotCache = { usd, observedAt: Date.now() };
  return usd;
}
async function prepareBuyPanel(page: Page, mint: string, worker: number, observedAt: number) {
  if (!values.prepareTradeUi) return;
  await selectTradeSide(page, 'buy');
  await applyExecutionSettings(page, DEFAULT_EXECUTION_SETTINGS);
  const solUsdSpot = await currentSolUsd(page);
  const solAmount = usdcToSol(String(simulationStakeUsd), solUsdSpot);
  await (await amountInput(page)).fill(solAmount);
  write('trade-preparation.jsonl', { type: 'BUY_PREPARED', mint, worker, observedAt, requestedUsdc: simulationStakeUsd, solAmount, solUsdSpot, executionSettings: DEFAULT_EXECUTION_SETTINGS,
    note: 'The GMGN Buy field was filled only. No Buy button was clicked and no transaction was submitted.' });
}
async function prepareSellPanel(page: Page, mint: string, worker: number, observedAt: number, reason: SimulationExitReason) {
  if (!values.prepareTradeUi) return;
  await selectTradeSide(page, 'sell');
  await applyExecutionSettings(page, DEFAULT_EXECUTION_SETTINGS);
  await selectSellPercent(page, 100);
  const preparedAmount = await (await amountInput(page)).inputValue();
  write('trade-preparation.jsonl', { type: 'SELL_PREPARED', mint, worker, observedAt, reason, sellPercent: 100, preparedAmount, executionSettings: DEFAULT_EXECUTION_SETTINGS,
    note: 'The GMGN Sell 100% preset was selected only. No Sell button was clicked and no transaction was submitted.' });
}
async function worker(index: number, deadline: number) {
  const page = await context!.newPage(); let activeMint: string | undefined;
  attach(page, false, () => activeMint);
  while (!stopping.signal.aborted && Date.now() < deadline) {
    const mint = queue.take();
    if (!mint) { await delay(200); continue; }
    activeMint = mint; const startedAt = Date.now(), stopAt = Math.min(deadline, startedAt + detailSeconds * 1000); let openingPrice: number | null = null, stopLoss = false, simulation: SimulationPosition | null = null, simulationExit: SimulationExitReason | null = null;
    let lastHolderCount: number | null = null, lastHolderObservedAt = 0, holderGrowthStreak = 0, lastSignificantGrowthAt = 0, recoveryHoldUntil = 0, recoveryHoldForGrowthAt = 0, targetHoldForGrowthAt = 0;
    const priceSamples: { observedAt: number; priceUsd: number }[] = []; let lastEntryBlockPriceAt = 0, lastTokenStatAt = 0, lastDeveloperHoldersAt = 0, developerHolderPollMs = 30_000, candleDecision: ReturnType<typeof assessCandleHistory> | null = null, candleEntryFlow: ReturnType<typeof assessCandleEntryFlow> | null = null, candleBlockRecorded = false, trialLimitRecorded = false;
    // A single socket trade can make a thin launch wick below the stop.  Keep
    // the breach pending until independent socket and candle evidence agree.
    let entryCandleClose: number | null = null, hardStopPendingAt = 0, hardStopDistinctTicks = 0, hardStopLastPriceObservedAt = 0;
    write('events.jsonl', { type: 'DETAIL_STARTED', worker: index, mint, startedAt });
    console.log('[detail-start]', 'worker=' + index, mint);
    try {
      await page.goto(config.tokenUrlTemplate.replaceAll('{mint}', mint), { waitUntil: 'commit', timeout: config.workerTimeoutMs });
      await refreshTokenStat(page, mint, Date.now()); lastTokenStatAt = Date.now();
      const candleResult = await fetchMcapCandles(page, mint);
      candleDecision = assessCandleHistory(candleResult.candles);
      candleEntryFlow = assessCandleEntryFlow(candleResult.candles);
      entryCandleClose = candleResult.candles.at(-1)?.close ?? null;
      write('mcap-candles.jsonl', { mint, observedAt: Date.now(), source: 'GMGN same-session /api/v1/token_mcap_candles', resolution: '1m', status: candleResult.status, candles: candleResult.candles, decision: candleDecision, entryFlow: candleEntryFlow });
      if (!candleDecision.allowed || !candleEntryFlow.allowed) console.log('[candle-buy-blocked]', mint, candleDecision.reason, candleEntryFlow.reason);
      while (!stopping.signal.aborted && Date.now() < stopAt) {
        const now = Date.now();
        if (now - lastTokenStatAt >= 5_000) { await refreshTokenStat(page, mint, now); lastTokenStatAt = Date.now(); }
        if (simulation && now - lastDeveloperHoldersAt >= developerHolderPollMs) {
          const developerSnapshot = await maybeRefreshDeveloperHolders(page, mint, now);
          if (!developerSnapshot.deferred) {
            lastDeveloperHoldersAt = Date.now(); developerHolderPollMs = developerSnapshot.status === 429 ? 60_000 : 30_000;
          }
        }
        const candidate = candidates.get(mint), price = num(candidate, 'priceUsd'), priceObservedAt = candidate?.fields.priceUsd?.observedAt ?? 0;
        const holderField = candidate?.fields.holders, holderCount = typeof holderField?.value === 'number' ? holderField.value : null;
        if (holderCount !== null && holderField && holderField.observedAt > lastHolderObservedAt) {
          if (lastHolderCount !== null) {
            const growth = holderCount - lastHolderCount, significant = lastHolderCount > 0 && growth >= 5 && growth / lastHolderCount >= 0.1;
            holderGrowthStreak = significant ? holderGrowthStreak + 1 : 0;
            if (significant) lastSignificantGrowthAt = holderField.observedAt;
          }
          lastHolderCount = holderCount; lastHolderObservedAt = holderField.observedAt;
        }
        if (price && priceObservedAt && priceSamples.at(-1)?.observedAt !== priceObservedAt) {
          priceSamples.push({ observedAt: priceObservedAt, priceUsd: price });
          while (priceSamples.length && priceSamples[0]!.observedAt < priceObservedAt - 10_000) priceSamples.shift();
        }
        if (price && openingPrice === null) openingPrice = price;
        if (price && !simulation && now - priceObservedAt <= 10_000) {
          const entry = assessEntryStability(priceSamples);
          const flow = entryTradeFlow(mint, now);
          const flowAllowed = flow.trades >= 5 && flow.buyUsd >= flow.sellUsd;
          if (entry.stable && candleDecision?.allowed && candleEntryFlow?.allowed && flowAllowed && (maxPaperBuys === null || paperBuyCount < maxPaperBuys)) {
            paperBuyCount++;
            simulation = openSimulation(mint, now, price, simulationStakeUsd);
            const developerSnapshot = await maybeRefreshDeveloperHolders(page, mint, now);
            if (!developerSnapshot.deferred) {
              lastDeveloperHoldersAt = Date.now(); developerHolderPollMs = developerSnapshot.status === 429 ? 60_000 : 30_000;
            }
            // Normalize the market-cap candle to the socket price at entry.
            // This lets the current candle confirm a later socket stop without
            // assuming a fixed token supply.
            if (!entryCandleClose || entryCandleClose <= 0) entryCandleClose = null;
            writeSimulation({ type: 'SIMULATED_BUY', mint, worker: index, observedAt: now, entryPriceUsd: price, stakeUsd: simulation.stakeUsd, quantity: simulation.quantity,
              entryGate: { realtime: entry, candleHistory: candleDecision, candleEntryFlow, tradeFlow20s: flow }, metadata: candidate?.metadata ?? null, assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper simulation only. No GMGN or Fomo buy was submitted.' } });
            await prepareBuyPanel(page, mint, index, now).catch(error => {
              write('events.jsonl', { type: 'BUY_PREPARATION_ERROR', mint, worker: index, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
            });
            console.log('[sim-buy]', candidate?.metadata?.symbol ?? mint, 'stake=$' + simulation.stakeUsd, 'price=' + price);
          } else if (maxPaperBuys !== null && entry.stable && candleDecision?.allowed && candleEntryFlow?.allowed && flowAllowed && !trialLimitRecorded) {
            trialLimitRecorded = true;
            write('events.jsonl', { type: 'SIMULATION_BUY_SKIPPED_TRIAL_LIMIT', mint, worker: index, observedAt: now, maxPaperBuys, paperBuyCount,
              note: 'All entry gates passed, but the non-submitting paper-buy trial has already prepared its maximum number of candidates.' });
            console.log('[sim-buy-skipped]', candidate?.metadata?.symbol ?? mint, 'TRIAL_LIMIT=' + maxPaperBuys);
          } else if ((!candleDecision?.allowed || !candleEntryFlow?.allowed) && !candleBlockRecorded) {
            candleBlockRecorded = true;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, candleDecision, candleEntryFlow, note: 'No paper buy: closed-candle count or current 1-minute candle is unsafe.' });
          } else if ((entry.reason === 'CONTINUING_PRICE_DROP' || entry.reason === 'INSUFFICIENT_PRICE_CONFIRMATION') && lastEntryBlockPriceAt !== priceObservedAt) {
            lastEntryBlockPriceAt = priceObservedAt;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, entryGate: entry, tradeFlow20s: flow, note: entry.reason === 'INSUFFICIENT_PRICE_CONFIRMATION' ? 'No paper buy: price ticks did not show a real recovery.' : 'No paper buy: detail price is still falling.' });
            console.log('[sim-buy-blocked]', candidate?.metadata?.symbol ?? mint, entry.reason, entry.momentum5sPercent);
          } else if (!flowAllowed && lastEntryBlockPriceAt !== priceObservedAt) {
            lastEntryBlockPriceAt = priceObservedAt;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, tradeFlow20s: flow, note: 'No paper buy: the last 20 seconds lack at least 5 trades with buy USD at least sell USD.' });
          }
        }
        if (price && simulation && now - priceObservedAt <= 10_000) {
          const trades5s = recentTradeWindow(mint, now), returnPercent = (price / simulation.entryPriceUsd - 1) * 100;
          const freshSignificantGrowth = lastSignificantGrowthAt > 0 && now - lastSignificantGrowthAt <= 5_000;
          const recoveryEligible = returnPercent <= -10 && returnPercent > -20 && freshSignificantGrowth && trades5s.buyUsd >= trades5s.sellUsd;
          if (recoveryEligible && recoveryHoldForGrowthAt !== lastSignificantGrowthAt) {
            recoveryHoldUntil = now + 10_000; recoveryHoldForGrowthAt = lastSignificantGrowthAt;
            writeSimulation({ type: 'SIMULATION_HOLD', mint, worker: index, observedAt: now, reason: 'HOLDER_GROWTH_RECOVERY', holderCount, holderGrowthStreak, returnPercent, holdUntil: recoveryHoldUntil, trades5s,
              note: 'Paper hold: price is between -10% and -20%, total-holder update grew by at least 10% and 5, and 5-second buy USD is at least sell USD.' });
            console.log('[sim-hold]', candidate?.metadata?.symbol ?? mint, 'HOLDER_GROWTH_RECOVERY');
          }
          const momentumBase = priceSamples.find(sample => sample.observedAt >= priceObservedAt - 5_000);
          const priceMomentum5s = momentumBase ? (price / momentumBase.priceUsd - 1) * 100 : null;
          const sustainedHolderGrowth = holderGrowthStreak >= 2 && freshSignificantGrowth;
          const targetMomentumHold = returnPercent >= 40 && sustainedHolderGrowth && (priceMomentum5s ?? 0) >= 2;
          if (targetMomentumHold && targetHoldForGrowthAt !== lastSignificantGrowthAt) {
            targetHoldForGrowthAt = lastSignificantGrowthAt;
            writeSimulation({ type: 'SIMULATION_HOLD', mint, worker: index, observedAt: now, reason: 'HOLDER_GROWTH_MOMENTUM', holderCount, holderGrowthStreak, returnPercent, priceMomentum5s, trades5s,
              note: 'Paper hold: profit is at least +40%, holder growth is significant for two updates, and price rose at least 2% in 5 seconds.' });
            console.log('[sim-hold]', candidate?.metadata?.symbol ?? mint, 'HOLDER_GROWTH_MOMENTUM');
          }
          const decision = assessSimulation(simulation, price, trades5s, { suppressSellPressure: now < recoveryHoldUntil, deferTargetForHolderMomentum: targetMomentumHold, suppressHardStop: true });
          let exitReason = decision.exitReason;
          let hardStopValidation: Record<string, unknown> | null = null;
          const hardStopThreshold = simulation.entryPriceUsd * 0.8;
          if (price <= hardStopThreshold + 1e-12) {
            if (!hardStopPendingAt) {
              hardStopPendingAt = now; hardStopDistinctTicks = 1; hardStopLastPriceObservedAt = priceObservedAt;
              write('events.jsonl', { type: 'STOP_LOSS_PENDING', mint, worker: index, observedAt: now, entryPriceUsd: simulation.entryPriceUsd, socketPriceUsd: price, returnPercent, thresholdPriceUsd: hardStopThreshold, confirmation: 'Waiting 5 seconds, at least 3 distinct socket ticks below threshold, then live candle API confirmation.' });
            } else if (priceObservedAt > hardStopLastPriceObservedAt) {
              hardStopDistinctTicks++; hardStopLastPriceObservedAt = priceObservedAt;
            }
            if (!exitReason && now - hardStopPendingAt >= 5_000 && hardStopDistinctTicks >= 3) {
              const confirmation = await fetchMcapCandles(page, mint);
              const currentCandleClose = confirmation.candles.at(-1)?.close ?? null;
              const candleReturnPercent = entryCandleClose && currentCandleClose ? (currentCandleClose / entryCandleClose - 1) * 100 : null;
              const apiConfirms = candleReturnPercent !== null && candleReturnPercent <= -20;
              write('mcap-candles.jsonl', { mint, observedAt: now, source: 'GMGN same-session /api/v1/token_mcap_candles hard-stop confirmation', resolution: '1m', status: confirmation.status, candles: confirmation.candles, hardStopConfirmation: { entryCandleClose, currentCandleClose, candleReturnPercent, socketReturnPercent: returnPercent, socketTicksBelowThreshold: hardStopDistinctTicks, apiConfirms } });
              if (apiConfirms) {
                exitReason = 'STOP_LOSS_20';
                hardStopValidation = { status: 'CONFIRMED', pendingSeconds: (now - hardStopPendingAt) / 1000, socketTicksBelowThreshold: hardStopDistinctTicks, candleReturnPercent };
              } else {
                write('events.jsonl', { type: 'STOP_LOSS_CANCELLED', mint, worker: index, observedAt: now, socketPriceUsd: price, socketReturnPercent: returnPercent, candleReturnPercent, note: 'Socket breach was not confirmed by the live GMGN candle API.' });
                hardStopPendingAt = 0; hardStopDistinctTicks = 0; hardStopLastPriceObservedAt = 0;
              }
            }
          } else if (hardStopPendingAt) {
            write('events.jsonl', { type: 'STOP_LOSS_CANCELLED', mint, worker: index, observedAt: now, socketPriceUsd: price, socketReturnPercent: returnPercent, note: 'Socket price recovered above the hard-stop threshold before confirmation.' });
            hardStopPendingAt = 0; hardStopDistinctTicks = 0; hardStopLastPriceObservedAt = 0;
          }
          if (!exitReason && returnPercent >= 40 && sustainedHolderGrowth && (priceMomentum5s ?? 0) < 0.5) exitReason = 'TARGET_40_HOLDER_FLAT';
          if (exitReason) {
            simulationExit = exitReason;
            const result = writeSimulationExit(simulation, mint, now, price, exitReason, candidate?.metadata ?? null, { ...decision, holderCount, holderGrowthStreak, priceMomentum5s, recoveryHoldActive: now < recoveryHoldUntil, stopValidation: hardStopValidation });
            await prepareSellPanel(page, mint, index, now, exitReason).catch(error => {
              write('events.jsonl', { type: 'SELL_PREPARATION_ERROR', mint, worker: index, observedAt: Date.now(), reason: exitReason, message: error instanceof Error ? error.message : 'unknown' });
            });
            const releaseAt = Date.now() + exitHoldSeconds * 1000;
            write('events.jsonl', { type: 'SELL_PREPARED_HOLD', mint, worker: index, observedAt: now, reason: exitReason, holdSeconds: exitHoldSeconds, releaseAt,
              note: 'Sell panel is prepared but no order is submitted. The detail slot remains open for the configured review hold, then advances to the next queued token.' });
            console.log('[sim-sell]', candidate?.metadata?.symbol ?? mint, exitReason, 'pnl=$' + result.pnlUsd.toFixed(6), 'hold=' + exitHoldSeconds + 's');
            if (exitHoldSeconds > 0) await delay(exitHoldSeconds * 1000);
            write('events.jsonl', { type: 'DETAIL_SLOT_RELEASED_AFTER_SELL_HOLD', mint, worker: index, observedAt: Date.now(), reason: exitReason, holdSeconds: exitHoldSeconds });
            break;
          }
        }
        // A non-bought detail can be released on a rug.  A paper position must
        // stay alive long enough for the two-source stop confirmation above.
        if (!simulation && price && openingPrice && (openingPrice - price) / openingPrice * 100 >= stopLossPercent) { stopLoss = true; write('events.jsonl', { type: 'STOP_LOSS_REACHED', mint, observedAt: Date.now(), openingPriceUsd: openingPrice, currentPriceUsd: price, drawdownPercent: (openingPrice - price) / openingPrice * 100, thresholdPercent: stopLossPercent }); break; }
        await delay(500);
      }
      const candidate = candidates.get(mint);
      if (candidate) {
        const endedAt = Date.now();
        const endPrice = num(candidate, 'priceUsd');
        // A closing worker can lose a fresh token-stat update while still having
        // a valid last socket tick.  Finalize the paper position at that last
        // observed price; otherwise the report falsely labels it “monitoring”
        // after the collector itself has already ended.
        const finalTick = priceSamples.at(-1);
        const closePrice = endPrice && candidate.fields.priceUsd && endedAt - candidate.fields.priceUsd.observedAt <= 10_000 ? endPrice : finalTick?.priceUsd;
        if (simulation && !simulationExit && closePrice) {
          simulationExit = 'OBSERVATION_END'; const result = writeSimulationExit(simulation, mint, endedAt, closePrice, simulationExit, candidate.metadata ?? null, { priceSource: finalTick?.priceUsd === closePrice ? 'last observed detail socket tick' : 'fresh candidate price', priceObservedAt: finalTick?.observedAt ?? candidate.fields.priceUsd?.observedAt ?? null }); console.log('[sim-sell]', candidate.metadata?.symbol ?? mint, simulationExit, 'pnl=$' + result.pnlUsd.toFixed(6));
        }
        const summary = { mint, worker: index, startedAt, endedAt, endedBecause: stopLoss ? 'STOP_LOSS_REACHED' : 'OBSERVATION_WINDOW', openingPriceUsd: openingPrice, metadata: candidate.metadata ?? null, fields: candidate.fields, report: evaluate(candidate, config), capturedTrades: (trades.get(mint) ?? []).length, capturedHolderWallets: holders.get(mint)?.size ?? 0, comparison: comparison(mint, endedAt), developerMonitoring: developerMonitoring(mint), wallets: walletBehavior(mint, candidate) };
        write('token-summary.jsonl', summary);
        console.log('[detail-complete]', 'worker=' + index, mint, 'trades=' + summary.capturedTrades, 'holders=' + summary.capturedHolderWallets, summary.endedBecause);
      }
    } catch (error) { write('events.jsonl', { type: 'DETAIL_ERROR', worker: index, mint, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' }); }
    finally {
      queue.done(mint); activeMint = undefined;
      // Keep visible Chrome tabs aligned with actual monitoring state. A worker
      // that has finished must not leave its old GMGN token detail on screen.
      await page.goto('about:blank', { waitUntil: 'commit', timeout: config.workerTimeoutMs }).catch(() => {});
    }
  }
  await page.close().catch(() => {});
}
async function main() {
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ runId, startedAt: new Date().toISOString(), purpose: 'Research-only collector with paper buy/sell simulation and non-submitting GMGN UI preparation.', workers, detailSeconds, stopLossPercent, tradePreparation: { enabled: values.prepareTradeUi, buyStakeUsdc: simulationStakeUsd, sellPercent: 100, exitHoldSeconds, maxPaperBuys, enableExtensions: values.enableExtensions, executionSettings: DEFAULT_EXECUTION_SETTINGS, note: 'The collector fills GMGN controls but never clicks Buy or Sell.' }, simulation: { stakeUsd: simulationStakeUsd, maxPaperBuys, entryStability: { priceWindowSeconds: 5, minimumFreshPriceUpdates: 3, maximumPriceDropPercent: 2, maximumConsecutiveDeclines: 2, actionWhenBlocked: 'Continue detail observation without paper buy' }, mcapCandleHistory: { endpoint: '/api/v1/token_mcap_candles/sol/{mint}', resolution: '1m', limit: 501, pumpThenDump: { largestGreenCandlePercent: 100, peakToLastDrawdownPercent: -20 }, consecutiveRedCandles: 3 }, targetPercent: 40, trailingStartPercent: 20, trailingDrawdownPercent: 10, stopLossPercent: 20, sellPressure: { windowSeconds: 5, completedWindows: true, minimumTrades: 10, minimumUniqueSellers: 3, minimumSellSharePercent: 70, minimumPriceReturnPercent: -5, consecutiveWindows: 2 }, holderGrowthRecovery: { priceReturnMinPercent: -20, priceReturnMaxPercent: -10, minimumHolderGrowthPercent: 10, minimumHolderGrowthAbsolute: 5, holderUpdateFreshSeconds: 5, buyUsdAtLeastSellUsd: true, holdSeconds: 10 }, holderGrowthMomentum: { minimumConsecutiveGrowthUpdates: 2, minimumPriceMomentum5sPercent: 2, flatPriceMomentum5sBelowPercent: 0.5 }, executionSettings: DEFAULT_EXECUTION_SETTINGS }, feedRules: { minimumAgeSeconds: config.minimumAgeSeconds, maximumAgeSeconds: config.maximumAgeSeconds, minimumHolders: config.minimumHolders, minimumLiquidityUsd: config.minimumLiquidityUsd, maximumLiquidityUsd: config.maximumLiquidityUsd, maximumTop10Percent: config.maximumTop10Percent } }, null, 2));
  scheduleReportRefresh();
  context = await chromium.launchPersistentContext(values.profileDir, { channel: config.browserChannel || undefined, headless: false, viewport: null, args: ['--start-maximized', '--profile-directory=' + values.profileName], ignoreDefaultArgs: values.enableExtensions ? ['--disable-extensions'] : undefined });
  console.log('[research-start]', output, 'workers=' + workers, 'detailSeconds=' + detailSeconds);
  const feed = context.pages()[0] ?? await context.newPage(); attach(feed, true, () => undefined);
  await feed.goto(config.feedUrl, { waitUntil: 'commit', timeout: config.workerTimeoutMs });
  const deadline = Date.now() + runSeconds * 1000, timer = setTimeout(() => stopping.abort(), runSeconds * 1000);
  await Promise.allSettled(Array.from({ length: workers }, (_, index) => worker(index + 1, deadline)));
  clearTimeout(timer); const simulated = simulatedEvents;
  const sells = simulated.filter(row => row.type === 'SIMULATED_SELL'), pnl = sells.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0);
  writeFileSync(join(output, 'simulation-summary.json'), JSON.stringify({ observedAt: Date.now(), positionsOpened: simulated.filter(row => row.type === 'SIMULATED_BUY').length, positionsClosed: sells.length, openAtEnd: simulated.filter(row => row.type === 'SIMULATED_BUY').length - sells.length, totalStakeUsd: simulated.filter(row => row.type === 'SIMULATED_BUY').length * simulationStakeUsd, totalPnlUsd: pnl, profitable: sells.filter(row => (row.pnlUsd ?? 0) > 0).length, losing: sells.filter(row => (row.pnlUsd ?? 0) < 0).length, breakEven: sells.filter(row => row.pnlUsd === 0).length, exitsByReason: Object.fromEntries(sells.reduce((map, row) => map.set(row.reason ?? 'UNKNOWN', (map.get(row.reason ?? 'UNKNOWN') ?? 0) + 1), new Map<string, number>())), assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper simulation only; it does not represent executable net proceeds.' } }, null, 2));
  if (reportRefreshTimer) clearTimeout(reportRefreshTimer);
  await refreshLatestReport();
  write('events.jsonl', { type: 'RUN_COMPLETE', observedAt: Date.now(), sockets, received, screened: inspected.size, rejected: rejected.size, rejectionCounts: Object.fromEntries(rejectionCounts), youngRejected: youngRejected.size, youngRejectionCounts: Object.fromEntries(youngRejectionCounts), simulation: { positionsClosed: sells.length, totalPnlUsd: pnl } });
  console.log('[research-complete]', 'sockets=' + sockets, 'frames=' + received, 'screened=' + inspected.size, 'rejected=' + rejected.size, 'youngRejected=' + youngRejected.size);
  await context.close();
}
main().catch(error => { console.error(error); process.exitCode = 1; });
