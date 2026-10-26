import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WalletTier = "SUPERULTRA" | "ULTRA" | "SSS" | "SS" | "S" | "A" | "B" | "C" | "D" | "E";

export function computeWalletTier(wallet: {
  source?: string;
  pnl30d?: number;
  hitCount?: number;
  solBalance?: number;
  score?: number;
  tier?: WalletTier;
  isUltra?: boolean;
  isSuperUltra?: boolean;
}): WalletTier {
  // Tier SUPERULTRA & ULTRA: Preserved if already qualified by consistency audit
  if (wallet.tier === "SUPERULTRA" || wallet.isSuperUltra) {
    return "SUPERULTRA";
  }
  if (wallet.tier === "ULTRA" || wallet.isUltra) {
    return "ULTRA";
  }

  const pnl = Number(wallet.pnl30d || 0);
  const hits = Number(wallet.hitCount || 1);
  const bal = Number(wallet.solBalance || 0);
  const isCurator = wallet.source === "gmgn_curator";

  // Tier SSS: Apex Alpha / God Snipers (Top 0.5% - Serial multi-token winner, massive PnL & heavy bankroll)
  // Syarat: (Hits >= 50 && PnL >= $25k && Bal >= 10 SOL) ATAU (PnL >= $100k && Hits >= 20 && Bal >= 15 SOL)
  if ((hits >= 50 && pnl >= 25000 && bal >= 10.0) || (pnl >= 100000 && hits >= 20 && bal >= 15.0)) {
    return "SSS";
  }

  // Tier SS: Master Scouts / Heavy Smart Money (Top ~2%)
  // Syarat: (Hits >= 20 && PnL >= $8k && Bal >= 4 SOL) ATAU (Hits >= 35 && PnL >= $5k && Bal >= 3 SOL) ATAU (PnL >= $30k && bal >= 10 SOL)
  if ((hits >= 20 && pnl >= 8000 && bal >= 4.0) || (hits >= 35 && pnl >= 5000 && bal >= 3.0) || (pnl >= 30000 && bal >= 10.0)) {
    return "SS";
  }

  // Tier S: Whales / Curated Elite (Top conviction baseline)
  if ((isCurator && pnl >= 2000) || (hits >= 5 && pnl >= 2000 && bal >= 2.0)) {
    return "S";
  }

  // Tier A: Proven Multi-Token Smart Money
  if (isCurator || (hits >= 3 && pnl >= 500 && bal >= 0.5)) {
    return "A";
  }

  // Tier B: Consistent Scalpers / Active Scouts (3+ tokens)
  if (hits >= 3 && pnl >= 150 && bal >= 0.1) {
    return "B";
  }

  // Tier C: Emerging / Developing (at least 2 tokens)
  if (hits >= 2 && pnl >= 100 && bal >= 0.05) {
    return "C";
  }

  // Tier D: Single-Hit / Retail Punter
  if (pnl >= 50 && bal >= 0.01) {
    return "D";
  }

  // Tier E: Dust / Burner / Inactive
  return "E";
}

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
  tier: WalletTier;
  dailyAuditStatus?: "PROCESSED" | "PENDING" | "FAILED" | "NO_DATA";
  dailyAuditAt?: string;
  winDayRate?: number;
  posDays60d?: number;
  negDays60d?: number;
  pnl60d?: number;
  isUltra?: boolean;
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
          const tier = computeWalletTier(w);
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
            lastActiveAt: w.lastActiveAt || new Date().toISOString(),
            tier,
            dailyAuditStatus: w.dailyAuditStatus,
            dailyAuditAt: w.dailyAuditAt,
            winDayRate: w.winDayRate,
            posDays60d: w.posDays60d,
            negDays60d: w.negDays60d,
            pnl60d: w.pnl60d,
            isUltra: w.isUltra || (w.tier === "ULTRA")
          });
        }
      } catch {}
    }

    // 3. Sync audited daily profit consistency from SQLite
    const root = process.cwd();
    const dbPath = join(root, "data", "crypto-bot.sqlite");
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath);
        const audits = db.prepare("SELECT address, win_day_rate, positive_days, negative_days, total_net_pnl, is_ultra, status, audited_at FROM wallet_daily_profit_audits WHERE status = 'PROCESSED'").all() as any[];
        for (const a of audits) {
          const existing = this.walletsMap.get(a.address);
          if (existing) {
            existing.dailyAuditStatus = a.status;
            existing.dailyAuditAt = a.audited_at;
            existing.winDayRate = a.win_day_rate;
            existing.posDays60d = a.positive_days;
            existing.negDays60d = a.negative_days;
            existing.pnl60d = a.total_net_pnl;
            existing.isUltra = a.is_ultra === 1;
            if (a.is_ultra === 1) {
              existing.tier = "ULTRA";
            }
          }
        }
        db.close();
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
      existing.pnl30d = Math.round(existing.pnl30d + profit);
      if (solBalance > 0) existing.solBalance = Number(solBalance.toFixed(2));
      existing.tier = computeWalletTier(existing);
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
      lastActiveAt: nowIso,
      tier: "D"
    };
    newWallet.tier = computeWalletTier(newWallet);

    this.walletsMap.set(address, newWallet);
    this.newThisRun++;
    return { isNew: true, wallet: newWallet };
  }

  public saveSnowball(): { totalCurated: number; newSnowballed: number } {
    const list = Array.from(this.walletsMap.values());

    // Sync latest SQLite audit records so ULTRA status is always preserved
    const root = process.cwd();
    const dbPath = join(root, "data", "crypto-bot.sqlite");
    if (existsSync(dbPath)) {
      try {
        const db = new DatabaseSync(dbPath);
        const audits = db.prepare("SELECT address, tier_at_audit, win_day_rate, positive_days, negative_days, total_net_pnl, is_ultra, status, audited_at FROM wallet_daily_profit_audits WHERE status = 'PROCESSED'").all() as any[];
        const auditMap = new Map(audits.map(a => [a.address, a]));
        for (const w of list) {
          const a = auditMap.get(w.address);
          if (a) {
            w.dailyAuditStatus = a.status;
            w.dailyAuditAt = a.audited_at;
            w.winDayRate = a.win_day_rate;
            w.posDays60d = a.positive_days;
            w.negDays60d = a.negative_days;
            w.pnl60d = a.total_net_pnl;
            w.isUltra = a.is_ultra === 1;
            if (a.tier_at_audit === "SUPERULTRA" || w.tier === "SUPERULTRA") {
              w.tier = "SUPERULTRA";
              w.isSuperUltra = true;
            } else if (a.is_ultra === 1) {
              w.tier = "ULTRA";
            }
          }
        }
        db.close();
      } catch {}
    }

    // Refresh tiers for all wallets
    const tierCounts: Record<WalletTier, number> = { SUPERULTRA: 0, ULTRA: 0, SSS: 0, SS: 0, S: 0, A: 0, B: 0, C: 0, D: 0, E: 0 };
    for (const w of list) {
      w.tier = computeWalletTier(w);
      tierCounts[w.tier]++;
    }

    // Sort by tier weight, hit count, and score
    const tierWeight: Record<WalletTier, number> = { SUPERULTRA: 10, ULTRA: 8, SSS: 7, SS: 6, S: 5, A: 4, B: 3, C: 2, D: 1, E: 0 };
    list.sort((a, b) => {
      const wa = tierWeight[a.tier] || 0;
      const wb = tierWeight[b.tier] || 0;
      if (wa !== wb) return wb - wa;
      return (b.hitCount * 100 + b.score) - (a.hitCount * 100 + a.score);
    });

    // Save curated wallets JSON
    const payload = {
      updatedAt: new Date().toISOString(),
      totalCurated: list.length,
      snowballedWalletsCount: list.filter(w => w.source === "snowball_runner").length,
      tierBreakdown: tierCounts,
      criteria: {
        target: "Lowcap / Launchpad / Pump.fun specialists & Snipers",
        tiers: {
          SSS: "Apex Alpha / God Snipers (50+ hits, PnL >= $25k, Bal >= 10 SOL atau PnL >= $100k)",
          SS: "Master Scouts / Heavy Smart (20+ hits, PnL >= $8k, Bal >= 4 SOL)",
          S: "Whale / Curated Elite (5+ hits, PnL >= $2k & Bal >= 2 SOL)",
          A: "Proven Smart Money (3+ hits, PnL >= $500, Bal >= 0.5 SOL)",
          B: "Consistent Scouts (3+ hits, PnL >= $150, Bal >= 0.1 SOL)",
          C: "Emerging (2+ hits, PnL >= $100, Bal >= 0.05 SOL)",
          D: "Single-Hit Retail / Lucky Punter",
          E: "Dust / Burner / Inactive"
        },
        executionMinTier: "Tier B (Hanya Tier SSS, SS, S, A, B yang memicu Auto-Buy)"
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
        auditData.tierBreakdown = tierCounts;
        auditData.cleanOrganicWallets = list.map(w => ({
          address: w.address,
          winrate30d: w.winrate30d,
          pnl30d: w.pnl30d,
          solBalance: w.solBalance,
          score: w.score,
          hitCount: w.hitCount,
          source: w.source,
          tier: w.tier
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

  public getWallet(address: string): SnowballWallet | undefined {
    return this.walletsMap.get(address);
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
