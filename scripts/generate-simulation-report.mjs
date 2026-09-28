import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('Usage: node scripts/generate-simulation-report.mjs <research-run-folder>');
const folder = resolve(run);
const readJson = file => existsSync(join(folder, file)) ? JSON.parse(readFileSync(join(folder, file), 'utf8')) : null;
const readLines = file => existsSync(join(folder, file)) ? readFileSync(join(folder, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const rows = readLines('simulated-trades.jsonl');
const paperOrdersBySignal = new Map(readLines('paper-orders.jsonl').map(row => [row.signalId, row]));
const screened = new Map(readLines('screened-tokens.jsonl').map(row => [row.mint, row]));
const activityRows = readLines('trades.jsonl');
const events = readLines('events.jsonl');
const tokenSummaries = new Map(readLines('token-summary.jsonl').map(row => [row.mint, row]));
const completedDetails = new Set(tokenSummaries.keys());
const summary = readJson('simulation-summary.json');
const manifest = readJson('manifest.json');
const strategy = readJson('strategy.json');
const liveLedger = readLines('live-trade-ledger.jsonl');
const followupRows = readLines('order-followup-responses.jsonl');
const routeComparisonRows = readLines('quote-simulated-orders.jsonl');

const liveOrdersByMint = new Map();
const liveErrors = [];

for (const row of liveLedger) {
  if (row.type === 'LIVE_ORDER_SUBMITTED' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (row.side === 'BUY') cur.buy = row;
    if (row.side === 'SELL') cur.sell = row;
    liveOrdersByMint.set(row.mint, cur);
    if (row.ok === false) {
      liveErrors.push({
        observedAt: row.observedAt,
        side: row.side,
        mint: row.mint,
        status: row.status ?? null,
        code: row.code ?? null,
        message: row.message || 'Order ditolak oleh GMGN API',
      });
    }
  }
}
for (const row of events) {
  if (row.type === 'BROWSER_BUY_SUBMITTED' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (!cur.buy) cur.buy = { observedAt: row.observedAt, orderId: row.result?.orderId, hash: row.result?.hash, acquiredAmount: row.result?.acquiredAmount, stakeUsd: row.stakeUsd, ok: row.result?.ok ?? true };
    liveOrdersByMint.set(row.mint, cur);
  }
  if (row.type === 'BROWSER_BUY_NOT_SUBMITTED' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (!cur.buy || !cur.buy.hash) {
      cur.buy = { observedAt: row.observedAt, ok: false, status: row.result?.status, code: row.result?.code, message: row.result?.message ?? row.result?.msg, stakeUsd: row.stakeUsd };
    }
    liveOrdersByMint.set(row.mint, cur);
    if (!liveErrors.some(e => e.mint === row.mint && e.side === 'BUY' && Math.abs(e.observedAt - row.observedAt) < 2000)) {
      liveErrors.push({
        observedAt: row.observedAt,
        side: 'BUY',
        mint: row.mint,
        status: row.result?.status ?? null,
        code: row.result?.code ?? null,
        message: row.result?.message ?? row.result?.msg ?? 'Submit BUY ditolak oleh GMGN API',
      });
    }
  }
  if (row.type === 'BROWSER_SELL_SUBMITTED' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (!cur.sell) cur.sell = { observedAt: row.observedAt, orderId: row.result?.orderId, hash: row.result?.hash, inputAmount: row.inputAmount, ok: row.result?.ok ?? true };
    liveOrdersByMint.set(row.mint, cur);
  }
  if (row.type === 'BROWSER_SELL_NOT_SUBMITTED' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (!cur.sell || !cur.sell.hash) {
      cur.sell = { observedAt: row.observedAt, ok: false, status: row.result?.status, code: row.result?.code, message: row.result?.message ?? row.result?.msg, inputAmount: row.inputAmount };
    }
    liveOrdersByMint.set(row.mint, cur);
    if (!liveErrors.some(e => e.mint === row.mint && e.side === 'SELL' && Math.abs(e.observedAt - row.observedAt) < 2000)) {
      liveErrors.push({
        observedAt: row.observedAt,
        side: 'SELL',
        mint: row.mint,
        status: row.result?.status ?? null,
        code: row.result?.code ?? null,
        message: row.result?.message ?? row.result?.msg ?? 'Submit SELL ditolak oleh GMGN API',
      });
    }
  }
  if (row.type === 'BROWSER_BUY_ERROR' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (!cur.buy) cur.buy = { observedAt: row.observedAt, ok: false, status: null, code: 'EXEC_ERROR', message: row.message };
    liveOrdersByMint.set(row.mint, cur);
    liveErrors.push({ observedAt: row.observedAt, side: 'BUY', mint: row.mint, status: null, code: 'EXEC_ERROR', message: row.message ?? 'Browser execution error saat BUY' });
  }
  if (row.type === 'BROWSER_SELL_ERROR' && row.mint) {
    const cur = liveOrdersByMint.get(row.mint) ?? {};
    if (!cur.sell) cur.sell = { observedAt: row.observedAt, ok: false, status: null, code: 'EXEC_ERROR', message: row.message };
    liveOrdersByMint.set(row.mint, cur);
    liveErrors.push({ observedAt: row.observedAt, side: 'SELL', mint: row.mint, status: null, code: 'EXEC_ERROR', message: row.message ?? 'Browser execution error saat SELL' });
  }
  if (row.type === 'BROWSER_BUY_SKIPPED' && row.mint) {
    liveErrors.push({ observedAt: row.observedAt, side: 'BUY', mint: row.mint, status: null, code: 'SKIPPED', message: row.reason === 'NO_CAPTURED_ORDER_SESSION' ? 'Sesi wallet / auth belum tertangkap pada profil browser' : (row.reason ?? 'Order dilewati') });
  }
  if (row.type === 'BROWSER_SELL_SKIPPED' && row.mint) {
    liveErrors.push({ observedAt: row.observedAt, side: 'SELL', mint: row.mint, status: null, code: 'SKIPPED', message: row.reason === 'NO_CAPTURED_ORDER_SESSION' ? 'Sesi wallet / auth belum tertangkap pada profil browser' : (row.reason ?? 'Order dilewati') });
  }
  if (row.type === 'BROWSER_AUTH_REFRESHING') {
    liveErrors.push({ observedAt: row.observedAt, side: row.side ?? 'AUTH', mint: row.mint, status: 401, code: 'TOKEN_EXPIRED', message: 'Sesi token GMGN kedaluwarsa (401/403). Tab browser dimuat ulang otomatis untuk perbarui sesi.' });
  }
}

const walletstatByMint = new Map();
for (const row of liveLedger) {
  if (row.type === 'GMGN_WALLETSTAT_SNAPSHOT' && row.token) {
    walletstatByMint.set(row.token, row);
  }
}
for (const row of followupRows) {
  if (row.type === 'ORDER_FOLLOWUP_RESPONSE' && row.url && row.url.includes('/smartmoney/sol/walletstat/') && row.bodyText) {
    try {
      const data = JSON.parse(row.bodyText).data;
      if (data?.token_address && !walletstatByMint.has(data.token_address)) {
        const buyCost = Number(data.history_bought_cost ?? 0), soldIncome = Number(data.history_sold_income ?? 0);
        const grossPnlUsd = Number.isFinite(buyCost) && Number.isFinite(soldIncome) ? soldIncome - buyCost : null;
        walletstatByMint.set(data.token_address, {
          observedAt: row.observedAt,
          token: data.token_address,
          symbol: data.symbol,
          balance: data.balance,
          historyBoughtCostUsd: data.history_bought_cost,
          historyBoughtAmount: data.history_bought_amount,
          historyAvgCost: data.history_avg_cost,
          historySoldIncomeUsd: data.history_sold_income,
          avgSold: data.avg_sold,
          grossPnlUsd,
          grossPnlPercent: buyCost > 0 && grossPnlUsd !== null ? grossPnlUsd / buyCost * 100 : null,
          reportedRealizedProfitUsd: data.realized_profit,
          reportedGasUsd: data.gas_usd,
          priceUsd: data.price,
        });
      }
    } catch { /* Ignore */ }
  }
}

const paperLane = row => row?.paperLane ?? 'control';
const paperLaneLabel = lane => lane === 'r5-band' ? 'R5-band 5%–<10%' : 'Kontrol V2';
const buys = rows.filter(row => row.type === 'SIMULATED_BUY');
const sells = rows.filter(row => row.type === 'SIMULATED_SELL');
const holds = rows.filter(row => row.type === 'SIMULATION_HOLD');
const sellsByMint = new Map(sells.map(row => [row.mint, row]));
const sellsByPosition = new Map(sells.filter(row => row.positionId).map(row => [row.positionId, row]));
const blockedByMint = new Map();
// The detail queue is shared by both paper lanes.  Its one row per token
// describes the base/control decision; the R5-band block remains in the raw
// event log and transaction comparison, not in this single-token view.
for (const row of events) if (row.type === 'SIMULATION_BUY_BLOCKED' && paperLane(row) === 'control') blockedByMint.set(row.mint, row);
const dumpAbortedByMint = new Map();
for (const row of events) if (row.type === 'OBSERVATION_ABORTED_DUMP') dumpAbortedByMint.set(row.mint, row);
const unpricedByMint = new Map();
for (const row of events) if (row.type === 'SIMULATION_EXIT_UNPRICED') unpricedByMint.set(row.mint, row);
const detailStartedByMint = new Map();
for (const row of events) if (row.type === 'DETAIL_STARTED') detailStartedByMint.set(row.mint, row);
const activityByMint = new Map();
for (const row of activityRows) {
  const current = activityByMint.get(row.mint) ?? { buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, latestPriceUsd: null };
  if (row.side === 'buy') { current.buys++; current.buyUsd += row.amount ?? 0; }
  if (row.side === 'sell') { current.sells++; current.sellUsd += row.amount ?? 0; }
  if (Number.isFinite(row.priceUsd)) current.latestPriceUsd = row.priceUsd;
  activityByMint.set(row.mint, current);
}
const f = (v, digits = 4) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
// Six decimals turns $0.000007781 into the misleading $0.000008.  Memecoin
// prices need enough digits for the report to show the actual simulation tick.
const usd = v => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? '$' + f(Number(v), Math.abs(Number(v)) < 0.01 ? 10 : 6) : '—';
const pct = v => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v))) ? (Number(v) > 0 ? '+' : '') + f(Number(v), 2) + '%' : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const time = value => value ? new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '—';
const timeExact = value => value ? new Intl.DateTimeFormat('id-ID', {
  timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
}).format(new Date(value)) : '—';
const routeComparisonByPosition = new Map();
for (const row of routeComparisonRows.filter(row => row.positionId)) {
  const position = routeComparisonByPosition.get(row.positionId) ?? {};
  if (row.type?.startsWith('QUOTE_BUY_COMPARISON')) position.buy = row;
  if (row.type?.startsWith('QUOTE_SELL_COMPARISON')) position.sell = row;
  routeComparisonByPosition.set(row.positionId, position);
}
const buyByPosition = new Map(buys.filter(row => row.positionId).map(row => [row.positionId, row]));
const routeComparisonHtml = (strategy?.quoteSimulationEnabled === true || routeComparisonRows.length > 0)
  ? `<h2>Komparasi harga socket vs route swap GMGN</h2><div class="note">Harga SOL diambil saat token masuk detail. Ketika paper BUY dan SELL terjadi, sistem meminta route swap GMGN tanpa submit order. Selisih positif pada harga buy berarti route lebih mahal; selisih negatif pada token/proceeds berarti hasil route lebih buruk daripada harga socket.</div><div class="scroll"><table><thead><tr><th>Token / lane</th><th>Paper BUY / socket</th><th>SOL saat masuk detail</th><th>Quote buy · selisih harga / token</th><th>Quote sell · selisih proceeds</th></tr></thead><tbody>${[...routeComparisonByPosition.entries()].reverse().map(([positionId, position]) => { const row = position.buy ?? position.sell ?? {}; const buy = buyByPosition.get(positionId); const screen = screened.get(row.mint); const symbol = screen?.metadata?.symbol ?? buy?.metadata?.symbol ?? row.mint?.slice(0, 8) ?? 'Token'; const lane = paperLane(buy); const deltaClass = (value, inverse = false) => { const n = Number(value); return !Number.isFinite(n) || n === 0 ? '' : (inverse ? n < 0 : n > 0) ? 'down' : 'up'; }; const quoteCell = (quote, kind) => quote?.type === `QUOTE_${kind}_COMPARISON` ? `${timeExact(quote.observedAt)} WIB<br><b>${usd(quote.quote?.amountInUsd)}</b> → ${usd(quote.quote?.amountOutUsd)}<br><small>${f(quote.latencyMs, 0)} ms · impact ${esc(quote.quote?.priceImpactPct ?? '—')}%</small>` : `<span class="watch">${esc(quote?.type?.replace(`QUOTE_${kind}_COMPARISON_`, '') ?? 'MENUNGGU')}</span><br><small>${esc(quote?.reason ?? quote?.message ?? '')}</small>`; const buyQuote = position.buy, sellQuote = position.sell; return `<tr><td><b>${esc(symbol)}</b><br><span class="mono">${esc(row.mint)}</span><small>${esc(paperLaneLabel(lane))}</small></td><td>${buy ? `${timeExact(buy.observedAt)} WIB<br><b>${usd(buy.entryPriceUsd)}</b><br><small>Estimasi ${f(buyQuote?.socketExpectedTokenAmount, 4)} token</small>` : '—'}</td><td>${buyQuote?.detailSolSpotUsd ? `<b>${usd(buyQuote.detailSolSpotUsd)}</b><br><small>${timeExact(buyQuote.detailSolSpotAt)} WIB</small>` : '—'}</td><td>${quoteCell(buyQuote, 'BUY')}<br><small class="${deltaClass(buyQuote?.routeVsSocketPricePercent)}">Harga ${pct(buyQuote?.routeVsSocketPricePercent)}</small><br><small class="${deltaClass(buyQuote?.routeVsSocketTokenPercent, true)}">Token ${pct(buyQuote?.routeVsSocketTokenPercent)}</small></td><td>${quoteCell(sellQuote, 'SELL')}<br><small class="${deltaClass(sellQuote?.routeVsSocketProceedsPercent, true)}">Proceeds ${pct(sellQuote?.routeVsSocketProceedsPercent)}</small></td></tr>`; }).join('') || '<tr><td colspan="5" class="muted">Belum ada paper BUY yang meminta quote route.</td></tr>'}</tbody></table></div>`
  : '';
const signalTiming = row => {
  if (!row?.timing) return '<small>Waktu sinyal terpisah belum dicatat pada run ini.</small>';
  const signal = row.timing, order = paperOrdersBySignal.get(signal.signalId);
  const orderText = signal.plannedOrderAt
    ? `<br>Target order simulasi ${timeExact(signal.plannedOrderAt)} WIB · batas ${timeExact(signal.orderDeadlineAt)} WIB${order
      ? `<br><b class="${order.withinOneSecond ? 'up' : 'down'}">Order simulasi ${timeExact(order.simulatedOrderAt)} WIB · ${f(order.delayMs, 0)} ms ${order.withinOneSecond ? '(≤1 dtk)' : '(melewati 1 dtk)'}</b>${order.observedPriceProxyUsd !== null ? `<br>Harga tick teramati saat order ${usd(order.observedPriceProxyUsd)} (${timeExact(order.observedPriceProxyAt)} WIB; bukan fill` : ''}`
      : '<br>Menunggu waktu order simulasi'}`
    : '';
  return `<small>Sinyal ${timeExact(signal.decisionAt)} WIB<br>Trade pasar ${timeExact(signal.marketTradeAt)} WIB<br>WebSocket diterima ${timeExact(signal.priceReceivedAt)} WIB · usia harga ${f(signal.priceAgeMsAtDecision, 0)} ms<br>Paper dicatat ${timeExact(signal.paperRecordedAt)} WIB${orderText}</small>`;
};
const fieldValue = (row, name) => row?.fields?.[name]?.value;
const buyReason = row => {
  if (strategy?.strategy === 'pump-band') {
    const gate = row.entryGate ?? {};
    return `Pump-band: token fresh masuk detail pada market cap ${usd(gate.initialMarketCapUsd)} dalam rentang $3.000–$10.000. Simulasi beli memakai transaksi pu baru pertama ${f(gate.priceLatencyMs / 1000, 1)} detik setelah detail dibuka.`;
  }
  const screen = screened.get(row.mint);
  if (!screen) return 'Masuk halaman detail; snapshot screening tidak tersedia.';
  const age = fieldValue(screen, 'createdAt');
  const ageSeconds = Number.isFinite(age) ? Math.max(0, (screen.observedAt - age) / 1000) : null;
  const candle = row.entryGate?.candleHistory;
  const momentum = row.entryGate?.momentum;
  if (momentum?.allowed) {
    const m = momentum.metrics;
    return `Momentum v2: harga 5 detik ${pct(m.return5s)}, tren regresi ${pct(m.slope5s)}, buy share ${pct(m.buyShare * 100)}, ${m.buyers} pembeli unik, pembeli terbesar ${pct(m.topBuyerShare * 100)}. Holder ${momentum.holders?.count ?? '—'}; pertumbuhan dua snapshot: ${momentum.holders?.sustained ? 'terkonfirmasi' : 'tidak / tidak wajib untuk token matang'}. Screening, candle, serta distribusi holder juga lolos.`;
  }
  const override = row.entryGate?.singleCandleHolderOverride;
  const growth = row.entryGate?.significantHolderGrowth;
  const overrideText = override?.allowed ? ` Pengecualian satu candle: holder ${f(growth?.current, 0)}; naik ${f(growth?.absolute, 0)} (${pct(growth?.percent)}) dalam pembaruan token-stat terakhir.` : '';
  const candleText = candle ? ` Candle 1m: ${candle.reason}; puncak-ke-close ${pct(candle.peakToLastDrawdownPercent)}, candle merah beruntun ${f(candle.consecutiveRedCandles, 0)}.${overrideText}` : '';
  return `Lolos screening: umur ${ageSeconds === null ? '—' : f(ageSeconds, 0) + ' dtk'}, holder ${f(fieldValue(screen, 'holders'), 0)}, likuiditas ${usd(fieldValue(screen, 'liquidityUsd'))}, Top-10 ${pct(fieldValue(screen, 'top10Percent'))}.${candleText}`;
};
const sellReason = row => ({
  V2_HARD_STOP: 'Stop v2: minimal dua trade berbeda mengonfirmasi harga turun ≥20%.',
  V2_CONFIRMED_CRASH: 'Crash v2: penurunan ≥25% dikonfirmasi trade berbeda; harga exit memakai tick yang tersedia.',
  V2_MAJOR_HOLDER_SELL: 'Penjualan signifikan oleh dev/top holder, atau whale yang mendominasi arus jual.',
  V2_PROFIT_LOCK: 'Batas pengamanan profit tersentuh; hasil tetap mengikuti harga tick, termasuk bila melompati batas.',
  V2_TARGET_40: 'Target +40% tercapai; momentum dan holder tidak cukup kuat untuk menunda exit.',
  V2_TARGET_50: 'Batas target +50% tercapai.',
  V2_MOMENTUM_FADE: 'Profit ≥3%, tren 5 detik melemah, sell mendominasi, holder tidak tumbuh signifikan.',
  V2_SELL_PRESSURE: 'Posisi ≤−8% dengan tren turun dan tekanan jual lintas beberapa wallet.',
  TARGET_40: 'Target dasar: harga mencapai +40% dari harga beli.',
  TARGET_40_HOLDER_FLAT: 'Sudah +40%; laju holder mulai melandai saat momentum berkurang.',
  TARGET_DYNAMIC: 'Target dinamis tercapai sesuai kenaikan momentum dan pembeli aktif.',
  TRAILING_10: 'Pernah naik ≥20%, lalu turun ≥10% dari harga puncak.',
  TRAILING_TIERED: 'Trailing bertingkat: mengunci profit setelah terjadi koreksi dari titik tertinggi.',
  BREAKEVEN_GUARD: 'Proteksi modal: sempat naik ≥+5% lalu turun mendekati modal (+0.5%).',
  EARLY_CUT_LOSS: 'Cut loss cepat: harga turun ≤-8% dengan lonjakan tekanan jual.',
  STOP_LOSS_20: 'Hard stop: harga turun ≥20% dari harga beli.',
  SELL_PRESSURE: 'Dua jendela socket 5-detik penuh menunjukkan tekanan jual tinggi.',
  PROFIT_STAGNATION_10S: 'Take profit: harga stagnan selama 10 detik saat posisi untung ≥+3%.',
  PROFIT_STAGNATION_25S: 'Take profit: konsolidasi 25 detik selesai saat posisi untung ≥+10%.',
  MOMENTUM_EXHAUSTION_5S: 'Momentum melandai: pertumbuhan holder melambat & volume beli melemah saat sudah profit (≥+3%).',
  DEV_DUMP_EXIT: 'Darurat dump: dompet Developer/kreator terdeteksi melakukan aksi jual.',
  TOP_HOLDER_DUMP: 'Darurat dump: pemegang koin besar (≥1.5% suplai / whale) melakukan aksi jual saat harga melemah.',
  OBSERVATION_END: 'Waktu observasi detail atau run selesai sebelum exit lain.',
  PUMP_DUMP_20: 'Pump-band: harga transaksi turun sedikitnya 20% dari puncak yang terlihat selama sesi.',
  PUMP_OBSERVATION_END: 'Pump-band: observasi 20 detik selesai; harga transaksi terakhir masih cukup segar untuk simulasi jual.',
}[row?.reason] ?? `Alasan exit belum terpetakan (${row?.reason ?? 'UNKNOWN'}).`);
const tradeRows = lane => buys.filter(buy => lane === null || paperLane(buy) === lane).slice().reverse().map(buy => {
  const sell = buy.positionId ? sellsByPosition.get(buy.positionId) : sellsByMint.get(buy.mint);
  const symbol = buy.metadata?.symbol || sell?.metadata?.symbol || 'Token';
  const unpriced = unpricedByMint.get(buy.mint);
  const resultClass = sell ? (sell.pnlUsd > 0 ? 'up' : sell.pnlUsd < 0 ? 'down' : '') : '';
  return `<tr><td><button class="token" data-mint="${esc(buy.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(buy.mint)}</span><small>${paperLaneLabel(paperLane(buy))} · Preview detail GMGN</small></button></td><td>${timeExact(buy.observedAt)} WIB<br>${usd(buy.stakeUsd)} @ ${usd(buy.entryPriceUsd)}${strategy?.strategy === 'momentum-v2' ? signalTiming(buy) : ''}</td><td>${esc(buyReason(buy))}</td><td>${sell ? `${timeExact(sell.observedAt)} WIB<br>${usd(sell.exit?.priceUsd)}${strategy?.strategy === 'momentum-v2' ? signalTiming(sell) : ''}` : unpriced ? `<span class="watch">Sesi selesai ${time(unpriced.observedAt)}</span>` : '<span class="watch">Masih dipantau</span>'}</td><td>${sell ? esc(sellReason(sell)) : unpriced ? 'Harga transaksi terakhir sudah lebih dari 5 detik; hasil jual tidak dihitung.' : 'Belum ada sinyal sell.'}</td><td class="${resultClass}">${sell ? `<b>${usd(sell.pnlUsd)}</b><br>${pct(sell.pnlPercent)}` : '—'}</td></tr>`;
}).join('');
const hasR5BandTrades = buys.some(buy => paperLane(buy) === 'r5-band') || (summary?.lanes && summary.lanes['r5-band']?.positionsOpened > 0);
const singleLaneMode = !hasR5BandTrades;

// The Momentum V2 dashboard is deliberately a lane-to-lane execution ledger.
// A route comparison belongs beside its paper position, rather than in a
// separate table where the two P/L figures are difficult to compare.
const quoteStatus = (quote, side) => {
  if (quote?.type === `QUOTE_${side}_COMPARISON`) return null;
  const state = quote?.type?.replace(`QUOTE_${side}_COMPARISON_`, '') ?? 'MENUNGGU';
  return { state, detail: quote?.reason ?? quote?.message ?? '' };
};
const quotePnl = (comparison) => {
  const buy = comparison?.buy, sell = comparison?.sell;
  if (quoteStatus(buy, 'BUY') || quoteStatus(sell, 'SELL')) return null;
  const cost = Number(buy.amountInUsd ?? buy.quote?.amountInUsd);
  const proceeds = Number(sell.amountOutUsd ?? sell.quote?.amountOutUsd);
  if (!Number.isFinite(cost) || cost <= 0 || !Number.isFinite(proceeds)) return null;
  const pnlUsd = proceeds - cost;
  return { cost, proceeds, pnlUsd, pnlPercent: pnlUsd / cost * 100 };
};
const moneyClass = value => Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : '';
const quoteCell = (quote, side) => {
  const status = quoteStatus(quote, side);
  if (status) return `<span class="watch">${esc(status.state)}</span>${status.detail ? `<br><small class="muted">${esc(status.detail)}</small>` : ''}`;
  const price = quote.routeImpliedTokenPriceUsd;
  const input = quote.amountInUsd ?? quote.quote?.amountInUsd;
  const output = quote.amountOutUsd ?? quote.quote?.amountOutUsd;
  const amounts = side === 'BUY'
    ? `<small>Modal route (SOL): <b>${usd(input)}</b><br>Nilai token versi GMGN: <b>${usd(output)}</b></small>`
    : `<small>Nilai token sebelum jual: <b>${usd(input)}</b><br>Estimasi SOL diterima: <b>${usd(output)}</b></small>`;
  return `${timeExact(quote.observedAt)} WIB<br><b>Harga route ${usd(price)}</b><br>${amounts}<br><small class="muted">Respons route ${f(quote.latencyMs, 0)} ms · bukan order/fill</small>`;
};
const paperPnl = sell => sell ? { pnlUsd: Number(sell.pnlUsd), pnlPercent: Number(sell.pnlPercent) } : null;
const laneLedgerRows = lane => buys.filter(buy => paperLane(buy) === lane).slice().reverse().map(buy => {
  const sell = buy.positionId ? sellsByPosition.get(buy.positionId) : sellsByMint.get(buy.mint);
  const comparison = routeComparisonByPosition.get(buy.positionId) ?? {};
  const quoted = quotePnl(comparison);
  const paper = paperPnl(sell);
  const symbol = buy.metadata?.symbol || sell?.metadata?.symbol || 'Token';
  const paperResult = paper ? `<b class="${moneyClass(paper.pnlUsd)}">${usd(paper.pnlUsd)}</b><br><span class="${moneyClass(paper.pnlUsd)}">${pct(paper.pnlPercent)}</span>` : '<span class="watch">Menunggu sell</span>';
  const quoteResult = quoted ? `<b class="${moneyClass(quoted.pnlUsd)}">${usd(quoted.pnlUsd)}</b><br><span class="${moneyClass(quoted.pnlUsd)}">${pct(quoted.pnlPercent)}</span>` : `<span class="watch">${sell ? 'Quote belum lengkap' : 'Menunggu sell'}</span>`;
  const paperSell = sell
    ? `${timeExact(sell.observedAt)} WIB<br><b>${usd(sell.exit?.priceUsd)}</b>`
    : '<span class="watch">Masih dipantau</span>';
  return `<tr class="ledger-main">
    <td><button class="token" data-mint="${esc(buy.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(buy.mint)}</span></button></td>
    <td>${timeExact(buy.observedAt)} WIB<br><b>${usd(buy.entryPriceUsd)}</b><br><small>Modal paper ${usd(buy.stakeUsd)}</small></td>
    <td>${quoteCell(comparison.buy, 'BUY')}</td>
    <td>${paperSell}</td>
    <td>${quoteCell(comparison.sell, 'SELL')}</td>
    <td>${paperResult}</td>
    <td>${quoteResult}</td>
  </tr><tr class="ledger-reason"><td colspan="7"><div><b>Alasan beli:</b> ${esc(buyReason(buy))}</div><div><b>Alasan jual:</b> ${sell ? esc(sellReason(sell)) : '<span class="watch">Belum ada sinyal jual.</span>'}</div></td></tr>`;
}).join('');
const laneLedgerTotals = lane => {
  const laneBuys = buys.filter(buy => paperLane(buy) === lane);
  const closed = laneBuys.map(buy => {
    const sell = buy.positionId ? sellsByPosition.get(buy.positionId) : sellsByMint.get(buy.mint);
    const comparison = routeComparisonByPosition.get(buy.positionId) ?? {};
    return { paper: paperPnl(sell), quote: quotePnl(comparison) };
  });
  const summarize = key => {
    const values = closed.map(row => row[key]).filter(Boolean);
    const profit = values.filter(row => row.pnlUsd > 0).reduce((total, row) => total + row.pnlUsd, 0);
    const loss = values.filter(row => row.pnlUsd < 0).reduce((total, row) => total + row.pnlUsd, 0);
    return { completed: values.length, profit, loss, net: profit + loss };
  };
  return { positions: laneBuys.length, paper: summarize('paper'), quote: summarize('quote') };
};
const laneLedgerTable = lane => {
  const totals = laneLedgerTotals(lane);
  const totalCell = values => `<b>Untung ${values.completed ? usd(values.profit) : '—'}</b><br><span class="down">Rugi ${values.completed ? usd(values.loss) : '—'}</span><br><span class="${moneyClass(values.net)}">Net ${values.completed ? usd(values.net) : '—'}</span>`;
  return `<section class="lane-ledger"><h2>${paperLaneLabel(lane)}</h2><p class="muted">Paper memakai harga socket pada sinyal. Quote memakai route GMGN pada saat sinyal, tanpa submit order. Harga dan P/L quote hanya final jika quote BUY serta SELL sama-sama tersedia.</p><div class="scroll"><table class="ledger-table"><thead><tr><th>Token</th><th>Harga Paper Buy</th><th>Harga Quote Buy<br><small>(route GMGN)</small></th><th>Harga Paper Sell</th><th>Harga Quote Sell<br><small>(route GMGN)</small></th><th>P/L Paper</th><th>P/L Quote<br><small>(estimasi route)</small></th></tr></thead><tbody>${laneLedgerRows(lane) || '<tr><td colspan="7" class="muted">Belum ada transaksi pada lane ini.</td></tr>'}</tbody><tfoot><tr><th colspan="4">Total ${paperLaneLabel(lane)} · ${totals.positions} posisi</th><th>Transaksi selesai<br>Paper: ${totals.paper.completed}<br>Quote lengkap: ${totals.quote.completed}</th><th>${totalCell(totals.paper)}</th><th>${totalCell(totals.quote)}</th></tr></tfoot></table></div></section>`;
};
const v2LaneDashboardHtml = `<div class="lane-ledger-intro"><b>Komparasi transaksi per lane</b><br><span class="muted">Paper = harga socket; Quote = estimasi route swap GMGN. Tidak ada order nyata yang dikirim.</span></div>${laneLedgerTable('control')}${laneLedgerTable('r5-band')}`;

const comparisonTradeRows = buys.filter(buy => paperLane(buy) === 'control').slice().reverse().map(buy => {
  const sell = buy.positionId ? sellsByPosition.get(buy.positionId) : sellsByMint.get(buy.mint);
  const symbol = buy.metadata?.symbol || sell?.metadata?.symbol || 'Token';
  const unpriced = unpricedByMint.get(buy.mint);
  const simResultClass = sell ? (sell.pnlUsd > 0 ? 'up' : sell.pnlUsd < 0 ? 'down' : '') : '';

  const liveBuy = liveOrdersByMint.get(buy.mint)?.buy;
  const liveSell = liveOrdersByMint.get(buy.mint)?.sell;
  const ws = walletstatByMint.get(buy.mint);

  const simBuyCell = `${timeExact(buy.observedAt)} WIB<br><b>${usd(buy.stakeUsd)} @ ${usd(buy.entryPriceUsd)}</b><br><small class="muted">${esc(buyReason(buy))}</small>`;
  const simSellCell = sell
    ? `${timeExact(sell.observedAt)} WIB<br><b>@ ${usd(sell.exit?.priceUsd)}</b><br><small class="muted">${esc(sellReason(sell))}</small>`
    : unpriced ? `<span class="watch">Sesi selesai tanpa tick</span>` : '<span class="watch">Masih dipantau</span>';
  const simResultCell = sell ? `<b class="${simResultClass}">${usd(sell.pnlUsd)}</b><br><span class="${simResultClass}">${pct(sell.pnlPercent)}</span>` : '—';

  let liveBuyCell = '<span class="muted">Hanya paper simulasi</span>';
  let liveSellCell = '—';
  let liveResultCell = '—';
  let deltaCell = '—';

  if (liveBuy || ws) {
    const buyTimeStr = liveBuy?.observedAt ? `${timeExact(liveBuy.observedAt)} WIB<br>` : '';
    if (liveBuy && liveBuy.ok === false) {
      const statusBadge = liveBuy.status ? ` <span style="background:#5c1d1d;color:#ff9999;padding:1px 5px;border-radius:4px;font-size:11px">HTTP ${esc(liveBuy.status)}</span>` : '';
      const codeBadge = liveBuy.code ? `<br><small class="mono" style="color:#ffb3ba">Kode: ${esc(liveBuy.code)}</small>` : '';
      const msgText = liveBuy.message ? `<br><small class="down" style="font-weight:600">Alasan: ${esc(liveBuy.message)}</small>` : '';
      liveBuyCell = `${buyTimeStr}<b class="down">❌ Submit BUY Gagal${statusBadge}</b>${codeBadge}${msgText}`;
    } else {
      const buyCost = ws?.historyBoughtCostUsd != null ? usd(ws.historyBoughtCostUsd) : (liveBuy?.stakeUsd ? usd(liveBuy.stakeUsd) : '—');
      const buyAmount = ws?.historyBoughtAmount ? `<br><small class="muted">Vol: ${f(ws.historyBoughtAmount, 2)} unit</small>` : '';
      const buyPrice = ws?.historyAvgCost ? `<br><small>Harga: ${usd(ws.historyAvgCost)}</small>` : '';
      const buyTx = liveBuy?.hash ? `<br><a class="mono tx-link" href="https://solscan.io/tx/${esc(liveBuy.hash)}" target="_blank" rel="noopener">Tx: ${esc(liveBuy.hash.slice(0, 8))}…</a>` : (liveBuy?.orderId ? `<br><span class="mono">Order: ${esc(liveBuy.orderId.slice(0, 10))}…</span>` : '');
      liveBuyCell = `${buyTimeStr}<b>Cost: ${buyCost}</b>${buyAmount}${buyPrice}${buyTx}`;
    }

    if (liveSell && liveSell.ok === false) {
      const sellTimeStr = liveSell?.observedAt ? `${timeExact(liveSell.observedAt)} WIB<br>` : '';
      const statusBadge = liveSell.status ? ` <span style="background:#5c1d1d;color:#ff9999;padding:1px 5px;border-radius:4px;font-size:11px">HTTP ${esc(liveSell.status)}</span>` : '';
      const codeBadge = liveSell.code ? `<br><small class="mono" style="color:#ffb3ba">Kode: ${esc(liveSell.code)}</small>` : '';
      const msgText = liveSell.message ? `<br><small class="down" style="font-weight:600">Alasan: ${esc(liveSell.message)}</small>` : '';
      liveSellCell = `${sellTimeStr}<b class="down">❌ Submit SELL Gagal${statusBadge}</b>${codeBadge}${msgText}`;
    } else if (liveSell || (ws && Number(ws.historySoldIncomeUsd) > 0)) {
      const sellTimeStr = liveSell?.observedAt ? `${timeExact(liveSell.observedAt)} WIB<br>` : '';
      const soldIncome = ws?.historySoldIncomeUsd != null ? usd(ws.historySoldIncomeUsd) : '—';
      const sellPrice = ws?.avgSold ? `<br><small>Harga: ${usd(ws.avgSold)}</small>` : '';
      const sellTx = liveSell?.hash ? `<br><a class="mono tx-link" href="https://solscan.io/tx/${esc(liveSell.hash)}" target="_blank" rel="noopener">Tx: ${esc(liveSell.hash.slice(0, 8))}…</a>` : (liveSell?.orderId ? `<br><span class="mono">Order: ${esc(liveSell.orderId.slice(0, 10))}…</span>` : '');
      liveSellCell = `${sellTimeStr}<b>Income: ${soldIncome}</b>${sellPrice}${sellTx}`;
    } else if (liveBuy && liveBuy.ok === false) {
      liveSellCell = '<span class="muted">Batal (Buy gagal)</span>';
    } else {
      liveSellCell = '<span class="watch">Menunggu sell riil</span>';
    }

    if (liveBuy && liveBuy.ok === false) {
      liveResultCell = '<span class="down" style="font-weight:700">Order tidak terisi</span>';
    } else if (ws?.grossPnlUsd != null) {
      const livePnlClass = ws.grossPnlUsd > 0 ? 'up' : ws.grossPnlUsd < 0 ? 'down' : '';
      const balNote = ws.balance && ws.balance !== '0' ? `<br><small class="watch">Sisa saldo: ${f(ws.balance, 0)}</small>` : '';
      liveResultCell = `<b class="${livePnlClass}">${usd(ws.grossPnlUsd)}</b><br><span class="${livePnlClass}">${pct(ws.grossPnlPercent)}</span>${balNote}`;

      if (sell && sell.pnlUsd != null) {
        const deltaUsd = ws.grossPnlUsd - sell.pnlUsd;
        const deltaClass = deltaUsd >= 0 ? 'up' : 'down';
        const priceSlippage = (ws.historyAvgCost && buy.entryPriceUsd) ? ((ws.historyAvgCost - buy.entryPriceUsd) / buy.entryPriceUsd * 100) : null;
        const slippageText = priceSlippage !== null ? `<br><small class="muted">Slip entry: ${pct(priceSlippage)}</small>` : '';
        deltaCell = `<b class="${deltaClass}">${usd(deltaUsd)}</b>${slippageText}`;
      }
    } else if (liveBuy && !liveSell) {
      liveResultCell = '<span class="watch">Posisi live terbuka</span>';
    }
  }

  return `<tr>
    <td><button class="token" data-mint="${esc(buy.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(buy.mint)}</span><small>Preview detail GMGN</small></button></td>
    <td>${simBuyCell}</td>
    <td>${simSellCell}</td>
    <td style="border-right:2px solid #2d4563">${simResultCell}</td>
    <td>${liveBuyCell}</td>
    <td>${liveSellCell}</td>
    <td style="border-right:2px solid #2d4563">${liveResultCell}</td>
    <td style="text-align:center">${deltaCell}</td>
  </tr>`;
}).join('');

const tradeTableHtml = (rows, emptyText) => `<div class="scroll"><table><thead><tr><th>Token</th><th>Buy simulasi</th><th>Kenapa dibeli</th><th>Sell simulasi</th><th>Kenapa dijual</th><th>Hasil</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">${emptyText}</td></tr>`}</tbody></table></div>`;
const controlTradeRows = tradeRows('control');
const r5BandTradeRows = tradeRows('r5-band');
const legacyTransactionsHtml = singleLaneMode
  ? `<h2>Komparasi Transaksi: Simulasi (Sinyal) vs Eksekusi Riil API (Wallet)</h2>
     <div class="scroll"><table class="comparison-table">
     <thead>
       <tr>
         <th rowspan="2" style="vertical-align:middle">Token</th>
         <th colspan="3" style="text-align:center;background:#152438;border-right:2px solid #2d4563">1. Perhitungan Sinyal Simulasi (Paper)</th>
         <th colspan="3" style="text-align:center;background:#102e26;border-right:2px solid #2d4563">2. Data Riil API / Wallet GMGN</th>
         <th rowspan="2" style="vertical-align:middle;text-align:center">Selisih Riil vs Sim</th>
       </tr>
       <tr>
         <th style="background:#152438">Buy Simulasi</th>
         <th style="background:#152438">Sell Simulasi</th>
         <th style="background:#152438;border-right:2px solid #2d4563">P/L Sinyal</th>
         <th style="background:#102e26">Buy Riil / Order</th>
         <th style="background:#102e26">Sell Riil / Order</th>
         <th style="background:#102e26;border-right:2px solid #2d4563">Gross P/L Riil</th>
       </tr>
     </thead>
     <tbody>
       ${comparisonTradeRows || '<tr><td colspan="8" class="muted" style="text-align:center">Belum ada transaksi.</td></tr>'}
     </tbody>
     </table></div>`
  : (strategy?.strategy === 'momentum-v2'
    ? `<h2>Transaksi simulasi V2</h2>${tradeTableHtml(controlTradeRows, 'Belum ada transaksi simulasi V2.') }<h2>Transaksi simulasi R5-band</h2>${tradeTableHtml(r5BandTradeRows, 'Belum ada transaksi simulasi R5-band.')}`
    : `<h2>Setiap transaksi simulasi</h2>${tradeTableHtml(tradeRows(null), 'Belum ada token yang masuk detail.')}`);
const transactionsHtml = strategy?.strategy === 'momentum-v2' ? v2LaneDashboardHtml : legacyTransactionsHtml;
const blocked = [...blockedByMint.values()];
for (const [mint, dumpRow] of dumpAbortedByMint) {
  if (!blockedByMint.has(mint)) {
    blocked.push({
      mint,
      observedAt: dumpRow.observedAt,
      priceUsd: dumpRow.currentPriceUsd ?? null,
      entryGate: {},
      candleDecision: null,
    });
  }
}
const waitingForPriceRows = [...detailStartedByMint.values()]
  .filter(row => !blockedByMint.has(row.mint) && !dumpAbortedByMint.has(row.mint) && !buys.some(buy => buy.mint === row.mint))
  .filter(row => !completedDetails.has(row.mint))
  .slice().reverse().map(row => {
    const screen = screened.get(row.mint), symbol = screen?.metadata?.symbol ?? 'Token';
    const sum = tokenSummaries.get(row.mint);
    const detailTime = sum?.detailStartedAt ?? row.startedAt;
    return `<tr><td><button class="token" data-mint="${esc(row.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(row.mint)}</span><small>Preview data socket</small></button></td><td>${time(detailTime)}</td><td>—</td><td>Menunggu tick</td><td>—</td><td><b class="watch">Masuk detail</b><br><span class="muted">Menunggu cukup harga, candle, dan transaksi untuk menilai buy simulasi.</span></td></tr>`;
  }).join('');
const blockedTable = waitingForPriceRows + blocked.slice().reverse().map(row => {
  const screen = screened.get(row.mint), symbol = screen?.metadata?.symbol ?? 'Token', gate = row.entryGate ?? {}, candle = row.candleDecision;
  const boughtLater = buys.some(buy => buy.mint === row.mint);
  const dumpEvent = dumpAbortedByMint.get(row.mint);
  const status = boughtLater
    ? 'Buy setelah harga pulih'
    : dumpEvent
    ? 'Observasi ditutup: Dump parah'
    : completedDetails.has(row.mint)
    ? 'Observasi selesai tanpa buy'
    : 'Masih monitoring';
  const statusClass = dumpEvent ? 'down' : 'watch';
  const detail = boughtLater
    ? 'Buy awal diblok; simulasi baru membeli setelah harga stabil/pulih.'
    : dumpEvent
    ? `Token dump terdeteksi (${esc(dumpEvent.details ?? dumpEvent.reason)}). Worker dilepas lebih awal.`
    : candle
    ? `Buy diblok: riwayat candle 1 menit belum aman (${candle.reason}).`
    : row.reason ? `Belum buy: ${row.reason}` : 'Tidak ada buy simulasi selama harga masih turun.';
  const momentumText = dumpEvent && dumpEvent.drawdownPercent !== null
    ? `-${f(dumpEvent.drawdownPercent, 1)}%`
    : candle
    ? esc(candle.reason)
    : pct(gate.momentum5sPercent);
  const sum = tokenSummaries.get(row.mint);
  const detailStartCell = time(sum?.detailStartedAt ?? detailStartedByMint.get(row.mint)?.startedAt ?? row.observedAt);
  // Alasan terkini dari snapshot monitoring terakhir
  const latestSnap = sum?.monitoringTimeline?.at(-1);
  const detailBlockReasons = (latestSnap?.blockingReasons ?? []).filter(reason => !reason.startsWith('R5_BAND:'));
  const latestBlockText = detailBlockReasons.length
    ? detailBlockReasons.map(r => esc(r.replace(/^([^:]+):/, '<b>$1</b>: '))).join('; ')
    : detail;
  return `<tr><td><button class="token" data-mint="${esc(row.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(row.mint)}</span><small>Preview data socket</small></button></td><td>${detailStartCell}</td><td>${usd(row.priceUsd)}</td><td class="down">${momentumText}</td><td>${candle ? '—' : f(gate.consecutiveDeclines, 0)}</td><td><b class="${statusClass}">${status}</b><br><span class="muted">${latestBlockText}</span></td></tr>`;
}).join('');
const profit = sells.filter(row => row.pnlUsd > 0).reduce((sum, row) => sum + row.pnlUsd, 0);
const loss = sells.filter(row => row.pnlUsd < 0).reduce((sum, row) => sum + row.pnlUsd, 0);
const totalPnl = sells.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0);
const open = buys.length - sells.length - unpricedByMint.size;
const laneSummary = summary?.lanes ?? Object.fromEntries(['control', 'r5-band'].map(lane => {
  const laneBuys = buys.filter(row => paperLane(row) === lane), laneSells = sells.filter(row => paperLane(row) === lane);
  return [lane, { positionsOpened: laneBuys.length, positionsClosed: laneSells.length, openAtEnd: laneBuys.length - laneSells.length,
    totalPnlUsd: laneSells.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0), profitable: laneSells.filter(row => row.pnlUsd > 0).length, losing: laneSells.filter(row => row.pnlUsd < 0).length }];
}));
const laneFinancials = Object.fromEntries(['control', 'r5-band'].map(lane => {
  const laneSells = sells.filter(row => paperLane(row) === lane);
  const profit = laneSells.filter(row => row.pnlUsd > 0).reduce((sum, row) => sum + row.pnlUsd, 0);
  const loss = laneSells.filter(row => row.pnlUsd < 0).reduce((sum, row) => sum + row.pnlUsd, 0);
  return [lane, { profit, loss, pnl: profit + loss }];
}));
const laneComparisonHtml = (strategy?.strategy === 'momentum-v2' && !singleLaneMode) ? `<h2>Hasil per lane paper</h2><div class="scroll"><table><thead><tr><th>Lane</th><th>Entry</th><th>Exit</th><th>Masih terbuka</th><th>Menang / kalah</th><th>Keuntungan</th><th>Kerugian</th><th>P/L sinyal</th></tr></thead><tbody>${Object.entries(laneSummary).map(([lane, value]) => { const financial = laneFinancials[lane] ?? { profit: 0, loss: 0, pnl: value.totalPnlUsd ?? 0 }; return `<tr><td><b>${paperLaneLabel(lane)}</b></td><td>${value.positionsOpened ?? 0}</td><td>${value.positionsClosed ?? 0}</td><td>${value.openAtEnd ?? 0}</td><td>${value.profitable ?? 0} / ${value.losing ?? 0}</td><td class="up">${usd(financial.profit)}</td><td class="down">${usd(financial.loss)}</td><td class="${financial.pnl > 0 ? 'up' : financial.pnl < 0 ? 'down' : ''}">${usd(financial.pnl)}</td></tr>`; }).join('')}</tbody></table></div>` : '';
const allLanes = strategy?.strategy === 'momentum-v2' && !singleLaneMode;
const liveRealizedTrades = [...walletstatByMint.values()].filter(w => w.grossPnlUsd !== null && Number(w.historySoldIncomeUsd) > 0);
const totalLivePnl = liveRealizedTrades.reduce((acc, w) => acc + (w.grossPnlUsd ?? 0), 0);
const liveProfitCount = liveRealizedTrades.filter(w => (w.grossPnlUsd ?? 0) > 0).length;
const liveLossCount = liveRealizedTrades.filter(w => (w.grossPnlUsd ?? 0) < 0).length;

const gridCardsHtml = singleLaneMode
  ? `<div class="grid">
      <div class="card"><div class="label">Total Posisi</div><div class="value">${buys.length} <small style="font-size:14px;color:#9cafc5">(${sells.length} sell)</small></div></div>
      <div class="card"><div class="label">Masih Dipantau</div><div class="value watch">${open}</div></div>
      <div class="card"><div class="label">P/L Sinyal Simulasi</div><div class="value ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}">${usd(totalPnl)}</div></div>
      <div class="card"><div class="label">P/L Riil Walletstat</div><div class="value ${totalLivePnl > 0 ? 'up' : totalLivePnl < 0 ? 'down' : ''}">${liveRealizedTrades.length ? usd(totalLivePnl) : '—'}</div></div>
      <div class="card"><div class="label">Selisih Real vs Sim</div><div class="value ${(totalLivePnl - totalPnl) >= 0 ? 'up' : 'down'}">${liveRealizedTrades.length ? usd(totalLivePnl - totalPnl) : '—'}</div></div>
      <div class="card"><div class="label">Kendala Submit Live</div><div class="value ${liveErrors.length > 0 ? 'down' : 'up'}">${liveErrors.length > 0 ? `${liveErrors.length} Error` : 'Aman (0)'}</div></div>
    </div>`
  : `<div class="grid"><div class="card"><div class="label">${allLanes ? 'Buy seluruh lane' : 'Simulasi buy'}</div><div class="value">${buys.length}</div></div><div class="card"><div class="label">${allLanes ? 'Sell seluruh lane' : 'Sudah sell'}</div><div class="value">${sells.length}</div></div><div class="card"><div class="label">${strategy?.strategy === 'pump-band' ? 'Harga keluar tak segar' : 'Masih dipantau'}</div><div class="value watch">${strategy?.strategy === 'pump-band' ? unpricedByMint.size : open}</div></div><div class="card"><div class="label">${allLanes ? 'Keuntungan seluruh lane' : 'Total keuntungan'}</div><div class="value up">${usd(profit)}</div></div><div class="card"><div class="label">${allLanes ? 'Kerugian seluruh lane' : 'Total kerugian'}</div><div class="value down">${usd(loss)}</div></div><div class="card"><div class="label">${allLanes ? 'P/L seluruh lane' : 'P/L total'}</div><div class="value ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}">${usd(totalPnl)}</div></div></div>`;

const liveErrorRows = liveErrors.slice().reverse().map(err => {
  const screen = screened.get(err.mint);
  const symbol = screen?.metadata?.symbol ?? (err.mint ? err.mint.slice(0, 8) : 'Umum');
  const statusBadge = err.status ? `<span style="background:#5c1d1d;color:#ff9999;padding:2px 7px;border-radius:4px;font-weight:700;font-size:12px">HTTP ${esc(err.status)}</span>` : '<span class="muted">—</span>';
  const codeBadge = err.code ? ` <code style="color:#ffb3ba;font-size:11px">${esc(err.code)}</code>` : '';
  const sideBadge = err.side === 'BUY' ? '<b class="up">BUY</b>' : (err.side === 'SELL' ? '<b class="down">SELL</b>' : '<b>AUTH</b>');
  const tokenCell = err.mint ? `<button class="token" data-mint="${esc(err.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono" style="font-size:11px">${esc(err.mint.slice(0, 10))}…</span></button>` : '—';
  return `<tr>
    <td style="white-space:nowrap">${timeExact(err.observedAt)} WIB</td>
    <td>${sideBadge}</td>
    <td>${tokenCell}</td>
    <td>${statusBadge}${codeBadge}</td>
    <td style="color:#ffc0c0">${esc(err.message)}</td>
  </tr>`;
}).join('');

const liveErrorSectionHtml = liveErrors.length > 0
  ? `<div style="background:#261215;border:1px solid #792828;border-left:4px solid #ff4d4f;border-radius:10px;padding:16px 20px;margin:20px 0">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="font-size:22px">⚠️</span>
        <div>
          <strong style="color:#ff7875;font-size:16px">Riwayat Kendala / Error Submit Live (${liveErrors.length})</strong>
          <div class="muted" style="font-size:12px">Terdeteksi kendala saat submit order ke GMGN API (misal: HTTP 403 Forbidden, 401 token expired, slippage, dsb).</div>
        </div>
      </div>
      <div class="scroll">
        <table style="min-width:800px;font-size:13px">
          <thead>
            <tr>
              <th style="background:#3a181c;padding:8px 10px">Waktu</th>
              <th style="background:#3a181c;padding:8px 10px">Sisi</th>
              <th style="background:#3a181c;padding:8px 10px">Token</th>
              <th style="background:#3a181c;padding:8px 10px">Status / Kode</th>
              <th style="background:#3a181c;padding:8px 10px">Detail Pesan GMGN API</th>
            </tr>
          </thead>
          <tbody>
            ${liveErrorRows}
          </tbody>
        </table>
      </div>
    </div>`
  : '';

const pumpBandNote = strategy?.strategy === 'pump-band'
  ? `Token fresh dalam market cap $3.000–$10.000 mendapat slot detail kosong. Buy simulasi $${f(manifest?.simulation?.stakeUsd ?? 0.25, 2)} dilakukan pada tick transaksi pu baru pertama. Sell simulasi terjadi saat harga turun 20% dari puncak, atau setelah 20 detik jika harga terakhir masih berumur paling lama 5 detik. Fee dan slippage belum dihitung. ${unpricedByMint.size} sesi selesai tanpa harga jual segar sehingga P/L-nya belum dinilai.`
  : `Setiap token yang lolos screening dan masuk detail dibeli secara simulasi sebesar <b>${usd(manifest?.simulation?.stakeUsd ?? 0.25)}</b>. Fee, slippage, dampak harga, dan swap nyata dihitung 0.${strategy?.strategy === 'momentum-v2' && !singleLaneMode ? ' Kontrol V2 dan R5-band memakai data socket yang sama, tetapi posisi serta P/L dicatat per lane. Jam sinyal, trade pasar, WebSocket, dan order simulasi dicatat terpisah sampai milidetik. Target order simulasi 0,9 detik, batas 1 detik setelah sinyal. P/L tetap memakai tick pemicu; belum ada permintaan GMGN, fill, atau harga eksekusi nyata.' : ''}`;
const pumpBandRulesHtml = strategy?.strategy === 'pump-band'
  ? '<h2>Arti sinyal sell</h2><div class="rule"><b>PUMP_DUMP_20</b>: harga transaksi pu turun sedikitnya 20% dari puncak yang tertangkap setelah buy.</div><div class="rule"><b>PUMP_OBSERVATION_END</b>: sesi 20 detik selesai dan harga transaksi terakhir masih segar. Harga yang lebih tua dari 5 detik tidak dipakai untuk menghitung hasil jual.</div>'
  : '<h2>Arti sinyal sell</h2><div class="rule"><b>Holder growth recovery</b> menahan posisi 10 detik saat harga −10% sampai sebelum −20%, holder total naik ≥10% dan ≥5, serta buy USD 5 detik ≥ sell USD. Stop −20% tetap berlaku.</div><div class="rule"><b>Target +40% dengan holder momentum</b> menunda sell hanya jika dua pembaruan holder signifikan datang berurutan dan harga masih naik ≥2% per 5 detik. Saat kenaikan melandai &lt;0,5% per 5 detik, exit memakai <code>TARGET_40_HOLDER_FLAT</code>.</div><div class="rule"><b>Sell pressure</b> memerlukan dua jendela socket 5-detik selesai berturut-turut: ≥10 trade, ≥3 penjual kandidat, sell USD share ≥70%, dan posisi sudah ≤−5%.</div><p class="muted">Sinyal hold holder tercatat: ' + holds.length + '. Aturan holder hanya aktif bila socket memberi angka total holder baru; daftar holder parsial tidak dipakai sebagai total.</p>';
const title = `Laporan simulasi — ${basename(folder)}`;
const tagText = (singleLaneMode && (liveOrdersByMint.size > 0 || liveRealizedTrades.length > 0))
  ? 'GMGN LIVE TRADE & SIMULATION COMPARISON'
  : 'GMGN SOCKET · PAPER SIMULATION · BUKAN ORDER NYATA';
let html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#09111d;color:#e8eff8;font:15px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:1500px;margin:auto;padding:30px}.tag{color:#6be1b2;font-weight:700;letter-spacing:1px;font-size:12px}.muted{color:#9cafc5}.note{background:#19273a;border-left:3px solid #7fb8ff;padding:14px 17px;border-radius:6px}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:20px 0}.card{padding:17px;background:#111e2e;border:1px solid #263950;border-radius:12px}.label{color:#9cafc5;font-size:13px}.value{font-size:23px;font-weight:700;margin-top:4px}.up{color:#62dfa8}.down{color:#ff9299}.watch{color:#ffce76;font-weight:700}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1100px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #263950}th{color:#a9c1df;background:#0d1827}.mono{font:11px ui-monospace,Consolas,monospace;color:#a9c1df;word-break:break-all}.tx-link{color:#58b4ff;text-decoration:none}.tx-link:hover{text-decoration:underline}.rule{background:#111e2e;border:1px solid #263950;border-radius:10px;padding:14px;margin:10px 0}.token{padding:0;border:0;background:transparent;color:#e8eff8;text-align:left;cursor:pointer}.token:hover b,.token:hover small{color:#6be1b2}.token small{display:block;color:#7fb8ff;margin-top:4px}.comparison-table th{padding:10px 12px;font-size:13px}.comparison-table td{padding:11px 12px;font-size:13px;border-right:1px solid #1a293c}.comparison-table tr:hover td{background:#132235}.lane-ledger-intro{margin:22px 0 10px;padding:14px 17px;background:#102a2b;border:1px solid #245a59;border-radius:10px}.lane-ledger{margin:28px 0 42px}.lane-ledger h2{margin:0 0 6px;color:#8ed8ff}.ledger-table{min-width:1420px}.ledger-table th{white-space:nowrap}.ledger-table .ledger-main:hover td{background:#132235}.ledger-reason td{background:#0d1827;color:#c7d6e8;padding:12px 16px 14px}.ledger-reason div+div{margin-top:7px}.ledger-table tfoot th{background:#16283a;border-top:2px solid #4c779d;border-bottom:0}.modal{position:fixed;inset:0;z-index:10;background:#000b;display:none;place-items:center;padding:20px}.modal.open{display:grid}.dialog{width:min(1400px,96vw);height:min(860px,92vh);background:#111e2e;border:1px solid #426381;border-radius:14px;display:grid;grid-template-rows:auto 1fr;overflow:hidden;box-shadow:0 24px 80px #000}.modal-head{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#19273a}.modal-head strong{margin-right:auto}.modal-head a,.modal-head button{border:1px solid #49739a;border-radius:7px;background:#0e1a29;color:#e8eff8;padding:7px 10px;text-decoration:none;cursor:pointer}.modal iframe{display:none}.preview{overflow:auto;padding:24px}.preview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.preview .card{min-height:62px}.preview h3{margin:20px 0 8px}.preview a{color:#7fb8ff}.tl-table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px}.tl-table th{background:#0d1827;color:#a9c1df;padding:7px 10px;text-align:left;position:sticky;top:0;z-index:1}.tl-table td{padding:6px 10px;border-bottom:1px solid #1e2e40;vertical-align:top}.tl-table tr:hover td{background:#192a3d}.tl-scroll{max-height:280px;overflow:auto;border:1px solid #263950;border-radius:8px;margin-top:6px}.hbar{display:flex;align-items:center;gap:5px;font-size:12px;margin:2px 0}.hbar-fill{height:8px;border-radius:4px;background:#5b8ecc;flex-shrink:0}.hbar-fill.dev{background:#f5a623}.hbar-pct{color:#9cafc5;min-width:42px;text-align:right}.hbar-addr{font:10px ui-monospace,Consolas,monospace;color:#7d9bb7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}.delta-up{color:#62dfa8}.delta-down{color:#ff9299}.block-reason{font-size:11px;color:#ffce76;background:#1e2c10;border-radius:3px;padding:1px 5px;margin:1px 2px;display:inline-block}#refresh-bar{position:fixed;top:0;left:0;right:0;height:3px;background:#1e3a5a;z-index:20}#refresh-fill{height:100%;width:0;background:#6be1b2;transition:width 10s linear}@media(max-width:800px){main{padding:16px}.grid{grid-template-columns:1fr 1fr}.modal{padding:6px}.dialog{width:100%;height:96vh}.preview-grid{grid-template-columns:1fr 1fr}}</style><div id="refresh-bar"><div id="refresh-fill"></div></div><main><div class="tag">${tagText}</div><h1>${title}</h1><p class="muted">Laporan diperbarui setiap 10 detik. Data terakhir dibaca ${time(Date.now())} WIB; run mulai ${time(Date.parse(manifest?.startedAt ?? ''))} WIB.</p><div class="note">${pumpBandNote}</div>${gridCardsHtml}${liveErrorSectionHtml}${transactionsHtml}${pumpBandRulesHtml}</main><div class="modal" id="tokenModal" role="dialog" aria-modal="true"><div class="dialog"><div class="modal-head"><strong id="modalTitle">Detail token</strong><a id="openGmgn" target="_blank" rel="noopener">Buka GMGN penuh</a><button id="closeModal">Tutup</button></div><section class="preview" id="localPreview"></section></div></div><script>
const modal=document.querySelector('#tokenModal'),titleEl=document.querySelector('#modalTitle'),openLink=document.querySelector('#openGmgn'),preview=document.querySelector('#localPreview');
let _activeMint=null;
function closeModal(){modal.classList.remove('open')}
function fmtTime(ts){return ts?new Date(ts).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—'}
function fmtPrice(v){if(v==null)return'—';const n=Number(v);return Number.isFinite(n)?'$'+n.toLocaleString('en-US',{maximumFractionDigits:Math.abs(n)<0.01?10:6}):'—'}
function fmtNum(v,d=2){const n=Number(v);return Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:d}):'—'}
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function buildTimelineTable(timeline){
  if(!timeline||!timeline.length)return'<p class="muted">Belum ada snapshot monitoring (akan muncul setelah token diobservasi selama &ge;5 detik tanpa buy).</p>';
  const rows=[...timeline].map(s=>{
    const dt=s.holderDelta;
    const dtStr=dt==null?'—':dt>0?'<span class="delta-up">+'+dt+'</span>':'<span class="delta-down">'+dt+'</span>';
    const reasons=(s.blockingReasons||[]).map(r=>'<span class="block-reason">'+esc(r)+'</span>').join(' ');
    const reasonCell=reasons||'<span style="color:#62dfa8;font-size:11px">\u2714 semua gate ok</span>';
    return'<tr><td style="white-space:nowrap">'+fmtTime(s.observedAt)+'</td><td>'+(s.holderCount??'—')+'</td><td>'+dtStr+'</td><td><span class="up">'+s.buys5s+'</span> / <span class="down">'+s.sells5s+'</span></td><td>'+fmtPrice(s.priceUsd)+'</td><td>'+reasonCell+'</td></tr>';
  }).join('');
  return'<div class="tl-scroll"><table class="tl-table"><thead><tr><th>Jam</th><th>Holder</th><th>&Delta; Holder</th><th>Buy / Sell (5s)</th><th>Harga</th><th>Alasan belum beli</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function buildTop10(timeline){
  if(!timeline||!timeline.length)return'<p class="muted">Belum ada data distribusi holder.</p>';
  const snap=[...timeline].reverse().find(s=>s.top10Holders&&s.top10Holders.length);
  if(!snap)return'<p class="muted">Belum ada data top-10 holder (holder API belum terpanggil).</p>';
  const holders=snap.top10Holders;
  const maxPct=Math.max(0,...holders.map(h=>h.pct||0));
  const total=holders.reduce((a,h)=>a+(h.pct||0),0);
  const rows=holders.map((h,i)=>{
    const barW=maxPct>0?Math.round((h.pct||0)/maxPct*120):0;
    const addr=h.wallet?h.wallet.slice(0,8)+'\u2026'+h.wallet.slice(-4):'—';
    const devBadge=h.isDev?' <span style="color:#f5a623;font-size:10px">[DEV]</span>':'';
    return'<div class="hbar"><span style="color:#9cafc5;min-width:22px;font-size:12px;text-align:right">#'+(i+1)+'</span><div class="hbar-fill'+(h.isDev?' dev':'')+'" style="width:'+barW+'px"></div><span class="hbar-pct">'+fmtNum(h.pct,2)+'%</span><span class="hbar-addr">'+esc(addr)+'</span>'+devBadge+'</div>';
  }).join('');
  return'<div style="background:#0d1827;border-radius:8px;padding:12px 14px">'+rows+'<div style="font-size:12px;color:#9cafc5;margin-top:8px;border-top:1px solid #263950;padding-top:6px">Total top-'+holders.length+': <b>'+fmtNum(total,2)+'%</b> &nbsp;·&nbsp; snapshot: '+fmtTime(snap.observedAt)+'</div></div>';
}
// Render modal content dari data object
function renderModalContent(mint,d){
  const detailTimeStr=d.detailStartedAt?('<b>'+fmtTime(d.detailStartedAt)+'</b> WIB'):'—';
  const snapCount=(d.monitoringTimeline||[]).length;
  preview.innerHTML=
    '<h2>'+esc(d.symbol||'Token')+'</h2><p class="mono">'+esc(mint)+'</p>'+
    '<div style="background:#132233;border-left:3px solid #6be1b2;padding:10px 16px;border-radius:6px;margin-bottom:14px;font-size:13px">'+
      '\u23f1\ufe0f Pertama masuk detail: '+detailTimeStr+
      ' &nbsp;\u00b7\u00a0 Snapshot monitoring: <b>'+snapCount+'</b> titik'+
      (snapCount?'<span style="color:#6be1b2;font-size:11px;float:right">\u27f3 diperbarui '+fmtTime(Date.now())+'</span>':'')+
    '</div>'+
    '<div class="preview-grid">'+
      '<div class="card"><div class="label">Harga buy simulasi</div><div class="value">'+esc(d.entryPrice||'—')+'</div></div>'+
      '<div class="card"><div class="label">Harga terakhir socket</div><div class="value">'+esc(d.lastPrice||'—')+'</div></div>'+
      '<div class="card"><div class="label">Likuiditas saat lolos</div><div class="value">'+esc(d.liquidity||'—')+'</div></div>'+
      '<div class="card"><div class="label">Holder saat lolos</div><div class="value">'+esc(d.holders||'—')+'</div></div>'+
      '<div class="card"><div class="label">Trade detail tertangkap</div><div class="value">'+(d.buys??0)+' buy / '+(d.sells??0)+' sell</div></div>'+
      '<div class="card"><div class="label">Arus USD tertangkap</div><div class="value">'+esc(d.buyUsd||'—')+' / '+esc(d.sellUsd||'—')+'</div></div>'+
    '</div>'+
    '<h3>Keputusan simulasi</h3><p>'+esc(d.decision||'—')+'</p>'+
    '<h3>Kenapa dibeli / diblok</h3><p>'+esc(d.buyReason||'—')+'</p>'+
    '<h3>\ud83d\udcca Timeline monitoring (snapshot tiap 5 dtk, sebelum buy)</h3>'+buildTimelineTable(d.monitoringTimeline)+
    '<h3>\ud83c\udfc6 Distribusi top-10 holder (snapshot terakhir)</h3>'+buildTop10(d.monitoringTimeline)+
    '<p class="muted" style="margin-top:16px">Preview lokal dari data socket yang tersimpan. Gunakan tombol \u201cBuka GMGN penuh\u201d untuk detail live.</p>';
}
document.querySelectorAll('.token').forEach(button=>button.addEventListener('click',async()=>{
  const mint=button.dataset.mint,url='https://gmgn.ai/sol/token/'+encodeURIComponent(mint);
  titleEl.textContent=(button.dataset.symbol||'Token')+' — data socket';
  openLink.href=url;
  preview.innerHTML='<p class="muted">Memuat detail…</p>';
  _activeMint=mint;
  modal.classList.add('open');
  try{
    const res=await fetch(previewBase+encodeURIComponent(mint)+'.json',{cache:'no-store'});
    const d=res.ok?await res.json():{};
    window.__preview[mint]=d;
    if(_activeMint===mint) renderModalContent(mint,d);
  }catch(e){preview.innerHTML='<p class="muted">Detail belum dapat dimuat. Coba tutup lalu buka lagi.</p>';console.warn('[preview-load-error]',e);}
}));
document.querySelector('#closeModal').addEventListener('click',()=>{_activeMint=null;closeModal()});
modal.addEventListener('click',event=>{if(event.target===modal){_activeMint=null;closeModal()}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){_activeMint=null;closeModal()}});
// Refresh hanya detail yang sedang dibuka, bukan seluruh report atau preview.
function startRefreshCycle(){
  const fill=document.getElementById('refresh-fill');
  function resetBar(){if(fill){fill.style.transition='none';fill.style.width='0';requestAnimationFrame(()=>requestAnimationFrame(()=>{fill.style.transition='width 10s linear';fill.style.width='100%';}));}}
  async function kick(){
    resetBar();
    if(_activeMint&&modal.classList.contains('open')){
      try{
        const res=await fetch(previewBase+encodeURIComponent(_activeMint)+'.json',{cache:'no-store'});
        if(res.ok){const fresh=await res.json();window.__preview[_activeMint]=fresh;renderModalContent(_activeMint,fresh);}
      }catch(e){console.warn('[refresh-error]',e);}
    }
    setTimeout(kick,10000);
  }
  setTimeout(kick,10000);
}
startRefreshCycle();
</script></html>`;
html = html.replace('<h1>', '<nav style="display:flex;gap:8px;margin-bottom:18px"><a style="padding:8px 12px;border:1px solid #426381;border-radius:7px;color:#fff;background:#235577;text-decoration:none" href="/paper-simulation-report.html">Run terbaru</a><a style="padding:8px 12px;border:1px solid #426381;border-radius:7px;color:#b9d5f3;text-decoration:none" href="/run-history.html">Riwayat run</a></nav><h1>');
if (allLanes) html = html.replace(/<div class="card"><div class="label">Keuntungan seluruh lane<\/div><div class="value up">[^<]*<\/div><\/div><div class="card"><div class="label">Kerugian seluruh lane<\/div><div class="value down">[^<]*<\/div><\/div><div class="card"><div class="label">P\/L seluruh lane<\/div><div class="value[^\"]*">[^<]*<\/div><\/div>/, '');
if (allLanes) html = html.replace(/<div class="grid"><div class="card"><div class="label">Buy seluruh lane<\/div><div class="value">[^<]*<\/div><\/div><div class="card"><div class="label">Sell seluruh lane<\/div><div class="value">[^<]*<\/div><\/div><div class="card"><div class="label">Masih dipantau<\/div><div class="value watch">[^<]*<\/div><\/div><\/div>/, '');
if (routeComparisonHtml && strategy?.strategy !== 'momentum-v2') html = html.replace(transactionsHtml, `${routeComparisonHtml}${transactionsHtml}`);
if (laneComparisonHtml && strategy?.strategy !== 'momentum-v2') html = html.replace(transactionsHtml, `${laneComparisonHtml}${transactionsHtml}`);
if (strategy?.strategy !== 'momentum-v2') html = html.replace('<h2>Arti sinyal sell</h2>', `<h2>Masuk detail, belum dibeli</h2><p class="muted">Satu daftar bersama per token. Status ini memakai gate dasar dan Kontrol V2; R5-band hanya muncul sebagai lane tersendiri setelah ada transaksi simulasi.</p><div class="scroll"><table><thead><tr><th>Token</th><th>Terakhir diblok</th><th>Harga saat diblok</th><th>Perubahan 5 dtk</th><th>Turun beruntun</th><th>Status</th></tr></thead><tbody>${blockedTable || '<tr><td colspan="6" class="muted">Belum ada token yang diblok karena penurunan harga beruntun.</td></tr>'}</tbody></table></div><h2>Arti sinyal sell</h2>`);
const preview = Object.fromEntries(buys.map(buy => {
  const screen = screened.get(buy.mint), activity = activityByMint.get(buy.mint) ?? {}, sell = buy.positionId ? sellsByPosition.get(buy.positionId) : sellsByMint.get(buy.mint);
  const sum = tokenSummaries.get(buy.mint);
  const timeline = sum?.monitoringTimeline ?? [];
  return [buy.mint, { symbol: buy.metadata?.symbol ?? 'Token', entryPrice: usd(buy.entryPriceUsd), lastPrice: usd(activity.latestPriceUsd), liquidity: usd(fieldValue(screen, 'liquidityUsd')), holders: f(fieldValue(screen, 'holders'), 0), buys: activity.buys ?? 0, sells: activity.sells ?? 0, buyUsd: usd(activity.buyUsd), sellUsd: usd(activity.sellUsd), buyReason: buyReason(buy), decision: sell ? sellReason(sell) + ' Hasil: ' + usd(sell.pnlUsd) + ' (' + pct(sell.pnlPercent) + ').' : 'Masih dipantau; belum ada sinyal sell.', detailStartedAt: sum?.detailStartedAt ?? null, monitoringTimeline: timeline }];
}));
for (const row of blocked) {
  if (preview[row.mint]) continue;
  const screen = screened.get(row.mint), activity = activityByMint.get(row.mint) ?? {}, gate = row.entryGate ?? {};
  const dumpEvent = dumpAbortedByMint.get(row.mint);
  const sum = tokenSummaries.get(row.mint);
  const timeline = sum?.monitoringTimeline ?? [];
  const decisionText = dumpEvent
    ? `Observasi ditutup otomatis karena token mengalami dump parah: ${dumpEvent.details ?? dumpEvent.reason}. Slot worker langsung dibebaskan.`
    : `Buy diblok karena harga masih turun: ${pct(gate.momentum5sPercent)} dalam 5 detik, ${f(gate.consecutiveDeclines, 0)} penurunan harga beruntun. ${completedDetails.has(row.mint) ? 'Observasi detail selesai tanpa buy.' : 'Token tetap dipantau sampai harga stabil atau pulih.'}`;
  preview[row.mint] = { symbol: screen?.metadata?.symbol ?? 'Token', entryPrice: 'Belum dibeli', lastPrice: usd(activity.latestPriceUsd ?? row.priceUsd), liquidity: usd(fieldValue(screen, 'liquidityUsd')), holders: f(fieldValue(screen, 'holders'), 0), buys: activity.buys ?? 0, sells: activity.sells ?? 0, buyUsd: usd(activity.buyUsd), sellUsd: usd(activity.sellUsd), buyReason: buyReason({ mint: row.mint }), decision: decisionText, detailStartedAt: sum?.detailStartedAt ?? detailStartedByMint.get(row.mint)?.startedAt ?? null, monitoringTimeline: timeline };
}
// Token yang masuk detail tapi belum ada blocked event maupun buy
// (kategori "menunggu tick" / masih awal monitoring) juga harus punya data preview
for (const row of detailStartedByMint.values()) {
  if (preview[row.mint]) continue;
  if (buys.some(buy => buy.mint === row.mint)) continue;
  const screen = screened.get(row.mint), activity = activityByMint.get(row.mint) ?? {};
  const sum = tokenSummaries.get(row.mint);
  const timeline = sum?.monitoringTimeline ?? [];
  const latestSnap = timeline.at(-1);
  const latestPrice = latestSnap?.priceUsd ?? activity.latestPriceUsd ?? null;
  const latestBlockReasons = latestSnap?.blockingReasons?.length
    ? latestSnap.blockingReasons.join('; ')
    : 'Menunggu data harga, candle, dan trade yang cukup untuk menilai kondisi buy.';
  const isDump = dumpAbortedByMint.has(row.mint);
  const dumpEvent = dumpAbortedByMint.get(row.mint);
  const decisionText = isDump
    ? `Observasi ditutup otomatis karena dump parah: ${dumpEvent?.details ?? dumpEvent?.reason}.`
    : latestBlockReasons;
  preview[row.mint] = {
    symbol: screen?.metadata?.symbol ?? 'Token',
    entryPrice: 'Belum dibeli',
    lastPrice: usd(latestPrice),
    liquidity: usd(fieldValue(screen, 'liquidityUsd')),
    holders: f(fieldValue(screen, 'holders'), 0),
    buys: activity.buys ?? 0,
    sells: activity.sells ?? 0,
    buyUsd: usd(activity.buyUsd),
    sellUsd: usd(activity.sellUsd),
    buyReason: buyReason({ mint: row.mint }),
    decision: decisionText,
    detailStartedAt: sum?.detailStartedAt ?? row.startedAt ?? null,
    monitoringTimeline: timeline,
  };
}
const previewBase='/research-preview/'+encodeURIComponent(basename(folder))+'/';
html = html.replace('<script>', `<script>window.__preview={};const previewBase='${previewBase}';`);
if (strategy?.strategy === 'momentum-v2') {
  // Keep this view strictly to completed/current V2 and R5 positions.  The
  // blocked-token and rules sections are useful for research, but obscure the
  // per-lane execution comparison requested by the dashboard.
  html = html.replace(/<h2>Arti sinyal sell<\/h2>[\s\S]*?<\/main>/, '</main>');
  html = html.replace(gridCardsHtml, '');
  html = html.replace(liveErrorSectionHtml, '');
  html = html.replace('<div class="note">' + pumpBandNote + '</div>', '<div class="note">Dua lane berjalan pada data socket yang sama. P/L <b>paper</b> memakai harga socket; P/L <b>quote</b> memakai amount-in/amount-out dari route GMGN. Semua route hanya estimasi dan tidak pernah disubmit.</div>');
}
if (strategy?.strategy === 'flow-3') {
  html = html.replace(/<h2>Arti sinyal sell<\/h2>[\s\S]*?<\/main>/, `<h2>Aturan flow-3</h2><div class="rule">Screening tetap memakai umur 0–900 detik, holder minimal 20, likuiditas $6.000–$15.000, dan Top-10 maksimal 30%. Entry memerlukan harga detail yang stabil serta minimal 5 trade dalam 20 detik dengan USD buy ≥ USD sell. Riwayat dua candle diperbolehkan, selama candle berjalan tidak turun.</div><div class="rule">Exit flow-3: target +40%, stop −20%, trailing 10% setelah puncak minimal +20%, atau sell pressure dua window. Tidak memakai gate holder-distribution, blind-protection, target dinamis, maupun exit developer/whale dari strategi yang lebih baru.</div></main>`);
  html = html.replace('Setiap token yang lolos screening dan masuk detail dibeli secara simulasi sebesar', 'Token dibeli simulasi setelah gate flow-3 lolos; nominal');
}
mkdirSync(join(folder, 'simulation-preview'), { recursive: true });
for (const [mint, data] of Object.entries(preview)) writeFileSync(join(folder, 'simulation-preview', mint), JSON.stringify(data));
writeFileSync(join(folder, 'simulation-preview.json'), JSON.stringify(preview));
writeFileSync(join(folder, 'simulation-report.html'), html);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/paper-simulation-report.html', html);
console.log(JSON.stringify({ report: join(folder, 'simulation-report.html'), latest: 'dist/paper-simulation-report.html', buys: buys.length, positions: sells.length, totalPnlUsd: totalPnl }));
