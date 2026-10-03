import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const runDir = "research/momentum-aggressive-2026-09-30T14-54-29-909Z";
const simTradesFile = join(runDir, "simulated-trades.jsonl");
const quotesFile = join(runDir, "quote-simulated-orders.jsonl");

if (!existsSync(simTradesFile)) {
  console.error("File simulated-trades.jsonl not found:", simTradesFile);
  process.exit(1);
}

const simulatedTrades = readFileSync(simTradesFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
const routeQuotes = existsSync(quotesFile) ? readFileSync(quotesFile, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];

const quotesByPosition = new Map();
for (const q of routeQuotes) {
  if (q.positionId) {
    const cur = quotesByPosition.get(q.positionId) || [];
    cur.push(q);
    quotesByPosition.set(q.positionId, cur);
  }
}

function simulateMode(filterLane, label) {
  const events = simulatedTrades
    .filter(t => !filterLane || t.paperLane === filterLane)
    .sort((a, b) => a.observedAt - b.observedAt);

  let cash = 20.0;
  const openPositions = new Map(); // posId -> position
  let maxConcurrent = 0;
  let maxCommittedUsd = 0;
  let executedBuys = 0;
  let executedSells = 0;
  let skippedBuys = 0;
  let minCash = 20.0;
  let minEquity = 20.0;
  let peakEquity = 20.0;
  let maxDrawdown = 0;
  const ledger = [];

  for (const e of events) {
    const timeStr = new Date(e.observedAt).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
    const workerId = e.worker || (e.timing ? e.timing.worker : 1);

    if (e.type === "SIMULATED_BUY") {
      if (cash >= 5.0) {
        cash -= 5.0;
        executedBuys++;
        const posInfo = {
          posId: e.positionId,
          mint: e.mint,
          symbol: e.metadata?.symbol || e.mint.slice(0, 6),
          lane: e.paperLane,
          worker: workerId,
          buyPrice: e.entryPriceUsd,
          buyTime: e.observedAt,
          stake: 5.0
        };
        openPositions.set(e.positionId, posInfo);

        const concurrent = openPositions.size;
        const committedUsd = concurrent * 5.0;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        if (committedUsd > maxCommittedUsd) maxCommittedUsd = committedUsd;
        if (cash < minCash) minCash = cash;

        const currentEquity = cash + committedUsd;
        if (currentEquity < minEquity) minEquity = currentEquity;
        if (currentEquity > peakEquity) peakEquity = currentEquity;
        const dd = (peakEquity - currentEquity) / peakEquity * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        const activeWorkersList = Array.from(openPositions.values()).map(p => ({
          worker: p.worker,
          symbol: p.symbol,
          lane: p.lane
        }));

        ledger.push({
          type: "BUY",
          timestamp: e.observedAt,
          time: timeStr,
          worker: workerId,
          lane: e.paperLane,
          symbol: posInfo.symbol,
          amount: -5.0,
          pnl: null,
          ret: null,
          cash: Number(cash.toFixed(2)),
          concurrent,
          committedUsd,
          activeWorkers: activeWorkersList,
          totalEquity: Number(currentEquity.toFixed(2)),
          reason: e.entryGate?.reason || "ENTRY_PASSED",
          note: `Worker ${workerId} BUY $5.00 • Modal terpakai: $${committedUsd.toFixed(2)} (${concurrent} worker) • Sisa kas: $${cash.toFixed(2)}`
        });
      } else {
        skippedBuys++;
        const concurrent = openPositions.size;
        const committedUsd = concurrent * 5.0;
        const currentEquity = cash + committedUsd;
        const activeWorkersList = Array.from(openPositions.values()).map(p => ({
          worker: p.worker,
          symbol: p.symbol,
          lane: p.lane
        }));

        ledger.push({
          type: "SKIPPED_BUY",
          timestamp: e.observedAt,
          time: timeStr,
          worker: workerId,
          lane: e.paperLane,
          symbol: e.metadata?.symbol || e.mint.slice(0, 6),
          amount: 0,
          pnl: null,
          ret: null,
          cash: Number(cash.toFixed(2)),
          concurrent,
          committedUsd,
          activeWorkers: activeWorkersList,
          totalEquity: Number(currentEquity.toFixed(2)),
          reason: `Kas sisa $${cash.toFixed(2)} (< $5.00)`,
          note: `Worker ${workerId} lewati buy: Kas sisa $${cash.toFixed(2)} (< $5.00). Seluruh modal $${committedUsd.toFixed(2)} sedang aktif di ${concurrent} worker.`
        });
      }
    } else if (e.type === "SIMULATED_SELL") {
      if (openPositions.has(e.positionId)) {
        executedSells++;
        const pos = openPositions.get(e.positionId);
        openPositions.delete(e.positionId);

        const buyQuotes = quotesByPosition.get(e.positionId) || [];
        const buyQuote = buyQuotes.find(q => q.type === "QUOTE_BUY_COMPARISON");
        const sellQuote = buyQuotes.find(q => q.type === "QUOTE_SELL_COMPARISON");

        const socketReturn = e.pnlPercent ?? ((e.exitPriceUsd / pos.buyPrice - 1) * 100);
        let realReturn = socketReturn - 3.5;
        const inUsd = Number(buyQuote?.quote?.amountInUsd || 0);
        const outUsd = Number(sellQuote?.quote?.amountOutUsd || 0);
        if (inUsd > 0 && outUsd > 0) {
          realReturn = ((outUsd / inUsd) - 1) * 100;
        }

        const proceeds = 5.0 * (1 + realReturn / 100);
        const pnl = proceeds - 5.0;
        cash += proceeds;

        const concurrent = openPositions.size;
        const committedUsd = concurrent * 5.0;
        const currentEquity = cash + committedUsd;
        if (cash < minCash) minCash = cash;
        if (currentEquity < minEquity) minEquity = currentEquity;
        if (currentEquity > peakEquity) peakEquity = currentEquity;
        const dd = (peakEquity - currentEquity) / peakEquity * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        const activeWorkersList = Array.from(openPositions.values()).map(p => ({
          worker: p.worker,
          symbol: p.symbol,
          lane: p.lane
        }));

        ledger.push({
          type: "SELL",
          timestamp: e.observedAt,
          time: timeStr,
          worker: pos.worker,
          lane: pos.lane,
          symbol: pos.symbol,
          amount: Number(proceeds.toFixed(2)),
          pnl: Number(pnl.toFixed(2)),
          ret: Number(realReturn.toFixed(1)),
          cash: Number(cash.toFixed(2)),
          concurrent,
          committedUsd,
          activeWorkers: activeWorkersList,
          totalEquity: Number(currentEquity.toFixed(2)),
          reason: e.reason,
          note: `Worker ${pos.worker} SELL ${realReturn >= 0 ? "+" : ""}${realReturn.toFixed(1)}% (PnL: $${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}). Kas kembali bertambah jadi $${cash.toFixed(2)}.`
        });
      }
    }
  }

  const finalEquity = cash + openPositions.size * 5.0;
  return {
    key: filterLane || "all",
    label: label,
    executedBuys,
    executedSells,
    skippedBuys,
    maxConcurrent,
    maxCommittedUsd,
    minCash: Number(minCash.toFixed(2)),
    minEquity: Number(minEquity.toFixed(2)),
    finalCash: Number(cash.toFixed(2)),
    finalEquity: Number(finalEquity.toFixed(2)),
    netProfit: Number((finalEquity - 20).toFixed(2)),
    roiPercent: Number(((finalEquity / 20 - 1) * 100).toFixed(1)),
    maxDrawdown: Number(maxDrawdown.toFixed(1)),
    openRemaining: openPositions.size,
    ledger
  };
}

const allModes = {
  all: simulateMode(null, "🌐 Semua Mode (Portfolio Gabungan 3-Worker)"),
  v3: simulateMode("momentum-v3", "⚡ Momentum V3 (3-Worker)"),
  safe: simulateMode("aggressive-safe", "🟢 Safe Aggressive (3-Worker)"),
  v2: simulateMode("momentum-v2", "🔵 Momentum V2 (3-Worker)"),
  optimal: simulateMode("aggressive-optimal", "🟣 Optimal Aggressive (3-Worker)"),
  wide: simulateMode("aggressive-wide", "🟠 Wide Aggressive (3-Worker)"),
  raw: simulateMode("control", "🔵 Raw Aggressive (Baseline)"),
  r5: simulateMode("r5-band", "🟡 Momentum R5 Band")
};

const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Simulasi Cash-Flow Real-Case Modal $20 USD (3 Worker Parallel)</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #121826;
      --card-border: #1f293d;
      --text: #e2e8f0;
      --text-dim: #94a3b8;
      --green: #00ff88;
      --green-dim: rgba(0, 255, 136, 0.12);
      --red: #ff4d6d;
      --red-dim: rgba(255, 77, 109, 0.12);
      --blue: #00b4d8;
      --blue-dim: rgba(0, 180, 216, 0.12);
      --gold: #ffb703;
      --gold-dim: rgba(255, 183, 3, 0.12);
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px; font-size: 14px; }
    
    .header { margin-bottom: 20px; border-bottom: 1px solid var(--card-border); padding-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
    .header h1 { font-size: 22px; font-weight: 800; color: #fff; margin-bottom: 6px; }
    .header p { color: var(--text-dim); font-size: 13px; max-width: 800px; line-height: 1.5; }
    
    .real-arch-notice {
      background: rgba(30, 41, 59, 0.7);
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 20px;
      font-size: 12.5px;
      line-height: 1.6;
      color: #cbd5e1;
    }
    .real-arch-notice b { color: #fff; }

    .mode-tabs { display: flex; gap: 8px; margin-bottom: 20px; overflow-x: auto; padding-bottom: 4px; }
    .tab-btn { background: #162032; border: 1px solid var(--card-border); color: var(--text-dim); padding: 10px 16px; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; white-space: nowrap; transition: all 0.2s; }
    .tab-btn:hover { background: #1e2c44; color: #fff; }
    .tab-btn.active { background: var(--blue-dim); border-color: var(--blue); color: var(--blue); box-shadow: 0 0 10px rgba(0, 180, 216, 0.2); }

    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 16px; position: relative; }
    .kpi-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .kpi-value { font-size: 22px; font-weight: 800; }
    .kpi-sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
    
    .chart-container { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 18px; margin-bottom: 24px; position: relative; }
    .chart-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; display: flex; justify-content: space-between; color: var(--text-dim); flex-wrap: wrap; gap: 8px; }
    canvas { width: 100%; height: 260px; display: block; cursor: crosshair; }
    .chart-tooltip {
      position: absolute;
      display: none;
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid #38bdf8;
      border-radius: 8px;
      padding: 10px 14px;
      color: #fff;
      font-size: 12px;
      pointer-events: none;
      z-index: 10;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6);
      min-width: 210px;
      backdrop-filter: blur(8px);
    }
    .chart-tooltip .tt-time { font-size: 11px; color: #94a3b8; margin-bottom: 6px; border-bottom: 1px solid #334155; padding-bottom: 4px; font-weight: 600; }
    .chart-tooltip .tt-row { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
    .chart-tooltip .tt-label { color: #cbd5e1; }
    .chart-tooltip .tt-val { font-weight: 700; }

    .table-container { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; overflow: hidden; }
    .table-header { padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--card-border); flex-wrap: wrap; gap: 10px; }
    .table-header h2 { font-size: 15px; font-weight: 700; }
    .filter-group { display: flex; gap: 6px; }
    .filter-btn { background: #182234; border: 1px solid var(--card-border); color: var(--text-dim); padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .filter-btn.active { background: var(--blue); color: #000; border-color: var(--blue); font-weight: 700; }

    .ledger-scroll { max-height: 600px; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 12.5px; }
    th { background: #162032; color: var(--text-dim); padding: 10px 14px; font-weight: 600; font-size: 11px; text-transform: uppercase; position: sticky; top: 0; z-index: 1; border-bottom: 1px solid var(--card-border); }
    td { padding: 10px 14px; border-bottom: 1px solid #1a2333; }
    tr:hover { background: #141c2c; }

    .tag { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 10.5px; font-weight: 800; text-transform: uppercase; }
    .tag-buy { background: var(--blue-dim); color: var(--blue); border: 1px solid rgba(0, 180, 216, 0.3); }
    .tag-sell { background: var(--green-dim); color: var(--green); border: 1px solid rgba(0, 255, 136, 0.3); }
    .tag-skip { background: rgba(255, 183, 3, 0.15); color: var(--gold); border: 1px solid rgba(255, 183, 3, 0.3); }

    .worker-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 700; background: #1e293b; color: #93c5fd; border: 1px solid #3b82f6; }
    .lane-badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 10px; background: rgba(255,255,255,0.06); color: #94a3b8; }

    .text-green { color: var(--green); font-weight: 600; }
    .text-red { color: var(--red); font-weight: 600; }
    .text-blue { color: var(--blue); font-weight: 600; }
    .text-gold { color: var(--gold); font-weight: 600; }

    .active-workers-box { display: inline-flex; gap: 4px; flex-wrap: wrap; }
    .worker-chip { background: #1e293b; color: #cbd5e1; padding: 2px 6px; border-radius: 3px; font-size: 10.5px; border-left: 2px solid var(--blue); }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <h1>💰 Simulasi Aliran Kas Riil Modal $20 USD (3 Worker Parallel)</h1>
      <p>Pelacakan persis arsitektur riil bot: Bot menjalankan 3 Worker simultan yang berbagi kas $20. Setiap Buy menyerap $5. Jika 2 worker beli bersamaan, modal terpakai $10. Jika 3 worker beli, modal terpakai $15 (sisa $5 di kas). Saat Sell, uang kembali ke kas.</p>
    </div>
    <div style="text-align: right; color: var(--text-dim); font-size: 12px;">
      Data Riil: <b>Run 2026-09-30T14-54-29-909Z</b> (~7.5 Jam Live)<br>
      Pool Bersama: <b>$20.00 USD</b> | Stake: <b>$5.00 USD / Posisi</b>
    </div>
  </div>

  <div class="real-arch-notice">
    💡 <b>Mekanisme Alokasi Kas Nyata (Real Case):</b><br>
    • <b>1 Worker Masuk:</b> Kas berkurang <b>-$5.00</b> (Modal terpakai $5, sisa kas $15).<br>
    • <b>2 Worker Masuk Bersamaan:</b> Kas berkurang <b>-$10.00</b> ($5 x 2 posisi aktif, sisa kas $10 standby).<br>
    • <b>3 Worker Masuk Bersamaan:</b> Kas berkurang <b>-$15.00</b> ($5 x 3 posisi aktif, sisa kas $5 standby sambil menunggu).<br>
    • <b>Kapasitas Maksimal ($20 pool):</b> Maksimal 4 posisi (@ $5.00). Jika ada sinyal beli saat kas &lt; $5.00, transaksi otomatis <b>Dilewati (Skipped)</b> demi mencegah over-leverage sampai salah satu worker selesai sell.
  </div>

  <div class="mode-tabs">
    <button class="tab-btn active" onclick="switchMode('all')">🌐 Semua Mode (Portfolio Gabungan)</button>
    <button class="tab-btn" onclick="switchMode('v3')">⚡ Momentum V3 (3-Worker)</button>
    <button class="tab-btn" onclick="switchMode('safe')">🟢 Safe Aggressive (3-Worker)</button>
    <button class="tab-btn" onclick="switchMode('v2')">🔵 Momentum V2 (3-Worker)</button>
    <button class="tab-btn" onclick="switchMode('optimal')">🟣 Optimal Aggressive (3-Worker)</button>
    <button class="tab-btn" onclick="switchMode('wide')">🟠 Wide Aggressive (3-Worker)</button>
    <button class="tab-btn" onclick="switchMode('raw')">🔵 Raw Aggressive (Baseline)</button>
    <button class="tab-btn" onclick="switchMode('r5')">🟡 Momentum R5 Band</button>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Modal Kas Awal</div>
      <div class="kpi-value text-blue">$20.00</div>
      <div class="kpi-sub">Kapasitas: Maks 4 Posisi @ $5</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Saldo (Equity) Akhir</div>
      <div class="kpi-value text-green" id="kpiFinalEquity">$49.83</div>
      <div class="kpi-sub" id="kpiRoi">+149.1% ROI Bersih</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Kas Menganggur Terendah</div>
      <div class="kpi-value text-gold" id="kpiMinCash">$2.93</div>
      <div class="kpi-sub" id="kpiMaxCommitted">Maks $25 terpakai serentak</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Maks Worker Beli Bersamaan</div>
      <div class="kpi-value" id="kpiMaxConcurrent">5 Posisi</div>
      <div class="kpi-sub">Worker 1, 2, 3 paralel</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Max Drawdown Akun</div>
      <div class="kpi-value text-red" id="kpiMaxDd">18.9%</div>
      <div class="kpi-sub" id="kpiMinEquity">Saldo terendah: $19.14</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Eksekusi vs Dilewati</div>
      <div class="kpi-value" id="kpiTradesCount">319 B / 319 S</div>
      <div class="kpi-sub text-gold" id="kpiSkipped">2 order dilewati saat kas &lt; $5</div>
    </div>
  </div>

  <div class="chart-container">
    <div class="chart-title">
      <span>📈 KURVA PERJALANAN SALDO REAL-TIME (PER TANGGAL & JUMLAH SALDO USD)</span>
      <span style="font-size: 11px;">Garis Hijau = Total Equity • Garis Biru = Sisa Kas Tunai • Garis Kuning Putus-putus = Modal Pokok $20.00</span>
    </div>
    <div style="position: relative;">
      <canvas id="equityChart"></canvas>
      <div id="chartTooltip" class="chart-tooltip"></div>
    </div>
  </div>

  <div class="table-container">
    <div class="table-header">
      <h2 id="tableTitle">📋 Rekam Jejak Aliran Kas 3-Worker per Detik</h2>
      <div class="filter-group">
        <button class="filter-btn active" onclick="setFilter('ALL')">Semua Event</button>
        <button class="filter-btn" onclick="setFilter('BUY')">Hanya BUY</button>
        <button class="filter-btn" onclick="setFilter('SELL')">Hanya SELL</button>
        <button class="filter-btn" onclick="setFilter('SKIPPED_BUY')">Order Dilewati</button>
      </div>
    </div>
    <div class="ledger-scroll">
      <table>
        <thead>
          <tr>
            <th>Waktu (WIB)</th>
            <th>Worker</th>
            <th>Aksi</th>
            <th>Token & Lane</th>
            <th>Arus Kas Transaksi</th>
            <th>Return Real</th>
            <th>Modal Terpakai</th>
            <th>Sisa Kas Dompet</th>
            <th>Worker Aktif Bersamaan</th>
            <th>Total Equity</th>
            <th>Catatan Real-Case</th>
          </tr>
        </thead>
        <tbody id="ledgerBody"></tbody>
      </table>
    </div>
  </div>

  <script>
    const modesData = ${JSON.stringify(allModes)};
    let activeKey = 'all';
    let activeData = modesData.all;
    let currentFilter = 'ALL';

    function switchMode(key) {
      activeKey = key;
      activeData = modesData[key];
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('onclick').includes("'" + key + "'"));
      });
      document.getElementById('tableTitle').textContent = '📋 Rekam Jejak Aliran Kas 3-Worker: ' + activeData.label;
      updateKpis();
      renderTable();
      renderChart();
    }

    function setFilter(filter) {
      currentFilter = filter;
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.includes(filter === 'ALL' ? 'Semua' : filter));
      });
      renderTable();
    }

    function updateKpis() {
      document.getElementById('kpiFinalEquity').textContent = '$' + activeData.finalEquity.toFixed(2);
      document.getElementById('kpiFinalEquity').className = 'kpi-value ' + (activeData.finalEquity < 20.0 ? 'text-red' : 'text-green');
      document.getElementById('kpiRoi').textContent = (activeData.netProfit >= 0 ? '+' : '') + '$' + activeData.netProfit.toFixed(2) + ' (' + (activeData.roiPercent >= 0 ? '+' : '') + activeData.roiPercent + '%)';
      document.getElementById('kpiMinCash').textContent = '$' + activeData.minCash.toFixed(2);
      document.getElementById('kpiMinCash').className = 'kpi-value ' + (activeData.minCash < 20.0 ? 'text-red' : 'text-green');
      document.getElementById('kpiMaxCommitted').textContent = 'Maksimal $' + activeData.maxCommittedUsd.toFixed(2) + ' terpakai di pasar';
      document.getElementById('kpiMaxConcurrent').textContent = activeData.maxConcurrent + ' Posisi';
      document.getElementById('kpiMaxDd').textContent = activeData.maxDrawdown + '%';
      document.getElementById('kpiMinEquity').textContent = 'Saldo terendah: $' + activeData.minEquity.toFixed(2);
      document.getElementById('kpiTradesCount').textContent = activeData.executedBuys + ' B / ' + activeData.executedSells + ' S';
      document.getElementById('kpiSkipped').textContent = activeData.skippedBuys + ' order dilewati saat kas < $5';
    }

    function renderTable() {
      const tbody = document.getElementById('ledgerBody');
      const filtered = activeData.ledger.filter(item => {
        if (currentFilter === 'ALL') return true;
        return item.type === currentFilter;
      });

      tbody.innerHTML = filtered.map(item => {
        const isBuy = item.type === 'BUY';
        const isSell = item.type === 'SELL';
        const isSkip = item.type === 'SKIPPED_BUY';

        let tagClass = 'tag-buy';
        let actionLabel = 'BUY';
        let changeHtml = '<span class="text-blue">-$5.00</span>';

        if (isSell) {
          tagClass = 'tag-sell';
          actionLabel = 'SELL';
          changeHtml = '<span class="' + (item.pnl >= 0 ? 'text-green' : 'text-red') + '">+$' + item.amount.toFixed(2) + ' (' + (item.pnl >= 0 ? '+' : '') + '$' + item.pnl.toFixed(2) + ')</span>';
        } else if (isSkip) {
          tagClass = 'tag-skip';
          actionLabel = 'SKIPPED';
          changeHtml = '<span style="color:#64748b;">$0.00</span>';
        }

        const retHtml = item.ret != null
          ? '<span class="' + (item.ret >= 0 ? 'text-green' : 'text-red') + '">' + (item.ret >= 0 ? '+' : '') + item.ret.toFixed(1) + '%</span>'
          : '<span style="color:#64748b;">—</span>';

        const activeWorkersHtml = item.activeWorkers && item.activeWorkers.length > 0
          ? item.activeWorkers.map(w => '<span class="worker-chip">W' + w.worker + ': ' + w.symbol + '</span>').join('')
          : '<span style="color:#64748b; font-size:11px;">Semua Kas Bebas</span>';

        const cashClass = item.cash < 20.0 ? 'text-red' : 'text-green';
        const equityClass = item.totalEquity < 20.0 ? 'text-red' : 'text-green';
        const cashSub = item.cash < 20.0 
          ? '<span style="font-size:10px; color:#f87171; display:block; font-weight:normal;">(di bawah modal $20)</span>'
          : '<span style="font-size:10px; color:#4ade80; display:block; font-weight:normal;">(di atas modal)</span>';

        return '<tr>' +
          '<td><b>' + item.time + '</b></td>' +
          '<td><span class="worker-badge">Worker ' + item.worker + '</span></td>' +
          '<td><span class="tag ' + tagClass + '">' + actionLabel + '</span></td>' +
          '<td><b>' + item.symbol + '</b> <span class="lane-badge">' + item.lane + '</span></td>' +
          '<td>' + changeHtml + '</td>' +
          '<td>' + retHtml + '</td>' +
          '<td><b class="text-gold">$' + item.committedUsd.toFixed(2) + '</b> <span style="font-size:10px; color:#64748b;">(' + item.concurrent + ' pos)</span></td>' +
          '<td><b class="' + cashClass + '">$' + item.cash.toFixed(2) + '</b>' + cashSub + '</td>' +
          '<td><div class="active-workers-box">' + activeWorkersHtml + '</div></td>' +
          '<td><b class="' + equityClass + '">$' + item.totalEquity.toFixed(2) + '</b></td>' +
          '<td><span style="color:#cbd5e1; font-size:11.5px;">' + item.note + '</span></td>' +
        '</tr>';
      }).join('');
    }

    let hoveredPoint = null;

    function renderChart() {
      const canvas = document.getElementById('equityChart');
      const tooltip = document.getElementById('chartTooltip');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      const w = rect.width;
      const h = rect.height;
      const points = activeData.ledger;
      if (!points.length) return;

      const padL = 70;
      const padR = 25;
      const padT = 25;
      const padB = 45;
      const chartW = w - padL - padR;
      const chartH = h - padT - padB;

      const equities = points.map(p => p.totalEquity);
      const cashes = points.map(p => p.cash);
      const times = points.map(p => p.timestamp);
      const minTime = times[0];
      const maxTime = times[times.length - 1];

      const minVal = 0;
      const peakVal = Math.max(...equities, 45);
      const maxVal = Math.ceil(peakVal / 10) * 10 + 5;

      ctx.clearRect(0, 0, w, h);

      // 1. Draw Horizontal Y-Axis Grid Lines & Saldo Labels ($0, $10, $20, $30, $40, etc.)
      const yStep = maxVal > 60 ? 15 : 10;
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      for (let v = 0; v <= maxVal; v += yStep) {
        const y = padT + chartH - ((v - minVal) / (maxVal - minVal)) * chartH;
        
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(w - padR, y);
        
        if (v === 20) {
          // Highlight $20 Modal Pokok
          ctx.strokeStyle = 'rgba(234, 179, 8, 0.45)';
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#eab308';
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText('$20.00 (Modal)', 6, y + 4);
          ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        } else {
          ctx.strokeStyle = '#1e293b';
          ctx.stroke();
          ctx.fillStyle = '#64748b';
          ctx.fillText('$' + v.toFixed(2), 16, y + 4);
        }
      }

      // 2. Draw Vertical X-Axis Time / Date Grid Lines & Labels (Per Tanggal & Jam)
      const numXTicks = Math.max(4, Math.floor(chartW / 140));
      const timeInterval = (maxTime - minTime) / (numXTicks - 1);
      
      for (let i = 0; i < numXTicks; i++) {
        const t = minTime + i * timeInterval;
        const x = padL + ((t - minTime) / (maxTime - minTime)) * chartW;
        const dateObj = new Date(t);
        
        const dayStr = dateObj.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short' });
        const timeStr = dateObj.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' });

        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + chartH);
        ctx.strokeStyle = '#172033';
        ctx.stroke();

        ctx.fillStyle = '#94a3b8';
        ctx.textAlign = 'center';
        ctx.fillText(dayStr, x, h - padB + 16);
        ctx.fillStyle = '#64748b';
        ctx.fillText(timeStr, x, h - padB + 30);
      }
      ctx.textAlign = 'left';

      function getCoord(idx, val) {
        const t = times[idx];
        const x = padL + ((t - minTime) / (maxTime - minTime)) * chartW;
        const y = padT + chartH - ((val - minVal) / (maxVal - minVal)) * chartH;
        return { x, y };
      }

      // 3. Draw Gradient Area Fill for Equity
      ctx.beginPath();
      points.forEach((p, i) => {
        const { x, y } = getCoord(i, p.totalEquity);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      const lastCoord = getCoord(points.length - 1, points[points.length - 1].totalEquity);
      const firstCoord = getCoord(0, points[0].totalEquity);
      ctx.lineTo(lastCoord.x, padT + chartH);
      ctx.lineTo(firstCoord.x, padT + chartH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
      grad.addColorStop(0, 'rgba(0, 255, 136, 0.22)');
      grad.addColorStop(1, 'rgba(0, 255, 136, 0.0)');
      ctx.fillStyle = grad;
      ctx.fill();

      // 4. Draw Cash Line (Blue)
      ctx.beginPath();
      points.forEach((p, i) => {
        const { x, y } = getCoord(i, p.cash);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#00b4d8';
      ctx.lineWidth = 2;
      ctx.stroke();

      // 5. Draw Equity Line (Green)
      ctx.beginPath();
      points.forEach((p, i) => {
        const { x, y } = getCoord(i, p.totalEquity);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = '#00ff88';
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // 6. Draw Hovered Point & Crosshair if any
      if (hoveredPoint !== null && hoveredPoint >= 0 && hoveredPoint < points.length) {
        const hp = points[hoveredPoint];
        const eqCoord = getCoord(hoveredPoint, hp.totalEquity);
        const cashCoord = getCoord(hoveredPoint, hp.cash);

        ctx.beginPath();
        ctx.moveTo(eqCoord.x, padT);
        ctx.lineTo(eqCoord.x, padT + chartH);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(eqCoord.x, eqCoord.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#00ff88';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cashCoord.x, cashCoord.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#00b4d8';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();

        const dateObj = new Date(hp.timestamp);
        const fullDateStr = dateObj.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'short', day: '2-digit', month: 'short' });
        const fullTimeStr = dateObj.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' });

        const actionClass = hp.type === 'BUY' ? 'text-blue' : hp.type === 'SELL' ? 'text-green' : 'text-gold';
        const eqClass = hp.totalEquity < 20 ? 'text-red' : 'text-green';
        const cClass = hp.cash < 20 ? 'text-red' : 'text-blue';

        tooltip.innerHTML = 
          '<div class="tt-time">📅 ' + fullDateStr + ', ' + fullTimeStr + ' WIB</div>' +
          '<div class="tt-row"><span class="tt-label">Aksi Transaksi:</span><span class="tt-val ' + actionClass + '">' + hp.type + ' (' + hp.symbol + ')</span></div>' +
          '<div class="tt-row"><span class="tt-label">Total Saldo:</span><span class="tt-val ' + eqClass + '">$' + hp.totalEquity.toFixed(2) + '</span></div>' +
          '<div class="tt-row"><span class="tt-label">Sisa Kas:</span><span class="tt-val ' + cClass + '">$' + hp.cash.toFixed(2) + '</span></div>' +
          '<div class="tt-row"><span class="tt-label">Modal Terpakai:</span><span class="tt-val text-gold">$' + hp.committedUsd.toFixed(2) + ' (' + hp.concurrent + ' worker)</span></div>';
        tooltip.style.display = 'block';

        let ttX = eqCoord.x + 15;
        if (ttX + 220 > w) ttX = eqCoord.x - 235;
        tooltip.style.left = ttX + 'px';
        tooltip.style.top = Math.max(10, Math.min(eqCoord.y - 40, h - 130)) + 'px';
      } else {
        tooltip.style.display = 'none';
      }

      // Legend in top-right
      ctx.fillStyle = '#00ff88';
      ctx.fillRect(w - 210, 8, 10, 10);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '11px sans-serif';
      ctx.fillText('Total Equity (Saldo)', w - 195, 17);

      ctx.fillStyle = '#00b4d8';
      ctx.fillRect(w - 95, 8, 10, 10);
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText('Kas Tersedia', w - 80, 17);
    }

    const chartCanvas = document.getElementById('equityChart');
    chartCanvas.addEventListener('mousemove', (e) => {
      const rect = chartCanvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const padL = 70;
      const padR = 25;
      const chartW = rect.width - padL - padR;
      const points = activeData.ledger;
      if (!points.length || mouseX < padL || mouseX > rect.width - padR) {
        hoveredPoint = null;
        renderChart();
        return;
      }
      const minTime = points[0].timestamp;
      const maxTime = points[points.length - 1].timestamp;
      const targetTime = minTime + ((mouseX - padL) / chartW) * (maxTime - minTime);

      let closestIdx = 0;
      let minDiff = Infinity;
      for (let i = 0; i < points.length; i++) {
        const diff = Math.abs(points[i].timestamp - targetTime);
        if (diff < minDiff) {
          minDiff = diff;
          closestIdx = i;
        }
      }
      hoveredPoint = closestIdx;
      renderChart();
    });

    chartCanvas.addEventListener('mouseleave', () => {
      hoveredPoint = null;
      renderChart();
    });

    window.addEventListener('resize', renderChart);
    updateKpis();
    renderTable();
    setTimeout(renderChart, 100);
  </script>
</body>
</html>
`;

writeFileSync("reports/simulation-cashflow-20usd.html", html);
console.log("✅ Berhasil memperbarui file HTML laporan cash-flow:", "reports/simulation-cashflow-20usd.html");
