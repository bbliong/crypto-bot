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
const tokenSummaries = new Map(readLines('token-summary.jsonl').map(row => [row.mint, row]));
const completedDetails = new Set(tokenSummaries.keys());
const summary = readJson('simulation-summary.json');
const manifest = readJson('manifest.json');
const strategy = readJson('strategy.json');
const buys = rows.filter(row => row.type === 'SIMULATED_BUY');
const sells = rows.filter(row => row.type === 'SIMULATED_SELL');
const holds = rows.filter(row => row.type === 'SIMULATION_HOLD');
const sellsByMint = new Map(sells.map(row => [row.mint, row]));
const blockedByMint = new Map();
for (const row of events) if (row.type === 'SIMULATION_BUY_BLOCKED') blockedByMint.set(row.mint, row);
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
const f = (v, digits = 4) => Number.isFinite(v) ? Number(v).toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
// Six decimals turns $0.000007781 into the misleading $0.000008.  Memecoin
// prices need enough digits for the report to show the actual simulation tick.
const usd = v => Number.isFinite(v) ? '$' + f(v, Math.abs(Number(v)) < 0.01 ? 10 : 6) : '—';
const pct = v => Number.isFinite(v) ? (v > 0 ? '+' : '') + f(v, 2) + '%' : '—';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const time = value => value ? new Date(value).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '—';
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
const tradeTable = buys.slice().reverse().map(buy => {
  const sell = sellsByMint.get(buy.mint), symbol = buy.metadata?.symbol || sell?.metadata?.symbol || 'Token';
  const unpriced = unpricedByMint.get(buy.mint);
  const resultClass = sell ? (sell.pnlUsd > 0 ? 'up' : sell.pnlUsd < 0 ? 'down' : '') : '';
  return `<tr><td><button class="token" data-mint="${esc(buy.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(buy.mint)}</span><small>Preview detail GMGN</small></button></td><td>${time(buy.observedAt)}<br>${usd(buy.stakeUsd)} @ ${usd(buy.entryPriceUsd)}</td><td>${esc(buyReason(buy))}</td><td>${sell ? `${time(sell.observedAt)}<br>${usd(sell.exit?.priceUsd)}` : unpriced ? `<span class="watch">Sesi selesai ${time(unpriced.observedAt)}</span>` : '<span class="watch">Masih dipantau</span>'}</td><td>${sell ? esc(sellReason(sell)) : unpriced ? 'Harga transaksi terakhir sudah lebih dari 5 detik; hasil jual tidak dihitung.' : 'Belum ada sinyal sell.'}</td><td class="${resultClass}">${sell ? `<b>${usd(sell.pnlUsd)}</b><br>${pct(sell.pnlPercent)}` : '—'}</td></tr>`;
}).join('');
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
  const latestBlockText = latestSnap?.blockingReasons?.length
    ? latestSnap.blockingReasons.map(r => esc(r.replace(/^([^:]+):/, '<b>$1</b>: '))).join('; ')
    : detail;
  return `<tr><td><button class="token" data-mint="${esc(row.mint)}" data-symbol="${esc(symbol)}"><b>${esc(symbol)}</b><br><span class="mono">${esc(row.mint)}</span><small>Preview data socket</small></button></td><td>${detailStartCell}</td><td>${usd(row.priceUsd)}</td><td class="down">${momentumText}</td><td>${candle ? '—' : f(gate.consecutiveDeclines, 0)}</td><td><b class="${statusClass}">${status}</b><br><span class="muted">${latestBlockText}</span></td></tr>`;
}).join('');
const profit = sells.filter(row => row.pnlUsd > 0).reduce((sum, row) => sum + row.pnlUsd, 0);
const loss = sells.filter(row => row.pnlUsd < 0).reduce((sum, row) => sum + row.pnlUsd, 0);
const totalPnl = sells.reduce((sum, row) => sum + (row.pnlUsd ?? 0), 0);
const open = buys.length - sells.length - unpricedByMint.size;
const pumpBandNote = strategy?.strategy === 'pump-band'
  ? `Token fresh dalam market cap $3.000–$10.000 mendapat slot detail kosong. Buy simulasi $${f(manifest?.simulation?.stakeUsd ?? 0.25, 2)} dilakukan pada tick transaksi pu baru pertama. Sell simulasi terjadi saat harga turun 20% dari puncak, atau setelah 20 detik jika harga terakhir masih berumur paling lama 5 detik. Fee dan slippage belum dihitung. ${unpricedByMint.size} sesi selesai tanpa harga jual segar sehingga P/L-nya belum dinilai.`
  : `Setiap token yang lolos screening dan masuk detail dibeli secara simulasi sebesar <b>${usd(manifest?.simulation?.stakeUsd ?? 0.25)}</b>. Fee, slippage, dampak harga, dan swap nyata dihitung 0.`;
const pumpBandRulesHtml = strategy?.strategy === 'pump-band'
  ? '<h2>Arti sinyal sell</h2><div class="rule"><b>PUMP_DUMP_20</b>: harga transaksi pu turun sedikitnya 20% dari puncak yang tertangkap setelah buy.</div><div class="rule"><b>PUMP_OBSERVATION_END</b>: sesi 20 detik selesai dan harga transaksi terakhir masih segar. Harga yang lebih tua dari 5 detik tidak dipakai untuk menghitung hasil jual.</div>'
  : '<h2>Arti sinyal sell</h2><div class="rule"><b>Holder growth recovery</b> menahan posisi 10 detik saat harga −10% sampai sebelum −20%, holder total naik ≥10% dan ≥5, serta buy USD 5 detik ≥ sell USD. Stop −20% tetap berlaku.</div><div class="rule"><b>Target +40% dengan holder momentum</b> menunda sell hanya jika dua pembaruan holder signifikan datang berurutan dan harga masih naik ≥2% per 5 detik. Saat kenaikan melandai &lt;0,5% per 5 detik, exit memakai <code>TARGET_40_HOLDER_FLAT</code>.</div><div class="rule"><b>Sell pressure</b> memerlukan dua jendela socket 5-detik selesai berturut-turut: ≥10 trade, ≥3 penjual kandidat, sell USD share ≥70%, dan posisi sudah ≤−5%.</div><p class="muted">Sinyal hold holder tercatat: ' + holds.length + '. Aturan holder hanya aktif bila socket memberi angka total holder baru; daftar holder parsial tidak dipakai sebagai total.</p>';
const title = `Laporan simulasi — ${basename(folder)}`;
let html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#09111d;color:#e8eff8;font:15px/1.5 system-ui,Segoe UI,sans-serif}main{max-width:1500px;margin:auto;padding:30px}.tag{color:#6be1b2;font-weight:700;letter-spacing:1px;font-size:12px}.muted{color:#9cafc5}.note{background:#19273a;border-left:3px solid #7fb8ff;padding:14px 17px;border-radius:6px}.grid{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:20px 0}.card{padding:17px;background:#111e2e;border:1px solid #263950;border-radius:12px}.label{color:#9cafc5;font-size:13px}.value{font-size:23px;font-weight:700;margin-top:4px}.up{color:#62dfa8}.down{color:#ff9299}.watch{color:#ffce76;font-weight:700}.scroll{overflow:auto}table{width:100%;border-collapse:collapse;min-width:1100px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #263950}th{color:#a9c1df;background:#0d1827}.mono{font:11px ui-monospace,Consolas,monospace;color:#a9c1df;word-break:break-all}.rule{background:#111e2e;border:1px solid #263950;border-radius:10px;padding:14px;margin:10px 0}.token{padding:0;border:0;background:transparent;color:#e8eff8;text-align:left;cursor:pointer}.token:hover b,.token:hover small{color:#6be1b2}.token small{display:block;color:#7fb8ff;margin-top:4px}.modal{position:fixed;inset:0;z-index:10;background:#000b;display:none;place-items:center;padding:20px}.modal.open{display:grid}.dialog{width:min(1400px,96vw);height:min(860px,92vh);background:#111e2e;border:1px solid #426381;border-radius:14px;display:grid;grid-template-rows:auto 1fr;overflow:hidden;box-shadow:0 24px 80px #000}.modal-head{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#19273a}.modal-head strong{margin-right:auto}.modal-head a,.modal-head button{border:1px solid #49739a;border-radius:7px;background:#0e1a29;color:#e8eff8;padding:7px 10px;text-decoration:none;cursor:pointer}.modal iframe{display:none}.preview{overflow:auto;padding:24px}.preview-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.preview .card{min-height:62px}.preview h3{margin:20px 0 8px}.preview a{color:#7fb8ff}.tl-table{width:100%;border-collapse:collapse;font-size:13px;min-width:900px}.tl-table th{background:#0d1827;color:#a9c1df;padding:7px 10px;text-align:left;position:sticky;top:0;z-index:1}.tl-table td{padding:6px 10px;border-bottom:1px solid #1e2e40;vertical-align:top}.tl-table tr:hover td{background:#192a3d}.tl-scroll{max-height:280px;overflow:auto;border:1px solid #263950;border-radius:8px;margin-top:6px}.hbar{display:flex;align-items:center;gap:5px;font-size:12px;margin:2px 0}.hbar-fill{height:8px;border-radius:4px;background:#5b8ecc;flex-shrink:0}.hbar-fill.dev{background:#f5a623}.hbar-pct{color:#9cafc5;min-width:42px;text-align:right}.hbar-addr{font:10px ui-monospace,Consolas,monospace;color:#7d9bb7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px}.delta-up{color:#62dfa8}.delta-down{color:#ff9299}.block-reason{font-size:11px;color:#ffce76;background:#1e2c10;border-radius:3px;padding:1px 5px;margin:1px 2px;display:inline-block}#refresh-bar{position:fixed;top:0;left:0;right:0;height:3px;background:#1e3a5a;z-index:20}#refresh-fill{height:100%;width:0;background:#6be1b2;transition:width 10s linear}@media(max-width:800px){main{padding:16px}.grid{grid-template-columns:1fr 1fr}.modal{padding:6px}.dialog{width:100%;height:96vh}.preview-grid{grid-template-columns:1fr 1fr}}</style><div id="refresh-bar"><div id="refresh-fill"></div></div><main><div class="tag">GMGN SOCKET · PAPER SIMULATION · BUKAN ORDER NYATA</div><h1>${title}</h1><p class="muted">Laporan diperbarui setiap 10 detik. Data terakhir dibaca ${time(Date.now())} WIB; run mulai ${time(Date.parse(manifest?.startedAt ?? ''))} WIB.</p><div class="note">${pumpBandNote}</div><div class="grid"><div class="card"><div class="label">Simulasi buy</div><div class="value">${buys.length}</div></div><div class="card"><div class="label">Sudah sell</div><div class="value">${sells.length}</div></div><div class="card"><div class="label">${strategy?.strategy === 'pump-band' ? 'Harga keluar tak segar' : 'Masih dipantau'}</div><div class="value watch">${strategy?.strategy === 'pump-band' ? unpricedByMint.size : open}</div></div><div class="card"><div class="label">Total keuntungan</div><div class="value up">${usd(profit)}</div></div><div class="card"><div class="label">Total kerugian</div><div class="value down">${usd(loss)}</div></div><div class="card"><div class="label">P/L total</div><div class="value ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}">${usd(totalPnl)}</div></div></div><h2>Setiap transaksi simulasi</h2><div class="scroll"><table><thead><tr><th>Token</th><th>Buy simulasi</th><th>Kenapa dibeli</th><th>Sell simulasi</th><th>Kenapa dijual</th><th>Hasil</th></tr></thead><tbody>${tradeTable || '<tr><td colspan="6" class="muted">Belum ada token yang masuk detail.</td></tr>'}</tbody></table></div>${pumpBandRulesHtml}</main><div class="modal" id="tokenModal" role="dialog" aria-modal="true"><div class="dialog"><div class="modal-head"><strong id="modalTitle">Detail token</strong><a id="openGmgn" target="_blank" rel="noopener">Buka GMGN penuh</a><button id="closeModal">Tutup</button></div><section class="preview" id="localPreview"></section></div></div><script>
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
document.querySelectorAll('.token').forEach(button=>button.addEventListener('click',()=>{
  const mint=button.dataset.mint,url='https://gmgn.ai/sol/token/'+encodeURIComponent(mint);
  titleEl.textContent=(button.dataset.symbol||'Token')+' \u2014 data socket';
  openLink.href=url;
  const d=window.__preview[mint]||{};
  renderModalContent(mint,d);
  _activeMint=mint;
  modal.classList.add('open');
}));
document.querySelector('#closeModal').addEventListener('click',()=>{_activeMint=null;closeModal()});
modal.addEventListener('click',event=>{if(event.target===modal){_activeMint=null;closeModal()}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){_activeMint=null;closeModal()}});
// Auto-refresh: fetch data terbaru tanpa reload halaman sehingga modal tetap terbuka
function startRefreshCycle(){
  const fill=document.getElementById('refresh-fill');
  function resetBar(){if(fill){fill.style.transition='none';fill.style.width='0';requestAnimationFrame(()=>requestAnimationFrame(()=>{fill.style.transition='width 10s linear';fill.style.width='100%';}));}}
  function kick(){
    resetBar();
    setTimeout(async()=>{
      try{
        const res=await fetch(location.href,{cache:'no-store'});
        const text=await res.text();
        const marker='<script>window.'+'__preview=';
        const idx=text.lastIndexOf(marker);
        if(idx>-1){
          const jsonStart=idx+marker.length;
          const endMarker=';<'+'/script>';
          const endIdx=text.indexOf(endMarker,jsonStart);
          const raw=endIdx>-1?text.slice(jsonStart,endIdx):text.slice(jsonStart,text.lastIndexOf(';'));
          const fresh=JSON.parse(raw);
          // Update data in-place tanpa rebuild DOM utama
          for(const k of Object.keys(fresh)) window.__preview[k]=fresh[k];
          for(const k of Object.keys(window.__preview)) if(!(k in fresh)) delete window.__preview[k];
          // Jika modal terbuka, perbarui isi modal dengan data terbaru
          if(_activeMint&&modal.classList.contains('open')){
            const d=window.__preview[_activeMint]||{};
            renderModalContent(_activeMint,d);
          }
        }
      }catch(e){console.warn('[refresh-error]',e);}
      kick();
    },10000);
  }
  kick();
}
startRefreshCycle();
</script></html>`;
html = html.replace('<h1>', '<nav style="display:flex;gap:8px;margin-bottom:18px"><a style="padding:8px 12px;border:1px solid #426381;border-radius:7px;color:#fff;background:#235577;text-decoration:none" href="/paper-simulation-report.html">Run terbaru</a><a style="padding:8px 12px;border:1px solid #426381;border-radius:7px;color:#b9d5f3;text-decoration:none" href="/run-history.html">Riwayat run</a></nav><h1>');
html = html.replace('<h2>Arti sinyal sell</h2>', `<h2>Masuk detail, belum dibeli</h2><p class="muted">Token di bawah tetap dipantau. Buy hanya dibuat bila harga berhenti turun atau mulai pulih.</p><div class="scroll"><table><thead><tr><th>Token</th><th>Terakhir diblok</th><th>Harga saat diblok</th><th>Perubahan 5 dtk</th><th>Turun beruntun</th><th>Status</th></tr></thead><tbody>${blockedTable || '<tr><td colspan="6" class="muted">Belum ada token yang diblok karena penurunan harga beruntun.</td></tr>'}</tbody></table></div><h2>Arti sinyal sell</h2>`);
const preview = Object.fromEntries(buys.map(buy => {
  const screen = screened.get(buy.mint), activity = activityByMint.get(buy.mint) ?? {}, sell = sellsByMint.get(buy.mint);
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
html = html.replace('</html>', `<script>window.__preview=${JSON.stringify(preview).replace(/</g, '\\u003c')};</script></html>`);
if (strategy?.strategy === 'momentum-v2') {
  html = html.replace(/<h2>Arti sinyal sell<\/h2>[\s\S]*?<\/main>/, `<h2>Rumus momentum v2</h2><div class="rule">Entry: return harga 5 detik +0.25% hingga +20%, regresi log-harga positif, buy share ≥60%, minimal 3 pembeli, pembeli terbesar ≤50%. Token muda memerlukan dua interval pertumbuhan holder ≥10% dan ≥5 holder.</div><div class="rule">Exit diperiksa pada trade socket baru: stop −20% dengan konfirmasi trade berbeda, penjualan holder signifikan, profit lock dan trailing 4–8%. Target +40% dapat ditahan bila momentum serta holder kuat, dengan batas +50%. Harga loncat tetap dicatat sesuai tick yang tersedia.</div><p><a href="/momentum-replay.html">Lihat perbandingan replay dan keterbatasannya</a></p></main>`);
  html = html.replace('Setiap token yang lolos screening dan masuk detail dibeli secara simulasi sebesar', 'Token dibeli secara simulasi setelah screening, candle, holder, dan momentum v2 lolos; nominal');
}
if (strategy?.strategy === 'flow-3') {
  html = html.replace(/<h2>Arti sinyal sell<\/h2>[\s\S]*?<\/main>/, `<h2>Aturan flow-3</h2><div class="rule">Screening tetap memakai umur 0–900 detik, holder minimal 20, likuiditas $6.000–$15.000, dan Top-10 maksimal 30%. Entry memerlukan harga detail yang stabil serta minimal 5 trade dalam 20 detik dengan USD buy ≥ USD sell. Riwayat dua candle diperbolehkan, selama candle berjalan tidak turun.</div><div class="rule">Exit flow-3: target +40%, stop −20%, trailing 10% setelah puncak minimal +20%, atau sell pressure dua window. Tidak memakai gate holder-distribution, blind-protection, target dinamis, maupun exit developer/whale dari strategi yang lebih baru.</div></main>`);
  html = html.replace('Setiap token yang lolos screening dan masuk detail dibeli secara simulasi sebesar', 'Token dibeli simulasi setelah gate flow-3 lolos; nominal');
}
writeFileSync(join(folder, 'simulation-report.html'), html);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/paper-simulation-report.html', html);
console.log(JSON.stringify({ report: join(folder, 'simulation-report.html'), latest: 'dist/paper-simulation-report.html', buys: buys.length, positions: sells.length, totalPnlUsd: totalPnl }));
