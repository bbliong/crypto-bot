import { randomUUID } from 'node:crypto';
import { buyKey, detailWalletSell, latestActivityBuy, sellAfterBuy, type WalletBuy } from './buy-sell-watch-activity.js';

export type CohortDetail = {
  id: string; mint: string; symbol?: string; openedAt: number;
  phase: 'opening' | 'tracking' | 'closing'; watchers: Map<string, WalletBuy>;
  closeReason?: string;
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
  constructor(readonly wallets: string[], readonly batchSize = 3) {
    if (!wallets.length || batchSize < 1 || !Number.isInteger(batchSize)) throw new Error('Batch tidak valid.');
  }
  next() {
    const round = this.round;
    const wallets = this.wallets.slice(this.index, this.index + this.batchSize);
    this.index += wallets.length;
    if (this.index >= this.wallets.length) { this.index = 0; this.round++; }
    return { wallets, round };
  }
}

export class Holder149Engine {
  readonly details = new Map<string, CohortDetail>();
  private consumed = new Map<string, { timestamp: number; keys: Set<string> }>();
  private opening = new Set<Promise<void>>();
  stopping = false;
  constructor(private hooks: DetailHooks, readonly maxDetails = 3, private now = Date.now) {}
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
    const buy = latestActivityBuy(body, wallet);
    if (!buy || !this.consume(buy) || sellAfterBuy(body, buy)) return;
    const shared = this.details.get(buy.mint);
    if (shared && shared.phase !== 'closing') {
      shared.watchers.set(wallet, buy);
      this.emit('WALLET_JOINED_DETAIL', { detailId: shared.id, mint: buy.mint, buy });
      return;
    }
    if (shared || this.details.size >= this.maxDetails) {
      this.emit('BUY_SKIPPED_CAPACITY', { wallet, mint: buy.mint });
      return; // consume now; no stale Buy queue when a slot later becomes free
    }
    const detail: CohortDetail = { id: randomUUID(), mint: buy.mint, symbol: buy.symbol,
      openedAt: this.now(), phase: 'opening', watchers: new Map([[wallet, buy]]) };
    // Reserve synchronously before any Playwright await, including newPage().
    this.details.set(buy.mint, detail);
    const task = this.open(detail);
    this.opening.add(task);
    void task.finally(() => this.opening.delete(task));
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
    this.emit('TRACKED_WALLET_SOLD', { detailId: detail.id, wallet, mint: detail.mint, buy, sell, source });
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
