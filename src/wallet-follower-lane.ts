import fs from 'node:fs';
import path from 'node:path';

export interface FollowerEntry {
  entryNum: number;
  stakeUsd: number;
  tokensBought: number;
  priceUsd: number;
  txHash: string;
  timestamp: number;
}

export interface FollowerExit {
  targetSold: number;
  targetRemaining: number;
  sellRatioPct: number;
  tokensSold: number;
  usdReceived: number;
  priceUsd: number;
  pnlUsd: number;
  roiPct: number;
  isFullExit: boolean;
  txHash: string;
  timestamp: number;
}

export interface FollowerPosition {
  mint: string;
  symbol: string;
  tokenName: string;
  openedAt: number;
  updatedAt: number;
  entryCount: number; // 1..5
  totalStakeUsd: number; // Max $10 ($2 * 5)
  remainingCostBasisUsd: number;
  totalTokens: number; // Sisa saldo koin yang di-hold bot
  avgEntryPriceUsd: number;
  lastObservedPriceUsd: number;
  lastObservedTargetHolding: number;
  realizedPnlUsd: number;
  status: 'OPEN' | 'CLOSED';
  entries: FollowerEntry[];
  exits: FollowerExit[];
}

export interface WalletTradeSignal {
  action: 'buy' | 'sell';
  mint: string;
  symbol: string;
  tokenName: string;
  tokenAmount: number;
  remainingHolding: number;
  solAmount: number;
  usdAmount: number;
  priceUsd: number;
  txHash: string;
  timestamp: number;
}

export interface FollowerLaneConfig {
  targetWallet: string;
  stakePerEntryUsd: number; // default $2.0
  maxEntriesPerToken: number; // default 5
  maxTotalStakeUsd: number; // default $10.0
  positionsFilePath?: string;
  tradesFilePath?: string;
}

export class WalletFollowerLane {
  public readonly targetWallet: string;
  public readonly stakePerEntryUsd: number;
  public readonly maxEntriesPerToken: number;
  public readonly maxTotalStakeUsd: number;
  private positionsFilePath: string;
  private tradesFilePath: string;

  // Active positions keyed by mint
  private positions = new Map<string, FollowerPosition>();

  constructor(config: FollowerLaneConfig) {
    this.targetWallet = config.targetWallet;
    this.stakePerEntryUsd = config.stakePerEntryUsd ?? 2.0;
    this.maxEntriesPerToken = config.maxEntriesPerToken ?? 5;
    this.maxTotalStakeUsd = config.maxTotalStakeUsd ?? 10.0;
    this.positionsFilePath = config.positionsFilePath || path.resolve(process.cwd(), 'data/wallet-follower-positions.json');
    this.tradesFilePath = config.tradesFilePath || path.resolve(process.cwd(), 'data/wallet-follower-trades.json');

    this.loadState();
  }

  public getPosition(mint: string): FollowerPosition | undefined {
    return this.positions.get(mint);
  }

  public getAllPositions(): FollowerPosition[] {
    return Array.from(this.positions.values());
  }

  public getOpenPositions(): FollowerPosition[] {
    return Array.from(this.positions.values()).filter(p => p.status === 'OPEN');
  }

  /**
   * Evaluasi sinyal BUY dari target wallet.
   * Return stake yang diizinkan untuk dieksekusi ($2.0 atau 0 jika sudah mencapai batas akumulasi).
   */
  public evaluateBuySignal(signal: WalletTradeSignal): {
    canEnter: boolean;
    stakeUsd: number;
    entryNum: number;
    reason: string;
  } {
    const existing = this.positions.get(signal.mint);

    if (!existing || existing.status === 'CLOSED') {
      return {
        canEnter: true,
        stakeUsd: this.stakePerEntryUsd,
        entryNum: 1,
        reason: 'NEW_TOKEN_ENTRY_1',
      };
    }

    if (existing.entryCount >= this.maxEntriesPerToken) {
      return {
        canEnter: false,
        stakeUsd: 0,
        entryNum: existing.entryCount,
        reason: `CAP_REACHED_MAX_ENTRIES_${this.maxEntriesPerToken}`,
      };
    }

    if (existing.totalStakeUsd + this.stakePerEntryUsd > this.maxTotalStakeUsd + 0.001) {
      return {
        canEnter: false,
        stakeUsd: 0,
        entryNum: existing.entryCount,
        reason: `CAP_REACHED_MAX_STAKE_$${this.maxTotalStakeUsd}`,
      };
    }

    return {
      canEnter: true,
      stakeUsd: this.stakePerEntryUsd,
      entryNum: existing.entryCount + 1,
      reason: `ACCUMULATE_ENTRY_${existing.entryCount + 1}`,
    };
  }

  /**
   * Catat eksekusi BUY bot setelah quote swap route berhasil didapat.
   */
  public recordBuyExecution(
    signal: WalletTradeSignal,
    stakeUsd: number,
    tokensBought: number,
    executionPriceUsd: number
  ): FollowerPosition {
    let pos = this.positions.get(signal.mint);

    if (!pos || pos.status === 'CLOSED') {
      pos = {
        mint: signal.mint,
        symbol: signal.symbol || 'UNKNOWN',
        tokenName: signal.tokenName || '',
        openedAt: signal.timestamp || Date.now(),
        updatedAt: signal.timestamp || Date.now(),
        entryCount: 1,
        totalStakeUsd: stakeUsd,
        remainingCostBasisUsd: stakeUsd,
        totalTokens: tokensBought,
        avgEntryPriceUsd: executionPriceUsd > 0 ? executionPriceUsd : (tokensBought > 0 ? stakeUsd / tokensBought : 0),
        lastObservedPriceUsd: executionPriceUsd,
        lastObservedTargetHolding: signal.remainingHolding,
        realizedPnlUsd: 0,
        status: 'OPEN',
        entries: [
          {
            entryNum: 1,
            stakeUsd,
            tokensBought,
            priceUsd: executionPriceUsd,
            txHash: signal.txHash,
            timestamp: signal.timestamp || Date.now(),
          },
        ],
        exits: [],
      };
      this.positions.set(signal.mint, pos);
    } else {
      const newEntryNum = pos.entryCount + 1;
      pos.entryCount = newEntryNum;
      pos.totalStakeUsd += stakeUsd;
      pos.remainingCostBasisUsd += stakeUsd;
      pos.totalTokens += tokensBought;
      pos.avgEntryPriceUsd = pos.totalTokens > 0 ? pos.remainingCostBasisUsd / pos.totalTokens : pos.avgEntryPriceUsd;
      pos.lastObservedPriceUsd = executionPriceUsd;
      pos.lastObservedTargetHolding = signal.remainingHolding;
      pos.updatedAt = signal.timestamp || Date.now();
      pos.entries.push({
        entryNum: newEntryNum,
        stakeUsd,
        tokensBought,
        priceUsd: executionPriceUsd,
        txHash: signal.txHash,
        timestamp: signal.timestamp || Date.now(),
      });
    }

    this.saveState();
    return pos;
  }

  /**
   * Evaluasi sinyal SELL dari target wallet.
   * Menghitung rasio penjualan target dan jumlah token bot yang harus dijual.
   */
  public evaluateSellSignal(signal: WalletTradeSignal): {
    canSell: boolean;
    sellRatioPct: number;
    botTokensToSell: number;
    isFullExit: boolean;
    reason: string;
  } {
    const pos = this.positions.get(signal.mint);
    if (!pos || pos.status !== 'OPEN' || pos.totalTokens <= 0) {
      return {
        canSell: false,
        sellRatioPct: 0,
        botTokensToSell: 0,
        isFullExit: false,
        reason: 'NO_OPEN_POSITION',
      };
    }

    // Formula matematis rasio jual target:
    // Saldo target sebelum jual = sisa saldo sesudah jual + jumlah yang dijual
    const targetSold = signal.tokenAmount;
    const targetRemaining = signal.remainingHolding;
    const targetBefore = targetRemaining + targetSold;

    let sellRatio = 1.0;
    let isFullExit = false;

    if (targetBefore > 0) {
      sellRatio = Math.min(1.0, Math.max(0.0, targetSold / targetBefore));
    }

    // Jika target menyisakan dust (sisa token < 0.1% atau < 100 token) atau menjual >= 99%
    if (sellRatio >= 0.99 || targetRemaining < 100 || (targetBefore > 0 && targetRemaining / targetBefore < 0.005)) {
      sellRatio = 1.0;
      isFullExit = true;
    }

    const botTokensToSell = isFullExit ? pos.totalTokens : pos.totalTokens * sellRatio;

    return {
      canSell: botTokensToSell > 0,
      sellRatioPct: Number((sellRatio * 100).toFixed(2)),
      botTokensToSell,
      isFullExit,
      reason: isFullExit ? 'TARGET_FULL_EXIT' : `TARGET_PARTIAL_EXIT_${(sellRatio * 100).toFixed(1)}%`,
    };
  }

  /**
   * Catat eksekusi SELL bot setelah quote swap route berhasil didapat.
   */
  public recordSellExecution(
    signal: WalletTradeSignal,
    tokensSold: number,
    usdReceived: number,
    executionPriceUsd: number,
    isFullExit: boolean
  ): { position: FollowerPosition; exitRecord: FollowerExit } | null {
    const pos = this.positions.get(signal.mint);
    if (!pos || pos.status !== 'OPEN') return null;

    // Kalkulasi cost basis proporsional untuk token yang dijual
    const sellPortionOfRemaining = pos.totalTokens > 0 ? Math.min(1.0, tokensSold / pos.totalTokens) : 1.0;
    const costBasisPortion = pos.remainingCostBasisUsd * sellPortionOfRemaining;
    const pnlUsd = usdReceived - costBasisPortion;
    const roiPct = costBasisPortion > 0 ? (pnlUsd / costBasisPortion) * 100 : 0;

    const targetSold = signal.tokenAmount;
    const targetRemaining = signal.remainingHolding;
    const targetBefore = targetRemaining + targetSold;
    const sellRatioPct = targetBefore > 0 ? (targetSold / targetBefore) * 100 : 100;

    const exitRecord: FollowerExit = {
      targetSold,
      targetRemaining,
      sellRatioPct: Number(sellRatioPct.toFixed(2)),
      tokensSold,
      usdReceived,
      priceUsd: executionPriceUsd,
      pnlUsd: Number(pnlUsd.toFixed(4)),
      roiPct: Number(roiPct.toFixed(2)),
      isFullExit,
      txHash: signal.txHash,
      timestamp: signal.timestamp || Date.now(),
    };

    pos.exits.push(exitRecord);
    pos.realizedPnlUsd = Number((pos.realizedPnlUsd + pnlUsd).toFixed(4));
    pos.remainingCostBasisUsd = Number(Math.max(0, pos.remainingCostBasisUsd - costBasisPortion).toFixed(4));
    pos.totalTokens = Math.max(0, pos.totalTokens - tokensSold);
    pos.lastObservedPriceUsd = executionPriceUsd;
    pos.lastObservedTargetHolding = signal.remainingHolding;
    pos.updatedAt = signal.timestamp || Date.now();

    if (isFullExit || pos.totalTokens <= 0.000001) {
      pos.status = 'CLOSED';
      pos.totalTokens = 0;
      pos.remainingCostBasisUsd = 0;
      this.archiveClosedTrade(pos);
    }

    this.saveState();
    return { position: pos, exitRecord };
  }

  /**
   * Update live price token dari WebSocket token_stat tick.
   */
  public updateTokenTick(mint: string, currentPriceUsd: number): void {
    const pos = this.positions.get(mint);
    if (pos && pos.status === 'OPEN' && currentPriceUsd > 0) {
      pos.lastObservedPriceUsd = currentPriceUsd;
    }
  }

  private archiveClosedTrade(pos: FollowerPosition): void {
    try {
      const dir = path.dirname(this.tradesFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      let closedList: FollowerPosition[] = [];
      if (fs.existsSync(this.tradesFilePath)) {
        try {
          closedList = JSON.parse(fs.readFileSync(this.tradesFilePath, 'utf8'));
        } catch {
          closedList = [];
        }
      }
      closedList.push(pos);
      fs.writeFileSync(this.tradesFilePath, JSON.stringify(closedList, null, 2), 'utf8');
    } catch (err: any) {
      console.error(`[FOLLOWER-STORAGE-ERR] Gagal arsip closed trade: ${err?.message}`);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.positionsFilePath)) {
        const raw = fs.readFileSync(this.positionsFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.mint) this.positions.set(item.mint, item);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[FOLLOWER-LOAD-WARN] Gagal membaca state awal: ${err?.message}`);
    }
  }

  public saveState(): void {
    try {
      const dir = path.dirname(this.positionsFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const all = Array.from(this.positions.values());
      fs.writeFileSync(this.positionsFilePath, JSON.stringify(all, null, 2), 'utf8');
    } catch (err: any) {
      console.error(`[FOLLOWER-SAVE-ERR] Gagal simpan state posisi: ${err?.message}`);
    }
  }
}
