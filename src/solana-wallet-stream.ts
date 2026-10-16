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
        const msg = `Solana RPC WebSocket error (socket ${socketIndex}): ${err.message}`;
        this.emit("warn", msg);
        if (this.listenerCount("error") > 0) {
          this.emit("error", new Error(msg));
        }
      });

      ws.on("close", (code, reason) => {
        if (!this.running) return;
        this.emit(
          "status",
          `Solana RPC socket ${socketIndex} closed (${code}: ${reason}). Reconnecting in 3s...`,
        );
        const idx = this.sockets.indexOf(ws);
        if (idx !== -1) {
          this.sockets[idx] = null as any;
        }
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

    // Check if logs touch SPL token, Token-2022, pump.fun, raydium, jupiter, or transfers
    const hasSpl = logs.some(
      (l) =>
        l.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") ||
        l.includes("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") ||
        l.includes("Instruction: Transfer") ||
        l.includes("Instruction: TransferChecked") ||
        l.includes("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P") ||
        l.includes("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA") ||
        l.includes("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8") ||
        l.includes("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK") ||
        l.includes("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C") ||
        l.includes("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc") ||
        l.includes("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
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

      if (res.status === 429 && attempt <= 4) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        return this.resolveTransaction(wallet, signature, attempt + 1);
      }

      if (!res.ok) return;
      const body: any = await res.json();
      if (body.error && attempt <= 4) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        return this.resolveTransaction(wallet, signature, attempt + 1);
      }
      const tx = body.result;
      if ((!tx || !tx.meta) && attempt <= 4) {
        // Transaction may be processed but not yet indexed in RPC block store
        await new Promise((r) => setTimeout(r, 600 * attempt));
        return this.resolveTransaction(wallet, signature, attempt + 1);
      }
      if (!tx || !tx.meta) return;

    const blockTime = tx.blockTime ? tx.blockTime * 1000 : Date.now();
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    // Skip native SOL wrapped or common stablecoins
    const ignoredMints = new Set([
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
      "7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT",
      "USDH1SM1ojcxkgmunbKc98QmTXpnStephenbpTREg9Dh7",
    ]);

    // Find token balance changes for our monitored wallet
    const relevantMints = new Set<string>();
    preBalances.forEach((b: any) => {
      if (b.owner === wallet && b.mint && !ignoredMints.has(b.mint)) relevantMints.add(b.mint);
    });
    postBalances.forEach((b: any) => {
      if (b.owner === wallet && b.mint && !ignoredMints.has(b.mint)) relevantMints.add(b.mint);
    });

    // Check SOL spent / received for price estimation
    const accountKeys = tx.transaction?.message?.accountKeys || [];
    const walletIdx = accountKeys.findIndex((k: any) => (typeof k === "string" ? k : k.pubkey) === wallet);
    const preSolLamports = walletIdx !== -1 ? (tx.meta.preBalances?.[walletIdx] || 0) : 0;
    const postSolLamports = walletIdx !== -1 ? (tx.meta.postBalances?.[walletIdx] || 0) : 0;
    const solDiff = (postSolLamports - preSolLamports) / 1e9;

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

        let estimatedPriceUsd: number | undefined = undefined;
        if (solDiff < -0.001) {
          const solSpent = Math.abs(solDiff);
          estimatedPriceUsd = (solSpent * 150) / diff; // baseline SOL $150
        }

        const transferEvent: WalletTransferEvent = {
          wallet,
          mint,
          amount: diff.toString(),
          timestamp: Math.floor(blockTime / 1000),
          from: sender?.owner || "",
          tx: signature,
          priceUsd: estimatedPriceUsd,
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

  public isConnected(): boolean {
    return this.running && this.sockets.some((ws) => ws && ws.readyState === WebSocket.OPEN);
  }

  public getStatus() {
    return {
      running: this.running,
      totalSockets: this.sockets.length,
      activeSockets: this.sockets.filter((ws) => ws && ws.readyState === WebSocket.OPEN).length,
      subscriptions: this.subToWallet.size,
    };
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
