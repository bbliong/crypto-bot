import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getSolanaRpcUrl, getSolanaRpcWsUrl } from '../scripts/solana-rpc-config.mjs';
import { fetchTransactionWithRetry, parseTransactionRecipients } from '../scripts/scan-airdrop-clusters.mjs';
import { SyndicateSqliteStorage, SyndicateTransferRecord } from './storage/syndicate-sqlite.js';
import { syncCanonicalSyndicateOutputs } from './syndicate-canonical-grouper.js';

export interface HeliusStreamOptions {
  rootDir?: string;
  rpcWsUrl?: string;
  rpcHttpUrl?: string;
  deployers?: string[];
  autoSyncDashboard?: boolean;
}

export class HeliusDeployerStream extends EventEmitter {
  private root: string;
  private rpcWsUrl: string;
  private rpcHttpUrl: string;
  private deployers: Set<string>;
  private autoSyncDashboard: boolean;
  private ws: WebSocket | null = null;
  private isRunning: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private subMap: Map<number, string> = new Map(); // subId -> deployer
  private nextReqId: number = 1;
  private processedSigs: Set<string> = new Set();
  private storage: SyndicateSqliteStorage | null = null;

  constructor(options: HeliusStreamOptions = {}) {
    super();
    this.root = options.rootDir || '/home/bbliong/project/crypto-bot';
    this.rpcWsUrl = options.rpcWsUrl || getSolanaRpcWsUrl();
    this.rpcHttpUrl = options.rpcHttpUrl || getSolanaRpcUrl();
    this.deployers = new Set(options.deployers || []);
    this.autoSyncDashboard = options.autoSyncDashboard ?? true;

    // Load initial deployers from monitored wallets if not provided
    if (this.deployers.size === 0) {
      this.loadDeployersFromConfig();
    }
  }

  private loadDeployersFromConfig(): void {
    try {
      const watchedFile = join(this.root, 'data', 'syndicate-watch', 'gmgn-monitored-wallets.json');
      if (existsSync(watchedFile)) {
        const data = JSON.parse(readFileSync(watchedFile, 'utf8'));
        for (const t of data.targets || []) {
          if (t.deployerAddress) {
            this.deployers.add(t.deployerAddress);
          }
        }
      }

      // Also add top 5 known cluster senders if available
      const clusterFile = join(this.root, 'data', 'profit4-watch', 'airdrop-clusters.json');
      if (existsSync(clusterFile)) {
        const cData = JSON.parse(readFileSync(clusterFile, 'utf8'));
        for (const cl of (cData.clusters || []).slice(0, 10)) {
          for (const s of cl.senders || []) {
            this.deployers.add(s);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[HELIUS-STREAM] Could not load deployers: ${err?.message}`);
    }
  }

  public setDeployers(addresses: string[]): void {
    this.deployers = new Set(addresses);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.resubscribeAll();
    }
  }

  public addDeployer(address: string): void {
    if (!this.deployers.has(address)) {
      this.deployers.add(address);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.subscribeDeployer(address);
      }
    }
  }

  public getDeployers(): string[] {
    return Array.from(this.deployers);
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.connect();
  }

  public stop(): void {
    this.isRunning = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    if (this.storage) {
      this.storage.close();
      this.storage = null;
    }
    this.emit('stopped');
  }

  private connect(): void {
    if (!this.isRunning) return;

    const safeUrl = this.rpcWsUrl.replace(/api-key=[^&]+/, 'api-key=[REDACTED]');
    console.log(`[HELIUS-STREAM] Connecting to Helius WebSocket (${safeUrl})...`);

    try {
      this.ws = new WebSocket(this.rpcWsUrl);
    } catch (err: any) {
      console.error(`[HELIUS-STREAM] Connection error: ${err?.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log(`[HELIUS-STREAM] WebSocket connected. Subscribing to ${this.deployers.size} deployers...`);
      this.emit('connected');
      this.resubscribeAll();

      // Start ping keepalive every 30s to prevent inactivity timeout
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      }, 30000);
    });

    this.ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this.handleMessage(msg);
      } catch (err: any) {
        console.warn(`[HELIUS-STREAM] Error handling message: ${err?.message}`);
      }
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`[HELIUS-STREAM] WebSocket closed (code ${code}): ${reason || 'no reason'}`);
      this.ws = null;
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(`[HELIUS-STREAM] WebSocket error: ${err.message}`);
    });
  }

  private scheduleReconnect(): void {
    if (!this.isRunning || this.reconnectTimer) return;
    console.log('[HELIUS-STREAM] Reconnecting in 5 seconds...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  private resubscribeAll(): void {
    this.subMap.clear();
    for (const dep of this.deployers) {
      this.subscribeDeployer(dep);
    }
  }

  private subscribeDeployer(deployer: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const reqId = this.nextReqId++;
    const payload = {
      jsonrpc: '2.0',
      id: reqId,
      method: 'logsSubscribe',
      params: [
        { mentions: [deployer] },
        { commitment: 'confirmed' }
      ]
    };
    this.subMap.set(reqId, deployer);
    this.ws.send(JSON.stringify(payload));
  }

  private async handleMessage(msg: any): Promise<void> {
    // 1. Subscription confirmation
    if (msg.id && this.subMap.has(msg.id)) {
      const dep = this.subMap.get(msg.id);
      if (msg.result !== undefined) {
        // Map subscription ID back to deployer
        this.subMap.set(msg.result, dep!);
        // console.log(`[HELIUS-STREAM] Subscribed to deployer ${dep?.slice(0, 8)}... (subId: ${msg.result})`);
      }
      return;
    }

    // 2. Push Notification of logs
    if (msg.method === 'logsNotification' && msg.params) {
      const val = msg.params.result?.value;
      if (!val) return;
      if (val.err !== null) return; // Skip failed txs

      const signature = val.signature;
      if (!signature || this.processedSigs.has(signature)) return;
      this.processedSigs.add(signature);
      if (this.processedSigs.size > 2000) {
        // Prevent unbounded memory growth
        const first = this.processedSigs.values().next().value;
        if (first) this.processedSigs.delete(first);
      }

      const subId = msg.params.subscription;
      const deployer = this.subMap.get(subId) || 'UNKNOWN_DEPLOYER';

      console.log(`⚡ [HELIUS-STREAM] INSTANT PUSH: Deployer ${deployer.slice(0, 8)}... tx detected: ${signature.slice(0, 16)}...`);
      await this.processNewTransaction(signature, deployer);
    }
  }

  private async processNewTransaction(signature: string, deployer: string): Promise<void> {
    try {
      const tx = await fetchTransactionWithRetry(this.rpcHttpUrl, signature, 3);
      if (!tx) return;

      const recipients = parseTransactionRecipients(tx);
      if (recipients.length === 0) return;

      const blockTime = tx.blockTime || Math.floor(Date.now() / 1000);
      const timeWib = new Date(blockTime * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

      const transfers: SyndicateTransferRecord[] = [];
      let detectedMint = '';

      for (const r of recipients) {
        if (r.wallet && r.mint) {
          detectedMint = r.mint;
          transfers.push({
            txSignature: `${signature}_${r.wallet}`,
            mint: r.mint,
            tokenName: r.mint.slice(0, 8),
            symbol: 'SOL',
            fromAddress: deployer,
            toAddress: r.wallet,
            amount: '0',
            blockTime,
            timeWib,
            syndicateId: 'helius-stream',
            syndicateName: `Deployer ${deployer.slice(0, 8)}`
          });
        }
      }

      if (transfers.length > 0) {
        console.log(`🎯 [HELIUS-STREAM] Captured ${transfers.length} transfers for mint ${detectedMint.slice(0, 8)}...!`);

        if (!this.storage) {
          const dbPath = join(this.root, 'data', 'crypto-bot.sqlite');
          this.storage = new SyndicateSqliteStorage(dbPath);
        }

        const inserted = this.storage.insertTransfers(transfers, 'helius-stream');
        console.log(`💾 [HELIUS-STREAM] Inserted ${inserted} records to SQLite database.`);

        if (this.autoSyncDashboard) {
          try {
            syncCanonicalSyndicateOutputs(this.root);
            console.log(`🔄 [HELIUS-STREAM] Canonical tokens and Top 5 dashboard synced.`);
          } catch (syncErr: any) {
            console.warn(`[HELIUS-STREAM] Sync dashboard error: ${syncErr?.message}`);
          }
        }

        this.emit('transfer', {
          signature,
          deployer,
          mint: detectedMint,
          recipientsCount: recipients.length,
          blockTime,
          timeWib
        });
      }
    } catch (err: any) {
      console.error(`[HELIUS-STREAM] Error processing transaction ${signature}: ${err?.message}`);
    }
  }
}
