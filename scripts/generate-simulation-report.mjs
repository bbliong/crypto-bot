import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const run = process.argv[2];
if (!run) throw new Error('Usage: node scripts/generate-simulation-report.mjs <research-run-folder>');
const folder = resolve(run);
const readJson = file => existsSync(join(folder, file)) ? JSON.parse(readFileSync(join(folder, file), 'utf8')) : null;
const readLines = file => existsSync(join(folder, file)) ? readFileSync(join(folder, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const rows = readLines('simulated-trades.jsonl');
const screened = new Map(readLines('screened-tokens.jsonl').map(row => [row.mint, row]));
const activityRows = readLines('trades.jsonl');
const events = readLines('events.jsonl');
const completedDetails = new Set(readLines('token-summary.jsonl').map(row => row.mint));
const summary = readJson('simulation-summary.json');
const manifest = readJson('manifest.json');
const buys = rows.filter(row => row.type === 'SIMULATED_BUY');
const sells = rows.filter(row => row.type === 'SIMULATED_SELL');
const holds = rows.filter(row => row.type === 'SIMULATION_HOLD');
const sellsByMint = new Map(sells.map(row => [row.mint, row]));
const blockedByMint = new Map();
for (const row of events) if (row.type === 'SIMULATION_BUY_BLOCKED') blockedByMint.set(row.mint, row);
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
const f = (v, digits = 4) => Number.isFinite(v) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
// Six decimals turns $0.000007781 into the misleading $0.000008.  Memecoin
// prices need enough digits for the report to show the actual simulation tick.
const usd = v => Number.isFinite(v) ? '$' + f(v, Math.abs(Number(v)) < 0.01 ? 10 : 6) : '—';
const pct = v => Number.isFinite(v) ? (v > 0 ? '+' : '') + f(v, 2) + '%' : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const time = value => value ? new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '—';
const fieldValue = (row, name) => row?.fields?.[name]?.value;
const buyReason = row => {
  const screen = screened.get(row.mint);
  if (!screen) return 'Masuk halaman detail; snapshot screening tidak tersedia.';
  const age = fieldValue(screen, 'createdAt');
  const ageSeconds = Number.isFinite(age) ? Math.max(0, (screen.observedAt - age) / 1000) : null;
  const candle = row.entryGate?.candleHistory;
  const override = row.entryGate?.singleCandleHolderOverride;
  const growth = row.entryGate?.significantHolderGrowth;
  const overrideText = override?.allowed ? ` Pengecualian satu candle: holder ${f(growth?.current, 0)}; naik ${f(growth?.absolute, 0)} (${pct(growth?.percent)}) dalam pembaruan token-stat terakhir.` : '';
  const candleText = candle ? ` Candle 1m: ${candle.reason}; puncak-ke-close ${pct(candle.peakToLastDrawdownPercent)}, candle merah beruntun ${f(candle.consecutiveRedCandles, 0)}.${overrideText}` : '';
  return `Lolos screening: umur ${ageSeconds === null ? '—' : f(ageSeconds, 0) + ' dtk'}, holder ${f(fieldValue(screen, 'holders'), 0)}, likuiditas ${usd(fieldValue(screen, 'liquidityUsd'))}, Top-10 ${pct(fieldValue(screen, 'top10Percent'))}.${candleText}`;
};
const sellReason = row => ({
  TARGET_40: 'Target dasar: harga mencapai +40% dari harga beli.',
  TARGET_40_HOLDER_FLAT: 'Sudah +40%; holder sebelumnya masih tumbuh, lalu momentum harga melandai.',
  TRAILING_10: 'Pernah naik ≥20%, lalu turun ≥10% dari harga puncak.',
  STOP_LOSS_20: 'Hard stop: harga turun ≥20% dari harga beli.',
  SELL_PRESSURE: 'Dua jendela socket 5-detik penuh menunjukkan tekanan jual tinggi.',
  OBSERVATION_END: 'Waktu observasi detail atau run selesai sebelum exit lain.',
}[row?.reason] ?? 'Alasan exit belum tersedia.');
const tradeTable = buys.slice().reverse().map(buy => {
  const sell = sellsByMint.get(buy.mint), symbol = buy.metadata?.symbol || sell?.metadata?.symbol || 'Token';
  const resultClass = sell ? (sell.pnlUsd > 0 ? 'up' : sell.pnlUsd < 0 ? 'down' : '') : '';
  return `<tr><td><button class="token" data-mint="${esc(buy.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(buy.mint)}</span><small>Preview detail GMGN</small></button></td><td>${time(buy.observedAt)}<br>${usd(buy.stakeUsd)} @ ${usd(buy.entryPriceUsd)}</td><td>${esc(buyReason(buy))}</td><td>${sell ? `${time(sell.observedAt)}<br>${usd(sell.exit?.priceUsd)}` : '<span class="watch">Masih dipantau</span>'}</td><td>${sell ? esc(sellReason(sell)) : 'Belum ada sinyal sell.'}</td><td class="${resultClass}">${sell ? `<b>${usd(sell.pnlUsd)}</b><br>${pct(sell.pnlPercent)}` : '—'}</td></tr>`;
}).join('');
const blocked = [...blockedByMint.values()];
const waitingForPriceRows = [...detailStartedByMint.values()]
  .filter(row => !blockedByMint.has(row.mint) && !buys.some(buy => buy.mint === row.mint))
  .filter(row => !completedDetails.has(row.mint))
  .slice().reverse().map(row => {
    const screen = screened.get(row.mint), symbol = screen?.metadata?.symbol ?? 'Token';
    return `<tr><td><button class="token" data-mint="${esc(row.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(row.mint)}</span><small>Preview data socket</small></button></td><td>${time(row.startedAt)}</td><td>—</td><td>Menunggu tick</td><td>—</td><td><b class="watch">Masuk detail</b><br><span class="muted">Menunggu cukup harga, candle, dan transaksi untuk menilai buy simulasi.</span></td></tr>`;
  }).join('');
const blockedTable = waitingForPriceRows + blocked.slice().reverse().map(row => {
  const screen = screened.get(row.mint), symbol = screen?.metadata?.symbol ?? 'Token', gate = row.entryGate ?? {}, candle = row.candleDecision;
  const boughtLater = buys.some(buy => buy.mint === row.mint);
  const status = boughtLater ? 'Buy setelah harga pulih' : completedDetails.has(row.mint) ? 'Observasi selesai tanpa buy' : 'Masih monitoring';
  const detail = boughtLater ? 'Buy awal diblok; simulasi baru membeli setelah harga stabil/pulih.' : candle ? `Buy diblok: riwayat candle 1 menit belum aman (${candle.reason}).` : 'Tidak ada buy simulasi selama harga masih turun.';
  return `<tr><td><button class="token" data-mint="${esc(row.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(row.mint)}</span><small>Preview data socket</small></button></td><td>${time(row.observedAt)}</td><td>${usd(row.priceUsd)}</td><td class="down">${candle ? esc(candle.reason) : pct(gate.momentum5sPercent)}</td><td>${candle ? '—' : f(gate.consecutiveDeclines, 0)}</td><td><b class="watch">${status}</b><br><span class="muted">${detail}</span></td></tr>`;
}).join('');
const profit = sells.filter(row => row.pnlUsd > 0).reduce((sum, row) => sum + row.pnlUsd, 0);
const loss = sells.filter(row => row.pnlUsd < 0).reduce((sum, row) => sum + row.pnlUsd, 0);
const totalPnl = sells.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0);
const open = buys.length - sells.length;
const title = `Laporan simulasi — ${basename(folder)}`;
let html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>${title}</title><style>body{margin:0;background:#09111d;color:#e8eff8;font:15px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:1500px;margin:auto;padding:30px}.tag{color:#6be1b2;font-weight:700;letter-spacing:1px;font-size:12px}.muted{color:#9cafc5}.note{background:#19273a;border-left:3px solid #7fb8ff;padding:14px 17px;border-radius:6px}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:20px 0}.card{padding:17px;background:#111e2e;border:1px solid #263950;border-radius:12px}.label{color:#9cafc5;font-size:13px}.value{font-size:23px;font-weight:700;margin-top:4px}.up{color:#62dfa8}.down{color:#ff9299}.watch{color:#ffce76;font-weight:700}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1100px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #263950}th{color:#a9c1df;background:#0d1827}.mono{font:11px ui-monospace,Consolas,monospace;color:#a9c1df;word-break:break-all}.rule{background:#111e2e;border:1px solid #263950;border-radius:10px;padding:14px;margin:10px 0}.token{padding:0;border:0;background:transparent;color:#e8eff8;text-align:left;cursor:pointer}.token:hover b,.token:hover small{color:#6be1b2}.token small{display:block;color:#7fb8ff;margin-top:4px}.modal{position:fixed;inset:0;z-index:10;background:#000b;display:none;place-items:center;padding:20px}.modal.open{display:grid}.dialog{width:min(1400px,96vw);height:min(860px,92vh);background:#111e2e;border:1px solid #426381;border-radius:14px;display:grid;grid-template-rows:auto 1fr;overflow:hidden;box-shadow:0 24px 80px #000}.modal-head{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#19273a}.modal-head strong{margin-right:auto}.modal-head a,.modal-head button{border:1px solid #49739a;border-radius:7px;background:#0e1a29;color:#e8eff8;padding:7px 10px;text-decoration:none;cursor:pointer}.modal iframe{display:none}.preview{overflow:auto;padding:24px}.preview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.preview .card{min-height:62px}.preview h3{margin:20px 0 8px}.preview a{color:#7fb8ff}@media(max-width:800px){main{padding:16px}.grid{grid-template-columns:1fr 1fr}.modal{padding:6px}.dialog{width:100%;height:96vh}.preview-grid{grid-template-columns:1fr 1fr}}</style><main><div class="tag">GMGN SOCKET · PAPER SIMULATION · BUKAN ORDER NYATA</div><h1>${title}</h1><p class="muted">Laporan diperbarui setiap 10 detik. Data terakhir dibaca ${time(Date.now())} WIB; run mulai ${time(Date.parse(manifest?.startedAt ?? ''))} WIB.</p><div class="note">Setiap token yang lolos screening dan masuk detail dibeli secara simulasi sebesar <b>${usd(manifest?.simulation?.stakeUsd ?? 0.25)}</b>. Fee, slippage, dampak harga, dan swap nyata dihitung 0.</div><div class="grid"><div class="card"><div class="label">Simulasi buy</div><div class="value">${buys.length}</div></div><div class="card"><div class="label">Sudah sell</div><div class="value">${sells.length}</div></div><div class="card"><div class="label">Masih dipantau</div><div class="value watch">${open}</div></div><div class="card"><div class="label">Total keuntungan</div><div class="value up">${usd(profit)}</div></div><div class="card"><div class="label">Total kerugian</div><div class="value down">${usd(loss)}</div></div><div class="card"><div class="label">P/L total</div><div class="value ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}">${usd(totalPnl)}</div></div></div><h2>Setiap transaksi simulasi</h2><div class="scroll"><table><thead><tr><th>Token</th><th>Buy simulasi</th><th>Kenapa dibeli</th><th>Sell simulasi</th><th>Kenapa dijual</th><th>Hasil</th></tr></thead><tbody>${tradeTable || '<tr><td colspan="6" class="muted">Belum ada token yang masuk detail.</td></tr>'}</tbody></table></div><h2>Arti sinyal sell</h2><div class="rule"><b>Holder growth recovery</b> menahan posisi 10 detik saat harga −10% sampai sebelum −20%, holder total naik ≥10% dan ≥5, serta buy USD 5 detik ≥ sell USD. Stop −20% tetap berlaku.</div><div class="rule"><b>Target +40% dengan holder momentum</b> menunda sell hanya jika dua pembaruan holder signifikan datang berurutan dan harga masih naik ≥2% per 5 detik. Saat kenaikan melandai &lt;0,5% per 5 detik, exit memakai <code>TARGET_40_HOLDER_FLAT</code>.</div><div class="rule"><b>Sell pressure</b> memerlukan dua jendela socket 5-detik selesai berturut-turut: ≥10 trade, ≥3 penjual kandidat, sell USD share ≥70%, dan posisi sudah ≤−5%.</div><p class="muted">Sinyal hold holder tercatat: ${holds.length}. Aturan holder hanya aktif bila socket memberi angka total holder baru; daftar holder parsial tidak dipakai sebagai total.</p></main><div class="modal" id="tokenModal" role="dialog" aria-modal="true"><div class="dialog"><div class="modal-head"><strong id="modalTitle">Detail token</strong><a id="openGmgn" target="_blank" rel="noopener">Buka GMGN penuh</a><button id="closeModal">Tutup</button></div><section class="preview" id="localPreview"></section></div></div><script>const modal=document.querySelector('#tokenModal'),titleEl=document.querySelector('#modalTitle'),openLink=document.querySelector('#openGmgn'),preview=document.querySelector('#localPreview');function closeModal(){modal.classList.remove('open')}document.querySelectorAll('.token').forEach(button=>button.addEventListener('click',()=>{const mint=button.dataset.mint,url='https://gmgn.ai/sol/token/'+encodeURIComponent(mint);titleEl.textContent=(button.dataset.symbol||'Token')+' — data socket';openLink.href=url;const d=window.__preview[mint]||{};preview.innerHTML='<h2>'+String(d.symbol||'Token')+'</h2><p class="mono">'+mint+'</p><div class="preview-grid"><div class="card"><div class="label">Harga buy simulasi</div><div class="value">'+d.entryPrice+'</div></div><div class="card"><div class="label">Harga terakhir socket</div><div class="value">'+d.lastPrice+'</div></div><div class="card"><div class="label">Likuiditas saat lolos</div><div class="value">'+d.liquidity+'</div></div><div class="card"><div class="label">Holder saat lolos</div><div class="value">'+d.holders+'</div></div><div class="card"><div class="label">Trade detail tertangkap</div><div class="value">'+d.buys+' buy / '+d.sells+' sell</div></div><div class="card"><div class="label">Arus USD tertangkap</div><div class="value">'+d.buyUsd+' / '+d.sellUsd+'</div></div></div><h3>Keputusan simulasi</h3><p>'+d.decision+'</p><h3>Kenapa dibeli</h3><p>'+d.buyReason+'</p><p class="muted">Ini adalah preview lokal dari data socket yang disimpan. GMGN memblokir embedding halaman aslinya; gunakan tombol “Buka GMGN penuh” untuk detail live.</p>';modal.classList.add('open')}));document.querySelector('#closeModal').addEventListener('click',closeModal);modal.addEventListener('click',event=>{if(event.target===modal)closeModal()});document.addEventListener('keydown',event=>{if(event.key==='Escape')closeModal()});</script></html>`;
html = html.replace('<h1>', '<nav style="display:flex;gap:8px;margin-bottom:18px"><a style="padding:8px 12px;border:1px solid #426381;border-radius:7px;color:#fff;background:#235577;text-decoration:none" href="/paper-simulation-report.html">Run terbaru</a><a style="padding:8px 12px;border:1px solid #426381;border-radius:7px;color:#b9d5f3;text-decoration:none" href="/run-history.html">Riwayat run</a></nav><h1>');
html = html.replace('<h2>Arti sinyal sell</h2>', `<h2>Masuk detail, belum dibeli</h2><p class="muted">Token di bawah tetap dipantau. Buy hanya dibuat bila harga berhenti turun atau mulai pulih.</p><div class="scroll"><table><thead><tr><th>Token</th><th>Terakhir diblok</th><th>Harga saat diblok</th><th>Perubahan 5 dtk</th><th>Turun beruntun</th><th>Status</th></tr></thead><tbody>${blockedTable || '<tr><td colspan="6" class="muted">Belum ada token yang diblok karena penurunan harga beruntun.</td></tr>'}</tbody></table></div><h2>Arti sinyal sell</h2>`);
const preview = Object.fromEntries(buys.map(buy => {
  const screen = screened.get(buy.mint), activity = activityByMint.get(buy.mint) ?? {}, sell = sellsByMint.get(buy.mint);
  return [buy.mint, { symbol: buy.metadata?.symbol ?? 'Token', entryPrice: usd(buy.entryPriceUsd), lastPrice: usd(activity.latestPriceUsd), liquidity: usd(fieldValue(screen, 'liquidityUsd')), holders: f(fieldValue(screen, 'holders'), 0), buys: activity.buys ?? 0, sells: activity.sells ?? 0, buyUsd: usd(activity.buyUsd), sellUsd: usd(activity.sellUsd), buyReason: buyReason(buy), decision: sell ? sellReason(sell) + ' Hasil: ' + usd(sell.pnlUsd) + ' (' + pct(sell.pnlPercent) + ').' : 'Masih dipantau; belum ada sinyal sell.' }];
}));
for (const row of blocked) {
  if (preview[row.mint]) continue;
  const screen = screened.get(row.mint), activity = activityByMint.get(row.mint) ?? {}, gate = row.entryGate ?? {};
  preview[row.mint] = { symbol: screen?.metadata?.symbol ?? 'Token', entryPrice: 'Belum dibeli', lastPrice: usd(activity.latestPriceUsd ?? row.priceUsd), liquidity: usd(fieldValue(screen, 'liquidityUsd')), holders: f(fieldValue(screen, 'holders'), 0), buys: activity.buys ?? 0, sells: activity.sells ?? 0, buyUsd: usd(activity.buyUsd), sellUsd: usd(activity.sellUsd), buyReason: buyReason({ mint: row.mint }), decision: `Buy diblok karena harga masih turun: ${pct(gate.momentum5sPercent)} dalam 5 detik, ${f(gate.consecutiveDeclines, 0)} penurunan harga beruntun. ${completedDetails.has(row.mint) ? 'Observasi detail selesai tanpa buy.' : 'Token tetap dipantau sampai harga stabil atau pulih.'}` };
}
html = html.replace('</html>', `<script>window.__preview=${JSON.stringify(preview).replace(/</g, '\\u003c')};</script></html>`);
writeFileSync(join(folder, 'simulation-report.html'), html);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/paper-simulation-report.html', html);
console.log(JSON.stringify({ report: join(folder, 'simulation-report.html'), latest: 'dist/paper-simulation-report.html', buys: buys.length, positions: sells.length, totalPnlUsd: totalPnl }));
