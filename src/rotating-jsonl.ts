import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const LOG_CHUNK_MS = 30 * 60 * 1000;
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

export class RotatingJsonlWriter {
  private bucket: number | undefined;
  private directory: string | undefined;
  private readonly handles = new Map<string, number>();

  constructor(private readonly runDirectory: string, private readonly clock: () => number = Date.now) {}

  write(name: string, value: unknown) {
    if (!/^[a-z0-9-]+\.jsonl$/.test(name)) throw new Error('Invalid log filename.');
    // Partition by receipt/write time, preserving observedAt inside each record.
    const bucket = Math.max(this.bucket ?? -Infinity, Math.floor(this.clock() / LOG_CHUNK_MS) * LOG_CHUNK_MS);
    if (bucket !== this.bucket) {
      this.close();
      const label = new Date(bucket + WIB_OFFSET_MS).toISOString().replace(/[:.]/g, '-').replace('Z', '-WIB');
      this.directory = join(this.runDirectory, 'chunks', label);
      mkdirSync(this.directory, { recursive: true });
      writeFileSync(join(this.directory, 'chunk.json'), JSON.stringify({
        startUtc: new Date(bucket).toISOString(), endUtc: new Date(bucket + LOG_CHUNK_MS).toISOString(),
        timezone: 'Asia/Jakarta', minutes: 30,
      }, null, 2));
      this.bucket = bucket;
    }
    let handle = this.handles.get(name);
    if (handle === undefined) {
      handle = openSync(join(this.directory!, name), 'a');
      this.handles.set(name, handle);
    }
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(handle, bytes, offset, bytes.length - offset);
  }

  close() {
    for (const handle of this.handles.values()) {
      try { fsyncSync(handle); } finally { closeSync(handle); }
    }
    this.handles.clear();
  }
}
