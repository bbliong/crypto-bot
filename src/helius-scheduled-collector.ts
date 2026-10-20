import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SyndicateSqliteStorage, type TransferRecord, type CandidateRecord } from './storage/syndicate-sqlite.js';
import { getSolanaRpcUrl } from '../scripts/solana-rpc-config.mjs';
import { fetchTransactionWithRetry, parseTransactionRecipients } from '../scripts/scan-airdrop-clusters.mjs';

export interface CollectorOptions {
  storage?: SyndicateSqliteStorage;
  rpcUrl?: string;
  outputCandidatesPath?: string;
  durationMinutes?: number;
  durationSeconds?: number;
  mockTransfers?: TransferRecord[];
}

export interface CollectorResult {
  status: 'COMPLETED' | 'INTERRUPTED' | 'ERROR';
  cycleId: string;
  transfersSaved: number;
  totalCandidates: number;
  candidates: CandidateRecord[];
  durationMs: number;
}

export class HeliusScheduledCollector {
  private storage: SyndicateSqliteStorage;
  private rpcUrl: string;
  private outputCandidatesPath: string;
  private durationSeconds: number;
  private mockTransfers?: TransferRecord[];

  constructor(options: CollectorOptions = {}) {
    this.storage = options.storage || new SyndicateSqliteStorage();
    this.rpcUrl = options.rpcUrl || getSolanaRpcUrl();
    this.outputCandidatesPath = options.outputCandidatesPath || '/home/bbliong/project/crypto-bot/data/syndicate-watch/active-candidates.json';
    this.durationSeconds = options.durationSeconds ?? ((options.durationMinutes ?? 30) * 60);
    this.mockTransfers = options.mockTransfers;
  }

  public async runWindow(): Promise<CollectorResult> {
    const startMs = Date.now();
    const cycleId = new Date(startMs).toISOString().replace(/[:.]/g, '-');
    const endMs = startMs + (this.durationSeconds * 1000);

    console.log(`[HELIUS-COLLECTOR] 🚀 Starting ${this.durationSeconds}s ingestion window for cycle ${cycleId}...`);

    let transfersToSave: TransferRecord[] = [];

    // If mockTransfers provided (e.g. for testing)
    if (this.mockTransfers && this.mockTransfers.length > 0) {
      transfersToSave = [...this.mockTransfers];
    } else {
      // Real collection from cluster cache and Helius RPC
      try {
        transfersToSave = await this.collectRealSyndicateTransfers(endMs);
      } catch (err: any) {
        console.warn(`[HELIUS-COLLECTOR-WARN] Error during collection: ${err?.message}`);
      }
    }

    // Persist all transfers to SQLite
    this.storage.insertTransfers(transfersToSave, cycleId);

    // Recompute ranked candidates for this cycle
    const candidates = this.storage.recomputeCandidates(cycleId);

    // Export comprehensive candidates JSON
    this.storage.exportAllCandidatesJson(this.outputCandidatesPath);

    const durationMs = Date.now() - startMs;
    console.log(`[HELIUS-COLLECTOR] ✅ Window completed in ${(durationMs / 1000).toFixed(1)}s. Saved ${transfersToSave.length} transfers across ${candidates.length} candidate tokens.`);

    return {
      status: 'COMPLETED',
      cycleId,
      transfersSaved: transfersToSave.length,
      totalCandidates: candidates.length,
      candidates,
      durationMs
    };
  }

  private async collectRealSyndicateTransfers(deadlineMs: number): Promise<TransferRecord[]> {
    const transfers: TransferRecord[] = [];
    const root = '/home/bbliong/project/crypto-bot';
    const txCacheFile = path.join(root, 'data/profit4-watch/tx-cluster-cache.json');
    const airdropClusterFile = path.join(root, 'data/profit4-watch/airdrop-clusters.json');

    // 1. Ingest existing cached transfers
    if (existsSync(txCacheFile)) {
      try {
        const cacheData = JSON.parse(readFileSync(txCacheFile, 'utf8'));
        for (const [txId, item] of Object.entries(cacheData) as [string, any][]) {
          if (!item.mint || !item.recipients || item.recipients.length === 0) continue;
          const blockTime = item.timestamp || Math.floor((item.fetchedAt || Date.now()) / 1000);
          const timeWib = new Date(blockTime * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';
          
          for (const recipient of item.recipients) {
            transfers.push({
              txSignature: `${txId}_${recipient}`,
              mint: item.mint,
              tokenName: item.symbol || item.mint.slice(0, 8),
              symbol: item.symbol || 'MEME',
              fromAddress: item.from || 'DEPLOYER_CLUSTER',
              toAddress: recipient,
              amount: String(item.amount || '0'),
              blockTime,
              timeWib,
              syndicateId: 'cluster-sync',
              syndicateName: item.symbol ? `${item.symbol} Syndicate` : 'Syndicate Fleet'
            });
          }
        }
      } catch (err: any) {
        console.warn(`[HELIUS-COLLECTOR] Error loading tx cache: ${err?.message}`);
      }
    }

    // 2. Query Helius RPC for recent signatures of top active deployers if time remains
    if (Date.now() < deadlineMs && existsSync(airdropClusterFile)) {
      try {
        const airdropData = JSON.parse(readFileSync(airdropClusterFile, 'utf8'));
        const clusters = airdropData.clusters || [];
        const deployers: string[] = [];
        for (const cl of clusters) {
          if (cl.senders && cl.senders.length > 0) {
            for (const s of cl.senders) {
              if (!deployers.includes(s)) deployers.push(s);
            }
          }
        }

        console.log(`[HELIUS-COLLECTOR] Polling active deployers (total: ${deployers.length}) via Helius RPC...`);
        for (const dep of deployers.slice(0, 15)) {
          if (Date.now() >= deadlineMs) break;

          try {
            const reqData = {
              jsonrpc: '2.0',
              id: 1,
              method: 'getSignaturesForAddress',
              params: [dep, { limit: 5 }]
            };
            const resp = await fetch(this.rpcUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(reqData)
            });
            if (!resp.ok) continue;
            const data = await resp.json();
            const sigs = (data.result || []).map((s: any) => s.signature);

            for (const sig of sigs) {
              if (Date.now() >= deadlineMs) break;
              // Check if already parsed
              if (transfers.some(t => t.txSignature.startsWith(sig))) continue;

              const tx = await fetchTransactionWithRetry(this.rpcUrl, sig, 2);
              if (!tx) continue;

              const recipients = parseTransactionRecipients(tx);
              const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);
              const timeWib = new Date(blockTime * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

              for (const r of recipients) {
                if (r.wallet && r.mint) {
                  transfers.push({
                    txSignature: `${sig}_${r.wallet}`,
                    mint: r.mint,
                    tokenName: r.mint.slice(0, 8),
                    symbol: 'SOL',
                    fromAddress: dep,
                    toAddress: r.wallet,
                    amount: '0',
                    blockTime,
                    timeWib,
                    syndicateId: 'live-helius',
                    syndicateName: 'Live Syndicate'
                  });
                }
              }
            }
          } catch {}
        }
      } catch (err: any) {
        console.warn(`[HELIUS-COLLECTOR] Polling deployers error: ${err?.message}`);
      }
    }

    return transfers;
  }
}

// CLI runner support
if (process.argv[1] && process.argv[1].endsWith('helius-scheduled-collector.ts')) {
  const durationSec = process.argv.includes('--duration-seconds')
    ? Number(process.argv[process.argv.indexOf('--duration-seconds') + 1])
    : 1800; // default 30 min

  const collector = new HeliusScheduledCollector({ durationSeconds: durationSec });
  collector.runWindow().then(res => {
    console.log('[HELIUS-COLLECTOR] Done:', JSON.stringify(res, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error('[HELIUS-COLLECTOR-ERR]', err);
    process.exit(1);
  });
}
