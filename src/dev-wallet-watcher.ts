import WebSocket from 'ws';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { getSolanaRpcUrl, getSolanaRpcWsUrl } from '../scripts/solana-rpc-config.mjs';

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
  private browserPage: any = null;
  private devTokensPollInterval: NodeJS.Timeout | null = null;
  private knownDevMints: Set<string> = new Set();

  constructor(options: { wsUrl?: string; rpcUrl?: string; dataDir?: string } = {}) {
    super();
    // Gunakan cluster public resmi Solana yang stabil dan bebas batas kuota bulanan
    this.wsUrl = options.wsUrl || 'wss://api.mainnet-beta.solana.com';
    this.rpcUrl = options.rpcUrl || 'https://api.mainnet-beta.solana.com';
    this.dataDir = options.dataDir || path.resolve(process.cwd(), 'data');

    // Pulihkan activeTarget yang tersimpan sebelumnya agar tidak reset saat service restart
    try {
      const stateFile = path.join(this.dataDir, 'follower-dev-watcher-state.json');
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && parsed.active && parsed.target) {
          this.activeTarget = parsed.target;
          console.log(`[DEV-WATCHER] 🔄 Memulihkan target dev dari state tersimpan: ${this.activeTarget?.devWallet} (${this.activeTarget?.symbol})`);
        }
      }
    } catch {}

    this.saveState();
  }

  public setBrowserPage(page: any): void {
    this.browserPage = page;
    console.log('[DEV-WATCHER] 🌐 Browser page terhubung untuk GMGN Dev API integration.');
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
   * Resolusi dev pembuat koin (GMGN Creator Tag -> On-Chain Genesis Fallback) & IPFS metadata
   */
  public async resolveDevAndMetadata(mintAddress: string, defaultSymbol: string = 'UNKNOWN'): Promise<{ devWallet: string; symbol: string; uri: string } | null> {
    // 1. Prioritas Pertama: Cek GMGN Token Holders API (< 100ms via Browser Session)
    if (this.browserPage && !this.browserPage.isClosed()) {
      try {
        const gmgnDev = await this.browserPage.evaluate(async (m: string) => {
          try {
            const resp = await fetch(`/vas/api/v1/token_holders/sol/${m}?limit=50&orderby=amount_percentage&direction=desc`);
            const json = await resp.json();
            const list = json?.data?.list || [];
            const creator = list.find((h: any) => (h.maker_token_tags || []).includes('creator') || (h.tags || []).includes('creator'));
            return creator ? creator.address : null;
          } catch {
            return null;
          }
        }, mintAddress);

        if (gmgnDev) {
          console.log(`[DEV-RESOLVER] ⚡ GMGN Creator Tag Terdeteksi Instan: ${gmgnDev}`);
          return { devWallet: gmgnDev, symbol: defaultSymbol, uri: '' };
        }
      } catch (err: any) {
        console.warn(`[DEV-RESOLVER-GMGN-WARN] ${err?.message}`);
      }
    }

    try {
      const conn = new Connection(this.rpcUrl, 'confirmed');
      const pubkey = new PublicKey(mintAddress);

      // 1. Ambil signature pertama/tertua (Genesis) dengan pagination mundur sampai ke blok kelahiran awal
      let oldestSig = '';
      let beforeSig: string | undefined = undefined;
      for (let hop = 0; hop < 15; hop++) {
        const options: any = { limit: 1000 };
        if (beforeSig) options.before = beforeSig;
        const batch = await conn.getSignaturesForAddress(pubkey, options);
        if (!batch || batch.length === 0) break;
        oldestSig = batch[batch.length - 1].signature;
        if (batch.length < 1000) break; // Sudah sampai genesis paling awal!
        beforeSig = oldestSig;
        await new Promise(r => setTimeout(r, 120)); // Delay antar-hop untuk menghindari rate limit
      }
      if (!oldestSig) return null;

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

    // 4. Pasang Poller GMGN dev_created_tokens sebagai radar ganda (Dual-Radar)
    this.startDevTokensPoller(target.devWallet);
    return target;
  }

  /**
   * Menghentikan pengawasan pada dev saat ini
   */
  public unwatch(): void {
    if (this.activeTarget) {
      console.log(`[DEV-WATCHER] 🛑 Melepas pengawasan dev: ${this.activeTarget.devWallet} (Token: ${this.activeTarget.symbol})`);
    }
    this.stopDevTokensPoller();
    this.activeTarget = null;
    this.saveState();
    this.closeWs();
  }

  private startDevTokensPoller(devWallet: string): void {
    this.stopDevTokensPoller();
    if (!this.activeTarget) return;

    this.knownDevMints.add(this.activeTarget.mint);

    const checkGmgnDevTokens = async () => {
      if (!this.activeTarget || !this.browserPage || this.browserPage.isClosed()) return;
      try {
        const tokens = await this.browserPage.evaluate(async (dev: string) => {
          try {
            const resp = await fetch(`/api/v1/dev_created_tokens/sol/${dev}`);
            const json = await resp.json();
            return json?.data?.tokens || [];
          } catch {
            return [];
          }
        }, devWallet);

        if (!Array.isArray(tokens) || tokens.length === 0) return;

        // Cek apakah ada token baru yang lahir
        for (const t of tokens) {
          const m = t.token_address;
          if (!m || this.knownDevMints.has(m)) continue;

          // Validasi Re-Deploy: Simbol koin baru wajib sama dengan token yang dimasuki target
          const targetSym = (this.activeTarget.symbol || '').toUpperCase().trim();
          const newSym = (t.symbol || '').toUpperCase().trim();
          if (targetSym && newSym && targetSym !== newSym) {
            this.knownDevMints.add(m);
            console.log(`[GMGN DEV-TOKENS SKIP] Dev merilis token '${t.symbol}', tetapi target sedang aktif di '${this.activeTarget.symbol}'. Melewati (Bukan Re-Deploy)...`);
            continue;
          }

          // Token baru dari dev terdeteksi (Re-Deploy)!
          this.knownDevMints.add(m);

          console.log(`\n=========================================================`);
          console.log(`🚨 [GMGN DEV-TOKENS RADAR] Dev Rilis Token Baru Terdeteksi via API!`);
          console.log(`   Token Baru : ${t.symbol} [${m.slice(0, 8)}...]`);
          console.log(`   Dev Wallet : ${devWallet}`);
          console.log(`   Pool DAMM  : ${t.biggest_pool || '-'}`);
          console.log(`   Liquidity  : $${t.pool_liquidity || '0'}`);
          console.log(`=========================================================\n`);

          const event: RedeployDetectedEvent = {
            oldMint: this.activeTarget ? this.activeTarget.mint : m,
            newMint: m,
            symbol: t.symbol || (this.activeTarget ? this.activeTarget.symbol : 'UNKNOWN'),
            devWallet: devWallet,
            signature: `gmgn_dev_pool_${t.biggest_pool || Date.now()}`,
            timestamp: Date.now()
          };

          this.emit('redeploy_detected', event);
          break; // tangani 1 token per tick
        }
      } catch (err: any) {
        // quiet error on transient page navigation
      }
    };

    checkGmgnDevTokens();
    this.devTokensPollInterval = setInterval(checkGmgnDevTokens, 2500);
  }

  private stopDevTokensPoller(): void {
    if (this.devTokensPollInterval) {
      clearInterval(this.devTokensPollInterval);
      this.devTokensPollInterval = null;
    }
    this.knownDevMints.clear();
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
        // Cek apakah simbol koin baru sesuai dengan koin target yang sedang aktif
        let detectedSymbol = this.activeTarget.symbol;
        try {
          const accInfo = await conn.getParsedAccountInfo(new PublicKey(detectedMint));
          const exts = (accInfo.value?.data as any)?.parsed?.info?.extensions || [];
          const tm = exts.find((e: any) => e.extension === 'tokenMetadata')?.state;
          if (tm && tm.symbol) detectedSymbol = tm.symbol;
        } catch {}

        const targetSym = (this.activeTarget.symbol || '').toUpperCase().trim();
        const newSym = (detectedSymbol || '').toUpperCase().trim();
        if (targetSym && newSym && targetSym !== newSym) {
          console.log(`[DEV-RADAR SKIP] Dev deploy pool baru '${detectedSymbol}', tapi target sedang aktif di '${this.activeTarget.symbol}'. Melewati (Bukan Re-Deploy)...`);
          return;
        }

        const evt: RedeployDetectedEvent = {
          oldMint: this.activeTarget.mint,
          newMint: detectedMint,
          symbol: detectedSymbol || this.activeTarget.symbol,
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
