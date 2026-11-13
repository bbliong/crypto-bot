#!/usr/bin/env node
/**
 * scripts/generate-report-infographic.mjs
 *
 * Engine pembuat Infografis Scorecard Telegram per Skenario (Opsi A) & Ringkasan.
 * Menghasilkan kartu visual individual untuk tiap skenario secara ringan, cepat, & tajam.
 *
 * Penggunaan:
 *   node scripts/generate-report-infographic.mjs --scenario s14_net10
 *   node scripts/generate-report-infographic.mjs --net10  (menghasilkan AP1-10%, AP2-10%, AP3-10%)
 *   node scripts/generate-report-infographic.mjs --all    (semua 6 varian AP)
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const STATE_FILE = join(ROOT, 'data', 'dryrun-3scenarios-live.json');
const CONFIG_FILE = join(ROOT, 'data', 'follower-autobuy-settings.json');

const LANES_METADATA = {
  s14_net10: {
    label: 'AP1-10%',
    fullName: 'AP1-10%: Bundler Runner Net 10%',
    rules: 'Bundler Rate ≥ 5.0% · Saldo Awal $20.00 · Modal $5.00/entry · Full Exit Net TP +10%',
    type: 'NET10',
    color: '#34d399'
  },
  s14_alpha_net10: {
    label: 'AP2-10%',
    fullName: 'AP2-10%: Bundler + 60s Grace Net 10%',
    rules: 'Grace Period ≥ 60s · Bundler ≥ 5.0% · Saldo Awal $20.00 · Modal $5.00/entry · Exit Net TP +10%',
    type: 'NET10',
    color: '#34d399'
  },
  s14_beta_net10: {
    label: 'AP3-10%',
    fullName: 'AP3-10%: Bundler + Grace + Hoarding Net 10%',
    rules: 'Grace ≥ 60s · Bundler ≥ 5.0% · Whale Hoarding Defense (+25% bag) · Exit Net TP +10%',
    type: 'NET10',
    color: '#34d399'
  },
  s14: {
    label: 'AP1',
    fullName: 'AP1: Bundler-Confirmed Runner (Wave Rider)',
    rules: 'Bundler Rate ≥ 5.0% · Saldo Awal $5.00 · Modal $5.00/entry · Multi-Stage TP (+50% / +100%)',
    type: 'STANDARD',
    color: '#38bdf8'
  },
  s14_alpha: {
    label: 'AP2',
    fullName: 'AP2: Bundler Runner + 60s Grace Period',
    rules: 'Grace Period ≥ 60s · Bundler ≥ 5.0% · Saldo Awal $5.00 · Modal $5.00/entry · TP 50% / 100%',
    type: 'STANDARD',
    color: '#38bdf8'
  },
  s14_beta: {
    label: 'AP3',
    fullName: 'AP3: Bundler Runner + 60s Grace + Hoarding Defense',
    rules: 'Grace ≥ 60s · Bundler ≥ 5% · Whale Hoarding Trap Defense · Saldo $5.00 · Modal $5.00',
    type: 'STANDARD',
    color: '#38bdf8'
  }
};

function formatWib(ms) {
  if (!ms) return '-';
  const d = new Date(ms + 7 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')}`;
}

function formatWibDateTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms + 7 * 3600 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mo}/${yyyy} · ${hh}:${mm} WIB`;
}

function normalizeLaneKey(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (['ap1-10%', 'ap1_net10', 's14_net10'].includes(s)) return 's14_net10';
  if (['ap2-10%', 'ap2_net10', 's14_alpha_net10'].includes(s)) return 's14_alpha_net10';
  if (['ap3-10%', 'ap3_net10', 's14_beta_net10'].includes(s)) return 's14_beta_net10';
  if (['ap1', 's14'].includes(s)) return 's14';
  if (['ap2', 's14_alpha'].includes(s)) return 's14_alpha';
  if (['ap3', 's14_beta', 's15'].includes(s)) return 's14_beta';
  return LANES_METADATA[s] ? s : null;
}

async function renderSingleScenarioCard(browser, state, laneKey) {
  const meta = LANES_METADATA[laneKey];
  const s = state[laneKey];
  if (!meta || !s) return null;

  const trades = s.closedTrades || [];
  const wins = trades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
  const losses = trades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
  const pnl = trades.reduce((acc, t) => acc + (t.realizedPnlUsd || 0), 0);
  const winRate = trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0';
  const opens = s.openPositions || [];

  const holds = trades.map(t => (t.closedAt - t.openedAt) / 1000).filter(h => h > 0);
  const avgHold = holds.length ? Math.round(holds.reduce((a, b) => a + b, 0) / holds.length) : 0;

  const nowWib = formatWibDateTime(Date.now());
  const availableCash = s.availableCash || 0;

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
      body { background: #0b1120; color: #f8fafc; padding: 18px; width: 880px; margin: 0 auto; }
      .card { background: #131d31; border-radius: 16px; border: 1px solid #22324e; padding: 22px; box-shadow: 0 16px 36px rgba(0,0,0,0.6); }
      
      .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #22324e; padding-bottom: 16px; margin-bottom: 18px; }
      .title-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .lane-title { font-size: 22px; font-weight: 800; color: #38bdf8; letter-spacing: -0.3px; }
      .badge-type { background: ${meta.type === 'NET10' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(56, 189, 248, 0.2)'}; color: ${meta.type === 'NET10' ? '#34d399' : '#38bdf8'}; border: 1px solid ${meta.type === 'NET10' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(56, 189, 248, 0.4)'}; padding: 3px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; }
      .lane-desc { font-size: 11px; color: #94a3b8; line-height: 1.4; }
      .meta-right { text-align: right; }
      .time-pill { background: #1e293b; color: #94a3b8; font-size: 11px; padding: 4px 10px; border-radius: 6px; border: 1px solid #334155; font-weight: 600; }

      .grid-kpi { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 20px; }
      .kpi-box { background: #0f172a; border: 1px solid #1e293b; border-radius: 10px; padding: 12px 10px; text-align: center; }
      .kpi-lbl { font-size: 10px; color: #94a3b8; text-transform: uppercase; font-weight: 600; margin-bottom: 4px; }
      .kpi-val { font-size: 18px; font-weight: 800; }
      .val-green { color: #34d399; }
      .val-red { color: #f87171; }
      .val-cyan { color: #38bdf8; }
      .val-amber { color: #fbbf24; }

      .section-hdr { font-size: 12px; font-weight: 700; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; }
      
      .open-box { background: rgba(56, 189, 248, 0.08); border: 1px dashed rgba(56, 189, 248, 0.3); border-radius: 10px; padding: 12px; margin-bottom: 16px; }
      .open-title { font-size: 11px; font-weight: 700; color: #38bdf8; margin-bottom: 6px; }
      .open-tag { display: inline-flex; align-items: center; gap: 8px; background: #0f172a; border: 1px solid #22324e; padding: 4px 10px; border-radius: 6px; font-size: 11px; margin-right: 8px; }

      .table-wrap { background: #182338; border: 1px solid #263857; border-radius: 12px; overflow: hidden; margin-bottom: 16px; }
      .trade-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .trade-table th { background: #0f172a; color: #94a3b8; text-align: left; padding: 9px 10px; font-weight: 600; border-bottom: 1px solid #263857; }
      .trade-table td { padding: 8px 10px; border-bottom: 1px solid #1e293b; }
      .trade-table tr:last-child td { border-bottom: none; }

      .coin-badge { font-family: monospace; font-size: 9px; padding: 2px 4px; border-radius: 4px; background: #0f172a; border: 1px solid #263857; color: #94a3b8; }
      .tag-win { background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; }
      .tag-loss { background: rgba(248, 113, 113, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; }

      .footer { display: flex; justify-content: space-between; font-size: 10px; color: #64748b; padding-top: 8px; border-top: 1px solid #22324e; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="header">
        <div>
          <div class="title-row">
            <span class="lane-title">${meta.fullName}</span>
            <span class="badge-type">${meta.type === 'NET10' ? 'TARGET NET TP +10%' : 'MULTI-STAGE TP'}</span>
          </div>
          <div class="lane-desc">${meta.rules}</div>
        </div>
        <div class="meta-right">
          <div class="time-pill">${nowWib}</div>
        </div>
      </div>

      <div class="grid-kpi">
        <div class="kpi-box">
          <div class="kpi-lbl">Realized PnL</div>
          <div class="kpi-val ${pnl >= 0 ? 'val-green' : 'val-red'}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-lbl">Win Rate</div>
          <div class="kpi-val val-cyan">${winRate}%</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-lbl">Win / Loss</div>
          <div class="kpi-val">${wins}W / ${losses}L</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-lbl">Saldo Kas</div>
          <div class="kpi-val">$${availableCash.toFixed(2)}</div>
        </div>
        <div class="kpi-box">
          <div class="kpi-lbl">Avg Hold</div>
          <div class="kpi-val val-amber">${avgHold}s</div>
        </div>
      </div>

      ${opens.length ? `
      <div class="open-box">
        <div class="open-title">🚨 POSISI TERBUKA AKTIF (${opens.length})</div>
        <div>
          ${opens.map(p => `
            <div class="open-tag">
              <strong>${p.symbol}</strong>
              <span class="coin-badge">${p.mint ? p.mint.slice(0, 8) : ''}</span>
              <span>Modal: $${p.costBasisUsd || 5}</span>
              <span class="${(p.unrealizedPnlUsd || 0) >= 0 ? 'val-green' : 'val-red'}">
                Float: ${(p.unrealizedPnlUsd || 0) >= 0 ? '+' : ''}$${(p.unrealizedPnlUsd || 0).toFixed(2)}
              </span>
              <span style="color:#64748b;">${formatWib(p.openedAt)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <div class="section-hdr">
        <span>RIWAYAT TRANSAKSI TERAKHIR (${trades.length} CLOSED)</span>
        <span style="color:#94a3b8; font-weight:400; font-size:10px;">Modal: $5.00/Entry · Fee $0.050/roundtrip</span>
      </div>

      <div class="table-wrap">
        <table class="trade-table">
          <thead>
            <tr>
              <th style="width: 30px;">#</th>
              <th>Token</th>
              <th>Jam Masuk</th>
              <th>Jam Keluar</th>
              <th>Durasi</th>
              <th>Hasil Realized</th>
              <th>Alasan Exit</th>
            </tr>
          </thead>
          <tbody>
            ${trades.slice(0, 10).map((t, idx) => `
              <tr>
                <td style="color:#64748b;">${idx + 1}</td>
                <td>
                  <strong>${t.symbol}</strong>
                  <span class="coin-badge">${t.mint ? t.mint.slice(0, 8) : ''}</span>
                </td>
                <td>${formatWib(t.openedAt)}</td>
                <td>${formatWib(t.closedAt)}</td>
                <td style="color:#94a3b8;">${t.closedAt && t.openedAt ? Math.round((t.closedAt - t.openedAt) / 1000) + 's' : '-'}</td>
                <td>
                  <span class="${(t.realizedPnlUsd || 0) >= 0 ? 'tag-win' : 'tag-loss'}">
                    ${(t.realizedPnlUsd || 0) >= 0 ? '+' : ''}$${(t.realizedPnlUsd || 0).toFixed(4)} (${(t.roiPct || 0) >= 0 ? '+' : ''}${(t.roiPct || 0).toFixed(1)}%)
                  </span>
                </td>
                <td style="color:#cbd5e1; font-size:10px;">${t.exitReason}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="footer">
        <span>* Kuotasi swap AMM on-chain via GMGN Route Proxy · Flat DEX fee $0.025/leg</span>
        <span>Auto-Buy Live: ⚪ DRY_RUN</span>
      </div>
    </div>
  </body>
  </html>
  `;

  const page = await browser.newPage({ viewport: { width: 900, height: 750, deviceScaleFactor: 2 } });
  await page.setContent(html);
  const outPath = join(ROOT, 'data', `scorecard-${laneKey}.png`);
  await page.screenshot({ path: outPath, fullPage: true });
  await page.close();

  return { laneKey, label: meta.label, outPath, pnl, wins, losses, tradesCount: trades.length, winRate };
}

async function main() {
  const args = process.argv.slice(2);
  let targetScenarios = [];

  const scArgIdx = args.indexOf('--scenario');
  if (scArgIdx !== -1 && args[scArgIdx + 1]) {
    const norm = normalizeLaneKey(args[scArgIdx + 1]);
    if (norm) targetScenarios.push(norm);
  } else if (args.includes('--net10') || args.includes('--ap-net10')) {
    targetScenarios = ['s14_net10', 's14_alpha_net10', 's14_beta_net10'];
  } else if (args.includes('--all')) {
    targetScenarios = ['s14_net10', 's14_alpha_net10', 's14_beta_net10', 's14', 's14_alpha', 's14_beta'];
  } else {
    // Default fallback: 3 varian net10
    targetScenarios = ['s14_net10', 's14_alpha_net10', 's14_beta_net10'];
  }

  if (!existsSync(STATE_FILE)) {
    console.error(`State file not found: ${STATE_FILE}`);
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const results = [];
  for (const laneKey of targetScenarios) {
    const res = await renderSingleScenarioCard(browser, state, laneKey);
    if (res) results.push(res);
  }

  await browser.close();

  console.log(`[GENERATED_${results.length}_SCORECARDS]`);
  for (const r of results) {
    console.log(`MEDIA_PATH: ${r.outPath} | ${r.label} | PnL: +$${r.pnl.toFixed(4)} (${r.wins}W/${r.losses}L)`);
  }
}

main().catch(err => {
  console.error('[ERROR]', err);
  process.exit(1);
});
