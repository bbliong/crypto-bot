import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type PaperLaneType = "LANE_GMGN_DISCOVERY" | "LANE_SOLANA_RPC";

export type ExitReason =
  | "TAKE_PROFIT_35"
  | "TRAILING_STOP_7PCT"
  | "STOP_LOSS_12"
  | "TIMEOUT_30M"
  | "EMERGENCY_DUMP_GUARD"
  | "MANUAL_CLOSE";

export interface PaperPosition {
  id: string;
  lane: PaperLaneType;
  mint: string;
  symbol: string;
  stakeUsd: number;               // Default $100
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
  trailingActivated: boolean;      // True when peakGainPct >= +20%
  
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
    takeProfitPct: number;        // +35%
    stopLossPct: number;          // -12%
    trailingActivationPct: number;// +20%
    trailingDropPct: number;      // 7% drop from peak
    maxHoldingDurationSec: number;// 1800s (30m)
    roundTripFeeRate: number;     // 2%
  };
  lanes: Record<PaperLaneType, LaneStats>;
  positions: PaperPosition[];
}

export class GoldenConvergencePaperLane {
  private storePath: string;
  private positions: PaperPosition[] = [];
  private openByMintAndLane: Map<string, PaperPosition> = new Map();

  // Rules constants
  public static readonly STAKE_PER_TRADE = 100;
  public static readonly TP_PCT = 35;
  public static readonly SL_PCT = -12;
  public static readonly TRAILING_ACTIVATE_PCT = 20;
  public static readonly TRAILING_DROP_PCT = 7;
  public static readonly MAX_HOLDING_SEC = 1800; // 30 minutes
  public static readonly FEE_RATE = 2.0;         // 2% roundtrip

  constructor(options?: { storePath?: string }) {
    const root = process.cwd();
    this.storePath = options?.storePath || join(root, "data", "golden-paper-positions.json");
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
      stakePerTradeUsd: GoldenConvergencePaperLane.STAKE_PER_TRADE,
      rules: {
        takeProfitPct: GoldenConvergencePaperLane.TP_PCT,
        stopLossPct: GoldenConvergencePaperLane.SL_PCT,
        trailingActivationPct: GoldenConvergencePaperLane.TRAILING_ACTIVATE_PCT,
        trailingDropPct: GoldenConvergencePaperLane.TRAILING_DROP_PCT,
        maxHoldingDurationSec: GoldenConvergencePaperLane.MAX_HOLDING_SEC,
        roundTripFeeRate: GoldenConvergencePaperLane.FEE_RATE
      },
      lanes: {
        LANE_GMGN_DISCOVERY: this.computeLaneStats("LANE_GMGN_DISCOVERY"),
        LANE_SOLANA_RPC: this.computeLaneStats("LANE_SOLANA_RPC")
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
   * Trigger a PAPER BUY when Wallet #2 enters
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
      return null; // Already open in this lane
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

    const pos: PaperPosition = {
      id: `pos_${params.lane === "LANE_GMGN_DISCOVERY" ? "gmgn" : "sol"}_${params.mint.slice(0, 6)}_${nowSec}`,
      lane: params.lane,
      mint: params.mint,
      symbol: params.symbol || "UNKNOWN",
      stakeUsd: GoldenConvergencePaperLane.STAKE_PER_TRADE,
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
   * Update open position with latest market candle / tick price and evaluate exit rules
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

    // Update tracking
    const holdingSec = Math.max(0, tickTime - pos.entryTimestamp);
    const m = Math.floor(holdingSec / 60);
    const s = holdingSec % 60;
    pos.holdingSec = holdingSec;
    pos.holdingDurationStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
    pos.currentPriceUsd = currentPrice;
    pos.currentMcapUsd = marketData.mcapUsd || pos.currentMcapUsd;

    const gainPct = Number((((currentPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(2));
    const highGainPct = Number((((highPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(2));
    const lowGainPct = Number((((lowPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(2));
    pos.currentGainPct = gainPct;

    // Update high-water mark
    if (highPrice > pos.peakPriceUsd) {
      pos.peakPriceUsd = highPrice;
      pos.peakGainPct = highGainPct;
    }

    if (pos.peakGainPct >= GoldenConvergencePaperLane.TRAILING_ACTIVATE_PCT) {
      pos.trailingActivated = true;
    }

    // 1. Check Take Profit (+35%)
    if (highGainPct >= GoldenConvergencePaperLane.TP_PCT) {
      const exitPrice = pos.entryPriceUsd * (1 + GoldenConvergencePaperLane.TP_PCT / 100);
      this.closePosition(pos, exitPrice, "TAKE_PROFIT_35", tickTime, marketData.mcapUsd);
      return { closed: true, reason: "TAKE_PROFIT_35" };
    }

    // 2. Check Trailing Stop (activated at +20%, drops 7% from peak)
    if (pos.trailingActivated) {
      const dropFromPeak = ((pos.peakPriceUsd - currentPrice) / pos.peakPriceUsd) * 100;
      if (dropFromPeak >= GoldenConvergencePaperLane.TRAILING_DROP_PCT) {
        this.closePosition(pos, currentPrice, "TRAILING_STOP_7PCT", tickTime, marketData.mcapUsd);
        return { closed: true, reason: "TRAILING_STOP_7PCT" };
      }
    }

    // 3. Check Stop Loss (-12%)
    if (lowGainPct <= GoldenConvergencePaperLane.SL_PCT) {
      const exitPrice = pos.entryPriceUsd * (1 + GoldenConvergencePaperLane.SL_PCT / 100);
      this.closePosition(pos, exitPrice, "STOP_LOSS_12", tickTime, marketData.mcapUsd);
      return { closed: true, reason: "STOP_LOSS_12" };
    }

    // 4. Check Emergency Dump / Liquidity Drained
    if (marketData.isLiquidityDrained || lowGainPct <= -25) {
      this.closePosition(pos, lowPrice, "EMERGENCY_DUMP_GUARD", tickTime, marketData.mcapUsd);
      return { closed: true, reason: "EMERGENCY_DUMP_GUARD" };
    }

    // 5. Check Timeout (30 minutes)
    if (holdingSec >= GoldenConvergencePaperLane.MAX_HOLDING_SEC) {
      this.closePosition(pos, currentPrice, "TIMEOUT_30M", tickTime, marketData.mcapUsd);
      return { closed: true, reason: "TIMEOUT_30M" };
    }

    return { closed: false };
  }

  private closePosition(
    pos: PaperPosition,
    exitPrice: number,
    reason: ExitReason,
    exitTimestamp: number,
    exitMcapUsd?: number
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
      pos.exitMcapUsd = exitMcapUsd;
    } else if (pos.entryMcapUsd > 0) {
      pos.exitMcapUsd = Math.round(pos.entryMcapUsd * (exitPrice / pos.entryPriceUsd));
    }

    const grossReturnPct = Number((((exitPrice - pos.entryPriceUsd) / pos.entryPriceUsd) * 100).toFixed(2));
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

    const names: Record<PaperLaneType, { name: string; desc: string }> = {
      LANE_GMGN_DISCOVERY: {
        name: "Lane 1: GMGN Discovery",
        desc: "Bottom-up scanner token lowcap $5k-$100k, buy saat smart wallet ke-2 terkonfirmasi."
      },
      LANE_SOLANA_RPC: {
        name: "Lane 2: Solana RPC Queue",
        desc: "Top-down monitor on-chain 100% gratis tanpa kuota, trigger instan saat smart wallet ke-2 masuk."
      }
    };

    return {
      lane,
      name: names[lane].name,
      description: names[lane].desc,
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
