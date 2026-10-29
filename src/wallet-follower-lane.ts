import fs from 'node:fs';
import path from 'node:path';

export interface ComparisonEvent {
  id: string;
  timestamp: number;
  timeWib: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  target: {
    action: 'BUY' | 'SELL';
    tokenAmount: number;
    tokenAmountFormatted: string;
    usdAmount: number;
    priceUsd: number;
    remainingHolding: number;
    remainingHoldingFormatted: string;
    sellRatioPct?: number;
    txHash: string;
  };
  bot: {
    action: 'BUY' | 'SELL' | 'HOLD_MAX_CAP' | 'SKIP_NO_POSITION';
    entryNum?: number;
    stakeUsd?: number;
    tokensBoughtOrSold: number;
    tokensFormatted: string;
    executionPriceUsd: number;
    swapAmm?: {
      inAmount: string;
      outAmount: string;
      exchange?: string;
      priceImpactPct?: number | string;
    } | null;
    pnlUsd?: number;
    roiPct?: number;
    isFullExit?: boolean;
    positionStatus: 'OPEN' | 'CLOSED';
    reason: string;
  };
}

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
  stage1Exited?: boolean;
  peakTargetHolding?: number;
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
  isOpenOrClose?: boolean;
  isFirstBuy?: boolean;
}

export interface FollowerLaneConfig {
  targetWallet: string;
  stakePerEntryUsd?: number; // default $2.0
  maxCapitalExposureUsd?: number; // default $20.0 (bebas beli sampai modal habis, ~8-10 buy bersamaan tanpa sell)
  onlyNewTokens?: boolean; // default true: hanya ikuti saat target mulai beli token baru dari 0
  positionsFilePath?: string;
  tradesFilePath?: string;
  eventsFilePath?: string;
}

export class WalletFollowerLane {
  public readonly targetWallet: string;
  public stakePerEntryUsd: number;
  public maxCapitalExposureUsd: number;
  public readonly onlyNewTokens: boolean;
  private positionsFilePath: string;
  private tradesFilePath: string;
  private eventsFilePath: string;

  // Active positions keyed by mint
  private positions = new Map<string, FollowerPosition>();
  private events: ComparisonEvent[] = [];

  constructor(config: FollowerLaneConfig) {
    this.targetWallet = config.targetWallet;
    this.stakePerEntryUsd = config.stakePerEntryUsd ?? 2.0;
    this.maxCapitalExposureUsd = config.maxCapitalExposureUsd ?? 20.0;
    this.onlyNewTokens = config.onlyNewTokens ?? true;
    this.positionsFilePath = config.positionsFilePath || path.resolve(process.cwd(), 'data/wallet-follower-positions.json');
    this.tradesFilePath = config.tradesFilePath || path.resolve(process.cwd(), 'data/wallet-follower-trades.json');
    this.eventsFilePath = config.eventsFilePath || path.resolve(process.cwd(), 'data/wallet-follower-events.json');

    this.loadState();
  }

  public setStakePerEntryUsd(stake: number): void {
    if (typeof stake === 'number' && stake > 0) {
      this.stakePerEntryUsd = stake;
      this.maxCapitalExposureUsd = stake * 10;
    }
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
  public evaluateBuySignal(signal: WalletTradeSignal, opts?: { isFreshToken?: boolean; tokenAgeMinutes?: number | null }): {
    canEnter: boolean;
    stakeUsd: number;
    entryNum: number;
    reason: string;
  } {
    const existing = this.positions.get(signal.mint);

    if (!existing || existing.status === 'CLOSED') {
      // Hitung saldo target sebelum transaksi buy ini
      const targetBalanceBefore = Math.max(0, signal.remainingHolding - signal.tokenAmount);
      const isGroundZero = (signal.isFirstBuy === true) || (targetBalanceBefore <= 0.05 * signal.tokenAmount || targetBalanceBefore <= 1000);
      
      // Jika mode onlyNewTokens aktif:
      // 1. Tolak jika umur koin diketahui dan sudah tua (> 10 menit)
      if (this.onlyNewTokens && typeof opts?.tokenAgeMinutes === 'number' && opts.tokenAgeMinutes > 10) {
        return {
          canEnter: false,
          stakeUsd: 0,
          entryNum: 0,
          reason: `REJECT_OLD_TOKEN_AGE_${Math.round(opts.tokenAgeMinutes)}M (Batas token baru: <= 10m)`,
        };
      }

      // 2. Wajib MUTLAK Ground Zero & First Buy
      // Jika GMGN memberi tahu ini BUKAN First Buy (ooc === 0 / Buy More) ATAU target sudah pegang barang sebelumnya -> TOLAK!
      if (signal.isFirstBuy === false || !isGroundZero) {
        return {
          canEnter: false,
          stakeUsd: 0,
          entryNum: 0,
          reason: `REJECT_PRE_EXISTING_BAG_MID_FLIGHT (Target held ${Math.round(targetBalanceBefore).toLocaleString()} tokens before | isFirstBuy: ${signal.isFirstBuy ?? 'unknown'})`,
        };
      }

      return {
        canEnter: true,
        stakeUsd: this.stakePerEntryUsd,
        entryNum: 1,
        reason: 'NEW_TOKEN_FRESH_ENTRY_1',
      };
    }

    // Untuk akumulasi (posisi yang sudah terbuka):
    // Tolak akumulasi baru jika umur token sudah melebihi 10 menit ("hanya lakukan buy jika dibawah 10 menit")
    if (typeof opts?.tokenAgeMinutes === 'number' && opts.tokenAgeMinutes > 10) {
      return {
        canEnter: false,
        stakeUsd: 0,
        entryNum: existing.entryCount,
        reason: `REJECT_ACCUMULATE_TOKEN_AGE_${Math.round(opts.tokenAgeMinutes)}M (Hanya buy jika umur token <= 10m)`,
      };
    }

    // Sistem Modal Kas $20 (Rotating Capital Pool):
    // Cek apakah modal aktif yang sedang tertahan (remaining cost basis) + stake $2.0 melebihi plafon modal $20
    const nextCostBasis = existing.remainingCostBasisUsd + this.stakePerEntryUsd;
    if (nextCostBasis > this.maxCapitalExposureUsd + 0.001) {
      return {
        canEnter: false,
        stakeUsd: 0,
        entryNum: existing.entryCount,
        reason: `CAPITAL_EXHAUSTED_MAX_EXPOSURE_$${this.maxCapitalExposureUsd} (Modal Tertahan: $${existing.remainingCostBasisUsd.toFixed(2)})`,
      };
    }

    return {
      canEnter: true,
      stakeUsd: this.stakePerEntryUsd,
      entryNum: existing.entryCount + 1,
      reason: `ACCUMULATE_ENTRY_${existing.entryCount + 1} (Eksposur: $${nextCostBasis.toFixed(2)} / $${this.maxCapitalExposureUsd})`,
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
      // Rotasi Modal Paper: Jika ada posisi koin lama yang masih OPEN, tutup agar modal berpindah ke koin baru
      for (const [m, p] of Array.from(this.positions.entries())) {
        if (m !== signal.mint && p.status === 'OPEN') {
          p.status = 'CLOSED';
          p.updatedAt = signal.timestamp || Date.now();
          const exitPrice = p.lastObservedPriceUsd || p.avgEntryPriceUsd;
          const valOut = p.totalTokens * exitPrice;
          const pnl = valOut - p.remainingCostBasisUsd;
          const roi = p.remainingCostBasisUsd > 0 ? (pnl / p.remainingCostBasisUsd) * 100 : 0;
          p.exits.push({
            targetSold: 0,
            targetRemaining: 0,
            sellRatioPct: 100,
            tokensSold: p.totalTokens,
            usdReceived: valOut,
            priceUsd: exitPrice,
            pnlUsd: pnl,
            roiPct: roi,
            isFullExit: true,
            txHash: signal.txHash || 'ROTATION_EXIT',
            timestamp: signal.timestamp || Date.now(),
          });
          p.realizedPnlUsd += pnl;
        }
      }

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
        peakTargetHolding: signal.remainingHolding,
        stage1Exited: false,
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
      pos.peakTargetHolding = Math.max(pos.peakTargetHolding || 0, signal.remainingHolding);
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
   * Evaluasi sinyal SELL dari target wallet (Pendekatan A: Milestone Exit Max 2 Tahap).
   * Menghindari spam transaksi jual eceran (3%, 5%, 7%) yang membakar gas fee Solana.
   * Tahap 1: Jual 50% saat target membuang akumulasi >= 50% barang.
   * Tahap 2: Jual 100% saat target melakukan Full Exit (>= 85% atau sisa 0).
   */
  public evaluateSellSignal(signal: WalletTradeSignal): {
    canSell: boolean;
    sellRatioPct: number;
    botTokensToSell: number;
    isFullExit: boolean;
    milestone: 'NONE' | 'STAGE_1_HALF' | 'STAGE_2_FULL';
    reason: string;
  } {
    const pos = this.positions.get(signal.mint);
    if (!pos || pos.status !== 'OPEN' || pos.totalTokens <= 0) {
      return {
        canSell: false,
        sellRatioPct: 0,
        botTokensToSell: 0,
        isFullExit: false,
        milestone: 'NONE',
        reason: 'NO_OPEN_POSITION',
      };
    }

    const targetSold = signal.tokenAmount;
    const targetRemaining = signal.remainingHolding;
    const targetBefore = targetRemaining + targetSold;
    const peak = Math.max(pos.peakTargetHolding || 0, targetBefore);
    pos.peakTargetHolding = peak;

    const singleDumpRatio = targetBefore > 0 ? targetSold / targetBefore : 1.0;
    const cumulativeDropRatio = peak > 0 ? (peak - targetRemaining) / peak : singleDumpRatio;

    // Milestone 2 (Full Exit):
    // Target menjual >= 85%, saldo sisa target < 15% dari peak, saldo sisa target < 100 token,
    // ATAU koin bot tersisa dust (< 50 token atau sisa cost basis < $0.05 USD)
    const isTargetFullExit =
      targetRemaining < 100 ||
      singleDumpRatio >= 0.85 ||
      (peak > 0 && targetRemaining / peak <= 0.15) ||
      pos.totalTokens < 50 ||
      pos.remainingCostBasisUsd < 0.05;

    if (isTargetFullExit) {
      return {
        canSell: true,
        sellRatioPct: 100,
        botTokensToSell: pos.totalTokens,
        isFullExit: true,
        milestone: 'STAGE_2_FULL',
        reason: 'MILESTONE_2_FULL_EXIT',
      };
    }

    // Milestone 1 (Tahap 1 - Jual 50% saat target buang >= 50% barang):
    if (!pos.stage1Exited && (singleDumpRatio >= 0.49 || cumulativeDropRatio >= 0.49)) {
      const halfTokens = Math.max(1, Math.floor(pos.totalTokens * 0.5));
      return {
        canSell: true,
        sellRatioPct: 50,
        botTokensToSell: halfTokens,
        isFullExit: false,
        milestone: 'STAGE_1_HALF',
        reason: `MILESTONE_1_HALF_EXIT (Target Sold ${(cumulativeDropRatio * 100).toFixed(1)}% >= 50%)`,
      };
    }

    // Abaikan eceran kecil target (< 50%) untuk menghemat 90% gas fee Solana!
    return {
      canSell: false,
      sellRatioPct: 0,
      botTokensToSell: 0,
      isFullExit: false,
      milestone: 'NONE',
      reason: `IGNORE_SMALL_PARTIAL (Target sold ${(cumulativeDropRatio * 100).toFixed(1)}% < 50%, Holding with Target)`,
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
    let pnlUsd = usdReceived - costBasisPortion;
    let roiPct = costBasisPortion > 0.001 ? (pnlUsd / costBasisPortion) * 100 : 0;

    // Normalisasi dust exit: jika transaksi senilai debu mikro (< $0.005 USD)
    if (usdReceived < 0.001 && costBasisPortion < 0.01) {
      pnlUsd = 0;
      roiPct = 0;
    }

    const targetSold = signal.tokenAmount;
    const targetRemaining = signal.remainingHolding;
    const targetBefore = targetRemaining + targetSold;
    const sellRatioPct = isFullExit ? 100 : 50;

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
    pos.stage1Exited = true; // Tandai stage 1 selesai

    if (isFullExit || pos.totalTokens < 1 || pos.remainingCostBasisUsd < 0.01) {
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

  public appendComparisonEvent(event: ComparisonEvent): void {
    this.events.unshift(event);
    if (this.events.length > 250) {
      this.events = this.events.slice(0, 250);
    }
    this.saveEvents();
  }

  public getRecentEvents(limit: number = 100): ComparisonEvent[] {
    return this.events.slice(0, limit);
  }

  private saveEvents(): void {
    try {
      const dir = path.dirname(this.eventsFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.eventsFilePath, JSON.stringify(this.events, null, 2), 'utf8');
    } catch (err: any) {
      console.error(`[FOLLOWER-EVENTS-ERR] Gagal simpan events: ${err?.message}`);
    }
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.positionsFilePath)) {
        const raw = fs.readFileSync(this.positionsFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.totalTokens < 1 || item.remainingCostBasisUsd < 0.01) {
              item.status = 'CLOSED';
              item.totalTokens = 0;
              item.remainingCostBasisUsd = 0;
            }
            if (item.mint) this.positions.set(item.mint, item);
          }
        }
      }
      if (fs.existsSync(this.eventsFilePath)) {
        const rawEv = fs.readFileSync(this.eventsFilePath, 'utf8');
        const parsedEv = JSON.parse(rawEv);
        if (Array.isArray(parsedEv)) {
          this.events = parsedEv;
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
