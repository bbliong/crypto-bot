import fs from 'node:fs';
import path from 'node:path';
import type { WalletTradeSignal } from './wallet-follower-lane.js';

export interface SmartDipPosition {
  mint: string;
  symbol: string;
  tokenName: string;
  openedAt: number;
  updatedAt: number;
  status: 'OPEN' | 'CLOSED';
  phase: 'INITIAL' | 'WAITING_DIP' | 'HOLDING_REBOUND';
  
  // Financials
  totalStakeUsd: number;
  remainingCostBasisUsd: number;
  totalTokens: number;
  avgEntryPriceUsd: number;
  initialEntryPriceUsd: number;
  reboundEntryPriceUsd?: number;
  lastObservedPriceUsd: number;
  peakPriceUsd: number;
  lowestPriceSincePeakUsd: number;
  realizedPnlUsd: number;
  lastTradeActivityAt?: number;
  isMoonbagActive?: boolean;
  
  // History
  entries: Array<{
    type: 'INITIAL_BUY' | 'REBOUND_BUY';
    stakeUsd: number;
    tokensBought: number;
    priceUsd: number;
    timestamp: number;
    txHash: string;
  }>;
  exits: Array<{
    type: 'TP_30_50_FULL' | 'TP_OVER_50_PARTIAL_70' | 'REBOUND_TP_20_FULL' | 'TARGET_EXIT' | 'STOP_LOSS' | 'STAGNANT_TIMEOUT_EXIT';
    tokensSold: number;
    usdReceived: number;
    priceUsd: number;
    pnlUsd: number;
    roiPct: number;
    isFullExit: boolean;
    timestamp: number;
    txHash: string;
  }>;
}

export interface SmartDipComparisonEvent {
  id: string;
  timestamp: number;
  timeWib: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  action: 'BUY_INITIAL' | 'BUY_REBOUND' | 'SELL_TP_FULL' | 'SELL_TP_70' | 'SELL_REBOUND_TP20' | 'SELL_TARGET_EXIT' | 'SELL_TIMEOUT';
  stakeOrProceedsUsd: number;
  tokens: number;
  executionPriceUsd: number;
  pnlUsd?: number;
  roiPct?: number;
  reason: string;
  positionStatus: 'OPEN' | 'CLOSED';
}

export interface SmartDipConfig {
  targetWallet: string;
  stakePerTradeUsd?: number; // default $5.0
  maxCapitalExposureUsd?: number; // default $20.0
  positionsFilePath?: string;
  tradesFilePath?: string;
  eventsFilePath?: string;
}

export class SmartDipFollowerLane {
  public readonly targetWallet: string;
  public readonly stakePerTradeUsd: number;
  public readonly maxCapitalExposureUsd: number;
  private positionsFilePath: string;
  private tradesFilePath: string;
  private eventsFilePath: string;

  private positions = new Map<string, SmartDipPosition>();
  private closedTrades: SmartDipPosition[] = [];
  private events: SmartDipComparisonEvent[] = [];

  // Recent target buy history per token to detect conviction (2x consecutive buys or large buy)
  private targetBuyHistory = new Map<string, Array<{ timestamp: number; usdAmount: number; priceUsd: number; solAmount: number }>>();

  constructor(config: SmartDipConfig) {
    this.targetWallet = config.targetWallet;
    this.stakePerTradeUsd = config.stakePerTradeUsd ?? 5.0;
    this.maxCapitalExposureUsd = config.maxCapitalExposureUsd ?? 20.0;
    this.positionsFilePath = config.positionsFilePath || path.resolve(process.cwd(), 'data/smart-dip-positions.json');
    this.tradesFilePath = config.tradesFilePath || path.resolve(process.cwd(), 'data/smart-dip-trades.json');
    this.eventsFilePath = config.eventsFilePath || path.resolve(process.cwd(), 'data/smart-dip-events.json');

    this.loadState();
  }

  public getPosition(mint: string): SmartDipPosition | undefined {
    return this.positions.get(mint);
  }

  public getAllPositions(): SmartDipPosition[] {
    return Array.from(this.positions.values());
  }

  public getOpenPositions(): SmartDipPosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
  }

  public getSummary(): {
    openPositionsCount: number;
    totalCapitalInvested: number;
    totalRealizedPnlUsd: number;
    closedTradesCount: number;
    winRatePct: number;
  } {
    const open = this.getOpenPositions();
    const totalCapitalInvested = open.reduce((acc, p) => acc + p.remainingCostBasisUsd, 0);
    let totalRealized = 0;
    let winCount = 0;

    for (const t of this.closedTrades) {
      totalRealized += t.realizedPnlUsd;
      if (t.realizedPnlUsd > 0) winCount++;
    }
    for (const p of open) {
      totalRealized += p.realizedPnlUsd;
    }

    const winRate = this.closedTrades.length > 0 ? (winCount / this.closedTrades.length) * 100 : 0;
    return {
      openPositionsCount: open.length,
      totalCapitalInvested: Number(totalCapitalInvested.toFixed(2)),
      totalRealizedPnlUsd: Number(totalRealized.toFixed(4)),
      closedTradesCount: this.closedTrades.length,
      winRatePct: Number(winRate.toFixed(1)),
    };
  }

  /**
   * Catat aktivitas BUY target untuk melacak conviction (beli 2x berturut-turut atau beli besar).
   */
  public recordTargetBuyActivity(signal: WalletTradeSignal): void {
    const now = signal.timestamp || Date.now();
    let history = this.targetBuyHistory.get(signal.mint) || [];
    // Simpan event 5 menit terakhir
    history = history.filter(h => now - h.timestamp < 300_000);
    history.push({
      timestamp: now,
      usdAmount: signal.usdAmount,
      priceUsd: signal.priceUsd,
      solAmount: signal.solAmount,
    });
    this.targetBuyHistory.set(signal.mint, history);
  }

  /**
   * Evaluasi sinyal BUY dari target:
   * 1. Jika token baru (fresh pool <= 10m) & belum pernah entry -> Beli Awal $5
   * 2. Jika sedang WAITING_DIP & target buy (conviction: beli besar atau 2x berturut-turut) & harga sedang rebound -> Beli Rebound $5
   */
  public evaluateBuySignal(signal: WalletTradeSignal, opts?: { isFreshToken?: boolean; tokenAgeMinutes?: number | null }): {
    canBuy: boolean;
    buyType: 'INITIAL_BUY' | 'REBOUND_BUY' | 'NONE';
    stakeUsd: number;
    reason: string;
  } {
    this.recordTargetBuyActivity(signal);

    const pos = this.positions.get(signal.mint);
    const activeCapital = this.getOpenPositions().reduce((acc, p) => acc + p.remainingCostBasisUsd, 0);

    // Cek batas total eksposur kas ($20 pool)
    if (activeCapital + this.stakePerTradeUsd > this.maxCapitalExposureUsd) {
      return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: 'MAX_CAPITAL_EXPOSURE_REACHED' };
    }

    // 1. Kasus Token Baru: Initial Entry
    if (!pos || pos.status === 'CLOSED') {
      const isFresh = opts?.isFreshToken ?? (opts?.tokenAgeMinutes !== undefined && opts.tokenAgeMinutes !== null && opts.tokenAgeMinutes <= 10);
      if (!isFresh) {
        return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: `REJECT_OLD_TOKEN_AGE_${opts?.tokenAgeMinutes?.toFixed(0) || '>10'}M` };
      }
      return {
        canBuy: true,
        buyType: 'INITIAL_BUY',
        stakeUsd: this.stakePerTradeUsd,
        reason: 'NEW_FRESH_TOKEN_INITIAL_BUY',
      };
    }

    // 2. Kasus Posisi Sedang Berjalan
    if (pos.status === 'OPEN') {
      // Jika masih memegang Initial Buy dan belum TP, jangan beli berulang-ulang (hemat fee!)
      if (pos.phase === 'INITIAL') {
        return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: 'ALREADY_HOLDING_INITIAL_AWAITING_TP' };
      }

      // Jika sedang memegang Rebound, tunggu TP 20%
      if (pos.phase === 'HOLDING_REBOUND') {
        return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: 'ALREADY_HOLDING_REBOUND_AWAITING_TP20' };
      }

      // Jika fase WAITING_DIP: Cek apakah target menunjukkan conviction & harga rebound
      if (pos.phase === 'WAITING_DIP') {
        // Limit ketat: Rebound buy hanya boleh maksimal 1 kali saja per token
        const reboundBuyCount = (pos.entries || []).filter(e => e.type === 'REBOUND_BUY').length;
        if (reboundBuyCount >= 1) {
          return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: 'REBOUND_BUY_MAX_1X_REACHED' };
        }

        const history = this.targetBuyHistory.get(signal.mint) || [];
        const isConsecutiveBuys = history.length >= 2;
        const isLargeBuy = signal.usdAmount >= 100 || signal.solAmount >= 1.0;
        const hasConviction = isConsecutiveBuys || isLargeBuy;

        if (!hasConviction) {
          return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: 'AWAITING_TARGET_CONVICTION_2X_OR_LARGE' };
        }

        // Cek apakah harga saat ini sudah mengalami koreksi (dip) dari puncak
        const currentPrice = signal.priceUsd;
        const peakPrice = pos.peakPriceUsd;
        const lowestPrice = pos.lowestPriceSincePeakUsd > 0 ? pos.lowestPriceSincePeakUsd : currentPrice;

        const dropFromPeakPct = peakPrice > 0 ? ((peakPrice - lowestPrice) / peakPrice) * 100 : 0;
        const reboundFromLowestPct = lowestPrice > 0 ? ((currentPrice - lowestPrice) / lowestPrice) * 100 : 0;

        // Syarat Dip-Rebound: koreksi minimal >= 10% dari puncak dan mulai rebound >= 2.5%
        if (dropFromPeakPct >= 10.0 && reboundFromLowestPct >= 2.0) {
          return {
            canBuy: true,
            buyType: 'REBOUND_BUY',
            stakeUsd: this.stakePerTradeUsd,
            reason: `DIP_REBOUND_CONFIRMED (Drop: -${dropFromPeakPct.toFixed(1)}%, Rebound: +${reboundFromLowestPct.toFixed(1)}%, Conviction: ${isLargeBuy ? 'LargeBuy' : '2xBuy'})`,
          };
        } else {
          return {
            canBuy: false,
            buyType: 'NONE',
            stakeUsd: 0,
            reason: `DIP_CONDITIONS_NOT_MET (Drop: -${dropFromPeakPct.toFixed(1)}%, Rebound: +${reboundFromLowestPct.toFixed(1)}%)`,
          };
        }
      }
    }

    return { canBuy: false, buyType: 'NONE', stakeUsd: 0, reason: 'NO_VALID_ENTRY_CONDITION' };
  }

  /**
   * Catat eksekusi BUY (Initial atau Rebound).
   */
  public recordBuyExecution(
    signal: WalletTradeSignal,
    buyType: 'INITIAL_BUY' | 'REBOUND_BUY',
    stakeUsd: number,
    tokensBought: number,
    executionPriceUsd: number
  ): SmartDipPosition {
    let pos = this.positions.get(signal.mint);
    const now = signal.timestamp || Date.now();

    if (!pos || pos.status === 'CLOSED') {
      pos = {
        mint: signal.mint,
        symbol: signal.symbol || 'TOKEN',
        tokenName: signal.tokenName || '',
        openedAt: now,
        updatedAt: now,
        status: 'OPEN',
        phase: 'INITIAL',
        totalStakeUsd: stakeUsd,
        remainingCostBasisUsd: stakeUsd,
        totalTokens: tokensBought,
        avgEntryPriceUsd: executionPriceUsd,
        initialEntryPriceUsd: executionPriceUsd,
        lastObservedPriceUsd: executionPriceUsd,
        peakPriceUsd: executionPriceUsd,
        lowestPriceSincePeakUsd: executionPriceUsd,
        realizedPnlUsd: 0,
        lastTradeActivityAt: now * 1000,
        isMoonbagActive: false,
        entries: [
          {
            type: 'INITIAL_BUY',
            stakeUsd,
            tokensBought,
            priceUsd: executionPriceUsd,
            timestamp: now,
            txHash: signal.txHash,
          },
        ],
        exits: [],
      };
      this.positions.set(signal.mint, pos);
    } else {
      // Rebound Buy
      pos.phase = 'HOLDING_REBOUND';
      pos.totalStakeUsd += stakeUsd;
      pos.remainingCostBasisUsd += stakeUsd;
      pos.totalTokens += tokensBought;
      pos.reboundEntryPriceUsd = executionPriceUsd;
      pos.lastObservedPriceUsd = executionPriceUsd;
      pos.lastTradeActivityAt = now * 1000;
      pos.avgEntryPriceUsd = pos.totalTokens > 0 ? pos.remainingCostBasisUsd / pos.totalTokens : executionPriceUsd;
      pos.updatedAt = now;
      pos.entries.push({
        type: 'REBOUND_BUY',
        stakeUsd,
        tokensBought,
        priceUsd: executionPriceUsd,
        timestamp: now,
        txHash: signal.txHash,
      });
    }

    this.saveState();
    return pos;
  }

  public recordTokenActivity(mint: string, timestampMs?: number): void {
    const pos = this.positions.get(mint);
    if (!pos) return;
    pos.lastTradeActivityAt = timestampMs || Date.now();
  }

  /**
   * Update tick harga live untuk mendeteksi:
   * - TP 30%-50% (jual 100%)
   * - TP >50% (jual 70%, 30% Free Moonbag)
   * - Rebound TP 20% (jual 100%)
   * - Inactivity Exit 5m jika tidak ada buy & sell sama sekali di pasar
   */
  public evaluatePriceTick(mint: string, currentPrice: number): {
    shouldSell: boolean;
    sellType: 'TP_30_50_FULL' | 'TP_OVER_50_PARTIAL_70' | 'REBOUND_TP_20_FULL' | 'TARGET_EXIT' | 'STOP_LOSS' | 'STAGNANT_TIMEOUT_EXIT' | 'NONE';
    sellRatioPct: number;
    tokensToSell: number;
    reason: string;
  } {
    const pos = this.positions.get(mint);
    if (!pos || pos.status !== 'OPEN') {
      return { shouldSell: false, sellType: 'NONE', sellRatioPct: 0, tokensToSell: 0, reason: 'NO_POSITION' };
    }

    const effectivePrice = currentPrice > 0 ? currentPrice : pos.lastObservedPriceUsd;
    if (effectivePrice <= 0) {
      // Jika harga 0/mati, evaluasi apakah pasar sudah tidak aktif >= 5 menit
      const lastActivity = pos.lastTradeActivityAt || pos.updatedAt || (pos.openedAt * 1000);
      const inactiveMinutes = (Date.now() - lastActivity) / 60000;
      if (inactiveMinutes >= 5.0 && pos.totalTokens > 0) {
        return {
          shouldSell: true,
          sellType: 'STAGNANT_TIMEOUT_EXIT',
          sellRatioPct: 100,
          tokensToSell: pos.totalTokens,
          reason: `NO_ACTIVITY_5M (Tidak ada aktivitas buy/sell pasar selama ${inactiveMinutes.toFixed(0)}m, auto-sell exit)`,
        };
      }
      return { shouldSell: false, sellType: 'NONE', sellRatioPct: 0, tokensToSell: 0, reason: 'INVALID_PRICE' };
    }

    currentPrice = effectivePrice;
    pos.lastObservedPriceUsd = currentPrice;
    if (currentPrice > pos.peakPriceUsd) pos.peakPriceUsd = currentPrice;

    // Track lowest price saat fase koreksi (jika koin 0 pasca Full TP)
    if (pos.phase === 'WAITING_DIP' && pos.totalTokens <= 0) {
      const waitMinutes = (Date.now() - (pos.updatedAt || pos.openedAt * 1000)) / 60000;
      if (waitMinutes >= 10.0) {
        pos.status = 'CLOSED';
        this.archiveClosedTrade(pos);
        this.saveState();
        return { shouldSell: false, sellType: 'NONE', sellRatioPct: 0, tokensToSell: 0, reason: 'WAITING_DIP_EXPIRED_CLOSED' };
      }
      if (pos.lowestPriceSincePeakUsd === 0 || currentPrice < pos.lowestPriceSincePeakUsd) {
        pos.lowestPriceSincePeakUsd = currentPrice;
      }
      return { shouldSell: false, sellType: 'NONE', sellRatioPct: 0, tokensToSell: 0, reason: 'WAITING_DIP' };
    }

    if (pos.totalTokens <= 0) {
      return { shouldSell: false, sellType: 'NONE', sellRatioPct: 0, tokensToSell: 0, reason: 'NO_TOKENS' };
    }

    // 0. Evaluasi Inaktivitas Pasar: Jika dalam 5 menit TIDAK ADA aktivitas buy & sell sama sekali di pasar DEX
    const lastActivity = pos.lastTradeActivityAt || pos.updatedAt || (pos.openedAt * 1000);
    const inactiveMinutes = (Date.now() - lastActivity) / 60000;

    if (inactiveMinutes >= 5.0) {
      const isMoonbag = !!pos.isMoonbagActive || (pos.phase === 'WAITING_DIP' && pos.totalTokens > 0);
      return {
        shouldSell: true,
        sellType: 'STAGNANT_TIMEOUT_EXIT',
        sellRatioPct: 100,
        tokensToSell: pos.totalTokens,
        reason: isMoonbag
          ? `MOONBAG_INACTIVITY_EXIT (Free moonbag dijual 100% karena tidak ada aktivitas buy/sell pasar selama ${inactiveMinutes.toFixed(0)}m)`
          : `NO_ACTIVITY_5M (Tidak ada aktivitas buy/sell pasar selama ${inactiveMinutes.toFixed(0)}m, auto-sell exit)`,
      };
    }

    // 1. Evaluasi Fase INITIAL BUY
    if (pos.phase === 'INITIAL') {
      const entryPrice = pos.initialEntryPriceUsd;
      const gainPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      // Jika gain > 50%: Jual 70% muatan, 30% koin disimpan sebagai Free Moonbag!
      if (gainPct >= 50.0) {
        const tokensToSell = pos.totalTokens * 0.70;
        return {
          shouldSell: true,
          sellType: 'TP_OVER_50_PARTIAL_70',
          sellRatioPct: 70,
          tokensToSell,
          reason: `TP_OVER_50%_TRIGGERED (Gain: +${gainPct.toFixed(1)}%, Amankan 70% kas, simpan 30% free moonbag)`,
        };
      }

      // Jika gain antara 30% s/d 50%: Jual FULL 100%
      if (gainPct >= 30.0) {
        return {
          shouldSell: true,
          sellType: 'TP_30_50_FULL',
          sellRatioPct: 100,
          tokensToSell: pos.totalTokens,
          reason: `TP_30_50%_TRIGGERED (Gain: +${gainPct.toFixed(1)}%)`,
        };
      }
    }

    // 2. Evaluasi Fase HOLDING REBOUND (Rebound TP >= 20% jual FULL 100%)
    if (pos.phase === 'HOLDING_REBOUND') {
      const entryPrice = pos.reboundEntryPriceUsd || pos.avgEntryPriceUsd;
      const reboundGainPct = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      if (reboundGainPct >= 20.0) {
        return {
          shouldSell: true,
          sellType: 'REBOUND_TP_20_FULL',
          sellRatioPct: 100,
          tokensToSell: pos.totalTokens,
          reason: `REBOUND_TP_20%_TRIGGERED (Gain: +${reboundGainPct.toFixed(1)}%)`,
        };
      }
    }

    return { shouldSell: false, sellType: 'NONE', sellRatioPct: 0, tokensToSell: 0, reason: 'HOLDING_AWAITING_TARGET' };
  }

  /**
   * Evaluasi sinyal SELL dari target (jika target Full Exit, bot juga wajib ikut Full Exit).
   */
  public evaluateTargetSellSignal(signal: WalletTradeSignal): {
    shouldSell: boolean;
    isTargetFullExit: boolean;
    tokensToSell: number;
    reason: string;
  } {
    const pos = this.positions.get(signal.mint);
    if (!pos || pos.status !== 'OPEN' || pos.totalTokens <= 0) {
      return { shouldSell: false, isTargetFullExit: false, tokensToSell: 0, reason: 'NO_OPEN_POSITION' };
    }

    const targetRemaining = signal.remainingHolding;
    const isTargetFullExit = targetRemaining < 100 || (signal.remainingHolding + signal.tokenAmount > 0 && targetRemaining / (signal.remainingHolding + signal.tokenAmount) < 0.01);

    if (isTargetFullExit) {
      return {
        shouldSell: true,
        isTargetFullExit: true,
        tokensToSell: pos.totalTokens,
        reason: 'TARGET_FULL_EXIT_SAFETY_CLOSE',
      };
    }

    return { shouldSell: false, isTargetFullExit: false, tokensToSell: 0, reason: 'TARGET_PARTIAL_IGNORED_SMART_LANE' };
  }

  /**
   * Catat eksekusi SELL (TP 100%, TP 70%, Rebound TP 20%, atau Target Exit).
   */
  public recordSellExecution(
    mint: string,
    sellType: 'TP_30_50_FULL' | 'TP_OVER_50_PARTIAL_70' | 'REBOUND_TP_20_FULL' | 'TARGET_EXIT' | 'STOP_LOSS',
    tokensSold: number,
    usdReceived: number,
    executionPriceUsd: number,
    isFullExit: boolean,
    txHash: string
  ): SmartDipPosition | null {
    const pos = this.positions.get(mint);
    if (!pos || pos.status !== 'OPEN') return null;

    const sellPortion = pos.totalTokens > 0 ? Math.min(1.0, tokensSold / pos.totalTokens) : 1.0;
    const costBasisPortion = pos.remainingCostBasisUsd * sellPortion;
    const pnlUsd = Number((usdReceived - costBasisPortion).toFixed(4));
    const roiPct = costBasisPortion > 0.001 ? Number(((pnlUsd / costBasisPortion) * 100).toFixed(2)) : 0;

    pos.realizedPnlUsd = Number((pos.realizedPnlUsd + pnlUsd).toFixed(4));
    pos.remainingCostBasisUsd = Number(Math.max(0, pos.remainingCostBasisUsd - costBasisPortion).toFixed(4));
    pos.totalTokens = Math.max(0, pos.totalTokens - tokensSold);
    pos.lastObservedPriceUsd = executionPriceUsd;
    if (executionPriceUsd > pos.peakPriceUsd) pos.peakPriceUsd = executionPriceUsd;
    pos.updatedAt = Date.now();

    pos.exits.push({
      type: sellType,
      tokensSold,
      usdReceived,
      priceUsd: executionPriceUsd,
      pnlUsd,
      roiPct,
      isFullExit,
      timestamp: Date.now(),
      txHash,
    });

    if (isFullExit || pos.totalTokens < 1 || pos.remainingCostBasisUsd < 0.01) {
      if (sellType === 'TARGET_EXIT' || sellType === 'STOP_LOSS' || sellType === 'REBOUND_TP_20_FULL' || sellType === 'STAGNANT_TIMEOUT_EXIT') {
        pos.status = 'CLOSED';
        pos.totalTokens = 0;
        pos.remainingCostBasisUsd = 0;
        this.archiveClosedTrade(pos);
      } else {
        // TP 100% Initial -> Masuk fase WAITING_DIP untuk mencari 1x setup rebound
        pos.phase = 'WAITING_DIP';
        pos.lowestPriceSincePeakUsd = executionPriceUsd;
      }
    } else {
      // Partial TP 70% -> Sisa 30% koin masuk fase WAITING_DIP sebagai Free Moonbag
      pos.phase = 'WAITING_DIP';
      pos.isMoonbagActive = true;
      pos.lowestPriceSincePeakUsd = executionPriceUsd;
    }

    this.saveState();
    return pos;
  }

  public appendEvent(event: SmartDipComparisonEvent): void {
    this.events.unshift(event);
    if (this.events.length > 500) this.events.pop();
    try {
      fs.writeFileSync(this.eventsFilePath, JSON.stringify(this.events, null, 2), 'utf8');
    } catch {}
  }

  private archiveClosedTrade(pos: SmartDipPosition): void {
    try {
      this.closedTrades.push({ ...pos });
      fs.writeFileSync(this.tradesFilePath, JSON.stringify(this.closedTrades, null, 2), 'utf8');
    } catch {}
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.positionsFilePath)) {
        const raw = fs.readFileSync(this.positionsFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if ((item.totalTokens < 1 || item.remainingCostBasisUsd < 0.01) && item.phase !== 'WAITING_DIP') {
              item.status = 'CLOSED';
            }
            if (item.mint) this.positions.set(item.mint, item);
          }
        }
      }
      if (fs.existsSync(this.tradesFilePath)) {
        const rawT = fs.readFileSync(this.tradesFilePath, 'utf8');
        const parsedT = JSON.parse(rawT);
        if (Array.isArray(parsedT)) this.closedTrades = parsedT;
      }
      if (fs.existsSync(this.eventsFilePath)) {
        const rawEv = fs.readFileSync(this.eventsFilePath, 'utf8');
        const parsedEv = JSON.parse(rawEv);
        if (Array.isArray(parsedEv)) this.events = parsedEv;
      }
    } catch (err: any) {
      console.warn(`[SMART-DIP-LOAD-WARN] Gagal membaca state awal: ${err?.message}`);
    }
  }

  public saveState(): void {
    try {
      const all = Array.from(this.positions.values());
      fs.writeFileSync(this.positionsFilePath, JSON.stringify(all, null, 2), 'utf8');
    } catch {}
  }
}
