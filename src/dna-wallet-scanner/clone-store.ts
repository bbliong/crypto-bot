import * as fs from 'node:fs';
import * as path from 'node:path';
import { DiscoveredCloneWallet } from './types.js';

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
      // Sort by hitCount desc, then score desc, then totalProfit desc
      list.sort((a, b) => {
        if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
        if (b.score !== a.score) return b.score - a.score;
        return b.totalRealizedProfitUsd - a.totalRealizedProfitUsd;
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
      const w: DiscoveredCloneWallet = {
        address,
        firstDiscoveredAt: now,
        lastActiveAt: now,
        hitCount: 1,
        solBalance,
        totalRealizedProfitUsd: tradeRecord.profitUsd,
        avgHoldSec: tradeRecord.holdSec,
        avgStakeUsd: tradeRecord.stakeUsd,
        tokensTraded: [tradeRecord],
        tags,
        score: this.calculateScore(1, tradeRecord.profitUsd, solBalance)
      };
      this.wallets.set(address, w);
      this.save();
      return { isNew: true, hitCount: 1 };
    } else {
      // Wallet already exists: check if this token was already recorded
      const alreadyHasToken = existing.tokensTraded.some(t => t.mint === tradeRecord.mint);
      if (!alreadyHasToken) {
        existing.tokensTraded.unshift(tradeRecord);
        existing.hitCount += 1;
        existing.totalRealizedProfitUsd += tradeRecord.profitUsd;
      }
      existing.lastActiveAt = now;
      if (solBalance > 0) existing.solBalance = solBalance;
      
      const totHold = existing.tokensTraded.reduce((acc, t) => acc + t.holdSec, 0);
      existing.avgHoldSec = Math.round(totHold / existing.tokensTraded.length);
      
      const totStake = existing.tokensTraded.reduce((acc, t) => acc + t.stakeUsd, 0);
      existing.avgStakeUsd = Math.round(totStake / existing.tokensTraded.length);
      
      existing.score = this.calculateScore(existing.hitCount, existing.totalRealizedProfitUsd, existing.solBalance);
      this.save();
      return { isNew: false, hitCount: existing.hitCount };
    }
  }

  private calculateScore(hitCount: number, totalProfitUsd: number, solBalance: number): number {
    // 0 - 100 Score:
    // Repeat Hit (40 pts max): 1 hit = 15, 2 hits = 30, 3+ hits = 40
    let sHit = Math.min(40, hitCount * 15);
    
    // Profit score (40 pts max, log scaled)
    let sProf = 0;
    if (totalProfitUsd > 0) {
      sProf = Math.min(40, Math.round((Math.log10(Math.max(10, totalProfitUsd)) / 4) * 40));
    }
    
    // Balance score (20 pts max): 0.5 - 20 SOL
    let sBal = Math.min(20, Math.round(solBalance * 2));
    
    return Math.min(100, sHit + sProf + sBal);
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
