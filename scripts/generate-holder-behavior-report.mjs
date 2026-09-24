import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const [collectorDir, simulatorDir] = process.argv.slice(2);
if (!collectorDir || !simulatorDir) throw new Error('Usage: node scripts/generate-holder-behavior-report.mjs <collector-dir> <simulator-dir>');
const outputDir = join('research', 'holder-behavior-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(outputDir, { recursive: true });
const load = (dir, file) => {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
};
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const fmt = (number, places = 2) => Number.isFinite(number) ? Number(number).toFixed(places) : '—';
const time = ms => Number.isFinite(ms) ? new Date(ms).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : '—';
const ordinary = holder => holder.isPoolOrExchange !== undefined
  ? !holder.isPoolOrExchange
  : holder.raw?.addr_type !== 2 && !holder.raw?.exchange && !String(holder.walletTagV2 ?? '').toLowerCase().includes('lp');

function build(name, dir) {
  const sessions = load(dir, 'token-summary.jsonl');
  const trades = load(dir, 'trades.jsonl');
  const snapshots = load(dir, name === 'Collector' ? 'holder-snapshots.jsonl' : 'tracked-holders.jsonl');
  const holderCounts = load(dir, name === 'Collector' ? 'holder-counts.jsonl' : 'token-stat.jsonl');
  const paper = name === 'Simulator' ? load(dir, 'simulated-trades.jsonl') : [];
  const sessionByMint = new Map(sessions.map(session => [session.mint, session]));
  const byMint = new Map();
  for (const session of sessions) byMint.set(session.mint, { session, trades: [], snapshots: [], counts: [], paper: [] });
  for (const [rows, field] of [[trades, 'trades'], [snapshots, 'snapshots'], [holderCounts, 'counts'], [paper, 'paper']]) {
    for (const row of rows) byMint.get(row.mint)?.[field].push(row);
  }
  const allWallets = new Map();
  for (const [mint, group] of byMint) {
    for (const snapshot of group.snapshots) {
      const holders = snapshot.topUserHolders ?? snapshot.holders ?? [];
      for (const holder of holders.filter(ordinary)) {
        const wallets = allWallets.get(holder.wallet) ?? new Set();
        wallets.add(mint); allWallets.set(holder.wallet, wallets);
      }
    }
  }
  const tokens = [...byMint].map(([mint, group]) => {
    const { session } = group;
    const snapshots = group.snapshots.sort((a, b) => a.observedAt - b.observedAt);
    const validCounts = group.counts.filter(row => row.status === 200 && Number.isFinite(row.holderCount)).sort((a, b) => a.observedAt - b.observedAt);
    const byWallet = new Map();
    for (const snapshot of snapshots) {
      for (const holder of (snapshot.topUserHolders ?? snapshot.holders ?? []).filter(ordinary)) {
        const record = byWallet.get(holder.wallet) ?? { wallet: holder.wallet, shares: [], devEvidence: [], buys: [], sells: [] };
        record.shares.push({ observedAt: snapshot.observedAt, percent: holder.amountPercentage, amount: holder.amount ?? null });
        record.devEvidence.push(...(holder.devEvidence ?? []));
        byWallet.set(holder.wallet, record);
      }
    }
    for (const trade of group.trades) {
      if (!trade.wallet) continue;
      const record = byWallet.get(trade.wallet) ?? { wallet: trade.wallet, shares: [], devEvidence: [], buys: [], sells: [] };
      record[trade.side === 'buy' ? 'buys' : 'sells'].push(trade);
      byWallet.set(trade.wallet, record);
    }
    const wallets = [...byWallet.values()].map(wallet => {
      const buys = wallet.buys.sort((a, b) => a.occurredAt - b.occurredAt);
      const sells = wallet.sells.sort((a, b) => a.occurredAt - b.occurredAt);
      const roundTrips = sells.flatMap(sell => {
        const buy = buys.filter(candidate => candidate.occurredAt <= sell.occurredAt).at(-1);
        return buy ? [(sell.occurredAt - buy.occurredAt) / 1000] : [];
      });
      const shares = wallet.shares.sort((a, b) => a.observedAt - b.observedAt);
      return { wallet: wallet.wallet, firstShare: shares[0]?.percent ?? null, lastShare: shares.at(-1)?.percent ?? null,
        shareChange: shares.length >= 2 ? shares.at(-1).percent - shares[0].percent : null,
        devEvidence: [...new Set(wallet.devEvidence)], repeatedTokens: allWallets.get(wallet.wallet)?.size ?? 0,
        buys: buys.length, sells: sells.length, buyUsd: buys.reduce((n, t) => n + (t.amountUsd ?? 0), 0),
        sellUsd: sells.reduce((n, t) => n + (t.amountUsd ?? 0), 0), firstBuyAt: buys[0]?.occurredAt ?? null,
        firstSellAt: sells[0]?.occurredAt ?? null, fastestRoundTripSeconds: roundTrips.length ? Math.min(...roundTrips) : null,
        snapshotCount: shares.length,
        // The API does not always mark shared reserve-like addresses as pool/exchange.
        sharedHighBalance: (allWallets.get(wallet.wallet)?.size ?? 0) >= 3 && shares.some(row => row.percent >= 50),
      };
    }).sort((a, b) => (b.firstShare ?? -1) - (a.firstShare ?? -1));
    const observedWallets = wallets.filter(wallet => wallet.snapshotCount > 0);
    const activeWallets = wallets.filter(wallet => wallet.buys || wallet.sells);
    const devSellers = wallets.filter(wallet => wallet.devEvidence.length && wallet.sells);
    const paperSell = group.paper.find(row => row.type === 'SIMULATED_SELL');
    return { mint, symbol: session.metadata?.symbol ?? session.metadata?.name ?? mint.slice(0, 8), startedAt: session.startedAt,
      endedAt: session.endedAt, endReason: session.endedBecause, holderStart: validCounts[0]?.holderCount ?? null,
      holderEnd: validCounts.at(-1)?.holderCount ?? null, holderSamples: validCounts.length,
      observedWalletCount: observedWallets.length, activeWalletCount: activeWallets.length, devSellers: devSellers.length,
      holderCountConflict: validCounts.at(-1)?.holderCount === 0 && observedWallets.length > 0,
      rapidSellers5s: wallets.filter(wallet => wallet.fastestRoundTripSeconds !== null && wallet.fastestRoundTripSeconds <= 5).length,
      tradeBuys: group.trades.filter(trade => trade.side === 'buy').length,
      tradeSells: group.trades.filter(trade => trade.side === 'sell').length,
      paperPnlUsd: paperSell?.pnlUsd ?? null, wallets };
  }).sort((a, b) => a.startedAt - b.startedAt);
  const positiveCountSeries = tokens.filter(token => token.holderSamples >= 2 && token.holderStart > 0 && token.holderEnd > 0);
  return { name, dir, tokens, tradeRows: trades.length, snapshotRows: snapshots.length,
    sharedAddresses: [...allWallets].filter(([, mints]) => mints.size >= 2).length,
    uniqueHolderAddresses: allWallets.size, allWallets,
    rapidWalletPairs5s: tokens.reduce((sum, token) => sum + token.rapidSellers5s, 0),
    devSellTokens: tokens.filter(token => token.devSellers > 0).length,
    fullDevExits: tokens.reduce((sum, token) => sum + token.wallets.filter(wallet => wallet.devEvidence.length && wallet.firstShare > 0 && wallet.lastShare === 0 && wallet.sells > 0).length, 0),
    positiveCountSeries: positiveCountSeries.length,
    holderCountGrowthInPositiveSeries: positiveCountSeries.filter(token => token.holderEnd > token.holderStart).length };
}

const collector = build('Collector', collectorDir);
const simulator = build('Simulator', simulatorDir);
const overlap = [...collector.allWallets.keys()].filter(wallet => simulator.allWallets.has(wallet));
const uniqueMintsA = new Set(collector.tokens.map(token => token.mint));
const overlapAcrossDifferentMints = overlap.filter(wallet => [...collector.allWallets.get(wallet)].some(firstMint =>
  [...simulator.allWallets.get(wallet)].some(secondMint => firstMint !== secondMint)));
const summary = { generatedAt: new Date().toISOString(), collector: {
  dir: collectorDir, sessions: collector.tokens.length, tradeRows: collector.tradeRows, holderSnapshots: collector.snapshotRows,
  uniqueHolderAddresses: collector.uniqueHolderAddresses, sharedAddressesWithinRun: collector.sharedAddresses,
  rapidWalletPairs5s: collector.rapidWalletPairs5s, devSellTokens: collector.devSellTokens,
  fullDevExits: collector.fullDevExits, positiveCountSeries: collector.positiveCountSeries,
  holderCountGrowthInPositiveSeries: collector.holderCountGrowthInPositiveSeries,
}, simulator: { dir: simulatorDir, sessions: simulator.tokens.length, tradeRows: simulator.tradeRows,
  holderSnapshots: simulator.snapshotRows, uniqueHolderAddresses: simulator.uniqueHolderAddresses,
  sharedAddressesWithinRun: simulator.sharedAddresses, rapidWalletPairs5s: simulator.rapidWalletPairs5s,
  devSellTokens: simulator.devSellTokens, fullDevExits: simulator.fullDevExits,
  positiveCountSeries: simulator.positiveCountSeries,
  holderCountGrowthInPositiveSeries: simulator.holderCountGrowthInPositiveSeries,
}, overlap: { tokenMints: simulator.tokens.filter(token => uniqueMintsA.has(token.mint)).length,
  holderAddresses: overlap.length, holderAddressesAcrossDifferentMints: overlapAcrossDifferentMints.length } };
writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2));
const rows = run => run.tokens.map(token => {
  const delta = token.holderStart === null || token.holderEnd === null ? null : token.holderEnd - token.holderStart;
  const walletRows = token.wallets.map(wallet => `<tr><td class="mono">${esc(wallet.wallet)}</td><td>${wallet.devEvidence.length ? `<span class="dev">DEV: ${esc(wallet.devEvidence.join(', '))}</span>` : wallet.sharedHighBalance ? '<span class="warn">Alamat berulang dengan saldo besar; peran belum pasti</span>' : '—'}</td><td>${fmt(wallet.firstShare)} → ${fmt(wallet.lastShare)}%</td><td>${fmt(wallet.shareChange)} pp</td><td>${wallet.buys} / ${wallet.sells}</td><td>${fmt(wallet.buyUsd)} / ${fmt(wallet.sellUsd)}</td><td>${time(wallet.firstBuyAt)} / ${time(wallet.firstSellAt)}</td><td>${wallet.fastestRoundTripSeconds === null ? '—' : fmt(wallet.fastestRoundTripSeconds, 0) + ' dtk'}</td><td>${wallet.repeatedTokens}</td></tr>`).join('');
  return `<details><summary><strong>${esc(token.symbol)}</strong> <span class="mono">${esc(token.mint)}</span> · holder ${token.holderStart ?? '—'} → ${token.holderEnd ?? '—'} (${delta === null ? '—' : delta >= 0 ? '+' + delta : delta})${token.holderCountConflict ? ' ⚠️ API belum sinkron' : ''} · buy/sell ${token.tradeBuys}/${token.tradeSells} · DEV menjual ${token.devSellers} wallet · flip ≤5 dtk ${token.rapidSellers5s} wallet${token.paperPnlUsd === null ? '' : ` · PnL kertas $${fmt(token.paperPnlUsd, 4)}`}</summary><p>Masuk ${time(token.startedAt)}, selesai ${time(token.endedAt)}. ${esc(token.endReason)}. <a href="https://gmgn.ai/sol/token/${encodeURIComponent(token.mint)}" target="_blank" rel="noopener">Buka GMGN</a></p><div class="table-wrap"><table><thead><tr><th>Alamat wallet</th><th>Tag / catatan</th><th>Share awal → akhir</th><th>Δ share</th><th>Buy / sell</th><th>USD buy / sell</th><th>Buy / sell pertama (WIB)</th><th>Flip tercepat</th><th>Muncul di token</th></tr></thead><tbody>${walletRows}</tbody></table></div></details>`;
}).join('');
const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Perbandingan perilaku holder</title><style>body{font:15px/1.5 system-ui,sans-serif;background:#0d1320;color:#edf3ff;margin:0;padding:2rem}main{max-width:1500px;margin:auto}h1,h2{margin:.2rem 0 1rem}a{color:#81baff}header,p.note{color:#b2bed2}.cards{display:flex;gap:1rem;flex-wrap:wrap;margin:1.2rem 0 2rem}.card{background:#162238;border:1px solid #30405b;border-radius:12px;padding:1rem;min-width:210px}.card strong{font-size:1.5rem;display:block}details{background:#132035;border:1px solid #30405b;border-radius:10px;margin:.5rem 0;padding:.8rem}summary{cursor:pointer}summary .mono{font-size:.8rem;color:#99acc6}table{border-collapse:collapse;width:100%;font-size:.84rem}td,th{border-bottom:1px solid #2d3a52;padding:.45rem;text-align:left;white-space:nowrap}th{color:#acbfdc}.table-wrap{overflow:auto}.mono{font-family:ui-monospace,monospace}.dev{color:#ffd47b}.warn{color:#f49f9f}.note{max-width:1100px}</style></head><body><main><header><h1>Perilaku holder pada dua run ulang</h1><p>Collector: ${esc(basename(collectorDir))} · Simulator: ${esc(basename(simulatorDir))}</p></header><div class="cards"><div class="card"><strong>${collector.tokens.length}</strong> sesi collector · ${collector.tradeRows} trade</div><div class="card"><strong>${simulator.tokens.length}</strong> sesi simulator · ${simulator.tradeRows} trade</div><div class="card"><strong>${overlap.length}</strong> alamat holder sama di kedua run</div><div class="card"><strong>${summary.overlap.tokenMints}</strong> mint token sama</div></div><p class="note">Setiap sesi hanya sekitar 20 detik. Buy/sell berasal dari aktivitas WebSocket; persentase dan label DEV berasal dari respons holder API GMGN. Share holder adalah snapshot, bukan bukti jumlah token yang dijual pada trade tertentu. Pool/exchange yang dikenali dikeluarkan dari tabel. Alamat saldo besar yang berulang di banyak token diberi catatan peran belum pasti. Jeda flip memakai cap waktu trade dengan resolusi satu detik; nol detik berarti dalam detik yang sama, bukan transaksi instan. Jika API holder_count menunjukkan nol sementara daftar holder berisi alamat, hitungan API belum sinkron dan perubahannya tidak layak dipakai sebagai sinyal. Data ini adalah pengamatan dan simulasi, bukan fill nyata.</p><h2>Collector</h2>${rows(collector)}<h2>Simulator</h2>${rows(simulator)}</main></body></html>`;
writeFileSync(join(outputDir, 'holder-behavior-report.html'), html);
console.log(join(outputDir, 'holder-behavior-report.html'));
