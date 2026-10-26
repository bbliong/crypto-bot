import { chromium, type Browser, type Page, type CDPSession } from 'playwright';
import path from 'node:path';
import { WalletFollowerLane, type WalletTradeSignal } from '../src/wallet-follower-lane.js';
import { getBrowserBuySwapRoute, getBrowserSellSwapRoute, DEFAULT_SWAP_WALLET } from '../src/browser-swap-route.js';

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
  private lane: WalletFollowerLane;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private cdp: CDPSession | null = null;
  private isRunning = false;
  private currentSubscribedToken: string | null = null;
  private solPriceUsd = 145.0;
  private lastMtmLogAt = 0;
  private processedTxHashes: Set<string> = new Set();

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
  }

  public async start(durationSeconds: number = 0): Promise<void> {
    console.log(`[FOLLOWER] Memulai Dedicated Wallet Follower...`);
    console.log(`[FOLLOWER] Target Wallet: ${this.targetWallet}`);
    console.log(`[FOLLOWER] Rule: Buy $2.0/entry (Modal Kas $20 Pool, Max 10 buy tanpa sell, modal didaur ulang saat sell)`);
    console.log(`[FOLLOWER] Mode: APPLE-TO-APPLE (Hanya ikut saat target mulai beli token baru dari 0)`);
    console.log(`[FOLLOWER] Chrome CDP: ${this.cdpEndpoint}`);
    if (this.dryRun) console.log(`[FOLLOWER] MODE: DRY-RUN (Tidak mengubah posisi file)`);

    this.isRunning = true;
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

  private handleIncomingWsFrame(payload: string): void {
    if (!payload || !payload.startsWith('{')) return;

    try {
      const msg = JSON.parse(payload);

      // 1. Tangkap aktivitas Buy / Sell dari target wallet
      if (msg.channel === 'wallet_activity_info' && Array.isArray(msg.data)) {
        for (const item of msg.data) {
          if (item.m === this.targetWallet || !item.m) {
            this.processWalletTradeItem(item);
          }
        }
      }

      // 2. Tangkap update harga token_stat dari token yang sedang dipantau
      if (msg.channel === 'token_stat' && Array.isArray(msg.data)) {
        for (const stat of msg.data) {
          if (stat.a && stat.p) {
            const price = Number(stat.p) || 0;
            this.lane.updateTokenTick(stat.a, price);
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

  private async handleTargetBuy(signal: WalletTradeSignal): Promise<void> {
    const evalBuy = this.lane.evaluateBuySignal(signal);
    const nowMs = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(nowMs);
    const eventId = `ev_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;

    if (!evalBuy.canEnter) {
      console.log(`[FOLLOW BUY SKIP] Alasan: ${evalBuy.reason}`);
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
        const tokensBought = Number(quote.quote.outAmount || 0) / 10 ** (quote.quote.outDecimals ?? 6);
        const execPrice = quote.impliedPriceUsd || signal.priceUsd;
        console.log(`[SWAP AMM QUOTE SUCCESSS] Diterima ${tokensBought.toLocaleString()} token ${signal.symbol} | Implied: $${execPrice}`);

        const pos = this.lane.recordBuyExecution(signal, evalBuy.stakeUsd, tokensBought, execPrice);
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
            stakeUsd: evalBuy.stakeUsd,
            tokensBoughtOrSold: tokensBought,
            tokensFormatted: formatAmount(tokensBought),
            executionPriceUsd: execPrice,
            swapAmm: {
              inAmount: quote.quote.inAmount || `${evalBuy.stakeUsd} USD`,
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
  }

  private async handleTargetSell(signal: WalletTradeSignal): Promise<void> {
    const evalSell = this.lane.evaluateSellSignal(signal);
    const nowMs = signal.timestamp ? signal.timestamp * 1000 : Date.now();
    const timeWib = formatWibDate(nowMs);
    const eventId = `ev_${nowMs}_${Math.random().toString(36).slice(2, 6)}`;

    if (!evalSell.canSell) {
      console.log(`[FOLLOW SELL SKIP] Tidak ada open position pada token ini.`);
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
          action: 'SKIP_NO_POSITION',
          tokensBoughtOrSold: 0,
          tokensFormatted: '0',
          executionPriceUsd: signal.priceUsd,
          positionStatus: 'CLOSED',
          reason: 'NO_OPEN_POSITION',
        },
      });
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
        const usdReceived = quote.quote.amountOutUsd || (evalSell.botTokensToSell * signal.priceUsd);
        const execPrice = quote.impliedPriceUsd || signal.priceUsd;

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
  }

  private async ensureTokenSubscribed(mint: string): Promise<void> {
    if (this.currentSubscribedToken === mint || !this.page) return;

    try {
      const prevMint = this.currentSubscribedToken;
      this.currentSubscribedToken = mint;

      await this.page.evaluate(
        ({ prevMint, newMint }) => {
          const ws = (window as any).__gmgnWs;
          if (!ws || ws.readyState !== 1) return;

          // Unsubscribe token lama jika ada
          if (prevMint) {
            ws.send(JSON.stringify({
              action: 'unsubscribe',
              channel: 'token_activity',
              f: 'w',
              id: 'unsub_token_act',
              data: [{ chain: 'sol', addresses: prevMint }],
            }));
            ws.send(JSON.stringify({
              action: 'unsubscribe',
              channel: 'token_stat',
              f: 'w',
              id: 'unsub_token_stat',
              data: [{ chain: 'sol', addresses: prevMint }],
            }));
          }

          // Subscribe token baru
          ws.send(JSON.stringify({
            action: 'subscribe',
            channel: 'token_activity',
            f: 'w',
            id: 'sub_token_act',
            data: [{ chain: 'sol', addresses: newMint }],
          }));
          ws.send(JSON.stringify({
            action: 'subscribe',
            channel: 'token_stat',
            f: 'w',
            id: 'sub_token_stat',
            data: [{ chain: 'sol', addresses: newMint }],
          }));
        },
        { prevMint, newMint: mint }
      );

      console.log(`[DYNAMIC TOKEN WS] Berhasil subscribe sub-second feed untuk token: ${mint}`);
    } catch (err: any) {
      console.warn(`[DYNAMIC-SUB-WARN] Gagal subscribe token: ${err?.message}`);
    }
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
      console.log(`\n[HEARTBEAT] Follower Aktif | Open Positions: ${openPositions.length} | Target: ${this.targetWallet.slice(0, 8)}... | Tab: ${this.page?.url()?.slice(0, 45)}...`);
      for (const p of openPositions) {
        const curValue = p.totalTokens * p.lastObservedPriceUsd;
        const unPnl = curValue - p.remainingCostBasisUsd;
        const roi = p.remainingCostBasisUsd > 0 ? (unPnl / p.remainingCostBasisUsd) * 100 : 0;
        console.log(`  -> ${p.symbol}: Stake $${p.remainingCostBasisUsd.toFixed(2)} (${p.entryCount}/5) | CurValue: $${curValue.toFixed(2)} | UnPnl: ${unPnl >= 0 ? '+' : ''}$${unPnl.toFixed(2)} (${roi.toFixed(1)}%)`);
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
