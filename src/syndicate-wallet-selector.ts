import fs from 'node:fs';
import path from 'node:path';
import { SyndicateSqliteStorage } from './storage/syndicate-sqlite.js';
import { selectTopSyndicateWatchingTargets, syncCanonicalSyndicateOutputs, type MonitoredTarget } from './syndicate-canonical-grouper.js';

export type { MonitoredTarget };

export interface SelectorOptions {
  storage?: SyndicateSqliteStorage;
  outputPath?: string;
  minWallets?: number;
  topLimit?: number;
}

export class SyndicateWalletSelector {
  private storage: SyndicateSqliteStorage;
  private outputPath: string;
  private minWallets: number;
  private topLimit: number;

  constructor(options: SelectorOptions = {}) {
    this.storage = options.storage || new SyndicateSqliteStorage();
    this.outputPath = options.outputPath || '/home/bbliong/project/crypto-bot/data/syndicate-watch/gmgn-monitored-wallets.json';
    this.minWallets = options.minWallets ?? 4;
    this.topLimit = options.topLimit ?? 5;
  }

  public selectAndExport(): MonitoredTarget[] {
    const allCandidates = this.storage.getAllCandidates();

    // If storage has mock/test candidates, prioritize test flow
    if (allCandidates.length > 0 && allCandidates.some(c => c.mint.startsWith('MINT_'))) {
      const eligible = allCandidates.filter(c => c.walletsCount > this.minWallets);
      eligible.sort((a, b) => b.latestTransferAt - a.latestTransferAt);
      const topCandidates = eligible.slice(0, this.topLimit);
      const targets: MonitoredTarget[] = topCandidates.map(c => ({
        tokenName: c.name,
        tokenMint: c.mint,
        symbol: c.symbol,
        totalSyndicateWallets: c.walletsCount,
        latestTransferWib: c.latestTransferWib,
        monitoredWallet: c.sampleWallet
      }));
      const watchedMints = topCandidates.map(c => c.mint);
      this.storage.markWatchedTokens(watchedMints);
      const payload = {
        updatedAt: new Date().toISOString(),
        selectionRule: `top ${this.topLimit} newest tokens with >${this.minWallets} syndicate wallets, 1 wallet per token`,
        totalCandidatesInDatabase: allCandidates.length,
        eligibleTokensCount: eligible.length,
        watchingTargetsCount: targets.length,
        targets
      };
      const dir = path.dirname(this.outputPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.outputPath, JSON.stringify(payload, null, 2), 'utf8');
      return targets;
    }

    // Real canonical syndicate grouping
    const rootDir = '/home/bbliong/project/crypto-bot';
    const { groups, targets } = syncCanonicalSyndicateOutputs(rootDir);

    // Also mark watched tokens in SQLite
    const watchedMints = targets.map(t => t.tokenMint);
    try {
      this.storage.markWatchedTokens(watchedMints);
    } catch {}

    console.log(`[SYNDICATE-SELECTOR] 🎯 Selected ${targets.length} unique canonical watching targets from ${groups.length} groups.`);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      console.log(`   ${i + 1}. [${t.tokenName} | ${t.symbol}] Wallets: ${t.totalSyndicateWallets} | Mint: ${t.tokenMint} | Monitored: ${t.monitoredWallet} (${t.latestTransferWib})`);
    }

    return targets;
  }
}

// CLI runner support
if (process.argv[1] && process.argv[1].endsWith('syndicate-wallet-selector.ts')) {
  const selector = new SyndicateWalletSelector();
  const targets = selector.selectAndExport();
  console.log(`[SYNDICATE-SELECTOR] Exported to ${selector['outputPath']}`);
  process.exit(0);
}
