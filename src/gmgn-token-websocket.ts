import { EventEmitter } from "events";
import type { Page, CDPSession } from "playwright";

export interface GmgnTradeTick {
  mint: string;
  side: "buy" | "sell";
  price: number;
  usd: number;
  sol: number;
  wallet: string;
  signature: string;
  timestamp: number;
  at: number;
}

export interface GmgnTokenStatTick {
  mint: string;
  price: number;
  buys1m: number;
  sells1m: number;
  volume1m: number;
  at: number;
}

export type TokenPoolType = "momentum" | "smartmoney" | "trend20m";

export interface TokenSubscriptionMeta {
  mint: string;
  pool: TokenPoolType;
  subscribedAt: number;
  maxDurationSeconds: number;
}

export class GmgnTokenWebSocketManager extends EventEmitter {
  private page: Page;
  private poolCapacities: Record<TokenPoolType, number> = {
    momentum: 10,
    smartmoney: 10,
    trend20m: 10,
  };
  private pools: Record<TokenPoolType, string[]> = {
    momentum: [],
    smartmoney: [],
    trend20m: [],
  };
  private tokenMeta = new Map<string, TokenSubscriptionMeta>();
  private cdpSession: CDPSession | null = null;
  private isInitialized = false;

  constructor(
    page: Page,
    maxPerPool: number = 50,
    maxVipTokens: number = 50
  ) {
    super();
    this.page = page;
    const clamped = Math.max(10, Math.min(100, maxPerPool));
    this.poolCapacities = {
      momentum: clamped,
      smartmoney: Math.max(10, Math.min(100, maxVipTokens)),
      trend20m: clamped,
    };
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;

    // Inject WebSocket hook so window.__gmgnWs holds the active native GMGN WebSocket instance
    await this.page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      (window as any).__allSockets = (window as any).__allSockets || [];
      window.WebSocket = function (...args: any[]) {
        const ws = new OrigWS(...(args as [any, any]));
        (window as any).__allSockets.push(ws);
        if (args[0] && String(args[0]).includes("ws.gmgn.ai")) {
          (window as any).__gmgnWs = ws;
        }
        return ws;
      } as any;
      window.WebSocket.prototype = OrigWS.prototype;
    });

    try {
      this.cdpSession = await this.page.context().newCDPSession(this.page);
      await this.cdpSession.send("Network.enable");

      this.cdpSession.on("Network.webSocketFrameReceived", (p) => {
        try {
          const str = p.response.payloadData;
          if (!str || !str.startsWith("{")) return;
          const msg = JSON.parse(str);

          if (msg.channel === "token_activity" && Array.isArray(msg.data)) {
            for (const item of msg.data) {
              const tick: GmgnTradeTick = {
                mint: item.a || "",
                side: item.e === "buy" ? "buy" : "sell",
                price: Number(item.pu) || 0,
                usd: Number(item.au) || 0,
                sol: Number(item.qa) || 0,
                wallet: item.m || "",
                signature: item.h || "",
                timestamp: Number(item.t) || Math.floor(Date.now() / 1000),
                at: Date.now(),
              };
              if (tick.mint && tick.price > 0) {
                this.emit("trade", tick);
              }
            }
          } else if (msg.channel === "token_stat" && Array.isArray(msg.data)) {
            for (const item of msg.data) {
              const stat: GmgnTokenStatTick = {
                mint: item.a || "",
                price: Number(item.p) || 0,
                buys1m: Number(item.b1m) || 0,
                sells1m: Number(item.s1m) || 0,
                volume1m: Number(item.v1m) || 0,
                at: Date.now(),
              };
              if (stat.mint && stat.price > 0) {
                this.emit("stat", stat);
              }
            }
          } else if (
            msg.channel === "token_holding" ||
            msg.channel === "token_tag_holding" ||
            msg.channel === "token_general_stat_num"
          ) {
            this.emit("frame", msg);
          }
        } catch {}
      });

      this.isInitialized = true;
    } catch (err: any) {
      this.emit("error", new Error(`Failed to initialize CDP session for GMGN WS: ${err?.message}`));
    }
  }

  private resolvePool(poolOrVip: string | boolean): TokenPoolType {
    if (typeof poolOrVip === "boolean") {
      return poolOrVip ? "smartmoney" : "momentum";
    }
    const lower = String(poolOrVip).toLowerCase();
    if (lower === "trend20m" || lower === "trend" || lower.includes("trend")) {
      return "trend20m";
    }
    if (lower === "smartmoney" || lower === "smart_money" || lower === "vip") {
      return "smartmoney";
    }
    return "momentum";
  }

  public async sweepExpired(now = Date.now()): Promise<string[]> {
    const expiredMints: string[] = [];
    for (const [mint, meta] of this.tokenMeta.entries()) {
      const ageSec = (now - meta.subscribedAt) / 1000;
      if (ageSec >= meta.maxDurationSeconds) {
        expiredMints.push(mint);
      }
    }
    for (const mint of expiredMints) {
      await this.unsubscribeToken(mint);
    }
    return expiredMints;
  }

  public async subscribeToken(
    mint: string,
    poolOrVip: string | boolean = "momentum",
    maxDurationSeconds = 7200
  ): Promise<boolean> {
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return false;

    // Bersihkan token yang sudah lewat batas durasi (misal > 2 jam)
    await this.sweepExpired();

    const targetPool = this.resolvePool(poolOrVip);
    const capacity = this.poolCapacities[targetPool] || 10;
    const poolList = this.pools[targetPool];

    // Jika token sudah terdaftar di pool ini, refresh metadata dan pindah ke posisi ekor (most recently active)
    const existingIdx = poolList.indexOf(mint);
    if (existingIdx !== -1) {
      poolList.splice(existingIdx, 1);
      poolList.push(mint);
      const meta = this.tokenMeta.get(mint);
      if (meta) {
        meta.subscribedAt = Date.now();
        meta.maxDurationSeconds = maxDurationSeconds;
      }
      return true;
    }

    // Jika token sebelumnya ada di pool lain, cabut dari pool lama
    for (const otherPool of (["momentum", "smartmoney", "trend20m"] as TokenPoolType[])) {
      if (otherPool !== targetPool) {
        const idx = this.pools[otherPool].indexOf(mint);
        if (idx !== -1) {
          this.pools[otherPool].splice(idx, 1);
        }
      }
    }

    // Enforce Pool quota (Strict 10 per pool, FIFO eviction hanya di dalam pool terkait)
    while (poolList.length >= capacity) {
      const oldest = poolList.shift();
      if (oldest) {
        this.tokenMeta.delete(oldest);
        await this.sendFrame("unsubscribe", oldest).catch(() => {});
      }
    }

    poolList.push(mint);
    this.tokenMeta.set(mint, {
      mint,
      pool: targetPool,
      subscribedAt: Date.now(),
      maxDurationSeconds,
    });

    return await this.sendFrame("subscribe", mint);
  }

  public async unsubscribeToken(mint: string): Promise<boolean> {
    this.tokenMeta.delete(mint);
    for (const p of (["momentum", "smartmoney", "trend20m"] as TokenPoolType[])) {
      const idx = this.pools[p].indexOf(mint);
      if (idx !== -1) {
        this.pools[p].splice(idx, 1);
      }
    }
    return await this.sendFrame("unsubscribe", mint);
  }

  public getSubscribedMints(): string[] {
    return [
      ...this.pools.momentum,
      ...this.pools.smartmoney,
      ...this.pools.trend20m,
    ];
  }

  public getSubscribedCount(): number {
    return (
      this.pools.momentum.length +
      this.pools.smartmoney.length +
      this.pools.trend20m.length
    );
  }

  public getPoolCounts(): {
    momentum: number;
    smartmoney: number;
    trend20m: number;
    total: number;
    capacities: Record<TokenPoolType, number>;
  } {
    return {
      momentum: this.pools.momentum.length,
      smartmoney: this.pools.smartmoney.length,
      trend20m: this.pools.trend20m.length,
      total: this.getSubscribedCount(),
      capacities: { ...this.poolCapacities },
    };
  }

  // Backward compatibility getters
  public getVipCount(): number {
    return this.pools.smartmoney.length;
  }

  public getRegularCount(): number {
    return this.pools.momentum.length + this.pools.trend20m.length;
  }

  public isVip(mint: string): boolean {
    return this.pools.smartmoney.includes(mint);
  }

  public get vipMints(): string[] {
    return this.pools.smartmoney;
  }

  public get regularMints(): string[] {
    return [...this.pools.momentum, ...this.pools.trend20m];
  }

  public getTokenMeta(mint: string): TokenSubscriptionMeta | undefined {
    return this.tokenMeta.get(mint);
  }

  private async sendFrame(action: "subscribe" | "unsubscribe", mint: string): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;

    try {
      return await this.page.evaluate(
        ({ action, mint }) => {
          const ws = (window as any).__gmgnWs;
          if (!ws || ws.readyState !== 1) return false;
          const id = `${action === "subscribe" ? "sub" : "unsub"}_${Math.random().toString(36).slice(2, 8)}`;
          
          ws.send(
            JSON.stringify({
              action,
              channel: "token_activity",
              f: "w",
              id: `${id}_act`,
              data: [{ chain: "sol", addresses: mint }],
            })
          );
          
          ws.send(
            JSON.stringify({
              action,
              channel: "token_stat",
              f: "w",
              id: `${id}_stat`,
              data: [{ chain: "sol", addresses: mint }],
            })
          );

          ws.send(
            JSON.stringify({
              action,
              channel: "token_holding",
              f: "w",
              id: `${id}_hold`,
              data: [{ chain: "sol", addresses: mint }],
            })
          );
          return true;
        },
        { action, mint }
      );
    } catch {
      return false;
    }
  }
}
