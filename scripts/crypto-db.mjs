import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
export const DEFAULT_DB_PATH = join(projectRoot, 'data', 'crypto-bot.sqlite');

let globalDbInstance = null;

export function initCryptoDb(dbPath = DEFAULT_DB_PATH) {
  if (globalDbInstance) return globalDbInstance;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      started_at TEXT NOT NULL,
      friendly_label TEXT,
      is_live INTEGER DEFAULT 0,
      trades_count INTEGER DEFAULT 0,
      manifest_json TEXT,
      strategy_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS token_metadata (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      decimals INTEGER,
      market_cap_usd REAL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      position_id TEXT,
      mint TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      lane TEXT NOT NULL,
      lane_label TEXT,
      worker INTEGER DEFAULT 1,
      status TEXT NOT NULL,
      entry_price REAL,
      entry_time INTEGER,
      exit_price REAL,
      exit_time INTEGER,
      duration_sec INTEGER,
      exit_reason TEXT,
      trade_return_percent REAL,
      socket_return_percent REAL,
      real_return_percent REAL,
      trade_pnl_usd REAL,
      swap_pnl_usd REAL,
      is_win INTEGER,
      is_socket_win INTEGER,
      is_real_win INTEGER,
      swap_route_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_trades_run_id ON trades(run_id);
    CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint);
    CREATE INDEX IF NOT EXISTS idx_trades_lane ON trades(lane);
    CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time DESC);

    CREATE TABLE IF NOT EXISTS real_trades (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      lane TEXT NOT NULL,
      lane_label TEXT,
      status TEXT NOT NULL,
      buy_time INTEGER,
      buy_ok INTEGER,
      buy_status INTEGER,
      buy_code INTEGER,
      buy_message TEXT,
      buy_order_id TEXT,
      buy_hash TEXT,
      buy_solscan_url TEXT,
      buy_stake_usd REAL,
      buy_token_price_usd REAL,
      buy_acquired_amount TEXT,
      buy_acquired_decimals INTEGER,
      sell_time INTEGER,
      sell_ok INTEGER,
      sell_status INTEGER,
      sell_code INTEGER,
      sell_message TEXT,
      sell_order_id TEXT,
      sell_hash TEXT,
      sell_solscan_url TEXT,
      sell_input_amount TEXT,
      sell_token_price_usd REAL,
      duration_sec INTEGER,
      theory_return_percent REAL,
      actual_return_percent REAL,
      slippage_diff_percent REAL,
      wallet_buy_cost REAL,
      wallet_sold_income REAL,
      wallet_pnl_usd REAL,
      wallet_snapshots_json TEXT,
      buy_payloads_json TEXT,
      sell_payloads_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_real_trades_run_id ON real_trades(run_id);
    CREATE INDEX IF NOT EXISTS idx_real_trades_mint ON real_trades(mint);
    CREATE INDEX IF NOT EXISTS idx_real_trades_buy_time ON real_trades(buy_time DESC);

    CREATE TABLE IF NOT EXISTS route_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      mint TEXT NOT NULL,
      symbol TEXT,
      name TEXT,
      type TEXT NOT NULL,
      type_label TEXT,
      flow_text TEXT,
      signal_price_usd REAL,
      route_implied_token_price_usd REAL,
      slip_percent REAL,
      latency_ms INTEGER,
      input_amount_base_units TEXT,
      route_token_amount REAL,
      raw_quote_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_route_quotes_run_id ON route_quotes(run_id);
    CREATE INDEX IF NOT EXISTS idx_route_quotes_mint ON route_quotes(mint);
    CREATE INDEX IF NOT EXISTS idx_route_quotes_observed_at ON route_quotes(observed_at DESC);
  `);

  globalDbInstance = db;
  return db;
}

export function getSetting(key, defaultValue = null) {
  const db = initCryptoDb();
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return defaultValue;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export function setSetting(key, value) {
  const db = initCryptoDb();
  const strVal = typeof value === 'string' ? value : JSON.stringify(value);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, strVal, now);
}

export function getAllSettings() {
  const db = initCryptoDb();
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const result = {};
  for (const r of rows) {
    try {
      result[r.key] = JSON.parse(r.value);
    } catch {
      result[r.key] = r.value;
    }
  }
  return result;
}

export function upsertRun(run) {
  const db = initCryptoDb();
  db.prepare(`
    INSERT INTO runs (id, path, started_at, friendly_label, is_live, trades_count, manifest_json, strategy_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      started_at = excluded.started_at,
      friendly_label = excluded.friendly_label,
      is_live = excluded.is_live,
      trades_count = excluded.trades_count,
      manifest_json = COALESCE(excluded.manifest_json, runs.manifest_json),
      strategy_json = COALESCE(excluded.strategy_json, runs.strategy_json),
      updated_at = excluded.updated_at
  `).run(
    run.id,
    run.path,
    run.startedAt,
    run.friendlyLabel || null,
    run.isLive ? 1 : 0,
    run.tradesCount || 0,
    run.manifest ? JSON.stringify(run.manifest) : null,
    run.strategy ? JSON.stringify(run.strategy) : null,
    new Date().toISOString()
  );
}

export function getRuns() {
  const db = initCryptoDb();
  const rows = db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all();
  return rows.map(r => ({
    id: r.id,
    path: r.path,
    startedAt: r.started_at,
    friendlyLabel: r.friendly_label,
    isLive: Boolean(r.is_live),
    tradesCount: r.trades_count,
    manifest: r.manifest_json ? JSON.parse(r.manifest_json) : null,
    strategy: r.strategy_json ? JSON.parse(r.strategy_json) : null,
  }));
}

export function upsertTrade(trade) {
  const db = initCryptoDb();
  const id = trade.id || trade.positionId || `${trade.runId}:${trade.mint}:${trade.lane}:${trade.entryTime}`;
  db.prepare(`
    INSERT INTO trades (
      id, run_id, position_id, mint, symbol, name, lane, lane_label, worker, status,
      entry_price, entry_time, exit_price, exit_time, duration_sec, exit_reason,
      trade_return_percent, socket_return_percent, real_return_percent,
      trade_pnl_usd, swap_pnl_usd, is_win, is_socket_win, is_real_win, swap_route_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      exit_price = excluded.exit_price,
      exit_time = excluded.exit_time,
      duration_sec = excluded.duration_sec,
      exit_reason = excluded.exit_reason,
      trade_return_percent = excluded.trade_return_percent,
      socket_return_percent = excluded.socket_return_percent,
      real_return_percent = excluded.real_return_percent,
      trade_pnl_usd = excluded.trade_pnl_usd,
      swap_pnl_usd = excluded.swap_pnl_usd,
      is_win = excluded.is_win,
      is_socket_win = excluded.is_socket_win,
      is_real_win = excluded.is_real_win,
      swap_route_json = excluded.swap_route_json
  `).run(
    id,
    trade.runId,
    trade.positionId || id,
    trade.mint,
    trade.symbol || trade.mint.slice(0, 6),
    trade.name || trade.symbol || trade.mint.slice(0, 6),
    trade.lane,
    trade.laneLabel || trade.lane,
    trade.worker || 1,
    trade.status || (trade.exitTime ? 'CLOSED' : 'OPEN'),
    trade.entryPrice,
    trade.entryTime,
    trade.exitPrice || null,
    trade.exitTime || null,
    trade.durationSec || 0,
    trade.exitReason || null,
    trade.tradeReturnPercent ?? null,
    trade.socketReturnPercent ?? null,
    trade.realReturnPercent ?? null,
    trade.tradePnlUsd ?? null,
    trade.swapPnlUsd ?? null,
    trade.isWin ? 1 : 0,
    trade.isSocketWin ? 1 : 0,
    trade.isRealWin ? 1 : 0,
    trade.swapRoute ? JSON.stringify(trade.swapRoute) : null
  );
}

export function countTrades(runId, options = {}) {
  const db = initCryptoDb();
  let sql = 'SELECT COUNT(*) as total FROM trades WHERE run_id = ?';
  const params = [runId];
  if (options.status) { sql += ' AND status = ?'; params.push(options.status); }
  if (options.lane && options.lane !== 'all') { sql += ' AND lane = ?'; params.push(options.lane); }
  const row = db.prepare(sql).get(...params);
  return row ? (row.total || 0) : 0;
}

export function getTrades(runId, options = {}) {
  const db = initCryptoDb();
  let sql = 'SELECT * FROM trades WHERE run_id = ?';
  const params = [runId];

  if (options.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }
  if (options.lane && options.lane !== 'all') {
    sql += ' AND lane = ?';
    params.push(options.lane);
  }

  sql += ' ORDER BY COALESCE(exit_time, entry_time) DESC';

  if (options.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
    if (options.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }
  }

  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    positionId: r.position_id,
    mint: r.mint,
    lane: r.lane,
    laneLabel: r.lane_label,
    symbol: r.symbol,
    name: r.name,
    worker: r.worker,
    status: r.status,
    entryPrice: r.entry_price,
    entryTime: r.entry_time,
    exitPrice: r.exit_price,
    exitTime: r.exit_time,
    durationSec: r.duration_sec,
    exitReason: r.exit_reason,
    tradeReturnPercent: r.trade_return_percent,
    socketReturnPercent: r.socket_return_percent,
    realReturnPercent: r.real_return_percent,
    tradePnlUsd: r.trade_pnl_usd,
    swapPnlUsd: r.swap_pnl_usd,
    pnlUsd: r.trade_pnl_usd,
    isWin: Boolean(r.is_win),
    isSocketWin: Boolean(r.is_socket_win),
    isRealWin: Boolean(r.is_real_win),
    swapRoute: r.swap_route_json ? JSON.parse(r.swap_route_json) : null,
  }));
}

export function upsertRealTrade(trade) {
  const db = initCryptoDb();
  const id = trade.id || `${trade.runId}:${trade.mint}:${trade.buy?.time || Date.now()}`;
  db.prepare(`
    INSERT INTO real_trades (
      id, run_id, mint, symbol, name, lane, lane_label, status,
      buy_time, buy_ok, buy_status, buy_code, buy_message, buy_order_id, buy_hash, buy_solscan_url,
      buy_stake_usd, buy_token_price_usd, buy_acquired_amount, buy_acquired_decimals,
      sell_time, sell_ok, sell_status, sell_code, sell_message, sell_order_id, sell_hash, sell_solscan_url,
      sell_input_amount, sell_token_price_usd, duration_sec, theory_return_percent, actual_return_percent,
      slippage_diff_percent, wallet_buy_cost, wallet_sold_income, wallet_pnl_usd,
      wallet_snapshots_json, buy_payloads_json, sell_payloads_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      sell_time = excluded.sell_time,
      sell_ok = excluded.sell_ok,
      sell_status = excluded.sell_status,
      sell_code = excluded.sell_code,
      sell_message = excluded.sell_message,
      sell_order_id = excluded.sell_order_id,
      sell_hash = excluded.sell_hash,
      sell_solscan_url = excluded.sell_solscan_url,
      sell_input_amount = excluded.sell_input_amount,
      sell_token_price_usd = excluded.sell_token_price_usd,
      duration_sec = excluded.duration_sec,
      theory_return_percent = excluded.theory_return_percent,
      actual_return_percent = excluded.actual_return_percent,
      slippage_diff_percent = excluded.slippage_diff_percent,
      wallet_buy_cost = excluded.wallet_buy_cost,
      wallet_sold_income = excluded.wallet_sold_income,
      wallet_pnl_usd = excluded.wallet_pnl_usd,
      wallet_snapshots_json = excluded.wallet_snapshots_json,
      sell_payloads_json = excluded.sell_payloads_json
  `).run(
    id,
    trade.runId || trade.run_id || null,
    trade.mint,
    trade.symbol || null,
    trade.name || null,
    trade.lane || null,
    trade.laneLabel || null,
    trade.status || 'COMPLETED',
    trade.buy?.time || null,
    trade.buy?.ok ? 1 : 0,
    trade.buy?.status || null,
    trade.buy?.code || null,
    trade.buy?.message || null,
    trade.buy?.orderId || null,
    trade.buy?.hash || null,
    trade.buy?.solscanUrl || null,
    trade.buy?.stakeUsd ?? trade.stakeUsd ?? 0.5,
    trade.buy?.tokenPriceUsd ?? null,
    trade.buy?.acquiredAmount || null,
    trade.buy?.acquiredDecimals ?? null,
    trade.sell?.time || null,
    trade.sell?.ok ? 1 : 0,
    trade.sell?.status || null,
    trade.sell?.code || null,
    trade.sell?.message || null,
    trade.sell?.orderId || null,
    trade.sell?.hash || null,
    trade.sell?.solscanUrl || null,
    trade.sell?.inputAmount || null,
    trade.sell?.tokenPriceUsd ?? null,
    trade.durationSec || 0,
    trade.theoryReturnPercent ?? null,
    trade.actualReturnPercent ?? null,
    trade.slippageDiffPercent ?? null,
    trade.walletBuyCost ?? null,
    trade.walletSoldIncome ?? null,
    trade.walletPnlUsd ?? null,
    trade.walletSnapshots ? JSON.stringify(trade.walletSnapshots) : null,
    trade.buy?.payloads ? JSON.stringify(trade.buy.payloads.slice(-3)) : null,
    trade.sell?.payloads ? JSON.stringify(trade.sell.payloads.slice(-3)) : null
  );
}

export function getRealTrades(runId = null) {
  const db = initCryptoDb();
  let sql = 'SELECT * FROM real_trades';
  const params = [];
  if (runId) {
    sql += ' WHERE run_id = ?';
    params.push(runId);
  }
  sql += ' ORDER BY buy_time DESC';
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    id: r.id,
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    lane: r.lane,
    laneLabel: r.lane_label,
    status: r.status,
    durationSec: r.duration_sec,
    theoryReturnPercent: r.theory_return_percent,
    actualReturnPercent: r.actual_return_percent,
    slippageDiffPercent: r.slippage_diff_percent,
    walletBuyCost: r.wallet_buy_cost,
    walletSoldIncome: r.wallet_sold_income,
    walletPnlUsd: r.wallet_pnl_usd,
    walletSnapshots: r.wallet_snapshots_json ? JSON.parse(r.wallet_snapshots_json) : [],
    buy: {
      time: r.buy_time,
      timeFormatted: r.buy_time ? new Date(r.buy_time).toLocaleTimeString('id-ID', { hour12: false }) : '—',
      ok: Boolean(r.buy_ok),
      status: r.buy_status,
      code: r.buy_code,
      message: r.buy_message,
      orderId: r.buy_order_id,
      hash: r.buy_hash,
      solscanUrl: r.buy_solscan_url,
      stakeUsd: r.buy_stake_usd,
      tokenPriceUsd: r.buy_token_price_usd,
      acquiredAmount: r.buy_acquired_amount,
      acquiredDecimals: r.buy_acquired_decimals,
      payloads: r.buy_payloads_json ? JSON.parse(r.buy_payloads_json) : [],
    },
    sell: r.sell_time ? {
      time: r.sell_time,
      timeFormatted: new Date(r.sell_time).toLocaleTimeString('id-ID', { hour12: false }),
      ok: Boolean(r.sell_ok),
      status: r.sell_status,
      code: r.sell_code,
      message: r.sell_message,
      orderId: r.sell_order_id,
      hash: r.sell_hash,
      solscanUrl: r.sell_solscan_url,
      inputAmount: r.sell_input_amount,
      tokenPriceUsd: r.sell_token_price_usd,
      payloads: r.sell_payloads_json ? JSON.parse(r.sell_payloads_json) : [],
    } : null,
  }));
}

export function upsertRouteQuote(q) {
  const db = initCryptoDb();
  db.prepare(`
    INSERT INTO route_quotes (
      run_id, observed_at, mint, symbol, name, type, type_label, flow_text,
      signal_price_usd, route_implied_token_price_usd, slip_percent, latency_ms,
      input_amount_base_units, route_token_amount, raw_quote_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    q.runId,
    q.observedAt,
    q.mint,
    q.symbol || q.mint.slice(0, 6),
    q.name || q.symbol || q.mint.slice(0, 6),
    q.type,
    q.typeLabel || q.type,
    q.flowText || null,
    q.signalPriceUsd ?? null,
    q.routeImpliedTokenPriceUsd ?? null,
    q.slipPercent ?? null,
    q.latencyMs ?? null,
    q.inputAmountBaseUnits || null,
    q.routeTokenAmount || null,
    q.quote ? JSON.stringify(q.quote) : null
  );
}

export function getRouteQuotes(runId = null, limit = 50) {
  const db = initCryptoDb();
  let sql = 'SELECT * FROM route_quotes';
  const params = [];
  if (runId) {
    sql += ' WHERE run_id = ?';
    params.push(runId);
  }
  sql += ' ORDER BY observed_at DESC LIMIT ?';
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map(r => ({
    observedAt: r.observed_at,
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    type: r.type,
    typeLabel: r.type_label,
    flowText: r.flow_text,
    signalPriceUsd: r.signal_price_usd,
    routeImpliedTokenPriceUsd: r.route_implied_token_price_usd,
    slipPercent: r.slip_percent,
    latencyMs: r.latency_ms,
    quote: r.raw_quote_json ? JSON.parse(r.raw_quote_json) : null,
    isBuy: r.type === 'QUOTE_BUY_COMPARISON',
    isSell: r.type === 'QUOTE_SELL_COMPARISON',
  }));
}

export function getWibSlot(now = new Date(), slotHours = 3) {
  const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
  const wibTime = new Date(now.getTime() + WIB_OFFSET_MS);

  const wibYear = wibTime.getUTCFullYear();
  const wibMonth = wibTime.getUTCMonth();
  const wibDate = wibTime.getUTCDate();
  const wibHours = wibTime.getUTCHours();

  const slotStartHour = Math.floor(wibHours / slotHours) * slotHours;
  const slotEndHour = slotStartHour + slotHours;

  const slotStartWibMs = Date.UTC(wibYear, wibMonth, wibDate, slotStartHour, 0, 0, 0);
  const slotStartUtcMs = slotStartWibMs - WIB_OFFSET_MS;

  const slotEndWibMs = Date.UTC(wibYear, wibMonth, wibDate, slotEndHour, 0, 0, 0);
  const slotEndUtcMs = slotEndWibMs - WIB_OFFSET_MS;

  const slotStartDate = new Date(slotStartUtcMs);
  const slotEndDate = new Date(slotEndUtcMs);

  const folderTimestamp = slotStartDate.toISOString().replace(/[:.]/g, '-');
  const runId = `momentum-aggressive-${folderTimestamp}`;
  const folderPath = join(projectRoot, 'research', runId);

  return {
    slotStartHour,
    slotEndHour,
    slotStartUtcMs,
    slotEndUtcMs,
    slotStartDate,
    slotEndDate,
    runId,
    folderPath,
    folderName: `research/${runId}`,
    remainingSeconds: Math.max(0, Math.round((slotEndUtcMs - now.getTime()) / 1000)),
    friendlyLabel: `${String(slotStartHour).padStart(2, '0')}:00 - ${String(slotEndHour).padStart(2, '0')}:00 WIB`,
  };
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function syncSingleRunToSqlite(runDir, isLive = false) {
  if (!existsSync(runDir)) return { ok: false, error: 'Directory does not exist' };
  const db = initCryptoDb();
  const runId = basename(runDir);

  const manifest = readJsonFile(join(runDir, 'manifest.json'));
  const strategy = readJsonFile(join(runDir, 'strategy.json'));
  const simTrades = readJsonLines(join(runDir, 'simulated-trades.jsonl'));
  const routeQuotes = readJsonLines(join(runDir, 'quote-simulated-orders.jsonl'));
  const ledgerRows = readJsonLines(join(runDir, 'live-trade-ledger.jsonl'));
  const eventRows = readJsonLines(join(runDir, 'events.jsonl'));
  const screenedTokens = readJsonLines(join(runDir, 'screened-tokens.jsonl'));
  const tokenSummaries = readJsonLines(join(runDir, 'token-summary.jsonl'));

  const match = runId.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  let startedAt = (match && match[3] === '00' && match[4] === '00')
    ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
    : (manifest?.startedAt || (match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : new Date().toISOString()));

  // Metadata lookup
  const metadataByMint = new Map();
  for (const t of simTrades) if (t.mint && t.metadata) metadataByMint.set(t.mint, t.metadata);
  for (const s of screenedTokens) if (s.mint && s.metadata) metadataByMint.set(s.mint, s.metadata);
  for (const t of tokenSummaries) if (t.mint && t.metadata) metadataByMint.set(t.mint, t.metadata);

  // Process Simulated Trades
  const buys = simTrades.filter(t => t.type === 'SIMULATED_BUY');
  const sells = simTrades.filter(t => t.type === 'SIMULATED_SELL');
  const sellsByPos = new Map(sells.filter(s => s.positionId).map(s => [s.positionId, s]));
  const sellsByMint = new Map(sells.map(s => [s.mint, s]));

  const quotesByPos = new Map();
  for (const q of routeQuotes) {
    if (q.positionId) {
      const list = quotesByPos.get(q.positionId) || [];
      list.push(q);
      quotesByPos.set(q.positionId, list);
    }
  }

  let closedCount = 0;

  db.exec('BEGIN TRANSACTION;');
  try {
    const insertTradeStmt = db.prepare(`
      INSERT INTO trades (
        id, run_id, position_id, mint, symbol, name, lane, lane_label, worker, status,
        entry_price, entry_time, exit_price, exit_time, duration_sec, exit_reason,
        trade_return_percent, socket_return_percent, real_return_percent,
        trade_pnl_usd, swap_pnl_usd, is_win, is_socket_win, is_real_win, swap_route_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        exit_price = excluded.exit_price,
        exit_time = excluded.exit_time,
        duration_sec = excluded.duration_sec,
        exit_reason = excluded.exit_reason,
        trade_return_percent = excluded.trade_return_percent,
        socket_return_percent = excluded.socket_return_percent,
        real_return_percent = excluded.real_return_percent,
        trade_pnl_usd = excluded.trade_pnl_usd,
        swap_pnl_usd = excluded.swap_pnl_usd,
        is_win = excluded.is_win,
        is_socket_win = excluded.is_socket_win,
        is_real_win = excluded.is_real_win,
        swap_route_json = excluded.swap_route_json
    `);

    for (const buy of buys) {
      const lane = buy.paperLane || 'control';
      const laneLabel = lane === 'momentum-v3-calm-v1' ? 'Momentum V3 Calm V1 (Paper)' : lane === 'momentum-v2-balanced-flow-v1' ? 'Momentum V2 Balanced Flow V1 (Paper)' : lane === 'r5-band' ? 'Momentum R5 Band' : lane === 'momentum-v3' ? 'Momentum V3' : lane === 'momentum-v2' ? 'Momentum V2' : lane === 'aggressive-wide' ? 'Wide Aggressive' : lane === 'aggressive-optimal' ? 'Optimal Aggressive' : lane === 'aggressive-safe' ? 'Safe Aggressive' : 'Raw Aggressive';
      const posId = buy.positionId || `${buy.mint}:${buy.observedAt}:${lane}`;
      const sell = sellsByPos.get(posId) || sells.find(s => s.mint === buy.mint && ((s.paperLane || 'control') === lane)) || sellsByMint.get(buy.mint);

      const meta = metadataByMint.get(buy.mint) || buy.metadata || {};
      const symbol = meta.symbol || buy.symbol || buy.mint.slice(0, 6);
      const name = meta.name || symbol;

      const buyQuotes = quotesByPos.get(posId) || quotesByPos.get(`${buy.mint}:${buy.observedAt}:control`) || [];
      const buyQuote = buyQuotes.find(q => q.type === 'QUOTE_BUY_COMPARISON');
      const sellQuote = buyQuotes.find(q => q.type === 'QUOTE_SELL_COMPARISON');

      let socketReturn = null;
      let realReturn = null;
      let tradePnlUsd = null;
      let swapPnlUsd = null;
      let isSocketWin = 0;
      let isRealWin = 0;

      if (sell) {
        const exitPriceUsd = sell.exit?.priceUsd ?? sell.timing?.priceUsd ?? sell.decision?.priceUsd ?? sell.exitPriceUsd ?? null;
        closedCount++;
        socketReturn = sell.pnlPercent ?? (exitPriceUsd && buy.entryPriceUsd ? ((exitPriceUsd / buy.entryPriceUsd - 1) * 100) : 0);
        isSocketWin = socketReturn > 0 ? 1 : 0;
        const stakeUsd = buy.stakeUsd || 0.5;
        tradePnlUsd = stakeUsd * (socketReturn / 100);

        realReturn = socketReturn - 3.5;
        const inUsd = Number(buyQuote?.quote?.amountInUsd || 0);
        const outUsd = Number(sellQuote?.quote?.amountOutUsd || 0);
        if (inUsd > 0 && outUsd > 0) {
          realReturn = ((outUsd / inUsd) - 1) * 100;
          swapPnlUsd = outUsd - inUsd;
        } else {
          swapPnlUsd = sell.pnlUsd ?? (stakeUsd * (realReturn / 100));
        }
        isRealWin = realReturn > 0 ? 1 : 0;
      }

      const swapRoute = {
        hasBuy: !!buyQuote,
        hasSell: !!sellQuote,
        buyTime: buyQuote?.observedAt || buy.observedAt,
        buyInSol: buyQuote?.inputAmountBaseUnits ? (Number(buyQuote.inputAmountBaseUnits) / 1e9).toFixed(4) + ' SOL' : null,
        buyInUsd: buyQuote?.quote?.amountInUsd ? '$' + Number(buyQuote.quote.amountInUsd).toFixed(4) : null,
        buyOutTokens: buyQuote?.routeTokenAmount ? Math.round(buyQuote.routeTokenAmount).toLocaleString() : null,
        buySlippage: buyQuote?.routeVsSocketPricePercent != null ? (buyQuote.routeVsSocketPricePercent >= 0 ? '+' : '') + buyQuote.routeVsSocketPricePercent.toFixed(2) + '%' : '—',
        sellTime: sellQuote?.observedAt || sell?.observedAt,
        sellOutSol: sellQuote?.quote?.outAmount ? (Number(sellQuote.quote.outAmount) / 1e9).toFixed(4) + ' SOL' : null,
        sellOutUsd: sellQuote?.quote?.amountOutUsd ? '$' + Number(sellQuote.quote.amountOutUsd).toFixed(4) : null,
        sellSlippage: sellQuote?.routeVsSocketProceedsPercent != null ? (sellQuote.routeVsSocketProceedsPercent >= 0 ? '+' : '') + sellQuote.routeVsSocketProceedsPercent.toFixed(2) + '%' : '—',
      };

      const exitPriceUsd = sell ? (sell.exit?.priceUsd ?? sell.timing?.priceUsd ?? sell.decision?.priceUsd ?? sell.exitPriceUsd ?? null) : null;

      insertTradeStmt.run(
        posId,
        runId,
        posId,
        buy.mint,
        symbol,
        name,
        lane,
        laneLabel,
        buy.worker || 1,
        sell ? 'CLOSED' : 'OPEN',
        buy.entryPriceUsd,
        buy.observedAt,
        exitPriceUsd,
        sell?.observedAt || null,
        sell ? Math.max(1, Math.round((sell.observedAt - buy.observedAt) / 1000)) : 0,
        sell?.exitReason || sell?.reason || null,
        socketReturn,
        socketReturn,
        realReturn,
        tradePnlUsd,
        swapPnlUsd,
        isSocketWin,
        isSocketWin,
        isRealWin,
        JSON.stringify(swapRoute)
      );
    }

    const insertQuoteStmt = db.prepare(`
      INSERT INTO route_quotes (
        run_id, observed_at, mint, symbol, name, type, type_label, flow_text,
        signal_price_usd, route_implied_token_price_usd, slip_percent, latency_ms,
        input_amount_base_units, route_token_amount, raw_quote_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const q of routeQuotes.slice(-200)) {
      const meta = metadataByMint.get(q.mint);
      insertQuoteStmt.run(
        runId,
        q.observedAt,
        q.mint,
        q.symbol || meta?.symbol || q.mint.slice(0, 6),
        meta?.name || q.symbol || q.mint.slice(0, 6),
        q.type,
        q.type === 'QUOTE_BUY_COMPARISON' ? 'Buy Route' : 'Sell Route',
        q.flowText || null,
        q.signalPriceUsd ?? null,
        q.routeImpliedTokenPriceUsd ?? null,
        q.routeVsSocketPricePercent ?? q.routeVsSocketProceedsPercent ?? null,
        q.latencyMs ?? null,
        q.inputAmountBaseUnits || null,
        q.routeTokenAmount || null,
        q.quote ? JSON.stringify(q.quote) : null
      );
    }

    const insertRealTradeStmt = db.prepare(`
      INSERT INTO real_trades (
        id, run_id, mint, symbol, name, lane, lane_label, status,
        buy_time, buy_ok, buy_status, buy_code, buy_message, buy_order_id, buy_hash, buy_solscan_url,
        buy_stake_usd, buy_token_price_usd, buy_acquired_amount, buy_acquired_decimals,
        sell_time, sell_ok, sell_status, sell_code, sell_message, sell_order_id, sell_hash, sell_solscan_url,
        sell_input_amount, sell_token_price_usd, duration_sec, theory_return_percent, actual_return_percent,
        slippage_diff_percent, wallet_buy_cost, wallet_sold_income, wallet_pnl_usd,
        wallet_snapshots_json, buy_payloads_json, sell_payloads_json
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        sell_time = excluded.sell_time,
        sell_ok = excluded.sell_ok,
        sell_status = excluded.sell_status,
        sell_code = excluded.sell_code,
        sell_message = excluded.sell_message,
        sell_order_id = excluded.sell_order_id,
        sell_hash = excluded.sell_hash,
        sell_solscan_url = excluded.sell_solscan_url,
        sell_input_amount = excluded.sell_input_amount,
        sell_token_price_usd = excluded.sell_token_price_usd,
        duration_sec = excluded.duration_sec,
        theory_return_percent = excluded.theory_return_percent,
        actual_return_percent = excluded.actual_return_percent,
        slippage_diff_percent = excluded.slippage_diff_percent,
        wallet_buy_cost = excluded.wallet_buy_cost,
        wallet_sold_income = excluded.wallet_sold_income,
        wallet_pnl_usd = excluded.wallet_pnl_usd,
        wallet_snapshots_json = excluded.wallet_snapshots_json,
        sell_payloads_json = excluded.sell_payloads_json
    `);

    const buyOrders = [];
    const sellOrders = [];
    const walletSnapshotsByMint = new Map();

    for (const row of ledgerRows) {
      if (row.type === 'LIVE_ORDER_SUBMITTED') {
        if (row.side === 'BUY') buyOrders.push(row);
        else if (row.side === 'SELL') sellOrders.push(row);
      } else if (row.type === 'GMGN_WALLETSTAT_SNAPSHOT' && row.token) {
        const list = walletSnapshotsByMint.get(row.token) || [];
        list.push(row);
        walletSnapshotsByMint.set(row.token, list);
      }
    }

    for (const ev of eventRows) {
      if (ev.type === 'BROWSER_BUY_SUBMITTED' || ev.type === 'BROWSER_BUY_NOT_SUBMITTED') {
        if (!buyOrders.some(b => b.mint === ev.mint && Math.abs(b.observedAt - ev.observedAt) < 2000)) {
          buyOrders.push({
            type: 'LIVE_ORDER_SUBMITTED', side: 'BUY', mint: ev.mint, paperLane: ev.paperLane, observedAt: ev.observedAt,
            orderId: ev.result?.orderId ?? null, hash: ev.result?.hash ?? null, acquiredAmount: ev.result?.acquiredAmount ?? null,
            acquiredDecimals: ev.result?.acquiredDecimals ?? null, ok: ev.result?.ok ?? (ev.type === 'BROWSER_BUY_SUBMITTED'),
            status: ev.result?.status ?? null, code: ev.result?.code ?? null, message: ev.result?.message ?? null,
            stakeUsd: ev.stakeUsd ?? 2.0
          });
        }
      } else if (ev.type === 'BROWSER_SELL_SUBMITTED' || ev.type === 'BROWSER_SELL_NOT_SUBMITTED') {
        if (!sellOrders.some(s => s.mint === ev.mint && Math.abs(s.observedAt - ev.observedAt) < 2000)) {
          sellOrders.push({
            type: 'LIVE_ORDER_SUBMITTED', side: 'SELL', mint: ev.mint, paperLane: ev.paperLane, originLane: ev.originLane ?? ev.paperLane,
            observedAt: ev.observedAt, orderId: ev.result?.orderId ?? null, hash: ev.result?.hash ?? null,
            ok: ev.result?.ok ?? (ev.type === 'BROWSER_SELL_SUBMITTED'), status: ev.result?.status ?? null,
            code: ev.result?.code ?? null, message: ev.result?.message ?? null,
          });
        }
      }
    }

    let realTradesCount = 0;
    for (const buy of buyOrders) {
      const mint = buy.mint;
      const snaps = walletSnapshotsByMint.get(mint) || [];
      const meta = metadataByMint.get(mint) || {};
      const symbol = snaps.find(s => s.symbol)?.symbol || meta.symbol || buy.symbol || mint.slice(0, 6);
      const name = snaps.find(s => s.name)?.name || meta.name || symbol;
      const lane = buy.originLane || buy.paperLane || 'aggressive-optimal';
      const laneLabel = lane === 'momentum-v3-calm-v1' ? 'Momentum V3 Calm V1 (Paper)' : lane === 'momentum-v2-balanced-flow-v1' ? 'Momentum V2 Balanced Flow V1 (Paper)' : lane === 'r5-band' ? 'Momentum R5 Band' : lane === 'momentum-v3' ? 'Momentum V3' : lane === 'momentum-v2' ? 'Momentum V2' : lane === 'aggressive-wide' ? 'Wide Aggressive' : lane === 'aggressive-optimal' ? 'Optimal Aggressive' : lane === 'aggressive-safe' ? 'Safe Aggressive' : 'Raw Aggressive';

      const matchingSell = sellOrders.find(s => s.mint === mint && s.observedAt >= buy.observedAt);
      const postBuySnap = snaps.find(s => s.stage === 'POST_BUY');
      const postSellSnap = [...snaps].reverse().find(s => s.stage === 'POST_SELL' || s.stage === 'RETRY_SELL');

      const buyCost = postSellSnap?.historyBoughtCostUsd ?? postBuySnap?.historyBoughtCostUsd ?? buy.stakeUsd ?? 2.0;
      const soldIncome = postSellSnap?.historySoldIncomeUsd ?? null;
      const pnlUsd = (soldIncome !== null && buyCost > 0) ? soldIncome - buyCost : null;
      const actualReturn = (pnlUsd !== null && buyCost > 0) ? (pnlUsd / buyCost) * 100 : null;

      const realTradeId = `real:${runId}:${mint}:${buy.observedAt}`;
      const status = matchingSell ? 'CLOSED' : 'HOLDING';

      insertRealTradeStmt.run(
        realTradeId,
        runId,
        mint,
        symbol,
        name,
        lane,
        laneLabel,
        status,
        buy.observedAt,
        buy.ok ? 1 : 0,
        buy.status || (buy.ok ? 'SUBMITTED' : 'FAILED'),
        buy.code || null,
        buy.message || null,
        buy.orderId || null,
        buy.hash || null,
        buy.hash ? `https://solscan.io/tx/${buy.hash}` : null,
        buyCost,
        buy.tokenPriceUsd || null,
        buy.acquiredAmount || null,
        buy.acquiredDecimals || null,
        matchingSell?.observedAt || null,
        matchingSell ? (matchingSell.ok ? 1 : 0) : null,
        matchingSell?.status || null,
        matchingSell?.code || null,
        matchingSell?.message || null,
        matchingSell?.orderId || null,
        matchingSell?.hash || null,
        matchingSell?.hash ? `https://solscan.io/tx/${matchingSell.hash}` : null,
        matchingSell?.inputAmount || null,
        matchingSell?.tokenPriceUsd || null,
        matchingSell ? Math.max(1, Math.round((matchingSell.observedAt - buy.observedAt) / 1000)) : null,
        null,
        actualReturn,
        null,
        buyCost,
        soldIncome,
        pnlUsd,
        snaps.length > 0 ? JSON.stringify(snaps) : null,
        null,
        null
      );
      realTradesCount++;
    }

    const d = new Date(startedAt);
    const dateFormatted = !isNaN(d.getTime())
      ? `${d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false })} WIB`
      : startedAt;

    db.prepare(`
      INSERT INTO runs (id, path, started_at, friendly_label, is_live, trades_count, manifest_json, strategy_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        started_at = excluded.started_at,
        friendly_label = excluded.friendly_label,
        is_live = excluded.is_live,
        trades_count = excluded.trades_count,
        manifest_json = COALESCE(excluded.manifest_json, runs.manifest_json),
        strategy_json = COALESCE(excluded.strategy_json, runs.strategy_json),
        updated_at = excluded.updated_at
    `).run(
      runId,
      runDir,
      startedAt,
      isLive ? `🔴 [LIVE] ${dateFormatted}` : `📁 [ARSIP] ${dateFormatted} (${closedCount} Trades)`,
      isLive ? 1 : 0,
      closedCount,
      manifest ? JSON.stringify(manifest) : null,
      strategy ? JSON.stringify(strategy) : null,
      new Date().toISOString()
    );

    db.exec('COMMIT;');
    return { ok: true, runId, closedCount, realTradesCount };
  } catch (err) {
    db.exec('ROLLBACK;');
    console.error(`[sqlite-sync-error] Failed to sync run ${runId} to SQLite:`, err);
    return { ok: false, error: err.message };
  }
}
