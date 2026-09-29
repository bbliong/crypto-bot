import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const researchRoot = 'research';
const output = process.argv[2] || join(researchRoot, `mc-formula-optimization-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const minSamples = Number(process.env.MC_OPTIMIZER_MIN_SAMPLES ?? 8);
const maxSessions = Number(process.env.MC_OPTIMIZER_MAX_SESSIONS ?? 1_000);
if (!Number.isInteger(minSamples) || minSamples < 4) throw new Error('MC_OPTIMIZER_MIN_SAMPLES must be an integer >= 4');
if (!Number.isInteger(maxSessions) || maxSessions < minSamples) throw new Error('MC_OPTIMIZER_MAX_SESSIONS must be an integer >= MC_OPTIMIZER_MIN_SAMPLES');
mkdirSync(output, { recursive: true });

const historyPath = join(output, 'formula-history.jsonl');
// The first deployment may already have a current formula from before history
// logging existed. Preserve that baseline on the next optimizer pass, rather
// than making the historical menu start only with the replacement formula.
const previousActiveFormula = (() => {
  try { return JSON.parse(readFileSync(join(output, 'active-formula.json'), 'utf8')); }
  catch { return null; }
})();
if (!existsSync(historyPath) && previousActiveFormula?.version && previousActiveFormula?.formula) {
  appendFileSync(historyPath, JSON.stringify({
    ...previousActiveFormula,
    generatedAt: previousActiveFormula.version,
    bootstrap: true,
    note: 'Baseline formula captured when persistent history was enabled. Historical train/test metrics were not retained by the earlier run.',
  }) + '\n');
}

const rows = (dir, file) => {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
};
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const median = values => {
  const ordered = values.filter(finite).sort((a, b) => a - b);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const hash = value => [...String(value)].reduce((total, char) => ((total * 31) + char.charCodeAt(0)) >>> 0, 0);
const percent = value => finite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—';

function closestInitialTick(ticks, startedAt, seconds) {
  const target = startedAt + seconds * 1_000;
  return ticks.filter(tick => tick.observedAt <= target).at(-1) ?? ticks.find(tick => tick.observedAt > target) ?? null;
}
function featuresForSession(summary, allTicks, observationSeconds) {
  const ticks = allTicks.filter(tick => tick.observedAt >= summary.startedAt && tick.observedAt <= summary.endedAt)
    .sort((a, b) => a.observedAt - b.observedAt);
  const entry = ticks[0] ?? null;
  const decision = closestInitialTick(ticks, summary.startedAt, observationSeconds);
  if (!entry || !decision || !positive(entry.priceUsd) || !positive(decision.priceUsd)) return null;
  const beforeDecision = ticks.filter(tick => tick.observedAt <= decision.observedAt);
  const peakAtDecision = Math.max(...beforeDecision.map(tick => tick.priceUsd));
  const prior5 = beforeDecision.filter(tick => tick.observedAt <= decision.observedAt - 5_000).at(-1) ?? null;
  return {
    id: `${summary.sourceDir}:${summary.startedAt}:${summary.mint}`,
    symbol: summary.metadata?.symbol ?? summary.mint,
    mint: summary.mint,
    startedAt: summary.startedAt,
    entry,
    decision,
    after: ticks.filter(tick => tick.observedAt >= decision.observedAt),
    priceReturn30: (decision.priceUsd / entry.priceUsd - 1) * 100,
    return5s: prior5 && positive(prior5.priceUsd) ? (decision.priceUsd / prior5.priceUsd - 1) * 100 : null,
    drawdown30: (decision.priceUsd / peakAtDecision - 1) * 100,
    marketCap: summary.entryMarketCapUsd,
    top1Safe: summary.top1Safe === true,
    holderChange: summary.holderChange,
    coverageSeconds: (ticks.at(-1).observedAt - decision.observedAt) / 1_000,
  };
}

function simulateExit(row, formula) {
  const { entry, after } = row;
  const hardStop = entry.priceUsd * (1 - formula.hardStop / 100);
  const activateAt = entry.priceUsd * (1 + formula.activation / 100);
  const lockAt = entry.priceUsd * (1 + formula.lock / 100);
  let peak = entry.priceUsd, negatives = 0, lastWindowAt = -Infinity;
  for (const tick of after.slice(1)) {
    peak = Math.max(peak, tick.priceUsd);
    const result = (tick.priceUsd / entry.priceUsd - 1) * 100;
    if (peak < activateAt && tick.priceUsd <= hardStop) return { returnPercent: result, reason: `HARD_STOP_${formula.hardStop}`, heldSeconds: (tick.observedAt - entry.observedAt) / 1_000 };
    if (peak >= activateAt && tick.priceUsd <= Math.max(lockAt, peak * (1 - formula.trailing / 100))) return { returnPercent: result, reason: `LOCK_${formula.lock}_TRAIL_${formula.trailing}`, heldSeconds: (tick.observedAt - entry.observedAt) / 1_000 };
    if (formula.negativeWindows > 0 && tick.observedAt - lastWindowAt >= 4_500) {
      const prior = after.filter(item => item.observedAt <= tick.observedAt - 5_000).at(-1) ?? null;
      const change5 = prior ? (tick.priceUsd / prior.priceUsd - 1) * 100 : null;
      if (change5 !== null) {
        negatives = change5 < 0 ? negatives + 1 : 0;
        lastWindowAt = tick.observedAt;
        if (negatives >= formula.negativeWindows && tick.priceUsd > entry.priceUsd) return { returnPercent: result, reason: `NEGATIVE_5S_X${formula.negativeWindows}`, heldSeconds: (tick.observedAt - entry.observedAt) / 1_000 };
      }
    }
  }
  const last = after.at(-1);
  return { returnPercent: (last.priceUsd / entry.priceUsd - 1) * 100, reason: 'END_OF_CAPTURE', heldSeconds: (last.observedAt - entry.observedAt) / 1_000 };
}

function eligible(row, formula) {
  return row.coverageSeconds >= 8
    && row.priceReturn30 >= formula.entryReturn
    && row.return5s !== null && row.return5s >= formula.return5
    && row.drawdown30 >= formula.maxDrawdown
    && (formula.maxMarketCap === Infinity || (finite(row.marketCap) && row.marketCap <= formula.maxMarketCap))
    && (!formula.requireTop1Safe || row.top1Safe);
}
function summarize(rows, formula) {
  const trades = rows.map(row => ({ ...simulateExit(row, formula), row }));
  const returns = trades.map(trade => trade.returnPercent);
  const wins = returns.filter(value => value > 0).length;
  const losses = returns.filter(value => value < 0).length;
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
  const downside = returns.length ? returns.filter(value => value < 0).reduce((sum, value) => sum + value, 0) / returns.length : null;
  const worst = returns.length ? Math.min(...returns) : null;
  return { entries: trades.length, wins, losses, winRate: trades.length ? wins / trades.length * 100 : null, meanReturn: mean, medianReturn: median(returns), worstReturn: worst, downsideMean: downside, trades };
}

const studyDirs = readdirSync(researchRoot, { withFileTypes: true })
  .filter(item => item.isDirectory() && item.name.startsWith('pump-band-'))
  .map(item => join(researchRoot, item.name))
  .filter(dir => existsSync(join(dir, 'token-summary.jsonl')) && existsSync(join(dir, 'socket-ticks.jsonl')));
if (!studyDirs.length) throw new Error('No pump-band research dataset found');

const sessions = [];
for (const dir of studyDirs) {
  const manifest = existsSync(join(dir, 'manifest.json')) ? JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) : {};
  const observationSeconds = manifest.rules?.initialObservationSeconds ?? 30;
  const ticksByMint = new Map();
  for (const tick of rows(dir, 'socket-ticks.jsonl')) {
    if (!String(tick.source ?? '').startsWith('detail_socket_activity') || !positive(tick.priceUsd) || !finite(tick.observedAt)) continue;
    const list = ticksByMint.get(tick.mint) ?? []; list.push(tick); ticksByMint.set(tick.mint, list);
  }
  for (const list of ticksByMint.values()) list.sort((a, b) => a.observedAt - b.observedAt);
  for (const summary of rows(dir, 'token-summary.jsonl')) {
    if (!finite(summary.startedAt) || !finite(summary.endedAt)) continue;
    const row = featuresForSession({ ...summary, sourceDir: dir }, ticksByMint.get(summary.mint) ?? [], observationSeconds);
    if (row) sessions.push(row);
  }
}
// Retain data files indefinitely, but bound the optimizer cost.  Recent
// behavior is also the most relevant for a short-lived momentum strategy.
const totalSessionsAvailable = sessions.length;
sessions.sort((a, b) => b.startedAt - a.startedAt);
if (sessions.length > maxSessions) sessions.length = maxSessions;
sessions.sort((a, b) => a.startedAt - b.startedAt);

// Fixed split prevents the script from declaring a formula good merely
// because it fitted the exact sessions on which it was chosen.
const train = sessions.filter(row => hash(row.id) % 3 !== 0);
const test = sessions.filter(row => hash(row.id) % 3 === 0);
const formulas = [];
const formulaKeys = new Set();
let baseCandidateCount = 0, refinedCandidateCount = 0;
function addFormula(formula, stage) {
  const key = JSON.stringify(formula);
  if (formulaKeys.has(key)) return;
  formulaKeys.add(key);
  const trainStats = summarize(train.filter(row => eligible(row, formula)), formula);
  if (trainStats.entries < minSamples) return;
  // Decision score: reward positive expectancy and reliability, while
  // strongly penalising the mean downside and single catastrophic trades.
  const score = (trainStats.meanReturn ?? -999) * (trainStats.winRate ?? 0) / 100 + (trainStats.downsideMean ?? 0) * 1.5 + Math.max(trainStats.worstReturn ?? -100, -30) * 0.15;
  const testStats = summarize(test.filter(row => eligible(row, formula)), formula);
  formulas.push({ formula, stage, score, train: { ...trainStats, trades: undefined }, test: { ...testStats, trades: undefined } });
}
// Include +1% explicitly: it is a meaningful early-momentum threshold and
// must be compared on every full data pass, not only when local refinement
// happens to sample it around another candidate.
for (const entryReturn of [0, 1, 2, 5, 8]) for (const return5 of [0, 0.5, 1]) for (const maxDrawdown of [-5, -3, -1])
  for (const maxMarketCap of [80_000, 100_000, 150_000, 2_000_000]) for (const requireTop1Safe of [false, true])
    for (const hardStop of [2, 3, 4]) for (const activation of [4, 6, 8]) for (const lock of [0, 1, 2]) for (const trailing of [3, 5, 7]) for (const negativeWindows of [0, 2]) {
      const formula = { entryReturn, return5, maxDrawdown, maxMarketCap, requireTop1Safe, hardStop, activation, lock, trailing, negativeWindows };
      baseCandidateCount++; addFormula(formula, 'base');
    }
formulas.sort((a, b) => b.score - a.score);
// Stage two: sample a denser local neighbourhood around the 15 strongest
// base formulas. This gives more precision without exploding into millions
// of full-grid combinations every 30 minutes.
const clamp = (value, min, max, step) => Math.max(min, Math.min(max, Math.round(value / step) * step));
const caps = [60_000, 80_000, 100_000, 120_000, 150_000, 200_000, 300_000, 500_000, 2_000_000];
for (const [seedIndex, seed] of formulas.slice(0, 15).entries()) for (let attempt = 0; attempt < 200; attempt++) {
  let state = ((seedIndex + 1) * 1_103_515_245 + (attempt + 1) * 12_345) >>> 0;
  const jitter = (range, step) => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return (((state / 2 ** 32) * 2 - 1) * range) / step * step; };
  const f = seed.formula;
  const formula = {
    entryReturn: clamp(f.entryReturn + jitter(1.5, 0.25), 0, 12, 0.25),
    return5: clamp(f.return5 + jitter(0.75, 0.25), 0, 3, 0.25),
    maxDrawdown: clamp(f.maxDrawdown + jitter(2, 0.5), -10, 0, 0.5),
    maxMarketCap: caps[Math.min(caps.length - 1, Math.max(0, caps.indexOf(f.maxMarketCap) + Math.round(jitter(2, 1))))] ?? f.maxMarketCap,
    requireTop1Safe: attempt % 4 === 0 ? !f.requireTop1Safe : f.requireTop1Safe,
    hardStop: clamp(f.hardStop + jitter(1, 0.5), 1, 6, 0.5),
    activation: clamp(f.activation + jitter(2, 0.5), 2, 15, 0.5),
    lock: clamp(f.lock + jitter(1, 0.5), 0, 5, 0.5),
    trailing: clamp(f.trailing + jitter(2, 0.5), 2, 12, 0.5),
    negativeWindows: [0, 1, 2, 3][attempt % 4],
  };
  refinedCandidateCount++; addFormula(formula, 'refined');
}
formulas.sort((a, b) => b.score - a.score);
const requiredTestSamples = Math.max(4, Math.floor(minSamples / 2));
// A positive average alone is not sufficient. A formula with one near-total
// loss is rejected even when its mean and win rate look attractive.
const acceptable = formulas.filter(candidate => candidate.train.entries >= minSamples
  && candidate.test.entries >= requiredTestSamples
  && candidate.train.meanReturn > 0 && candidate.test.meanReturn > 0
  && candidate.train.winRate >= 55 && candidate.test.winRate >= 50
  && candidate.train.worstReturn >= -10 && candidate.test.worstReturn >= -10);
const selected = acceptable[0] ?? null;
const bestByTrain = formulas[0] ?? null;
const forwardCandidate = selected ?? bestByTrain;
const formulaKey = formula => JSON.stringify(formula ?? null);
const forwardResults = studyDirs.flatMap(dir => rows(dir, 'formula-live-results.jsonl').map(row => ({ ...row, sourceDir: dir })));
const candidateForward = forwardCandidate ? forwardResults.filter(row => row.entryAccepted === true && formulaKey(row.formula) === formulaKey(forwardCandidate.formula) && finite(row.returnPercent)) : [];
const forwardReturns = candidateForward.map(row => row.returnPercent);
const forwardValidation = { entries: candidateForward.length, wins: forwardReturns.filter(value => value > 0).length, losses: forwardReturns.filter(value => value < 0).length,
  meanReturn: forwardReturns.length ? forwardReturns.reduce((a, b) => a + b, 0) / forwardReturns.length : null,
  worstReturn: forwardReturns.length ? Math.min(...forwardReturns) : null,
  winRate: forwardReturns.length ? forwardReturns.filter(value => value > 0).length / forwardReturns.length * 100 : null };
const forwardValidated = Boolean(selected && forwardValidation.entries >= minSamples && forwardValidation.meanReturn !== null && forwardValidation.meanReturn > 0
  && forwardValidation.winRate !== null && forwardValidation.winRate >= 55 && forwardValidation.worstReturn !== null && forwardValidation.worstReturn >= -10);
const confidence = forwardValidated ? 'FORWARD_VALIDATED_EXPERIMENTAL' : formulas.length ? 'NO_SAFE_FORMULA_YET' : 'NO_FORMULA';
const result = {
  generatedAt: new Date().toISOString(),
  method: 'Offline socket-price replay only. The 30-second decision and all exit prices are observed socket prices, not GMGN route quotes or fills. Sessions with less than 8 seconds of price coverage after virtual entry are excluded.',
  datasets: studyDirs, sessionCount: sessions.length, totalSessionsAvailable, maxSessions, trainSessions: train.length, testSessions: test.length, minSamples,
  formulasTested: formulas.length, search: { baseCandidateCount, refinedCandidateCount, totalCandidateCount: baseCandidateCount + refinedCandidateCount, dataQualifiedFormulaCount: formulas.length }, confidence, safetyRequirements: { minimumTrainSamples: minSamples, minimumTestSamples: requiredTestSamples, minimumTrainWinRate: 55, minimumTestWinRate: 50, minimumForwardFormulaEntries: minSamples, maximumSingleLossPercent: -10 }, selected, bestByTrain, forwardCandidate, forwardValidation, topCandidates: formulas.slice(0, 25),
};
writeFileSync(join(output, 'formula-optimization.json'), JSON.stringify(result, null, 2));
// This is the only file a live observer may consume. Unsafe candidates never
// become active merely because they ranked well on the training split.
const activeFormula = forwardValidated && selected
  ? { status: 'VALIDATED', version: result.generatedAt, formula: selected.formula, validation: { train: selected.train, test: selected.test, forward: forwardValidation }, confidence }
  : forwardCandidate
    ? { status: 'TESTING', version: result.generatedAt, formula: forwardCandidate.formula, validation: { train: forwardCandidate.train, test: forwardCandidate.test, forward: forwardValidation }, confidence, reason: 'Candidate only. It is evaluated solely on new incoming tokens and can never submit an order.' }
    : { status: 'NO_ENTRY', version: result.generatedAt, confidence, reason: 'No candidate formula available.', bestCandidate: null };
writeFileSync(join(output, 'active-formula.json'), JSON.stringify(activeFormula, null, 2));
appendFileSync(historyPath, JSON.stringify({ ...activeFormula, generatedAt: result.generatedAt, search: result.search, dataset: { sessions: sessions.length, totalAvailable: totalSessionsAvailable, maxSessions, train: train.length, test: test.length }, optimizerConfidence: confidence }) + '\n');
const selectedText = selected ? `<pre>${JSON.stringify(selected.formula, null, 2)}</pre><p>Train: ${selected.train.entries} entry · ${percent(selected.train.meanReturn)} rata-rata · ${selected.train.winRate?.toFixed(1)}% win rate<br>Test terpisah: ${selected.test.entries} entry · ${percent(selected.test.meanReturn)} rata-rata · ${selected.test.winRate?.toFixed(1)}% win rate</p>` : `<p>Tidak ada formula aman yang lolos. Kandidat skor train tertinggi tetap ditampilkan di bawah sebagai diagnosis, tetapi tidak boleh digunakan sebagai strategi.</p>${bestByTrain ? `<pre>${JSON.stringify(bestByTrain.formula, null, 2)}</pre>` : ''}`;
const topRows = formulas.slice(0, 25).map((candidate, index) => `<tr><td>${index + 1}</td><td>${candidate.train.entries}</td><td>${percent(candidate.train.meanReturn)}</td><td>${candidate.train.winRate?.toFixed(1) ?? '—'}%</td><td>${candidate.test.entries}</td><td>${percent(candidate.test.meanReturn)}</td><td>${candidate.test.winRate?.toFixed(1) ?? '—'}%</td><td><code>${JSON.stringify(candidate.formula)}</code></td></tr>`).join('');
writeFileSync(join(output, 'formula-optimization.html'), `<!doctype html><meta charset="utf-8"><title>MC Formula Optimizer</title><style>body{background:#0b1220;color:#e8eef8;font:14px system-ui;margin:0}main{max-width:1500px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #263a58;padding:9px;text-align:left;vertical-align:top}code,pre{white-space:pre-wrap;color:#b9d5ff} .warn{color:#ffd37c}</style><main><h1>MC momentum formula optimizer</h1><p class="warn">Status: ${confidence}. Ini replay harga socket, bukan bukti profit eksekusi. Formula tidak boleh dipindahkan ke live buy sebelum diuji lagi dengan route quote.</p><p>Dataset optimizer: ${sessions.length} sesi terbaru dari ${totalSessionsAvailable} sesi tersimpan (batas ${maxSessions}); train ${train.length}, test ${test.length}; formula yang lolos minimum sampel: ${formulas.length}.</p><h2>Formula pilihan</h2>${selectedText}<h2>25 kandidat teratas berdasarkan train</h2><table><thead><tr><th>#</th><th>Train n</th><th>Train avg</th><th>Train win</th><th>Test n</th><th>Test avg</th><th>Test win</th><th>Rules</th></tr></thead><tbody>${topRows || '<tr><td colspan="8">Tidak ada formula.</td></tr>'}</tbody></table></main>`);
console.log(JSON.stringify({ output, sessionCount: sessions.length, formulasTested: formulas.length, confidence, selected: selected ? { formula: selected.formula, train: selected.train, test: selected.test } : null }, null, 2));
