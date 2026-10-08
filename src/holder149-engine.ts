import { randomUUID } from 'node:crypto';
import { buyKey, detailWalletSell, latestActivityBuy, sellAfterBuy, walletOpenPositions, type WalletBuy } from './buy-sell-watch-activity.js';

export type SlotType = 'fresh' | 'holding';

export type CohortDetail = {
  id: string; mint: string; symbol?: string; openedAt: number;
  phase: 'opening' | 'tracking' | 'closing'; watchers: Map<string, WalletBuy>;
  closeReason?: string;
  slotType?: SlotType;
};
export type CohortEvent = { type: string; observedAt: number; [key: string]: unknown };
export type DetailHooks = {
  open: (detail: CohortDetail) => Promise<void>;
  close: (detail: CohortDetail) => Promise<void>;
  ready?: (detail: CohortDetail) => void;
  event: (event: CohortEvent) => void;
};

// The final batch is short. Never repeat the first wallet in the same round.
export class CohortCursor {
  index = 0;
  round = 1;
  priorityQueue: string[] = [];
  constructor(readonly wallets: string[], readonly batchSize = 3) {
    if (!wallets.length || batchSize < 1 || !Number.isInteger(batchSize)) throw new Error('Batch tidak valid.');
  }
  next() {
    if (this.priorityQueue.length > 0) {
      const wallets = this.priorityQueue.splice(0, this.batchSize);
      return { wallets, round: this.round, isPriority: true };
    }
    const round = this.round;
    const wallets = this.wallets.slice(this.index, this.index + this.batchSize);
    this.index += wallets.length;
    if (this.index >= this.wallets.length) { this.index = 0; this.round++; }
    return { wallets, round, isPriority: false };
  }
  injectPriority(wallets: string[]) {
    for (const w of wallets) {
      if (!this.priorityQueue.includes(w)) this.priorityQueue.push(w);
    }
  }
}

export class Holder149Engine {
  readonly details = new Map<string, CohortDetail>();
  private consumed = new Map<string, { timestamp: number; keys: Set<string> }>();
  private opening = new Set<Promise<void>>();
  stopping = false;
  constructor(
    private hooks: DetailHooks,
    readonly maxDetails = 3,
    private now = Date.now,
    private getWalletScore?: (wallet: string) => number,
    readonly maxBuyAgeSeconds?: number // Only open details for buys < maxBuyAgeSeconds old (e.g. 600s / 10m)
  ) {}
  private emit(type: string, extra: Record<string, unknown>) { this.hooks.event({ type, observedAt: this.now(), ...extra }); }
  private consume(buy: WalletBuy): boolean {
    const previous = this.consumed.get(buy.wallet), key = buyKey(buy);
    if (previous && (buy.timestamp < previous.timestamp || previous.keys.has(key))) return false;
    const keys = previous?.timestamp === buy.timestamp ? previous.keys : new Set<string>();
    keys.add(key);
    this.consumed.set(buy.wallet, { timestamp: buy.timestamp, keys });
    return true;
  }
  async activity(wallet: string, body: unknown): Promise<void> {
    if (this.stopping) return;
    // Also check a watched mint when the newest activity belongs to another mint.
    for (const detail of [...this.details.values()]) {
      const buy = detail.watchers.get(wallet);
      const sell = buy && sellAfterBuy(body, buy);
      if (sell) await this.sold(detail, wallet, sell, 'wallet_activity_poll');
    }
    if (this.stopping) return;
    if (this.stopping) return;

    const nowSec = Math.floor(this.now() / 1000);
    const latestBuy = latestActivityBuy(body, wallet);
    const candidateScore = this.getWalletScore ? this.getWalletScore(wallet) : 0;

    // Check if this latest buy is a "Fresh" buy (< maxBuyAgeSeconds old, e.g. 10m)
    let isFreshBuy = false;
    if (latestBuy && !sellAfterBuy(body, latestBuy)) {
      const buyAge = Math.max(0, nowSec - latestBuy.timestamp);
      if (this.maxBuyAgeSeconds === undefined || buyAge <= this.maxBuyAgeSeconds) {
        isFreshBuy = true;
      }
    }

    if (isFreshBuy && latestBuy && this.consume(latestBuy)) {
      // Slot 1 (Fresh candidate):
      const shared = this.details.get(latestBuy.mint);
      if (shared && shared.phase !== 'closing') {
        shared.watchers.set(wallet, latestBuy);
        this.emit('WALLET_JOINED_DETAIL', { detailId: shared.id, mint: latestBuy.mint, buy: latestBuy });
        return;
      }
      if (shared) return;

      // Determine fresh slot quota:
      // If splitSlots is enabled (when maxDetails === 2 and maxBuyAgeSeconds is configured),
      // reserve 1 slot for fresh and 1 for holding. Otherwise allow up to maxDetails.
      const freshDetails = [...this.details.values()].filter(d => (d.slotType ?? 'fresh') === 'fresh');
      const maxFreshSlots = (this.maxDetails === 2 && (this.maxBuyAgeSeconds ?? 0) > 0) ? 1 : this.maxDetails;

      if (freshDetails.length >= maxFreshSlots) {
        // Can preempt lower-scoring fresh detail
        let lowestDetail: CohortDetail | null = null;
        let lowestScore = Infinity;
        for (const d of freshDetails) {
          if (d.phase !== 'tracking') continue;
          let maxSc = -Infinity;
          for (const w of d.watchers.keys()) {
            const sc = this.getWalletScore ? this.getWalletScore(w) : 0;
            if (sc > maxSc) maxSc = sc;
          }
          if (maxSc < lowestScore) {
            lowestScore = maxSc;
            lowestDetail = d;
          }
        }

        if (lowestDetail && candidateScore > lowestScore && (candidateScore > 50 || lowestScore <= 0)) {
          this.emit('DETAIL_PREEMPTED_FOR_SMART_MONEY', {
            preemptedMint: lowestDetail.mint,
            preemptedScore: lowestScore,
            incomingWallet: wallet,
            incomingScore: candidateScore,
            slotType: 'fresh'
          });
          await this.close(lowestDetail, 'preempted_by_higher_profit_fresh');
        } else {
          this.emit('BUY_SKIPPED_CAPACITY', { wallet, mint: latestBuy.mint, reason: 'fresh_slot_full' });
          return;
        }
      }

      if (this.details.size >= this.maxDetails) {
        this.emit('BUY_SKIPPED_CAPACITY', { wallet, mint: latestBuy.mint });
        return;
      }

      const detail: CohortDetail = {
        id: randomUUID(),
        mint: latestBuy.mint,
        symbol: latestBuy.symbol,
        openedAt: this.now(),
        phase: 'opening',
        watchers: new Map([[wallet, latestBuy]]),
        slotType: 'fresh'
      };
      this.details.set(latestBuy.mint, detail);
      const task = this.open(detail);
      this.opening.add(task);
      void task.finally(() => this.opening.delete(task));
      return;
    }

    // Slot 2: Holding Bag (Token already bought, not yet sold, prioritized by Smart Money / highest profit)
    // Only consider holding candidates from highly profitable wallets or Smart Money (score > 50 or positive profit)
    const holdingDetails = [...this.details.values()].filter(d => d.slotType === 'holding');
    const maxHoldingSlots = Math.max(1, this.maxDetails - 1); // 1 slot dedicated to holding

    if (candidateScore > 50 || candidateScore > 0) {
      const openPositions = walletOpenPositions(body, wallet);
      if (openPositions.length > 0) {
        const topBag = openPositions[0]; // Newest open bag
        const shared = this.details.get(topBag.mint);
        if (shared && shared.phase !== 'closing') {
          shared.watchers.set(wallet, topBag);
          return;
        }
        if (!shared && !this.details.has(topBag.mint)) {
          if (holdingDetails.length >= maxHoldingSlots) {
            let lowestHolding: CohortDetail | null = null;
            let lowestScore = Infinity;
            for (const d of holdingDetails) {
              if (d.phase !== 'tracking') continue;
              let maxSc = -Infinity;
              for (const w of d.watchers.keys()) {
                const sc = this.getWalletScore ? this.getWalletScore(w) : 0;
                if (sc > maxSc) maxSc = sc;
              }
              if (maxSc < lowestScore) {
                lowestScore = maxSc;
                lowestHolding = d;
              }
            }

            if (lowestHolding && candidateScore > lowestScore && (candidateScore > 50 || lowestScore <= 0)) {
              this.emit('DETAIL_PREEMPTED_FOR_SMART_MONEY', {
                preemptedMint: lowestHolding.mint,
                preemptedScore: lowestScore,
                incomingWallet: wallet,
                incomingScore: candidateScore,
                slotType: 'holding'
              });
              await this.close(lowestHolding, 'preempted_by_higher_profit_holding');
            }
          }

          const currentHoldings = [...this.details.values()].filter(d => d.slotType === 'holding');
          if (currentHoldings.length < maxHoldingSlots && this.details.size < this.maxDetails && this.consume(topBag)) {
            const detail: CohortDetail = {
              id: randomUUID(),
              mint: topBag.mint,
              symbol: topBag.symbol,
              openedAt: this.now(),
              phase: 'opening',
              watchers: new Map([[wallet, topBag]]),
              slotType: 'holding'
            };
            this.details.set(topBag.mint, detail);
            const task = this.open(detail);
            this.opening.add(task);
            void task.finally(() => this.opening.delete(task));
          }
        }
      }
    }
  }
  private async open(detail: CohortDetail) {
    try {
      await this.hooks.open(detail);
      if (this.details.get(detail.mint) !== detail || detail.phase === 'closing') return;
      detail.phase = 'tracking';
      this.emit('TOKEN_DETAIL_OPENED', { detailId: detail.id, mint: detail.mint, symbol: detail.symbol });
      this.hooks.ready?.(detail);
    } catch (error) {
      this.emit('DETAIL_OPEN_FAILED', { detailId: detail.id, mint: detail.mint, error: String(error) });
      await this.close(detail, 'open_failed');
    }
  }
  async socket(detail: CohortDetail, body: unknown): Promise<void> {
    if (this.details.get(detail.mint) !== detail || detail.phase === 'closing') return;
    for (const [wallet, buy] of [...detail.watchers]) {
      const sell = detailWalletSell(body, buy);
      if (sell) await this.sold(detail, wallet, sell, 'token_detail_websocket');
    }
  }
  private async sold(detail: CohortDetail, wallet: string, sell: Record<string, unknown>, source: string) {
    const buy = detail.watchers.get(wallet);
    if (!buy || detail.phase === 'closing') return;
    detail.watchers.delete(wallet); // duplicate frames cannot close twice
    const sellPrice = Number(sell.price_usd ?? sell.pu) || 0;
    const buyPrice = buy.priceUsd || 0;
    const pnlPercent = buyPrice > 0 && sellPrice > 0 ? ((sellPrice - buyPrice) / buyPrice) * 100 : undefined;
    const sellTs = Number(sell.timestamp ?? sell.t) || Math.floor(Date.now() / 1000);
    const holdDurationSeconds = Math.max(0, sellTs - buy.timestamp);
    this.emit('TRACKED_WALLET_SOLD', {
      detailId: detail.id, wallet, mint: detail.mint, buy, sell, source,
      buyPriceUsd: buyPrice || undefined,
      sellPriceUsd: sellPrice || undefined,
      pnlPercent: pnlPercent !== undefined ? Number(pnlPercent.toFixed(2)) : undefined,
      holdDurationSeconds
    });
    if (!detail.watchers.size) await this.close(detail, 'wallet_sold');
  }
  async close(detail: CohortDetail, reason: string) {
    if (this.details.get(detail.mint) !== detail || detail.phase === 'closing') return;
    detail.phase = 'closing';
    detail.closeReason = reason;
    try { await this.hooks.close(detail); }
    catch (error) {
      this.emit('DETAIL_CLOSE_FAILED', { mint: detail.mint, error: String(error) });
      return; // retain the occupied slot if the physical tab could not be closed
    }
    if (this.details.get(detail.mint) !== detail) return;
    this.details.delete(detail.mint);
    this.emit('TOKEN_DETAIL_CLOSED', { detailId: detail.id, mint: detail.mint, reason });
  }
  pageClosed(detail: CohortDetail) {
    if (this.details.get(detail.mint) !== detail) return;
    this.details.delete(detail.mint);
    this.emit('TOKEN_DETAIL_CLOSED', { detailId: detail.id, mint: detail.mint, reason: detail.closeReason ?? 'page_closed' });
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled(this.opening);
    await Promise.all([...this.details.values()].map(detail => this.close(detail, 'worker_stopped')));
  }
  snapshot() {
    return [...this.details.values()].map(detail => ({ ...detail, watchers: [...detail.watchers.values()] }));
  }
}
