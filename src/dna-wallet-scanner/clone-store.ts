import * as fs from 'node:fs';
import * as path from 'node:path';
import { DiscoveredCloneWallet } from './types.js';
import { isStrictSerialTrader } from './dna-filter.js';

export class CloneWalletStore {
  private filePath: string;
  public wallets: Map<string, DiscoveredCloneWallet> = new Map();

  constructor(dataDir?: string) {
    const dir = dataDir || path.resolve(process.cwd(), 'data');
    this.filePath = path.join(dir, 'dna-clone-wallets.json');
    this.load();
  }

  private load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const list: DiscoveredCloneWallet[] = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const w of list) {
            this.wallets.set(w.address, w);
          }
        }
      } catch (err: any) {
        console.warn(`[CLONE-STORE-LOAD-ERR] ${err?.message}`);
      }
    }
  }

  public save(): void {
    try {
      const list = Array.from(this.wallets.values());
      // Sort priority:
      // 1. Exact Clones (Strict Serial + Multi-Sell TWAP) FIRST
      // 2. Multi-hit count DESCENDING (Konsistensi di banyak koin)
      // 3. Highest GMGN Total Profit / 7D Realized Profit (True Smart Money) DESCENDING
      list.sort((a, b) => {
        const isExactA = (a.isStrictSerial !== false && a.isMultiStepScalper);
        const isExactB = (b.isStrictSerial !== false && b.isMultiStepScalper);
        if (isExactA !== isExactB) return isExactB ? 1 : -1;

        if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;

        const profB = b.gmgnProfile?.totalProfit || b.gmgnProfile?.realized7d || 0;
        const profA = a.gmgnProfile?.totalProfit || a.gmgnProfile?.realized7d || 0;
        return profB - profA;
      });
      fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2), 'utf8');
    } catch (err: any) {
      console.warn(`[CLONE-STORE-SAVE-ERR] ${err?.message}`);
    }
  }

  public recordMatch(
    address: string,
    tradeRecord: any,
    solBalance: number,
    tags: string[] = []
  ): { isNew: boolean; hitCount: number } {
    let existing = this.wallets.get(address);
    const now = Date.now();

    if (!existing) {
      const isMultiStep = tradeRecord.sellCount >= 2;
      const w: DiscoveredCloneWallet = {
        address,
        firstDiscoveredAt: now,
        lastActiveAt: now,
        hitCount: 1,
        solBalance,
        totalRealizedProfitUsd: tradeRecord.profitUsd,
        avgHoldSec: tradeRecord.holdSec,
        avgStakeUsd: tradeRecord.stakeUsd,
        isStrictSerial: true,
        isMultiStepScalper: isMultiStep,
        isPureDexTrader: true,
        isPingPongRebuy: isMultiStep,
        tokensTraded: [tradeRecord],
        tags,
        score: this.calculateScore(1, tradeRecord.profitUsd, solBalance, true, isMultiStep)
      };
      this.wallets.set(address, w);
      this.save();
      return { isNew: true, hitCount: 1 };
    } else {
      // Preserve existing profile and ping-pong state
      const prevProfile = existing.gmgnProfile;
      const prevPingPong = existing.isPingPongRebuy;
      const prevWinRate = existing.realPnlWinRate;
      const prevWins = existing.completedWins;
      const prevLosses = existing.completedLosses;
      const prevCalendar = existing.calendarPnl;
      const prevRecentAudit = existing.recentActivityAudit;
      const prevSixtyDay = existing.sixtyDayAudit;

      // Wallet already exists: check if this token was already recorded
      const alreadyHasToken = existing.tokensTraded.some(t => t.mint === tradeRecord.mint);
      if (!alreadyHasToken) {
        existing.tokensTraded.unshift(tradeRecord);
        existing.hitCount += 1;
        existing.totalRealizedProfitUsd += tradeRecord.profitUsd;
      } else {
        // Re-entered the same token!
        existing.isPingPongRebuy = true;
      }
      existing.lastActiveAt = now;
      if (solBalance > 0) existing.solBalance = solBalance;
      
      const totHold = existing.tokensTraded.reduce((acc, t) => acc + t.holdSec, 0);
      existing.avgHoldSec = Math.round(totHold / existing.tokensTraded.length);
      
      const totStake = existing.tokensTraded.reduce((acc, t) => acc + t.stakeUsd, 0);
      existing.avgStakeUsd = Math.round(totStake / existing.tokensTraded.length);

      // Check strict serial execution
      existing.isStrictSerial = isStrictSerialTrader(existing.tokensTraded);

      // Check multi-step scalper (TWAP sell count >= 2)
      existing.isMultiStepScalper = existing.tokensTraded.some(t => t.sellCount >= 2);
      existing.isPureDexTrader = true;
      existing.isPingPongRebuy = Boolean(prevPingPong || existing.isMultiStepScalper);
      if (prevProfile) existing.gmgnProfile = prevProfile;
      if (prevWinRate !== undefined) existing.realPnlWinRate = prevWinRate;
      if (prevWins !== undefined) existing.completedWins = prevWins;
      if (prevLosses !== undefined) existing.completedLosses = prevLosses;
      if (prevCalendar !== undefined) existing.calendarPnl = prevCalendar;
      if (prevRecentAudit !== undefined) existing.recentActivityAudit = prevRecentAudit;
      if (prevSixtyDay !== undefined) existing.sixtyDayAudit = prevSixtyDay;
      
      existing.score = this.calculateScore(
        existing.hitCount,
        existing.totalRealizedProfitUsd,
        existing.solBalance,
        existing.isStrictSerial,
        existing.isMultiStepScalper
      );
      this.save();
      return { isNew: false, hitCount: existing.hitCount };
    }
  }

  private calculateScore(
    hitCount: number,
    totalProfitUsd: number,
    solBalance: number,
    isStrictSerial: boolean = true,
    isMultiStepScalper: boolean = false
  ): number {
    // 0 - 100 Score:
    // Repeat Hit (25 pts max): 1 hit = 8, 2 hits = 16, 3+ hits = 25
    let sHit = Math.min(25, hitCount * 8);
    
    // Profit score (25 pts max, log scaled)
    let sProf = 0;
    if (totalProfitUsd > 0) {
      sProf = Math.min(25, Math.round((Math.log10(Math.max(10, totalProfitUsd)) / 4) * 25));
    }

    // Strict Serial Trader Bonus (25 pts max) - Key Target DNA trait!
    let sSerial = isStrictSerial ? 25 : 0;

    // Multi-Step TWAP Sells Bonus (25 pts max) - Target NEVER does 1 buy -> 1 sell!
    let sMultiStep = isMultiStepScalper ? 25 : 0;
    
    return Math.min(100, sHit + sProf + sSerial + sMultiStep);
  }

  public getRankedList(): DiscoveredCloneWallet[] {
    const list = Array.from(this.wallets.values());
    list.sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      if (b.score !== a.score) return b.score - a.score;
      return b.totalRealizedProfitUsd - a.totalRealizedProfitUsd;
    });
    return list;
  }
}
