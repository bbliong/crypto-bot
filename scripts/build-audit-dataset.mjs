import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

function findFiles(dir, name) {
  let res = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) res.push(...findFiles(full, name));
      else if (item === name) res.push(full);
    }
  } catch (e) {}
  return res;
}

export async function extractAuditDataset(baseDir = 'data/profit4-watch') {
  const eventFiles = findFiles(baseDir, 'profit4-events.jsonl');
  const sells = new Map();

  for (const f of eventFiles) {
    const rl = readline.createInterface({
      input: fs.createReadStream(f),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === 'PAPER_SELL') {
          // Keep newest or first
          if (!sells.has(j.mint)) {
            sells.set(j.mint, j);
          }
        }
      } catch (e) {}
    }
  }

  // Also supplement with positions from profit4-state.json
  const runs = fs.readdirSync(baseDir).filter(d => {
    try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
  });
  for (const r of runs) {
    const statePath = path.join(baseDir, r, 'profit4-state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      for (const p of state.positions || []) {
        if (p.netReturnPercent !== null && p.netReturnPercent !== undefined) {
          if (!sells.has(p.mint)) {
            sells.set(p.mint, {
              mint: p.mint,
              symbol: p.symbol,
              netReturnPercent: p.netReturnPercent,
              pnlUsd: p.pnlUsd,
              reason: p.lastEvent?.reason || 'CLOSED',
              entryAt: p.entryAt,
              exitAt: p.exitAt,
              holdDurationSec: p.entryAt && p.exitAt ? Math.round((p.exitAt - p.entryAt) / 1000) : 0,
              transfer: { symbol: p.symbol },
            });
          }
        }
      }
    } catch (e) {}
  }

  const mintsNeeded = new Set(sells.keys());
  const tokenMeta = new Map();

  const apiFiles = findFiles(baseDir, 'api-responses.jsonl');
  for (const f of apiFiles) {
    const rl = readline.createInterface({
      input: fs.createReadStream(f),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.includes('token_stat') && !line.includes('token_trader_stat') && !line.includes('token_security')) continue;
      try {
        const j = JSON.parse(line);
        const endpoint = j.endpoint || '';
        const mintMatch = endpoint.match(/\/sol\/([1-9A-HJ-NP-Za-km-z]+)/);
        const mint = j.mint || (mintMatch ? mintMatch[1] : null);
        if (!mint || !mintsNeeded.has(mint)) continue;

        if (!tokenMeta.has(mint)) {
          tokenMeta.set(mint, { traderStat: {}, tokenStat: {}, security: {} });
        }
        const m = tokenMeta.get(mint);
        const d = j.body?.data || j.body || {};

        if (endpoint.includes('token_trader_stat')) {
          Object.assign(m.traderStat, d);
        } else if (endpoint.includes('token_stat')) {
          Object.assign(m.tokenStat, d);
        } else if (endpoint.includes('token_security')) {
          Object.assign(m.security, d);
        }
      } catch (e) {}
    }
  }

  const allRows = [];
  for (const [mint, sell] of sells.entries()) {
    const meta = tokenMeta.get(mint) || { traderStat: {}, tokenStat: {}, security: {} };
    const ts = meta.traderStat || {};
    const ks = meta.tokenStat || {};
    const sec = meta.security || {};

    const netRet = Number((sell.netReturnPercent || 0).toFixed(2));
    const isWin = netRet > 0;
    const duration = sell.entryAt && sell.exitAt ? Math.round((sell.exitAt - sell.entryAt) / 1000) : (sell.holdDurationSec || 0);

    const hasMeta = Boolean(Object.keys(ts).length || Object.keys(ks).length);

    allRows.push({
      symbol: sell.transfer?.symbol || sell.symbol || mint.slice(0, 8),
      mint,
      shortMint: mint.slice(0, 8),
      outcome: isWin ? 'WIN' : 'LOSS',
      netReturnPercent: netRet,
      net: (netRet >= 0 ? '+' : '') + netRet.toFixed(1) + '%',
      pnlUsd: Number((sell.pnlUsd || 0).toFixed(2)),
      reason: sell.reason || sell.lastEvent?.reason || 'CLOSED',
      holdDurationSec: duration,
      hasMeta,
      // Metrics GMGN:
      snipers: Number(ts.sniper_count ?? ks.sniper_count ?? 0),
      sniperHoldPct: Number(((Number(ks.top70_sniper_hold_rate || 0)) * 100).toFixed(2)),
      bundlers: Number(ts.bundler_count ?? 0),
      bundlerPct: Number(((Number(ks.top_bundler_trader_percentage || 0)) * 100).toFixed(2)),
      ratTraderPct: Number(((Number(ks.top_rat_trader_percentage || 0)) * 100).toFixed(2)),
      insiders: Number(ts.insider_count ?? 0),
      dexBots: Number(ts.dex_bot_count ?? 0),
      botDegens: Number(ks.bot_degen_count ?? 0),
      freshWallets: Number(ts.fresh_wallet_count ?? 0),
      creatorCoins: Number(ks.creator_created_count ?? 0),
      top10Pct: Number(((Number(ks.top_10_holder_rate || 0)) * 100).toFixed(1)),
      holderCount: Number(ks.holder_count ?? 0),
      devTeamHoldPct: Number(((Number(ks.dev_team_hold_rate || 0)) * 100).toFixed(2)),
      creatorHoldPct: Number(((Number(ks.creator_hold_rate || 0)) * 100).toFixed(2)),
      renouncedMint: sec.is_renounced_mint ?? ks.is_renounced_mint ?? null,
      renouncedFreeze: sec.is_renounced_freeze_account ?? ks.is_renounced_freeze_account ?? null,
    });
  }

  // Sort rows: first tokens with metadata, then by netReturnPercent descending
  allRows.sort((a, b) => {
    if (a.hasMeta !== b.hasMeta) return b.hasMeta ? 1 : -1;
    return b.netReturnPercent - a.netReturnPercent;
  });

  return allRows;
}

if (process.argv[1] && process.argv[1].endsWith('build-audit-dataset.mjs')) {
  console.log('Building audit dataset streaming...');
  const t0 = Date.now();
  extractAuditDataset().then(rows => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
    console.log(`Done in ${elapsed}s! Total rows: ${rows.length}`);
    const metaRows = rows.filter(r => r.hasMeta);
    console.log(`Rows with full GMGN metadata: ${metaRows.length}`);
    const winMeta = metaRows.filter(r => r.outcome === 'WIN');
    const lossMeta = metaRows.filter(r => r.outcome === 'LOSS');
    console.log(`WIN with metadata: ${winMeta.length}, LOSS with metadata: ${lossMeta.length}`);
    fs.writeFileSync('data/profit4-watch/audit-cache.json', JSON.stringify(rows, null, 2));
    console.log('Saved to data/profit4-watch/audit-cache.json');
  }).catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
