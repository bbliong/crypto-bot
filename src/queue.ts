export class CandidateQueue {
  private pending = new Map<string, number>();
  private active = new Set<string>();
  constructor(private capacity: number, private ttlMs: number, private newestFirst = true) {}
  push(mint: string, now = Date.now()): 'queued' | 'duplicate' | 'full' {
    this.prune(now);
    if (this.pending.has(mint) || this.active.has(mint)) return 'duplicate';
    if (this.pending.size >= this.capacity) return 'full';
    this.pending.set(mint, now); return 'queued';
  }
  take(now = Date.now()): string | undefined {
    this.prune(now);
    // Most collectors favor the freshest eligible token. Lane comparisons use
    // FIFO instead, so every lane receives the same screened cohort in order.
    const mint = this.newestFirst ? [...this.pending.keys()].at(-1) : this.pending.keys().next().value as string | undefined;
    if (mint) { this.pending.delete(mint); this.active.add(mint); }
    return mint;
  }
  done(mint: string) { this.active.delete(mint); }
  remove(mint: string): boolean {
    const deleted = this.pending.delete(mint);
    this.active.delete(mint);
    return deleted;
  }
  getPendingMints(now = Date.now()): string[] {
    this.prune(now);
    return [...this.pending.keys()].reverse();
  }
  getPendingCount(now = Date.now()): number {
    this.prune(now);
    return this.pending.size;
  }
  private prune(now: number) {
    for (const [mint, time] of this.pending) if (now - time > this.ttlMs) this.pending.delete(mint);
  }
}
