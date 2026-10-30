import * as fs from 'node:fs';
import * as path from 'node:path';
import { WalletTradeSignal } from './wallet-follower-lane.js';

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
  realizedPnlUsd: number;
  roiPct: number;
  exitReason: string;
  isWin: boolean;
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
  tokens?: number;
  priceUsd: number;
  pnlUsd?: number;
  availableCashAfter: number;
  investedCashAfter: number;
  reason: string;
}

export interface ScenarioState {
  id: 'SCENARIO_1_STATIC_2USD' | 'SCENARIO_2_DYNAMIC_V1' | 'SCENARIO_3_DYNAMIC_V2';
  name: string;
  description: string;
  initialCash: number;
  availableCash: number;
  investedCash: number;
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
  private maxPool: number = 20.0;

  public scenarios: {
    s1: ScenarioState;
    s2: ScenarioState;
    s3: ScenarioState;
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data');
    this.filePath = path.join(this.dataDir, 'dryrun-3scenarios-live.json');

    this.scenarios = this.loadState();
  }

  private initFreshScenarios(): { s1: ScenarioState; s2: ScenarioState; s3: ScenarioState } {
    return {
      s1: {
        id: 'SCENARIO_1_STATIC_2USD',
        name: 'Skenario 1: Full Follower Statis $2',
        description: 'Modal Pool $20. Setiap Buy statis $2.00, Sell proporsional persis target.',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 20.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s2: {
        id: 'SCENARIO_2_DYNAMIC_V1',
        name: 'Skenario 2: Dynamic V1 ($1 Flat, Max $5 / Token)',
        description: 'Modal Pool $20. Max $5 per token, setiap buy $1.00 flat, Sell proporsional.',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 20.0,
        wins: 0,
        losses: 0,
        totalTrades: 0,
        winRate: 0.0,
        openPositions: [],
        closedTrades: [],
        recentEvents: [],
      },
      s3: {
        id: 'SCENARIO_3_DYNAMIC_V2',
        name: 'Skenario 3: Dynamic V2 ($1 - $5 Bertingkat, Pool $20)',
        description: 'Modal Pool $20. Buy bertingkat $1-$5 mengikuti ukuran target, Sell proporsional.',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        realizedPnl: 0.0,
        unrealizedPnl: 0.0,
        totalPortfolioValue: 20.0,
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

  private loadState(): { s1: ScenarioState; s2: ScenarioState; s3: ScenarioState } {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.s1 && parsed.s2 && parsed.s3) {
          return parsed;
        }
      } catch {}
    }
    return this.initFreshScenarios();
  }

  public saveState(): void {
    try {
      const now = Date.now();
      // Recalculate totals
      for (const s of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3]) {
        s.investedCash = s.openPositions.reduce((acc, p) => acc + p.costBasisUsd, 0);
        s.unrealizedPnl = s.openPositions.reduce((acc, p) => acc + p.unrealizedPnlUsd, 0);
        s.totalPortfolioValue = Number((s.availableCash + s.investedCash + s.unrealizedPnl).toFixed(2));
        s.winRate = s.totalTrades > 0 ? Number(((s.wins / s.totalTrades) * 100).toFixed(1)) : 0.0;
      }

      fs.writeFileSync(this.filePath, JSON.stringify(this.scenarios, null, 2), 'utf8');
    } catch (err: any) {
      console.warn(`[DRYRUN-ENGINE-SAVE-WARN] ${err?.message}`);
    }
  }

  /**
   * Helper: Hitung ukuran beli bertingkat untuk Skenario 3
   */
  private getTieredStake(targetUsd: number): number {
    if (targetUsd >= 200) return 5.0;
    if (targetUsd >= 150) return 4.0;
    if (targetUsd >= 100) return 3.0;
    if (targetUsd >= 50) return 2.0;
    return 1.0;
  }

  /**
   * Tangani aktivitas Target BUY secara simultan di 3 skenario
   */
  public handleTargetBuy(
    signal: WalletTradeSignal,
    isGroundZero: boolean
  ): void {
    const now = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(now);
    const targetUsd = signal.usdAmount > 0 ? signal.usdAmount : (signal.solAmount * 100);

    // 1. Proses Skenario 1 (Statis $2, Pool $20)
    this.processScenarioBuy(this.scenarios.s1, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: 20.0,
      getStake: () => 2.0,
    });

    // 2. Proses Skenario 2 (Dynamic V1: $1 Flat, Max $5/token, Pool $20)
    this.processScenarioBuy(this.scenarios.s2, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: 5.0,
      getStake: () => 1.0,
    });

    // 3. Proses Skenario 3 (Dynamic V2: $1-$5 Bertingkat, Pool $20)
    this.processScenarioBuy(this.scenarios.s3, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: 20.0,
      getStake: (tUsd) => this.getTieredStake(tUsd),
    });

    this.saveState();
  }

  private processScenarioBuy(
    scenario: ScenarioState,
    signal: WalletTradeSignal,
    isGroundZero: boolean,
    targetUsd: number,
    now: number,
    timeWib: string,
    rules: { maxTokenExposure: number; getStake: (tUsd: number) => number }
  ): void {
    const pIn = signal.priceUsd;
    if (pIn <= 0) return;

    let pos = scenario.openPositions.find(p => p.mint === signal.mint);

    // Jika posisi belum ada: wajib Ground Zero (First Buy dari saldo 0)
    if (!pos) {
      if (!isGroundZero) {
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
          reason: 'REJECT_MID_FLIGHT (Target held tokens before)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      // Cek ketersediaan kas di pool $20
      if (scenario.availableCash < 1.0) {
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
          reason: 'CASH_POOL_EXHAUSTED (Sisa kas < $1.00)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      const desiredStake = rules.getStake(targetUsd);
      const actualStake = Math.min(scenario.availableCash, Math.min(rules.maxTokenExposure, desiredStake));
      if (actualStake < 1.0) return;

      const tokensBought = actualStake / pIn;
      scenario.availableCash = Number((scenario.availableCash - actualStake).toFixed(2));

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
        tokens: tokensBought,
        priceUsd: pIn,
        availableCashAfter: scenario.availableCash,
        investedCashAfter: scenario.investedCash + actualStake,
        reason: `ENTRY_1 (Target ~$${targetUsd.toFixed(0)})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
      return;
    }

    // Jika posisi sudah ada: Akumulasi Buy
    const remTokenCap = Math.max(0, rules.maxTokenExposure - pos.costBasisUsd);
    if (remTokenCap < 1.0 || scenario.availableCash < 1.0) {
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
    const actualStake = Math.min(scenario.availableCash, Math.min(remTokenCap, desiredStake));
    if (actualStake < 1.0) return;

    const addedTokens = actualStake / pIn;
    scenario.availableCash = Number((scenario.availableCash - actualStake).toFixed(2));

    pos.tokens += addedTokens;
    pos.costBasisUsd += actualStake;
    pos.entryCount += 1;
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
      tokens: addedTokens,
      priceUsd: pIn,
      availableCashAfter: scenario.availableCash,
      investedCashAfter: scenario.investedCash + actualStake,
      reason: `ACCUMULATE_${pos.entryCount} (Target ~$${targetUsd.toFixed(0)})`,
    });
    if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
  }

  /**
   * Tangani aktivitas Target SELL secara simultan di 3 skenario
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

    for (const scenario of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx === -1) continue;

      const pos = scenario.openPositions[posIdx];
      if (pos.tokens <= 0) continue;

      const tokensToSell = pos.tokens * sellRatio;
      const usdReceived = tokensToSell * pOut;
      const costBasisSold = pos.costBasisUsd * sellRatio;
      const pnlUsd = usdReceived - costBasisSold;

      scenario.availableCash = Number((scenario.availableCash + usdReceived).toFixed(2));
      scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

      pos.tokens -= tokensToSell;
      pos.costBasisUsd = Math.max(0, pos.costBasisUsd - costBasisSold);
      pos.realizedPnlUsd += pnlUsd;
      pos.lastPriceUsd = pOut;
      pos.updatedAt = now;

      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'SELL',
        symbol: signal.symbol,
        mint: signal.mint,
        usdReceived: Number(usdReceived.toFixed(2)),
        tokens: tokensToSell,
        priceUsd: pOut,
        pnlUsd: Number(pnlUsd.toFixed(2)),
        availableCashAfter: scenario.availableCash,
        investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
        reason: isFullExit ? 'FULL_EXIT_100%' : `PARTIAL_SELL_${(sellRatio * 100).toFixed(1)}%`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Jika Full Exit atau koin habis
      if (isFullExit || pos.tokens < 10 || pos.costBasisUsd < 0.05) {
        scenario.openPositions.splice(posIdx, 1);
        const totalInvested = pos.costBasisUsd + costBasisSold;
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
          realizedPnlUsd: Number(pos.realizedPnlUsd.toFixed(2)),
          roiPct: Number(roi.toFixed(1)),
          exitReason: isFullExit ? 'TARGET_FULL_EXIT' : 'POSITION_CLOSED',
          isWin,
        });
        if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
      }
    }

    this.saveState();
  }

  /**
   * Update unrealized PnL saat harga berubah
   */
  public updatePriceTick(mint: string, priceUsd: number): void {
    if (priceUsd <= 0) return;
    let changed = false;

    for (const scenario of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3]) {
      const pos = scenario.openPositions.find(p => p.mint === mint);
      if (pos) {
        pos.lastPriceUsd = priceUsd;
        const curVal = pos.tokens * priceUsd;
        pos.unrealizedPnlUsd = Number((curVal - pos.costBasisUsd).toFixed(2));
        changed = true;
      }
    }

    if (changed) {
      this.saveState();
    }
  }
}
