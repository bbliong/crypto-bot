import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: generate-pump-band-report.mjs <research-dir>');
const lines = name => existsSync(join(dir, name))
  ? readFileSync(join(dir, name), 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
  : [];
const sessions = lines('token-summary.jsonl').sort((a, b) => a.startedAt - b.startedAt);
const priceTicksByMint = new Map();
for (const tick of lines('socket-ticks.jsonl')) {
  if (!String(tick.source ?? '').startsWith('detail_socket_activity') || !positivePriceTick(tick)) continue;
  const list = priceTicksByMint.get(tick.mint) ?? [];
  list.push(tick);
  priceTicksByMint.set(tick.mint, list);
}
for (const ticks of priceTicksByMint.values()) ticks.sort((a, b) => a.observedAt - b.observedAt);
function positivePriceTick(tick) {
  return typeof tick.priceUsd === 'number' && Number.isFinite(tick.priceUsd) && tick.priceUsd > 0
    && typeof tick.observedAt === 'number' && Number.isFinite(tick.observedAt);
}
const manifest = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : {};
const observationSeconds = manifest.rules?.observationSeconds ?? 60;
const minMarketCap = manifest.rules?.minimumMarketCapUsd ?? 3_000;
const maxMarketCap = manifest.rules?.maximumMarketCapUsd ?? 10_000;
const stakeUsdc = manifest.rules?.simulationStakeUsdc ?? 0.25;
const maximumExitPriceAgeMs = 5_000;
if (typeof stakeUsdc !== 'number' || !Number.isFinite(stakeUsdc) || stakeUsdc <= 0) throw new Error('Invalid simulationStakeUsdc');

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positive = value => number(value) !== null && value > 0;
const f = value => number(value) !== null ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—';
const price = value => positive(value) ? value.toExponential(4) : '—';
const signedPercent = value => number(value) !== null ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
const signedUsd = value => number(value) !== null ? `${value >= 0 ? '+' : '-'}$${Math.abs(value).toFixed(6)}` : '—';
const time = value => number(value) !== null
  ? new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' WIB'
  : '—';
const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

const simulated = sessions.map(s => {
  const endedAt = number(s.endedAt);
  const eligibleTicks = (priceTicksByMint.get(s.mint) ?? []).filter(tick => tick.observedAt >= s.startedAt && endedAt !== null && tick.observedAt <= endedAt);
  const first = eligibleTicks[0];
  const last = eligibleTicks.at(-1);
  const entryPriceUsd = first?.priceUsd ?? null;
  const exitPriceUsd = last?.priceUsd ?? null;
  const entryAt = first?.observedAt ?? null;
  const exitPriceAt = last?.observedAt ?? null;
  const peakPriceUsd = eligibleTicks.length ? Math.max(...eligibleTicks.map(tick => tick.priceUsd)) : null;
  const usable = positive(entryPriceUsd) && positive(exitPriceUsd) && entryAt !== null && exitPriceAt !== null && exitPriceAt > entryAt;
  const exitPriceAgeMs = usable && endedAt !== null ? Math.max(0, endedAt - exitPriceAt) : null;
  const priceFresh = exitPriceAgeMs !== null && exitPriceAgeMs <= maximumExitPriceAgeMs;
  const returnPercent = usable ? (exitPriceUsd / entryPriceUsd - 1) * 100 : null;
  const proceedsUsdc = usable ? stakeUsdc * exitPriceUsd / entryPriceUsd : null;
  const pnlUsdc = proceedsUsdc === null ? null : proceedsUsdc - stakeUsdc;
  return {
    mint: s.mint, symbol: s.metadata?.symbol ?? s.mint, detailOpenedAt: s.startedAt ?? null,
    buyAt: usable ? entryAt : null, buyPriceUsd: usable ? entryPriceUsd : null,
    exitSignalAt: endedAt, exitPriceObservedAt: usable ? exitPriceAt : null,
    sellPriceUsd: usable ? exitPriceUsd : null, exitPriceAgeMs,
    stakeUsdc, proceedsUsdc, pnlUsdc, returnPercent, exitReason: s.endedBecause ?? null, eligiblePriceTicks: eligibleTicks.length,
    peakPriceUsd, drawdownFromPeakPercent: usable && positive(peakPriceUsd) ? (exitPriceUsd / peakPriceUsd - 1) * 100 : null,
    quality: !usable ? 'INSUFFICIENT_PRICE_TICKS' : priceFresh ? 'FRESH_EXIT_PRICE' : 'STALE_EXIT_PRICE',
  };
});

const measured = simulated.filter(s => s.quality === 'FRESH_EXIT_PRICE');
const stale = simulated.filter(s => s.quality === 'STALE_EXIT_PRICE');
const missing = simulated.filter(s => s.quality === 'INSUFFICIENT_PRICE_TICKS');
const winners = measured.filter(s => s.pnlUsdc > 0);
const losers = measured.filter(s => s.pnlUsdc < 0);
const flat = measured.filter(s => s.pnlUsdc === 0);
const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
const grossProfitUsdc = sum(winners, 'pnlUsdc');
const grossLossUsdc = sum(losers, 'pnlUsdc');
const netPnlUsdc = grossProfitUsdc + grossLossUsdc;
const measuredStakeUsdc = stakeUsdc * measured.length;
const stats = { measured: measured.length, winners: winners.length, losers: losers.length, flat: flat.length,
  stale: stale.length, missing: missing.length, grossProfitUsdc, grossLossUsdc, netPnlUsdc,
  measuredStakeUsdc, netReturnPercent: measuredStakeUsdc > 0 ? netPnlUsdc / measuredStakeUsdc * 100 : null };

const qualityText = { FRESH_EXIT_PRICE: 'Harga keluar ≤5 dtk', STALE_EXIT_PRICE: 'Harga keluar lama', INSUFFICIENT_PRICE_TICKS: 'Tick harga kurang' };
const tradeRows = simulated.map(s => {
  const resultClass = s.quality === 'FRESH_EXIT_PRICE' ? (s.pnlUsdc > 0 ? 'profit' : s.pnlUsdc < 0 ? 'loss' : '') : 'muted';
  const priceAge = s.exitPriceAgeMs === null ? '—' : `${(s.exitPriceAgeMs / 1000).toFixed(1)} dtk`;
  const tokenUrl = `https://gmgn.ai/sol/token/${encodeURIComponent(s.mint)}`;
  return `<tr><td><a href="${tokenUrl}" target="_blank" rel="noopener noreferrer">${esc(s.symbol)}</a><div class="mono">${esc(s.mint)}</div></td><td>${time(s.detailOpenedAt)}</td><td>${time(s.buyAt)}<div class="mono">${price(s.buyPriceUsd)}</div></td><td>${time(s.exitSignalAt)}<div class="mono">${esc(s.exitReason)}</div></td><td>${time(s.exitPriceObservedAt)}<div class="mono">${price(s.sellPriceUsd)}</div></td><td>${priceAge}</td><td class="${resultClass}">${signedPercent(s.returnPercent)}</td><td class="${resultClass}">${signedUsd(s.pnlUsdc)}</td><td>${qualityText[s.quality]}</td></tr>`;
}).join('');

const simulatedByMint = new Map(simulated.map(row => [row.mint, row]));
const researchRows = sessions.map(s => {
  const sim = simulatedByMint.get(s.mint);
  return `<tr><td>${esc(s.metadata?.symbol ?? s.mint)}</td><td class="mono">${esc(s.mint)}</td><td>${time(s.startedAt)}</td><td>$${f(s.entryMarketCapUsd)}</td><td>$${f(s.finalMarketCapUsd)}</td><td>${signedPercent(s.entryToFinalPercent)}</td><td>${price(sim?.buyPriceUsd)}</td><td>${price(sim?.sellPriceUsd)}</td><td>${signedPercent(sim?.returnPercent)}</td><td>${signedPercent(sim?.drawdownFromPeakPercent)}</td><td>${f(s.holderCountStart)} → ${f(s.holderCountEnd)}</td><td>${esc(s.endedBecause)}</td><td>${s.milestonesMs?.['10000'] === null || s.milestonesMs?.['10000'] === undefined ? '—' : (s.milestonesMs['10000'] / 1000).toFixed(1) + ' dtk'}</td></tr>`;
}).join('');
const dumps = sessions.filter(s => String(s.endedBecause).startsWith('DUMP')).length;
const reached = sessions.filter(s => s.milestonesMs?.['10000'] !== null && s.milestonesMs?.['10000'] !== undefined).length;

const html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Riset Pump $${f(minMarketCap)}–$${f(maxMarketCap)}</title><style>body{margin:0;background:#0b1220;color:#e8eef8;font:15px system-ui}main{max-width:1700px;margin:auto;padding:28px}section{background:#121e31;border:1px solid #20324d;border-radius:12px;padding:18px;margin:16px 0}.stats{display:flex;gap:12px;flex-wrap:wrap}.stat{background:#172945;border-radius:8px;padding:12px;min-width:155px}.n{font-size:26px;font-weight:700}table{border-collapse:collapse;width:100%}th,td{padding:9px;border-bottom:1px solid #263a58;text-align:left;white-space:nowrap;vertical-align:top}th{color:#9dc1f5}.scroll{overflow:auto}.mono{font:12px ui-monospace,monospace;color:#a9b9cf;margin-top:3px}.note,.muted{color:#b5c4d8}.profit{color:#62dba0;font-weight:700}.loss{color:#ff9292;font-weight:700}a{color:#9dc1f5}h1,h2{margin-top:0}</style><main><h1>Riset pump market cap $${f(minMarketCap)}–$${f(maxMarketCap)}</h1><p>Token fresh mendapat slot detail kosong. Setiap sesi maksimal ${observationSeconds} detik. Semua waktu memakai WIB.</p><section><h2>Perbandingan simulasi beli dan jual</h2><p>Modal ${stakeUsdc.toFixed(2)} USDC per token. Beli diasumsikan pada tick transaksi <code>pu</code> pertama setelah detail dibuka. Sinyal jual terjadi saat sesi berakhir; harga jual diperkirakan dari tick <code>pu</code> terakhir yang tercatat sebelum sinyal tersebut. Hasil ini belum memasukkan biaya jaringan, fee, slippage, atau dampak ukuran order.</p><div class="stats"><div class="stat">Harga keluar segar<div class="n">${measured.length} / ${sessions.length}</div></div><div class="stat">Untung<div class="n profit">${winners.length}</div></div><div class="stat">Rugi<div class="n loss">${losers.length}</div></div><div class="stat">Impas<div class="n">${flat.length}</div></div><div class="stat">Total untung<div class="n profit">${signedUsd(grossProfitUsdc)}</div></div><div class="stat">Total rugi<div class="n loss">${signedUsd(grossLossUsdc)}</div></div><div class="stat">Hasil bersih<div class="n ${netPnlUsdc >= 0 ? 'profit' : 'loss'}">${signedUsd(netPnlUsdc)}</div></div><div class="stat">Return total<div class="n ${netPnlUsdc >= 0 ? 'profit' : 'loss'}">${signedPercent(stats.netReturnPercent)}</div></div></div><p class="note">Total hanya menghitung ${measured.length} sesi dengan harga jual yang tercatat dalam 5 detik sebelum penutupan: modal gabungan $${f(measuredStakeUsdc)}. ${stale.length} sesi berharga keluar lebih lama dan ${missing.length} sesi kekurangan tick; keduanya tetap ditampilkan di tabel tetapi tidak masuk total. Harga transaksi socket tidak menjamin order dapat terisi pada harga itu.</p><div class="scroll"><table><thead><tr><th>Token</th><th>Detail dibuka</th><th>Simulasi beli</th><th>Sinyal jual</th><th>Harga terakhir tercatat</th><th>Umur harga saat keluar</th><th>Perubahan harga</th><th>Hasil dari $${stakeUsdc.toFixed(2)}</th><th>Kualitas data</th></tr></thead><tbody>${tradeRows || '<tr><td colspan="9">Belum ada sesi selesai.</td></tr>'}</tbody></table></div></section><section><h2>Data riset per sesi</h2><div class="stats"><div class="stat">Sesi selesai<div class="n">${sessions.length}</div></div><div class="stat">Mencapai $${f(maxMarketCap)} menurut feed MCap<div class="n">${reached}</div></div><div class="stat">Dump dari puncak harga<div class="n">${dumps}</div></div></div><p class="note">Market cap feed dapat terlambat. Return harga dan pemeriksaan dump memakai tick transaksi socket; waktu tick awal dapat lebih lambat dari waktu halaman dibuka.</p><div class="scroll"><table><thead><tr><th>Token</th><th>Mint</th><th>Mulai detail</th><th>Feed MCap awal</th><th>Feed MCap akhir</th><th>Feed MCap return</th><th>Harga socket awal</th><th>Harga socket akhir</th><th>Harga return</th><th>Harga turun dari puncak</th><th>Holder</th><th>Status</th><th>Ke $${f(maxMarketCap)} feed</th></tr></thead><tbody>${researchRows || '<tr><td colspan="13">Belum ada sesi selesai.</td></tr>'}</tbody></table></div></section></main></html>`;
writeFileSync(join(dir, 'pump-band-simulation.json'), JSON.stringify({ method: 'hypothetical buy at first observed pu, exit at session end valued using last observed pu at or before exit signal', stakeUsdc, maximumExitPriceAgeMs, stats, trades: simulated }, null, 2));
writeFileSync(join(dir, 'pump-band-report.html'), html);
