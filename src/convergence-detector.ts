import { EventEmitter } from "node:events";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import {
  getBrowserBuySwapRoute,
  getBrowserSellSwapRoute,
  DEFAULT_SWAP_WALLET,
  type SwapRouteResult,
} from "./browser-swap-route.js";
import type { WalletTier } from "./snowball-collector.js";

export type { WalletTier };

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
  tier?: WalletTier;
  exitedAt?: string | null;
  exitedAtWib?: string | null;
  exitTimestamp?: number | null;
  holdingDurationSec?: number | null;
  holdingDurationStr?: string | null;
  isHolding?: boolean;
  profitUsd?: number | null;
  pnlPercent?: number | null;
  totalCostUsd?: number | null;
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

export interface WalletEntryDetail {
  wallet: string;
  tier?: WalletTier;
  enteredAt: string; // ISO 8601
  enteredAtWib: string; // Formatted WIB time (UTC+7)
  timestamp: number; // Unix timestamp in seconds
  deltaSecFromFirst: number; // Seconds since the first wallet entered
  solAmount?: number;
  tokenAmount?: number;
  txSignature?: string;
  exitedAt?: string | null;
  exitedAtWib?: string | null;
  exitTimestamp?: number | null;
  holdingDurationSec?: number | null;
  holdingDurationStr?: string | null;
  isHolding?: boolean;
  profitUsd?: number | null;
  pnlPercent?: number | null;
  totalCostUsd?: number | null;
}

export interface ConvergenceReport {
  id: string;
  mint: string;
  symbol: string;
  detectedAt: string;
  classification: ConvergenceClassification;
  wallets: string[];
  walletEntries?: WalletEntryDetail[];
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
  walletTiers?: Record<string, WalletTier> | Map<string, WalletTier>;
  outputFile?: string;
  maxMarketCapUsd?: number; // default: 100000 ($100k max for micro/lowcaps)
  maxPriceUsd?: number; // default: 0.50 (filters out tokenized stocks like TTWO $208)
}

export class ConvergenceDetector extends EventEmitter {
  private timeWindowSec: number;
  private cdpUrl: string;
  private monitoredWallets: Set<string> | null = null;
  private walletTiers = new Map<string, WalletTier>();
  private quarantinedWallets = new Set<string>();
  private tradesByMint = new Map<string, TradeEvent[]>();
  private evaluatedEvents = new Map<string, number>(); // mint -> timestamp evaluated
  private outputFile: string;
  private maxMarketCapUsd: number;
  private maxPriceUsd: number;

  // Browser CDP handle for GMGN
  private browser: Browser | null = null;
  private gmgnPage: Page | null = null;

  // Caching to eliminate redundant lookups across overlapping tokens
  private dexCache = new Map<string, { info: DexTokenInfo | null; exp: number }>();
  private candleCache = new Map<string, { candles: CandleKline[]; exp: number }>();

  // Injectable fetchers for testing / mock
  private customDexFetcher: ((mint: string) => Promise<DexTokenInfo | null>) | null = null;
  private customCandleFetcher: ((mint: string) => Promise<CandleKline[]>) | null = null;

  constructor(options: ConvergenceDetectorOptions = {}) {
    super();
    this.timeWindowSec = options.timeWindowSec ?? 1800;
    this.cdpUrl = options.cdpUrl ?? "http://127.0.0.1:9223";
    this.outputFile = options.outputFile ?? "data/convergence-monitor-events.json";
    this.maxMarketCapUsd = options.maxMarketCapUsd ?? 100_000;
    this.maxPriceUsd = options.maxPriceUsd ?? 0.50;

    if (options.monitoredWallets && options.monitoredWallets.length > 0) {
      this.monitoredWallets = new Set(options.monitoredWallets);
    }
    if (options.walletTiers) {
      if (options.walletTiers instanceof Map) {
        for (const [addr, tier] of options.walletTiers.entries()) {
          this.walletTiers.set(addr, tier);
        }
      } else {
        for (const [addr, tier] of Object.entries(options.walletTiers)) {
          this.walletTiers.set(addr, tier);
        }
      }
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

  public setWalletTier(address: string, tier: WalletTier): void {
    this.walletTiers.set(address, tier);
  }

  public getWalletTier(address: string): WalletTier {
    return this.walletTiers.get(address) || (this.monitoredWallets ? "D" : "A");
  }

  public addMonitoredWallet(address: string, tier?: WalletTier): void {
    if (!this.monitoredWallets) {
      this.monitoredWallets = new Set();
    }
    this.monitoredWallets.add(address);
    if (tier) {
      this.walletTiers.set(address, tier);
    }
  }

  public addMonitoredWallets(wallets: { address: string; tier?: WalletTier }[] | string[]): void {
    for (const item of wallets) {
      if (typeof item === "string") {
        this.addMonitoredWallet(item);
      } else {
        this.addMonitoredWallet(item.address, item.tier);
      }
    }
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

    // Calculate Entry Details for each distinct wallet (chronological)
    const walletFirstBuyMap = new Map<string, TradeEvent>();
    for (const t of currentTrades) {
      const existing = walletFirstBuyMap.get(t.wallet);
      if (!existing || t.timestamp < existing.timestamp) {
        walletFirstBuyMap.set(t.wallet, t);
      } else if (existing && (t.profitUsd !== undefined || t.exitedAt !== undefined)) {
        if (t.profitUsd !== undefined) existing.profitUsd = t.profitUsd;
        if (t.pnlPercent !== undefined) existing.pnlPercent = t.pnlPercent;
        if (t.totalCostUsd !== undefined) existing.totalCostUsd = t.totalCostUsd;
        if (t.exitedAt !== undefined) existing.exitedAt = t.exitedAt;
        if (t.exitedAtWib !== undefined) existing.exitedAtWib = t.exitedAtWib;
        if (t.exitTimestamp !== undefined) existing.exitTimestamp = t.exitTimestamp;
        if (t.isHolding !== undefined) existing.isHolding = t.isHolding;
        if (t.holdingDurationSec !== undefined) existing.holdingDurationSec = t.holdingDurationSec;
        if (t.holdingDurationStr !== undefined) existing.holdingDurationStr = t.holdingDurationStr;
      }
    }

    const sortedTrades = Array.from(walletFirstBuyMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    const firstTimestamp = sortedTrades[0].timestamp;
    const lastTimestamp = sortedTrades[sortedTrades.length - 1].timestamp;
    const entryDeltaSec = lastTimestamp - firstTimestamp;

    const walletEntries: WalletEntryDetail[] = sortedTrades.map((t) => {
      const date = new Date(t.timestamp * 1000);
      const wibStr = date.toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }) + " WIB";

      const tier: WalletTier = t.tier || this.walletTiers.get(t.wallet) || (this.monitoredWallets ? "D" : "A");

      return {
        wallet: t.wallet,
        tier,
        enteredAt: date.toISOString(),
        enteredAtWib: wibStr,
        timestamp: t.timestamp,
        deltaSecFromFirst: t.timestamp - firstTimestamp,
        solAmount: t.solAmount,
        tokenAmount: t.tokenAmount,
        txSignature: t.txSignature,
        exitedAt: t.exitedAt ?? null,
        exitedAtWib: t.exitedAtWib ?? (t.isHolding ? "HOLDING" : null),
        exitTimestamp: t.exitTimestamp ?? null,
        holdingDurationSec: t.holdingDurationSec ?? null,
        holdingDurationStr: t.holdingDurationStr ?? null,
        isHolding: t.isHolding ?? (t.exitedAt ? false : true),
        profitUsd: t.profitUsd ?? null,
        pnlPercent: t.pnlPercent ?? null,
        totalCostUsd: t.totalCostUsd ?? null
      };
    });

    // Fetch DexScreener liquidity & volume
    const dexInfo = await this.fetchDexInfo(trade.mint);

    // Hard Gate: Filter out large tokens / tokenized stocks (> $100k MC or price > $0.50)
    if (dexInfo) {
      const effectiveCap = dexInfo.fdv > 0 ? dexInfo.fdv : (dexInfo.liquidityUsd * 2);
      if (effectiveCap > this.maxMarketCapUsd || dexInfo.priceUsd > this.maxPriceUsd) {
        // Ignored: Token is not in the lowcap <$100k target range
        return null;
      }
    }

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

    // Quality Tier Consensus check
    const tiers = walletEntries.map((w) => w.tier || (this.monitoredWallets ? "D" : "A"));
    const hasTierS = tiers.includes("S");
    const hasTierA = tiers.includes("A");
    const tierBCount = tiers.filter((t) => t === "B").length;
    // Convergence is valid if at least 1 Tier S or A, OR at least 2 Tier B wallets participate
    const isQualityConvergence = hasTierS || hasTierA || (tierBCount >= 2);
    const tierSummary = walletEntries.map((w) => `${w.wallet.slice(0, 4)}..[${w.tier || 'D'}]`).join(" + ");

    // Classification Decision
    let classification: ConvergenceClassification = "ACCUMULATION_WATCH";
    let reason = "";

    const isObviousDump = (liquidity > 0 && liquidity < 1000) || maxDropPercent > 50 || (dexInfo?.priceChange24h ?? 0) < -70;

    // Deteksi Cabal Insider: Pembelian awal terlalu raksasa (potensi dev/insider memegang >40% suplai untuk dump)
    const zeroSecSol = walletEntries
      .filter((w) => (w.deltaSecFromFirst || 0) === 0)
      .reduce((sum, w) => sum + (w.solAmount || 0), 0);
    const isCabalSupplyRisk = zeroSecSol > 20.0 || (walletEntries[0]?.solAmount || 0) > 15.0;

    if (isCabalSupplyRisk || (entryDeltaSec <= 30 && (isObviousDump || (!isQualityConvergence && isLiquidityDrained)))) {
      classification = "SYNDICATE_DUMP_RISK";
      reason = isCabalSupplyRisk
        ? `Cabal supply risk: Pembelian awal detik 0 mencapai ${zeroSecSol.toFixed(1)} SOL (> 20 SOL batas aman), dominasi insider siap dump`
        : `Delta entry sangat rapat (${entryDeltaSec}s) dengan indikasi dump likuiditas ($${liquidity.toFixed(0)}) dan drop -${maxDropPercent.toFixed(1)}%`;
      for (const w of uniqueWallets) {
        this.quarantinedWallets.add(w);
      }
    } else if (isQualityConvergence) {
      // Aturan delta 45s dihilangkan untuk Tier S, A, B:
      // Delta berapapun (termasuk <= 30s) diizinkan selama bukan dump dan drop tidak parah
      if ((liquidity >= 2000 || !dexInfo) && maxDropPercent < 45 && (dexInfo?.priceChange24h ?? 0) >= -60) {
        classification = "GOLDEN_ORGANIC_CONVERGENCE";
        reason = `Konsensus Tier Mutu S/A/B (${tierSummary}) lowcap (<$100k): ${uniqueWallets.length} smart wallet terdeteksi (Delta: ${entryDeltaSec}s). Aturan delta 45s di-bypass untuk Tier S/A/B. Likuiditas: $${liquidity.toLocaleString()}`;
      } else {
        classification = "ACCUMULATION_WATCH";
        reason = `Tier Mutu S/A/B (${tierSummary}) terdeteksi namun likuiditas belum cukup ($${liquidity.toFixed(0)}) atau drop > 45%`;
      }
    } else if (entryDeltaSec >= 45 && !isQualityConvergence) {
      classification = "ACCUMULATION_WATCH";
      reason = `Akumulasi terpantau dari trader retail/scout (${tierSummary}). Menunggu konfirmasi smart money Tier S/A/B sebelum eksekusi.`;
    } else {
      classification = "ACCUMULATION_WATCH";
      reason = `Lowcap watch (${tierSummary}): ${uniqueWallets.length} wallet masuk bersamaan dalam ${Math.round(entryDeltaSec / 60)} menit. Likuiditas: $${liquidity.toLocaleString()}`;
    }

    const report: ConvergenceReport = {
      id: `conv_${trade.mint.slice(0, 8)}_${nowSec}`,
      mint: trade.mint,
      symbol: trade.symbol || dexInfo?.symbol || "UNKNOWN",
      detectedAt: new Date(nowSec * 1000).toISOString(),
      classification,
      wallets: sortedTrades.map((t) => t.wallet),
      walletEntries,
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

  public async fetchDexInfo(mint: string): Promise<DexTokenInfo | null> {
    if (this.customDexFetcher) {
      return await this.customDexFetcher(mint);
    }
    const now = Date.now();
    const cached = this.dexCache.get(mint);
    if (cached && cached.exp > now) {
      return cached.info;
    }
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data: any = await res.json();
      const pair = data.pairs?.[0];
      if (!pair) {
        this.dexCache.set(mint, { info: null, exp: now + 60_000 });
        return null;
      }
      const info: DexTokenInfo = {
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
      this.dexCache.set(mint, { info, exp: now + 60_000 });
      return info;
    } catch {
      this.dexCache.set(mint, { info: null, exp: now + 20_000 });
      return null;
    }
  }

  public async fetchCandles(mint: string): Promise<CandleKline[]> {
    if (this.customCandleFetcher) {
      return await this.customCandleFetcher(mint);
    }
    const now = Date.now();
    const cached = this.candleCache.get(mint);
    if (cached && cached.exp > now) {
      return cached.candles;
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

      if (!Array.isArray(raw)) {
        this.candleCache.set(mint, { candles: [], exp: now + 60_000 });
        return [];
      }
      const parsed: CandleKline[] = raw.map((c: any) => ({
        time: Number(c.time) || 0,
        open: Number(c.open) || 0,
        high: Number(c.high) || 0,
        low: Number(c.low) || 0,
        close: Number(c.close) || 0,
        volume: Number(c.volume) || 0
      }));
      this.candleCache.set(mint, { candles: parsed, exp: now + 60_000 });
      return parsed;
    } catch {
      this.candleCache.set(mint, { candles: [], exp: now + 20_000 });
      return [];
    }
  }

  /**
   * Panggil API GMGN Swap Route (/txproxy/v1/get_swap_route) via CDP untuk mendapatkan harga real executable
   */
  public async fetchRealSwapRoute(
    mint: string,
    side: "buy" | "sell" = "buy",
    stakeUsd: number = 5.0,
    inputTokenUnits?: string
  ): Promise<SwapRouteResult | null> {
    try {
      const page = await this.getGmgnPage();
      if (!page) return null;
      if (side === "buy") {
        return await getBrowserBuySwapRoute(page, mint, DEFAULT_SWAP_WALLET, stakeUsd);
      } else {
        const units = inputTokenUnits || "1000000000";
        return await getBrowserSellSwapRoute(page, mint, DEFAULT_SWAP_WALLET, units);
      }
    } catch {
      return null;
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
      // Deduplicate: replace if same mint and same classification within last 1 hour
      const existingIdx = events.findIndex(
        (e) => e.mint === report.mint && e.classification === report.classification
      );
      if (existingIdx !== -1) {
        events[existingIdx] = report;
      } else {
        events.push(report);
      }
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
