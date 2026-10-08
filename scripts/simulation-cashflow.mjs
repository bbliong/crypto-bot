import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Derived from the confirmed Solana receipts audited for this wallet:
// 0.000105 SOL meta fee + 0.000100 SOL explicit tip per submitted leg.
const NETWORK_AND_TIP_SOL_PER_LEG = 0.000205;
// Observed when GMGN had to create a Token-2022 account. This is a recoverable
// rent deposit, so it reduces available cash but is retained in equity.
const TOKEN_ACCOUNT_RENT_SOL = 0.00151384;
const FALLBACK_SOL_USD = 120;

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, 'utf8').split(/\r?\n/).flatMap(line => {
      if (!line.trim()) return [];
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positionKey(row) {
  return row.positionId || `${row.paperLane ?? 'control'}:${row.mint ?? 'unknown'}:${row.observedAt ?? 'unknown'}`;
}

function quoteReturnPercent(quotesByPosition, positionId, socketReturnPercent) {
  const quotes = quotesByPosition.get(positionId) ?? [];
  const buy = quotes.find(row => row.type === 'QUOTE_BUY_COMPARISON');
  const sell = quotes.find(row => row.type === 'QUOTE_SELL_COMPARISON');
  const amountIn = number(buy?.quote?.amountInUsd, 0);
  const amountOut = number(sell?.quote?.amountOutUsd, 0);
  if (amountIn > 0 && amountOut >= 0) {
    return { returnPercent: (amountOut / amountIn - 1) * 100, source: 'ROUTE_QUOTE', buyQuote: buy, sellQuote: sell };
  }
  return { returnPercent: socketReturnPercent - 3.5, source: 'SOCKET_MINUS_3_5_PERCENT', buyQuote: buy, sellQuote: sell };
}

function solUsdFromQuote(quote, side) {
  if (!quote) return null;
  const direct = number(quote.detailSolSpotUsd);
  if (direct && direct > 0) return direct;
  if (side === 'BUY') {
    const amount = number(quote.quote?.amountInUsd);
    const lamports = number(quote.inputAmountBaseUnits ?? quote.quote?.inAmount);
    if (amount && lamports > 0) return amount / (lamports / 1e9);
  }
  if (side === 'SELL') {
    const amount = number(quote.quote?.amountOutUsd);
    const lamports = number(quote.quote?.outAmount);
    if (amount && lamports > 0) return amount / (lamports / 1e9);
  }
  return null;
}

/**
 * Replays a single run's paper trades as the existing $20 cash-flow report did:
 * $5 per position, route quote when a full buy/sell pair exists, otherwise
 * socket return less 3.5%. It is intentionally display-only and never submits.
 */
export function buildRunCashflow(runPath, { startingCashUsd = 20, stakeUsd = 5, lane = 'all' } = {}) {
  const simulated = readJsonLines(join(runPath, 'simulated-trades.jsonl'));
  const routeQuotes = readJsonLines(join(runPath, 'quote-simulated-orders.jsonl'));
  const quotesByPosition = new Map();
  for (const quote of routeQuotes) {
    if (!quote.positionId) continue;
    const list = quotesByPosition.get(quote.positionId) ?? [];
    list.push(quote);
    quotesByPosition.set(quote.positionId, list);
  }

  const sourceEvents = simulated.filter(row => row?.type === 'SIMULATED_BUY' || row?.type === 'SIMULATED_SELL');
  const lanes = [...new Set(sourceEvents.map(row => row.paperLane ?? 'control'))].sort();
  const selectedLane = lane === 'all' || lanes.includes(lane) ? lane : 'all';
  const events = sourceEvents
    .filter(row => selectedLane === 'all' || (row.paperLane ?? 'control') === selectedLane)
    .sort((left, right) => number(left.observedAt, 0) - number(right.observedAt, 0));
  const open = new Map();
  const trades = [];
  const ledger = [];
  const tokenAccounts = new Set();
  let cash = startingCashUsd;
  let reclaimableRentUsd = 0;
  let totalNetworkAndTipUsd = 0;
  let totalRouteImpactUsd = 0;
  let totalGmgnPlatformUsdIncluded = 0;
  let skippedBuys = 0;
  let peakEquity = startingCashUsd;
  let maxDrawdownPercent = 0;

  // Rent remains part of equity because a zero-balance token account can be
  // closed later to return its lamports. It still reduces available cash now.
  const equity = () => cash + reclaimableRentUsd + [...open.values()].reduce((total, trade) => total + trade.stakeUsd, 0);
  const record = entry => {
    const currentEquity = equity();
    peakEquity = Math.max(peakEquity, currentEquity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peakEquity > 0 ? ((peakEquity - currentEquity) / peakEquity) * 100 : 0);
    ledger.push({ ...entry, cashUsd: cash, equityUsd: currentEquity, reclaimableRentUsd, openPositions: open.size });
  };

  for (const event of events) {
    const key = positionKey(event);
    const at = number(event.observedAt, 0);
    const eventLane = event.paperLane ?? 'control';
    const symbol = event.metadata?.symbol ?? event.symbol ?? event.mint?.slice(0, 8) ?? 'Token';
    if (event.type === 'SIMULATED_BUY') {
      const positionQuotes = quotesByPosition.get(key) ?? [];
      const buyQuote = positionQuotes.find(row => row.type === 'QUOTE_BUY_COMPARISON');
      const solUsd = solUsdFromQuote(buyQuote, 'BUY') ?? FALLBACK_SOL_USD;
      // A GMGN route quote already returns an amount after its platform/route
      // charges. This is a transparent estimate only; do not subtract it again.
      const gmgnPlatformUsdIncluded = buyQuote ? stakeUsd * 0.01 : null;
      const networkAndTipUsd = NETWORK_AND_TIP_SOL_PER_LEG * solUsd;
      const createsTokenAccount = Boolean(event.mint) && !tokenAccounts.has(event.mint);
      const rentUsd = createsTokenAccount ? TOKEN_ACCOUNT_RENT_SOL * solUsd : 0;
      const requiredCash = stakeUsd + networkAndTipUsd + rentUsd;
      if (cash + 1e-9 < requiredCash) {
        skippedBuys++;
        record({ type: 'SKIPPED_BUY', observedAt: at, positionId: key, mint: event.mint ?? null, symbol, lane: eventLane, stakeUsd, requiredCashUsd: requiredCash, reason: 'INSUFFICIENT_CASH_AFTER_FEES' });
        continue;
      }
      if (createsTokenAccount) {
        tokenAccounts.add(event.mint);
        reclaimableRentUsd += rentUsd;
      }
      totalNetworkAndTipUsd += networkAndTipUsd;
      if (gmgnPlatformUsdIncluded !== null) totalGmgnPlatformUsdIncluded += gmgnPlatformUsdIncluded;
      cash -= stakeUsd + networkAndTipUsd + rentUsd;
      const trade = {
        positionId: key, mint: event.mint ?? null, symbol, lane: eventLane, buyAt: at, buyPriceUsd: number(event.entryPriceUsd), stakeUsd,
        sellAt: null, sellPriceUsd: null, pnlUsd: null, returnPercent: null, returnSource: null, exitReason: null, status: 'OPEN',
        buyNetworkAndTipUsd: networkAndTipUsd, sellNetworkAndTipUsd: null, accountRentUsd: rentUsd, gmgnPlatformUsdIncluded,
      };
      open.set(key, trade);
      record({ type: 'BUY', observedAt: at, positionId: key, mint: trade.mint, symbol, lane: eventLane, stakeUsd, entryPriceUsd: trade.buyPriceUsd,
        networkAndTipUsd, accountRentUsd: rentUsd, reason: event.entryGate?.reason ?? 'ENTRY_PASSED' });
      continue;
    }

    let trade = open.get(key);
    if (!trade && event.mint) {
      trade = [...open.values()].find(candidate => candidate.mint === event.mint && candidate.lane === eventLane) ?? null;
    }
    if (!trade) {
      record({ type: 'UNMATCHED_SELL', observedAt: at, positionId: key, mint: event.mint ?? null, symbol, lane: eventLane, reason: event.reason ?? 'UNMATCHED_SELL' });
      continue;
    }
    const socketReturn = number(event.pnlPercent, trade.buyPriceUsd && number(event.exitPriceUsd) !== null
      ? ((number(event.exitPriceUsd) / trade.buyPriceUsd) - 1) * 100
      : 0);
    const route = quoteReturnPercent(quotesByPosition, trade.positionId, socketReturn);
    const solUsd = solUsdFromQuote(route.sellQuote, 'SELL') ?? solUsdFromQuote(route.buyQuote, 'BUY') ?? FALLBACK_SOL_USD;
    const sellNetworkAndTipUsd = NETWORK_AND_TIP_SOL_PER_LEG * solUsd;
    const grossProceedsUsd = trade.stakeUsd * (1 + route.returnPercent / 100);
    const routeImpactUsd = route.source === 'ROUTE_QUOTE'
      ? trade.stakeUsd * (socketReturn - route.returnPercent) / 100
      : null;
    totalNetworkAndTipUsd += sellNetworkAndTipUsd;
    if (routeImpactUsd !== null) totalRouteImpactUsd += routeImpactUsd;
    trade = {
      ...trade, sellAt: at, sellPriceUsd: number(event.exitPriceUsd), returnPercent: route.returnPercent,
      pnlUsd: grossProceedsUsd - trade.stakeUsd - trade.buyNetworkAndTipUsd - sellNetworkAndTipUsd,
      grossProceedsUsd, sellNetworkAndTipUsd, routeImpactUsd,
      returnSource: route.source, exitReason: event.reason ?? 'UNKNOWN', status: 'CLOSED',
    };
    open.delete(trade.positionId);
    cash += grossProceedsUsd - sellNetworkAndTipUsd;
    trades.push(trade);
    record({ type: 'SELL', observedAt: at, positionId: trade.positionId, mint: trade.mint, symbol: trade.symbol, lane: eventLane, stakeUsd: trade.stakeUsd,
      proceedsUsd: grossProceedsUsd, pnlUsd: trade.pnlUsd, returnPercent: trade.returnPercent, returnSource: trade.returnSource,
      networkAndTipUsd: sellNetworkAndTipUsd, routeImpactUsd, exitPriceUsd: trade.sellPriceUsd, reason: trade.exitReason });
  }

  const openTrades = [...open.values()];
  return {
    startingCashUsd,
    stakeUsd,
    lane: selectedLane,
    lanes,
    sourceEvents: events.length,
    closedTrades: trades.length,
    openTrades: openTrades.length,
    skippedBuys,
    networkAndTipSolPerLeg: NETWORK_AND_TIP_SOL_PER_LEG,
    totalNetworkAndTipUsd,
    totalRouteImpactUsd,
    totalGmgnPlatformUsdIncluded,
    reclaimableRentUsd,
    feeModel: {
      receiptSampleSize: 29,
      networkFeeSolPerLeg: 0.000105,
      tipSolPerLeg: 0.0001,
      networkAndTipSolPerLeg: NETWORK_AND_TIP_SOL_PER_LEG,
      gmgnPlatformBuyPercent: 1,
      tokenAccountRentSol: TOKEN_ACCOUNT_RENT_SOL,
      routeQuoteIncludesSwapFees: true,
    },
    endingCashUsd: cash,
    endingEquityUsd: equity(),
    netPnlUsd: equity() - startingCashUsd,
    roiPercent: startingCashUsd > 0 ? ((equity() / startingCashUsd) - 1) * 100 : 0,
    maxDrawdownPercent,
    trades: [...trades, ...openTrades].sort((left, right) => right.buyAt - left.buyAt),
    ledger: ledger.sort((left, right) => left.observedAt - right.observedAt),
  };
}

export function renderSimulationPage() {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulasi per run 3 jam</title><style>
:root{color-scheme:dark}body{margin:0;background:#09111d;color:#e8eff8;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1500px;margin:auto;padding:28px}.muted{color:#9cafc5}.card{background:#111e2e;border:1px solid #263950;border-radius:12px;padding:16px}.controls{display:flex;gap:12px;flex-wrap:wrap;align-items:end}.field{display:grid;gap:5px}.field label{font-size:12px;color:#9cafc5}.field select,.field input{background:#0c1827;border:1px solid #426381;color:#e8eff8;border-radius:7px;padding:9px;min-width:220px}.field input{min-width:90px;width:90px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.value{font-size:21px;font-weight:700}.up{color:#62dfa8}.down{color:#ff9299}.scroll{overflow:auto}.table{width:100%;border-collapse:collapse;min-width:1150px}.table th,.table td{text-align:left;padding:10px;border-bottom:1px solid #263950;vertical-align:top}.table th{background:#0d1827;color:#a9c1df;position:sticky;top:0}.badge{font-size:11px;border-radius:999px;padding:3px 7px;background:#203b5b;color:#b9dbff}.error{color:#ff9299}.loading{padding:30px;text-align:center}.chart{width:100%;height:300px;display:block;background:#0c1827;border-radius:8px}.chart-tip{min-height:20px;color:#9cafc5;font-size:12px;margin-top:8px}@media(max-width:800px){main{padding:14px}.grid{grid-template-columns:repeat(2,1fr)}.field select{min-width:100%}}</style></head>
<body><main><h1>Simulasi per run 3 jam</h1><p class="muted">Pilih satu slot run dan lane. Simulasi hanya menghitung trade paper yang cocok, berurutan menurut waktu trade. Tidak mengirim order.</p><section class="card controls"><div class="field"><label for="run">Run 3 jam</label><select id="run"><option>Memuat run…</option></select></div><div class="field"><label for="lane">Lane</label><select id="lane" disabled><option value="all">Semua lane</option></select></div><div class="field"><label for="capital">Modal awal USD</label><input id="capital" type="number" min="1" step="1" value="20"></div><div class="field"><label for="stake">Stake per trade USD</label><input id="stake" type="number" min="0.01" step="0.01" value="5"></div></section><p class="muted">Net P/L mengurangi network + tip sebesar 0.000205 SOL per leg. Hasil <b>ROUTE_QUOTE</b> sudah mencerminkan GMGN/platform dan biaya route DEX/Pump, sehingga tidak dikurangi kedua kali. Rent token mengurangi kas tersedia, tetapi tetap equity karena dapat diklaim kembali saat akun token kosong ditutup.</p><p id="state" class="muted loading">Memuat data simulasi…</p><section id="content" hidden><div class="grid" id="kpis"></div><section class="card"><h2>Grafik equity dan kas</h2><canvas class="chart" id="equityChart"></canvas><div id="chartTip" class="chart-tip">Arahkan pointer ke grafik untuk melihat event.</div></section><section class="card" style="margin-top:16px"><h2>Trade pada run dan lane terpilih</h2><div class="scroll"><table class="table"><thead><tr><th>Waktu BUY</th><th>Token / lane</th><th>Status</th><th>BUY → SELL</th><th>Return simulasi</th><th>P/L</th><th>Network + tip</th><th>Route vs paper</th><th>Dasar return</th><th>Alasan sell</th></tr></thead><tbody id="trades"></tbody></table></div></section><section class="card" style="margin-top:16px"><h2>Ledger cash-flow</h2><div class="scroll"><table class="table"><thead><tr><th>Waktu</th><th>Event</th><th>Token</th><th>Lane</th><th>P/L</th><th>Network + tip</th><th>Rent terkunci</th><th>Kas</th><th>Equity</th><th>Posisi buka</th></tr></thead><tbody id="ledger"></tbody></table></div></section></section></main><script>
const money=v=>Number.isFinite(Number(v))?Number(v).toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}):'—';const pct=v=>Number.isFinite(Number(v))?((Number(v)>=0?'+':'')+Number(v).toFixed(2)+'%'):'—';const time=v=>v?new Date(v).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',dateStyle:'short',timeStyle:'medium'}):'—';const esc=v=>String(v??'—').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));const signClass=v=>Number(v)>0?'up':Number(v)<0?'down':'';
const run=document.querySelector('#run'),lane=document.querySelector('#lane'),capital=document.querySelector('#capital'),stake=document.querySelector('#stake'),state=document.querySelector('#state'),content=document.querySelector('#content'),chart=document.querySelector('#equityChart'),tip=document.querySelector('#chartTip');let activeSimulation=null;
function optionLabel(item){return item.friendlyLabel||item.id}async function loadRuns(){const r=await fetch('/api/simulation-runs',{cache:'no-store'});if(!r.ok)throw new Error('Daftar run tidak tersedia');const data=await r.json();run.innerHTML=data.runs.map(item=>'<option value="'+esc(item.id)+'">'+esc(optionLabel(item))+'</option>').join('');if(data.selectedRun)run.value=data.selectedRun;}
function updateLaneOptions(simulation){const requested=simulation.lane||'all';lane.innerHTML='<option value="all">Semua lane</option>'+simulation.lanes.map(value=>'<option value="'+esc(value)+'">'+esc(value)+'</option>').join('');lane.value=requested;lane.disabled=simulation.lanes.length===0;}
function drawChart(){const points=activeSimulation?.ledger||[],ctx=chart.getContext('2d'),rect=chart.getBoundingClientRect(),dpr=window.devicePixelRatio||1,w=Math.max(300,Math.floor(rect.width*dpr)),h=Math.max(220,Math.floor(rect.height*dpr));chart.width=w;chart.height=h;ctx.scale(dpr,dpr);const cw=w/dpr,ch=h/dpr,pad={l:58,r:20,t:22,b:34};ctx.clearRect(0,0,cw,ch);ctx.fillStyle='#0c1827';ctx.fillRect(0,0,cw,ch);if(!points.length){ctx.fillStyle='#9cafc5';ctx.font='14px system-ui';ctx.fillText('Tidak ada event trade untuk lane ini.',pad.l,pad.t+25);return}const values=points.flatMap(p=>[p.cashUsd,p.equityUsd]);let lo=Math.min(...values),hi=Math.max(...values);if(lo===hi){lo-=1;hi+=1}const span=hi-lo||1;const x=i=>pad.l+(points.length===1?0:i/(points.length-1))*(cw-pad.l-pad.r),y=v=>pad.t+(hi-v)/span*(ch-pad.t-pad.b);ctx.strokeStyle='#29425d';ctx.lineWidth=1;ctx.font='11px system-ui';ctx.fillStyle='#9cafc5';for(let i=0;i<4;i++){const v=lo+(span*i/3),yy=y(v);ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(cw-pad.r,yy);ctx.stroke();ctx.fillText(money(v),4,yy+4)}function line(key,color){ctx.strokeStyle=color;ctx.lineWidth=2;ctx.beginPath();points.forEach((p,i)=>{const xx=x(i),yy=y(p[key]);if(i)ctx.lineTo(xx,yy);else ctx.moveTo(xx,yy)});ctx.stroke()}line('equityUsd','#00ff88');line('cashUsd','#00b4d8');ctx.fillStyle='#00ff88';ctx.fillRect(cw-190,8,10,10);ctx.fillStyle='#e8eff8';ctx.fillText('Equity',cw-176,18);ctx.fillStyle='#00b4d8';ctx.fillRect(cw-105,8,10,10);ctx.fillStyle='#e8eff8';ctx.fillText('Kas',cw-91,18);chart.onmousemove=e=>{const b=chart.getBoundingClientRect(),raw=(e.clientX-b.left-pad.l)/(b.width-pad.l-pad.r),index=Math.max(0,Math.min(points.length-1,Math.round(raw*(points.length-1))));const p=points[index];tip.textContent=time(p.observedAt)+' · '+p.type+' '+p.symbol+' · Kas '+money(p.cashUsd)+' · Equity '+money(p.equityUsd);};chart.onmouseleave=()=>{tip.textContent='Arahkan pointer ke grafik untuk melihat event.'}}
async function loadSimulation(){if(!run.value)return;state.hidden=false;content.hidden=true;state.className='muted loading';state.textContent='Menghitung simulasi untuk run dan lane terpilih…';const query=new URLSearchParams({run:run.value,lane:lane.value,capital:capital.value,stake:stake.value});const r=await fetch('/api/simulation-data?'+query,{cache:'no-store'});if(!r.ok)throw new Error('Data simulasi tidak tersedia');const data=await r.json();if(!data.ok)throw new Error(data.error||'Data simulasi tidak tersedia');const s=data.simulation;updateLaneOptions(s);activeSimulation=s;document.querySelector('#kpis').innerHTML=[['Run',data.run.friendlyLabel||data.run.id],['Lane',s.lane==='all'?'Semua lane':s.lane],['Trade selesai',s.closedTrades],['Posisi terbuka',s.openTrades],['Net P/L',money(s.netPnlUsd)],['ROI',pct(s.roiPercent)],['Network + tip (dipotong)',money(s.totalNetworkAndTipUsd)],['GMGN 1% BUY estimasi (di route)',money(s.totalGmgnPlatformUsdIncluded)],['Route vs socket paper (di route)',money(s.totalRouteImpactUsd)],['Rent token terkunci',money(s.reclaimableRentUsd)]].map(([l,v])=>'<div class="card"><div class="muted">'+esc(l)+'</div><div class="value '+(l==='Net P/L'||l==='ROI'?signClass(l==='ROI'?s.roiPercent:s.netPnlUsd):'')+'">'+esc(v)+'</div></div>').join('');document.querySelector('#trades').innerHTML=s.trades.map(t=>'<tr><td>'+time(t.buyAt)+'</td><td><b>'+esc(t.symbol)+'</b><br><span class="muted">'+esc(t.lane)+'</span></td><td><span class="badge">'+esc(t.status)+'</span></td><td>'+money(t.stakeUsd)+' → '+(t.sellAt?time(t.sellAt):'—')+'</td><td class="'+signClass(t.returnPercent)+'">'+pct(t.returnPercent)+'</td><td class="'+signClass(t.pnlUsd)+'">'+money(t.pnlUsd)+'</td><td>'+money((t.buyNetworkAndTipUsd||0)+(t.sellNetworkAndTipUsd||0))+'</td><td class="'+signClass(-(t.routeImpactUsd||0))+'">'+money(t.routeImpactUsd)+'</td><td>'+esc(t.returnSource)+'</td><td>'+esc(t.exitReason)+'</td></tr>').join('')||'<tr><td colspan="10" class="muted">Tidak ada trade paper pada run/lane ini.</td></tr>';document.querySelector('#ledger').innerHTML=s.ledger.map(e=>'<tr><td>'+time(e.observedAt)+'</td><td>'+esc(e.type)+'</td><td>'+esc(e.symbol)+'</td><td>'+esc(e.lane)+'</td><td class="'+signClass(e.pnlUsd)+'">'+money(e.pnlUsd)+'</td><td>'+money(e.networkAndTipUsd)+'</td><td>'+money(e.accountRentUsd)+'</td><td>'+money(e.cashUsd)+'</td><td>'+money(e.equityUsd)+'</td><td>'+esc(e.openPositions)+'</td></tr>').join('')||'<tr><td colspan="10" class="muted">Tidak ada event trade.</td></tr>';state.hidden=true;content.hidden=false;requestAnimationFrame(drawChart);}
async function refresh(){try{await loadSimulation()}catch(error){state.textContent=error.message;state.className='error';state.hidden=false;content.hidden=true;}}run.addEventListener('change',refresh);lane.addEventListener('change',refresh);capital.addEventListener('change',refresh);stake.addEventListener('change',refresh);window.addEventListener('resize',drawChart);(async()=>{try{await loadRuns();await refresh()}catch(error){state.textContent=error.message;state.className='error';}})();
</script></body></html>`;
}
