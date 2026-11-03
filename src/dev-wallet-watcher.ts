import WebSocket from 'ws';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { getSolanaRpcUrl } from '../scripts/solana-rpc-config.mjs';

export interface WatchedDevTarget {
  mint: string;
  symbol: string;
  devWallet: string;
  ipfsUri?: string;
  ipfsHash?: string;
  subscribedAt: number;
}

export interface RedeployDetectedEvent {
  oldMint: string;
  newMint: string;
  symbol: string;
  ipfsUri?: string;
  devWallet: string;
  signature: string;
  timestamp: number;
}

export function extractIpfsHash(uri?: string): string | undefined {
  if (!uri) return undefined;
  const match = uri.match(/ipfs\/(bafk[a-z0-9]+|Qm[a-zA-Z0-9]+)/i) || uri.match(/(bafk[a-z0-9]{40,}|Qm[a-zA-Z0-9]{44})/i);
  return match ? match[1] : undefined;
}

export class SingleDevWalletWatcher extends EventEmitter {
  private activeTarget: WatchedDevTarget | null = null;
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private rpcUrl: string;
  private subscriptionId: number | null = null;
  private isConnecting: boolean = false;
  private reqId: number = 1;
  private processedSigs: Set<string> = new Set();
  private pingInterval: NodeJS.Timeout | null = null;
  private dataDir: string;

  constructor(options: { wsUrl?: string; rpcUrl?: string; dataDir?: string } = {}) {
    super();
    // Gunakan public solana WebSocket yang bebas kuota dan stabil
    this.wsUrl = options.wsUrl || 'wss://api.mainnet-beta.solana.com';
    this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
    this.saveState();
  }

  private saveState(): void {
    try {
      const stateFile = path.join(this.dataDir, 'follower-dev-watcher-state.json');
      const payload = {
        updatedAt: Date.now(),
        active: !!this.activeTarget,
        target: this.activeTarget
      };
      fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), 'utf8');
    } catch {}
  }

  public getActiveTarget(): WatchedDevTarget | null {
    return this.activeTarget ? { ...this.activeTarget } : null;
  }

  /**
   * Resolusi on-chain: Cari dev pembuat koin (genesis fee payer) & IPFS metadata
   */
  public async resolveDevAndMetadata(mintAddress: string, defaultSymbol: string = 'UNKNOWN'): Promise<{ devWallet: string; symbol: string; uri: string } | null> {
    try {
      const conn = new Connection(this.rpcUrl, 'confirmed');
      const pubkey = new PublicKey(mintAddress);

      // 1. Ambil signature pertama/tertua (Genesis)
      const sigs = await conn.getSignaturesForAddress(pubkey, { limit: 1000 });
      if (!sigs || sigs.length === 0) return null;
      const oldestSig = sigs[sigs.length - 1].signature;

      // 2. Baca isi transaksi genesis untuk mengambil fee payer (Akun 0 = Dev)
      const genesisTx = await conn.getParsedTransaction(oldestSig, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0
      });
      if (!genesisTx || !genesisTx.transaction) return null;

      const accKeys = genesisTx.transaction.message.accountKeys;
      const devWallet = accKeys[0].pubkey ? accKeys[0].pubkey.toBase58() : (accKeys[0] as any).toString();

      // 3. Baca account info mint untuk mengekstrak IPFS URI
      let uri = '';
      let symbol = defaultSymbol;
      try {
        const accInfo = await conn.getParsedAccountInfo(pubkey);
        const data = accInfo.value?.data;
        if (data && 'parsed' in data) {
          const exts = (data.parsed.info.extensions || []) as any[];
          const tm = exts.find(e => e.extension === 'tokenMetadata')?.state;
          if (tm) {
            uri = tm.uri || '';
            if (tm.symbol) symbol = tm.symbol;
          }
        }
      } catch {}

      return { devWallet, symbol, uri };
    } catch (err: any) {
      console.warn(`[DEV-RESOLVER-WARN] Gagal resolusi dev wallet untuk mint ${mintAddress}: ${err?.message}`);
      return null;
    }
  }

  /**
   * Mengawasi HANYA 1 Dev Wallet per waktu.
   * Jika sebelumnya ada dev lain yang diawasi, langsung unwatch dev lama.
   */
  public async watchSingleDev(mintAddress: string, symbol: string): Promise<WatchedDevTarget | null> {
    // 1. Lepas watcher sebelumnya jika ada
    this.unwatch();

    // 2. Resolusi alamat dev wallet on-chain
    console.log(`[DEV-WATCHER] 🔎 Mencari alamat dev wallet pembuat ${symbol} (${mintAddress.slice(0, 10)}...)...`);
    const resolved = await this.resolveDevAndMetadata(mintAddress, symbol);
    if (!resolved || !resolved.devWallet) {
      console.warn(`[DEV-WATCHER] ⚠️ Tidak dapat menemukan dev wallet untuk ${symbol}`);
      return null;
    }

    const target: WatchedDevTarget = {
      mint: mintAddress,
      symbol: resolved.symbol || symbol,
      devWallet: resolved.devWallet,
      ipfsUri: resolved.uri,
      ipfsHash: extractIpfsHash(resolved.uri),
      subscribedAt: Date.now()
    };

    this.activeTarget = target;
    this.saveState();
    console.log(`[DEV-WATCHER] 🎯 Terkunci pada 1 Dev: ${target.devWallet} (Token: ${target.symbol} | IPFS: ${target.ipfsHash || '-'})`);

    // 3. Sambungkan WebSocket logsSubscribe ke dev wallet tersebut
    this.connectAndSubscribe();
    return target;
  }

  /**
   * Menghentikan pengawasan pada dev saat ini
   */
  public unwatch(): void {
    if (this.activeTarget) {
      console.log(`[DEV-WATCHER] 🛑 Melepas pengawasan dev: ${this.activeTarget.devWallet} (Token: ${this.activeTarget.symbol})`);
    }
    this.activeTarget = null;
    this.saveState();
    this.closeWs();
  }

  private closeWs(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.ws) {
      try {
        if (this.subscriptionId !== null && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: ++this.reqId,
            method: 'logsUnsubscribe',
            params: [this.subscriptionId]
          }));
        }
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }
    this.subscriptionId = null;
  }

  private connectAndSubscribe(): void {
    if (!this.activeTarget || this.isConnecting) return;
    this.isConnecting = true;

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        this.isConnecting = false;
        if (!this.activeTarget) {
          this.closeWs();
          return;
        }

        const devWallet = this.activeTarget.devWallet;
        console.log(`[DEV-WATCHER-WS] 🟢 Terhubung ke Solana WebSocket. Memasang logsSubscribe ke Dev: ${devWallet.slice(0, 8)}...`);

        const req = {
          jsonrpc: '2.0',
          id: ++this.reqId,
          method: 'logsSubscribe',
          params: [
            { mentions: [devWallet] },
            { commitment: 'processed' }
          ]
        };
        this.ws?.send(JSON.stringify(req));

        // Ping heartbeat setiap 30 detik agar koneksi tetap hidup
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.ping();
          }
        }, 30000);
      });

      this.ws.on('message', async (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          // Simpan subId
          if (msg.id && typeof msg.result === 'number') {
            this.subscriptionId = msg.result;
            return;
          }

          if (msg.method === 'logsNotification') {
            await this.handleLogsNotification(msg.params?.result?.value);
          }
        } catch (err: any) {
          console.warn(`[DEV-WATCHER-PARSE-ERR] ${err?.message}`);
        }
      });

      this.ws.on('error', (err: any) => {
        if (err.message && err.message.includes('before the connection was established')) return;
        console.warn(`[DEV-WATCHER-WS-ERR] ${err.message}`);
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        if (this.activeTarget) {
          // Reconnect otomatis jika target masih aktif
          setTimeout(() => this.connectAndSubscribe(), 3000);
        }
      });
    } catch (err: any) {
      this.isConnecting = false;
      console.warn(`[DEV-WATCHER-CONN-ERR] ${err?.message}`);
    }
  }

  /**
   * Menangani event notifikasi log dari transaksi dev
   */
  private async handleLogsNotification(val: any): Promise<void> {
    if (!val || !val.signature || !this.activeTarget) return;
    const sig = val.signature;
    if (this.processedSigs.has(sig)) return;
    this.processedSigs.add(sig);
    if (this.processedSigs.size > 200) {
      const first = this.processedSigs.values().next().value;
      if (first) this.processedSigs.delete(first);
    }

    const logs: string[] = val.logs || [];
    const isPoolCreation = logs.some(l => 
      l.includes('InitializeCustomizablePool') || 
      l.includes('InitializePool') ||
      (l.includes('TokenMetadataInstruction: Initialize') && l.includes('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'))
    );

    if (!isPoolCreation) return;

    console.log(`\n=========================================================`);
    console.log(`⚡ [DEV-RADAR TRIGGER] Dev ${this.activeTarget.devWallet.slice(0, 8)}... baru saja memanggil InitializePool (tx: ${sig.slice(0, 12)}...)!`);
    console.log(`=========================================================`);

    // Ambil detail transaksi genesis koin baru secara instan
    try {
      const conn = new Connection(this.rpcUrl, 'confirmed');
      const tx = await conn.getParsedTransaction(sig, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0
      });

      if (!tx || !tx.transaction) return;

      // Pada transaksi pool Meteora DAMM v2, akun 13 adalah mint koin baru
      const accs = tx.transaction.message.accountKeys;
      let detectedMint = '';

      for (const a of accs) {
        const pk = a.pubkey ? a.pubkey.toBase58() : (a as any).toString();
        // Mint baru bukan devWallet, bukan WSOL, bukan program
        if (
          pk !== this.activeTarget.devWallet &&
          pk !== 'So11111111111111111111111111111111111111112' &&
          pk !== '11111111111111111111111111111111' &&
          pk !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
          pk !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' &&
          pk !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' &&
          pk !== 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' &&
          pk !== this.activeTarget.mint
        ) {
          // Cek apakah akun ini adalah token mint (punya Decimals / supply)
          try {
            const accInfo = await conn.getParsedAccountInfo(new PublicKey(pk));
            if (accInfo.value && 'parsed' in accInfo.value.data) {
              const info = accInfo.value.data.parsed?.info;
              if (info && info.decimals !== undefined && info.supply !== undefined) {
                detectedMint = pk;
                break;
              }
            }
          } catch {}
        }
      }

      if (detectedMint) {
        const evt: RedeployDetectedEvent = {
          oldMint: this.activeTarget.mint,
          newMint: detectedMint,
          symbol: this.activeTarget.symbol,
          ipfsUri: this.activeTarget.ipfsUri,
          devWallet: this.activeTarget.devWallet,
          signature: sig,
          timestamp: Date.now()
        };

        console.log(`🚀 [DEV-RADAR SUCCESS] DITEMUKAN TOKEN RE-DEPLOY GENERASI 2!`);
        console.log(`   Mint Lama : ${evt.oldMint}`);
        console.log(`   Mint Baru : ${evt.newMint}`);
        console.log(`   Simbol    : ${evt.symbol}`);
        console.log(`   Dev Wallet: ${evt.devWallet}`);
        console.log(`   Tx Hash   : ${evt.signature}`);

        this.emit('redeploy_detected', evt);
      }
    } catch (err: any) {
      console.warn(`[DEV-RADAR-RESOLVE-ERR] ${err?.message}`);
    }
  }
}
