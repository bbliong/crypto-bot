import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type WalletTransferEvent = {
  wallet: string;
  mint: string;
  symbol?: string;
  timestamp: number;
  amount: string;
  from?: string;
  tx: string;
  priceUsd?: number;
};

export type WalletSellEvent = {
  wallet: string;
  mint: string;
  timestamp: number;
  tx: string;
  amount?: string;
};

export type SolanaWalletStreamOptions = {
  rpcWsUrl?: string;
  rpcHttpUrl?: string;
  maxWalletsPerSocket?: number;
  staggerMs?: number;
};

export class SolanaWalletStream extends EventEmitter {
  private rpcWsUrl: string;
  private rpcHttpUrl: string;
  private maxWalletsPerSocket: number;
  private staggerMs: number;
  private sockets: WebSocket[] = [];
  private subToWallet = new Map<number, string>();
  private walletToSub = new Map<string, number>();
  private processedSignatures = new Set<string>();
  private running = false;
  private addresses: string[] = [];
  private reconnectTimers: NodeJS.Timeout[] = [];

  constructor(options?: SolanaWalletStreamOptions) {
    super();
    this.rpcWsUrl = options?.rpcWsUrl || "wss://api.mainnet-beta.solana.com";
    this.rpcHttpUrl = options?.rpcHttpUrl || "https://api.mainnet-beta.solana.com";
    this.maxWalletsPerSocket = options?.maxWalletsPerSocket || 70;
    this.staggerMs = options?.staggerMs || 25;
  }

  public async start(addresses: string[]): Promise<void> {
    this.running = true;
    this.addresses = [...addresses];
    this.stopSockets();

    const chunks: string[][] = [];
    for (let i = 0; i < this.addresses.length; i += this.maxWalletsPerSocket) {
      chunks.push(this.addresses.slice(i, i + this.maxWalletsPerSocket));
    }

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      await this.initSocket(chunk, index);
    }
  }

  private initSocket(wallets: string[], socketIndex: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.running) return resolve();

      const ws = new WebSocket(this.rpcWsUrl);
      this.sockets.push(ws);

      const requestToWallet = new Map<number, string>();
      let reqId = socketIndex * 10000 + 1;

      ws.on("open", async () => {
        for (const wallet of wallets) {
          if (!this.running || ws.readyState !== WebSocket.OPEN) break;
          const id = reqId++;
          requestToWallet.set(id, wallet);
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "logsSubscribe",
              params: [{ mentions: [wallet] }, { commitment: "processed" }],
            }),
          );
          if (this.staggerMs > 0) {
            await new Promise((r) => setTimeout(r, this.staggerMs));
          }
        }
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());

          // Handle subscription acknowledgment
          if (msg.id && requestToWallet.has(msg.id)) {
            const wallet = requestToWallet.get(msg.id)!;
            const subId = msg.result;
            if (typeof subId === "number") {
              this.subToWallet.set(subId, wallet);
              this.walletToSub.set(wallet, subId);
            }
            return;
          }

          // Handle log notifications
          if (msg.method === "logsNotification" && msg.params) {
            const subId = msg.params.subscription;
            const wallet = this.subToWallet.get(subId);
            const value = msg.params.result?.value;
            if (wallet && value) {
              this.handleLogNotification(wallet, value);
            }
          }
        } catch (err: any) {
          this.emit("error", new Error(`Failed to parse RPC message: ${err?.message}`));
        }
      });

      ws.on("error", (err) => {
        this.emit("error", new Error(`Solana RPC WebSocket error (socket ${socketIndex}): ${err.message}`));
      });

      ws.on("close", (code, reason) => {
        if (!this.running) return;
        this.emit(
          "status",
          `Solana RPC socket ${socketIndex} closed (${code}: ${reason}). Reconnecting in 3s...`,
        );
        const timer = setTimeout(() => {
          if (this.running) {
            this.initSocket(wallets, socketIndex).catch(() => {});
          }
        }, 3000);
        this.reconnectTimers.push(timer);
      });
    });
  }

  private async handleLogNotification(
    wallet: string,
    notificationValue: { signature: string; err: unknown; logs: string[] },
  ) {
    const { signature, err, logs } = notificationValue;
    if (err) return; // ignore failed transactions

    // Dedupe signature
    if (this.processedSignatures.has(signature)) return;
    this.processedSignatures.add(signature);
    if (this.processedSignatures.size > 5000) {
      const it = this.processedSignatures.values();
      for (let i = 0; i < 1000; i++) {
        const next = it.next();
        if (next.done) break;
        this.processedSignatures.delete(next.value);
      }
    }

    // Check if logs touch SPL token or pump.fun / raydium
    const hasSpl = logs.some(
      (l) =>
        l.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") ||
        l.includes("Instruction: Transfer") ||
        l.includes("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") ||
        l.includes("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
    );
    if (!hasSpl) return;

    // Resolve transaction details
    try {
      await this.resolveTransaction(wallet, signature);
    } catch {
      // Fallback: emit minimal notification so caller can query GMGN or inspect
      this.emit("rawActivity", { wallet, signature, logs });
    }
  }

  private async resolveTransaction(wallet: string, signature: string, attempt = 1): Promise<void> {
    try {
      const res = await fetch(this.rpcHttpUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [
            signature,
            {
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0,
            },
          ],
        }),
      });

      if (res.status === 429 && attempt <= 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        return this.resolveTransaction(wallet, signature, attempt + 1);
      }

      if (!res.ok) return;
      const body: any = await res.json();
      if (body.error && attempt <= 3) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
        return this.resolveTransaction(wallet, signature, attempt + 1);
      }
      const tx = body.result;
      if (!tx || !tx.meta) return;

    const blockTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    // Find token balance changes for our monitored wallet
    const relevantMints = new Set<string>();
    preBalances.forEach((b: any) => {
      if (b.owner === wallet && b.mint) relevantMints.add(b.mint);
    });
    postBalances.forEach((b: any) => {
      if (b.owner === wallet && b.mint) relevantMints.add(b.mint);
    });

    for (const mint of relevantMints) {
      const pre = preBalances.find((b: any) => b.owner === wallet && b.mint === mint);
      const post = postBalances.find((b: any) => b.owner === wallet && b.mint === mint);

      const preAmount = Number(pre?.uiTokenAmount?.uiAmount || 0);
      const postAmount = Number(post?.uiTokenAmount?.uiAmount || 0);
      const diff = postAmount - preAmount;

      if (diff > 0) {
        // Monitored wallet received tokens -> TRANSFER IN / BUY
        // Find potential sender (wallet whose balance decreased)
        const sender = preBalances.find(
          (b: any) => b.mint === mint && b.owner !== wallet && Number(b.uiTokenAmount?.uiAmount || 0) > 0,
        );

        const transferEvent: WalletTransferEvent = {
          wallet,
          mint,
          amount: diff.toString(),
          timestamp: Math.floor(blockTime / 1000),
          from: sender?.owner || "",
          tx: signature,
        };
        this.emit("transfer", transferEvent);
      } else if (diff < 0) {
        // Monitored wallet lost tokens -> SELL
        const sellEvent: WalletSellEvent = {
          wallet,
          mint,
          timestamp: Math.floor(blockTime / 1000),
          tx: signature,
          amount: Math.abs(diff).toString(),
        };
        this.emit("sell", sellEvent);
      }
    }
  } catch {
    // Ignore RPC error or rate limit
  }
}

  public stopSockets() {
    for (const timer of this.reconnectTimers) clearTimeout(timer);
    this.reconnectTimers = [];
    for (const ws of this.sockets) {
      try {
        ws.removeAllListeners();
        ws.close();
      } catch {}
    }
    this.sockets = [];
    this.subToWallet.clear();
    this.walletToSub.clear();
  }

  public stop() {
    this.running = false;
    this.stopSockets();
  }
}
