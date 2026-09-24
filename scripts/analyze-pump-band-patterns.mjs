import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [collectorDir, simulatorDir] = process.argv.slice(2);
if (!collectorDir || !simulatorDir) throw new Error('Usage: node scripts/analyze-pump-band-patterns.mjs <collector-dir> <simulator-dir>');
const output = join('research', 'pump-patterns-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(output, { recursive: true });
const load = (dir, file) => {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
};
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function observations(name, dir) {
  const trades = load(dir, 'trades.jsonl');
  let entries;
  if (name === 'Collector') {
    const simulation = JSON.parse(readFileSync(join(dir, 'pump-band-simulation.json'), 'utf8'));
    entries = simulation.trades.filter(row => row.buyAt !== null).map(row => ({
      mint: row.mint, symbol: row.symbol, entryAt: row.buyAt,
      pnlUsd: row.quality === 'FRESH_EXIT_PRICE' ? row.pnlUsdc : null, exitQuality: row.quality,
    }));
  } else {
    const simulation = load(dir, 'simulated-trades.jsonl');
    entries = simulation.filter(row => row.type === 'SIMULATED_BUY').map(row => {
      const sell = simulation.find(candidate => candidate.type === 'SIMULATED_SELL' && candidate.mint === row.mint);
      return { mint: row.mint, symbol: row.metadata?.symbol ?? row.mint.slice(0, 8), entryAt: row.observedAt,
        pnlUsd: sell?.pnlUsd ?? null, exitQuality: sell ? 'FRESH_EXIT_PRICE' : 'UNPRICED' };
    });
  }
  return entries.map(entry => {
    const frame = trades.filter(trade => trade.mint === entry.mint && trade.observedAt === entry.entryAt);
    if (!frame.length) return { ...entry, run: name, features: null };
    const latestTradeAt = Math.max(...frame.map(trade => trade.occurredAt));
    const recent = frame.filter(trade => trade.occurredAt >= latestTradeAt - 5_000);
    const buys = recent.filter(trade => trade.side === 'buy');
    const sells = recent.filter(trade => trade.side === 'sell');
    const buyUsd = buys.reduce((sum, trade) => sum + (trade.amountUsd ?? 0), 0);
    const sellUsd = sells.reduce((sum, trade) => sum + (trade.amountUsd ?? 0), 0);
    const prices = recent.filter(trade => typeof trade.priceUsd === 'number' && trade.priceUsd > 0)
      .sort((a, b) => a.occurredAt - b.occurredAt);
    return { ...entry, run: name, features: {
      buyCount: buys.length, sellCount: sells.length, buyUsd, sellUsd,
      uniqueBuyers: new Set(buys.map(trade => trade.wallet).filter(Boolean)).size,
      latestSide: prices.at(-1)?.side ?? null,
      trendPercent: prices.length >= 2 ? (prices.at(-1).priceUsd / prices[0].priceUsd - 1) * 100 : null,
    } };
  });
}

const all = [...observations('Collector', collectorDir), ...observations('Simulator', simulatorDir)];
const rules = [
  ['Semua entry', () => true],
  ['Transaksi terakhir sell', value => value.latestSide === 'sell'],
  ['Transaksi terakhir buy', value => value.latestSide === 'buy'],
  ['Tidak ada sell pada 5 detik riwayat awal', value => value.sellCount === 0],
  ['Buy USD ≥ sell USD dan ≥3 pembeli', value => value.buyUsd >= value.sellUsd && value.uniqueBuyers >= 3],
  ['Terakhir buy, tren >10%, ≥3 pembeli', value => value.latestSide === 'buy' && value.trendPercent > 10 && value.uniqueBuyers >= 3],
];
const summarize = rows => {
  const measured = rows.filter(row => row.pnlUsd !== null);
  return { entries: rows.length, measured: measured.length,
    wins: measured.filter(row => row.pnlUsd > 0).length,
    losses: measured.filter(row => row.pnlUsd < 0).length,
    flat: measured.filter(row => row.pnlUsd === 0).length,
    grossPnlUsd: measured.reduce((sum, row) => sum + row.pnlUsd, 0) };
};
const analysis = { generatedAt: new Date().toISOString(), sources: { collectorDir, simulatorDir },
  method: 'Entry features use only trades in the first received detail frame, limited to the preceding 5 seconds of trade timestamps. Results include only exits with a fresh observed price. No fees, slippage, or real fills are included.',
  rows: rules.map(([name, predicate]) => ({ name,
    collector: summarize(all.filter(row => row.run === 'Collector' && row.features && predicate(row.features))),
    simulator: summarize(all.filter(row => row.run === 'Simulator' && row.features && predicate(row.features))),
    combined: summarize(all.filter(row => row.features && predicate(row.features))) })),
  entries: all };
writeFileSync(join(output, 'pattern-analysis.json'), JSON.stringify(analysis, null, 2));
const cell = item => `${item.entries} entry · ${item.measured} exit berharga · ${item.wins} untung / ${item.losses} rugi${item.flat ? ` / ${item.flat} impas` : ''} · <b>$${item.grossPnlUsd.toFixed(3)}</b>`;
const body = analysis.rows.map(row => `<tr><th>${esc(row.name)}</th><td>${cell(row.collector)}</td><td>${cell(row.simulator)}</td><td>${cell(row.combined)}</td></tr>`).join('');
const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evaluasi pola pump-band</title><style>body{font:15px/1.55 system-ui,sans-serif;background:#0d1423;color:#edf3ff;padding:2rem}main{max-width:1250px;margin:auto}p{max-width:1050px;color:#b5c3d8}table{border-collapse:collapse;width:100%;background:#142238}td,th{border:1px solid #334563;padding:.8rem;text-align:left;vertical-align:top}thead th{background:#1b304b}tbody th{width:25%}.bad{color:#ffa4a4}.good{color:#8bdfab}code{color:#a9d1ff}a{color:#8bbdff}</style></head><body><main><h1>Pola awal vs hasil paper simulation</h1><p>Collector: ${esc(basename(collectorDir))}<br>Simulator: ${esc(basename(simulatorDir))}</p><p>Fitur dihitung hanya dari frame aktivitas pertama yang sudah diterima saat entry. Trade historis dalam frame itu dibatasi ke 5 detik terakhir menurut cap waktu transaksi. Satu frame hanya menghasilkan satu harga yang dapat diamati. Hasil untung/rugi hanya untuk exit dengan harga baru; posisi tanpa harga exit tetap dicatat sebagai <em>belum terukur</em>. Semua nominal kotor, belum termasuk fee, slippage, dan kegagalan eksekusi.</p><table><thead><tr><th>Filter saat awal</th><th>Collector</th><th>Simulator</th><th>Gabungan</th></tr></thead><tbody>${body}</tbody></table><p><strong>Kesimpulan:</strong> transaksi terakhir <em>sell</em> tampak sebagai calon filter penolakan. Syarat pembeli ramai, buy USD dominan, dan tren awal naik belum menghasilkan keuntungan konsisten di dua run. Sampel dan waktu observasi terlalu kecil untuk menetapkan aturan beli otomatis yang menguntungkan.</p><p>Run sebelumnya terdistorsi oleh transaksi historis yang dikirim sekaligus dalam satu frame; kedua run di halaman ini dibuat setelah pemrosesan frame diperbaiki.</p></main></body></html>`;
writeFileSync(join(output, 'pattern-analysis.html'), html);
console.log(join(output, 'pattern-analysis.html'));
