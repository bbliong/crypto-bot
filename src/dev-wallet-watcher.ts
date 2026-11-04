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
  initialMeteoraSol?: number;
  mainExchange?: 'meteora' | 'pumpswap' | 'raydium';
  mainPairAddress?: string;
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
          setTimeout(() => this.connectAndSubscribe(), 500);
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
    if (this.activeTarget && this.activeTarget.mint === mintAddress) {
      return this.activeTarget;
    }

    // 1. Resolusi alamat dev wallet on-chain DULU SEBELUM unwatch agar tidak ada gap/race condition
    console.log(`[DEV-WATCHER] 🔎 Mencari alamat dev wallet pembuat ${symbol} (${mintAddress.slice(0, 10)}...)...`);
    const resolved = await this.resolveDevAndMetadata(mintAddress, symbol);
    if (!resolved || !resolved.devWallet) {
      console.warn(`[DEV-WATCHER] ⚠️ Tidak dapat menemukan dev wallet untuk ${symbol}`);
      return null;
    }

    // 2. Jika dev wallet sama dengan yang sedang aktif, jangan putus WebSocket! Cukup perbarui token targetnya.
    if (this.activeTarget && this.activeTarget.devWallet === resolved.devWallet) {
      this.activeTarget.mint = mintAddress;
      this.activeTarget.symbol = resolved.symbol || symbol;
      this.activeTarget.ipfsUri = resolved.uri;
      this.activeTarget.ipfsHash = extractIpfsHash(resolved.uri);
      this.saveState();
      console.log(`[DEV-WATCHER] 🎯 Dev wallet sama (${resolved.devWallet.slice(0, 8)}...). Memperbarui token target ke: ${this.activeTarget.symbol} [${mintAddress.slice(0, 8)}...]`);
      return this.activeTarget;
    }

    // 3. Hanya jika dev wallet benar-benar berbeda: lepas dev lama dan pasang ke dev baru
    this.unwatch();

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

    // 4. Sambungkan WebSocket logsSubscribe ke dev wallet tersebut (100% Real-time Pure WebSocket)
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
      (l.includes('TokenMetadataInstruction: Initialize') && l.includes('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'))
    );

    if (!isPoolCreation) {
      // Periksa apakah ini transaksi transfer rotasi modal dev (SystemProgram.transfer)
      // Hanya cek jika transaksi transfer murni (bukan interaksi DEX/Token program yang memicu spam RPC)
      const isDexOrTokenTx = logs.some(l => 
        l.includes('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') || 
        l.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') || 
        l.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') ||
        l.includes('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
      );
      const hasSystemTransfer = !isDexOrTokenTx && logs.some(l => l.includes('11111111111111111111111111111111'));
      if (hasSystemTransfer) {
        this.checkDevCapitalRotation(sig, target);
      }
      return;
    }

    console.log(`\n=========================================================`);
    console.log(`⚡ [DEV-RADAR TRIGGER] Dev ${target.devWallet.slice(0, 8)}... baru saja memanggil InitializePool (tx: ${sig.slice(0, 12)}...)!`);
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

      // Ekstrak mint koin baru secara presisi dari transferChecked / transfer di innerInstructions (Base Token liquidity deposit)
      let detectedMint = '';
      const inner = (tx.meta as any)?.innerInstructions || [];
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

      // Fallback 1: cek inner ix mint lain yang bukan WSOL
      if (!detectedMint) {
        for (const g of inner) {
          for (const ix of (g.instructions || [])) {
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
                if (info && info.decimals !== undefined && info.supply !== undefined) {
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
        if (targetSym && newSym && targetSym !== newSym) {
          console.log(`[DEV-RADAR SKIP] Dev deploy pool baru '${detectedSymbol}', tapi target sedang aktif di '${target.symbol}'. Melewati (Bukan Re-Deploy)...`);
          return;
        }

        // 1. Hitung saldo awal SOL yang disetor dev ke pool Meteora
        let initialMeteoraSol = 0;
        const inner = (tx.meta as any)?.innerInstructions || [];
        for (const g of inner) {
          for (const ix of (g.instructions || [])) {
            if (ix?.parsed?.type === 'transferChecked' || ix?.parsed?.type === 'transfer') {
              const m = ix?.parsed?.info?.mint;
              if (m === 'So11111111111111111111111111111111111111112') {
                const amt = ix?.parsed?.info?.tokenAmount?.uiAmount ?? (ix?.parsed?.info?.lamports ? ix.parsed.info.lamports / 1e9 : 0);
                if (amt > initialMeteoraSol) initialMeteoraSol = amt;
              }
            }
          }
        }

        let mainExchange: 'meteora' | 'pumpswap' | 'raydium' = 'meteora';
        let mainPairAddress = '';
        let poolLiquidityUsd = 0;

        if (initialMeteoraSol >= 0.1) {
          mainExchange = 'meteora';
          console.log(`[DEV-RADAR POOL] 🟢 Meteora DAMM valid! Initial SOL: ${initialMeteoraSol.toFixed(3)} SOL`);
        } else {
          console.log(`[DEV-RADAR POOL WARN] ⚠️ Meteora pool cuma berisi ${initialMeteoraSol.toFixed(6)} SOL (< 0.1 SOL)! Mengecek kolam utama Pump.fun/PumpSwap...`);
          try {
            const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${detectedMint}`, { signal: AbortSignal.timeout(1500) });
            if (res.ok) {
              const data = await res.json() as any;
              const pairs = (data.pairs || []).sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
              const bestPair = pairs[0];
              if (bestPair && (bestPair.liquidity?.usd || 0) > 500) {
                mainPairAddress = bestPair.pairAddress;
                poolLiquidityUsd = bestPair.liquidity.usd;
                if (bestPair.dexId === 'pumpswap' || bestPair.dexId === 'pumpfun') {
                  mainExchange = 'pumpswap';
                } else if (bestPair.dexId === 'raydium') {
                  mainExchange = 'raydium';
                }
                console.log(`[DEV-RADAR SMART-REDIRECT] 🎯 Mengalihkan front-run ke kolam utama: ${mainExchange.toUpperCase()} (${bestPair.pairAddress.slice(0, 8)}...) dengan Likuiditas $${poolLiquidityUsd.toLocaleString()}!`);
              }
            }
          } catch {}

          if (initialMeteoraSol < 0.05 && poolLiquidityUsd < 500) {
            console.log(`[DEV-RADAR SKIP] 🚫 Kolam Meteora (${initialMeteoraSol.toFixed(6)} SOL) dan kolam alternatif tidak memiliki likuiditas valid. Melewati koin debu...`);
            return;
          }
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
        } else if (pk !== target.devWallet && delta >= 10.0 && delta > maxGain) {
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
