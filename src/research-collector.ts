import { chromium, type BrowserContext, type Page } from 'playwright';
import { parseArgs } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { attachCapture } from './capture.js';
import { at, parseCandidates, parseTokenMetadata, validMint } from './parser.js';
import { CandidateQueue } from './queue.js';
import { evaluate } from './risk.js';
import { assessBlindProtection, assessCandleEntryFlow, assessCandleHistory, assessEarlyCandleRising, assessEntryStability, assessFlow3EntryStability, assessFlow3Simulation, assessHolderDistribution, assessObservationDump, assessSimulation, assessSingleCandleHolderOverride, closeSimulation, openSimulation, type BlindProtectionDecision, type HolderDistributionDecision, type McapCandle, type ObservationDumpDecision, type ObservationDumpReason, type SimulationPosition, type SimulationExitReason } from './research-simulation.js';
import { DEFAULT_EXECUTION_SETTINGS } from './execution-settings.js';
import { amountInput, applyExecutionSettings, clickTradeButton, fetchSolUsdSpot, fetchSolUsdSpotInBrowser, selectSellPercent, selectTradeSide, usdcToSol } from './gmgn-trade-ui.js';
import type { Candidate, Config } from './model.js';
import { MOMENTUM_AGGRESSIVE_RULES, MOMENTUM_R5_BAND, MOMENTUM_RULES, MOMENTUM_V3_RULES, assessMomentumAggressiveEntry, assessMomentumAggressiveExit, assessMomentumEntry, assessMomentumExit, cleanTape, createMomentumPosition, type HolderSample, type OwnerSample, type TapeTrade } from './momentum-strategy.js';
import { paperOrderEvent, paperSignal, type PaperSignal } from './paper-signal.js';
import { PUMP_BAND_RULES, isInPumpBand, latestPricedTradeInFrame } from './pump-band.js';
import { ResearchHolderStore, type ResearchTrackedHolder } from './research-holder-store.js';
import { assessPreBuyHolderGate } from './prebuy-holder-gate.js';

const defaultProfileDir = existsSync('profiles/research-vps') ? 'profiles/research-vps' : 'profiles/research-aria-tele01';
const defaultProfileName = defaultProfileDir === 'profiles/research-vps' ? 'Default' : 'Profile 12';

const { values } = parseArgs({ options: {
  seconds: { type: 'string', default: '0' }, detailSeconds: { type: 'string', default: '600' },
  workers: { type: 'string', default: '3' }, stopLossPercent: { type: 'string', default: '20' },
  simulationStakeUsd: { type: 'string' },
  stake: { type: 'string' },
  stakeUsd: { type: 'string' },
  amount: { type: 'string' },
  sol: { type: 'string' },
  buySol: { type: 'string' },
  profileDir: { type: 'string', default: defaultProfileDir },
  profileName: { type: 'string', default: defaultProfileName }, output: { type: 'string' },
  prepareTradeUi: { type: 'boolean', default: true }, enableExtensions: { type: 'boolean', default: true },
  exitHoldSeconds: { type: 'string', default: '20' }, maxPaperBuys: { type: 'string' }, maxBuys: { type: 'string' },
  autoBuy: { type: 'boolean' },
  orderCapture: { type: 'boolean', default: false },
  orderCapturePayloads: { type: 'boolean', default: false },
  simulateOrder: { type: 'boolean', default: false },
  browserBuyPrompt: { type: 'boolean', default: false },
  browserPromptTestSignal: { type: 'boolean', default: false },
  browserAutoTrade: { type: 'boolean', default: false },
  browserBuyAuto: { type: 'boolean', default: false },
  quoteSimulation: { type: 'boolean', default: false },
  orderOutcomeCapture: { type: 'boolean', default: false },
  controlOnly: { type: 'boolean', default: false },
  strategy: { type: 'string', default: 'momentum-v2' },
  topHolderDumpMinPercent: { type: 'string' },
  config: { type: 'string', default: 'config/rules.yaml' },
} });
const loadedConfig = loadConfig(values.config);
if (!['legacy', 'flow-3', 'momentum-v2', 'momentum-v3', 'momentum-v2-v3', 'pump-band', 'momentum-aggressive'].includes(values.strategy!)) throw new Error('Unknown research strategy');
const momentumAggressive = values.strategy === 'momentum-aggressive';
const momentumComparison = values.strategy === 'momentum-v2-v3';
const standaloneMomentumV2 = values.strategy === 'momentum-v2';
const standaloneMomentumV3 = values.strategy === 'momentum-v3';
const momentumV2 = standaloneMomentumV2 || momentumComparison;
const momentumV3 = standaloneMomentumV3 || momentumComparison;
const momentumResearch = momentumV2 || momentumV3 || momentumAggressive;
const browserAutoTrade = Boolean(values.browserAutoTrade || values.browserBuyAuto);
const browserTradingEnabled = values.browserBuyPrompt || browserAutoTrade;
const quoteSimulationEnabled = Boolean(values.quoteSimulation);
if (browserAutoTrade && !standaloneMomentumV2) throw new Error('--browserAutoTrade is only supported with standalone --strategy momentum-v2.');
if (quoteSimulationEnabled && !momentumResearch) throw new Error('--quoteSimulation is only supported with momentum paper strategies.');
if (browserAutoTrade) {
  values.orderOutcomeCapture = true;
  values.controlOnly = true;
}
const r5BandEnabled = standaloneMomentumV2 && !values.controlOnly;
const flow3 = values.strategy === 'flow-3';
const pumpBand = values.strategy === 'pump-band';
const FLOW3_RULES = {
  version: 'flow-3',
  entry: { priceWindowSeconds: 5, minimumFreshPriceUpdates: 3, maximumPriceDropPercent: 2, maximumConsecutiveDeclines: 2, minimumTrades20s: 5, buyUsdAtLeastSellUsd: true },
  candles: { minimumCompletedCandles: 2, allowTwoCandleHistory: true, largestGreenCandlePercent: 100, peakToLastDrawdownPercent: -20, maximumConsecutiveRedCandles: 2 },
  exits: { targetPercent: 40, hardStopPercent: 20, trailingStartPercent: 20, trailingDrawdownPercent: 10, sellPressureWindows: 2 },
  feed: { minimumHolders: 20, minimumLiquidityUsd: 6_000, maximumLiquidityUsd: 15_000, maximumTop10Percent: 30 },
  stakeUsd: 0.25,
} as const;
// Flow-3 replays the recorded 2026-09-21 paper experiment.  It intentionally
// fixes the feed thresholds so an unrelated YAML tuning run cannot silently
// change the research cohort.
const config: Config = flow3 ? {
  ...loadedConfig,
  minimumAgeSeconds: 0,
  maximumAgeSeconds: 900,
  minimumHolders: 20,
  minimumLiquidityUsd: 6_000,
  maximumLiquidityUsd: 15_000,
  maximumTop10Percent: 30,
} : loadedConfig;
const runSeconds = Number(values.seconds), detailSeconds = Number(pumpBand && values.detailSeconds === '600' ? '20' : values.detailSeconds);
const workers = Number(values.workers), stopLossPercent = Number(values.stopLossPercent);
const exitHoldSeconds = Number(values.exitHoldSeconds);
const maxPaperBuys = values.maxPaperBuys !== undefined ? Number(values.maxPaperBuys) : values.maxBuys !== undefined ? Number(values.maxBuys) : null;
const autoBuyEnabled = values.autoBuy !== undefined ? values.autoBuy : (config.autoBuy ?? false);
if ((momentumResearch || flow3 || pumpBand) && autoBuyEnabled) throw new Error(`${values.strategy} is a paper research strategy; set autoBuy=false before testing it.`);
if (values.orderCapture && !standaloneMomentumV2) throw new Error('--orderCapture is only supported with standalone --strategy momentum-v2.');
if (values.simulateOrder && !standaloneMomentumV2 && !momentumAggressive) throw new Error('--simulateOrder is only supported with standalone --strategy momentum-v2 or momentum-aggressive.');
if (values.browserBuyPrompt && !standaloneMomentumV2) throw new Error('--browserBuyPrompt is only supported with standalone --strategy momentum-v2.');
if (values.browserPromptTestSignal && !values.browserBuyPrompt) throw new Error('--browserPromptTestSignal requires --browserBuyPrompt.');
const topHolderDumpMinPercent = values.topHolderDumpMinPercent !== undefined ? Number(values.topHolderDumpMinPercent) : (config.topHolderDumpMinPercent ?? 1.5);

// Stake configuration: supports USD (--stake 1, --stakeUsd 5) or direct SOL (--sol 0.005, --buySol 0.01)
const directSolArg = values.sol ?? values.buySol;
const simulationStakeSol = directSolArg !== undefined
  ? Number(directSolArg)
  : (config.simulationStakeSol ?? null);

const rawStakeUsd = values.stake ?? values.stakeUsd ?? values.amount ?? values.simulationStakeUsd
  ?? (flow3 || pumpBand ? '0.25' : config.simulationStakeUsd !== undefined ? String(config.simulationStakeUsd) : '0.25');
const simulationStakeUsd = Number(rawStakeUsd);
if (pumpBand && simulationStakeSol !== null) throw new Error('pump-band paper simulation uses a USDC stake; omit --sol/--buySol');

if (![runSeconds, detailSeconds, workers, stopLossPercent, simulationStakeUsd, exitHoldSeconds].every(Number.isFinite) || runSeconds < 0 || detailSeconds <= 0 || !Number.isInteger(workers) || workers < 1 || workers > 8 || stopLossPercent <= 0 || stopLossPercent >= 100 || simulationStakeUsd <= 0 || exitHoldSeconds < 0 || exitHoldSeconds > 300 || (simulationStakeSol !== null && (!Number.isFinite(simulationStakeSol) || simulationStakeSol <= 0)) || (maxPaperBuys !== null && (!Number.isInteger(maxPaperBuys) || maxPaperBuys < 1))) throw new Error('Invalid research options');
if (!existsSync(values.profileDir)) throw new Error('Research profile tidak ditemukan: ' + values.profileDir);

type Primitive = string | number | boolean | null;
type Trade = { mint: string; wallet: string | null; side: 'buy' | 'sell'; occurredAt: number; observedAt: number; priceUsd: number | null; amount: number | null; amountUsd?: number | null; signature: string | null; raw: Record<string, Primitive> };
type Holder = { mint: string; wallet: string; observedAt: number; raw: Record<string, string | number | boolean | null> };
type DeveloperHolder = { mint: string; wallet: string; observedAt: number; amountPercentage: number | null; amount: number | null; raw: Record<string, Primitive> };
type TrackedHolder = ResearchTrackedHolder;
type HolderApiStatus = { status: number; count: number; observedAt: number; source: 'network_intercept' | 'replayed_xhr' };
const holderApiStatus = new Map<string, HolderApiStatus>();
const developerHolderApiStatus = new Map<string, HolderApiStatus>();
type PaperLane = 'control' | 'r5-band' | 'v3-v8' | 'v3-exit-confirmed';
const PAPER_LANES = Object.freeze({
  control: { id: 'control' as const, label: momentumAggressive ? 'momentum-aggressive' : standaloneMomentumV3 ? 'momentum-v3-control' : 'momentum-v2-control' },
  r5Band: { id: 'r5-band' as const, label: 'momentum-v2-r5-band' },
  v3: { id: 'v3-v8' as const, label: 'momentum-v3-v8' },
  v3ExitConfirmed: { id: 'v3-exit-confirmed' as const, label: 'momentum-v3-exit-confirmed' },
});
const v3PaperLane: PaperLane = momentumComparison ? PAPER_LANES.v3.id : PAPER_LANES.control.id;
// GMGN stores the New Pair controls as a map keyed by its internal trend route.
// Keep the user's selected launchpad set, but require the UI's minimum MC field
// to be 5 (GMGN displays this as $5K).  This is only a feed pre-filter: all
// later paper-entry checks still use live socket/detail evidence.
const GMGN_NEW_PAIR_SOL_FILTER = Object.freeze({
  __v: '20260922',
  '0bks': '1', '0pm': '1', '0bags_v2': '1', '0stonkfun': '1', '0ks': '1', '0ory': '1', '0bags': '1', 'lb': '1',
  '0stx': '1', '0tren_ch': '1', '0pf': '1', '0pfa': '1', '0pma': '1', '0vi': '1', '0swarms': '1', '0meo': '1',
  '0li': '1', '0bk': '1', '0zr': '1', '0sg': '1', '0an': '1', '0msa': '1', '0wdt': '1', '0heaven': '1',
  '0sugar': '1', '0tm': '1', '0bel': '1', '0tsfun': '1', '0tfun': '1', '0js': '1', '0Ms': '1', 'bp': '1',
  '0xtc': '1', 'ry': '1', '0mvc': '1', '0pla': '1', '0pra': '1', '0plpa': '1', '0po': '1',
  '9mim': '20', '9im': '1',
});
async function installGmgnNewPairFilter(browserContext: BrowserContext): Promise<void> {
  await browserContext.addInitScript(filter => {
    if (location.hostname !== 'gmgn.ai') return;
    const storageKey = 'filter_query_map';
    let map: Record<string, Record<string, string>> = {};
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) map = parsed as Record<string, Record<string, string>>;
    } catch { /* replace an invalid saved value with a valid map */ }
    map['/trend2_sol'] = { ...(map['/trend2_sol'] ?? {}), ...filter };
    localStorage.setItem(storageKey, JSON.stringify(map));
  }, GMGN_NEW_PAIR_SOL_FILTER);
}
type SimulatedEvent = { type: 'SIMULATED_BUY' | 'SIMULATED_SELL' | 'SIMULATION_HOLD'; paperLane?: PaperLane; pnlUsd?: number; reason?: string };

type MomentumV3EntryDecision = {
  allowed: boolean;
  passedValidations: number;
  totalValidations: number;
  blockingReasons: string[];
  hardRejections: string[];
  version: typeof MOMENTUM_V3_RULES.version;
};

/**
 * V3 intentionally permits up to four soft validation misses, but never
 * enters with stale/falling price evidence, a red live candle, sell-dominant
 * 20-second flow, single-buyer dominance, or a holder-distribution reject.
 * The count uses the same five base gates and seven momentum gates shown in
 * the detail monitoring timeline, so replay and live paper runs agree.
 */
function assessMomentumV3Entry(input: {
  momentumReasons: string[];
  candleAllowed: boolean;
  candleReason: string | null;
  blindProtectionAllowed: boolean;
  blindProtectionReason: string;
  holderDistributionAllowed: boolean;
  holderDistributionReason: string;
  entryStable: boolean;
  entryReason: string;
  flowAllowed: boolean;
  candleEntryFlowReason: string | null;
  flowSellUsdDominant: boolean;
}): MomentumV3EntryDecision {
  const blockingReasons = [
    ...input.momentumReasons,
    ...(input.candleAllowed ? [] : [`CANDLE:${input.candleReason ?? 'UNKNOWN'}`]),
    ...(input.blindProtectionAllowed ? [] : [`BLIND_PROTECTION:${input.blindProtectionReason}`]),
    ...(input.holderDistributionAllowed ? [] : [`HOLDER_DIST:${input.holderDistributionReason}`]),
    ...(input.entryStable ? [] : [`ENTRY:${input.entryReason}`]),
    ...(input.flowAllowed ? [] : ['FLOW:INSUFFICIENT_BUY_PRESSURE']),
  ];
  const hardRejections = [
    ...(input.momentumReasons.includes('MOMENTUM_NOT_RISING') ? ['MOMENTUM_NOT_RISING'] : []),
    ...(input.momentumReasons.includes('MOMENTUM_INSUFFICIENT_FRESH_HISTORY') ? ['MOMENTUM_INSUFFICIENT_FRESH_HISTORY'] : []),
    ...(input.momentumReasons.includes('MOMENTUM_SINGLE_BUYER_DOMINANCE') ? ['MOMENTUM_SINGLE_BUYER_DOMINANCE'] : []),
    ...(!input.entryStable ? ['ENTRY_UNSTABLE'] : []),
    ...(input.candleEntryFlowReason === 'CURRENT_CANDLE_DROP' ? ['CURRENT_CANDLE_DROP'] : []),
    ...(input.flowSellUsdDominant ? ['FLOW_SELL_USD_DOMINANT'] : []),
    ...(!input.holderDistributionAllowed ? ['HOLDER_DISTRIBUTION_RISK'] : []),
  ];
  const passedValidations = MOMENTUM_V3_RULES.totalValidations - blockingReasons.length;
  return {
    allowed: passedValidations >= MOMENTUM_V3_RULES.minimumPassedValidations && hardRejections.length === 0,
    passedValidations,
    totalValidations: MOMENTUM_V3_RULES.totalValidations,
    blockingReasons,
    hardRejections,
    version: MOMENTUM_V3_RULES.version,
  };
}
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const output = values.output || join('research', runId);
mkdirSync(output, { recursive: true });
const holderStore = new ResearchHolderStore(join(output, 'research.sqlite'));
let reportRefreshTimer: NodeJS.Timeout | undefined;
let reportRefreshRunning = false;
let reportRefreshQueued = false;
const reportRelevantEventTypes = new Set([
  'DETAIL_STARTED',
  'OBSERVATION_ABORTED_DUMP',
  'SIMULATION_BUY_BLOCKED',
  'BUY_PREPARED',
  'BUY_PREPARATION_ERROR',
  'BUY_BUTTON_CLICKED',
  'BUY_CLICK_ERROR',
  'SELL_PREPARED',
  'SELL_PREPARATION_ERROR',
  'SELL_BUTTON_CLICKED',
  'SELL_CLICK_ERROR',
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
  if (file === 'quote-simulated-orders.jsonl') scheduleReportRefresh();
  if (file === 'events.jsonl' && value && typeof value === 'object'
    && reportRelevantEventTypes.has((value as { type?: unknown }).type as string)) scheduleReportRefresh();
};
const simulatedEvents: SimulatedEvent[] = [];
const writeSimulation = (event: SimulatedEvent & Record<string, unknown>) => {
  const normalized = event.paperLane ? event : { ...event, paperLane: PAPER_LANES.control.id };
  simulatedEvents.push(normalized); write('simulated-trades.jsonl', normalized); scheduleReportRefresh();
};
const candidates = new Map<string, Candidate>(), trades = new Map<string, Trade[]>(), holders = new Map<string, Map<string, Holder>>();
const developerHolders = new Map<string, Map<string, DeveloperHolder>>();
const holderHistory = new Map<string, Map<string, Holder[]>>();
const totalHolderSamples = new Map<string, HolderSample[]>();
const momentumTape = new Map<string, TapeTrade[]>();
const pendingPaperOrders = new Set<Promise<void>>();
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
function schedulePaperOrder(signal: PaperSignal): void {
  const task = (async () => {
    await delay(Math.max(0, signal.plannedOrderAt - Date.now()));
    const simulatedOrderAt = Date.now();
    const latestPrice = (momentumTape.get(signal.mint) ?? [])
      .filter(tick => tick.priceUsd !== null && tick.priceUsd > 0 && tick.observedAt <= simulatedOrderAt)
      .sort((a, b) => b.observedAt - a.observedAt)[0];
    write('paper-orders.jsonl', paperOrderEvent(signal, simulatedOrderAt,
      latestPrice?.priceUsd === null || latestPrice === undefined ? null
        : { observedAt: latestPrice.observedAt, priceUsd: latestPrice.priceUsd }));
    scheduleReportRefresh();
  })();
  pendingPaperOrders.add(task);
  void task.then(() => pendingPaperOrders.delete(task), error => {
    pendingPaperOrders.delete(task);
    console.error('[paper-order-error]', signal.signalId, error);
  });
}
/** Produces a live-order request template without calling GMGN or a wallet. */
function scheduleSimulatedOrder(signal: PaperSignal, stakeUsd: number): void {
  if (!values.simulateOrder || signal.paperLane !== PAPER_LANES.control.id) return;
  const task = (async () => {
    await delay(Math.max(0, signal.plannedOrderAt - Date.now()));
    const solUsd = solSpotCache?.usd ?? 150;
    const estimatedBuyLamports = signal.side === 'BUY' && solUsd > 0
      ? Math.floor(stakeUsd / solUsd * 1_000_000_000).toString()
      : null;
    const tokenIn = signal.side === 'BUY' ? WSOL_MINT : signal.mint;
    const tokenOut = signal.side === 'BUY' ? signal.mint : WSOL_MINT;
    write('simulated-order-intents.jsonl', {
      type: 'SIMULATED_ORDER_INTENT', execution: 'DRY_RUN_NO_ROUTE_NO_SIGNATURE_NO_SUBMIT',
      signalId: signal.signalId, positionId: signal.positionId, side: signal.side, mint: signal.mint,
      reason: signal.reason, decisionAt: signal.decisionAt, simulatedAt: Date.now(), priceUsd: signal.priceUsd,
      routeRequest: {
        method: 'GET', endpoint: '/txproxy/v1/get_swap_route', tokenIn, tokenOut,
        inputAmountBaseUnits: signal.side === 'BUY' ? estimatedBuyLamports : null,
        inputAmountSource: signal.side === 'BUY' ? (solSpotCache ? 'stakeUsd / cached SOL-USD price' : 'stakeUsd / $150 simulation fallback') : 'full token balance must be read at execution time',
        slippagePercent: DEFAULT_EXECUTION_SETTINGS.slippagePercent, feeSol: DEFAULT_EXECUTION_SETTINGS.tipFeeSol + DEFAULT_EXECUTION_SETTINGS.priorityFeeSol,
      },
      submitRequest: {
        method: 'POST', endpoint: '/mrtapi/v2/swap_batch_order', chain: 'sol', tokenIn, tokenOut,
        swapMode: 'ExactIn', inputAmountBaseUnits: signal.side === 'BUY' ? estimatedBuyLamports : null,
        requiresFreshRoute: true, requiresWalletAddress: true, requiresLiveTxBuildInfo: true,
      },
      note: 'Dry-run intent only. No GMGN request, wallet signature, or on-chain transaction was sent.',
    });
  })();
  pendingPaperOrders.add(task);
  void task.then(() => pendingPaperOrders.delete(task), error => {
    pendingPaperOrders.delete(task);
    console.error('[simulated-order-intent-error]', signal.signalId, error);
  });
}
let liveBrowserAuthorization: string | null = null;
let liveBrowserWalletAddress: string | null = null;
let orderOutcomeCaptureUntil = 0;
/** Quote-only mode needs a public wallet address for GMGN's route endpoint,
 * never an authorization token and never an order submission. */
function latestQuoteWalletAddress(): string | null {
  if (liveBrowserWalletAddress) return liveBrowserWalletAddress;
  try {
    const root = join(process.cwd(), 'research');
    for (const entry of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const payloadFile = join(root, entry.name, 'order-api-payloads.jsonl');
      if (!existsSync(payloadFile)) continue;
      for (const line of readFileSync(payloadFile, 'utf8').trim().split(/\r?\n/).reverse()) {
        try {
          const row = JSON.parse(line) as { type?: string; bodyText?: string };
          if (row.type !== 'ORDER_REQUEST_PAYLOAD' || !row.bodyText) continue;
          const address = (JSON.parse(row.bodyText) as { from_address?: unknown }).from_address;
          if (typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return address;
        } catch { /* Ignore an incomplete historical record. */ }
      }
    }
  } catch { /* A first-time profile may not have a prior order capture. */ }
  return null;
}
function latestCapturedOrderSession(): { fromAddress: string; authorization: string } | null {
  if (liveBrowserWalletAddress && (liveBrowserAuthorization || browserAutoTrade)) {
    return { fromAddress: liveBrowserWalletAddress, authorization: liveBrowserAuthorization ?? '' };
  }
  try {
    const root = join(process.cwd(), 'research');
    for (const entry of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
      const payloadFile = join(root, entry.name, 'order-api-payloads.jsonl');
      if (!existsSync(payloadFile)) continue;
      const lines = readFileSync(payloadFile, 'utf8').trim().split(/\r?\n/).reverse();
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { type?: string; url?: string; bodyText?: string; headers?: Record<string, unknown> };
          if (row.type !== 'ORDER_REQUEST_PAYLOAD' || !row.bodyText || !row.url?.includes('/mrtapi/v2/swap_batch_order')) continue;
          const body = JSON.parse(row.bodyText) as { from_address?: unknown };
          const authorization = row.headers?.authorization;
          if (typeof body.from_address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.from_address)
            && (liveBrowserAuthorization || (typeof authorization === 'string' && authorization.length > 0))) {
            return { fromAddress: body.from_address, authorization: liveBrowserAuthorization ?? authorization as string };
          }
        } catch { /* Ignore incomplete JSONL rows. */ }
      }
    }
  } catch { /* A first-time browser session has no captured order yet. */ }
  return null;
}
async function fetchWalletStat(page: Page, walletAddress: string, mint: string): Promise<Record<string, unknown> | null> {
  return page.evaluate(async ({ walletAddress, mint }) => {
    try {
      const res = await fetch(`/defi/quotation/v1/smartmoney/sol/walletstat/${walletAddress}?token_address=${encodeURIComponent(mint)}`, { credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.json().catch(() => null);
      return (body?.data as Record<string, unknown>) ?? null;
    } catch {
      return null;
    }
  }, { walletAddress, mint }).catch(() => null);
}
function parseBalanceToBaseUnits(balanceStr: string, decimals = 6): string {
  if (!balanceStr || typeof balanceStr !== 'string') return '0';
  const clean = balanceStr.trim().replace(/,/g, '');
  if (!clean || clean === '0' || Number(clean) === 0) return '0';
  const parts = clean.split('.');
  const whole = parts[0] || '0';
  const rawFrac = parts[1] || '';
  const frac = rawFrac.slice(0, decimals).padEnd(decimals, '0');
  const combined = (whole + frac).replace(/^0+/, '') || '0';
  return combined;
}
const liveBrowserPositions = new Map<string, { inputAmount: string; tokenDecimals: number; confirmedAt: number; entryPriceUsd: number; isRealBalanceConfirmed: boolean; walletBalanceDecimal?: string }>();
const liveTokenBalances = new Map<string, { balanceBaseUnits: string; balanceDecimal: string; decimals: number; updatedAt: number }>();
function recordWalletStatSnapshot(data: Record<string, unknown>, stage: 'PRE_BUY' | 'POST_BUY' | 'PRE_SELL' | 'RETRY_SELL' | 'POST_SELL' | 'PASSIVE_CAPTURE' = 'POST_BUY') {
  if (typeof data.token_address === 'string' && typeof data.balance === 'string' && data.balance !== '' && data.balance !== '0') {
    const decimals = typeof data.decimals === 'number' ? data.decimals : 6;
    const baseUnits = parseBalanceToBaseUnits(data.balance, decimals);
    if (baseUnits !== '0') {
      liveTokenBalances.set(data.token_address, { balanceBaseUnits: baseUnits, balanceDecimal: data.balance, decimals, updatedAt: Date.now() });
      const pos = liveBrowserPositions.get(data.token_address);
      if (pos) {
        pos.inputAmount = baseUnits;
        pos.tokenDecimals = decimals;
        pos.walletBalanceDecimal = data.balance;
        pos.isRealBalanceConfirmed = true;
        if (typeof data.history_avg_cost === 'number' && data.history_avg_cost > 0) {
          pos.entryPriceUsd = data.history_avg_cost;
        }
      }
    }
  }
  const buyCost = Number(data.history_bought_cost ?? 0), soldIncome = Number(data.history_sold_income ?? 0);
  const grossPnlUsd = Number.isFinite(buyCost) && Number.isFinite(soldIncome) ? soldIncome - buyCost : null;
  write('live-trade-ledger.jsonl', {
    type: 'GMGN_WALLETSTAT_SNAPSHOT', stage, observedAt: Date.now(), token: data.token_address ?? null, symbol: data.symbol ?? null,
    balance: data.balance ?? null, historyBoughtCostUsd: data.history_bought_cost ?? null, historyBoughtAmount: data.history_bought_amount ?? null,
    historyAvgCost: data.history_avg_cost ?? null, historySoldIncomeUsd: data.history_sold_income ?? null, avgSold: data.avg_sold ?? null,
    grossPnlUsd, grossPnlPercent: buyCost > 0 && grossPnlUsd !== null ? grossPnlUsd / buyCost * 100 : null,
    reportedRealizedProfitUsd: data.realized_profit ?? null, reportedRealizedPnlPercent: data.realized_profit_pnl ?? null,
    reportedGasUsd: data.gas_usd ?? null, priceUsd: data.price ?? null, trades: data.trades ?? null,
    note: 'Wallet-level response. Gross P/L is this response history_sold_income minus history_bought_cost; GMGN realized fields may include older activity for the same token.',
  });
}
function isExpiredBrowserAuthorization(result: unknown): boolean {
  const row = result as { status?: unknown; code?: unknown; message?: unknown } | null;
  return (row?.status === 401 || row?.status === 403) && (row?.code === 40010100 || String(row?.message ?? '').toLowerCase().includes('token expired'));
}
async function refreshBrowserAuthorization(page: Page, previousAuthorization: string): Promise<boolean> {
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    for (let attempt = 0; attempt < 10; attempt++) {
      if (liveBrowserAuthorization && liveBrowserAuthorization !== previousAuthorization) return true;
      await delay(500);
    }
  } catch { /* The next signal can still use a later browser-session request. */ }
  return Boolean(liveBrowserAuthorization && liveBrowserAuthorization !== previousAuthorization);
}
async function showBrowserOrderPrompt(page: Page, input: { side: 'BUY' | 'SELL'; mint: string; symbol: string; amountLine: string; expectedOut?: string | null }): Promise<boolean> {
  // This is a page modal rather than window.confirm(): Chromium returns false
  // immediately for confirmation dialogs invoked through automation.
  await page.bringToFront();
  // page.evaluate(expression, arg) does not call a string expression as a
  // function. Embed the small, non-sensitive signal object and invoke the
  // expression explicitly so the promise remains pending for the operator.
  const promptValue = JSON.stringify(input).replace(/</g, '\\u003c');
  return page.evaluate(`(() => {
    const value = ${promptValue};
    return new Promise((resolve) => {
    const existing = document.getElementById('__momentum-v2-order-prompt');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = '__momentum-v2-order-prompt';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(2,8,18,.82);font:16px system-ui;color:#f8fbff';
    const card = document.createElement('section');
    card.style.cssText = 'width:min(520px,calc(100vw - 36px));padding:26px;border:2px solid #58b4ff;border-radius:16px;background:#0d1b2d;box-shadow:0 20px 70px #000';
    const heading = document.createElement('h2');
    heading.style.cssText = 'margin:0 0 16px;font-size:23px;color:#7fd0ff';
    heading.textContent = 'Momentum V2: ' + value.side + ' siap';
    const details = document.createElement('pre');
    details.style.cssText = 'margin:0 0 18px;white-space:pre-wrap;font:14px ui-monospace,Consolas,monospace;line-height:1.55;color:#fff';
    details.textContent = [
      value.symbol,
      value.mint,
      '',
      value.amountLine,
      value.expectedOut ? 'Quote output: ' + value.expectedOut : '',
      '',
      'Route akan dibuat ulang tepat sebelum submit.'
    ].filter(Boolean).join('\\n');
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:12px';
    const submit = document.createElement('button');
    submit.textContent = 'SUBMIT ' + value.side;
    submit.style.cssText = 'flex:1;background:#17a36b;color:#fff;border:0;border-radius:9px;padding:13px;font-weight:800;font-size:15px;cursor:pointer';
    const skip = document.createElement('button');
    skip.textContent = 'LEWATI';
    skip.style.cssText = 'background:#34475c;color:#fff;border:0;border-radius:9px;padding:13px 18px;font-weight:700;font-size:15px;cursor:pointer';
    const finish = (approved, event) => {
      if (!event.isTrusted) return;
      root.remove();
      resolve(approved);
    };
    submit.addEventListener('click', event => finish(true, event));
    skip.addEventListener('click', event => finish(false, event));
    actions.append(submit, skip);
    card.append(heading, details, actions);
    root.append(card);
    document.body.append(root);
    document.title = 'BUY confirmation | ' + document.title;
    console.warn('[Momentum V2] Buy confirmation is waiting on this tab.');
    });
  })()`);
}
async function browserRoute(page: Page, input: { mint: string; fromAddress: string; inputLamports: string }) {
  return page.evaluate(async value => {
    const params = new URLSearchParams({ web_from_source: 'token_poll', token_in_chain: 'sol', token_out_chain: 'sol', from_address: value.fromAddress,
      token_in_address: 'So11111111111111111111111111111111111111112', token_out_address: value.mint, in_amount: value.inputLamports,
      slippage: '15', is_anti_mev: 'false', fee: '0.0002', tip_fee: '0.0001', priority_fee: '0.0001', legacy: 'true' });
    const response = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }, input);
}
function quoteSummary(routeData: any) {
  const quote = routeData?.quote ?? {};
  return {
    amountInUsd: routeData?.amount_in_usd ?? null, amountOutUsd: routeData?.amount_out_usd ?? null,
    inAmount: quote.inAmount ?? null, outAmount: quote.outAmount ?? null,
    inDecimals: quote.inDecimals ?? null, outDecimals: quote.outDecimals ?? null,
    priceImpactPct: quote.priceImpactPct ?? null, exchange: routeData?.exchange ?? null,
  };
}
type RouteComparisonPosition = { inputAmount: string; tokenDecimals: number; routeTokenAmount: number; quoteAt: number };
const routeComparisonPositions = new Map<string, RouteComparisonPosition>();
const routeComparisonBuyTasks = new Map<string, Promise<void>>();

async function browserSellRoute(page: Page, input: { mint: string; fromAddress: string; inputAmount: string }) {
  if (page.isClosed()) return { status: 499, body: null };
  return page.evaluate(async value => {
    const params = new URLSearchParams({ web_from_source: 'token_poll', token_in_chain: 'sol', token_out_chain: 'sol', from_address: value.fromAddress,
      token_in_address: value.mint, token_out_address: 'So11111111111111111111111111111111111111112', in_amount: value.inputAmount,
      slippage: '15', is_anti_mev: 'false', fee: '0.0002', tip_fee: '0.0001', priority_fee: '0.0001', legacy: 'true' });
    const response = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, input).catch(() => ({ status: 500, body: null }));
}

interface PrewarmedSellRoute {
  mint: string;
  positionId: string;
  inputAmount: string;
  tokenDecimals: number;
  routeTokenAmount: number;
  quoteAt: number;
  latencyMs: number;
  data: any;
  route: any;
  routeOutputUsd: number;
  routeImpliedTokenPriceUsd: number;
  netPnlUsd: number;
  netPnlPercent: number;
}

const closedRoutePositions = new Set<string>();
const activeSellRoutePollers = new Map<string, { abort: () => void; mint: string }>();
const prewarmedSellRoutes = new Map<string, PrewarmedSellRoute>();
const prewarmedSellRoutesByMint = new Map<string, PrewarmedSellRoute>();

function stopPeriodicSellRoutePolling(positionId: string): void {
  const poller = activeSellRoutePollers.get(positionId);
  if (poller) {
    poller.abort();
    activeSellRoutePollers.delete(positionId);
  }
}

function stopAllPeriodicSellRoutePollingForMint(mint: string): void {
  for (const [posId, poller] of activeSellRoutePollers.entries()) {
    if (poller.mint === mint) {
      poller.abort();
      activeSellRoutePollers.delete(posId);
      prewarmedSellRoutes.delete(posId);
    }
  }
  prewarmedSellRoutesByMint.delete(mint);
}

function startPeriodicSellRoutePolling(
  page: Page,
  positionId: string,
  mint: string,
  inputAmount: string,
  tokenDecimals: number,
  routeTokenAmount: number,
  stakeUsd: number,
  walletAddress: string
): void {
  if (closedRoutePositions.has(positionId)) return;
  if (activeSellRoutePollers.has(positionId)) return;

  let stopped = false;
  activeSellRoutePollers.set(positionId, {
    abort: () => { stopped = true; },
    mint,
  });

  const pollIntervalMs = 500;

  void (async () => {
    while (!stopped && !page.isClosed()) {
      const pollStartedAt = Date.now();
      try {
        const route = await browserSellRoute(page, { mint, fromAddress: walletAddress, inputAmount });
        if (stopped || page.isClosed()) break;
        const observedAt = Date.now();
        const latencyMs = observedAt - pollStartedAt;
        const data = route.body?.data;
        const quote = data?.quote;
        if (route.status === 200 && route.body?.code === 0 && quote) {
          const routeOutputUsd = Number(data.amount_out_usd);
          const routeImpliedTokenPriceUsd = Number.isFinite(routeOutputUsd) && routeOutputUsd > 0 && routeTokenAmount > 0
            ? routeOutputUsd / routeTokenAmount
            : 0;
          const netPnlUsd = Number.isFinite(routeOutputUsd) ? routeOutputUsd - stakeUsd : 0;
          const netPnlPercent = Number.isFinite(routeOutputUsd) && stakeUsd > 0
            ? ((routeOutputUsd / stakeUsd) - 1) * 100
            : 0;

          const prewarmed: PrewarmedSellRoute = {
            mint,
            positionId,
            inputAmount,
            tokenDecimals,
            routeTokenAmount,
            quoteAt: observedAt,
            latencyMs,
            data,
            route,
            routeOutputUsd,
            routeImpliedTokenPriceUsd,
            netPnlUsd,
            netPnlPercent,
          };
          prewarmedSellRoutes.set(positionId, prewarmed);
          prewarmedSellRoutesByMint.set(mint, prewarmed);

          write('quote-simulated-orders.jsonl', {
            type: 'PERIODIC_SELL_ROUTE_QUOTE',
            positionId,
            mint,
            observedAt,
            latencyMs,
            routeOutputUsd,
            netPnlUsd,
            netPnlPercent,
            inputAmountBaseUnits: inputAmount,
            tokenDecimals,
            quote: quoteSummary(data),
            execution: 'ROUTE_PREWARM_POLL',
          });
        }
      } catch {
        if (stopped || page.isClosed()) break;
      }

      const elapsed = Date.now() - pollStartedAt;
      const sleepMs = Math.max(100, pollIntervalMs - elapsed);
      await delay(sleepMs);
    }
  })();
}

/**
 * Passive research quote: paper BUY is already recorded and is never delayed
 * or rejected by this function. It only compares GMGN's executable route to
 * the socket price visible at the buy signal.
 */
function scheduleBuyRouteComparison(page: Page, signal: PaperSignal, stakeUsd: number, detailSolSpot: { usd: number; observedAt: number } | null): void {
  if (!quoteSimulationEnabled) return;
  const task = (async () => {
    const quoteStartedAt = Date.now();
    if (!detailSolSpot) {
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_BUY_COMPARISON_SKIPPED', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, observedAt: quoteStartedAt, reason: 'NO_DETAIL_SOL_SPOT', execution: 'ROUTE_ONLY_NO_SUBMIT' });
      return;
    }
    const walletAddress = latestQuoteWalletAddress();
    if (!walletAddress) {
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_BUY_COMPARISON_SKIPPED', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, observedAt: quoteStartedAt, reason: 'NO_QUOTE_WALLET_CONTEXT', execution: 'ROUTE_ONLY_NO_SUBMIT' });
      return;
    }
    const inputAmount = Math.floor(stakeUsd / detailSolSpot.usd * 1_000_000_000).toString();
    try {
      const routeRequestedAt = Date.now();
      const route = await browserRoute(page, { mint: signal.mint, fromAddress: walletAddress, inputLamports: inputAmount });
      const observedAt = Date.now(), data = route.body?.data, quote = data?.quote;
      if (route.status !== 200 || route.body?.code !== 0 || !quote || typeof quote.outAmount !== 'string' || !Number.isInteger(quote.outDecimals)) {
        write('quote-simulated-orders.jsonl', { type: 'QUOTE_BUY_COMPARISON_UNPRICED', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, decisionAt: signal.decisionAt, quoteStartedAt, routeRequestedAt, observedAt, latencyMs: observedAt - routeRequestedAt, status: route.status, code: route.body?.code ?? null, message: route.body?.msg ?? null, execution: 'ROUTE_ONLY_NO_SUBMIT' });
        return;
      }
      const amountInUsd = Number(data.amount_in_usd);
      const routeTokenAmount = Number(quote.outAmount) / 10 ** quote.outDecimals;
      const socketExpectedTokenAmount = Number.isFinite(amountInUsd) && amountInUsd > 0 && signal.priceUsd > 0 ? amountInUsd / signal.priceUsd : null;
      const routeImpliedTokenPriceUsd = Number.isFinite(amountInUsd) && amountInUsd > 0 && routeTokenAmount > 0 ? amountInUsd / routeTokenAmount : null;
      const routeVsSocketTokenPercent = socketExpectedTokenAmount && routeTokenAmount > 0 ? (routeTokenAmount / socketExpectedTokenAmount - 1) * 100 : null;
      const routeVsSocketPricePercent = routeImpliedTokenPriceUsd && signal.priceUsd > 0 ? (routeImpliedTokenPriceUsd / signal.priceUsd - 1) * 100 : null;
      routeComparisonPositions.set(signal.positionId, { inputAmount: quote.outAmount, tokenDecimals: quote.outDecimals, routeTokenAmount, quoteAt: observedAt });
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_BUY_COMPARISON', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, decisionAt: signal.decisionAt, signalPriceUsd: signal.priceUsd,
        quoteStartedAt, routeRequestedAt, observedAt, latencyMs: observedAt - routeRequestedAt, decisionToRouteMs: routeRequestedAt - signal.decisionAt,
        detailSolSpotUsd: detailSolSpot.usd, detailSolSpotAt: detailSolSpot.observedAt, detailSolSpotAgeMs: routeRequestedAt - detailSolSpot.observedAt,
        inputAmountBaseUnits: inputAmount, socketExpectedTokenAmount, routeTokenAmount, routeImpliedTokenPriceUsd, routeVsSocketTokenPercent, routeVsSocketPricePercent,
        quote: quoteSummary(data), execution: 'ROUTE_ONLY_NO_SUBMIT' });
      startPeriodicSellRoutePolling(page, signal.positionId, signal.mint, quote.outAmount, quote.outDecimals, routeTokenAmount, stakeUsd, walletAddress);
    } catch (error) {
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_BUY_COMPARISON_ERROR', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown', execution: 'ROUTE_ONLY_NO_SUBMIT' });
    }
  })();
  routeComparisonBuyTasks.set(signal.positionId, task);
  pendingPaperOrders.add(task);
  void task.then(() => pendingPaperOrders.delete(task), () => pendingPaperOrders.delete(task));
}
function writeLiveRouteLedger(side: 'BUY' | 'SELL', routeData: any, input: { mint: string; inputAmount: string; tokenPriceUsd: number; solPriceUsd: number }) {
  const quote = routeData?.quote ?? {};
  const outputPriceUsd = side === 'BUY' ? input.tokenPriceUsd : input.solPriceUsd;
  const outputDecimals = Number(quote.outDecimals ?? 0);
  const platformFee = Number(quote.platformFee ?? 0);
  const platformFeeUsd = outputDecimals >= 0 && Number.isFinite(platformFee) && Number.isFinite(outputPriceUsd)
    ? platformFee / 10 ** outputDecimals * outputPriceUsd : null;
  const routeFees = Array.isArray(quote.routePlan) ? quote.routePlan.map((item: any) => ({
    label: item?.swapInfo?.label ?? null, feeAmountBaseUnits: item?.swapInfo?.feeAmount ?? null, feeMint: item?.swapInfo?.feeMint ?? null,
  })) : [];
  write('live-trade-ledger.jsonl', {
    type: 'LIVE_ROUTE_QUOTE', side, mint: input.mint, observedAt: Date.now(), inputAmountBaseUnits: input.inputAmount,
    amountInUsd: routeData?.amount_in_usd ?? null, amountOutUsd: routeData?.amount_out_usd ?? null,
    quote: { inAmount: quote.inAmount ?? null, outAmount: quote.outAmount ?? null, inDecimals: quote.inDecimals ?? null, outDecimals: quote.outDecimals ?? null, otherAmountThreshold: quote.otherAmountThreshold ?? null, priceImpactPct: quote.priceImpactPct ?? null, exchange: routeData?.exchange ?? null },
    fees: { platformFeeBaseUnits: quote.platformFee ?? null, platformFeeUsdEstimate: platformFeeUsd, routeFees, configuredFeeSol: 0.0002, configuredTipFeeSol: 0.0001, configuredPriorityFeeSol: 0.0001, prioritizationFeeLamports: routeData?.raw_tx?.prioritizationFeeLamports ?? null },
    note: 'Route quote before submit. Fee values are estimates/configuration; final network fee must be read from the confirmed Solana transaction.',
  });
}
async function submitBrowserBuy(page: Page, input: { mint: string; fromAddress: string; authorization: string; inputLamports: string; tokenPriceUsd: number; solPriceUsd: number; marketCapUsd: number | null }, skipPrompt = false) {
  const route = await browserRoute(page, input);
  const routeData = route.body?.data;
  if (route.status !== 200 || route.body?.code !== 0 || !routeData?.quote) return { ok: false, stage: 'route', status: route.status, code: route.body?.code ?? null, message: route.body?.msg ?? null };
  if (!skipPrompt) {
    write('events.jsonl', { type: 'BROWSER_BUY_PROMPT_OPENING', mint: input.mint, observedAt: Date.now(), pageUrl: page.url(), stakeUsd: Number(input.inputLamports) / 1_000_000_000 * input.solPriceUsd });
    const approved = await showBrowserOrderPrompt(page, { side: 'BUY', mint: input.mint, symbol: input.mint.slice(0, 8), amountLine: 'Nominal: $' + (Number(input.inputLamports) / 1_000_000_000 * input.solPriceUsd).toFixed(2), expectedOut: routeData.quote.outAmount ?? null });
    if (!approved) return { ok: false, stage: 'operator_declined' };
  }
  const freshRoute = await browserRoute(page, input);
  const fresh = freshRoute.body?.data;
  if (freshRoute.status !== 200 || freshRoute.body?.code !== 0 || !fresh?.quote) return { ok: false, stage: 'route_refresh', status: freshRoute.status, code: freshRoute.body?.code ?? null, message: freshRoute.body?.msg ?? null };
  writeLiveRouteLedger('BUY', fresh, { mint: input.mint, inputAmount: input.inputLamports, tokenPriceUsd: input.tokenPriceUsd, solPriceUsd: input.solPriceUsd });
  return page.evaluate(async ({ value, routeBody }) => {
    const quote = routeBody.data.quote;
    const swapInfo = quote.routePlan?.[0]?.swapInfo ?? {};
    const now = Date.now();
    const payload = {
      is_auto_tip_fee: false, is_auto_priority_fee: false, max_auto_fee: '0.001', token_in_chain: 'sol', token_out_chain: 'sol',
      from_address: value.fromAddress, token_in_address: 'So11111111111111111111111111111111111111112', token_out_address: value.mint,
      is_anti_mev: false, token_in_price: String(value.solPriceUsd), token_out_price: String(value.tokenPriceUsd), chain: 'sol', retry_on_submit_failed: 0,
      simulate_before_submit: false, input_token: 'So11111111111111111111111111111111111111112', output_token: value.mint, source: 'swap_web',
      decimals: quote.outDecimals ?? 6, swap_mode: 'ExactIn', input_amount: value.inputLamports, market_cap: value.marketCapUsd ?? 0,
      priority_gas_price: '0.0001', gas_price: '0.0001', auto_slippage: false, slippage: 15, fee: '0.0002', tip_fee: '0.0001', priority_fee: '0.0001',
      tx_build_info: { ok: true, fallback: false, error: { code: '', message: '', stage: 'browser_prompt_route', exchange: routeBody.data.exchange ?? '', pool: swapInfo.ammKey ?? '' },
        summary: { totalMs: Number(quote.timeTaken ?? 0) * 1000, method: 'browser_prompt_route', entryCount: Array.isArray(quote.routePlan) ? quote.routePlan.length : 0 },
        traceFields: { query: { userId: value.fromAddress, tokenIn: { address: 'So11111111111111111111111111111111111111112', decimals: 9, price: value.solPriceUsd }, tokenOut: { address: value.mint, decimals: quote.outDecimals ?? 6, price: value.tokenPriceUsd }, swapMode: 'ExactIn', slippage: 15, mc: value.marketCapUsd ?? 0, isAntiMev: false, fee: 0.0002, exchange: routeBody.data.exchange ?? '', pool: swapInfo.ammKey ?? '', tipFee: 0.0001, priorityFee: 0.0001, amountIn: value.inputLamports, legacy: true }, serverTimeMs: now }, client_click_at_ms: now, order_type: 'browser_prompt_submit', ws_status: 'Stable', ws_latency_ms: 0, ws_chain_stat_ts: now, ws_route_info_ts: now },
    };
    const response = await fetch('/mrtapi/v2/swap_batch_order', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: value.authorization }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.code === 0, status: response.status, code: body?.code ?? null, message: body?.message ?? body?.msg ?? null, orderId: body?.data?.order_id ?? null, hash: body?.data?.hash ?? null, acquiredAmount: quote.outAmount ?? null, acquiredDecimals: quote.outDecimals ?? null };
  }, { value: input, routeBody: freshRoute.body });
}
/** Passive sell-side counterpart to the buy comparison. It waits for the buy
 * quote so the sell route uses exactly the token amount GMGN quoted at entry. */
function scheduleSellRouteComparison(page: Page, signal: PaperSignal): Promise<void> {
  if (!quoteSimulationEnabled) return Promise.resolve();
  closedRoutePositions.add(signal.positionId);
  stopPeriodicSellRoutePolling(signal.positionId);
  const task = (async () => {
    await routeComparisonBuyTasks.get(signal.positionId);
    const position = routeComparisonPositions.get(signal.positionId);
    const walletAddress = latestQuoteWalletAddress();
    if (!position || !walletAddress) {
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_SELL_COMPARISON_SKIPPED', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, observedAt: Date.now(), reason: position ? 'NO_QUOTE_WALLET_CONTEXT' : 'NO_BUY_ROUTE_QUOTE', execution: 'ROUTE_ONLY_NO_SUBMIT' });
      return;
    }
    try {
      const prewarmed = prewarmedSellRoutes.get(signal.positionId);
      const isPrewarmedFresh = prewarmed && (Date.now() - prewarmed.quoteAt < 1500) && prewarmed.data?.quote;
      let data: any;
      let quote: any;
      let routeRequestedAt: number;
      let observedAt: number;
      let latencyMs: number;
      let isPrewarmedCacheHit = false;

      if (isPrewarmedFresh) {
        data = prewarmed.data;
        quote = data.quote;
        routeRequestedAt = prewarmed.quoteAt;
        observedAt = Date.now();
        latencyMs = 0;
        isPrewarmedCacheHit = true;
      } else {
        routeRequestedAt = Date.now();
        const route = await browserSellRoute(page, { mint: signal.mint, fromAddress: walletAddress, inputAmount: position.inputAmount });
        observedAt = Date.now();
        latencyMs = observedAt - routeRequestedAt;
        data = route.body?.data;
        quote = data?.quote;
        if (route.status !== 200 || route.body?.code !== 0 || !quote) {
          write('quote-simulated-orders.jsonl', { type: 'QUOTE_SELL_COMPARISON_UNPRICED', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, decisionAt: signal.decisionAt, routeRequestedAt, observedAt, latencyMs, status: route.status, code: route.body?.code ?? null, message: route.body?.msg ?? null, execution: 'ROUTE_ONLY_NO_SUBMIT' });
          return;
        }
      }

      const routeOutputUsd = Number(data.amount_out_usd);
      const socketExpectedProceedsUsd = position.routeTokenAmount * signal.priceUsd;
      const routeVsSocketProceedsPercent = Number.isFinite(routeOutputUsd) && routeOutputUsd >= 0 && socketExpectedProceedsUsd > 0 ? (routeOutputUsd / socketExpectedProceedsUsd - 1) * 100 : null;
      const routeImpliedTokenPriceUsd = Number.isFinite(routeOutputUsd) && routeOutputUsd >= 0 && position.routeTokenAmount > 0 ? routeOutputUsd / position.routeTokenAmount : null;
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_SELL_COMPARISON', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, decisionAt: signal.decisionAt, signalPriceUsd: signal.priceUsd,
        routeRequestedAt, observedAt, latencyMs, prewarmedCacheHit: isPrewarmedCacheHit, prewarmedAgeMs: isPrewarmedCacheHit ? observedAt - routeRequestedAt : null, buyQuoteAt: position.quoteAt, inputAmountBaseUnits: position.inputAmount, tokenDecimals: position.tokenDecimals,
        socketExpectedProceedsUsd, routeImpliedTokenPriceUsd, routeVsSocketProceedsPercent, quote: quoteSummary(data), execution: 'ROUTE_ONLY_NO_SUBMIT' });
    } catch (error) {
      write('quote-simulated-orders.jsonl', { type: 'QUOTE_SELL_COMPARISON_ERROR', signalId: signal.signalId, positionId: signal.positionId, mint: signal.mint, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown', execution: 'ROUTE_ONLY_NO_SUBMIT' });
    } finally {
      prewarmedSellRoutes.delete(signal.positionId);
      routeComparisonPositions.delete(signal.positionId);
      routeComparisonBuyTasks.delete(signal.positionId);
      closedRoutePositions.delete(signal.positionId);
    }
  })();
  pendingPaperOrders.add(task);
  void task.then(() => pendingPaperOrders.delete(task), () => pendingPaperOrders.delete(task));
  return task;
}
async function submitBrowserSell(page: Page, input: { mint: string; fromAddress: string; authorization: string; inputAmount: string; tokenDecimals: number; tokenPriceUsd: number; solPriceUsd: number; marketCapUsd: number | null }, skipPrompt = false) {
  const prewarmed = prewarmedSellRoutesByMint.get(input.mint);
  const isPrewarmedFresh = prewarmed && (Date.now() - prewarmed.quoteAt < 1500) && prewarmed.route?.body?.code === 0 && prewarmed.route?.body?.data?.quote;
  const route = isPrewarmedFresh ? prewarmed.route : await browserSellRoute(page, input);
  const routeData = route.body?.data;
  if (route.status !== 200 || route.body?.code !== 0 || !routeData?.quote) return { ok: false, stage: 'route', status: route.status, code: route.body?.code ?? null, message: route.body?.msg ?? null };
  if (!skipPrompt) {
    write('events.jsonl', { type: 'BROWSER_SELL_PROMPT_OPENING', mint: input.mint, observedAt: Date.now(), pageUrl: page.url(), inputAmount: input.inputAmount });
    const approved = await showBrowserOrderPrompt(page, { side: 'SELL', mint: input.mint, symbol: input.mint.slice(0, 8), amountLine: 'Jual 100%: ' + input.inputAmount + ' base units', expectedOut: routeData.quote.outAmount ?? null });
    if (!approved) return { ok: false, stage: 'operator_declined' };
  }
  const freshRoute = (!skipPrompt || !isPrewarmedFresh) ? await browserSellRoute(page, input) : route;
  const fresh = freshRoute.body?.data;
  if (freshRoute.status !== 200 || freshRoute.body?.code !== 0 || !fresh?.quote) return { ok: false, stage: 'route_refresh', status: freshRoute.status, code: freshRoute.body?.code ?? null, message: freshRoute.body?.msg ?? null };
  writeLiveRouteLedger('SELL', fresh, { mint: input.mint, inputAmount: input.inputAmount, tokenPriceUsd: input.tokenPriceUsd, solPriceUsd: input.solPriceUsd });
  return page.evaluate(async ({ value, routeBody }) => {
    const quote = routeBody.data.quote, swapInfo = quote.routePlan?.[0]?.swapInfo ?? {}, now = Date.now();
    const payload = { is_auto_tip_fee: false, is_auto_priority_fee: false, max_auto_fee: '0.001', token_in_chain: 'sol', token_out_chain: 'sol', from_address: value.fromAddress,
      token_in_address: value.mint, token_out_address: 'So11111111111111111111111111111111111111112', is_anti_mev: false, token_in_price: String(value.tokenPriceUsd), token_out_price: String(value.solPriceUsd), chain: 'sol', retry_on_submit_failed: 0,
      simulate_before_submit: false, input_token: value.mint, output_token: 'So11111111111111111111111111111111111111112', source: 'swap_web', decimals: value.tokenDecimals, swap_mode: 'ExactIn', input_amount: value.inputAmount, market_cap: value.marketCapUsd ?? 0,
      priority_gas_price: '0.0001', gas_price: '0.0001', auto_slippage: false, slippage: 15, fee: '0.0002', tip_fee: '0.0001', priority_fee: '0.0001',
      tx_build_info: { ok: true, fallback: false, error: { code: '', message: '', stage: 'browser_prompt_sell_route', exchange: routeBody.data.exchange ?? '', pool: swapInfo.ammKey ?? '' }, summary: { totalMs: Number(quote.timeTaken ?? 0) * 1000, method: 'browser_prompt_sell_route', entryCount: Array.isArray(quote.routePlan) ? quote.routePlan.length : 0 }, traceFields: { query: { userId: value.fromAddress, tokenIn: { address: value.mint, decimals: value.tokenDecimals, price: value.tokenPriceUsd }, tokenOut: { address: 'So11111111111111111111111111111111111111112', decimals: 9, price: value.solPriceUsd }, swapMode: 'ExactIn', slippage: 15, mc: value.marketCapUsd ?? 0, isAntiMev: false, fee: 0.0002, exchange: routeBody.data.exchange ?? '', pool: swapInfo.ammKey ?? '', tipFee: 0.0001, priorityFee: 0.0001, amountIn: value.inputAmount, legacy: true }, serverTimeMs: now }, client_click_at_ms: now, order_type: 'browser_prompt_sell_submit', ws_status: 'Stable', ws_latency_ms: 0, ws_chain_stat_ts: now, ws_route_info_ts: now },
    };
    const response = await fetch('/mrtapi/v2/swap_batch_order', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: value.authorization }, body: JSON.stringify(payload) });
    const body = await response.json().catch(() => null);
    return { ok: response.ok && body?.code === 0, status: response.status, code: body?.code ?? null, message: body?.message ?? body?.msg ?? null, orderId: body?.data?.order_id ?? null, hash: body?.data?.hash ?? null };
  }, { value: input, routeBody: freshRoute.body });
}
async function promptAndSubmitBrowserBuy(page: Page, signal: PaperSignal, stakeUsd: number, tokenPriceUsd: number, marketCapUsd: number | null): Promise<void> {
  if (!browserTradingEnabled || signal.paperLane !== PAPER_LANES.control.id) return;
  const orderSession = latestCapturedOrderSession();
  if (!orderSession) {
    write('events.jsonl', { type: 'BROWSER_BUY_SKIPPED', mint: signal.mint, observedAt: Date.now(), reason: 'NO_CAPTURED_ORDER_SESSION' });
    return;
  }
  const solPriceUsd = await currentSolUsd(page);
  const inputLamports = Math.floor(stakeUsd / solPriceUsd * 1_000_000_000).toString();
  let result = await submitBrowserBuy(page, { mint: signal.mint, fromAddress: orderSession.fromAddress, authorization: orderSession.authorization, inputLamports, tokenPriceUsd, solPriceUsd, marketCapUsd }, browserAutoTrade);
  if (isExpiredBrowserAuthorization(result)) {
    write('events.jsonl', { type: 'BROWSER_AUTH_REFRESHING', side: 'BUY', mint: signal.mint, observedAt: Date.now(), reason: 'TOKEN_EXPIRED' });
    if (await refreshBrowserAuthorization(page, orderSession.authorization)) {
      const refreshedSession = latestCapturedOrderSession();
      if (refreshedSession) result = await submitBrowserBuy(page, { mint: signal.mint, fromAddress: refreshedSession.fromAddress, authorization: refreshedSession.authorization, inputLamports, tokenPriceUsd, solPriceUsd, marketCapUsd }, browserAutoTrade);
    }
  }
  if (result.ok && 'acquiredAmount' in result && typeof result.acquiredAmount === 'string' && typeof result.acquiredDecimals === 'number') {
    liveBrowserPositions.set(signal.mint, { inputAmount: result.acquiredAmount, tokenDecimals: result.acquiredDecimals, confirmedAt: Date.now(), entryPriceUsd: tokenPriceUsd, isRealBalanceConfirmed: false });
  }
  write('events.jsonl', { type: result.ok ? 'BROWSER_BUY_SUBMITTED' : 'BROWSER_BUY_NOT_SUBMITTED', mint: signal.mint, observedAt: Date.now(), signalId: signal.signalId, stakeUsd, inputLamports, result });
  write('live-trade-ledger.jsonl', {
    type: 'LIVE_ORDER_SUBMITTED', side: 'BUY', mint: signal.mint, signalId: signal.signalId, positionId: signal.positionId, observedAt: Date.now(),
    orderId: (result as any).orderId ?? null, hash: (result as any).hash ?? null,
    acquiredAmount: (result as any).acquiredAmount ?? null, acquiredDecimals: (result as any).acquiredDecimals ?? null,
    ok: result.ok, status: result.status, code: result.code, message: result.message, stakeUsd, tokenPriceUsd,
  });
  console.log(result.ok ? '[browser-buy-submitted]' : '[browser-buy-not-submitted]', signal.mint, result);
  if (result.ok && orderSession.fromAddress) {
    void (async () => {
      for (const delayMs of [1200, 1500, 2000]) {
        await delay(delayMs);
        const wsData = await fetchWalletStat(page, orderSession.fromAddress, signal.mint);
        if (wsData) {
          recordWalletStatSnapshot(wsData, 'POST_BUY');
          if (typeof wsData.balance === 'string' && wsData.balance !== '0' && Number(wsData.balance) > 0) {
            break;
          }
        }
      }
    })();
  }
}
const browserSellDeferredBeforeBuy = new Set<string>();
async function promptAndSubmitBrowserSell(page: Page, signal: PaperSignal, tokenPriceUsd: number, marketCapUsd: number | null): Promise<void> {
  if (!browserTradingEnabled || signal.paperLane !== PAPER_LANES.control.id) return;
  const position = liveBrowserPositions.get(signal.mint);
  if (!position) {
    write('events.jsonl', { type: 'BROWSER_SELL_SKIPPED', mint: signal.mint, observedAt: Date.now(), signalId: signal.signalId, reason: 'NO_CONFIRMED_BROWSER_BUY' });
    return;
  }
  const orderSession = latestCapturedOrderSession();
  if (!orderSession) {
    write('events.jsonl', { type: 'BROWSER_SELL_SKIPPED', mint: signal.mint, observedAt: Date.now(), signalId: signal.signalId, reason: 'NO_CAPTURED_ORDER_SESSION' });
    return;
  }

  // 1. Sync real token balance. If already confirmed post-buy, directly hit sell without network latency.
  if (!position.isRealBalanceConfirmed) {
    const cachedBalance = liveTokenBalances.get(signal.mint);
    if (cachedBalance && cachedBalance.balanceBaseUnits !== '0') {
      position.inputAmount = cachedBalance.balanceBaseUnits;
      position.tokenDecimals = cachedBalance.decimals;
      position.isRealBalanceConfirmed = true;
    } else {
      try {
        const freshWs = await fetchWalletStat(page, orderSession.fromAddress, signal.mint);
        if (freshWs) {
          recordWalletStatSnapshot(freshWs, 'PRE_SELL');
          if (typeof freshWs.balance === 'string' && freshWs.balance !== '0' && Number(freshWs.balance) > 0) {
            const dec = typeof freshWs.decimals === 'number' ? freshWs.decimals : position.tokenDecimals;
            const realBaseUnits = parseBalanceToBaseUnits(freshWs.balance, dec);
            if (realBaseUnits !== '0') {
              position.inputAmount = realBaseUnits;
              position.tokenDecimals = dec;
              position.isRealBalanceConfirmed = true;
            }
          }
        }
      } catch { /* Fallback to cached balance or initial estimate */ }
    }
  }

  const solPriceUsd = await currentSolUsd(page);
  let result = await submitBrowserSell(page, { mint: signal.mint, fromAddress: orderSession.fromAddress, authorization: orderSession.authorization, inputAmount: position.inputAmount, tokenDecimals: position.tokenDecimals, tokenPriceUsd, solPriceUsd, marketCapUsd }, browserAutoTrade);

  // 2. Auto-retry if rejected due to token balance (40003701)
  if (!result.ok && (result.code === 40003701 || String(result.message).toLowerCase().includes('balance is less than available balance'))) {
    console.warn(`[browser-sell-balance-retry] Sinyal sell ${signal.mint} ditolak karena selisih saldo (${result.message}). Mengambil saldo riil ulang...`);
    await delay(1200);
    const retryWs = await fetchWalletStat(page, orderSession.fromAddress, signal.mint);
    if (retryWs) {
      recordWalletStatSnapshot(retryWs, 'RETRY_SELL');
      if (typeof retryWs.balance === 'string' && retryWs.balance !== '0' && Number(retryWs.balance) > 0) {
        const dec = typeof retryWs.decimals === 'number' ? retryWs.decimals : position.tokenDecimals;
        const correctedAmount = parseBalanceToBaseUnits(retryWs.balance, dec);
        if (correctedAmount && correctedAmount !== '0' && correctedAmount !== position.inputAmount) {
          console.warn(`[browser-sell-balance-retry] Mencoba sell ulang dengan saldo riil terkonfirmasi: ${retryWs.balance} (${correctedAmount} base units)`);
          position.inputAmount = correctedAmount;
          position.tokenDecimals = dec;
          result = await submitBrowserSell(page, { mint: signal.mint, fromAddress: orderSession.fromAddress, authorization: orderSession.authorization, inputAmount: position.inputAmount, tokenDecimals: position.tokenDecimals, tokenPriceUsd, solPriceUsd, marketCapUsd }, browserAutoTrade);
        }
      }
    }
  }

  // 3. Auto-refresh auth on expiration (401/403)
  if (isExpiredBrowserAuthorization(result)) {
    write('events.jsonl', { type: 'BROWSER_AUTH_REFRESHING', side: 'SELL', mint: signal.mint, observedAt: Date.now(), reason: 'TOKEN_EXPIRED' });
    if (await refreshBrowserAuthorization(page, orderSession.authorization)) {
      const refreshedSession = latestCapturedOrderSession();
      if (refreshedSession) result = await submitBrowserSell(page, { mint: signal.mint, fromAddress: refreshedSession.fromAddress, authorization: refreshedSession.authorization, inputAmount: position.inputAmount, tokenDecimals: position.tokenDecimals, tokenPriceUsd, solPriceUsd, marketCapUsd }, browserAutoTrade);
    }
  }

  if (result.ok) {
    liveBrowserPositions.delete(signal.mint);
    liveTokenBalances.delete(signal.mint);
  }
  write('events.jsonl', { type: result.ok ? 'BROWSER_SELL_SUBMITTED' : 'BROWSER_SELL_NOT_SUBMITTED', mint: signal.mint, observedAt: Date.now(), signalId: signal.signalId, inputAmount: position.inputAmount, result });
  write('live-trade-ledger.jsonl', {
    type: 'LIVE_ORDER_SUBMITTED', side: 'SELL', mint: signal.mint, signalId: signal.signalId, positionId: signal.positionId, observedAt: Date.now(),
    orderId: (result as any).orderId ?? null, hash: (result as any).hash ?? null,
    ok: result.ok, status: result.status, code: result.code, message: result.message, inputAmount: position.inputAmount, tokenPriceUsd,
  });
  console.log(result.ok ? '[browser-sell-submitted]' : '[browser-sell-not-submitted]', signal.mint, result);
  if (result.ok && orderSession.fromAddress) {
    void (async () => {
      await delay(3500);
      const wsData = await fetchWalletStat(page, orderSession.fromAddress, signal.mint);
      if (wsData) recordWalletStatSnapshot(wsData, 'POST_SELL');
    })();
  }
}
const paperRiskListeners = new Map<string, (tick: TapeTrade) => void>();
const ownerSnapshots = new Map<string, OwnerSample[]>();
function ownerEvidence(mint: string): OwnerSample[] {
  return ownerSnapshots.get(mint) ?? [];
}
const queue = new CandidateQueue(500, 10 * 60_000), inspected = new Set<string>(), lastHolderWrite = new Map<string, number>(), lastComparisonWrite = new Map<string, number>();
const pumpConsidered = new Set<string>();
const pumpSlots: { state: 'idle' | 'assigned' | 'active'; mint: string | null }[] = Array.from({ length: workers }, () => ({ state: 'idle', mint: null }));
const rejected = new Set<string>(), youngRejected = new Set<string>(), rejectionCounts = new Map<string, number>(), youngRejectionCounts = new Map<string, number>();
const stopping = new AbortController();
let context: BrowserContext | undefined, received = 0, sockets = 0;
let solSpotCache: { usd: number; observedAt: number } | undefined;
let paperBuyCount = 0;
// DEV-tag data is supplementary. Reserve one request globally so five detail
// workers never burst the endpoint and trigger a session-wide 429.
let nextDeveloperApiRequestAt = 0;

type MonitoringSnapshot = {
  observedAt: number;
  holderCount: number | null;
  holderDelta: number | null;          // selisih dari snapshot sebelumnya
  buys5s: number;                      // jumlah buy dalam 5 detik terakhir
  sells5s: number;                     // jumlah sell dalam 5 detik terakhir
  buyUsd5s: number;                    // volume buy USD dalam 5 detik terakhir
  sellUsd5s: number;                   // volume sell USD dalam 5 detik terakhir
  priceUsd: number | null;
  top10Holders: { wallet: string; pct: number; isDev: boolean }[];
  blockingReasons: string[];           // alasan buy belum terjadi saat snapshot ini
};
const monitoringSnapshots = new Map<string, MonitoringSnapshot[]>();

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
  const holderCount = response.status === 200 ? ['holder_count', 'holders', 'holder_num', 'holderCount']
    .filter(key => record[key] !== null && record[key] !== undefined && record[key] !== '')
    .map(key => Number(record[key])).find(value => Number.isInteger(value) && value >= 0) ?? null : null;
  // A response becomes evidence when it arrives, not when its request started.
  observedAt = Date.now();
  write('token-stat.jsonl', { mint, observedAt, source: 'GMGN same-session /api/v1/token_stat', status: response.status, holderCount, availableFields: Object.keys(record).slice(0, 100) });
  if (holderCount !== null) {
    const samples = totalHolderSamples.get(mint) ?? [];
    if (!samples.length || observedAt > samples.at(-1)!.observedAt) samples.push({ observedAt, count: holderCount });
    totalHolderSamples.set(mint, samples.slice(-12));
    const existing = candidates.get(mint);
    merge({ mint, firstSeenAt: existing?.firstSeenAt ?? observedAt, updatedAt: observedAt, fields: { holders: { value: holderCount, observedAt, source: 'GMGN token_stat API' } } });
  }
  return { status: response.status, holderCount };
}
function numberFrom(record: Record<string, unknown>, keys: string[]) {
  return keys.map(key => Number(record[key])).find(value => Number.isFinite(value)) ?? null;
}
const gmgnClientCache = {
  deviceId: '2d9248c7-3137-4fc1-bae6-a9d70136d48e',
  fpDid: 'aaa4fd49dbd9a8cb1b32059bd5b6b375',
  clientId: 'gmgn_web_20260922-4775-0d0463e',
  appVer: '20260922-4775-0d0463e',
  tzName: 'Asia_Jakarta',
  tzOffset: '25200',
};

function cacheGmgnNetworkParams(params: URLSearchParams) {
  const did = params.get('device_id');
  if (did) gmgnClientCache.deviceId = did;
  const fp = params.get('fp_did');
  if (fp) gmgnClientCache.fpDid = fp;
  const cid = params.get('client_id');
  if (cid) gmgnClientCache.clientId = cid;
  const ver = params.get('app_ver');
  if (ver) gmgnClientCache.appVer = ver;
  const tz = params.get('tz_name');
  if (tz) gmgnClientCache.tzName = tz;
  const tzo = params.get('tz_offset');
  if (tzo) gmgnClientCache.tzOffset = tzo;
}

function parseAndStoreDeveloperHolders(mint: string, body: unknown, observedAt: number, source: 'network_intercept' | 'replayed_xhr', status: number): DeveloperHolder[] {
  const root = body && typeof body === 'object' ? body as { data?: unknown } : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  const values = [data.list, data.holders, data.data].find(Array.isArray) as unknown[] | undefined;
  const found: DeveloperHolder[] = [];
  for (const value of values ?? []) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const wallet = ['wallet_address', 'wallet', 'address', 'wa', 'owner_address'].map(key => item[key]).find(validMint);
    if (typeof wallet !== 'string') continue;
    const raw: Record<string, Primitive> = {};
    for (const [key, val] of Object.entries(item)) if (val === null || typeof val === 'boolean' || typeof val === 'number' || (typeof val === 'string' && val.length <= 500)) raw[key] = val;
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
  developerHolderApiStatus.set(mint, { status, count: found.length, observedAt, source });
  write('developer-holders.jsonl', { mint, observedAt, source: `GMGN ${source} /vas/api/v1/token_holders tag=dev`, status, holders: found });
  return found;
}

function parseAndStoreTrackedHolders(mint: string, body: unknown, observedAt: number, source: 'network_intercept' | 'replayed_xhr', status: number): TrackedHolder[] {
  observedAt = Date.now();
  const root = body && typeof body === 'object' ? body as { data?: unknown } : {};
  const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : {};
  const values = [data.list, data.holders, data.data].find(Array.isArray) as unknown[] | undefined;
  const found: TrackedHolder[] = [];
  for (const value of values ?? []) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const wallet = ['address', 'wallet_address', 'wallet', 'wa', 'owner_address'].map(key => item[key]).find(validMint);
    if (typeof wallet !== 'string') continue;

    const makerTags = Array.isArray(item.maker_token_tags) ? item.maker_token_tags.map(String) : [];
    const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
    const walletTagV2 = typeof item.wallet_tag_v2 === 'string' ? item.wallet_tag_v2 : '';
    const devEvidence = [...makerTags, ...tags].filter(t => ['creator', 'dev_team', 'dev'].includes(t.toLowerCase()));
    if (walletTagV2.toLowerCase().includes('dev')) devEvidence.push(walletTagV2);
    const isDev = devEvidence.length > 0;

    let pct = numberFrom(item, ['amount_percentage', 'percentage', 'percent', 'ownership_percentage']);
    if (pct !== null && pct <= 1 && pct > 0) pct = pct * 100;

    const raw: Record<string, Primitive> = {};
    for (const [key, val] of Object.entries(item)) {
      if (val === null || typeof val === 'boolean' || typeof val === 'number' || (typeof val === 'string' && val.length <= 500)) raw[key] = val;
    }
    found.push({
      mint, wallet, observedAt, amountPercentage: pct,
      amount: numberFrom(item, ['amount_cur', 'balance', 'amount', 'token_amount']),
      isDev, devEvidence, walletTagV2, raw
    });
  }
  const map = new Map<string, TrackedHolder>();
  for (const holder of found) map.set(holder.wallet, holder);
  if (found.length) trackedHolders.set(mint, map);
  if (status === 200 && found.length) {
    const snapshots = found.filter(h => h.raw.addr_type !== 2 && !h.raw.exchange && !h.walletTagV2?.toLowerCase().includes('lp')).map(h => ({
      observedAt, wallet: h.wallet, balance: h.amount,
      percent: h.raw.amount_percentage === null || h.raw.amount_percentage === undefined ? null : Number(h.raw.amount_percentage) * 100,
      isDev: h.isDev,
    }));
    ownerSnapshots.set(mint, [...(ownerSnapshots.get(mint) ?? []).filter(h => observedAt - h.observedAt <= 60_000), ...snapshots]);
  }
  holderApiStatus.set(mint, { status, count: found.length, observedAt, source });
  const persisted = holderStore.record(mint, observedAt, status, source, found);
  console.log(`[tracked-holders-sqlite] (${source}) ${mint} ${persisted.changed ? 'snapshot-changed' : 'snapshot-unchanged'}`);
  console.log(`[tracked-holders-loaded] (${source}) ${mint} loaded ${found.length} holders (Devs: ${found.filter(h => h.isDev).length}, status=${status})`);
  return found;
}

function attachHolderNetworkInspector(page: Page) {
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/vas/api/v1/token_holders/sol/')) return;
    try {
      const urlObj = new URL(url);
      cacheGmgnNetworkParams(urlObj.searchParams);
      const segments = urlObj.pathname.split('/');
      const tokenMint = segments.at(-1) || '';
      if (!validMint(tokenMint)) return;

      const status = res.status();
      const observedAt = Date.now();
      if (status === 200) {
        const body = await res.json().catch(() => null);
        if (body && typeof body === 'object') {
          const isDevTag = urlObj.searchParams.get('tag') === 'dev';
          if (isDevTag) {
            parseAndStoreDeveloperHolders(tokenMint, body, observedAt, 'network_intercept', 200);
          } else {
            parseAndStoreTrackedHolders(tokenMint, body, observedAt, 'network_intercept', 200);
          }
        }
      } else {
        holderApiStatus.set(tokenMint, { status, count: 0, observedAt, source: 'network_intercept' });
        holderStore.record(tokenMint, observedAt, status, 'network_intercept', []);
        console.log(`[network-holders-intercept] ${tokenMint} status=${status} from browser XHR`);
      }
    } catch {
      // ignore passive inspection errors
    }
  });
}

/** Records GMGN order endpoint metadata and, only when explicitly requested,
 * the complete local request/response exchange for the order endpoint. */
function attachOrderApiInspector(target: Page | BrowserContext) {
  // Quote simulation only observes the wallet address from normal GMGN
  // requests; it never uses an authorization header or submits an order.
  const quoteSessionCaptureEnabled = browserTradingEnabled || quoteSimulationEnabled;
  const isGmgnApiRequest = (request: import('playwright').Request) => {
    try {
      const url = new URL(request.url());
      return /gmgn\.ai$/i.test(url.hostname) && ['fetch', 'xhr'].includes(request.resourceType());
    } catch {
      return false;
    }
  };
  const isOrderEndpoint = (rawUrl: string) => {
    try {
      const url = new URL(rawUrl);
      return /gmgn\.ai$/i.test(url.hostname)
        && /\/(?:txproxy\/v1\/get_swap_route|defi\/router|api\/v\d+\/.*(?:swap|order|transaction)|.*\/(?:swap(?:[_-].*)?|order(?:[_-].*)?|transaction(?:[_-].*)?))\b/i.test(url.pathname);
    } catch {
      return false;
    }
  };
  const isSolanaRpcSubmission = (request: import('playwright').Request) => {
    if (request.method() !== 'POST' || !['fetch', 'xhr'].includes(request.resourceType())) return false;
    const body = request.postData() ?? '';
    return /"method"\s*:\s*"(?:sendTransaction|simulateTransaction|getSignatureStatuses)"/.test(body);
  };
  const safeEndpoint = (rawUrl: string) => {
    const url = new URL(rawUrl);
    return { origin: url.origin, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort() };
  };

  target.on('request', request => {
    const orderEndpoint = isOrderEndpoint(request.url());
    const rpcSubmission = isSolanaRpcSubmission(request);
    const gmgnApiRequest = isGmgnApiRequest(request);
    if (!orderEndpoint && !rpcSubmission && (!values.orderCapture || !gmgnApiRequest) && (!quoteSessionCaptureEnabled || !gmgnApiRequest)) return;
    const headers = request.headers();
    if (browserTradingEnabled && typeof headers.authorization === 'string' && headers.authorization.length > 0) liveBrowserAuthorization = headers.authorization;
    const walletMatch = request.url().match(/\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (walletMatch && walletMatch[1]) liveBrowserWalletAddress = walletMatch[1];
    if (values.orderOutcomeCapture && orderEndpoint && request.method() === 'POST') orderOutcomeCaptureUntil = Date.now() + 60_000;
    const endpoint = safeEndpoint(request.url());
    write('order-api-audit.jsonl', {
      type: orderEndpoint ? 'ORDER_API_REQUEST' : rpcSubmission ? 'SOLANA_RPC_REQUEST' : 'GMGN_API_REQUEST', observedAt: Date.now(), method: request.method(), resourceType: request.resourceType(), ...endpoint,
      contentType: headers['content-type'] ?? null,
      hasBody: request.postDataBuffer() !== null,
      note: 'Request values, headers, cookies, and body are intentionally redacted.',
    });
    if (values.orderCapturePayloads && (orderEndpoint || rpcSubmission)) {
      const bodyBuffer = request.postDataBuffer();
      write('order-api-payloads.jsonl', {
        type: orderEndpoint ? 'ORDER_REQUEST_PAYLOAD' : 'SOLANA_RPC_REQUEST_PAYLOAD', observedAt: Date.now(), method: request.method(), resourceType: request.resourceType(),
        url: request.url(), headers, contentType: headers['content-type'] ?? null, bodyText: request.postData() ?? null,
        bodyBase64: bodyBuffer ? bodyBuffer.toString('base64') : null,
        note: 'Complete local request capture explicitly enabled.',
      });
    }
  });
  target.on('response', async response => {
    const request = response.request(), orderEndpoint = isOrderEndpoint(response.url()), rpcSubmission = isSolanaRpcSubmission(request);
    const captureOutcome = values.orderOutcomeCapture && Date.now() <= orderOutcomeCaptureUntil && isGmgnApiRequest(request);
    if (!orderEndpoint && !rpcSubmission && (!values.orderCapture || !isGmgnApiRequest(request)) && !captureOutcome) return;
    const endpoint = safeEndpoint(response.url());
    write('order-api-audit.jsonl', {
      type: orderEndpoint ? 'ORDER_API_RESPONSE' : rpcSubmission ? 'SOLANA_RPC_RESPONSE' : 'GMGN_API_RESPONSE', observedAt: Date.now(), method: request.method(), resourceType: request.resourceType(), status: response.status(), ...endpoint,
      contentType: response.headers()['content-type'] ?? null,
      note: 'Response body is intentionally not recorded because it may contain an unsigned or signed transaction.',
    });
    if (values.orderCapturePayloads && (orderEndpoint || rpcSubmission)) {
      try {
        const bodyBuffer = await response.body();
        const headers = response.headers();
        write('order-api-payloads.jsonl', {
          type: orderEndpoint ? 'ORDER_RESPONSE_PAYLOAD' : 'SOLANA_RPC_RESPONSE_PAYLOAD', observedAt: Date.now(), method: request.method(), resourceType: request.resourceType(),
          url: response.url(), status: response.status(), headers, contentType: headers['content-type'] ?? null,
          bodyText: bodyBuffer.toString('utf8'), bodyBase64: bodyBuffer.toString('base64'),
          note: 'Complete local response capture explicitly enabled.',
        });
      } catch (error) {
        write('order-api-payloads.jsonl', { type: 'ORDER_RESPONSE_PAYLOAD_ERROR', observedAt: Date.now(), method: request.method(), url: response.url(), status: response.status(), message: error instanceof Error ? error.message : 'unknown' });
      }
    }
    if (captureOutcome) {
      try {
        const body = await response.body();
        const headers = response.headers();
        const bodyText = body.toString('utf8');
        write('order-followup-responses.jsonl', {
          type: 'ORDER_FOLLOWUP_RESPONSE', observedAt: Date.now(), method: request.method(), resourceType: request.resourceType(), status: response.status(),
          url: response.url(), headers, contentType: headers['content-type'] ?? null,
          bodyText, bodyBase64: body.toString('base64'),
          note: 'Captured for local inspection after a browser Buy/Sell submit; may contain account, balance, and order data.',
        });
        if (new URL(response.url()).pathname.includes('/smartmoney/sol/walletstat/')) {
          try {
            const data = (JSON.parse(bodyText) as { data?: Record<string, unknown> }).data;
            if (data) recordWalletStatSnapshot(data, 'PASSIVE_CAPTURE');
          } catch { /* Ignore non-JSON or incomplete wallet-stat responses. */ }
        }
      } catch { /* Some responses are no longer available to Playwright. */ }
    }
  });
}

async function refreshDeveloperHolders(page: Page, mint: string, observedAt: number) {
  const response = await page.evaluate(async ({ mint: tokenMint, cachedParams }) => {
    let deviceId = cachedParams.deviceId;
    let fpDid = cachedParams.fpDid;
    let clientId = cachedParams.clientId;
    let appVer = cachedParams.appVer || '20260922-4775-0d0463e';

    try {
      const matchDid = document.cookie.match(/_did=([^;]+)/);
      if (matchDid && matchDid[1]) {
        deviceId = deviceId || matchDid[1];
        fpDid = fpDid || matchDid[1];
      }
      const lsDeviceId = localStorage.getItem('device_id') || localStorage.getItem('gmgn_device_id');
      if (lsDeviceId) deviceId = lsDeviceId;
      const lsFp = localStorage.getItem('fp_did');
      if (lsFp) fpDid = lsFp;
      const lsClientId = localStorage.getItem('client_id');
      if (lsClientId) clientId = lsClientId;
    } catch {}

    if (!deviceId) deviceId = '2d9248c7-3137-4fc1-bae6-a9d70136d48e';
    if (!fpDid) fpDid = 'aaa4fd49dbd9a8cb1b32059bd5b6b375';
    if (!clientId) clientId = `gmgn_web_${appVer}`;

    const tabId = Math.random().toString(36).slice(2, 14);
    let tzName = 'Asia_Jakarta';
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia_Jakarta'; } catch {}
    const tzOffset = String(-new Date().getTimezoneOffset() * 60 || 25200);

    const query = new URLSearchParams({
      device_id: deviceId,
      tab_id: tabId,
      fp_did: fpDid,
      client_id: clientId,
      from_app: 'gmgn',
      app_ver: appVer,
      tz_name: tzName,
      tz_offset: tzOffset,
      app_lang: 'en-US',
      os: 'web',
      worker: '0',
      limit: '100',
      cost: '20',
      tag: 'dev',
      orderby: 'amount_percentage',
      direction: 'desc'
    });

    const url = '/vas/api/v1/token_holders/sol/' + encodeURIComponent(tokenMint) + '?' + query.toString();
    const result = await fetch(url, {
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'priority': 'u=1, i',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });
    const body: unknown = await result.json().catch(() => null);
    return { status: result.status, body };
  }, { mint, cachedParams: gmgnClientCache }).catch(error => ({
    status: 0, body: { error: error instanceof Error ? error.message : 'request failed' }
  }));

  const found = parseAndStoreDeveloperHolders(mint, response.body, Date.now(), 'replayed_xhr', response.status);
  return { status: response.status, holders: found };
}

async function maybeRefreshDeveloperHolders(page: Page, mint: string, observedAt: number) {
  if (Date.now() < nextDeveloperApiRequestAt) return { status: null, deferred: true };
  nextDeveloperApiRequestAt = Date.now() + 30_000;
  const response = await refreshDeveloperHolders(page, mint, observedAt);
  if (response.status === 429) nextDeveloperApiRequestAt = Date.now() + 60_000;
  return { status: response.status, deferred: false };
}

const trackedHolders = new Map<string, Map<string, TrackedHolder>>();

async function refreshTrackedHolders(page: Page, mint: string, observedAt: number) {
  const cachedStatus = holderApiStatus.get(mint);
  const cachedHolders = trackedHolders.get(mint);
  if (cachedStatus && cachedStatus.status === 200 && cachedHolders && cachedHolders.size > 0 && observedAt - cachedStatus.observedAt <= 20_000) {
    return { status: 200, holders: [...cachedHolders.values()] };
  }

  const response = await page.evaluate(async ({ mint: tokenMint, cachedParams }) => {
    let deviceId = cachedParams.deviceId;
    let fpDid = cachedParams.fpDid;
    let clientId = cachedParams.clientId;
    let appVer = cachedParams.appVer || '20260922-4775-0d0463e';

    try {
      const matchDid = document.cookie.match(/_did=([^;]+)/);
      if (matchDid && matchDid[1]) {
        deviceId = deviceId || matchDid[1];
        fpDid = fpDid || matchDid[1];
      }
      const lsDeviceId = localStorage.getItem('device_id') || localStorage.getItem('gmgn_device_id');
      if (lsDeviceId) deviceId = lsDeviceId;
      const lsFp = localStorage.getItem('fp_did');
      if (lsFp) fpDid = lsFp;
      const lsClientId = localStorage.getItem('client_id');
      if (lsClientId) clientId = lsClientId;
    } catch {}

    if (!deviceId) deviceId = '2d9248c7-3137-4fc1-bae6-a9d70136d48e';
    if (!fpDid) fpDid = 'aaa4fd49dbd9a8cb1b32059bd5b6b375';
    if (!clientId) clientId = `gmgn_web_${appVer}`;

    const tabId = Math.random().toString(36).slice(2, 14);
    let tzName = 'Asia_Jakarta';
    try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia_Jakarta'; } catch {}
    const tzOffset = String(-new Date().getTimezoneOffset() * 60 || 25200);

    const query = new URLSearchParams({
      device_id: deviceId,
      tab_id: tabId,
      fp_did: fpDid,
      client_id: clientId,
      from_app: 'gmgn',
      app_ver: appVer,
      tz_name: tzName,
      tz_offset: tzOffset,
      app_lang: 'en-US',
      os: 'web',
      worker: '0',
      limit: '100',
      cost: '20',
      orderby: 'amount_percentage',
      direction: 'desc'
    });

    const url = '/vas/api/v1/token_holders/sol/' + encodeURIComponent(tokenMint) + '?' + query.toString();
    const result = await fetch(url, {
      credentials: 'include',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'priority': 'u=1, i',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      }
    });
    const body: unknown = await result.json().catch(() => null);
    return { status: result.status, body, extractedParams: { deviceId, fpDid, clientId, appVer, tzName, tzOffset } };
  }, { mint, cachedParams: gmgnClientCache }).catch(error => ({
    status: 0,
    body: { error: error instanceof Error ? error.message : 'request failed' },
    extractedParams: null
  }));

  if (response.extractedParams) {
    if (response.extractedParams.deviceId) gmgnClientCache.deviceId = response.extractedParams.deviceId;
    if (response.extractedParams.fpDid) gmgnClientCache.fpDid = response.extractedParams.fpDid;
    if (response.extractedParams.clientId) gmgnClientCache.clientId = response.extractedParams.clientId;
    if (response.extractedParams.appVer) gmgnClientCache.appVer = response.extractedParams.appVer;
    if (response.extractedParams.tzName) gmgnClientCache.tzName = response.extractedParams.tzName;
    if (response.extractedParams.tzOffset) gmgnClientCache.tzOffset = response.extractedParams.tzOffset;
  }

  const found = parseAndStoreTrackedHolders(mint, response.body, observedAt, 'replayed_xhr', response.status);
  return { status: response.status, holders: found };
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
function writeSimulationExit(position: SimulationPosition, paperLane: PaperLane, mint: string, now: number, exitPriceUsd: number, reason: SimulationExitReason, metadata: unknown, decision: Record<string, unknown> | null, timing?: PaperSignal) {
  const result = closeSimulation(position, exitPriceUsd);
  writeSimulation({ type: 'SIMULATED_SELL', paperLane, mint, observedAt: now, reason, entry: { openedAt: position.openedAt, priceUsd: position.entryPriceUsd, stakeUsd: position.stakeUsd, quantity: position.quantity },
    exit: { priceUsd: exitPriceUsd, grossProceedsUsd: result.grossProceedsUsd }, pnlUsd: result.pnlUsd, pnlPercent: result.pnlPercent,
    decision, ...(timing ? { timing, positionId: timing.positionId } : {}),
    assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper valuation at the observed signal price; this is not a confirmed swap fill.' }, metadata });
  if (maxPaperBuys !== null && !values.browserBuyPrompt) {
    const totalSells = simulatedEvents.filter(event => event.type === 'SIMULATED_SELL' && event.paperLane === PAPER_LANES.control.id).length;
    const openLanes = simulatedEvents.filter(event => event.type === 'SIMULATED_BUY').length - simulatedEvents.filter(event => event.type === 'SIMULATED_SELL').length;
    const comparisonComplete = !momentumComparison || [PAPER_LANES.control.id, PAPER_LANES.v3.id, PAPER_LANES.v3ExitConfirmed.id]
      .every(lane => simulatedEvents.filter(event => event.type === 'SIMULATED_SELL' && event.paperLane === lane).length >= maxPaperBuys);
    if (comparisonComplete && totalSells >= maxPaperBuys && openLanes === 0 && liveBrowserPositions.size === 0) {
      console.log('[trial-complete]', `Target ${maxPaperBuys} buy dan ${totalSells} sell selesai.`);
      setTimeout(() => stopping.abort(), 2_000);
    }
  }
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
    const rawAu = Number(at(row, 'au') ?? at(row, 'amount_usd') ?? at(row, 'vol'));
    const amountUsd = Number.isFinite(rawAu) ? rawAu : null;
    const trade: Trade = { mint, side, signature, observedAt: now, occurredAt: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : now,
      wallet: typeof wallet === 'string' ? wallet : null,
      priceUsd: Number.isFinite(Number(at(row, 'pu'))) ? Number(at(row, 'pu')) : null,
      amount: Number.isFinite(Number(at(row, 'au'))) ? Number(at(row, 'au')) : null,
      amountUsd, raw };
    list.push(trade); trades.set(mint, list); write('trades.jsonl', trade);
    if (momentumResearch) {
      const rawTokens = trade.raw.ba;
      const tick: TapeTrade = { id: signature ?? String(trade.raw.id ?? trade.raw.si ?? `${mint}:${trade.occurredAt}:${trade.wallet}:${trade.side}:${trade.priceUsd}:${rawTokens}`),
        observedAt: now, occurredAt: trade.occurredAt, priceUsd: trade.priceUsd, side: trade.side, wallet: trade.wallet,
        usd: trade.amountUsd ?? null, tokens: rawTokens === null || rawTokens === undefined ? null : Number(rawTokens) };
      const tape = momentumTape.get(mint) ?? [];
      tape.push(tick); momentumTape.set(mint, tape.filter(t => t.observedAt >= now - 15_000));
      // Synchronous, exactly-once paper exit. UI/API awaits never suspend this listener.
      paperRiskListeners.get(mint)?.(tick);
    }
    if (trade.priceUsd !== null && trade.priceUsd > 0) {
      const candidate = candidates.get(mint);
      if (candidate) {
        candidate.fields.priceUsd = { value: trade.priceUsd, observedAt: now, source: 'token_activity' };
      }
    }
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
    if (snapshot.length) {
      holders.set(mint, map);
      lastHolderWrite.set(mint, now);
      holderStore.recordSocket(mint, now, snapshot.map(({ wallet, raw }) => ({ wallet, raw })));
      writeComparison(mint, now);
    }
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
function computeTop10Holders(mint: string): { wallet: string; pct: number; isDev: boolean }[] {
  const tokenHoldersMap = trackedHolders.get(mint);
  if (tokenHoldersMap && tokenHoldersMap.size > 0) {
    const userHolders = Array.from(tokenHoldersMap.values())
      .filter(h => h.raw?.addr_type !== 2 && !h.raw?.exchange && !h.walletTagV2?.toLowerCase().includes('lp'))
      .sort((a, b) => (b.amountPercentage ?? 0) - (a.amountPercentage ?? 0))
      .slice(0, 10);
    return userHolders.map(h => ({ wallet: h.wallet, pct: h.amountPercentage ?? 0, isDev: h.isDev }));
  }
  // Fallback: estimasi dari trades jika belum ada holder data
  const candidate = candidates.get(mint);
  const marketCap = num(candidate, 'marketCapUsd'), price = num(candidate, 'priceUsd');
  const estimatedSupply = marketCap && price && price > 0 ? marketCap / price : null;
  if (!estimatedSupply) return [];
  const netTokens = new Map<string, number>();
  for (const tr of trades.get(mint) ?? []) {
    const ba = Number(tr.raw?.ba ?? 0);
    const cur = netTokens.get(tr.wallet ?? '') ?? 0;
    if (tr.side === 'buy') netTokens.set(tr.wallet ?? '', cur + ba);
    else netTokens.set(tr.wallet ?? '', Math.max(0, cur - ba));
  }
  const sorted = Array.from(netTokens.entries()).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a).slice(0, 10);
  const totalCirc = sorted.reduce((acc, [, v]) => acc + v, 0);
  if (!totalCirc) return [];
  return sorted.map(([wallet, bal]) => ({ wallet, pct: bal / totalCirc * 100, isDev: false }));
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
      if (feed && pumpBand) {
        const marketCapUsd = num(candidate, 'marketCapUsd');
        if (!isInPumpBand(marketCapUsd) || pumpConsidered.has(candidate.mint)) continue;
        pumpConsidered.add(candidate.mint);
        const slotIndex = pumpSlots.findIndex(slot => slot.state === 'idle');
        if (slotIndex < 0 || (maxPaperBuys !== null && paperBuyCount >= maxPaperBuys)) {
          write('events.jsonl', { type: 'PUMP_BAND_SKIPPED_NO_SLOT', mint: candidate.mint, observedAt: now, marketCapUsd });
          continue;
        }
        const slot = pumpSlots[slotIndex]!;
        slot.state = 'assigned'; slot.mint = candidate.mint;
        inspected.add(candidate.mint);
        write('screened-tokens.jsonl', { observedAt: now, mint: candidate.mint, metadata: candidate.metadata ?? null, fields: candidate.fields, strategy: 'pump-band', worker: slotIndex + 1 });
        console.log('[pump-band-assigned]', 'slot=' + (slotIndex + 1), candidate.metadata?.symbol ?? candidate.mint, '$' + marketCapUsd?.toFixed(2));
        continue;
      }
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
async function refreshSolUsd(page: Page): Promise<{ usd: number; observedAt: number }> {
  let usd: number;
  try { usd = await fetchSolUsdSpot(); } catch { usd = await fetchSolUsdSpotInBrowser(page); }
  solSpotCache = { usd, observedAt: Date.now() };
  return solSpotCache;
}
async function currentSolUsd(page: Page) {
  if (solSpotCache && Date.now() - solSpotCache.observedAt < 30_000) return solSpotCache.usd;
  return (await refreshSolUsd(page)).usd;
}
async function safelySetAmount(page: Page, solAmount: string) {
  const input = await amountInput(page);
  const current = (await input.inputValue()).trim();
  if (current === solAmount) return;
  await input.click({ clickCount: 3 });
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await page.waitForTimeout(100);
  await input.fill(solAmount);
  const afterFill = (await input.inputValue()).trim();
  if (afterFill !== solAmount) {
    await input.evaluate((el: HTMLInputElement, val: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) {
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = val;
      }
    }, solAmount);
  }
}
async function prepareBuyPanel(page: Page, mint: string, worker: number, observedAt: number) {
  if (!values.prepareTradeUi || values.simulateOrder) return;
  await selectTradeSide(page, 'buy');
  let executionSettingsApplied = true;
  try { await applyExecutionSettings(page, DEFAULT_EXECUTION_SETTINGS); }
  catch (error) {
    executionSettingsApplied = false;
    write('events.jsonl', { type: 'BUY_EXECUTION_SETTINGS_WARNING', mint, worker, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
    console.log('[buy-settings-warning]', mint, error instanceof Error ? error.message : error);
  }
  const solUsdSpot = await currentSolUsd(page);
  const solAmount = simulationStakeSol !== null
    ? simulationStakeSol.toFixed(3)
    : usdcToSol(String(simulationStakeUsd), solUsdSpot);
  await safelySetAmount(page, solAmount);
  write('trade-preparation.jsonl', { type: 'BUY_PREPARED', mint, worker, observedAt, requestedUsdc: simulationStakeUsd, requestedSol: simulationStakeSol, solAmount, solUsdSpot, executionSettings: DEFAULT_EXECUTION_SETTINGS, executionSettingsApplied,
    note: 'The GMGN Buy field was filled only. No Buy button was clicked and no transaction was submitted.' });
}
async function prepareSellPanel(page: Page, mint: string, worker: number, observedAt: number, reason: SimulationExitReason) {
  if (!values.prepareTradeUi || values.simulateOrder) return;
  await selectTradeSide(page, 'sell');
  let executionSettingsApplied = true;
  try { await applyExecutionSettings(page, DEFAULT_EXECUTION_SETTINGS); }
  catch (error) {
    executionSettingsApplied = false;
    write('events.jsonl', { type: 'SELL_EXECUTION_SETTINGS_WARNING', mint, worker, observedAt: Date.now(), reason, message: error instanceof Error ? error.message : 'unknown' });
    console.log('[sell-settings-warning]', mint, error instanceof Error ? error.message : error);
  }
  await selectSellPercent(page, 100);
  const preparedAmount = await (await amountInput(page)).inputValue();
  write('trade-preparation.jsonl', { type: 'SELL_PREPARED', mint, worker, observedAt, reason, sellPercent: 100, preparedAmount, executionSettings: DEFAULT_EXECUTION_SETTINGS, executionSettingsApplied,
    note: 'The GMGN Sell 100% preset was selected only. No Sell button was clicked and no transaction was submitted.' });
}
async function pumpBandWorker(index: number, deadline: number) {
  const slot = pumpSlots[index - 1]!;
  const page = await context!.newPage();
  let activeMint: string | undefined;
  attach(page, false, () => activeMint);
  attachHolderNetworkInspector(page);
  try {
    while (!stopping.signal.aborted && Date.now() < deadline) {
      if (slot.state !== 'assigned' || !slot.mint) { await delay(100); continue; }
      const mint = slot.mint;
      slot.state = 'active'; activeMint = mint;
      const startedAt = Date.now(), stopAt = Math.min(deadline, startedAt + detailSeconds * 1_000);
      const initialMarketCapUsd = num(candidates.get(mint), 'marketCapUsd');
      let position: SimulationPosition | null = null;
      let exitReason: SimulationExitReason | null = null;
      let lastTick: Trade | null = null;
      let peakPriceUsd = 0, processedTrades = 0, lastTokenStatAt = 0, lastMonitoringSnapshotAt = 0;
      let tokenStatInFlight: Promise<unknown> | null = null;
      write('events.jsonl', { type: 'DETAIL_STARTED', mint, worker: index, startedAt, strategy: 'pump-band', initialMarketCapUsd });
      console.log('[pump-band-detail]', 'slot=' + index, candidates.get(mint)?.metadata?.symbol ?? mint);
      try {
        await page.goto(config.tokenUrlTemplate.replaceAll('{mint}', mint), { waitUntil: 'commit', timeout: config.workerTimeoutMs });
        while (!stopping.signal.aborted && Date.now() < stopAt) {
          const now = Date.now();
          if (!tokenStatInFlight && now - lastTokenStatAt >= PUMP_BAND_RULES.holderPollMs) {
            lastTokenStatAt = now;
            tokenStatInFlight = refreshTokenStat(page, mint, now).catch(() => {}).finally(() => { tokenStatInFlight = null; });
          }
          if (now - lastMonitoringSnapshotAt >= PUMP_BAND_RULES.holderPollMs) {
            lastMonitoringSnapshotAt = now;
            const previous = monitoringSnapshots.get(mint) ?? [];
            const holderCount = num(candidates.get(mint), 'holders');
            const recent = (trades.get(mint) ?? []).filter(trade => trade.observedAt >= now - PUMP_BAND_RULES.flowWindowMs);
            const buys = recent.filter(trade => trade.side === 'buy');
            const sells = recent.filter(trade => trade.side === 'sell');
            previous.push({ observedAt: now, holderCount,
              holderDelta: holderCount !== null && previous.length && previous.at(-1)!.holderCount !== null ? holderCount - previous.at(-1)!.holderCount! : null,
              buys5s: buys.length, sells5s: sells.length,
              buyUsd5s: buys.reduce((sum, trade) => sum + (trade.amountUsd ?? 0), 0),
              sellUsd5s: sells.reduce((sum, trade) => sum + (trade.amountUsd ?? 0), 0),
              priceUsd: lastTick?.priceUsd ?? null, top10Holders: computeTop10Holders(mint), blockingReasons: [] });
            monitoringSnapshots.set(mint, previous);
          }
          const observed = trades.get(mint) ?? [];
          for (; processedTrades < observed.length; processedTrades++) {
            const frameObservedAt = observed[processedTrades]!.observedAt;
            const frame: Trade[] = [];
            while (processedTrades < observed.length && observed[processedTrades]!.observedAt === frameObservedAt) {
              frame.push(observed[processedTrades]!);
              processedTrades++;
            }
            processedTrades--; // The for-loop advances to the first trade in the next frame.
            const tick = latestPricedTradeInFrame(frame.filter(trade => trade.observedAt >= startedAt
              && trade.observedAt <= stopAt && trade.occurredAt >= startedAt - 2_000));
            if (!tick) continue;
            if (!position) {
              if (maxPaperBuys !== null && paperBuyCount >= maxPaperBuys) continue;
              position = openSimulation(mint, tick.observedAt, tick.priceUsd, simulationStakeUsd);
              paperBuyCount++;
              peakPriceUsd = tick.priceUsd;
              writeSimulation({ type: 'SIMULATED_BUY', mint, worker: index, observedAt: tick.observedAt, entryPriceUsd: tick.priceUsd,
                stakeUsd: position.stakeUsd, quantity: position.quantity, metadata: candidates.get(mint)?.metadata ?? null,
                entryGate: { strategy: 'pump-band', initialMarketCapUsd, rangeUsd: [PUMP_BAND_RULES.minimumMarketCapUsd, PUMP_BAND_RULES.maximumMarketCapUsd],
                  detailOpenedAt: startedAt, priceSource: 'fresh token_activity pu', priceLatencyMs: tick.observedAt - startedAt },
                assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper buy on first fresh observed transaction price; no GMGN trade button clicked.' } });
              console.log('[sim-buy]', candidates.get(mint)?.metadata?.symbol ?? mint, 'price=' + tick.priceUsd);
            }
            lastTick = tick;
            // A buy cannot be followed by a paper sell inside the same
            // received frame (or the same millisecond of received frames).
            if (tick.observedAt <= position.openedAt) continue;
            peakPriceUsd = Math.max(peakPriceUsd, tick.priceUsd);
            const drawdownPercent = (tick.priceUsd / peakPriceUsd - 1) * 100;
            if (drawdownPercent <= -PUMP_BAND_RULES.dumpFromPeakPercent) {
              exitReason = 'PUMP_DUMP_20';
              writeSimulationExit(position, PAPER_LANES.control.id, mint, tick.observedAt, tick.priceUsd, exitReason, candidates.get(mint)?.metadata ?? null,
                { priceSource: 'fresh token_activity pu', priceObservedAt: tick.observedAt, peakPriceUsd, drawdownPercent });
              console.log('[sim-sell]', candidates.get(mint)?.metadata?.symbol ?? mint, exitReason, drawdownPercent.toFixed(2) + '%');
              break;
            }
          }
          if (exitReason) break;
          await delay(100);
        }
        const endedAt = Date.now();
        if (position && !exitReason) {
          const priceAgeMs = lastTick ? endedAt - lastTick.observedAt : null;
          if (lastTick && priceAgeMs !== null && priceAgeMs <= 5_000) {
            exitReason = 'PUMP_OBSERVATION_END';
            writeSimulationExit(position, PAPER_LANES.control.id, mint, endedAt, lastTick.priceUsd!, exitReason, candidates.get(mint)?.metadata ?? null,
              { priceSource: 'last token_activity pu at or before exit', priceObservedAt: lastTick.observedAt, priceAgeMs, peakPriceUsd });
            console.log('[sim-sell]', candidates.get(mint)?.metadata?.symbol ?? mint, exitReason, 'priceAgeMs=' + priceAgeMs);
          } else {
            write('events.jsonl', { type: 'SIMULATION_EXIT_UNPRICED', mint, worker: index, observedAt: endedAt, lastPriceObservedAt: lastTick?.observedAt ?? null,
              priceAgeMs, note: 'No fresh transaction price within five seconds of the exit signal; PnL is not assigned.' });
          }
        }
        if (!position) write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: endedAt,
          reason: 'NO_FRESH_PU_TICK', note: 'Detail opened but no fresh transaction-price tick arrived during observation.' });
        const candidate = candidates.get(mint);
        write('token-summary.jsonl', { mint, worker: index, startedAt, detailStartedAt: startedAt, endedAt,
          endedBecause: exitReason ?? (position ? 'EXIT_UNPRICED' : 'NO_FRESH_PU_TICK'), strategy: 'pump-band', initialMarketCapUsd,
          openingPriceUsd: position?.entryPriceUsd ?? null, finalPriceUsd: exitReason ? lastTick?.priceUsd ?? null : null,
          peakPriceUsd: peakPriceUsd || null, capturedTrades: (trades.get(mint) ?? []).length,
          capturedHolderWallets: holders.get(mint)?.size ?? 0, metadata: candidate?.metadata ?? null, fields: candidate?.fields ?? {},
          comparison: comparison(mint, endedAt), developerMonitoring: developerMonitoring(mint),
          wallets: candidate ? walletBehavior(mint, candidate) : [], monitoringTimeline: monitoringSnapshots.get(mint) ?? [] });
        monitoringSnapshots.delete(mint);
        scheduleReportRefresh();
      } catch (error) {
        write('events.jsonl', { type: 'DETAIL_ERROR', worker: index, mint, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
        console.log('[detail-error]', 'worker=' + index, mint, error instanceof Error ? error.message : error);
      } finally {
        activeMint = undefined;
        await page.goto('about:blank', { waitUntil: 'commit', timeout: config.workerTimeoutMs }).catch(() => {});
        slot.state = 'idle'; slot.mint = null;
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}
async function worker(index: number, deadline: number) {
  if (pumpBand) return pumpBandWorker(index, deadline);
  // The initial page is the screening feed. Each worker gets its own detail
  // tab, including the one-worker order-capture flow.
  let activeMint: string | undefined;
  const openDetailPage = async () => {
    const next = await context!.newPage();
    attach(next, false, () => activeMint);
    attachHolderNetworkInspector(next);
    // A replacement detail page must be visible to the operator immediately
    // after they close the prior one.
    await next.bringToFront().catch(() => {});
    return next;
  };
  let page = await openDetailPage();
  while (!stopping.signal.aborted && Date.now() < deadline) {
    if (page.isClosed()) page = await openDetailPage();
    if (maxPaperBuys !== null && !momentumComparison && paperBuyCount >= maxPaperBuys) {
      const openPositions = simulatedEvents.filter(r => r.type === 'SIMULATED_BUY').length - simulatedEvents.filter(r => r.type === 'SIMULATED_SELL').length;
      if (openPositions <= 0) {
        // Keep the detail tab on the completed token so a manual order-capture
        // session can inspect and submit its Sell before the operator stops it.
        if (values.orderCapture || browserTradingEnabled) { await delay(500); continue; }
        stopping.abort();
        break;
      }
      await delay(500);
      continue;
    }
    const mint = queue.take();
    if (!mint) { await delay(200); continue; }
    activeMint = mint; const startedAt = Date.now(), stopAt = Math.min(deadline, startedAt + detailSeconds * 1000); let openingPrice: number | null = null, stopLoss = false, operatorClosedDetail = false, simulation: SimulationPosition | null = null, simulationExit: SimulationExitReason | null = null, r5BandSimulation: SimulationPosition | null = null, r5BandExit: SimulationExitReason | null = null;
    let peakObservedPrice = 0, observationAbortedDump: ObservationDumpDecision | null = null;
    const initialTrades = trades.get(mint) ?? [];
    if (initialTrades.length) {
      const firstP = initialTrades.find(t => t.priceUsd !== null && t.priceUsd > 0)?.priceUsd;
      if (firstP) { openingPrice = firstP; peakObservedPrice = Math.max(peakObservedPrice, firstP); }
      const maxP = Math.max(0, ...initialTrades.map(t => t.priceUsd ?? 0));
      if (maxP > 0) peakObservedPrice = Math.max(peakObservedPrice, maxP);
    }
    let lastHolderCount: number | null = null, lastHolderObservedAt = 0, holderGrowthStreak = 0, lastSignificantGrowthAt = 0, recoveryHoldUntil = 0, recoveryHoldForGrowthAt = 0, targetHoldForGrowthAt = 0;
    let holderCount: number | null = typeof candidates.get(mint)?.fields.holders?.value === 'number' ? (candidates.get(mint)!.fields.holders!.value as number) : null;
    const priceSamples: { observedAt: number; priceUsd: number }[] = []; let lastEntryBlockPriceAt = 0, lastTokenStatAt = 0, lastCandlePollAt = 0, lastDeveloperHoldersAt = 0, developerHolderPollMs = 30_000, candleDecision: ReturnType<typeof assessCandleHistory> | null = null, candleEntryFlow: ReturnType<typeof assessCandleEntryFlow> | null = null, latestCandles: McapCandle[] = [], candleBlockRecorded = false, trialLimitRecorded = false, blindProtectionBlockRecorded = false, holderDistributionBlockRecorded = false, lastHolderDistributionLogAt = 0;
    let lastMonitoringSnapshotAt = 0;
    let pendingMomentumExit: ReturnType<typeof assessMomentumExit> | ReturnType<typeof assessMomentumAggressiveExit> = null;
    const momentumLaneStates = new Map<PaperLane, { position: SimulationPosition; riskState: ReturnType<typeof createMomentumPosition>; closed: boolean; whaleSellPendingAt: number | null }>();
    let lastMomentumBlockAt = 0, lastR5BandBlockAt = 0;
    let lastTrackedPollAt = Date.now(), trackedPollDelayMs = 21_000;
    // A single socket trade can make a thin launch wick below the stop.  Keep
    // the breach pending until independent socket and candle evidence agree.
    let entryCandleClose: number | null = null, hardStopPendingAt = 0, hardStopDistinctTicks = 0, hardStopLastPriceObservedAt = 0;
    let highestProfitPriceUsd = 0, lastProfitProgressAt = 0, dynamicTargetPercent = 30;
    let detailSolSpot: { usd: number; observedAt: number } | null = null;
    write('events.jsonl', { type: 'DETAIL_STARTED', worker: index, mint, startedAt });
    console.log('[detail-start]', 'worker=' + index, mint);
    try {
      await page.goto(config.tokenUrlTemplate.replaceAll('{mint}', mint), { waitUntil: 'commit', timeout: config.workerTimeoutMs });
      if (quoteSimulationEnabled) {
        try {
          detailSolSpot = await refreshSolUsd(page);
          write('sol-spot-checks.jsonl', { type: 'DETAIL_SOL_SPOT', mint, worker: index, detailStartedAt: startedAt, observedAt: detailSolSpot.observedAt, solPriceUsd: detailSolSpot.usd, execution: 'ROUTE_ONLY_NO_SUBMIT' });
        } catch (error) {
          write('sol-spot-checks.jsonl', { type: 'DETAIL_SOL_SPOT_ERROR', mint, worker: index, detailStartedAt: startedAt, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown', execution: 'ROUTE_ONLY_NO_SUBMIT' });
        }
      }
      await refreshTokenStat(page, mint, Date.now()); lastTokenStatAt = Date.now();
      await refreshTrackedHolders(page, mint, Date.now()).catch(() => {});
      const candleResult = await fetchMcapCandles(page, mint);
      latestCandles = candleResult.candles;
      candleDecision = assessCandleHistory(candleResult.candles);
      candleEntryFlow = assessCandleEntryFlow(candleResult.candles);
      entryCandleClose = candleResult.candles.at(-1)?.close ?? null;
      lastCandlePollAt = Date.now();
      const earlyMinHolders = config.earlyCandleMinimumHolders ?? 60;
      const initialEarlyRising = assessEarlyCandleRising(candleResult.candles, candleDecision, candleEntryFlow, holderCount, earlyMinHolders);
      write('mcap-candles.jsonl', { mint, observedAt: Date.now(), source: 'GMGN same-session /api/v1/token_mcap_candles', resolution: '1m', status: candleResult.status, candles: candleResult.candles, decision: candleDecision, entryFlow: candleEntryFlow, earlyRising: initialEarlyRising });
      if ((!candleDecision.allowed || !candleEntryFlow.allowed) && !initialEarlyRising.allowed) {
        console.log('[candle-buy-blocked]', mint, candleDecision.reason, candleEntryFlow.reason);
      } else if (initialEarlyRising.allowed) {
        console.log('[early-candle-rising-ok]', mint, 'return=' + (initialEarlyRising.returnPercent?.toFixed(1) ?? '0') + '%');
      }
      // In the single-candidate order-capture flow, keep the operator's
      // amount ready as soon as the detail page loads.  Momentum V2 still
      // controls the paper-entry decision; this only fills the input and
      // never submits an order.
      const buyUiPreparedOnOpen = values.prepareTradeUi && (!momentumResearch || values.orderCapture);
      if (buyUiPreparedOnOpen) {
        await prepareBuyPanel(page, mint, index, Date.now()).catch(error => {
          write('events.jsonl', { type: 'BUY_PREPARATION_ERROR', mint, worker: index, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
        });
      }
      while (!stopping.signal.aborted && Date.now() < stopAt) {
        // Closing the detail tab is the operator's explicit request to skip
        // this candidate.  Do not continue observing from cached sockets for
        // the remainder of the window.
        if (page.isClosed()) {
          operatorClosedDetail = true;
          write('events.jsonl', { type: 'OPERATOR_RELEASED_DETAIL_SLOT', mint, worker: index, observedAt: Date.now(),
            note: 'Detail tab was closed by the operator; the worker will create one replacement tab for the next candidate.' });
          console.log('[operator-released-detail-slot]', mint);
          break;
        }
        let now = Date.now();
        if (momentumResearch && now - lastTrackedPollAt >= trackedPollDelayMs) {
          const tracked = await refreshTrackedHolders(page, mint, now).catch(() => ({ status: 0 }));
          lastTrackedPollAt = Date.now(); trackedPollDelayMs = tracked.status === 429 ? 60_000 : 21_000;
        }
        if (now - lastTokenStatAt >= 5_000) { await refreshTokenStat(page, mint, now); lastTokenStatAt = Date.now(); }
        if (now - lastCandlePollAt >= 3_000) {
          const freshCandleResult = await fetchMcapCandles(page, mint);
          lastCandlePollAt = Date.now();
          if (freshCandleResult.status === 200 && freshCandleResult.candles.length) {
            latestCandles = freshCandleResult.candles;
            const prevAllowed = (candleDecision?.allowed ?? false) && (candleEntryFlow?.allowed ?? false);
            candleDecision = assessCandleHistory(freshCandleResult.candles);
            candleEntryFlow = assessCandleEntryFlow(freshCandleResult.candles);
            if (!simulation && !r5BandSimulation && ![...momentumLaneStates.values()].some(state => !state.closed)) {
              entryCandleClose = freshCandleResult.candles.at(-1)?.close ?? null;
            }
            const freshEarlyRising = assessEarlyCandleRising(freshCandleResult.candles, candleDecision, candleEntryFlow, holderCount, earlyMinHolders);
            if (!prevAllowed && ((candleDecision.allowed && candleEntryFlow.allowed) || freshEarlyRising.allowed)) {
              console.log('[candle-unblocked]', mint, 'candles=' + freshCandleResult.candles.length, freshEarlyRising.allowed ? '(early-rising)' : '');
            }
            write('mcap-candles.jsonl', { mint, observedAt: Date.now(), source: 'GMGN same-session /api/v1/token_mcap_candles', resolution: '1m', status: freshCandleResult.status, candles: freshCandleResult.candles, decision: candleDecision, entryFlow: candleEntryFlow, earlyRising: freshEarlyRising });
          } else if (freshCandleResult.status === 429) {
            lastCandlePollAt = Date.now() + 2_000;
          }
        }
        if ((simulation || r5BandSimulation || [...momentumLaneStates.values()].some(state => !state.closed)) && now - lastDeveloperHoldersAt >= developerHolderPollMs) {
          const developerSnapshot = await maybeRefreshDeveloperHolders(page, mint, now);
          if (!developerSnapshot.deferred) {
            lastDeveloperHoldersAt = Date.now(); developerHolderPollMs = developerSnapshot.status === 429 ? 60_000 : 30_000;
          }
        }
        now = Date.now();
        const candidate = candidates.get(mint);
        const lastMomentumTick = cleanTape(momentumTape.get(mint) ?? [], now).filter(t => t.priceUsd !== null && t.priceUsd > 0).at(-1);
        const price = momentumResearch ? lastMomentumTick?.priceUsd ?? null : num(candidate, 'priceUsd');
        const priceObservedAt = momentumResearch ? lastMomentumTick?.observedAt ?? 0 : candidate?.fields.priceUsd?.observedAt ?? 0;
        const holderField = candidate?.fields.holders;
        if (typeof holderField?.value === 'number') holderCount = holderField.value;
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
        if (price) peakObservedPrice = Math.max(peakObservedPrice, price);
        if (!simulation && !r5BandSimulation && ![...momentumLaneStates.values()].some(state => !state.closed)) {
          const flow = entryTradeFlow(mint, now);
          const dumpAssessment = assessObservationDump({
            currentPriceUsd: price,
            openingPriceUsd: openingPrice,
            peakPriceUsd: peakObservedPrice > 0 ? peakObservedPrice : null,
            stopLossPercent,
            candleDecision,
            candleEntryFlow,
            tradeFlow: flow,
            sampleCount: priceSamples.length,
            tradesCount: (trades.get(mint) ?? []).length,
          });
          if (dumpAssessment.shouldAbort) {
            observationAbortedDump = dumpAssessment;
            stopLoss = true;
            write('events.jsonl', {
              type: 'OBSERVATION_ABORTED_DUMP',
              mint,
              worker: index,
              observedAt: now,
              reason: dumpAssessment.reason,
              drawdownPercent: dumpAssessment.drawdownPercent,
              details: dumpAssessment.details,
              openingPriceUsd: openingPrice,
              currentPriceUsd: price,
              peakPriceUsd: peakObservedPrice,
              note: 'Auto close monitoring: Token terdeteksi dump parah saat diobservasi (belum dibeli). Slot worker dilepas lebih awal.'
            });
            console.log('[observation-aborted-dump]', candidate?.metadata?.symbol ?? mint, dumpAssessment.reason, dumpAssessment.details);
            break;
          }
        }
        if (price && (momentumResearch || !simulation) && now - priceObservedAt <= 10_000) {
          const entry = flow3 ? assessFlow3EntryStability(priceSamples) : assessEntryStability(priceSamples);
          const flow = entryTradeFlow(mint, now);
          const flowAllowed = flow.trades >= 5 && flow.buyUsd >= flow.sellUsd;
          const freshSignificantGrowth = lastSignificantGrowthAt > 0 && now - lastSignificantGrowthAt <= 5_000;
          const singleCandleOverride = assessSingleCandleHolderOverride(candleDecision, holderCount, freshSignificantGrowth);
          const earlyCandleRising = assessEarlyCandleRising(latestCandles, candleDecision, candleEntryFlow, holderCount, earlyMinHolders);

          const candidateCreatedAt = candidate?.fields.createdAt?.value ? Number(candidate.fields.createdAt.value) : null;
          const isYoungToken = (candleDecision?.reason === 'INSUFFICIENT_CANDLES' || candleDecision?.reason === 'SINGLE_CANDLE_ONLY')
            || singleCandleOverride.allowed
            || earlyCandleRising.allowed
            || (candidateCreatedAt !== null ? (now - candidateCreatedAt <= 120_000) : false);

          // The holder gate is checked before any paper BUY. It requires a
          // recent full untagged list AND a separate recent tag=dev response.
          // The dev-tag list supplies developer evidence only; it cannot ever
          // become the Top-1 distribution source.
          if (momentumAggressive) {
            const devStatus = developerHolderApiStatus.get(mint);
            if (!devStatus || now - devStatus.observedAt > MOMENTUM_RULES.holderEvidenceMaxAgeMs) {
              const refreshed = await maybeRefreshDeveloperHolders(page, mint, now);
              if (!refreshed.deferred) lastDeveloperHoldersAt = Date.now();
              now = Date.now();
            }
          }
          const tokenHoldersMap = trackedHolders.get(mint);
          const currentHolderCount = tokenHoldersMap?.size ?? 0;
          const currentHolderStatus = holderApiStatus.get(mint)?.status ?? null;
          const ownerStatus = holderApiStatus.get(mint);
          const verifiedStatus = momentumResearch && (!ownerStatus || now - ownerStatus.observedAt > MOMENTUM_RULES.holderEvidenceMaxAgeMs) ? null : currentHolderStatus;
          const blindProtection = assessBlindProtection(momentumResearch || isYoungToken, verifiedStatus, currentHolderCount);

          // Calculate holder distribution metrics (Top 1, Top 5, Dev) excluding liquidity pool / bonding curve
          let top1Pct = 0, top5Pct = 0, devHoldingPct = 0;
          if (tokenHoldersMap && tokenHoldersMap.size > 0) {
            const userHolders = Array.from(tokenHoldersMap.values())
              .filter(h => h.raw?.addr_type !== 2 && !h.raw?.exchange && !h.walletTagV2?.toLowerCase().includes('lp'));
            const sortedHolders = userHolders.sort((a, b) => (b.amountPercentage ?? 0) - (a.amountPercentage ?? 0));
            top1Pct = sortedHolders[0]?.amountPercentage ?? 0;
            top5Pct = sortedHolders.slice(0, 5).reduce((acc, h) => acc + (h.amountPercentage ?? 0), 0);
            devHoldingPct = userHolders.filter(h => h.isDev).reduce((acc, h) => acc + (h.amountPercentage ?? 0), 0);
          } else {
            const tokenTrades = trades.get(mint) ?? [];
            if (tokenTrades.length > 0) {
              const netTokens = new Map<string, number>();
              for (const tr of tokenTrades) {
                const ba = Number(tr.raw?.ba ?? 0);
                const cur = netTokens.get(tr.wallet ?? '') ?? 0;
                if (tr.side === 'buy') netTokens.set(tr.wallet ?? '', cur + ba);
                else netTokens.set(tr.wallet ?? '', Math.max(0, cur - ba));
              }
              const active = Array.from(netTokens.values()).filter(v => v > 0).sort((a, b) => b - a);
              const totalCirc = active.reduce((acc, v) => acc + v, 0);
              if (totalCirc > 0) {
                top1Pct = (active[0] ?? 0) / totalCirc * 100;
                top5Pct = active.slice(0, 5).reduce((acc, v) => acc + v, 0) / totalCirc * 100;
              }
            }
          }

          const effectiveHolderCount = Math.max(holderCount ?? 0, currentHolderCount);
          const holderDistribution = assessHolderDistribution(effectiveHolderCount, top1Pct, top5Pct, devHoldingPct);
          const strictHolderPreBuy = assessPreBuyHolderGate({
            now,
            holders: tokenHoldersMap?.values(),
            holderStatus: ownerStatus,
            developerStatus: developerHolderApiStatus.get(mint),
            maximumAgeMs: MOMENTUM_RULES.holderEvidenceMaxAgeMs,
            maximumTop1Percent: 50,
          });

          if (!simulation && !holderDistribution.allowed && holderDistribution.action === 'WAIT_FOR_DILUTION' && now - lastHolderDistributionLogAt >= 10_000) {
            lastHolderDistributionLogAt = now;
            console.log('[holder-wait-dilution]', candidate?.metadata?.symbol ?? mint, holderDistribution.reason);
          } else if (!simulation && !holderDistribution.allowed && holderDistribution.action === 'REJECT' && now - lastHolderDistributionLogAt >= 10_000) {
            lastHolderDistributionLogAt = now;
            console.log('[holder-rejected-dominated]', candidate?.metadata?.symbol ?? mint, holderDistribution.reason);
          }

          // Flow-3 temporarily allows a two-candle history.  A live red candle
          // still blocks entry, while a one-candle launch remains insufficient.
          const flow3TwoCandleGrace = flow3
            && candleDecision?.reason === 'INSUFFICIENT_CANDLES'
            && candleEntryFlow?.reason !== 'CURRENT_CANDLE_DROP';
          const candleAllowed = flow3TwoCandleGrace || ((candleDecision?.allowed && candleEntryFlow?.allowed)
            || singleCandleOverride.allowed
            || earlyCandleRising.allowed);

          const momentumEntry = (momentumV2 || momentumV3) ? assessMomentumEntry(momentumTape.get(mint) ?? [], totalHolderSamples.get(mint) ?? [], now, isYoungToken) : null;
          const momentumAggressiveEntry = momentumAggressive ? assessMomentumAggressiveEntry(momentumTape.get(mint) ?? [], now) : null;
          const r5BandEntry = r5BandEnabled ? assessMomentumEntry(momentumTape.get(mint) ?? [], totalHolderSamples.get(mint) ?? [], now, isYoungToken, MOMENTUM_R5_BAND) : null;
          // Flow-3 uses the historical entry contract: stable live price,
          // safe candle history, and net-positive 20-second buy flow.  Holder
          // distribution and the later blind-protection gate were not part of
          // that experiment, so retaining them would not reproduce its cohort.
          const baseBuyAllowed = flow3
            ? entry.stable && candleAllowed && flowAllowed
            : entry.stable && candleAllowed && flowAllowed && blindProtection.allowed && holderDistribution.allowed;
          const momentumV3Entry = momentumV3 && momentumEntry ? assessMomentumV3Entry({
            momentumReasons: momentumEntry.reasons,
            candleAllowed,
            candleReason: candleDecision?.reason ?? candleEntryFlow?.reason ?? null,
            blindProtectionAllowed: blindProtection.allowed,
            blindProtectionReason: blindProtection.reason,
            holderDistributionAllowed: holderDistribution.allowed,
            holderDistributionReason: holderDistribution.reason,
            entryStable: entry.stable,
            entryReason: entry.reason,
            flowAllowed,
            candleEntryFlowReason: candleEntryFlow?.reason ?? null,
            flowSellUsdDominant: flow.sellUsd > flow.buyUsd,
          }) : null;
          // Browser prompt testing intentionally uses only live, easily
          // observable evidence. It never changes the regular V2 or paper
          // simulation rules unless the explicit test flag is supplied.
          const newestCandle = latestCandles.at(-1);
          const candleRisingForPromptTest = Boolean(newestCandle && newestCandle.close > newestCandle.open);
          const socketTrades5s = (trades.get(mint) ?? []).filter(t => t.occurredAt >= now - 5_000 && t.occurredAt <= now);
          const socketBuys5s = socketTrades5s.filter(t => t.side === 'buy').length;
          const socketSells5s = socketTrades5s.filter(t => t.side === 'sell').length;
          const socketBuySurgeForPromptTest = socketBuys5s >= 3 && socketBuys5s > socketSells5s;
          const browserPromptTestReason = values.browserPromptTestSignal
            ? candleRisingForPromptTest ? 'BROWSER_TEST_CANDLE_UP'
              : socketBuySurgeForPromptTest ? 'BROWSER_TEST_SOCKET_BUY_SURGE'
                : null
            : null;
          const v2ControlBuyAllowed = momentumV2 && (browserPromptTestReason !== null || (baseBuyAllowed && (momentumEntry?.allowed ?? true)));
          const v3ControlBuyAllowed = momentumV3 && (momentumV3Entry?.allowed ?? false);
          const candidateMC = num(candidate, 'marketCapUsd');
          const aggressiveMcAllowed = candidateMC === null || (candidateMC >= MOMENTUM_AGGRESSIVE_RULES.minMarketCap && candidateMC <= MOMENTUM_AGGRESSIVE_RULES.maxMarketCap);
          const aggressiveControlBuyAllowed = momentumAggressive
            && (momentumAggressiveEntry?.allowed ?? false)
            && aggressiveMcAllowed;
          const r5BandBuyAllowed = r5BandEnabled && baseBuyAllowed && (r5BandEntry?.allowed ?? false);
          const laneAtPaperLimit = (paperLane: PaperLane) => maxPaperBuys !== null && simulatedEvents.filter(event => event.type === 'SIMULATED_BUY' && event.paperLane === paperLane).length >= maxPaperBuys;
          const canOpenControl = (v2ControlBuyAllowed || aggressiveControlBuyAllowed) && !simulation && !laneAtPaperLimit(PAPER_LANES.control.id);
          const canOpenV3 = v3ControlBuyAllowed && !momentumLaneStates.has(v3PaperLane) && !laneAtPaperLimit(v3PaperLane);
          const canOpenV3ExitConfirmed = momentumComparison && v3ControlBuyAllowed
            && !momentumLaneStates.has(PAPER_LANES.v3ExitConfirmed.id)
            && !laneAtPaperLimit(PAPER_LANES.v3ExitConfirmed.id);
          // The variant may enter later than control when R5 first reaches its
          // band. It never opens a browser trade control or changes control's
          // position state.
          const canOpenR5Band = r5BandBuyAllowed && !r5BandSimulation
            && (maxPaperBuys === null || paperBuyCount < maxPaperBuys || canOpenControl);

          if (canOpenControl || canOpenV3 || canOpenR5Band) {
            const effectiveStakeUsd = simulationStakeSol !== null
              ? Number((simulationStakeSol * (solSpotCache?.usd ?? 150)).toFixed(4))
              : simulationStakeUsd;
            const entryDecisionAt = momentumResearch ? Date.now() : now;
            const openMomentumLane = (paperLane: PaperLane, entryGate: any, entryReason?: string) => {
              const paperPosition = openSimulation(mint, entryDecisionAt, price, effectiveStakeUsd);
              const entrySignal = paperSignal({
                side: 'BUY', paperLane, runId, mint, positionId: `${mint}:${paperPosition.openedAt}:${paperLane}`, worker: index,
                reason: entryReason ?? (paperLane === PAPER_LANES.r5Band.id
                  ? 'MOMENTUM_V2_R5_BAND_ENTRY_PASSED'
                  : paperLane === v3PaperLane && !momentumV2
                    ? 'MOMENTUM_V3_ENTRY_PASSED'
                    : paperLane === PAPER_LANES.v3.id
                      ? 'MOMENTUM_V3_ENTRY_PASSED'
                      : momentumAggressive
                        ? 'MOMENTUM_AGGRESSIVE_ENTRY_PASSED'
                        : 'MOMENTUM_V2_ENTRY_PASSED'),
                marketTradeAt: lastMomentumTick?.occurredAt ?? null, priceReceivedAt: lastMomentumTick?.observedAt ?? priceObservedAt,
                decisionAt: entryDecisionAt, paperRecordedAt: Date.now(), priceUsd: price,
              });
              write('trade-signals.jsonl', entrySignal); schedulePaperOrder(entrySignal); scheduleSimulatedOrder(entrySignal, paperPosition.stakeUsd);
              scheduleBuyRouteComparison(page, entrySignal, paperPosition.stakeUsd, detailSolSpot);
              void promptAndSubmitBrowserBuy(page, entrySignal, paperPosition.stakeUsd, price, num(candidate, 'marketCapUsd')).catch(error => {
                write('events.jsonl', { type: 'BROWSER_BUY_ERROR', mint, observedAt: Date.now(), signalId: entrySignal.signalId, message: error instanceof Error ? error.message : 'unknown' });
              });
              const riskState = createMomentumPosition(entryDecisionAt, price, lastMomentumTick?.occurredAt ?? entryDecisionAt);
              momentumLaneStates.set(paperLane, { position: paperPosition, riskState, closed: false, whaleSellPendingAt: null });
              writeSimulation({ type: 'SIMULATED_BUY', paperLane, mint, worker: index, observedAt: entryDecisionAt, timing: entrySignal, positionId: entrySignal.positionId,
                entryPriceUsd: price, stakeUsd: paperPosition.stakeUsd, quantity: paperPosition.quantity,
                entryGate: { momentum: entryGate, aggressive: momentumAggressive ? momentumAggressiveEntry : null, strictHolderPreBuy: momentumAggressive ? strictHolderPreBuy : null, v3: (paperLane === v3PaperLane || paperLane === PAPER_LANES.v3ExitConfirmed.id) ? momentumV3Entry : null, realtime: entry, candleHistory: candleDecision, candleEntryFlow, earlyCandleRising, singleCandleOverride, blindProtection, holderDistribution, tradeFlow20s: flow }, metadata: candidate?.metadata ?? null,
                assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper lane only; no GMGN order is submitted.' } });
              return paperPosition;
            };
            if (momentumResearch) {
              if (canOpenControl) {
                paperBuyCount++;
                simulation = openMomentumLane(
                  PAPER_LANES.control.id,
                  momentumAggressive ? momentumAggressiveEntry : momentumEntry,
                  browserPromptTestReason ?? (momentumAggressive ? 'MOMENTUM_AGGRESSIVE_ENTRY_PASSED' : undefined)
                );
              }
              if (canOpenV3) {
                if (!canOpenControl) paperBuyCount++;
                openMomentumLane(v3PaperLane, momentumEntry, 'MOMENTUM_V3_ENTRY_PASSED');
              }
              if (canOpenV3ExitConfirmed) openMomentumLane(PAPER_LANES.v3ExitConfirmed.id, momentumEntry, 'MOMENTUM_V3_ENTRY_PASSED');
              if (canOpenR5Band) r5BandSimulation = openMomentumLane(PAPER_LANES.r5Band.id, r5BandEntry);
              if (!paperRiskListeners.has(mint)) paperRiskListeners.set(mint, tick => {
                for (const [paperLane, state] of momentumLaneStates) {
                  if (state.closed) continue;
                  if (browserTradingEnabled && paperLane === PAPER_LANES.control.id) {
                    const livePosition = liveBrowserPositions.get(mint);
                    if (!livePosition) {
                      if (!browserSellDeferredBeforeBuy.has(mint)) {
                        browserSellDeferredBeforeBuy.add(mint);
                        write('events.jsonl', { type: 'BROWSER_SELL_DEFERRED', mint, observedAt: tick.observedAt, reason: 'WAITING_FOR_BROWSER_BUY_SUBMISSION' });
                      }
                      continue;
                    }
                    if (state.riskState.openedAt < livePosition.confirmedAt) {
                      state.riskState = createMomentumPosition(livePosition.confirmedAt, livePosition.entryPriceUsd, tick.occurredAt);
                      browserSellDeferredBeforeBuy.delete(mint);
                      write('events.jsonl', { type: 'BROWSER_SELL_ARMED', mint, observedAt: tick.observedAt, buyConfirmedAt: livePosition.confirmedAt, entryPriceUsd: livePosition.entryPriceUsd });
                      continue;
                    }
                  }
                  const decision = momentumAggressive
                    ? assessMomentumAggressiveExit(state.riskState, tick, momentumTape.get(mint) ?? [])
                    : assessMomentumExit(state.riskState, tick, momentumTape.get(mint) ?? [], totalHolderSamples.get(mint) ?? [], ownerEvidence(mint));
                  if (!decision) continue;
                  if (decision.reason || tick.observedAt - lastMonitoringSnapshotAt >= 5_000) {
                    lastMonitoringSnapshotAt = tick.observedAt;
                    write('momentum-decisions.jsonl', { mint, paperLane, ...decision });
                  }
                  if (!decision.reason) continue;
                  let exitReason: SimulationExitReason | null = decision.reason;
                  let customExitPolicy: Record<string, unknown> | null = null;
                  // This lane has the identical V3 entry as the normal V3 lane.
                  // Only its exit differs: a non-dev whale sell exits immediately
                  // when underwater/unsupported, while a profitable, supported
                  // position may wait for two bearish confirmations after 5 seconds.
                  if (paperLane === PAPER_LANES.v3ExitConfirmed.id) {
                    const holderDelta = decision.holders.steps.reduce((total, step) => total + step.delta, 0);
                    const sellUsd = decision.metrics.sellUsd ?? 0;
                    const buyUsd = decision.metrics.buyUsd ?? 0;
                    const sellDominant = sellUsd >= Math.max(1, buyUsd) * 1.5;
                    const priceFalling = (decision.metrics.return5s ?? 0) <= -2;
                    const holdersWeak = holderDelta <= 0;
                    const confirmations = Number(sellDominant) + Number(priceFalling) + Number(holdersWeak);

                    if (decision.reason === 'V2_MAJOR_HOLDER_SELL' && !decision.majorSell?.isDev) {
                      const profitableAtWhaleSignal = decision.returnPercent > 0;
                      const flowAndHoldersSupportHold = buyUsd > sellUsd && holderDelta > 0;
                      if (!profitableAtWhaleSignal || !flowAndHoldersSupportHold) {
                        exitReason = 'V3_EXIT_IMMEDIATE_WHALE_SELL';
                        customExitPolicy = { immediate: true, returnPercent: decision.returnPercent, profitableAtWhaleSignal, flowAndHoldersSupportHold, holderDelta, buyUsd, sellUsd, sellerWallet: decision.majorSell?.wallet ?? null, tradeUsd: decision.majorSell?.usd ?? null };
                      } else if (state.whaleSellPendingAt === null) {
                        state.whaleSellPendingAt = tick.observedAt;
                        state.riskState.closed = false;
                        write('events.jsonl', { type: 'V3_WHALE_SELL_PENDING', paperLane, mint, worker: index, observedAt: tick.observedAt,
                          sellerWallet: decision.majorSell?.wallet ?? null, tradeUsd: decision.majorSell?.usd ?? null,
                          pendingUntil: tick.observedAt + 5_000, sellDominant, priceFalling, holdersWeak, holderDelta, returnPercent: decision.returnPercent,
                          note: 'Profitable, supported position: non-dev whale sell is being confirmed for 5 seconds before the V3 exit lane closes.' });
                        continue;
                      } else if (tick.observedAt - state.whaleSellPendingAt < 5_000) {
                        state.riskState.closed = false;
                        continue;
                      } else if (confirmations >= 2) {
                        exitReason = 'V3_EXIT_CONFIRMED_WHALE_SELL';
                        customExitPolicy = { pendingMs: tick.observedAt - state.whaleSellPendingAt, confirmations, sellDominant, priceFalling, holdersWeak, holderDelta, buyUsd, sellUsd };
                      } else {
                        write('events.jsonl', { type: 'V3_WHALE_SELL_CANCELLED', paperLane, mint, worker: index, observedAt: tick.observedAt,
                          pendingMs: tick.observedAt - state.whaleSellPendingAt, confirmations, sellDominant, priceFalling, holdersWeak, holderDelta,
                          note: 'Whale sell did not receive two bearish confirmations; the V3 confirmed-exit lane keeps holding.' });
                        state.whaleSellPendingAt = null;
                        state.riskState.closed = false;
                        continue;
                      }
                    } else if (decision.reason === 'V2_MAJOR_HOLDER_SELL' && decision.majorSell?.isDev) {
                      exitReason = 'V3_EXIT_DEV_DUMP';
                      customExitPolicy = { immediate: true, sellerWallet: decision.majorSell.wallet, tradeUsd: decision.majorSell.usd };
                    } else if (decision.reason === 'V2_PROFIT_LOCK') {
                      const bullishProfit = buyUsd > sellUsd && holderDelta > 0 && (decision.metrics.return5s ?? 0) > 0;
                      if (bullishProfit && decision.drawdownPercent < 5) {
                        state.riskState.closed = false;
                        write('events.jsonl', { type: 'V3_PROFIT_LOCK_HELD', paperLane, mint, worker: index, observedAt: tick.observedAt,
                          returnPercent: decision.returnPercent, drawdownPercent: decision.drawdownPercent, holderDelta, buyUsd, sellUsd,
                          note: 'Profit lock deferred: buy flow, holder growth, and 5-second price momentum are all still positive.' });
                        continue;
                      }
                      if (bullishProfit) {
                        exitReason = 'V3_EXIT_PROFIT_TRAIL';
                        customExitPolicy = { trailingDrawdownPercent: decision.drawdownPercent, holderDelta, buyUsd, sellUsd };
                      }
                    }
                  }
                  if (!exitReason) continue;
                  state.closed = true;
                  if (paperLane === PAPER_LANES.control.id) { simulationExit = exitReason; pendingMomentumExit = decision; }
                  else if (paperLane === PAPER_LANES.r5Band.id) r5BandExit = exitReason;
                  const exitDecisionAt = Date.now();
                  const exitSignal = paperSignal({ side: 'SELL', paperLane, runId, mint, positionId: `${mint}:${state.position.openedAt}:${paperLane}`, worker: index,
                    reason: exitReason, marketTradeAt: tick.occurredAt, priceReceivedAt: tick.observedAt,
                    decisionAt: exitDecisionAt, paperRecordedAt: Date.now(), priceUsd: decision.priceUsd });
                  write('trade-signals.jsonl', exitSignal); schedulePaperOrder(exitSignal); scheduleSimulatedOrder(exitSignal, state.position.stakeUsd);
                  scheduleSellRouteComparison(page, exitSignal);
                  void promptAndSubmitBrowserSell(page, exitSignal, decision.priceUsd, num(candidates.get(mint), 'marketCapUsd')).catch(error => {
                    write('events.jsonl', { type: 'BROWSER_SELL_ERROR', mint, observedAt: Date.now(), signalId: exitSignal.signalId, message: error instanceof Error ? error.message : 'unknown' });
                  });
                  writeSimulationExit(state.position, paperLane, mint, exitDecisionAt, decision.priceUsd, exitReason, candidates.get(mint)?.metadata ?? null, { ...decision, reason: exitReason, customExitPolicy }, exitSignal);
                }
              });
            } else if (canOpenControl) {
              paperBuyCount++; simulation = openSimulation(mint, entryDecisionAt, price, effectiveStakeUsd);
            }
            highestProfitPriceUsd = price;
            lastProfitProgressAt = now;
            dynamicTargetPercent = 30;
            const developerSnapshot = momentumResearch ? { deferred: true, status: null } : await maybeRefreshDeveloperHolders(page, mint, now);
            if (!developerSnapshot.deferred) {
              lastDeveloperHoldersAt = Date.now(); developerHolderPollMs = developerSnapshot.status === 429 ? 60_000 : 30_000;
            }
            // Normalize the market-cap candle to the socket price at entry.
            // This lets the current candle confirm a later socket stop without
            // assuming a fixed token supply.
            if (!entryCandleClose || entryCandleClose <= 0) entryCandleClose = null;
            if (!momentumResearch && simulation) writeSimulation({ type: 'SIMULATED_BUY', paperLane: PAPER_LANES.control.id, mint, worker: index, observedAt: entryDecisionAt,
              entryPriceUsd: price, stakeUsd: simulation.stakeUsd, quantity: simulation.quantity,
              entryGate: { momentum: momentumEntry, realtime: entry, candleHistory: candleDecision, candleEntryFlow, earlyCandleRising, singleCandleOverride, blindProtection, holderDistribution, tradeFlow20s: flow }, metadata: candidate?.metadata ?? null, assumptions: { feeUsd: 0, slippagePercent: 0, note: autoBuyEnabled ? 'Paper simulation with real GMGN UI Buy button click.' : 'Paper simulation (real UI Buy button click disabled by autoBuy=false).' } });
            if (values.prepareTradeUi && !buyUiPreparedOnOpen && !flow3 && !browserTradingEnabled) {
              await prepareBuyPanel(page, mint, index, now).catch(error => {
                write('events.jsonl', { type: 'BUY_PREPARATION_ERROR', mint, worker: index, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
              });
              if (autoBuyEnabled) {
                await clickTradeButton(page, 'buy').then(res => {
                  write('events.jsonl', { type: 'BUY_BUTTON_CLICKED', mint, worker: index, observedAt: Date.now(), buttonText: res.buttonText });
                  console.log('[buy-clicked]', candidate?.metadata?.symbol ?? mint, res.buttonText);
                }).catch(error => {
                  write('events.jsonl', { type: 'BUY_CLICK_ERROR', mint, worker: index, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
                  console.log('[buy-click-error]', candidate?.metadata?.symbol ?? mint, error instanceof Error ? error.message : error);
                });
              } else {
                write('events.jsonl', { type: 'BUY_BUTTON_CLICK_SKIPPED', mint, worker: index, observedAt: Date.now(), note: 'autoBuy is false; real Playwright buy button click skipped while paper simulation runs.' });
                console.log('[paper-only]', candidate?.metadata?.symbol ?? mint, 'Simulated buy opened; real UI buy click skipped (autoBuy=false)');
              }
            }
            console.log('[sim-buy]', candidate?.metadata?.symbol ?? mint, 'lanes=' + [canOpenControl && PAPER_LANES.control.id, canOpenV3 && v3PaperLane, canOpenV3ExitConfirmed && PAPER_LANES.v3ExitConfirmed.id, canOpenR5Band && PAPER_LANES.r5Band.id].filter(Boolean).join(','), 'stake=$' + effectiveStakeUsd, 'price=' + price, earlyCandleRising.allowed ? '(early-candle-rising)' : '');
          } else if (maxPaperBuys !== null && (v2ControlBuyAllowed || v3ControlBuyAllowed) && !trialLimitRecorded) {
            trialLimitRecorded = true;
            write('events.jsonl', { type: 'SIMULATION_BUY_SKIPPED_TRIAL_LIMIT', mint, worker: index, observedAt: now, maxPaperBuys, paperBuyCount,
              note: 'All entry gates passed, but the non-submitting paper-buy trial has already prepared its maximum number of candidates.' });
            console.log('[sim-buy-skipped]', candidate?.metadata?.symbol ?? mint, 'TRIAL_LIMIT=' + maxPaperBuys);
          } else if (momentumAggressive && !aggressiveMcAllowed && now - lastMomentumBlockAt >= 5_000) {
            lastMomentumBlockAt = now;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price,
              reason: 'MC_OUTSIDE_SWEET_SPOT', aggressive: momentumAggressiveEntry, candidateMC,
              note: `Aggressive Flow: Market cap ($${candidateMC}) di luar sweet spot ($5.5k - $15k).` });
            console.log('[sim-buy-blocked]', candidate?.metadata?.symbol ?? mint, 'MC_OUTSIDE_SWEET_SPOT', candidateMC);
          } else if (momentumAggressive && momentumAggressiveEntry && !momentumAggressiveEntry.allowed && now - lastMomentumBlockAt >= 5_000) {
            lastMomentumBlockAt = now;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price,
              reason: momentumAggressiveEntry.reasons.join(', '), aggressive: momentumAggressiveEntry });
            console.log('[sim-buy-blocked]', candidate?.metadata?.symbol ?? mint, momentumAggressiveEntry.reasons.join(', '));
          } else if (momentumV3 && momentumV3Entry && !momentumV3Entry.allowed && now - lastMomentumBlockAt >= 5_000) {
            lastMomentumBlockAt = now;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price,
              reason: momentumV3Entry.blockingReasons.join(', '), momentum: momentumEntry, v3: momentumV3Entry,
              note: `Momentum V3 requires ${MOMENTUM_V3_RULES.minimumPassedValidations}/${MOMENTUM_V3_RULES.totalValidations} validations and no V3 hard rejection.` });
          } else if (momentumV2 && momentumEntry && !momentumEntry.allowed && now - lastMomentumBlockAt >= 5_000) {
            lastMomentumBlockAt = now;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, reason: momentumEntry.reasons.join(', '), momentum: momentumEntry });
          } else if (!flow3 && !blindProtection.allowed && !blindProtectionBlockRecorded) {
            blindProtectionBlockRecorded = true;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, reason: blindProtection.reason, holderStatus: blindProtection.holderStatus, holderCount: blindProtection.holderCount, isYoungToken, candleDecision, earlyCandleRising, singleCandleOverride, note: 'Blind Protection: DILARANG BUY pada token umur muda (candle 1-2) karena API holder terkena 429 atau top holder belum terverifikasi.' });
            console.log(`[blind-protection-blocked] ${candidate?.metadata?.symbol ?? mint} ${blindProtection.reason} (status=${blindProtection.holderStatus}, holders=${blindProtection.holderCount})`);
          } else if (!flow3 && !holderDistribution.allowed && !holderDistributionBlockRecorded) {
            holderDistributionBlockRecorded = true;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, reason: holderDistribution.reason, action: holderDistribution.action, holderCount: holderDistribution.holderCount, top1Percent: holderDistribution.top1Percent, top5Percent: holderDistribution.top5Percent, note: `Holder Distribution: ${holderDistribution.reason}` });
          } else if (!candleAllowed && !candleBlockRecorded) {
            candleBlockRecorded = true;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, candleDecision, candleEntryFlow, earlyCandleRising, singleCandleOverride, note: 'No paper buy: closed-candle count or current 1-minute candle is unsafe.' });
          } else if ((entry.reason === 'CONTINUING_PRICE_DROP' || entry.reason === 'INSUFFICIENT_PRICE_CONFIRMATION') && lastEntryBlockPriceAt !== priceObservedAt) {
            lastEntryBlockPriceAt = priceObservedAt;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, entryGate: entry, tradeFlow20s: flow, note: entry.reason === 'INSUFFICIENT_PRICE_CONFIRMATION' ? 'No paper buy: price ticks did not show a real recovery.' : 'No paper buy: detail price is still falling.' });
            console.log('[sim-buy-blocked]', candidate?.metadata?.symbol ?? mint, entry.reason, entry.momentum5sPercent);
          } else if (!flowAllowed && lastEntryBlockPriceAt !== priceObservedAt) {
            lastEntryBlockPriceAt = priceObservedAt;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', mint, worker: index, observedAt: now, priceUsd: price, tradeFlow20s: flow, note: 'No paper buy: the last 20 seconds lack at least 5 trades with buy USD at least sell USD.' });
          }
          if (momentumV2 && !r5BandSimulation && baseBuyAllowed && r5BandEntry && !r5BandEntry.allowed && now - lastR5BandBlockAt >= 5_000) {
            lastR5BandBlockAt = now;
            write('events.jsonl', { type: 'SIMULATION_BUY_BLOCKED', paperLane: PAPER_LANES.r5Band.id, mint, worker: index, observedAt: now, priceUsd: price,
              reason: r5BandEntry.reasons.join(', '), momentum: r5BandEntry,
              note: 'R5-band paper lane stays in observation until all existing V2 gates and 5% <= return5s < 10% pass together.' });
          }

          // Rekam snapshot monitoring setiap 5 detik selagi belum beli
          if (now - lastMonitoringSnapshotAt >= 5_000) {
            lastMonitoringSnapshotAt = now;
            const prevSnaps = monitoringSnapshots.get(mint) ?? [];
            const prevSnap = prevSnaps.at(-1);
            const holderDelta = prevSnap?.holderCount != null && holderCount != null ? holderCount - prevSnap.holderCount : null;
            const tokenTrades5s = (trades.get(mint) ?? []).filter(t => t.occurredAt >= now - 5_000 && t.occurredAt <= now);
            const buys5s = tokenTrades5s.filter(t => t.side === 'buy').length;
            const sells5s = tokenTrades5s.filter(t => t.side === 'sell').length;
            const buyUsd5s = tokenTrades5s.filter(t => t.side === 'buy').reduce((s, t) => s + (t.amount ?? 0), 0);
            const sellUsd5s = tokenTrades5s.filter(t => t.side === 'sell').reduce((s, t) => s + (t.amount ?? 0), 0);
            // Kumpulkan alasan buy belum terjadi
            const blockReasons: string[] = [];
            if (!candleAllowed) blockReasons.push('CANDLE:' + (candleDecision?.reason ?? candleEntryFlow?.reason ?? 'UNKNOWN'));
            if (!flow3 && !blindProtection.allowed) blockReasons.push('BLIND_PROTECTION:' + blindProtection.reason);
            if (!flow3 && !holderDistribution.allowed) blockReasons.push('HOLDER_DIST:' + holderDistribution.reason + (holderDistribution.action ? ':' + holderDistribution.action : ''));
            if (!entry.stable) blockReasons.push('ENTRY:' + (entry.reason ?? 'UNSTABLE'));
            if (!flowAllowed) blockReasons.push('FLOW:INSUFFICIENT_BUY_PRESSURE');
            if (momentumEntry && !momentumEntry.allowed) blockReasons.push(...momentumEntry.reasons);
            const snap: MonitoringSnapshot = { observedAt: now, holderCount, holderDelta, buys5s, sells5s, buyUsd5s, sellUsd5s, priceUsd: price ?? null, top10Holders: computeTop10Holders(mint), blockingReasons: blockReasons };
            prevSnaps.push(snap);
            monitoringSnapshots.set(mint, prevSnaps);
          }
        }
        if (momentumV2 && pendingMomentumExit && r5BandSimulation && r5BandExit) {
          const exit = pendingMomentumExit as NonNullable<ReturnType<typeof assessMomentumExit>>;
          if (values.prepareTradeUi && exit.reason) await prepareSellPanel(page, mint, index, exit.observedAt, exit.reason).catch(error => {
            write('events.jsonl', { type: 'SELL_PREPARATION_ERROR', mint, observedAt: Date.now(), message: String(error) });
          });
          if (exitHoldSeconds > 0) await delay(exitHoldSeconds * 1000);
          break;
        }
        if (!momentumResearch && price && simulation && now - priceObservedAt <= 10_000) {
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
          const decision = flow3
            ? assessFlow3Simulation(simulation, price, trades5s, { suppressSellPressure: now < recoveryHoldUntil, deferTargetForHolderMomentum: targetMomentumHold })
            : assessSimulation(simulation, price, trades5s, { suppressSellPressure: now < recoveryHoldUntil, deferTargetForHolderMomentum: targetMomentumHold, suppressHardStop: true });
          let exitReason = decision.exitReason;
          let hardStopValidation: Record<string, unknown> | null = null;
          if (!flow3) {
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
          // DYNAMIC TARGET ADAPTATION:
          // 1. Jika hijau terus, momentum 5s kuat (>= 2%), holder terus bertambah, dan transaksi buy ramai:
          //    Naikkan target sedikit demi sedikit (+30% -> +40% -> +50% -> +60% dst.)
          const strongMomentum5s = (priceMomentum5s ?? 0) >= 2;
          const activeBuying5s = trades5s.buys >= 3 && trades5s.buyUsd >= trades5s.sellUsd;
          if (returnPercent >= dynamicTargetPercent - 10 && strongMomentum5s && (freshSignificantGrowth || sustainedHolderGrowth) && activeBuying5s) {
            const nextTarget = Math.max(dynamicTargetPercent + 10, Math.floor(returnPercent / 10) * 10 + 10);
            if (nextTarget > dynamicTargetPercent) {
              console.log('[sim-target-raised]', candidate?.metadata?.symbol ?? mint, `target=${dynamicTargetPercent}%->${nextTarget}%`, `return=+${returnPercent.toFixed(1)}%`);
              dynamicTargetPercent = nextTarget;
            }
          }

          // 2. TOP HOLDER, DEV & WHALE DUMP DETECTOR:
          // Jika DEV, Top Holder (pemegang >= topHolderDumpMinPercent, default 1.5%), atau Whale sell (>= $150 / 5M tokens) menjual koin
          // SETELAH posisi dibuka (t.occurredAt >= simulation.openedAt), dan harga mulai melemah / minus, langsung auto-sell seketika!
          const tokenHolders = trackedHolders.get(mint);
          if (!exitReason) {
            const recentSells = (trades.get(mint) ?? []).filter(t => t.occurredAt >= simulation!.openedAt && t.occurredAt >= now - 5_000 && t.side === 'sell');
            for (const sellTrade of recentSells) {
              if (!sellTrade.wallet) continue;
              const holder = tokenHolders?.get(sellTrade.wallet);
              const isDevSell = holder ? holder.isDev : false;
              const isTopHolderSell = holder ? ((holder.amountPercentage ?? 0) >= topHolderDumpMinPercent) : false;
              const isWhaleSell = (sellTrade.amountUsd !== null && sellTrade.amountUsd !== undefined && sellTrade.amountUsd >= 150)
                || (sellTrade.amount !== null && sellTrade.amount !== undefined && sellTrade.amount >= 5_000_000);

              if (isDevSell || isTopHolderSell || isWhaleSell) {
                // Dev sell is dangerous: exit if dev sells after buy. For top holder/whale, exit if price weakens (return < -1% or momentum < -0.5%).
                const priceWeakening = isDevSell ? (returnPercent <= 0 || (priceMomentum5s ?? 0) <= 0) : (returnPercent < -1.0 || (priceMomentum5s !== null && priceMomentum5s < -0.5));
                if (priceWeakening) {
                  exitReason = isDevSell ? 'DEV_DUMP_EXIT' : 'TOP_HOLDER_DUMP';
                  const dumpDesc = isDevSell ? 'Developer' : isTopHolderSell ? `Top Holder owning >= ${topHolderDumpMinPercent}%` : `Whale sell ($${sellTrade.amountUsd ?? '?'})`;
                  write('events.jsonl', { type: 'SIMULATION_DUMP_EXIT_TRIGGERED', mint, worker: index, observedAt: now, reason: exitReason, sellerWallet: sellTrade.wallet, isDev: isDevSell, isWhale: isWhaleSell, amountPercentage: holder?.amountPercentage ?? null, tradeUsd: sellTrade.amountUsd, priceMomentum5s, returnPercent, note: `Emergency exit: ${dumpDesc} sold during price decline.` });
                  console.log(`[sim-dump-exit] ${candidate?.metadata?.symbol ?? mint} ${exitReason}! Wallet=${sellTrade.wallet.slice(0, 8)}... (${(holder?.amountPercentage ?? 0).toFixed(1)}% supply, Dev=${isDevSell}, Whale=${isWhaleSell}) sold $${sellTrade.amountUsd ?? '?'}, return=${returnPercent.toFixed(1)}%`);
                  break;
                }
              }
            }
          }

          // 3. Jika dalam 5 detik holder bertambah sedikit / berhenti naik dan transaksi tidak signifikan:
          //    Turunkan target dan langsung jual jika sudah untung (>= 3%)
          const slowingMomentum5s = (priceMomentum5s ?? 0) <= 0.5;
          const weakTrades5s = trades5s.buys <= 2 || trades5s.sellUsd > trades5s.buyUsd;
          const holderStalled5s = !freshSignificantGrowth;
          if (!exitReason && returnPercent >= 3 && slowingMomentum5s && weakTrades5s && holderStalled5s && now - lastProfitProgressAt >= 5_000) {
            exitReason = 'MOMENTUM_EXHAUSTION_5S';
          }

          // 3. Jika target dinamis tercapai:
          if (!exitReason && returnPercent >= dynamicTargetPercent && !targetMomentumHold) {
            exitReason = 'TARGET_DYNAMIC';
          }

          const minProfitStagnationPercent = config.profitStagnationPercent ?? 3;
          const profitStagnationDurationMs = (config.profitStagnationSeconds ?? 10) * 1000;
          if (returnPercent >= minProfitStagnationPercent) {
            if (price > highestProfitPriceUsd + 1e-12) {
              highestProfitPriceUsd = price;
              lastProfitProgressAt = now;
            } else if (!exitReason) {
              const requiredStagnationMs = returnPercent >= 10 ? 25_000 : profitStagnationDurationMs;
              if (now - lastProfitProgressAt >= requiredStagnationMs) {
                exitReason = returnPercent >= 10 ? 'PROFIT_STAGNATION_25S' : 'PROFIT_STAGNATION_10S';
              }
            }
          }
          if (!exitReason && returnPercent >= 40 && sustainedHolderGrowth && (priceMomentum5s ?? 0) < 0.5) exitReason = 'TARGET_40_HOLDER_FLAT';
          }
          if (exitReason) {
            simulationExit = exitReason;
            const result = writeSimulationExit(simulation, PAPER_LANES.control.id, mint, now, price, exitReason, candidate?.metadata ?? null, { ...decision, holderCount, holderGrowthStreak, priceMomentum5s, recoveryHoldActive: now < recoveryHoldUntil, stopValidation: hardStopValidation });
            if (values.prepareTradeUi && !flow3) {
              await prepareSellPanel(page, mint, index, now, exitReason).catch(error => {
                write('events.jsonl', { type: 'SELL_PREPARATION_ERROR', mint, worker: index, observedAt: Date.now(), reason: exitReason, message: error instanceof Error ? error.message : 'unknown' });
              });
              if (autoBuyEnabled) {
                await clickTradeButton(page, 'sell').then(res => {
                  write('events.jsonl', { type: 'SELL_BUTTON_CLICKED', mint, worker: index, observedAt: Date.now(), reason: exitReason, buttonText: res.buttonText });
                  console.log('[sell-clicked]', candidate?.metadata?.symbol ?? mint, exitReason, res.buttonText);
                }).catch(error => {
                  write('events.jsonl', { type: 'SELL_CLICK_ERROR', mint, worker: index, observedAt: Date.now(), reason: exitReason, message: error instanceof Error ? error.message : 'unknown' });
                  console.log('[sell-click-error]', candidate?.metadata?.symbol ?? mint, error instanceof Error ? error.message : error);
                });
              } else {
                write('events.jsonl', { type: 'SELL_BUTTON_CLICK_SKIPPED', mint, worker: index, observedAt: Date.now(), reason: exitReason, note: 'autoBuy is false; real Playwright sell button click skipped while paper simulation exits.' });
                console.log('[paper-only]', candidate?.metadata?.symbol ?? mint, 'Simulated sell recorded; real UI sell click skipped (autoBuy=false)');
              }
            }
            const releaseAt = Date.now() + exitHoldSeconds * 1000;
            write('events.jsonl', { type: 'SELL_PREPARED_HOLD', mint, worker: index, observedAt: now, reason: exitReason, holdSeconds: exitHoldSeconds, releaseAt,
              note: 'Sell button clicked. The detail slot remains open for the configured review hold, then advances to the next queued token.' });
            console.log('[sim-sell]', candidate?.metadata?.symbol ?? mint, exitReason, 'pnl=$' + result.pnlUsd.toFixed(6), 'hold=' + exitHoldSeconds + 's');
            if (exitHoldSeconds > 0) await delay(exitHoldSeconds * 1000);
            write('events.jsonl', { type: 'DETAIL_SLOT_RELEASED_AFTER_SELL_HOLD', mint, worker: index, observedAt: Date.now(), reason: exitReason, holdSeconds: exitHoldSeconds });
            if (maxPaperBuys !== null && paperBuyCount >= maxPaperBuys && !values.browserBuyPrompt) {
              const openPositions = simulatedEvents.filter(r => r.type === 'SIMULATED_BUY').length - simulatedEvents.filter(r => r.type === 'SIMULATED_SELL').length;
              if (openPositions <= 0 && liveBrowserPositions.size === 0) {
                console.log('[trial-complete]', `Target of ${maxPaperBuys} transactions completed.`);
                stopping.abort();
              }
            }
            break;
          }
        }
        // A non-bought detail can be released on a rug.  A paper position must
        // stay alive long enough for the two-source stop confirmation above.
        if (!simulation && !r5BandSimulation && ![...momentumLaneStates.values()].some(state => !state.closed) && price && openingPrice && (openingPrice - price) / openingPrice * 100 >= stopLossPercent) { stopLoss = true; write('events.jsonl', { type: 'STOP_LOSS_REACHED', mint, observedAt: Date.now(), openingPriceUsd: openingPrice, currentPriceUsd: price, drawdownPercent: (openingPrice - price) / openingPrice * 100, thresholdPercent: stopLossPercent }); break; }
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
        if (momentumResearch && closePrice) {
          const finalObservedAt = finalTick?.observedAt ?? candidate.fields.priceUsd?.observedAt ?? endedAt;
          for (const [paperLane, state] of momentumLaneStates) {
            if (state.closed) continue;
            state.closed = true;
            const exitSignal = paperSignal({ side: 'SELL', paperLane, runId, mint, positionId: `${mint}:${state.position.openedAt}:${paperLane}`, worker: index,
              reason: 'OBSERVATION_END', marketTradeAt: finalTick?.observedAt ?? null, priceReceivedAt: finalObservedAt,
              decisionAt: endedAt, paperRecordedAt: Date.now(), priceUsd: closePrice });
            write('trade-signals.jsonl', exitSignal); schedulePaperOrder(exitSignal); scheduleSimulatedOrder(exitSignal, state.position.stakeUsd);
            await scheduleSellRouteComparison(page, exitSignal);
            const result = writeSimulationExit(state.position, paperLane, mint, endedAt, closePrice, 'OBSERVATION_END', candidate.metadata ?? null,
              { priceSource: finalTick?.priceUsd === closePrice ? 'last observed detail socket tick' : 'fresh candidate price', priceObservedAt: finalTick?.observedAt ?? candidate.fields.priceUsd?.observedAt ?? null }, exitSignal);
            if (paperLane === PAPER_LANES.control.id) simulationExit = 'OBSERVATION_END';
            else if (paperLane === PAPER_LANES.r5Band.id) r5BandExit = 'OBSERVATION_END';
            console.log('[sim-sell]', candidate.metadata?.symbol ?? mint, paperLane, 'OBSERVATION_END', 'pnl=$' + result.pnlUsd.toFixed(6));
          }
        } else if (simulation && !simulationExit && closePrice) {
          simulationExit = 'OBSERVATION_END'; const result = writeSimulationExit(simulation, PAPER_LANES.control.id, mint, endedAt, closePrice, simulationExit, candidate.metadata ?? null, { priceSource: finalTick?.priceUsd === closePrice ? 'last observed detail socket tick' : 'fresh candidate price', priceObservedAt: finalTick?.observedAt ?? candidate.fields.priceUsd?.observedAt ?? null }); console.log('[sim-sell]', candidate.metadata?.symbol ?? mint, simulationExit, 'pnl=$' + result.pnlUsd.toFixed(6));
          if (values.prepareTradeUi) {
            await prepareSellPanel(page, mint, index, endedAt, simulationExit).catch(() => {});
            if (autoBuyEnabled) await clickTradeButton(page, 'sell').catch(() => {});
          }
        }
        if (!momentumResearch && r5BandSimulation && !r5BandExit && closePrice) {
          r5BandExit = 'OBSERVATION_END'; const result = writeSimulationExit(r5BandSimulation, PAPER_LANES.r5Band.id, mint, endedAt, closePrice, r5BandExit, candidate.metadata ?? null, { priceSource: finalTick?.priceUsd === closePrice ? 'last observed detail socket tick' : 'fresh candidate price', priceObservedAt: finalTick?.observedAt ?? candidate.fields.priceUsd?.observedAt ?? null }); console.log('[sim-sell]', candidate.metadata?.symbol ?? mint, 'r5-band', r5BandExit, 'pnl=$' + result.pnlUsd.toFixed(6));
        }
        const summary = {
          mint,
          worker: index,
          startedAt,
          detailStartedAt: startedAt,
          endedAt,
          endedBecause: operatorClosedDetail ? 'OPERATOR_CLOSED_DETAIL' : observationAbortedDump ? 'OBSERVATION_ABORTED_DUMP' : stopLoss ? 'STOP_LOSS_REACHED' : 'OBSERVATION_WINDOW',
          dumpDetails: observationAbortedDump ? { reason: observationAbortedDump.reason, details: observationAbortedDump.details, drawdownPercent: observationAbortedDump.drawdownPercent } : null,
          openingPriceUsd: openingPrice,
          metadata: candidate.metadata ?? null,
          fields: candidate.fields,
          report: evaluate(candidate, config),
          capturedTrades: (trades.get(mint) ?? []).length,
          capturedHolderWallets: holders.get(mint)?.size ?? 0,
          comparison: comparison(mint, endedAt),
          developerMonitoring: developerMonitoring(mint),
          wallets: walletBehavior(mint, candidate),
          monitoringTimeline: monitoringSnapshots.get(mint) ?? [],
        };
        monitoringSnapshots.delete(mint);
        write('token-summary.jsonl', summary);
        console.log('[detail-complete]', 'worker=' + index, mint, 'trades=' + summary.capturedTrades, 'holders=' + summary.capturedHolderWallets, summary.endedBecause);
      }
    } catch (error) {
      if (values.orderCapture && page.isClosed()) {
        if (simulation && !simulationExit) paperBuyCount = Math.max(0, paperBuyCount - 1);
        write('events.jsonl', { type: 'OPERATOR_SKIPPED_CANDIDATE', mint, worker: index, observedAt: Date.now(),
          hadPaperEntry: !!simulation, note: 'Operator closed the detail tab. The worker will open a replacement detail tab and continue screening.' });
        console.log('[operator-skipped-candidate]', mint);
      }
      write('events.jsonl', { type: 'DETAIL_ERROR', worker: index, mint, observedAt: Date.now(), message: error instanceof Error ? error.message : 'unknown' });
      console.log('[detail-error]', 'worker=' + index, mint, error instanceof Error ? error.message : error);
    }
    finally {
      stopAllPeriodicSellRoutePollingForMint(mint);
      paperRiskListeners.delete(mint);
      momentumTape.delete(mint);
      totalHolderSamples.delete(mint);
      ownerSnapshots.delete(mint);
      queue.done(mint); activeMint = undefined;
      // The operator owns the cadence in the one-tab capture flow.  Keep this
      // exact token on screen after a dump, timeout, or rejected V2 signal;
      // only closing the detail tab releases the worker to inspect a new one.
      if (values.orderCapture && !browserAutoTrade && !page.isClosed() && !stopping.signal.aborted) {
        write('events.jsonl', { type: 'DETAIL_AWAITING_OPERATOR_CLOSE', mint, worker: index, observedAt: Date.now(),
          note: 'Detail tab stays on this token. Close it to release the worker to the next candidate.' });
        console.log('[detail-awaiting-operator-close]', mint);
        while (!stopping.signal.aborted && !page.isClosed()) await delay(250);
        if (page.isClosed()) {
          write('events.jsonl', { type: 'OPERATOR_RELEASED_DETAIL_SLOT', mint, worker: index, observedAt: Date.now(),
            note: 'Detail tab was closed by the operator; the worker will create one replacement tab for the next candidate.' });
        }
      }
      // In an order-capture session the completed token must remain visible for
      // the operator's manual Sell. Ordinary research workers or auto-traders clear the tab.
      if ((!values.orderCapture || browserAutoTrade) && !page.isClosed()) await page.goto('about:blank', { waitUntil: 'commit', timeout: config.workerTimeoutMs }).catch(() => {});
    }
  }
  await page.close().catch(() => {});
}
async function main() {
  writeFileSync(join(output, 'strategy.json'), JSON.stringify({ strategy: values.strategy, autoBuyEnabled, quoteSimulationEnabled,
    runSeconds: runSeconds === 0 ? null : runSeconds,
    rules: pumpBand ? { ...PUMP_BAND_RULES, observationSeconds: detailSeconds, simulationStakeUsdc: simulationStakeUsd, maximumExitPriceAgeMs: 5_000,
      entry: 'first fresh token_activity pu after detail opened', exit: '20% fall from observed price peak or observation window end' }
      : momentumComparison ? { version: 'momentum-v2-v3', comparison: { v2: MOMENTUM_RULES, v3: MOMENTUM_V3_RULES }, exits: MOMENTUM_RULES }
      : momentumAggressive ? MOMENTUM_AGGRESSIVE_RULES
      : momentumV3 ? { ...MOMENTUM_V3_RULES, exits: MOMENTUM_RULES }
      : momentumV2 ? MOMENTUM_RULES : flow3 ? FLOW3_RULES : null,
    ...(momentumResearch ? { paperLanes: {
      [PAPER_LANES.control.id]: { label: PAPER_LANES.control.label, entry: momentumAggressive ? MOMENTUM_AGGRESSIVE_RULES : standaloneMomentumV3 ? MOMENTUM_V3_RULES : { minimumReturn5s: MOMENTUM_RULES.minimumReturn5s, maximumReturn5s: MOMENTUM_RULES.maximumReturn5s } },
      ...(momentumComparison ? { [PAPER_LANES.v3.id]: { label: PAPER_LANES.v3.label, entry: MOMENTUM_V3_RULES } } : {}),
      ...(momentumComparison ? { [PAPER_LANES.v3ExitConfirmed.id]: { label: PAPER_LANES.v3ExitConfirmed.label, entry: MOMENTUM_V3_RULES,
        exit: { nonDevWhaleSell: 'immediate when P/L <= 0 or buy flow/holder growth is not supportive; otherwise pending 5 seconds, then sell with 2 of: sell USD >= 1.5x buy USD, 5s price <= -2%, holder delta <= 0', devSell: 'immediate', profitLock: 'hold while buy USD > sell USD, holder delta > 0, price 5s > 0; exit on 5% drawdown' } } } : {}),
      ...(r5BandEnabled ? { [PAPER_LANES.r5Band.id]: { label: PAPER_LANES.r5Band.label, entry: MOMENTUM_R5_BAND } } : {}),
    }, timing: {
      signalFile: 'trade-signals.jsonl',
      paperOrderFile: 'paper-orders.jsonl',
      plannedOrderAt: 'local target time 900 ms after decision',
      orderDeadlineAt: 'local deadline 1000 ms after decision',
      simulatedOrderAt: 'local time the delayed paper event was recorded; no GMGN request',
      marketTradeAt: 'GMGN transaction timestamp, usually second precision',
      priceReceivedAt: 'local WebSocket receipt time in milliseconds',
      decisionAt: 'local time when all gates or exit rules passed',
      paperRecordedAt: 'local time the paper signal was written',
      actualOrderAt: null, actualFillAt: null,
    } } : {}),
    storage: { holderSnapshots: 'research.sqlite (holder_api_observations + changed holder_snapshots + holder_balances)', legacyTrackedHoldersJsonl: false },
    note: 'Thresholds are research hypotheses; replay does not establish profitability.' }, null, 2));
  if (pumpBand) writeFileSync(join(output, 'manifest.json'), JSON.stringify({ runId, strategy: 'pump-band', startedAt: new Date().toISOString(),
    purpose: 'Playwright paper buy/sell test of the pump-band rules. No real GMGN trade controls are used.', workers, detailSeconds,
    scheduling: 'No queue. Only a fresh eligible token with an empty detail slot is assigned.',
    feedRules: { minimumMarketCapUsd: PUMP_BAND_RULES.minimumMarketCapUsd, maximumMarketCapUsd: PUMP_BAND_RULES.maximumMarketCapUsd },
    simulation: { stakeUsd: simulationStakeUsd, buyPrice: 'first fresh transaction pu after detail open',
      sellSignal: '20% drawdown from observed pu peak or observation window end', maximumExitPriceAgeMs: 5_000,
      feeUsd: 0, slippagePercent: 0, maxPaperBuys }, tradePreparation: { enabled: false, autoBuyEnabled: false } }, null, 2));
  else
  writeFileSync(join(output, 'manifest.json'), JSON.stringify({ runId, strategy: values.strategy, startedAt: new Date().toISOString(), purpose: 'Research-only collector with paper buy/sell simulation and non-submitting GMGN UI preparation.', workers, detailSeconds, stopLossPercent, paperLanes: momentumResearch ? { [PAPER_LANES.control.id]: { label: PAPER_LANES.control.label, entry: momentumAggressive ? MOMENTUM_AGGRESSIVE_RULES : standaloneMomentumV3 ? MOMENTUM_V3_RULES : undefined }, ...(momentumComparison ? { [PAPER_LANES.v3.id]: { label: PAPER_LANES.v3.label, entry: MOMENTUM_V3_RULES }, [PAPER_LANES.v3ExitConfirmed.id]: { label: PAPER_LANES.v3ExitConfirmed.label, entry: MOMENTUM_V3_RULES, exit: { nonDevWhaleSell: 'immediate when underwater or flow/holders do not support holding; otherwise 5-second confirmation with 2 of 3 bearish signals', devSell: 'immediate', profitLock: 'hold bullish flow; 5% trail' } } } : {}), ...(r5BandEnabled ? { [PAPER_LANES.r5Band.id]: { label: PAPER_LANES.r5Band.label, entry: MOMENTUM_R5_BAND } } : {}) } : null, tradePreparation: { enabled: values.prepareTradeUi && !flow3, buyStakeUsdc: simulationStakeUsd, sellPercent: 100, exitHoldSeconds, maxPaperBuys, enableExtensions: values.enableExtensions, executionSettings: DEFAULT_EXECUTION_SETTINGS, note: flow3 ? 'Flow-3 is paper-only and does not prepare or click GMGN trade controls.' : 'The collector fills GMGN controls but never clicks Buy or Sell.' }, simulation: { stakeUsd: simulationStakeUsd, maxPaperBuys, entryStability: { priceWindowSeconds: 5, minimumFreshPriceUpdates: 3, maximumPriceDropPercent: 2, maximumConsecutiveDeclines: 2, actionWhenBlocked: 'Continue detail observation without paper buy' }, mcapCandleHistory: { endpoint: '/api/v1/token_mcap_candles/sol/{mint}', resolution: '1m', limit: 501, pumpThenDump: { largestGreenCandlePercent: 100, peakToLastDrawdownPercent: -20 }, consecutiveRedCandles: 3 }, targetPercent: 40, trailingStartPercent: 20, trailingDrawdownPercent: 10, stopLossPercent: 20, sellPressure: { windowSeconds: 5, completedWindows: true, minimumTrades: 10, minimumUniqueSellers: 3, minimumSellSharePercent: 70, minimumPriceReturnPercent: -5, consecutiveWindows: 2 }, holderGrowthRecovery: { priceReturnMinPercent: -20, priceReturnMaxPercent: -10, minimumHolderGrowthAbsolute: 5, holderUpdateFreshSeconds: 5, buyUsdAtLeastSellUsd: true, holdSeconds: 10 }, executionSettings: DEFAULT_EXECUTION_SETTINGS }, feedRules: { minimumAgeSeconds: config.minimumAgeSeconds, maximumAgeSeconds: config.maximumAgeSeconds, minimumLiquidityUsd: config.minimumLiquidityUsd, maximumLiquidityUsd: config.maximumLiquidityUsd, maximumTop10Percent: config.maximumTop10Percent } }, null, 2));
  scheduleReportRefresh();
  context = await chromium.launchPersistentContext(values.profileDir, { channel: config.browserChannel || undefined, headless: false, viewport: null, args: ['--start-maximized', '--profile-directory=' + values.profileName], ignoreDefaultArgs: values.enableExtensions ? ['--disable-extensions'] : undefined });
  await installGmgnNewPairFilter(context);
  context.on('close', () => stopping.abort());
  attachOrderApiInspector(context);
  process.once('SIGINT', () => stopping.abort());
  process.once('SIGTERM', () => stopping.abort());
  console.log('[research-start]', output, 'workers=' + workers, 'detailSeconds=' + detailSeconds, simulationStakeSol !== null ? ('stakeSol=' + simulationStakeSol) : ('stakeUsd=$' + simulationStakeUsd));
  const feed = context.pages()[0] ?? await context.newPage(); attach(feed, true, () => undefined);
  await feed.goto(config.feedUrl, { waitUntil: 'commit', timeout: config.workerTimeoutMs });
  const deadline = runSeconds === 0 ? Number.POSITIVE_INFINITY : Date.now() + runSeconds * 1000;
  const timer = runSeconds === 0 ? null : setTimeout(() => stopping.abort(), runSeconds * 1000);
  await Promise.allSettled(Array.from({ length: workers }, (_, index) => worker(index + 1, deadline)));
  await Promise.allSettled([...pendingPaperOrders]);
  if (timer) clearTimeout(timer);
  const simulated = simulatedEvents;
  const summarizeLane = (paperLane: PaperLane) => {
    const buys = simulated.filter(row => row.type === 'SIMULATED_BUY' && row.paperLane === paperLane);
    const sells = simulated.filter(row => row.type === 'SIMULATED_SELL' && row.paperLane === paperLane);
    return { positionsOpened: buys.length, positionsClosed: sells.length, openAtEnd: buys.length - sells.length,
      totalStakeUsd: buys.reduce((sum, row) => sum + Number((row as { stakeUsd?: number }).stakeUsd ?? 0), 0),
      totalPnlUsd: sells.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0),
      profitable: sells.filter(row => (row.pnlUsd ?? 0) > 0).length, losing: sells.filter(row => (row.pnlUsd ?? 0) < 0).length,
      breakEven: sells.filter(row => row.pnlUsd === 0).length,
      exitsByReason: Object.fromEntries(sells.reduce((map, row) => map.set(row.reason ?? 'UNKNOWN', (map.get(row.reason ?? 'UNKNOWN') ?? 0) + 1), new Map<string, number>())),
    };
  };
  const lanes = { [PAPER_LANES.control.id]: summarizeLane(PAPER_LANES.control.id), ...(momentumComparison ? { [PAPER_LANES.v3.id]: summarizeLane(PAPER_LANES.v3.id), [PAPER_LANES.v3ExitConfirmed.id]: summarizeLane(PAPER_LANES.v3ExitConfirmed.id) } : {}), ...(r5BandEnabled ? { [PAPER_LANES.r5Band.id]: summarizeLane(PAPER_LANES.r5Band.id) } : {}) };
  const controlSummary = lanes[PAPER_LANES.control.id];
  writeFileSync(join(output, 'simulation-summary.json'), JSON.stringify({ observedAt: Date.now(), ...controlSummary, lanes,
    holderStorage: { api: holderStore.counts(), socket: holderStore.socketCounts() },
    assumptions: { feeUsd: 0, slippagePercent: 0, note: 'Paper simulation only; it does not represent executable net proceeds.' } }, null, 2));
  if (reportRefreshTimer) clearTimeout(reportRefreshTimer);
  await refreshLatestReport();
  write('events.jsonl', { type: 'RUN_COMPLETE', observedAt: Date.now(), sockets, received, screened: inspected.size, rejected: rejected.size, rejectionCounts: Object.fromEntries(rejectionCounts), youngRejected: youngRejected.size, youngRejectionCounts: Object.fromEntries(youngRejectionCounts), simulation: { lanes } });
  console.log('[research-complete]', 'sockets=' + sockets, 'frames=' + received, 'screened=' + inspected.size, 'rejected=' + rejected.size, 'youngRejected=' + youngRejected.size);
  await context.close();
  holderStore.close();
}
main().catch(error => { holderStore.close(); console.error(error); process.exitCode = 1; });
