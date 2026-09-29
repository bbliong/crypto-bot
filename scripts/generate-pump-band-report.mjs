import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
const jsonFile = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const jsonLinesFile = path => existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
const formulaLiveStatus = jsonFile(join(dir, 'formula-live-status.json'));
const formulaLiveResults = lines('formula-live-results.jsonl');
const formulaHistory = typeof manifest.activeFormulaPath === 'string' ? jsonLinesFile(join(dirname(manifest.activeFormulaPath), 'formula-history.jsonl')) : [];
const observationSeconds = manifest.rules?.initialObservationSeconds ?? manifest.rules?.observationSeconds ?? 60;
const maximumObservationSeconds = manifest.rules?.maximumObservationSeconds ?? observationSeconds;
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
const timestamp = value => number(value) !== null ? value : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const time = value => timestamp(value) !== null
  ? new Date(timestamp(value)).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' WIB'
  : '—';
const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function formulaForSession(snapshot) {
  // Older captures predate active-formula.json and retain the previous
  // survivor simulation. New captures must explicitly be ACTIVE.
  if (!snapshot) return { entryReturn: 0, return5: 0, maxDrawdown: -5, hardStop: 3, activation: 6, lock: 1, trailing: 5, negativeWindows: 2, legacy: true };
  if (snapshot.status !== 'VALIDATED' && snapshot.status !== 'TESTING' || !snapshot.formula || typeof snapshot.formula !== 'object') return null;
  const f = snapshot.formula;
  const keys = ['entryReturn', 'return5', 'maxDrawdown', 'hardStop', 'activation', 'lock', 'trailing', 'negativeWindows'];
  if (!keys.every(key => number(f[key]) !== null)) return null;
  return { ...f, legacy: false };
}
function virtualTradeAfterInitialObservation(ticks, entryPriceUsd, decisionTick, formula, session) {
  if (!formula) return { eligible: false, reason: 'NO_ENTRY: belum ada formula aman' };
  if (!positive(entryPriceUsd) || !decisionTick || !positive(decisionTick.priceUsd)) return { eligible: false, reason: 'Harga 30 dtk belum tersedia' };
  if (number(formula.maxMarketCap) !== null && number(session?.entryMarketCapUsd) !== null && session.entryMarketCapUsd > formula.maxMarketCap) {
    return { eligible: false, reason: `ENTRY_RULE_NOT_MET: MC awal di atas batas $${f(formula.maxMarketCap)}` };
  }
  if (formula.requireTop1Safe && session?.top1Safe !== true) {
    return { eligible: false, reason: 'ENTRY_RULE_NOT_MET: distribusi Top-1 tidak aman' };
  }
  const decisionIndex = ticks.indexOf(decisionTick);
  const beforeDecision = ticks.slice(0, decisionIndex + 1);
  const anchor5s = beforeDecision.filter(tick => tick.observedAt <= decisionTick.observedAt - 5_000).at(-1);
  const returnFromStart = (decisionTick.priceUsd / entryPriceUsd - 1) * 100;
  const return5s = anchor5s && positive(anchor5s.priceUsd) ? (decisionTick.priceUsd / anchor5s.priceUsd - 1) * 100 : null;
  const peakAtDecision = Math.max(...beforeDecision.map(tick => tick.priceUsd));
  const drawdownAtDecision = (decisionTick.priceUsd / peakAtDecision - 1) * 100;
  // This is deliberately the same survivor gate used by the observation
  // extension: a virtual entry exists only after the token has held its rise.
  if (!(returnFromStart >= formula.entryReturn && return5s !== null && return5s >= formula.return5 && drawdownAtDecision >= formula.maxDrawdown)) {
    return { eligible: false, reason: 'Tidak lolos formula entry 30 dtk', returnFromStart, return5s, drawdownAtDecision };
  }
  const hardStopPrice = decisionTick.priceUsd * (1 - formula.hardStop / 100);
  const profitActivationPrice = decisionTick.priceUsd * (1 + formula.activation / 100);
  const lockedProfitPrice = decisionTick.priceUsd * (1 + formula.lock / 100);
  let peak = decisionTick.priceUsd, negativeWindows = 0, lastWindowAt = -Infinity;
  for (const tick of ticks.slice(decisionIndex + 1)) {
    peak = Math.max(peak, tick.priceUsd);
    const drawdown = (tick.priceUsd / peak - 1) * 100;
    // Before the trade has earned enough to lock a profit, accept only a
    // small, explicit loss. A 5% trail from a shallow peak would otherwise
    // sell below entry almost by design.
    if (peak < profitActivationPrice && tick.priceUsd <= hardStopPrice) {
      return { eligible: true, entryPriceUsd: decisionTick.priceUsd, entryAt: decisionTick.observedAt, sellPriceUsd: tick.priceUsd, sellAt: tick.observedAt, sellReason: `HARD_STOP_${formula.hardStop}_PERSEN`, returnPercent: (tick.priceUsd / decisionTick.priceUsd - 1) * 100, drawdown };
    }
    // Once peak profit reached +6%, the exit threshold can never fall below
    // +1% from entry, even if the trailing calculation is lower.
    if (peak >= profitActivationPrice && tick.priceUsd <= Math.max(lockedProfitPrice, peak * (1 - formula.trailing / 100))) {
      return { eligible: true, entryPriceUsd: decisionTick.priceUsd, entryAt: decisionTick.observedAt, sellPriceUsd: tick.priceUsd, sellAt: tick.observedAt, sellReason: `PROFIT_LOCK_${formula.lock}_ATAU_TRAILING_${formula.trailing}`, returnPercent: (tick.priceUsd / decisionTick.priceUsd - 1) * 100, drawdown };
    }
    // Count one 5-second momentum result per roughly five-second window, so
    // many socket frames from one burst cannot falsely form two confirmations.
    if (tick.observedAt - lastWindowAt >= 4_500) {
      const prior = ticks.filter(row => row.observedAt <= tick.observedAt - 5_000).at(-1);
      const return5 = prior && positive(prior.priceUsd) ? (tick.priceUsd / prior.priceUsd - 1) * 100 : null;
      if (return5 !== null) {
        negativeWindows = return5 < 0 ? negativeWindows + 1 : 0;
        lastWindowAt = tick.observedAt;
        if (formula.negativeWindows > 0 && negativeWindows >= formula.negativeWindows && tick.priceUsd > decisionTick.priceUsd) return { eligible: true, entryPriceUsd: decisionTick.priceUsd, entryAt: decisionTick.observedAt, sellPriceUsd: tick.priceUsd, sellAt: tick.observedAt, sellReason: `MOMENTUM_5DTK_NEGATIF_${formula.negativeWindows}X_DI_ATAS_BUY`, returnPercent: (tick.priceUsd / decisionTick.priceUsd - 1) * 100, drawdown };
      }
    }
  }
  return { eligible: true, entryPriceUsd: decisionTick.priceUsd, entryAt: decisionTick.observedAt, sellPriceUsd: null, sellAt: null, sellReason: 'BELUM_ADA_SINYAL_SELL', returnPercent: null, drawdown: (ticks.at(-1)?.priceUsd ?? decisionTick.priceUsd) / peak * 100 - 100 };
}

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
  // A session can be extended after the initial observation. Preserve the
  // price available at the initial decision point, rather than showing only
  // its eventual final price. Prefer the last socket trade at/before 30s;
  // when no trade arrived before that boundary, use the first one after it.
  const initialDecisionAt = typeof s.startedAt === 'number' ? s.startedAt + observationSeconds * 1_000 : null;
  const atOrBeforeInitialDecision = initialDecisionAt === null ? [] : eligibleTicks.filter(tick => tick.observedAt <= initialDecisionAt);
  const initialDecisionTick = atOrBeforeInitialDecision.at(-1)
    ?? (initialDecisionAt === null ? null : eligibleTicks.find(tick => tick.observedAt > initialDecisionAt) ?? null);
  const priceAtInitialObservationUsd = initialDecisionTick?.priceUsd ?? null;
  const priceAtInitialObservationAt = initialDecisionTick?.observedAt ?? null;
  const initialObservationReturnPercent = positive(entryPriceUsd) && positive(priceAtInitialObservationUsd)
    ? (priceAtInitialObservationUsd / entryPriceUsd - 1) * 100 : null;
  const sessionFormula = formulaForSession(s.activeFormula);
  const virtualTrade = virtualTradeAfterInitialObservation(eligibleTicks, entryPriceUsd, initialDecisionTick, sessionFormula, s);
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
    initialDecisionAt, priceAtInitialObservationUsd, priceAtInitialObservationAt, initialObservationReturnPercent,
    activeFormula: s.activeFormula ?? { status: 'LEGACY_NO_FORMULA_FILE', version: null }, sessionFormula, virtualTrade,
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
const currentFormula = formulaLiveStatus?.currentFormula ?? null;
const formulaEntries = formulaLiveResults.filter(row => row.entryAccepted === true && number(row.returnPercent) !== null);
const formulaWins = formulaEntries.filter(row => row.returnPercent > 0), formulaLosses = formulaEntries.filter(row => row.returnPercent < 0);
const formulaAverageReturn = formulaEntries.length ? formulaEntries.reduce((sum, row) => sum + row.returnPercent, 0) / formulaEntries.length : null;
const formulaText = currentFormula?.formula && typeof currentFormula.formula === 'object'
  ? currentFormula.formula : null;
const ruleText = formulaText ? `Entry 30 dtk ≥${f(formulaText.entryReturn)}% · 5 dtk ≥${f(formulaText.return5)}% · drawdown ≥${f(formulaText.maxDrawdown)}% · hard stop -${f(formulaText.hardStop)}% · aktif profit +${f(formulaText.activation)}% · lock +${f(formulaText.lock)}% · trailing ${f(formulaText.trailing)}%`
  : 'Belum ada formula yang sedang diuji.';
const currentSessions = Array.isArray(formulaLiveStatus?.activeSessions) ? formulaLiveStatus.activeSessions : [];
const currentSessionRows = currentSessions.map(row => `<tr><td>${esc(row.mint)}</td><td>Worker ${esc(row.worker)}</td><td>${f(row.elapsedSeconds)} dtk</td><td>${signedPercent(row.priceReturnPercent)}</td><td>${esc(row.formula?.status ?? '—')}<div class="mono">${esc(row.formula?.version ?? '—')}</div></td></tr>`).join('');
const sessionByFormulaKey = new Map(sessions.map(session => [`${session.mint}:${session.startedAt}`, session]));
const formulaResultRows = formulaLiveResults.slice().reverse().slice(0, 100).map(result => {
  const session = sessionByFormulaKey.get(`${result.mint}:${result.sessionStartedAt}`);
  const token = session?.metadata?.symbol ?? result.mint;
  const outcome = result.entryAccepted ? '<span class="profit">LOLOS BUY VIRTUAL</span>' : '<span class="muted">DITOLAK</span>';
  const reason = result.entryAccepted ? result.exitReason : result.reason;
  const resultClass = number(result.returnPercent) === null ? '' : result.returnPercent >= 0 ? 'profit' : 'loss';
  return `<tr><td><b>${esc(token)}</b><div class="mono">${esc(result.mint)}</div></td><td>${time(result.sessionStartedAt)}</td><td>${esc(result.formulaStatus)}<div class="mono">${esc(result.formulaVersion ?? '—')}</div></td><td>${outcome}</td><td>${esc(reason ?? '—')}</td><td class="${resultClass}">${signedPercent(result.returnPercent)}</td></tr>`;
}).join('');
// A history record is immutable: at the moment an optimizer selects a
// formula, no post-selection session may have finished yet.  Keep that
// snapshot, but compute a separate rolling forward result from the sessions
// that actually started with this exact formula version.
const forwardLatestByVersion = new Map();
for (const result of formulaLiveResults) {
  if (!result.formulaVersion) continue;
  const item = forwardLatestByVersion.get(result.formulaVersion) ?? { candidates: 0, entrySignals: 0, entries: 0, wins: 0, losses: 0, returns: [] };
  item.candidates++;
  if (result.entryAccepted === true) item.entrySignals++;
  if (result.entryAccepted === true && number(result.returnPercent) !== null) {
    item.entries++;
    item.returns.push(result.returnPercent);
    if (result.returnPercent > 0) item.wins++;
    if (result.returnPercent < 0) item.losses++;
  }
  forwardLatestByVersion.set(result.formulaVersion, item);
}
const summarizeForwardLatest = item => {
  if (!item) return { candidates: 0, entrySignals: 0, entries: 0, wins: 0, losses: 0, meanReturn: null, winRate: null, worstReturn: null };
  const returns = item.returns ?? [];
  return { ...item, meanReturn: returns.length ? returns.reduce((total, value) => total + value, 0) / returns.length : null,
    winRate: returns.length ? item.wins / returns.length * 100 : null, worstReturn: returns.length ? Math.min(...returns) : null };
};
const formulaHistoryRows = formulaHistory.slice().reverse().slice(0, 30).map(item => {
  const formula = item.formula ?? {};
  const validation = item.validation?.forward ?? {};
  const latest = summarizeForwardLatest(forwardLatestByVersion.get(item.version));
  return `<tr><td>${time(item.generatedAt ?? item.version)}</td><td>${esc(item.status)}</td><td class="mono">Entry ≥${f(formula.entryReturn)}% · 5d ≥${f(formula.return5)}% · DD ≥${f(formula.maxDrawdown)}% · stop -${f(formula.hardStop)}% · trail ${f(formula.trailing)}%</td><td>${latest.candidates} kandidat · ${latest.entrySignals} lolos · ${latest.entries} selesai · ${signedPercent(latest.meanReturn)} · ${f(latest.winRate)}% win</td><td>${f(validation.entries)} entry · ${signedPercent(validation.meanReturn)} · ${f(validation.winRate)}% win</td></tr>`;
}).join('');
// Each optimizer pass is append-only.  Keep the complete snapshot (rather
// than only the short table fields) so an older version can be inspected in
// the browser even after active-formula.json has moved on to a newer version.
const formulaHistoryPicker = formulaHistory.slice().reverse().map(item => ({
  version: item.version ?? item.generatedAt ?? null,
  generatedAt: item.generatedAt ?? item.version ?? null,
  status: item.status ?? '—',
  formula: item.formula ?? {},
  validation: item.validation ?? {},
  forwardLatest: summarizeForwardLatest(forwardLatestByVersion.get(item.version)),
  confidence: item.confidence ?? item.optimizerConfidence ?? '—',
}));
const formulaHistoryPickerJson = JSON.stringify(formulaHistoryPicker).replace(/</g, '\\u003c');
const formulaHistoryOptions = formulaHistoryPicker.map((item, index) => `<option value="${index}">${esc(time(item.generatedAt))} · ${esc(item.status)} · ${esc(item.version)}</option>`).join('');
const formulaPanel = `<section><h2>Simulasi formula realtime</h2><div class="stats"><div class="stat">Status formula<div class="n">${esc(currentFormula?.status ?? '—')}</div></div><div class="stat">Token baru dievaluasi<div class="n">${formulaLiveResults.length}</div></div><div class="stat">Lolos entry virtual<div class="n">${formulaEntries.length}</div></div><div class="stat">Hasil formula<div class="n">${formulaWins.length} W / ${formulaLosses.length} L</div><div>${signedPercent(formulaAverageReturn)} rata-rata</div></div></div><p class="note"><b>Versi:</b> ${esc(currentFormula?.version ?? '—')}<br><b>Rules:</b> ${esc(ruleText)}<br>Hasil di atas hanya memakai token baru yang masuk setelah versi formula diterbitkan; tidak menghitung ulang token lama.</p><h3>Token yang sedang diuji</h3><div class="scroll"><table><thead><tr><th>Mint</th><th>Worker</th><th>Durasi</th><th>Return harga sementara</th><th>Formula saat mulai</th></tr></thead><tbody>${currentSessionRows || '<tr><td colspan="5" class="muted">Tidak ada token pada tab detail saat ini.</td></tr>'}</tbody></table></div><h3>Hasil formula pada token baru</h3><div class="scroll"><table><thead><tr><th>Token / mint</th><th>Mulai detail</th><th>Versi formula</th><th>Keputusan entry</th><th>Alasan / exit</th><th>Return virtual</th></tr></thead><tbody>${formulaResultRows || '<tr><td colspan="6" class="muted">Belum ada sesi formula yang selesai.</td></tr>'}</tbody></table></div><h3>Riwayat formula tiap 30 menit</h3><p class="note"><b>Penting:</b> “8 entry train” bukan berarti hanya 8 token yang dibaca. Semua sesi data dibaca; angka entry hanya token yang lolos aturan buy virtual. “Forward terbaru” diperbarui dari token yang masuk setelah versi tersebut diterbitkan. “Snapshot saat dibuat” wajar masih nol pada formula baru.</p><label class="formula-picker-label">Pilih formula: <select id="formula-history-picker"><option value="">— pilih versi —</option>${formulaHistoryOptions}</select></label><div id="formula-history-detail" class="formula-history-detail muted">${formulaHistoryPicker.length ? 'Pilih salah satu versi formula di atas.' : 'Riwayat mulai tersedia setelah optimizer menulis putaran berikutnya.'}</div><div class="scroll"><table><thead><tr><th>Dibuat</th><th>Status</th><th>Parameter ringkas</th><th>Forward terbaru</th><th>Snapshot saat dibuat</th></tr></thead><tbody>${formulaHistoryRows || '<tr><td colspan="5" class="muted">Riwayat belum tersedia.</td></tr>'}</tbody></table></div></section><script id="formula-history-data" type="application/json">${formulaHistoryPickerJson}</script>`;

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
  const token = esc(s.metadata?.symbol ?? s.mint);
  const shortMint = esc(String(s.mint).length > 14 ? `${String(s.mint).slice(0, 7)}…${String(s.mint).slice(-5)}` : s.mint);
  const initialObservationPrice = sim?.priceAtInitialObservationUsd === null || sim?.priceAtInitialObservationUsd === undefined
    ? '—'
    : `${price(sim.priceAtInitialObservationUsd)}<div class="mono">${time(sim.priceAtInitialObservationAt)} · ${signedPercent(sim.initialObservationReturnPercent)} vs awal</div>`;
  const buyVirtual = sim?.virtualTrade?.eligible
    ? `<span class="profit">BUY VIRTUAL</span><div>${price(sim.virtualTrade.entryPriceUsd)}</div><div class="mono">${time(sim.virtualTrade.entryAt)} · ${signedPercent((sim.virtualTrade.entryPriceUsd / sim.buyPriceUsd - 1) * 100)} vs awal</div>`
    : `<span class="muted">TIDAK BUY</span><div>${initialObservationPrice}</div><div class="mono">${esc(sim?.virtualTrade?.reason ?? '—')}</div>`;
  const sellSignal = !sim?.virtualTrade?.eligible ? `<span class="muted">—<div class="mono">${esc(sim?.virtualTrade?.reason ?? '—')}</div></span>`
    : sim.virtualTrade.sellPriceUsd === null ? `<span class="profit">Belum sell</span><div class="mono">${esc(sim.virtualTrade.sellReason)}</div>`
      : `${price(sim.virtualTrade.sellPriceUsd)}<div class="mono">${time(sim.virtualTrade.sellAt)} · ${esc(sim.virtualTrade.sellReason)}</div>`;
  const sellReturn = sim?.virtualTrade?.eligible && sim.virtualTrade.returnPercent !== null && sim.virtualTrade.returnPercent !== undefined
    ? `<span class="${sim.virtualTrade.returnPercent >= 0 ? 'profit' : 'loss'}">${signedPercent(sim.virtualTrade.returnPercent)}</span>` : '—';
  const snapshot = s.activeFormula;
  const formulaText = !snapshot ? '<span class="muted">Legacy</span>'
    : snapshot.status === 'TESTING' ? `<span class="profit">TESTING</span><div class="mono">${esc(snapshot.version ?? '—')}</div>`
      : snapshot.status === 'VALIDATED' ? `<span class="profit">VALIDATED</span><div class="mono">${esc(snapshot.version ?? '—')}</div>`
        : `<span class="muted">${esc(snapshot.status ?? 'NO_ENTRY')}</span><div class="mono">${esc(snapshot.version ?? '—')}</div>`;
  return `<tr><td><b>${token}</b><div class="mono">${shortMint}</div></td><td>${time(s.startedAt)}</td><td>${formulaText}</td><td>$${f(s.entryMarketCapUsd)}</td><td>$${f(s.finalMarketCapUsd)}</td><td>${signedPercent(s.entryToFinalPercent)}</td><td>${price(sim?.buyPriceUsd)}</td><td>${buyVirtual}</td><td>${sellSignal}</td><td>${sellReturn}</td><td>${price(sim?.sellPriceUsd)}</td><td>${signedPercent(sim?.returnPercent)}</td><td>${signedPercent(sim?.drawdownFromPeakPercent)}</td><td>${f(s.holderCountStart)} → ${f(s.holderCountEnd)}</td><td>${s.top1Safe === true ? '≤50% ✓' : s.top1Safe === false ? '>50% ✗' : '—'}</td><td>${esc(s.behavior ?? '—')}</td><td>${esc(s.endedBecause)}</td></tr>`;
}).join('');
const dumps = sessions.filter(s => String(s.endedBecause).startsWith('DUMP')).length;
const reached = sessions.filter(s => s.milestonesMs?.['10000'] !== null && s.milestonesMs?.['10000'] !== undefined).length;

const html = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Riset MC Momentum $${f(minMarketCap)}–$${f(maxMarketCap)}</title><style>body{margin:0;background:#0b1220;color:#e8eef8;font:14px system-ui}main{width:100%;box-sizing:border-box;margin:auto;padding:16px 20px}section{background:#121e31;border:1px solid #20324d;border-radius:12px;padding:16px;margin:14px 0}.stats{display:flex;gap:10px;flex-wrap:wrap}.stat{background:#172945;border-radius:8px;padding:10px;min-width:145px}.n{font-size:24px;font-weight:700}table{border-collapse:collapse;width:100%;min-width:1920px}th,td{padding:8px;border-bottom:1px solid #263a58;text-align:left;white-space:nowrap;vertical-align:top}th{color:#9dc1f5}.sort{cursor:pointer;user-select:none}.sort:hover{color:#fff}.sort::after{content:' ↕';color:#6882a2;font-size:12px}.sort.asc::after{content:' ↑';color:#76d6ac}.sort.desc::after{content:' ↓';color:#ffb5a7}.scroll{overflow:auto}.mono{font:11px ui-monospace,monospace;color:#a9b9cf;margin-top:2px}.note,.muted{color:#b5c4d8}.profit{color:#62dba0;font-weight:700}.loss{color:#ff9292;font-weight:700}a{color:#9dc1f5}h1,h2{margin-top:0}.formula-picker-label{display:block;margin:8px 0;font-weight:600}.formula-picker-label select{margin-left:8px;max-width:min(100%,620px);padding:7px;background:#172945;color:#e8eef8;border:1px solid #42648f;border-radius:6px}.formula-history-detail{margin:10px 0;padding:12px;background:#0f1929;border:1px solid #294362;border-radius:8px;line-height:1.55}.formula-history-detail dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}.formula-history-detail dt{color:#9dc1f5}.formula-history-detail dd{margin:0;white-space:pre-wrap;word-break:break-word}</style><main><h1>Riset perilaku MC momentum $${f(minMarketCap)}–$${f(maxMarketCap)}</h1><p>Refresh otomatis 10 detik. Setiap formula dicatat saat sesi token <em>dimulai</em> dan hanya diuji terhadap tick harga token tersebut yang datang sesudahnya. <b>TESTING</b> berarti kandidat paper baru; <b>VALIDATED</b> berarti kandidat sudah lulus data lama dan sampel paper forward. Tidak ada order nyata.</p><section><h2>Data riset per sesi</h2><div class="stats"><div class="stat">Sesi selesai<div class="n">${sessions.length}</div></div><div class="stat">Mencapai $${f(maxMarketCap)} menurut feed MCap<div class="n">${reached}</div></div><div class="stat">Dump dari puncak harga<div class="n">${dumps}</div></div></div><div class="scroll"><table id="behavior-table"><thead><tr><th class="sort">Token / mint</th><th class="sort">Mulai detail</th><th class="sort">Formula live</th><th class="sort">MC awal</th><th class="sort">MC akhir</th><th class="sort">MC return</th><th class="sort">Harga awal</th><th class="sort">Keputusan BUY virtual (30 dtk)</th><th class="sort">Sell virtual</th><th class="sort">P/L sell virtual</th><th class="sort">Harga akhir</th><th class="sort">Harga return akhir</th><th class="sort">Turun dari puncak</th><th class="sort">Holder</th><th class="sort">Top-1 ≤50%</th><th class="sort">Perilaku</th><th class="sort">Status akhir</th></tr></thead><tbody>${researchRows || '<tr><td colspan="17">Belum ada sesi selesai.</td></tr>'}</tbody></table></div></section></main><script>const table=document.querySelector('#behavior-table');if(table){let active=-1,ascending=true;for(const header of table.tHead.rows[0].cells)header.addEventListener('click',()=>{const column=header.cellIndex;ascending=active===column?!ascending:true;active=column;for(const h of table.tHead.rows[0].cells)h.classList.remove('asc','desc');header.classList.add(ascending?'asc':'desc');const rows=[...table.tBodies[0].rows].filter(row=>row.cells.length===table.tHead.rows[0].cells.length);rows.sort((a,b)=>{const av=a.cells[column].innerText.trim(),bv=b.cells[column].innerText.trim();const num=v=>Number(v.replace(/[^0-9.+-]/g,''));const an=num(av),bn=num(bv);const result=Number.isFinite(an)&&Number.isFinite(bn)&&av.match(/[0-9]/)&&bv.match(/[0-9]/)?an-bn:av.localeCompare(bv,'id');return ascending?result:-result});rows.forEach(row=>table.tBodies[0].append(row))})}</script></html>`;
const persistentSortScript = `<script>(()=>{const table=document.querySelector('#behavior-table');if(!table)return;const key='mc-momentum-sort';const headers=[...table.tHead.rows[0].cells];const sort=(column,ascending)=>{const rows=[...table.tBodies[0].rows].filter(row=>row.cells.length===headers.length);rows.sort((a,b)=>{const av=a.cells[column].innerText.trim(),bv=b.cells[column].innerText.trim();const an=Number(av.replace(/[^0-9.+-]/g,'')),bn=Number(bv.replace(/[^0-9.+-]/g,''));const result=Number.isFinite(an)&&Number.isFinite(bn)&&/[0-9]/.test(av)&&/[0-9]/.test(bv)?an-bn:av.localeCompare(bv,'id');return ascending?result:-result});rows.forEach(row=>table.tBodies[0].append(row));headers.forEach(header=>header.classList.remove('asc','desc'));headers[column]?.classList.add(ascending?'asc':'desc')};let saved=null;try{saved=JSON.parse(sessionStorage.getItem(key)||'null')}catch{}if(saved&&Number.isInteger(saved.column)&&headers[saved.column])sort(saved.column,Boolean(saved.ascending));table.tHead.addEventListener('click',event=>{const header=event.target.closest('th');if(!header)return;const column=header.cellIndex;const next={column,ascending:!(saved&&saved.column===column&&saved.ascending)};saved=next;sessionStorage.setItem(key,JSON.stringify(next));setTimeout(()=>sort(next.column,next.ascending),0)},true)})()</script>`;
const formulaHistoryPickerScript = `<script>(()=>{const picker=document.querySelector('#formula-history-picker'),detail=document.querySelector('#formula-history-detail'),dataNode=document.querySelector('#formula-history-data');if(!picker||!detail||!dataNode)return;let items=[];try{items=JSON.parse(dataNode.textContent||'[]')}catch{}const key='mc-momentum-formula-history-version';const metric=(label,row)=>{if(!row||typeof row!=='object')return '—';const n=row.entries??'—',mean=typeof row.meanReturn==='number'?((row.meanReturn>=0?'+':'')+row.meanReturn.toFixed(2)+'%'):'—',win=typeof row.winRate==='number'?row.winRate.toFixed(1)+'%':'—',worst=typeof row.worstReturn==='number'?((row.worstReturn>=0?'+':'')+row.worstReturn.toFixed(2)+'%'):'—';return label+': '+n+' entry · avg '+mean+' · win '+win+' · worst '+worst};const render=()=>{const item=items[Number(picker.value)];if(!item){detail.textContent='Pilih salah satu versi formula di atas.';return}const f=item.formula||{},v=item.validation||{};detail.replaceChildren();const dl=document.createElement('dl');const fields=[['Versi',item.version||'—'],['Dibuat',item.generatedAt?new Date(item.generatedAt).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',hour12:false})+' WIB':'—'],['Status',item.status||'—'],['Kepercayaan',item.confidence||'—'],['Entry','return 30 dtk ≥'+(f.entryReturn??'—')+'% · return 5 dtk ≥'+(f.return5??'—')+'% · drawdown ≥'+(f.maxDrawdown??'—')+'% · Top-1 aman: '+(f.requireTop1Safe?'ya':'tidak')],['Exit','hard stop -'+(f.hardStop??'—')+'% · profit aktif +'+(f.activation??'—')+'% · lock +'+(f.lock??'—')+'% · trailing '+(f.trailing??'—')+'% · jendela negatif '+(f.negativeWindows??'—')+'x'],['Hasil train',metric('',v.train).replace(/^: /,'')],['Hasil test terpisah',metric('',v.test).replace(/^: /,'')],['Hasil forward saat dibuat',metric('',v.forward).replace(/^: /,'')]];for(const [name,value] of fields){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=name;dd.textContent=value;dl.append(dt,dd)}detail.append(dl)};picker.addEventListener('change',()=>{try{localStorage.setItem(key,items[Number(picker.value)]?.version||'')}catch{}render()});let saved='';try{saved=localStorage.getItem(key)||''}catch{}const matching=[...picker.options].find(option=>items[Number(option.value)]?.version===saved);if(matching)picker.value=matching.value;else if(items.length)picker.value='0';render()})()</script>`;
const staticHtml = html.replace('<meta http-equiv="refresh" content="10">', '').replace('Refresh otomatis 10 detik. ', '');
const htmlWithFormulaPanel = staticHtml.replace('<section><h2>Data riset per sesi</h2>', `${formulaPanel}<section><h2>Data riset per sesi</h2>`);
const htmlWithPersistentSort = htmlWithFormulaPanel.replace('</script></html>', `</script>${persistentSortScript}${formulaHistoryPickerScript}</html>`);
writeFileSync(join(dir, 'pump-band-simulation.json'), JSON.stringify({ method: 'hypothetical buy at first observed pu, exit at session end valued using last observed pu at or before exit signal', stakeUsdc, maximumExitPriceAgeMs, stats, trades: simulated }, null, 2));
writeFileSync(join(dir, 'pump-band-report.html'), htmlWithPersistentSort);
