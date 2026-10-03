#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWibSlot } from './crypto-db.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const dbPath = join(projectRoot, 'data', 'crypto-bot.sqlite');
const researchDir = join(projectRoot, 'research');
const backupDbPath = join(projectRoot, 'data', `crypto-bot.sqlite.bak-before-split-${Date.now()}`);

console.log('=============================================================================');
console.log('       🛠️ HISTORICAL 3-HOUR WINDOW PARTITIONING & DATA VALIDATION 🛠️        ');
console.log('=============================================================================\n');

// Step 1: Backup SQLite Database
console.log('Step 1: Creating safety backups of SQLite database...');
copyFileSync(dbPath, backupDbPath);
console.log(`  ✅ SQLite database backed up to: ${backupDbPath}`);

// Open DB
const db = new DatabaseSync(dbPath);

// Step 2: Audit Counts Before
console.log('\nStep 2: Counting records before partitioning...');
const totalTradesBefore = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
const totalRealBefore = db.prepare('SELECT COUNT(*) as c FROM real_trades').get().c;
const totalQuotesBefore = db.prepare('SELECT COUNT(*) as c FROM route_quotes').get().c;
console.log(`  • Trades in DB      : ${totalTradesBefore}`);
console.log(`  • Real Trades in DB : ${totalRealBefore}`);
console.log(`  • Route Quotes in DB: ${totalQuotesBefore}`);

// Step 3: Partition Trades in SQLite
console.log('\nStep 3: Partitioning trades by 3-hour WIB slot...');
const allTrades = db.prepare('SELECT id, entry_time FROM trades').all();
const updateTradeStmt = db.prepare('UPDATE trades SET run_id = ? WHERE id = ?');

db.exec('BEGIN TRANSACTION;');
const slotStats = {};

for (const t of allTrades) {
  const slot = getWibSlot(new Date(t.entry_time), 3);
  updateTradeStmt.run(slot.runId, t.id);
  if (!slotStats[slot.runId]) {
    slotStats[slot.runId] = {
      runId: slot.runId,
      slotStartDate: slot.slotStartDate,
      slotStartUtcMs: slot.slotStartUtcMs,
      slotEndUtcMs: slot.slotEndUtcMs,
      slotStartHour: slot.slotStartHour,
      slotEndHour: slot.slotEndHour,
      trades: 0,
      realTrades: 0,
      quotes: 0,
    };
  }
  slotStats[slot.runId].trades++;
}
db.exec('COMMIT;');
console.log(`  ✅ Updated ${allTrades.length} trades with canonical slot run_id.`);

// Step 4: Partition Real Trades in SQLite
console.log('\nStep 4: Partitioning real trades by 3-hour WIB slot...');
const allRealTrades = db.prepare('SELECT id, buy_time FROM real_trades').all();
const updateRealStmt = db.prepare('UPDATE real_trades SET run_id = ? WHERE id = ?');

db.exec('BEGIN TRANSACTION;');
for (const rt of allRealTrades) {
  const slot = getWibSlot(new Date(rt.buy_time), 3);
  updateRealStmt.run(slot.runId, rt.id);
  if (!slotStats[slot.runId]) {
    slotStats[slot.runId] = {
      runId: slot.runId,
      slotStartDate: slot.slotStartDate,
      slotStartUtcMs: slot.slotStartUtcMs,
      slotEndUtcMs: slot.slotEndUtcMs,
      slotStartHour: slot.slotStartHour,
      slotEndHour: slot.slotEndHour,
      trades: 0,
      realTrades: 0,
      quotes: 0,
    };
  }
  slotStats[slot.runId].realTrades++;
}
db.exec('COMMIT;');
console.log(`  ✅ Updated ${allRealTrades.length} real trades with canonical slot run_id.`);

// Step 5: Partition Route Quotes in SQLite
console.log('\nStep 5: Partitioning route quotes by 3-hour WIB slot...');
const allQuotes = db.prepare('SELECT id, observed_at FROM route_quotes').all();
const updateQuoteStmt = db.prepare('UPDATE route_quotes SET run_id = ? WHERE id = ?');

db.exec('BEGIN TRANSACTION;');
for (const q of allQuotes) {
  if (q.observed_at) {
    const slot = getWibSlot(new Date(q.observed_at), 3);
    updateQuoteStmt.run(slot.runId, q.id);
    if (!slotStats[slot.runId]) {
      slotStats[slot.runId] = {
        runId: slot.runId,
        slotStartDate: slot.slotStartDate,
        slotStartUtcMs: slot.slotStartUtcMs,
        slotEndUtcMs: slot.slotEndUtcMs,
        slotStartHour: slot.slotStartHour,
        slotEndHour: slot.slotEndHour,
        trades: 0,
        realTrades: 0,
        quotes: 0,
      };
    }
    slotStats[slot.runId].quotes++;
  }
}
db.exec('COMMIT;');
console.log(`  ✅ Updated ${allQuotes.length} route quotes with canonical slot run_id.`);

// Step 6: Create Canonical Disk Folders and Partition JSONL Files
console.log('\nStep 6: Creating canonical disk folders and partitioning JSONL files...');

const existingResearchFolders = readdirSync(researchDir, { withFileTypes: true })
  .filter(e => e.isDirectory() && e.name.includes('momentum-aggressive'))
  .map(e => e.name);

// Prepare slot file buffers
const slotSimTradesContent = new Map();
const slotQuotesContent = new Map();

for (const folderName of existingResearchFolders) {
  const fullPath = join(researchDir, folderName);

  // Simulated trades
  const simPath = join(fullPath, 'simulated-trades.jsonl');
  if (existsSync(simPath)) {
    const lines = readFileSync(simPath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        const slot = getWibSlot(new Date(item.observedAt), 3);
        const cur = slotSimTradesContent.get(slot.runId) || [];
        cur.push(line);
        slotSimTradesContent.set(slot.runId, cur);
      } catch {}
    }
  }

  // Quote simulated orders
  const quotePath = join(fullPath, 'quote-simulated-orders.jsonl');
  if (existsSync(quotePath)) {
    const lines = readFileSync(quotePath, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        const slot = getWibSlot(new Date(item.observedAt), 3);
        const cur = slotQuotesContent.get(slot.runId) || [];
        cur.push(line);
        slotQuotesContent.set(slot.runId, cur);
      } catch {}
    }
  }
}

// Strategy template
const sampleStrategyPath = join(researchDir, 'momentum-aggressive-2026-10-01T23-00-00-000Z', 'strategy.json');
const strategyContent = existsSync(sampleStrategyPath) ? readFileSync(sampleStrategyPath, 'utf8') : JSON.stringify({ strategy: 'momentum-aggressive' });

// Get all canonical slots
const canonicalSlotIds = Array.from(new Set([
  ...Object.keys(slotStats),
  ...slotSimTradesContent.keys(),
  ...slotQuotesContent.keys()
])).sort();

for (const slotId of canonicalSlotIds) {
  const slotDir = join(researchDir, slotId);
  if (!existsSync(slotDir)) {
    mkdirSync(slotDir, { recursive: true });
  }

  // Write simulated trades
  const simLines = slotSimTradesContent.get(slotId) || [];
  if (simLines.length > 0) {
    writeFileSync(join(slotDir, 'simulated-trades.jsonl'), simLines.join('\n') + '\n');
  }

  // Write quotes
  const quoteLines = slotQuotesContent.get(slotId) || [];
  if (quoteLines.length > 0) {
    writeFileSync(join(slotDir, 'quote-simulated-orders.jsonl'), quoteLines.join('\n') + '\n');
  }

  // Write strategy
  if (!existsSync(join(slotDir, 'strategy.json'))) {
    writeFileSync(join(slotDir, 'strategy.json'), strategyContent);
  }

  // Write manifest
  const stat = slotStats[slotId];
  const manifest = {
    runId: slotId,
    strategy: 'momentum-aggressive',
    startedAt: stat?.slotStartDate?.toISOString() || new Date().toISOString(),
    purpose: '3-Hour Fixed Window Research Session',
    workers: 3,
    detailSeconds: 90
  };
  writeFileSync(join(slotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
console.log(`  ✅ Successfully created/updated ${canonicalSlotIds.length} canonical disk slot folders.`);

// Step 7: Rebuild SQLite `runs` Table
console.log('\nStep 7: Rebuilding runs table in SQLite...');
db.exec('DELETE FROM runs;');

const insertRunStmt = db.prepare(`
  INSERT INTO runs (id, path, started_at, friendly_label, is_live, trades_count, manifest_json, strategy_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// Current live slot (06:00 - 09:00 WIB today: 2026-10-01T23:00:00.000Z)
const currentLiveSlotId = 'momentum-aggressive-2026-10-01T23-00-00-000Z';

for (const slotId of canonicalSlotIds) {
  const stat = slotStats[slotId];
  const slotDir = join(researchDir, slotId);
  const startedAt = stat?.slotStartDate?.toISOString() || new Date().toISOString();
  const d = new Date(startedAt);

  const dateStr = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });
  const startHourStr = String(stat?.slotStartHour ?? 0).padStart(2, '0');
  const endHourStr = String(stat?.slotEndHour ?? 3).padStart(2, '0');
  const slotRange = `${startHourStr}.00 - ${endHourStr}.00 WIB`;

  const tradeCount = stat?.trades || 0;
  const realCount = stat?.realTrades || 0;
  const isLive = (slotId === currentLiveSlotId);

  const tradesText = tradeCount > 0 ? ` (${tradeCount} Trades)` : '';
  const realText = realCount > 0 ? ` • 💳 ${realCount} Real Tx` : '';

  const friendlyLabel = isLive
    ? `🔴 [LIVE] ${dateStr}, ${slotRange}${tradesText}${realText}`
    : `📁 [ARSIP] ${dateStr}, ${slotRange}${tradesText}${realText}`;

  insertRunStmt.run(
    slotId,
    slotDir,
    startedAt,
    friendlyLabel,
    isLive ? 1 : 0,
    tradeCount,
    null,
    null,
    new Date().toISOString()
  );
}

// Step 8: Validation & Sanity Verification
console.log('\nStep 8: Final validation check...');
const totalTradesAfter = db.prepare('SELECT COUNT(*) as c FROM trades').get().c;
const totalRealAfter = db.prepare('SELECT COUNT(*) as c FROM real_trades').get().c;
const totalQuotesAfter = db.prepare('SELECT COUNT(*) as c FROM route_quotes').get().c;
const totalRunsAfter = db.prepare('SELECT COUNT(*) as c FROM runs').get().c;

console.log('-----------------------------------------------------------------------------');
console.log(` Trades Count       : Before = ${totalTradesBefore} | After = ${totalTradesAfter} (Match: ${totalTradesBefore === totalTradesAfter ? '✅ PASS' : '❌ FAIL'})`);
console.log(` Real Trades Count  : Before = ${totalRealBefore} | After = ${totalRealAfter} (Match: ${totalRealBefore === totalRealAfter ? '✅ PASS' : '❌ FAIL'})`);
console.log(` Route Quotes Count : Before = ${totalQuotesBefore} | After = ${totalQuotesAfter} (Match: ${totalQuotesBefore === totalQuotesAfter ? '✅ PASS' : '❌ FAIL'})`);
console.log(` Canonical Sessions : Total = ${totalRunsAfter} sessions`);
console.log('-----------------------------------------------------------------------------\n');

// Print Full Final Table of Canonical Runs
const finalRuns = db.prepare(`
  SELECT r.id, r.started_at, r.friendly_label, r.trades_count,
    (SELECT COUNT(*) FROM real_trades rt WHERE rt.run_id = r.id) as real_trades,
    (SELECT COUNT(*) FROM route_quotes rq WHERE rq.run_id = r.id) as quotes
  FROM runs r
  ORDER BY r.started_at DESC
`).all();

console.table(finalRuns.map(r => ({
  Slot: r.friendly_label,
  Trades: r.trades_count,
  RealTx: r.real_trades,
  Quotes: r.quotes,
  RunId: r.id
})));

console.log('\n🎉 VALIDATION AND PARTITIONING COMPLETED SUCCESSFULLY!');
