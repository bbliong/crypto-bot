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
  stage1RealUsdReturned?: number;
  initialTokens?: number;
  initialCostBasisUsd?: number;
  boughtAtGenesis?: boolean;
  targetEnteredAt?: number;
  pairAddress?: string;
  exchange?: string;
  waitingBuybackSince?: number;
  peakGainPct?: number;
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
  stage1RealUsdReturned?: number;
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

export interface Gen2CycleState {
  mint: string;
  symbol: string;
  pairAddress: string;
  exchange: string;
  devWallet: string;
  cycleCount: number; // 1 s/d 5
  maxCycles: number; // default 5
  lastExitAt: number;
  lastExitPrice: number;
  lastExitReason: string;
  lastTradeProfitable: boolean;
  status: 'COOLDOWN' | 'HOLDING' | 'TERMINATED';
  cooldownUntil: number; // lastExitAt + 60_000
}

export type ScenarioTradeActionCallback = (
  action: 'BUY' | 'SELL',
  scenarioId: string,
  signal: WalletTradeSignal,
  details: { stakeUsd?: number; tokens?: number; priceUsd: number; reason: string; isReEntryCycle?: boolean; cycleIndex?: number }
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
  private gen2CycleTracker: Map<string, Gen2CycleState> = new Map();
  private lastObservedPrices: Map<string, number> = new Map();
  public onTradeAction?: ScenarioTradeActionCallback;

  public scenarios: {
    s4: ScenarioState;
    s5: ScenarioState;
    s6: ScenarioState;
    s7: ScenarioState;
    s8: ScenarioState;
    s9: ScenarioState;
    s10: ScenarioState;
  };

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data');
    this.filePath = path.join(this.dataDir, 'dryrun-3scenarios-live.json');

    this.scenarios = this.loadState();
  }

  private initFreshScenarios(): { s4: ScenarioState; s5: ScenarioState; s6: ScenarioState; s7: ScenarioState; s8: ScenarioState; s9: ScenarioState; s10: ScenarioState } {
    return {
      s4: {
        id: 'SCENARIO_4_SINGLE_BUY_5USD',
        name: 'Skenario 4: 2-Lapis Shakeout Trap (Hold 8s & Dump on Buyback)',
        description: 'Saldo Awal $20.00. 1x Buy Ground Zero. Jika target sell <= 3s (shakeout): tahan hingga 8 detik. Begitu target buyback: LANGSUNG SELL 100% dump ke likuiditas target. Jika tidak buyback dlm 8s -> Safety Exit.',
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
        id: 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER',
        name: 'Skenario 5: Anti-Shakeout Runner (TP +25% | Hold >= 12s | Time-Stop 35s)',
        description: 'Saldo Awal $20.00. Modal $1.00. Abaikan goyangan dump target di 12 detik pertama (Anti-Shakeout). Auto Take-Profit +25%, Time-Stop 35s, atau ikuti sell target jika dump pasca detik 12.',
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
        description: 'Saldo Awal $20.00. Pool 1: $5 saat First Buy. Pool 2: Re-Deploy $7 saat dev rilis pool baru. TP1: Jual 50% di >= 5% (BEP). TP2: Jual 50% di >= 15%.',
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
      s7: {
        id: 'SCENARIO_7_TIME_STOP_SNIPER',
        name: 'Skenario 7: Time-Stop Sniper (Stage 1 @ 5% + Force Sell @ 28s)',
        description: 'Saldo Awal $20.00. Entry First Buy Ground Zero. Stage 1: TP 50% di >= 5% Anti-Rug. Stage 2: Kejar >= 15% ATAU Force Sell 100% tepat di Detik 28 (Puncak Pump) sebelum dev rugpull.',
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
      s8: {
        id: 'SCENARIO_8_FRONTRUN_DEV',
        name: 'Skenario 8: Front-Run Dev & Dump on Target Entry',
        description: 'Saldo Awal $20.00. Buy instan di Detik 0 saat Dev rilis pool baru. Begitu Target masuk beli (15-20 SOL), bot LANGSUNG SELL 100% dump ke likuiditas target!',
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
      s9: {
        id: 'SCENARIO_9_DEV_FRONTRUN_SYNC',
        name: 'Skenario 9: Dev Front-Run & 2-Way Target Sync (Max 60s Timeout)',
        description: 'Saldo Awal $20.00. Modal $1.00. Proaktif Buy di Detik 0 saat Dev rilis pool baru sebelum target whale masuk. Jika target tidak masuk dalam 60s -> Force Sell. Komparasi 2-arah jika target beralih dev.',
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
      s10: {
        id: 'SCENARIO_10_DYNAMIC_WAVE_RUNNER',
        name: 'Skenario 10: Dynamic Wave Runner (Genesis Buy + MCap/Whale Sell Sync)',
        description: 'Saldo Awal $20.00. Modal $0.25. Proaktif Buy di Detik 0 saat Dev rilis pool baru. Tidak buru-buru TP kaku 25% jika whale masih hold koin. Begitu whale mulai dump >= 15% atau time-stop 30s pasca-inflow: LANGSUNG SELL 100% di puncak wave!',
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

  private loadState(): { s4: ScenarioState; s5: ScenarioState; s6: ScenarioState; s7: ScenarioState; s8: ScenarioState; s9: ScenarioState; s10: ScenarioState } {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.s4 || parsed.s5 || parsed.s6 || parsed.s7 || parsed.s8 || parsed.s9 || parsed.s10) {
          const fresh = this.initFreshScenarios();
          const s4 = parsed.s4 || fresh.s4;
          const s5 = parsed.s5 || fresh.s5;
          const s6 = parsed.s6 || fresh.s6;
          const s7 = parsed.s7 || fresh.s7;
          const s8 = parsed.s8 || fresh.s8;
          const s9 = parsed.s9 || fresh.s9;
          const s10 = parsed.s10 || fresh.s10;
          if (s4.totalFeesPaid === undefined) s4.totalFeesPaid = 0.0;
          if (s5.totalFeesPaid === undefined) s5.totalFeesPaid = 0.0;
          if (s6.totalFeesPaid === undefined) s6.totalFeesPaid = 0.0;
          if (s7.totalFeesPaid === undefined) s7.totalFeesPaid = 0.0;
          if (s8.totalFeesPaid === undefined) s8.totalFeesPaid = 0.0;
          if (s9.totalFeesPaid === undefined) s9.totalFeesPaid = 0.0;
          if (s10.totalFeesPaid === undefined) s10.totalFeesPaid = 0.0;
          return { s4, s5, s6, s7, s8, s9, s10 };
        }
      } catch {}
    }
    return this.initFreshScenarios();
  }

  public saveState(): void {
    try {
      for (const s of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9, this.scenarios.s10]) {
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
   * Tangani aktivitas Target BUY secara simultan di skenario s4, s6, dan s7
   */
  public handleTargetBuy(
    signal: WalletTradeSignal,
    isGroundZero: boolean
  ): void {
    const now = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(now);
    const targetUsd = signal.usdAmount > 0 ? signal.usdAmount : (signal.solAmount * 100);

    // Baca konfigurasi stake dinamis (default: semua skenario $1.00)
    let s4Stake = 1.0;
    let s5Stake = 1.0;
    let s6Pool1 = 1.0;
    let s6Pool2 = 1.0;
    let s7Pool1 = 1.0;
    let s7Pool2 = 1.0;
    try {
      const cfg = readFollowerLiveConfig(this.dataDir);
      if (cfg.stakeUsdS4) s4Stake = Number(cfg.stakeUsdS4);
      if (cfg.stakeUsdS5) s5Stake = Number(cfg.stakeUsdS5);
      if (cfg.stakeUsdS6Pool1) s6Pool1 = Number(cfg.stakeUsdS6Pool1);
      if (cfg.stakeUsdS6Pool2) s6Pool2 = Number(cfg.stakeUsdS6Pool2);
      if (cfg.stakeUsdS7Pool1) s7Pool1 = Number(cfg.stakeUsdS7Pool1);
      if (cfg.stakeUsdS7Pool2) s7Pool2 = Number(cfg.stakeUsdS7Pool2);
    } catch {}

    // 1. Skenario 4 (2-Lapis Shakeout Trap: Hold 8s & Dump on Buyback)
    // Cek apakah S4 sedang menunggu buyback pada token ini (Lapis 2: Dump on Buyback)
    const s4PosIdx = this.scenarios.s4.openPositions.findIndex(p => p.mint === signal.mint);
    if (s4PosIdx >= 0) {
      const s4Pos = this.scenarios.s4.openPositions[s4PosIdx];
      if (s4Pos.waitingBuybackSince) {
        const elapsedSinceSell = (now - s4Pos.waitingBuybackSince) / 1000;
        if (elapsedSinceSell <= 8.5) {
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 4 LAPIS 2: DUMP ON BUYBACK] Target Buyback $${targetUsd.toFixed(0)} di +${elapsedSinceSell.toFixed(1)}s!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Aksi     : LANGSUNG SELL 100% Dump ke Likuiditas Buy Target!`);
          console.log(`=========================================================\n`);
          const exitReason = `S4_DUMP_ON_BUYBACK (Target buyback $${targetUsd.toFixed(0)} di +${elapsedSinceSell.toFixed(1)}s pasca-shakeout, panen likuiditas)`;
          this.executeScenarioExit(this.scenarios.s4, s4PosIdx, signal.priceUsd, now, timeWib, exitReason);
        }
      }
    }

    this.processScenarioBuy(this.scenarios.s4, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s4Stake,
      getStake: () => s4Stake,
      disallowAccumulation: true,
    });
    // Auto-rotasi: Setelah buy Mint baru, segera sell 100% posisi lama yang memiliki simbol/nama sama
    this.autoRotateSameSymbolPositions(this.scenarios.s4, signal, now, timeWib);

    // 1b. Skenario 5 (Anti-Shakeout Runner: Hold >= 12s, TP +25%, Time-Stop 35s)
    this.processScenarioBuy(this.scenarios.s5, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s5Stake,
      getStake: () => s5Stake,
      disallowAccumulation: true,
    });
    this.autoRotateSameSymbolPositions(this.scenarios.s5, signal, now, timeWib);

    // 2. Skenario 6 & 7 (Re-Deploy Sniper / Time-Stop: Pool 1 Dinamis, Pool 2 Dinamis)
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
    // Auto-rotasi: Setelah buy Mint baru, segera sell 100% posisi lama yang memiliki simbol/nama sama
    this.autoRotateSameSymbolPositions(this.scenarios.s6, signal, now, timeWib);

    // 3. Skenario 7 (Time-Stop Sniper: Stage 1 @ 5% + Force Sell 100% @ 28s)
    const s7Stake = gen >= 2 ? s7Pool2 : s7Pool1;
    this.processScenarioBuy(this.scenarios.s7, signal, isGroundZero, targetUsd, now, timeWib, {
      maxTokenExposure: s7Stake,
      getStake: () => s7Stake,
      disallowAccumulation: true,
    });
    this.autoRotateSameSymbolPositions(this.scenarios.s7, signal, now, timeWib);

    // Sinkronkan alamat Pool aktif ke posisi yang dipegang:
    // Jika target whale masuk bertransaksi di pool tertentu (signal.pairAddress),
    // seluruh skenario otomatis mengalihkan tujuan SELL ke pool whale tersebut!
    if (signal.pairAddress) {
      for (const sc of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9, this.scenarios.s10]) {
        const p = sc.openPositions.find(pos => pos.mint === signal.mint);
        if (p && p.pairAddress !== signal.pairAddress) {
          console.log(`[DYNAMIC POOL REDIRECTION] 🔄 Mengalihkan pool ${p.symbol} [${sc.id}] dari ${p.pairAddress ? p.pairAddress.slice(0, 8) + '...' : 'none'} ke Pool Whale: ${signal.pairAddress.slice(0, 8)}...`);
          p.pairAddress = signal.pairAddress;
        }
      }
    }

    // 4. Skenario 8 (Front-Run Dev & Hold 20s Post-Target Inflow)
    // Jika S8 memiliki posisi terbuka pada koin ini yang dibeli di Genesis:
    // TARGET SUDAH MASUK (15-20 SOL)! Kurva harga terpompa! Kunci waktu masuk target & tahan hingga 20 detik!
    const s8PosIdx = this.scenarios.s8.openPositions.findIndex(p => p.mint === signal.mint);
    if (s8PosIdx >= 0) {
      const s8Pos = this.scenarios.s8.openPositions[s8PosIdx];
      if (s8Pos.boughtAtGenesis && !s8Pos.targetEnteredAt) {
        s8Pos.targetEnteredAt = now;
        s8Pos.lastPriceUsd = signal.priceUsd;
        console.log(`\n=========================================================`);
        console.log(`🎯 [SCENARIO 8 TARGET INFLOW DETECTED] Target Masuk Beli ${signal.solAmount} SOL!`);
        console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
        console.log(`   Harga In : $${s8Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
        console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);
        console.log(`   Strategi : Tahan posisi selama 20 detik pasca-target masuk untuk maksimalkan profit!`);
        console.log(`=========================================================\n`);
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s8, signal, now, timeWib);

    // 5. Skenario 9: Dev Front-Run & 2-Way Target Sync
    for (let i = this.scenarios.s9.openPositions.length - 1; i >= 0; i--) {
      const s9Pos = this.scenarios.s9.openPositions[i];
      if (s9Pos.mint === signal.mint) {
        if (!s9Pos.targetEnteredAt) {
          s9Pos.targetEnteredAt = now;
          s9Pos.lastPriceUsd = signal.priceUsd;
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 9 TARGET INFLOW DETECTED] Target Whale MASUK ke token Front-Run '${s9Pos.symbol}' ($${targetUsd.toFixed(0)})!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Harga In : $${s9Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
          console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);

          // JIKA MODAL MASUK WHALE KECIL (< $300 atau < 3 SOL): LANGSUNG DUMP SELL 100%!
          // Menyelamatkan cuan di harga pompa whale sebelum whale membanting 2-10 detik kemudian!
          if (targetUsd > 0 && targetUsd < 300) {
            console.log(`   Strategi : ⚡ MICRO-INFLOW HARVEST (Modal whale $${targetUsd.toFixed(0)} < $300, langsung dump jual sebelum whale membanting)!`);
            console.log(`=========================================================\n`);
            const exitReason = `S9_MICRO_WHALE_INFLOW_HARVEST (Whale masuk modal kecil $${targetUsd.toFixed(0)} < $300, langsung dump jual sebelum whale membanting)`;
            this.executeScenarioExit(this.scenarios.s9, i, signal.priceUsd, now, timeWib, exitReason);
            continue;
          }

          console.log(`   Strategi : Mengaktifkan proteksi runner (Anti-Shakeout 12s + Follow Whale Sell)...`);
          console.log(`=========================================================\n`);
        }
      } else {
        // Target beli token lain saat S9 masih nunggu target di token ini!
        if (!s9Pos.targetEnteredAt) {
          console.log(`[SCENARIO 9] ⚠️ Target BERALIH beli '${signal.symbol}'! Mengosongkan posisi koin lama '${s9Pos.symbol}'...`);
          const reason = `TARGET_SWITCHED_DEV (Target beli '${signal.symbol}' bukan '${s9Pos.symbol}', batalkan front-run lama)`;
          this.executeScenarioExit(this.scenarios.s9, i, s9Pos.lastPriceUsd, now, timeWib, reason);
        }
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s9, signal, now, timeWib);

    // 6. Skenario 10: Dynamic Wave Runner (Genesis Buy + MCap/Whale Sell Sync)
    for (let i = this.scenarios.s10.openPositions.length - 1; i >= 0; i--) {
      const s10Pos = this.scenarios.s10.openPositions[i];
      if (s10Pos.mint === signal.mint) {
        if (!s10Pos.targetEnteredAt) {
          s10Pos.targetEnteredAt = now;
          s10Pos.lastPriceUsd = signal.priceUsd;
          console.log(`\n=========================================================`);
          console.log(`🎯 [SCENARIO 10 TARGET INFLOW DETECTED] Target Whale MASUK ke token Front-Run '${s10Pos.symbol}' ($${targetUsd.toFixed(0)})!`);
          console.log(`   Token    : ${signal.symbol} [${signal.mint.slice(0, 8)}...]`);
          console.log(`   Harga In : $${s10Pos.avgEntryPriceUsd.toFixed(8)} (Floor Genesis)`);
          console.log(`   Harga Out: $${signal.priceUsd.toFixed(8)} (Pumped by Target)`);
          console.log(`   Strategi : Dynamic Wave Runner (Tahan selama whale hold & exit saat whale sell >= 15%)...`);
          console.log(`=========================================================\n`);
        }
      } else {
        // Target beli token lain saat S10 masih nunggu target di token ini!
        if (!s10Pos.targetEnteredAt) {
          console.log(`[SCENARIO 10] ⚠️ Target BERALIH beli '${signal.symbol}'! Mengosongkan posisi koin lama '${s10Pos.symbol}'...`);
          const reason = `TARGET_SWITCHED_DEV (Target beli '${signal.symbol}' bukan '${s10Pos.symbol}', batalkan front-run lama)`;
          this.executeScenarioExit(this.scenarios.s10, i, s10Pos.lastPriceUsd, now, timeWib, reason);
        }
      }
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s10, signal, now, timeWib);

    this.saveState();
  }

  /**
   * Eksekusi BUY Proaktif / Dini (SEBELUM Target Buy):
   * Dipanggil saat WebSocket Dev-Radar mendeteksi dev membuat koin baru (Gen 2)!
   */
  public handleEarlyRedeployBuy(
    evt: {
      oldMint: string;
      newMint: string;
      symbol: string;
      ipfsUri?: string;
      devWallet: string;
      signature: string;
      timestamp: number;
      initialMeteoraSol?: number;
      mainExchange?: 'meteora' | 'pumpswap' | 'raydium';
      mainPairAddress?: string;
    },
    customStakeUsd?: number
  ): void {
    const now = evt.timestamp || Date.now();
    const timeWib = formatWibDate(now);

    let pool2Stake = customStakeUsd;
    if (!pool2Stake) {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      pool2Stake = liveCfg.stakeUsdS6Pool2 || 1.0;
    }

    const targetExchange = evt.mainExchange === 'pumpswap' ? 'pump_amm' : (evt.mainExchange || 'meteora_dammv2');

    console.log(`\n=========================================================`);
    console.log(`🚀 [EARLY-BUY RADAR] Mengeksekusi Buy SEBELUM Target Buy:`);
    console.log(`   Token Baru : ${evt.symbol} [${evt.newMint.slice(0, 8)}...]`);
    console.log(`   Exchange   : ${targetExchange} (Pool: ${evt.mainPairAddress ? evt.mainPairAddress.slice(0, 8) + '...' : 'Default'})`);
    console.log(`   Modal S6/S7: $${pool2Stake.toFixed(2)} (Pool 2)`);
    console.log(`   Dev Wallet : ${evt.devWallet}`);
    console.log(`=========================================================\n`);

    const earlySignal: WalletTradeSignal = {
      action: 'buy',
      mint: evt.newMint,
      symbol: evt.symbol,
      tokenName: evt.symbol,
      tokenAmount: 1000000,
      remainingHolding: 1000000,
      solAmount: 15,
      usdAmount: 1380,
      priceUsd: 0.0000096, // estimasi awal ground zero, akan disinkronkan ke kuotasi swap AMM riil
      txHash: evt.signature,
      timestamp: Math.floor(now / 1000),
      isOpenOrClose: true,
      isFirstBuy: true,
      pairAddress: evt.mainPairAddress || '',
      exchange: targetExchange
    };

    // Eksekusi buy di Skenario 6, Skenario 7 & Skenario 8 jika koin re-deploy nama sama (isSameSymbol !== false)
    if (evt.isSameSymbol !== false) {
      if (!this.scenarios.s6.openPositions.some(p => p.mint === evt.newMint)) {
        this.processScenarioBuy(this.scenarios.s6, earlySignal, true, 1380, now, timeWib, {
          maxTokenExposure: pool2Stake,
          getStake: () => pool2Stake,
          disallowAccumulation: true,
        });
        this.autoRotateSameSymbolPositions(this.scenarios.s6, earlySignal, now, timeWib);
        const s6CreatedPos = this.scenarios.s6.openPositions.find(p => p.mint === evt.newMint);
        if (s6CreatedPos) {
          s6CreatedPos.pairAddress = evt.mainPairAddress || '';
          s6CreatedPos.exchange = targetExchange;
        }
      }

      if (!this.scenarios.s7.openPositions.some(p => p.mint === evt.newMint)) {
        this.processScenarioBuy(this.scenarios.s7, earlySignal, true, 1380, now, timeWib, {
          maxTokenExposure: pool2Stake,
          getStake: () => pool2Stake,
          disallowAccumulation: true,
        });
        this.autoRotateSameSymbolPositions(this.scenarios.s7, earlySignal, now, timeWib);
        const s7CreatedPos = this.scenarios.s7.openPositions.find(p => p.mint === evt.newMint);
        if (s7CreatedPos) {
          s7CreatedPos.pairAddress = evt.mainPairAddress || '';
          s7CreatedPos.exchange = targetExchange;
        }
      }

      // Eksekusi buy di Skenario 8 (Front-Run Dev Genesis Nama Sama)
      let s8Stake = customStakeUsd;
      if (!s8Stake) {
        const liveCfg = readFollowerLiveConfig(this.dataDir);
        s8Stake = liveCfg.stakeUsdS8 || 1.0;
      }
      if (!this.scenarios.s8.openPositions.some(p => p.mint === evt.newMint)) {
        this.processScenarioBuy(this.scenarios.s8, earlySignal, true, 1380, now, timeWib, {
          maxTokenExposure: s8Stake,
          getStake: () => s8Stake,
          disallowAccumulation: true,
        });
        const s8CreatedPos = this.scenarios.s8.openPositions.find(p => p.mint === evt.newMint);
        if (s8CreatedPos) {
          s8CreatedPos.boughtAtGenesis = true;
          s8CreatedPos.pairAddress = evt.mainPairAddress || '';
          s8CreatedPos.exchange = targetExchange;
        }
        this.autoRotateSameSymbolPositions(this.scenarios.s8, earlySignal, now, timeWib);
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s8, earlySignal, now, timeWib);

      // Daftarkan koin Gen-2 nama sama ke Multi-Cycle Tracker (Maksimal 5x Siklus)
      const existingGen2 = this.gen2CycleTracker.get(evt.newMint);
      if (!existingGen2) {
        this.gen2CycleTracker.set(evt.newMint, {
          mint: evt.newMint,
          symbol: evt.symbol,
          pairAddress: evt.mainPairAddress || '',
          exchange: targetExchange,
          devWallet: evt.devWallet,
          cycleCount: 1,
          maxCycles: 5,
          lastExitAt: 0,
          lastExitPrice: 0,
          lastExitReason: '',
          lastTradeProfitable: true,
          status: 'HOLDING',
          cooldownUntil: 0,
        });
        console.log(`[GEN2 CYCLE TRACKER] 🔄 Koin Gen-2 '${evt.symbol}' [${evt.newMint.slice(0, 8)}...] terdaftar untuk evaluasi siklus berulang (Maks 5x, Cooldown 1m, Profit-Only)!`);
      }
    }

    // Eksekusi buy di Skenario 9 (Dev Front-Run Bebas Simbol & 2-Way Sync)
    // S9 MEMBELI SEMUA KOIN BARU DARI DEV APAPUN SIMBOLNYA!
    let s9Stake = customStakeUsd;
    if (!s9Stake) {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      s9Stake = liveCfg.stakeUsdS9 || 1.0;
    }
    const closedTradeS9 = this.scenarios.s9.closedTrades.find(t => t.mint === evt.newMint);
    const prevProfitableS9 = !closedTradeS9 || closedTradeS9.realizedPnlUsd >= 0;
    const sameMintTradesS9 = this.scenarios.s9.closedTrades.filter(t => t.mint === evt.newMint).length;
    const allowReEntryS9 = evt.isSameSymbol !== false && prevProfitableS9 && sameMintTradesS9 < 5;

    if (!this.scenarios.s9.openPositions.some(p => p.mint === evt.newMint)) {
      this.processScenarioBuy(this.scenarios.s9, earlySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s9Stake,
        getStake: () => s9Stake,
        disallowAccumulation: true,
        allowReEntryCycle: allowReEntryS9,
        cycleIndex: sameMintTradesS9 + 1,
      });
      const s9CreatedPos = this.scenarios.s9.openPositions.find(p => p.mint === evt.newMint);
      if (s9CreatedPos) {
        s9CreatedPos.boughtAtGenesis = true;
        s9CreatedPos.pairAddress = evt.mainPairAddress || '';
        s9CreatedPos.exchange = targetExchange;
        s9CreatedPos.entryCount = sameMintTradesS9 + 1;
        (s9CreatedPos as any).isSameSymbol = evt.isSameSymbol !== false;
        (s9CreatedPos as any).isPool2 = evt.isSameSymbol !== false || sameMintTradesS9 > 0;
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s9, earlySignal, now, timeWib);
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s9, earlySignal, now, timeWib);

    // Eksekusi buy di Skenario 10 (Dynamic Wave Runner)
    let s10Stake = customStakeUsd;
    if (!s10Stake) {
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      s10Stake = (liveCfg as any).stakeUsdS10 || liveCfg.stakeUsdS9 || 0.25;
    }
    const closedTradeS10 = this.scenarios.s10.closedTrades.find(t => t.mint === evt.newMint);
    const prevProfitableS10 = !closedTradeS10 || closedTradeS10.realizedPnlUsd >= 0;
    const sameMintTradesS10 = this.scenarios.s10.closedTrades.filter(t => t.mint === evt.newMint).length;
    const allowReEntryS10 = evt.isSameSymbol !== false && prevProfitableS10 && sameMintTradesS10 < 5;

    if (!this.scenarios.s10.openPositions.some(p => p.mint === evt.newMint)) {
      this.processScenarioBuy(this.scenarios.s10, earlySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s10Stake,
        getStake: () => s10Stake,
        disallowAccumulation: true,
        allowReEntryCycle: allowReEntryS10,
        cycleIndex: sameMintTradesS10 + 1,
      });
      const s10CreatedPos = this.scenarios.s10.openPositions.find(p => p.mint === evt.newMint);
      if (s10CreatedPos) {
        s10CreatedPos.boughtAtGenesis = true;
        s10CreatedPos.pairAddress = evt.mainPairAddress || '';
        s10CreatedPos.exchange = targetExchange;
        s10CreatedPos.entryCount = sameMintTradesS10 + 1;
        (s10CreatedPos as any).isSameSymbol = evt.isSameSymbol !== false;
        (s10CreatedPos as any).isPool2 = evt.isSameSymbol !== false || sameMintTradesS10 > 0;
      }
      this.autoRotateSameSymbolPositions(this.scenarios.s10, earlySignal, now, timeWib);
    }
    this.autoRotateSameSymbolPositions(this.scenarios.s10, earlySignal, now, timeWib);

    // Auto-rotasi: likuidasi koin lama
    this.autoRotateSameSymbolPositions(this.scenarios.s6, earlySignal, now, timeWib);
    this.saveState();
  }

  private processScenarioBuy(
    scenario: ScenarioState,
    signal: WalletTradeSignal,
    isGroundZero: boolean,
    targetUsd: number,
    now: number,
    timeWib: string,
    rules: { maxTokenExposure: number; getStake: (tUsd: number) => number; disallowAccumulation?: boolean; allowReEntryCycle?: boolean; cycleIndex?: number }
  ): void {
    const pIn = signal.priceUsd;
    if (pIn <= 0) return;

    let pos = scenario.openPositions.find(p => p.mint === signal.mint);

    // Jika posisi belum ada:
    if (!pos) {
      // 0. Strict 1-Cycle-Per-Token Rule: Dilarang keras buy ulang token yang sudah pernah ditradingkan / ada di closedTrades
      // Kecuali jika diizinkan oleh Multi-Cycle Gen-2 Re-Entry (allowReEntryCycle = true)
      const alreadyTraded = scenario.closedTrades.some(t => t.mint === signal.mint);
      if (alreadyTraded && !rules.allowReEntryCycle) {
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
          reason: 'REJECT_ALREADY_TRADED (Limitasi 1 token hanya boleh buy 1 kali, dilarang buy ulang)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      // 1. Wajib First Buy (Ground Zero dari saldo 0) - dilewati jika Re-Entry Cycle
      if (!isGroundZero && !rules.allowReEntryCycle) {
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
          reason: 'REJECT_MID_FLIGHT (Bukan First Buy / Target sudah pegang token)',
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
        return;
      }

      // 2. Filter Anti-Pucuk (Ground-Zero Price Cap): Target First Buy price wajib <= $0.000020 (hanya berlaku saat Genesis awal)
      const GROUND_ZERO_MAX_PRICE_USD = 0.000020;
      if (!rules.allowReEntryCycle && pIn > GROUND_ZERO_MAX_PRICE_USD) {
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
          reason: `REJECT_NON_GROUND_ZERO_PRICE_CAP (First Buy tapi harga pucuk $${pIn.toFixed(7)} > $${GROUND_ZERO_MAX_PRICE_USD.toFixed(6)})`,
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
        pairAddress: signal.pairAddress || '',
        exchange: signal.exchange || '',
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
        reason: rules.allowReEntryCycle ? `GEN2_CYCLE_${rules.cycleIndex || 2}_RE_ENTRY (Fee: $${REAL_SWAP_FEE_USD})` : `ENTRY_1 (Target ~$${targetUsd.toFixed(0)} | Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Trigger callback tindakan trade nyata (misal untuk eksekusi/probe GMGN API terukur)
      if (this.onTradeAction) {
        try {
          this.onTradeAction('BUY', scenario.id, signal, {
            stakeUsd: actualStake,
            tokens: tokensBought,
            priceUsd: pIn,
            reason: rules.allowReEntryCycle ? `GEN2_CYCLE_${rules.cycleIndex || 2}_RE_ENTRY` : 'ENTRY_1',
            isReEntryCycle: Boolean(rules.allowReEntryCycle),
            cycleIndex: rules.cycleIndex,
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
   * Eksekusi Full Exit Bersih untuk suatu posisi di skenario:
   * Menghitung PnL, mencatat closed trade, recent event, dan memanggil callback onTradeAction SELL.
   */
  public executeScenarioExit(
    scenario: ScenarioState,
    posIdx: number,
    exitPriceUsd: number,
    now: number,
    timeWib: string,
    reason: string
  ): void {
    const pos = scenario.openPositions[posIdx];
    if (!pos) return;

    const pOut = exitPriceUsd > 0 ? exitPriceUsd : pos.avgEntryPriceUsd;
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
      symbol: pos.symbol,
      mint: pos.mint,
      usdReceived: netReceived,
      feeUsd: REAL_SWAP_FEE_USD,
      tokens: tokensToSell,
      priceUsd: pOut,
      pnlUsd,
      availableCashAfter: scenario.availableCash,
      investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
      reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
    });
    if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

    scenario.openPositions.splice(posIdx, 1);

    const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? costBasisSold * 2 : costBasisSold);
    const totalInvested = initialInvested;
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
      exitReason: reason,
      isWin,
      stage1RealUsdReturned: pos.stage1RealUsdReturned || 0,
    });
    if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();

    // Update Multi-Cycle Tracker khusus S9:
    if (scenario.id === 'SCENARIO_9_DEV_FRONTRUN_SYNC') {
      const gen2 = this.gen2CycleTracker.get(pos.mint);
      if (gen2) {
        // Toleransi gas fee untuk exit pengaman TARGET_SKIPPED_DEV_POOL (hingga -$0.05)
        const isSafeOrProfitable = pos.realizedPnlUsd >= 0 || (reason.includes('TARGET_SKIPPED_DEV_POOL') && pos.realizedPnlUsd >= -0.05);
        gen2.lastExitAt = now;
        gen2.lastExitPrice = pOut;
        gen2.lastExitReason = reason;
        gen2.lastTradeProfitable = isSafeOrProfitable;

        if (!isSafeOrProfitable) {
          gen2.status = 'TERMINATED';
          console.log(`[GEN2 CYCLE TERMINATED] ⛔ Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] mengalami kerugian nyata (PnL: $${pos.realizedPnlUsd}). Siklus dihentikan permanen!`);
        } else if (gen2.cycleCount >= gen2.maxCycles) {
          gen2.status = 'TERMINATED';
          console.log(`[GEN2 CYCLE FINISHED] 🏁 Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] telah mencapai batas maksimal 5 siklus (${gen2.cycleCount}/${gen2.maxCycles}). Selesai!`);
        } else {
          gen2.status = 'COOLDOWN';
          gen2.cooldownUntil = now + 60000;
          console.log(`\n=========================================================`);
          console.log(`⏳ [GEN2 CYCLE COOLDOWN] Koin ${pos.symbol} [${pos.mint.slice(0, 8)}...] selesai Siklus #${gen2.cycleCount}/${gen2.maxCycles} via '${reason}' (Untung/BEP: +$${pos.realizedPnlUsd})!`);
          console.log(`   Masa Cooldown  : 60 Detik (sampai ${formatWibDate(gen2.cooldownUntil)})`);
          console.log(`   Syarat Siklus Berikutnya: Grafik meningkat (Spot > $${pOut.toFixed(8)}) pasca-cooldown`);
          console.log(`=========================================================\n`);
        }
      }
    }

    if (this.onTradeAction) {
      try {
        const signal: WalletTradeSignal = {
          action: 'sell',
          mint: pos.mint,
          symbol: pos.symbol,
          tokenName: pos.tokenName,
          tokenAmount: tokensToSell,
          remainingHolding: 0,
          solAmount: 0,
          usdAmount: netReceived,
          priceUsd: pOut,
          txHash: '',
          timestamp: Math.floor(now / 1000),
          isOpenOrClose: true,
          isFirstBuy: false,
          pairAddress: pos.pairAddress || '',
          exchange: pos.exchange || '',
        };
        const p = this.onTradeAction('SELL', scenario.id, signal, {
          tokens: tokensToSell,
          priceUsd: pOut,
          reason,
        });
        if (p && typeof p.then === 'function') {
          p.catch(err => console.warn(`[ASYNC-SELL-ACTION-WARN] ${err?.message}`));
        }
      } catch (err: any) {
        console.warn(`[ON-TRADE-ACTION-SELL-ERR] ${err?.message}`);
      }
    }
  }

  /**
   * Auto-Rotasi: Jika target buy token baru (Mint B) dengan simbol/nama yang sama,
   * segera sell 100% posisi lama (Mint A) agar hanya ada 1 token aktif bernama sama.
   * Dijalankan SETELAH buy Mint B selesai dieksekusi agar tidak menahan kecepatan entry buy.
   */
  private autoRotateSameSymbolPositions(
    scenario: ScenarioState,
    newSignal: WalletTradeSignal,
    now: number,
    timeWib: string
  ): void {
    const newSym = (newSignal.symbol || '').trim().toUpperCase();
    const newName = (newSignal.tokenName || '').trim().toUpperCase();
    if (!newSym && !newName) return;

    // Cari posisi lama yang berbeda dengan mint yang baru dibeli
    const staleIndices: number[] = [];
    for (let i = 0; i < scenario.openPositions.length; i++) {
      const p = scenario.openPositions[i];
      if (p.mint === newSignal.mint) continue;
      staleIndices.push(i);
    }

    if (staleIndices.length === 0) return;

    // Urutkan dari indeks terbesar ke terkecil agar splice aman
    staleIndices.sort((a, b) => b - a);

    for (const idx of staleIndices) {
      const pos = scenario.openPositions[idx];
      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
      const tokensToSell = pos.tokens;
      const costBasisSold = pos.costBasisUsd;

      // Estimasi USD kembali
      const grossReceived = tokensToSell * pOut;
      const netReceived = Math.max(0, grossReceived - REAL_SWAP_FEE_USD);
      const pnlUsd = netReceived - costBasisSold;

      const pSym = (pos.symbol || '').trim().toUpperCase();
      const pName = (pos.tokenName || '').trim().toUpperCase();
      const isSameSymbol = (newSym && pSym && newSym === pSym) || (newName && pName && newName === pName);

      const exitReason = isSameSymbol
        ? `AUTO_ROTATION_SAME_NAME (Target buy kontrak baru '${newSignal.symbol}' [${newSignal.mint.slice(0, 8)}...])`
        : (scenario.id === 'SCENARIO_8_FRONTRUN_DEV'
            ? `TARGET_SKIPPED_FOR_ANOTHER_COIN (Dev deploy pool '${pos.symbol}' tapi Target malah beli '${newSignal.symbol}', likuidasi S8)`
            : `AUTO_LIQUIDATE_TARGET_MOVED (Target berpindah beli koin baru '${newSignal.symbol}' [${newSignal.mint.slice(0, 8)}...], likuidasi '${pos.symbol}')`);

      pos.realizedPnlUsd = Number((pos.realizedPnlUsd + pnlUsd).toFixed(2));
      pos.feesPaidUsd = Number((pos.feesPaidUsd + REAL_SWAP_FEE_USD).toFixed(3));
      scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
      scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));

      scenario.recentEvents.unshift({
        id: `ev_${now}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: now,
        timeWib,
        scenarioId: scenario.id,
        action: 'SELL',
        symbol: pos.symbol,
        mint: pos.mint,
        usdReceived: Number(netReceived.toFixed(2)),
        feeUsd: REAL_SWAP_FEE_USD,
        tokens: tokensToSell,
        priceUsd: pOut,
        pnlUsd: Number(pnlUsd.toFixed(2)),
        availableCashAfter: scenario.availableCash,
        investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
        reason: `${exitReason} (Fee: $${REAL_SWAP_FEE_USD})`,
      });
      if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

      // Hapus dari open positions
      scenario.openPositions.splice(idx, 1);

      const totalInvested = pos.initialCostBasisUsd || costBasisSold;
      const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
      const isWin = pos.realizedPnlUsd >= 0;

      if (isWin) scenario.wins += 1;
      else scenario.losses += 1;
      scenario.totalTrades += 1;

      // Pindahkan ke closedTrades
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

      // Trigger callback SELL untuk eksekusi swap riil / burn & reclaim rent
      if (this.onTradeAction) {
        try {
          const oldSignal: WalletTradeSignal = {
            action: 'sell',
            mint: pos.mint,
            symbol: pos.symbol,
            tokenName: pos.tokenName,
            tokenAmount: tokensToSell,
            remainingHolding: 0,
            solAmount: 0,
            usdAmount: netReceived,
            priceUsd: pOut,
            txHash: '',
            timestamp: Math.floor(now / 1000),
            isOpenOrClose: true,
            isFirstBuy: false,
          };
          this.onTradeAction('SELL', scenario.id, oldSignal, {
            stakeUsd: netReceived,
            tokens: tokensToSell,
            priceUsd: pOut,
            reason: exitReason,
          });
        } catch (e: any) {
          console.warn(`[AUTO-ROTATION-ACTION-ERR] ${e?.message}`);
        }
      }
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

    for (const scenario of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9, this.scenarios.s10]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === signal.mint);
      if (posIdx === -1) continue;

      const pos = scenario.openPositions[posIdx];
      if (pos.tokens <= 0) continue;

      if (signal.pairAddress && pos.pairAddress !== signal.pairAddress) {
        pos.pairAddress = signal.pairAddress;
      }

      // Skenario 4: 2-Lapis Shakeout Trap (Hold 8s & Dump on Buyback)
      if (scenario.id === 'SCENARIO_4_SINGLE_BUY_5USD') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const elapsedSec = (now - pos.openedAt) / 1000;

        // Lapis 1: Jika sell terjadi di detik <= 3.0 (Shakeout) dan belum pernah masuk mode waitingBuyback:
        if (elapsedSec <= 3.0 && !pos.waitingBuybackSince) {
          pos.waitingBuybackSince = now;
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
            reason: `S4_WAITING_BUYBACK (Target sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s <= 3s, tahan hingga 8s menunggu buyback)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Jika sedang dalam status waitingBuyback:
        if (pos.waitingBuybackSince) {
          const waitElapsedSec = (now - pos.waitingBuybackSince) / 1000;
          // Jika target malah melakukan dump kedua berturut-turut (consecutive dump) >= 15% atau Full Exit:
          if (currentSellRatioPct >= 15.0 || isFullExit) {
            const exitReason = `S4_CONSECUTIVE_DUMP_EXIT (Target dump susulan ${currentSellRatioPct}% saat menunggu buyback di +${waitElapsedSec.toFixed(1)}s, safety cut)`;
            this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
            continue;
          }
          // Masih dalam 8s dan sell kecil: tetap tahan
          continue;
        }

        // Standar exit S4 jika sell terjadi di luar detik 3 (misal detik 10, 15, dll):
        if (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) {
          const exitReason = `CUM_SELL_${pos.targetCumulativeSellRatioPct}%_GTE_15%_FULL_EXIT`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 9: Dev Front-Run & 2-Way Target Sync (Anti-Shakeout micro-sell + Emergency Dump Exit)
      if (scenario.id === 'SCENARIO_9_DEV_FRONTRUN_SYNC') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const referenceTime = pos.targetEnteredAt || pos.openedAt;
        const elapsedSec = (now - referenceTime) / 1000;

        // 1. EMERGENCY EXIT: Jika Whale DUMP BESAR (>= 50% atau Full Exit), BATALKAN TAHANAN! LANGSUNG EXIT DETIK ITU JUGA!
        // Menyelamatkan modal dari Dev rugpull (RemoveAllLiquidity) yang mengeksekusi 10-15s setelah whale dump 100%.
        if (isFullExit || pos.targetCumulativeSellRatioPct >= 50.0 || currentSellRatioPct >= 50.0) {
          const exitReason = `S9_EMERGENCY_WHALE_DUMP_EXIT (Whale dump ${pos.targetCumulativeSellRatioPct}% >= 50% / Full Exit di detik ${elapsedSec.toFixed(1)}s, kabur sebelum dev rugpull)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }

        // 2. ANTI-SHAKEOUT GATE: Untuk micro-sell (< 50%) dalam 12 detik pertama pasca target masuk, tahan posisi untuk wave pompa!
        if (elapsedSec < 12.0) {
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
            reason: `ANTI_SHAKEOUT_HOLD (Whale micro sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 12s, tahan posisi untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // 3. Pasca detik ke-12: jika target akumulasi jual >= 15%, ikuti whale keluar!
        if (pos.targetCumulativeSellRatioPct >= 15.0) {
          const exitReason = `S9_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% pasca detik 12s)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 10: Dynamic Wave Runner (Hold selama whale hold / exit saat whale sell >= 15% pasca detik 10s)
      if (scenario.id === 'SCENARIO_10_DYNAMIC_WAVE_RUNNER') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const referenceTime = pos.targetEnteredAt || pos.openedAt;
        const elapsedSec = (now - referenceTime) / 1000;
        // ANTI-SHAKEOUT GATE: Dalam 10 detik pertama pasca target masuk jika bukan dump besar, tahan posisi!
        if (elapsedSec < 10.0 && !isFullExit && pos.targetCumulativeSellRatioPct < 15.0) {
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
            reason: `ANTI_SHAKEOUT_HOLD (Whale micro sell ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 10s, tahan untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Pasca detik ke-10 (atau jika whale langsung dump >= 15% / full exit): IKUTI WHALE KELUAR 100%!
        if (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) {
          const exitReason = `S10_WHALE_SELL_EXIT (Whale sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% | Puncak wave harvest)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Skenario 5: Anti-Shakeout Runner (Anti-shakeout micro-sell + Emergency Whale Dump Exit)
      if (scenario.id === 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
        pos.lastTargetSellAt = now;

        const elapsedSec = (now - pos.openedAt) / 1000;

        // Emergency Exit jika Whale Dump >= 50% atau Full Exit
        if (isFullExit || pos.targetCumulativeSellRatioPct >= 50.0 || currentSellRatioPct >= 50.0) {
          const exitReason = `S5_EMERGENCY_WHALE_DUMP_EXIT (Whale dump ${pos.targetCumulativeSellRatioPct}% >= 50% / Full Exit di detik ${elapsedSec.toFixed(1)}s, kabur sebelum dev rugpull)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }

        // ANTI-SHAKEOUT GATE: Dalam 12 detik pertama untuk micro-sell, abaikan goyangan dump target!
        if (elapsedSec < 12.0) {
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
            reason: `ANTI_SHAKEOUT_HOLD (Target sold ${currentSellRatioPct}% di detik ${elapsedSec.toFixed(1)}s < 12s, tahan posisi untuk wave pompa)`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();
          continue;
        }

        // Pasca detik ke-12: jika target akumulasi jual >= 15%, ikuti whale keluar!
        if (pos.targetCumulativeSellRatioPct >= 15.0) {
          const exitReason = `S5_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15% pasca detik 12s)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        continue;
      }

      // Jika Skenario 8 masih memegang posisi saat target sell:
      if (scenario.id === 'SCENARIO_8_FRONTRUN_DEV') {
        pos.lastPriceUsd = pOut;
        if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
        const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
        pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));

        // Safety exit jika target dump >= 15% atau Full Exit sebelum 20 detik
        if (pos.targetCumulativeSellRatioPct >= 15.0 || isFullExit) {
          const exitReason = `S8_TARGET_SELL_FOLLOW_EXIT (Target sold ${signal.symbol} ${pos.targetCumulativeSellRatioPct}% >= 15%, safety exit)`;
          this.executeScenarioExit(scenario, posIdx, pOut, now, timeWib, exitReason);
          continue;
        }
        // Jika target baru jual sedikit (< 15%), S8 tetap hold menuju 20 detik
        continue;
      }

      // Akumulasi rasio jual target (Anti-Fee-Churning Gate)
      if (!pos.targetCumulativeSellRatioPct) pos.targetCumulativeSellRatioPct = 0.0;
      const currentSellRatioPct = Number((sellRatio * 100).toFixed(1));
      pos.targetCumulativeSellRatioPct = Number((pos.targetCumulativeSellRatioPct + currentSellRatioPct).toFixed(1));
      pos.lastTargetSellAt = now;

      // Ambang Batas Exit & Strategi Khusus:
      // - Skenario 6 & 7: Split TP 50/50 (Stage 1: TP 50% di >= 5.0% Anti-Rug, Stage 2: 50% Tahan >= 15.0% Mega Runner)
      // - Skenario 4: Single Buy $5 (Standar Full Exit >= 15.0%)

      if (scenario.id === 'SCENARIO_6_REDEPLOY_SNIPER' || scenario.id === 'SCENARIO_7_TIME_STOP_SNIPER') {
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
          pos.stage1RealUsdReturned = netReceived;

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
        stage1RealUsdReturned: pos.stage1RealUsdReturned || 0,
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
    this.lastObservedPrices.set(mint, priceUsd);
    let changed = false;

    for (const scenario of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9, this.scenarios.s10]) {
      const posIdx = scenario.openPositions.findIndex(p => p.mint === mint);
      if (posIdx !== -1) {
        const pos = scenario.openPositions[posIdx];
        pos.lastPriceUsd = priceUsd;
        const curVal = pos.tokens * priceUsd;
        pos.unrealizedPnlUsd = Number((curVal - pos.costBasisUsd).toFixed(2));
        changed = true;

        // Khusus Skenario 5 & Skenario 9: Auto Take-Profit +25% & Stop Loss -15%
        if ((scenario.id === 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER' || scenario.id === 'SCENARIO_9_DEV_FRONTRUN_SYNC') && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          if (gainPct >= 25.0) {
            const now = Date.now();
            const timeWib = formatWibDate(now);
            const exitReason = `AUTO_TAKE_PROFIT_25% (Gain: +${gainPct.toFixed(1)}% >= +25% | Mengunci cuan puncak wave)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
          if (gainPct <= -15.0) {
            const now = Date.now();
            // Grace Period 12 Detik: Jika whale baru masuk (< 12s), tahan cut-loss agar tidak terkena shakeout tick saat pompa sedang berjalan
            if (pos.targetEnteredAt && (now - pos.targetEnteredAt) < 12000) {
              continue;
            }
            const timeWib = formatWibDate(now);
            const exitReason = `STOP_LOSS_15% (Drop: ${gainPct.toFixed(1)}% <= -15% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
        }

        // Khusus Skenario 10: Dynamic Wave Runner (Stop-Loss -15%, Hard Ceiling +300%, Trailing Peak Lock)
        // S10 TIDAK MEMICU AUTO_TAKE_PROFIT_25%! Posisi dibiarkan terbang selama whale hold!
        if (scenario.id === 'SCENARIO_10_DYNAMIC_WAVE_RUNNER' && pos.avgEntryPriceUsd > 0) {
          const gainPct = ((priceUsd - pos.avgEntryPriceUsd) / pos.avgEntryPriceUsd) * 100;
          if (!pos.peakGainPct || gainPct > pos.peakGainPct) {
            pos.peakGainPct = gainPct;
          }

          // 1. Cut Loss Pengaman (-15%)
          if (gainPct <= -15.0) {
            const now = Date.now();
            // Grace Period 12 Detik: Jika whale baru masuk (< 12s), tahan cut-loss agar tidak terkena shakeout tick saat pompa sedang berjalan
            if (pos.targetEnteredAt && (now - pos.targetEnteredAt) < 12000) {
              continue;
            }
            const timeWib = formatWibDate(now);
            const exitReason = `STOP_LOSS_15% (Drop: ${gainPct.toFixed(1)}% <= -15% | Cut-loss pengaman)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }

          // 2. Hard Ceiling Multi-Bagger (+300% / 4x lipat)
          if (gainPct >= 300.0) {
            const now = Date.now();
            const timeWib = formatWibDate(now);
            const exitReason = `HARD_TP_300%_CEILING (Gain: +${gainPct.toFixed(1)}% >= +300% | Kunci profit multi-bagger puncak wave)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }

          // 3. Trailing Profit Lock: Jika sempat mencapai >= +100% dan terkoreksi >= 30% dari titik puncak
          if (pos.peakGainPct >= 100.0 && gainPct <= pos.peakGainPct * 0.70) {
            const now = Date.now();
            const timeWib = formatWibDate(now);
            const exitReason = `TRAILING_STOP_PEAK_DROP_30% (Peak: +${pos.peakGainPct.toFixed(1)}% -> Current: +${gainPct.toFixed(1)}% | Kunci profit sebelum dump)`;
            this.executeScenarioExit(scenario, posIdx, priceUsd, now, timeWib, exitReason);
            continue;
          }
        }

        // 1. Hard Take-Profit Gate: Jika harga melonjak >= +200% (>= 3x dari harga entry)
        // Eksekusi sell 100% instan untuk mengamankan profit multi-bagger sebelum dev rugpull
        if (pos.avgEntryPriceUsd > 0 && priceUsd >= pos.avgEntryPriceUsd * 3.0) {
          const now = Date.now();
          const timeWib = formatWibDate(now);
          const tokensToSell = pos.tokens;
          const costBasisSold = pos.costBasisUsd;

          const grossReceived = tokensToSell * priceUsd;
          const netReceived = Math.max(0.0, Number((grossReceived - REAL_SWAP_FEE_USD).toFixed(2)));
          const pnlUsd = Number((netReceived - costBasisSold).toFixed(2));

          pos.realizedPnlUsd = Number(((pos.realizedPnlUsd || 0) + pnlUsd).toFixed(2));
          pos.feesPaidUsd = Number((pos.feesPaidUsd + REAL_SWAP_FEE_USD).toFixed(3));
          scenario.availableCash = Number((scenario.availableCash + netReceived).toFixed(2));
          scenario.totalFeesPaid = Number((scenario.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));
          scenario.realizedPnl = Number((scenario.realizedPnl + pnlUsd).toFixed(2));

          scenario.openPositions.splice(posIdx, 1);

          const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? costBasisSold * 2 : costBasisSold);
          const totalInvested = initialInvested;
          const roi = totalInvested > 0 ? (pos.realizedPnlUsd / totalInvested) * 100 : 0.0;
          const isWin = pos.realizedPnlUsd >= 0;

          if (isWin) scenario.wins += 1;
          else scenario.losses += 1;
          scenario.totalTrades += 1;

          const exitReason = `HARD_TP_200%_CEILING (Gain: +${roi.toFixed(1)}% >= +200% | Auto-Harvest Profit)`;

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
            priceUsd,
            pnlUsd,
            availableCashAfter: scenario.availableCash,
            investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
            reason: `${exitReason} (Fee: $${REAL_SWAP_FEE_USD})`,
          });
          if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

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

          // Trigger onTradeAction SELL
          if (this.onTradeAction) {
            try {
              const sellSignal: WalletTradeSignal = {
                action: 'sell',
                mint: pos.mint,
                symbol: pos.symbol,
                tokenName: pos.tokenName,
                tokenAmount: tokensToSell,
                remainingHolding: 0,
                solAmount: 0,
                usdAmount: netReceived,
                priceUsd,
                txHash: '',
                timestamp: Math.floor(now / 1000),
                isOpenOrClose: true,
                isFirstBuy: false,
              };
              this.onTradeAction('SELL', scenario.id, sellSignal, {
                stakeUsd: netReceived,
                tokens: tokensToSell,
                priceUsd,
                reason: exitReason,
              });
            } catch (err: any) {
              console.warn(`[HARD-TP-ACTION-ERR] ${err?.message}`);
            }
          }
          continue;
        }

        // 2. Auto Liquidation Gate: Jika harga crash > 95% dari harga entry (Rugpull/Liquidity Drained)
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
    this.checkGen2ReEntry(mint, priceUsd);
  }

  /**
   * Pengecekan Re-Entry Otomatis untuk Koin Gen-2 Nama Sama:
   * Jika token Gen-2 keluar via TARGET_SKIPPED_DEV_POOL (atau exit aman),
   * bot menunggu cooldown 1 menit (60s). Jika harga / grafik meningkat,
   * bot mengeksekusi BUY siklus berikutnya (hingga maksimal 5x siklus)!
   */
  public checkGen2ReEntry(targetMint?: string, currentPriceUsd?: number): void {
    const now = Date.now();
    const timeWib = formatWibDate(now);

    for (const [mint, gen2] of this.gen2CycleTracker.entries()) {
      if (targetMint && mint !== targetMint) continue;
      if (gen2.status !== 'COOLDOWN') continue;

      // 1. Cek apakah masa cooldown 60 detik (1 menit) sudah selesai
      if (now < gen2.cooldownUntil) continue;

      // 2. Cek apakah masih dalam batas 5 siklus
      if (gen2.cycleCount >= gen2.maxCycles) {
        gen2.status = 'TERMINATED';
        continue;
      }

      // 3. Cek apakah trade sebelumnya untung/BEP
      if (!gen2.lastTradeProfitable) {
        gen2.status = 'TERMINATED';
        continue;
      }

      // 4. Cek apakah S9 sedang memegang koin ini (jangan buy jika posisi masih terbuka)
      const hasOpenPos = this.scenarios.s9.openPositions.some(p => p.mint === mint);
      if (hasOpenPos) continue;

      // 5. Cek harga spot saat ini:
      const spotPrice = (currentPriceUsd && currentPriceUsd > 0) ? currentPriceUsd : (this.lastObservedPrices.get(mint) || 0);
      if (spotPrice <= 0) continue;

      // 6. Syarat Grafik / Harga Meningkat:
      // Harga spot saat ini harus lebih tinggi dari harga exit terakhir (ada momentum naik)
      if (spotPrice <= gen2.lastExitPrice) {
        continue;
      }

      const gainSinceExitPct = ((spotPrice - gen2.lastExitPrice) / gen2.lastExitPrice) * 100;
      gen2.cycleCount += 1;
      gen2.status = 'HOLDING';

      console.log(`\n=========================================================`);
      console.log(`🚀 [GEN2 CYCLE RE-ENTRY TRIGGERED] Memulai Buy Putaran ke-${gen2.cycleCount}/${gen2.maxCycles}:`);
      console.log(`   Token        : ${gen2.symbol} [${mint.slice(0, 8)}...]`);
      console.log(`   Harga Exit   : $${gen2.lastExitPrice.toFixed(8)}`);
      console.log(`   Harga Spot   : $${spotPrice.toFixed(8)} (+${gainSinceExitPct.toFixed(1)}% meningkat)`);
      console.log(`   Timer Tunggu : 60 Detik untuk aksi whale / TP`);
      console.log(`=========================================================\n`);

      let s9Stake = 0.25;
      try {
        const liveCfg = readFollowerLiveConfig(this.dataDir);
        s9Stake = liveCfg.stakeUsdS9 || 0.25;
      } catch {}

      const reEntrySignal: WalletTradeSignal = {
        action: 'buy',
        mint,
        symbol: gen2.symbol,
        tokenName: gen2.symbol,
        tokenAmount: 0,
        remainingHolding: 0,
        solAmount: 0,
        usdAmount: 0,
        priceUsd: spotPrice,
        txHash: `gen2_cycle${gen2.cycleCount}_${now}`,
        timestamp: Math.floor(now / 1000),
        isOpenOrClose: true,
        isFirstBuy: false,
        pairAddress: gen2.pairAddress,
        exchange: gen2.exchange,
      };

      this.processScenarioBuy(this.scenarios.s9, reEntrySignal, true, 1380, now, timeWib, {
        maxTokenExposure: s9Stake,
        getStake: () => s9Stake,
        disallowAccumulation: true,
        allowReEntryCycle: true,
        cycleIndex: gen2.cycleCount,
      });

      const newPos = this.scenarios.s9.openPositions.find(p => p.mint === mint);
      if (newPos) {
        newPos.boughtAtGenesis = true; // Enables TARGET_SKIPPED_DEV_POOL 60s timer!
        newPos.openedAt = now; // Fresh 60s timer!
        newPos.pairAddress = gen2.pairAddress;
        newPos.exchange = gen2.exchange;
        newPos.entryCount = gen2.cycleCount;
      }

      this.saveState();
    }
  }

  public getGen2CooldownMints(): string[] {
    const mints: string[] = [];
    for (const [mint, gen2] of this.gen2CycleTracker.entries()) {
      if (gen2.status === 'COOLDOWN') mints.push(mint);
    }
    return mints;
  }

  /**
   * Auto-likuidasi posisi stagnan / terbengkalai (> 25 menit tanpa aktivitas target)
   */
  public checkStagnantPositions(maxAgeMinutes: number = 25): void {
    const now = Date.now();
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    let changed = false;

    for (const scenario of [this.scenarios.s4, this.scenarios.s5, this.scenarios.s6, this.scenarios.s7, this.scenarios.s8, this.scenarios.s9]) {
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
    // Periksa S7 Time-Stop (Force Exit @ 28s)
    this.checkTimeStopExits(28000);
  }

  /**
   * Skenario 7 Time-Stop Exit:
   * Jika posisi terbuka sudah mencapai maxTimeMs (default 28000ms / 28s),
   * bot LANGSUNG FORCE SELL 100% sisa koinnya untuk mengamankan puncak pump sebelum dev rugpull!
   */
  public checkTimeStopExits(maxTimeMs: number = 28000): void {
    const now = Date.now();
    let changed = false;
    this.checkGen2ReEntry();
    const scenario = this.scenarios.s7;

    for (let i = scenario.openPositions.length - 1; i >= 0; i--) {
      const pos = scenario.openPositions[i];
      if (pos.tokens <= 0) continue;

      const elapsedMs = now - pos.openedAt;
      if (elapsedMs >= maxTimeMs) {
        const timeWib = formatWibDate(now);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
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

        const elapsedSec = Math.round(elapsedMs / 1000);
        const reason = `TIME_STOP_${elapsedSec}S_FORCE_EXIT (Reached ${elapsedSec}s post-entry, locked profit before rugpull)`;

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
          pnlUsd,
          availableCashAfter: scenario.availableCash,
          investedCashAfter: Math.max(0, scenario.investedCash - costBasisSold),
          reason: `${reason} (Fee: $${REAL_SWAP_FEE_USD})`,
        });
        if (scenario.recentEvents.length > 50) scenario.recentEvents.pop();

        scenario.openPositions.splice(i, 1);

        const initialInvested = pos.initialCostBasisUsd || (pos.stage1Exited ? costBasisSold * 2 : costBasisSold);
        const totalInvested = initialInvested;
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
          exitReason: reason,
          isWin,
          stage1RealUsdReturned: pos.stage1RealUsdReturned || 0,
        });
        if (scenario.closedTrades.length > 100) scenario.closedTrades.pop();

        if (this.onTradeAction) {
          try {
            const signal: WalletTradeSignal = {
              action: 'sell',
              mint: pos.mint,
              symbol: pos.symbol,
              tokenName: pos.tokenName,
              tokenAmount: tokensToSell,
              remainingHolding: 0,
              solAmount: 0,
              usdAmount: netReceived,
              priceUsd: pOut,
              txHash: '',
              timestamp: Math.floor(now / 1000),
              isOpenOrClose: true,
              isFirstBuy: false,
            };
            this.onTradeAction('SELL', scenario.id, signal, {
              stakeUsd: netReceived,
              tokens: tokensToSell,
              priceUsd: pOut,
              reason,
            });
          } catch {}
        }
        changed = true;
      }
    }

    // 2. Cek Skenario 8 Time-Stop (Force Exit @ 20s pasca Target Inflow) & Timeout 80s:
    const s8 = this.scenarios.s8;
    for (let i = s8.openPositions.length - 1; i >= 0; i--) {
      const pos = s8.openPositions[i];
      if (pos.tokens <= 0) continue;

      // Kasus A: Target sudah masuk, hitung apakah sudah mencapai 20 detik pasca-target masuk!
      if (pos.targetEnteredAt) {
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 20000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_ENTRY (Reached 20s post-target inflow, locked profit before dump)`;
          this.executeScenarioExit(s8, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }

      // Kasus B: Target tidak kunjung masuk dalam 80s sejak Genesis
      const elapsedMs = now - pos.openedAt;
      if (elapsedMs >= 80000) {
        const timeWib = formatWibDate(now);
        const elapsedSec = Math.round(elapsedMs / 1000);
        const reason = `TARGET_SKIPPED_DEV_POOL (Dev Deploy Pool '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit)`;
        this.executeScenarioExit(s8, i, pos.lastPriceUsd, now, timeWib, reason);
        changed = true;
      }
    }

    // 3. Cek Skenario 5 Time-Stop (Force Exit @ 35s post-entry untuk mengamankan wave):
    const s5 = this.scenarios.s5;
    for (let i = s5.openPositions.length - 1; i >= 0; i--) {
      const pos = s5.openPositions[i];
      if (pos.tokens <= 0) continue;

      const elapsedMs = now - pos.openedAt;
      if (elapsedMs >= 35000) {
        const timeWib = formatWibDate(now);
        const elapsedSec = Math.round(elapsedMs / 1000);
        const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
        const reason = `TIME_STOP_${elapsedSec}S_WAVE_EXIT (Reached 35s wave limit, locked profit before minute 1-2 liquidity drain)`;
        this.executeScenarioExit(s5, i, pOut, now, timeWib, reason);
        changed = true;
      }
    }

    // 4. Cek Skenario 9 Time-Stop:
    // - Gap 60s tanpa target masuk -> Force Sell
    // - Wave limit 35s pasca target masuk -> Force Exit
    const s9 = this.scenarios.s9;
    for (let i = s9.openPositions.length - 1; i >= 0; i--) {
      const pos = s9.openPositions[i];
      if (pos.tokens <= 0) continue;

      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;

      // Kasus A: Target sudah masuk, batasi wave 35s pasca-target masuk
      if (pos.targetEnteredAt) {
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 35000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_WAVE_EXIT (Reached 35s post-target wave limit, locked profit before minute 1-2 liquidity drain)`;
          this.executeScenarioExit(s9, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      } else {
        // Kasus B: Target tidak kunjung masuk sejak genesis
        const elapsedMs = now - pos.openedAt;
        // JIKA Pool 1 Umpan (koin baru bukan Gen-2/Pool 2): batas waktu diperpendek menjadi 35 detik (sebelum dev rugpull di detik 45)
        // JIKA Pool 2 / Gen-2 re-deploy: batas waktu 60 detik (memberi ruang pompa lebih longgar)
        const isPool2OrGen2 = Boolean(this.gen2CycleTracker.get(pos.mint) || (pos as any).isPool2 || (pos as any).isSameSymbol);
        const timeoutLimitMs = isPool2OrGen2 ? 60000 : 35000;

        if (elapsedMs >= timeoutLimitMs) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedMs / 1000);
          const poolTypeStr = isPool2OrGen2 ? 'Pool 2' : 'Pool 1 Umpan';
          const reason = `TARGET_SKIPPED_DEV_POOL (${poolTypeStr} '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit sebelum dev rugpull)`;
          this.executeScenarioExit(s9, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }
    }

    // 4b. Cek Skenario 10 Time-Stop (Dynamic Wave Runner):
    // - Gap 35s/60s tanpa target masuk -> Force Sell (Safety Exit)
    // - Wave limit 30s pasca target masuk -> Force Exit (Time-Stop pengaman sebelum dev rugpull)
    const s10 = this.scenarios.s10;
    for (let i = s10.openPositions.length - 1; i >= 0; i--) {
      const pos = s10.openPositions[i];
      if (pos.tokens <= 0) continue;

      const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;

      if (pos.targetEnteredAt) {
        const elapsedSinceTarget = now - pos.targetEnteredAt;
        if (elapsedSinceTarget >= 30000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceTarget / 1000);
          const reason = `TIME_STOP_${elapsedSec}S_POST_TARGET_WAVE_EXIT (Reached 30s post-target wave limit, locked profit before minute 1-2 liquidity drain)`;
          this.executeScenarioExit(s10, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      } else {
        const elapsedMs = now - pos.openedAt;
        const isPool2OrGen2 = Boolean(this.gen2CycleTracker.get(pos.mint) || (pos as any).isPool2 || (pos as any).isSameSymbol);
        const timeoutLimitMs = isPool2OrGen2 ? 60000 : 35000;

        if (elapsedMs >= timeoutLimitMs) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedMs / 1000);
          const poolTypeStr = isPool2OrGen2 ? 'Pool 2' : 'Pool 1 Umpan';
          const reason = `TARGET_SKIPPED_DEV_POOL (${poolTypeStr} '${pos.symbol}' tapi Target TIDAK Beli dalam ${elapsedSec}s, safety exit sebelum dev rugpull)`;
          this.executeScenarioExit(s10, i, pOut, now, timeWib, reason);
          changed = true;
          continue;
        }
      }
    }

    // 5. Cek Skenario 4: 8s Buyback Timeout
    const s4 = this.scenarios.s4;
    for (let i = s4.openPositions.length - 1; i >= 0; i--) {
      const pos = s4.openPositions[i];
      if (pos.tokens <= 0) continue;

      if (pos.waitingBuybackSince) {
        const elapsedSinceSell = now - pos.waitingBuybackSince;
        if (elapsedSinceSell >= 8000) {
          const timeWib = formatWibDate(now);
          const elapsedSec = Math.round(elapsedSinceSell / 1000);
          const pOut = pos.lastPriceUsd > 0 ? pos.lastPriceUsd : pos.avgEntryPriceUsd;
          const reason = `S4_BUYBACK_TIMEOUT_${elapsedSec}S_EXIT (Target tidak buyback dalam 8s pasca shakeout sell, safety exit)`;
          this.executeScenarioExit(s4, i, pOut, now, timeWib, reason);
          changed = true;
        }
      }
    }

    if (changed) {
      this.saveState();
    }
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
      { scenario: this.scenarios.s7, maxInactivity: 30000 },
      { scenario: this.scenarios.s5, maxInactivity: 35000 },
      { scenario: this.scenarios.s9, maxInactivity: 35000 },
      { scenario: this.scenarios.s10, maxInactivity: 30000 },
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

  /**
   * Sinkronisasi Eksekusi Beli Riil (dari kuotasi AMM DEX riil / swap ke-2 dryrun):
   * Menggantikan harga estimasi target dengan harga swap pasar nyata!
   */
  public syncRealBuyExecution(
    scenarioId: string,
    mint: string,
    realPriceUsd: number,
    tokensBought: number,
    stakeUsd: number
  ): void {
    if (realPriceUsd <= 0 || tokensBought <= 0) return;
    const targetSc = scenarioId.includes('10') ? this.scenarios.s10 : (scenarioId.includes('9') ? this.scenarios.s9 : (scenarioId.includes('8') ? this.scenarios.s8 : (scenarioId.includes('7') ? this.scenarios.s7 : (scenarioId.includes('6') ? this.scenarios.s6 : (scenarioId.includes('5') ? this.scenarios.s5 : this.scenarios.s4)))));
    const pos = targetSc.openPositions.find(p => p.mint === mint);
    if (!pos) return;

    const oldPrice = pos.avgEntryPriceUsd;
    pos.avgEntryPriceUsd = realPriceUsd;
    pos.lastPriceUsd = realPriceUsd;
    pos.tokens = tokensBought;
    pos.initialTokens = tokensBought;
    pos.costBasisUsd = stakeUsd;
    pos.initialCostBasisUsd = stakeUsd;

    // Update recent event jika ada
    const ev = targetSc.recentEvents.find(e => e.mint === mint && e.action === 'BUY');
    if (ev) {
      ev.priceUsd = realPriceUsd;
      ev.tokens = tokensBought;
      if (!ev.reason.includes('Real Swap:')) {
        ev.reason = `${ev.reason} (Real Swap: $${realPriceUsd.toFixed(8)})`;
      }
    }

    console.log(`[DRYRUN-ENGINE SYNC] ✅ Posisi ${pos.symbol} [${scenarioId}] disinkronkan ke harga swap AMM riil: $${realPriceUsd.toFixed(8)} (Target: $${oldPrice.toFixed(8)}, Gap: ${((realPriceUsd - oldPrice)/oldPrice*100).toFixed(1)}%)`);
    this.saveState();
  }

  /**
   * Sinkronisasi Eksekusi Jual Riil (dari kuotasi swap AMM sell):
   * Menggantikan estimasi harga target dengan proceeds kas riil yang kembali dari DEX!
   */
  public syncRealSellExecution(
    scenarioId: string,
    mint: string,
    realExitPriceUsd: number,
    realUsdReturned: number,
    reason: string
  ): void {
    if (realUsdReturned < 0) return;
    const targetSc = scenarioId.includes('10') ? this.scenarios.s10 : (scenarioId.includes('9') ? this.scenarios.s9 : (scenarioId.includes('8') ? this.scenarios.s8 : (scenarioId.includes('7') ? this.scenarios.s7 : (scenarioId.includes('6') ? this.scenarios.s6 : (scenarioId.includes('5') ? this.scenarios.s5 : this.scenarios.s4)))));

    // 1. Cek apakah ini sinkronisasi Stage 1 TP 50% (posisi masih open)
    if (reason && reason.includes('STAGE_1_TP_50%')) {
      const openPos = targetSc.openPositions.find(p => p.mint === mint);
      if (openPos) {
        // Kurangi fee transaksi DEX riil agar kas bersih mencerminkan saldo dompet nyata
        const netStage1 = Math.max(0, realUsdReturned - REAL_SWAP_FEE_USD);
        openPos.stage1RealUsdReturned = netStage1;
        console.log(`[DRYRUN-ENGINE SYNC] ✅ Stage 1 TP 50% ${openPos.symbol} [${scenarioId}] proceeds disinkronkan ke swap AMM bersih: $${netStage1.toFixed(2)} (Gross: $${realUsdReturned.toFixed(2)}, Fee: -$${REAL_SWAP_FEE_USD})`);
        this.saveState();
        return;
      }
    }

    // 2. Cek apakah ada di closedTrades (Full exit / Stage 2)
    const trade = targetSc.closedTrades.find(t => t.mint === mint);
    if (trade) {
      const oldPnl = trade.realizedPnlUsd;
      const oldReturned = trade.totalReturnedUsd;

      // Jika trade ini adalah S6 Split TP yang melewati Stage 1:
      const stage1Proceeds = trade.stage1RealUsdReturned || 0;
      // Kurangi total fee transaksi roundtrip ($0.05 = $0.025 buy + $0.025 sell) agar persis sama dengan GMGN & dompet asli!
      const totalRoundtripFee = REAL_SWAP_FEE_USD * 2; // $0.050 USD
      const grossTotalReturn = stage1Proceeds + realUsdReturned;
      const totalRealReturned = Math.max(0, grossTotalReturn - totalRoundtripFee);

      trade.totalReturnedUsd = Number(totalRealReturned.toFixed(2));
      trade.realizedPnlUsd = Number((totalRealReturned - trade.totalInvestedUsd).toFixed(2));
      trade.roiPct = trade.totalInvestedUsd > 0 ? Number(((trade.realizedPnlUsd / trade.totalInvestedUsd) * 100).toFixed(1)) : 0.0;
      trade.isWin = trade.realizedPnlUsd >= 0;
      trade.totalFeesPaidUsd = Number(totalRoundtripFee.toFixed(3));
      if (!trade.exitReason.includes('Real Swap:')) {
        trade.exitReason = `${trade.exitReason} (Real Swap: $${grossTotalReturn.toFixed(2)} | Net: $${totalRealReturned.toFixed(2)})`;
      }

      // Recalculate scenario metrics
      const pnlDiff = trade.realizedPnlUsd - oldPnl;
      const cashDiff = trade.totalReturnedUsd - oldReturned;
      targetSc.realizedPnl = Number((targetSc.realizedPnl + pnlDiff).toFixed(2));
      targetSc.availableCash = Number((targetSc.availableCash + cashDiff).toFixed(2));
      targetSc.totalFeesPaid = Number((targetSc.totalFeesPaid + REAL_SWAP_FEE_USD).toFixed(3));

      targetSc.wins = targetSc.closedTrades.filter(t => t.isWin).length;
      targetSc.losses = targetSc.closedTrades.filter(t => !t.isWin).length;
      targetSc.winRate = targetSc.totalTrades > 0 ? Number(((targetSc.wins / targetSc.totalTrades) * 100).toFixed(1)) : 0.0;

      console.log(`[DRYRUN-ENGINE SYNC] ✅ Trade ${trade.symbol} [${scenarioId}] disinkronkan ke hasil bersih GMGN & dompet riil: Total Return Net $${totalRealReturned.toFixed(2)} (Gross: $${grossTotalReturn.toFixed(2)}, Fee: -$${totalRoundtripFee.toFixed(2)} | Net PnL: $${trade.realizedPnlUsd.toFixed(2)}, ROI: ${trade.roiPct}%)`);
      this.saveState();
    }
  }

  /**
   * Batalkan Buy di Scenario jika rute swap AMM gagal (little pool hit / no route):
   * Mencegah posisi hantu di dry-run yang menghasilkan profit palsu!
   */
  public abortScenarioBuy(scenarioId: string, mint: string, reason: string): void {
    const targetSc = scenarioId.includes('10') ? this.scenarios.s10 : (scenarioId.includes('9') ? this.scenarios.s9 : (scenarioId.includes('8') ? this.scenarios.s8 : (scenarioId.includes('7') ? this.scenarios.s7 : (scenarioId.includes('6') ? this.scenarios.s6 : (scenarioId.includes('5') ? this.scenarios.s5 : this.scenarios.s4)))));
    const idx = targetSc.openPositions.findIndex(p => p.mint === mint);
    if (idx >= 0) {
      const pos = targetSc.openPositions[idx];
      targetSc.openPositions.splice(idx, 1);
      targetSc.availableCash = Number((targetSc.availableCash + pos.costBasisUsd).toFixed(2));
      targetSc.investedCash = Math.max(0, Number((targetSc.investedCash - pos.costBasisUsd).toFixed(2)));
      targetSc.recentEvents.unshift({
        id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: Date.now(),
        timeWib: formatWibDate(Date.now()),
        scenarioId: targetSc.id,
        action: 'SKIP',
        symbol: pos.symbol,
        mint: pos.mint,
        priceUsd: pos.avgEntryPriceUsd,
        availableCashAfter: targetSc.availableCash,
        investedCashAfter: targetSc.investedCash,
        reason: `BUY_ROUTE_FAILED (${reason}) - Posisi dibatalkan dari engine`,
      });
      if (targetSc.recentEvents.length > 50) targetSc.recentEvents.pop();
      console.log(`[DRYRUN-ENGINE ABORT] 🚫 Posisi ${pos.symbol} [${scenarioId}] dibatalkan karena rute beli AMM gagal: ${reason}`);
      this.saveState();
    }
  }

  /**
   * Catat Kegagalan Jual Riil di Scenario (little pool hit / unsellable):
   * Mengoreksi trade agar tercatat sebagai rugi / proceeds = 0 jika token tidak bisa dijual!
   */
  public recordFailedSellExecution(scenarioId: string, mint: string, reason: string): void {
    const targetSc = scenarioId.includes('10') ? this.scenarios.s10 : (scenarioId.includes('9') ? this.scenarios.s9 : (scenarioId.includes('8') ? this.scenarios.s8 : (scenarioId.includes('7') ? this.scenarios.s7 : (scenarioId.includes('6') ? this.scenarios.s6 : (scenarioId.includes('5') ? this.scenarios.s5 : this.scenarios.s4)))));
    const trade = targetSc.closedTrades.find(t => t.mint === mint);
    if (trade) {
      const oldPnl = trade.realizedPnlUsd;
      const oldReturned = trade.totalReturnedUsd;

      // Token tidak bisa dijual sama sekali (0 proceeds returned)
      trade.totalReturnedUsd = 0;
      trade.realizedPnlUsd = -trade.totalInvestedUsd;
      trade.roiPct = -100.0;
      trade.isWin = false;
      trade.exitReason = `${trade.exitReason} (UNSELLABLE_AMM_DEAD_POOL: ${reason} | Return: $0.00)`;

      const pnlDiff = trade.realizedPnlUsd - oldPnl;
      const cashDiff = trade.totalReturnedUsd - oldReturned;
      targetSc.realizedPnl = Number((targetSc.realizedPnl + pnlDiff).toFixed(2));
      targetSc.availableCash = Math.max(0, Number((targetSc.availableCash + cashDiff).toFixed(2)));
      targetSc.wins = targetSc.closedTrades.filter(t => t.isWin).length;
      targetSc.losses = targetSc.closedTrades.filter(t => !t.isWin).length;
      targetSc.winRate = targetSc.totalTrades > 0 ? Number(((targetSc.wins / targetSc.totalTrades) * 100).toFixed(1)) : 0.0;

      console.log(`[DRYRUN-ENGINE SYNC] ⚠️ Trade ${trade.symbol} [${scenarioId}] dikoreksi menjadi LOSS 100% karena rute jual AMM ditolak (${reason})`);
      this.saveState();
    }
  }

  public getS9OpenPositionsCount(): number {
    return this.scenarios.s9.openPositions.length;
  }

  public getS10OpenPositionsCount(): number {
    return this.scenarios.s10.openPositions.length;
  }

  public isTargetEntered(mint: string): boolean {
    for (const sc of [this.scenarios.s9, this.scenarios.s10, this.scenarios.s8]) {
      const pos = sc.openPositions.find(p => p.mint === mint);
      if (pos && pos.targetEnteredAt && pos.targetEnteredAt > 0) return true;
    }
    return false;
  }
}
