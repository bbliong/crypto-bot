import WebSocket from 'ws';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
// @ts-ignore
import { getSolanaRpcUrl, getSolanaRpcWsUrl } from '../scripts/solana-rpc-config.mjs';

export interface WatchedDevTarget {
  mint: string;
  symbol: string;
  devWallet: string;
  fundingWallet?: string;
  pairAddress?: string;
  ipfsUri?: string;
  ipfsHash?: string;
  subscribedAt: number;
}

export const KNOWN_AMM_PROGRAMS: Record<string, { name: string; exchange: 'meteora' | 'pumpswap' | 'raydium' }> = {
  // Pump.fun / PumpSwap
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA': { name: 'PumpAMM', exchange: 'pumpswap' },
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': { name: 'Pump.fun Bonding Curve', exchange: 'pumpswap' },

  // Meteora
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': { name: 'Meteora CPMM', exchange: 'meteora' },
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': { name: 'Meteora DAMM', exchange: 'meteora' },
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': { name: 'Meteora DLMM', exchange: 'meteora' },

  // Raydium
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': { name: 'Raydium AMM v4', exchange: 'raydium' },
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': { name: 'Raydium CPMM', exchange: 'raydium' },
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': { name: 'Raydium CLMM', exchange: 'raydium' },

  // Moonshot (DexScreener)
  'MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG': { name: 'Moonshot', exchange: 'pumpswap' },

  // Orca
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': { name: 'Orca Whirlpool', exchange: 'raydium' },
};

export interface RedeployDetectedEvent {
  oldMint: string;
  newMint: string;
  symbol: string;
  ipfsUri?: string;
  devWallet: string;
  signature: string;
  timestamp: number;
  initialMeteoraSol?: number;
  mainExchange?: 'meteora' | 'pumpswap' | 'raydium';
  mainPairAddress?: string;
  isSameSymbol?: boolean;
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
  private targetWallet: string = '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34';
  public isHuntingMode: () => boolean = () => true;

  constructor(options: { wsUrl?: string; rpcUrl?: string; dataDir?: string; targetWallet?: string } = {}) {
    super();
    this.wsUrl = options.wsUrl || getSolanaRpcWsUrl();
    this.rpcUrl = options.rpcUrl || getSolanaRpcUrl();
    this.dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
    if (options.targetWallet) this.targetWallet = options.targetWallet;

    // Pulihkan activeTarget yang tersimpan sebelumnya agar tidak reset saat service restart
    try {
      const stateFile = path.join(this.dataDir, 'follower-dev-watcher-state.json');
      if (fs.existsSync(stateFile)) {
        const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (parsed && parsed.active && parsed.target) {
          this.activeTarget = parsed.target;
          console.log(`[DEV-WATCHER] 🔄 Memulihkan target dev dari state tersimpan: ${this.activeTarget?.devWallet} (${this.activeTarget?.symbol})`);
          setTimeout(() => this.connectAndSubscribe(), 500);
        }
      }
    } catch {}

    this.saveState();
  }

  private devTokensPollerInterval: NodeJS.Timeout | null = null;
  private knownDevTokenMints: Set<string> = new Set();

  public setBrowserPage(page: any): void {
    this.browserPage = page;
    console.log('[DEV-WATCHER] 🌐 Browser page terhubung untuk GMGN Dev API integration.');
    if (this.activeTarget && this.activeTarget.devWallet) {
      this.startDevTokensPoller();
    }
  }

  public startDevTokensPoller(intervalMs: number = 6000): void {
    if (this.devTokensPollerInterval) return;
    this.devTokensPollerInterval = setInterval(async () => {
      await this.pollDevCreatedTokens();
    }, intervalMs);
    setTimeout(() => this.pollDevCreatedTokens(), 200);
  }

  public stopDevTokensPoller(): void {
    if (this.devTokensPollerInterval) {
      clearInterval(this.devTokensPollerInterval);
      this.devTokensPollerInterval = null;
    }
    this.knownDevTokenMints.clear();
  }

  public async pollDevCreatedTokens(): Promise<void> {
    const target = this.activeTarget;
    if (!target || !target.devWallet || !this.browserPage || this.browserPage.isClosed()) return;
    if (!this.isHuntingMode()) return;

    try {
      const devWallet = target.devWallet;
      const tokens = await this.browserPage.evaluate(async (dev: string) => {
        try {
          const r = await fetch(`/api/v1/dev_created_tokens/sol/${dev}`);
          const json = await r.json();
          return json?.code === 0 ? json.data?.tokens : null;
        } catch {
          return null;
        }
      }, devWallet);

      if (!tokens || !Array.isArray(tokens) || tokens.length === 0) return;

      if (this.knownDevTokenMints.size === 0) {
        for (const t of tokens) {
          if (t.token_address) this.knownDevTokenMints.add(t.token_address);
        }
        console.log(`[DEV-RADAR-MENU] 📋 Memuat ${this.knownDevTokenMints.size} token terdahulu dari Dev Token menu GMGN (${devWallet.slice(0, 8)}...). Radar menu aktif!`);
        return;
      }

      for (const t of tokens) {
        const mint = t.token_address;
        if (!mint || this.knownDevTokenMints.has(mint)) continue;

        this.knownDevTokenMints.add(mint);

        console.log(`\n=========================================================`);
        console.log(`⚡ [GMGN DEV-TOKEN MENU DETECTED] Token baru terbit di menu Dev Token GMGN!`);
        console.log(`   Simbol   : ${t.symbol}`);
        console.log(`   Mint     : ${mint}`);
        console.log(`   Pool PAIR: ${t.biggest_pool}`);
        console.log(`   Platform : ${t.launchpad_platform}`);
        console.log(`   Dev      : ${devWallet}`);
        console.log(`=========================================================\n`);

        const isPump = Boolean(t.is_pump || (t.launchpad_platform && t.launchpad_platform.includes('pump')));
        const poolLiq = Number(t.pool_liquidity || 0);
        if (!isPump && poolLiq < 100) {
          console.log(`[GMGN DEV-TOKEN MENU] ⚠️ Token ${t.symbol} non-pump dengan likuiditas rendah ($${poolLiq.toFixed(1)} < $100). Melewati pool kosong...`);
          continue;
        }
        const mainExchange = isPump ? 'pumpswap' : 'meteora';

        const evt: RedeployDetectedEvent = {
          oldMint: target.mint,
          newMint: mint,
          symbol: t.symbol || 'UNKNOWN',
          devWallet,
          signature: '',
          timestamp: Date.now(),
          initialMeteoraSol: poolLiq / 90,
          mainExchange,
          mainPairAddress: t.biggest_pool || '',
          isSameSymbol: (t.symbol || '').toUpperCase() === (target.symbol || '').toUpperCase(),
        };

        this.emit('redeploy_detected', evt);
        break;
      }
    } catch {}
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
   * Resolusi dev pembuat koin (GMGN multi_token_full_info -> Holder Creator Tag -> Genesis Fallback)
   */
  public async resolveDevAndMetadata(mintAddress: string, defaultSymbol: string = 'UNKNOWN'): Promise<{ devWallet: string; fundingWallet?: string; symbol: string; uri: string; pairAddress?: string } | null> {
    // 1. Prioritas Pertama & Paling Akurat: GMGN multi_token_full_info API (< 150ms via Browser Session)
    if (this.browserPage && !this.browserPage.isClosed()) {
      try {
        const gmgnInfo = await this.browserPage.evaluate(async (m: string) => {
          try {
            const resp = await fetch('/mrwapi/v1/multi_token_full_info', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chain: 'sol', addresses: [m] })
            });
            const json = await resp.json();
            const token = json?.data?.[0];
            if (token && token.creator_address) {
              return {
                creator: token.creator_address,
                fundingWallet: token.creator_stat?.from_address || '',
                symbol: token.symbol || '',
                pairAddress: token.biggest_pool_address || '',
              };
            }
            return null;
          } catch {
            return null;
          }
        }, mintAddress);

        if (gmgnInfo && gmgnInfo.creator) {
          console.log(`[DEV-RESOLVER] 🎯 GMGN Token Info Akurat: Dev=${gmgnInfo.creator} | Funding=${gmgnInfo.fundingWallet} | Pair=${gmgnInfo.pairAddress}`);
          return {
            devWallet: gmgnInfo.creator,
            fundingWallet: gmgnInfo.fundingWallet,
            symbol: gmgnInfo.symbol || defaultSymbol,
            uri: '',
            pairAddress: gmgnInfo.pairAddress,
          };
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
  public async watchSingleDev(mintAddress: string, symbol: string, explicitDevWallet?: string): Promise<WatchedDevTarget | null> {
    if (this.activeTarget && this.activeTarget.mint === mintAddress) {
      return this.activeTarget;
    }

    // 1. Resolusi alamat dev wallet SELALU via GMGN Creator Tag / On-Chain Genesis
    //    Field `ad` dari GMGN WebSocket BUKAN dev sesungguhnya (bisa sub-wallet/pool authority).
    //    Dev asli hanya bisa didapat dari holder tag 'creator' atau genesis tx fee payer.
    let resolved: { devWallet: string; fundingWallet?: string; symbol: string; uri: string; pairAddress?: string } | null = null;
    console.log(`[DEV-WATCHER] 🔎 Mencari alamat dev ASLI pembuat ${symbol} (${mintAddress.slice(0, 10)}...) via GMGN Creator Tag / On-Chain Genesis...`);
    resolved = await this.resolveDevAndMetadata(mintAddress, symbol);

    if (!resolved || !resolved.devWallet || resolved.devWallet === this.targetWallet) {
      console.warn(`[DEV-WATCHER] ⚠️ Tidak dapat menemukan dev wallet valid untuk ${symbol} (Dev: ${resolved?.devWallet || '-'})`);
      return null;
    }

    // 2. Jika dev wallet sama dengan yang sedang aktif, jangan putus WebSocket! Cukup perbarui token targetnya.
    if (this.activeTarget && this.activeTarget.devWallet === resolved.devWallet) {
      this.activeTarget.mint = mintAddress;
      this.activeTarget.symbol = resolved.symbol || symbol;
      if (resolved.fundingWallet) this.activeTarget.fundingWallet = resolved.fundingWallet;
      if (resolved.pairAddress) this.activeTarget.pairAddress = resolved.pairAddress;
      this.activeTarget.ipfsUri = resolved.uri;
      this.activeTarget.ipfsHash = extractIpfsHash(resolved.uri);
      this.saveState();
      console.log(`[DEV-WATCHER] 🎯 Dev wallet sama (${resolved.devWallet.slice(0, 8)}...). Memperbarui token target ke: ${this.activeTarget.symbol} [${mintAddress.slice(0, 8)}...]`);
      this.startDevTokensPoller();
      return this.activeTarget;
    }

    // 3. Hanya jika dev wallet benar-benar berbeda: lepas dev lama dan pasang ke dev baru
    this.unwatch();

    const target: WatchedDevTarget = {
      mint: mintAddress,
      symbol: resolved.symbol || symbol,
      devWallet: resolved.devWallet,
      fundingWallet: resolved.fundingWallet,
      pairAddress: resolved.pairAddress,
      ipfsUri: resolved.uri,
      ipfsHash: extractIpfsHash(resolved.uri),
      subscribedAt: Date.now()
    };

    this.activeTarget = target;
    this.saveState();
    console.log(`[DEV-WATCHER] 🎯 Terkunci pada 1 Dev: ${target.devWallet} (Token: ${target.symbol} | Funding: ${target.fundingWallet || '-'} | Pair: ${target.pairAddress || '-'})`);

    // 4. Sambungkan WebSocket logsSubscribe & mulai Dev Token menu poller
    this.connectAndSubscribe();
    this.startDevTokensPoller();
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
        if (err.message && err.message.includes('429')) {
          if (!this.wsUrl.includes('api.mainnet-beta.solana.com')) {
            console.log(`[DEV-WATCHER] 🔄 Mengalihkan WebSocket ke public Solana cluster (wss://api.mainnet-beta.solana.com)...`);
            this.wsUrl = 'wss://api.mainnet-beta.solana.com';
          }
        }
      });

      this.ws.on('close', () => {
        this.isConnecting = false;
        if (this.activeTarget) {
          const delay = this.wsUrl.includes('api.mainnet-beta.solana.com') ? 8000 : 3000;
          setTimeout(() => this.connectAndSubscribe(), delay);
        }
      });
    } catch (err: any) {
      this.isConnecting = false;
      console.warn(`[DEV-WATCHER-CONN-ERR] ${err?.message}`);
    }
  }

  private lastRotationCheckTime = 0;

  /**
   * Menangani event notifikasi log dari transaksi dev
   */
  private async handleLogsNotification(val: any): Promise<void> {
    const target = this.activeTarget;
    if (!val || !val.signature || !target) return;
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
      l.includes('Instruction: CreatePool') ||
      l.includes('Instruction: InitializeMint') ||
      l.includes('Instruction: InitializeMint2') ||
      l.includes('TokenMetadataInstruction: Initialize') ||
      Object.keys(KNOWN_AMM_PROGRAMS).some(pid => l.includes(pid))
    );

    if (!isPoolCreation) {
      // Periksa apakah ini transaksi transfer rotasi modal dev (SystemProgram.transfer)
      // Hanya cek jika transaksi transfer murni (bukan interaksi DEX/Token program yang memicu spam RPC)
      const isDexOrTokenTx = logs.some(l => 
        Object.keys(KNOWN_AMM_PROGRAMS).some(pid => l.includes(pid)) ||
        l.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') || 
        l.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
      );
      const hasSystemTransfer = !isDexOrTokenTx && logs.some(l => l.includes('11111111111111111111111111111111'));
      const now = Date.now();
      if (hasSystemTransfer && (now - this.lastRotationCheckTime > 15000)) {
        this.lastRotationCheckTime = now;
        this.checkDevCapitalRotation(sig, target);
      }
      return;
    }

    console.log(`\n=========================================================`);
    console.log(`⚡ [DEV-RADAR TRIGGER] Dev ${target.devWallet.slice(0, 8)}... baru saja mendeploy token/pool baru (tx: ${sig.slice(0, 12)}...)!`);
    console.log(`=========================================================`);

    // Ambil detail transaksi genesis koin baru secara instan (retry hingga 4x / 600ms agar pasti ter-index)
    try {
      const conn = new Connection(this.rpcUrl, 'confirmed');
      let tx: any = null;
      for (let attempt = 1; attempt <= 4; attempt++) {
        tx = await conn.getParsedTransaction(sig, {
          maxSupportedTransactionVersion: 0
        });
        if (tx && tx.transaction) break;
        if (attempt < 4) await new Promise(r => setTimeout(r, 150));
      }

      if (!tx || !tx.transaction) {
        console.warn(`[DEV-RADAR WARN] Tx genesis ${sig.slice(0, 12)}... belum ter-index oleh RPC node.`);
        return;
      }

      // Verifikasi Kriptografis: Pastikan target Dev kita ADALAH Fee Payer (Account 0) atau Signer dari transaksi ini!
      // Jika dev hanya numpang nama (misal di mentions PumpAMM sebagai referrer/fee recipient), tolak mentah-mentah!
      const feePayer = tx.transaction.message.accountKeys[0]?.pubkey
        ? tx.transaction.message.accountKeys[0].pubkey.toBase58()
        : tx.transaction.message.accountKeys[0]?.toString();
      const isDevSigner = (tx.transaction.message.accountKeys || []).some(
        (a: any) => a.signer && (a.pubkey ? a.pubkey.toBase58() === target.devWallet : a.toString() === target.devWallet)
      );
      if (feePayer !== target.devWallet && !isDevSigner) {
        console.log(`[DEV-RADAR IGNORE] Tx ${sig.slice(0, 10)}... BUKAN dibuat oleh dev kita (Fee Payer: ${feePayer?.slice(0, 8)}..., Dev kita: ${target.devWallet.slice(0, 8)}...). Mengabaikan.`);
        return;
      }

      // 0. Ekstrak langsung dari parsed instruction jika ini tx pembuatan SPL Token (InitializeMint / InitializeMint2)
      let detectedMint = '';
      let detectedSymbol = target.symbol;
      for (const ix of (tx.transaction.message.instructions || [])) {
        const parsed = (ix as any)?.parsed;
        if (parsed?.type === 'initializeMint' || parsed?.type === 'initializeMint2' || parsed?.type === 'initializeTokenMetadata') {
          if (parsed.info?.mint && parsed.info.mint !== target.devWallet) {
            detectedMint = parsed.info.mint;
            if (parsed.info?.symbol) detectedSymbol = parsed.info.symbol;
            break;
          }
        }
      }

      // Ekstrak mint koin baru secara presisi dari transferChecked / transfer di innerInstructions (Base Token liquidity deposit)
      const inner = (tx.meta as any)?.innerInstructions || [];
      if (!detectedMint) {
        for (const g of inner) {
          for (const ix of (g.instructions || [])) {
            if (ix?.parsed?.type === 'transferChecked' || ix?.parsed?.type === 'transfer') {
              const m = ix?.parsed?.info?.mint;
              if (
                m &&
                m !== 'So11111111111111111111111111111111111111112' &&
                m !== target.devWallet &&
                m !== target.mint
              ) {
                detectedMint = m;
                break;
              }
            }
          }
          if (detectedMint) break;
        }
      }

      // Fallback 1: cek inner ix pembuatan mint baru (InitializeMint / InitializeMint2)
      // DILARANG mengambil dari instruksi 'burn' karena itu adalah pembakaran LP Token oleh Dev, bukan koin baru!
      if (!detectedMint) {
        for (const g of inner) {
          for (const ix of (g.instructions || [])) {
            if (ix?.parsed?.type === 'initializeMint' || ix?.parsed?.type === 'initializeMint2' || ix?.parsed?.type === 'initializeTokenMetadata') {
              const m = ix?.parsed?.info?.mint;
              if (
                m &&
                m !== 'So11111111111111111111111111111111111111112' &&
                m !== target.devWallet &&
                m !== target.mint
              ) {
                detectedMint = m;
                if (ix?.parsed?.info?.symbol) detectedSymbol = ix.parsed.info.symbol;
                break;
              }
            }
          }
          if (detectedMint) break;
        }
      }

      // Fallback 2: cek postTokenBalances (Base Token yang didepositkan ke vault)
      if (!detectedMint) {
        const postBalances = (tx.meta as any)?.postTokenBalances || [];
        for (const b of postBalances) {
          if (
            b.mint &&
            b.mint !== 'So11111111111111111111111111111111111111112' &&
            b.mint !== target.devWallet &&
            b.mint !== target.mint
          ) {
            detectedMint = b.mint;
            break;
          }
        }
      }

      // Fallback 3: cek accountKeys
      if (!detectedMint) {
        const accs = tx.transaction.message.accountKeys;
        for (const a of accs) {
          const pk = a.pubkey ? a.pubkey.toBase58() : (a as any).toString();
          // Mint baru bukan devWallet, bukan WSOL, bukan program
          if (
            pk !== target.devWallet &&
            pk !== 'So11111111111111111111111111111111111111112' &&
            pk !== '11111111111111111111111111111111' &&
            pk !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
            pk !== 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' &&
            pk !== 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' &&
            pk !== 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG' &&
            pk !== target.mint
          ) {
            // Cek apakah akun ini adalah token mint (punya Decimals / supply)
            try {
              const accInfo = await conn.getParsedAccountInfo(new PublicKey(pk));
              if (accInfo.value && 'parsed' in accInfo.value.data) {
                const info = accInfo.value.data.parsed?.info;
                // Koin memecoin di Solana memiliki 6 desimal, sedangkan LP Token AMM memiliki 9 desimal
                if (info && info.decimals === 6 && info.supply !== undefined) {
                  detectedMint = pk;
                  break;
                }
              }
            } catch {}
          }
        }
      }

      if (detectedMint) {
        // Cek apakah simbol koin baru sesuai dengan koin target yang sedang aktif
        let detectedSymbol = target.symbol;
        try {
          const accInfo = await conn.getParsedAccountInfo(new PublicKey(detectedMint));
          const exts = (accInfo.value?.data as any)?.parsed?.info?.extensions || [];
          const tm = exts.find((e: any) => e.extension === 'tokenMetadata')?.state;
          if (tm && tm.symbol) detectedSymbol = tm.symbol;
        } catch {}

        // Abaikan jika LP token internal (MPN)
        if (detectedSymbol === 'MPN') {
          console.log(`[DEV-RADAR IGNORE] Mint ${detectedMint.slice(0, 8)}... adalah LP token (MPN). Mengabaikan.`);
          return;
        }

        const targetSym = (target.symbol || '').toUpperCase().trim();
        const newSym = (detectedSymbol || '').toUpperCase().trim();
        const isSameSymbol = Boolean(targetSym && newSym && targetSym === newSym);
        if (!isSameSymbol) {
          console.log(`[DEV-RADAR INFO] Dev deploy pool baru '${detectedSymbol}', berbeda simbol dengan koin aktif '${target.symbol}'. Meneruskan untuk S9 Front-Run...`);
        }

        // 1. Ekstrak pool pair address dan saldo awal SOL yang disetor dev
        let initialMeteoraSol = 0;
        let mainPairAddress = '';
        let detectedExchangeOwner = '';
        const inner = (tx.meta as any)?.innerInstructions || [];
        for (const g of inner) {
          for (const ix of (g.instructions || [])) {
            if (ix?.parsed?.type === 'createAccount') {
              const owner = ix?.parsed?.info?.owner;
              if (owner && KNOWN_AMM_PROGRAMS[owner]) {
                mainPairAddress = ix.parsed.info.newAccount;
                detectedExchangeOwner = owner;
              }
            }
            if (ix?.parsed?.type === 'transferChecked' || ix?.parsed?.type === 'transfer') {
              const m = ix?.parsed?.info?.mint;
              if (m === 'So11111111111111111111111111111111111111112') {
                const amt = ix?.parsed?.info?.tokenAmount?.uiAmount ?? (ix?.parsed?.info?.lamports ? ix.parsed.info.lamports / 1e9 : 0);
                if (amt > initialMeteoraSol) initialMeteoraSol = amt;
              }
            }
          }
        }

        let mainExchange: 'meteora' | 'pumpswap' | 'raydium' = 'pumpswap';
        let poolLiquidityUsd = 0;

        const matchedAmm = detectedExchangeOwner ? KNOWN_AMM_PROGRAMS[detectedExchangeOwner] : null;
        if (matchedAmm) {
          mainExchange = matchedAmm.exchange;
          // Filter Pool Kosong: Jika non-Pump (Meteora/Raydium) tapi SOL awal < 0.5 SOL, itu adalah pool umpan/kosong!
          if (mainExchange !== 'pumpswap' && initialMeteoraSol < 0.5) {
            console.log(`[DEV-RADAR POOL] ⚠️ ${matchedAmm.name} terdeteksi tapi KOSONG (Initial SOL: ${initialMeteoraSol.toFixed(3)} < 0.5 SOL). Melewati pool umpan kosong, menunggu pool riil...`);
            return;
          }
          console.log(`[DEV-RADAR POOL] 🟢 ${matchedAmm.name} valid! Initial SOL: ${initialMeteoraSol.toFixed(3)} SOL | Pool: ${mainPairAddress}`);
        } else if (initialMeteoraSol >= 0.5) {
          mainExchange = 'meteora';
          console.log(`[DEV-RADAR POOL] 🟢 Meteora DAMM fallback (SOL: ${initialMeteoraSol.toFixed(3)})`);
        } else if (mainPairAddress) {
          mainExchange = 'pumpswap';
          console.log(`[DEV-RADAR POOL] 🟢 Pool PumpAMM/PumpSwap aktif untuk token baru ${detectedSymbol} [${detectedMint.slice(0, 8)}...]!`);
        } else {
          console.log(`[DEV-RADAR POOL] ⚠️ Token mint ${detectedSymbol} [${detectedMint.slice(0, 8)}...] terdeteksi tapi belum ada pool AMM aktif. Menunggu tx pembuatan pool...`);
          return;
        }

        const evt: RedeployDetectedEvent = {
          oldMint: target.mint,
          newMint: detectedMint,
          symbol: detectedSymbol || target.symbol,
          ipfsUri: target.ipfsUri,
          devWallet: target.devWallet,
          signature: sig,
          timestamp: Date.now(),
          initialMeteoraSol,
          mainExchange,
          mainPairAddress,
          isSameSymbol,
        };

        console.log(`🚀 [DEV-RADAR SUCCESS] DITEMUKAN TOKEN RE-DEPLOY GENERASI 2!`);
        console.log(`   Mint Lama : ${evt.oldMint}`);
        console.log(`   Mint Baru : ${evt.newMint}`);
        console.log(`   Simbol    : ${evt.symbol}`);
        console.log(`   Dev Wallet: ${evt.devWallet}`);
        console.log(`   Exchange  : ${evt.mainExchange}`);
        console.log(`   Tx Hash   : ${evt.signature}`);

        this.emit('redeploy_detected', evt);
      }
    } catch (err: any) {
      console.warn(`[DEV-RADAR-RESOLVE-ERR] ${err?.message}`);
    }
  }

  /**
   * Deteksi Rotasi Dompet Dev:
   * Jika dev yang sedang dipantau mentransfer kas besar (>= 10 SOL) ke dompet lain,
   * itu adalah sinyal bahwa dev memindahkan modal ke Child Dev Wallet untuk membuat pool berikutnya!
   */
  private async checkDevCapitalRotation(sig: string, target: WatchedDevTarget): Promise<void> {
    try {
      const conn = new Connection(this.rpcUrl, 'confirmed');
      const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx || !tx.meta || !tx.transaction) return;

      const keys = tx.transaction.message.accountKeys.map((a: any) => a.pubkey ? a.pubkey.toBase58() : a.toString());
      const pre = tx.meta.preBalances;
      const post = tx.meta.postBalances;

      let senderDelta = 0;
      let newDevCandidate: string | null = null;
      let maxGain = 0;

      for (let i = 0; i < keys.length; i++) {
        const pk = keys[i];
        const delta = (post[i] - pre[i]) / 1e9;
        if (pk === target.devWallet && delta <= -10.0) {
          senderDelta = delta;
        } else if (pk !== target.devWallet && pk !== this.targetWallet && delta >= 10.0 && delta > maxGain) {
          // Abaikan program address umum
          if (
            pk !== '11111111111111111111111111111111' &&
            pk !== 'So11111111111111111111111111111111111111112' &&
            pk !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
            pk !== 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' &&
            pk !== 'ComputeBudget111111111111111111111111111111'
          ) {
            maxGain = delta;
            newDevCandidate = pk;
          }
        }
      }

      if (senderDelta <= -10.0 && newDevCandidate && maxGain >= 10.0) {
        console.log(`\n=========================================================`);
        console.log(`🚨 [DEV-ROTATION DETECTED] Sindikat Dev Memindahkan Kas!`);
        console.log(`   Dev Lama : ${target.devWallet} (Keluar: ${senderDelta.toFixed(3)} SOL)`);
        console.log(`   Dev Baru : ${newDevCandidate} (Masuk: +${maxGain.toFixed(3)} SOL)`);
        console.log(`   Token    : ${target.symbol}`);
        console.log(`   Aksi     : Memasang Radar Tambahan ke Dev Baru SEKETIKA!`);
        console.log(`=========================================================\n`);

        this.migrateToNewDev(newDevCandidate, target);
      }
    } catch (e: any) {
      console.warn(`[DEV-ROTATION-CHECK-ERR] ${e?.message}`);
    }
  }

  public migrateToNewDev(newDevWallet: string, oldTarget: WatchedDevTarget): void {
    const updated: WatchedDevTarget = {
      mint: oldTarget.mint,
      symbol: oldTarget.symbol,
      devWallet: newDevWallet,
      ipfsUri: oldTarget.ipfsUri,
      ipfsHash: oldTarget.ipfsHash,
      subscribedAt: Date.now()
    };
    this.activeTarget = updated;
    this.saveState();

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const req = {
        jsonrpc: '2.0',
        id: ++this.reqId,
        method: 'logsSubscribe',
        params: [
          { mentions: [newDevWallet] },
          { commitment: 'processed' }
        ]
      };
      this.ws.send(JSON.stringify(req));
      console.log(`[DEV-WATCHER-WS] 🟢 Berhasil memasang logsSubscribe tambahan ke Dev Baru: ${newDevWallet.slice(0, 8)}...`);
    } else {
      this.connectAndSubscribe();
    }
  }
}
