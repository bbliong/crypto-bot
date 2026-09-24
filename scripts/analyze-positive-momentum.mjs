import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [collectorDir, simulatorDir] = process.argv.slice(2);
if (!collectorDir) {
  throw new Error('Usage: node scripts/analyze-positive-momentum.mjs <pump-band-run> [simulator-run]');
}
const outputDir = join('research', `positive-momentum-${new Date().toISOString().replace(/[:.]/g, '-')}`);
mkdirSync(outputDir, { recursive: true });
const readRows = (dir, file) => {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
};
const groupBy = (rows, key) => {
  const grouped = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!grouped.has(value)) grouped.set(value, []);
    grouped.get(value).push(row);
  }
  return grouped;
};
const group = rows => groupBy(rows, row => row.mint);
const number = value => value === null || value === undefined || value === '' ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const sum = rows => rows.reduce((total, value) => total + value, 0);
const pct = (value, digits = 1) => value === null ? '—' : `${value.toFixed(digits)}%`;
const fmt = (value, digits = 1) => value === null ? '—' : value.toFixed(digits);
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const median = values => {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
};

function buildRun(name, dir) {
  const summaries = readRows(dir, 'token-summary.jsonl');
  const trades = group(readRows(dir, 'trades.jsonl'));
  const counts = group(readRows(dir, name === 'Collector' ? 'holder-counts.jsonl' : 'token-stat.jsonl'));
  const snapshots = group(readRows(dir, 'holder-snapshots.jsonl'));
  const candleSnapshots = group(readRows(dir, 'mcap-candles.jsonl'));
  const socketTicks = group(readRows(dir, 'socket-ticks.jsonl'));
  return summaries.map(summary => {
    const mint = summary.mint;
    const start = summary.startedAt;
    const end = summary.endedAt;
    const tokenTrades = (trades.get(mint) ?? []).filter(row => row.observedAt >= start && row.observedAt <= end);
    // One received WebSocket frame is one actionable price observation. Its historical
    // trades must never become multiple sequential entry/exit opportunities.
    const frames = name === 'Collector'
      ? (socketTicks.get(mint) ?? []).filter(row => row.source === 'detail_socket_activity' && number(row.priceUsd) > 0)
        .map(row => ({ observedAt: row.observedAt, priceUsd: number(row.priceUsd) }))
      : [...groupBy(tokenTrades.filter(row => number(row.priceUsd) > 0), row => row.observedAt)]
        .map(([observedAt, rows]) => {
          const latest = rows.toSorted((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0)).at(-1);
          return { observedAt, priceUsd: number(latest.priceUsd) };
        });
    const prices = frames.filter(row => row.observedAt >= start && row.observedAt <= end)
      .sort((a, b) => a.observedAt - b.observedAt);
    const first = prices[0] ?? null;
    const later = first ? prices.filter(row => row.observedAt > first.observedAt) : [];
    const peak = later.length ? later.reduce((best, row) => row.priceUsd > best.priceUsd ? row : best) : null;
    const last = later.at(-1) ?? null;
    const baselineAt = first?.observedAt ?? null;

    const availableTrades = baselineAt === null ? [] : tokenTrades.filter(row =>
      row.observedAt <= baselineAt && row.occurredAt >= baselineAt - 5000 && row.occurredAt <= baselineAt + 1000);
    const buys = availableTrades.filter(row => row.side === 'buy');
    const sells = availableTrades.filter(row => row.side === 'sell');
    const buyers = new Set(buys.map(row => row.wallet).filter(Boolean));
    const sellers = new Set(sells.map(row => row.wallet).filter(Boolean));
    const buyUsd = sum(buys.map(row => number(row.amountUsd) ?? 0));
    const sellUsd = sum(sells.map(row => number(row.amountUsd) ?? 0));
    const buyerAmounts = [...groupBy(buys.filter(row => row.wallet), row => row.wallet).values()]
      .map(rows => sum(rows.map(row => number(row.amountUsd) ?? 0)));
    const historicalPrices = availableTrades.filter(row => number(row.priceUsd) > 0)
      .toSorted((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0));
    const historyFirst = historicalPrices[0];
    const historyLast = historicalPrices.at(-1);
    const historyPeak = historicalPrices.length ? Math.max(...historicalPrices.map(row => Number(row.priceUsd))) : null;
    const priorTradeTrendPercent = historicalPrices.length >= 2 && historyFirst.priceUsd > 0
      ? (historyLast.priceUsd / historyFirst.priceUsd - 1) * 100 : null;
    const priorTradePeakDrawdownPercent = historyPeak && historyLast
      ? (historyLast.priceUsd / historyPeak - 1) * 100 : null;

    const validCounts = (counts.get(mint) ?? []).filter(row => baselineAt !== null && row.observedAt <= baselineAt &&
      row.status === 200 && Number.isFinite(Number(row.holderCount)) && Number(row.holderCount) > 0)
      .sort((a, b) => a.observedAt - b.observedAt);
    const holderCount = validCounts.length ? Number(validCounts.at(-1).holderCount) : null;
    const holderGrowth = validCounts.length >= 2 ? holderCount - Number(validCounts[0].holderCount) : null;
    const wholeSessionCounts = (counts.get(mint) ?? []).filter(row => row.observedAt >= start && row.observedAt <= end &&
      row.status === 200 && Number.isFinite(Number(row.holderCount)) && Number(row.holderCount) > 0)
      .sort((a, b) => a.observedAt - b.observedAt);
    const holderChangeDuring = wholeSessionCounts.length >= 2
      ? Number(wholeSessionCounts.at(-1).holderCount) - Number(wholeSessionCounts[0].holderCount) : null;
    const laterTrades = baselineAt === null ? [] : tokenTrades.filter(row => row.observedAt > baselineAt);
    const laterBuys = laterTrades.filter(row => row.side === 'buy');
    const laterSells = laterTrades.filter(row => row.side === 'sell');
    const laterBuyUsd = sum(laterBuys.map(row => number(row.amountUsd) ?? 0));
    const laterSellUsd = sum(laterSells.map(row => number(row.amountUsd) ?? 0));

    const holderSnapshot = (snapshots.get(mint) ?? []).filter(row => baselineAt !== null && row.observedAt <= baselineAt)
      .sort((a, b) => a.observedAt - b.observedAt).at(-1);
    const holderList = name === 'Collector'
      ? (holderSnapshot?.topUserHolders ?? holderSnapshot?.topHolders?.filter(holder => !holder.isPoolOrExchange) ?? [])
      : [];
    const holderPercents = holderList.map(holder => number(holder.amountPercentage)).filter(Number.isFinite);
    const top5UserPercent = holderPercents.length >= 5 ? sum(holderPercents.slice(0, 5)) : null;
    const devTaggedPercent = name === 'Collector' && holderList.length
      ? sum(holderList.filter(holder => holder.isDev).map(holder => number(holder.amountPercentage) ?? 0)) : null;

    const candleSnapshot = (candleSnapshots.get(mint) ?? []).filter(row => baselineAt !== null && row.observedAt <= baselineAt && row.status === 200)
      .sort((a, b) => a.observedAt - b.observedAt).at(-1);
    // A current 1m candle contains price movement that had not happened at the
    // decision point, so only fully closed candles are historical features.
    const closedCandles = (candleSnapshot?.candles ?? []).filter(candle => candle.time + 60_000 <= baselineAt)
      .sort((a, b) => a.time - b.time);
    const priorCandleReturnPercent = closedCandles.length >= 2
      ? (Number(closedCandles.at(-1).close) / Number(closedCandles.at(-2).close) - 1) * 100 : null;

    const maxRisePercent = peak ? (peak.priceUsd / first.priceUsd - 1) * 100 : null;
    const finalReturnPercent = last ? (last.priceUsd / first.priceUsd - 1) * 100 : null;
    const firstHit = threshold => later.find(row => row.priceUsd >= first.priceUsd * (1 + threshold / 100)) ?? null;
    return {
      run: name, mint, symbol: summary.metadata?.symbol ?? mint.slice(0, 8), startedAt: start,
      endedAt: end, endedBecause: summary.endedBecause, baselineAt,
      baselineLatencyMs: baselineAt === null ? null : baselineAt - start,
      observationMs: end - start, priceFrames: prices.length,
      features: {
        holderCount, holderGrowth, holderCountSamples: validCounts.length,
        top5UserPercent, devTaggedPercent, holderSnapshotAt: holderSnapshot?.observedAt ?? null,
        buyCount: buys.length, sellCount: sells.length, uniqueBuyers: buyers.size,
        uniqueSellers: sellers.size, buyUsd, sellUsd,
        buyUsdSharePercent: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) * 100 : null,
        largestBuyerSharePercent: buyUsd > 0 && buyerAmounts.length ? Math.max(...buyerAmounts) / buyUsd * 100 : null,
        lastTradeSide: availableTrades.toSorted((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0)).at(-1)?.side ?? null,
        priorTradeTrendPercent, priorTradePeakDrawdownPercent,
        historicalTradeCount: historicalPrices.length,
        completedCandles: closedCandles.length, priorCandleReturnPercent,
        marketCapUsd: number(summary.entryMarketCapUsd ?? summary.initialMarketCapUsd),
      },
      outcome: {
        maxRisePercent, finalReturnPercent, peakAt: peak?.observedAt ?? null,
        hit10At: firstHit(10)?.observedAt ?? null, hit20At: firstHit(20)?.observedAt ?? null,
        hit40At: firstHit(40)?.observedAt ?? null,
        hit50At: firstHit(50)?.observedAt ?? null,
        measured: later.length > 0,
      },
      trajectory: {
        holderCountStart: wholeSessionCounts.length ? Number(wholeSessionCounts[0].holderCount) : null,
        holderCountEnd: wholeSessionCounts.length ? Number(wholeSessionCounts.at(-1).holderCount) : null,
        holderChangeDuring, holderCountSamples: wholeSessionCounts.length,
        laterUniqueBuyers: new Set(laterBuys.map(row => row.wallet).filter(Boolean)).size,
        laterUniqueSellers: new Set(laterSells.map(row => row.wallet).filter(Boolean)).size,
        laterBuyUsd, laterSellUsd,
        laterBuyUsdSharePercent: laterBuyUsd + laterSellUsd > 0
          ? laterBuyUsd / (laterBuyUsd + laterSellUsd) * 100 : null,
      },
    };
  });
}

const rows = [...buildRun('Collector', collectorDir), ...(simulatorDir ? buildRun('Simulator', simulatorDir) : [])];
const measured = rows.filter(row => row.outcome.measured);
const positive = measured.filter(row => row.outcome.maxRisePercent >= 20);
const other = measured.filter(row => row.outcome.maxRisePercent < 20);
const featureSpecs = [
  ['Holder saat harga pertama', 'holderCount'],
  ['Pertambahan holder sebelum harga pertama', 'holderGrowth'],
  ['Top-5 holder pengguna (%)', 'top5UserPercent'],
  ['Holder bertanda DEV (%)', 'devTaggedPercent'],
  ['Pembeli unik 5 dtk awal', 'uniqueBuyers'],
  ['Penjual unik 5 dtk awal', 'uniqueSellers'],
  ['Porsi USD beli (%)', 'buyUsdSharePercent'],
  ['Pembeli terbesar dari USD beli (%)', 'largestBuyerSharePercent'],
  ['Tren transaksi 5 dtk sebelum harga pertama (%)', 'priorTradeTrendPercent'],
  ['Turun dari puncak transaksi 5 dtk (%)', 'priorTradePeakDrawdownPercent'],
  ['Return candle tertutup sebelumnya (%)', 'priorCandleReturnPercent'],
];
const comparisons = featureSpecs.map(([label, key]) => ({
  label, key,
  positive: { n: positive.filter(row => row.features[key] !== null).length,
    median: median(positive.map(row => row.features[key])) },
  other: { n: other.filter(row => row.features[key] !== null).length,
    median: median(other.map(row => row.features[key])) },
}));
const trajectorySpecs = [
  ['Perubahan jumlah holder selama sesi', 'holderChangeDuring'],
  ['Pembeli unik setelah harga pertama', 'laterUniqueBuyers'],
  ['Penjual unik setelah harga pertama', 'laterUniqueSellers'],
  ['Porsi USD beli setelah harga pertama (%)', 'laterBuyUsdSharePercent'],
];
const trajectoryComparisons = trajectorySpecs.map(([label, key]) => ({
  label, key,
  positive: { n: positive.filter(row => row.trajectory[key] !== null).length,
    median: median(positive.map(row => row.trajectory[key])) },
  other: { n: other.filter(row => row.trajectory[key] !== null).length,
    median: median(other.map(row => row.trajectory[key])) },
}));
const criterion = [
  ['≥3 pembeli unik', row => row.features.uniqueBuyers >= 3],
  ['Buy USD > sell USD', row => row.features.buyUsd > row.features.sellUsd && row.features.buyUsdSharePercent !== null],
  ['≥3 pembeli dan buy dominan', row => row.features.uniqueBuyers >= 3 && row.features.buyUsdSharePercent > 50],
  ['Transaksi terakhir buy', row => row.features.lastTradeSide === 'buy'],
  ['Riwayat transaksi awal naik', row => row.features.priorTradeTrendPercent !== null && row.features.priorTradeTrendPercent > 0],
  ['Belum turun >10% dari puncak awal', row => row.features.priorTradePeakDrawdownPercent !== null && row.features.priorTradePeakDrawdownPercent > -10],
  ['Holder ≥20 (API)', row => row.features.holderCount !== null && row.features.holderCount >= 20],
  ['Top-5 pengguna ≤25%', row => row.features.top5UserPercent !== null && row.features.top5UserPercent <= 25],
].map(([label, predicate]) => {
  const selected = measured.filter(predicate);
  return { label, measured: selected.length,
    positive20: selected.filter(row => row.outcome.maxRisePercent >= 20).length,
    byRun: Object.fromEntries(['Collector', 'Simulator'].map(run => {
      const subset = selected.filter(row => row.run === run);
      return [run, { measured: subset.length, positive20: subset.filter(row => row.outcome.maxRisePercent >= 20).length }];
    })) };
});
const counts = {
  sessions: rows.length, uniqueTokens: new Set(rows.map(row => row.mint)).size,
  withBaseline: rows.filter(row => row.baselineAt !== null).length,
  withoutBaseline: rows.filter(row => row.baselineAt === null).length,
  withFuturePrice: measured.length, noLaterPrice: rows.filter(row => row.baselineAt !== null && !row.outcome.measured).length,
  unpriced: rows.length - measured.length,
  hit10: measured.filter(row => row.outcome.hit10At !== null).length,
  hit20: positive.length, hit40: measured.filter(row => row.outcome.hit40At !== null).length,
  hit50: measured.filter(row => row.outcome.hit50At !== null).length,
  hit20AndFinalPositive: positive.filter(row => row.outcome.finalReturnPercent > 0).length,
  finalPositive: measured.filter(row => row.outcome.finalReturnPercent > 0).length,
  final10: measured.filter(row => row.outcome.finalReturnPercent >= 10).length,
  final20: measured.filter(row => row.outcome.finalReturnPercent >= 20).length,
  holderCountAtBaseline: measured.filter(row => row.features.holderCount !== null).length,
  holderGrowthAtBaseline: measured.filter(row => row.features.holderGrowth !== null).length,
  holderDistributionAtBaseline: measured.filter(row => row.features.top5UserPercent !== null).length,
  priorClosedCandles: measured.filter(row => row.features.completedCandles >= 2).length,
  priorTradeHistory: measured.filter(row => row.features.priorTradeTrendPercent !== null).length,
  holderTrajectory: measured.filter(row => row.trajectory.holderChangeDuring !== null).length,
};
const report = {
  generatedAt: new Date().toISOString(), sources: { collectorDir, simulatorDir: simulatorDir ?? null }, counts,
  definition: 'Features are frozen when the first detail price frame is received; outcome is maximum price rise in later observed frames before the detail session ends. Recent transaction history is restricted to trades already received with occurredAt in the preceding 5 seconds. +20% is descriptive and was not optimized. No simulated fill or PnL is used as the label.',
  limitations: [
    'A missing later price is censored, not a failed token. A 20-second detail session cannot establish returns after it closes.',
    'WebSocket transaction prices are last observed trades, not executable bid or a guaranteed fill.',
    'Holder counts use token_stat API only when available before the baseline. Zero or missing API responses are unknown, not zero holders.',
    'Pool/exchange addresses are excluded from holder concentration. Simulator has no comparable historical top-holder API snapshot.',
    'Only completed 1-minute candles received before baseline qualify as history; the current candle is excluded.',
    'Historical transactions in the first WebSocket frame are valid descriptive features available at baseline, but they are not actionable earlier price observations.',
    ...(simulatorDir ? ['The two runs have different collection paths and one token appears in both at different times; combining sessions is exploratory, not independent validation.'] : []),
  ], comparisons, trajectoryComparisons, criteria: criterion, rows,
};
writeFileSync(join(outputDir, 'positive-momentum.json'), JSON.stringify(report, null, 2));

const comparisonRows = comparisons.map(row => `<tr><th>${esc(row.label)}</th><td>${fmt(row.positive.median)} <small>n=${row.positive.n}</small></td><td>${fmt(row.other.median)} <small>n=${row.other.n}</small></td></tr>`).join('');
const trajectoryRows = trajectoryComparisons.map(row => `<tr><th>${esc(row.label)}</th><td>${fmt(row.positive.median)} <small>n=${row.positive.n}</small></td><td>${fmt(row.other.median)} <small>n=${row.other.n}</small></td></tr>`).join('');
const criterionRows = criterion.map(row => `<tr><th>${esc(row.label)}</th><td>${row.positive20}/${row.measured}</td><td>${row.byRun.Collector.positive20}/${row.byRun.Collector.measured}</td>${simulatorDir ? `<td>${row.byRun.Simulator.positive20}/${row.byRun.Simulator.measured}</td>` : ''}</tr>`).join('');
const sourceLabel = simulatorDir ? `${esc(basename(collectorDir))} dan ${esc(basename(simulatorDir ?? collectorDir))}` : esc(basename(collectorDir));
const tokenRows = rows.map(row => `<tr><td><a href="https://gmgn.ai/sol/token/${encodeURIComponent(row.mint)}" target="_blank" rel="noopener">${esc(row.symbol)}</a><small>${esc(row.run)} · ${esc(row.mint.slice(0, 8))}</small></td><td>${row.baselineAt ? new Date(row.baselineAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }) : '—'}</td><td>${row.features.holderCount ?? '—'}</td><td>${row.features.uniqueBuyers}/${row.features.uniqueSellers}</td><td>${pct(row.features.buyUsdSharePercent)}</td><td>${pct(row.features.top5UserPercent)}</td><td>${row.features.completedCandles}</td><td>${row.trajectory.holderChangeDuring ?? '—'}</td><td class="${row.outcome.maxRisePercent >= 20 ? 'up' : ''}">${pct(row.outcome.maxRisePercent)}</td><td>${pct(row.outcome.finalReturnPercent)}</td><td>${esc(row.endedBecause)}</td></tr>`).join('');
const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Riset momentum positif token baru</title><style>body{font:15px/1.5 system-ui,sans-serif;background:#0c1422;color:#edf4ff;margin:0;padding:24px}main{max-width:1440px;margin:auto}h1{margin-bottom:4px}p{color:#b8c8dd;max-width:1100px}.cards{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}.card{background:#17283d;border:1px solid #2d4562;border-radius:10px;padding:12px 18px;min-width:130px}.card strong{display:block;font-size:25px;color:#92ddbb}.card span,small{display:block;color:#aebfd3;font-size:12px}table{border-collapse:collapse;width:100%;background:#132238;margin:14px 0 28px}th,td{border:1px solid #30445e;padding:8px 10px;text-align:left;vertical-align:top}thead{background:#1d344f}.scroll{overflow-x:auto}a{color:#8fc7ff}.up{color:#87e4a9;font-weight:700}code{color:#c1dcff}</style></head><body><main><h1>Pola token yang naik setelah detail dibuka</h1><p>Fitur dibekukan pada frame harga detail pertama. Target: harga transaksi berikutnya sempat naik ≥20% sebelum sesi detail berakhir. Ini riset momentum harga, bukan hasil paper buy/sell.</p><div class="cards"><div class="card"><strong>${counts.sessions}</strong><span>sesi dari ${counts.uniqueTokens} token</span></div><div class="card"><strong>${counts.withFuturePrice}</strong><span>punya harga lanjutan</span></div><div class="card"><strong>${counts.hit20}</strong><span>sempat +20%</span></div><div class="card"><strong>${counts.hit20AndFinalPositive}</strong><span>+20% dan akhir positif</span></div><div class="card"><strong>${counts.unpriced}</strong><span>hasil belum terukur</span></div></div><p>Kenaikan sesaat dan kenaikan yang bertahan berbeda: hanya ${counts.final10}/${counts.withFuturePrice} berakhir ≥+10% dan ${counts.final20}/${counts.withFuturePrice} berakhir ≥+20%. Ambang puncak lain: +10% ${counts.hit10}/${counts.withFuturePrice}; +40% ${counts.hit40}/${counts.withFuturePrice}; +50% ${counts.hit50}/${counts.withFuturePrice}. ${counts.withoutBaseline} sesi tanpa harga pertama dan ${counts.noLaterPrice} tanpa harga lanjutan. Holder API tersedia pada ${counts.holderCountAtBaseline}/${counts.withFuturePrice}; pertumbuhan holder sebelum baseline ${counts.holderGrowthAtBaseline}/${counts.withFuturePrice}; sebaran Top-5 pengguna ${counts.holderDistributionAtBaseline}/${counts.withFuturePrice}; riwayat transaksi 5 dtk ${counts.priorTradeHistory}/${counts.withFuturePrice}; riwayat ≥2 candle 1m tertutup ${counts.priorClosedCandles}/${counts.withFuturePrice}.</p><h2>Komposisi saat awal</h2><p>Median kelompok yang sempat +20% dibanding kelompok lain. Jumlah <code>n</code> per kolom menunjukkan berapa token yang benar-benar memiliki fitur itu.</p><div class="scroll"><table><thead><tr><th>Fitur saat harga pertama</th><th>Sempat +20% (${positive.length})</th><th>Lainnya (${other.length})</th></tr></thead><tbody>${comparisonRows}</tbody></table></div><h2>Pemeriksaan sinyal awal</h2><p>Angka adalah token yang sempat +20% / token terukur yang memenuhi syarat. Ini perbandingan deskriptif pada data yang sama, belum uji prediksi terpisah.</p><div class="scroll"><table><thead><tr><th>Syarat awal</th><th>Gabungan</th><th>Collector</th><th>Simulator</th></tr></thead><tbody>${criterionRows}</tbody></table></div><h2>Seluruh sesi</h2><p>Kolom “puncak naik” dihitung dari harga frame pertama ke harga maksimum pada frame berikutnya. “Harga akhir” adalah frame terakhir, bukan harga jual. Tanda — berarti tidak tersedia. Waktu ditampilkan WIB.</p><div class="scroll"><table><thead><tr><th>Token</th><th>Harga pertama</th><th>Holder awal</th><th>Pembeli/penjual unik</th><th>Porsi buy USD</th><th>Top-5 pengguna</th><th>Candle tertutup</th><th>Puncak naik</th><th>Harga akhir</th><th>Sesi selesai</th></tr></thead><tbody>${tokenRows}</tbody></table></div><h2>Batas data</h2>${report.limitations.map(item => `<p>• ${esc(item)}</p>`).join('')}<p>Dataset rinci: <a href="positive-momentum.json">positive-momentum.json</a>. Sumber: ${esc(basename(collectorDir))} dan ${esc(basename(simulatorDir ?? collectorDir))}.</p></main></body></html>`;
const trajectorySection = `<h2>Gerak holder dan transaksi selama observasi</h2><p>Bagian ini memakai data setelah harga pertama. Ini menjelaskan apa yang terjadi bersamaan dengan kenaikan, dan tidak boleh dipakai sebagai fitur keputusan pada harga pertama. Perubahan holder hanya dihitung jika ada sedikitnya dua respons API yang valid.</p><div class="scroll"><table><thead><tr><th>Perubahan selama sesi</th><th>Sempat +20% (${positive.length})</th><th>Lainnya (${other.length})</th></tr></thead><tbody>${trajectoryRows}</tbody></table></div>`;
const finalHtml = html
  .replace('<h2>Pemeriksaan sinyal awal</h2>', `${trajectorySection}<h2>Pemeriksaan sinyal awal</h2>`)
  .replace('<th>Candle tertutup</th><th>Puncak naik</th>', '<th>Candle tertutup</th><th>Δ holder sesi</th><th>Puncak naik</th>')
  .replace('<th>Collector</th><th>Simulator</th>', simulatorDir ? '<th>Collector</th><th>Simulator</th>' : '<th>Collector</th>')
  .replace(`Sumber: ${esc(basename(collectorDir))} dan ${esc(basename(simulatorDir ?? collectorDir))}`, `Sumber: ${sourceLabel}`);
writeFileSync(join(outputDir, 'positive-momentum.html'), finalHtml);
console.log(join(outputDir, 'positive-momentum.html'));
console.log(JSON.stringify({ counts, comparisons, criteria: criterion }, null, 2));
