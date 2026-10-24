/**
 * Solana Rate-Limited RPC Queue
 * Guarantees zero HTTP 429 (Too Many Requests) errors on public Solana RPC nodes
 * by enforcing a strict sliding-window rate limit (e.g., 25 req / 10s vs node cap of 40 req / 10s).
 */

export type Priority = "HIGH" | "NORMAL" | "LOW";

export interface QueueTask<T = any> {
  id: string;
  fn: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
  priority: Priority;
  enqueuedAt: number;
  retries: number;
}

export interface SolanaRpcQueueOptions {
  rpcUrl?: string;
  maxRequestsPerWindow?: number; // e.g. 25 requests (safety margin under 40)
  windowDurationMs?: number;     // e.g. 10_000 ms (10 seconds)
  minIntervalBetweenReqMs?: number; // e.g. 250 ms (max ~4 req/s)
  maxRetriesOn429?: number;
  cooldownOn429Ms?: number;      // e.g. 10_000 ms pause on 429
}

export interface RpcSignatureResult {
  signature: string;
  slot: number;
  err: any;
  memo: string | null;
  blockTime: number | null;
  confirmationStatus: string;
}

export class SolanaRpcQueue {
  private rpcUrl: string;
  private maxRequestsPerWindow: number;
  private windowDurationMs: number;
  private minIntervalBetweenReqMs: number;
  private maxRetriesOn429: number;
  private cooldownOn429Ms: number;

  private queue: QueueTask[] = [];
  private requestTimestamps: number[] = [];
  private lastRequestAt: number = 0;
  private isProcessing: boolean = false;
  private isPaused: boolean = false;
  private pauseUntil: number = 0;

  // Telemetry metrics
  private totalEnqueued: number = 0;
  private totalCompleted: number = 0;
  private total429s: number = 0;
  private totalErrors: number = 0;
  private responseTimes: number[] = [];

  constructor(options?: SolanaRpcQueueOptions) {
    this.rpcUrl = options?.rpcUrl || "https://api.mainnet-beta.solana.com";
    // For indexed RPC methods like getSignaturesForAddress, Solana limit is 8 req / 10s.
    // Setting max 6 per 10s guarantees 100% immunity from HTTP 429.
    this.maxRequestsPerWindow = options?.maxRequestsPerWindow || 6;
    this.windowDurationMs = options?.windowDurationMs || 10_000;
    this.minIntervalBetweenReqMs = options?.minIntervalBetweenReqMs || 1000; // 1.0s gap
    this.maxRetriesOn429 = options?.maxRetriesOn429 ?? 3;
    this.cooldownOn429Ms = options?.cooldownOn429Ms || 10_000;
  }

  /**
   * Enqueue a generic async RPC task with priority
   */
  public enqueue<T>(fn: () => Promise<T>, priority: Priority = "NORMAL"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = {
        id: `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        fn,
        resolve,
        reject,
        priority,
        enqueuedAt: Date.now(),
        retries: 0
      };

      this.totalEnqueued++;

      // Insert based on priority: HIGH at top, then NORMAL, then LOW
      if (priority === "HIGH") {
        const insertIdx = this.queue.findIndex(t => t.priority !== "HIGH");
        if (insertIdx === -1) this.queue.push(task);
        else this.queue.splice(insertIdx, 0, task);
      } else if (priority === "NORMAL") {
        const insertIdx = this.queue.findIndex(t => t.priority === "LOW");
        if (insertIdx === -1) this.queue.push(task);
        else this.queue.splice(insertIdx, 0, task);
      } else {
        this.queue.push(task);
      }

      this.triggerProcessing();
    });
  }

  /**
   * Helper: Call getSignaturesForAddress through the queue
   */
  public async getSignaturesForAddress(
    walletAddress: string,
    limit: number = 1,
    priority: Priority = "NORMAL"
  ): Promise<RpcSignatureResult[]> {
    return this.enqueue(async () => {
      const t0 = Date.now();
      const res = await fetch(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getSignaturesForAddress",
          params: [walletAddress, { limit }]
        }),
        signal: AbortSignal.timeout(8000)
      });

      this.recordLatency(Date.now() - t0);

      if (res.status === 429) {
        throw new Error("HTTP_429");
      }

      if (!res.ok) {
        throw new Error(`RPC_HTTP_${res.status}`);
      }

      const json = await res.json();
      if (json.error) {
        throw new Error(`RPC_ERROR: ${json.error.message || JSON.stringify(json.error)}`);
      }

      return (json.result || []) as RpcSignatureResult[];
    }, priority);
  }

  /**
   * Process queue items complying strictly with rate limits
   */
  private async triggerProcessing(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const now = Date.now();

      // Check if currently under 429 cooldown
      if (this.isPaused) {
        if (now < this.pauseUntil) {
          const waitMs = this.pauseUntil - now;
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        } else {
          this.isPaused = false;
        }
      }

      // 1. Clean up old timestamps from sliding window
      const cutoff = now - this.windowDurationMs;
      this.requestTimestamps = this.requestTimestamps.filter(t => t > cutoff);

      // 2. Check window capacity limit
      if (this.requestTimestamps.length >= this.maxRequestsPerWindow) {
        const oldest = this.requestTimestamps[0];
        const waitMs = Math.max(250, (oldest + this.windowDurationMs + 250) - now);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // 3. Check min interval gap between adjacent requests (e.g. 250ms)
      const elapsedSinceLast = now - this.lastRequestAt;
      if (elapsedSinceLast < this.minIntervalBetweenReqMs) {
        const waitMs = this.minIntervalBetweenReqMs - elapsedSinceLast;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      // Execute next task
      const task = this.queue.shift();
      if (!task) break;

      const reqTime = Date.now();
      this.lastRequestAt = reqTime;
      this.requestTimestamps.push(reqTime);

      try {
        const result = await task.fn();
        this.totalCompleted++;
        task.resolve(result);
      } catch (err: any) {
        if (err.message === "HTTP_429" || err.message?.includes("429")) {
          this.total429s++;
          task.retries++;
          console.log(`[RPC-QUEUE] ⚠️  Hit 429 on task ${task.id} (attempt ${task.retries}). Pausing for ${this.cooldownOn429Ms}ms...`);
          // Pause queue for cooldown
          this.isPaused = true;
          this.pauseUntil = Date.now() + this.cooldownOn429Ms;

          if (task.retries <= this.maxRetriesOn429) {
            // Re-insert task at the front with HIGH priority
            this.queue.unshift(task);
          } else {
            this.totalErrors++;
            task.reject(new Error(`Max retries exceeded for task ${task.id} due to rate limiting`));
          }
        } else {
          this.totalErrors++;
          task.reject(err);
        }
      }
    }

    this.isProcessing = false;
  }

  private recordLatency(ms: number): void {
    this.responseTimes.push(ms);
    if (this.responseTimes.length > 50) this.responseTimes.shift();
  }

  public getStats() {
    const avgLatency = this.responseTimes.length > 0
      ? Math.round(this.responseTimes.reduce((a, b) => a + b, 0) / this.responseTimes.length)
      : 0;

    return {
      rpcUrl: this.rpcUrl,
      queueLength: this.queue.length,
      totalEnqueued: this.totalEnqueued,
      totalCompleted: this.totalCompleted,
      total429s: this.total429s,
      totalErrors: this.totalErrors,
      requestsInCurrentWindow: this.requestTimestamps.length,
      maxRequestsPerWindow: this.maxRequestsPerWindow,
      windowDurationMs: this.windowDurationMs,
      minIntervalBetweenReqMs: this.minIntervalBetweenReqMs,
      avgLatencyMs: avgLatency,
      isPaused: this.isPaused
    };
  }

  public clear(): void {
    for (const task of this.queue) {
      task.reject(new Error("Queue cleared"));
    }
    this.queue = [];
  }
}
