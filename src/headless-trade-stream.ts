import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { TargetTrade } from './distribution-target-lane.js';

export interface HeadlessStreamOptions {
  pumpPortalWsUrl?: string;
  pumpPortalApiKey?: string;
  dexPollIntervalMs?: number;
  solPriceUsd?: number;
}

export interface NewTokenEvent {
  mint: string;
  traderPublicKey: string;
  name?: string;
  symbol?: string;
  initialBuy?: number;
  bondingCurveKey?: string;
  vTokensInBondingCurve?: number;
  vSolInBondingCurve?: number;
  marketCapSol?: number;
  createdAt: number;
}

interface TrackedMintMeta {
  registeredAt: number;
  lastPrice: number;
  lastTradeAt: number;
  lastVolumeUsd: number;
  symbol?: string;
  isVip?: boolean;
}

export class HeadlessTradeStream extends EventEmitter {
  private pumpWs: WebSocket | null = null;
  private wsConnected = false;
  private running = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private trackedMints = new Map<string, TrackedMintMeta>();
  private readonly pumpPortalWsUrl: string;
  private readonly pumpPortalApiKey?: string;
  private readonly dexPollIntervalMs: number;
  private solPriceUsd: number;

  constructor(options: HeadlessStreamOptions = {}) {
    super();
    this.pumpPortalWsUrl = options.pumpPortalWsUrl || 'wss://pumpportal.fun/api/data';
    this.pumpPortalApiKey = options.pumpPortalApiKey || process.env.PUMPPORTAL_API_KEY;
    this.dexPollIntervalMs = Math.max(1000, options.dexPollIntervalMs || 1500);
    this.solPriceUsd = options.solPriceUsd || 145.0;
  }

  public setSolPriceUsd(price: number): void {
    if (price > 0) {
      this.solPriceUsd = price;
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.connectPumpPortal();
    this.startDexPoller();
  }

  public stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pumpWs) {
      try {
        this.pumpWs.close();
      } catch {}
      this.pumpWs = null;
    }
    this.wsConnected = false;
  }

  public registerMint(mint: string, meta?: { symbol?: string; priceUsd?: number; isVip?: boolean }): void {
    if (!mint || typeof mint !== 'string') return;
    const now = Date.now();
    const existing = this.trackedMints.get(mint);
    if (!existing) {
      const maxCapacity = 45; // 15 VIP + 30 Regular
      if (this.trackedMints.size >= maxCapacity) {
        // Cari mint non-VIP tertua untuk di-evict terlebih dahulu
        let evictKey: string | null = null;
        for (const [k, v] of this.trackedMints.entries()) {
          if (!v.isVip) {
            evictKey = k;
            break;
          }
        }
        // Jika semua VIP, baru ambil yang paling lama
        if (!evictKey) {
          evictKey = this.trackedMints.keys().next().value ?? null;
        }
        if (evictKey) this.unregisterMint(evictKey);
      }
      this.trackedMints.set(mint, {
        registeredAt: now,
        lastPrice: meta?.priceUsd || 0,
        lastTradeAt: now,
        lastVolumeUsd: 0,
        symbol: meta?.symbol,
        isVip: Boolean(meta?.isVip),
      });

      // Jika kita punya API key PumpPortal, subscribe ke token trades via WebSocket
      if (this.pumpWs && this.wsConnected && this.pumpPortalApiKey) {
        try {
          this.pumpWs.send(JSON.stringify({
            method: 'subscribeTokenTrade',
            keys: [mint],
          }));
        } catch {}
      }
    } else if (meta?.isVip && !existing.isVip) {
      existing.isVip = true;
    }
  }

  public unregisterMint(mint: string): void {
    if (!mint) return;
    if (this.trackedMints.has(mint)) {
      this.trackedMints.delete(mint);
      if (this.pumpWs && this.wsConnected && this.pumpPortalApiKey) {
        try {
          this.pumpWs.send(JSON.stringify({
            method: 'unsubscribeTokenTrade',
            keys: [mint],
          }));
        } catch {}
      }
    }
  }

  public hasMint(mint: string): boolean {
    return this.trackedMints.has(mint);
  }

  public isConnected(): boolean {
    return this.wsConnected;
  }

  public getTrackedMints(): string[] {
    return Array.from(this.trackedMints.keys());
  }

  public emitTrade(mint: string, trade: TargetTrade): void {
    const meta = this.trackedMints.get(mint);
    if (meta) {
      meta.lastPrice = trade.price;
      meta.lastTradeAt = trade.at;
    }
    this.emit('trade', mint, trade);
  }

  private connectPumpPortal(): void {
    if (!this.running) return;

    try {
      this.pumpWs = new WebSocket(this.pumpPortalWsUrl);

      this.pumpWs.on('open', () => {
        this.wsConnected = true;
        this.emit('status', { ws: true });

        // Selalu subscribe new token untuk Genesis Surge & deteksi detik ke-0
        try {
          this.pumpWs?.send(JSON.stringify({ method: 'subscribeNewToken' }));
        } catch {}

        // Jika punya API key, resubscribe semua token yang sedang dipantau
        if (this.pumpPortalApiKey && this.trackedMints.size > 0) {
          const keys = Array.from(this.trackedMints.keys());
          try {
            this.pumpWs?.send(JSON.stringify({
              method: 'subscribeTokenTrade',
              keys,
            }));
          } catch {}
        }
      });

      this.pumpWs.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handlePumpPortalMessage(msg);
        } catch {}
      });

      this.pumpWs.on('error', () => {
        // Error diamankan, siklus close akan memicu reconnect
      });

      this.pumpWs.on('close', () => {
        this.wsConnected = false;
        this.pumpWs = null;
        this.emit('status', { ws: false });
        if (this.running) {
          this.reconnectTimer = setTimeout(() => this.connectPumpPortal(), 4000);
        }
      });
    } catch {
      if (this.running) {
        this.reconnectTimer = setTimeout(() => this.connectPumpPortal(), 5000);
      }
    }
  }

  private handlePumpPortalMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;

    const now = Date.now();
    const txType = msg.txType;

    // 1. Deteksi New Token Create
    if (txType === 'create' && msg.mint) {
      let vSol = Number(msg.vSolInBondingCurve) || 30;
      let vTokens = Number(msg.vTokensInBondingCurve) || 1_073_000_000;
      if (vSol > 1e6) vSol /= 1e9;
      if (vTokens > 1e12) vTokens /= 1e6;
      let initialPrice = vTokens > 0 ? (vSol / vTokens) * this.solPriceUsd : 0.000004;
      if (initialPrice < 0.000001 || initialPrice > 10.0 || !Number.isFinite(initialPrice)) {
        initialPrice = 0.000004;
      }

      const event: NewTokenEvent = {
        mint: msg.mint,
        traderPublicKey: msg.traderPublicKey || '',
        name: msg.name,
        symbol: msg.symbol,
        initialBuy: Number(msg.initialBuy) || 0,
        bondingCurveKey: msg.bondingCurveKey,
        vTokensInBondingCurve: vTokens,
        vSolInBondingCurve: vSol,
        marketCapSol: Number(msg.marketCapSol) || 28,
        createdAt: now,
      };

      this.emit('newToken', event);

      // Jika token baru ini terdaftar untuk dipantau langsung:
      if (this.trackedMints.has(msg.mint)) {
        const trade: TargetTrade = {
          at: now,
          timestamp: Math.floor(now / 1000),
          price: initialPrice,
          side: 'buy',
          wallet: msg.traderPublicKey || 'creator',
          usd: (Number(msg.initialBuy) || 0.1) * this.solPriceUsd,
          signature: msg.signature || 'create_tx',
        };
        this.emitTrade(msg.mint, trade);
      }
      return;
    }

    // 2. Transaksi Buy/Sell dari subscribeTokenTrade
    if ((txType === 'buy' || txType === 'sell') && msg.mint) {
      const mint = msg.mint;
      if (!this.trackedMints.has(mint)) return;

      let vSol = Number(msg.vSolInBondingCurve);
      let vTokens = Number(msg.vTokensInBondingCurve);
      if (vSol > 1e6) vSol /= 1e9;
      if (vTokens > 1e12) vTokens /= 1e6;

      let price = 0;
      if (vSol > 0 && vTokens > 0) {
        price = (vSol / vTokens) * this.solPriceUsd;
      } else if (msg.solAmount && msg.tokenAmount && Number(msg.tokenAmount) > 0) {
        let sol = Number(msg.solAmount);
        let tok = Number(msg.tokenAmount);
        if (sol > 1e6) sol /= 1e9;
        if (tok > 1e12) tok /= 1e6;
        price = (sol / tok) * this.solPriceUsd;
      }

      // Validasi batas harga pump.fun yang realistis ($0.000001 - $10.0)
      const lastKnown = this.trackedMints.get(mint)?.lastPrice;
      if (price < 0.000001 || price > 10.0 || !Number.isFinite(price)) {
        if (lastKnown && lastKnown >= 0.000001) {
          price = lastKnown;
        } else {
          return;
        }
      }

      const usd = (Number(msg.solAmount) || 0) * this.solPriceUsd;
      const trade: TargetTrade = {
        at: now,
        timestamp: Math.floor(now / 1000),
        price,
        side: txType,
        wallet: msg.traderPublicKey || 'trader',
        usd: usd > 0 ? usd : 10,
        signature: msg.signature,
      };

      this.emitTrade(mint, trade);
    }
  }

  private startDexPoller(): void {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(async () => {
      if (!this.running || this.trackedMints.size === 0) return;

      const mints = Array.from(this.trackedMints.keys());
      // DexScreener mendukung hingga 30 token sekaligus dipisah koma
      const batchSize = 25;
      for (let i = 0; i < mints.length; i += batchSize) {
        const batch = mints.slice(i, i + batchSize);
        await this.pollDexScreenerBatch(batch).catch(() => {});
      }
    }, this.dexPollIntervalMs);

    this.pollTimer.unref();
  }

  private async pollDexScreenerBatch(mints: string[]): Promise<void> {
    if (mints.length === 0) return;

    const url = `https://api.dexscreener.com/latest/dex/tokens/${mints.join(',')}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return;

    const data = await res.json() as any;
    const pairs = data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return;

    const now = Date.now();
    const seenMints = new Set<string>();

    for (const pair of pairs) {
      const mint = pair.baseToken?.address;
      if (!mint || !this.trackedMints.has(mint) || seenMints.has(mint)) continue;
      seenMints.add(mint);

      const priceUsd = Number(pair.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

      const meta = this.trackedMints.get(mint)!;
      const currentVol = Number(pair.volume?.m5) || 0;
      const volDelta = Math.max(0, currentVol - meta.lastVolumeUsd);

      // Tentukan apakah ada pergerakan harga atau volume
      const priceChanged = Math.abs(priceUsd - meta.lastPrice) > 1e-12;
      const timeStale = now - meta.lastTradeAt >= 2500;

      if (priceChanged || timeStale || meta.lastPrice === 0) {
        const side = priceUsd >= meta.lastPrice ? 'buy' : 'sell';
        const m5Buys = Number(pair.txns?.m5?.buys) || 1;
        const buyerCount = Math.max(1, Math.min(6, m5Buys));
        const totalUsd = volDelta > 0 ? volDelta : 25;

        if (side === 'buy' && buyerCount > 1) {
          const sliceUsd = totalUsd / buyerCount;
          for (let b = 0; b < buyerCount; b++) {
            const trade: TargetTrade = {
              at: now - (buyerCount - 1 - b) * 200,
              timestamp: Math.floor(now / 1000),
              price: priceUsd,
              side: 'buy',
              wallet: `dex_trader_${b}_${mint.slice(0, 4)}`,
              usd: sliceUsd,
              signature: `dex_${now}_${b}`,
            };
            this.emitTrade(mint, trade);
          }
        } else {
          const trade: TargetTrade = {
            at: now,
            timestamp: Math.floor(now / 1000),
            price: priceUsd,
            side,
            wallet: side === 'buy' ? `dex_trader_0_${mint.slice(0, 4)}` : `dex_seller_0_${mint.slice(0, 4)}`,
            usd: totalUsd,
            signature: `dex_${now}`,
          };
          this.emitTrade(mint, trade);
        }

        meta.lastVolumeUsd = currentVol;
      }
    }
  }
}
