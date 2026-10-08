import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { activityFields, walkActivity } from './buy-sell-watch-activity.js';

export type HolderTradeRecord = {
  mint: string;
  symbol?: string;
  buyPriceUsd?: number;
  sellPriceUsd?: number;
  pnlPercent?: number;
  buyTimestamp: number;
  sellTimestamp?: number;
  holdSeconds?: number;
  isWin?: boolean;
  source?: string;
};

export type HolderStats = {
  wallet: string;
  tier: 'tier1' | 'tier2' | 'tier3';
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number; // percentage 0 - 100
  totalPnlPercent: number;
  avgPnlPercent: number;
  lastActivityTimestamp?: number;
  recommendation: 'SMART_MONEY' | 'NEUTRAL' | 'AVOID';
  recentTrades: HolderTradeRecord[];
};

export function pairTradesFromActivities(body: unknown): HolderTradeRecord[] {
  const activities = walkActivity(body);
  const byMint = new Map<string, Array<{
    side: string;
    mint: string;
    symbol?: string;
    timestamp: number;
    priceUsd: number;
    amount: string;
  }>>();

  for (const row of activities) {
    const f = activityFields(row);
    if (!f.mint || !f.timestamp) continue;
    if (!byMint.has(f.mint)) byMint.set(f.mint, []);
    byMint.get(f.mint)!.push({
      side: f.side,
      mint: f.mint,
      symbol: (f.token as { symbol?: string } | undefined)?.symbol,
      timestamp: f.timestamp,
      priceUsd: Number(row.price_usd ?? row.pu) || 0,
      amount: String(row.token_amount ?? row.ba ?? ''),
    });
  }

  const trades: HolderTradeRecord[] = [];
  for (const [mint, rows] of byMint) {
    rows.sort((a, b) => a.timestamp - b.timestamp);
    let openBuy: typeof rows[0] | null = null;
    for (const r of rows) {
      if (r.side === 'buy') {
        openBuy = r;
      } else if (r.side === 'sell' && openBuy) {
        const pnl = openBuy.priceUsd > 0 && r.priceUsd > 0
          ? ((r.priceUsd - openBuy.priceUsd) / openBuy.priceUsd) * 100
          : 0;
        trades.push({
          mint,
          symbol: openBuy.symbol || r.symbol,
          buyPriceUsd: openBuy.priceUsd || undefined,
          sellPriceUsd: r.priceUsd || undefined,
          pnlPercent: Number(pnl.toFixed(2)),
          buyTimestamp: openBuy.timestamp,
          sellTimestamp: r.timestamp,
          holdSeconds: Math.max(0, r.timestamp - openBuy.timestamp),
          isWin: pnl >= 0,
          source: 'history_poll',
        });
        openBuy = null;
      }
    }
  }
  return trades.sort((a, b) => (b.sellTimestamp ?? 0) - (a.sellTimestamp ?? 0));
}

export class HolderProfiler {
  private profiles = new Map<string, HolderStats>();
  private allWallets: string[] = [];

  constructor(wallets: string[] = []) {
    this.allWallets = wallets;
    for (const w of wallets) {
      this.profiles.set(w, this.defaultStats(w));
    }
  }

  private defaultStats(wallet: string): HolderStats {
    return {
      wallet,
      tier: 'tier3',
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnlPercent: 0,
      avgPnlPercent: 0,
      recommendation: 'NEUTRAL',
      recentTrades: [],
    };
  }

  recordActivities(wallet: string, body: unknown, nowSeconds = Math.floor(Date.now() / 1000)) {
    const stats = this.profiles.get(wallet) ?? this.defaultStats(wallet);
    const historicalTrades = pairTradesFromActivities(body);

    // Find latest activity timestamp in feed
    const activities = walkActivity(body);
    let maxTs = 0;
    for (const a of activities) {
      const f = activityFields(a);
      if (f.timestamp > maxTs) maxTs = f.timestamp;
    }
    if (maxTs > 0) stats.lastActivityTimestamp = maxTs;

    // Determine tier:
    // VIP rule: Smart Money always gets Tier 1 VIP pass
    if (stats.recommendation === 'SMART_MONEY') {
      stats.tier = 'tier1';
    } else if (stats.recommendation === 'AVOID') {
      // Frequent losers / bad win-rate go to Tier 3 cool-down
      stats.tier = 'tier3';
    } else {
      // Option B for neutral/unverified wallets:
      // Tier 1: Active in < 30 minutes (1800s) - Hot
      // Tier 2: Active between 30 min and 3 hours (1800s - 10800s) - Warm
      // Tier 3: Active > 3 hours (> 10800s) or no activity - Cool
      const diff = stats.lastActivityTimestamp ? nowSeconds - stats.lastActivityTimestamp : Infinity;
      if (diff < 1800) {
        stats.tier = 'tier1';
      } else if (diff < 10800) {
        stats.tier = 'tier2';
      } else {
        stats.tier = 'tier3';
      }
    }

    // Merge recent trades (avoid duplicating existing)
    const existingKeys = new Set(stats.recentTrades.map(t => `${t.mint}:${t.buyTimestamp}:${t.sellTimestamp}`));
    for (const t of historicalTrades) {
      const key = `${t.mint}:${t.buyTimestamp}:${t.sellTimestamp}`;
      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        stats.recentTrades.push(t);
      }
    }
    stats.recentTrades.sort((a, b) => (b.sellTimestamp ?? b.buyTimestamp) - (a.sellTimestamp ?? a.buyTimestamp));
    stats.recentTrades = stats.recentTrades.slice(0, 30);

    this.recomputeStats(stats);
    this.profiles.set(wallet, stats);
  }

  recordLiveTrade(trade: {
    wallet: string;
    mint: string;
    symbol?: string;
    buyPriceUsd?: number;
    sellPriceUsd?: number;
    pnlPercent?: number;
    holdDurationSeconds?: number;
    source?: string;
  }) {
    const stats = this.profiles.get(trade.wallet) ?? this.defaultStats(trade.wallet);
    stats.tier = 'tier1';
    stats.lastActivityTimestamp = Math.floor(Date.now() / 1000);

    const record: HolderTradeRecord = {
      mint: trade.mint,
      symbol: trade.symbol,
      buyPriceUsd: trade.buyPriceUsd,
      sellPriceUsd: trade.sellPriceUsd,
      pnlPercent: trade.pnlPercent,
      buyTimestamp: Math.floor(Date.now() / 1000) - (trade.holdDurationSeconds ?? 0),
      sellTimestamp: Math.floor(Date.now() / 1000),
      holdSeconds: trade.holdDurationSeconds,
      isWin: trade.pnlPercent !== undefined ? trade.pnlPercent >= 0 : undefined,
      source: trade.source ?? 'live_socket',
    };

    stats.recentTrades.unshift(record);
    stats.recentTrades = stats.recentTrades.slice(0, 30);
    this.recomputeStats(stats);
    this.profiles.set(trade.wallet, stats);
  }

  private recomputeStats(stats: HolderStats) {
    let wins = 0, losses = 0, sumPnl = 0;
    for (const t of stats.recentTrades) {
      if (t.pnlPercent !== undefined) {
        sumPnl += t.pnlPercent;
        if (t.pnlPercent >= 0) wins++;
        else losses++;
      }
    }
    const total = wins + losses;
    stats.totalTrades = total;
    stats.wins = wins;
    stats.losses = losses;
    stats.winRate = total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;
    stats.totalPnlPercent = Number(sumPnl.toFixed(1));
    stats.avgPnlPercent = total > 0 ? Number((sumPnl / total).toFixed(1)) : 0;

    // Recommendation rules
    if (total >= 2 && stats.winRate >= 55 && stats.avgPnlPercent > 0) {
      stats.recommendation = 'SMART_MONEY';
      stats.tier = 'tier1'; // VIP Pass: Smart Money is ALWAYS Tier 1
    } else if (total >= 2 && (stats.winRate < 40 || stats.avgPnlPercent < -15)) {
      stats.recommendation = 'AVOID';
      stats.tier = 'tier3'; // Losers demoted to Tier 3
    } else {
      stats.recommendation = 'NEUTRAL';
    }
  }

  getTier(wallet: string): 'tier1' | 'tier2' | 'tier3' {
    return this.profiles.get(wallet)?.tier ?? 'tier3';
  }

  getProfitScore(wallet: string): number {
    const s = this.profiles.get(wallet);
    if (!s) return 0;
    // Score based on profitability: Win Rate weighted + Avg PnL
    return (s.winRate * 2) + s.avgPnlPercent + (s.recommendation === 'SMART_MONEY' ? 100 : s.recommendation === 'AVOID' ? -100 : 0);
  }

  snapshot(): HolderStats[] {
    const list = [...this.profiles.values()];
    // Sort strictly by PROFITABILITY FIRST:
    // 1. Recommendation (Smart Money > Neutral > Avoid)
    // 2. Wallets with completed trades and profit > wallets with 0 trades
    // 3. Avg PnL % and Win Rate %
    // 4. Recency / Tier
    return list.sort((a, b) => {
      const recRank = (s: HolderStats) => s.recommendation === 'SMART_MONEY' ? 3 : s.recommendation === 'NEUTRAL' ? 2 : 1;
      if (recRank(a) !== recRank(b)) return recRank(b) - recRank(a);

      // If one has positive profit and the other has 0 trades, prioritize the profitable one
      const aProfitable = a.totalTrades > 0 && a.avgPnlPercent > 0;
      const bProfitable = b.totalTrades > 0 && b.avgPnlPercent > 0;
      if (aProfitable !== bProfitable) return aProfitable ? -1 : 1;

      if (b.avgPnlPercent !== a.avgPnlPercent) return b.avgPnlPercent - a.avgPnlPercent;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.totalTrades !== a.totalTrades) return b.totalTrades - a.totalTrades;

      const tierRank = (t: string) => t === 'tier1' ? 3 : t === 'tier2' ? 2 : 1;
      return tierRank(b.tier) - tierRank(a.tier);
    });
  }

  save(file: string) {
    try {
      const list = [...this.profiles.values()];
      const data = {
        updatedAt: new Date().toISOString(),
        totalWallets: this.profiles.size,
        tier1Count: list.filter(s => s.tier === 'tier1').length,
        tier2Count: list.filter(s => s.tier === 'tier2').length,
        tier3Count: list.filter(s => s.tier === 'tier3').length,
        holders: this.snapshot(),
      };
      writeFileSync(file, JSON.stringify(data, null, 2));
    } catch { /* ignore write issues */ }
  }

  load(file: string) {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(raw?.holders)) {
        for (const h of raw.holders) {
          if (h && typeof h.wallet === 'string') {
            if (h.recommendation === 'SMART_MONEY') h.tier = 'tier1';
            else if (h.recommendation === 'AVOID') h.tier = 'tier3';
            this.profiles.set(h.wallet, h);
          }
        }
      }
    } catch { /* ignore corrupted stats */ }
  }
}
