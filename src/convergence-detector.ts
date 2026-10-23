import { EventEmitter } from "node:events";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

export interface TradeEvent {
  wallet: string;
  mint: string;
  symbol?: string;
  side: "buy" | "sell";
  timestamp: number; // Unix timestamp in seconds
  solAmount?: number;
  tokenAmount?: number;
  priceUsd?: number;
  txSignature?: string;
}

export interface DexTokenInfo {
  mint: string;
  symbol: string;
  name: string;
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
  fdv: number;
  volume24h: number;
  priceChange24h: number;
}

export interface CandleKline {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ConvergenceClassification =
  | "SYNDICATE_DUMP_RISK"
  | "GOLDEN_ORGANIC_CONVERGENCE"
  | "ACCUMULATION_WATCH";

export interface ConvergenceReport {
  id: string;
  mint: string;
  symbol: string;
  detectedAt: string;
  classification: ConvergenceClassification;
  wallets: string[];
  entryDeltaSec: number;
  isLiquidityDrained: boolean;
  maxDropPercent: number;
  dexInfo?: DexTokenInfo | null;
  candlesSummary?: {
    count: number;
    firstClose: number;
    lastClose: number;
    pctChange: number;
  };
  reason: string;
}

export interface ConvergenceDetectorOptions {
  timeWindowSec?: number; // default: 1800 (30 mins)
  cdpUrl?: string; // default: 'http://127.0.0.1:9223'
  monitoredWallets?: string[];
  outputFile?: string;
}

export class ConvergenceDetector extends EventEmitter {
  private timeWindowSec: number;
  private cdpUrl: string;
  private monitoredWallets: Set<string> | null = null;
  private quarantinedWallets = new Set<string>();
  private tradesByMint = new Map<string, TradeEvent[]>();
  private evaluatedEvents = new Map<string, number>(); // mint -> timestamp evaluated
  private outputFile: string;

  // Browser CDP handle for GMGN
  private browser: Browser | null = null;
  private gmgnPage: Page | null = null;

  // Injectable fetchers for testing / mock
  private customDexFetcher: ((mint: string) => Promise<DexTokenInfo | null>) | null = null;
  private customCandleFetcher: ((mint: string) => Promise<CandleKline[]>) | null = null;

  constructor(options: ConvergenceDetectorOptions = {}) {
    super();
    this.timeWindowSec = options.timeWindowSec ?? 1800;
    this.cdpUrl = options.cdpUrl ?? "http://127.0.0.1:9223";
    this.outputFile = options.outputFile ?? "data/convergence-monitor-events.json";

    if (options.monitoredWallets && options.monitoredWallets.length > 0) {
      this.monitoredWallets = new Set(options.monitoredWallets);
    }
  }

  public setDexFetcher(fn: (mint: string) => Promise<DexTokenInfo | null>): void {
    this.customDexFetcher = fn;
  }

  public setCandleFetcher(fn: (mint: string) => Promise<CandleKline[]>): void {
    this.customCandleFetcher = fn;
  }

  public isQuarantined(wallet: string): boolean {
    return this.quarantinedWallets.has(wallet);
  }

  public getQuarantinedWallets(): string[] {
    return Array.from(this.quarantinedWallets);
  }

  public getActiveMintsCount(): number {
    this.evictExpired(Math.floor(Date.now() / 1000));
    return this.tradesByMint.size;
  }

  private evictExpired(nowSec: number): void {
    const cutoff = nowSec - this.timeWindowSec;
    for (const [mint, trades] of this.tradesByMint.entries()) {
      const active = trades.filter((t) => t.timestamp >= cutoff);
      if (active.length === 0) {
        this.tradesByMint.delete(mint);
      } else {
        this.tradesByMint.set(mint, active);
      }
    }
  }

  public async recordTrade(trade: TradeEvent): Promise<ConvergenceReport | null> {
    if (this.monitoredWallets && !this.monitoredWallets.has(trade.wallet)) {
      return null; // Not in monitored list
    }

    if (this.quarantinedWallets.has(trade.wallet)) {
      return null; // Quarantined wallet ignored
    }

    const nowSec = trade.timestamp || Math.floor(Date.now() / 1000);
    this.evictExpired(nowSec);

    // Only process buys for convergence detection
    if (trade.side !== "buy") {
      return null;
    }

    if (!this.tradesByMint.has(trade.mint)) {
      this.tradesByMint.set(trade.mint, []);
    }
    const currentTrades = this.tradesByMint.get(trade.mint)!;
    currentTrades.push(trade);

    // Check unique wallets participating
    const uniqueWallets = Array.from(new Set(currentTrades.map((t) => t.wallet)));
    if (uniqueWallets.length < 2) {
      return null; // Only 1 wallet so far
    }

    // Cooldown check: evaluate at most once per 60 seconds per mint
    const lastEval = this.evaluatedEvents.get(trade.mint) || 0;
    if (nowSec - lastEval < 60) {
      return null;
    }
    this.evaluatedEvents.set(trade.mint, nowSec);

    // Calculate Entry Delta between distinct wallet initial buys
    const walletFirstBuy = new Map<string, number>();
    for (const t of currentTrades) {
      if (!walletFirstBuy.has(t.wallet) || t.timestamp < walletFirstBuy.get(t.wallet)!) {
        walletFirstBuy.set(t.wallet, t.timestamp);
      }
    }
    const buyTimes = Array.from(walletFirstBuy.values()).sort((a, b) => a - b);
    const entryDeltaSec = buyTimes[buyTimes.length - 1] - buyTimes[0];

    // Fetch DexScreener liquidity & volume
    const dexInfo = await this.fetchDexInfo(trade.mint);

    // Fetch GMGN 1m candle kline
    const candles = await this.fetchCandles(trade.mint);

    // Analyze Candle Drop
    let maxDropPercent = 0;
    let candlesSummary: ConvergenceReport["candlesSummary"];
    if (candles.length > 0) {
      const firstClose = candles[0].close || 0.0000001;
      const lastClose = candles[candles.length - 1].close || 0.0000001;
      const pctChange = ((lastClose - firstClose) / firstClose) * 100;
      
      let highestHigh = 0;
      let lowestAfterHigh = Infinity;
      for (const c of candles) {
        if (c.high > highestHigh) {
          highestHigh = c.high;
          lowestAfterHigh = c.low;
        } else if (c.low < lowestAfterHigh) {
          lowestAfterHigh = c.low;
        }
      }
      if (highestHigh > 0 && lowestAfterHigh < highestHigh) {
        maxDropPercent = ((highestHigh - lowestAfterHigh) / highestHigh) * 100;
      }

      candlesSummary = {
        count: candles.length,
        firstClose,
        lastClose,
        pctChange: Number(pctChange.toFixed(2))
      };
    }

    const liquidity = dexInfo?.liquidityUsd ?? 0;
    const isLiquidityDrained = liquidity < 5000;

    // Classification Decision
    let classification: ConvergenceClassification = "ACCUMULATION_WATCH";
    let reason = "";

    if (entryDeltaSec <= 30 && (isLiquidityDrained || maxDropPercent > 35 || (dexInfo?.priceChange24h ?? 0) < -40)) {
      classification = "SYNDICATE_DUMP_RISK";
      reason = `Delta entry sangat rapat (${entryDeltaSec}s) dengan indikasi dump likuiditas ($${liquidity.toFixed(0)}) dan drop -${maxDropPercent.toFixed(1)}%`;
      for (const w of uniqueWallets) {
        this.quarantinedWallets.add(w);
      }
    } else if (
      entryDeltaSec >= 180 &&
      liquidity >= 10000 &&
      (dexInfo?.volume24h ?? 0) >= 50000 &&
      maxDropPercent < 30
    ) {
      classification = "GOLDEN_ORGANIC_CONVERGENCE";
      reason = `Konsensus organik terverifikasi: ${uniqueWallets.length} wallet independen akumulasi dengan delta sehat (${Math.round(entryDeltaSec / 60)}m), likuiditas solid ($${liquidity.toLocaleString()})`;
    } else {
      classification = "ACCUMULATION_WATCH";
      reason = `${uniqueWallets.length} wallet masuk bersamaan dalam ${Math.round(entryDeltaSec / 60)} menit. Likuiditas: $${liquidity.toLocaleString()}`;
    }

    const report: ConvergenceReport = {
      id: `conv_${trade.mint.slice(0, 8)}_${nowSec}`,
      mint: trade.mint,
      symbol: trade.symbol || dexInfo?.symbol || "UNKNOWN",
      detectedAt: new Date(nowSec * 1000).toISOString(),
      classification,
      wallets: uniqueWallets,
      entryDeltaSec,
      isLiquidityDrained,
      maxDropPercent: Number(maxDropPercent.toFixed(1)),
      dexInfo,
      candlesSummary,
      reason
    };

    // Emit Events
    this.emit("convergence", report);
    if (classification === "SYNDICATE_DUMP_RISK") {
      this.emit("syndicate_detected", report);
    } else if (classification === "GOLDEN_ORGANIC_CONVERGENCE") {
      this.emit("golden_signal", report);
    }

    this.persistReport(report);
    return report;
  }

  private async fetchDexInfo(mint: string): Promise<DexTokenInfo | null> {
    if (this.customDexFetcher) {
      return await this.customDexFetcher(mint);
    }
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data: any = await res.json();
      const pair = data.pairs?.[0];
      if (!pair) return null;
      return {
        mint,
        symbol: pair.baseToken?.symbol || "UNKNOWN",
        name: pair.baseToken?.name || "UNKNOWN",
        dexId: pair.dexId || "UNKNOWN",
        priceUsd: Number(pair.priceUsd) || 0,
        liquidityUsd: Number(pair.liquidity?.usd) || 0,
        fdv: Number(pair.fdv) || 0,
        volume24h: Number(pair.volume?.h24) || 0,
        priceChange24h: Number(pair.priceChange?.h24) || 0
      };
    } catch {
      return null;
    }
  }

  private async fetchCandles(mint: string): Promise<CandleKline[]> {
    if (this.customCandleFetcher) {
      return await this.customCandleFetcher(mint);
    }

    try {
      const page = await this.getGmgnPage();
      if (!page) return [];

      const raw = await page.evaluate(async (tokenMint) => {
        try {
          const resp = await fetch(
            `/api/v1/token_mcap_candles/sol/${tokenMint}?resolution=1m&limit=30`,
            { credentials: "include", signal: AbortSignal.timeout(4000) }
          );
          if (!resp.ok) return [];
          const json = await resp.json();
          return json.data?.list || [];
        } catch {
          return [];
        }
      }, mint);

      if (!Array.isArray(raw)) return [];
      return raw.map((c: any) => ({
        time: Number(c.time) || 0,
        open: Number(c.open) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
        close: Number(c.close) || 0,
        volume: Number(c.volume) || 0
      }));
    } catch {
      return [];
    }
  }

  private async getGmgnPage(): Promise<Page | null> {
    if (this.gmgnPage && !this.gmgnPage.isClosed()) {
      return this.gmgnPage;
    }
    try {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
      const contexts = this.browser.contexts();
      const ctx = contexts[0] || (await this.browser.newContext());
      const pages = ctx.pages();
      this.gmgnPage = pages.find((p) => p.url().includes("gmgn.ai")) || pages[0] || null;
      return this.gmgnPage;
    } catch {
      return null;
    }
  }

  private persistReport(report: ConvergenceReport): void {
    try {
      let events: ConvergenceReport[] = [];
      if (existsSync(this.outputFile)) {
        try {
          events = JSON.parse(readFileSync(this.outputFile, "utf8"));
          if (!Array.isArray(events)) events = [];
        } catch {}
      }
      events.push(report);
      // Keep last 100 events
      if (events.length > 100) events = events.slice(-100);
      writeFileSync(this.outputFile, JSON.stringify(events, null, 2));
    } catch {}
  }

  public async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.gmgnPage = null;
    }
  }
}
