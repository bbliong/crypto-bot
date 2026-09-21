import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Candidate, Report } from './model.js';
import type { CaptureEvent } from './capture.js';
import { PARSER_VERSION } from './parser.js';
import type { TokenActivity } from './activity.js';
export class Store {
  db: DatabaseSync;
  constructor(path = 'data/monitor.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS candidates(mint TEXT PRIMARY KEY, first_seen INTEGER NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY, mint TEXT, observed_at INTEGER, body TEXT);
      CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY, mint TEXT, signal_at INTEGER, status TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS schemas(hash TEXT PRIMARY KEY, channel TEXT, direction TEXT, count INTEGER, first_seen INTEGER, last_seen INTEGER, body TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, observed_at INTEGER, kind TEXT, body TEXT);
      CREATE TABLE IF NOT EXISTS checkpoints(mint TEXT, threshold INTEGER, observed_at INTEGER, body TEXT, PRIMARY KEY(mint, threshold));
      CREATE TABLE IF NOT EXISTS token_activity(id INTEGER PRIMARY KEY, mint TEXT NOT NULL, side TEXT NOT NULL, occurred_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, price_usd REAL, amount REAL, actor_hash TEXT, actor_address TEXT);
      CREATE INDEX IF NOT EXISTS observations_mint_time ON observations(mint, observed_at);
      CREATE INDEX IF NOT EXISTS token_activity_mint_time ON token_activity(mint, occurred_at DESC);
    `);
    const activityColumns = this.db.prepare('PRAGMA table_info(token_activity)').all() as Array<{ name: string }>;
    if (!activityColumns.some(column => column.name === 'actor_hash')) this.db.exec('ALTER TABLE token_activity ADD COLUMN actor_hash TEXT');
    if (!activityColumns.some(column => column.name === 'actor_address')) this.db.exec('ALTER TABLE token_activity ADD COLUMN actor_address TEXT');
  }
  get(mint: string): Candidate | undefined {
    const row = this.db.prepare('SELECT body FROM candidates WHERE mint=?').get(mint);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  merge(update: Candidate): Candidate {
    const previous = this.get(update.mint);
    const merged: Candidate = previous ?? { mint: update.mint, firstSeenAt: update.firstSeenAt, updatedAt: update.updatedAt, fields: {} };
    merged.updatedAt = Math.max(merged.updatedAt, update.updatedAt);
    if (update.metadata) merged.metadata = { ...merged.metadata, ...update.metadata };
    for (const [key, invalidation] of Object.entries(update.invalidatedFields ?? {})) {
      const fieldKey = key as keyof Candidate['fields'];
      const old = merged.fields[fieldKey];
      const priorInvalidation = merged.invalidatedFields?.[fieldKey];
      if ((!old || invalidation.observedAt >= old.observedAt) &&
          (!priorInvalidation || invalidation.observedAt >= priorInvalidation.observedAt)) {
        (merged.invalidatedFields ??= {})[fieldKey] = invalidation;
        delete merged.fields[fieldKey];
      }
    }
    for (const [key, field] of Object.entries(update.fields)) {
      const fieldKey = key as keyof Candidate['fields'];
      const old = merged.fields[fieldKey];
      const invalidation = merged.invalidatedFields?.[fieldKey];
      if ((!old || field.observedAt >= old.observedAt) && (!invalidation || field.observedAt > invalidation.observedAt)) {
        merged.fields[fieldKey] = field;
        if (merged.invalidatedFields) delete merged.invalidatedFields[fieldKey];
      }
    }
    const body = JSON.stringify(merged);
    this.db.prepare('INSERT INTO candidates VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET updated_at=excluded.updated_at,body=excluded.body')
      .run(merged.mint, merged.firstSeenAt, merged.updatedAt, body);
    this.db.prepare('INSERT INTO observations(mint,observed_at,body) VALUES(?,?,?)').run(merged.mint, update.updatedAt, JSON.stringify(update));
    const holders = merged.fields.holders;
    if (holders && typeof holders.value === 'number') {
      for (const threshold of [25, 50, 75, 100]) if (holders.value >= threshold) {
        this.db.prepare('INSERT OR IGNORE INTO checkpoints VALUES(?,?,?,?)').run(merged.mint, threshold, holders.observedAt, body);
      }
    }
    return merged;
  }
  report(r: Report) {
    this.db.prepare('INSERT INTO reports(mint,signal_at,status,body) VALUES(?,?,?,?)').run(r.mint, r.signalAt, r.status, JSON.stringify(r));
  }
  activity(activity: TokenActivity) {
    this.db.prepare('INSERT INTO token_activity(mint,side,occurred_at,observed_at,price_usd,amount,actor_hash,actor_address) VALUES(?,?,?,?,?,?,?,?)')
      .run(activity.mint, activity.side, activity.occurredAt, activity.observedAt, activity.priceUsd ?? null, activity.amount ?? null, activity.actorHash ?? null, activity.actorAddress ?? null);
  }
  capture(event: CaptureEvent) {
    if (event.kind !== 'frame') { this.event(event.kind, event); return; }
    const body = JSON.stringify({ ...event.schema, parserVersion: PARSER_VERSION, source: event.source });
    const hash = createHash('sha256').update(`${event.direction}:${body}`).digest('hex');
    this.db.prepare(`INSERT INTO schemas VALUES(?,?,?,1,?,?,?) ON CONFLICT(hash) DO UPDATE SET count=count+1,last_seen=excluded.last_seen`)
      .run(hash, event.schema?.channel ?? 'unknown', event.direction ?? '', event.observedAt, event.observedAt, body);
  }
  event(kind: string, body: unknown) {
    this.db.prepare('INSERT INTO events(observed_at,kind,body) VALUES(?,?,?)').run(Date.now(), kind, JSON.stringify(body));
  }
  schemas() { return this.db.prepare('SELECT channel,direction,count,body FROM schemas ORDER BY count DESC').all(); }
  close() { this.db.close(); }
}
