import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/home/bbliong/project/crypto-bot";
const DB_PATH = join(ROOT, "data", "crypto-bot.sqlite");
const CURATED_JSON_PATH = join(ROOT, "data", "curated-lowcap-smart-wallets.json");
const CDP_URL = "http://127.0.0.1:9223";

// Inisialisasi Database SQLite
function initDb() {
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_daily_profit_audits (
      address TEXT PRIMARY KEY,
      tier_at_audit TEXT NOT NULL,
      total_days INTEGER NOT NULL,
      positive_days INTEGER NOT NULL,
      negative_days INTEGER NOT NULL,
      zero_days INTEGER NOT NULL,
      win_day_rate REAL NOT NULL,
      total_net_pnl REAL NOT NULL,
      m1_days INTEGER NOT NULL,
      m1_positive_days INTEGER NOT NULL,
      m1_negative_days INTEGER NOT NULL,
      m1_win_day_rate REAL NOT NULL,
      m1_net_pnl REAL NOT NULL,
      m2_days INTEGER NOT NULL,
      m2_positive_days INTEGER NOT NULL,
      m2_negative_days INTEGER NOT NULL,
      m2_win_day_rate REAL NOT NULL,
      m2_net_pnl REAL NOT NULL,
      is_ultra INTEGER NOT NULL DEFAULT 0,
      ultra_reason TEXT,
      audited_at TEXT NOT NULL,
      audited_timestamp INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PROCESSED'
    );
    CREATE INDEX IF NOT EXISTS idx_audit_status ON wallet_daily_profit_audits(status);
    CREATE INDEX IF NOT EXISTS idx_audit_ultra ON wallet_daily_profit_audits(is_ultra);
  `);
  return db;
}

// Dapatkan daftar wallet yang sudah selesai diproses dari DB
function getProcessedAddresses(db) {
  const rows = db.prepare("SELECT address FROM wallet_daily_profit_audits WHERE status = 'PROCESSED'").all();
  return new Set(rows.map(r => r.address));
}

// Simpan hasil audit ke DB SQLite
function saveAuditRecord(db, record) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO wallet_daily_profit_audits (
      address, tier_at_audit, total_days, positive_days, negative_days, zero_days,
      win_day_rate, total_net_pnl,
      m1_days, m1_positive_days, m1_negative_days, m1_win_day_rate, m1_net_pnl,
      m2_days, m2_positive_days, m2_negative_days, m2_win_day_rate, m2_net_pnl,
      is_ultra, ultra_reason, audited_at, audited_timestamp, status
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    record.address,
    record.tier_at_audit,
    record.total_days,
    record.positive_days,
    record.negative_days,
    record.zero_days,
    record.win_day_rate,
    record.total_net_pnl,
    record.m1_days,
    record.m1_positive_days,
    record.m1_negative_days,
    record.m1_win_day_rate,
    record.m1_net_pnl,
    record.m2_days,
    record.m2_positive_days,
    record.m2_negative_days,
    record.m2_win_day_rate,
    record.m2_net_pnl,
    record.is_ultra ? 1 : 0,
    record.ultra_reason || "",
    record.audited_at,
    record.audited_timestamp,
    record.status || "PROCESSED"
  );
}

// Random jitter delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomJitter = (minMs, maxMs) => Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

async function main() {
  const args = process.argv.slice(2);
  const targetTierArg = args.find(a => a.startsWith("--tier="))?.split("=")[1]?.toUpperCase();
  const limitArg = args.find(a => a.startsWith("--limit="))?.split("=")[1];
  const targetAddrArg = args.find(a => a.startsWith("--address="))?.split("=")[1];
  const forceFlag = args.includes("--force");

  console.log(`[AUDIT-ULTRA] 🚀 Memulai Auditor Konsistensi Profit GMGN...`);
  console.log(`[AUDIT-ULTRA] Filter: tier=${targetTierArg || 'SSS,SS,S'}, limit=${limitArg || 'unlimited'}, force=${forceFlag}`);

  const db = initDb();
  const processedFromDb = getProcessedAddresses(db);
  console.log(`[AUDIT-ULTRA] Database SQLite: ${processedFromDb.size} wallet sudah berstatus PROCESSED`);

  if (!existsSync(CURATED_JSON_PATH)) {
    console.error(`[AUDIT-ULTRA] ❌ File master dataset tidak ditemukan: ${CURATED_JSON_PATH}`);
    process.exit(1);
  }

  const rawDataset = JSON.parse(readFileSync(CURATED_JSON_PATH, "utf8"));
  const wallets = rawDataset.wallets || rawDataset;

  // Sync SQLite processed records into JSON dataset if missing
  const allDbAudits = db.prepare("SELECT * FROM wallet_daily_profit_audits WHERE status = 'PROCESSED'").all();
  const dbAuditMap = new Map(allDbAudits.map(r => [r.address, r]));
  let jsonSynced = false;
  for (const w of wallets) {
    const audit = dbAuditMap.get(w.address);
    if (audit) {
      if (w.dailyAuditStatus !== 'PROCESSED' || (audit.is_ultra && w.tier !== 'ULTRA')) {
        w.dailyAuditStatus = 'PROCESSED';
        w.dailyAuditAt = audit.audited_at;
        w.winDayRate = audit.win_day_rate;
        w.posDays60d = audit.positive_days;
        w.negDays60d = audit.negative_days;
        w.pnl60d = audit.total_net_pnl;
        w.isUltra = audit.is_ultra === 1;
        if (audit.is_ultra === 1) {
          w.tier = 'ULTRA';
        }
        jsonSynced = true;
      }
    }
  }
  if (jsonSynced) {
    writeFileSync(CURATED_JSON_PATH, JSON.stringify(rawDataset, null, 2), "utf8");
    console.log(`[AUDIT-ULTRA] 🔄 Sinkronisasi status audit dari SQLite ke JSON berhasil.`);
  }

  // Filter kandidat yang relevan
  let candidates = [];
  if (targetAddrArg) {
    const found = wallets.find(w => w.address === targetAddrArg);
    if (!found) {
      console.error(`[AUDIT-ULTRA] ❌ Address target ${targetAddrArg} tidak ditemukan di master dataset.`);
      process.exit(1);
    }
    candidates = [found];
  } else {
    // Target prioritas: SSS, SS, S (serta ULTRA jika ada)
    const allowedTiers = targetTierArg ? [targetTierArg] : ["SSS", "SS", "S", "ULTRA"];
    candidates = wallets.filter(w => allowedTiers.includes(w.tier));

    // Urutkan prioritas: SSS dulu, lalu SS, lalu S
    const tierPriority = { ULTRA: 0, SSS: 1, SS: 2, S: 3 };
    candidates.sort((a, b) => (tierPriority[a.tier] ?? 99) - (tierPriority[b.tier] ?? 99));
  }

  console.log(`[AUDIT-ULTRA] Total populasi kandidat target: ${candidates.length} wallet`);

  // Saring hanya yang BELUM diproses (incremental check)
  const pendingWallets = candidates.filter(w => {
    if (forceFlag) return true;
    const isProcessedDb = processedFromDb.has(w.address);
    const isProcessedJson = w.dailyAuditStatus === "PROCESSED";
    return !isProcessedDb && !isProcessedJson;
  });

  console.log(`[AUDIT-ULTRA] Antrean wallet yang BELUM diproses: ${pendingWallets.length} wallet`);
  if (pendingWallets.length === 0) {
    console.log(`[AUDIT-ULTRA] ✅ Semua wallet kandidat sudah diaudit dan ter-flagging PROCESSED di DB. Tidak ada tugas baru.`);
    db.close();
    process.exit(0);
  }

  const limit = limitArg ? parseInt(limitArg, 10) : pendingWallets.length;
  const executionBatch = pendingWallets.slice(0, limit);
  console.log(`[AUDIT-ULTRA] Akan memproses ${executionBatch.length} wallet pada siklus ini...`);

  // Connect ke Chrome CDP port 9223
  console.log(`[AUDIT-ULTRA] Menghubungkan ke Chrome CDP: ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL).catch(err => {
    console.error(`[AUDIT-ULTRA] ❌ Gagal menghubungkan ke Chrome CDP port 9223: ${err.message}`);
    process.exit(1);
  });

  const context = browser.contexts()[0];
  let page = context?.pages().find(p => p.url().includes("gmgn.ai"));
  if (!page) {
    page = context?.pages()[0] || await context?.newPage();
    console.log("[AUDIT-ULTRA] Membuka halaman GMGN...");
    await page.goto("https://gmgn.ai/?chain=sol", { waitUntil: "domcontentloaded", timeout: 30000 });
  }

  console.log(`[AUDIT-ULTRA] Browser aktif di tab: ${page.url()}`);

  // Rentang waktu 60 hari:
  // Sep 2026: 1788220800 s/d 1790812799 (Month 1)
  // Oct 2026: 1790812800 s/d 1793491199 (Month 2)
  const START_AT = 1788220800; // 2026-09-01 00:00:00 UTC
  const END_AT = 1793491199;   // 2026-10-31 23:59:59 UTC
  const M1_END = 1790812799;   // 2026-09-30 23:59:59 UTC

  let processedCount = 0;
  let ultraPromotedCount = 0;
  let batchSinceLastPause = 0;

  for (let i = 0; i < executionBatch.length; i++) {
    const w = executionBatch[i];
    const progress = `[${i + 1}/${executionBatch.length}]`;

    console.log(`\n${progress} Memeriksa ${w.address} (Tier Asal: ${w.tier})...`);

    let retryCount = 0;
    let apiResult = null;

    while (retryCount < 3) {
      apiResult = await page.evaluate(async ({ address, start_at, end_at }) => {
        try {
          const res = await fetch("https://gmgn.ai/pf/api/v1/wallets/sol/daily_profits", {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              wallet_addresses: [address],
              start_at,
              end_at
            })
          });

          if (!res.ok) {
            return { code: res.status, msg: `HTTP ${res.status}` };
          }
          return await res.json();
        } catch (e) {
          return { code: -1, msg: e.message };
        }
      }, { address: w.address, start_at: START_AT, end_at: END_AT });

      if (apiResult && apiResult.code === 0 && Array.isArray(apiResult.data?.list)) {
        break;
      }

      // Handle rate limit atau Cloudflare glitch
      if (apiResult?.code === 429 || apiResult?.code === 403) {
        console.warn(`[AUDIT-ULTRA] ⚠️ Respon status ${apiResult.code} (${apiResult.msg}). Istirahat 25 detik sebelum retry...`);
        await sleep(25000);
        retryCount++;
      } else {
        console.warn(`[AUDIT-ULTRA] ⚠️ Gagal fetch (${apiResult?.code || 'unknown'}: ${apiResult?.msg}). Retry #${retryCount + 1}...`);
        await sleep(5000);
        retryCount++;
      }
    }

    const list = apiResult?.data?.list || [];

    // Analisis data harian M1 (Sep) dan M2 (Oct)
    let m1Pos = 0, m1Neg = 0, m1Zero = 0, m1Pnl = 0, m1Days = 0;
    let m2Pos = 0, m2Neg = 0, m2Zero = 0, m2Pnl = 0, m2Days = 0;
    let totalPos = 0, totalNeg = 0, totalZero = 0, totalPnl = 0;

    for (const item of list) {
      const p = parseFloat(item.total_profit || "0");
      const d = item.date;

      totalPnl += p;
      if (p > 0) totalPos++;
      else if (p < 0) totalNeg++;
      else totalZero++;

      if (d <= M1_END) {
        m1Days++;
        m1Pnl += p;
        if (p > 0) m1Pos++;
        else if (p < 0) m1Neg++;
        else m1Zero++;
      } else {
        m2Days++;
        m2Pnl += p;
        if (p > 0) m2Pos++;
        else if (p < 0) m2Neg++;
        else m2Zero++;
      }
    }

    const m1Active = m1Pos + m1Neg;
    const m2Active = m2Pos + m2Neg;
    const totalActive = totalPos + totalNeg;

    const m1WinRate = m1Active > 0 ? (m1Pos / m1Active) * 100 : 0;
    const m2WinRate = m2Active > 0 ? (m2Pos / m2Active) * 100 : 0;
    const totalWinRate = totalActive > 0 ? (totalPos / totalActive) * 100 : 0;

    // Evaluasi Standar Tier ULTRA:
    // 1. Win-day rate M1 >= 65% dan M2 >= 65%
    // 2. Net profit M1 > $0 dan M2 > $0 (kedua bulan cuan)
    // 3. Akumulasi cuan 60d >= $5,000 USD
    // 4. Hari aktif minimal >= 8 hari per bulan
    const reasons = [];
    if (m1WinRate < 65) reasons.push(`M1 WR rendah (${m1WinRate.toFixed(1)}%)`);
    if (m2WinRate < 65) reasons.push(`M2 WR rendah (${m2WinRate.toFixed(1)}%)`);
    if (m1Pnl <= 0) reasons.push(`M1 tekor ($${Math.round(m1Pnl)})`);
    if (m2Pnl <= 0) reasons.push(`M2 tekor ($${Math.round(m2Pnl)})`);
    if (totalPnl < 5000) reasons.push(`Total PnL 60d < $5k ($${Math.round(totalPnl)})`);
    if (m1Active < 8) reasons.push(`M1 hari aktif sedikit (${m1Active}d)`);
    if (m2Active < 8) reasons.push(`M2 hari aktif sedikit (${m2Active}d)`);

    const isUltra = reasons.length === 0 && list.length > 0;
    const nowIso = new Date().toISOString();
    const nowSec = Math.floor(Date.now() / 1000);

    const record = {
      address: w.address,
      tier_at_audit: w.tier,
      total_days: list.length,
      positive_days: totalPos,
      negative_days: totalNeg,
      zero_days: totalZero,
      win_day_rate: parseFloat(totalWinRate.toFixed(1)),
      total_net_pnl: Math.round(totalPnl),
      m1_days: m1Days,
      m1_positive_days: m1Pos,
      m1_negative_days: m1Neg,
      m1_win_day_rate: parseFloat(m1WinRate.toFixed(1)),
      m1_net_pnl: Math.round(m1Pnl),
      m2_days: m2Days,
      m2_positive_days: m2Pos,
      m2_negative_days: m2Neg,
      m2_win_day_rate: parseFloat(m2WinRate.toFixed(1)),
      m2_net_pnl: Math.round(m2Pnl),
      is_ultra: isUltra ? 1 : 0,
      ultra_reason: isUltra ? "QUALIFIED_ULTRA" : reasons.join(", "),
      audited_at: nowIso,
      audited_timestamp: nowSec,
      status: list.length > 0 ? "PROCESSED" : "NO_DATA"
    };

    // 1. Simpan ke SQLite
    saveAuditRecord(db, record);

    // 2. Update object wallet di dataset in-memory
    w.dailyAuditStatus = record.status;
    w.dailyAuditAt = nowIso;
    w.winDayRate = record.win_day_rate;
    w.posDays60d = totalPos;
    w.negDays60d = totalNeg;
    w.pnl60d = record.total_net_pnl;
    w.isUltra = isUltra;
    if (isUltra) {
      w.tier = "ULTRA";
      ultraPromotedCount++;
      console.log(`  🌟 PROMOSI TIER ULTRA! Win-Day: ${totalWinRate.toFixed(1)}% (${totalPos}/${totalActive}d) | Cuan: +$${Math.round(totalPnl).toLocaleString()}`);
    } else {
      console.log(`  📊 Audit Selesai: Win-Day: ${totalWinRate.toFixed(1)}% (${totalPos}/${totalActive}d) | Cuan: $${Math.round(totalPnl).toLocaleString()} | Status: Tetap ${w.tier} (${record.ultra_reason})`);
    }

    processedCount++;
    batchSinceLastPause++;

    // Simpan master JSON setiap 5 wallet atau di akhir
    if (processedCount % 5 === 0 || i === executionBatch.length - 1) {
      writeFileSync(CURATED_JSON_PATH, JSON.stringify(rawDataset, null, 2), "utf8");
    }

    // Pacing anti-rate limit
    if (i < executionBatch.length - 1) {
      if (batchSinceLastPause >= 10) {
        const batchCooldown = randomJitter(8000, 12000);
        console.log(`[AUDIT-ULTRA] ☕ Batch 10 request selesai. Cooldown sejenak ${batchCooldown / 1000}s...`);
        await sleep(batchCooldown);
        batchSinceLastPause = 0;
      } else {
        const jitter = randomJitter(2500, 4500);
        process.stdout.write(`  ⏳ Pacing ${jitter}ms... `);
        await sleep(jitter);
        process.stdout.write(`ok\n`);
      }
    }
  }

  // Final flush ke master JSON
  writeFileSync(CURATED_JSON_PATH, JSON.stringify(rawDataset, null, 2), "utf8");
  console.log(`\n================ RINGKASAN AUDIT SIKLUS INI ================`);
  console.log(`Total wallet diproses: ${processedCount}`);
  console.log(`Promosi ke Tier ULTRA: ${ultraPromotedCount}`);
  console.log(`Semua hasil tersimpan permanen di SQLite: ${DB_PATH}`);
  console.log(`Master JSON terupdate dan ter-flagging PROCESSED: ${CURATED_JSON_PATH}`);

  db.close();
  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error(`[AUDIT-ULTRA] Fatal error:`, err);
  process.exit(1);
});
