import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type ResearchTrackedHolder = {
  mint: string;
  wallet: string;
  observedAt: number;
  amountPercentage: number | null;
  amount: number | null;
  isDev: boolean;
  devEvidence: string[];
  walletTagV2?: string;
  raw: Record<string, string | number | boolean | null>;
};

export type HolderObservationSource = 'network_intercept' | 'replayed_xhr';

export type ResearchSocketHolder = {
  wallet: string;
  raw: Record<string, string | number | boolean | null>;
};

type LatestSnapshot = { snapshot_hash: string; snapshot_id: number };

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + stableJson(record[key])).join(',') + '}';
}

function snapshotHash(holders: ResearchTrackedHolder[] | ResearchSocketHolder[]): string {
  const normalized = holders
    .map(holder => {
      const { observedAt: _observedAt, ...stored } = holder as ResearchTrackedHolder;
      return stored;
    })
    .sort((left, right) => left.wallet.localeCompare(right.wallet));
  return createHash('sha256').update(stableJson(normalized)).digest('hex');
}

/**
 * Per-run persistence for the high-volume GMGN holder endpoint. Every response
 * remains auditable in holder_api_observations, while the complete holder rows
 * are saved only when their contents change for a mint.
 */
export class ResearchHolderStore {
  private readonly db: DatabaseSync;
  private readonly latest;
  private readonly insertSnapshot;
  private readonly insertObservation;
  private readonly insertBalance;
  private readonly upsertLatest;
  private readonly latestSocket;
  private readonly insertSocketSnapshot;
  private readonly insertSocketObservation;
  private readonly insertSocketBalance;
  private readonly upsertLatestSocket;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS holder_snapshots(
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        holder_count INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS holder_balances(
        snapshot_id INTEGER NOT NULL REFERENCES holder_snapshots(id),
        wallet TEXT NOT NULL,
        amount_percentage REAL,
        amount REAL,
        is_dev INTEGER NOT NULL,
        dev_evidence TEXT NOT NULL,
        wallet_tag_v2 TEXT,
        raw TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS holder_api_observations(
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        status INTEGER NOT NULL,
        source TEXT NOT NULL,
        holder_count INTEGER NOT NULL,
        snapshot_hash TEXT,
        changed INTEGER NOT NULL,
        full_snapshot_id INTEGER REFERENCES holder_snapshots(id)
      );
      CREATE TABLE IF NOT EXISTS holder_latest(
        mint TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL,
        snapshot_id INTEGER NOT NULL REFERENCES holder_snapshots(id),
        observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS socket_holder_snapshots(
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        holder_count INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS socket_holder_balances(
        snapshot_id INTEGER NOT NULL REFERENCES socket_holder_snapshots(id),
        wallet TEXT NOT NULL,
        raw TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, wallet)
      );
      CREATE TABLE IF NOT EXISTS socket_holder_observations(
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        observed_at INTEGER NOT NULL,
        holder_count INTEGER NOT NULL,
        snapshot_hash TEXT NOT NULL,
        changed INTEGER NOT NULL,
        full_snapshot_id INTEGER REFERENCES socket_holder_snapshots(id)
      );
      CREATE TABLE IF NOT EXISTS socket_holder_latest(
        mint TEXT PRIMARY KEY,
        snapshot_hash TEXT NOT NULL,
        snapshot_id INTEGER NOT NULL REFERENCES socket_holder_snapshots(id),
        observed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS holder_api_observations_mint_time
        ON holder_api_observations(mint, observed_at DESC);
      CREATE INDEX IF NOT EXISTS holder_snapshots_mint_time
        ON holder_snapshots(mint, observed_at DESC);
      CREATE INDEX IF NOT EXISTS holder_balances_wallet
        ON holder_balances(wallet);
      CREATE INDEX IF NOT EXISTS socket_holder_observations_mint_time
        ON socket_holder_observations(mint, observed_at DESC);
    `);
    this.latest = this.db.prepare('SELECT snapshot_hash, snapshot_id FROM holder_latest WHERE mint=?');
    this.insertSnapshot = this.db.prepare('INSERT INTO holder_snapshots(mint,observed_at,holder_count,snapshot_hash) VALUES(?,?,?,?) RETURNING id');
    this.insertObservation = this.db.prepare('INSERT INTO holder_api_observations(mint,observed_at,status,source,holder_count,snapshot_hash,changed,full_snapshot_id) VALUES(?,?,?,?,?,?,?,?)');
    this.insertBalance = this.db.prepare('INSERT INTO holder_balances(snapshot_id,wallet,amount_percentage,amount,is_dev,dev_evidence,wallet_tag_v2,raw) VALUES(?,?,?,?,?,?,?,?)');
    this.upsertLatest = this.db.prepare('INSERT INTO holder_latest(mint,snapshot_hash,snapshot_id,observed_at) VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,snapshot_id=excluded.snapshot_id,observed_at=excluded.observed_at');
    this.latestSocket = this.db.prepare('SELECT snapshot_hash, snapshot_id FROM socket_holder_latest WHERE mint=?');
    this.insertSocketSnapshot = this.db.prepare('INSERT INTO socket_holder_snapshots(mint,observed_at,holder_count,snapshot_hash) VALUES(?,?,?,?) RETURNING id');
    this.insertSocketObservation = this.db.prepare('INSERT INTO socket_holder_observations(mint,observed_at,holder_count,snapshot_hash,changed,full_snapshot_id) VALUES(?,?,?,?,?,?)');
    this.insertSocketBalance = this.db.prepare('INSERT INTO socket_holder_balances(snapshot_id,wallet,raw) VALUES(?,?,?)');
    this.upsertLatestSocket = this.db.prepare('INSERT INTO socket_holder_latest(mint,snapshot_hash,snapshot_id,observed_at) VALUES(?,?,?,?) ON CONFLICT(mint) DO UPDATE SET snapshot_hash=excluded.snapshot_hash,snapshot_id=excluded.snapshot_id,observed_at=excluded.observed_at');
  }

  record(mint: string, observedAt: number, status: number, source: HolderObservationSource, holders: ResearchTrackedHolder[]): { changed: boolean; snapshotId: number | null } {
    const completeSnapshot = status === 200 && holders.length > 0;
    const hash = completeSnapshot ? snapshotHash(holders) : null;
    const previous = this.latest.get(mint) as LatestSnapshot | undefined;
    const changed = completeSnapshot && previous?.snapshot_hash !== hash;
    let snapshotId = previous?.snapshot_id ?? null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (changed && hash) {
        const row = this.insertSnapshot.get(mint, observedAt, holders.length, hash) as { id: number };
        snapshotId = row.id;
        for (const holder of holders) {
          this.insertBalance.run(snapshotId, holder.wallet, holder.amountPercentage, holder.amount, holder.isDev ? 1 : 0,
            JSON.stringify(holder.devEvidence), holder.walletTagV2 ?? null, JSON.stringify(holder.raw));
        }
        this.upsertLatest.run(mint, hash, snapshotId, observedAt);
      }
      this.insertObservation.run(mint, observedAt, status, source, holders.length, hash, changed ? 1 : 0, completeSnapshot ? snapshotId : null);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { changed, snapshotId };
  }

  recordSocket(mint: string, observedAt: number, holders: ResearchSocketHolder[]): { changed: boolean; snapshotId: number | null } {
    const hash = snapshotHash(holders);
    const previous = this.latestSocket.get(mint) as LatestSnapshot | undefined;
    const changed = previous?.snapshot_hash !== hash;
    let snapshotId = previous?.snapshot_id ?? null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (changed) {
        const row = this.insertSocketSnapshot.get(mint, observedAt, holders.length, hash) as { id: number };
        snapshotId = row.id;
        for (const holder of holders) this.insertSocketBalance.run(snapshotId, holder.wallet, JSON.stringify(holder.raw));
        this.upsertLatestSocket.run(mint, hash, snapshotId, observedAt);
      }
      this.insertSocketObservation.run(mint, observedAt, holders.length, hash, changed ? 1 : 0, snapshotId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { changed, snapshotId };
  }

  counts() {
    const row = this.db.prepare(`SELECT
      (SELECT count(*) FROM holder_api_observations) AS observations,
      (SELECT count(*) FROM holder_snapshots) AS snapshots,
      (SELECT count(*) FROM holder_balances) AS balances`).get() as { observations: number; snapshots: number; balances: number };
    return { observations: row.observations, snapshots: row.snapshots, balances: row.balances };
  }

  socketCounts() {
    const row = this.db.prepare(`SELECT
      (SELECT count(*) FROM socket_holder_observations) AS observations,
      (SELECT count(*) FROM socket_holder_snapshots) AS snapshots,
      (SELECT count(*) FROM socket_holder_balances) AS balances`).get() as { observations: number; snapshots: number; balances: number };
    return { observations: row.observations, snapshots: row.snapshots, balances: row.balances };
  }

  close() { this.db.close(); }
}
