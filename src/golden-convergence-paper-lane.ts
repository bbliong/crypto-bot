import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type PaperLaneType = "LANE_GOLDEN_SCALP" | "LANE_GOLDEN_MOONBAG";

export type ExitReason =
  | "TAKE_PROFIT_35"
  | "TRAILING_STOP_7PCT"
  | "STOP_LOSS_12"
  | "TIMEOUT_30M"
  | "TP1_50_TP2_120_HIT"
  | "TP1_50_TRAILING_10"
  | "STOP_LOSS_15"
  | "TIMEOUT_60M"
  | "EMERGENCY_DUMP_GUARD"
  | "MANUAL_CLOSE";

export interface PaperPosition {
  id: string;
  lane: PaperLaneType;
  mint: string;
  symbol: string;
  stakeUsd: number;               // $100 USD per trade
  entryTimestamp: number;          // Epoch seconds
  entryTimeWib: string;            // HH.MM.SS WIB
  entryPriceUsd: number;
  entryMcapUsd: number;
  wallet1: {
    address: string;
    enteredAtWib: string;
  };
  wallet2: {
    address: string;
    enteredAtWib: string;
    deltaSecFromFirst: number;     // Seconds after wallet 1
  };
  status: "OPEN" | "CLOSED";
  
  // High-water mark tracking
  peakPriceUsd: number;
  peakGainPct: number;
  trailingActivated: boolean;
  
  // Moonbag specific state
  tp1Hit?: boolean;                // True if TP1 (+50%) sold 50%
  realizedFraction?: number;       // Tracks partial exits
  
  // Current / Live status (for OPEN positions)
  currentPriceUsd?: number;
  currentMcapUsd?: number;
  currentGainPct?: number;
  holdingSec?: number;
  holdingDurationStr?: string;
  
  // Exit details (for CLOSED positions)
  exitTimestamp?: number;
  exitTimeWib?: string;
  exitPriceUsd?: number;
  exitMcapUsd?: number;
  exitReason?: ExitReason;
  grossReturnPct?: number;
  netReturnPct?: number;           // grossReturnPct - 2% fee/slippage
  pnlUsd?: number;                 // stakeUsd * netReturnPct / 100
  isProfitable?: boolean;
}

export interface LaneStats {
  lane: PaperLaneType;
  name: string;
  description: string;
  winRateTag: string;
  totalTrades: number;
  openPositions: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  totalPnlUsd: number;
  grossProfitUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  avgDurationM: number;
  avgReturnPct: number;
}

export interface GoldenPaperStorePayload {
  updatedAt: string;
  stakePerTradeUsd: number;
  rules: {
    roundTripFeeRate: number;      // 2%
    scalp: {
      tpPct: number;               // +35%
      slPct: number;               // -12%
      trailingActivatePct: number; // +20%
      trailingDropPct: number;     // 7%
      maxDurationSec: number;      // 1800s (30m)
    };
    moonbag: {
      tp1Pct: number;              // +50% (sell 50%)
      tp2Pct: number;              // +120% (sell 50%)
      slPct: number;               // -15%
      trailingActivatePct: number; // +30%
      trailingDropPct: number;     // 10%
      maxDurationSec: number;      // 3600s (60m)
    };
  };
  lanes: Record<PaperLaneType, LaneStats>;
  positions: PaperPosition[];
}

export class GoldenConvergencePaperLane {
  private storePath: string;
  private positions: PaperPosition[] = [];
  private openByMintAndLane: Map<string, PaperPosition> = new Map();

  public stakePerTrade: number;
  public static readonly DEFAULT_STAKE = 5; // $5 USD per trade (low-capital mode)
  public static readonly FEE_RATE = 2.0; // 2% roundtrip

  constructor(options?: { storePath?: string; stakePerTradeUsd?: number }) {
    const root = process.cwd();
    this.storePath = options?.storePath || join(root, "data", "golden-paper-positions.json");
    this.stakePerTrade = options?.stakePerTradeUsd || GoldenConvergencePaperLane.DEFAULT_STAKE;
    this.loadState();
  }

  public loadState(): void {
    if (existsSync(this.storePath)) {
      try {
        const raw = readFileSync(this.storePath, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.positions)) {
          this.positions = data.positions;
          this.openByMintAndLane.clear();
          for (const pos of this.positions) {
            if (pos.status === "OPEN") {
              this.openByMintAndLane.set(`${pos.lane}_${pos.mint}`, pos);
            }
          }
        }
      } catch (err: any) {
        console.error(`[PAPER-LANE] Failed to read store: ${err.message}`);
      }
    }
  }

  public saveState(): void {
    const payload: GoldenPaperStorePayload = {
      updatedAt: new Date().toISOString(),
      stakePerTradeUsd: this.stakePerTrade,
      rules: {
        roundTripFeeRate: GoldenConvergencePaperLane.FEE_RATE,
        scalp: {
          tpPct: 35,
          slPct: -12,
          trailingActivatePct: 20,
          trailingDropPct: 7,
          maxDurationSec: 1800
        },
        moonbag: {
          tp1Pct: 50,
          tp2Pct: 120,
          slPct: -15,
          trailingActivatePct: 30,
          trailingDropPct: 10,
          maxDurationSec: 3600
        }
      },
      lanes: {
        LANE_GOLDEN_SCALP: this.computeLaneStats("LANE_GOLDEN_SCALP"),
        LANE_GOLDEN_MOONBAG: this.computeLaneStats("LANE_GOLDEN_MOONBAG")
      },
      positions: this.positions
    };

    try {
      writeFileSync(this.storePath, JSON.stringify(payload, null, 2));
    } catch (err: any) {
      console.error(`[PAPER-LANE] Failed to save store: ${err.message}`);
    }
  }

  /**
   * Open position when Wallet #2 enters
   */
  public openPosition(params: {
    lane: PaperLaneType;
    mint: string;
    symbol: string;
    entryPriceUsd: number;
    entryMcapUsd: number;
    entryTimestamp?: number;
    wallet1: { address: string; enteredAtWib: string };
    wallet2: { address: string; enteredAtWib: string; deltaSecFromFirst: number };
  }): PaperPosition | null {
    const key = `${params.lane}_${params.mint}`;
    if (this.openByMintAndLane.has(key)) {
      return null;
    }

    // Prevent duplicate entries for the same token/event across scans
    const alreadyTraded = this.positions.some(
      (p) => p.lane === params.lane && p.mint === params.mint && (
        p.status === "OPEN" ||
        p.entryTimestamp === (params.entryTimestamp || 0) ||
        Math.abs(p.entryTimestamp - (params.entryTimestamp || Math.floor(Date.now() / 1000))) < 3600
      )
    );
    if (alreadyTraded) {
      return null;
    }

    if (!params.entryPriceUsd || params.entryPriceUsd <= 0) {
      return null;
    }

    const nowSec = params.entryTimestamp || Math.floor(Date.now() / 1000);
    const entryDate = new Date(nowSec * 1000);
    const entryTimeWib = entryDate.toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }) + " WIB";

    const lanePrefix = params.lane === "LANE_GOLDEN_SCALP" ? "scalp" : "moon";
    const pos: PaperPosition = {
      id: `pos_${lanePrefix}_${params.mint.slice(0, 6)}_${nowSec}`,
      lane: params.lane,
      mint: params.mint,
      symbol: params.symbol || "UNKNOWN",
      stakeUsd: this.stakePerTrade,
      entryTimestamp: nowSec,
      entryTimeWib,
      entryPriceUsd: params.entryPriceUsd,
      entryMcapUsd: params.entryMcapUsd,
      wallet1: params.wallet1,
      wallet2: params.wallet2,
      status: "OPEN",
      peakPriceUsd: params.entryPriceUsd,
      peakGainPct: 0,
      trailingActivated: false,
      tp1Hit: false,
      realizedFraction: 0,
      currentPriceUsd: params.entryPriceUsd,
      currentMcapUsd: params.entryMcapUsd,
      currentGainPct: 0,
      holdingSec: 0,
      holdingDurationStr: "0s"
    };

    this.positions.unshift(pos);
    this.openByMintAndLane.set(key, pos);
    this.saveState();
    return pos;
  }

  /**
   * Evaluate open position against current price tick using the exact proven rules
   */
  public evaluatePriceTick(
    pos: PaperPosition,
    marketData: {
      priceUsd: number;
      mcapUsd?: number;
      timestamp?: number;
      highPriceUsd?: number;
      lowPriceUsd?: number;
      isLiquidityDrained?: boolean;
    }
  ): { closed: boolean; reason?: ExitReason } {
    if (pos.status !== "OPEN") return { closed: false };

    const tickTime = marketData.timestamp || Math.floor(Date.now() / 1000);
    const currentPrice = marketData.priceUsd;
    const highPrice = marketData.highPriceUsd || currentPrice;
    const lowPrice = marketData.lowPriceUsd || currentPrice;

    const holdingSec = Math.max(0, tickTime - pos.entryTimestamp);
    const m = Math.floor(holdingSec / 60);
    const s = holdingSec % 60;
    pos.holdingSec = holdingSec;
    pos.holdingDurationStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    pos.currentPriceUsd = currentPrice;
    pos.currentMcapUsd = marketData.mcapUsd || pos.currentMcapUsd;

    const curGain = (highPrice - pos.entryPriceUsd) / pos.entryPriceUsd;
    const curLoss = (lowPrice - pos.entryPriceUsd) / pos.entryPriceUsd;
    pos.currentGainPct = Number((((currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(2));

    if (highPrice > pos.peakPriceUsd) {
      pos.peakPriceUsd = highPrice;
      pos.peakGainPct = Number((curGain * 100).toFixed(2));
    }

    // ====================================================
    // STRATEGY A: SCALP BOT (+35% TP / -12% SL / Trailing 7% from +20% / Max 30m)
    // ====================================================
    if (pos.lane === "LANE_GOLDEN_SCALP") {
      // 1. Take Profit (+35%)
      if (curGain >= 0.35) {
        const exitPrice = pos.entryPriceUsd * 1.35;
        this.closePosition(pos, exitPrice, "TAKE_PROFIT_35", tickTime, pos.entryMcapUsd * 1.35, 1.35);
        return { closed: true, reason: "TAKE_PROFIT_35" };
      }

      // 2. Trailing Stop (activated if peak >= +20% and pulled back 7%)
      const pullbackFromPeak = (pos.peakPriceUsd - lowPrice) / pos.peakPriceUsd;
      if (pos.peakPriceUsd >= pos.entryPriceUsd * 1.20 && pullbackFromPeak >= 0.07) {
        const exitPrice = pos.peakPriceUsd * 0.93;
        const exitMult = exitPrice / pos.entryPriceUsd;
        this.closePosition(pos, exitPrice, "TRAILING_STOP_7PCT", tickTime, pos.entryMcapUsd * exitMult, exitMult);
        return { closed: true, reason: "TRAILING_STOP_7PCT" };
      }

      // 3. Stop Loss (-12%)
      if (curLoss <= -0.12) {
        const exitPrice = pos.entryPriceUsd * 0.88;
        this.closePosition(pos, exitPrice, "STOP_LOSS_12", tickTime, pos.entryMcapUsd * 0.88, 0.88);
        return { closed: true, reason: "STOP_LOSS_12" };
      }

      // 4. Timeout (30 minutes)
      if (holdingSec >= 1800) {
        // Anti-fake timeout protection: do not close if price data is stale (exact 0 diff)
        if (Math.abs(currentPrice - pos.entryPriceUsd) < 1e-12 && !marketData.highPriceUsd) {
          return { closed: false };
        }
        // If position is in profit and liquidity is healthy, allow runner to extend up to 60m
        if (currentPrice > pos.entryPriceUsd && !marketData.isLiquidityDrained && holdingSec < 3600) {
          // let winner run towards TP
        } else {
          const exitMult = currentPrice / pos.entryPriceUsd;
          this.closePosition(pos, currentPrice, "TIMEOUT_30M", tickTime, marketData.mcapUsd, exitMult);
          return { closed: true, reason: "TIMEOUT_30M" };
        }
      }
    }

    // ====================================================
    // STRATEGY B: MOONBAG RUNNER (+50% TP1, +120% TP2 / -15% SL / Trailing 10% from +30% / Max 60m)
    // ====================================================
    if (pos.lane === "LANE_GOLDEN_MOONBAG") {
      // TP1 (+50%): Sell 50%
      if (!pos.tp1Hit && curGain >= 0.50) {
        pos.tp1Hit = true;
        pos.realizedFraction = 0.5 * 1.50; // 50% locked at 1.5x
      }

      // TP2 (+120%): Sell remaining 50%
      if (curGain >= 1.20) {
        const exitFraction = (pos.realizedFraction || 0) + (pos.tp1Hit ? 0.5 * 2.20 : 2.20);
        this.closePosition(pos, pos.entryPriceUsd * 2.20, "TP1_50_TP2_120_HIT", tickTime, pos.entryMcapUsd * 2.20, exitFraction);
        return { closed: true, reason: "TP1_50_TP2_120_HIT" };
      }

      // Trailing Stop (activated if peak >= +30% and pulled back 10%)
      const pullbackFromPeak = (pos.peakPriceUsd - lowPrice) / pos.peakPriceUsd;
      if (pos.peakPriceUsd >= pos.entryPriceUsd * 1.30 && pullbackFromPeak >= 0.10) {
        const trailPrice = pos.peakPriceUsd * 0.90;
        const trailMult = trailPrice / pos.entryPriceUsd;
        const exitFraction = (pos.realizedFraction || 0) + (pos.tp1Hit ? 0.5 * trailMult : trailMult);
        this.closePosition(pos, trailPrice, "TP1_50_TRAILING_10", tickTime, pos.entryMcapUsd * trailMult, exitFraction);
        return { closed: true, reason: "TP1_50_TRAILING_10" };
      }

      // Stop Loss (-15%) before TP1
      if (!pos.tp1Hit && curLoss <= -0.15) {
        const exitPrice = pos.entryPriceUsd * 0.85;
        this.closePosition(pos, exitPrice, "STOP_LOSS_15", tickTime, pos.entryMcapUsd * 0.85, 0.85);
        return { closed: true, reason: "STOP_LOSS_15" };
      }

      // Timeout (60 minutes)
      if (holdingSec >= 3600) {
        // Anti-fake timeout protection: do not close if price data is stale (exact 0 diff)
        if (Math.abs(currentPrice - pos.entryPriceUsd) < 1e-12 && !marketData.highPriceUsd) {
          return { closed: false };
        }
        // If trade is in profit or TP1 already hit, allow runner to extend up to 120m
        if ((currentPrice > pos.entryPriceUsd || pos.tp1Hit) && !marketData.isLiquidityDrained && holdingSec < 7200) {
          // let moonbag runner run towards TP2
        } else {
          const closeMult = currentPrice / pos.entryPriceUsd;
          const exitFraction = (pos.realizedFraction || 0) + (pos.tp1Hit ? 0.5 * closeMult : closeMult);
          this.closePosition(pos, currentPrice, "TIMEOUT_60M", tickTime, marketData.mcapUsd, exitFraction);
          return { closed: true, reason: "TIMEOUT_60M" };
        }
      }
    }

    return { closed: false };
  }

  private closePosition(
    pos: PaperPosition,
    exitPrice: number,
    reason: ExitReason,
    exitTimestamp: number,
    exitMcapUsd?: number,
    realizedMultiplier?: number
  ): void {
    pos.status = "CLOSED";
    pos.exitPriceUsd = Number(exitPrice.toFixed(8));
    pos.exitTimestamp = exitTimestamp;
    const exitDate = new Date(exitTimestamp * 1000);
    pos.exitTimeWib = exitDate.toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }) + " WIB";
    pos.exitReason = reason;

    if (exitMcapUsd) {
      pos.exitMcapUsd = Math.round(exitMcapUsd);
    } else if (pos.entryMcapUsd > 0) {
      pos.exitMcapUsd = Math.round(pos.entryMcapUsd * (exitPrice / pos.entryPriceUsd));
    }

    const mult = realizedMultiplier !== undefined ? realizedMultiplier : (exitPrice / pos.entryPriceUsd);
    const grossReturnPct = Number(((mult - 1) * 100).toFixed(2));
    const netReturnPct = Number((grossReturnPct - GoldenConvergencePaperLane.FEE_RATE).toFixed(2));
    const pnlUsd = Number(((pos.stakeUsd * netReturnPct) / 100).toFixed(2));

    pos.grossReturnPct = grossReturnPct;
    pos.netReturnPct = netReturnPct;
    pos.pnlUsd = pnlUsd;
    pos.isProfitable = pnlUsd > 0;

    this.openByMintAndLane.delete(`${pos.lane}_${pos.mint}`);
  }

  public getOpenPositions(lane?: PaperLaneType): PaperPosition[] {
    return this.positions.filter(p => p.status === "OPEN" && (!lane || p.lane === lane));
  }

  public getClosedPositions(lane?: PaperLaneType): PaperPosition[] {
    return this.positions.filter(p => p.status === "CLOSED" && (!lane || p.lane === lane));
  }

  public getAllPositions(): PaperPosition[] {
    return this.positions;
  }

  public computeLaneStats(lane: PaperLaneType): LaneStats {
    const list = this.positions.filter(p => p.lane === lane);
    const closed = list.filter(p => p.status === "CLOSED");
    const open = list.filter(p => p.status === "OPEN");
    const wins = closed.filter(p => (p.pnlUsd || 0) > 0);
    const losses = closed.filter(p => (p.pnlUsd || 0) <= 0);

    const grossProfit = wins.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);
    const grossLoss = Math.abs(losses.reduce((sum, p) => sum + (p.pnlUsd || 0), 0));
    const totalPnl = closed.reduce((sum, p) => sum + (p.pnlUsd || 0), 0);

    const winRate = closed.length > 0 ? Number(((wins.length / closed.length) * 100).toFixed(1)) : 0;
    const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : (grossProfit > 0 ? 99.9 : 1.0);

    const totalDurSec = closed.reduce((sum, p) => sum + (p.holdingSec || 0), 0);
    const avgDurationM = closed.length > 0 ? Number((totalDurSec / closed.length / 60).toFixed(1)) : 0;
    const avgReturnPct = closed.length > 0 ? Number((closed.reduce((sum, p) => sum + (p.netReturnPct || 0), 0) / closed.length).toFixed(1)) : 0;

    const names: Record<PaperLaneType, { name: string; desc: string; tag: string }> = {
      LANE_GOLDEN_SCALP: {
        name: "⚡ Lane A: Golden Scalp Bot",
        desc: "Scalp cepat (+35% TP / -12% SL / Trailing 7% dari +20% / Max 30m). Menang 72.2% WR dengan tangkapan momentum awal.",
        tag: "72.2% WR · TERBAIK"
      },
      LANE_GOLDEN_MOONBAG: {
        name: "🚀 Lane B: Golden Moonbag Runner",
        desc: "Runner bertingkat (TP1 +50% jual 50%, TP2 +120% / -15% SL / Trailing 10% dari +30% / Max 60m). Net Profit tertinggi.",
        tag: "+$1,454 · MAX PROFIT"
      }
    };

    return {
      lane,
      name: names[lane].name,
      description: names[lane].desc,
      winRateTag: names[lane].tag,
      totalTrades: list.length,
      openPositions: open.length,
      closedTrades: closed.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRatePct: winRate,
      totalPnlUsd: Number(totalPnl.toFixed(2)),
      grossProfitUsd: Number(grossProfit.toFixed(2)),
      grossLossUsd: Number(grossLoss.toFixed(2)),
      profitFactor,
      avgDurationM,
      avgReturnPct
    };
  }
}
