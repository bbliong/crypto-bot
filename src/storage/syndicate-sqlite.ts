import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export interface TransferRecord {
  txSignature: string;
  mint: string;
  tokenName?: string;
  symbol?: string;
  fromAddress: string;
  toAddress: string;
  amount: string;
  blockTime: number;
  timeWib: string;
  syndicateId?: string;
  syndicateName?: string;
}

export interface CandidateRecord {
  mint: string;
  name: string;
  symbol: string;
  deployerAddress: string;
  walletsCount: number;
  latestTransferAt: number;
  latestTransferWib: string;
  latestTx: string;
  sampleWallet: string;
  isWatched: number;
  cycleId: string;
  updatedAt: number;
}

export class SyndicateSqliteStorage {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath: string = '/home/bbliong/project/crypto-bot/data/crypto-bot.sqlite') {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS syndicate_transfers (
        tx_signature TEXT PRIMARY KEY,
        mint TEXT NOT NULL,
        token_name TEXT,
        symbol TEXT,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        amount TEXT NOT NULL,
        block_time INTEGER NOT NULL,
        time_wib TEXT NOT NULL,
        syndicate_id TEXT,
        syndicate_name TEXT,
        cycle_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_st_mint ON syndicate_transfers(mint);
      CREATE INDEX IF NOT EXISTS idx_st_cycle ON syndicate_transfers(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_st_block_time ON syndicate_transfers(block_time);

      CREATE TABLE IF NOT EXISTS syndicate_candidates (
        mint TEXT PRIMARY KEY,
        name TEXT,
        symbol TEXT,
        deployer_address TEXT NOT NULL,
        wallets_count INTEGER NOT NULL,
        latest_transfer_at INTEGER NOT NULL,
        latest_transfer_wib TEXT NOT NULL,
        latest_tx TEXT NOT NULL,
        sample_wallet TEXT NOT NULL,
        is_watched INTEGER DEFAULT 0,
        cycle_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sc_watched ON syndicate_candidates(is_watched);
      CREATE INDEX IF NOT EXISTS idx_sc_latest ON syndicate_candidates(latest_transfer_at);
      CREATE INDEX IF NOT EXISTS idx_sc_wallets ON syndicate_candidates(wallets_count);
    `);
  }

  public insertTransfers(transfers: TransferRecord[], cycleId: string = 'stream'): number {
    if (!transfers || transfers.length === 0) return 0;

    const now = Date.now();
    const effectiveCycleId = cycleId || 'stream';
    const insertStmt = this.db.prepare(`
      INSERT INTO syndicate_transfers (
        tx_signature, mint, token_name, symbol,
        from_address, to_address, amount,
        block_time, time_wib, syndicate_id, syndicate_name,
        cycle_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tx_signature) DO UPDATE SET
        token_name = COALESCE(excluded.token_name, syndicate_transfers.token_name),
        symbol = COALESCE(excluded.symbol, syndicate_transfers.symbol),
        cycle_id = excluded.cycle_id
    `);

    for (const t of transfers) {
      insertStmt.run(
        t.txSignature,
        t.mint,
        t.tokenName || null,
        t.symbol || null,
        t.fromAddress,
        t.toAddress,
        t.amount,
        t.blockTime,
        t.timeWib,
        t.syndicateId || null,
        t.syndicateName || null,
        effectiveCycleId,
        now
      );
    }
    return transfers.length;
  }

  public recomputeCandidates(cycleId: string): CandidateRecord[] {
    const rows = this.db.prepare(`
      SELECT 
        mint,
        MAX(token_name) as name,
        MAX(symbol) as symbol,
        from_address as deployer_address,
        COUNT(DISTINCT to_address) as wallets_count,
        MAX(block_time) as latest_transfer_at,
        MAX(time_wib) as latest_transfer_wib,
        (SELECT tx_signature FROM syndicate_transfers st2 
         WHERE st2.mint = st1.mint 
         ORDER BY block_time DESC, created_at DESC LIMIT 1) as latest_tx,
        (SELECT to_address FROM syndicate_transfers st3 
         WHERE st3.mint = st1.mint 
         ORDER BY block_time DESC, created_at DESC LIMIT 1) as sample_wallet
      FROM syndicate_transfers st1
      WHERE cycle_id = ?
      GROUP BY mint
      ORDER BY latest_transfer_at DESC, wallets_count DESC
    `).all(cycleId) as any[];

    const now = Date.now();
    const upsertCandidateStmt = this.db.prepare(`
      INSERT INTO syndicate_candidates (
        mint, name, symbol, deployer_address,
        wallets_count, latest_transfer_at, latest_transfer_wib,
        latest_tx, sample_wallet, is_watched,
        cycle_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(mint) DO UPDATE SET
        name = COALESCE(excluded.name, syndicate_candidates.name),
        symbol = COALESCE(excluded.symbol, syndicate_candidates.symbol),
        deployer_address = excluded.deployer_address,
        wallets_count = excluded.wallets_count,
        latest_transfer_at = excluded.latest_transfer_at,
        latest_transfer_wib = excluded.latest_transfer_wib,
        latest_tx = excluded.latest_tx,
        sample_wallet = excluded.sample_wallet,
        cycle_id = excluded.cycle_id,
        updated_at = excluded.updated_at
    `);

    const result: CandidateRecord[] = [];
    for (const r of rows) {
      upsertCandidateStmt.run(
        r.mint,
        r.name || 'Unknown',
        r.symbol || 'UNKNOWN',
        r.deployer_address,
        Number(r.wallets_count),
        Number(r.latest_transfer_at),
        r.latest_transfer_wib || '',
        r.latest_tx || '',
        r.sample_wallet || '',
        cycleId,
        now
      );

      result.push({
        mint: r.mint,
        name: r.name || 'Unknown',
        symbol: r.symbol || 'UNKNOWN',
        deployerAddress: r.deployer_address,
        walletsCount: Number(r.wallets_count),
        latestTransferAt: Number(r.latest_transfer_at),
        latestTransferWib: r.latest_transfer_wib || '',
        latestTx: r.latest_tx || '',
        sampleWallet: r.sample_wallet || '',
        isWatched: 0,
        cycleId,
        updatedAt: now
      });
    }

    return result;
  }

  public markWatchedTokens(topMints: string[]): void {
    this.db.prepare(`UPDATE syndicate_candidates SET is_watched = 0`).run();
    if (topMints.length === 0) return;

    const markStmt = this.db.prepare(`UPDATE syndicate_candidates SET is_watched = 1 WHERE mint = ?`);
    for (const m of topMints) {
      markStmt.run(m);
    }
  }

  public getWatchedCandidates(): CandidateRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM syndicate_candidates WHERE is_watched = 1 ORDER BY latest_transfer_at DESC
    `).all() as any[];

    return rows.map(r => ({
      mint: r.mint,
      name: r.name,
      symbol: r.symbol,
      deployerAddress: r.deployer_address,
      walletsCount: Number(r.wallets_count),
      latestTransferAt: Number(r.latest_transfer_at),
      latestTransferWib: r.latest_transfer_wib,
      latestTx: r.latest_tx,
      sampleWallet: r.sample_wallet,
      isWatched: Number(r.is_watched),
      cycleId: r.cycle_id,
      updatedAt: Number(r.updated_at)
    }));
  }

  public getAllCandidates(): CandidateRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM syndicate_candidates ORDER BY latest_transfer_at DESC, wallets_count DESC
    `).all() as any[];

    return rows.map(r => ({
      mint: r.mint,
      name: r.name,
      symbol: r.symbol,
      deployerAddress: r.deployer_address,
      walletsCount: Number(r.wallets_count),
      latestTransferAt: Number(r.latest_transfer_at),
      latestTransferWib: r.latest_transfer_wib,
      latestTx: r.latest_tx,
      sampleWallet: r.sample_wallet,
      isWatched: Number(r.is_watched),
      cycleId: r.cycle_id,
      updatedAt: Number(r.updated_at)
    }));
  }

  public exportAllCandidatesJson(outputPath: string): void {
    const all = this.getAllCandidates();
    const cycleId = all.length > 0 ? all[0].cycleId : new Date().toISOString();
    const payload = {
      exportedAt: new Date().toISOString(),
      cycleId,
      totalCandidates: all.length,
      candidates: all
    };
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  }

  public close(): void {
    this.db.close();
  }
}
