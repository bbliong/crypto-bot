import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SnowballWallet {
  address: string;
  score: number;
  winrate30d: number;
  pnl30d: number;
  solBalance: number;
  source: "gmgn_curator" | "snowball_runner";
  successfulTokens: string[];
  hitCount: number;
  firstSeenAt: string;
  lastActiveAt: string;
}

export interface SnowballStats {
  totalCurated: number;
  newSnowballedThisRun: number;
  knownHitsThisRun: number;
}

export class SnowballCollector {
  private curatedPath: string;
  private auditPath: string;
  private walletsMap: Map<string, SnowballWallet> = new Map();
  private quarantinedSet: Set<string> = new Set();
  private newThisRun: number = 0;
  private hitsThisRun: number = 0;

  constructor(options?: { curatedPath?: string; auditPath?: string }) {
    const root = process.cwd();
    this.curatedPath = options?.curatedPath || join(root, "data", "curated-lowcap-smart-wallets.json");
    this.auditPath = options?.auditPath || join(root, "data", "syndicate-candle-audit-results.json");
    this.loadState();
  }

  public loadState(): void {
    // 1. Load quarantined syndicates to avoid collecting bad actors
    if (existsSync(this.auditPath)) {
      try {
        const auditData = JSON.parse(readFileSync(this.auditPath, "utf8"));
        const syndicates = auditData.syndicatesDetected || auditData.purgedSyndicateWallets || [];
        for (const item of syndicates) {
          const addr = typeof item === "string" ? item : item.address;
          if (addr) this.quarantinedSet.add(addr);
        }
      } catch {}
    }

    // 2. Load existing curated wallets
    if (existsSync(this.curatedPath)) {
      try {
        const data = JSON.parse(readFileSync(this.curatedPath, "utf8"));
        const list: any[] = data.wallets || (Array.isArray(data) ? data : []);
        for (const w of list) {
          if (!w.address || this.quarantinedSet.has(w.address)) continue;
          this.walletsMap.set(w.address, {
            address: w.address,
            score: w.score || 70,
            winrate30d: w.winrate30d || (w.winRate ? Math.round(w.winRate * 100) : 50),
            pnl30d: Math.round(w.pnl30d || w.realizedProfit || 0),
            solBalance: Number(w.solBalance || 0),
            source: w.source || "gmgn_curator",
            successfulTokens: Array.isArray(w.successfulTokens) ? w.successfulTokens : [],
            hitCount: w.hitCount || 1,
            firstSeenAt: w.firstSeenAt || new Date().toISOString(),
            lastActiveAt: w.lastActiveAt || new Date().toISOString()
          });
        }
      } catch {}
    }
  }

  public ingestTrader(
    trader: any,
    tokenSymbol: string,
    tokenMint: string
  ): { isNew: boolean; wallet?: SnowballWallet } {
    if (!trader || !trader.address) return { isNew: false };
    const address = trader.address.trim();

    // Strict safety filters
    if (this.quarantinedSet.has(address)) return { isNew: false };
    if (trader.is_suspicious) return { isNew: false };
    if (trader.maker_token_tags && trader.maker_token_tags.includes("bundler")) return { isNew: false };

    // Minimum profit filter: trader must have made at least $50 or 50% ROI
    const profit = Number(trader.profit || trader.realized_profit || 0);
    const pnl = Number(trader.realized_pnl || 0);
    if (profit < 50 && pnl < 0.50) return { isNew: false };

    const solBalance = trader.native_balance ? Number(trader.native_balance) / 1e9 : Number(trader.balance || 0);
    const nowIso = new Date().toISOString();

    const existing = this.walletsMap.get(address);
    if (existing) {
      existing.hitCount++;
      existing.lastActiveAt = nowIso;
      if (tokenSymbol && !existing.successfulTokens.includes(tokenSymbol)) {
        existing.successfulTokens.push(tokenSymbol);
      }
      this.hitsThisRun++;
      return { isNew: false, wallet: existing };
    }

    // New smart wallet discovered
    const score = Math.min(100, Math.round(55 + (profit > 1000 ? 30 : profit > 250 ? 20 : 10) + (solBalance > 5 ? 10 : 5)));
    const newWallet: SnowballWallet = {
      address,
      score,
      winrate30d: trader.winrate ? Math.round(trader.winrate * 100) : 55,
      pnl30d: Math.round(profit),
      solBalance: Number(solBalance.toFixed(2)),
      source: "snowball_runner",
      successfulTokens: tokenSymbol ? [tokenSymbol] : [tokenMint.slice(0, 8)],
      hitCount: 1,
      firstSeenAt: nowIso,
      lastActiveAt: nowIso
    };

    this.walletsMap.set(address, newWallet);
    this.newThisRun++;
    return { isNew: true, wallet: newWallet };
  }

  public saveSnowball(): { totalCurated: number; newSnowballed: number } {
    const list = Array.from(this.walletsMap.values());
    // Sort by hit count and score
    list.sort((a, b) => (b.hitCount * 100 + b.score) - (a.hitCount * 100 + a.score));

    // Save curated wallets JSON
    const payload = {
      updatedAt: new Date().toISOString(),
      totalCurated: list.length,
      snowballedWalletsCount: list.filter(w => w.source === "snowball_runner").length,
      criteria: {
        target: "Lowcap / Launchpad / Pump.fun specialists & Snipers",
        minProfit: "$50+ USD per verified lowcap runner",
        antiSyndicate: "Auto-quarantined on pump-and-dump",
        mode: "100% Free GMGN Auto-Collector Snowball"
      },
      wallets: list
    };

    try {
      writeFileSync(this.curatedPath, JSON.stringify(payload, null, 2));
    } catch (e: any) {
      console.warn(`[SNOWBALL] Failed saving ${this.curatedPath}:`, e.message);
    }

    // Also sync cleanOrganicWallets in audit results so all consumers see the new pool
    if (existsSync(this.auditPath)) {
      try {
        const auditData = JSON.parse(readFileSync(this.auditPath, "utf8"));
        auditData.cleanOrganicWallets = list.map(w => ({
          address: w.address,
          winrate30d: w.winrate30d,
          pnl30d: w.pnl30d,
          solBalance: w.solBalance,
          score: w.score,
          hitCount: w.hitCount,
          source: w.source
        }));
        writeFileSync(this.auditPath, JSON.stringify(auditData, null, 2));
      } catch (e: any) {
        console.warn(`[SNOWBALL] Failed syncing ${this.auditPath}:`, e.message);
      }
    }

    return {
      totalCurated: list.length,
      newSnowballed: this.newThisRun
    };
  }

  public getStats(): SnowballStats {
    return {
      totalCurated: this.walletsMap.size,
      newSnowballedThisRun: this.newThisRun,
      knownHitsThisRun: this.hitsThisRun
    };
  }

  public getAllWallets(): SnowballWallet[] {
    return Array.from(this.walletsMap.values());
  }

  public getAllAddresses(): string[] {
    return Array.from(this.walletsMap.keys());
  }

  public isQuarantined(address: string): boolean {
    return this.quarantinedSet.has(address);
  }
}
