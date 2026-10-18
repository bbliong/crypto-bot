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

export class GmgnTokenWebSocketManager extends EventEmitter {
  private page: Page;
  private maxVipTokens: number;
  private maxRegularTokens: number;
  private vipMints: string[] = [];
  private regularMints: string[] = [];
  private cdpSession: CDPSession | null = null;
  private isInitialized = false;

  constructor(page: Page, maxRegularTokens: number = 18, maxVipTokens: number = 12) {
    super();
    this.page = page;
    this.maxRegularTokens = Math.max(5, Math.min(25, maxRegularTokens));
    this.maxVipTokens = Math.max(5, Math.min(15, maxVipTokens));
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

  public async subscribeToken(mint: string, isVip = false): Promise<boolean> {
    if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return false;

    if (isVip) {
      // Remove from regular if it was previously registered there
      const regIdx = this.regularMints.indexOf(mint);
      if (regIdx !== -1) {
        this.regularMints.splice(regIdx, 1);
      }

      // If already in VIP, move to tail (most recent)
      const vipIdx = this.vipMints.indexOf(mint);
      if (vipIdx !== -1) {
        this.vipMints.splice(vipIdx, 1);
        this.vipMints.push(mint);
        return true;
      }

      // Enforce VIP slots constraint (FIFO within VIP only)
      while (this.vipMints.length >= this.maxVipTokens) {
        const oldest = this.vipMints.shift();
        if (oldest) {
          await this.sendFrame("unsubscribe", oldest).catch(() => {});
        }
      }

      this.vipMints.push(mint);
      return await this.sendFrame("subscribe", mint);
    } else {
      // Regular token: if already in VIP, do NOT downgrade
      if (this.vipMints.includes(mint)) return true;

      // If already in regular, move to tail
      const regIdx = this.regularMints.indexOf(mint);
      if (regIdx !== -1) {
        this.regularMints.splice(regIdx, 1);
        this.regularMints.push(mint);
        return true;
      }

      // Enforce Regular slots constraint (never evicts VIP tokens!)
      while (this.regularMints.length >= this.maxRegularTokens) {
        const oldest = this.regularMints.shift();
        if (oldest) {
          await this.sendFrame("unsubscribe", oldest).catch(() => {});
        }
      }

      this.regularMints.push(mint);
      return await this.sendFrame("subscribe", mint);
    }
  }

  public async unsubscribeToken(mint: string): Promise<boolean> {
    const vipIdx = this.vipMints.indexOf(mint);
    if (vipIdx !== -1) {
      this.vipMints.splice(vipIdx, 1);
    }
    const regIdx = this.regularMints.indexOf(mint);
    if (regIdx !== -1) {
      this.regularMints.splice(regIdx, 1);
    }
    return await this.sendFrame("unsubscribe", mint);
  }

  public getSubscribedMints(): string[] {
    return [...this.vipMints, ...this.regularMints];
  }

  public getSubscribedCount(): number {
    return this.vipMints.length + this.regularMints.length;
  }

  public getVipCount(): number {
    return this.vipMints.length;
  }

  public getRegularCount(): number {
    return this.regularMints.length;
  }

  public isVip(mint: string): boolean {
    return this.vipMints.includes(mint);
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
