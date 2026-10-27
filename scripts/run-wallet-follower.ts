import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { WalletFollowerLane, type WalletTradeSignal } from '../src/wallet-follower-lane.js';
import { SmartDipFollowerLane } from '../src/smart-dip-follower-lane.js';
import { getBrowserBuySwapRoute, getBrowserSellSwapRoute, DEFAULT_SWAP_WALLET } from '../src/browser-swap-route.js';
import { getSolanaRpcUrl, getSolanaRpcWsUrl } from './solana-rpc-config.mjs';

const TARGET_WALLET = '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34';
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9223';
const WALLET_PAGE_URL = `https://gmgn.ai/sol/address/${TARGET_WALLET}`;

export interface RunnerOptions {
  cdpEndpoint?: string;
  targetWallet?: string;
  dryRun?: boolean;
  onceSeconds?: number;
}

function formatWibDate(dateMs: number): string {
  const d = new Date(dateMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  // Format WIB (UTC+7)
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const wib = new Date(utc + 7 * 3600000);
  const year = wib.getFullYear();
  const month = pad(wib.getMonth() + 1);
  const day = pad(wib.getDate());
  const hours = pad(wib.getHours());
  const minutes = pad(wib.getMinutes());
  const seconds = pad(wib.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} WIB`;
}

function formatAmount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

export class WalletFollowerRunner {
  private cdpEndpoint: string;
  private targetWallet: string;
  private dryRun: boolean;
  public readonly lane: WalletFollowerLane;
  public readonly smartDipLane: SmartDipFollowerLane;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private isRunning = false;
  private subscribedTokens: Set<string> = new Set();
  private inFlightBuyMints: Set<string> = new Set();
  private inFlightSellMints: Set<string> = new Set();
  private solPriceUsd = 101.5;
  private lastMtmLogAt = 0;
  private processedTxHashes: Set<string> = new Set();
  private heliusApiKey = '';
  private heliusPollInterval: NodeJS.Timeout | null = null;
  private isPollingHelius = false;
  private heliusWs: WebSocket | null = null;
  private heliusWsReconnectTimer: NodeJS.Timeout | null = null;

  private initHeliusKey(): void {
    if (process.env.HELIUS_API_KEY) {
      this.heliusApiKey = process.env.HELIUS_API_KEY.trim();
      return;
    }
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (existsSync(envPath)) {
        const content = readFileSync(envPath, 'utf8');
        const m = content.match(/HELIUS_API_KEY=([^\s\r\n]+)/);
        if (m) this.heliusApiKey = m[1].trim();
      }
    } catch {}
  }

  private startHeliusPoller(): void {
    this.initHeliusKey();
    if (!this.heliusApiKey) {
      console.log('[HELIUS] HELIUS_API_KEY tidak ditemukan, poller on-chain dinonaktifkan.');
      return;
    }
    console.log('[HELIUS] On-chain backup poller aktif (interval: 6s)');
    this.heliusPollInterval = setInterval(async () => {
      if (!this.isRunning || this.isPollingHelius) return;
      this.isPollingHelius = true;
      try {
        await this.pollHeliusTransactions();
      } catch {} finally {
        this.isPollingHelius = false;
      }
    }, 6000);
  }

  private startHeliusWebSocket(): void {
    this.initHeliusKey();
    const wsUrl = getSolanaRpcWsUrl();
    if (!wsUrl || !this.heliusApiKey) return;

    try {
      console.log('[HELIUS WS] Menghubungkan WebSocket on-chain logsSubscribe...');
      this.heliusWs = new WebSocket(wsUrl);

      this.heliusWs.onopen = () => {
        console.log('[HELIUS WS] WebSocket on-chain terhubung! Mendengarkan real-time logs target wallet (processed commitment)...');
        const req = {
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [
            { mentions: [this.targetWallet] },
            { commitment: 'processed' },
          ],
        };
        this.heliusWs?.send(JSON.stringify(req));
      };

      this.heliusWs.onmessage = async (event: any) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data.toString();
          const msg = JSON.parse(raw);
          if (msg.method === 'logsNotification') {
            const val = msg.params?.result?.value;
            const sig = val?.signature;
            if (sig && !val?.err && !this.processedTxHashes.has(sig)) {
              console.log(`\n[HELIUS WS PUSH] Transaksi baru terdeteksi instan via WebSocket: ${sig.slice(0, 10)}...`);
              await this.processHeliusSignature(sig);
            }
          }
        } catch {}
      };

      this.heliusWs.onerror = () => {};

      this.heliusWs.onclose = () => {
        if (!this.isRunning) return;
        console.log('[HELIUS WS] Terputus. Reconnecting dalam 3 detik...');
        if (this.heliusWsReconnectTimer) clearTimeout(this.heliusWsReconnectTimer);
        this.heliusWsReconnectTimer = setTimeout(() => {
          if (this.isRunning) this.startHeliusWebSocket();
        }, 3000);
      };
    } catch (err: any) {
      console.log(`[HELIUS WS ERROR] Gagal inisiasi WebSocket: ${err.message}`);
    }
  }

  private async processHeliusSignature(sig: string): Promise<void> {
    if (this.processedTxHashes.has(sig)) return;
    this.processedTxHashes.add(sig);
    if (this.processedTxHashes.size > 2000) {
      const first = this.processedTxHashes.values().next().value;
      if (first) this.processedTxHashes.delete(first);
    }

    try {
      const url = `https://api.helius.xyz/v0/transactions?api-key=${this.heliusApiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactions: [sig] }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return;
      const txs = await res.json() as any[];
      if (!Array.isArray(txs) || txs.length === 0) return;
      const tx = txs[0];
      if (tx.type !== 'SWAP' && !tx.events?.swap) return;

      let tokenMint = null;
      let tokenDiff = 0;
      let decimals = 6;
      for (const acc of tx.accountData || []) {
        for (const ch of acc.tokenBalanceChanges || []) {
          if (ch.userAccount === this.targetWallet && ch.mint !== 'So11111111111111111111111111111111111111112') {
            tokenMint = ch.mint;
            decimals = ch.rawTokenAmount?.decimals ?? 6;
            tokenDiff += Number(ch.rawTokenAmount?.tokenAmount || 0) / (10 ** decimals);
          }
        }
      }

      if (!tokenMint || tokenDiff === 0) return;

      const action: 'buy' | 'sell' = tokenDiff > 0 ? 'buy' : 'sell';
      const tokenAmount = Math.abs(tokenDiff);

      let solDiff = 0;
      for (const acc of tx.accountData || []) {
        if (acc.account === this.targetWallet) {
          solDiff = (acc.nativeBalanceChange || 0) / 1e9;
          break;
        }
      }
      const solAmount = Math.abs(solDiff);
      const usdAmount = solAmount * this.solPriceUsd;
      const priceUsd = tokenAmount > 0 ? usdAmount / tokenAmount : 0;

      console.log(`\n---------------------------------------------------------`);
      console.log(`[HELIUS WS DETECTED] ${action.toUpperCase()} ${tokenMint.slice(0, 8)}... (${tokenAmount.toLocaleString()} tokens, ${solAmount.toFixed(3)} SOL) [sig: ${sig.slice(0, 10)}...]`);

      const signal: WalletTradeSignal = {
        action,
        mint: tokenMint,
        symbol: 'TOKEN',
        tokenName: '',
        tokenAmount,
        remainingHolding: tokenAmount,
        solAmount,
        usdAmount,
        priceUsd,
        txHash: sig,
        timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
      };

      await this.ensureTokenSubscribed(tokenMint);

      if (action === 'buy') {
        await this.handleTargetBuy(signal);
      } else {
        await this.handleTargetSell(signal);
      }
    } catch {}
  }

  private async pollHeliusTransactions(): Promise<void> {
    const url = `https://api.helius.xyz/v0/addresses/${this.targetWallet}/transactions?api-key=${this.heliusApiKey}&limit=4`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const txs = await res.json() as any[];
    if (!Array.isArray(txs)) return;

    for (const tx of txs) {
      const sig = tx.signature;
      if (!sig || this.processedTxHashes.has(sig)) continue;

      if (tx.type !== 'SWAP' && !tx.events?.swap) {
        this.processedTxHashes.add(sig);
        continue;
      }

      let tokenMint = null;
      let tokenDiff = 0;
      let decimals = 6;
      for (const acc of tx.accountData || []) {
        for (const ch of acc.tokenBalanceChanges || []) {
          if (ch.userAccount === this.targetWallet && ch.mint !== 'So11111111111111111111111111111111111111112') {
            tokenMint = ch.mint;
            decimals = ch.rawTokenAmount?.decimals ?? 6;
            tokenDiff += Number(ch.rawTokenAmount?.tokenAmount || 0) / (10 ** decimals);
          }
        }
      }

      if (!tokenMint || tokenDiff === 0) {
        this.processedTxHashes.add(sig);
        continue;
      }

      this.processedTxHashes.add(sig);
      if (this.processedTxHashes.size > 2000) {
        const first = this.processedTxHashes.values().next().value;
        if (first) this.processedTxHashes.delete(first);
      }

      const action: 'buy' | 'sell' = tokenDiff > 0 ? 'buy' : 'sell';
      const tokenAmount = Math.abs(tokenDiff);

      let solDiff = 0;
      for (const acc of tx.accountData || []) {
        if (acc.account === this.targetWallet) {
          solDiff = (acc.nativeBalanceChange || 0) / 1e9;
          break;
        }
      }
      const solAmount = Math.abs(solDiff);
      const usdAmount = solAmount * this.solPriceUsd;
      const priceUsd = tokenAmount > 0 ? usdAmount / tokenAmount : 0;

      console.log(`\n---------------------------------------------------------`);
      console.log(`[HELIUS ON-CHAIN DETECTED] ${action.toUpperCase()} ${tokenMint.slice(0, 8)}... (${tokenAmount.toLocaleString()} tokens, ${solAmount.toFixed(3)} SOL) [sig: ${sig.slice(0, 10)}...]`);

      const signal: WalletTradeSignal = {
        action,
        mint: tokenMint,
        symbol: 'TOKEN',
        tokenName: '',
        tokenAmount,
        remainingHolding: tokenAmount,
        solAmount,
        usdAmount,
        priceUsd,
        txHash: sig,
        timestamp: tx.timestamp || Math.floor(Date.now() / 1000),
      };

      await this.ensureTokenSubscribed(tokenMint);

      if (action === 'buy') {
        await this.handleTargetBuy(signal);
      } else {
        await this.handleTargetSell(signal);
      }
    }
  }

  private async refreshSolPrice(): Promise<void> {
    try {
      const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', {
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json() as any;
      if (data && data.price) {
        this.solPriceUsd = Number(data.price);
        console.log(`[SOL PRICE] Live SOL Price: $${this.solPriceUsd.toFixed(2)} USD`);
        return;
      }
    } catch {}
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
        signal: AbortSignal.timeout(3000),
      });
      const data = await res.json() as any;
      if (data?.solana?.usd) {
        this.solPriceUsd = Number(data.solana.usd);
        console.log(`[SOL PRICE] Live SOL Price (CG): $${this.solPriceUsd.toFixed(2)} USD`);
      }
    } catch {}
  }

  constructor(options: RunnerOptions = {}) {
    this.cdpEndpoint = options.cdpEndpoint || CDP_ENDPOINT;
    this.targetWallet = options.targetWallet || TARGET_WALLET;
    this.dryRun = options.dryRun || false;

    this.lane = new WalletFollowerLane({
      targetWallet: this.targetWallet,
      stakePerEntryUsd: 2.0,
      maxCapitalExposureUsd: 20.0,
      onlyNewTokens: true,
      positionsFilePath: path.resolve(process.cwd(), 'data/wallet-follower-positions.json'),
      tradesFilePath: path.resolve(process.cwd(), 'data/wallet-follower-trades.json'),
      eventsFilePath: path.resolve(process.cwd(), 'data/wallet-follower-events.json'),
    });

    this.smartDipLane = new SmartDipFollowerLane({
      targetWallet: this.targetWallet,
      stakePerTradeUsd: 5.0,
      maxCapitalExposureUsd: 20.0,
      positionsFilePath: path.resolve(process.cwd(), 'data/smart-dip-positions.json'),
      tradesFilePath: path.resolve(process.cwd(), 'data/smart-dip-trades.json'),
      eventsFilePath: path.resolve(process.cwd(), 'data/smart-dip-events.json'),
    });
  }

  public async start(durationSeconds: number = 0): Promise<void> {
    console.log(`[FOLLOWER] Memulai Dedicated Wallet Follower...`);
    console.log(`[FOLLOWER] Target Wallet: ${this.targetWallet}`);
    console.log(`[FOLLOWER] Rule: Buy $2.0/entry (Modal Kas $20 Pool, Max 10 buy tanpa sell, modal didaur ulang saat sell)`);
    console.log(`[FOLLOWER] Mode: APPLE-TO-APPLE (Hanya ikut saat target mulai beli token baru dari 0)`);
    console.log(`[FOLLOWER] Chrome CDP: ${this.cdpEndpoint}`);
    if (this.dryRun) console.log(`[FOLLOWER] MODE: DRY-RUN (Tidak mengubah posisi file)`);

    this.isRunning = true;
    await this.refreshSolPrice();
    setInterval(() => this.refreshSolPrice(), 60000);
    this.startHeliusWebSocket();
    this.startHeliusPoller();
    await this.connectAndSetup();

    if (durationSeconds > 0) {
      console.log(`[FOLLOWER] Berjalan dengan batas waktu ${durationSeconds} detik...`);
      await new Promise(r => setTimeout(r, durationSeconds * 1000));
      await this.stop();
    } else {
      // Loop heartbeat & healthcheck
      while (this.isRunning) {
        await new Promise(r => setTimeout(r, 10000));
        await this.performHealthcheck();
      }
    }
  }

  public async stop(): Promise<void> {
    console.log(`[FOLLOWER] Menghentikan Wallet Follower...`);
    this.isRunning = false;
    if (this.heliusWsReconnectTimer) {
      clearTimeout(this.heliusWsReconnectTimer);
      this.heliusWsReconnectTimer = null;
    }
    if (this.heliusWs) {
      this.heliusWs.close();
      this.heliusWs = null;
    }
    if (this.heliusPollInterval) {
      clearInterval(this.heliusPollInterval);
      this.heliusPollInterval = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    console.log(`[FOLLOWER] Stopped.`);
  }

  private async connectAndSetup(): Promise<void> {
    try {
      this.browser = await chromium.connectOverCDP(this.cdpEndpoint);
      const contexts = this.browser.contexts();
      const ctx = contexts[0] || (await this.browser.newContext());

      const pages = ctx.pages();
      let targetTab = pages.find(p => p.url().includes(this.targetWallet));

      if (!targetTab) {
        console.log(`[FOLLOWER] Tab target ${this.targetWallet} belum ada, membuka tab baru...`);
        targetTab = await ctx.newPage();
        await targetTab.goto(WALLET_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      } else {
        console.log(`[FOLLOWER] Menggunakan tab target yang sudah aktif: ${targetTab.url()}`);
      }

      this.page = targetTab;

      // Ensure initScript is active for intercepting native WebSocket
      await this.page.addInitScript(() => {
        const OrigWS = window.WebSocket;
        (window as any).__allSockets = (window as any).__allSockets || [];
        window.WebSocket = function (...args: any[]) {
          const ws = new OrigWS(...(args as [any, any]));
          (window as any).__allSockets.push(ws);
          if (args[0] && String(args[0]).includes('ws.gmgn.ai')) {
            (window as any).__gmgnWs = ws;
          }
          return ws;
        } as any;
        window.WebSocket.prototype = OrigWS.prototype;
      });

      // Hubungkan CDP Session untuk memantau network frames
      this.cdp = await ctx.newCDPSession(this.page);
      await this.cdp.send('Network.enable');

      this.cdp.on('Network.webSocketFrameReceived', ({ response }) => {
        this.handleIncomingWsFrame(response.payloadData);
      });

      // Cek apakah socket __gmgnWs sudah tersambung
      const wsReady = await this.page.evaluate(() => {
        const ws = (window as any).__gmgnWs;
        return ws && ws.readyState === 1;
      });

      if (!wsReady) {
        console.log(`[FOLLOWER] Memastikan reload tab untuk mengikat hook WebSocket GMGN...`);
        await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await this.page.waitForTimeout(3000);
      }

      console.log(`[FOLLOWER] CDP & WebSocket GMGN berhasil terhubung! Menunggu trade sinyal...`);
    } catch (err: any) {
      console.error(`[FOLLOWER-ERR] Koneksi gagal: ${err?.message}`);
      if (this.isRunning) {
        console.log(`[FOLLOWER] Mencoba reconnect dalam 5 detik...`);
        await new Promise(r => setTimeout(r, 5000));
        await this.connectAndSetup();
      }
    }
  }

  private async handleIncomingWsFrame(payload: string): Promise<void> {
    if (!payload || !payload.startsWith('{')) return;

    try {
      const msg = JSON.parse(payload);

      // 1. Tangkap aktivitas Buy / Sell dari target wallet
      if (msg.channel === 'wallet_activity_info' && Array.isArray(msg.data)) {
        for (const item of msg.data) {
          if (item.m === this.targetWallet || !item.m) {
            await this.processWalletTradeItem(item);
          }
        }
      }

      // 2. Tangkap update harga token_stat dari token yang sedang dipantau
      if (msg.channel === 'token_stat' && Array.isArray(msg.data)) {
        for (const stat of msg.data) {
          if (stat.a && stat.p) {
            const price = Number(stat.p) || 0;
            this.lane.updateTokenTick(stat.a, price);
            await this.handleSmartDipPriceTick(stat.a, price);
          }
        }
      }

      // 3. Update harga SOL jika ada
      if (msg.channel === 'major_coin_price' && Array.isArray(msg.data)) {
        for (const c of msg.data) {
          if (c.symbol === 'SOL' && c.price) {
            this.solPriceUsd = Number(c.price) || this.solPriceUsd;
          }
        }
      }
    } catch {
      // payload non-json
    }
  }

  private async processWalletTradeItem(item: any): Promise<void> {
    const action = item.e === 'buy' ? 'buy' : 'sell';
    const mint = item.a;
    if (!mint) return;

    const txHash = item.h || '';
    if (txHash && this.processedTxHashes.has(txHash)) {
      return; // Skip duplicate transaction event
    }
    if (txHash) {
      this.processedTxHashes.add(txHash);
      if (this.processedTxHashes.size > 2000) {
        const first = this.processedTxHashes.values().next().value;
        if (first) this.processedTxHashes.delete(first);
      }
    }

    const signal: WalletTradeSignal = {
      action,
      mint,
      symbol: item.bs || 'UNKNOWN',
      tokenName: item.bn || '',
      tokenAmount: Number(item.ba) || 0,
      remainingHolding: Number(item.b) || 0,
      solAmount: Number(item.qa) || 0,
      usdAmount: Number(item.au) || 0,
      priceUsd: Number(item.pu) || 0,
      txHash,
      timestamp: Number(item.t) || Math.floor(Date.now() / 1000),
    };

    console.log(`\n---------------------------------------------------------`);
    console.log(`[TARGET ACTIVITY] ${signal.action.toUpperCase()} ${signal.symbol} (${signal.mint.slice(0, 8)}...)`);
    console.log(`  Amount: ${signal.tokenAmount.toLocaleString()} tokens | Remaining: ${signal.remainingHolding.toLocaleString()} tokens`);
    console.log(`  Target USD: $${signal.usdAmount.toFixed(2)} | Price: $${signal.priceUsd} | Age: live`);

    // Dynamically subscribe token to sub-second tick channel
    await this.ensureTokenSubscribed(mint);

    if (signal.action === 'buy') {
      await this.handleTargetBuy(signal);
    } else {
      await this.handleTargetSell(signal);
    }
  }

  private async getTokenAgeMinutes(mint: string): Promise<{ ageMinutes: number | null; source: string; pairData?: any }> {
    // 1. Cek via DexScreener API
    try {
      const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const pair = data.pairs?.[0];
        if (pair?.pairCreatedAt) {
          const age = (Date.now() - pair.pairCreatedAt) / 60000;
          return { ageMinutes: age, source: 'dexscreener', pairData: pair };
        }
        if (Array.isArray(data.pairs) && data.pairs.length === 0) {
          return { ageMinutes: 0.5, source: 'dexscreener_unindexed_fresh' };
        }
      }
    } catch {}

    // 2. Fallback: Helius RPC Earliest Signature BlockTime
    try {
      const rpcUrl = getSolanaRpcUrl();
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [mint, { limit: 100 }],
        }),
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const data = await res.json() as any;
        const sigs = data.result;
        if (Array.isArray(sigs) && sigs.length > 0) {
          const oldest = sigs[sigs.length - 1];
          if (oldest.blockTime) {
            const age = (Date.now() / 1000 - oldest.blockTime) / 60;
            return { ageMinutes: age, source: 'helius_rpc' };
          }
        }
      }
    } catch {}

    return { ageMinutes: null, source: 'unknown' };
  }

  private async handleTargetBuy(signal: WalletTradeSignal): Promise<void> {
    const existing = this.lane.getPosition(signal.mint);
    let isFresh = false;
    let tokenAgeMinutes: number | null = null;
    let ageSource = 'none';

    // Periksa umur koin via DexScreener & Helius RPC
    const ageRes = await this.getTokenAgeMinutes(signal.mint);
    tokenAgeMinutes = ageRes.ageMinutes;
    ageSource = ageRes.source;

    // Jika symbol masih default TOKEN (dari Helius on-chain), lengkapi dari DexScreener
    if (signal.symbol === 'TOKEN' && ageRes.pairData?.baseToken?.symbol) {
      signal.symbol = ageRes.pairData.baseToken.symbol;
      signal.tokenName = ageRes.pairData.baseToken.name || '';
    }

    if (tokenAgeMinutes !== null) {
      if (tokenAgeMinutes <= 10) {
        isFresh = true;
        console.log(`[FRESH TOKEN DETECTED via ${ageSource}] Pool ${signal.symbol} baru berumur ${tokenAgeMinutes.toFixed(1)} menit (<= 10m). Lolos seleksi token baru!`);
      } else {
        console.log(`[OLD TOKEN FILTER via ${ageSource}] Pool ${signal.symbol} berumur ${tokenAgeMinutes.toFixed(1)} menit (> 10m). Ditolak (hanya boleh <= 10m).`);
      }
    } else {
      console.log(`[TOKEN AGE UNKNOWN] Umur pool ${signal.symbol} tidak dapat diverifikasi via DexScreener/Helius.`);
    }

    const evalBuy = this.lane.evaluateBuySignal(signal, { isFreshToken: isFresh, tokenAgeMinutes });
    const nowMs = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(nowMs);
    const eventId = `ev_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;

    if (!evalBuy.canEnter) {
      console.log(`[FOLLOW BUY SKIP] Alasan: ${evalBuy.reason}`);
      // Evaluasi Lane 2 (Smart Dip $5)
      await this.evaluateSmartDipBuy(signal, isFresh, tokenAgeMinutes);

      // Jangan spam dashboard komparasi jika target memperdagangkan koin lama / akumulasi kedaluwarsa
      if (
        evalBuy.reason.startsWith('REJECT_PRE_EXISTING_BAG') ||
        evalBuy.reason.startsWith('REJECT_OLD_TOKEN') ||
        evalBuy.reason.startsWith('REJECT_ACCUMULATE_TOKEN_AGE')
      ) {
        return;
      }
      this.lane.appendComparisonEvent({
        id: eventId,
        timestamp: nowMs,
        timeWib,
        tokenMint: signal.mint,
        tokenSymbol: signal.symbol,
        tokenName: signal.tokenName,
        target: {
          action: 'BUY',
          tokenAmount: signal.tokenAmount,
          tokenAmountFormatted: formatAmount(signal.tokenAmount),
          usdAmount: signal.usdAmount,
          priceUsd: signal.priceUsd,
          remainingHolding: signal.remainingHolding,
          remainingHoldingFormatted: formatAmount(signal.remainingHolding),
          txHash: signal.txHash,
        },
        bot: {
          action: 'HOLD_MAX_CAP',
          entryNum: evalBuy.entryNum,
          stakeUsd: 0,
          tokensBoughtOrSold: 0,
          tokensFormatted: '0',
          executionPriceUsd: signal.priceUsd,
          positionStatus: 'OPEN',
          reason: evalBuy.reason,
        },
      });
      return;
    }

    console.log(`[FOLLOW BUY TRIGGER] Masuk Entry #${evalBuy.entryNum} dengan alokasi stake $${evalBuy.stakeUsd.toFixed(2)}...`);

    if (this.dryRun || !this.page) {
      console.log(`[DRY-RUN] Simulasi Buy $2.00 pada harga $${signal.priceUsd}`);
      const estTokens = signal.priceUsd > 0 ? evalBuy.stakeUsd / signal.priceUsd : 0;
      const pos = this.lane.recordBuyExecution(signal, evalBuy.stakeUsd, estTokens, signal.priceUsd);
      this.lane.appendComparisonEvent({
        id: eventId,
        timestamp: nowMs,
        timeWib,
        tokenMint: signal.mint,
        tokenSymbol: signal.symbol,
        tokenName: signal.tokenName,
        target: {
          action: 'BUY',
          tokenAmount: signal.tokenAmount,
          tokenAmountFormatted: formatAmount(signal.tokenAmount),
          usdAmount: signal.usdAmount,
          priceUsd: signal.priceUsd,
          remainingHolding: signal.remainingHolding,
          remainingHoldingFormatted: formatAmount(signal.remainingHolding),
          txHash: signal.txHash,
        },
        bot: {
          action: 'BUY',
          entryNum: evalBuy.entryNum,
          stakeUsd: evalBuy.stakeUsd,
          tokensBoughtOrSold: estTokens,
          tokensFormatted: formatAmount(estTokens),
          executionPriceUsd: signal.priceUsd,
          positionStatus: pos.status,
          reason: `DRY_RUN_ENTRY_${evalBuy.entryNum}`,
        },
      });
      return;
    }

    try {
      const quote = await getBrowserBuySwapRoute(
        this.page,
        signal.mint,
        DEFAULT_SWAP_WALLET,
        evalBuy.stakeUsd,
        this.solPriceUsd,
        15
      );

      if (quote.ok && quote.quote) {
        if (quote.solPriceUsd && quote.solPriceUsd > 0) {
          this.solPriceUsd = quote.solPriceUsd;
        }
        const tokensBought = Number(quote.quote.outAmount || 0) / 10 ** (quote.quote.outDecimals ?? 6);
        const actualStakeUsd = quote.quote.amountInUsd && quote.quote.amountInUsd > 0 ? quote.quote.amountInUsd : evalBuy.stakeUsd;
        const execPrice = quote.impliedPriceUsd || (tokensBought > 0 ? actualStakeUsd / tokensBought : signal.priceUsd);
        console.log(`[SWAP AMM QUOTE SUCCESSS] Diterima ${tokensBought.toLocaleString()} token ${signal.symbol} | ActualStake: $${actualStakeUsd.toFixed(2)} | Implied: $${execPrice}`);

        const pos = this.lane.recordBuyExecution(signal, actualStakeUsd, tokensBought, execPrice);
        console.log(`[POSITION UPDATED] Total Stake: $${pos.totalStakeUsd.toFixed(2)} (${pos.entryCount}/5) | Tokens: ${pos.totalTokens.toLocaleString()}`);

        this.lane.appendComparisonEvent({
          id: eventId,
          timestamp: nowMs,
          timeWib,
          tokenMint: signal.mint,
          tokenSymbol: signal.symbol,
          tokenName: signal.tokenName,
          target: {
            action: 'BUY',
            tokenAmount: signal.tokenAmount,
            tokenAmountFormatted: formatAmount(signal.tokenAmount),
            usdAmount: signal.usdAmount,
            priceUsd: signal.priceUsd,
            remainingHolding: signal.remainingHolding,
            remainingHoldingFormatted: formatAmount(signal.remainingHolding),
            txHash: signal.txHash,
          },
          bot: {
            action: 'BUY',
            entryNum: evalBuy.entryNum,
            stakeUsd: actualStakeUsd,
            tokensBoughtOrSold: tokensBought,
            tokensFormatted: formatAmount(tokensBought),
            executionPriceUsd: execPrice,
            swapAmm: {
              inAmount: quote.quote.inAmount || `${actualStakeUsd.toFixed(2)} USD`,
              outAmount: quote.quote.outAmount || `${tokensBought}`,
              exchange: quote.quote.exchange || 'Raydium/Pump',
              priceImpactPct: quote.quote.priceImpactPct || 0,
            },
            positionStatus: pos.status,
            reason: `ENTRY_${evalBuy.entryNum}`,
          },
        });
      } else {
        console.warn(`[SWAP AMM QUOTE FAILED] Gagal mendapatkan quote buy swap: ${quote.error}`);
        const estTokens = signal.priceUsd > 0 ? evalBuy.stakeUsd / signal.priceUsd : 0;
        const pos = this.lane.recordBuyExecution(signal, evalBuy.stakeUsd, estTokens, signal.priceUsd);
        this.lane.appendComparisonEvent({
          id: eventId,
          timestamp: nowMs,
          timeWib,
          tokenMint: signal.mint,
          tokenSymbol: signal.symbol,
          tokenName: signal.tokenName,
          target: {
            action: 'BUY',
            tokenAmount: signal.tokenAmount,
            tokenAmountFormatted: formatAmount(signal.tokenAmount),
            usdAmount: signal.usdAmount,
            priceUsd: signal.priceUsd,
            remainingHolding: signal.remainingHolding,
            remainingHoldingFormatted: formatAmount(signal.remainingHolding),
            txHash: signal.txHash,
          },
          bot: {
            action: 'BUY',
            entryNum: evalBuy.entryNum,
            stakeUsd: evalBuy.stakeUsd,
            tokensBoughtOrSold: estTokens,
            tokensFormatted: formatAmount(estTokens),
            executionPriceUsd: signal.priceUsd,
            positionStatus: pos.status,
            reason: `SPOT_FALLBACK_ENTRY_${evalBuy.entryNum}`,
          },
        });
      }
    } catch (err: any) {
      console.error(`[EXEC-BUY-ERR] ${err?.message}`);
    }

    // Evaluasi Lane 2 (Smart Dip $5) setelah Lane 1
    await this.evaluateSmartDipBuy(signal, isFresh, tokenAgeMinutes);
  }

  private async handleTargetSell(signal: WalletTradeSignal): Promise<void> {
    const evalSell = this.lane.evaluateSellSignal(signal);
    const nowMs = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(nowMs);
    const eventId = `ev_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;

    if (!evalSell.canSell) {
      console.log(`[FOLLOW SELL SKIP] Tidak ada open position pada token ini di Lane 1.`);
      const evalSmartSell = this.smartDipLane.evaluateTargetSellSignal(signal);
      if (evalSmartSell.shouldSell && evalSmartSell.tokensToSell > 0) {
        await this.executeSmartDipTargetExit(signal, evalSmartSell.tokensToSell);
      }
      return;
    }

    console.log(`[FOLLOW SELL TRIGGER] Target Sell Ratio: ${evalSell.sellRatioPct}% | Jual ${evalSell.botTokensToSell.toLocaleString()} tokens bot... (${evalSell.isFullExit ? 'FULL EXIT' : 'PARTIAL'})`);

    if (this.dryRun || !this.page) {
      console.log(`[DRY-RUN] Simulasi Sell ${evalSell.botTokensToSell} tokens`);
      const usdReceived = evalSell.botTokensToSell * signal.priceUsd;
      const res = this.lane.recordSellExecution(signal, evalSell.botTokensToSell, usdReceived, signal.priceUsd, evalSell.isFullExit);
      if (res) {
        console.log(`[DRY-RUN EXIT] PnL: ${res.exitRecord.pnlUsd >= 0 ? '+' : ''}$${res.exitRecord.pnlUsd} (${res.exitRecord.roiPct}%)`);
        this.lane.appendComparisonEvent({
          id: eventId,
          timestamp: nowMs,
          timeWib,
          tokenMint: signal.mint,
          tokenSymbol: signal.symbol,
          tokenName: signal.tokenName,
          target: {
            action: 'SELL',
            tokenAmount: signal.tokenAmount,
            tokenAmountFormatted: formatAmount(signal.tokenAmount),
            usdAmount: signal.usdAmount,
            priceUsd: signal.priceUsd,
            remainingHolding: signal.remainingHolding,
            remainingHoldingFormatted: formatAmount(signal.remainingHolding),
            sellRatioPct: evalSell.sellRatioPct,
            txHash: signal.txHash,
          },
          bot: {
            action: 'SELL',
            tokensBoughtOrSold: evalSell.botTokensToSell,
            tokensFormatted: formatAmount(evalSell.botTokensToSell),
            executionPriceUsd: signal.priceUsd,
            pnlUsd: res.exitRecord.pnlUsd,
            roiPct: res.exitRecord.roiPct,
            isFullExit: evalSell.isFullExit,
            positionStatus: res.position.status,
            reason: `DRY_RUN_SELL_${evalSell.sellRatioPct}%`,
          },
        });
      }
      return;
    }

    try {
      const baseUnits = Math.floor(evalSell.botTokensToSell * 1_000_000).toString();
      const quote = await getBrowserSellSwapRoute(
        this.page,
        signal.mint,
        DEFAULT_SWAP_WALLET,
        baseUnits,
        6,
        15
      );

      if (quote.ok && quote.quote) {
        if (quote.solPriceUsd && quote.solPriceUsd > 0) {
          this.solPriceUsd = quote.solPriceUsd;
        }
        const usdReceived = (quote.quote.amountOutUsd && quote.quote.amountOutUsd > 0)
          ? quote.quote.amountOutUsd
          : (evalSell.botTokensToSell * (quote.impliedPriceUsd || signal.priceUsd));
        const execPrice = quote.impliedPriceUsd || (evalSell.botTokensToSell > 0 ? usdReceived / evalSell.botTokensToSell : signal.priceUsd);

        const res = this.lane.recordSellExecution(signal, evalSell.botTokensToSell, usdReceived, execPrice, evalSell.isFullExit);
        if (res) {
          console.log(`[SWAP SELL EXECUTED] UsdReceived: $${usdReceived.toFixed(2)} | Realized PnL: ${res.exitRecord.pnlUsd >= 0 ? '+' : ''}$${res.exitRecord.pnlUsd} (${res.exitRecord.roiPct}%)`);
          console.log(`[POSITION STATE] Status: ${res.position.status} | Sisa Koin: ${res.position.totalTokens.toLocaleString()}`);

          this.lane.appendComparisonEvent({
            id: eventId,
            timestamp: nowMs,
            timeWib,
            tokenMint: signal.mint,
            tokenSymbol: signal.symbol,
            tokenName: signal.tokenName,
            target: {
              action: 'SELL',
              tokenAmount: signal.tokenAmount,
              tokenAmountFormatted: formatAmount(signal.tokenAmount),
              usdAmount: signal.usdAmount,
              priceUsd: signal.priceUsd,
              remainingHolding: signal.remainingHolding,
              remainingHoldingFormatted: formatAmount(signal.remainingHolding),
              sellRatioPct: evalSell.sellRatioPct,
              txHash: signal.txHash,
            },
            bot: {
              action: 'SELL',
              tokensBoughtOrSold: evalSell.botTokensToSell,
              tokensFormatted: formatAmount(evalSell.botTokensToSell),
              executionPriceUsd: execPrice,
              swapAmm: {
                inAmount: quote.quote.inAmount || `${evalSell.botTokensToSell}`,
                outAmount: quote.quote.outAmount || `${usdReceived}`,
                exchange: quote.quote.exchange || 'Raydium/Pump',
                priceImpactPct: quote.quote.priceImpactPct || 0,
              },
              pnlUsd: res.exitRecord.pnlUsd,
              roiPct: res.exitRecord.roiPct,
              isFullExit: evalSell.isFullExit,
              positionStatus: res.position.status,
              reason: evalSell.isFullExit ? 'FULL_EXIT' : `PARTIAL_SELL_${evalSell.sellRatioPct}%`,
            },
          });
        }
      } else {
        console.warn(`[SWAP SELL QUOTE FAILED] Gagal route sell: ${quote.error}. Fallback spot.`);
        const usdReceived = evalSell.botTokensToSell * signal.priceUsd;
        const res = this.lane.recordSellExecution(signal, evalSell.botTokensToSell, usdReceived, signal.priceUsd, evalSell.isFullExit);
        if (res) {
          this.lane.appendComparisonEvent({
            id: eventId,
            timestamp: nowMs,
            timeWib,
            tokenMint: signal.mint,
            tokenSymbol: signal.symbol,
            tokenName: signal.tokenName,
            target: {
              action: 'SELL',
              tokenAmount: signal.tokenAmount,
              tokenAmountFormatted: formatAmount(signal.tokenAmount),
              usdAmount: signal.usdAmount,
              priceUsd: signal.priceUsd,
              remainingHolding: signal.remainingHolding,
              remainingHoldingFormatted: formatAmount(signal.remainingHolding),
              sellRatioPct: evalSell.sellRatioPct,
              txHash: signal.txHash,
            },
            bot: {
              action: 'SELL',
              tokensBoughtOrSold: evalSell.botTokensToSell,
              tokensFormatted: formatAmount(evalSell.botTokensToSell),
              executionPriceUsd: signal.priceUsd,
              pnlUsd: res.exitRecord.pnlUsd,
              roiPct: res.exitRecord.roiPct,
              isFullExit: evalSell.isFullExit,
              positionStatus: res.position.status,
              reason: 'SPOT_FALLBACK_SELL',
            },
          });
        }
      }
    } catch (err: any) {
      console.error(`[EXEC-SELL-ERR] ${err?.message}`);
    }

    // Evaluasi Lane 2 (Smart Dip $5) Target Exit
    const evalSmartSell = this.smartDipLane.evaluateTargetSellSignal(signal);
    if (evalSmartSell.shouldSell && evalSmartSell.tokensToSell > 0) {
      await this.executeSmartDipTargetExit(signal, evalSmartSell.tokensToSell);
    }
  }

  /**
   * Helper: Evaluasi BUY Lane 2 (Smart Dip $5 Stake)
   */
  private async evaluateSmartDipBuy(signal: WalletTradeSignal, isFresh: boolean, tokenAgeMinutes: number | null): Promise<void> {
    if (this.inFlightBuyMints.has(signal.mint)) {
      return;
    }
    this.inFlightBuyMints.add(signal.mint);
    try {
      const evalSmart = this.smartDipLane.evaluateBuySignal(signal, { isFreshToken: isFresh, tokenAgeMinutes });
      if (!evalSmart.canBuy) {
        console.log(`[SMART DIP BUY SKIP] ${evalSmart.reason}`);
        return;
      }

      console.log(`\n=========================================================`);
      console.log(`[SMART DIP BUY TRIGGER] Eksekusi ${evalSmart.buyType} untuk ${signal.symbol} ($${evalSmart.stakeUsd.toFixed(2)})...`);
      let tokensBought = 0;
      let execPrice = signal.priceUsd;
      let actualStakeUsd = evalSmart.stakeUsd;

      if (!this.dryRun && this.page && !this.page.isClosed()) {
        const quote = await getBrowserBuySwapRoute(
          this.page,
          signal.mint,
          DEFAULT_SWAP_WALLET,
          evalSmart.stakeUsd,
          this.solPriceUsd,
          15
        );
        if (quote.ok && quote.quote) {
          tokensBought = Number(quote.quote.outAmount || 0) / 10 ** (quote.quote.outDecimals ?? 6);
          actualStakeUsd = quote.quote.amountInUsd && quote.quote.amountInUsd > 0 ? quote.quote.amountInUsd : evalSmart.stakeUsd;
          execPrice = quote.impliedPriceUsd || (tokensBought > 0 ? actualStakeUsd / tokensBought : signal.priceUsd);
        }
      }

      if (tokensBought === 0 && signal.priceUsd > 0) {
        tokensBought = actualStakeUsd / signal.priceUsd;
      }

      const pos = this.smartDipLane.recordBuyExecution(signal, evalSmart.buyType, actualStakeUsd, tokensBought, execPrice);
      console.log(`[SMART DIP BUY EXECUTED] ${evalSmart.buyType} ${signal.symbol} | Stake: $${actualStakeUsd.toFixed(2)} | Tokens: ${tokensBought.toLocaleString()} @ $${execPrice}`);
      console.log(`=========================================================\n`);

      await this.ensureTokenSubscribed(signal.mint);

      const nowMs = signal.timestamp ? signal.timestamp * 1000 : Date.now();
      this.smartDipLane.appendEvent({
        id: `sd_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: nowMs,
        timeWib: formatWibDate(nowMs),
        tokenMint: signal.mint,
        tokenSymbol: signal.symbol,
        tokenName: signal.tokenName,
        action: evalSmart.buyType === 'INITIAL_BUY' ? 'BUY_INITIAL' : 'BUY_REBOUND',
        stakeOrProceedsUsd: actualStakeUsd,
        tokens: tokensBought,
        executionPriceUsd: execPrice,
        reason: evalSmart.reason,
        positionStatus: pos.status,
      });
    } finally {
      this.inFlightBuyMints.delete(signal.mint);
    }
  }

  /**
   * Helper: Evaluasi Price Tick Lane 2 (TP 30%-50%, TP >50%, Rebound TP 20%)
   */
  private async handleSmartDipPriceTick(mint: string, currentPrice: number): Promise<void> {
    if (this.inFlightSellMints.has(mint)) return;

    const tick = this.smartDipLane.evaluatePriceTick(mint, currentPrice);
    if (!tick.shouldSell || tick.tokensToSell <= 0) return;

    this.inFlightSellMints.add(mint);
    try {
      console.log(`\n---------------------------------------------------------`);
      console.log(`[SMART DIP TP TRIGGER] ${tick.sellType} untuk token ${mint.slice(0, 8)}... (${tick.reason})`);

      let tokensSold = tick.tokensToSell;
      let usdReceived = 0;
      let execPrice = currentPrice;

      if (!this.dryRun && this.page && !this.page.isClosed()) {
        const baseUnits = Math.floor(tokensSold * 1e6).toString();
        const quote = await getBrowserSellSwapRoute(this.page, mint, DEFAULT_SWAP_WALLET, baseUnits, 6, 15);
        if (quote.ok && quote.quote) {
          usdReceived = quote.quote.amountOutUsd && quote.quote.amountOutUsd > 0 ? quote.quote.amountOutUsd : (tokensSold * (quote.impliedPriceUsd || currentPrice));
          execPrice = quote.impliedPriceUsd || (tokensSold > 0 ? usdReceived / tokensSold : currentPrice);
        }
      }

      if (usdReceived === 0) {
        usdReceived = tokensSold * currentPrice;
      }

      const isFullExit = tick.sellRatioPct >= 99;
      const res = this.smartDipLane.recordSellExecution(
        mint,
        tick.sellType,
        tokensSold,
        usdReceived,
        execPrice,
        isFullExit,
        `tp_${Date.now()}`
      );

      if (res) {
        const lastExit = res.exits[res.exits.length - 1];
        console.log(`[SMART DIP SELL EXECUTED] ${tick.sellType} | UsdReceived: $${usdReceived.toFixed(2)} | PnL: ${lastExit.pnlUsd >= 0 ? '+' : ''}$${lastExit.pnlUsd} (${lastExit.roiPct}%) | Sisa Tokens: ${res.totalTokens.toLocaleString()}`);
        console.log(`---------------------------------------------------------\n`);

        const nowMs = Date.now();
        this.smartDipLane.appendEvent({
          id: `sd_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: nowMs,
          timeWib: formatWibDate(nowMs),
          tokenMint: mint,
          tokenSymbol: res.symbol,
          tokenName: res.tokenName,
          action: tick.sellType === 'TP_OVER_50_PARTIAL_70' ? 'SELL_TP_70' : (tick.sellType === 'REBOUND_TP_20_FULL' ? 'SELL_REBOUND_TP20' : 'SELL_TP_FULL'),
          stakeOrProceedsUsd: usdReceived,
          tokens: tokensSold,
          executionPriceUsd: execPrice,
          pnlUsd: lastExit.pnlUsd,
          roiPct: lastExit.roiPct,
          reason: tick.reason,
          positionStatus: res.status,
        });
      }
    } finally {
      this.inFlightSellMints.delete(mint);
    }
  }

  /**
   * Helper: Evaluasi Target Exit Lane 2 (Target Full Exit Safety Close)
   */
  private async executeSmartDipTargetExit(signal: WalletTradeSignal, tokensToSell: number): Promise<void> {
    console.log(`[SMART DIP SAFETY EXIT] Target keluar penuh! Menjual seluruh sisa token ${signal.symbol} (${tokensToSell.toLocaleString()})...`);
    let usdReceived = 0;
    let execPrice = signal.priceUsd;

    if (!this.dryRun && this.page && !this.page.isClosed()) {
      const baseUnits = Math.floor(tokensToSell * 1e6).toString();
      const quote = await getBrowserSellSwapRoute(this.page, signal.mint, DEFAULT_SWAP_WALLET, baseUnits, 6, 15);
      if (quote.ok && quote.quote) {
        usdReceived = quote.quote.amountOutUsd && quote.quote.amountOutUsd > 0 ? quote.quote.amountOutUsd : (tokensToSell * (quote.impliedPriceUsd || signal.priceUsd));
        execPrice = quote.impliedPriceUsd || (tokensToSell > 0 ? usdReceived / tokensToSell : signal.priceUsd);
      }
    }

    if (usdReceived === 0) {
      usdReceived = tokensToSell * signal.priceUsd;
    }

    const res = this.smartDipLane.recordSellExecution(
      signal.mint,
      'TARGET_EXIT',
      tokensToSell,
      usdReceived,
      execPrice,
      true,
      signal.txHash
    );

    if (res) {
      const lastExit = res.exits[res.exits.length - 1];
      console.log(`[SMART DIP SAFETY EXIT EXECUTED] PnL: ${lastExit.pnlUsd >= 0 ? '+' : ''}$${lastExit.pnlUsd} (${lastExit.roiPct}%) | Posisi CLOSED`);
      const nowMs = Date.now();
      this.smartDipLane.appendEvent({
        id: `sd_${nowMs}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: nowMs,
        timeWib: formatWibDate(nowMs),
        tokenMint: signal.mint,
        tokenSymbol: signal.symbol,
        tokenName: signal.tokenName,
        action: 'SELL_TARGET_EXIT',
        stakeOrProceedsUsd: usdReceived,
        tokens: tokensToSell,
        executionPriceUsd: execPrice,
        pnlUsd: lastExit.pnlUsd,
        roiPct: lastExit.roiPct,
        reason: 'TARGET_FULL_EXIT_SAFETY_CLOSE',
        positionStatus: res.status,
      });
    }
  }

  private async ensureTokenSubscribed(mint: string): Promise<void> {
    if (!mint || this.subscribedTokens.has(mint) || !this.page) return;

    try {
      this.subscribedTokens.add(mint);

      await this.page.evaluate(
        (targetMint) => {
          const ws = (window as any).__gmgnWs;
          if (!ws || ws.readyState !== 1) return;

          ws.send(JSON.stringify({
            action: 'subscribe',
            channel: 'token_activity',
            f: 'w',
            id: `sub_act_${targetMint.slice(0, 8)}`,
            data: [{ chain: 'sol', addresses: targetMint }],
          }));
          ws.send(JSON.stringify({
            action: 'subscribe',
            channel: 'token_stat',
            f: 'w',
            id: `sub_stat_${targetMint.slice(0, 8)}`,
            data: [{ chain: 'sol', addresses: targetMint }],
          }));
        },
        mint
      );

      console.log(`[DYNAMIC TOKEN WS] Berhasil subscribe sub-second feed untuk token: ${mint} (Total aktif: ${this.subscribedTokens.size})`);
    } catch (err: any) {
      this.subscribedTokens.delete(mint);
      console.warn(`[DYNAMIC-SUB-WARN] Gagal subscribe token: ${err?.message}`);
    }
  }

  private async unsubscribeToken(mint: string): Promise<void> {
    if (!mint || !this.subscribedTokens.has(mint) || !this.page) return;

    try {
      this.subscribedTokens.delete(mint);
      await this.page.evaluate(
        (targetMint) => {
          const ws = (window as any).__gmgnWs;
          if (!ws || ws.readyState !== 1) return;

          ws.send(JSON.stringify({
            action: 'unsubscribe',
            channel: 'token_activity',
            f: 'w',
            id: `unsub_act_${targetMint.slice(0, 8)}`,
            data: [{ chain: 'sol', addresses: targetMint }],
          }));
          ws.send(JSON.stringify({
            action: 'unsubscribe',
            channel: 'token_stat',
            f: 'w',
            id: `unsub_stat_${targetMint.slice(0, 8)}`,
            data: [{ chain: 'sol', addresses: targetMint }],
          }));
        },
        mint
      );
      console.log(`[DYNAMIC TOKEN WS] Unsubscribed token: ${mint} (Sisa: ${this.subscribedTokens.size})`);
    } catch {}
  }

  private async performHealthcheck(): Promise<void> {
    const now = Date.now();
    const openPositions = this.lane.getOpenPositions();

    // Watchdog: pastikan tab tetap berada di halaman target wallet
    if (!this.page || this.page.isClosed() || !this.page.url().includes(this.targetWallet)) {
      console.warn(`[WATCHDOG] ⚠️ Tab target terlepas (${this.page?.url()}). Mengarahkan kembali ke ${WALLET_PAGE_URL}...`);
      try {
        if (!this.page || this.page.isClosed()) {
          const ctx = this.browser?.contexts()[0];
          if (ctx) this.page = await ctx.newPage();
        }
        if (this.page) {
          await this.page.goto(WALLET_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
          this.cdp = await this.page.context().newCDPSession(this.page);
          await this.cdp.send('Network.enable');
          this.cdp.on('Network.webSocketFrameReceived', ({ response }) => {
            this.handleIncomingWsFrame(response.payloadData);
          });
          console.log(`[WATCHDOG] ✅ Berhasil merecover tab target wallet!`);
        }
      } catch (err: any) {
        console.error(`[WATCHDOG-ERR] Gagal recover tab: ${err?.message}`);
      }
    }

    if (now - this.lastMtmLogAt > 30000) {
      this.lastMtmLogAt = now;
      // Cek kesehatan WebSocket di dalam tab GMGN
      try {
        if (this.page && !this.page.isClosed()) {
          const wsReady = await this.page.evaluate(() => {
            const ws = (window as any).__gmgnWs;
            return ws ? ws.readyState : -1;
          }).catch(() => -1);
          if (wsReady !== 1 && wsReady !== -1) {
            console.warn(`[WATCHDOG] ⚠️ WebSocket GMGN di tab target terputus (readyState: ${wsReady}). Merefresh tab...`);
            await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        }
      } catch {}

      // 1. Sinkronisasi subscribe token aktif dan batch price heartbeat
      const smartOpen = this.smartDipLane.getOpenPositions();
      const allOpenMints = Array.from(new Set([
        ...openPositions.map(p => p.mint),
        ...smartOpen.map(p => p.mint)
      ]));

      for (const mint of allOpenMints) {
        if (!this.subscribedTokens.has(mint)) {
          await this.ensureTokenSubscribed(mint);
        }
      }

      // 2. Heartbeat batch price polling via DexScreener API (fallback 30s)
      if (allOpenMints.length > 0) {
        try {
          const mintsQuery = allOpenMints.slice(0, 30).join(',');
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintsQuery}`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const data = await res.json() as any;
            const pairs = data.pairs || [];
            const bestPrices = new Map<string, number>();
            for (const pair of pairs) {
              const baseMint = pair.baseToken?.address;
              const price = parseFloat(pair.priceUsd) || 0;
              const liq = pair.liquidity?.usd || 0;
              if (baseMint && price > 0) {
                if (!bestPrices.has(baseMint) || liq > 1000) {
                  bestPrices.set(baseMint, price);
                }
              }
            }

            for (const [mint, price] of bestPrices.entries()) {
              this.lane.updateTokenTick(mint, price);
              await this.handleSmartDipPriceTick(mint, price);
            }
          }
        } catch {}
      }

      console.log(`\n[HEARTBEAT] Follower Aktif | Target: ${this.targetWallet.slice(0, 8)}... | Tab: ${this.page?.url()?.slice(0, 45)}...`);
      console.log(`--- LANE 1 (Direct Scalper $20 Pool, $2/buy) ---`);
      for (const p of openPositions) {
        const curValue = p.totalTokens * p.lastObservedPriceUsd;
        const unPnl = curValue - p.remainingCostBasisUsd;
        const roi = p.remainingCostBasisUsd > 0 ? (unPnl / p.remainingCostBasisUsd) * 100 : 0;
        console.log(`  -> ${p.symbol}: Stake $${p.remainingCostBasisUsd.toFixed(2)} (${p.entryCount}/5) | CurValue: $${curValue.toFixed(2)} | UnPnl: ${unPnl >= 0 ? '+' : ''}$${unPnl.toFixed(2)} (${roi.toFixed(1)}%)`);
      }

      const smartSum = this.smartDipLane.getSummary();
      console.log(`--- LANE 2 (Smart Dip TP + Rebound, $5 Stake) | Invested: $${smartSum.totalCapitalInvested.toFixed(2)} | Realized: $${smartSum.totalRealizedPnlUsd.toFixed(2)} ---`);
      for (const sp of smartOpen) {
        const curValue = sp.totalTokens * sp.lastObservedPriceUsd;
        const unPnl = curValue - sp.remainingCostBasisUsd;
        const roi = sp.remainingCostBasisUsd > 0 ? (unPnl / sp.remainingCostBasisUsd) * 100 : 0;
        console.log(`  -> ${sp.symbol} [${sp.phase}]: Stake $${sp.remainingCostBasisUsd.toFixed(2)} | Tokens: ${sp.totalTokens.toLocaleString()} | Entry: $${sp.avgEntryPriceUsd} | CurPrice: $${sp.lastObservedPriceUsd} | UnPnl: ${unPnl >= 0 ? '+' : ''}$${unPnl.toFixed(2)} (${roi.toFixed(1)}%)`);
      }
    }
  }
}

// CLI Entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const onceArg = args.find(a => a.startsWith('--once='));
  const onceSeconds = onceArg ? parseInt(onceArg.split('=')[1], 10) : (args.includes('--once') ? 30 : 0);

  const runner = new WalletFollowerRunner({ dryRun });
  runner.start(onceSeconds).catch(err => {
    console.error('[FATAL] Runner error:', err);
    process.exit(1);
  });
}
