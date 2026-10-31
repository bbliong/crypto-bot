import * as fs from 'node:fs';
import * as path from 'node:path';
import { WalletTradeSignal } from './wallet-follower-lane.js';

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

  public scenarios: {
    s1: ScenarioState;
    s2: ScenarioState;
    s3: ScenarioState;
    s4: ScenarioState;
    s5: ScenarioState;
    s6: ScenarioState;
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data');
    this.filePath = path.join(this.dataDir, 'dryrun-3scenarios-live.json');

    this.scenarios = this.loadState();
  }

  private initFreshScenarios(): { s1: ScenarioState; s2: ScenarioState; s3: ScenarioState; s4: ScenarioState; s5: ScenarioState; s6: ScenarioState } {
    return {
      s1: {
        id: 'SCENARIO_1_STATIC_2USD',
        name: 'Skenario 1: Full Follower Statis $2',
        description: 'Saldo Awal $20.00. Buy $2.00 statis, Akumulasi Sell >= 15% -> Full Exit 100% (Fee $0.025/swap).',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
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
        description: 'Saldo Awal $20.00. Max $5 per token, buy $1.00 flat, Akumulasi Sell >= 15% -> Full Exit 100% (Fee $0.025/swap).',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
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
        name: 'Skenario 3: Dynamic V2 ($1 - $5 Bertingkat, Saldo Dinamis)',
        description: 'Saldo Awal $20.00 (Dinamis). Buy bertingkat $1-$5, Akumulasi Sell >= 15% -> Full Exit 100% (Fee $0.025/swap).',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
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
      s4: {
        id: 'SCENARIO_4_SINGLE_BUY_5USD',
        name: 'Skenario 4: Single Buy $5 (Hanya 1x Buy)',
        description: 'Saldo Awal $20.00. Hanya 1x Buy $5.00 saat First Buy (Tanpa akumulasi). Akumulasi Sell >= 15% -> Full Exit 100%.',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
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
      s5: {
        id: 'SCENARIO_5_QUICK_EXIT_5PCT',
        name: 'Skenario 5: Quick Exit 5% (Statis $5, Exit >= 5%)',
        description: 'Saldo Awal $20.00. Buy $5.00 statis. Akumulasi Sell >= 5% -> Langsung Full Exit 100% (Anti-Rugpull Dev Kilat).',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
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
      s6: {
        id: 'SCENARIO_6_REDEPLOY_SNIPER',
        name: 'Skenario 6: Re-Deploy Sniper (Pool 1: $5, Pool 2: $7)',
        description: 'Saldo Awal $20.00. Pool #1 beli $5 (Exit >= 5%). Jika dev re-deploy pool #2 nama sama dlm 20m: beli $7 (Exit >= 15% Mega Runner).',
        initialCash: 20.0,
        availableCash: 20.0,
        investedCash: 0.0,
        totalFeesPaid: 0.0,
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

  private loadState(): { s1: ScenarioState; s2: ScenarioState; s3: ScenarioState; s4: ScenarioState; s5: ScenarioState; s6: ScenarioState } {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.s1 && parsed.s2 && parsed.s3) {
          if (parsed.s1.totalFeesPaid === undefined) parsed.s1.totalFeesPaid = 0.0;
          if (parsed.s2.totalFeesPaid === undefined) parsed.s2.totalFeesPaid = 0.0;
          if (parsed.s3.totalFeesPaid === undefined) parsed.s3.totalFeesPaid = 0.0;
          if (!parsed.s4) {
            parsed.s4 = this.initFreshScenarios().s4;
          } else if (parsed.s4.totalFeesPaid === undefined) {
            parsed.s4.totalFeesPaid = 0.0;
          }
          if (!parsed.s5) {
            parsed.s5 = this.initFreshScenarios().s5;
          } else if (parsed.s5.totalFeesPaid === undefined) {
            parsed.s5.totalFeesPaid = 0.0;
          }
          if (!parsed.s6) {
            parsed.s6 = this.initFreshScenarios().s6;
          } else if (parsed.s6.totalFeesPaid === undefined) {
            parsed.s6.totalFeesPaid = 0.0;
          }
          return parsed;
        }
      } catch {}
    }
    return this.initFreshScenarios();
  }

  public saveState(): void {
    try {
      for (const s of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3, this.scenarios.s4, this.scenarios.s5, this.scenarios.s6]) {
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
   * Tangani aktivitas Target BUY secara simultan di 4 skenario
   */
  public handleTargetBuy(
    signal: WalletTradeSignal,
    isGroundZero: boolean
  ): void {
    const now = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(now);
    const targetUsd = signal.usdAmount > 0 ? signal.usdAmount : (signal.solAmount * 100);

    // 1. Skenario 1 (Statis $2, Plafon per token = min(Kas, $20))
    this.processScenarioBuy(this.scenarios.s1, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: Math.min(this.scenarios.s1.availableCash + this.scenarios.s1.investedCash, 20.0),
      getStake: () => 2.0,
    });

    // 2. Skenario 2 (Dynamic V1: $1 Flat, Max $5/token)
    this.processScenarioBuy(this.scenarios.s2, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: 5.0,
      getStake: () => 1.0,
    });

    // 3. Skenario 3 (Dynamic V2: $1-$5 Bertingkat, Saldo Dinamis)
    this.processScenarioBuy(this.scenarios.s3, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: Math.min(this.scenarios.s3.availableCash + this.scenarios.s3.investedCash, 20.0),
      getStake: (tUsd) => this.getTieredStake(tUsd),
    });

    // 4. Skenario 4 (Single Buy $5 Flat, HANYA 1x Buy per token, Anti-Akumulasi)
    this.processScenarioBuy(this.scenarios.s4, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: 5.0,
      getStake: () => 5.0,
      disallowAccumulation: true,
    });

    // 5. Skenario 5 (Quick Exit 5%: Statis $5, Exit di Ambang Batas >= 5%)
    this.processScenarioBuy(this.scenarios.s5, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: Math.min(this.scenarios.s5.availableCash + this.scenarios.s5.investedCash, 20.0),
      getStake: () => 5.0,
    });

    // 6. Skenario 6 (Re-Deploy Sniper: Pool 1: $5, Pool 2: $7)
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

    // Aturan S6: Pool 1 stake $5.00, Pool 2+ stake $7.00
    const s6Stake = gen >= 2 ? 7.0 : 5.0;

    this.processScenarioBuy(this.scenarios.s6, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: Math.min(this.scenarios.s6.availableCash + this.scenarios.s6.investedCash, 20.0),
      getStake: () => s6Stake,
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
    rules: { maxTokenExposure: number; getStake: (tUsd: number) => number; disallowAccumulation?: boolean }
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

      // Cek ketersediaan kas di pool (wajib cukup stake + fee $0.025)
      if (scenario.availableCash < 1.0 + REAL_SWAP_FEE_USD) {
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
          reason: 'CASH_EXHAUSTED (Sisa kas < $1.00 + fee)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      const desiredStake = rules.getStake(targetUsd);
      const maxAffordableStake = Math.max(0, scenario.availableCash - REAL_SWAP_FEE_USD);
      const actualStake = Math.min(maxAffordableStake, Math.min(rules.maxTokenExposure, desiredStake));
      if (actualStake < 1.0) return;

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
        reason: `ENTRY_1 (Target ~$${targetUsd.toFixed(0)} | Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
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
    if (remTokenCap < 1.0 || scenario.availableCash < 1.0 + REAL_SWAP_FEE_USD) {
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
    if (actualStake < 1.0) return;

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

    for (const scenario of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3, this.scenarios.s4, this.scenarios.s5, this.scenarios.s6]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx === -1) continue;

      const pos = scenario.openPositions[posIdx];
      if (pos.tokens <= 0) continue;

      // Akumulasi rasio jual target (Anti-Fee-Churning Gate)
      if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
      const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
      pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));

      // Ambang Batas Exit:
      // - Skenario 5: Quick Exit >= 5.0%
      // - Skenario 6: Adaptif (Pool #1 Exit >= 5.0%, Pool #2+ Exit >= 15.0%)
      // - Skenario 1-4: Standar Exit >= 15.0%
      let targetThresholdPct = 15.0;
      if (scenario.id === 'SCENARIO_5_QUICK_EXIT_5PCT') {
        targetThresholdPct = 5.0;
      } else if (scenario.id === 'SCENARIO_6_REDEPLOY_SNIPER') {
        const normSym = (signal.symbol || '').toUpperCase().trim();
        const genInfo = this.tokenGenerations.get(normSym);
        // Jika pool generasi 1 -> exit cepat 5%, jika generasi 2+ -> biarkan runner 15%
        targetThresholdPct = (genInfo && genInfo.generation >= 2) ? 15.0 : 5.0;
      }

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

      // AMBANG BATAS TERCAPAI: Jual Seluruhnya 100% (Instant Full Exit)
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
        symbol: signal.symbol,
        mint: signal.mint,
        usdReceived: netReceived,
        feeUsd: REAL_SWAP_FEE_USD,
        tokens: tokensToSell,
        priceUsd: pOut,
        pnlUsd: pnlUsd,
        availableCashAfter: scenario.availableCash,
        investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
        reason: isFullExit
          ? `FULL_EXIT_100% (Fee: $${REAL_SWAP_FEE_USD})`
          : `CUM_SELL_${pos.targetCumulativeSellRatioPct}%_GTE_${targetThresholdPct}%_FULL_EXIT (Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Tutup posisi 100%
      scenario.openPositions.splice(posIdx, 1);
      const totalInvested = costBasisSold;
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
        exitReason: isFullExit ? 'TARGET_FULL_EXIT' : `CUMULATIVE_SELL_${pos.targetCumulativeSellRatioPct}%_GTE_${targetThresholdPct}%`,
        isWin,
      });
      if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
    }

    this.saveState();
  }

  /**
   * Update unrealized PnL saat harga berubah
   */
  public updatePriceTick(mint: string, priceUsd: number): void {
    if (priceUsd <= 0) return;
    let changed = false;

    for (const scenario of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3, this.scenarios.s4, this.scenarios.s5, this.scenarios.s6]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === mint);
      if (posIdx !== -1) {
        const pos = scenario.openPositions[posIdx];
        pos.lastPriceUsd = priceUsd;
        const curVal = pos.tokens * priceUsd;
        pos.unrealizedPnlUsd = Number((curVal - pos.costBasisUsd).toFixed(2));
        changed = true;

        // Auto Liquidation Gate: Jika harga crash > 95% dari harga entry (Rugpull/Liquidity Drained)
        if (pos.avgEntryPriceUsd > 0 && priceUsd < pos.avgEntryPriceUsd * 0.05) {
          const now = Date.now();
          const timeWib = formatWibDate(now);
          scenario.openPositions.splice(posIdx, 1);
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
            priceUsd,
            pnlUsd: -pos.costBasisUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - pos.costBasisUsd),
            reason: `AUTO_LIQUIDATION_CRASH (Price dropped >95% to $${priceUsd})`,
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
            exitReason: 'AUTO_LIQUIDATION_CRASH (>95% drop / Rugpull)',
            isWin: false,
          });
          if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();
        }
      }
    }

    if (changed) {
      this.saveState();
    }
  }

  /**
   * Auto-likuidasi posisi stagnan / terbengkalai (> 25 menit tanpa aktivitas target)
   */
  public checkStagnantPositions(maxAgeMinutes: number = 25): void {
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    let changed = false;

    for (const scenario of [this.scenarios.s1, this.scenarios.s2, this.scenarios.s3, this.scenarios.s4, this.scenarios.s5, this.scenarios.s6]) {
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
  }
}
