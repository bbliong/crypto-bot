import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

export const captureChunkMilliseconds = 30 * 60 * 1000;
export const partitionedCaptureFiles = new Set([
  'websocket-frames.jsonl', 'token-trades.jsonl', 'api-responses.jsonl', 'buys.jsonl', 'sells.jsonl',
]);

export function captureBucket(observedAt: number): string {
  if (!Number.isFinite(observedAt) || observedAt < 0) throw new Error('Waktu capture tidak valid.');
  return new Date(Math.floor(observedAt / captureChunkMilliseconds) * captureChunkMilliseconds)
    .toISOString().replace(/[:.]/g, '-');
}

// Capture is partitioned by receipt time, not a transaction's historical timestamp.
// Keep control events in the run root for dashboard replay and legacy compatibility.
// Reuse append descriptors so a busy socket doesn't open/close a file every frame.
export class BuySellCaptureStorage {
  private handles = new Map<string, { path: string; fd: number }>();
  private closed = false;
  constructor(private run: string, private now: () => number = Date.now) {
    mkdirSync(run, { recursive: true });
  }
  write(name: string, value: unknown): void {
    if (this.closed) throw new Error('Penyimpanan capture sudah ditutup.');
    if (!/^[a-z][a-z0-9-]*\.jsonl$/.test(name)) throw new Error('Nama file capture tidak valid.');
    const observedAt = (value as { observedAt?: unknown } | null)?.observedAt;
    const directory = partitionedCaptureFiles.has(name)
      ? join(this.run, 'chunks', captureBucket(typeof observedAt === 'number' ? observedAt : this.now()))
      : this.run;
    const path = join(directory, name);
    let handle = this.handles.get(name);
    if (handle?.path !== path) {
      if (handle) { closeSync(handle.fd); this.handles.delete(name); }
      mkdirSync(directory, { recursive: true });
      handle = { path, fd: openSync(path, 'a') };
      this.handles.set(name, handle);
    }
    appendFileSync(handle.fd, JSON.stringify(value) + '\n', 'utf8');
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { for (const handle of this.handles.values()) closeSync(handle.fd); }
    finally { this.handles.clear(); }
  }
}
