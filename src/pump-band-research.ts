import { chromium, type BrowserContext, type Page } from 'playwright';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { attachCapture } from './capture.js';
import { parseCandidates, parseTokenMetadata, at, validMint } from './parser.js';
import { parseTokenActivities } from './activity.js';
import type { Candidate, Config } from './model.js';
import { PUMP_BAND_RULES, isInPumpBand, latestPricedTradeInFrame, pumpMilestones, type PumpBandTick } from './pump-band.js';

const { values } = parseArgs({ options: {
  seconds: { type: 'string', default: '1800' },
  workers: { type: 'string', default: String(PUMP_BAND_RULES.maximumSlots) },
  detailSeconds: { type: 'string', default: String(PUMP_BAND_RULES.observationSeconds) },
  dumpPercent: { type: 'string', default: String(PUMP_BAND_RULES.dumpFromPeakPercent) },
  minMarketCap: { type: 'string', default: String(PUMP_BAND_RULES.minimumMarketCapUsd) },
  maxMarketCap: { type: 'string', default: String(PUMP_BAND_RULES.maximumMarketCapUsd) },
  profileDir: { type: 'string', default: 'profiles/research-aria-tele01' },
  profileName: { type: 'string', default: 'Profile 12' },
  output: { type: 'string' }, config: { type: 'string', default: 'config/rules.yaml' },
} });

const baseConfig = loadConfig(values.config);
const workers = Number(values.workers), runSeconds = Number(values.seconds), detailSeconds = Number(values.detailSeconds);
const dumpPercent = Number(values.dumpPercent), minMarketCap = Number(values.minMarketCap), maxMarketCap = Number(values.maxMarketCap);
if (![workers, runSeconds, detailSeconds, dumpPercent, minMarketCap, maxMarketCap].every(Number.isFinite)
  || !Number.isInteger(workers) || workers < 1 || workers > PUMP_BAND_RULES.maximumSlots
  || runSeconds <= 0 || detailSeconds <= 0 || dumpPercent <= 0 || dumpPercent >= 100
  || minMarketCap <= 0 || minMarketCap >= maxMarketCap) throw new Error('Invalid pump-band research options');
if (!existsSync(values.profileDir)) throw new Error('Research profile tidak ditemukan: ' + values.profileDir);

type Primitive = string | number | boolean | null;
type ObservedTrade = { mint: string; wallet: string | null; side: 'buy' | 'sell'; occurredAt: number; observedAt: number; priceUsd: number | null; amountUsd: number | null };
type HolderRow = { wallet: string; amountPercentage: number | null; isDev: boolean; devEvidence: string[]; addrType: number | null; exchange: string; walletTag: string; isPoolOrExchange: boolean };
type Slot = { state: 'idle' | 'assigned' | 'active'; mint: string | null };
type Session = { mint: string; worker: number; startedAt: number; closedAt: number | null; entryMarketCapUsd: number; peakMarketCapUsd: number; ticks: PumpBandTick[]; lastHolderCount: number | null; topHolders: HolderRow[]; lastHolderResponseAt: number; holderPhase: 'start' | 'monitor' | 'end'; entryPriceUsd: number | null; entryPriceObservedAt: number | null; latestPriceUsd: number | null; latestPriceObservedAt: number | null; peakPriceUsd: number | null; lowPriceUsd: number | null; priceTickCount: number };

const runId = 'pump-band-' + new Date().toISOString().replace(/[:.]/g, '-');
const output = values.output || join('research', runId);
mkdirSync(output, { recursive: true });
const write = (file: string, value: unknown) => appendFileSync(join(output, file), JSON.stringify(value) + '\n');
const candidates = new Map<string, Candidate>();
const firstSeen = new Set<string>(), considered = new Set<string>(), activeMints = new Set<string>();
const trades = new Map<string, ObservedTrade[]>(), sessions = new Map<string, Session>();
const holderQueryByWorker = new Map<number, Record<string, string>>();
const manualHolderRequests = new Set<string>();
const slots: Slot[] = Array.from({ length: workers }, () => ({ state: 'idle', mint: null }));
let context: BrowserContext | undefined, received = 0, sockets = 0, skippedNoSlot = 0, nextHolderApiAt = 0, holderApiCooldownUntil = 0;
const stopping = new AbortController();
const HOLDER_QUERY_KEYS = ['device_id', 'tab_id', 'fp_did', 'client_id', 'from_app', 'app_ver', 'tz_name', 'tz_offset', 'app_lang', 'os', 'worker'] as const;

function merge(update: Candidate) {
  const candidate = candidates.get(update.mint) ?? { mint: update.mint, firstSeenAt: update.firstSeenAt, updatedAt: update.updatedAt, fields: {} };
  candidate.updatedAt = Math.max(candidate.updatedAt, update.updatedAt);
  if (update.metadata) candidate.metadata = { ...candidate.metadata, ...update.metadata };
  for (const [key, field] of Object.entries(update.fields)) {
    const old = candidate.fields[key as keyof Candidate['fields']];
    if (!old || field.observedAt >= old.observedAt) candidate.fields[key as keyof Candidate['fields']] = field;
  }
  candidates.set(candidate.mint, candidate);
  return candidate;
}
function fieldNumber(candidate: Candidate | undefined, key: keyof Candidate['fields']) {
  const value = candidate?.fields[key]?.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function snapshotFields(candidate: Candidate) {
  return Object.fromEntries(Object.entries(candidate.fields).map(([key, field]) => [key, { value: field.value, observedAt: field.observedAt, source: field.source }]));
}
function updateTick(mint: string, now: number, source: string, values: { marketCapUsd?: number | null; priceUsd?: number | null; liquidityUsd?: number | null }) {
  const session = sessions.get(mint);
  if (!session || session.closedAt !== null) return;
  const candidate = candidates.get(mint);
  const marketCapUsd = values.marketCapUsd === undefined ? fieldNumber(candidate, 'marketCapUsd') : values.marketCapUsd;
  const priceUsd = values.priceUsd === undefined ? fieldNumber(candidate, 'priceUsd') : values.priceUsd;
  const liquidityUsd = values.liquidityUsd === undefined ? fieldNumber(candidate, 'liquidityUsd') : values.liquidityUsd;
  const previous = session.ticks.at(-1);
  if (previous?.marketCapUsd === marketCapUsd && previous.priceUsd === priceUsd && now - previous.observedAt < 250) return;
  session.ticks.push({ observedAt: now, marketCapUsd, priceUsd });
  if (marketCapUsd !== null) session.peakMarketCapUsd = Math.max(session.peakMarketCapUsd, marketCapUsd);
  // Only transaction activity's `pu` field is suitable for price-return and
  // dump calculations. Candidate `p` values remain in the raw tick log but
  // must not become a false transaction-price baseline.
  const usablePrice = source.startsWith('detail_socket_activity') && priceUsd !== null && priceUsd > 0 ? priceUsd : null;
  if (usablePrice !== null) {
    if (session.entryPriceUsd === null) {
      session.entryPriceUsd = usablePrice; session.entryPriceObservedAt = now;
      write('events.jsonl', { type: 'PRICE_BASELINE_CAPTURED', mint, worker: session.worker, observedAt: now, latencyMs: now - session.startedAt, priceUsd: usablePrice, source });
    }
    session.latestPriceUsd = usablePrice; session.latestPriceObservedAt = now;
    session.peakPriceUsd = Math.max(session.peakPriceUsd ?? usablePrice, usablePrice);
    session.lowPriceUsd = Math.min(session.lowPriceUsd ?? usablePrice, usablePrice);
    session.priceTickCount++;
  }
  const returnFromEntryPercent = usablePrice !== null && session.entryPriceUsd ? ((usablePrice / session.entryPriceUsd) - 1) * 100 : null;
  const drawdownFromPricePeakPercent = usablePrice !== null && session.peakPriceUsd ? ((usablePrice / session.peakPriceUsd) - 1) * 100 : null;
  const estimatedMarketCapUsd = usablePrice !== null && session.entryPriceUsd ? session.entryMarketCapUsd * usablePrice / session.entryPriceUsd : null;
  write('socket-ticks.jsonl', { mint, worker: session.worker, observedAt: now, source, marketCapUsd, priceUsd, liquidityUsd, holders: fieldNumber(candidate, 'holders'),
    returnFromFirstPricePercent: returnFromEntryPercent, drawdownFromPricePeakPercent, estimatedMarketCapUsd, estimatedMarketCapMethod: estimatedMarketCapUsd === null ? null : 'entry market cap scaled by pu price ratio; assumes constant token supply' });
}
function captureDetailPayload(payload: unknown, now: number, activeMint: string) {
  const session = sessions.get(activeMint);
  if (!session || session.closedAt !== null) return;
  const activities = parseTokenActivities(payload, now).filter(activity => activity.mint === activeMint);
  for (const activity of activities) {
    const trade: ObservedTrade = { mint: activity.mint, wallet: activity.actorAddress ?? null, side: activity.side, occurredAt: activity.occurredAt, observedAt: activity.observedAt, priceUsd: activity.priceUsd ?? null, amountUsd: activity.amount ?? null };
    const list = trades.get(activeMint) ?? []; list.push(trade); trades.set(activeMint, list);
    write('trades.jsonl', trade);
  }
  const latestActivity = latestPricedTradeInFrame(activities);
  if (latestActivity) updateTick(activeMint, now, 'detail_socket_activity', { priceUsd: latestActivity.priceUsd });
  for (const update of parseCandidates(payload, baseConfig.mappings, now, 'detail_socket')) {
    if (update.mint !== activeMint) continue;
    const candidate = merge(update);
    updateTick(activeMint, now, 'detail_socket_candidate', { marketCapUsd: fieldNumber(candidate, 'marketCapUsd'), priceUsd: fieldNumber(candidate, 'priceUsd'), liquidityUsd: fieldNumber(candidate, 'liquidityUsd') });
  }
}
function assignFresh(candidate: Candidate, now: number) {
  if (considered.has(candidate.mint)) return;
  const marketCapUsd = fieldNumber(candidate, 'marketCapUsd');
  if (!isInPumpBand(marketCapUsd) || marketCapUsd === null || marketCapUsd < minMarketCap || marketCapUsd > maxMarketCap) return;
  considered.add(candidate.mint);
  const slotIndex = slots.findIndex(slot => slot.state === 'idle');
  if (slotIndex < 0) {
    skippedNoSlot++;
    write('fresh-tokens.jsonl', { type: 'SKIPPED_NO_EMPTY_SLOT', mint: candidate.mint, observedAt: now, marketCapUsd, metadata: candidate.metadata ?? null, fields: snapshotFields(candidate) });
    return;
  }
  const slot = slots[slotIndex]!;
  slot.state = 'assigned';
  slot.mint = candidate.mint;
  write('fresh-tokens.jsonl', { type: 'ASSIGNED_FRESH_TOKEN', mint: candidate.mint, worker: slotIndex + 1, observedAt: now, marketCapUsd, metadata: candidate.metadata ?? null, fields: snapshotFields(candidate) });
  console.log('[pump-band-assigned]', 'slot=' + (slotIndex + 1), candidate.metadata?.symbol ?? candidate.mint, '$' + marketCapUsd.toFixed(2));
}
function attachFeed(page: Page) {
  attachCapture(page, event => {
    if (event.kind === 'open') { sockets++; console.log('[socket-open] pump-band-feed'); }
    if (event.kind === 'frame' && event.direction === 'received') received++;
  }, (payload, now, source) => {
    for (const metadata of parseTokenMetadata(payload)) {
      const known = candidates.get(metadata.mint);
      if (known) merge({ mint: metadata.mint, firstSeenAt: known.firstSeenAt, updatedAt: now, fields: {}, metadata: metadata.metadata });
    }
    for (const update of parseCandidates(payload, baseConfig.mappings, now, source)) {
      const isNew = !firstSeen.has(update.mint);
      if (isNew) firstSeen.add(update.mint);
      const candidate = merge(update);
      if (isNew) write('fresh-tokens.jsonl', { type: 'FEED_FIRST_SEEN', mint: candidate.mint, observedAt: now, metadata: candidate.metadata ?? null, fields: snapshotFields(candidate) });
      if (activeMints.has(candidate.mint)) updateTick(candidate.mint, now, 'feed_socket', { marketCapUsd: fieldNumber(candidate, 'marketCapUsd'), priceUsd: fieldNumber(candidate, 'priceUsd'), liquidityUsd: fieldNumber(candidate, 'liquidityUsd') });
      assignFresh(candidate, now);
    }
  });
}
async function fetchJson(page: Page, path: string) {
  return page.evaluate(async requestPath => {
    const response = await fetch(requestPath, { credentials: 'include' });
    const text = await response.text();
    try { return { status: response.status, data: JSON.parse(text) as unknown }; }
    catch { return { status: response.status, data: null }; }
  }, path);
}
function readHolderCount(value: unknown): number | null {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  for (const key of ['holder_count', 'holders', 'holder_num', 'holderCount']) {
    const count = Number(data[key]); if (Number.isFinite(count) && count >= 0) return count;
  }
  return null;
}
function parseHolderRows(value: unknown): HolderRow[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root;
  const list = [data.list, data.holders, root.list].find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  return list.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const wallet = [record.address, record.wallet, record.owner, record.a].find(value => typeof value === 'string');
    if (typeof wallet !== 'string' || !validMint(wallet)) return [];
    const rawPercentage = Number(record.amount_percentage ?? record.amountPercent ?? record.percentage);
    const amountPercentage = Number.isFinite(rawPercentage) ? (rawPercentage > 0 && rawPercentage <= 1 ? rawPercentage * 100 : rawPercentage) : null;
    const tags = [record.tag, record.tag_v2, record.wallet_tag_v2,
      ...(Array.isArray(record.maker_token_tags) ? record.maker_token_tags : []),
      ...(Array.isArray(record.tags) ? record.tags : [])].filter((tag): tag is string => typeof tag === 'string');
    const devEvidence = tags.filter(tag => tag.toLowerCase() === 'creator' || tag.toLowerCase().includes('dev'));
    const addrType = Number(record.addr_type);
    const exchange = typeof record.exchange === 'string' ? record.exchange : '';
    const walletTag = typeof record.wallet_tag_v2 === 'string' ? record.wallet_tag_v2 : '';
    const isPoolOrExchange = addrType === 2 || Boolean(exchange) || walletTag.toLowerCase().includes('lp');
    return [{ wallet, amountPercentage, isDev: devEvidence.length > 0, devEvidence,
      addrType: Number.isFinite(addrType) ? addrType : null, exchange, walletTag, isPoolOrExchange }];
  }).sort((a, b) => (b.amountPercentage ?? -1) - (a.amountPercentage ?? -1));
}
function cacheHolderQuery(worker: number, requestUrl: string) {
  try {
    const url = new URL(requestUrl);
    if (!url.hostname.endsWith('gmgn.ai')) return;
    const params = Object.fromEntries(HOLDER_QUERY_KEYS.flatMap(key => {
      const value = url.searchParams.get(key);
      return value === null ? [] : [[key, value]];
    }));
    if (params.device_id && params.tab_id && params.fp_did && params.client_id && params.app_ver) {
      holderQueryByWorker.set(worker, { ...holderQueryByWorker.get(worker), ...params });
    }
  } catch { /* Ignore non-URL or non-GMGN requests. */ }
}
function writeHolderSnapshot(session: Session, observedAt: number, phase: Session['holderPhase'], status: number, value: unknown, source: string, queryKeys: string[] = []) {
  const rows = status === 200 ? parseHolderRows(value) : [];
  if (rows.length) session.topHolders = rows;
  const top = rows.slice(0, 10);
  const topUsers = rows.filter(row => !row.isPoolOrExchange).slice(0, 10);
  write('holder-snapshots.jsonl', { mint: session.mint, worker: session.worker, observedAt, phase, source, status, queryKeys,
    topHolders: top, topUserHolders: topUsers, top1Percent: topUsers[0]?.amountPercentage ?? null,
    top5Percent: topUsers.slice(0, 5).reduce((sum, row) => sum + (row.amountPercentage ?? 0), 0),
    top10Percent: topUsers.reduce((sum, row) => sum + (row.amountPercentage ?? 0), 0) });
  if (status === 429) holderApiCooldownUntil = Math.max(holderApiCooldownUntil, Date.now() + 60_000);
  session.lastHolderResponseAt = observedAt;
}
function attachHolderResponseCapture(page: Page, worker: number) {
  page.on('request', request => cacheHolderQuery(worker, request.url()));
  page.on('websocket', socket => cacheHolderQuery(worker, socket.url()));
  page.on('response', async response => {
    let url: URL;
    try { url = new URL(response.url()); } catch { return; }
    if (!url.pathname.includes('/vas/api/v1/token_holders/sol/')) return;
    cacheHolderQuery(worker, response.url());
    const mint = url.pathname.split('/').at(-1) ?? '';
    if (!validMint(mint)) return;
    const session = sessions.get(mint);
    if (!session) return;
    const observedAt = Date.now();
    if (manualHolderRequests.has(mint)) {
      if (response.status() === 429) holderApiCooldownUntil = Math.max(holderApiCooldownUntil, observedAt + 60_000);
      session.lastHolderResponseAt = observedAt;
      return;
    }
    let body: unknown = null;
    if (response.status() === 200) body = await response.json().catch(() => null);
    writeHolderSnapshot(session, observedAt, session.holderPhase, response.status(), body, 'GMGN UI XHR (passive)', [...url.searchParams.keys()]);
  });
}
async function refreshHolderCount(page: Page, session: Session, now: number) {
  try {
    const result = await fetchJson(page, '/api/v1/token_stat/sol/' + encodeURIComponent(session.mint));
    const holderCount = result.status === 200 ? readHolderCount(result.data) : null;
    if (holderCount !== null) session.lastHolderCount = holderCount;
    write('holder-counts.jsonl', { mint: session.mint, worker: session.worker, observedAt: now, source: 'GMGN /api/v1/token_stat', status: result.status, holderCount });
  } catch (error) {
    write('holder-counts.jsonl', { mint: session.mint, worker: session.worker, observedAt: now, source: 'GMGN /api/v1/token_stat', status: null, holderCount: null, error: error instanceof Error ? error.message : 'unknown' });
  }
}
async function refreshTopHolders(page: Page, session: Session, now: number, phase: 'start' | 'end') {
  session.holderPhase = phase;
  // Reuse the page's own response if GMGN has already loaded this token's
  // holder table. Do not immediately issue a duplicate API request.
  if ((phase === 'start' && session.lastHolderResponseAt >= session.startedAt)
    || (phase === 'end' && session.lastHolderResponseAt >= now - 1_500)) return;
  const defer = (reason: string, retryAt?: number) => write('events.jsonl', { type: 'TOP_HOLDERS_REQUEST_DEFERRED', mint: session.mint, worker: session.worker, observedAt: Date.now(), phase, reason, retryAt: retryAt ?? null });
  if (Date.now() < holderApiCooldownUntil) { defer('HTTP_429_COOLDOWN', holderApiCooldownUntil); return; }
  if (Date.now() < nextHolderApiAt) { defer('GLOBAL_REQUEST_SPACING', nextHolderApiAt); return; }
  const query = new URLSearchParams(holderQueryByWorker.get(session.worker) ?? {});
  for (const [key, value] of Object.entries({ from_app: 'gmgn', tz_name: 'Asia_Jakarta', tz_offset: '25200', app_lang: 'en-US', os: 'web', worker: '0' })) {
    if (!query.has(key)) query.set(key, value);
  }
  const missing = ['device_id', 'tab_id', 'fp_did', 'client_id', 'app_ver'].filter(key => !query.has(key));
  if (missing.length) { defer('MISSING_LIVE_BROWSER_QUERY_PARAMS:' + missing.join(',')); return; }
  query.set('limit', '100'); query.set('cost', '20'); query.set('tag', 'dev');
  query.set('orderby', 'amount_percentage'); query.set('direction', 'desc');
  const path = '/vas/api/v1/token_holders/sol/' + encodeURIComponent(session.mint) + '?' + query.toString();
  nextHolderApiAt = Date.now() + 3_000;
  manualHolderRequests.add(session.mint);
  try {
    const result = await fetchJson(page, path);
    writeHolderSnapshot(session, Date.now(), phase, result.status, result.data, 'GMGN API fallback (full browser query)', [...query.keys()]);
    if (result.status === 429) holderApiCooldownUntil = Math.max(holderApiCooldownUntil, Date.now() + 60_000);
  } catch (error) {
    write('holder-snapshots.jsonl', { mint: session.mint, worker: session.worker, observedAt: Date.now(), phase, source: 'GMGN API fallback (full browser query)', status: null, queryKeys: [...query.keys()], topHolders: [], error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    manualHolderRequests.delete(session.mint);
  }
}
async function captureCandles(page: Page, session: Session, now: number, phase: 'start' | 'end') {
  try {
    const result = await fetchJson(page, '/api/v1/token_mcap_candles/sol/' + encodeURIComponent(session.mint) + '?pool_type=tpool&resolution=1m&limit=501');
    const root = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {};
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
    const list = Array.isArray(data.list) ? data.list : [];
    write('mcap-candles.jsonl', { mint: session.mint, worker: session.worker, observedAt: now, phase, source: 'GMGN /api/v1/token_mcap_candles', status: result.status, candles: list });
  } catch (error) {
    write('mcap-candles.jsonl', { mint: session.mint, worker: session.worker, observedAt: now, phase, source: 'GMGN /api/v1/token_mcap_candles', status: null, candles: [], error: error instanceof Error ? error.message : 'unknown' });
  }
}
function writeFlowWindow(session: Session, now: number) {
  const rows = (trades.get(session.mint) ?? []).filter(trade => trade.occurredAt >= now - PUMP_BAND_RULES.flowWindowMs);
  const buys = rows.filter(row => row.side === 'buy'), sells = rows.filter(row => row.side === 'sell');
  const buyUsd = buys.reduce((sum, row) => sum + (row.amountUsd ?? 0), 0), sellUsd = sells.reduce((sum, row) => sum + (row.amountUsd ?? 0), 0);
  write('flow-windows.jsonl', { mint: session.mint, worker: session.worker, observedAt: now, windowSeconds: PUMP_BAND_RULES.flowWindowMs / 1000, buys: buys.length, sells: sells.length, buyUsd, sellUsd, uniqueBuyers: new Set(buys.flatMap(row => row.wallet ? [row.wallet] : [])).size, uniqueSellers: new Set(sells.flatMap(row => row.wallet ? [row.wallet] : [])).size, holderCount: session.lastHolderCount, marketCapUsd: session.ticks.at(-1)?.marketCapUsd ?? null });
}
async function observe(page: Page, worker: number, mint: string, deadline: number) {
  let session: Session | undefined;
  const candidate = candidates.get(mint);
  const entryMarketCapUsd = fieldNumber(candidate, 'marketCapUsd');
  if (entryMarketCapUsd === null) return;
  const startedAt = Date.now(), stopAt = Math.min(deadline, startedAt + detailSeconds * 1_000);
  session = { mint, worker, startedAt, closedAt: null, entryMarketCapUsd, peakMarketCapUsd: entryMarketCapUsd, ticks: [{ observedAt: startedAt, marketCapUsd: entryMarketCapUsd, priceUsd: null }], lastHolderCount: fieldNumber(candidate, 'holders'), topHolders: [], lastHolderResponseAt: 0, holderPhase: 'start', entryPriceUsd: null, entryPriceObservedAt: null, latestPriceUsd: null, latestPriceObservedAt: null, peakPriceUsd: null, lowPriceUsd: null, priceTickCount: 0 };
  sessions.set(mint, session); activeMints.add(mint);
  write('events.jsonl', { type: 'SESSION_STARTED', mint, worker, startedAt, entryMarketCapUsd, metadata: candidate?.metadata ?? null });
  console.log('[pump-band-start]', 'slot=' + worker, candidate?.metadata?.symbol ?? mint, '$' + entryMarketCapUsd.toFixed(2));
  let endedBecause = `OBSERVATION_${detailSeconds}S_COMPLETE`, dumpDetails: { reference: string; entryPriceUsd: number; peakPriceUsd: number; currentPriceUsd: number; drawdownPercent: number } | null = null, lastPollAt = 0;
  try {
    await page.goto(baseConfig.tokenUrlTemplate.replaceAll('{mint}', mint), { waitUntil: 'commit', timeout: baseConfig.workerTimeoutMs });
    await Promise.allSettled([refreshHolderCount(page, session, Date.now()), refreshTopHolders(page, session, Date.now(), 'start'), captureCandles(page, session, Date.now(), 'start')]);
    while (!stopping.signal.aborted && Date.now() < stopAt) {
      const now = Date.now();
      session.holderPhase = 'monitor';
      const currentMarketCapUsd = fieldNumber(candidates.get(mint), 'marketCapUsd');
      if (typeof currentMarketCapUsd === 'number' && Number.isFinite(currentMarketCapUsd)) session.peakMarketCapUsd = Math.max(session.peakMarketCapUsd, currentMarketCapUsd);
      const currentPriceUsd = session.latestPriceUsd, peakPriceUsd = session.peakPriceUsd;
      if (session.entryPriceUsd !== null && currentPriceUsd !== null && peakPriceUsd !== null
        && session.latestPriceObservedAt !== null && now - session.latestPriceObservedAt <= 5_000) {
        const drawdownPercent = ((currentPriceUsd / peakPriceUsd) - 1) * 100;
        if (drawdownPercent <= -dumpPercent) {
          endedBecause = 'DUMP_20_FROM_SESSION_PEAK_PRICE';
          dumpDetails = { reference: 'socket transaction price pu', entryPriceUsd: session.entryPriceUsd, peakPriceUsd, currentPriceUsd, drawdownPercent };
          break;
        }
      }
      if (now - lastPollAt >= PUMP_BAND_RULES.holderPollMs) {
        lastPollAt = now;
        await refreshHolderCount(page, session, now);
        writeFlowWindow(session, now);
      }
      await delay(200);
    }
  } catch (error) {
    endedBecause = 'DETAIL_ERROR';
    write('events.jsonl', { type: 'SESSION_ERROR', mint, worker, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
  } finally {
    const endedAt = Date.now();
    session.closedAt = endedAt;
    await Promise.allSettled([refreshTopHolders(page, session, endedAt, 'end'), captureCandles(page, session, endedAt, 'end')]);
    const finalMarketCapUsd = fieldNumber(candidates.get(mint), 'marketCapUsd') ?? session.ticks.at(-1)?.marketCapUsd ?? null;
    const holderAtEnd = session.lastHolderCount;
    const startHolders = fieldNumber(candidate, 'holders');
    const top = session.topHolders.filter(row => !row.isPoolOrExchange).slice(0, 10);
    write('token-summary.jsonl', { mint, worker, startedAt, endedAt, endedBecause, entryMarketCapUsd: session.entryMarketCapUsd, finalMarketCapUsd, peakMarketCapUsd: session.peakMarketCapUsd, entryToFinalPercent: finalMarketCapUsd === null ? null : ((finalMarketCapUsd / session.entryMarketCapUsd) - 1) * 100, peakToFinalDrawdownPercent: finalMarketCapUsd === null ? null : ((finalMarketCapUsd / session.peakMarketCapUsd) - 1) * 100,
      entryPriceUsd: session.entryPriceUsd, entryPriceObservedAt: session.entryPriceObservedAt, entryPriceLatencyMs: session.entryPriceObservedAt === null ? null : session.entryPriceObservedAt - startedAt,
      finalPriceUsd: session.latestPriceUsd, finalPriceObservedAt: session.latestPriceObservedAt, peakPriceUsd: session.peakPriceUsd, lowPriceUsd: session.lowPriceUsd, priceTickCount: session.priceTickCount,
      priceReturnPercent: session.entryPriceUsd && session.latestPriceUsd ? ((session.latestPriceUsd / session.entryPriceUsd) - 1) * 100 : null,
      pricePeakToFinalDrawdownPercent: session.peakPriceUsd && session.latestPriceUsd ? ((session.latestPriceUsd / session.peakPriceUsd) - 1) * 100 : null,
      priceReturnMethod: 'first valid observed socket price pu to last valid observed socket price pu; not an execution fill', dumpDetails, milestonesMs: pumpMilestones(session.ticks, startedAt), holderCountStart: startHolders, holderCountEnd: holderAtEnd, holderChange: startHolders !== null && holderAtEnd !== null ? holderAtEnd - startHolders : null, top1Percent: top[0]?.amountPercentage ?? null, top5Percent: top.slice(0, 5).reduce((sum, row) => sum + (row.amountPercentage ?? 0), 0), top10Percent: top.reduce((sum, row) => sum + (row.amountPercentage ?? 0), 0), devHolders: top.filter(row => row.isDev).length, capturedTicks: session.ticks.length, capturedTrades: (trades.get(mint) ?? []).length, metadata: candidate?.metadata ?? null });
    write('events.jsonl', { type: 'SESSION_FINISHED', mint, worker, observedAt: endedAt, endedBecause });
    sessions.delete(mint); activeMints.delete(mint);
    console.log('[pump-band-complete]', 'slot=' + worker, candidate?.metadata?.symbol ?? mint, endedBecause);
  }
}
async function worker(index: number, deadline: number) {
  const slot = slots[index - 1]!;
  const page = await context!.newPage();
  let activeMint: string | undefined;
  attachCapture(page, event => {
    if (event.kind === 'open') { sockets++; console.log('[socket-open] pump-band-detail'); }
    if (event.kind === 'frame' && event.direction === 'received') received++;
  }, (payload, now) => { if (activeMint) captureDetailPayload(payload, now, activeMint); });
  attachHolderResponseCapture(page, index);
  try {
    while (!stopping.signal.aborted && Date.now() < deadline) {
      if (slot.state !== 'assigned' || !slot.mint) { await delay(100); continue; }
      const mint = slot.mint; slot.state = 'active'; activeMint = mint;
      try { await observe(page, index, mint, deadline); }
      finally {
        activeMint = undefined;
        // Keep this tab for its worker. Navigating it blank closes the old
        // token socket before the next fresh token is assigned to this slot.
        await page.goto('about:blank', { waitUntil: 'commit', timeout: baseConfig.workerTimeoutMs }).catch(() => {});
        slot.state = 'idle'; slot.mint = null;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}
async function main() {
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ runId, startedAt: new Date().toISOString(), purpose: 'Fresh-token pump-band research only. No buy, sell, or paper position is created.', rules: { ...PUMP_BAND_RULES, minimumMarketCapUsd: minMarketCap, maximumMarketCapUsd: maxMarketCap, observationSeconds: detailSeconds, maximumSlots: workers, dumpFromPeakPercent: dumpPercent }, scheduling: 'No queue. A token is assigned only if a detail slot is empty at its first eligible live feed observation. Full slots cause SKIPPED_NO_EMPTY_SLOT.', sources: ['GMGN WebSocket feed and detail sockets', 'GMGN token_stat API every 5 seconds', 'GMGN holder XHR response interception with full-query API fallback, start/end, global 3-second minimum spacing and 60-second cooldown after HTTP 429', 'GMGN mcap candles at session start/end'] }, null, 2));
  context = await chromium.launchPersistentContext(values.profileDir, { channel: baseConfig.browserChannel || undefined, headless: false, viewport: null, args: ['--start-maximized', '--profile-directory=' + values.profileName] });
  const feed = context.pages()[0] ?? await context.newPage(); attachFeed(feed);
  await feed.goto(baseConfig.feedUrl, { waitUntil: 'commit', timeout: baseConfig.workerTimeoutMs });
  const deadline = Date.now() + runSeconds * 1_000, timer = setTimeout(() => stopping.abort(), runSeconds * 1_000);
  console.log('[pump-band-research-start]', output, 'slots=' + workers, 'seconds=' + detailSeconds, 'band=$' + minMarketCap + '-$' + maxMarketCap);
  await Promise.allSettled(Array.from({ length: workers }, (_, index) => worker(index + 1, deadline)));
  clearTimeout(timer);
  const summaries = existsSync(join(output, 'token-summary.jsonl')) ? requireLines(join(output, 'token-summary.jsonl')) : [];
  const byReason = summaries.reduce((map, row) => map.set(String(row.endedBecause), (map.get(String(row.endedBecause)) ?? 0) + 1), new Map<string, number>());
  writeFileSync(join(output, 'run-summary.json'), JSON.stringify({ runId, observedAt: Date.now(), feedTokensSeen: firstSeen.size, eligibleTokens: considered.size, sessionsCompleted: summaries.length, skippedNoEmptySlot: skippedNoSlot, sessionEndReasons: Object.fromEntries(byReason), sockets, received }, null, 2));
  const child = spawn(process.execPath, ['scripts/generate-pump-band-report.mjs', output], { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
  await new Promise(resolve => child.once('exit', resolve));
  await context.close();
  console.log('[pump-band-research-complete]', 'sessions=' + summaries.length, 'skippedNoSlot=' + skippedNoSlot);
}
function requireLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; } });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
