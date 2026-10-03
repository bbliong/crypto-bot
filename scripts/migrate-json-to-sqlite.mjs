#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCryptoDb, setSetting, DEFAULT_DB_PATH } from './crypto-db.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const researchDir = join(projectRoot, 'research');
const autoBuyConfigFile = join(projectRoot, 'config', 'autobuy-settings.json');

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

function formatWibDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
    const wibTime = new Date(d.getTime() + WIB_OFFSET_MS);
    const hour = wibTime.getUTCHours();
    const minute = wibTime.getUTCMinutes();
    const dateStr = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });
    const slotStart = Math.floor(hour / 3) * 3;
    const slotEnd = slotStart + 3;
    const slotRange = `${String(slotStart).padStart(2, '0')}.00 - ${String(slotEnd).padStart(2, '0')}.00 WIB`;
    const startDetail = (minute === 0 && hour % 3 === 0)
      ? ''
      : ` (mulai ${d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false })})`;
    return `${dateStr}, ${slotRange}${startDetail}`;
  } catch {
    return String(iso);
  }
}

async function migrateAll() {
  console.log('=============================================================================');
  console.log('       🚀 MEMULAI MIGRASI DATA RUN CRYPTO BOT KE SQLITE 🚀                   ');
  console.log('=============================================================================');
  console.log(` Target Database: ${DEFAULT_DB_PATH}`);

  const db = initCryptoDb();
  const startTime = Date.now();

  // 1. Migrasi Config Settings
  console.log('\n[1/3] Migrasi Konfigurasi Auto-Buy & App Settings...');
  if (existsSync(autoBuyConfigFile)) {
    const cfg = readJsonFile(autoBuyConfigFile);
    if (cfg) {
      setSetting('autobuy_settings', cfg);
      console.log('  ✅ autobuy-settings.json berhasil disimpan ke SQLite table `app_settings`');
    }
  } else {
    console.log('  ⚠️ File autobuy-settings.json tidak ditemukan, menggunakan default');
  }

  // 2. Scan All Runs
  console.log('\n[2/3] Memindai Folder Run di `research/`...');
  if (!existsSync(researchDir)) {
    console.error('  ❌ Direktori research/ tidak ditemukan!');
    return;
  }

  const entries = readdirSync(researchDir, { withFileTypes: true });
  const runFolders = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.includes('momentum') && !entry.name.includes('pump-band')) continue;
    const folder = join(researchDir, entry.name);
    let mtime = 0;
    try { mtime = statSync(folder).mtimeMs; } catch {}
    runFolders.push({ id: entry.name, path: folder, mtime });
  }

  runFolders.sort((a, b) => b.mtime - a.mtime);
  console.log(`  Ditemukan ${runFolders.length} run sesi trading/riset.`);

  // 3. Batch Ingest into SQLite using Transactions
  console.log('\n[3/3] Memproses dan Menyimpan ke SQLite...');

  let totalMigratedRuns = 0;
  let totalMigratedTrades = 0;
  let totalMigratedQuotes = 0;
  let totalMigratedRealTrades = 0;

  const insertRunStmt = db.prepare(`
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
  `);

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

  const insertQuoteStmt = db.prepare(`
    INSERT INTO route_quotes (
      run_id, observed_at, mint, symbol, name, type, type_label, flow_text,
      signal_price_usd, route_implied_token_price_usd, slip_percent, latency_ms,
      input_amount_base_units, route_token_amount, raw_quote_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

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

  db.exec('BEGIN TRANSACTION;');

  try {
    for (let i = 0; i < runFolders.length; i++) {
      const r = runFolders[i];
      const isLive = (i === 0);
      const manifest = readJsonFile(join(r.path, 'manifest.json'));
      const strategy = readJsonFile(join(r.path, 'strategy.json'));
      const simTrades = readJsonLines(join(r.path, 'simulated-trades.jsonl'));
      const routeQuotes = readJsonLines(join(r.path, 'quote-simulated-orders.jsonl'));
      const ledgerRows = readJsonLines(join(r.path, 'live-trade-ledger.jsonl'));
      const eventRows = readJsonLines(join(r.path, 'events.jsonl'));
      const screenedTokens = readJsonLines(join(r.path, 'screened-tokens.jsonl'));
      const tokenSummaries = readJsonLines(join(r.path, 'token-summary.jsonl'));

      let startedAt = manifest?.startedAt;
      if (!startedAt) {
        const match = r.id.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
        if (match) startedAt = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
        else startedAt = new Date(r.mtime).toISOString();
      }

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

      // Quotes mapping
      const quotesByPos = new Map();
      for (const q of routeQuotes) {
        if (q.positionId) {
          const list = quotesByPos.get(q.positionId) || [];
          list.push(q);
          quotesByPos.set(q.positionId, list);
        }
      }

      let runClosedCount = 0;

      for (const buy of buys) {
        const lane = buy.paperLane || 'control';
        const laneLabel = lane === 'r5-band' ? 'Momentum R5 Band' : lane === 'momentum-v3' ? 'Momentum V3' : lane === 'momentum-v2' ? 'Momentum V2' : lane === 'aggressive-wide' ? 'Wide Aggressive' : lane === 'aggressive-optimal' ? 'Optimal Aggressive' : lane === 'aggressive-safe' ? 'Safe Aggressive' : 'Raw Aggressive';
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

        const exitPriceUsd = sell ? (sell.exit?.priceUsd ?? sell.timing?.priceUsd ?? sell.decision?.priceUsd ?? sell.exitPriceUsd ?? null) : null;
        if (sell) {
          runClosedCount++;
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

        insertTradeStmt.run(
          posId,
          r.id,
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
        totalMigratedTrades++;
      }

      // Process Route Quotes (Save latest 200 per run to keep DB lean)
      for (const q of routeQuotes.slice(-200)) {
        const meta = metadataByMint.get(q.mint);
        const isBuy = q.type === 'QUOTE_BUY_COMPARISON';
        const isSell = q.type === 'QUOTE_SELL_COMPARISON';
        const slip = isBuy ? q.routeVsSocketPricePercent : (q.routeVsSocketProceedsPercent ?? q.routeVsSocketPricePercent);
        const inSol = q.inputAmountBaseUnits && isBuy ? (Number(q.inputAmountBaseUnits) / 1e9).toFixed(4) + ' SOL' : null;
        const outTokens = q.routeTokenAmount ? Math.round(q.routeTokenAmount).toLocaleString() : null;
        const inTokens = q.inputAmountBaseUnits && isSell ? Math.round(Number(q.inputAmountBaseUnits) / 10**(q.tokenDecimals || 6)).toLocaleString() : null;
        const outSol = q.quote?.outAmount && isSell ? (Number(q.quote.outAmount) / 1e9).toFixed(4) + ' SOL' : null;
        const flowText = isBuy 
          ? (inSol && outTokens ? `${inSol} → ${outTokens} Tok` : '—')
          : (inTokens && outSol ? `${inTokens} Tok → ${outSol}` : '—');

        insertQuoteStmt.run(
          r.id,
          q.observedAt,
          q.mint,
          meta?.symbol || q.mint.slice(0, 6),
          meta?.name || meta?.symbol || q.mint.slice(0, 6),
          q.type,
          isBuy ? 'BUY ROUTE' : isSell ? 'SELL ROUTE' : q.type,
          flowText,
          q.signalPriceUsd ?? null,
          q.routeImpliedTokenPriceUsd ?? null,
          slip != null ? Number(Number(slip).toFixed(2)) : null,
          q.latencyMs ?? null,
          q.inputAmountBaseUnits || null,
          q.routeTokenAmount || null,
          q.quote ? JSON.stringify(q.quote) : null
        );
        totalMigratedQuotes++;
      }

      // Process Real Trades from live-trade-ledger
      const buyOrders = [];
      const sellOrders = [];
      const walletSnapshotsByMint = new Map();

      for (const row of ledgerRows) {
        if (row.type === 'LIVE_ORDER_SUBMITTED') {
          if (row.side === 'BUY') buyOrders.push(row);
          else if (row.side === 'SELL') sellOrders.push(row);
        } else if (row.type === 'GMGN_WALLETSTAT_SNAPSHOT') {
          if (row.token) {
            const list = walletSnapshotsByMint.get(row.token) || [];
            list.push(row);
            walletSnapshotsByMint.set(row.token, list);
          }
        }
      }

      for (const ev of eventRows) {
        if (ev.type === 'BROWSER_BUY_SUBMITTED') {
          if (!buyOrders.some(b => b.mint === ev.mint)) {
            buyOrders.push({
              type: 'LIVE_ORDER_SUBMITTED', side: 'BUY', mint: ev.mint, paperLane: ev.paperLane, observedAt: ev.observedAt,
              orderId: ev.result?.orderId, hash: ev.result?.hash, ok: true, status: ev.result?.status, code: ev.result?.code,
              message: ev.result?.message, stakeUsd: ev.stakeUsd || 0.5,
            });
          }
        } else if (ev.type === 'BROWSER_SELL_SUBMITTED') {
          if (!sellOrders.some(s => s.mint === ev.mint)) {
            sellOrders.push({
              type: 'LIVE_ORDER_SUBMITTED', side: 'SELL', mint: ev.mint, paperLane: ev.paperLane, originLane: ev.originLane, observedAt: ev.observedAt,
              orderId: ev.result?.orderId, hash: ev.result?.hash, ok: true, status: ev.result?.status, code: ev.result?.code, message: ev.result?.message,
            });
          }
        }
      }

      for (const buy of buyOrders) {
        const mint = buy.mint;
        const meta = metadataByMint.get(mint) || {};
        const symbol = meta.symbol || buy.symbol || mint.slice(0, 6);
        const name = meta.name || symbol;
        const lane = buy.originLane || buy.paperLane || 'aggressive-optimal';
        const laneLabel = lane === 'r5-band' ? 'Momentum R5 Band' : lane === 'momentum-v3' ? 'Momentum V3' : lane === 'momentum-v2' ? 'Momentum V2' : lane === 'aggressive-wide' ? 'Wide Aggressive' : lane === 'aggressive-optimal' ? 'Optimal Aggressive' : lane === 'aggressive-safe' ? 'Safe Aggressive' : 'Raw Aggressive';

        const matchingSell = sellOrders.find(s => s.mint === mint && s.observedAt >= buy.observedAt);
        const snaps = walletSnapshotsByMint.get(mint) || [];
        const postBuySnap = snaps.find(s => s.stage === 'POST_BUY');
        const postSellSnap = [...snaps].reverse().find(s => s.stage === 'POST_SELL' || s.stage === 'RETRY_SELL');

        const walletBuyCost = postSellSnap?.historyBoughtCostUsd ?? postBuySnap?.historyBoughtCostUsd ?? buy.stakeUsd ?? 0.5;
        const walletSoldIncome = postSellSnap?.historySoldIncomeUsd ?? null;
        const walletPnlUsd = postSellSnap?.grossPnlUsd ?? (walletSoldIncome != null ? walletSoldIncome - walletBuyCost : null);
        const walletPnlPercent = postSellSnap?.grossPnlPercent ?? (walletPnlUsd != null && walletBuyCost > 0 ? (walletPnlUsd / walletBuyCost) * 100 : null);

        insertRealTradeStmt.run(
          `${r.id}:${mint}:${buy.observedAt}`,
          r.id,
          mint,
          symbol,
          name,
          lane,
          laneLabel,
          matchingSell ? (matchingSell.ok ? 'COMPLETED' : 'SELL_FAILED') : (buy.ok ? 'HOLDING' : 'BUY_FAILED'),
          buy.observedAt,
          buy.ok ? 1 : 0,
          buy.status || null,
          buy.code || null,
          buy.message || null,
          buy.orderId || null,
          buy.hash || null,
          buy.hash ? `https://solscan.io/tx/${buy.hash}` : null,
          buy.stakeUsd || 0.5,
          buy.tokenPriceUsd || null,
          buy.acquiredAmount || null,
          buy.acquiredDecimals || null,
          matchingSell?.observedAt || null,
          matchingSell?.ok ? 1 : 0,
          matchingSell?.status || null,
          matchingSell?.code || null,
          matchingSell?.message || null,
          matchingSell?.orderId || null,
          matchingSell?.hash || null,
          matchingSell?.hash ? `https://solscan.io/tx/${matchingSell.hash}` : null,
          matchingSell?.inputAmount || null,
          matchingSell?.tokenPriceUsd || null,
          matchingSell ? Math.max(1, Math.round((matchingSell.observedAt - buy.observedAt) / 1000)) : 0,
          null,
          walletPnlPercent,
          null,
          walletBuyCost,
          walletSoldIncome,
          walletPnlUsd,
          snaps.length > 0 ? JSON.stringify(snaps) : null,
          null,
          null
        );
        totalMigratedRealTrades++;
      }

      // Upsert Run Entry
      const dateFormatted = formatWibDate(startedAt);
      const tradesText = runClosedCount > 0 ? ` (${runClosedCount} Trades)` : '';
      const friendlyLabel = isLive 
        ? `🔴 [LIVE] ${dateFormatted}${tradesText}` 
        : `📁 [ARSIP] ${dateFormatted}${tradesText}`;

      insertRunStmt.run(
        r.id,
        r.path,
        startedAt,
        friendlyLabel,
        isLive ? 1 : 0,
        runClosedCount,
        manifest ? JSON.stringify(manifest) : null,
        strategy ? JSON.stringify(strategy) : null,
        new Date().toISOString()
      );
      totalMigratedRuns++;
    }

    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    console.error('❌ Terjadi kesalahan saat migrasi:', err);
    throw err;
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('\n=============================================================================');
  console.log('       ✨ MIGRASI DATA RUN KE SQLITE SELESAI DENGAN SUKSES! ✨                ');
  console.log('=============================================================================');
  console.log(` • Total Runs Termigrasi        : ${totalMigratedRuns} run`);
  console.log(` • Total Simulated Trades       : ${totalMigratedTrades} trade`);
  console.log(` • Total Real Executed Trades   : ${totalMigratedRealTrades} trade`);
  console.log(` • Total Route Quotes           : ${totalMigratedQuotes} quote`);
  console.log(` • Waktu Penyelesaian           : ${durationSec} detik`);
  console.log(` • Lokasi SQLite File           : ${DEFAULT_DB_PATH}`);
  console.log('=============================================================================');
}

migrateAll().catch(err => {
  console.error(err);
  process.exit(1);
});
