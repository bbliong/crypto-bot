import * as fs from 'node:fs';
import * as path from 'node:path';
import { WalletTradeSignal } from './wallet-follower-lane.js';
import { readFollowerLiveConfig } from './follower-live-store.js';

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
  initialTokens?: number;
  initialCostBasisUsd?: number;
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

export type ScenarioTradeActionCallback = (
  action: 'BUY' | 'SELL',
  scenarioId: string,
  signal: WalletTradeSignal,
  details: { stakeUsd?: number; tokens?: number; priceUsd: number; reason: string }
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
  public onTradeAction?: ScenarioTradeActionCallback;

  public scenarios: {
    s4: ScenarioState;
    s6: ScenarioState;
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data');
    this.filePath = path.join(this.dataDir, 'dryrun-3scenarios-live.json');

    this.scenarios = this.loadState();
  }

  private initFreshScenarios(): { s4: ScenarioState; s6: ScenarioState } {
    return {
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
      s6: {
        id: 'SCENARIO_6_REDEPLOY_SNIPER',
        name: 'Skenario 6: Re-Deploy Sniper V2 (Split TP 50/50: 5% & 15%)',
        description: 'Saldo Awal $20.00. Pool 1: $5 flat, Pool 2+: $7 flat (Strict 1x Buy). Stage 1: TP 50% di >= 5% (Kunci Modal & Anti-Rug). Stage 2: 50% Tahan >= 15% (Mega Runner).',
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

  private loadState(): { s4: ScenarioState; s6: ScenarioState } {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.s4 || parsed.s6) {
          const fresh = this.initFreshScenarios();
          const s4 = parsed.s4 || fresh.s4;
          const s6 = parsed.s6 || fresh.s6;
          if (s4.totalFeesPaid === undefined) s4.totalFeesPaid = 0.0;
          if (s6.totalFeesPaid === undefined) s6.totalFeesPaid = 0.0;
          return { s4, s6 };
        }
      } catch {}
    }
    return this.initFreshScenarios();
  }

  public saveState(): void {
    try {
      for (const s of [this.scenarios.s4, this.scenarios.s6]) {
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
   * Tangani aktivitas Target BUY secara simultan di skenario s4 dan s6
   */
  public handleTargetBuy(
    signal: WalletTradeSignal,
    isGroundZero: boolean
  ): void {
    const now = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(now);
    const targetUsd = signal.usdAmount > 0 ? signal.usdAmount : (signal.solAmount * 100);

    // Baca konfigurasi stake dinamis (default: S4=$5, S6 Pool1=$5, S6 Pool2=$7)
    let s4Stake = 5.0;
    let s6Pool1 = 5.0;
    let s6Pool2 = 7.0;
    try {
      const cfg = readFollowerLiveConfig(this.dataDir);
      if (cfg.stakeUsdS4) s4Stake = Number(cfg.stakeUsdS4);
      if (cfg.stakeUsdS6Pool1) s6Pool1 = Number(cfg.stakeUsdS6Pool1);
      if (cfg.stakeUsdS6Pool2) s6Pool2 = Number(cfg.stakeUsdS6Pool2);
    } catch {}

    // 1. Skenario 4 (Single Buy Dinamis, HANYA 1x Buy per token, Anti-Akumulasi)
    this.processScenarioBuy(this.scenarios.s4, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s4Stake,
      getStake: () => s4Stake,
      disallowAccumulation: true,
    });

    // 2. Skenario 6 (Re-Deploy Sniper: Pool 1 Dinamis, Pool 2 Dinamis)
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

      // Trigger callback tindakan trade nyata (misal untuk eksekusi/probe GMGN API terukur)
      if (this.onTradeAction) {
        try {
          this.onTradeAction('BUY', scenario.id, signal, {
            stakeUsd: actualStake,
            tokens: tokensBought,
            priceUsd: pIn,
            reason: 'ENTRY_1',
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

    for (const scenario of [this.scenarios.s4, this.scenarios.s6]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx === -1) continue;

      const pos = scenario.openPositions[posIdx];
      if (pos.tokens <= 0) continue;

      // Akumulasi rasio jual target (Anti-Fee-Churning Gate)
      if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
      const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
      pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
      pos.lastTargetSellAt = now;

      // Ambang Batas Exit & Strategi Khusus:
      // - Skenario 6: Split TP 50/50 (Stage 1: TP 50% di >= 5.0% Anti-Rug, Stage 2: 50% Tahan >= 15.0% Mega Runner)
      // - Skenario 4: Single Buy $5 (Standar Full Exit >= 15.0%)

      if (scenario.id === 'SCENARIO_6_REDEPLOY_SNIPER') {
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

    for (const scenario of [this.scenarios.s4, this.scenarios.s6]) {
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
  }

  /**
   * Auto-likuidasi posisi stagnan / terbengkalai (> 25 menit tanpa aktivitas target)
   */
  public checkStagnantPositions(maxAgeMinutes: number = 25): void {
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    let changed = false;

    for (const scenario of [this.scenarios.s4, this.scenarios.s6]) {
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
}
