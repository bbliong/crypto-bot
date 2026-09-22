import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { MOMENTUM_RULES, assessMomentumEntry, assessMomentumExit, createMomentumPosition, type TapeTrade, type HolderSample, type OwnerSample } from '../src/momentum-strategy.js';
const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error('Provide one or more research folders');
const read = (d: string, f: string): any[] => existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
const results: any[] = [];
for (const input of dirs) {
  const d = resolve(input), sim = read(d, 'simulated-trades.jsonl'), events = read(d, 'events.jsonl');
  const trades = read(d, 'trades.jsonl'), stats = read(d, 'token-stat.jsonl'), owners = read(d, 'tracked-holders.jsonl');
  const starts = read(d, 'screened-tokens.jsonl');
  for (const b of sim.filter(r => r.type === 'SIMULATED_BUY')) {
    const old = sim.find(r => r.type === 'SIMULATED_SELL' && r.mint === b.mint);
    const tape: TapeTrade[] = trades.filter(t => t.mint === b.mint).map(t => ({ id: t.signature ?? String(t.raw?.id ?? t.raw?.si ?? `${t.mint}:${t.occurredAt}:${t.wallet}:${t.side}:${t.priceUsd}:${t.raw?.ba}`),
      observedAt: t.observedAt, occurredAt: t.occurredAt, priceUsd: t.priceUsd, side: t.side, wallet: t.wallet, usd: t.amountUsd ?? t.amount ?? null,
      tokens: t.raw?.ba == null ? null : Number(t.raw.ba) })).sort((a, b) => a.observedAt - b.observedAt);
    const hs: HolderSample[] = stats.filter(s => s.mint === b.mint && s.status === 200 && typeof s.holderCount === 'number').map(s => ({ observedAt: s.observedAt, count: s.holderCount }));
    const os: OwnerSample[] = owners.filter(s => s.mint === b.mint && s.status === 200).flatMap(s => (s.holders ?? []).filter((h: any) => h.raw?.addr_type !== 2 && !h.raw?.exchange && !h.walletTagV2?.toLowerCase().includes('lp')).map((h: any) => ({
      observedAt: s.observedAt, wallet: h.wallet, balance: h.amount, percent: h.raw?.amount_percentage == null ? null : Number(h.raw.amount_percentage) * 100, isDev: h.isDev })));
    const created = starts.find(s => s.mint === b.mint)?.fields?.createdAt?.value;
    const early = ['SINGLE_CANDLE_ONLY', 'INSUFFICIENT_CANDLES'].includes(b.entryGate?.candleHistory?.reason) || (typeof created === 'number' && b.observedAt - created <= 120_000);
    const entryAudit = assessMomentumEntry(tape, hs, b.observedAt, early);
    const p = createMomentumPosition(b.observedAt, b.entryPriceUsd, tape.filter(t => t.observedAt <= b.observedAt).at(-1)?.occurredAt ?? b.observedAt);
    const cutoff = old?.observedAt ?? tape.at(-1)?.observedAt ?? b.observedAt;
    const available: TapeTrade[] = [];
    let exit: ReturnType<typeof assessMomentumExit> = null;
    for (const tick of tape) {
      if (tick.observedAt > cutoff) break;
      available.push(tick);
      if (tick.observedAt <= b.observedAt) continue;
      const next = assessMomentumExit(p, tick, available, hs, os);
      if (next?.reason) { exit = next; break; }
    }
    const skips = events.find(e => e.mint === b.mint && e.type === 'BUY_BUTTON_CLICK_SKIPPED');
    results.push({ run: basename(d), token: b.metadata?.symbol ?? b.mint, mint: b.mint, stake: b.stakeUsd,
      entryAt: b.observedAt, oldExitAt: old?.observedAt ?? null, oldPnlUsd: old?.pnlUsd ?? null, oldPnlPercent: old?.pnlPercent ?? null,
      uiPreparationSeconds: skips ? (skips.observedAt - b.observedAt) / 1000 : null,
      entryAudit, newExitAt: exit?.observedAt ?? null, newReason: exit?.reason ?? 'CENSORED_NO_EXIT_WITHIN_COMMON_WINDOW',
      newPnlPercent: exit?.returnPercent ?? null, newPnlUsd: exit ? b.stakeUsd * exit.returnPercent / 100 : null,
      metrics: exit, cutoff, note: 'Exit-only replay keeps historical entry fixed; entry audit is separate. No future prices or invented exit fills.' });
  }
}
const summaries = dirs.map(d => {
  const rows = results.filter(r => r.run === basename(resolve(d))), paired = rows.filter(r => r.newPnlUsd !== null && r.oldPnlUsd !== null);
  return { run: basename(resolve(d)), positions: rows.length, paired: paired.length, censored: rows.length - paired.length,
    oldTotalUsd: rows.reduce((s, r) => s + (r.oldPnlUsd ?? 0), 0),
    oldPairedUsd: paired.reduce((s, r) => s + r.oldPnlUsd, 0), newPairedUsd: paired.reduce((s, r) => s + r.newPnlUsd, 0),
    entryAllowedAtOriginalTime: rows.filter(r => r.entryAudit.allowed).length };
});
const esc = (s: unknown) => String(s ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number | null) => n === null ? '—' : n.toFixed(2);
mkdirSync('reports', { recursive: true }); mkdirSync('dist', { recursive: true });
const report = { generatedAt: new Date().toISOString(), rules: MOMENTUM_RULES, summaries, results };
writeFileSync('reports/momentum-replay.json', JSON.stringify(report, null, 2));
writeFileSync('dist/momentum-replay.html', `<!doctype html><html lang="id"><meta charset="utf-8"><title>Evaluasi momentum v2</title><style>body{background:#101923;color:#eef;font:15px/1.5 system-ui;margin:32px}a{color:#8cf}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #456;text-align:left}small{color:#bbc}.box{background:#192b40;padding:18px;margin:16px 0}</style><h1>Evaluasi momentum v2</h1><a href="/paper-simulation-report.html">Report collector</a><div class="box">Replay exit memakai entry historis yang sama dan hanya data yang sudah diterima saat keputusan. Censored = tidak ada sinyal baru sebelum batas waktu exit lama; tidak dihitung sebagai nol/rugi/untung. Filter entry ditampilkan terpisah, bukan simulasi portofolio penuh. Fee dan slippage belum dihitung. Data ini dipakai saat menyusun rules, jadi bukan validasi independen.</div>${summaries.map(s => `<h2>${esc(s.run)}</h2><p>${s.positions} posisi; ${s.paired} pasangan exit tersedia; ${s.censored} censored. P/L seluruh run lama $${fmt(s.oldTotalUsd)}. Pada pasangan yang tersedia: lama $${fmt(s.oldPairedUsd)} → replay $${fmt(s.newPairedUsd)}. Lolos filter entry baru pada waktu entry lama: ${s.entryAllowedAtOriginalTime}/${s.positions}.</p>`).join('')}<table><tr><th>Run / token</th><th>Lama</th><th>Replay exit</th><th>Alasan</th><th>Entry baru</th><th>UI menahan evaluasi lama</th></tr>${results.map(r => `<tr><td>${esc(r.token)}<br><small>${esc(r.run)}</small></td><td>${fmt(r.oldPnlPercent)}%</td><td>${fmt(r.newPnlPercent)}${r.newPnlPercent === null ? '' : '%'}</td><td>${esc(r.newReason)}</td><td>${r.entryAudit.allowed ? 'LOLOS' : esc(r.entryAudit.reasons.join(', '))}</td><td>${fmt(r.uiPreparationSeconds)} detik</td></tr>`).join('')}</table><p>Stop dan profit lock adalah pemicu, bukan jaminan harga eksekusi. Jika harga melompati batas, replay mencatat harga tick yang tersedia.</p></html>`);
console.log(JSON.stringify({ summaries, json: 'reports/momentum-replay.json', html: 'dist/momentum-replay.html' }, null, 2));
