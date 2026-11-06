import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { WalletFollowerLane, type WalletTradeSignal } from '../src/wallet-follower-lane.js';
import { SmartDipFollowerLane } from '../src/smart-dip-follower-lane.js';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import { SingleDevWalletWatcher } from '../src/dev-wallet-watcher.js';
import { getBrowserBuySwapRoute, getBrowserSellSwapRoute, DEFAULT_SWAP_WALLET } from '../src/browser-swap-route.js';
import { getSolanaRpcUrl, getSolanaRpcWsUrl } from './solana-rpc-config.mjs';
import {
  readFollowerLiveConfig,
  saveFollowerLiveConfig,
  readFollowerRealState,
  writeFollowerRealState,
  auditFollowerReal,
  atomicWriteJson,
  getCompletedRealBuysCount,
  generateFollowerPositionId,
  REAL_ACTIVE_STATUSES,
  type FollowerRealPosition,
  type FollowerLiveConfig,
} from '../src/follower-live-store.js';
import { FollowerLiveAdapter } from '../src/follower-live-adapter.js';

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
  public readonly multiDryRunEngine: MultiScenarioDryRunEngine;
  public readonly devWatcher: SingleDevWalletWatcher;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private isRunning = false;
  private subscribedTokens: Set<string> = new Set();
  private inFlightBuyMints: Set<string> = new Set();
  private inFlightSellMints: Set<string> = new Set();
  private liveAdapter: FollowerLiveAdapter = new FollowerLiveAdapter();
  private dataDir: string = path.resolve(process.cwd(), 'data');
  private lastReadinessCheck = 0;
  private solPriceUsd = 101.5;
  private lastMtmLogAt = 0;
  private processedTxHashes: Set<string> = new Set();
  private heliusApiKey = '';
  private heliusPollInterval: NodeJS.Timeout | null = null;
  private fastSellRetryInterval: NodeJS.Timeout | null = null;
  private timeStopInterval: NodeJS.Timeout | null = null;
  private isPollingHelius = false;
  private probeQueue: Array<{
    side: 'BUY' | 'SELL';
    scenarioId: string;
    signal: WalletTradeSignal;
    stakeUsd: number;
    tokens?: number;
    priceUsd: number;
    reason: string;
  }> = [];
  private isProcessingProbeQueue = false;
  private heliusWs: WebSocket | null = null;
  private heliusWsReconnectTimer: NodeJS.Timeout | null = null;
  private startTimeSec: number = Math.floor(Date.now() / 1000);

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
      if (tx.timestamp && tx.timestamp < this.startTimeSec) return;

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
    txs.reverse(); // Chronological oldest to newest

    for (const tx of txs) {
      const sig = tx.signature;
      if (!sig || this.processedTxHashes.has(sig)) continue;

      if (tx.timestamp && tx.timestamp < this.startTimeSec) {
        this.processedTxHashes.add(sig);
        continue;
      }

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

    const initialCfg = readFollowerLiveConfig(this.dataDir);
    const stakeL1 = initialCfg.stakeUsdLane1 !== undefined ? initialCfg.stakeUsdLane1 : 0.25;
    const stakeL2 = initialCfg.stakeUsdLane2 !== undefined ? initialCfg.stakeUsdLane2 : 0.25;

    this.lane = new WalletFollowerLane({
      targetWallet: this.targetWallet,
      stakePerEntryUsd: stakeL1,
      maxCapitalExposureUsd: stakeL1 * 10,
      onlyNewTokens: true,
      positionsFilePath: path.resolve(process.cwd(), 'data/wallet-follower-positions.json'),
      tradesFilePath: path.resolve(process.cwd(), 'data/wallet-follower-trades.json'),
      eventsFilePath: path.resolve(process.cwd(), 'data/wallet-follower-events.json'),
    });

    this.smartDipLane = new SmartDipFollowerLane({
      targetWallet: this.targetWallet,
      stakePerTradeUsd: stakeL2,
      maxCapitalExposureUsd: stakeL2 * 10,
      positionsFilePath: path.resolve(process.cwd(), 'data/smart-dip-positions.json'),
      tradesFilePath: path.resolve(process.cwd(), 'data/smart-dip-trades.json'),
      eventsFilePath: path.resolve(process.cwd(), 'data/smart-dip-events.json'),
    });

    this.multiDryRunEngine = new MultiScenarioDryRunEngine(this.dataDir);

    // Radar 1 Dev Wallet: Memantau 1 dev aktif dan mendeteksi koin baru sebelum target buy
    this.devWatcher = new SingleDevWalletWatcher();
    this.devWatcher.on('redeploy_detected', (evt) => {
      console.log(`\n=========================================================`);
      console.log(`🚨 [DEV-RADAR TRIGGER] Terdeteksi Pool Baru Lahir dari Dev: ${evt.symbol} [${evt.newMint.slice(0, 8)}...]`);
      console.log(`   Dev Wallet : ${evt.devWallet}`);
      console.log(`   Tx Genesis : ${evt.signature}`);
      console.log(`   Mengeksekusi BUY Proaktif S6/S7/S8 (SEBELUM Target Masuk)!`);
      console.log(`=========================================================\n`);
      this.multiDryRunEngine.handleEarlyRedeployBuy(evt);
    });

    // Enqueue swap route probe untuk masing-masing skenario (S4 & S6):
    // Rute swap DEX/AMM selalu dicek. Order nyata batch_order & rent reclaim dikontrol oleh config autobuyScenario.
    this.multiDryRunEngine.onTradeAction = (action, scenarioId, signal, details) => {
      this.enqueueGmgnApiProbe({
        side: action,
        scenarioId,
        signal,
        stakeUsd: details.stakeUsd || 5.0,
        tokens: details.tokens,
        priceUsd: details.priceUsd,
        reason: details.reason,
      });
    };
  }

  public async start(durationSeconds: number = 0): Promise<void> {
    const curCfg = readFollowerLiveConfig(this.dataDir);
    const curStakeL1 = curCfg.stakeUsdLane1 !== undefined ? curCfg.stakeUsdLane1 : 0.25;
    const curStakeL2 = curCfg.stakeUsdLane2 !== undefined ? curCfg.stakeUsdLane2 : 0.25;

    console.log(`[FOLLOWER] Memulai Dedicated Wallet Follower...`);
    console.log(`[FOLLOWER] Target Wallet: ${this.targetWallet}`);
    console.log(`[FOLLOWER] Rule: Buy $${curStakeL1.toFixed(2)}/entry di Lane 1, $${curStakeL2.toFixed(2)}/entry di Lane 2 (Sinkron Auto-Buy Config)`);
    console.log(`[FOLLOWER] Mode: APPLE-TO-APPLE (Hanya ikut saat target mulai beli token baru dari 0)`);
    console.log(`[FOLLOWER] Chrome CDP: ${this.cdpEndpoint}`);
    if (this.dryRun) console.log(`[FOLLOWER] MODE: DRY-RUN (Tidak mengubah posisi file)`);

    this.isRunning = true;
    await this.refreshSolPrice();
    setInterval(() => this.refreshSolPrice(), 60000);
    this.startHeliusWebSocket();
    this.startHeliusPoller();
    await this.connectAndSetup();

    // Loop retry cepat (1.5 detik) khusus eksekusi Real Sell jika rute AMM sempat gagal/delay
    this.fastSellRetryInterval = setInterval(() => this.fastRetryPendingRealSells(), 1500);

    // Loop time-stop aktif (setiap 1 detik) khusus Skenario 7 Time-Stop (Force Exit @ 28s)
    this.timeStopInterval = setInterval(() => {
      try {
        this.multiDryRunEngine.checkTimeStopExits(28000);
      } catch {}
    }, 1000);

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
    if (this.fastSellRetryInterval) {
      clearInterval(this.fastSellRetryInterval);
      this.fastSellRetryInterval = null;
    }
    if (this.timeStopInterval) {
      clearInterval(this.timeStopInterval);
      this.timeStopInterval = null;
    }
    if (this.devWatcher) {
      this.devWatcher.unwatch();
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
      this.liveAdapter.attachPageListeners(this.page);
      this.devWatcher.setBrowserPage(this.page);

      // Trigger user info fetch to capture fresh Bearer Authorization header immediately
      this.page.evaluate(() => {
        fetch('/api/v1/user/info', { credentials: 'include' }).catch(() => {});
      }).catch(() => {});

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
          if (item.a) {
            this.smartDipLane.recordTokenActivity(item.a);
          }
          if (item.m === this.targetWallet || !item.m) {
            console.log(`[GMGN WS RAW ITEM] Event: ${item.e} | Keys: ${Object.keys(item).join(',')} | Raw: ${JSON.stringify(item)}`);
            await this.processWalletTradeItem(item);
          }
        }
      }

      // 1.1 Tangkap token_activity (transaksi buy / sell umum di koin yang dipantau)
      if (msg.channel === 'token_activity' && Array.isArray(msg.data)) {
        for (const act of msg.data) {
          if (act.a) {
            this.smartDipLane.recordTokenActivity(act.a);
          }
        }
      }

      // 2. Tangkap update harga token_stat dari token yang sedang dipantau
      if (msg.channel === 'token_stat' && Array.isArray(msg.data)) {
        for (const stat of msg.data) {
          if (stat.a && stat.p) {
            const price = Number(stat.p) || 0;
            this.smartDipLane.recordTokenActivity(stat.a);
            this.lane.updateTokenTick(stat.a, price);
            this.multiDryRunEngine.updatePriceTick(stat.a, price);
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

    const isOpenOrClose = item.ooc === 1 || item.is_open_or_close === 1;
    // Deteksi First Buy resmi dari payload GMGN (ooc = 1 pada event buy, atau hba = 0)
    const isFirstBuy = action === 'buy' && (
      item.ooc === 1 ||
      item.is_open_or_close === 1 ||
      item.event_type === 'new_holder' ||
      (Number(item.hba || 0) === 0 && Number(item.b || 0) === Number(item.ba || 0))
    );
    const isSellAll = action === 'sell' && (
      item.ooc === 1 ||
      item.is_open_or_close === 1 ||
      item.event_type === 'sell_all' ||
      Number(item.b || 0) <= 0
    );

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
      isOpenOrClose,
      isFirstBuy,
      pairAddress: item.pa || '',
      exchange: item.exchange || ''
    };

    console.log(`\n---------------------------------------------------------`);
    console.log(`[TARGET ACTIVITY] ${signal.action.toUpperCase()} ${signal.symbol} (${signal.mint.slice(0, 8)}...) | Tag: ${signal.isFirstBuy ? 'FIRST_BUY 🟢' : (signal.action === 'buy' ? 'BUY_MORE 🔵' : (isSellAll ? 'SELL_ALL 🔴' : 'PARTIAL_SELL 🟡'))}`);
    console.log(`  Amount: ${signal.tokenAmount.toLocaleString()} tokens | Remaining: ${signal.remainingHolding.toLocaleString()} tokens | OOC: ${item.ooc ?? item.is_open_or_close ?? '-'}`);
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
        if (data.pairs === null || (Array.isArray(data.pairs) && data.pairs.length === 0)) {
          return { ageMinutes: 0.5, source: 'dexscreener_unindexed_fresh' };
        }
      }
    } catch {}

    // 2. Fallback: Solana RPC Earliest Signature BlockTime (dengan failover ke public RPC jika Helius habis kuota)
    const fallbackRpcs = [getSolanaRpcUrl(), 'https://api.mainnet-beta.solana.com'].filter(Boolean);
    for (const rpcUrl of fallbackRpcs) {
      try {
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
              return { ageMinutes: age, source: rpcUrl.includes('helius') ? 'helius_rpc' : 'mainnet_rpc' };
            }
          }
        }
      } catch {}
    }

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

    // Selalu sinkronkan modal stake Paper Lane 1 & Lane 2 dengan konfigurasi Auto-Buy terkini
    const liveCfg = readFollowerLiveConfig(this.dataDir);
    if (liveCfg.stakeUsdLane1) this.lane.setStakePerEntryUsd(liveCfg.stakeUsdLane1);
    if (liveCfg.stakeUsdLane2) this.smartDipLane.setStakePerTradeUsd(liveCfg.stakeUsdLane2);

    const targetBalanceBefore = Math.max(0, signal.remainingHolding - signal.tokenAmount);
    const isGroundZero = (signal.isFirstBuy === true) || (targetBalanceBefore <= 0.05 * signal.tokenAmount || targetBalanceBefore <= 1000);

    // Filter Anti-Pucuk (Ground-Zero Price Cap): Jika ini First Buy, harga wajib <= $0.000020
    const GROUND_ZERO_MAX_PRICE_USD = 0.000020;
    if (isGroundZero && signal.priceUsd > GROUND_ZERO_MAX_PRICE_USD) {
      console.log(`[PRICE CAP GATE] 🚫 Target First Buy pada $${signal.priceUsd.toFixed(8)} melebihi batas Ground Zero $${GROUND_ZERO_MAX_PRICE_USD.toFixed(6)}. Melewati buy (anti-pucuk)!`);
      this.multiDryRunEngine.handleTargetBuy(signal, false);
      return;
    }

    this.multiDryRunEngine.handleTargetBuy(signal, isGroundZero);

    // Pantau HANYA 1 Dev Wallet secara real-time via Solana WebSocket (Sub-second radar)
    const currentWatched = this.devWatcher.getActiveTarget();
    const shouldWatch = (isGroundZero && signal.priceUsd <= GROUND_ZERO_MAX_PRICE_USD) || (!currentWatched && signal.priceUsd <= 0.000050) || (currentWatched && currentWatched.mint !== signal.mint && signal.priceUsd <= 0.000050);
    if (shouldWatch) {
      this.devWatcher.watchSingleDev(signal.mint, signal.symbol).catch((err: any) => {
        console.warn(`[DEV-WATCHER-SETUP-ERR] ${err?.message}`);
      });
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

        // Real Auto-Buy Trigger untuk Lane 1 (hanya boleh masuk jika Entry #1 atau sudah pegang posisi riil)
        await this.maybeExecuteRealBuy('LANE_1', signal, execPrice, evalBuy.entryNum === 1);
      } else {
        console.warn(`[SWAP AMM QUOTE FAILED] Gagal mendapatkan quote buy swap: ${quote.error}. Dilarang fallback spot, buy dibatalkan!`);
        return;
      }
    } catch (err: any) {
      console.error(`[EXEC-BUY-ERR] ${err?.message}`);
    }

    // Update live price tick ke Lane 1 & Lane 2 setiap kali ada aktivitas buy target
    if (signal.priceUsd > 0) {
      this.lane.updateTokenTick(signal.mint, signal.priceUsd);
      await this.handleSmartDipPriceTick(signal.mint, signal.priceUsd);
    }

    // Evaluasi Lane 2 (Smart Dip $5) setelah Lane 1
    await this.evaluateSmartDipBuy(signal, isFresh, tokenAgeMinutes);
  }

  private async handleTargetSell(signal: WalletTradeSignal): Promise<void> {
    // Jalankan eksekusi 3-way dry-run scenario simulator secara paralel
    this.multiDryRunEngine.handleTargetSell(signal);

    // Update live price tick ke Lane 1 & Lane 2 setiap kali target menjual token
    if (signal.priceUsd > 0) {
      this.lane.updateTokenTick(signal.mint, signal.priceUsd);
      await this.handleSmartDipPriceTick(signal.mint, signal.priceUsd);
    }

    const evalSell = this.lane.evaluateSellSignal(signal);
    const nowMs = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(nowMs);
    const eventId = `ev_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;

    if (!evalSell.canSell) {
      console.log(`[FOLLOW SELL SKIP] Alasan: ${evalSell.reason}`);
      const evalSmartSell = this.smartDipLane.evaluateTargetSellSignal(signal);
      if (evalSmartSell.shouldSell && evalSmartSell.tokensToSell > 0) {
        await this.executeSmartDipTargetExit(signal, evalSmartSell.tokensToSell, evalSmartSell.reason);
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

          // Real Auto-Sell Trigger untuk Lane 1 (mengikuti persis rasio jual target)
          await this.maybeExecuteRealSell('LANE_1', signal.mint, execPrice, evalSell.sellRatioPct, evalSell.isFullExit);
        }
      } else {
        console.warn(`[SWAP SELL QUOTE FAILED] Gagal route sell: ${quote.error}. Dilarang fallback spot, sell ditolak!`);
        return;
      }
    } catch (err: any) {
      console.error(`[EXEC-SELL-ERR] ${err?.message}`);
    }

    // Evaluasi Lane 2 (Smart Dip $5) Target Exit / Shadow Exit
    const evalSmartSell = this.smartDipLane.evaluateTargetSellSignal(signal);
    if (evalSmartSell.shouldSell && evalSmartSell.tokensToSell > 0) {
      await this.executeSmartDipTargetExit(signal, evalSmartSell.tokensToSell, evalSmartSell.reason);
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
      const liveCfg = readFollowerLiveConfig(this.dataDir);
      if (liveCfg.stakeUsdLane2) this.smartDipLane.setStakePerTradeUsd(liveCfg.stakeUsdLane2);
      this.smartDipLane.setAllowReboundBuy(liveCfg.reboundBuyEnabled ?? false);
      this.smartDipLane.setMaxCyclesPerToken(liveCfg.maxCyclesPerToken ?? 1);
      const evalSmart = this.smartDipLane.evaluateBuySignal(signal, {
        isFreshToken: isFresh,
        tokenAgeMinutes,
        allowReboundBuy: liveCfg.reboundBuyEnabled ?? false,
        maxCyclesPerToken: liveCfg.maxCyclesPerToken ?? 1,
      });
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
        } else {
          console.warn(`[SMART DIP BUY ABORTED] Gagal route swap AMM buy (${quote.error || 'NO_QUOTE'}). Dilarang fallback spot! Entry dibatalkan.`);
          return;
        }
      } else if (this.dryRun) {
        tokensBought = actualStakeUsd / signal.priceUsd;
      } else {
        console.warn(`[SMART DIP BUY ABORTED] Browser tab tidak tersedia. Dilarang fallback spot!`);
        return;
      }

      if (tokensBought <= 0) {
        console.warn(`[SMART DIP BUY ABORTED] AMM swap outAmount 0 token. Entry dibatalkan!`);
        return;
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

      // Real Auto-Buy Trigger untuk Lane 2 (hanya boleh masuk jika INITIAL_BUY atau sudah pegang posisi riil)
      await this.maybeExecuteRealBuy('LANE_2', signal, execPrice, evalSmart.buyType === 'INITIAL_BUY');
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
      let quote: any = null;

      if (!this.dryRun && this.page && !this.page.isClosed()) {
        const baseUnits = Math.floor(tokensSold * 1e6).toString();
        quote = await getBrowserSellSwapRoute(this.page, mint, DEFAULT_SWAP_WALLET, baseUnits, 6, 20);
        if (quote.ok && quote.quote) {
          usdReceived = quote.quote.amountOutUsd && quote.quote.amountOutUsd > 0 ? quote.quote.amountOutUsd : (tokensSold * (quote.impliedPriceUsd || currentPrice));
          execPrice = quote.impliedPriceUsd || (tokensSold > 0 ? usdReceived / tokensSold : currentPrice);
        } else if (tick.sellType === 'STAGNANT_TIMEOUT_EXIT' || (quote.error && (quote.error.includes('no route') || quote.error.includes('no external pool found') || quote.error.includes('little pool hit')))) {
          // Jika stagnant timeout atau pool AMM sudah mati/rug (misal 'no external pool found', 'no route', 'little pool hit'):
          // Likuidasi cut-loss $0 agar posisi tertutup dan tidak macet
          console.warn(`[SMART DIP TIMEOUT LIQUIDATION] Koin stagnan/rug tanpa likuiditas AMM (${quote.error}). Cut-loss posisi ditutup dengan proceeds $0.`);
          usdReceived = 0;
          execPrice = 0;
        } else {
          console.warn(`[SMART DIP SELL REJECTED] Gagal route swap AMM sell (${quote.error || 'NO_ROUTE'}). Dilarang fallback spot! Posisi tetap ditahan.`);
          return;
        }
      } else if (this.dryRun) {
        usdReceived = tokensSold * currentPrice;
      } else {
        console.warn(`[SMART DIP SELL REJECTED] Browser tab tidak tersedia. Dilarang fallback spot!`);
        return;
      }

      const isDeadPoolLiquidation = quote && quote.error && (
        quote.error.includes('no route') || 
        quote.error.includes('no external pool found') ||
        quote.error.includes('little pool hit')
      );

      if (usdReceived <= 0 && tick.sellType !== 'STAGNANT_TIMEOUT_EXIT' && !isDeadPoolLiquidation) {
        console.warn(`[SMART DIP SELL REJECTED] UsdReceived dari swap 0. Dilarang fallback spot!`);
        return;
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
          action: tick.sellType === 'STAGNANT_TIMEOUT_EXIT' ? 'SELL_TIMEOUT' : (tick.sellType === 'TP_OVER_50_PARTIAL_70' ? 'SELL_TP_70' : (tick.sellType === 'REBOUND_TP_20_FULL' ? 'SELL_REBOUND_TP20' : (tick.sellType === 'STOP_LOSS' ? 'SELL_STOP_LOSS' : 'SELL_TP_FULL'))),
          stakeOrProceedsUsd: usdReceived,
          tokens: tokensSold,
          executionPriceUsd: execPrice,
          pnlUsd: lastExit.pnlUsd,
          roiPct: lastExit.roiPct,
          reason: tick.reason,
          positionStatus: res.status,
        });

        // Real Auto-Sell Trigger untuk Lane 2
        await this.maybeExecuteRealSell('LANE_2', mint, execPrice);
      }
    } finally {
      this.inFlightSellMints.delete(mint);
    }
  }

  /**
   * Helper: Evaluasi Target Exit Lane 2 (Target Full Exit Safety Close / Rebound Shadow Exit)
   */
  private async executeSmartDipTargetExit(signal: WalletTradeSignal, tokensToSell: number, exitReason: string = 'TARGET_FULL_EXIT_SAFETY_CLOSE'): Promise<void> {
    console.log(`[SMART DIP SAFETY EXIT] Trigger: ${exitReason} | Menjual seluruh sisa token ${signal.symbol} (${tokensToSell.toLocaleString()})...`);
    let usdReceived = 0;
    let execPrice = signal.priceUsd;

    if (!this.dryRun && this.page && !this.page.isClosed()) {
      const baseUnits = Math.floor(tokensToSell * 1e6).toString();
      const quote = await getBrowserSellSwapRoute(this.page, signal.mint, DEFAULT_SWAP_WALLET, baseUnits, 6, 15);
      if (quote.ok && quote.quote) {
        usdReceived = quote.quote.amountOutUsd && quote.quote.amountOutUsd > 0 ? quote.quote.amountOutUsd : (tokensToSell * (quote.impliedPriceUsd || signal.priceUsd));
        execPrice = quote.impliedPriceUsd || (tokensToSell > 0 ? usdReceived / tokensToSell : signal.priceUsd);
      } else {
        console.warn(`[SMART DIP SAFETY EXIT FAILED] Gagal swap sell route: ${quote.error}. Dilarang fallback spot! Exit ditunda.`);
        return;
      }
    } else if (this.dryRun) {
      usdReceived = tokensToSell * signal.priceUsd;
    } else {
      console.warn(`[SMART DIP SAFETY EXIT FAILED] Browser tab tidak tersedia. Dilarang fallback spot!`);
      return;
    }

    if (usdReceived <= 0) {
      console.warn(`[SMART DIP SAFETY EXIT FAILED] UsdReceived 0. Dilarang fallback spot!`);
      return;
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
        reason: exitReason,
        positionStatus: res.status,
      });

      // Real Auto-Sell Trigger untuk Lane 2 (Safety Target Exit)
      await this.maybeExecuteRealSell('LANE_2', signal.mint, execPrice);
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

  /**
   * Fast Retry Loop (setiap 1.5 detik):
   * Khusus mengeksekusi posisi riil yang order sell-nya tertunda/pending di AMM.
   */
  private async fastRetryPendingRealSells(): Promise<void> {
    if (!this.isRunning || !this.page || this.page.isClosed()) return;
    try {
      const realState = readFollowerRealState(this.dataDir);
      const pendingRealPositions = realState.positions.filter(p => REAL_ACTIVE_STATUSES.has(p.status) && p.remainingTokens > 0);
      if (pendingRealPositions.length === 0) return;

      const smartOpen = this.smartDipLane.getOpenPositions();
      for (const rp of pendingRealPositions) {
        if (rp.lane === 'LANE_2') {
          const sp = smartOpen.find(s => s.mint === rp.mint);
          // Jika posisi paper Lane 2 sudah CLOSED (karena TP >= 30% / exit), posisi riil wajib disikat sell 100%
          if (!sp || sp.status === 'CLOSED') {
            if (!this.inFlightSellMints.has(rp.mint)) {
              console.log(`[FAST SELL RETRY 1.5s] ⚡ Menjual posisi riil Lane 2 ${rp.symbol} (${rp.remainingTokens} tokens) untuk kunci profit +30%...`);
              await this.maybeExecuteRealSell('LANE_2', rp.mint, rp.exitPriceUsd || 0, 100, true);
            }
          }
        } else if (rp.lane === 'LANE_1') {
          // Lane 1: Hanya menembak ulang sell jika sinyal sell target sebelumnya sempat tertunda/gagal
          if (rp.pendingSellRatio && rp.pendingSellRatio > 0) {
            if (!this.inFlightSellMints.has(rp.mint)) {
              const isFull = rp.pendingSellRatio >= 99 || rp.remainingTokens <= 0;
              console.log(`[FAST SELL RETRY 1.5s] ⚡ Menembak ulang sell Lane 1 ${rp.symbol} (${rp.pendingSellRatio.toFixed(1)}% porsi) mengikuti sinyal target...`);
              await this.maybeExecuteRealSell('LANE_1', rp.mint, rp.exitPriceUsd || 0, rp.pendingSellRatio, isFull);
            }
          }
        }
      }
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
          this.devWatcher.setBrowserPage(this.page);
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

      // Unsubscribe koin-koin lama yang posisinya sudah CLOSED di Lane 1 dan Lane 2
      // agar tidak membanjiri memory dan event loop dengan websocket tick yang tidak terpakai
      for (const subbedMint of Array.from(this.subscribedTokens)) {
        if (!allOpenMints.includes(subbedMint)) {
          await this.unsubscribeToken(subbedMint);
        }
      }

      // 2. Heartbeat batch price polling via DexScreener API (fallback 30s)
      const bestPrices = new Map<string, number>();
      if (allOpenMints.length > 0) {
        try {
          const mintsQuery = allOpenMints.slice(0, 30).join(',');
          const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mintsQuery}`, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            const data = await res.json() as any;
            const pairs = data.pairs || [];
            for (const pair of pairs) {
              const baseMint = pair.baseToken?.address;
              const price = parseFloat(pair.priceUsd) || 0;
              const liq = pair.liquidity?.usd || 0;
              const m5Buys = pair.txns?.m5?.buys || 0;
              const m5Sells = pair.txns?.m5?.sells || 0;

              if (baseMint && price > 0) {
                if (!bestPrices.has(baseMint) || liq > 1000) {
                  bestPrices.set(baseMint, price);
                }
                // Jika dalam 5 menit terakhir ada transaksi buy atau sell di DEX
                if (m5Buys > 0 || m5Sells > 0) {
                  this.smartDipLane.recordTokenActivity(baseMint);
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

      // 2.1 Polling harga live via AMM swap route untuk token unindexed (yang belum muncul di DexScreener)
      for (const sp of smartOpen) {
        if (!bestPrices.has(sp.mint) && this.page && !this.page.isClosed()) {
          try {
            const baseUnits = Math.floor(sp.totalTokens * 1e6).toString();
            const q = await getBrowserSellSwapRoute(this.page, sp.mint, DEFAULT_SWAP_WALLET, baseUnits, 6, 20);
            if (q.ok && q.impliedPriceUsd && q.impliedPriceUsd > 0) {
              bestPrices.set(sp.mint, q.impliedPriceUsd);
              this.lane.updateTokenTick(sp.mint, q.impliedPriceUsd);
              await this.handleSmartDipPriceTick(sp.mint, q.impliedPriceUsd);
            }
          } catch {}
        }
      }

      // 2.2 Periksa inaktivitas pasar (stagnant timeout 5m) untuk seluruh token Lane 2 yang terbuka
      // Ini memastikan token yang likuiditasnya mati/unindexed di DEX tetap dievaluasi untuk auto-sell & reclaim rent
      for (const sp of smartOpen) {
        const lastActivity = sp.lastTradeActivityAt || sp.updatedAt || (sp.openedAt * 1000);
        const inactiveMin = (Date.now() - lastActivity) / 60000;
        if (inactiveMin >= 5.0 && sp.totalTokens > 0) {
          await this.handleSmartDipPriceTick(sp.mint, sp.lastObservedPriceUsd || 0);
        }
      }

      // 2.3 Periksa inaktivitas pasar Lane 1 jika target menelantarkan koin selama >= 5 menit (300 detik)
      // Ini memastikan jika koin terkena rug-pull dan target tidak pernah sell, koin di-burn & sewa SOL di-reclaim
      try {
        const realState = readFollowerRealState(this.dataDir);
        const lane1RealOpen = realState.positions.filter(p => p.lane === 'LANE_1' && REAL_ACTIVE_STATUSES.has(p.status) && p.remainingTokens > 0);
        for (const rp of lane1RealOpen) {
          const inactiveMin = (now - (rp.updatedAt || rp.createdAt)) / 60000;
          if (inactiveMin >= 5.0 && !this.inFlightSellMints.has(rp.mint)) {
            console.log(`[LANE 1 INACTIVITY TIMEOUT 5M] Posisi riil ${rp.symbol} tidak ada aktivitas sell selama ${inactiveMin.toFixed(1)}m. Mencoba likuidasi / burn safety...`);
            await this.maybeExecuteRealSell('LANE_1', rp.mint, rp.exitPriceUsd || 0, 100, true);
          }
        }
      } catch {}

      // Auto-likuidasi posisi dry-run multi-skenario jika terbengkalai > 25 menit & fallback safety TP 45s
      try {
        this.multiDryRunEngine.checkStagnantPositions(25);
        this.multiDryRunEngine.checkSafetyExits(45000, 60000);
      } catch {}

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

      // Update Auto-Buy Readiness & Live Wallet Balance
      if (this.page && !this.page.isClosed() && (Date.now() - this.lastReadinessCheck > 15000)) {
        this.lastReadinessCheck = Date.now();
        try {
          const sess = await this.liveAdapter.detectWalletAndAuth(this.page);
          if (sess.wallet) {
            const bal = await this.liveAdapter.getWalletBalance(sess.wallet);
            let reclaimableRentSol = 0;
            let emptyAccountsCount = 0;
            try {
              const { scanEmptyTokenAccounts } = await import('./solana-rent-reclaimer.mjs');
              const { Connection } = await import('@solana/web3.js');
              const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
              const scan = await scanEmptyTokenAccounts(conn, sess.wallet);
              reclaimableRentSol = scan.totalReclaimableSol;
              emptyAccountsCount = scan.emptyCount;
            } catch {}

            const state = readFollowerRealState(this.dataDir);
            state.readiness = {
              sessionReady: !!sess.wallet,
              wallet: sess.wallet,
              balanceSol: bal.balanceSol,
              solUsd: bal.solUsd || this.solPriceUsd,
              reclaimableRentSol,
              emptyAccountsCount,
              observedAt: Date.now(),
              workerPid: process.pid,
              error: bal.error,
            };
            state.updatedAt = Date.now();
            atomicWriteJson(path.join(this.dataDir, 'follower-real-state.json'), state);
          }
        } catch {}
      }
    }
  }

  /**
   * Antrekan hit API GMGN (Swap Route & Submit Order Probe) per skenario.
   * Diproses secara sekuensial (FIFO queue) agar tidak membanjiri browser page.
   */
  private enqueueGmgnApiProbe(item: {
    side: 'BUY' | 'SELL';
    scenarioId: string;
    signal: WalletTradeSignal;
    stakeUsd: number;
    tokens?: number;
    priceUsd: number;
    reason: string;
  }): void {
    // Jika skenario ini adalah target Real Auto-Buy aktif (misal S4) atau S8 (Genesis),
    // eksekusi LANGSUNG secara paralel tanpa antre di belakang simulasi skenario lain!
    const config = readFollowerLiveConfig(this.dataDir);
    const isTargetReal = this.isScenarioAllowedForRealOrder(item.scenarioId, config);
    if (isTargetReal || item.scenarioId.includes('8') || item.scenarioId.includes('FRONTRUN')) {
      this.executeGmgnApiProbe(
        item.side,
        item.scenarioId,
        item.signal,
        item.stakeUsd,
        item.reason,
        item.tokens
      ).catch(err => console.warn(`[IMMEDIATE PROBE ERR: ${item.scenarioId}] ${err?.message}`));
      return;
    }

    this.probeQueue.push(item);
    this.processProbeQueue().catch(err => console.warn(`[PROBE QUEUE ERR] ${err?.message}`));
  }

  private async processProbeQueue(): Promise<void> {
    if (this.isProcessingProbeQueue) return;
    this.isProcessingProbeQueue = true;

    while (this.probeQueue.length > 0) {
      const item = this.probeQueue.shift()!;
      try {
        await this.executeGmgnApiProbe(
          item.side,
          item.scenarioId,
          item.signal,
          item.stakeUsd,
          item.reason,
          item.tokens
        );
      } catch (err: any) {
        console.warn(`[PROBE EXEC ERR] ${err?.message}`);
      }
    }

    this.isProcessingProbeQueue = false;
  }

  /**
   * Helper: Periksa apakah skenario diizinkan untuk eksekusi Real Auto-Buy
   */
  private isScenarioAllowedForRealOrder(scenarioId: string, config: any): boolean {
    if (!config.enabled) return false;
    const targetSc = String(config.autobuyScenario || 'OFF').toUpperCase();
    if (targetSc === 'OFF') return false;
    if (targetSc === 'BOTH' || targetSc === 'ALL') return true;

    const scUpper = scenarioId.toUpperCase();
    if (targetSc === 'S4' || targetSc === 'SCE4' || targetSc === 'SCENARIO_4') {
      return scUpper.includes('4') || scUpper.includes('SINGLE');
    }
    if (targetSc === 'S6' || targetSc === 'SCE6' || targetSc === 'SCENARIO_6') {
      return scUpper.includes('6') || scUpper.includes('REDEPLOY');
    }
    if (targetSc === 'S7' || targetSc === 'SCE7' || targetSc === 'SCENARIO_7') {
      return scUpper.includes('7') || scUpper.includes('TIME_STOP');
    }
    if (targetSc === 'S5' || targetSc === 'SCE5' || targetSc === 'SCENARIO_5') {
      return scUpper.includes('5') || scUpper.includes('ANTI_SHAKEOUT');
    }
    if (targetSc === 'S8' || targetSc === 'SCE8' || targetSc === 'SCENARIO_8') {
      return scUpper.includes('8') || scUpper.includes('FRONTRUN');
    }
    if (targetSc === 'S9' || targetSc === 'SCE9' || targetSc === 'SCENARIO_9') {
      return scUpper.includes('9') || scUpper.includes('DEV_FRONTRUN');
    }
    return false;
  }

  /**
   * Helper: Eksekusi Hit API Nyata ke GMGN (Swap Route & Submit Order Probe)
   * Mengikuti trigger BUY dan SELL dari masing-masing 6 skenario.
   */
  private async executeGmgnApiProbe(
    side: 'BUY' | 'SELL',
    scenarioId: string,
    signal: WalletTradeSignal,
    stakeUsd: number = 5.0,
    reason: string = '',
    tokens?: number
  ): Promise<void> {
    if (!this.page || this.page.isClosed()) {
      return;
    }

    try {
      const state = readFollowerRealState(this.dataDir);
      const wallet = state.readiness.wallet || 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6';
      const config = readFollowerLiveConfig(this.dataDir);

      console.log(`\n=========================================================`);
      console.log(`[GMGN SWAP ROUTE] 🎯 Cek rute ${side} [${scenarioId}] (${reason}) untuk ${signal.symbol} ($${stakeUsd.toFixed(2)})...`);

      let route: any;
      let unitsToSubmit: string = '0';

      if (side === 'BUY') {
        // Fast 1-attempt tanpa delay sleep agar tidak blocking skenario lain
        route = await getBrowserBuySwapRoute(
          this.page,
          signal.mint,
          wallet,
          stakeUsd,
          this.solPriceUsd,
          config.buySlippagePercent || 15,
          1 // maxRetries = 1 agar probe cepat (< 200ms)
        );
      } else {
        // SELL: Pre-check saldo on-chain aktual agar akurat hingga desimal terkecil
        let units = tokens && tokens > 0 ? Math.floor(tokens * 1e6).toString() : '1000000';
        try {
          const { getOnChainTokenBalance } = await import('./solana-rent-reclaimer.mjs');
          const onChain = await getOnChainTokenBalance(signal.mint, wallet);
          if (onChain && onChain.amount && onChain.amount !== '0') {
            const isStage1Partial = reason && reason.includes('STAGE_1_TP_50%');
            if (isStage1Partial) {
              units = (BigInt(onChain.amount) / 2n).toString();
              console.log(`[REAL SELL BALANCE PRE-CHECK] S6 STAGE 1 TP 50%: Menjual 50% saldo on-chain riil: ${units} base units`);
            } else {
              units = onChain.amount;
              console.log(`[REAL SELL BALANCE PRE-CHECK] Menggunakan 100% saldo on-chain riil: ${onChain.uiAmount} tokens (${units} base units)`);
            }
          }
        } catch {}

        route = await getBrowserSellSwapRoute(
          this.page,
          signal.mint,
          wallet,
          units,
          6,
          config.sellSlippagePercent || 20
        );

        // Double-Catch Auto-Recovery jika terdeteksi selisih saldo di aggregator
        if (!route.ok && route.error && route.error.includes('token balance is less than available balance')) {
          console.warn(`[DOUBLE-CATCH] Terdeteksi selisih saldo (${route.error}). Membaca ulang saldo on-chain dari blockchain...`);
          try {
            const { getOnChainTokenBalance } = await import('./solana-rent-reclaimer.mjs');
            const onChain = await getOnChainTokenBalance(signal.mint, wallet);
            if (onChain && onChain.amount && onChain.amount !== '0') {
              const isStage1Partial = reason && reason.includes('STAGE_1_TP_50%');
              units = isStage1Partial ? (BigInt(onChain.amount) / 2n).toString() : onChain.amount;
              console.log(`[DOUBLE-CATCH] Mengulang quote sell dengan saldo aktual: ${units} base units...`);
              route = await getBrowserSellSwapRoute(
                this.page,
                signal.mint,
                wallet,
                units,
                6,
                config.sellSlippagePercent || 20
              );
            }
          } catch (e: any) {
            console.warn(`[DOUBLE-CATCH-ERR] ${e?.message}`);
          }
        }
        unitsToSubmit = units;
      }

      console.log(`[GMGN ROUTE RESPONSE: ${scenarioId}] Status: ${route.status} | Ok: ${route.ok} | Latency: ${route.latencyMs}ms | Exchange: ${route.routeData?.exchange || '-'} | Msg: ${route.error || 'SUCCESS'}`);

      if (!route.ok || !route.routeData) {
        console.warn(`[GMGN API HIT ${side} ABORTED: ${scenarioId}] Route tidak ditemukan oleh AMM: ${route.error}`);
        if (side === 'SELL' && this.isScenarioAllowedForRealOrder(scenarioId, config)) {
          try {
            const { burnAndCloseTokenAccount } = await import('./solana-rent-reclaimer.mjs');
            console.log(`[SAFETY-AUTO-RECLAIM] Rute sell tidak ada (${route.error}). Membakar sisa token & me-reclaim sewa rent SOL untuk ${signal.symbol || signal.mint}...`);
            const burnRes = await burnAndCloseTokenAccount(signal.mint);
            if (burnRes.ok) {
              console.log(`[SAFETY-AUTO-RECLAIM] ✅ Berhasil burn & reclaim rent SOL: +${burnRes.reclaimedSol} SOL! Tx: ${burnRes.tx}`);
            }
          } catch (e: any) {
            console.warn(`[SAFETY-AUTO-RECLAIM-WARN] ${e?.message}`);
          }
        }
        auditFollowerReal(this.dataDir, state, null, `API_PROBE_${side}_${scenarioId}_NO_ROUTE`, {
          scenarioId,
          reason,
          signal,
          route
        });
        return;
      }

      const estimatedSol = stakeUsd / (this.solPriceUsd > 0 ? this.solPriceUsd : 95.0);
      const swapRouteRequest = {
        endpoint: '/txproxy/v1/get_swap_route',
        method: 'GET',
        side,
        mint: signal.mint,
        wallet,
        inAmountBaseUnits: side === 'BUY' ? Math.floor(estimatedSol * 1e9).toString() : unitsToSubmit,
        stakeUsd: side === 'BUY' ? stakeUsd : undefined,
        slippage: side === 'BUY' ? (config.buySlippagePercent || 15) : (config.sellSlippagePercent || 20)
      };

      const swapRouteResponse = {
        status: route.status,
        ok: route.ok,
        latencyMs: route.latencyMs,
        exchange: route.routeData?.exchange,
        quote: route.routeData?.quote ? {
          inAmount: route.routeData.quote.inAmount,
          outAmount: route.routeData.quote.outAmount,
          priceImpactPct: route.routeData.quote.priceImpactPct
        } : null,
        error: route.error || null
      };

      // Cek apakah skenario ini DIIZINKAN untuk Real Order batch_order & reclaim rent
      let isRealOrderTargeted = this.isScenarioAllowedForRealOrder(scenarioId, config);
      const autobuySc = String(config.autobuyScenario || (config.enabled ? 'BOTH' : 'OFF')).toUpperCase();

      if (isRealOrderTargeted && side === 'BUY') {
        // Cek apakah token ini sudah pernah dibeli sebelumnya di state posisi riil (Strict 1 Token 1 Buy)
        const alreadyBoughtReal = state.positions.some(p => p.mint === signal.mint);
        if (alreadyBoughtReal) {
          console.warn(`[AUTO-BUY REAL ORDER ABORTED] Token ${signal.symbol} [${signal.mint.slice(0, 8)}...] sudah pernah dibeli di real wallet! Dilarang buy ulang koin yang sama.`);
          isRealOrderTargeted = false;
        }

        const quotaThreshold = Number(config.quotaResetAt) || 0;
        const completedBuys = state.positions.filter(p => (p.status === 'HOLDING' || p.status === 'CLOSED') && (p.createdAt || 0) >= quotaThreshold).length;
        if (config.maxBuysQuota > 0 && completedBuys >= config.maxBuysQuota) {
          console.warn(`[AUTO-BUY REAL ORDER ABORTED] Kuota Max Buys (${completedBuys}/${config.maxBuysQuota}) telah tercapai sejak reset! Mengalihkan ke mode simulasi saja...`);
          isRealOrderTargeted = false;
        }
      }

      if (!isRealOrderTargeted) {
        let finalQuote = route.routeData?.quote;
        let finalPriceUsd = route.impliedPriceUsd;

        if (side === 'BUY') {
          // Double-Swap Mechanism: Hit swap ke-2 menggantikan batch_order untuk simulasi slippage eksekusi riil
          console.log(`[DRY RUN REALISTIS: ${scenarioId}] 🔄 Menembak swap ke-2 untuk simulasi slippage riil (menggantikan batch_order)...`);
          try {
            await new Promise(r => setTimeout(r, 300));
            const route2 = await getBrowserBuySwapRoute(
              this.page,
              signal.mint,
              wallet,
              stakeUsd,
              this.solPriceUsd,
              config.buySlippagePercent || 15,
              1
            );
            if (route2.ok && route2.routeData?.quote) {
              finalQuote = route2.routeData.quote;
              finalPriceUsd = route2.impliedPriceUsd || (stakeUsd / (Number(finalQuote.outAmount) / 1e6));
              console.log(`[DRY RUN REALISTIS: ${scenarioId}] ✅ Swap ke-2 berhasil (${route2.routeData.exchange || '-'} | ${route2.latencyMs}ms). Harga AMM ke-2: $${finalPriceUsd?.toFixed(8)}`);
            }
          } catch (e: any) {
            console.warn(`[DRY-RUN-SWAP2-WARN] ${e?.message}`);
          }

          if (finalQuote && finalPriceUsd) {
            const tokensBought = Number(finalQuote.outAmount) / 1e6;
            this.multiDryRunEngine.syncRealBuyExecution(scenarioId, signal.mint, finalPriceUsd, tokensBought, stakeUsd);
          }
        } else {
          // SELL Simulation: Sinkronkan proceeds jual riil ke engine
          if (finalQuote) {
            const solOut = Number(finalQuote.outAmount) / 1e9;
            const usdReceived = solOut * (this.solPriceUsd > 0 ? this.solPriceUsd : 93.0);
            const realExitPrice = route.impliedPriceUsd || (usdReceived / (Number(finalQuote.inAmount) / 1e6));
            this.multiDryRunEngine.syncRealSellExecution(scenarioId, signal.mint, realExitPrice, usdReceived, reason);
          }
        }

        console.log(`[AUTO-BUY: SIMULASI ONLY (${scenarioId})] ⚪ Rute swap selesai dicek (${route.routeData?.exchange || '-'} | Latency ${route.latencyMs}ms).`);
        console.log(`   Order nyata /mrtapi/v2/swap_batch_order & reclaim rent dilewati (Target aktif: ${autobuySc}).`);
        console.log(`=========================================================\n`);
        auditFollowerReal(this.dataDir, state, null, `SWAP_SIMULATION_${side}_${scenarioId}`, {
          scenarioId,
          reason,
          signal,
          route: { ok: route.ok, status: route.status, latencyMs: route.latencyMs, exchange: route.routeData?.exchange },
          request: { swap: swapRouteRequest, order: null },
          response: { swap: swapRouteResponse, order: { simulation: true, note: `Simulasi swap selesai. batch_order & rent reclaim dilewati karena Real Auto-Buy menargetkan ${autobuySc}.` } },
          autoBuyEnabled: false,
          activeScenarioConfig: autobuySc
        });
        return;
      }

      // Jika TARGET AKTIF: Eksekusi submitSwapOrder ke /mrtapi/v2/swap_batch_order via browser
      console.log(`[AUTO-BUY: REAL ORDER (${autobuySc})] 🟢 Menembak order swap NYATA ke GMGN API /mrtapi/v2/swap_batch_order untuk ${scenarioId}...`);
      if (side === 'BUY') {
        unitsToSubmit = route.routeData.quote?.inAmount || Math.floor(estimatedSol * 1e9).toString();
      }

      const orderSubmitRequest = {
        endpoint: '/mrtapi/v2/swap_batch_order',
        method: 'POST',
        side,
        mint: signal.mint,
        wallet,
        amountBaseUnits: unitsToSubmit,
        exchange: route.routeData?.exchange,
        tipFeeSol: config.tipFeeSol,
        priorityFeeSol: config.priorityFeeSol
      };

      const submitRes = await this.liveAdapter.submitSwapOrder(this.page, {
        side,
        mint: signal.mint,
        wallet,
        amountBaseUnits: unitsToSubmit,
        routeData: route.routeData,
        config,
        solUsd: this.solPriceUsd,
        tokenPriceUsd: route.impliedPriceUsd || signal.priceUsd,
      });

      console.log(`[GMGN SUBMIT ORDER RESPONSE: ${scenarioId}] Status: ${submitRes.status} | Ok: ${submitRes.ok} | Order ID: ${submitRes.orderId || '-'} | Hash: ${submitRes.hash || '-'} | Error/Msg: ${submitRes.error || 'SUCCESS'}`);
      console.log(`=========================================================\n`);

      // Sinkronkan SELL nyata ke engine & update state posisi riil
      if (side === 'SELL' && submitRes.ok && route.routeData?.quote) {
        const solOut = Number(route.routeData.quote.outAmount) / 1e9;
        const usdReceived = solOut * (this.solPriceUsd > 0 ? this.solPriceUsd : 93.0);
        const realExitPrice = route.impliedPriceUsd || (usdReceived / (Number(route.routeData.quote.inAmount) / 1e6));
        this.multiDryRunEngine.syncRealSellExecution(scenarioId, signal.mint, realExitPrice, usdReceived, reason);

        // Update status posisi riil menjadi CLOSED
        const curRealState = readFollowerRealState(this.dataDir);
        const targetPos = curRealState.positions.find(p => p.mint === signal.mint && (p.status === 'HOLDING' || p.status === 'ACTIVE'));
        if (targetPos) {
          targetPos.status = 'CLOSED';
          targetPos.updatedAt = Date.now();
          targetPos.exitPriceUsd = realExitPrice;
          targetPos.realizedPnlUsd = usdReceived - targetPos.costBasisUsd;
          targetPos.sells.push(submitRes);
          writeFollowerRealState(this.dataDir, curRealState);
        }

        // Reclaim rent SOL seketika pasca-sell
        try {
          const { burnAndCloseTokenAccount } = await import('./solana-rent-reclaimer.mjs');
          burnAndCloseTokenAccount(signal.mint).catch(() => {});
        } catch {}

        // Jika kuota tercapai, otomatis set autobuyScenario = 'DRY_RUN' agar aman
        const quotaThreshold = Number(config.quotaResetAt) || 0;
        const totalCompleted = curRealState.positions.filter(p => p.status === 'CLOSED' && (p.createdAt || 0) >= quotaThreshold).length;
        if (config.maxBuysQuota > 0 && totalCompleted >= config.maxBuysQuota) {
          console.log(`\n=========================================================`);
          console.log(`🏁 [TEST SELESAI] Kuota 1x Test Buy Asli telah tuntas (${totalCompleted}/${config.maxBuysQuota})!`);
          console.log(`   Otomatis menonaktifkan Real Auto-Buy (autobuyScenario = 'DRY_RUN') demi keamanan.`);
          console.log(`=========================================================\n`);
          config.autobuyScenario = 'DRY_RUN';
          saveFollowerLiveConfig(this.dataDir, config);
        }
      }

      // Cek kondisi sebenarnya beli berapa angkanya (Post-Buy On-Chain Verification & Sync)
      if (side === 'BUY' && submitRes.ok) {
        const newRealPos = {
          id: `real_${signal.mint.slice(0, 8)}_${Date.now()}`,
          mint: signal.mint,
          symbol: signal.symbol,
          tokenName: signal.tokenName,
          lane: scenarioId,
          status: 'HOLDING',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          wallet,
          acquiredTokens: Number(route.routeData?.quote?.outAmount || 0) / 1e6,
          remainingTokens: Number(route.routeData?.quote?.outAmount || 0) / 1e6,
          costBasisUsd: stakeUsd,
          realizedPnlUsd: 0,
          entryPriceUsd: route.impliedPriceUsd || signal.priceUsd,
          stage1Exited: false,
          buys: [submitRes],
          sells: [] as any[],
          audit: [{ at: Date.now(), type: 'REAL_BUY_SUBMITTED', details: submitRes }],
          lastError: submitRes.error,
        };
        state.positions.unshift(newRealPos as any);
        writeFollowerRealState(this.dataDir, state);

        console.log(`[POST-BUY SYNC] ⏳ Menunggu settlement blockchain untuk verifikasi jumlah token aktual yang terbeli...`);
        setTimeout(async () => {
          try {
            const { getOnChainTokenBalance } = await import('./solana-rent-reclaimer.mjs');
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise(r => setTimeout(r, 2000));
              const onChain = await getOnChainTokenBalance(signal.mint, wallet);
              if (onChain && onChain.uiAmount > 0) {
                console.log(`\n=========================================================`);
                console.log(`[POST-BUY VERIFIED] ✅ Terkonfirmasi beli aktual: ${onChain.uiAmount.toLocaleString()} tokens (${onChain.amount} base units) pada mint ${signal.symbol || signal.mint}`);
                console.log(`=========================================================\n`);
                
                const realPriceUsd = (stakeUsd / onChain.uiAmount);
                this.multiDryRunEngine.syncRealBuyExecution(scenarioId, signal.mint, realPriceUsd, onChain.uiAmount, stakeUsd);

                auditFollowerReal(this.dataDir, state, null, `POST_BUY_VERIFIED_${scenarioId}`, {
                  scenarioId,
                  mint: signal.mint,
                  symbol: signal.symbol,
                  actualTokens: onChain.uiAmount,
                  actualBaseUnits: onChain.amount,
                  stakeUsd
                });
                break;
              }
            }
          } catch (e: any) {
            console.warn(`[POST-BUY-SYNC-ERR] ${e?.message}`);
          }
        }, 1500);
      }

      // Auto-reclaim rent SOL setelah SELL berhasil (hanya pada full exit, bukan partial Stage 1 TP)
      if (side === 'SELL' && submitRes.ok && (!reason || !reason.includes('STAGE_1_TP_50%'))) {
        setTimeout(async () => {
          try {
            const { reclaimRentForMint } = await import('./solana-rent-reclaimer.mjs');
            console.log(`[AUTO-RECLAIM-RENT] Memeriksa akun kosong untuk reclaim rent token ${signal.symbol || signal.mint}...`);
            const reclaimRes = await reclaimRentForMint(signal.mint);
            if (reclaimRes.ok && reclaimRes.reclaimedSol > 0) {
              console.log(`[AUTO-RECLAIM-RENT] ✅ Berhasil me-reclaim +${reclaimRes.reclaimedSol.toFixed(6)} SOL untuk mint ${signal.symbol || signal.mint}! Tx: ${reclaimRes.signatures?.[0]}`);
            }
          } catch (err: any) {
            console.warn(`[AUTO-RECLAIM-RENT-WARN] ${err?.message}`);
          }
        }, 4000);
      }

      // Audit log ke follower-real-ledger.jsonl
      auditFollowerReal(this.dataDir, state, null, `API_PROBE_${side}_${scenarioId}`, {
        scenarioId,
        reason,
        signal,
        route: { ok: route.ok, status: route.status, latencyMs: route.latencyMs, exchange: route.routeData?.exchange },
        submit: submitRes,
        request: { swap: swapRouteRequest, order: orderSubmitRequest },
        response: { swap: swapRouteResponse, order: submitRes }
      });
    } catch (err: any) {
      console.error(`[GMGN API HIT ERR: ${scenarioId}] ${err?.message}`);
    }
  }

  /**
   * Helper: Eksekusi Real Auto-Buy on-chain jika diizinkan oleh safety gates.
   */
  private async maybeExecuteRealBuy(
    lane: 'LANE_1' | 'LANE_2',
    signal: WalletTradeSignal,
    tokenPriceUsd: number,
    isInitialEntry: boolean = true
  ): Promise<void> {
    try {
      const config = readFollowerLiveConfig(this.dataDir);
      if (!config.enabled) return;

      // Jika autobuyScenario aktif (S4, S6, atau BOTH), maka eksekusi nyata ditangani oleh scenario engine, bukan legacy lane
      if (config.autobuyScenario && config.autobuyScenario !== 'OFF') {
        return;
      }

      const laneAllowed = config.activeLane === 'BOTH' || config.activeLane === lane;
      if (!laneAllowed) {
        console.log(`[REAL AUTO-BUY SKIP] Lane ${lane} tidak diizinkan oleh config (Active: ${config.activeLane})`);
        return;
      }

      let state = readFollowerRealState(this.dataDir);
      if (!state.readiness.sessionReady || !state.readiness.wallet) {
        console.warn(`[REAL AUTO-BUY SKIP] Wallet GMGN belum siap atau belum terdeteksi`);
        return;
      }

      // Pastikan hanya masuk dari awal (Initial Entry / Token Baru dari 0), bukan koin yang sedang jalan di tengah
      const existingRealPos = state.positions.find(p => p.mint === signal.mint && p.lane === lane && REAL_ACTIVE_STATUSES.has(p.status));

      if (lane === 'LANE_2') {
        if (existingRealPos && !config.reboundBuyEnabled) {
          console.log(`[REAL AUTO-BUY SKIP] Rebound Buy dimatikan oleh config (reboundBuyEnabled: false)`);
          return;
        }

        // Validasi Entry Lane 2:
        if (!isInitialEntry) {
          // Ini adalah sinyal REBOUND BUY
          if (!config.reboundBuyEnabled) {
            console.log(`[REAL AUTO-BUY SKIP] Rebound Buy dimatikan oleh config`);
            return;
          }
          // Pastikan kita memang memegang token ini di Initial Buy dan baru saja exit (bukan token asing acak di tengah jalan)
          const recentClosedPos = state.positions.find(p => p.mint === signal.mint && p.lane === lane && p.status === 'CLOSED');
          if (!recentClosedPos && !existingRealPos) {
            console.log(`[REAL AUTO-BUY SKIP] Bukan token siklus kita. Rebound hanya diizinkan untuk token yang pernah lolos Initial Buy kita!`);
            return;
          }
        } else {
          // Ini adalah sinyal INITIAL BUY (Token Baru)
          if (existingRealPos) {
            console.log(`[REAL AUTO-BUY SKIP] Token ${signal.symbol} sudah memiliki posisi riil aktif di ${lane}`);
            return;
          }
          const targetBalanceBefore = Math.max(0, signal.remainingHolding - signal.tokenAmount);
          const isTrueGroundZero = (signal.isFirstBuy === true) || (targetBalanceBefore <= 0.05 * signal.tokenAmount || targetBalanceBefore <= 1000);
          if (signal.isFirstBuy === false || !isTrueGroundZero) {
            console.log(`[REAL AUTO-BUY SKIP] Dilarang masuk di tengah jalan (mid-flight entry) pada token ${signal.symbol} di Lane 2! (Target held: ${Math.round(targetBalanceBefore).toLocaleString()} tokens | isFirstBuy: ${signal.isFirstBuy ?? 'unknown'})`);
            return;
          }
          // Check Max Cycles per Token (default 1 siklus per koin seumur hidup)
          const maxCycles = config.maxCyclesPerToken ?? 1;
          const closedRealCount = state.positions.filter(p => p.mint === signal.mint && p.lane === lane && p.status === 'CLOSED').length;
          if (closedRealCount >= maxCycles) {
            console.log(`[REAL AUTO-BUY SKIP] Max Cycles tercapai untuk ${signal.symbol} (${closedRealCount}/${maxCycles}). Dilarang membuka siklus baru pada koin yang sama!`);
            return;
          }
        }
      } else if (lane === 'LANE_1') {
        // Lane 1: Direct Pure Copy-Trading (Bebas Siklus / Unlimited Cycles per token, TANPA Akumulasi)
        if (existingRealPos) {
          console.log(`[REAL AUTO-BUY SKIP] Token ${signal.symbol} sudah di-hold di Lane 1. Dilarang akumulasi buy (maksimal 1x buy per koin)!`);
          return;
        } else {
          // Safety Gate Berlapis: DILARANG masuk di tengah jalan (wajib Initial Entry dari saldo 0 Ground Zero & First Buy)
          const targetBalanceBefore = Math.max(0, signal.remainingHolding - signal.tokenAmount);
          const isTrueGroundZero = (signal.isFirstBuy === true) || (targetBalanceBefore <= 0.05 * signal.tokenAmount || targetBalanceBefore <= 1000);
          if (!isInitialEntry || signal.isFirstBuy === false || !isTrueGroundZero) {
            console.log(`[REAL AUTO-BUY SKIP] Dilarang masuk di tengah jalan (mid-flight entry) pada token ${signal.symbol} yang sedang running! (Target held: ${Math.round(targetBalanceBefore).toLocaleString()} tokens | isFirstBuy: ${signal.isFirstBuy ?? 'unknown'})`);
            return;
          }
          // Siklus baru diizinkan tanpa batas (unlimited cycles) di Lane 1 selama dimulai dari awal Ground Zero
          console.log(`[LANE 1 UNLIMITED CYCLE] Token ${signal.symbol} membuka siklus baru dari awal (Ground Zero) mengikuti buy target.`);
        }
      }

      // Check Kuota Max Buys: Hanya berlaku untuk LANE_2 (Lane 1 murni bebas kuota / unlimited follower)
      if (lane === 'LANE_2') {
        const completedCount = getCompletedRealBuysCount(state, config, 'LANE_2');
        if (config.maxBuysQuota > 0 && completedCount >= config.maxBuysQuota) {
          console.warn(`[REAL AUTO-BUY SKIP] Kuota Max Buys Lane 2 tercapai (${completedCount}/${config.maxBuysQuota})`);
          return;
        }
      }

      // Rotasi Modal / Target Migration:
      // Jika target membeli koin baru, sedangkan bot masih memegang koin lama di lane ini:
      // Langsung likuidasi 100% koin lama agar modal SOL kembali ke kas dan slot posisi terbebaskan!
      const otherActivePositions = state.positions.filter(p => p.lane === lane && REAL_ACTIVE_STATUSES.has(p.status) && p.mint !== signal.mint);
      if (otherActivePositions.length > 0 && !existingRealPos) {
        console.log(`\n=========================================================`);
        console.log(`[CAPITAL ROTATION] 🔄 Target berpindah membeli koin baru ${signal.symbol}!`);
        console.log(`[CAPITAL ROTATION] Melikuidasi 100% posisi lama (${otherActivePositions.map(p => p.symbol).join(', ')}) agar kas SOL & slot posisi bebas untuk koin baru...`);
        console.log(`=========================================================\n`);

        for (const oldPos of otherActivePositions) {
          try {
            await this.maybeExecuteRealSell(lane, oldPos.mint, oldPos.exitPriceUsd || 0, 100, true, true /* forceEmergencyClose */);
          } catch (e: any) {
            console.warn(`[CAPITAL-ROTATION-SELL-ERR] ${oldPos.symbol}: ${e?.message}`);
          }
        }

        // Beri jeda 1.5 detik agar transaksi sell / reclaim rent selesai on-chain dan sinkronkan state
        await new Promise(r => setTimeout(r, 1500));
        state = readFollowerRealState(this.dataDir);
      }

      // Check Active Real Positions (Diisolasi per masing-masing lane)
      const activePositions = state.positions.filter(p => p.lane === lane && REAL_ACTIVE_STATUSES.has(p.status));
      if (activePositions.length >= config.maxActiveRealPositions && !existingRealPos) {
        console.warn(`[REAL AUTO-BUY SKIP] Max Active Real Positions ${lane} tercapai (${activePositions.length}/${config.maxActiveRealPositions})`);
        return;
      }

      let realStakeUsd = lane === 'LANE_1' ? config.stakeUsdLane1 : config.stakeUsdLane2;
      const estimatedSolNeeded = realStakeUsd / (this.solPriceUsd > 0 ? this.solPriceUsd : 100);
      const availableSol = (state.readiness.balanceSol ?? 0) - config.minSolReserve;

      // Dynamic Stake Safety: Jika kas SOL sedikit di bawah nominal stake tapi masih cukup (> 0.003 SOL / ~$0.30 USD),
      // adaptif gunakan modal maksimum yang aman agar bot tidak terhenti akibat selisih kecil!
      if (availableSol > 0.003 && state.readiness.balanceSol !== null && state.readiness.balanceSol < (estimatedSolNeeded + config.minSolReserve)) {
        const maxAffordableUsd = availableSol * (this.solPriceUsd > 0 ? this.solPriceUsd : 100);
        console.log(`[DYNAMIC STAKE] Menyesuaikan modal beli dari $${realStakeUsd.toFixed(2)} menjadi $${maxAffordableUsd.toFixed(2)} sesuai kas tersedia (${state.readiness.balanceSol.toFixed(6)} SOL)...`);
        realStakeUsd = Math.max(0.25, Math.floor(maxAffordableUsd * 100) / 100);
      } else if (state.readiness.balanceSol === null || state.readiness.balanceSol < (estimatedSolNeeded + config.minSolReserve)) {
        console.warn(`[REAL AUTO-BUY SKIP] Saldo SOL (${state.readiness.balanceSol ?? 0} SOL) kurang dari modal (${estimatedSolNeeded.toFixed(4)}) + cadangan gas (${config.minSolReserve} SOL)`);
        return;
      }

      if (!this.page || this.page.isClosed()) return;

      console.log(`\n=========================================================`);
      console.log(`[REAL AUTO-BUY TRIGGER] 🚀 Mengambil route quote & kirim Real Swap BUY untuk ${signal.symbol} ($${realStakeUsd.toFixed(2)}) di ${lane}...`);

      const realQuote = await getBrowserBuySwapRoute(
        this.page,
        signal.mint,
        state.readiness.wallet,
        realStakeUsd,
        this.solPriceUsd,
        config.buySlippagePercent
      );

      if (!realQuote.ok || !realQuote.quote || !realQuote.routeData) {
        console.warn(`[REAL AUTO-BUY ABORTED] Gagal route swap AMM buy ($${realStakeUsd}): ${realQuote.error}`);
        return;
      }

      const res = await this.liveAdapter.submitSwapOrder(this.page, {
        side: 'BUY',
        mint: signal.mint,
        wallet: state.readiness.wallet,
        amountBaseUnits: realQuote.routeData.quote.inAmount || Math.floor(estimatedSolNeeded * 1e9).toString(),
        routeData: realQuote.routeData,
        config,
        solUsd: this.solPriceUsd,
        tokenPriceUsd: realQuote.impliedPriceUsd || tokenPriceUsd,
      });

      const posId = generateFollowerPositionId(signal.mint, lane, Date.now());
      const tokensAcquired = Number(realQuote.quote.outAmount || 0) / 10 ** (realQuote.quote.outDecimals ?? 6);

      const newOrder = {
        side: 'BUY' as const,
        lane,
        submittedAt: Date.now(),
        status: (res.ok ? 'CONFIRMED' : 'FAILED') as const,
        orderId: res.orderId,
        hash: res.hash,
        stakeUsd: realStakeUsd,
        tokenAmount: realQuote.quote.outAmount || '0',
        decimals: realQuote.quote.outDecimals ?? 6,
        solUsd: this.solPriceUsd,
        confirmedAt: res.ok ? Date.now() : undefined,
        error: res.error,
      };

      if (existingRealPos) {
        existingRealPos.acquiredTokens += tokensAcquired;
        existingRealPos.remainingTokens += tokensAcquired;
        const currentUnits = BigInt(existingRealPos.remainingBaseUnits || '0');
        const addedUnits = BigInt(newOrder.tokenAmount || '0');
        existingRealPos.remainingBaseUnits = (currentUnits + addedUnits).toString();
        existingRealPos.costBasisUsd += realStakeUsd;
        existingRealPos.updatedAt = Date.now();
        if (res.ok) existingRealPos.status = 'HOLDING';
        existingRealPos.buys.push(newOrder);
        if (lane === 'LANE_1') existingRealPos.stage1Exited = false;
        auditFollowerReal(this.dataDir, state, existingRealPos, lane === 'LANE_1' ? 'REAL_ACCUMULATE_BUY' : 'REAL_REBOUND_BUY', { signal, res });
      } else {
        const realPos: FollowerRealPosition = {
          id: posId,
          mint: signal.mint,
          symbol: signal.symbol,
          lane,
          status: res.ok ? 'HOLDING' : 'FAILED',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          wallet: state.readiness.wallet,
          acquiredTokens: tokensAcquired,
          remainingTokens: tokensAcquired,
          costBasisUsd: realStakeUsd,
          realizedPnlUsd: 0,
          entryPriceUsd: realQuote.impliedPriceUsd || tokenPriceUsd,
          stage1Exited: false,
          buys: [newOrder],
          sells: [],
          audit: [{ at: Date.now(), type: 'REAL_BUY_SUBMITTED', details: res }],
          lastError: res.error,
        };
        state.positions.unshift(realPos);
        auditFollowerReal(this.dataDir, state, realPos, 'REAL_BUY', { signal, res });
      }

      console.log(`[REAL AUTO-BUY RESULT] Status: ${res.ok ? 'SUCCESS' : 'FAILED'} | OrderId: ${res.orderId || '-'} | Hash: ${res.hash || '-'}`);
      console.log(`=========================================================\n`);

      if (res.ok) {
        // Sync saldo token on-chain aktual langsung sesaat setelah buy terkonfirmasi
        // agar saat sell tiba, bot langsung punya saldo pasti instan tanpa menunggu RPC lagi
        setTimeout(async () => {
          try {
            const { getOnChainTokenBalance } = await import('./solana-rent-reclaimer.mjs');
            for (let attempt = 1; attempt <= 3; attempt++) {
              await new Promise(r => setTimeout(r, 2000));
              const onChain = await getOnChainTokenBalance(signal.mint, state.readiness.wallet);
              if (onChain && onChain.uiAmount > 0) {
                const freshState = readFollowerRealState(this.dataDir);
                const targetPos = freshState.positions.find(p => p.mint === signal.mint && p.lane === lane && REAL_ACTIVE_STATUSES.has(p.status));
                if (targetPos) {
                  targetPos.acquiredTokens = onChain.uiAmount;
                  targetPos.remainingTokens = onChain.uiAmount;
                  targetPos.remainingBaseUnits = onChain.amount;
                  targetPos.updatedAt = Date.now();
                  writeFollowerRealState(this.dataDir, freshState);
                  console.log(`[REAL-BUY-SYNC] ✅ Saldo on-chain tersinkronisasi cepat: ${onChain.uiAmount} tokens (${onChain.amount} base units)`);
                }
                break;
              }
            }
          } catch (e: any) {
            console.warn(`[REAL-BUY-SYNC-WARN] ${e?.message}`);
          }
        }, 1000);
      }
    } catch (err: any) {
      console.error(`[REAL-BUY-ERR] ${err?.message}`);
    }
  }

  /**
   * Helper: Eksekusi Real Auto-Sell on-chain saat TP atau target exit tersentuh.
   */
  private async maybeExecuteRealSell(
    lane: 'LANE_1' | 'LANE_2',
    mint: string,
    tokenPriceUsd: number,
    sellRatioPct: number = 100,
    isFullExit: boolean = true,
    forceEmergencyClose: boolean = false
  ): Promise<void> {
    try {
      const config = readFollowerLiveConfig(this.dataDir);
      if (!config.autoSell) return;

      // Jika autobuyScenario aktif (S4, S6, atau BOTH), maka eksekusi nyata ditangani oleh scenario engine, bukan legacy lane
      if (config.autobuyScenario && config.autobuyScenario !== 'OFF' && !forceEmergencyClose) {
        return;
      }

      const state = readFollowerRealState(this.dataDir);
      const openPos = state.positions.find(p => p.mint === mint && p.lane === lane && REAL_ACTIVE_STATUSES.has(p.status));
      if (!openPos || openPos.remainingTokens <= 0) return;

      if (!this.page || this.page.isClosed()) return;

      // Tentukan apakah full exit atau partial sell
      let isActualFullExit = isFullExit || sellRatioPct >= 99;
      let totalRemainingUnits = BigInt(openPos.remainingBaseUnits || Math.floor(openPos.remainingTokens * 1e6).toString());
      let baseUnitsToSell: string;

      if (lane === 'LANE_2' || isActualFullExit) {
        baseUnitsToSell = totalRemainingUnits.toString();
        isActualFullExit = true;
      } else {
        // Lane 1 partial sell
        const ratioScaled = BigInt(Math.max(1, Math.min(10000, Math.round(sellRatioPct * 100))));
        const calcUnits = (totalRemainingUnits * ratioScaled) / 10000n;
        if (totalRemainingUnits - calcUnits < 100n || calcUnits <= 0n) {
          baseUnitsToSell = totalRemainingUnits.toString();
          isActualFullExit = true;
        } else {
          baseUnitsToSell = calcUnits.toString();
        }
      }

      let baseUnits = baseUnitsToSell;
      const tokensTargetToSell = Number(baseUnits) / 1e6;

      console.log(`\n---------------------------------------------------------`);
      console.log(`[REAL AUTO-SELL TRIGGER] 🚀 Mengambil route quote & kirim Real Swap SELL untuk ${openPos.symbol} (${tokensTargetToSell.toLocaleString()} tokens | ${sellRatioPct.toFixed(1)}% porsi | ${isActualFullExit ? 'FULL EXIT' : 'PARTIAL'}) di ${lane}...`);

      let sellQuote = await getBrowserSellSwapRoute(
        this.page,
        mint,
        openPos.wallet,
        baseUnits,
        6,
        config.sellSlippagePercent
      );

      // Jaring Pengaman Otomatis: Jika route gagal akibat selisih desimal (token balance is less than available balance)
      if (!sellQuote.ok && sellQuote.error && sellQuote.error.includes('token balance is less than available balance')) {
        console.warn(`[REAL AUTO-SELL] Terdeteksi selisih saldo (${sellQuote.error}). Membaca saldo on-chain riil dari blockchain...`);
        try {
          const { getOnChainTokenBalance } = await import('./solana-rent-reclaimer.mjs');
          const onChain = await getOnChainTokenBalance(mint, openPos.wallet);
          if (onChain && onChain.amount && onChain.amount !== '0') {
            openPos.remainingTokens = onChain.uiAmount;
            openPos.remainingBaseUnits = onChain.amount;
            totalRemainingUnits = BigInt(onChain.amount);
            if (lane === 'LANE_2' || isActualFullExit) {
              baseUnits = onChain.amount;
            } else {
              const ratioScaled = BigInt(Math.max(1, Math.min(10000, Math.round(sellRatioPct * 100))));
              baseUnits = ((totalRemainingUnits * ratioScaled) / 10000n).toString();
            }
            writeFollowerRealState(this.dataDir, state);
            console.log(`[REAL AUTO-SELL] Mengulang quote sell dengan saldo on-chain riil: ${onChain.uiAmount} tokens (${baseUnits} base units)...`);
            sellQuote = await getBrowserSellSwapRoute(
              this.page,
              mint,
              openPos.wallet,
              baseUnits,
              6,
              config.sellSlippagePercent
            );
          }
        } catch (e: any) {
          console.warn(`[REAL AUTO-SELL-RETRY-ERR] ${e?.message}`);
        }
      }

      if (!sellQuote.ok || !sellQuote.quote || !sellQuote.routeData) {
        console.warn(`[REAL AUTO-SELL ABORTED] Gagal route swap sell AMM (${sellQuote.error || 'NO_QUOTE'}). Menahan posisi untuk retry tick berikutnya.`);

        // Catat waktu pertama kali sell terpicu tapi gagal & simpan pending sell ratio agar loop 1.5s menembak ulang
        openPos.pendingSellRatio = sellRatioPct;
        if (!openPos.firstSellFailedAt) {
          openPos.firstSellFailedAt = Date.now();
        }
        writeFollowerRealState(this.dataDir, state);

        const errStr = (sellQuote.error || '').toLowerCase();
        const isLiquidityFailure = errStr.includes('no route') || 
                                   errStr.includes('little pool hit') || 
                                   errStr.includes('no external pool') || 
                                   errStr.includes('liquidity') ||
                                   errStr.includes('pool depleted');
        
        const failedDurationMs = Date.now() - (openPos.firstSellFailedAt || Date.now());

        // Jika rute swap gagal akibat ketiadaan likuiditas selama >= 5 menit ATAU forceEmergencyClose aktif (rotasi ke koin baru):
        // Eksekusi burn & reclaim rent SOL agar slot tidak macet dan modal sewa kembali!
        if (forceEmergencyClose || (isLiquidityFailure && failedDurationMs >= 300000)) {
          console.log(`[SAFETY-RUG-RECLAIM] ${forceEmergencyClose ? 'Rotasi koin baru / emergency force-close' : 'Likuiditas pool mati / rug-pull terkonfirmasi'} (${sellQuote.error}). Mengeksekusi burn & reclaim rent SOL...`);
          try {
            const { burnAndCloseTokenAccount } = await import('./solana-rent-reclaimer.mjs');
            const burnRes = await burnAndCloseTokenAccount(mint);
            if (burnRes.ok) {
              openPos.status = 'CLOSED';
              openPos.remainingTokens = 0;
              openPos.remainingBaseUnits = '0';
              delete openPos.pendingSellRatio;
              openPos.updatedAt = Date.now();
              openPos.audit.push({ at: Date.now(), type: 'RENT_RECLAIMED_BURN', details: burnRes });
              writeFollowerRealState(this.dataDir, state);
              console.log(`[SAFETY-RUG-RECLAIM] ✅ Berhasil burn & reclaim rent SOL: ${burnRes.tx}`);
              return;
            } else {
              console.warn(`[SAFETY-RUG-RECLAIM-FAIL] ${burnRes.message}`);
              if (burnRes.message && (burnRes.message.includes('Akun tidak ditemukan atau sudah kosong') || burnRes.message.includes('sudah kosong'))) {
                openPos.status = 'CLOSED';
                openPos.remainingTokens = 0;
                openPos.remainingBaseUnits = '0';
                delete openPos.pendingSellRatio;
                openPos.updatedAt = Date.now();
                openPos.audit.push({ at: Date.now(), type: 'RENT_ALREADY_CLOSED', details: burnRes });
                writeFollowerRealState(this.dataDir, state);
                console.log(`[SAFETY-RUG-RECLAIM] ✅ Akun on-chain sudah tertutup/bersih. Menutup status posisi lokal.`);
                return;
              } else if (forceEmergencyClose) {
                // Saat rotasi paksa, tetap tandai posisi lokal CLOSED agar slot tidak mengunci koin baru
                openPos.status = 'CLOSED';
                openPos.remainingTokens = 0;
                openPos.remainingBaseUnits = '0';
                delete openPos.pendingSellRatio;
                openPos.updatedAt = Date.now();
                openPos.audit.push({ at: Date.now(), type: 'FORCE_CLOSED_ON_ROTATION', details: burnRes });
                writeFollowerRealState(this.dataDir, state);
                console.log(`[SAFETY-RUG-RECLAIM] Posisi lokal ditutup paksa demi rotasi koin baru.`);
                return;
              }
            }
          } catch (e: any) {
            console.warn(`[SAFETY-RUG-RECLAIM-ERR] ${e?.message}`);
            if (forceEmergencyClose) {
              openPos.status = 'CLOSED';
              openPos.remainingTokens = 0;
              openPos.remainingBaseUnits = '0';
              delete openPos.pendingSellRatio;
              writeFollowerRealState(this.dataDir, state);
            }
          }
        }
        return;
      }

      // Reset tracking kegagalan jika sell rute berhasil didapat
      if (openPos.firstSellFailedAt) {
        delete openPos.firstSellFailedAt;
      }

      const res = await this.liveAdapter.submitSwapOrder(this.page, {
        side: 'SELL',
        mint,
        wallet: openPos.wallet,
        amountBaseUnits: baseUnits,
        routeData: sellQuote.routeData,
        config,
        solUsd: this.solPriceUsd,
        tokenPriceUsd,
      });

      const tokensSold = Number(baseUnits) / 10 ** (sellQuote.quote?.inDecimals ?? 6);
      const usdReceived = Number(sellQuote.routeData?.quote?.amountOutUsd || 0);

      // Hitung cost basis dari porsi yang terjual
      const soldRatioActual = openPos.remainingTokens > 0 ? Math.min(1.0, tokensSold / openPos.remainingTokens) : 1.0;
      const costBasisSold = openPos.costBasisUsd * soldRatioActual;
      const pnlUsd = usdReceived > 0 ? Number((usdReceived - costBasisSold).toFixed(4)) : 0;

      openPos.sells.push({
        side: 'SELL',
        lane,
        submittedAt: Date.now(),
        status: res.ok ? 'CONFIRMED' : 'FAILED',
        orderId: res.orderId,
        hash: res.hash,
        stakeUsd: usdReceived,
        tokenAmount: baseUnits,
        decimals: sellQuote.quote?.inDecimals ?? 6,
        solUsd: this.solPriceUsd,
        confirmedAt: res.ok ? Date.now() : undefined,
        error: res.error,
      });

      if (res.ok) {
        delete openPos.pendingSellRatio;
        if (isActualFullExit) {
          openPos.status = 'CLOSED';
          openPos.remainingTokens = 0;
          openPos.remainingBaseUnits = '0';
          openPos.realizedPnlUsd += pnlUsd;
          openPos.exitPriceUsd = tokenPriceUsd;

          // Auto-reclaim rent SOL dari token account yang sudah kosong setelah sell
          setTimeout(async () => {
            try {
              const { reclaimRentForMint } = await import('./solana-rent-reclaimer.mjs');
              console.log(`[AUTO-RECLAIM-RENT] Memeriksa akun kosong untuk reclaim rent token ${mint}...`);
              const reclaimRes = await reclaimRentForMint(mint);
              if (reclaimRes.ok && reclaimRes.reclaimedSol > 0) {
                console.log(`[AUTO-RECLAIM-RENT] ✅ Berhasil me-reclaim +${reclaimRes.reclaimedSol.toFixed(6)} SOL untuk mint ${mint}! Tx: ${reclaimRes.signatures?.[0]}`);
                auditFollowerReal(this.dataDir, state, openPos, 'RENT_RECLAIMED', {
                  reclaimedSol: reclaimRes.reclaimedSol,
                  signatures: reclaimRes.signatures,
                });
              }
            } catch (err: any) {
              console.warn(`[AUTO-RECLAIM-RENT-WARN] ${err?.message}`);
            }
          }, 4000);
        } else {
          // Parsial sell: status tetap HOLDING, kurangi saldo tersisa
          openPos.status = 'HOLDING';
          openPos.remainingTokens = Math.max(0, openPos.remainingTokens - tokensSold);
          const nextRemainingUnits = BigInt(openPos.remainingBaseUnits || '0') - BigInt(baseUnits);
          openPos.remainingBaseUnits = (nextRemainingUnits > 0n ? nextRemainingUnits : 0n).toString();
          openPos.costBasisUsd = Math.max(0, openPos.costBasisUsd - costBasisSold);
          openPos.realizedPnlUsd += pnlUsd;
          openPos.exitPriceUsd = tokenPriceUsd;
          openPos.stage1Exited = true;
          console.log(`[REAL PARTIAL SELL] ✅ Terjual ${tokensSold.toLocaleString()} token (${sellRatioPct.toFixed(1)}%). Sisa: ${openPos.remainingTokens.toLocaleString()} tokens`);
        }
      } else {
        openPos.lastError = res.error;
      }
      openPos.updatedAt = Date.now();

      auditFollowerReal(this.dataDir, state, openPos, 'REAL_SELL', { res, usdReceived, pnlUsd });
      console.log(`[REAL AUTO-SELL RESULT] Status: ${res.ok ? (isActualFullExit ? 'CLOSED' : 'PARTIAL_CONFIRMED') : 'FAILED'} | PnL: $${pnlUsd} | Hash: ${res.hash || '-'}`);
      console.log(`---------------------------------------------------------\n`);
    } catch (err: any) {
      console.error(`[REAL-SELL-ERR] ${err?.message}`);
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
