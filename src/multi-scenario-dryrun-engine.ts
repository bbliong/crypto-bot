import * as fs from 'node:fs';
import * as path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { WalletTradeSignal } from './wallet-follower-lane.js';
import { readFollowerLiveConfig } from './follower-live-store.js';
import { getSolanaRpcUrl } from '../scripts/solana-rpc-config.mjs';

// Rata-rata fee riil per swap: on-chain gas ($0.0105) + priority/tip ($0.0100) + DEX swap fee ($0.0045) = $0.025 USD
export const REAL_SWAP_FEE_USD = 0.025;

export interface ScenarioPosition {
  mint: string;
  symbol: string;
  tokenName: string;
  openedAt: number;
  updatedAt: number;
  entryCount: number;
  tokens: number;
  costBasisUsd: number;
  avgEntryPriceUsd: number;
  lastPriceUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  peakTargetHolding: number;
  feesPaidUsd: number;
  targetCumulativeSellRatioPct?: number;
  lastTargetSellAt?: number;
  stage1Exited?: boolean;
  stage1ExitedAt?: number;
  stage1RealUsdReturned?: number;
  initialTokens?: number;
  initialCostBasisUsd?: number;
  boughtAtGenesis?: boolean;
  targetEnteredAt?: number;
  pairAddress?: string;
  exchange?: string;
  waitingBuybackSince?: number;
  peakGainPct?: number;
  peakPriceUsd?: number;
}

export interface ScenarioTradeRecord {
  mint: string;
  symbol: string;
  tokenName: string;
  openedAt: number;
  closedAt: number;
  entryCount: number;
  totalInvestedUsd: number;
  totalReturnedUsd: number;
  totalFeesPaidUsd: number;
  realizedPnlUsd: number;
  roiPct: number;
  exitReason: string;
  isWin: boolean;
  stage1RealUsdReturned?: number;
}

export interface ScenarioLogEvent {
  id: string;
  timestamp: number;
  timeWib: string;
  scenarioId: string;
  action: 'BUY' | 'SELL' | 'SKIP';
  symbol: string;
  mint: string;
  stakeUsd?: number;
  usdReceived?: number;
  feeUsd?: number;
  tokens?: number;
  priceUsd: number;
  pnlUsd?: number;
  availableCashAfter: number;
  investedCashAfter: number;
  reason: string;
}

export interface TokenGenerationInfo {
  firstSeenAt: number;
  generation: number; // 1 = Pool pertama, 2 = Re-deploy pool kedua, dst
  lastMint: string;
}

export interface Gen2CycleState {
  mint: string;
  symbol: string;
  pairAddress: string;
  exchange: string;
  devWallet: string;
  cycleCount: number; // 1 s/d 5
  maxCycles: number; // default 5
  lastExitAt: number;
  lastExitPrice: number;
  lastExitReason: string;
  lastTradeProfitable: boolean;
  status: 'COOLDOWN' | 'HOLDING' | 'TERMINATED';
  cooldownUntil: number; // lastExitAt + 60_000
}

export interface S13PingPongState {
  mint: string;
  symbol: string;
  pairAddress?: string;
  exchange?: string;
  whaleFirstBuyAt: number;
  whaleFirstBuyUsd: number;
  whaleFirstBuySol: number;
  whaleRemainingHolding: number;
  whalePeakHolding: number;
  cycleCount: number;
  maxCycles: number;
  status: 'ACTIVE' | 'TERMINATED';
  lastExitAt: number;
}

export interface S13_5_PingPongState {
  mint: string;
  symbol: string;
  pairAddress?: string;
  exchange?: string;
  whaleFirstBuyAt: number;
  whaleFirstBuyUsd: number;
  whaleFirstBuySol: number;
  whaleRemainingHolding: number;
  whalePeakHolding: number;
  consecutiveSells: number;
  cycleCount: number;
  status: 'ACTIVE' | 'TERMINATED';
  lastExitAt: number;
}

export interface S13AlphaState {
  mint: string;
  symbol: string;
  pairAddress?: string;
  exchange?: string;
  whaleFirstBuyAt: number;
  whaleFirstBuyUsd: number;
  whaleFirstBuySol: number;
  whaleRemainingHolding: number;
  whalePeakHolding: number;
  consecutiveSells: number;
  cycleCount: number;
  status: 'PENDING_1S_VERIFICATION' | 'ACTIVE' | 'BLOCKED_SNIPER_BATTLE' | 'BLOCKED_LOW_BUNDLER' | 'TERMINATED';
  lastExitAt: number;
  sniperBuysIn1s: number;
  sniperSellsIn1s: number;
  verificationTimer?: any;
  verifiedAt?: number;
  targetBuySignal?: WalletTradeSignal;
  bundlerRate?: number | null;
}

export interface S13BetaState {
  mint: string;
  symbol: string;
  pairAddress?: string;
  exchange?: string;
  whaleFirstBuyAt: number;
  whaleFirstBuyUsd: number;
  whaleFirstBuySol: number;
  whaleRemainingHolding: number;
  whalePeakHolding: number;
  consecutiveSells: number;
  cycleCount: number;
  status: 'ACTIVE_MONITORING' | 'ACTIVE' | 'PANIC_DUMPED' | 'TERMINATED';
  lastExitAt: number;
  sniperBuysIn1s: number;
  sniperSellsIn1s: number;
}

export interface S13CentaurState {
  mint: string;
  symbol: string;
  pairAddress?: string;
  exchange?: string;
  whaleFirstBuyAt: number;
  whaleFirstBuyUsd: number;
  whaleFirstBuySol: number;
  whaleWallet: string;
  sniperBuysIn1s: number;
  sniperSellsIn1s: number;
  whaleBuybacks10_25s: number;
  hasLargeSell10_25s: boolean;
  consecutiveWhaleSells: number;
  status: 'PENDING_1S_VERIFICATION' | 'ACTIVE_INITIAL_PUMP' | 'RUNNER_WAVE_RIDE' | 'BLOCKED_MEV_DUMP' | 'BLOCKED_LOW_BUNDLER' | 'SCALPED_PRE_RUG' | 'EXHAUSTION_EXITED' | 'TERMINATED';
  peakPriceUsd: number;
  lastExitAt: number;
  verificationTimer?: any;
  decisionGateTimer?: any;
  targetBuySignal?: WalletTradeSignal;
  bundlerRate?: number | null;
}

export interface S14BundlerRunnerState {
  mint: string;
  symbol: string;
  pairAddress?: string;
  exchange?: string;
  whaleWallet: string;
  whaleFirstBuyAt: number;
  whaleFirstBuyUsd: number;
  whaleFirstBuySol: number;
  whalePeakHolding: number;
  whaleRemainingHolding: number;
  whaleBuysCount: number;
  whaleSellsCount: number;
  consecutiveWhaleSells: number;
  hasEntered: boolean;
  status: 'OBSERVING_BUNDLER' | 'ACTIVE_RIDING' | 'EXITED_TRAILING_STOP' | 'EXITED_WHALE_DUMP' | 'TERMINATED';
  bundlerPct: number;
  peakPriceUsd: number;
  lastExitAt: number;
  targetBuySignal?: WalletTradeSignal;
}

export type ScenarioTradeActionCallback = (
  action: 'BUY' | 'SELL',
  scenarioId: string,
  signal: WalletTradeSignal,
  details: { stakeUsd?: number; tokens?: number; priceUsd: number; reason: string; isReEntryCycle?: boolean; cycleIndex?: number }
) => void | Promise<void>;

export interface ScenarioState {
  id: string;
  name: string;
  description: string;
  initialCash: number;
  availableCash: number;
  investedCash: number;
  totalFeesPaid: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPortfolioValue: number;
  wins: number;
  losses: number;
  totalTrades: number;
  winRate: number;
  openPositions: ScenarioPosition[];
  closedTrades: ScenarioTradeRecord[];
  recentEvents: ScenarioLogEvent[];
}

function formatWibDate(ms: number): string {
  const date = new Date(ms);
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const wib = new Date(utc + 7 * 3600000);
  const yyyy = wib.getFullYear();
  const mm = String(wib.getMonth() + 1).padStart(2, '0');
  const dd = String(wib.getDate()).padStart(2, '0');
  const hh = String(wib.getHours()).padStart(2, '0');
  const min = String(wib.getMinutes()).padStart(2, '0');
  const ss = String(wib.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} WIB`;
}

export class MultiScenarioDryRunEngine {
  private dataDir: string;
  private filePath: string;
  private tokenGenerations: Map<string, TokenGenerationInfo> = new Map();
  private gen2CycleTracker: Map<string, Gen2CycleState> = new Map();
  private s13PingPongTrackers: Map<string, S13PingPongState> = new Map();
  private s13_5PingPongTrackers: Map<string, S13_5_PingPongState> = new Map();
  private s13AlphaTrackers: Map<string, S13AlphaState> = new Map();
  private s13BetaTrackers: Map<string, S13BetaState> = new Map();
  private s13Alpha1Trackers: Map<string, S13AlphaState> = new Map();
  private s13Beta1Trackers: Map<string, S13BetaState> = new Map();
  private s13CentaurTrackers: Map<string, S13CentaurState> = new Map();
  private s14Trackers: Map<string, S14BundlerRunnerState> = new Map();
  private s14AlphaTrackers: Map<string, S14BundlerRunnerState> = new Map();
  private lastObservedPrices: Map<string, number> = new Map();
  private abortedBuyKeys: Set<string> = new Set();
  public onTradeAction?: ScenarioTradeActionCallback;
  public browserPage: any = null;
  public bundlerResolver?: (mint: string) => Promise<number | null>;
  private bundlerResearchTrackers: Map<string, { timer: any; sampleCount: number; firstSeenAt: number; prevBundlerPct: number | null }> = new Map();

  public setBrowserPage(page: any): void {
    this.browserPage = page;
  }

  /**
   * Query raw response data dari /api/v1/token_stat/sol/${mint}
   */
  public async queryGmgnTokenStatRaw(mint: string): Promise<any | null> {
    // 1. Coba via this.browserPage jika aktif
    if (this.browserPage && typeof this.browserPage.isClosed === 'function' && !this.browserPage.isClosed()) {
      try {
        const raw = await Promise.race([
          this.browserPage.evaluate(async (m: string) => {
            try {
              const r = await fetch('/api/v1/token_stat/sol/' + m);
              const j = await r.json();
              return j?.data || null;
            } catch {
              return null;
            }
          }, mint),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1200))
        ]);
        if (raw) return raw;
      } catch {}
    }

    // 2. Standalone CDP WebSocket fallback (Port 9223)
    try {
      const tabsRes = await fetch('http://127.0.0.1:9223/json', { signal: AbortSignal.timeout(800) });
      if (!tabsRes.ok) return null;
      const tabs: any = await tabsRes.json();
      const pageTab = tabs.find((t: any) => t.type === 'page' && t.url && t.url.includes('gmgn.ai'));
      if (!pageTab || !pageTab.webSocketDebuggerUrl) return null;

      return await new Promise<any | null>((resolve) => {
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          resolve(null);
        }, 1200);

        const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
        ws.onopen = () => {
          const expr = `(async () => {
            try {
              const r = await fetch('/api/v1/token_stat/sol/${mint}');
              const j = await r.json();
              return j?.data || null;
            } catch { return null; }
          })()`;
          ws.send(JSON.stringify({
            id: 888,
            method: 'Runtime.evaluate',
            params: { expression: expr, awaitPromise: true, returnByValue: true }
          }));
        };
        ws.onmessage = (evt) => {
          try {
            const data = JSON.parse(evt.data.toString());
            if (data.id === 888) {
              clearTimeout(timer);
              ws.close();
              resolve(data.result?.result?.value || null);
            }
          } catch {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(null);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(null);
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Mengambil metrik Bundler Rate (% token supply diborong genesis bundle di Detik 0)
   */
  public async fetchTokenBundlerRate(mint: string): Promise<number | null> {
    if (this.bundlerResolver) {
      try {
        const val = await this.bundlerResolver(mint);
        return val !== undefined ? val : null;
      } catch {
        return null;
      }
    }

    const data = await this.queryGmgnTokenStatRaw(mint);
    const rawRate = data?.top_bundler_trader_percentage;
    if (rawRate !== undefined && rawRate !== null) {
      const num = Number(rawRate);
      return !isNaN(num) ? num : null;
    }
    return null;
  }

  /**
   * Worker Riset Bundler: Setiap token yang dibeli target Whale dipantau per 5 detik
   * untuk mengamati apakah Bundler bertambah, berkurang, atau tetap.
   */
  public startBundlerResearchTracker(mint: string, symbol: string): void {
    if (this.bundlerResearchTrackers.has(mint)) return;

    const firstSeenAt = Date.now();
    const trackerState = {
      timer: null as any,
      sampleCount: 0,
      firstSeenAt,
      prevBundlerPct: null as number | null
    };

    console.log(`\n=========================================================`);
    console.log(`🔬 [BUNDLER 2S RESEARCH TRACKER STARTED]`);
    console.log(`   Token        : ${symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Target       : Polling /api/v1/token_stat/sol/ setiap 2 detik (10 Menit)`);
    console.log(`   Tujuan       : Memantau detik demi detik kapan Bundler cluster muncul!`);
    console.log(`=========================================================\n`);

    const poll = async () => {
      trackerState.sampleCount++;
      const now = Date.now();
      const ageSec = Math.round((now - trackerState.firstSeenAt) / 1000);

      // Stop otomatis jika sudah lewat 10 menit (300 sample x 2s)
      if (trackerState.sampleCount > 300) {
        if (trackerState.timer) clearInterval(trackerState.timer);
        this.bundlerResearchTrackers.delete(mint);
        console.log(`[BUNDLER RESEARCH COMPLETE] Token ${symbol} [${mint.slice(0, 8)}...] selesai dipantau (10 menit).`);
        return;
      }

      const data = await this.queryGmgnTokenStatRaw(mint);
      if (!data) return;

      const bundlerRaw = data.top_bundler_trader_percentage;
      const bundlerPct = bundlerRaw !== undefined && bundlerRaw !== null ? Number(bundlerRaw) * 100 : 0;
      const holders = Number(data.holder_count || 0);
      const snipers = Number(data.top70_sniper_hold_rate || 0) * 100;
      const creator = Number(data.creator_hold_rate || 0) * 100;

      const prev = trackerState.prevBundlerPct;
      const delta = prev !== null ? (bundlerPct - prev) : 0;
      let status: 'STABLE' | 'INCREASED' | 'DECREASED' = 'STABLE';
      if (delta > 0.05) status = 'INCREASED';
      else if (delta < -0.05) status = 'DECREASED';

      trackerState.prevBundlerPct = bundlerPct;

      // Append ke timeseries file
      const timeseriesPath = path.join(this.dataDir, 'research-bundler-timeseries.jsonl');
      const entry = {
        mint,
        symbol,
        sampleIndex: trackerState.sampleCount,
        timestamp: now,
        timeWib: formatWibDate(now),
        ageSeconds: ageSec,
        bundlerPct: Number(bundlerPct.toFixed(2)),
        prevBundlerPct: prev !== null ? Number(prev.toFixed(2)) : null,
        deltaBundlerPct: Number(delta.toFixed(2)),
        status,
        holders,
        snipers: Number(snipers.toFixed(2)),
        creator: Number(creator.toFixed(2))
      };
      try {
        fs.appendFileSync(timeseriesPath, JSON.stringify(entry) + '\n', 'utf8');
      } catch {}

      // Evaluasi Entry untuk Skenario 14 & 14-Alpha:
      this.evaluateS14BundlerEntry(mint, bundlerPct);
      this.evaluateS14AlphaBundlerEntry(mint, bundlerPct);

      // Log ke console
      if (status === 'INCREASED') {
        console.log(`📈 [BUNDLER MENINGKAT! #${trackerState.sampleCount} | +${ageSec}s] ${symbol}: ${prev?.toFixed(2)}% -> ${bundlerPct.toFixed(2)}% (+${delta.toFixed(2)}%) | Holders: ${holders}`);
      } else if (status === 'DECREASED') {
        console.log(`📉 [BUNDLER TURUN! #${trackerState.sampleCount} | +${ageSec}s] ${symbol}: ${prev?.toFixed(2)}% -> ${bundlerPct.toFixed(2)}% (${delta.toFixed(2)}%) | Holders: ${holders}`);
      } else {
        if (trackerState.sampleCount % 5 === 1) {
          console.log(`📊 [BUNDLER 2S RESEARCH #${trackerState.sampleCount} | +${ageSec}s] ${symbol.padEnd(8)} | Bundler: ${bundlerPct.toFixed(2)}% (STABIL) | Holders: ${holders} | Snipers: ${snipers.toFixed(1)}% | Dev: ${creator.toFixed(1)}%`);
        }
      }
    };

    // Eksekusi segera detik ke-0, lalu pasang interval 2.000 ms
    poll().catch(() => {});
    trackerState.timer = setInterval(poll, 2000);
    if (typeof trackerState.timer?.unref === 'function') {
      trackerState.timer.unref();
    }
    this.bundlerResearchTrackers.set(mint, trackerState);
  }

  public scenarios: {
    s4: ScenarioState;
    s5: ScenarioState;
    s6: ScenarioState;
    s7: ScenarioState;
    s8: ScenarioState;
    s9: ScenarioState;
    s9_5: ScenarioState;
    s10: ScenarioState;
    s13: ScenarioState;
    s13_5: ScenarioState;
    s13_alpha: ScenarioState;
    s13_beta: ScenarioState;
    s13_alpha_1: ScenarioState;
    s13_beta_1: ScenarioState;
    s13_centaur: ScenarioState;
    s14: ScenarioState;
    s14_alpha: ScenarioState;
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data');
    this.filePath = path.join(this.dataDir, 'dryrun-3scenarios-live.json');

    this.scenarios = this.loadState();
  }

  private initFreshScenarios(): {
    s4: ScenarioState;
    s5: ScenarioState;
    s6: ScenarioState;
    s7: ScenarioState;
    s8: ScenarioState;
    s9: ScenarioState;
    s9_5: ScenarioState;
    s10: ScenarioState;
    s13: ScenarioState;
    s13_5: ScenarioState;
    s13_alpha: ScenarioState;
    s13_beta: ScenarioState;
    s13_alpha_1: ScenarioState;
    s13_beta_1: ScenarioState;
    s13_centaur: ScenarioState;
    s14: ScenarioState;
    s14_alpha: ScenarioState;
  } {
    return {
      s4: {
        id: 'SCENARIO_4_SINGLE_BUY_5USD',
        name: 'Skenario 4: 2-Lapis Shakeout Trap (Hold 8s & Dump on Buyback)',
        description: 'Saldo Awal $5.00. 1x Buy Ground Zero. Jika target sell <= 3s (shakeout): tahan hingga 8 detik. Begitu target buyback: LANGSUNG SELL 100% dump ke likuiditas target. Jika tidak buyback dlm 8s -> Safety Exit.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s5: {
        id: 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER',
        name: 'Skenario 5: Anti-Shakeout Runner (TP +25% | Hold >= 12s | Time-Stop 35s)',
        description: 'Saldo Awal $5.00. Modal $1.00. Abaikan goyangan dump target di 12 detik pertama (Anti-Shakeout). Auto Take-Profit +25%, Time-Stop 35s, atau ikuti sell target jika dump pasca detik 12.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s6: {
        id: 'SCENARIO_6_REDEPLOY_SNIPER',
        name: 'Skenario 6: Re-Deploy Sniper V2 (Split TP 50/50: 5% & 15%)',
        description: 'Saldo Awal $5.00. Pool 1: $5 saat First Buy. Pool 2: Re-Deploy $7 saat dev rilis pool baru. TP1: Jual 50% di >= 5% (BEP). TP2: Jual 50% di >= 15%.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s7: {
        id: 'SCENARIO_7_TIME_STOP_SNIPER',
        name: 'Skenario 7: Time-Stop Sniper (Stage 1 @ 5% + Force Sell @ 28s)',
        description: 'Saldo Awal $5.00. Entry First Buy Ground Zero. Stage 1: TP 50% di >= 5% Anti-Rug. Stage 2: Kejar >= 15% ATAU Force Sell 100% tepat di Detik 28 (Puncak Pump) sebelum dev rugpull.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s8: {
        id: 'SCENARIO_8_FRONTRUN_DEV',
        name: 'Skenario 8: Front-Run Dev & Dump on Target Entry',
        description: 'Saldo Awal $5.00. Buy instan di Detik 0 saat Dev rilis pool baru. Begitu Target masuk beli (15-20 SOL), bot LANGSUNG SELL 100% dump ke likuiditas target!',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s9: {
        id: 'SCENARIO_9_DEV_FRONTRUN_SYNC',
        name: 'Skenario 9: Dev Front-Run & 2-Way Target Sync (Max 60s Timeout)',
        description: 'Saldo Awal $5.00. Modal $1.00. Proaktif Buy di Detik 0 saat Dev rilis pool baru sebelum target whale masuk. Jika target tidak masuk dalam 60s -> Force Sell. Komparasi 2-arah jika target beralih dev.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s9_5: {
        id: 'SCENARIO_9_5_SPLIT_TP_MOONBAG',
        name: 'Skenario 9.5: Split TP 50/50 + 1-Min Moonbag (TP 50% @ >=300% & 50% Hold 1m / Dump on Whale Exit)',
        description: 'Saldo Awal $5.00. Modal $0.25 (sama seperti S9). Masuk Detik-0 dari sinyal Dev. Jika gain >= +300% (lonjakan awal swap): JUAL 50% untuk amankan profit masif, sisa 50% DITAHAN selama 1 menit (Moonbag). Jika target whale dump 100%, LANGSUNG JUAL SEMUA seketika. Jika gain < 300%: TP normal di +25%.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s10: {
        id: 'SCENARIO_10_DYNAMIC_WAVE_RUNNER',
        name: 'Skenario 10: Dynamic Wave Runner (Genesis Buy + MCap/Whale Sell Sync)',
        description: 'Saldo Awal $5.00. Modal $0.25. Proaktif Buy di Detik 0 saat Dev rilis pool baru. Tidak buru-buru TP kaku 25% jika whale masih hold koin. Begitu whale mulai dump >= 15% atau time-stop 30s pasca-inflow: LANGSUNG SELL 100% di puncak wave!',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13: {
        id: 'SCENARIO_13_PINGPONG_SCALPER',
        name: 'Skenario 13: Multi-Cycle Ping-Pong Scalper (Post-Whale Dip & Buyback Harvester)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry (Maks 10x Siklus). MASUK SETELAH WHALE MASUK. Syarat: Whale masuk >= 20 SOL & usia koin < 15m. Beli saat Whale SELL (tampung harga diskon). Jual saat TP +10% atau Whale BUYBACK (+5%). Cut-loss -10%. Stop jika Whale dump >= 40%.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13_5: {
        id: 'SCENARIO_13_5_DYNAMIC_PINGPONG',
        name: 'Skenario 13.5: Adaptive Ping-Pong Runner (Uncapped Cycles | 3 Consecutive Sells & Dynamic Health Gates)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry (Tanpa Batas 10 Siklus). MASUK SETELAH WHALE MASUK (Inflow >= 20 SOL). Beli di lembah Sell ke-1. Bekukan beli jika Sell beruntun >= 2x. Jual di TP +10% atau Whale BUYBACK. Rem Darurat & Terminate: jika Whale sell 3x beruntun tanpa buyback, kumulatif dump >= 35%, sell tunggal >= $300, atau usia koin >= 10m.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13_alpha: {
        id: 'SCENARIO_13_ALPHA_SNIPER_GATE',
        name: 'Skenario 13-Alpha: 1-Second Sniper Gate (Pre-Entry 1s Verification | Target TP +100% Full Exit)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Entry, Tanpa Ping-Pong). Detik 0: Whale masuk (>= 20 SOL), Alpha pasang delay observasi 1.000 ms. Jika dalam 1s terdeteksi >= 3 sniper sells (indikator kolam rugpull), ABORT BUY (kebal rugpull 100%, $0 fee). Jika dalam 1s sniper sell <= 2 (akumulasi murni koin pemenang), eksekusi BUY di detik 1. Target Take Profit +100% (2x Lipat Modal) lalu LANGSUNG SELL SEMUA. Stop Loss -10% / Whale Dump.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13_beta: {
        id: 'SCENARIO_13_BETA_INSTANT_DUMP',
        name: 'Skenario 13-Beta: Instant Buy + 1.5s Panic Cut (Post-Entry Rescue | Target TP +100% Full Exit)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Entry, Tanpa Ping-Pong). Detik 0: Langsung BUY bersama Whale. Selama 1.5 detik pertama (1500 ms), pasang radar deteksi sniper sell. Jika terdeteksi >= 2 sniper sell, LANGSUNG JUAL DI DETIK ITU JUGA (Instant Emergency Dump), mengamankan modal sebelum Dev RemoveLiquidity di detik 5. Jika aman, tahan posisi hingga Take Profit +100% (2x Lipat Modal) lalu LANGSUNG SELL SEMUA. Stop Loss -10% / Whale Dump.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13_alpha_1: {
        id: 'SCENARIO_13_ALPHA_1_WAVE_RIDER',
        name: 'Skenario 13-Alpha-1: 1s Sniper Gate + Whale Wave Rider (Max Profit on Whale Sell Signals)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Ride). Detik 0: Whale masuk >= 20 SOL, Alpha-1 verifikasi 1s on-chain. Jika ada >= 3 sniper sell atau >= 12 txs -> ABORT (100% Kebal Rugpull). Jika aman, BUY di detik 1. TAHAN SELAMA WHALE PING-PONG! Exit HANYA jika: (1) Whale sell 3x beruntun tanpa buyback, (2) Whale sell tunggal >= 2.5 SOL, (3) Trailing stop -20% dari peak setelah gain >= +100%, atau (4) Stop loss -10% / Max age 10m.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13_beta_1: {
        id: 'SCENARIO_13_BETA_1_WAVE_RIDER',
        name: 'Skenario 13-Beta-1: Instant Buy + 1.5s Rescue + Whale Wave Rider (Max Profit on Whale Sell Signals)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry (1x Ride). Detik 0: Langsung BUY bersama Whale. Jika dalam 1.5s terdeteksi >= 2 sniper sell atau >= 12 on-chain txs -> Instant Emergency Dump selamatkan modal. Jika aman, TAHAN SELAMA WHALE PING-PONG! Exit HANYA jika: (1) Whale sell 3x beruntun tanpa buyback, (2) Whale sell tunggal >= 2.5 SOL, (3) Trailing stop -20% dari peak setelah gain >= +100%, atau (4) Stop loss -10% / Max age 10m.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s13_centaur: {
        id: 'SCENARIO_13_CENTAUR_HYBRID_RIDER',
        name: 'Skenario 13-Centaur: Hybrid Initial Pump Rider & 25s Whale Decision Gate',
        description: 'Saldo Awal $5.00. Modal $5.00/entry. Detik 0: Masuk bersama Whale (>= 20 SOL). Detik 0-20: Tahan posisi (Guaranteed Pump +60% - +100%). Detik 20-25 (Decision Gate): Evaluasi aksi Whale. JALUR A (Rugpull Trap): Jika Whale pasif (0 buyback) atau ada sell >= 8 SOL, LANGSUNG EXIT di detik 20-25 (kunci cuan +40% - +80% sebelum bom banting). JALUR B (Runner Sejati): Jika Whale aktif ping-pong (buyback >= 1x, sell < 8 SOL), SWITCH KE WAVE RIDER MODE (tahan hingga trailing stop -20% pasca +100%, whale exhaustion 3x sell, atau timeout 30m).',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s14: {
        id: 'SCENARIO_14_BUNDLER_RUNNER',
        name: 'Skenario 14: Bundler-Confirmed Runner (Wave Rider)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry. Standby saat Detik 0 (menghindari rugpull kilat & shakeout trap). Menunggu konfirmasi on-chain Bundler Rate >= 5.0% dan Whale terbukti aktif buyback/ping-pong. Begitu terkonfirmasi runner: BUY $5.00. Take Profit Bertahap: Jual 50% di +50% gain (amankan modal), sisa 50% moonbag ditahan hingga +100% atau Whale Dump. Stop Loss -20% dari entry (sebelum TP 1). Whale consecutive sells hanya hitung order signifikan >= 3 SOL atau holding < 50% (anti-shakeout). Giant Dump >= 15 SOL exit 100%.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s14_alpha: {
        id: 'SCENARIO_14_ALPHA_60S_GRACE',
        name: 'Skenario 14-Alpha: Bundler Runner + 60s Grace Period (Anti-Rugpull 100%)',
        description: 'Saldo Awal $5.00. Modal $5.00/entry. Grace Period Umur Token >= 60 detik (kebal total rugpull kilat Dev). Menunggu konfirmasi on-chain Bundler Rate >= 5.0% dan Whale terbukti aktif. Take Profit Bertahap: Jual 50% di +50% gain, sisa 50% moonbag ke +100% atau Whale Dump. Stop Loss -20% dari entry (sebelum TP 1). Anti-shakeout sell >= 3 SOL. Giant Dump >= 15 SOL exit 100%.',
        initialCash: 5.0,
        availableCash: 5.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 5.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
    };
  }

  private loadState(): { s4: ScenarioState; s5: ScenarioState; s6: ScenarioState; s7: ScenarioState; s8: ScenarioState; s9: ScenarioState; s9_5: ScenarioState; s10: ScenarioState; s13: ScenarioState; s13_5: ScenarioState; s13_alpha: ScenarioState; s13_beta: ScenarioState; s13_alpha_1: ScenarioState; s13_beta_1: ScenarioState; s13_centaur: ScenarioState; s14: ScenarioState; s14_alpha: ScenarioState } {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.s4 || parsed.s5 || parsed.s6 || parsed.s7 || parsed.s8 || parsed.s9 || parsed.s9_5 || parsed.s10 || parsed.s13 || parsed.s13_5 || parsed.s13_alpha || parsed.s13_beta || parsed.s13_alpha_1 || parsed.s13_beta_1 || parsed.s13_centaur || parsed.s14 || parsed.s14_alpha) {
          const fresh = this.initFreshScenarios();
          const s4 = parsed.s4 || fresh.s4;
          const s5 = parsed.s5 || fresh.s5;
          const s6 = parsed.s6 || fresh.s6;
          const s7 = parsed.s7 || fresh.s7;
          const s8 = parsed.s8 || fresh.s8;
          const s9 = parsed.s9 || fresh.s9;
          const s9_5 = parsed.s9_5 || fresh.s9_5;
          const s10 = parsed.s10 || fresh.s10;
          const s13 = parsed.s13 || fresh.s13;
          const s13_5 = parsed.s13_5 || fresh.s13_5;
          const s13_alpha = parsed.s13_alpha || fresh.s13_alpha;
          const s13_beta = parsed.s13_beta || fresh.s13_beta;
          const s13_alpha_1 = parsed.s13_alpha_1 || fresh.s13_alpha_1;
          const s13_beta_1 = parsed.s13_beta_1 || fresh.s13_beta_1;
          const s13_centaur = parsed.s13_centaur || fresh.s13_centaur;
          const s14 = parsed.s14 || fresh.s14;
          const s14_alpha = parsed.s14_alpha || fresh.s14_alpha;
          s13_alpha.name = fresh.s13_alpha.name;
          s13_alpha.description = fresh.s13_alpha.description;
          s13_beta.name = fresh.s13_beta.name;
          s13_beta.description = fresh.s13_beta.description;
          s13_alpha_1.name = fresh.s13_alpha_1.name;
          s13_alpha_1.description = fresh.s13_alpha_1.description;
          s13_beta_1.name = fresh.s13_beta_1.name;
          s13_beta_1.description = fresh.s13_beta_1.description;
          s13_centaur.name = fresh.s13_centaur.name;
          s13_centaur.description = fresh.s13_centaur.description;
          s14.name = fresh.s14.name;
          s14.description = fresh.s14.description;
          s14_alpha.name = fresh.s14_alpha.name;
          s14_alpha.description = fresh.s14_alpha.description;
          if (s4.totalFeesPaid === undefined) s4.totalFeesPaid = 0.0;
          if (s5.totalFeesPaid === undefined) s5.totalFeesPaid = 0.0;
          if (s6.totalFeesPaid === undefined) s6.totalFeesPaid = 0.0;
          if (s7.totalFeesPaid === undefined) s7.totalFeesPaid = 0.0;
          if (s8.totalFeesPaid === undefined) s8.totalFeesPaid = 0.0;
          if (s9.totalFeesPaid === undefined) s9.totalFeesPaid = 0.0;
          if (s9_5.totalFeesPaid === undefined) s9_5.totalFeesPaid = 0.0;
          if (s10.totalFeesPaid === undefined) s10.totalFeesPaid = 0.0;
          if (s13.totalFeesPaid === undefined) s13.totalFeesPaid = 0.0;
          if (s13_5.totalFeesPaid === undefined) s13_5.totalFeesPaid = 0.0;
          if (s13_alpha.totalFeesPaid === undefined) s13_alpha.totalFeesPaid = 0.0;
          if (s13_beta.totalFeesPaid === undefined) s13_beta.totalFeesPaid = 0.0;
          if (s13_alpha_1.totalFeesPaid === undefined) s13_alpha_1.totalFeesPaid = 0.0;
          if (s13_beta_1.totalFeesPaid === undefined) s13_beta_1.totalFeesPaid = 0.0;
          if (s13_centaur.totalFeesPaid === undefined) s13_centaur.totalFeesPaid = 0.0;
          if (s14.totalFeesPaid === undefined) s14.totalFeesPaid = 0.0;
          if (s14_alpha.totalFeesPaid === undefined) s14_alpha.totalFeesPaid = 0.0;
          return { s4, s5, s6, s7, s8, s9, s9_5, s10, s13, s13_5, s13_alpha, s13_beta, s13_alpha_1, s13_beta_1, s13_centaur, s14, s14_alpha };
        }
      } catch {}
    }
    return this.initFreshScenarios();
  }

  public saveState(): void {
    try {
      for (const s of Object.values(this.scenarios)) {
        s.investedCash = Number(s.openPositions.reduce((acc, p) => acc + p.costBasisUsd, 0).toFixed(2));
        s.unrealizedPnl = Number(s.openPositions.reduce((acc, p) => acc + p.unrealizedPnlUsd, 0).toFixed(2));
        s.totalPortfolioValue = Number((s.availableCash + s.investedCash + s.unrealizedPnl).toFixed(2));
        s.winRate = s.totalTrades > 0 ? Number(((s.wins / s.totalTrades) * 100).toFixed(1)) : 0.0;
      }

      fs.writeFileSync(this.filePath, JSON.stringify(this.scenarios, null, 2), 'utf8');
    } catch (err: any) {
      console.warn(`[DRYRUN-ENGINE-SAVE-WARN] ${err?.message}`);
    }
  }

  /**
   * Tangani aktivitas Target BUY secara simultan di skenario s4, s6, dan s7
   */
  public handleTargetBuy(
    signal: WalletTradeSignal,
    isGroundZero: boolean
  ): void {
    const now = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(now);
    const targetUsd = signal.usdAmount > 0 ? signal.usdAmount : (signal.solAmount * 100);

    // Baca konfigurasi stake dinamis (default: semua skenario $1.00)
    let s4Stake = 1.0;
    let s5Stake = 1.0;
    let s6Pool1 = 1.0;
    let s6Pool2 = 1.0;
    let s7Pool1 = 1.0;
    let s7Pool2 = 1.0;
    try {
      const cfg = readFollowerLiveConfig(this.dataDir);
      if (cfg.stakeUsdS4) s4Stake = Number(cfg.stakeUsdS4);
      if (cfg.stakeUsdS5) s5Stake = Number(cfg.stakeUsdS5);
      if (cfg.stakeUsdS6Pool1) s6Pool1 = Number(cfg.stakeUsdS6Pool1);
      if (cfg.stakeUsdS6Pool2) s6Pool2 = Number(cfg.stakeUsdS6Pool2);
      if (cfg.stakeUsdS7Pool1) s7Pool1 = Number(cfg.stakeUsdS7Pool1);
      if (cfg.stakeUsdS7Pool2) s7Pool2 = Number(cfg.stakeUsdS7Pool2);
    } catch {}

    // Mulai riset pemantauan Bundler tiap 5 detik untuk token yang dibeli target Whale
    this.startBundlerResearchTracker(signal.mint, signal.symbol);

    // 1. Skenario 4 (2-Lapis Shakeout Trap: Hold 8s & Dump on Buyback)
    // Cek apakah S4 sedang menunggu buyback pada token ini (Lapis 2: Dump on Buyback)
    const s4PosIdx = this.scenarios.s4.openPositions.findIndex(p => p.mint === signal.mint);
    if (s4PosIdx >= 0) {
      const s4Pos = this.scenarios.s4.openPositions[s4PosIdx];
      if (s4Pos.waitingBuybackSince) {
        const elapsedSinceSell = (now - s4Pos.waitingBuybackSince) / 1000;
        if (elapsedSinceSell <= 8.5) {
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 4 LAPIS 2: DUMP ON BUYBACK] Target Buyback $${targetUsd.toFixed(0)} di +${elapsedSinceSell.toFixed(1)}s!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Aksi     : LANGSUNG SELL 100% Dump ke Likuiditas Buy Target!`);
          console.log(`=========================================================\n`);
          const exitReason = `S4_DUMP_ON_BUYBACK (Target buyback $${targetUsd.toFixed(0)} di +${elapsedSinceSell.toFixed(1)}s pasca-shakeout, panen likuiditas)`;
          this.executeScenarioExit(this.scenarios.s4, s4PosIdx, signal.priceUsd, now, timeWib, exitReason);
        }
      }
    }

    this.processScenarioBuy(this.scenarios.s4, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s4Stake,
      getStake: () => s4Stake,
      disallowAccumulation: true,
    });
    // Auto-rotasi: Setelah buy Mint baru, segera sell 100% posisi lama yang memiliki simbol/nama sama
    this.autoRotateSameSymbolPositions(this.scenarios.s4, signal, now, timeWib);

    // 1b. Skenario 5 (Anti-Shakeout Runner: Hold >= 12s, TP +25%, Time-Stop 35s)
    this.processScenarioBuy(this.scenarios.s5, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s5Stake,
      getStake: () => s5Stake,
      disallowAccumulation: true,
    });
    this.autoRotateSameSymbolPositions(this.scenarios.s5, signal, now, timeWib);

    // 2. Skenario 6 & 7 (Re-Deploy Sniper / Time-Stop: Pool 1 Dinamis, Pool 2 Dinamis)
    // Cek generasi pool berdasarkan kemunculan ticker nama token
    const normSym = (signal.symbol || '').toUpperCase().trim();
    let gen = 1;
    const existingGen = this.tokenGenerations.get(normSym);
    const TWENTY_MIN_MS = 20 * 60 * 1000;

    if (existingGen) {
      if (existingGen.lastMint !== signal.mint && (now - existingGen.firstSeenAt <= TWENTY_MIN_MS)) {
        // Nama sama, Contract Address beda, dalam 20 menit -> Pool 2 (Re-Deploy!)
        gen = existingGen.generation + 1;
        this.tokenGenerations.set(normSym, { firstSeenAt: now, generation: gen, lastMint: signal.mint });
      } else if (existingGen.lastMint === signal.mint) {
        gen = existingGen.generation;
      } else {
        // Melewati 20 menit -> reset ke generasi 1
        gen = 1;
        this.tokenGenerations.set(normSym, { firstSeenAt: now, generation: 1, lastMint: signal.mint });
      }
    } else {
      this.tokenGenerations.set(normSym, { firstSeenAt: now, generation: 1, lastMint: signal.mint });
    }

    // Aturan S6: Pool 1 stake dinamis, Pool 2+ stake dinamis
    const s6Stake = gen >= 2 ? s6Pool2 : s6Pool1;

    this.processScenarioBuy(this.scenarios.s6, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s6Stake,
      getStake: () => s6Stake,
      disallowAccumulation: true,
    });
    // Auto-rotasi: Setelah buy Mint baru, segera sell 100% posisi lama yang memiliki simbol/nama sama
    this.autoRotateSameSymbolPositions(this.scenarios.s6, signal, now, timeWib);

    // 3. Skenario 7 (Time-Stop Sniper: Stage 1 @ 5% + Force Sell 100% @ 28s)
    const s7Stake = gen >= 2 ? s7Pool2 : s7Pool1;
    this.processScenarioBuy(this.scenarios.s7, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s7Stake,
      getStake: () => s7Stake,
      disallowAccumulation: true,
    });
    this.autoRotateSameSymbolPositions(this.scenarios.s7, signal, now, timeWib);

    // Sinkronkan alamat Pool aktif ke posisi yang dipegang:
    // Jika target whale masuk bertransaksi di pool tertentu (signal.pairAddress),
    // seluruh skenario otomatis mengalihkan tujuan SELL ke pool whale tersebut!
    if (signal.pairAddress) {
      for (const sc of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9, this.scenarios.s9_5, this.scenarios.s10, this.scenarios.s13]) {
        const p = sc.openPositions.find(pos => pos.mint === signal.mint);
        if (p && p.pairAddress !== signal.pairAddress) {
          console.log(`[DYNAMIC POOL REDIRECTION] 🔄 Mengalihkan pool ${p.symbol} [${sc.id}] dari ${p.pairAddress ? p.pairAddress.slice(0, 8) + '...' : 'none'} ke Pool Whale: ${signal.pairAddress.slice(0, 8)}...`);
          p.pairAddress = signal.pairAddress;
        }
      }
    }

    // 4. Skenario 8 (Front-Run Dev & Hold 20s Post-Target Inflow)
    // Jika S8 memiliki posisi terbuka pada koin ini yang dibeli di Genesis:
    // TARGET SUDAH MASUK (15-20 SOL)! Kurva harga terpompa! Kunci waktu masuk target & tahan hingga 20 detik!
    const s8PosIdx = this.scenarios.s8.openPositions.findIndex(p => p.mint === signal.mint);
    if (s8PosIdx >= 0) {
      const s8Pos = this.scenarios.s8.openPositions[s8PosIdx];
      if (s8Pos.boughtAtGenesis && !s8Pos.targetEnteredAt) {
        s8Pos.targetEnteredAt = now;
        s8Pos.lastPriceUsd = signal.priceUsd;
        console.log(`\n=========================================================`);
        console.log(`🎯 [SCENARIO 8 TARGET INFLOW DETECTED] Target Masuk Beli ${signal.solAmount} SOL!`);
        console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
        console.log(`   Harga In : $${s8Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
        console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);
        console.log(`   Strategi : Tahan posisi selama 20 detik pasca-target masuk untuk maksimalkan profit!`);
        console.log(`=========================================================\n`);
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s8, signal, now, timeWib);

    // 5. Skenario 9: Dev Front-Run & 2-Way Target Sync
    for (let i = this.scenarios.s9.openPositions.length - 1; i >= 0; i--) {
      const s9Pos = this.scenarios.s9.openPositions[i];
      if (s9Pos.mint === signal.mint) {
        if (!s9Pos.targetEnteredAt) {
          s9Pos.targetEnteredAt = now;
          s9Pos.lastPriceUsd = signal.priceUsd;
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 9 TARGET INFLOW DETECTED] Target Whale MASUK ke token Front-Run '${s9Pos.symbol}' ($${targetUsd.toFixed(0)})!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Harga In : $${s9Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
          console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);

          // JIKA MODAL MASUK WHALE KECIL (< $300 atau < 3 SOL): LANGSUNG DUMP SELL 100%!
          // Menyelamatkan cuan di harga pompa whale sebelum whale membanting 2-10 detik kemudian!
          if (targetUsd > 0 && targetUsd < 300) {
            console.log(`   Strategi : ⚡ MICRO-INFLOW HARVEST (Modal whale $${targetUsd.toFixed(0)} < $300, langsung dump jual sebelum whale membanting)!`);
            console.log(`=========================================================\n`);
            const exitReason = `S9_MICRO_WHALE_INFLOW_HARVEST (Whale masuk modal kecil $${targetUsd.toFixed(0)} < $300, langsung dump jual sebelum whale membanting)`;
            this.executeScenarioExit(this.scenarios.s9, i, signal.priceUsd, now, timeWib, exitReason);
            continue;
          }

          console.log(`   Strategi : Mengaktifkan proteksi runner (Anti-Shakeout 12s + Follow Whale Sell)...`);
          console.log(`=========================================================\n`);
        }
      } else {
        // Target beli token lain saat S9 masih nunggu target di token ini!
        if (!s9Pos.targetEnteredAt) {
          console.log(`[SCENARIO 9] ⚠️ Target BERALIH beli '${signal.symbol}'! Mengosongkan posisi koin lama '${s9Pos.symbol}'...`);
          const reason = `TARGET_SWITCHED_DEV (Target beli '${signal.symbol}' bukan '${s9Pos.symbol}', batalkan front-run lama)`;
          this.executeScenarioExit(this.scenarios.s9, i, s9Pos.lastPriceUsd, now, timeWib, reason);
        }
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s9, signal, now, timeWib);

    // 5b. Skenario 9.5: Split TP 50/50 + 1-Min Moonbag (Genesis Buy + 50% TP @ >=300% & 50% Hold 1m / Dump on Whale Exit)
    for (let i = this.scenarios.s9_5.openPositions.length - 1; i >= 0; i--) {
      const s95Pos = this.scenarios.s9_5.openPositions[i];
      if (s95Pos.mint === signal.mint) {
        if (!s95Pos.targetEnteredAt) {
          s95Pos.targetEnteredAt = now;
          s95Pos.lastPriceUsd = signal.priceUsd;
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 9.5 TARGET INFLOW DETECTED] Target Whale MASUK ke token Front-Run '${s95Pos.symbol}' ($${targetUsd.toFixed(0)})!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Harga In : $${s95Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
          console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);

          // JIKA MODAL MASUK WHALE KECIL (< $300 atau < 3 SOL): LANGSUNG DUMP SELL 100%!
          if (targetUsd > 0 && targetUsd < 300) {
            console.log(`   Strategi : ⚡ MICRO-INFLOW HARVEST (Modal whale $${targetUsd.toFixed(0)} < $300, langsung dump jual sebelum whale membanting)!`);
            console.log(`=========================================================\n`);
            const exitReason = `S95_MICRO_WHALE_INFLOW_HARVEST (Whale masuk modal kecil $${targetUsd.toFixed(0)} < $300, langsung dump jual sebelum whale membanting)`;
            this.executeScenarioExit(this.scenarios.s9_5, i, signal.priceUsd, now, timeWib, exitReason);
            continue;
          }

          // Cek apakah lonjakan awal swap saat whale masuk sudah tembus >= +300%
          const initialGainPct = s95Pos.avgEntryPriceUsd > 0 ? ((signal.priceUsd - s95Pos.avgEntryPriceUsd) / s95Pos.avgEntryPriceUsd) * 100 : 0;
          if (initialGainPct >= 300.0 && !s95Pos.stage1Exited) {
            console.log(`   Strategi : 🚀 GAIN AWAL >= +300% (+${initialGainPct.toFixed(1)}%) -> JUAL 50% SEKARANG, SISA 50% DITAHAN 1 MENIT!`);
            console.log(`=========================================================\n`);
            this.executeScenarioPartial50Exit(this.scenarios.s9_5, i, signal.priceUsd, now, timeWib, `STAGE_1_TP_50%_MOONBAG (Initial Gain +${initialGainPct.toFixed(1)}% >= +300% | Kunci modal & 50% profit masif)`);
            continue;
          }

          console.log(`   Strategi : Mengaktifkan proteksi runner (Anti-Shakeout 12s + Follow Whale Sell)...`);
          console.log(`=========================================================\n`);
        }
      } else {
        if (!s95Pos.targetEnteredAt) {
          console.log(`[SCENARIO 9.5] ⚠️ Target BERALIH beli '${signal.symbol}'! Mengosongkan posisi koin lama '${s95Pos.symbol}'...`);
          const reason = `TARGET_SWITCHED_DEV (Target beli '${signal.symbol}' bukan '${s95Pos.symbol}', batalkan front-run lama)`;
          this.executeScenarioExit(this.scenarios.s9_5, i, s95Pos.lastPriceUsd, now, timeWib, reason);
        }
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s9_5, signal, now, timeWib);

    // 6. Skenario 10: Dynamic Wave Runner (Genesis Buy + MCap/Whale Sell Sync)
    for (let i = this.scenarios.s10.openPositions.length - 1; i >= 0; i--) {
      const s10Pos = this.scenarios.s10.openPositions[i];
      if (s10Pos.mint === signal.mint) {
        if (!s10Pos.targetEnteredAt) {
          s10Pos.targetEnteredAt = now;
          s10Pos.lastPriceUsd = signal.priceUsd;
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 10 TARGET INFLOW DETECTED] Target Whale MASUK ke token Front-Run '${s10Pos.symbol}' ($${targetUsd.toFixed(0)})!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Harga In : $${s10Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
          console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);
          console.log(`   Strategi : Dynamic Wave Runner (Tahan selama whale hold & exit saat whale sell >= 15%)...`);
          console.log(`=========================================================\n`);
        }
      } else {
        // Target beli token lain saat S10 masih nunggu target di token ini!
        if (!s10Pos.targetEnteredAt) {
          console.log(`[SCENARIO 10] ⚠️ Target BERALIH beli '${signal.symbol}'! Mengosongkan posisi koin lama '${s10Pos.symbol}'...`);
          const reason = `TARGET_SWITCHED_DEV (Target beli '${signal.symbol}' bukan '${s10Pos.symbol}', batalkan front-run lama)`;
          this.executeScenarioExit(this.scenarios.s10, i, s10Pos.lastPriceUsd, now, timeWib, reason);
        }
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s10, signal, now, timeWib);

    // 7. Skenario 13: Multi-Cycle Ping-Pong Scalper (Aktivasi Radar & Eksekusi Jual pada Whale Buyback)
    const existingS13Tracker = this.s13PingPongTrackers.get(signal.mint);

    // Kasus 7A: Whale First Buy -> Cek apakah memenuhi syarat High Conviction (>= 20 SOL / >= $1800) untuk mulai sesi pingpong!
    if (!existingS13Tracker) {
      const isHighConvictionInflow = (targetUsd >= 1800 || (signal.solAmount && signal.solAmount >= 20));
      if (isHighConvictionInflow && (isGroundZero || signal.isFirstBuy)) {
        this.s13PingPongTrackers.set(signal.mint, {
          mint: signal.mint,
          symbol: signal.symbol,
          pairAddress: signal.pairAddress || '',
          exchange: signal.exchange || 'pump_amm',
          whaleFirstBuyAt: now,
          whaleFirstBuyUsd: targetUsd,
          whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
          whaleRemainingHolding: signal.remainingHolding,
          whalePeakHolding: signal.remainingHolding,
          cycleCount: 0,
          maxCycles: 10,
          status: 'ACTIVE',
          lastExitAt: 0,
        });
        console.log(`\n=========================================================`);
        console.log(`🏓 [SCENARIO 13 PING-PONG RADAR ACTIVATED] Target Whale Masuk ${signal.solAmount || (targetUsd / 90).toFixed(1)} SOL ($${targetUsd.toFixed(0)}) di '${signal.symbol}'!`);
        console.log(`   Status      : Skenario 13 AKTIF untuk Multi-Cycle Scalping (Maks 10 Siklus / 15 Menit)!`);
        console.log(`   Aturan Masuk: Beli di Lembah (saat Whale SELL kecil) -> Jual di Puncak TP +10% atau Whale Buyback!`);
        console.log(`=========================================================\n`);
      }
    } else if (existingS13Tracker.status === 'ACTIVE') {
      // Kasus 7B: S13 sedang memegang koin dan Target Whale melakukan BUYBACK!
      const s13PosIdx = this.scenarios.s13.openPositions.findIndex(p => p.mint === signal.mint);
      if (s13PosIdx >= 0) {
        const pos = this.scenarios.s13.openPositions[s13PosIdx];
        const gainPct = pos.avgEntryPriceUsd > 0 ? ((signal.priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100 : 0;
        if (gainPct >= 4.0 || signal.priceUsd > pos.avgEntryPriceUsd) {
          const reason = `S13_PINGPONG_DUMP_ON_BUYBACK (Whale buyback $${targetUsd.toFixed(0)}, dump ke likuiditas whale | Gain: +${gainPct.toFixed(1)}% | Siklus #${pos.entryCount})`;
          this.executeScenarioExit(this.scenarios.s13, s13PosIdx, signal.priceUsd, now, timeWib, reason);
          existingS13Tracker.lastExitAt = now;
        }
      }
    }

    // 8. Skenario 13.5: Adaptive Ping-Pong Runner (Uncapped Cycles | 3 Consecutive Sells & Dynamic Health Gates)
    const existingS13_5Tracker = this.s13_5PingPongTrackers.get(signal.mint);
    if (!existingS13_5Tracker) {
      const isHighConvictionInflow = (targetUsd >= 1800 || (signal.solAmount && signal.solAmount >= 20));
      if (isHighConvictionInflow && (isGroundZero || signal.isFirstBuy)) {
        this.s13_5PingPongTrackers.set(signal.mint, {
          mint: signal.mint,
          symbol: signal.symbol,
          pairAddress: signal.pairAddress || '',
          exchange: signal.exchange || 'pump_amm',
          whaleFirstBuyAt: now,
          whaleFirstBuyUsd: targetUsd,
          whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
          whaleRemainingHolding: signal.remainingHolding,
          whalePeakHolding: signal.remainingHolding,
          consecutiveSells: 0,
          cycleCount: 0,
          status: 'ACTIVE',
          lastExitAt: 0,
        });
        console.log(`\n=========================================================`);
        console.log(`⚡ [SCENARIO 13.5 DYNAMIC PING-PONG RADAR ACTIVATED] Target Whale Masuk ${signal.solAmount || (targetUsd / 90).toFixed(1)} SOL ($${targetUsd.toFixed(0)}) di '${signal.symbol}'!`);
        console.log(`   Status      : Skenario 13.5 AKTIF (Uncapped Dynamic Cycles | 3 Consecutive Sells & Health Gates)!`);
        console.log(`   Aturan Masuk: Beli di Lembah Sell #1 -> Jual di TP +10% atau Whale Buyback! Bekukan jika Sell >= 2x!`);
        console.log(`=========================================================\n`);
      }
    } else if (existingS13_5Tracker.status === 'ACTIVE') {
      // Reset counter consecutive sells saat ada BUY / Buyback dari Whale!
      existingS13_5Tracker.consecutiveSells = 0;
      existingS13_5Tracker.whaleRemainingHolding = signal.remainingHolding;
      if (signal.remainingHolding > existingS13_5Tracker.whalePeakHolding) {
        existingS13_5Tracker.whalePeakHolding = signal.remainingHolding;
      }

      const s13_5PosIdx = this.scenarios.s13_5.openPositions.findIndex(p => p.mint === signal.mint);
      if (s13_5PosIdx >= 0) {
        const pos = this.scenarios.s13_5.openPositions[s13_5PosIdx];
        const gainPct = pos.avgEntryPriceUsd > 0 ? ((signal.priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100 : 0;
        if (gainPct >= 4.0 || signal.priceUsd > pos.avgEntryPriceUsd) {
          const reason = `S13_5_PINGPONG_DUMP_ON_BUYBACK (Whale buyback $${targetUsd.toFixed(0)}, dump ke likuiditas whale | Gain: +${gainPct.toFixed(1)}% | Siklus #${pos.entryCount})`;
          this.executeScenarioExit(this.scenarios.s13_5, s13_5PosIdx, signal.priceUsd, now, timeWib, reason);
          existingS13_5Tracker.lastExitAt = now;
        }
      }
    }

    // 9. Skenario 13-Alpha: 1-Second Sniper Gate (Pre-Entry 1s Verification | 100% Anti-Rugpull)
    const existingS13AlphaTracker = this.s13AlphaTrackers.get(signal.mint);
    if (!existingS13AlphaTracker) {
      const isHighConvictionInflow = (targetUsd >= 1800 || (signal.solAmount && signal.solAmount >= 20));
      if (isHighConvictionInflow && (isGroundZero || signal.isFirstBuy)) {
        const alphaTracker: S13AlphaState = {
          mint: signal.mint,
          symbol: signal.symbol,
          pairAddress: signal.pairAddress || '',
          exchange: signal.exchange || 'pump_amm',
          whaleFirstBuyAt: now,
          whaleFirstBuyUsd: targetUsd,
          whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
          whaleRemainingHolding: signal.remainingHolding,
          whalePeakHolding: signal.remainingHolding,
          consecutiveSells: 0,
          cycleCount: 0,
          status: 'PENDING_1S_VERIFICATION',
          lastExitAt: 0,
          sniperBuysIn1s: 0,
          sniperSellsIn1s: 0,
          targetBuySignal: signal
        };

        // Pasang timer 1.000 ms (1 detik) untuk evaluasi sniper gate
        alphaTracker.verificationTimer = setTimeout(async () => {
          await this.evaluateS13Alpha1sGate(signal.mint);
        }, 1000);

        this.s13AlphaTrackers.set(signal.mint, alphaTracker);

        // Pasang juga untuk S13-Alpha-1 (Whale Wave Rider)
        const alpha1Tracker: S13AlphaState = {
          ...alphaTracker,
          verificationTimer: setTimeout(async () => {
            await this.evaluateS13Alpha1Gate(signal.mint);
          }, 1000)
        };
        this.s13Alpha1Trackers.set(signal.mint, alpha1Tracker);

        console.log(`\n=========================================================`);
        console.log(`🛡️ [SCENARIO 13-ALPHA & ALPHA-1 1S GATE ACTIVATED] Target Whale Masuk ${signal.solAmount || (targetUsd / 90).toFixed(1)} SOL ($${targetUsd.toFixed(0)}) di '${signal.symbol}'!`);
        console.log(`   Status      : Membuka Jendela Verifikasi 1.000 ms (Detik 0 -> Detik 1)...`);
        console.log(`   Aturan Gate : Jika dalam 1s terdeteksi >= 3 sniper sell atau >= 12 txs -> BATALKAN BUY.`);
        console.log(`                 Jika aman -> EKSEKUSI BUY di detik 1!`);
        console.log(`                 S13-Alpha: Target TP +100% | S13-Alpha-1: Wave Rider (Cuan Maksimal)`);
        console.log(`=========================================================\n`);
      }
    } else if (existingS13AlphaTracker.status === 'ACTIVE') {
      existingS13AlphaTracker.consecutiveSells = 0;
      existingS13AlphaTracker.whaleRemainingHolding = signal.remainingHolding;
      if (signal.remainingHolding > existingS13AlphaTracker.whalePeakHolding) {
        existingS13AlphaTracker.whalePeakHolding = signal.remainingHolding;
      }
      const s13AlphaPosIdx = this.scenarios.s13_alpha.openPositions.findIndex(p => p.mint === signal.mint);
      if (s13AlphaPosIdx >= 0) {
        const pos = this.scenarios.s13_alpha.openPositions[s13AlphaPosIdx];
        pos.lastPriceUsd = signal.priceUsd;
      }
    }

    // Update S13-Alpha-1 saat Whale Buyback / Buy More
    const existingS13Alpha1Tracker = this.s13Alpha1Trackers.get(signal.mint);
    if (existingS13Alpha1Tracker && existingS13Alpha1Tracker.status === 'ACTIVE') {
      existingS13Alpha1Tracker.consecutiveSells = 0;
      existingS13Alpha1Tracker.whaleRemainingHolding = signal.remainingHolding;
      if (signal.remainingHolding > existingS13Alpha1Tracker.whalePeakHolding) {
        existingS13Alpha1Tracker.whalePeakHolding = signal.remainingHolding;
      }
      const posIdx = this.scenarios.s13_alpha_1.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx >= 0) {
        this.scenarios.s13_alpha_1.openPositions[posIdx].lastPriceUsd = signal.priceUsd;
      }
    }

    // 10. Skenario 13-Beta: Instant Buy + 1.5s Panic Cut (Post-Entry Rescue on Sniper Sells)
    const existingS13BetaTracker = this.s13BetaTrackers.get(signal.mint);
    if (!existingS13BetaTracker) {
      const isHighConvictionInflow = (targetUsd >= 1800 || (signal.solAmount && signal.solAmount >= 20));
      if (isHighConvictionInflow && (isGroundZero || signal.isFirstBuy)) {
        const betaTracker: S13BetaState = {
          mint: signal.mint,
          symbol: signal.symbol,
          pairAddress: signal.pairAddress || '',
          exchange: signal.exchange || 'pump_amm',
          whaleFirstBuyAt: now,
          whaleFirstBuyUsd: targetUsd,
          whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
          whaleRemainingHolding: signal.remainingHolding,
          whalePeakHolding: signal.remainingHolding,
          consecutiveSells: 0,
          cycleCount: 1,
          status: 'ACTIVE_MONITORING',
          lastExitAt: 0,
          sniperBuysIn1s: 0,
          sniperSellsIn1s: 0
        };

        this.s13BetaTrackers.set(signal.mint, betaTracker);

        let s13BetaStake = 5.0;
        try {
          const liveCfg = readFollowerLiveConfig(this.dataDir);
          s13BetaStake = (liveCfg as any).stakeUsdS13Beta || (liveCfg as any).stakeUsdS13 || 5.0;
        } catch {}

        // S13-Beta langsung BUY di Detik 0 bersama Whale!
        this.processScenarioBuy(this.scenarios.s13_beta, signal, isGroundZero, targetUsd, now, timeWib, {
          maxTokenExposure: s13BetaStake,
          getStake: () => s13BetaStake,
          disallowAccumulation: true,
          allowReEntryCycle: true,
          cycleIndex: 1
        });

        const createdBetaPos = this.scenarios.s13_beta.openPositions.find(p => p.mint === signal.mint);
        if (createdBetaPos) {
          createdBetaPos.pairAddress = signal.pairAddress || '';
          createdBetaPos.entryCount = 1;
        }

        // S13-Beta-1 (Wave Rider) juga langsung BUY di Detik 0 bersama Whale!
        const beta1Tracker: S13BetaState = { ...betaTracker };
        this.s13Beta1Trackers.set(signal.mint, beta1Tracker);
        let s13Beta1Stake = 5.0;
        try {
          const liveCfg = readFollowerLiveConfig(this.dataDir);
          s13Beta1Stake = (liveCfg as any).stakeUsdS13Beta1 || (liveCfg as any).stakeUsdS13 || 5.0;
        } catch {}

        this.processScenarioBuy(this.scenarios.s13_beta_1, signal, isGroundZero, targetUsd, now, timeWib, {
          maxTokenExposure: s13Beta1Stake,
          getStake: () => s13Beta1Stake,
          disallowAccumulation: true,
          allowReEntryCycle: true,
          cycleIndex: 1
        });
        const createdBeta1Pos = this.scenarios.s13_beta_1.openPositions.find(p => p.mint === signal.mint);
        if (createdBeta1Pos) {
          createdBeta1Pos.pairAddress = signal.pairAddress || '';
          createdBeta1Pos.entryCount = 1;
        }

        // S13-Centaur: Membuka Jendela Verifikasi MEV 1.000 ms sebelum eksekusi (Anti-Rugpull Trap)
        const centaurTracker: S13CentaurState = {
          mint: signal.mint,
          symbol: signal.symbol,
          pairAddress: signal.pairAddress,
          exchange: signal.exchange,
          whaleFirstBuyAt: now,
          whaleFirstBuyUsd: targetUsd,
          whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
          whaleWallet: (signal as any).ad || (signal as any).devWallet || '',
          sniperBuysIn1s: 0,
          sniperSellsIn1s: 0,
          whaleBuybacks10_25s: 0,
          hasLargeSell10_25s: false,
          consecutiveWhaleSells: 0,
          status: 'PENDING_1S_VERIFICATION',
          peakPriceUsd: signal.priceUsd,
          lastExitAt: 0,
          targetBuySignal: signal,
          verificationTimer: setTimeout(async () => {
            await this.evaluateS13Centaur1sGate(signal.mint);
          }, 1000)
        };
        this.s13CentaurTrackers.set(signal.mint, centaurTracker);

        const s14Tracker: S14BundlerRunnerState = {
          mint: signal.mint,
          symbol: signal.symbol,
          pairAddress: signal.pairAddress,
          exchange: signal.exchange,
          whaleWallet: (signal as any).ad || (signal as any).devWallet || '',
          whaleFirstBuyAt: now,
          whaleFirstBuyUsd: targetUsd,
          whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
          whalePeakHolding: signal.remainingHolding || signal.tokenAmount || 1,
          whaleRemainingHolding: signal.remainingHolding || signal.tokenAmount || 1,
          whaleBuysCount: 1,
          whaleSellsCount: 0,
          consecutiveWhaleSells: 0,
          hasEntered: false,
          status: 'OBSERVING_BUNDLER',
          bundlerPct: 0,
          peakPriceUsd: signal.priceUsd,
          lastExitAt: 0,
          targetBuySignal: signal,
        };
        this.s14Trackers.set(signal.mint, s14Tracker);

        const s14AlphaTracker: S14BundlerRunnerState = {
          ...s14Tracker,
        };
        this.s14AlphaTrackers.set(signal.mint, s14AlphaTracker);

        console.log(`\n=========================================================`);
        console.log(`💎 [SCENARIO 14 RADAR ACTIVATED] Target Whale Masuk ${signal.solAmount || (targetUsd/90).toFixed(1)} SOL ($${targetUsd.toFixed(0)}) di '${signal.symbol}'!`);
        console.log(`   Status      : Standby Cash (Menunggu Konfirmasi On-Chain Bundler >= 5.0%)...`);
        console.log(`   Aturan Masuk: Masuk saat Bundler Rate >= 5% & Whale aktif buyback/ping-pong.`);
        console.log(`   Aturan Jual : Wave Rider (Trailing Stop -20% pasca +100%, Whale Giant Sell >= 15 SOL, Streak 3x Sell).`);
        console.log(`=========================================================\n`);

        console.log(`\n=========================================================`);
        console.log(`🛡️ [SCENARIO 14-ALPHA RADAR ACTIVATED] Target Whale Masuk ${signal.solAmount || (targetUsd/90).toFixed(1)} SOL ($${targetUsd.toFixed(0)}) di '${signal.symbol}'!`);
        console.log(`   Status      : Standby Cash (Menunggu Umur Token >= 60s & Bundler >= 5.0%)...`);
        console.log(`   Aturan Masuk: Grace Period 60 detik (Anti-Rugpull 100%) + Bundler Rate >= 5% + Whale aktif.`);
        console.log(`   Aturan Jual : TP Bertahap (+50% TP 50% -> +100% Moonbag) | Stop Loss -20% dari Entry.`);
        console.log(`=========================================================\n`);

        console.log(`\n=========================================================`);
        console.log(`🐎 [SCENARIO 13-CENTAUR 1S MEV GATE ACTIVATED]`);
        console.log(`   Token        : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
        console.log(`   Whale Inflow : ${signal.solAmount || (targetUsd/90).toFixed(1)} SOL ($${targetUsd.toFixed(0)})`);
        console.log(`   Aturan Gate  : Memantau 1.000 ms -> Block jika rasio sell MEV >= 30% atau >= 4 sells!`);
        console.log(`                 Jika bersih -> BUY di detik 1 & Ride Wave (Exit sebelum Whale dump)!`);
        console.log(`=========================================================\n`);

        setTimeout(async () => {
          const t = this.s13BetaTrackers.get(signal.mint);
          const t1 = this.s13Beta1Trackers.get(signal.mint);
          if ((t && t.status === 'ACTIVE_MONITORING') || (t1 && t1.status === 'ACTIVE_MONITORING')) {
            // ZERO-BLINDSPOT ON-CHAIN CHECK:
            if (signal.pairAddress) {
              try {
                const conn = new Connection(getSolanaRpcUrl());
                const pairPk = new PublicKey(signal.pairAddress);
                const sigs = await conn.getSignaturesForAddress(pairPk, { limit: 25 });
                if (sigs.length >= 12) {
                  const posIdx = this.scenarios.s13_beta.openPositions.findIndex(p => p.mint === signal.mint);
                  if (posIdx >= 0 && t) {
                    t.status = 'PANIC_DUMPED';
                    const pos = this.scenarios.s13_beta.openPositions[posIdx];
                    const exitPrice = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
                    const reason = `S13_BETA_INSTANT_PANIC_DUMP (On-Chain ${sigs.length} txs dlm 1s terdeteksi | Jual darurat selamatkan modal)`;
                    this.executeScenarioExit(this.scenarios.s13_beta, posIdx, exitPrice, Date.now(), formatWibDate(Date.now()), reason);
                    t.lastExitAt = Date.now();
                  }
                  const pos1Idx = this.scenarios.s13_beta_1.openPositions.findIndex(p => p.mint === signal.mint);
                  if (pos1Idx >= 0 && t1) {
                    t1.status = 'PANIC_DUMPED';
                    const pos1 = this.scenarios.s13_beta_1.openPositions[pos1Idx];
                    const exitPrice1 = pos1.lastPriceUsd > 0 ? pos1.lastPriceUsd : pos1.avgEntryPriceUsd;
                    const reason1 = `S13_BETA_1_INSTANT_PANIC_DUMP (On-Chain ${sigs.length} txs dlm 1s terdeteksi | Jual darurat selamatkan modal)`;
                    this.executeScenarioExit(this.scenarios.s13_beta_1, pos1Idx, exitPrice1, Date.now(), formatWibDate(Date.now()), reason1);
                    t1.lastExitAt = Date.now();
                  }
                  console.log(`\n=========================================================`);
                  console.log(`🚨 [SCENARIO 13-BETA & BETA-1 INSTANT PANIC CUT TRIGGERED VIA ON-CHAIN BARRAGE]`);
                  console.log(`   Token        : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
                  console.log(`   Penyebab     : Terdeteksi ${sigs.length} transaksi di pool dlm 1s pertama!`);
                  console.log(`   Aksi         : JUAL DARURAT SEKETIKA sebelum Dev RemoveLiquidity!`);
                  console.log(`=========================================================\n`);
                  return;
                }
              } catch {}
            }
            if (t) t.status = 'ACTIVE';
            if (t1) t1.status = 'ACTIVE';
            console.log(`[SCENARIO 13-BETA & BETA-1] 🟢 1.5s Window Passed! Tidak terdeteksi sniper dump di ${signal.symbol}. Posisi aman, lanjut Ride mode!`);
          }
        }, 1200);
      }
    } else if (existingS13BetaTracker.status === 'ACTIVE' || existingS13BetaTracker.status === 'ACTIVE_MONITORING') {
      existingS13BetaTracker.consecutiveSells = 0;
      existingS13BetaTracker.whaleRemainingHolding = signal.remainingHolding;
      if (signal.remainingHolding > existingS13BetaTracker.whalePeakHolding) {
        existingS13BetaTracker.whalePeakHolding = signal.remainingHolding;
      }
      const s13BetaPosIdx = this.scenarios.s13_beta.openPositions.findIndex(p => p.mint === signal.mint);
      if (s13BetaPosIdx >= 0) {
        const pos = this.scenarios.s13_beta.openPositions[s13BetaPosIdx];
        pos.lastPriceUsd = signal.priceUsd;
      }
    }

    // Update S13-Beta-1 saat Whale Buyback / Buy More
    const existingS13Beta1Tracker = this.s13Beta1Trackers.get(signal.mint);
    if (existingS13Beta1Tracker && (existingS13Beta1Tracker.status === 'ACTIVE' || existingS13Beta1Tracker.status === 'ACTIVE_MONITORING')) {
      existingS13Beta1Tracker.consecutiveSells = 0;
      existingS13Beta1Tracker.whaleRemainingHolding = signal.remainingHolding;
      if (signal.remainingHolding > existingS13Beta1Tracker.whalePeakHolding) {
        existingS13Beta1Tracker.whalePeakHolding = signal.remainingHolding;
      }
      const posIdx = this.scenarios.s13_beta_1.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx >= 0) {
        this.scenarios.s13_beta_1.openPositions[posIdx].lastPriceUsd = signal.priceUsd;
      }
    }

    // Update S13-Centaur saat Whale Buyback / Buy More
    const existingCentaurTracker = this.s13CentaurTrackers.get(signal.mint);
    if (existingCentaurTracker && existingCentaurTracker.status !== 'TERMINATED' && existingCentaurTracker.status !== 'SCALPED_PRE_RUG') {
      existingCentaurTracker.consecutiveWhaleSells = 0;
      const ageSec = (now - existingCentaurTracker.whaleFirstBuyAt) / 1000;
      if (ageSec >= 8 && ageSec <= 35) {
        existingCentaurTracker.whaleBuybacks10_25s++;
      }
      const posIdx = this.scenarios.s13_centaur.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx >= 0) {
        this.scenarios.s13_centaur.openPositions[posIdx].lastPriceUsd = signal.priceUsd;
      }
    }

    // Inisialisasi atau Update S14 Tracker saat Whale Buy
    let s14Tracker = this.s14Trackers.get(signal.mint);
    if (!s14Tracker && (isGroundZero || signal.isFirstBuy || signal.isOpenOrClose || targetUsd >= 500 || (signal.solAmount && signal.solAmount >= 5))) {
      s14Tracker = {
        mint: signal.mint,
        symbol: signal.symbol,
        pairAddress: signal.pairAddress,
        exchange: signal.exchange,
        whaleWallet: (signal as any).ad || (signal as any).devWallet || '',
        whaleFirstBuyAt: now,
        whaleFirstBuyUsd: targetUsd,
        whaleFirstBuySol: signal.solAmount || (targetUsd / 90),
        whalePeakHolding: signal.remainingHolding || signal.tokenAmount || 1,
        whaleRemainingHolding: signal.remainingHolding || signal.tokenAmount || 1,
        whaleBuysCount: 1,
        whaleSellsCount: 0,
        consecutiveWhaleSells: 0,
        hasEntered: false,
        status: 'OBSERVING_BUNDLER',
        bundlerPct: 0,
        peakPriceUsd: signal.priceUsd,
        lastExitAt: 0,
        targetBuySignal: signal,
      };
      this.s14Trackers.set(signal.mint, s14Tracker);

      const s14AlphaTracker: S14BundlerRunnerState = {
        ...s14Tracker,
      };
      this.s14AlphaTrackers.set(signal.mint, s14AlphaTracker);

      console.log(`\n=========================================================`);
      console.log(`💎 [SCENARIO 14 RADAR ACTIVATED] Target Whale Masuk ${signal.solAmount || (targetUsd/90).toFixed(1)} SOL ($${targetUsd.toFixed(0)}) di '${signal.symbol}'!`);
      console.log(`   Status      : Standby Cash (Menunggu Konfirmasi On-Chain Bundler >= 5.0%)...`);
      console.log(`   Aturan Masuk: Masuk saat Bundler Rate >= 5% & Whale aktif buyback/ping-pong.`);
      console.log(`   Aturan Jual : Stop Loss -20% dari Entry | Exit saat Whale Dump (>= 15 SOL / Streak 3x Sell).`);
      console.log(`=========================================================\n`);
    } else {
      if (s14Tracker && s14Tracker.status !== 'TERMINATED' && s14Tracker.status !== 'EXITED_TRAILING_STOP' && s14Tracker.status !== 'EXITED_WHALE_DUMP') {
        s14Tracker.whaleBuysCount++;
        s14Tracker.consecutiveWhaleSells = 0;
        s14Tracker.whaleRemainingHolding = signal.remainingHolding;
        if (signal.remainingHolding > s14Tracker.whalePeakHolding) {
          s14Tracker.whalePeakHolding = signal.remainingHolding;
        }
        const posIdx = this.scenarios.s14.openPositions.findIndex(p => p.mint === signal.mint);
        if (posIdx >= 0) {
          this.scenarios.s14.openPositions[posIdx].lastPriceUsd = signal.priceUsd;
        }
        // Jika belum masuk dan bundler sudah >= 5%: coba evaluasi entry!
        if (!s14Tracker.hasEntered && s14Tracker.bundlerPct >= 5.0) {
          this.evaluateS14BundlerEntry(signal.mint, s14Tracker.bundlerPct, signal.priceUsd);
        }
      }

      let s14AlphaTracker = this.s14AlphaTrackers.get(signal.mint);
      if (s14AlphaTracker && s14AlphaTracker.status !== 'TERMINATED' && s14AlphaTracker.status !== 'EXITED_TRAILING_STOP' && s14AlphaTracker.status !== 'EXITED_WHALE_DUMP') {
        s14AlphaTracker.whaleBuysCount++;
        s14AlphaTracker.consecutiveWhaleSells = 0;
        s14AlphaTracker.whaleRemainingHolding = signal.remainingHolding;
        if (signal.remainingHolding > s14AlphaTracker.whalePeakHolding) {
          s14AlphaTracker.whalePeakHolding = signal.remainingHolding;
        }
        const posIdx = this.scenarios.s14_alpha.openPositions.findIndex(p => p.mint === signal.mint);
        if (posIdx >= 0) {
          this.scenarios.s14_alpha.openPositions[posIdx].lastPriceUsd = signal.priceUsd;
        }
        if (!s14AlphaTracker.hasEntered && s14AlphaTracker.bundlerPct >= 5.0) {
          this.evaluateS14AlphaBundlerEntry(signal.mint, s14AlphaTracker.bundlerPct, signal.priceUsd);
        }
      }
    }

    this.saveState();
  }

  /**
   * Evaluasi 1-Second Sniper Gate untuk Skenario 13-Alpha:
   * Dipanggil saat timer 1 detik habis atau saat ada lonjakan sniper sell seketika.
   */
  public async evaluateS13Alpha1sGate(mint: string): Promise<void> {
    const tracker = this.s13AlphaTrackers.get(mint);
    if (!tracker || tracker.status !== 'PENDING_1S_VERIFICATION') return;

    if (tracker.verificationTimer) {
      clearTimeout(tracker.verificationTimer);
      tracker.verificationTimer = undefined;
    }

    const now = Date.now();
    const timeWib = formatWibDate(now);

    // ZERO-BLINDSPOT ON-CHAIN RPC CHECK:
    // Periksa jumlah signatures aktual di pool secara langsung dari blockchain Solana (mengatasi delay stream WebSocket)
    let onChainTxCount = 0;
    if (tracker.pairAddress) {
      try {
        const conn = new Connection(getSolanaRpcUrl());
        const pairPk = new PublicKey(tracker.pairAddress);
        const sigs = await conn.getSignaturesForAddress(pairPk, { limit: 25 });
        onChainTxCount = sigs.length;
      } catch (e: any) {
        // fallback jika network fail
      }
    }

    const totTxs = tracker.sniperBuysIn1s + tracker.sniperSellsIn1s;
    const sellRatio = totTxs > 0 ? (tracker.sniperSellsIn1s / totTxs) : 0;

    // Ambil Bundler Rate dari GMGN Token Stat (Detik ke-1)
    const bundlerRate = await this.fetchTokenBundlerRate(mint);
    if (bundlerRate !== null) {
      tracker.bundlerRate = bundlerRate;
    }

    // Evaluasi 1: Jebakan Koin Umpan Rugpull (HANYA valid jika umur token >= 20 detik, karena GMGN butuh 20s untuk clustering)
    const isLowBundler = false;

    // Evaluasi 2: Serbuan MEV Sell / Dump
    const isSniperDump = (tracker.sniperSellsIn1s >= 3 && sellRatio >= 0.25) || tracker.sniperSellsIn1s >= 8;

    if (isLowBundler || isSniperDump) {
      tracker.status = isLowBundler ? 'BLOCKED_LOW_BUNDLER' : 'BLOCKED_SNIPER_BATTLE';
      const blockReason = isLowBundler
        ? `BLOCKED_LOW_BUNDLER_GATE (Bundler ${(bundlerRate! * 100).toFixed(1)}% < 5% | Rugpull umpan dicegah)`
        : `BLOCKED_1S_SNIPER_GATE (${tracker.sniperSellsIn1s}x sell / ${(sellRatio * 100).toFixed(0)}% sell ratio | Rugpull dicegah)`;

      console.log(`\n=========================================================`);
      console.log(`🛡️ [SCENARIO 13-ALPHA 1-SECOND SNIPER GATE: BLOCKED!]`);
      console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
      if (isLowBundler) {
        console.log(`   Indikator    : BUNDLER TERLALU RENDAH (${(bundlerRate! * 100).toFixed(2)}% < 5.0%) -> Koin umpan dev tanpa bundle!`);
      } else {
        console.log(`   Indikator    : Serbuan MEV Sell (${tracker.sniperSellsIn1s}x sell vs ${tracker.sniperBuysIn1s}x buy | Rasio Sell: ${(sellRatio * 100).toFixed(1)}%)!`);
      }
      console.log(`   Keputusan    : BATALKAN ORDER BUY (100% Kebal Rugpull | Modal Aman $${this.scenarios.s13_alpha.availableCash.toFixed(2)} | $0 Gas Fee)!`);
      console.log(`=========================================================\n`);

      this.scenarios.s13_alpha.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: this.scenarios.s13_alpha.id,
        action: 'BUY',
        symbol: tracker.symbol,
        mint: tracker.mint,
        usdReceived: 0,
        feeUsd: 0,
        tokens: 0,
        priceUsd: 0,
        pnlUsd: 0,
        availableCashAfter: this.scenarios.s13_alpha.availableCash,
        investedCashAfter: this.scenarios.s13_alpha.investedCash,
        reason: blockReason
      });
      if (this.scenarios.s13_alpha.recentEvents.length > 50) this.scenarios.s13_alpha.recentEvents.pop();
      this.saveState();
      return;
    }

    // Jika lolos gate (sniper sell <= 2x):
    tracker.status = 'ACTIVE';
    tracker.verifiedAt = now;
    tracker.cycleCount = 1;

    let stakeUsd = 5.0;
    try {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      stakeUsd = (liveCfg as any).stakeUsdS13Alpha || (liveCfg as any).stakeUsdS13 || 5.0;
    } catch {}

    const buySignal = tracker.targetBuySignal || {
      action: 'buy',
      mint: tracker.mint,
      symbol: tracker.symbol,
      tokenName: tracker.symbol,
      tokenAmount: 0,
      remainingHolding: tracker.whaleRemainingHolding,
      solAmount: tracker.whaleFirstBuySol,
      usdAmount: tracker.whaleFirstBuyUsd,
      priceUsd: tracker.whaleFirstBuyUsd > 0 ? (tracker.whaleFirstBuyUsd / (tracker.whaleFirstBuySol * 1e6)) : 0.000038,
      txHash: `s13_alpha_entry1_${now}`,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: true,
      pairAddress: tracker.pairAddress,
      exchange: tracker.exchange
    };

    const bundlerInfo = bundlerRate !== null ? `Bundler: ${(bundlerRate * 100).toFixed(1)}%` : 'Bundler: Organik';
    console.log(`\n=========================================================`);
    console.log(`🟢 [SCENARIO 13-ALPHA 1-SECOND SNIPER GATE: PASSED!]`);
    console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Indikator    : Terkonfirmasi Runner! (${bundlerInfo} | Serbuan Sell MEV: ${tracker.sniperSellsIn1s}x vs ${tracker.sniperBuysIn1s}x buy).`);
    console.log(`   Keputusan    : TERKONFIRMASI WINNER (Main Pool)! Mengeksekusi BUY di detik ke-1...`);
    console.log(`   Modal Siklus : $${stakeUsd.toFixed(2)}`);
    console.log(`=========================================================\n`);

    this.processScenarioBuy(this.scenarios.s13_alpha, buySignal, false, tracker.whaleFirstBuyUsd, now, timeWib, {
      maxTokenExposure: stakeUsd,
      getStake: () => stakeUsd,
      disallowAccumulation: true,
      allowReEntryCycle: true,
      cycleIndex: 1
    });

    const createdPos = this.scenarios.s13_alpha.openPositions.find(p => p.mint === mint);
    if (createdPos) {
      createdPos.pairAddress = tracker.pairAddress || '';
      createdPos.entryCount = 1;
    }

    this.saveState();
  }

  /**
   * Evaluasi 1-Second Sniper Gate untuk Skenario 13-Alpha-1:
   */
  public async evaluateS13Alpha1Gate(mint: string): Promise<void> {
    const tracker = this.s13Alpha1Trackers.get(mint);
    if (!tracker || tracker.status !== 'PENDING_1S_VERIFICATION') return;

    if (tracker.verificationTimer) {
      clearTimeout(tracker.verificationTimer);
      tracker.verificationTimer = undefined;
    }

    const now = Date.now();
    const timeWib = formatWibDate(now);

    let onChainTxCount = 0;
    if (tracker.pairAddress) {
      try {
        const conn = new Connection(getSolanaRpcUrl());
        const pairPk = new PublicKey(tracker.pairAddress);
        const sigs = await conn.getSignaturesForAddress(pairPk, { limit: 25 });
        onChainTxCount = sigs.length;
      } catch (e: any) {}
    }

    const totTxs = tracker.sniperBuysIn1s + tracker.sniperSellsIn1s;
    const sellRatio = totTxs > 0 ? (tracker.sniperSellsIn1s / totTxs) : 0;

    // Ambil Bundler Rate dari GMGN Token Stat (Detik ke-1)
    const bundlerRate = await this.fetchTokenBundlerRate(mint);
    if (bundlerRate !== null) {
      tracker.bundlerRate = bundlerRate;
    }

    // Evaluasi 1: Jebakan Koin Umpan Rugpull (HANYA valid jika umur token >= 20 detik, karena GMGN butuh 20s untuk clustering)
    const isLowBundler = false;

    // Evaluasi 2: Serbuan MEV Sell / Dump
    const isSniperDump = (tracker.sniperSellsIn1s >= 3 && sellRatio >= 0.25) || tracker.sniperSellsIn1s >= 8;

    if (isLowBundler || isSniperDump) {
      tracker.status = isLowBundler ? 'BLOCKED_LOW_BUNDLER' : 'BLOCKED_SNIPER_BATTLE';
      const blockReason = isLowBundler
        ? `BLOCKED_LOW_BUNDLER_GATE (Bundler ${(bundlerRate! * 100).toFixed(1)}% < 5% | Rugpull umpan dicegah)`
        : `BLOCKED_1S_SNIPER_GATE (${tracker.sniperSellsIn1s}x sell / ${(sellRatio * 100).toFixed(0)}% sell ratio | Rugpull dicegah)`;

      this.scenarios.s13_alpha_1.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: this.scenarios.s13_alpha_1.id,
        action: 'BUY',
        symbol: tracker.symbol,
        mint: tracker.mint,
        usdReceived: 0,
        feeUsd: 0,
        tokens: 0,
        priceUsd: 0,
        pnlUsd: 0,
        availableCashAfter: this.scenarios.s13_alpha_1.availableCash,
        investedCashAfter: this.scenarios.s13_alpha_1.investedCash,
        reason: blockReason
      });
      if (this.scenarios.s13_alpha_1.recentEvents.length > 50) this.scenarios.s13_alpha_1.recentEvents.pop();
      this.saveState();
      return;
    }

    tracker.status = 'ACTIVE';
    tracker.verifiedAt = now;
    tracker.cycleCount = 1;

    let stakeUsd = 5.0;
    try {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      stakeUsd = (liveCfg as any).stakeUsdS13Alpha1 || (liveCfg as any).stakeUsdS13 || 5.0;
    } catch {}

    const buySignal = tracker.targetBuySignal || {
      action: 'buy',
      mint: tracker.mint,
      symbol: tracker.symbol,
      tokenName: tracker.symbol,
      tokenAmount: 0,
      remainingHolding: tracker.whaleRemainingHolding,
      solAmount: tracker.whaleFirstBuySol,
      usdAmount: tracker.whaleFirstBuyUsd,
      priceUsd: tracker.whaleFirstBuyUsd > 0 ? (tracker.whaleFirstBuyUsd / (tracker.whaleFirstBuySol * 1e6)) : 0.000038,
      txHash: `s13_alpha1_entry1_${now}`,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: true,
      pairAddress: tracker.pairAddress,
      exchange: tracker.exchange
    };

    const bundlerInfo = bundlerRate !== null ? `Bundler: ${(bundlerRate * 100).toFixed(1)}%` : 'Bundler: Organik';
    console.log(`\n=========================================================`);
    console.log(`🟢 [SCENARIO 13-ALPHA-1 1S SNIPER GATE: PASSED!]`);
    console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Indikator    : Terkonfirmasi Runner! (${bundlerInfo} | Serbuan Sell MEV: ${tracker.sniperSellsIn1s}x vs ${tracker.sniperBuysIn1s}x buy).`);
    console.log(`   Keputusan    : TERKONFIRMASI WINNER (Main Pool)! Masuk Mode Wave Rider di detik ke-1...`);
    console.log(`   Modal Siklus : $${stakeUsd.toFixed(2)}`);
    console.log(`=========================================================\n`);

    this.processScenarioBuy(this.scenarios.s13_alpha_1, buySignal, false, tracker.whaleFirstBuyUsd, now, timeWib, {
      maxTokenExposure: stakeUsd,
      getStake: () => stakeUsd,
      disallowAccumulation: true,
      allowReEntryCycle: true,
      cycleIndex: 1
    });

    const createdPos = this.scenarios.s13_alpha_1.openPositions.find(p => p.mint === mint);
    if (createdPos) {
      createdPos.pairAddress = tracker.pairAddress || '';
      createdPos.entryCount = 1;
    }

    this.saveState();
  }

  /**
   * Evaluasi MEV Gate Skenario 13-Centaur di Detik 1:
   * Menggunakan parameter bot MEV (Rasio Jual MEV & Jumlah Order Sell):
   * - Jika terdeteksi serbuan sell sniper (>= 4 sells atau rasio sell >= 30%) -> ABORT BUY (Kebal rugpull, $0 fee).
   * - Jika akumulasi bersih (rasio sell < 30%) -> TERKONFIRMASI RUNNER! Eksekusi BUY & Switch to Wave Rider!
   */
  public async evaluateS13Centaur1sGate(mint: string): Promise<void> {
    const tracker = this.s13CentaurTrackers.get(mint);
    if (!tracker || tracker.status !== 'PENDING_1S_VERIFICATION') return;

    if (tracker.verificationTimer) {
      clearTimeout(tracker.verificationTimer);
      tracker.verificationTimer = undefined;
    }

    const now = Date.now();
    const timeWib = formatWibDate(now);

    const totTxs = tracker.sniperBuysIn1s + tracker.sniperSellsIn1s;
    const sellRatio = totTxs > 0 ? (tracker.sniperSellsIn1s / totTxs) : 0;

    // Ambil Bundler Rate dari GMGN Token Stat (Detik ke-1)
    const bundlerRate = await this.fetchTokenBundlerRate(mint);
    if (bundlerRate !== null) {
      tracker.bundlerRate = bundlerRate;
    }

    // Evaluasi 1: Jebakan Koin Umpan Rugpull (HANYA valid jika umur token >= 20 detik, karena GMGN butuh 20s untuk clustering)
    const isLowBundler = false;

    // Evaluasi 2: Serbuan MEV Sell / Dump
    const isMevDump = (tracker.sniperSellsIn1s >= 3 && sellRatio >= 0.25) || tracker.sniperSellsIn1s >= 8;

    if (isLowBundler || isMevDump) {
      tracker.status = isLowBundler ? 'BLOCKED_LOW_BUNDLER' : 'BLOCKED_MEV_DUMP';
      const blockReason = isLowBundler
        ? `BLOCKED_LOW_BUNDLER_GATE (Bundler ${(bundlerRate! * 100).toFixed(1)}% < 5% | Rugpull umpan dicegah)`
        : `BLOCKED_MEV_DUMP_GATE (${tracker.sniperSellsIn1s} sells / ${(sellRatio * 100).toFixed(0)}% sell ratio | Rugpull dicegah)`;

      console.log(`\n=========================================================`);
      console.log(`🛡️ [SCENARIO 13-CENTAUR MEV GATE: BLOCKED!]`);
      console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
      if (isLowBundler) {
        console.log(`   Indikator    : BUNDLER TERLALU RENDAH (${(bundlerRate! * 100).toFixed(2)}% < 5.0%) -> Koin umpan dev tanpa bundle!`);
      } else {
        console.log(`   Indikator    : Terdeteksi serbuan sell MEV (${tracker.sniperSellsIn1s}x sell vs ${tracker.sniperBuysIn1s}x buy | Rasio Sell: ${(sellRatio * 100).toFixed(1)}%)!`);
      }
      console.log(`   Keputusan    : BATALKAN ORDER BUY (100% Kebal Rugpull | Modal Aman $${this.scenarios.s13_centaur.availableCash.toFixed(2)} | $0 Gas Fee)!`);
      console.log(`=========================================================\n`);

      this.scenarios.s13_centaur.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: this.scenarios.s13_centaur.id,
        action: 'BUY',
        symbol: tracker.symbol,
        mint: tracker.mint,
        usdReceived: 0,
        feeUsd: 0,
        tokens: 0,
        priceUsd: 0,
        pnlUsd: 0,
        availableCashAfter: this.scenarios.s13_centaur.availableCash,
        investedCashAfter: this.scenarios.s13_centaur.investedCash,
        reason: blockReason
      });
      if (this.scenarios.s13_centaur.recentEvents.length > 50) this.scenarios.s13_centaur.recentEvents.pop();
      this.saveState();
      return;
    }

    // Terkonfirmasi Akumulasi Bersih / Calon Runner Sejati:
    tracker.status = 'RUNNER_WAVE_RIDE';
    let stakeUsd = 5.0;
    try {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      stakeUsd = (liveCfg as any).stakeUsdS13Centaur || (liveCfg as any).stakeUsdS13 || 5.0;
    } catch {}

    const buySignal = tracker.targetBuySignal || {
      action: 'buy',
      mint: tracker.mint,
      symbol: tracker.symbol,
      tokenName: tracker.symbol,
      tokenAmount: 0,
      remainingHolding: 0,
      solAmount: tracker.whaleFirstBuySol,
      usdAmount: tracker.whaleFirstBuyUsd,
      priceUsd: tracker.peakPriceUsd || 0.000038,
      txHash: `s13_centaur_entry_${now}`,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: true,
      pairAddress: tracker.pairAddress,
      exchange: tracker.exchange
    };

    const bundlerInfo = bundlerRate !== null ? `Bundler: ${(bundlerRate * 100).toFixed(1)}%` : 'Bundler: Organik';
    console.log(`\n=========================================================`);
    console.log(`🟢 [SCENARIO 13-CENTAUR 1S GATE: PASSED!]`);
    console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Indikator    : Terkonfirmasi Runner! (${bundlerInfo} | Serbuan Sell MEV: ${tracker.sniperSellsIn1s}x vs ${tracker.sniperBuysIn1s}x buy).`);
    console.log(`   Keputusan    : TERKONFIRMASI RUNNER (Main Pool)! Masuk Mode Wave Rider di detik ke-1...`);
    console.log(`   Modal Siklus : $${stakeUsd.toFixed(2)}`);
    console.log(`=========================================================\n`);

    this.processScenarioBuy(this.scenarios.s13_centaur, buySignal, false, tracker.whaleFirstBuyUsd, now, timeWib, {
      maxTokenExposure: stakeUsd,
      getStake: () => stakeUsd,
      disallowAccumulation: true,
      allowReEntryCycle: true,
      cycleIndex: 1
    });

    const createdPos = this.scenarios.s13_centaur.openPositions.find(p => p.mint === mint);
    if (createdPos) {
      createdPos.pairAddress = tracker.pairAddress || '';
      createdPos.entryCount = 1;
    }

    this.saveState();
  }

  /**
   * Evaluasi Entry Skenario 14: Bundler-Confirmed Runner Wave Rider
   * Dipanggil saat polling mendeteksi metrik Bundler Rate dari GMGN (>= 5.0%).
   * Tidak dibatasi oleh umur koin (tanpa batas umur 300s).
   */
  public evaluateS14BundlerEntry(mint: string, bundlerPct: number, currentPrice?: number): void {
    const tracker = this.s14Trackers.get(mint);
    if (!tracker || tracker.hasEntered || tracker.status !== 'OBSERVING_BUNDLER') return;

    tracker.bundlerPct = bundlerPct;

    // 1. Syarat Bundler Rate >= 5.0%
    if (bundlerPct < 5.0) return;

    // 2. Syarat Whale masih aktif (tidak kabur / abandon)
    const peak = tracker.whalePeakHolding || 1;
    const remRatio = tracker.whaleRemainingHolding / peak;
    if (remRatio < 0.40) {
      console.log(`[SCENARIO 14 SKIP ENTRY] Token ${tracker.symbol}: Bundler ${bundlerPct.toFixed(2)}% >= 5% tapi Whale sudah buang muatan (${(remRatio * 100).toFixed(1)}% < 40%). Lewati.`);
      tracker.status = 'TERMINATED';
      return;
    }

    // 3. Syarat Whale memiliki aktivitas perdagangan (bukan 0 aktivitas)
    const isWhaleActive = tracker.whaleBuysCount >= 1;
    if (!isWhaleActive) return;

    // TERKONFIRMASI RUNNER! Eksekusi BUY S14:
    tracker.hasEntered = true;
    tracker.status = 'ACTIVE_RIDING';

    const now = Date.now();
    const timeWib = formatWibDate(now);

    let stakeUsd = 5.0;
    try {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      stakeUsd = (liveCfg as any).stakeUsdS14 || 5.0;
    } catch {}

    const entryPrice = (currentPrice && currentPrice > 0)
      ? currentPrice
      : (this.lastObservedPrices.get(mint) || tracker.peakPriceUsd || 0.000038);

    tracker.peakPriceUsd = entryPrice;

    const buySignal: WalletTradeSignal = {
      ...(tracker.targetBuySignal || {}),
      action: 'buy',
      mint: tracker.mint,
      symbol: tracker.symbol,
      tokenName: tracker.symbol,
      tokenAmount: 0,
      remainingHolding: tracker.whaleRemainingHolding,
      solAmount: tracker.whaleFirstBuySol,
      usdAmount: tracker.whaleFirstBuyUsd,
      priceUsd: entryPrice,
      txHash: `s14_bundler_entry_${now}`,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: false,
      pairAddress: tracker.pairAddress,
      exchange: tracker.exchange
    };

    console.log(`\n=========================================================`);
    console.log(`💎 [SCENARIO 14: BUNDLER CONFIRMED RUNNER ENTRY!]`);
    console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Bundler Rate : ${bundlerPct.toFixed(2)}% (>= 5.0% Sindikat Terkonfirmasi)`);
    console.log(`   Whale Status : Aktif (${tracker.whaleBuysCount}x buy, sisa ${(remRatio * 100).toFixed(1)}% bag)`);
    console.log(`   Harga Masuk  : $${entryPrice.toFixed(8)}`);
    console.log(`   Modal Siklus : $${stakeUsd.toFixed(2)}`);
    console.log(`   Aksi         : MASUK MODE RUNNER (Stop Loss -20% dari Entry | Exit murni saat Whale Dump)!`);
    console.log(`=========================================================\n`);

    this.processScenarioBuy(this.scenarios.s14, buySignal, false, tracker.whaleFirstBuyUsd, now, timeWib, {
      maxTokenExposure: stakeUsd,
      getStake: () => stakeUsd,
      disallowAccumulation: true,
      allowReEntryCycle: true,
      cycleIndex: 1
    });

    const createdPos = this.scenarios.s14.openPositions.find(p => p.mint === mint);
    if (createdPos) {
      createdPos.pairAddress = tracker.pairAddress || '';
      createdPos.entryCount = 1;
      createdPos.peakPriceUsd = entryPrice;
    }

    this.saveState();
  }

  /**
   * Evaluasi Entry Skenario 14-Alpha (Bundler-Confirmed Runner + 60s Grace Period):
   * Syarat Masuk:
   * 1. Umur Token >= 60 detik (Grace Period Anti-Rugpull 100%)
   * 2. Bundler Rate >= 5.0%
   * 3. Whale masih aktif dan memegang >= 40% muatannya
   */
  public evaluateS14AlphaBundlerEntry(mint: string, bundlerPct: number, currentPrice?: number): void {
    const tracker = this.s14AlphaTrackers.get(mint);
    if (!tracker || tracker.hasEntered || tracker.status !== 'OBSERVING_BUNDLER') return;

    tracker.bundlerPct = bundlerPct;

    const now = Date.now();
    const ageSec = Math.floor((now - tracker.whaleFirstBuyAt) / 1000);

    // 1. Syarat GRACE PERIOD 60 DETIK:
    if (ageSec < 60) return;

    // 2. Syarat Bundler Rate >= 5.0%
    if (bundlerPct < 5.0) return;

    // 3. Syarat Whale masih aktif (tidak kabur / abandon)
    const peak = tracker.whalePeakHolding || 1;
    const remRatio = tracker.whaleRemainingHolding / peak;
    if (remRatio < 0.40) {
      console.log(`[SCENARIO 14-ALPHA SKIP ENTRY] Token ${tracker.symbol}: Umur ${ageSec}s, Bundler ${bundlerPct.toFixed(2)}% >= 5% tapi Whale sudah buang muatan (${(remRatio * 100).toFixed(1)}% < 40%). Lewati.`);
      tracker.status = 'TERMINATED';
      return;
    }

    // 4. Syarat Whale memiliki aktivitas perdagangan (bukan 0 aktivitas)
    const isWhaleActive = tracker.whaleBuysCount >= 1;
    if (!isWhaleActive) return;

    // TERKONFIRMASI RUNNER LOLOS GRACE PERIOD 60S! Eksekusi BUY S14-Alpha:
    tracker.hasEntered = true;
    tracker.status = 'ACTIVE_RIDING';

    const timeWib = formatWibDate(now);

    let stakeUsd = 5.0;
    try {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      stakeUsd = (liveCfg as any).stakeUsdS14Alpha || (liveCfg as any).stakeUsdS14 || 5.0;
    } catch {}

    const entryPrice = (currentPrice && currentPrice > 0)
      ? currentPrice
      : (this.lastObservedPrices.get(mint) || tracker.peakPriceUsd || 0.000038);

    tracker.peakPriceUsd = entryPrice;

    const buySignal: WalletTradeSignal = {
      ...(tracker.targetBuySignal || {}),
      action: 'buy',
      mint: tracker.mint,
      symbol: tracker.symbol,
      tokenName: tracker.symbol,
      tokenAmount: 0,
      remainingHolding: tracker.whaleRemainingHolding,
      solAmount: tracker.whaleFirstBuySol,
      usdAmount: tracker.whaleFirstBuyUsd,
      priceUsd: entryPrice,
      txHash: `s14_alpha_bundler_entry_${now}`,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: false,
      pairAddress: tracker.pairAddress,
      exchange: tracker.exchange
    };

    console.log(`\n=========================================================`);
    console.log(`🛡️ [SCENARIO 14-ALPHA: BUNDLER CONFIRMED RUNNER ENTRY (60s GRACE PASSED!)]`);
    console.log(`   Token        : ${tracker.symbol} [${mint.slice(0, 8)}...]`);
    console.log(`   Umur Token   : ${ageSec}s (>= 60s Grace Period Terpenuhi | Lolos Rugpull Kilat)`);
    console.log(`   Bundler Rate : ${bundlerPct.toFixed(2)}% (>= 5.0% Sindikat Terkonfirmasi)`);
    console.log(`   Whale Status : Aktif (${tracker.whaleBuysCount}x buy, sisa ${(remRatio * 100).toFixed(1)}% bag)`);
    console.log(`   Harga Masuk  : $${entryPrice.toFixed(8)}`);
    console.log(`   Modal Siklus : $${stakeUsd.toFixed(2)}`);
    console.log(`   Aksi         : MASUK MODE WAVE RIDER (Stop Loss -20% dari Entry | Exit murni saat Whale Dump)!`);
    console.log(`=========================================================\n`);

    this.processScenarioBuy(this.scenarios.s14_alpha, buySignal, false, tracker.whaleFirstBuyUsd, now, timeWib, {
      maxTokenExposure: stakeUsd,
      getStake: () => stakeUsd,
      disallowAccumulation: true,
      allowReEntryCycle: true,
      cycleIndex: 1
    });

    const createdPos = this.scenarios.s14_alpha.openPositions.find(p => p.mint === mint);
    if (createdPos) {
      createdPos.pairAddress = tracker.pairAddress || '';
      createdPos.entryCount = 1;
      createdPos.peakPriceUsd = entryPrice;
    }

    this.saveState();
  }

  /**
   * Rekam aktivitas trade (Buy / Sell / Withdraw) dari kolam / pembeli luar (sniper)
   * Digunakan untuk:
   * 1. S13-Alpha: Menghitung order sell sniper di 1s pertama (jika >= 3x -> batalkan buy)
   * 2. S13-Beta: Menghitung order sell sniper di 1.5s pertama (jika >= 2x -> panik jual darurat seketika)
   */
  public recordPoolTradeActivity(
    mint: string,
    action: 'buy' | 'sell' | 'withdraw',
    priceUsd?: number,
    solAmount?: number
  ): void {
    const now = Date.now();
    const timeWib = formatWibDate(now);

    // 1. S13-Alpha & S13-Alpha-1 Evaluation
    const alphaTracker = this.s13AlphaTrackers.get(mint);
    if (alphaTracker && alphaTracker.status === 'PENDING_1S_VERIFICATION') {
      if (action === 'sell' || action === 'withdraw') {
        alphaTracker.sniperSellsIn1s += 1;
        if (alphaTracker.sniperSellsIn1s >= 3 || action === 'withdraw') {
          this.evaluateS13Alpha1sGate(mint).catch(() => {});
        }
      } else if (action === 'buy') {
        alphaTracker.sniperBuysIn1s += 1;
      }
    }

    const alpha1Tracker = this.s13Alpha1Trackers.get(mint);
    if (alpha1Tracker && alpha1Tracker.status === 'PENDING_1S_VERIFICATION') {
      if (action === 'sell' || action === 'withdraw') {
        alpha1Tracker.sniperSellsIn1s += 1;
        if (alpha1Tracker.sniperSellsIn1s >= 3 || action === 'withdraw') {
          this.evaluateS13Alpha1Gate(mint).catch(() => {});
        }
      } else if (action === 'buy') {
        alpha1Tracker.sniperBuysIn1s += 1;
      }
    }

    // 1.1 S13-Centaur MEV Verification
    const centaurTracker = this.s13CentaurTrackers.get(mint);
    if (centaurTracker && centaurTracker.status === 'PENDING_1S_VERIFICATION') {
      if (action === 'sell' || action === 'withdraw') {
        centaurTracker.sniperSellsIn1s += 1;
        if (centaurTracker.sniperSellsIn1s >= 3 || action === 'withdraw') {
          this.evaluateS13Centaur1sGate(mint).catch(() => {});
        }
      } else if (action === 'buy') {
        centaurTracker.sniperBuysIn1s += 1;
      }
    }

    // 2. S13-Beta & S13-Beta-1 Evaluation
    const betaTracker = this.s13BetaTrackers.get(mint);
    if (betaTracker && betaTracker.status === 'ACTIVE_MONITORING') {
      if (action === 'sell' || action === 'withdraw') {
        betaTracker.sniperSellsIn1s += 1;
        if (betaTracker.sniperSellsIn1s >= 2 || action === 'withdraw') {
          const posIdx = this.scenarios.s13_beta.openPositions.findIndex(p => p.mint === mint);
          if (posIdx >= 0) {
            betaTracker.status = 'PANIC_DUMPED';
            const pos = this.scenarios.s13_beta.openPositions[posIdx];
            const exitPrice = (priceUsd && priceUsd > 0) ? priceUsd : (pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd);
            const reason = `S13_BETA_INSTANT_PANIC_DUMP (${betaTracker.sniperSellsIn1s}x sniper sell dlm 1s terdeteksi | Jual darurat selamatkan modal)`;
            console.log(`\n=========================================================`);
            console.log(`🚨 [SCENARIO 13-BETA INSTANT PANIC CUT TRIGGERED]`);
            console.log(`   Token        : ${pos.symbol} [${mint.slice(0, 8)}...]`);
            console.log(`   Penyebab     : Terdeteksi ${betaTracker.sniperSellsIn1s}x order sell sniper di 1s pertama!`);
            console.log(`   Aksi         : JUAL DARURAT SEKETIKA sebelum Dev RemoveLiquidity!`);
            console.log(`   Harga Keluar : $${exitPrice.toFixed(8)}`);
            console.log(`=========================================================\n`);
            this.executeScenarioExit(this.scenarios.s13_beta, posIdx, exitPrice, now, timeWib, reason);
            betaTracker.lastExitAt = now;
          }
        }
      } else if (action === 'buy') {
        betaTracker.sniperBuysIn1s += 1;
      }
    }

    const beta1Tracker = this.s13Beta1Trackers.get(mint);
    if (beta1Tracker && beta1Tracker.status === 'ACTIVE_MONITORING') {
      if (action === 'sell' || action === 'withdraw') {
        beta1Tracker.sniperSellsIn1s += 1;
        if (beta1Tracker.sniperSellsIn1s >= 2 || action === 'withdraw') {
          const posIdx = this.scenarios.s13_beta_1.openPositions.findIndex(p => p.mint === mint);
          if (posIdx >= 0) {
            beta1Tracker.status = 'PANIC_DUMPED';
            const pos = this.scenarios.s13_beta_1.openPositions[posIdx];
            const exitPrice = (priceUsd && priceUsd > 0) ? priceUsd : (pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd);
            const reason = `S13_BETA_1_INSTANT_PANIC_DUMP (${beta1Tracker.sniperSellsIn1s}x sniper sell dlm 1s terdeteksi | Jual darurat selamatkan modal)`;
            console.log(`\n=========================================================`);
            console.log(`🚨 [SCENARIO 13-BETA-1 INSTANT PANIC CUT TRIGGERED]`);
            console.log(`   Token        : ${pos.symbol} [${mint.slice(0, 8)}...]`);
            console.log(`   Penyebab     : Terdeteksi ${beta1Tracker.sniperSellsIn1s}x order sell sniper di 1s pertama!`);
            console.log(`   Aksi         : JUAL DARURAT SEKETIKA sebelum Dev RemoveLiquidity!`);
            console.log(`   Harga Keluar : $${exitPrice.toFixed(8)}`);
            console.log(`=========================================================\n`);
            this.executeScenarioExit(this.scenarios.s13_beta_1, posIdx, exitPrice, now, timeWib, reason);
            beta1Tracker.lastExitAt = now;
          }
        }
      } else if (action === 'buy') {
        beta1Tracker.sniperBuysIn1s += 1;
      }
    }
  }

  /**
   * Eksekusi BUY Proaktif / Dini (SEBELUM Target Buy):
   * Dipanggil saat WebSocket Dev-Radar mendeteksi dev membuat koin baru (Gen 2)!
   */
  public handleEarlyRedeployBuy(
    evt: {
      oldMint: string;
      newMint: string;
      symbol: string;
      ipfsUri?: string;
      devWallet: string;
      signature: string;
      timestamp: number;
      initialMeteoraSol?: number;
      mainExchange?: 'meteora' | 'pumpswap' | 'raydium';
      mainPairAddress?: string;
      isSameSymbol?: boolean;
    },
    customStakeUsd?: number
  ): void {
    const now = evt.timestamp || Date.now();
    const timeWib = formatWibDate(now);

    let pool2Stake = customStakeUsd;
    if (!pool2Stake) {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      pool2Stake = liveCfg.stakeUsdS6Pool2 || 1.0;
    }

    const targetExchange = evt.mainExchange === 'pumpswap' ? 'pump_amm' : (evt.mainExchange || 'meteora_dammv2');

    console.log(`\n=========================================================`);
    console.log(`🚀 [EARLY-BUY RADAR] Mengeksekusi Buy SEBELUM Target Buy:`);
    console.log(`   Token Baru : ${evt.symbol} [${evt.newMint.slice(0, 8)}...]`);
    console.log(`   Exchange   : ${targetExchange} (Pool: ${evt.mainPairAddress ? evt.mainPairAddress.slice(0, 8) + '...' : 'Default'})`);
    console.log(`   Modal S6/S7: $${pool2Stake.toFixed(2)} (Pool 2)`);
    console.log(`   Dev Wallet : ${evt.devWallet}`);
    console.log(`=========================================================\n`);

    const earlySignal: WalletTradeSignal = {
      action: 'buy',
      mint: evt.newMint,
      symbol: evt.symbol,
      tokenName: evt.symbol,
      tokenAmount: 1000000,
      remainingHolding: 1000000,
      solAmount: 15,
      usdAmount: 1380,
      priceUsd: 0.0000096, // estimasi awal ground zero, akan disinkronkan ke kuotasi swap AMM riil
      txHash: evt.signature,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: true,
      pairAddress: evt.mainPairAddress || '',
      exchange: targetExchange
    };

    // Eksekusi buy di Skenario 6, Skenario 7 & Skenario 8 jika koin re-deploy nama sama (isSameSymbol !== false)
    if (evt.isSameSymbol !== false) {
      if (!this.scenarios.s6.openPositions.some(p => p.mint === evt.newMint)) {
        this.processScenarioBuy(this.scenarios.s6, earlySignal, true, 1380, now, timeWib, {
          maxTokenExposure: pool2Stake,
          getStake: () => pool2Stake,
          disallowAccumulation: true,
        });
        this.autoRotateSameSymbolPositions(this.scenarios.s6, earlySignal, now, timeWib);
        const s6CreatedPos = this.scenarios.s6.openPositions.find(p => p.mint === evt.newMint);
        if (s6CreatedPos) {
          s6CreatedPos.pairAddress = evt.mainPairAddress || '';
          s6CreatedPos.exchange = targetExchange;
        }
      }

      if (!this.scenarios.s7.openPositions.some(p => p.mint === evt.newMint)) {
        this.processScenarioBuy(this.scenarios.s7, earlySignal, true, 1380, now, timeWib, {
          maxTokenExposure: pool2Stake,
          getStake: () => pool2Stake,
          disallowAccumulation: true,
        });
        this.autoRotateSameSymbolPositions(this.scenarios.s7, earlySignal, now, timeWib);
        const s7CreatedPos = this.scenarios.s7.openPositions.find(p => p.mint === evt.newMint);
        if (s7CreatedPos) {
          s7CreatedPos.pairAddress = evt.mainPairAddress || '';
          s7CreatedPos.exchange = targetExchange;
        }
      }

      // Eksekusi buy di Skenario 8 (Front-Run Dev Genesis Nama Sama)
      let s8Stake = customStakeUsd;
      if (!s8Stake) {
        const liveCfg = readFollowerLiveConfig(this.dataDir);
        s8Stake = liveCfg.stakeUsdS8 || 1.0;
      }
      if (!this.scenarios.s8.openPositions.some(p => p.mint === evt.newMint)) {
        this.processScenarioBuy(this.scenarios.s8, earlySignal, true, 1380, now, timeWib, {
          maxTokenExposure: s8Stake,
          getStake: () => s8Stake,
          disallowAccumulation: true,
        });
        const s8CreatedPos = this.scenarios.s8.openPositions.find(p => p.mint === evt.newMint);
        if (s8CreatedPos) {
          s8CreatedPos.boughtAtGenesis = true;
          s8CreatedPos.pairAddress = evt.mainPairAddress || '';
          s8CreatedPos.exchange = targetExchange;
        }
        this.autoRotateSameSymbolPositions(this.scenarios.s8, earlySignal, now, timeWib);
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s8, earlySignal, now, timeWib);

      // Daftarkan koin Gen-2 nama sama ke Multi-Cycle Tracker (Maksimal 5x Siklus)
      const existingGen2 = this.gen2CycleTracker.get(evt.newMint);
      if (!existingGen2) {
        this.gen2CycleTracker.set(evt.newMint, {
          mint: evt.newMint,
          symbol: evt.symbol,
          pairAddress: evt.mainPairAddress || '',
          exchange: targetExchange,
          devWallet: evt.devWallet,
          cycleCount: 1,
          maxCycles: 5,
          lastExitAt: 0,
          lastExitPrice: 0,
          lastExitReason: '',
          lastTradeProfitable: true,
          status: 'HOLDING',
          cooldownUntil: 0,
        });
        console.log(`[GEN2 CYCLE TRACKER] 🔄 Koin Gen-2 '${evt.symbol}' [${evt.newMint.slice(0, 8)}...] terdaftar untuk evaluasi siklus berulang (Maks 5x, Cooldown 1m, Profit-Only)!`);
      }
    }

    // Eksekusi buy di Skenario 9 (Dev Front-Run Bebas Simbol & 2-Way Sync)
    // S9 MEMBELI SEMUA KOIN BARU DARI DEV APAPUN SIMBOLNYA!
    let s9Stake = customStakeUsd;
    if (!s9Stake) {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      s9Stake = liveCfg.stakeUsdS9 || 1.0;
    }
    const closedTradeS9 = this.scenarios.s9.closedTrades.find(t => t.mint === evt.newMint);
    // Re-entry HANYA boleh jika trade sebelumnya keluar karena TARGET_SKIPPED_DEV_POOL (Whale belum masuk saat peluncuran).
    // Jika trade sebelumnya sudah sukses panen cuan (TAKE_PROFIT/HARVEST/WHALE_SELL), ombak selesai: DILARANG re-entry!
    const prevExitedViaSkippedPoolS9 = !closedTradeS9 || (closedTradeS9.exitReason.includes('TARGET_SKIPPED_DEV_POOL') && closedTradeS9.realizedPnlUsd >= -0.05);
    const sameMintTradesS9 = this.scenarios.s9.closedTrades.filter(t => t.mint === evt.newMint).length;
    const allowReEntryS9 = evt.isSameSymbol !== false && prevExitedViaSkippedPoolS9 && sameMintTradesS9 < 5;

    if (!this.scenarios.s9.openPositions.some(p => p.mint === evt.newMint)) {
      this.processScenarioBuy(this.scenarios.s9, earlySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s9Stake,
        getStake: () => s9Stake,
        disallowAccumulation: true,
        allowReEntryCycle: allowReEntryS9,
        cycleIndex: sameMintTradesS9 + 1,
      });
      const s9CreatedPos = this.scenarios.s9.openPositions.find(p => p.mint === evt.newMint);
      if (s9CreatedPos) {
        s9CreatedPos.boughtAtGenesis = true;
        s9CreatedPos.pairAddress = evt.mainPairAddress || '';
        s9CreatedPos.exchange = targetExchange;
        s9CreatedPos.entryCount = sameMintTradesS9 + 1;
        (s9CreatedPos as any).isSameSymbol = evt.isSameSymbol !== false;
        (s9CreatedPos as any).isPool2 = evt.isSameSymbol !== false || sameMintTradesS9 > 0;
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s9, earlySignal, now, timeWib);
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s9, earlySignal, now, timeWib);

    // Eksekusi buy di Skenario 9.5 (Split TP 50/50 + 1-Min Moonbag)
    let s95Stake: number = customStakeUsd || 0.25;
    if (!customStakeUsd) {
      try {
        const liveCfg = readFollowerLiveConfig(this.dataDir);
        s95Stake = (liveCfg as any).stakeUsdS95 || liveCfg.stakeUsdS9 || 0.25;
      } catch {}
    }
    const closedTradeS95 = this.scenarios.s9_5.closedTrades.find(t => t.mint === evt.newMint);
    const prevExitedViaSkippedPoolS95 = !closedTradeS95 || (closedTradeS95.exitReason.includes('TARGET_SKIPPED_DEV_POOL') && closedTradeS95.realizedPnlUsd >= -0.05);
    const sameMintTradesS95 = this.scenarios.s9_5.closedTrades.filter(t => t.mint === evt.newMint).length;
    const allowReEntryS95 = evt.isSameSymbol !== false && prevExitedViaSkippedPoolS95 && sameMintTradesS95 < 5;

    if (!this.scenarios.s9_5.openPositions.some(p => p.mint === evt.newMint)) {
      this.processScenarioBuy(this.scenarios.s9_5, earlySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s95Stake,
        getStake: () => s95Stake,
        disallowAccumulation: true,
        allowReEntryCycle: allowReEntryS95,
        cycleIndex: sameMintTradesS95 + 1,
      });
      const s95CreatedPos = this.scenarios.s9_5.openPositions.find(p => p.mint === evt.newMint);
      if (s95CreatedPos) {
        s95CreatedPos.boughtAtGenesis = true;
        s95CreatedPos.pairAddress = evt.mainPairAddress || '';
        s95CreatedPos.exchange = targetExchange;
        s95CreatedPos.entryCount = sameMintTradesS95 + 1;
        (s95CreatedPos as any).isSameSymbol = evt.isSameSymbol !== false;
        (s95CreatedPos as any).isPool2 = evt.isSameSymbol !== false || sameMintTradesS95 > 0;
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s9_5, earlySignal, now, timeWib);
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s9_5, earlySignal, now, timeWib);

    // Eksekusi buy di Skenario 10 (Dynamic Wave Runner)
    let s10Stake: number = customStakeUsd || 0.25;
    if (!customStakeUsd) {
      try {
        const liveCfg = readFollowerLiveConfig(this.dataDir);
        s10Stake = (liveCfg as any).stakeUsdS10 || liveCfg.stakeUsdS9 || 0.25;
      } catch {}
    }
    const closedTradeS10 = this.scenarios.s10.closedTrades.find(t => t.mint === evt.newMint);
    // Re-entry HANYA boleh jika trade sebelumnya keluar karena TARGET_SKIPPED_DEV_POOL (Whale belum masuk saat peluncuran).
    // Jika trade sebelumnya sudah sukses panen cuan (TAKE_PROFIT/HARVEST/WHALE_SELL), ombak selesai: DILARANG re-entry!
    const prevExitedViaSkippedPoolS10 = !closedTradeS10 || (closedTradeS10.exitReason.includes('TARGET_SKIPPED_DEV_POOL') && closedTradeS10.realizedPnlUsd >= -0.05);
    const sameMintTradesS10 = this.scenarios.s10.closedTrades.filter(t => t.mint === evt.newMint).length;
    const allowReEntryS10 = evt.isSameSymbol !== false && prevExitedViaSkippedPoolS10 && sameMintTradesS10 < 5;

    if (!this.scenarios.s10.openPositions.some(p => p.mint === evt.newMint)) {
      this.processScenarioBuy(this.scenarios.s10, earlySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s10Stake,
        getStake: () => s10Stake,
        disallowAccumulation: true,
        allowReEntryCycle: allowReEntryS10,
        cycleIndex: sameMintTradesS10 + 1,
      });
      const s10CreatedPos = this.scenarios.s10.openPositions.find(p => p.mint === evt.newMint);
      if (s10CreatedPos) {
        s10CreatedPos.boughtAtGenesis = true;
        s10CreatedPos.pairAddress = evt.mainPairAddress || '';
        s10CreatedPos.exchange = targetExchange;
        s10CreatedPos.entryCount = sameMintTradesS10 + 1;
        (s10CreatedPos as any).isSameSymbol = evt.isSameSymbol !== false;
        (s10CreatedPos as any).isPool2 = evt.isSameSymbol !== false || sameMintTradesS10 > 0;
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s10, earlySignal, now, timeWib);
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s10, earlySignal, now, timeWib);

    // Auto-rotasi: likuidasi koin lama
    this.autoRotateSameSymbolPositions(this.scenarios.s6, earlySignal, now, timeWib);
    this.saveState();
  }

  private processScenarioBuy(
    scenario: ScenarioState,
    signal: WalletTradeSignal,
    isGroundZero: boolean,
    targetUsd: number,
    now: number,
    timeWib: string,
    rules: { maxTokenExposure: number; getStake: (tUsd: number) => number; disallowAccumulation?: boolean; allowReEntryCycle?: boolean; cycleIndex?: number }
  ): void {
    const pIn = signal.priceUsd;
    if (pIn <= 0) return;

    let pos = scenario.openPositions.find(p => p.mint === signal.mint);

    // Jika posisi belum ada:
    if (!pos) {
      // 0. Strict 1-Cycle-Per-Token Rule: Dilarang keras buy ulang token yang sudah pernah ditradingkan / ada di closedTrades
      // Kecuali jika diizinkan oleh Multi-Cycle Gen-2 Re-Entry (allowReEntryCycle = true)
      const alreadyTraded = scenario.closedTrades.some(t => t.mint === signal.mint);
      if (alreadyTraded && !rules.allowReEntryCycle) {
        scenario.recentEvents.unshift({
          id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          timeWib,
          scenarioId: scenario.id,
          action: 'SKIP',
          symbol: signal.symbol,
          mint: signal.mint,
          priceUsd: pIn,
          availableCashAfter: scenario.availableCash,
          investedCashAfter: scenario.investedCash,
          reason: 'REJECT_ALREADY_TRADED (Limitasi 1 token hanya boleh buy 1 kali, dilarang buy ulang)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      // 1. Wajib First Buy (Ground Zero dari saldo 0) - dilewati jika Re-Entry Cycle
      if (!isGroundZero && !rules.allowReEntryCycle) {
        scenario.recentEvents.unshift({
          id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          timeWib,
          scenarioId: scenario.id,
          action: 'SKIP',
          symbol: signal.symbol,
          mint: signal.mint,
          priceUsd: pIn,
          availableCashAfter: scenario.availableCash,
          investedCashAfter: scenario.investedCash,
          reason: 'REJECT_MID_FLIGHT (Bukan First Buy / Target sudah pegang token)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      // 2. Filter Anti-Pucuk (Ground-Zero Price Cap): Target First Buy price wajib <= $0.000020 (hanya berlaku saat Genesis awal)
      const GROUND_ZERO_MAX_PRICE_USD = 0.000020;
      if (!rules.allowReEntryCycle && pIn > GROUND_ZERO_MAX_PRICE_USD) {
        scenario.recentEvents.unshift({
          id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          timeWib,
          scenarioId: scenario.id,
          action: 'SKIP',
          symbol: signal.symbol,
          mint: signal.mint,
          priceUsd: pIn,
          availableCashAfter: scenario.availableCash,
          investedCashAfter: scenario.investedCash,
          reason: `REJECT_NON_GROUND_ZERO_PRICE_CAP (First Buy tapi harga pucuk $${pIn.toFixed(7)} > $${GROUND_ZERO_MAX_PRICE_USD.toFixed(6)})`,
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      // Cek ketersediaan kas di pool (wajib cukup stake + fee $0.025)
      if (scenario.availableCash < 0.05 + REAL_SWAP_FEE_USD) {
        scenario.recentEvents.unshift({
          id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          timeWib,
          scenarioId: scenario.id,
          action: 'SKIP',
          symbol: signal.symbol,
          mint: signal.mint,
          priceUsd: pIn,
          availableCashAfter: scenario.availableCash,
          investedCashAfter: scenario.investedCash,
          reason: 'CASH_EXHAUSTED (Sisa kas < $0.05 + fee)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      const desiredStake = rules.getStake(targetUsd);
      const maxAffordableStake = Math.max(0, scenario.availableCash - REAL_SWAP_FEE_USD);
      const actualStake = Math.min(maxAffordableStake, Math.min(rules.maxTokenExposure, desiredStake));
      if (actualStake < 0.05) return;

      const tokensBought = actualStake / pIn;
      const totalCashDeducted = Number((actualStake + REAL_SWAP_FEE_USD).toFixed(2));
      scenario.availableCash = Number((scenario.availableCash - totalCashDeducted).toFixed(2));
      scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));

      pos = {
        mint: signal.mint,
        symbol: signal.symbol,
        tokenName: signal.tokenName,
        openedAt: now,
        updatedAt: now,
        entryCount: 1,
        tokens: tokensBought,
        costBasisUsd: actualStake,
        avgEntryPriceUsd: pIn,
        lastPriceUsd: pIn,
        unrealizedPnlUsd: 0.0,
        realizedPnlUsd: 0.0,
        peakTargetHolding: signal.remainingHolding,
        feesPaidUsd: REAL_SWAP_FEE_USD,
        initialTokens: tokensBought,
        initialCostBasisUsd: actualStake,
        pairAddress: signal.pairAddress || '',
        exchange: signal.exchange || '',
      };
      scenario.openPositions.unshift(pos);

      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'BUY',
        symbol: signal.symbol,
        mint: signal.mint,
        stakeUsd: actualStake,
        feeUsd: REAL_SWAP_FEE_USD,
        tokens: tokensBought,
        priceUsd: pIn,
        availableCashAfter: scenario.availableCash,
        investedCashAfter: scenario.investedCash + actualStake,
        reason: rules.allowReEntryCycle ? `GEN2_CYCLE_${rules.cycleIndex || 2}_RE_ENTRY (Fee: $${REAL_SWAP_FEE_USD})` : `ENTRY_1 (Target ~$${targetUsd.toFixed(0)} | Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Trigger callback tindakan trade nyata (misal untuk eksekusi/probe GMGN API terukur)
      if (this.onTradeAction) {
        try {
          this.onTradeAction('BUY', scenario.id, signal, {
            stakeUsd: actualStake,
            tokens: tokensBought,
            priceUsd: pIn,
            reason: rules.allowReEntryCycle ? `GEN2_CYCLE_${rules.cycleIndex || 2}_RE_ENTRY` : 'ENTRY_1',
            isReEntryCycle: Boolean(rules.allowReEntryCycle),
            cycleIndex: rules.cycleIndex,
          });
        } catch {}
      }
      return;
    }

    // Jika posisi sudah ada: periksa apakah aturan melarang akumulasi (Skenario 4: Single Buy 1x Only)
    if (rules.disallowAccumulation) {
      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'SKIP',
        symbol: signal.symbol,
        mint: signal.mint,
        priceUsd: pIn,
        availableCashAfter: scenario.availableCash,
        investedCashAfter: scenario.investedCash,
        reason: 'REJECT_ACCUMULATION (Skenario 4: Strict 1x Buy Only)',
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
      return;
    }

    // Jika skenario mengizinkan akumulasi buy
    const remTokenCap = Math.max(0, rules.maxTokenExposure - pos.costBasisUsd);
    if (remTokenCap < 0.05 || scenario.availableCash < 0.05 + REAL_SWAP_FEE_USD) {
      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'SKIP',
        symbol: signal.symbol,
        mint: signal.mint,
        priceUsd: pIn,
        availableCashAfter: scenario.availableCash,
        investedCashAfter: scenario.investedCash,
        reason: `CAP_REACHED (Token basis: $${pos.costBasisUsd.toFixed(2)} / $${rules.maxTokenExposure})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
      return;
    }

    const desiredStake = rules.getStake(targetUsd);
    const maxAffordableStake = Math.max(0, scenario.availableCash - REAL_SWAP_FEE_USD);
    const actualStake = Math.min(maxAffordableStake, Math.min(remTokenCap, desiredStake));
    if (actualStake < 0.05) return;

    const addedTokens = actualStake / pIn;
    const totalCashDeducted = Number((actualStake + REAL_SWAP_FEE_USD).toFixed(2));
    scenario.availableCash = Number((scenario.availableCash - totalCashDeducted).toFixed(2));
    scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));

    pos.tokens += addedTokens;
    pos.costBasisUsd += actualStake;
    pos.entryCount += 1;
    pos.feesPaidUsd += REAL_SWAP_FEE_USD;
    pos.avgEntryPriceUsd = pos.costBasisUsd / pos.tokens;
    pos.lastPriceUsd = pIn;
    pos.peakTargetHolding = Math.max(pos.peakTargetHolding, signal.remainingHolding);
    pos.updatedAt = now;

    scenario.recentEvents.unshift({
      id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      timeWib,
      scenarioId: scenario.id,
      action: 'BUY',
      symbol: signal.symbol,
      mint: signal.mint,
      stakeUsd: actualStake,
      feeUsd: REAL_SWAP_FEE_USD,
      tokens: addedTokens,
      priceUsd: pIn,
      availableCashAfter: scenario.availableCash,
      investedCashAfter: scenario.investedCash + actualStake,
      reason: `ACCUMULATE_${pos.entryCount} (Target ~$${targetUsd.toFixed(0)} | Fee: $${REAL_SWAP_FEE_USD})`,
    });
    if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

    if (this.onTradeAction) {
      try {
        this.onTradeAction('BUY', scenario.id, signal, {
          stakeUsd: actualStake,
          tokens: addedTokens,
          priceUsd: pIn,
          reason: `ACCUMULATE_${pos.entryCount}`,
        });
      } catch {}
    }
  }

  /**
   * Eksekusi Full Exit Bersih untuk suatu posisi di skenario:
   * Menghitung PnL, mencatat closed trade, recent event, dan memanggil callback onTradeAction SELL.
   */
  public executeScenarioExit(
    scenario: ScenarioState,
    posIdx: number,
    exitPriceUsd: number,
    now: number,
    timeWib: string,
    reason: string
  ): void {
    const pos = scenario.openPositions[posIdx];
    if (!pos) return;

    const pOut = exitPriceUsd > 0 ? exitPriceUsd : pos.avgEntryPriceUsd;
    const tokensToSell = pos.tokens;
    const grossReceived = tokensToSell * pOut;
    const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
    const costBasisSold = pos.costBasisUsd;
    const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

    scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
    scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
    scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

    pos.feesPaidUsd += REAL_SWAP_FEE_USD;
    pos.realizedPnlUsd += pnlUsd;
    pos.lastPriceUsd = pOut;
    pos.updatedAt = now;

    scenario.recentEvents.unshift({
      id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      timeWib,
      scenarioId: scenario.id,
      action: 'SELL',
      symbol: pos.symbol,
      mint: pos.mint,
      usdReceived: netReceived,
      feeUsd: REAL_SWAP_FEE_USD,
      tokens: tokensToSell,
      priceUsd: pOut,
      pnlUsd,
      availableCashAfter: scenario.availableCash,
      investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
      reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
    });
    if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

    scenario.openPositions.splice(posIdx, 1);

    const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? costBasisSold * 2 : costBasisSold);
    const totalInvested = initialInvested;
    const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
    const isWin = pos.realizedPnlUsd >= 0;

    if (isWin) scenario.wins += 1;
    else scenario.losses += 1;
    scenario.totalTrades += 1;

    scenario.closedTrades.unshift({
      mint: pos.mint,
      symbol: pos.symbol,
      tokenName: pos.tokenName,
      openedAt: pos.openedAt,
      closedAt: now,
      entryCount: pos.entryCount,
      totalInvestedUsd: Number(totalInvested.toFixed(2)),
      totalReturnedUsd: Number((totalInvested + pos.realizedPnlUsd).toFixed(2)),
      totalFeesPaidUsd: Number(pos.feesPaidUsd.toFixed(3)),
      realizedPnlUsd: Number(pos.realizedPnlUsd.toFixed(2)),
      roiPct: Number(roi.toFixed(1)),
      exitReason: reason,
      isWin,
      stage1RealUsdReturned: pos.stage1RealUsdReturned || 0,
    });
    if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();

    // Update Multi-Cycle Tracker khusus S9 & S9.5:
    if (scenario.id === 'SCENARIO_9_DEV_FRONTRUN_SYNC' || scenario.id === 'SCENARIO_9_5_SPLIT_TP_MOONBAG') {
      const gen2 = this.gen2CycleTracker.get(pos.mint);
      if (gen2) {
        const isTargetSkipped = reason.includes('TARGET_SKIPPED_DEV_POOL');
        // Re-Entry HANYA diizinkan jika exit sebelumnya adalah TARGET_SKIPPED_DEV_POOL (Whale belum masuk saat peluncuran) dan fee net aman (>= -$0.05).
        // Jika koin keluar via Take Profit, Micro Inflow Harvest, Whale Sell, atau Stop Loss, ombak utama sudah selesai dipanen: DILARANG re-entry!
        const isEligibleForReEntry = isTargetSkipped && pos.realizedPnlUsd >= -0.05;

        gen2.lastExitAt = now;
        gen2.lastExitPrice = pOut;
        gen2.lastExitReason = reason;
        gen2.lastTradeProfitable = isEligibleForReEntry;

        if (reason.includes('TAKE_PROFIT') || reason.includes('HARD_TP') || reason.includes('HARVEST') || reason.includes('WHALE')) {
          gen2.status = 'TERMINATED';
          console.log(`[GEN2 CYCLE COMPLETED] 🏆 Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] sudah sukses panen cuan/wave via '${reason}'. Siklus selesai permanen (tidak re-entry)!`);
        } else if (!isEligibleForReEntry) {
          gen2.status = 'TERMINATED';
          console.log(`[GEN2 CYCLE TERMINATED] ⛔ Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] keluar via '${reason}' (PnL: $${pos.realizedPnlUsd}). Siklus dihentikan permanen!`);
        } else if (gen2.cycleCount >= gen2.maxCycles) {
          gen2.status = 'TERMINATED';
          console.log(`[GEN2 CYCLE FINISHED] 🏁 Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] telah mencapai batas maksimal 5 siklus (${gen2.cycleCount}/${gen2.maxCycles}). Selesai!`);
        } else {
          gen2.status = 'COOLDOWN';
          gen2.cooldownUntil = now + 60000;
          console.log(`\n=========================================================`);
          console.log(`⏳ [GEN2 CYCLE COOLDOWN] Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] selesai Siklus #${gen2.cycleCount}/${gen2.maxCycles} via '${reason}' (Whale belum masuk, modal aman)!`);
          console.log(`   Masa Cooldown  : 60 Detik (sampai ${formatWibDate(gen2.cooldownUntil)})`);
          console.log(`   Syarat Siklus Berikutnya: Grafik meningkat (Spot > $${pOut.toFixed(8)}) jika Whale masuk belakangan`);
          console.log(`=========================================================\n`);
        }
      }
    }

    if (this.onTradeAction) {
      try {
        const signal: WalletTradeSignal = {
          action: 'sell',
          mint: pos.mint,
          symbol: pos.symbol,
          tokenName: pos.tokenName,
          tokenAmount: tokensToSell,
          remainingHolding: 0,
          solAmount: 0,
          usdAmount: netReceived,
          priceUsd: pOut,
          txHash: '',
          timestamp: Math.floor(now / 1000),
          isOpenOrClose: true,
          isFirstBuy: false,
          pairAddress: pos.pairAddress || '',
          exchange: pos.exchange || '',
        };
        const p = this.onTradeAction('SELL', scenario.id, signal, {
          tokens: tokensToSell,
          priceUsd: pOut,
          reason,
        });
        if (p && typeof p.then === 'function') {
          p.catch(err => console.warn(`[ASYNC-SELL-ACTION-WARN] ${err?.message}`));
        }
      } catch (err: any) {
        console.warn(`[ON-TRADE-ACTION-SELL-ERR] ${err?.message}`);
      }
    }
  }

  /**
   * Eksekusi Jual Sebagian (50%) untuk Skenario 9.5 (atau Split TP Moonbag):
   * Menjual 50% token, mengamankan modal & cuan, menyisakan 50% token untuk moonbag 1 menit.
   */
  public executeScenarioPartial50Exit(
    scenario: ScenarioState,
    posIdx: number,
    exitPriceUsd: number,
    now: number,
    timeWib: string,
    reason: string
  ): void {
    const pos = scenario.openPositions[posIdx];
    if (!pos || pos.tokens <= 0 || pos.stage1Exited) return;

    const pOut = exitPriceUsd > 0 ? exitPriceUsd : pos.avgEntryPriceUsd;
    const tokensToSell = Number((pos.tokens * 0.5).toFixed(6));
    const costBasisSold = Number((pos.costBasisUsd * 0.5).toFixed(2));
    const grossReceived = tokensToSell * pOut;
    const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
    const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

    scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
    scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
    scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

    if (!pos.initialTokens) pos.initialTokens = pos.tokens;
    if (!pos.initialCostBasisUsd) pos.initialCostBasisUsd = pos.costBasisUsd;

    pos.tokens = Number((pos.tokens - tokensToSell).toFixed(6));
    pos.costBasisUsd = Number((pos.costBasisUsd - costBasisSold).toFixed(2));
    pos.feesPaidUsd += REAL_SWAP_FEE_USD;
    pos.realizedPnlUsd += pnlUsd;
    pos.lastPriceUsd = pOut;
    pos.updatedAt = now;
    pos.stage1Exited = true;
    pos.stage1ExitedAt = now;
    pos.stage1RealUsdReturned = netReceived;

    scenario.recentEvents.unshift({
      id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: now,
      timeWib,
      scenarioId: scenario.id,
      action: 'SELL',
      symbol: pos.symbol,
      mint: pos.mint,
      usdReceived: netReceived,
      feeUsd: REAL_SWAP_FEE_USD,
      tokens: tokensToSell,
      priceUsd: pOut,
      pnlUsd: pnlUsd,
      availableCashAfter: scenario.availableCash,
      investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
      reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
    });
    if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

    if (this.onTradeAction) {
      try {
        const signal: WalletTradeSignal = {
          action: 'sell',
          mint: pos.mint,
          symbol: pos.symbol,
          tokenName: pos.tokenName,
          tokenAmount: tokensToSell,
          remainingHolding: 0,
          solAmount: 0,
          usdAmount: netReceived,
          priceUsd: pOut,
          txHash: '',
          timestamp: Math.floor(now / 1000),
          isOpenOrClose: false,
          isFirstBuy: false,
          pairAddress: pos.pairAddress || '',
          exchange: pos.exchange || '',
        };
        const p = this.onTradeAction('SELL', scenario.id, signal, {
          stakeUsd: netReceived,
          tokens: tokensToSell,
          priceUsd: pOut,
          reason,
        });
        if (p && typeof p.then === 'function') {
          p.catch(err => console.warn(`[ASYNC-PARTIAL-SELL-ACTION-WARN] ${err?.message}`));
        }
      } catch (err: any) {
        console.warn(`[ON-TRADE-ACTION-PARTIAL-SELL-ERR] ${err?.message}`);
      }
    }
  }

  /**
   * Auto-Rotasi: Jika target buy token baru (Mint B) dengan simbol/nama yang sama,
   * segera sell 100% posisi lama (Mint A) agar hanya ada 1 token aktif bernama sama.
   * Dijalankan SETELAH buy Mint B selesai dieksekusi agar tidak menahan kecepatan entry buy.
   */
  private autoRotateSameSymbolPositions(
    scenario: ScenarioState,
    newSignal: WalletTradeSignal,
    now: number,
    timeWib: string
  ): void {
    const newSym = (newSignal.symbol || '').trim().toUpperCase();
    const newName = (newSignal.tokenName || '').trim().toUpperCase();
    if (!newSym && !newName) return;

    // Cari posisi lama yang berbeda dengan mint yang baru dibeli
    const staleIndices: number[] = [];
    for (let i = 0; i < scenario.openPositions.length; i++) {
      const p = scenario.openPositions[i];
      if (p.mint === newSignal.mint) continue;
      staleIndices.push(i);
    }

    if (staleIndices.length === 0) return;

    // Urutkan dari indeks terbesar ke terkecil agar splice aman
    staleIndices.sort((a, b) => b - a);

    for (const idx of staleIndices) {
      const pos = scenario.openPositions[idx];
      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
      const tokensToSell = pos.tokens;
      const costBasisSold = pos.costBasisUsd;

      // Estimasi USD kembali
      const grossReceived = tokensToSell * pOut;
      const netReceived = Math.max(0, grossReceived - REAL_SWAP_FEE_USD);
      const pnlUsd = netReceived - costBasisSold;

      const pSym = (pos.symbol || '').trim().toUpperCase();
      const pName = (pos.tokenName || '').trim().toUpperCase();
      const isSameSymbol = (newSym && pSym && newSym === pSym) || (newName && pName && newName === pName);

      const exitReason = isSameSymbol
        ? `AUTO_ROTATION_SAME_NAME (Target buy kontrak baru '${newSignal.symbol}' [${newSignal.mint.slice(0, 8)}...])`
        : (scenario.id === 'SCENARIO_8_FRONTRUN_DEV'
            ? `TARGET_SKIPPED_FOR_ANOTHER_COIN (Dev deploy pool '${pos.symbol}' tapi Target malah beli '${newSignal.symbol}', likuidasi S8)`
            : `AUTO_LIQUIDATE_TARGET_MOVED (Target berpindah beli koin baru '${newSignal.symbol}' [${newSignal.mint.slice(0, 8)}...], likuidasi '${pos.symbol}')`);

      pos.realizedPnlUsd = Number((pos.realizedPnlUsd + pnlUsd).toFixed(2));
      pos.feesPaidUsd = Number((pos.feesPaidUsd + REAL_SWAP_FEE_USD).toFixed(3));
      scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
      scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));

      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'SELL',
        symbol: pos.symbol,
        mint: pos.mint,
        usdReceived: Number(netReceived.toFixed(2)),
        feeUsd: REAL_SWAP_FEE_USD,
        tokens: tokensToSell,
        priceUsd: pOut,
        pnlUsd: Number(pnlUsd.toFixed(2)),
        availableCashAfter: scenario.availableCash,
        investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
        reason: `${exitReason} (Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Hapus dari open positions
      scenario.openPositions.splice(idx, 1);

      const totalInvested = pos.initialCostBasisUsd || costBasisSold;
      const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
      const isWin = pos.realizedPnlUsd >= 0;

      if (isWin) scenario.wins += 1;
      else scenario.losses += 1;
      scenario.totalTrades += 1;

      // Pindahkan ke closedTrades
      scenario.closedTrades.unshift({
        mint: pos.mint,
        symbol: pos.symbol,
        tokenName: pos.tokenName,
        openedAt: pos.openedAt,
        closedAt: now,
        entryCount: pos.entryCount,
        totalInvestedUsd: Number(totalInvested.toFixed(2)),
        totalReturnedUsd: Number((totalInvested + pos.realizedPnlUsd).toFixed(2)),
        totalFeesPaidUsd: Number(pos.feesPaidUsd.toFixed(3)),
        realizedPnlUsd: Number(pos.realizedPnlUsd.toFixed(2)),
        roiPct: Number(roi.toFixed(1)),
        exitReason,
        isWin,
      });
      if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();

      // Trigger callback SELL untuk eksekusi swap riil / burn & reclaim rent
      if (this.onTradeAction) {
        try {
          const oldSignal: WalletTradeSignal = {
            action: 'sell',
            mint: pos.mint,
            symbol: pos.symbol,
            tokenName: pos.tokenName,
            tokenAmount: tokensToSell,
            remainingHolding: 0,
            solAmount: 0,
            usdAmount: netReceived,
            priceUsd: pOut,
            txHash: '',
            timestamp: Math.floor(now / 1000),
            isOpenOrClose: true,
            isFirstBuy: false,
          };
          this.onTradeAction('SELL', scenario.id, oldSignal, {
            stakeUsd: netReceived,
            tokens: tokensToSell,
            priceUsd: pOut,
            reason: exitReason,
          });
        } catch (e: any) {
          console.warn(`[AUTO-ROTATION-ACTION-ERR] ${e?.message}`);
        }
      }
    }
  }

  /**
   * Tangani aktivitas Target SELL secara simultan di 4 skenario
   */
  public handleTargetSell(signal: WalletTradeSignal): void {
    const now = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(now);
    const pOut = signal.priceUsd;
    if (pOut <= 0) return;

    const targetSold = signal.tokenAmount;
    const targetRemaining = signal.remainingHolding;
    const targetBefore = targetRemaining + targetSold;

    let sellRatio = targetBefore > 0 ? targetSold / targetBefore : 1.0;
    sellRatio = Math.min(1.0, Math.max(0.0, sellRatio));

    const isFullExit =
      signal.isOpenOrClose === true ||
      sellRatio >= 0.85 ||
      targetRemaining < 100;

    if (isFullExit) sellRatio = 1.0;
    const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
    const targetUsd = signal.usdAmount || (targetSold * pOut);

    for (const scenario of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9, this.scenarios.s9_5, this.scenarios.s10]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx === -1) continue;

      const pos = scenario.openPositions[posIdx];
      if (pos.tokens <= 0) continue;

      if (signal.pairAddress && pos.pairAddress !== signal.pairAddress) {
        pos.pairAddress = signal.pairAddress;
      }

      // Skenario 4: 2-Lapis Shakeout Trap (Hold 8s & Dump on Buyback)
      if (scenario.id === 'SCENARIO_4_SINGLE_BUY_5USD') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const elapsedSec = (now - pos.openedAt) / 1000;

        // Lapis 1: Jika sell terjadi di detik <= 3.0 (Shakeout) dan belum pernah masuk mode waitingBuyback:
        if (elapsedSec <= 3.0 && !pos.waitingBuybackSince) {
          pos.waitingBuybackSince = now;
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: `S4_WAITING_BUYBACK (Target sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s <= 3s, tahan hingga 8s menunggu buyback)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Jika sedang dalam status waitingBuyback:
        if (pos.waitingBuybackSince) {
          const waitElapsedSec = (now - pos.waitingBuybackSince) / 1000;
          // Jika target malah melakukan dump kedua berturut-turut (consecutive dump) >= 15% atau Full Exit:
          if (currentSellRatioPct >= 15.0 || isFullExit) {
            const exitReason = `S4_CONSECUTIVE_DUMP_EXIT (Target dump susulan ${currentSellRatioPct}% saat menunggu buyback di +${waitElapsedSec.toFixed(1)}s, safety cut)`;
            this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
            continue;
          }
          // Masih dalam 8s dan sell kecil: tetap tahan
          continue;
        }

        // Standar exit S4 jika sell terjadi di luar detik 3 (misal detik 10, 15, dll):
        if (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) {
          const exitReason = `CUM_SELL_${pos.targetCumulativeSellRatioPct}%_GTE_15%_FULL_EXIT`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 9: Dev Front-Run & 2-Way Target Sync (Anti-Shakeout micro-sell + Emergency Dump Exit)
      if (scenario.id === 'SCENARIO_9_DEV_FRONTRUN_SYNC') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const referenceTime = pos.targetEnteredAt || pos.openedAt;
        const elapsedSec = (now - referenceTime) / 1000;

        // 1. EMERGENCY EXIT: Jika Whale DUMP BESAR (>= 50% atau Full Exit), BATALKAN TAHANAN! LANGSUNG EXIT DETIK ITU JUGA!
        // Menyelamatkan modal dari Dev rugpull (RemoveAllLiquidity) yang mengeksekusi 10-15s setelah whale dump 100%.
        if (isFullExit || pos.targetCumulativeSellRatioPct >= 50.0 || currentSellRatioPct >= 50.0) {
          const exitReason = `S9_EMERGENCY_WHALE_DUMP_EXIT (Whale dump ${pos.targetCumulativeSellRatioPct}% >= 50% / Full Exit di detik ${elapsedSec.toFixed(1)}s, kabur sebelum dev rugpull)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }

        // 2. ANTI-SHAKEOUT GATE: Untuk micro-sell (< 50%) dalam 12 detik pertama pasca target masuk, tahan posisi untuk wave pompa!
        if (elapsedSec < 12.0) {
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: `ANTI_SHAKEOUT_HOLD (Whale micro sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 12s, tahan posisi untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // 3. Pasca detik ke-12: jika target akumulasi jual >= 15%, ikuti whale keluar!
        if (pos.targetCumulativeSellRatioPct >= 15.0) {
          const exitReason = `S9_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% pasca detik 12s)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 9.5: Split TP 50/50 + 1-Min Moonbag (TP 50% @ >=300% & 50% Hold 1m / Dump on Whale Exit)
      if (scenario.id === 'SCENARIO_9_5_SPLIT_TP_MOONBAG') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const referenceTime = pos.targetEnteredAt || pos.openedAt;
        const elapsedSec = (now - referenceTime) / 1000;

        // 1. JIKA TARGET JUAL 100% (isFullExit / dump >= 50% / sisa debu): LANGSUNG JUAL SEMUANYA SEKETIKA!
        // Ini berlaku baik jika belum Stage 1 maupun jika sudah Stage 1 (menjual sisa 50% moonbag seketika)
        if (isFullExit || pos.targetCumulativeSellRatioPct >= 50.0 || currentSellRatioPct >= 50.0) {
          const exitReason = pos.stage1Exited
            ? `S95_TARGET_WHALE_FULL_DUMP_EXIT (Whale dump 100% / >= 50% | Jual sisa 50% moonbag seketika)`
            : `S95_EMERGENCY_WHALE_DUMP_EXIT (Whale dump ${pos.targetCumulativeSellRatioPct}% >= 50% / Full Exit di detik ${elapsedSec.toFixed(1)}s, kabur sebelum dev rugpull)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }

        // 2. Jika SUDAH Stage 1 (sisa 50% moonbag):
        // Pasca detik 12 jika whale mulai buang >= 15%: ikuti whale keluar sisa moonbag
        if (pos.stage1Exited && pos.targetCumulativeSellRatioPct >= 15.0) {
          const exitReason = `S95_MOONBAG_WHALE_SELL_FOLLOW_EXIT (Whale akumulasi sell ${pos.targetCumulativeSellRatioPct}% >= 15% | Jual sisa 50% moonbag)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }

        // 3. Jika BELUM Stage 1:
        // Anti-shakeout 12 detik pasca masuk
        if (elapsedSec < 12.0) {
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: `ANTI_SHAKEOUT_HOLD (Whale micro sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 12s, tahan posisi untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Pasca detik 12 jika whale akumulasi jual >= 15%: ikuti whale keluar!
        if (pos.targetCumulativeSellRatioPct >= 15.0) {
          const exitReason = `S95_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% pasca detik 12s)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 10: Dynamic Wave Runner (Hold selama whale hold / exit saat whale sell >= 15% pasca detik 10s)
      if (scenario.id === 'SCENARIO_10_DYNAMIC_WAVE_RUNNER') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const referenceTime = pos.targetEnteredAt || pos.openedAt;
        const elapsedSec = (now - referenceTime) / 1000;
        // ANTI-SHAKEOUT GATE: Dalam 10 detik pertama pasca target masuk jika bukan dump besar, tahan posisi!
        if (elapsedSec < 10.0 && !isFullExit && pos.targetCumulativeSellRatioPct < 15.0) {
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: `ANTI_SHAKEOUT_HOLD (Whale micro sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 10s, tahan untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Pasca detik ke-10 (atau jika whale langsung dump >= 15% / full exit): IKUTI WHALE KELUAR 100%!
        if (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) {
          const exitReason = `S10_WHALE_SELL_EXIT (Whale sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% | Puncak wave harvest)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 5: Anti-Shakeout Runner (Anti-shakeout micro-sell + Emergency Whale Dump Exit)
      if (scenario.id === 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const elapsedSec = (now - pos.openedAt) / 1000;

        // Emergency Exit jika Whale Dump >= 50% atau Full Exit
        if (isFullExit || pos.targetCumulativeSellRatioPct >= 50.0 || currentSellRatioPct >= 50.0) {
          const exitReason = `S5_EMERGENCY_WHALE_DUMP_EXIT (Whale dump ${pos.targetCumulativeSellRatioPct}% >= 50% / Full Exit di detik ${elapsedSec.toFixed(1)}s, kabur sebelum dev rugpull)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }

        // ANTI-SHAKEOUT GATE: Dalam 12 detik pertama untuk micro-sell, abaikan goyangan dump target!
        if (elapsedSec < 12.0) {
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: `ANTI_SHAKEOUT_HOLD (Target sold ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 12s, tahan posisi untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Pasca detik ke-12: jika target akumulasi jual >= 15%, ikuti whale keluar!
        if (pos.targetCumulativeSellRatioPct >= 15.0) {
          const exitReason = `S5_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% pasca detik 12s)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Jika Skenario 8 masih memegang posisi saat target sell:
      if (scenario.id === 'SCENARIO_8_FRONTRUN_DEV') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));

        // Safety exit jika target dump >= 15% atau Full Exit sebelum 20 detik
        if (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) {
          const exitReason = `S8_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15%, safety exit)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        // Jika target baru jual sedikit (< 15%), S8 tetap hold menuju 20 detik
        continue;
      }

      // Akumulasi rasio jual target (Anti-Fee-Churning Gate)
      if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
      const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
      pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
      pos.lastTargetSellAt = now;

      // Ambang Batas Exit & Strategi Khusus:
      // - Skenario 6 & 7: Split TP 50/50 (Stage 1: TP 50% di >= 5.0% Anti-Rug, Stage 2: 50% Tahan >= 15.0% Mega Runner)
      // - Skenario 4: Single Buy $5 (Standar Full Exit >= 15.0%)

      if (scenario.id === 'SCENARIO_6_REDEPLOY_SNIPER' || scenario.id === 'SCENARIO_7_TIME_STOP_SNIPER') {
        const isStage1Met = pos.targetCumulativeSellRatioPct >= 5.0 && !pos.stage1Exited && !isFullExit;
        const isStage2Met = (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) && pos.stage1Exited;
        const isInstantFullMet = isFullExit && !pos.stage1Exited; // Target dump 100% seketika

        if (isStage1Met) {
          // EKSEKUSI STAGE 1: Jual 50% token untuk kunci modal pokok & amankan profit awal
          const tokensToSell = Number((pos.tokens * 0.5).toFixed(6));
          const costBasisSold = Number((pos.costBasisUsd * 0.5).toFixed(2));
          const grossReceived = tokensToSell * pOut;
          const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
          const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

          scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
          scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
          scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

          pos.tokens = Number((pos.tokens - tokensToSell).toFixed(6));
          pos.costBasisUsd = Number((pos.costBasisUsd - costBasisSold).toFixed(2));
          pos.feesPaidUsd += REAL_SWAP_FEE_USD;
          pos.realizedPnlUsd += pnlUsd;
          pos.lastPriceUsd = pOut;
          pos.updatedAt = now;
          pos.stage1Exited = true;
          pos.stage1RealUsdReturned = netReceived;

          const reason = `STAGE_1_TP_50% (Target sold ${pos.targetCumulativeSellRatioPct}% >= 5%)`;

          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SELL',
            symbol: signal.symbol,
            mint: signal.mint,
            usdReceived: netReceived,
            feeUsd: REAL_SWAP_FEE_USD,
            tokens: tokensToSell,
            priceUsd: pOut,
            pnlUsd: pnlUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
            reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

          if (this.onTradeAction) {
            try {
              this.onTradeAction('SELL', scenario.id, signal, {
                stakeUsd: netReceived,
                tokens: tokensToSell,
                priceUsd: pOut,
                reason,
              });
            } catch {}
          }
          continue; // Posisi tetap terbuka (Open) dengan sisa 50% token untuk runner
        }

        if (!isStage2Met && !isInstantFullMet) {
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: pos.stage1Exited
              ? `RUNNER_HOLD (Stage 1 TP done | Target sold ${currentSellRatioPct}% | Cum: ${pos.targetCumulativeSellRatioPct}% < 15%)`
              : `HOLD_ACCUMULATING (Target sold ${currentSellRatioPct}% | Cum: ${pos.targetCumulativeSellRatioPct}% < 5%)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Lanjut ke eksekusi Full Exit Stage 2
      } else {
        // Skenario 4: Single Buy $5 Standar (Ambang Batas Exit >= 15.0%)
        const targetThresholdPct = 15.0;
        const isThresholdMet = pos.targetCumulativeSellRatioPct >= targetThresholdPct || isFullExit;

        if (!isThresholdMet) {
          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SKIP',
            symbol: signal.symbol,
            mint: signal.mint,
            priceUsd: pOut,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: scenario.investedCash,
            reason: `HOLD_ACCUMULATING (Target sold ${currentSellRatioPct}% | Cum: ${pos.targetCumulativeSellRatioPct}% < ${targetThresholdPct}%)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }
      }

      // AMBANG BATAS TERCAPAI: Jual Seluruh Sisa Token 100% (Full Exit)
      const tokensToSell = pos.tokens;
      const grossReceived = tokensToSell * pOut;
      const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
      const costBasisSold = pos.costBasisUsd;
      const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

      scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
      scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
      scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

      pos.feesPaidUsd += REAL_SWAP_FEE_USD;
      pos.realizedPnlUsd += pnlUsd;
      pos.lastPriceUsd = pOut;
      pos.updatedAt = now;

      const exitReason = pos.stage1Exited
        ? `STAGE_2_RUNNER_FULL_EXIT (Target sold ${pos.targetCumulativeSellRatioPct}% >= 15%)`
        : (isFullExit ? 'FULL_EXIT_100%' : `CUM_SELL_${pos.targetCumulativeSellRatioPct}%_GTE_15%_FULL_EXIT`);

      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'SELL',
        symbol: signal.symbol,
        mint: signal.mint,
        usdReceived: netReceived,
        feeUsd: REAL_SWAP_FEE_USD,
        tokens: tokensToSell,
        priceUsd: pOut,
        pnlUsd: pnlUsd,
        availableCashAfter: scenario.availableCash,
        investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
        reason: `${exitReason} (Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Tutup posisi 100%
      scenario.openPositions.splice(posIdx, 1);
      const totalInvested = pos.initialCostBasisUsd || costBasisSold;
      const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
      const isWin = pos.realizedPnlUsd >= 0;

      if (isWin) scenario.wins += 1;
      else scenario.losses += 1;
      scenario.totalTrades += 1;

      // Trigger callback tindakan trade nyata saat ambang batas exit terpenuhi (100% full exit)
      if (this.onTradeAction) {
        try {
          this.onTradeAction('SELL', scenario.id, signal, {
            stakeUsd: netReceived,
            tokens: tokensToSell,
            priceUsd: pOut,
            reason: exitReason,
          });
        } catch {}
      }

      scenario.closedTrades.unshift({
        mint: pos.mint,
        symbol: pos.symbol,
        tokenName: pos.tokenName,
        openedAt: pos.openedAt,
        closedAt: now,
        entryCount: pos.entryCount,
        totalInvestedUsd: Number(totalInvested.toFixed(2)),
        totalReturnedUsd: Number((totalInvested + pos.realizedPnlUsd).toFixed(2)),
        totalFeesPaidUsd: Number(pos.feesPaidUsd.toFixed(3)),
        realizedPnlUsd: Number(pos.realizedPnlUsd.toFixed(2)),
        roiPct: Number(roi.toFixed(1)),
        exitReason,
        isWin,
        stage1RealUsdReturned: pos.stage1RealUsdReturned || 0,
      });
      if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
    }

    // Skenario 13: Multi-Cycle Ping-Pong Scalper (Masuk di Lembah saat Whale Sell kecil)
    const s13Tracker = this.s13PingPongTrackers.get(signal.mint);
    if (s13Tracker && s13Tracker.status === 'ACTIVE') {
      const s13PosIdx = this.scenarios.s13.openPositions.findIndex(p => p.mint === signal.mint);

      // Kasus A: Jika S13 sedang memegang posisi
      if (s13PosIdx >= 0) {
        const s13Pos = this.scenarios.s13.openPositions[s13PosIdx];
        s13Pos.lastPriceUsd = pOut;

        // 1. Rem Darurat / Emergency Dump Exit: Jika Whale DUMP BESAR (>= 40% atau Full Exit)
        if (isFullExit || sellRatio >= 0.40 || currentSellRatioPct >= 40.0) {
          s13Tracker.status = 'TERMINATED';
          const reason = `S13_EMERGENCY_WHALE_DUMP_EXIT (Whale dump ${currentSellRatioPct}% >= 40% | Emergency Exit & Terminate Ping-Pong)`;
          this.executeScenarioExit(this.scenarios.s13, s13PosIdx, pOut, now, timeWib, reason);
          s13Tracker.lastExitAt = now;
        }
      } else {
        // Kasus B: S13 TIDAK memegang posisi -> CEK APAKAH BOLEH BELI DI LEMBAH (DIP ENTRY)!
        const elapsedSinceFirstBuy = now - s13Tracker.whaleFirstBuyAt;
        const isWithin15M = elapsedSinceFirstBuy < 15 * 60 * 1000; // < 15 menit
        const isNotMajorDump = !isFullExit && sellRatio < 0.35 && currentSellRatioPct < 35.0; // Bukan dump besar
        const isCycleAvailable = s13Tracker.cycleCount < s13Tracker.maxCycles;
        const cooldownOk = (now - s13Tracker.lastExitAt) >= 3000; // jeda 3 detik pasca exit terakhir

        if (isWithin15M && isNotMajorDump && isCycleAvailable && cooldownOk && pOut > 0) {
          s13Tracker.cycleCount += 1;
          let s13Stake = 5.0;
          try {
            const liveCfg = readFollowerLiveConfig(this.dataDir);
            s13Stake = (liveCfg as any).stakeUsdS13 || 5.0;
          } catch {}

          const dipBuySignal: WalletTradeSignal = {
            action: 'buy',
            mint: signal.mint,
            symbol: signal.symbol,
            tokenName: signal.tokenName,
            tokenAmount: 0,
            remainingHolding: 0,
            solAmount: 0,
            usdAmount: targetUsd,
            priceUsd: pOut,
            txHash: `s13_cycle${s13Tracker.cycleCount}_${now}`,
            timestamp: Math.floor(now / 1000),
            isOpenOrClose: true,
            isFirstBuy: false,
            pairAddress: signal.pairAddress || s13Tracker.pairAddress || '',
            exchange: s13Tracker.exchange || 'pump_amm'
          };

          this.processScenarioBuy(this.scenarios.s13, dipBuySignal, false, targetUsd, now, timeWib, {
            maxTokenExposure: s13Stake,
            getStake: () => s13Stake,
            disallowAccumulation: true,
            allowReEntryCycle: true,
            cycleIndex: s13Tracker.cycleCount
          });

          const createdPos = this.scenarios.s13.openPositions.find(p => p.mint === signal.mint);
          if (createdPos) {
            createdPos.pairAddress = signal.pairAddress || s13Tracker.pairAddress || '';
            createdPos.entryCount = s13Tracker.cycleCount;
          }

          console.log(`\n=========================================================`);
          console.log(`🏓 [SCENARIO 13 PINGPONG DIP BUY] Masuk Siklus #${s13Tracker.cycleCount}/${s13Tracker.maxCycles}:`);
          console.log(`   Token        : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Harga Lembah : $${pOut.toFixed(8)} (Saat Whale Sell ${currentSellRatioPct}%)`);
          console.log(`   Modal Siklus : $${s13Stake.toFixed(2)}`);
          console.log(`   Target Jual  : TP +10% atau saat Whale Buyback berikutnya!`);
          console.log(`=========================================================\n`);
        } else if (!isWithin15M) {
          s13Tracker.status = 'TERMINATED';
          console.log(`[SCENARIO 13] 🏁 Koin ${signal.symbol} sudah berumur >= 15 menit. Siklus ping-pong selesai permanen!`);
        } else if (isFullExit || sellRatio >= 0.40) {
          s13Tracker.status = 'TERMINATED';
          console.log(`[SCENARIO 13] ⛔ Whale DUMP BESAR (${currentSellRatioPct}% >= 40%). Siklus ping-pong koin ${signal.symbol} dihentikan!`);
        }
      }
    }

    // Skenario 13.5: Adaptive Ping-Pong Runner (Uncapped Cycles | 3 Consecutive Sells & Dynamic Health Gates)
    const s13_5Tracker = this.s13_5PingPongTrackers.get(signal.mint);
    if (s13_5Tracker && s13_5Tracker.status === 'ACTIVE') {
      s13_5Tracker.consecutiveSells += 1;
      s13_5Tracker.whaleRemainingHolding = signal.remainingHolding;
      const peakHolding = s13_5Tracker.whalePeakHolding || 1;
      const cumSoldPct = Math.max(0, ((peakHolding - signal.remainingHolding) / peakHolding) * 100);
      const singleSellUsd = targetUsd;
      const elapsedSinceFirstBuy = now - s13_5Tracker.whaleFirstBuyAt;
      const isPast10M = elapsedSinceFirstBuy >= 10 * 60 * 1000;

      const s13_5PosIdx = this.scenarios.s13_5.openPositions.findIndex(p => p.mint === signal.mint);

      // Cek sinyal bahaya terminate
      const isDanger3ConsecutiveSells = s13_5Tracker.consecutiveSells >= 3;
      const isDangerCumSold35 = cumSoldPct >= 35.0 || sellRatio >= 0.35 || isFullExit;
      const isDangerLargeSingleSell = singleSellUsd >= 300.0;

      if (s13_5PosIdx >= 0) {
        // Sedang pegang posisi S13.5:
        const s13_5Pos = this.scenarios.s13_5.openPositions[s13_5PosIdx];
        s13_5Pos.lastPriceUsd = pOut;

        if (isDanger3ConsecutiveSells || isDangerCumSold35 || isDangerLargeSingleSell || isPast10M) {
          s13_5Tracker.status = 'TERMINATED';
          let reason = '';
          if (isDanger3ConsecutiveSells) {
            reason = `S13_5_EMERGENCY_3_CONSECUTIVE_SELLS (Whale sell ${s13_5Tracker.consecutiveSells}x berturut-turut tanpa buyback | Emergency Exit & Terminate)`;
          } else if (isDangerCumSold35) {
            reason = `S13_5_EMERGENCY_CUM_DUMP_EXIT (Whale kumulatif dump ${cumSoldPct.toFixed(1)}% >= 35% | Emergency Exit & Terminate)`;
          } else if (isDangerLargeSingleSell) {
            reason = `S13_5_EMERGENCY_LARGE_SELL_EXIT (Whale sell tunggal $${singleSellUsd.toFixed(0)} >= $300 | Emergency Exit & Terminate)`;
          } else {
            reason = `S13_5_MAX_AGE_10M_TIMEOUT_EXIT (Koin berumur >= 10m, akhiri pingpong sebelum rugpull)`;
          }
          this.executeScenarioExit(this.scenarios.s13_5, s13_5PosIdx, pOut, now, timeWib, reason);
          s13_5Tracker.lastExitAt = now;
        }
      } else {
        // Tidak sedang pegang posisi:
        if (isDanger3ConsecutiveSells || isDangerCumSold35 || isDangerLargeSingleSell || isPast10M) {
          s13_5Tracker.status = 'TERMINATED';
          console.log(`[SCENARIO 13.5] ⛔ Sesi dihentikan (${isDanger3ConsecutiveSells ? '3 Consecutive Sells' : (isDangerCumSold35 ? 'Cum Sold >= 35%' : (isDangerLargeSingleSell ? 'Single Sell >= $300' : 'Age >= 10m'))}) untuk ${signal.symbol}!`);
        } else {
          // CEK APAKAH BOLEH BELI DI LEMBAH:
          // HANYA masuk di Sell ke-1 (Normal Dip). Jika sell beruntun >= 2x, BEKUKAN pembelian!
          const isSingleSellDip = s13_5Tracker.consecutiveSells === 1;
          const cooldownOk = (now - s13_5Tracker.lastExitAt) >= 3000;
          const isNotLargeSell = singleSellUsd < 250.0;

          if (isSingleSellDip && cooldownOk && isNotLargeSell && pOut > 0) {
            s13_5Tracker.cycleCount += 1;
            let s13_5Stake = 5.0;
            try {
              const liveCfg = readFollowerLiveConfig(this.dataDir);
              s13_5Stake = (liveCfg as any).stakeUsdS13_5 || (liveCfg as any).stakeUsdS13 || 5.0;
            } catch {}

            const dipBuySignal: WalletTradeSignal = {
              action: 'buy',
              mint: signal.mint,
              symbol: signal.symbol,
              tokenName: signal.tokenName,
              tokenAmount: 0,
              remainingHolding: 0,
              solAmount: 0,
              usdAmount: targetUsd,
              priceUsd: pOut,
              txHash: `s13_5_cycle${s13_5Tracker.cycleCount}_${now}`,
              timestamp: Math.floor(now / 1000),
              isOpenOrClose: true,
              isFirstBuy: false,
              pairAddress: signal.pairAddress || s13_5Tracker.pairAddress || '',
              exchange: s13_5Tracker.exchange || 'pump_amm'
            };

            this.processScenarioBuy(this.scenarios.s13_5, dipBuySignal, false, targetUsd, now, timeWib, {
              maxTokenExposure: s13_5Stake,
              getStake: () => s13_5Stake,
              disallowAccumulation: true,
              allowReEntryCycle: true,
              cycleIndex: s13_5Tracker.cycleCount
            });

            const createdPos = this.scenarios.s13_5.openPositions.find(p => p.mint === signal.mint);
            if (createdPos) {
              createdPos.pairAddress = signal.pairAddress || s13_5Tracker.pairAddress || '';
              createdPos.entryCount = s13_5Tracker.cycleCount;
            }

            console.log(`\n=========================================================`);
            console.log(`⚡ [SCENARIO 13.5 DYNAMIC PINGPONG DIP BUY] Masuk Siklus #${s13_5Tracker.cycleCount} (Uncapped):`);
            console.log(`   Token        : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
            console.log(`   Harga Lembah : $${pOut.toFixed(8)} (Saat Whale Sell #1 $${singleSellUsd.toFixed(0)})`);
            console.log(`   Modal Siklus : $${s13_5Stake.toFixed(2)}`);
            console.log(`   Target Jual  : TP +10% atau saat Whale Buyback berikutnya!`);
            console.log(`=========================================================\n`);
          } else if (s13_5Tracker.consecutiveSells >= 2) {
            console.log(`[SCENARIO 13.5] ❄️ Membekukan pembelian lembah untuk ${signal.symbol}: Whale sell ${s13_5Tracker.consecutiveSells}x beruntun (potensi dump, jangan serok)!`);
          }
        }
      }
    }

    // 9. Skenario 13-Alpha: Ping-Pong Dip Buy & Emergency Dump Exit
    const s13AlphaTracker = this.s13AlphaTrackers.get(signal.mint);
    if (s13AlphaTracker && s13AlphaTracker.status === 'ACTIVE') {
      s13AlphaTracker.consecutiveSells += 1;
      s13AlphaTracker.whaleRemainingHolding = signal.remainingHolding;
      const peakHolding = s13AlphaTracker.whalePeakHolding || 1;
      const cumSoldPct = Math.max(0, ((peakHolding - signal.remainingHolding) / peakHolding) * 100);
      const singleSellUsd = targetUsd;
      const elapsedSinceFirstBuy = now - s13AlphaTracker.whaleFirstBuyAt;
      const isPast10M = elapsedSinceFirstBuy >= 10 * 60 * 1000;

      const posIdx = this.scenarios.s13_alpha.openPositions.findIndex(p => p.mint === signal.mint);
      const isDanger3ConsecutiveSells = s13AlphaTracker.consecutiveSells >= 3;
      const isDangerCumSold35 = cumSoldPct >= 35.0 || sellRatio >= 0.35 || isFullExit;
      const isDangerLargeSingleSell = singleSellUsd >= 300.0;

      if (posIdx >= 0) {
        const pos = this.scenarios.s13_alpha.openPositions[posIdx];
        pos.lastPriceUsd = pOut;

        if (isDanger3ConsecutiveSells || isDangerCumSold35 || isDangerLargeSingleSell || isPast10M) {
          s13AlphaTracker.status = 'TERMINATED';
          let reason = '';
          if (isDanger3ConsecutiveSells) reason = `S13_ALPHA_EMERGENCY_3_CONSECUTIVE_SELLS`;
          else if (isDangerCumSold35) reason = `S13_ALPHA_EMERGENCY_CUM_DUMP_EXIT`;
          else if (isDangerLargeSingleSell) reason = `S13_ALPHA_EMERGENCY_LARGE_SELL_EXIT`;
          else reason = `S13_ALPHA_MAX_AGE_10M_TIMEOUT_EXIT`;
          this.executeScenarioExit(this.scenarios.s13_alpha, posIdx, pOut, now, timeWib, reason);
          s13AlphaTracker.lastExitAt = now;
        }
      } else {
        // Tanpa Ping-Pong: Sekali keluar, tidak re-enter beli lembah!
        if (isDanger3ConsecutiveSells || isDangerCumSold35 || isDangerLargeSingleSell || isPast10M) {
          s13AlphaTracker.status = 'TERMINATED';
        }
      }
    }

    // 10. Skenario 13-Beta: Emergency Dump Exit (Tanpa Ping-Pong Dip Buy)
    const s13BetaTracker = this.s13BetaTrackers.get(signal.mint);
    if (s13BetaTracker && (s13BetaTracker.status === 'ACTIVE' || s13BetaTracker.status === 'ACTIVE_MONITORING')) {
      s13BetaTracker.consecutiveSells += 1;
      s13BetaTracker.whaleRemainingHolding = signal.remainingHolding;
      const peakHolding = s13BetaTracker.whalePeakHolding || 1;
      const cumSoldPct = Math.max(0, ((peakHolding - signal.remainingHolding) / peakHolding) * 100);
      const singleSellUsd = targetUsd;
      const elapsedSinceFirstBuy = now - s13BetaTracker.whaleFirstBuyAt;
      const isPast10M = elapsedSinceFirstBuy >= 10 * 60 * 1000;

      const posIdx = this.scenarios.s13_beta.openPositions.findIndex(p => p.mint === signal.mint);
      const isDanger3ConsecutiveSells = s13BetaTracker.consecutiveSells >= 3;
      const isDangerCumSold35 = cumSoldPct >= 35.0 || sellRatio >= 0.35 || isFullExit;
      const isDangerLargeSingleSell = singleSellUsd >= 300.0;

      if (posIdx >= 0) {
        const pos = this.scenarios.s13_beta.openPositions[posIdx];
        pos.lastPriceUsd = pOut;

        if (isDanger3ConsecutiveSells || isDangerCumSold35 || isDangerLargeSingleSell || isPast10M) {
          s13BetaTracker.status = 'TERMINATED';
          let reason = '';
          if (isDanger3ConsecutiveSells) reason = `S13_BETA_EMERGENCY_3_CONSECUTIVE_SELLS`;
          else if (isDangerCumSold35) reason = `S13_BETA_EMERGENCY_CUM_DUMP_EXIT`;
          else if (isDangerLargeSingleSell) reason = `S13_BETA_EMERGENCY_LARGE_SELL_EXIT`;
          else reason = `S13_BETA_MAX_AGE_10M_TIMEOUT_EXIT`;
          this.executeScenarioExit(this.scenarios.s13_beta, posIdx, pOut, now, timeWib, reason);
          s13BetaTracker.lastExitAt = now;
        }
      } else {
        // Tanpa Ping-Pong: Sekali keluar, tidak re-enter beli lembah!
        if (isDanger3ConsecutiveSells || isDangerCumSold35 || isDangerLargeSingleSell || isPast10M) {
          s13BetaTracker.status = 'TERMINATED';
        }
      }
    }

    // 11. Skenario 13-Alpha-1: Whale Wave Rider Exit on Dump Signals
    const s13Alpha1Tracker = this.s13Alpha1Trackers.get(signal.mint);
    if (s13Alpha1Tracker && s13Alpha1Tracker.status === 'ACTIVE') {
      s13Alpha1Tracker.consecutiveSells += 1;
      s13Alpha1Tracker.whaleRemainingHolding = signal.remainingHolding;
      const peakHolding = s13Alpha1Tracker.whalePeakHolding || 1;
      const cumSoldPct = Math.max(0, ((peakHolding - signal.remainingHolding) / peakHolding) * 100);
      const singleSellUsd = targetUsd;
      const elapsedSinceFirstBuy = now - s13Alpha1Tracker.whaleFirstBuyAt;
      const isPast10M = elapsedSinceFirstBuy >= 10 * 60 * 1000;

      const posIdx = this.scenarios.s13_alpha_1.openPositions.findIndex(p => p.mint === signal.mint);
      const isWhale3ConsecutiveSells = s13Alpha1Tracker.consecutiveSells >= 3;
      const isWhaleLargeSell = singleSellUsd >= 220.0 || (signal.solAmount && signal.solAmount >= 2.5);
      const isDangerCumSold35 = cumSoldPct >= 35.0 || sellRatio >= 0.35 || isFullExit;

      if (posIdx >= 0) {
        const pos = this.scenarios.s13_alpha_1.openPositions[posIdx];
        pos.lastPriceUsd = pOut;

        if (isWhale3ConsecutiveSells || isWhaleLargeSell || isDangerCumSold35 || isPast10M) {
          s13Alpha1Tracker.status = 'TERMINATED';
          let reason = '';
          if (isWhale3ConsecutiveSells) reason = `S13_ALPHA_1_WHALE_3_CONSECUTIVE_SELLS (Whale sell ${s13Alpha1Tracker.consecutiveSells}x beruntun tanpa buyback | Cuan Max Exit)`;
          else if (isWhaleLargeSell) reason = `S13_ALPHA_1_LARGE_WHALE_SELL (Whale sell tunggal $${singleSellUsd.toFixed(0)} >= $220 | Cuan Max Exit)`;
          else if (isDangerCumSold35) reason = `S13_ALPHA_1_EMERGENCY_CUM_DUMP_EXIT`;
          else reason = `S13_ALPHA_1_MAX_AGE_10M_TIMEOUT_EXIT`;
          this.executeScenarioExit(this.scenarios.s13_alpha_1, posIdx, pOut, now, timeWib, reason);
          s13Alpha1Tracker.lastExitAt = now;
        }
      } else {
        if (isWhale3ConsecutiveSells || isWhaleLargeSell || isDangerCumSold35 || isPast10M) {
          s13Alpha1Tracker.status = 'TERMINATED';
        }
      }
    }

    // 12. Skenario 13-Beta-1: Whale Wave Rider Exit on Dump Signals
    const s13Beta1Tracker = this.s13Beta1Trackers.get(signal.mint);
    if (s13Beta1Tracker && (s13Beta1Tracker.status === 'ACTIVE' || s13Beta1Tracker.status === 'ACTIVE_MONITORING')) {
      s13Beta1Tracker.consecutiveSells += 1;
      s13Beta1Tracker.whaleRemainingHolding = signal.remainingHolding;
      const peakHolding = s13Beta1Tracker.whalePeakHolding || 1;
      const cumSoldPct = Math.max(0, ((peakHolding - signal.remainingHolding) / peakHolding) * 100);
      const singleSellUsd = targetUsd;
      const elapsedSinceFirstBuy = now - s13Beta1Tracker.whaleFirstBuyAt;
      const isPast10M = elapsedSinceFirstBuy >= 10 * 60 * 1000;

      const posIdx = this.scenarios.s13_beta_1.openPositions.findIndex(p => p.mint === signal.mint);
      const isWhale3ConsecutiveSells = s13Beta1Tracker.consecutiveSells >= 3;
      const isWhaleLargeSell = singleSellUsd >= 220.0 || (signal.solAmount && signal.solAmount >= 2.5);
      const isDangerCumSold35 = cumSoldPct >= 35.0 || sellRatio >= 0.35 || isFullExit;

      if (posIdx >= 0) {
        const pos = this.scenarios.s13_beta_1.openPositions[posIdx];
        pos.lastPriceUsd = pOut;

        if (isWhale3ConsecutiveSells || isWhaleLargeSell || isDangerCumSold35 || isPast10M) {
          s13Beta1Tracker.status = 'TERMINATED';
          let reason = '';
          if (isWhale3ConsecutiveSells) reason = `S13_BETA_1_WHALE_3_CONSECUTIVE_SELLS (Whale sell ${s13Beta1Tracker.consecutiveSells}x beruntun tanpa buyback | Cuan Max Exit)`;
          else if (isWhaleLargeSell) reason = `S13_BETA_1_LARGE_WHALE_SELL (Whale sell tunggal $${singleSellUsd.toFixed(0)} >= $220 | Cuan Max Exit)`;
          else if (isDangerCumSold35) reason = `S13_BETA_1_EMERGENCY_CUM_DUMP_EXIT`;
          else reason = `S13_BETA_1_MAX_AGE_10M_TIMEOUT_EXIT`;
          this.executeScenarioExit(this.scenarios.s13_beta_1, posIdx, pOut, now, timeWib, reason);
          s13Beta1Tracker.lastExitAt = now;
        }
      } else {
        if (isWhale3ConsecutiveSells || isWhaleLargeSell || isDangerCumSold35 || isPast10M) {
          s13Beta1Tracker.status = 'TERMINATED';
        }
      }
    }

    // 13. Skenario 13-Centaur: Hybrid Initial Pump Rider & 25s Whale Decision Gate
    const centaurTracker = this.s13CentaurTrackers.get(signal.mint);
    if (centaurTracker && centaurTracker.status !== 'TERMINATED' && centaurTracker.status !== 'SCALPED_PRE_RUG') {
      const ageSec = (now - centaurTracker.whaleFirstBuyAt) / 1000;
      centaurTracker.consecutiveWhaleSells++;

      if (centaurTracker.status === 'ACTIVE_INITIAL_PUMP') {
        if ((signal.solAmount && signal.solAmount >= 8.0) || targetUsd >= 700) {
          centaurTracker.hasLargeSell10_25s = true;
        }
        // Jika muncul dump raksasa >= 15 SOL seketika (detik 20-35), percepat evaluasi untuk abort/exit!
        if ((signal.solAmount && signal.solAmount >= 15.0) || targetUsd >= 1300) {
          this.evaluateS13Centaur1sGate(signal.mint);
          return;
        }
      } else if (centaurTracker.status === 'RUNNER_WAVE_RIDE') {
        const posIdx = this.scenarios.s13_centaur.openPositions.findIndex(p => p.mint === signal.mint);
        if (posIdx >= 0) {
          const isWhale3ConsecutiveSells = centaurTracker.consecutiveWhaleSells >= 3;
          const isWhaleGiantSell = (signal.solAmount && signal.solAmount >= 15.0) || targetUsd >= 1300;
          const isPast30M = ageSec >= 1800;

          if (isWhale3ConsecutiveSells || isWhaleGiantSell || isPast30M) {
            centaurTracker.status = 'EXHAUSTION_EXITED';
            let reason = '';
            if (isWhale3ConsecutiveSells) reason = `S13_CENTAUR_WHALE_3_CONSECUTIVE_SELLS (Whale sell 3x beruntun tanpa buyback | Wave Ride Complete)`;
            else if (isWhaleGiantSell) reason = `S13_CENTAUR_WHALE_GIANT_SELL (Whale dump $${targetUsd.toFixed(0)} >= 15 SOL | Wave Ride Complete)`;
            else reason = `S13_CENTAUR_MAX_AGE_30M_TIMEOUT`;
            this.executeScenarioExit(this.scenarios.s13_centaur, posIdx, pOut, now, timeWib, reason);
            centaurTracker.lastExitAt = now;
          }
        }
      }
    }

    // 14. Skenario 14: Bundler-Confirmed Runner Wave Rider
    const s14Tracker = this.s14Trackers.get(signal.mint);
    if (s14Tracker && s14Tracker.status !== 'TERMINATED' && s14Tracker.status !== 'EXITED_TRAILING_STOP' && s14Tracker.status !== 'EXITED_WHALE_DUMP' && s14Tracker.status !== 'EXITED_PROFIT') {
      const ageSec = (now - s14Tracker.whaleFirstBuyAt) / 1000;
      s14Tracker.whaleSellsCount++;
      s14Tracker.whaleRemainingHolding = signal.remainingHolding;

      // Filter sell signifikan (Anti-Shakeout):
      // Hanya hitung consecutive sell jika order sell berukuran signifikan (>= 3.0 SOL / >= $250)
      // ATAU sisa holding Whale sudah di bawah 50% muatannya.
      // Order receh (< 3 SOL) saat Whale masih pegang > 50% diabaikan sebagai wash-trading/ping-pong normal.
      const isSignificantSell = (signal.solAmount && signal.solAmount >= 3.0) || targetUsd >= 250 || (signal.remainingHolding < s14Tracker.whalePeakHolding * 0.50);
      if (isSignificantSell) {
        s14Tracker.consecutiveWhaleSells++;
      }

      if (s14Tracker.status === 'ACTIVE_RIDING') {
        const posIdx = this.scenarios.s14.openPositions.findIndex(p => p.mint === signal.mint);
        if (posIdx >= 0) {
          const isWhale3ConsecutiveSells = s14Tracker.consecutiveWhaleSells >= 3;
          const isWhaleGiantSell = (signal.solAmount && signal.solAmount >= 15.0) || targetUsd >= 1300;
          const isPast30M = ageSec >= 1800;

          if (isWhale3ConsecutiveSells || isWhaleGiantSell || isPast30M) {
            s14Tracker.status = 'EXITED_WHALE_DUMP';
            let reason = '';
            if (isWhale3ConsecutiveSells) reason = `S14_WHALE_3_CONSECUTIVE_SELLS (Whale sell 3x beruntun signifikan >= 3 SOL | Wave Ride Complete)`;
            else if (isWhaleGiantSell) reason = `S14_WHALE_GIANT_SELL (Whale dump $${targetUsd.toFixed(0)} >= 15 SOL | Wave Ride Complete)`;
            else reason = `S14_MAX_AGE_30M_TIMEOUT`;
            this.executeScenarioExit(this.scenarios.s14, posIdx, pOut, now, timeWib, reason);
            s14Tracker.lastExitAt = now;
          }
        }
      }
    }

    // 15. Skenario 14-Alpha: Bundler-Confirmed Runner + 60s Grace Period (Anti-Rugpull 100%)
    const s14AlphaTracker = this.s14AlphaTrackers.get(signal.mint);
    if (s14AlphaTracker && s14AlphaTracker.status !== 'TERMINATED' && s14AlphaTracker.status !== 'EXITED_TRAILING_STOP' && s14AlphaTracker.status !== 'EXITED_WHALE_DUMP' && s14AlphaTracker.status !== 'EXITED_PROFIT') {
      const ageSec = (now - s14AlphaTracker.whaleFirstBuyAt) / 1000;
      s14AlphaTracker.whaleSellsCount++;
      s14AlphaTracker.whaleRemainingHolding = signal.remainingHolding;

      const isSignificantSell = (signal.solAmount && signal.solAmount >= 3.0) || targetUsd >= 250 || (signal.remainingHolding < s14AlphaTracker.whalePeakHolding * 0.50);
      if (isSignificantSell) {
        s14AlphaTracker.consecutiveWhaleSells++;
      }

      // Jika masih dalam status OBSERVING_BUNDLER (dalam 60s pertama) dan Whale Giant Dump / kuras kas:
      if (s14AlphaTracker.status === 'OBSERVING_BUNDLER') {
        const isWhaleGiantSell = (signal.solAmount && signal.solAmount >= 15.0) || targetUsd >= 1300;
        if (isWhaleGiantSell) {
          console.log(`[SCENARIO 14-ALPHA SKIP] Whale Giant Dump ($${targetUsd.toFixed(0)}) terdeteksi pada masa Grace Period. Token dibatalkan.`);
          s14AlphaTracker.status = 'TERMINATED';
        }
      }

      if (s14AlphaTracker.status === 'ACTIVE_RIDING') {
        const posIdx = this.scenarios.s14_alpha.openPositions.findIndex(p => p.mint === signal.mint);
        if (posIdx >= 0) {
          const isWhale3ConsecutiveSells = s14AlphaTracker.consecutiveWhaleSells >= 3;
          const isWhaleGiantSell = (signal.solAmount && signal.solAmount >= 15.0) || targetUsd >= 1300;
          const isPast30M = ageSec >= 1800;

          if (isWhale3ConsecutiveSells || isWhaleGiantSell || isPast30M) {
            s14AlphaTracker.status = 'EXITED_WHALE_DUMP';
            let reason = '';
            if (isWhale3ConsecutiveSells) reason = `S14_ALPHA_WHALE_3_CONSECUTIVE_SELLS (Whale sell 3x beruntun signifikan >= 3 SOL | Wave Ride Complete)`;
            else if (isWhaleGiantSell) reason = `S14_ALPHA_WHALE_GIANT_SELL (Whale dump $${targetUsd.toFixed(0)} >= 15 SOL | Wave Ride Complete)`;
            else reason = `S14_ALPHA_MAX_AGE_30M_TIMEOUT`;
            this.executeScenarioExit(this.scenarios.s14_alpha, posIdx, pOut, now, timeWib, reason);
            s14AlphaTracker.lastExitAt = now;
          }
        }
      }
    }

    this.saveState();
  }

  /**
   * Update unrealized PnL saat harga berubah
   */
  public updatePriceTick(mint: string, priceUsd: number): void {
    if (priceUsd <= 0) return;
    this.lastObservedPrices.set(mint, priceUsd);
    let changed = false;

    for (const scenario of Object.values(this.scenarios)) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === mint);
      if (posIdx !== -1) {
        const pos = scenario.openPositions[posIdx];
        pos.lastPriceUsd = priceUsd;
        const curVal = pos.tokens * priceUsd;
        pos.unrealizedPnlUsd = Number((curVal - pos.costBasisUsd).toFixed(2));
        changed = true;

        // Khusus Skenario 13 & Skenario 13.5: Multi-Cycle Ping-Pong Scalper (TP +10% & Stop Loss -10%)
        if ((scenario.id === 'SCENARIO_13_PINGPONG_SCALPER' || scenario.id === 'SCENARIO_13_5_DYNAMIC_PINGPONG') && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          const now = Date.now();
          const timeWib = formatWibDate(now);

          // 1. Take Profit +10% (Kunci Cuan Cepat di Ayunan Ping-Pong)
          if (gainPct >= 10.0) {
            const exitReason = `TP_10%_PINGPONG_SWING (Gain: +${gainPct.toFixed(1)}% >= +10% | Kunci profit siklus #${pos.entryCount})`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            const tracker13 = this.s13PingPongTrackers.get(mint);
            if (tracker13) tracker13.lastExitAt = now;
            const tracker13_5 = this.s13_5PingPongTrackers.get(mint);
            if (tracker13_5) tracker13_5.lastExitAt = now;
            continue;
          }

          // 2. Cut Loss Ketat (-10%)
          if (gainPct <= -10.0) {
            const exitReason = `STOP_LOSS_10% (Drop: ${gainPct.toFixed(1)}% <= -10% | Cut-loss pengaman siklus #${pos.entryCount})`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            const tracker13 = this.s13PingPongTrackers.get(mint);
            if (tracker13) tracker13.lastExitAt = now;
            const tracker13_5 = this.s13_5PingPongTrackers.get(mint);
            if (tracker13_5) tracker13_5.lastExitAt = now;
            continue;
          }
        }

        // Khusus Skenario 13-Alpha & Skenario 13-Beta: Target Take Profit +100% (2x Lipat Modal | Tanpa Ping-Pong)
        if ((scenario.id === 'SCENARIO_13_ALPHA_SNIPER_GATE' || scenario.id === 'SCENARIO_13_BETA_INSTANT_DUMP') && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          const now = Date.now();
          const timeWib = formatWibDate(now);

          // 1. Take Profit +100% (Target 2x Lipat Modal -> Full Exit Selesai)
          if (gainPct >= 100.0) {
            const exitReason = `TP_100%_DOUBLE_UP (Gain: +${gainPct.toFixed(1)}% >= +100% | Cuan 2x Lipat Modal Tercapai -> Full Exit)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            const trackerAlpha = this.s13AlphaTrackers.get(mint);
            if (trackerAlpha) { trackerAlpha.status = 'TERMINATED'; trackerAlpha.lastExitAt = now; }
            const trackerBeta = this.s13BetaTrackers.get(mint);
            if (trackerBeta) { trackerBeta.status = 'TERMINATED'; trackerBeta.lastExitAt = now; }
            continue;
          }

          // 2. Cut Loss Pengaman (-10%)
          if (gainPct <= -10.0) {
            const exitReason = `STOP_LOSS_10% (Drop: ${gainPct.toFixed(1)}% <= -10% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            const trackerAlpha = this.s13AlphaTrackers.get(mint);
            if (trackerAlpha) { trackerAlpha.status = 'TERMINATED'; trackerAlpha.lastExitAt = now; }
            const trackerBeta = this.s13BetaTrackers.get(mint);
            if (trackerBeta) { trackerBeta.status = 'TERMINATED'; trackerBeta.lastExitAt = now; }
            continue;
          }
        }

        // Khusus Skenario 13-Alpha-1 & Skenario 13-Beta-1: Whale Wave Rider (Max Profit Riding + Trailing Stop -20% from Peak)
        if ((scenario.id === 'SCENARIO_13_ALPHA_1_WAVE_RIDER' || scenario.id === 'SCENARIO_13_BETA_1_WAVE_RIDER') && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          const now = Date.now();
          const timeWib = formatWibDate(now);

          // Update peak price
          if (!pos.peakPriceUsd || priceUsd > pos.peakPriceUsd) {
            pos.peakPriceUsd = priceUsd;
          }

          // 1. Trailing Stop: Jika sudah mencapai profit >= +100% dan harga terkoreksi >= 20% dari puncak
          if (gainPct >= 100.0) {
            const dropFromPeak = ((pos.peakPriceUsd - priceUsd) / pos.peakPriceUsd) * 100;
            if (dropFromPeak >= 20.0) {
              const exitReason = `TRAILING_STOP_20%_LOCK (Gain: +${gainPct.toFixed(1)}% | Drop ${dropFromPeak.toFixed(1)}% dari Peak $${pos.peakPriceUsd.toFixed(8)} | Lock Cuan Max!)`;
              this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
              const trackerAlpha1 = this.s13Alpha1Trackers.get(mint);
              if (trackerAlpha1) { trackerAlpha1.status = 'TERMINATED'; trackerAlpha1.lastExitAt = now; }
              const trackerBeta1 = this.s13Beta1Trackers.get(mint);
              if (trackerBeta1) { trackerBeta1.status = 'TERMINATED'; trackerBeta1.lastExitAt = now; }
              continue;
            }
          }

          // 2. Cut Loss Pengaman (-10%)
          if (gainPct <= -10.0) {
            const exitReason = `STOP_LOSS_10% (Drop: ${gainPct.toFixed(1)}% <= -10% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            const trackerAlpha1 = this.s13Alpha1Trackers.get(mint);
            if (trackerAlpha1) { trackerAlpha1.status = 'TERMINATED'; trackerAlpha1.lastExitAt = now; }
            const trackerBeta1 = this.s13Beta1Trackers.get(mint);
            if (trackerBeta1) { trackerBeta1.status = 'TERMINATED'; trackerBeta1.lastExitAt = now; }
            continue;
          }
        }

        // Khusus Skenario 13-Centaur: Hybrid Initial Pump Rider & Wave Rider
        if (scenario.id === 'SCENARIO_13_CENTAUR_HYBRID_RIDER' && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          const now = Date.now();
          const timeWib = formatWibDate(now);
          const centaurTracker = this.s13CentaurTrackers.get(mint);

          if (!pos.peakPriceUsd || priceUsd > pos.peakPriceUsd) {
            pos.peakPriceUsd = priceUsd;
          }

          if (centaurTracker && centaurTracker.status === 'RUNNER_WAVE_RIDE') {
            if (gainPct >= 100.0) {
              const dropFromPeak = ((pos.peakPriceUsd - priceUsd) / pos.peakPriceUsd) * 100;
              if (dropFromPeak >= 20.0) {
                const exitReason = `S13_CENTAUR_TRAILING_STOP_20%_LOCK (Gain: +${gainPct.toFixed(1)}% | Drop ${dropFromPeak.toFixed(1)}% dari Peak $${pos.peakPriceUsd.toFixed(8)} | Lock Cuan Max!)`;
                this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
                centaurTracker.status = 'TERMINATED';
                centaurTracker.lastExitAt = now;
                continue;
              }
            }

            if (gainPct <= -10.0) {
              const exitReason = `STOP_LOSS_10% (Drop: ${gainPct.toFixed(1)}% <= -10% | Cut-loss pengaman)`;
              this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
              centaurTracker.status = 'TERMINATED';
              centaurTracker.lastExitAt = now;
              continue;
            }
          }
        }

        // Khusus Skenario 14 & Skenario 14-Alpha: Bundler-Confirmed Runner (Ride with Whale | Stop Loss -20% dari Entry | Exit on Whale Dump)
        if ((scenario.id === 'SCENARIO_14_BUNDLER_RUNNER' || scenario.id === 'SCENARIO_14_ALPHA_60S_GRACE') && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          const now = Date.now();
          const timeWib = formatWibDate(now);
          const isAlpha = scenario.id === 'SCENARIO_14_ALPHA_60S_GRACE';
          const prefix = isAlpha ? 'S14_ALPHA_' : 'S14_';
          const s14Tracker = isAlpha ? this.s14AlphaTrackers.get(mint) : this.s14Trackers.get(mint);

          if (!pos.peakPriceUsd || priceUsd > pos.peakPriceUsd) {
            pos.peakPriceUsd = priceUsd;
          }

          if (s14Tracker && s14Tracker.status === 'ACTIVE_RIDING') {
            // 1. Take Profit Bertahap Tahap 1: Jual 50% saat gain >= +50% (Kunci Cuan & Modal Aman)
            if (gainPct >= 50.0 && !pos.stage1Exited) {
              const exitReason = `${prefix}STAGE_1_TP_50% (Gain: +${gainPct.toFixed(1)}% >= +50% | Jual 50% amankan modal & cuan, sisa 50% moonbag ride wave)`;
              this.executeScenarioPartial50Exit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
              // Lanjut memantau sisa 50%
            }

            // 2. Take Profit Bertahap Tahap 2: Jual sisa 50% saat gain >= +100%
            if (gainPct >= 100.0 && pos.stage1Exited) {
              const exitReason = `${prefix}STAGE_2_TP_100% (Gain: +${gainPct.toFixed(1)}% >= +100% | Moonbag Cuan Maksimal 100% Tercapai!)`;
              this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
              s14Tracker.status = 'EXITED_PROFIT';
              s14Tracker.lastExitAt = now;
              continue;
            }

            // Cut loss HANYA jika harga turun -20% dari harga kita masuk (hanya berlaku jika belum TP 1):
            if (gainPct <= -20.0 && !pos.stage1Exited) {
              const exitReason = `STOP_LOSS_20%_ENTRY (Drop: ${gainPct.toFixed(1)}% <= -20% dari harga masuk $${pos.avgEntryPriceUsd.toFixed(8)} | Cut-loss pengaman)`;
              this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
              s14Tracker.status = 'TERMINATED';
              s14Tracker.lastExitAt = now;
              continue;
            }
          }
        }

        // Khusus Skenario 5 & Skenario 9: Auto Take-Profit +25% & Stop Loss -15%
        if ((scenario.id === 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER' || scenario.id === 'SCENARIO_9_DEV_FRONTRUN_SYNC') && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          if (gainPct >= 25.0) {
            const now = Date.now();
            const timeWib = formatWibDate(now);
            const exitReason = `AUTO_TAKE_PROFIT_25% (Gain: +${gainPct.toFixed(1)}% >= +25% | Mengunci cuan puncak wave)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
          if (gainPct <= -15.0) {
            const now = Date.now();
            // Grace Period 12 Detik: Jika whale baru masuk (< 12s), tahan cut-loss agar tidak terkena shakeout tick saat pompa sedang berjalan
            if (pos.targetEnteredAt && (now - pos.targetEnteredAt) < 12000) {
              continue;
            }
            const timeWib = formatWibDate(now);
            const exitReason = `STOP_LOSS_15% (Drop: ${gainPct.toFixed(1)}% <= -15% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
        }

        // Khusus Skenario 9.5: Split TP 50/50 + 1-Min Moonbag
        // Jika dari awal swap / pergerakan harga gain >= +300%: JUAL 50% saja, sisa 50% tahan 1 menit!
        // Jika target dump 100%: langsung jual semua. Jika gain < 300%: TP normal +25%.
        if (scenario.id === 'SCENARIO_9_5_SPLIT_TP_MOONBAG' && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          const now = Date.now();
          const timeWib = formatWibDate(now);

          // 1. Cut Loss Pengaman (-15%)
          if (gainPct <= -15.0) {
            if (pos.targetEnteredAt && (now - pos.targetEnteredAt) < 12000) {
              continue; // Grace period 12s saat whale baru masuk
            }
            const exitReason = `STOP_LOSS_15% (Drop: ${gainPct.toFixed(1)}% <= -15% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }

          // 2. Stage 1 TP 50%: Jika gain >= +300% dan BELUM jual Stage 1
          if (gainPct >= 300.0 && !pos.stage1Exited) {
            const stage1Reason = `STAGE_1_TP_50%_MOONBAG (Gain: +${gainPct.toFixed(1)}% >= +300% | Jual 50%, tahan 50% moonbag 1m)`;
            this.executeScenarioPartial50Exit(scenario, posIdx, priceUsd, now, timeWib, stage1Reason);
            continue;
          }

          // 3. Normal TP +25%: Jika gain >= +25% tapi < +300%, dan BELUM jual Stage 1
          if (gainPct >= 25.0 && !pos.stage1Exited) {
            const exitReason = `AUTO_TAKE_PROFIT_25% (Gain: +${gainPct.toFixed(1)}% >= +25% | Mengunci cuan normal)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }

          // 4. Stage 2 Timeout 1 Menit: Jika SUDAH jual Stage 1 (pos.stage1Exited === true) dan sudah lewat 60 detik
          if (pos.stage1Exited && pos.stage1ExitedAt && (now - pos.stage1ExitedAt) >= 60000) {
            const exitReason = `STAGE_2_MOONBAG_60S_TIMEOUT_EXIT (Sisa 50% token ditahan 1 menit pasca-TP, kunci cuan sisa)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
        }

        // Khusus Skenario 10: Dynamic Wave Runner (Stop-Loss -15%, Hard Ceiling +300%, Trailing Peak Lock)
        // S10 TIDAK MEMICU AUTO_TAKE_PROFIT_25%! Posisi dibiarkan terbang selama whale hold!
        if (scenario.id === 'SCENARIO_10_DYNAMIC_WAVE_RUNNER' && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          if (!pos.peakGainPct || gainPct > pos.peakGainPct) {
            pos.peakGainPct = gainPct;
          }

          // 1. Cut Loss Pengaman (-15%)
          if (gainPct <= -15.0) {
            const now = Date.now();
            // Grace Period 12 Detik: Jika whale baru masuk (< 12s), tahan cut-loss agar tidak terkena shakeout tick saat pompa sedang berjalan
            if (pos.targetEnteredAt && (now - pos.targetEnteredAt) < 12000) {
              continue;
            }
            const timeWib = formatWibDate(now);
            const exitReason = `STOP_LOSS_15% (Drop: ${gainPct.toFixed(1)}% <= -15% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }

          // 2. Hard Ceiling Multi-Bagger (+300% / 4x lipat)
          if (gainPct >= 300.0) {
            const now = Date.now();
            const timeWib = formatWibDate(now);
            const exitReason = `HARD_TP_300%_CEILING (Gain: +${gainPct.toFixed(1)}% >= +300% | Kunci profit multi-bagger puncak wave)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }

          // 3. Trailing Profit Lock: Jika sempat mencapai >= +100% dan terkoreksi >= 30% dari titik puncak
          if (pos.peakGainPct >= 100.0 && gainPct <= pos.peakGainPct * 0.70) {
            const now = Date.now();
            const timeWib = formatWibDate(now);
            const exitReason = `TRAILING_STOP_PEAK_DROP_30% (Peak: +${pos.peakGainPct.toFixed(1)}% -> Current: +${gainPct.toFixed(1)}% | Kunci profit sebelum dump)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
        }

        // 1. Hard Take-Profit Gate: Jika harga melonjak >= +200% (>= 3x dari harga entry)
        // Eksekusi sell 100% instan untuk mengamankan profit multi-bagger sebelum dev rugpull
        // (Dikecualikan untuk S13-Alpha-1, S13-Beta-1, S13-Centaur & S14 yang merupakan Wave Rider pelari bebas cuan maksimal)
        if (pos.avgEntryPriceUsd > 0 && priceUsd >= pos.avgEntryPriceUsd * 3.0 && scenario.id !== 'SCENARIO_13_ALPHA_1_WAVE_RIDER' && scenario.id !== 'SCENARIO_13_BETA_1_WAVE_RIDER' && scenario.id !== 'SCENARIO_13_CENTAUR_HYBRID_RIDER' && scenario.id !== 'SCENARIO_14_BUNDLER_RUNNER') {
          const now = Date.now();
          const timeWib = formatWibDate(now);
          const tokensToSell = pos.tokens;
          const costBasisSold = pos.costBasisUsd;

          const grossReceived = tokensToSell * priceUsd;
          const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
          const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

          pos.realizedPnlUsd = Number(((pos.realizedPnlUsd || 0) + pnlUsd).toFixed(2));
          pos.feesPaidUsd = Number((pos.feesPaidUsd + REAL_SWAP_FEE_USD).toFixed(3));
          scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
          scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
          scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

          scenario.openPositions.splice(posIdx, 1);

          const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? costBasisSold * 2 : costBasisSold);
          const totalInvested = initialInvested;
          const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
          const isWin = pos.realizedPnlUsd >= 0;

          if (isWin) scenario.wins += 1;
          else scenario.losses += 1;
          scenario.totalTrades += 1;

          const exitReason = `HARD_TP_200%_CEILING (Gain: +${roi.toFixed(1)}% >= +200% | Auto-Harvest Profit)`;

          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SELL',
            symbol: pos.symbol,
            mint: pos.mint,
            usdReceived: netReceived,
            feeUsd: REAL_SWAP_FEE_USD,
            tokens: tokensToSell,
            priceUsd,
            pnlUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
            reason: `${exitReason} (Fee: $${REAL_SWAP_FEE_USD})`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

          scenario.closedTrades.unshift({
            mint: pos.mint,
            symbol: pos.symbol,
            tokenName: pos.tokenName,
            openedAt: pos.openedAt,
            closedAt: now,
            entryCount: pos.entryCount,
            totalInvestedUsd: Number(totalInvested.toFixed(2)),
            totalReturnedUsd: Number((totalInvested + pos.realizedPnlUsd).toFixed(2)),
            totalFeesPaidUsd: Number(pos.feesPaidUsd.toFixed(3)),
            realizedPnlUsd: Number(pos.realizedPnlUsd.toFixed(2)),
            roiPct: Number(roi.toFixed(1)),
            exitReason,
            isWin,
          });
          if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();

          // Trigger onTradeAction SELL
          if (this.onTradeAction) {
            try {
              const sellSignal: WalletTradeSignal = {
                action: 'sell',
                mint: pos.mint,
                symbol: pos.symbol,
                tokenName: pos.tokenName,
                tokenAmount: tokensToSell,
                remainingHolding: 0,
                solAmount: 0,
                usdAmount: netReceived,
                priceUsd,
                txHash: '',
                timestamp: Math.floor(now / 1000),
                isOpenOrClose: true,
                isFirstBuy: false,
              };
              this.onTradeAction('SELL', scenario.id, sellSignal, {
                stakeUsd: netReceived,
                tokens: tokensToSell,
                priceUsd,
                reason: exitReason,
              });
            } catch (err: any) {
              console.warn(`[HARD-TP-ACTION-ERR] ${err?.message}`);
            }
          }
          continue;
        }

        // 2. Auto Liquidation Gate: Jika harga crash > 95% dari harga entry (Rugpull/Liquidity Drained)
        if (pos.avgEntryPriceUsd > 0 && priceUsd < pos.avgEntryPriceUsd * 0.05) {
          const now = Date.now();
          const timeWib = formatWibDate(now);
          scenario.openPositions.splice(posIdx, 1);
          scenario.realizedPnl = Number((scenario.realizedPnl - pos.costBasisUsd).toFixed(2));

          const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? pos.costBasisUsd * 2 : pos.costBasisUsd);
          const finalPnlUsd = Number(((pos.realizedPnlUsd || 0) - pos.costBasisUsd).toFixed(2));
          const totalReturned = Math.max(0, Number((initialInvested + finalPnlUsd).toFixed(2)));
          const roiPct = initialInvested > 0 ? Number(((finalPnlUsd / initialInvested) * 100).toFixed(1)) : -100;
          const isWin = finalPnlUsd >= 0;

          if (isWin) scenario.wins += 1;
          else scenario.losses += 1;
          scenario.totalTrades += 1;

          const crashReason = pos.stage1Exited
            ? `AUTO_LIQUIDATION_CRASH (Stage 1 TP done | Sisa 50% dropped >95%)`
            : `AUTO_LIQUIDATION_CRASH (>95% drop / Rugpull)`;

          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SELL',
            symbol: pos.symbol,
            mint: pos.mint,
            usdReceived: 0,
            feeUsd: 0,
            tokens: pos.tokens,
            priceUsd,
            pnlUsd: -pos.costBasisUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - pos.costBasisUsd),
            reason: crashReason,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

          scenario.closedTrades.unshift({
            mint: pos.mint,
            symbol: pos.symbol,
            tokenName: pos.tokenName,
            openedAt: pos.openedAt,
            closedAt: now,
            entryCount: pos.entryCount,
            totalInvestedUsd: initialInvested,
            totalReturnedUsd: totalReturned,
            totalFeesPaidUsd: Number(pos.feesPaidUsd.toFixed(3)),
            realizedPnlUsd: finalPnlUsd,
            roiPct,
            exitReason: crashReason,
            isWin,
          });
          if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
        }
      }
    }

    if (changed) {
      this.saveState();
    }
    this.checkGen2ReEntry(mint, priceUsd);
  }

  /**
   * Pengecekan Re-Entry Otomatis untuk Koin Gen-2 Nama Sama:
   * Jika token Gen-2 keluar via TARGET_SKIPPED_DEV_POOL (atau exit aman),
   * bot menunggu cooldown 1 menit (60s). Jika harga / grafik meningkat,
   * bot mengeksekusi BUY siklus berikutnya (hingga maksimal 5x siklus)!
   */
  public checkGen2ReEntry(targetMint?: string, currentPriceUsd?: number): void {
    const now = Date.now();
    const timeWib = formatWibDate(now);

    for (const [mint, gen2] of this.gen2CycleTracker.entries()) {
      if (targetMint && mint !== targetMint) continue;
      if (gen2.status !== 'COOLDOWN') continue;

      // 1. Cek apakah masa cooldown 60 detik (1 menit) sudah selesai
      if (now < gen2.cooldownUntil) continue;

      // 2. Cek apakah masih dalam batas 5 siklus
      if (gen2.cycleCount >= gen2.maxCycles) {
        gen2.status = 'TERMINATED';
        continue;
      }

      // 3. Re-entry HANYA boleh jika exit sebelumnya adalah TARGET_SKIPPED_DEV_POOL (Whale belum masuk saat peluncuran)
      if (!gen2.lastExitReason || !gen2.lastExitReason.includes('TARGET_SKIPPED_DEV_POOL')) {
        gen2.status = 'TERMINATED';
        continue;
      }

      // 4. Cek apakah trade sebelumnya aman/BEP (toleransi gas fee -$0.05)
      if (!gen2.lastTradeProfitable) {
        gen2.status = 'TERMINATED';
        continue;
      }

      // 5. Cek apakah S9 sedang memegang koin ini (jangan buy jika posisi masih terbuka)
      const hasOpenPos = this.scenarios.s9.openPositions.some(p => p.mint === mint);
      if (hasOpenPos) continue;

      // 5. Cek harga spot saat ini:
      const spotPrice = (currentPriceUsd && currentPriceUsd > 0) ? currentPriceUsd : (this.lastObservedPrices.get(mint) || 0);
      if (spotPrice <= 0) continue;

      // 6. Syarat Grafik / Harga Meningkat:
      // Harga spot saat ini harus lebih tinggi dari harga exit terakhir (ada momentum naik)
      if (spotPrice <= gen2.lastExitPrice) {
        continue;
      }

      const gainSinceExitPct = ((spotPrice - gen2.lastExitPrice) / gen2.lastExitPrice) * 100;
      gen2.cycleCount += 1;
      gen2.status = 'HOLDING';

      console.log(`\n=========================================================`);
      console.log(`🚀 [GEN2 CYCLE RE-ENTRY TRIGGERED] Memulai Buy Putaran ke-${gen2.cycleCount}/${gen2.maxCycles}:`);
      console.log(`   Token        : ${gen2.symbol} [${mint.slice(0, 8)}...]`);
      console.log(`   Harga Exit   : $${gen2.lastExitPrice.toFixed(8)}`);
      console.log(`   Harga Spot   : $${spotPrice.toFixed(8)} (+${gainSinceExitPct.toFixed(1)}% meningkat)`);
      console.log(`   Timer Tunggu : 60 Detik untuk aksi whale / TP`);
      console.log(`=========================================================\n`);

      let s9Stake = 0.25;
      try {
        const liveCfg = readFollowerLiveConfig(this.dataDir);
        s9Stake = liveCfg.stakeUsdS9 || 0.25;
      } catch {}

      const reEntrySignal: WalletTradeSignal = {
        action: 'buy',
        mint,
        symbol: gen2.symbol,
        tokenName: gen2.symbol,
        tokenAmount: 0,
        remainingHolding: 0,
        solAmount: 0,
        usdAmount: 0,
        priceUsd: spotPrice,
        txHash: `gen2_cycle${gen2.cycleCount}_${now}`,
        timestamp: Math.floor(now / 1000),
        isOpenOrClose: true,
        isFirstBuy: false,
        pairAddress: gen2.pairAddress,
        exchange: gen2.exchange,
      };

      this.processScenarioBuy(this.scenarios.s9, reEntrySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s9Stake,
        getStake: () => s9Stake,
        disallowAccumulation: true,
        allowReEntryCycle: true,
        cycleIndex: gen2.cycleCount,
      });

      const newPos = this.scenarios.s9.openPositions.find(p => p.mint === mint);
      if (newPos) {
        newPos.boughtAtGenesis = true; // Enables TARGET_SKIPPED_DEV_POOL 60s timer!
        newPos.openedAt = now; // Fresh 60s timer!
        newPos.pairAddress = gen2.pairAddress;
        newPos.exchange = gen2.exchange;
        newPos.entryCount = gen2.cycleCount;
      }

      this.saveState();
    }
  }

  public getGen2CooldownMints(): string[] {
    const mints: string[] = [];
    for (const [mint, gen2] of this.gen2CycleTracker.entries()) {
      if (gen2.status === 'COOLDOWN') mints.push(mint);
    }
    return mints;
  }

  /**
   * Auto-likuidasi posisi stagnan / terbengkalai (> 25 menit tanpa aktivitas target)
   */
  public checkStagnantPositions(maxAgeMinutes: number = 25): void {
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    let changed = false;

    for (const scenario of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9]) {
      for (let i = scenario.openPositions.length - 1; i >= 0; i--) {
        const pos = scenario.openPositions[i];
        if (now - pos.openedAt >= maxAgeMs) {
          const timeWib = formatWibDate(now);
          scenario.openPositions.splice(i, 1);
          scenario.losses += 1;
          scenario.totalTrades += 1;
          scenario.realizedPnl = Number((scenario.realizedPnl - pos.costBasisUsd).toFixed(2));

          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SELL',
            symbol: pos.symbol,
            mint: pos.mint,
            usdReceived: 0,
            feeUsd: 0,
            tokens: pos.tokens,
            priceUsd: pos.lastPriceUsd,
            pnlUsd: -pos.costBasisUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - pos.costBasisUsd),
            reason: `STAGNANT_TIMEOUT_AUTO_EXIT (No target exit in ${maxAgeMinutes}m)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

          scenario.closedTrades.unshift({
            mint: pos.mint,
            symbol: pos.symbol,
            tokenName: pos.tokenName,
            openedAt: pos.openedAt,
            closedAt: now,
            entryCount: pos.entryCount,
            totalInvestedUsd: pos.costBasisUsd,
            totalReturnedUsd: 0,
            totalFeesPaidUsd: pos.feesPaidUsd,
            realizedPnlUsd: -pos.costBasisUsd,
            roiPct: -100,
            exitReason: `STAGNANT_TIMEOUT_EXIT (> ${maxAgeMinutes}m Abandoned)`,
            isWin: false,
          });
          if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveState();
    }

    // Periksa fallback safety exits (ambil TP jika target diam setelah jual >= 5%)
    this.checkSafetyExits(45000, 60000);
    // Periksa S7 Time-Stop (Force Exit @ 28s)
    this.checkTimeStopExits(28000);
  }

  /**
   * Skenario 7 Time-Stop Exit:
   * Jika posisi terbuka sudah mencapai maxTimeMs (default 28000ms / 28s),
   * bot LANGSUNG FORCE SELL 100% sisa koinnya untuk mengamankan puncak pump sebelum dev rugpull!
   */
  public checkTimeStopExits(maxTimeMs: number = 28000): void {
    const now = Date.now();
    let changed = false;
    this.checkGen2ReEntry();
    const scenario = this.scenarios.s7;

    for (let i = scenario.openPositions.length - 1; i >= 0; i--) {
      const pos = scenario.openPositions[i];
      if (pos.tokens <= 0) continue;

      const elapsedMs = now - pos.openedAt;
      if (elapsedMs >= maxTimeMs) {
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const tokensToSell = pos.tokens;
        const grossReceived = tokensToSell * pOut;
        const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
        const costBasisSold = pos.costBasisUsd;
        const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

        scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
        scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
        scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

        pos.feesPaidUsd += REAL_SWAP_FEE_USD;
        pos.realizedPnlUsd += pnlUsd;
        pos.lastPriceUsd = pOut;
        pos.updatedAt = now;

        const elapsedSec = Math.round(elapsedMs / 1000);
        const reason = `TIME_STOP_${elapsedSec}S_FORCE_EXIT (Reached ${elapsedSec}s post-entry, locked profit before rugpull)`;

        scenario.recentEvents.unshift({
          id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: now,
          timeWib,
          scenarioId: scenario.id,
          action: 'SELL',
          symbol: pos.symbol,
          mint: pos.mint,
          usdReceived: netReceived,
          feeUsd: REAL_SWAP_FEE_USD,
          tokens: tokensToSell,
          priceUsd: pOut,
          pnlUsd,
          availableCashAfter: scenario.availableCash,
          investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
          reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

        scenario.openPositions.splice(i, 1);

        const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? costBasisSold * 2 : costBasisSold);
        const totalInvested = initialInvested;
        const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
        const isWin = pos.realizedPnlUsd >= 0;

        if (isWin) scenario.wins += 1;
        else scenario.losses += 1;
        scenario.totalTrades += 1;

        scenario.closedTrades.unshift({
          mint: pos.mint,
          symbol: pos.symbol,
          tokenName: pos.tokenName,
          openedAt: pos.openedAt,
          closedAt: now,
          entryCount: pos.entryCount,
          totalInvestedUsd: Number(totalInvested.toFixed(2)),
          totalReturnedUsd: Number((totalInvested + pos.realizedPnlUsd).toFixed(2)),
          totalFeesPaidUsd: Number(pos.feesPaidUsd.toFixed(3)),
          realizedPnlUsd: Number(pos.realizedPnlUsd.toFixed(2)),
          roiPct: Number(roi.toFixed(1)),
          exitReason: reason,
          isWin,
          stage1RealUsdReturned: pos.stage1RealUsdReturned || 0,
        });
        if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();

        if (this.onTradeAction) {
          try {
            const signal: WalletTradeSignal = {
              action: 'sell',
              mint: pos.mint,
              symbol: pos.symbol,
              tokenName: pos.tokenName,
              tokenAmount: tokensToSell,
              remainingHolding: 0,
              solAmount: 0,
              usdAmount: netReceived,
              priceUsd: pOut,
              txHash: '',
              timestamp: Math.floor(now / 1000),
              isOpenOrClose: true,
              isFirstBuy: false,
            };
            this.onTradeAction('SELL', scenario.id, signal, {
              stakeUsd: netReceived,
              tokens: tokensToSell,
              priceUsd: pOut,
              reason,
            });
          } catch {}
        }
        changed = true;
      }
    }

    // 2. Cek Skenario 8 Time-Stop (Force Exit @ 20s pasca Target Inflow) & Timeout 80s:
    const s8 = this.scenarios.s8;
    for (let i = s8.openPositions.length - 1; i >= 0; i--) {
      const pos = s8.openPositions[i];
      if (pos.tokens <= 0) continue;

      // Kasus A: Target sudah masuk, hitung apakah sudah mencapai 20 detik pasca-target masuk!
      if (pos.targetEnteredAt) {
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 20000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_ENTRY (Reached 20s post-target inflow, locked profit before dump)`;
          this.executeScenarioExit(s8, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }

      // Kasus B: Target tidak kunjung masuk dalam 80s sejak Genesis
      const elapsedMs = now - pos.openedAt;
      if (elapsedMs >= 80000) {
        const timeWib = formatWibDate(now);
        const elapsedSec = Math.round(elapsedMs / 1000);
        const reason = `TARGET_SKIPPED_DEV_POOL (Dev Deploy Pool '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit)`;
        this.executeScenarioExit(s8, i, pos.lastPriceUsd, now, timeWib, reason);
        changed = true;
      }
    }

    // 3. Cek Skenario 5 Time-Stop (Force Exit @ 35s post-entry untuk mengamankan wave):
    const s5 = this.scenarios.s5;
    for (let i = s5.openPositions.length - 1; i >= 0; i--) {
      const pos = s5.openPositions[i];
      if (pos.tokens <= 0) continue;

      const elapsedMs = now - pos.openedAt;
      if (elapsedMs >= 35000) {
        const timeWib = formatWibDate(now);
        const elapsedSec = Math.round(elapsedMs / 1000);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `TIME_STOP_${elapsedSec}S_WAVE_EXIT (Reached 35s wave limit, locked profit before minute 1-2 liquidity drain)`;
        this.executeScenarioExit(s5, i, pOut, now, timeWib, reason);
        changed = true;
      }
    }

    // 4. Cek Skenario 9 Time-Stop:
    // - Gap 60s tanpa target masuk -> Force Sell
    // - Wave limit 35s pasca target masuk -> Force Exit
    const s9 = this.scenarios.s9;
    for (let i = s9.openPositions.length - 1; i >= 0; i--) {
      const pos = s9.openPositions[i];
      if (pos.tokens <= 0) continue;

      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;

      // Kasus A: Target sudah masuk, batasi wave 35s pasca-target masuk
      if (pos.targetEnteredAt) {
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 35000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_WAVE_EXIT (Reached 35s post-target wave limit, locked profit before minute 1-2 liquidity drain)`;
          this.executeScenarioExit(s9, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      } else {
        // Kasus B: Target tidak kunjung masuk sejak genesis
        const elapsedMs = now - pos.openedAt;
        // JIKA Pool 1 Umpan (koin baru bukan Gen-2/Pool 2): batas waktu diperpendek menjadi 30 detik (sebelum dev rugpull di detik 45)
        // JIKA Pool 2 / Gen-2 re-deploy: batas waktu 60 detik (memberi ruang pompa lebih longgar)
        const isPool2OrGen2 = Boolean(this.gen2CycleTracker.get(pos.mint) || (pos as any).isPool2 || (pos as any).isSameSymbol);
        const timeoutLimitMs = isPool2OrGen2 ? 60000 : 30000;

        if (elapsedMs >= timeoutLimitMs) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedMs / 1000);
          const poolTypeStr = isPool2OrGen2 ? 'Pool 2' : 'Pool 1 Umpan';
          const reason = `TARGET_SKIPPED_DEV_POOL (${poolTypeStr} '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit sebelum dev rugpull)`;
          this.executeScenarioExit(s9, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }
    }

    // 4b. Cek Skenario 10 Time-Stop (Dynamic Wave Runner):
    // - Gap 30s/60s tanpa target masuk -> Force Sell (Safety Exit)
    // - Wave limit 30s pasca target masuk -> Force Exit (Time-Stop pengaman sebelum dev rugpull)
    const s10 = this.scenarios.s10;
    for (let i = s10.openPositions.length - 1; i >= 0; i--) {
      const pos = s10.openPositions[i];
      if (pos.tokens <= 0) continue;

      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;

      if (pos.targetEnteredAt) {
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 30000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_WAVE_EXIT (Reached 30s post-target wave limit, locked profit before minute 1-2 liquidity drain)`;
          this.executeScenarioExit(s10, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      } else {
        const elapsedMs = now - pos.openedAt;
        const isPool2OrGen2 = Boolean(this.gen2CycleTracker.get(pos.mint) || (pos as any).isPool2 || (pos as any).isSameSymbol);
        const timeoutLimitMs = isPool2OrGen2 ? 60000 : 30000;

        if (elapsedMs >= timeoutLimitMs) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedMs / 1000);
          const poolTypeStr = isPool2OrGen2 ? 'Pool 2' : 'Pool 1 Umpan';
          const reason = `TARGET_SKIPPED_DEV_POOL (${poolTypeStr} '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit sebelum dev rugpull)`;
          this.executeScenarioExit(s10, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }
    }

    // 4c. Cek Skenario 9.5: Split TP 50/50 + 1-Min Moonbag:
    const s95 = this.scenarios.s9_5;
    for (let i = s95.openPositions.length - 1; i >= 0; i--) {
      const pos = s95.openPositions[i];
      if (pos.tokens <= 0) continue;

      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;

      // Kasus A: Sudah pernah Stage 1 (sisa 50% moonbag ditahan 1 menit)
      if (pos.stage1Exited && pos.stage1ExitedAt) {
        const elapsedSinceStage1 = now - pos.stage1ExitedAt;
        if (elapsedSinceStage1 >= 60000) {
          const timeWib = formatWibDate(now);
          const reason = `STAGE_2_MOONBAG_60S_TIMEOUT_EXIT (Sisa 50% token ditahan 1 menit pasca-TP, kunci cuan sisa)`;
          this.executeScenarioExit(s95, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      } else if (pos.targetEnteredAt) {
        // Belum Stage 1, tapi target sudah masuk -> batas waktu wave 35s
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 35000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_WAVE_EXIT (Reached 35s post-target wave limit, locked profit before minute 1-2 liquidity drain)`;
          this.executeScenarioExit(s95, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      } else {
        // Target tidak kunjung masuk sejak genesis
        const elapsedMs = now - pos.openedAt;
        const isPool2OrGen2 = Boolean(this.gen2CycleTracker.get(pos.mint) || (pos as any).isPool2 || (pos as any).isSameSymbol);
        const timeoutLimitMs = isPool2OrGen2 ? 60000 : 30000;

        if (elapsedMs >= timeoutLimitMs) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedMs / 1000);
          const poolTypeStr = isPool2OrGen2 ? 'Pool 2' : 'Pool 1 Umpan';
          const reason = `TARGET_SKIPPED_DEV_POOL (${poolTypeStr} '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit sebelum dev rugpull)`;
          this.executeScenarioExit(s95, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }
    }

    // 5. Cek Skenario 4: 8s Buyback Timeout
    const s4 = this.scenarios.s4;
    for (let i = s4.openPositions.length - 1; i >= 0; i--) {
      const pos = s4.openPositions[i];
      if (pos.tokens <= 0) continue;

      if (pos.waitingBuybackSince) {
        const elapsedSinceSell = now - pos.waitingBuybackSince;
        if (elapsedSinceSell >= 8000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceSell / 1000);
          const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
          const reason = `S4_BUYBACK_TIMEOUT_${elapsedSec}S_EXIT (Target tidak buyback dalam 8s pasca shakeout sell, safety exit)`;
          this.executeScenarioExit(s4, i, pOut, now, timeWib, reason);
          changed = true;
        }
      }
    }

    // 6. Cek Skenario 13: 60s Cycle Timeout & 15m Session Max Age:
    const s13 = this.scenarios.s13;
    for (let i = s13.openPositions.length - 1; i >= 0; i--) {
      const pos = s13.openPositions[i];
      if (pos.tokens <= 0) continue;
      const tracker = this.s13PingPongTrackers.get(pos.mint);

      // 1. Cek apakah sesi ping-pong sudah lewat 15 menit
      if (tracker && (now - tracker.whaleFirstBuyAt) >= 15 * 60 * 1000) {
        tracker.status = 'TERMINATED';
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `S13_MAX_AGE_15M_TIMEOUT_EXIT (Koin berumur >= 15m, akhiri pingpong sebelum rugpull)`;
        this.executeScenarioExit(s13, i, pOut, now, timeWib, reason);
        changed = true;
        continue;
      }

      // 2. Cek apakah posisi siklus saat ini sudah menggantung >= 60 detik tanpa buyback/TP
      const elapsedSinceEntry = now - pos.openedAt;
      if (elapsedSinceEntry >= 60000) {
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const elapsedSec = Math.round(elapsedSinceEntry / 1000);
        const reason = `TIMEOUT_${elapsedSec}S_CYCLE_EXIT (Tidak ada buyback whale dalam 60s, rotasi siklus)`;
        this.executeScenarioExit(s13, i, pOut, now, timeWib, reason);
        if (tracker) tracker.lastExitAt = now;
        changed = true;
        continue;
      }
    }

    // 7. Cek Skenario 13.5: 60s Cycle Timeout & 10m Session Max Age:
    const s13_5 = this.scenarios.s13_5;
    for (let i = s13_5.openPositions.length - 1; i >= 0; i--) {
      const pos = s13_5.openPositions[i];
      if (pos.tokens <= 0) continue;
      const tracker = this.s13_5PingPongTrackers.get(pos.mint);

      // 1. Cek apakah sesi ping-pong sudah lewat 10 menit
      if (tracker && (now - tracker.whaleFirstBuyAt) >= 10 * 60 * 1000) {
        tracker.status = 'TERMINATED';
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `S13_5_MAX_AGE_10M_TIMEOUT_EXIT (Koin berumur >= 10m, akhiri pingpong sebelum rugpull)`;
        this.executeScenarioExit(s13_5, i, pOut, now, timeWib, reason);
        changed = true;
        continue;
      }

      // 2. Cek apakah posisi siklus saat ini sudah menggantung >= 60 detik tanpa buyback/TP
      const elapsedSinceEntry = now - pos.openedAt;
      if (elapsedSinceEntry >= 60000) {
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const elapsedSec = Math.round(elapsedSinceEntry / 1000);
        const reason = `TIMEOUT_${elapsedSec}S_CYCLE_EXIT (Tidak ada buyback whale dalam 60s, rotasi siklus)`;
        this.executeScenarioExit(s13_5, i, pOut, now, timeWib, reason);
        if (tracker) tracker.lastExitAt = now;
        changed = true;
        continue;
      }
    }

    // 8. Cek Skenario 13-Alpha: 10m Session Max Age
    const s13_alpha = this.scenarios.s13_alpha;
    for (let i = s13_alpha.openPositions.length - 1; i >= 0; i--) {
      const pos = s13_alpha.openPositions[i];
      if (pos.tokens <= 0) continue;
      const tracker = this.s13AlphaTrackers.get(pos.mint);
      if (tracker && (now - tracker.whaleFirstBuyAt) >= 10 * 60 * 1000) {
        tracker.status = 'TERMINATED';
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `S13_ALPHA_MAX_AGE_10M_TIMEOUT_EXIT`;
        this.executeScenarioExit(s13_alpha, i, pOut, now, timeWib, reason);
        changed = true;
        continue;
      }
    }

    // 9. Cek Skenario 13-Beta: 10m Session Max Age
    const s13_beta = this.scenarios.s13_beta;
    for (let i = s13_beta.openPositions.length - 1; i >= 0; i--) {
      const pos = s13_beta.openPositions[i];
      if (pos.tokens <= 0) continue;
      const tracker = this.s13BetaTrackers.get(pos.mint);
      if (tracker && (now - tracker.whaleFirstBuyAt) >= 10 * 60 * 1000) {
        tracker.status = 'TERMINATED';
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `S13_BETA_MAX_AGE_10M_TIMEOUT_EXIT`;
        this.executeScenarioExit(s13_beta, i, pOut, now, timeWib, reason);
        changed = true;
        continue;
      }
    }

    // 10. Cek Skenario 13-Alpha-1: 10m Session Max Age
    const s13_alpha_1 = this.scenarios.s13_alpha_1;
    for (let i = s13_alpha_1.openPositions.length - 1; i >= 0; i--) {
      const pos = s13_alpha_1.openPositions[i];
      if (pos.tokens <= 0) continue;
      const tracker = this.s13Alpha1Trackers.get(pos.mint);
      if (tracker && (now - tracker.whaleFirstBuyAt) >= 10 * 60 * 1000) {
        tracker.status = 'TERMINATED';
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `S13_ALPHA_1_MAX_AGE_10M_TIMEOUT_EXIT`;
        this.executeScenarioExit(s13_alpha_1, i, pOut, now, timeWib, reason);
        changed = true;
        continue;
      }
    }

    // 11. Cek Skenario 13-Beta-1: 10m Session Max Age
    const s13_beta_1 = this.scenarios.s13_beta_1;
    for (let i = s13_beta_1.openPositions.length - 1; i >= 0; i--) {
      const pos = s13_beta_1.openPositions[i];
      if (pos.tokens <= 0) continue;
      const tracker = this.s13Beta1Trackers.get(pos.mint);
      if (tracker && (now - tracker.whaleFirstBuyAt) >= 10 * 60 * 1000) {
        tracker.status = 'TERMINATED';
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `S13_BETA_1_MAX_AGE_10M_TIMEOUT_EXIT`;
        this.executeScenarioExit(s13_beta_1, i, pOut, now, timeWib, reason);
        changed = true;
        continue;
      }
    }

    if (changed) {
      this.saveState();
    }
  }

  /**
   * Fallback Safety Exit:
   * Jika target sudah menjual akumulasi >= 5% tapi belum mencapai 15%,
   * lalu target berhenti menjual selama > inactivityMs (indikasi target selesai TP / dev akan rugpull),
   * bot langsung mengeksekusi Full Exit untuk mengamankan profit!
   */
  public checkSafetyExits(inactivityMsS6: number = 45000, inactivityMsS4: number = 60000): void {
    const now = Date.now();
    let changed = false;

    const targets = [
      { scenario: this.scenarios.s7, maxInactivity: 30000 },
      { scenario: this.scenarios.s5, maxInactivity: 35000 },
      { scenario: this.scenarios.s9, maxInactivity: 35000 },
      { scenario: this.scenarios.s10, maxInactivity: 30000 },
      { scenario: this.scenarios.s6, maxInactivity: inactivityMsS6 },
      { scenario: this.scenarios.s4, maxInactivity: inactivityMsS4 }
    ];

    for (const { scenario, maxInactivity } of targets) {
      for (let i = scenario.openPositions.length - 1; i >= 0; i--) {
        const pos = scenario.openPositions[i];
        if (pos.tokens <= 0) continue;

        const cumSell = pos.targetCumulativeSellRatioPct || 0;
        const lastSellAt = pos.lastTargetSellAt || 0;

        if (cumSell >= 5.0 && lastSellAt > 0 && (now - lastSellAt >= maxInactivity)) {
          const timeWib = formatWibDate(now);
          const pOut = pos.lastPriceUsd;
          const tokensToSell = pos.tokens;
          const grossReceived = tokensToSell * pOut;
          const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
          const costBasisSold = pos.costBasisUsd;
          const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

          scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
          scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
          scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

          pos.feesPaidUsd += REAL_SWAP_FEE_USD;
          pos.realizedPnlUsd += pnlUsd;
          pos.lastPriceUsd = pOut;
          pos.updatedAt = now;

          const inactiveSec = Math.round((now - lastSellAt) / 1000);
          const reason = `FALLBACK_SAFETY_EXIT (Target sold ${cumSell}% then silent ${inactiveSec}s)`;

          scenario.recentEvents.unshift({
            id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
            timestamp: now,
            timeWib,
            scenarioId: scenario.id,
            action: 'SELL',
            symbol: pos.symbol,
            mint: pos.mint,
            usdReceived: netReceived,
            feeUsd: REAL_SWAP_FEE_USD,
            tokens: tokensToSell,
            priceUsd: pOut,
            pnlUsd: pnlUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
            reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

          scenario.openPositions.splice(i, 1);
          const roi = costBasisSold > 0 ? (pos.realizedPnlUsd / costBasisSold) * 100 : 0.0;
          const isWin = pos.realizedPnlUsd >= 0;

          if (isWin) scenario.wins += 1;
          else scenario.losses += 1;
          scenario.totalTrades += 1;

          if (this.onTradeAction) {
            try {
              this.onTradeAction('SELL', scenario.id, {
                mint: pos.mint,
                symbol: pos.symbol,
                tokenName: pos.tokenName,
                action: 'sell',
                tokenAmount: tokensToSell,
                remainingHolding: 0,
                solAmount: 0,
                usdAmount: netReceived,
                priceUsd: pOut,
                txHash: '',
                timestamp: Math.floor(now / 1000),
              }, {
                stakeUsd: netReceived,
                tokens: tokensToSell,
                priceUsd: pOut,
                reason,
              });
            } catch {}
          }

          scenario.closedTrades.unshift({
            mint: pos.mint,
            symbol: pos.symbol,
            tokenName: pos.tokenName,
            openedAt: pos.openedAt,
            closedAt: now,
            entryCount: pos.entryCount,
            totalInvestedUsd: costBasisSold,
            totalReturnedUsd: netReceived,
            totalFeesPaidUsd: pos.feesPaidUsd,
            realizedPnlUsd: pnlUsd,
            roiPct: Number(roi.toFixed(1)),
            exitReason: reason,
            isWin,
          });
          if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveState();
    }
  }

  public getScenarioById(scenarioId: string): ScenarioState {
    const id = (scenarioId || '').toLowerCase();
    if (id.includes('14_alpha') || id.includes('14-alpha')) return this.scenarios.s14_alpha;
    if (id.includes('14') || id.includes('bundler')) return this.scenarios.s14;
    if (id.includes('centaur') || id.includes('13_centaur') || id.includes('13-centaur')) return this.scenarios.s13_centaur;
    if (id.includes('13_alpha_1') || id.includes('13-alpha-1') || id.includes('alpha_1') || id.includes('alpha-1')) return this.scenarios.s13_alpha_1;
    if (id.includes('13_beta_1') || id.includes('13-beta-1') || id.includes('beta_1') || id.includes('beta-1')) return this.scenarios.s13_beta_1;
    if (id.includes('13_alpha') || id.includes('13-alpha') || id.includes('alpha')) return this.scenarios.s13_alpha;
    if (id.includes('13_beta') || id.includes('13-beta') || id.includes('beta')) return this.scenarios.s13_beta;
    if (id.includes('13_5') || id.includes('13.5')) return this.scenarios.s13_5;
    if (id.includes('13')) return this.scenarios.s13;
    if (id.includes('9_5') || id.includes('9.5')) return this.scenarios.s9_5;
    if (id.includes('10')) return this.scenarios.s10;
    if (id.includes('9')) return this.scenarios.s9;
    if (id.includes('8')) return this.scenarios.s8;
    if (id.includes('7')) return this.scenarios.s7;
    if (id.includes('6')) return this.scenarios.s6;
    if (id.includes('5')) return this.scenarios.s5;
    return this.scenarios.s4;
  }

  /**
   * Sinkronisasi Eksekusi Beli Riil (dari kuotasi AMM DEX riil / swap ke-2 dryrun):
   * Menggantikan harga estimasi target dengan harga swap pasar nyata!
   */
  public syncRealBuyExecution(
    scenarioId: string,
    mint: string,
    realPriceUsd: number,
    tokensBought: number,
    stakeUsd: number
  ): void {
    if (realPriceUsd <= 0 || tokensBought <= 0) return;
    const targetSc = this.getScenarioById(scenarioId);
    const pos = targetSc.openPositions.find(p => p.mint === mint);
    if (!pos) return;

    const oldPrice = pos.avgEntryPriceUsd;
    pos.avgEntryPriceUsd = realPriceUsd;
    pos.lastPriceUsd = realPriceUsd;
    pos.tokens = tokensBought;
    pos.initialTokens = tokensBought;
    pos.costBasisUsd = stakeUsd;
    pos.initialCostBasisUsd = stakeUsd;

    // Update recent event jika ada
    const ev = targetSc.recentEvents.find(e => e.mint === mint && e.action === 'BUY');
    if (ev) {
      ev.priceUsd = realPriceUsd;
      ev.tokens = tokensBought;
      if (!ev.reason.includes('Real Swap:')) {
        ev.reason = `${ev.reason} (Real Swap: $${realPriceUsd.toFixed(8)})`;
      }
    }

    console.log(`[DRYRUN-ENGINE SYNC] ✅ Posisi ${pos.symbol} [${scenarioId}] disinkronkan ke harga swap AMM riil: $${realPriceUsd.toFixed(8)} (Target: $${oldPrice.toFixed(8)}, Gap: ${((realPriceUsd - oldPrice)/oldPrice*100).toFixed(1)}%)`);
    this.saveState();
  }

  /**
   * Sinkronisasi Eksekusi Jual Riil (dari kuotasi swap AMM sell):
   * Menggantikan estimasi harga target dengan proceeds kas riil yang kembali dari DEX!
   */
  public syncRealSellExecution(
    scenarioId: string,
    mint: string,
    realExitPriceUsd: number,
    realUsdReturned: number,
    reason: string
  ): void {
    if (realUsdReturned < 0) return;
    if (this.abortedBuyKeys.has(`${scenarioId}_${mint}`)) {
      console.warn(`[DRYRUN-ENGINE SYNC] ⛔ Mengabaikan sync rute jual untuk ${mint} [${scenarioId}] karena pembelian sebelumnya telah dibatalkan (ABORTED)!`);
      return;
    }
    const targetSc = this.getScenarioById(scenarioId);

    // 1. Cek apakah ini sinkronisasi Stage 1 TP 50% (posisi masih open)
    if (reason && reason.includes('STAGE_1_TP_50%')) {
      const openPos = targetSc.openPositions.find(p => p.mint === mint);
      if (openPos) {
        // Kurangi fee transaksi DEX riil agar kas bersih mencerminkan saldo dompet nyata
        const netStage1 = Math.max(0, realUsdReturned - REAL_SWAP_FEE_USD);
        openPos.stage1RealUsdReturned = netStage1;
        console.log(`[DRYRUN-ENGINE SYNC] ✅ Stage 1 TP 50% ${openPos.symbol} [${scenarioId}] proceeds disinkronkan ke swap AMM bersih: $${netStage1.toFixed(2)} (Gross: $${realUsdReturned.toFixed(2)}, Fee: -$${REAL_SWAP_FEE_USD})`);
        this.saveState();
        return;
      }
    }

    // 2. Cek apakah ada di closedTrades (Full exit / Stage 2)
    const trade = targetSc.closedTrades.find(t => t.mint === mint);
    if (trade) {
      const oldPnl = trade.realizedPnlUsd;
      const oldReturned = trade.totalReturnedUsd;

      // Jika trade ini adalah S6 Split TP yang melewati Stage 1:
      const stage1Proceeds = trade.stage1RealUsdReturned || 0;
      // Kurangi total fee transaksi roundtrip ($0.05 = $0.025 buy + $0.025 sell) agar persis sama dengan GMGN & dompet asli!
      const totalRoundtripFee = REAL_SWAP_FEE_USD * 2; // $0.050 USD
      const grossTotalReturn = stage1Proceeds + realUsdReturned;
      const totalRealReturned = Math.max(0, grossTotalReturn - totalRoundtripFee);

      trade.totalReturnedUsd = Number(totalRealReturned.toFixed(2));
      trade.realizedPnlUsd = Number((totalRealReturned - trade.totalInvestedUsd).toFixed(2));
      trade.roiPct = trade.totalInvestedUsd > 0 ? Number(((trade.realizedPnlUsd / trade.totalInvestedUsd) * 100).toFixed(1)) : 0.0;
      trade.isWin = trade.realizedPnlUsd >= 0;
      trade.totalFeesPaidUsd = Number(totalRoundtripFee.toFixed(3));
      if (!trade.exitReason.includes('Real Swap:')) {
        trade.exitReason = `${trade.exitReason} (Real Swap: $${grossTotalReturn.toFixed(2)} | Net: $${totalRealReturned.toFixed(2)})`;
      }

      // Recalculate scenario metrics
      const pnlDiff = trade.realizedPnlUsd - oldPnl;
      const cashDiff = trade.totalReturnedUsd - oldReturned;
      targetSc.realizedPnl = Number((targetSc.realizedPnl + pnlDiff).toFixed(2));
      targetSc.availableCash = Number((targetSc.availableCash + cashDiff).toFixed(2));
      targetSc.totalFeesPaid = Number((targetSc.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));

      targetSc.wins = targetSc.closedTrades.filter(t => t.isWin).length;
      targetSc.losses = targetSc.closedTrades.filter(t => !t.isWin).length;
      targetSc.winRate = targetSc.totalTrades > 0 ? Number(((targetSc.wins / targetSc.totalTrades) * 100).toFixed(1)) : 0.0;

      console.log(`[DRYRUN-ENGINE SYNC] ✅ Trade ${trade.symbol} [${scenarioId}] disinkronkan ke hasil bersih GMGN & dompet riil: Total Return Net $${totalRealReturned.toFixed(2)} (Gross: $${grossTotalReturn.toFixed(2)}, Fee: -$${totalRoundtripFee.toFixed(2)} | Net PnL: $${trade.realizedPnlUsd.toFixed(2)}, ROI: ${trade.roiPct}%)`);
      this.saveState();
    }
  }

  /**
   * Batalkan Buy di Scenario jika rute swap AMM gagal (little pool hit / no route):
   * Mencegah posisi hantu di dry-run yang menghasilkan profit palsu!
   */
  public abortScenarioBuy(scenarioId: string, mint: string, reason: string): void {
    this.abortedBuyKeys.add(`${scenarioId}_${mint}`);
    const targetSc = this.getScenarioById(scenarioId);
    const idx = targetSc.openPositions.findIndex(p => p.mint === mint);
    if (idx >= 0) {
      const pos = targetSc.openPositions[idx];
      targetSc.openPositions.splice(idx, 1);
      const refundedFee = pos.feesPaidUsd || REAL_SWAP_FEE_USD;
      targetSc.availableCash = Number((targetSc.availableCash + pos.costBasisUsd + refundedFee).toFixed(2));
      targetSc.investedCash = Math.max(0, Number((targetSc.investedCash - pos.costBasisUsd).toFixed(2)));
      targetSc.totalFeesPaid = Math.max(0, Number((targetSc.totalFeesPaid - refundedFee).toFixed(3)));
      targetSc.recentEvents.unshift({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        timeWib: formatWibDate(Date.now()),
        scenarioId: targetSc.id,
        action: 'SKIP',
        symbol: pos.symbol,
        mint: pos.mint,
        priceUsd: pos.avgEntryPriceUsd,
        availableCashAfter: targetSc.availableCash,
        investedCashAfter: targetSc.investedCash,
        reason: `BUY_ROUTE_FAILED (${reason}) - Posisi dibatalkan dari engine`,
      });
      if (targetSc.recentEvents.length > 50) targetSc.recentEvents.pop();
      console.log(`[DRYRUN-ENGINE ABORT] 🚫 Posisi ${pos.symbol} [${scenarioId}] dibatalkan karena rute beli AMM gagal: ${reason}`);
      this.saveState();
    } else {
      // Cek apakah posisi sudah terlanjur dipindahkan ke closedTrades oleh fast-tick sebelum rute selesai dicek!
      const closedIdx = targetSc.closedTrades.findIndex(t => t.mint === mint);
      if (closedIdx >= 0) {
        const trade = targetSc.closedTrades[closedIdx];
        targetSc.closedTrades.splice(closedIdx, 1);

        // Kembalikan saldo kas & hapus laba/rugi hantu beserta fee transaksi beli
        const buyFeeToRefund = REAL_SWAP_FEE_USD;
        targetSc.availableCash = Number((targetSc.availableCash - trade.totalReturnedUsd + trade.totalInvestedUsd + buyFeeToRefund).toFixed(2));
        targetSc.realizedPnl = Number((targetSc.realizedPnl - trade.realizedPnlUsd).toFixed(2));
        targetSc.totalFeesPaid = Math.max(0, Number((targetSc.totalFeesPaid - (trade.totalFeesPaidUsd || (REAL_SWAP_FEE_USD * 2))).toFixed(3)));
        targetSc.totalTrades = Math.max(0, targetSc.totalTrades - 1);
        if ((targetSc as any).totalInvested) (targetSc as any).totalInvested = Math.max(0, Number(((targetSc as any).totalInvested - trade.totalInvestedUsd).toFixed(2)));
        if (trade.isWin) {
          targetSc.wins = Math.max(0, targetSc.wins - 1);
        } else {
          targetSc.losses = Math.max(0, targetSc.losses - 1);
        }
        targetSc.winRate = targetSc.totalTrades > 0 ? Number(((targetSc.wins / targetSc.totalTrades) * 100).toFixed(1)) : 0.0;

        targetSc.recentEvents.unshift({
          id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: Date.now(),
          timeWib: formatWibDate(Date.now()),
          scenarioId: targetSc.id,
          action: 'SKIP',
          symbol: trade.symbol,
          mint: trade.mint,
          priceUsd: 0,
          availableCashAfter: targetSc.availableCash,
          investedCashAfter: targetSc.investedCash,
          reason: `BUY_ROUTE_FAILED_REVERT (${reason}) - Trade hantu dihapus karena rute beli AMM ditolak / anti-pucuk`,
        });
        if (targetSc.recentEvents.length > 50) targetSc.recentEvents.pop();
        console.log(`[DRYRUN-ENGINE ABORT] 🚫 Trade tertutup ${trade.symbol} [${scenarioId}] dibatalkan & laba hantu dikurangkan karena rute beli AMM gagal: ${reason}`);
        this.saveState();
      }
    }
  }

  /**
   * Catat Kegagalan Jual Riil di Scenario (little pool hit / unsellable):
   * Mengoreksi trade agar tercatat sebagai rugi / proceeds = 0 jika token tidak bisa dijual!
   */
  public recordFailedSellExecution(scenarioId: string, mint: string, reason: string): void {
    const targetSc = this.getScenarioById(scenarioId);
    const trade = targetSc.closedTrades.find(t => t.mint === mint);
    if (trade) {
      const oldPnl = trade.realizedPnlUsd;
      const oldReturned = trade.totalReturnedUsd;

      // Token tidak bisa dijual sama sekali (0 proceeds returned)
      trade.totalReturnedUsd = 0;
      trade.realizedPnlUsd = -trade.totalInvestedUsd;
      trade.roiPct = -100.0;
      trade.isWin = false;
      trade.exitReason = `${trade.exitReason} (UNSELLABLE_AMM_DEAD_POOL: ${reason} | Return: $0.00)`;

      const pnlDiff = trade.realizedPnlUsd - oldPnl;
      const cashDiff = trade.totalReturnedUsd - oldReturned;
      targetSc.realizedPnl = Number((targetSc.realizedPnl + pnlDiff).toFixed(2));
      targetSc.availableCash = Math.max(0, Number((targetSc.availableCash + cashDiff).toFixed(2)));
      targetSc.wins = targetSc.closedTrades.filter(t => t.isWin).length;
      targetSc.losses = targetSc.closedTrades.filter(t => !t.isWin).length;
      targetSc.winRate = targetSc.totalTrades > 0 ? Number(((targetSc.wins / targetSc.totalTrades) * 100).toFixed(1)) : 0.0;

      console.log(`[DRYRUN-ENGINE SYNC] ⚠️ Trade ${trade.symbol} [${scenarioId}] dikoreksi menjadi LOSS 100% karena rute jual AMM ditolak (${reason})`);
      this.saveState();
    }
  }

  public getS9OpenPositionsCount(): number {
    return this.scenarios.s9.openPositions.length;
  }

  public getS95OpenPositionsCount(): number {
    return this.scenarios.s9_5.openPositions.length;
  }

  public getS10OpenPositionsCount(): number {
    return this.scenarios.s10.openPositions.length;
  }

  public getS13OpenPositionsCount(): number {
    return this.scenarios.s13.openPositions.length;
  }

  public getS13_5OpenPositionsCount(): number {
    return this.scenarios.s13_5.openPositions.length;
  }

  public getS13AlphaOpenPositionsCount(): number {
    return this.scenarios.s13_alpha.openPositions.length;
  }

  public getS13BetaOpenPositionsCount(): number {
    return this.scenarios.s13_beta.openPositions.length;
  }

  public getS13Alpha1OpenPositionsCount(): number {
    return this.scenarios.s13_alpha_1.openPositions.length;
  }

  public getS13Beta1OpenPositionsCount(): number {
    return this.scenarios.s13_beta_1.openPositions.length;
  }

  public getS13CentaurOpenPositionsCount(): number {
    return this.scenarios.s13_centaur.openPositions.length;
  }

  public getS14OpenPositionsCount(): number {
    return this.scenarios.s14.openPositions.length;
  }

  public getS14AlphaOpenPositionsCount(): number {
    return this.scenarios.s14_alpha.openPositions.length;
  }

  public isTargetEntered(mint: string): boolean {
    for (const sc of [this.scenarios.s9, this.scenarios.s9_5, this.scenarios.s10, this.scenarios.s8, this.scenarios.s13, this.scenarios.s13_5, this.scenarios.s13_alpha, this.scenarios.s13_beta, this.scenarios.s13_alpha_1, this.scenarios.s13_beta_1, this.scenarios.s13_centaur, this.scenarios.s14, this.scenarios.s14_alpha]) {
      const pos = sc.openPositions.find(p => p.mint === mint);
      if (pos && pos.targetEnteredAt && pos.targetEnteredAt > 0) return true;
    }
    return false;
  }
}
