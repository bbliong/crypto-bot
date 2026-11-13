import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TickEnvelope } from './follower-tick-schema.js';

export interface RecorderStats {
  received: number; enqueued: number; written: number; dropped: number;
  writeUncertain: number; coverageGaps: number; queueRecords: number; queueBytes: number; lastError: string | null;
}
export interface RecorderOptions {
  outputDir: string; sessionId: string;
  maxQueueRecords?: number; maxQueueBytes?: number; maxChunkBytes?: number;
  flushIntervalMs?: number; manifestIntervalMs?: number; closeTimeoutMs?: number;
  writeLine?: (path: string, data: string) => Promise<void>;
}
type QueueItem = { name: string; receivedAt: number; data: string; bytes: number };
const names: Record<string,string> = {
  token_activity:'token-activity.jsonl', token_stat:'token-stat.jsonl',
  wallet_activity_info:'wallet-activity.jsonl', lifecycle:'lifecycle.jsonl',
  decisions:'decisions.jsonl',
};
export class FollowerTickRecorder {
  private readonly dir: string;
  private readonly opts: RecorderOptions;
  private queue: QueueItem[] = [];
  private busy = false;
  private closed = false;
  private closeTimedOut = false;
  private waiters: Array<() => void> = [];
  private bucket = -1;
  private part = 0;
  private chunkBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private manifestTimer: NodeJS.Timeout;
  private manifestWrite: Promise<void> = Promise.resolve();
  private counters: RecorderStats = {received:0,enqueued:0,written:0,dropped:0,writeUncertain:0,coverageGaps:0,queueRecords:0,queueBytes:0,lastError:null};
  constructor(options: RecorderOptions) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.sessionId)) throw new Error('Invalid session ID');
    this.opts=options;
    this.dir=join(options.outputDir,options.sessionId);
    this.manifestTimer=setInterval(()=>{void this.persistManifest('OPEN');},options.manifestIntervalMs ?? 5000);
    this.manifestTimer.unref();
    if (options.flushIntervalMs) {
      this.timer=setInterval(()=>this.kick(),options.flushIntervalMs);
      this.timer.unref();
    }
  }
  stats(): RecorderStats { return {...this.counters}; }
  record(value: TickEnvelope): boolean { return this.push(value.channel,value.receivedAt,value); }
  decision(event: Record<string,unknown>): boolean {
    const safe=(value: unknown): string | null => typeof value==='string' && value.length<=160 && /^[A-Za-z0-9_ .:+%$-]+$/.test(value) ? value : null;
    const safeReason=(value: unknown): string | null => typeof value==='string' && value.length<=240 &&
      /^[A-Za-z0-9_ .:+%$()><=|\-]+$/.test(value) &&
      !/(?:api[_-]?key|password|secret|token|cookie|authorization|bearer)\s*[:=]/i.test(value) ? value : null;
    const numeric=(value: unknown): number | null => typeof value==='number' && Number.isFinite(value) ? value : null;
    const amount=(value: unknown): string | null => typeof value==='string' && /^\d{1,80}$/.test(value) ? value : null;
    const decimals=(value: unknown): number | null => Number.isInteger(value) && (value as number)>=0 && (value as number)<=18 ? value as number : null;
    const at=numeric(event.observedAt) ?? Date.now();
    return this.push('decisions',at,{
      schemaVersion:1,sessionId:this.opts.sessionId,source:'follower_decision',
      kind:safe(event.kind),actionId:safe(event.actionId),scenarioId:safe(event.scenarioId),
      mint:safe(event.mint),side:safe(event.side),reason:safeReason(event.reason) ?? '[REDACTED]',
      positionId:safe(event.positionId),originFrame:null,observedAt:at,
      ok:typeof event.ok==='boolean' ? event.ok : null,
      status:numeric(event.status) ?? safe(event.status),priceUsd:numeric(event.priceUsd),
      orderId:safe(event.orderId),hash:safe(event.hash),exchange:safe(event.exchange),
      inAmountBaseUnits:amount(event.inAmountBaseUnits),outAmountBaseUnits:amount(event.outAmountBaseUnits),
      inDecimals:decimals(event.inDecimals),outDecimals:decimals(event.outDecimals),
      amountInUsd:numeric(event.amountInUsd),amountOutUsd:numeric(event.amountOutUsd),
      priceImpactPct:numeric(event.priceImpactPct),reclaimedSol:numeric(event.reclaimedSol),
      probeIndex:numeric(event.probeIndex),
    });
  }
  lifecycle(event: Record<string,unknown>): boolean {
    return this.push('lifecycle',Date.now(),{schemaVersion:1,source:'follower_capture_lifecycle',sessionId:this.opts.sessionId,...event});
  }
  coverageGap(reason: string, detail: Record<string,unknown> = {}): void {
    this.counters.coverageGaps++;
    this.lifecycle({event:'subscription_coverage_unverified',at:Date.now(),reason,...detail});
  }
  private push(channel: string, at: number, value: unknown): boolean {
    this.counters.received++;
    try {
      const data=JSON.stringify(value)+'\n';
      const bytes=Buffer.byteLength(data);
      if (!names[channel] || this.closed || bytes > (this.opts.maxQueueBytes ?? 32*1024*1024) ||
          this.counters.queueRecords >= (this.opts.maxQueueRecords ?? 20000) ||
          this.counters.queueBytes + bytes > (this.opts.maxQueueBytes ?? 32*1024*1024)) {
        this.counters.dropped++; return false;
      }
      this.queue.push({name:names[channel],receivedAt:at,data,bytes});
      this.counters.enqueued++;
      this.counters.queueRecords++;
      this.counters.queueBytes+=bytes;
      this.kick();
      return true;
    } catch (err) {
      this.counters.dropped++;
      this.counters.lastError=String(err);
      return false;
    }
  }
  private kick(): void {
    if (!this.busy && this.queue.length) {
      this.busy=true;
      void this.drain();
    }
  }
  private async drain(): Promise<void> {
    while (this.queue.length) {
      const item=this.queue.shift()!;
      try {
        const bucket=Math.floor(item.receivedAt / 1800000)*1800000;
        if (bucket !== this.bucket) { this.bucket=bucket;this.part=0;this.chunkBytes=0; }
        if (this.chunkBytes && this.chunkBytes+item.bytes > (this.opts.maxChunkBytes ?? 64*1024*1024)) {this.part++;this.chunkBytes=0;}
        const chunk=join(this.dir,`${new Date(bucket).toISOString().replace(/[:.]/g,'-')}-${this.part}`);
        await mkdir(chunk,{recursive:true});
        const filepath=join(chunk,item.name);
        await (this.opts.writeLine ?? appendFile)(filepath,item.data);
        this.chunkBytes+=item.bytes;
        this.counters.written++;
      } catch (err) {
        this.counters.writeUncertain++;
        this.counters.lastError=String(err);
        if (this.counters.writeUncertain===1 || this.counters.writeUncertain%100===0) console.warn('[FOLLOWER-TICK-RECORDER] write failed:',String(err));
      } finally {
        this.counters.queueRecords--;
        this.counters.queueBytes-=item.bytes;
      }
    }
    this.busy=false;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  async flush(): Promise<void> {
    if (this.busy || this.queue.length) await new Promise<void>(resolve=>this.waiters.push(resolve));
    await this.persistManifest(this.closed ? 'CLOSED' : 'OPEN');
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed=true;
    if (this.timer) clearInterval(this.timer);
    clearInterval(this.manifestTimer);
    let timeout: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      this.busy || this.queue.length ? new Promise<'done'>(resolve=>this.waiters.push(()=>resolve('done'))) : Promise.resolve('done' as const),
      new Promise<'timeout'>(resolve=>{timeout=setTimeout(()=>resolve('timeout'),this.opts.closeTimeoutMs ?? 5000);}),
    ]);
    if (timeout) clearTimeout(timeout);
    if (result==='timeout') {
      this.closeTimedOut=true;
      this.counters.writeUncertain+=this.counters.queueRecords;
      this.counters.lastError='shutdown flush timeout';
    }
    await this.persistManifest('CLOSED');
  }
  private async persistManifest(status: 'OPEN'|'CLOSED'): Promise<void> {
    this.manifestWrite=this.manifestWrite.then(async () => {
    const actualStatus=this.closeTimedOut || this.counters.coverageGaps || this.counters.dropped || this.counters.writeUncertain ? 'INCOMPLETE' : status;
    try {
      await mkdir(this.dir,{recursive:true});
      const tmp=join(this.dir,`manifest.${process.pid}.tmp`);
      await writeFile(tmp,JSON.stringify({schemaVersion:1,sessionId:this.opts.sessionId,status:actualStatus,stats:this.stats(),updatedAt:Date.now(),durability:'async append; no per-record fsync; crash may lose buffered records'},null,2));
      await rename(tmp,join(this.dir,'manifest.json'));
    } catch (err) {
      this.counters.lastError=String(err);
      console.warn('[FOLLOWER-TICK-RECORDER] manifest failed:',String(err));
    }
    });
    await this.manifestWrite;
  }
}
