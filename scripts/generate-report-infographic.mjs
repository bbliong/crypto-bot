#!/usr/bin/env node
/**
 * scripts/generate-report-infographic.mjs
 *
 * Engine pembuat Infografis Scorecard Telegram untuk Crypto Bot Follower.
 * Membaca data state live, mengekstrak data on-chain whale/bundler dari log,
 * dan menghasilkan file gambar PNG resolusi tinggi via Playwright.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');

const STATE_FILE = join(ROOT, 'data', 'dryrun-3scenarios-live.json');
const CONFIG_FILE = join(ROOT, 'data', 'follower-autobuy-settings.json');
const DEFAULT_OUT_PATH = join(ROOT, 'data', 'telegram-report-scorecard.png');

function formatWib(ms) {
  if (!ms) return '-';
  const d = new Date(ms + 7 * 3600 * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatWibDateTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms + 7 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}/${mo}/${yyyy} · ${hh}:${mm} WIB`;
}

async function main() {
  const outPath = process.argv[2] || DEFAULT_OUT_PATH;

  if (!existsSync(STATE_FILE)) {
    console.error(`State file not found: ${STATE_FILE}`);
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) : {};

  // 1. Ekstrak data jurnal log untuk mencocokkan Whale In, Bundler, & Whale Dump
  const whaleFirstBuys = new Map();
  const bundlerRates = new Map();
  const whaleFirstSells = new Map();
  const whaleSellAlls = new Map();

  try {
    const rawLogs = execSync(
      `journalctl --user -u crypto-bot-wallet-follower.service --since "12 hours ago" --no-pager -o short-iso`,
      { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }
    );
    const lines = rawLogs.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];

      // Whale first buy
      if (l.includes('[TARGET ACTIVITY] BUY') && l.includes('FIRST_BUY')) {
        const m = l.match(/BUY\s+(.+?)\s+\(([A-Za-z0-9]+)\.\.\.\)/);
        const mTime = l.match(/T([0-9]{2}:[0-9]{2}:[0-9]{2})/);
        if (m && mTime) {
          const pref = m[2];
          let price = null;
          let usd = null;
          for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
            const mp = lines[j].match(/Price:\s*\$([0-9.]+)/);
            if (mp) price = mp[1];
            const mu = lines[j].match(/Target USD:\s*\$([0-9.]+)/);
            if (mu) usd = mu[1];
          }
          if (!whaleFirstBuys.has(pref)) {
            whaleFirstBuys.set(pref, { time: mTime[1], price, usd });
          }
        }
      }

      // Bundler rate terkonfirmasi
      if (l.includes('Bundler Rate :') || l.includes('BUNDLER 2S RESEARCH') || l.includes('BUNDLER MENINGKAT!')) {
        const mb = l.match(/Bundler(?:\s*Rate)?\s*:\s*([0-9.]+%)|->\s*([0-9.]+%)|\(([0-9.]+%\))/);
        const mPref = l.match(/\[([A-Za-z0-9]{8})\.\.\.\]/);
        if (mb && mPref) {
          const val = mb[1] || mb[2] || mb[3];
          if (val) bundlerRates.set(mPref[1], val);
        }
      }

      // Whale sell activity
      if (l.includes('[TARGET ACTIVITY] SELL')) {
        const m = l.match(/SELL\s+(.+?)\s+\(([A-Za-z0-9]+)\.\.\.\)/);
        const mTime = l.match(/T([0-9]{2}:[0-9]{2}:[0-9]{2})/);
        if (m && mTime) {
          const pref = m[2];
          if (!whaleFirstSells.has(pref)) whaleFirstSells.set(pref, mTime[1]);
          if (l.includes('SELL_ALL')) whaleSellAlls.set(pref, mTime[1]);
        }
      }
    }
  } catch (err) {
    console.warn('[SCORECARD] Warning: tidak dapat membaca journalctl secara penuh:', err.message);
  }

  // 2. Kalkulasi statistik skenario
  const apLanes = [
    { key: 's14_net10', label: 'AP1-10%', parent: 'AP1', type: 'NET10' },
    { key: 's14_alpha_net10', label: 'AP2-10%', parent: 'AP2', type: 'NET10' },
    { key: 's14_beta_net10', label: 'AP3-10%', parent: 'AP3', type: 'NET10' },
    { key: 's14', label: 'AP1', parent: 'AP1', type: 'STANDARD' },
    { key: 's14_alpha', label: 'AP2', parent: 'AP2', type: 'STANDARD' },
    { key: 's14_beta', label: 'AP3', parent: 'AP3', type: 'STANDARD' }
  ];

  const laneStats = {};
  let net10Trades = 0, net10Wins = 0, net10Losses = 0, net10Pnl = 0;
  let stdTrades = 0, stdWins = 0, stdLosses = 0, stdPnl = 0;
  let allOpenPositions = [];

  for (const l of apLanes) {
    const s = state[l.key] || {};
    const trades = s.closedTrades || [];
    const wins = trades.filter(t => (t.realizedPnlUsd || 0) > 0).length;
    const losses = trades.filter(t => (t.realizedPnlUsd || 0) < 0).length;
    const pnl = trades.reduce((acc, t) => acc + (t.realizedPnlUsd || 0), 0);
    const opens = s.openPositions || [];

    laneStats[l.key] = {
      label: l.label,
      type: l.type,
      initialCash: s.initialCash || (l.type === 'NET10' ? 20 : 5),
      availableCash: s.availableCash || 0,
      portfolio: s.totalPortfolioValue || 0,
      tradesCount: trades.length,
      wins,
      losses,
      winRate: trades.length ? ((wins / trades.length) * 100).toFixed(1) : '0.0',
      pnl,
      openCount: opens.length
    };

    if (l.type === 'NET10') {
      net10Trades += trades.length;
      net10Wins += wins;
      net10Losses += losses;
      net10Pnl += pnl;
    } else {
      stdTrades += trades.length;
      stdWins += wins;
      stdLosses += losses;
      stdPnl += pnl;
    }

    for (const pos of opens) {
      allOpenPositions.push({
        laneLabel: l.label,
        symbol: pos.symbol,
        mint: pos.mint,
        mintPrefix: pos.mint ? pos.mint.slice(0, 8) : '',
        openedAt: pos.openedAt,
        costBasisUsd: pos.costBasisUsd || 5,
        unrealizedPnlUsd: pos.unrealizedPnlUsd || 0,
        status: pos.ap?.status || 'OPEN'
      });
    }
  }

  // 3. Gabungkan dan urutkan transaksi tertutup terbaru
  const recentClosed = [];
  for (const l of apLanes) {
    const s = state[l.key] || {};
    for (const t of s.closedTrades || []) {
      const pref = t.mint ? t.mint.slice(0, 8) : '';
      const wBuy = whaleFirstBuys.get(pref);
      const wSell = whaleFirstSells.get(pref);
      const wSellAll = whaleSellAlls.get(pref);
      const bRate = bundlerRates.get(pref);

      let holdSeconds = '-';
      if (t.openedAt && t.closedAt) {
        holdSeconds = `${Math.round((t.closedAt - t.openedAt) / 1000)}s`;
      }

      recentClosed.push({
        laneLabel: l.label,
        type: l.type,
        symbol: t.symbol,
        mintPrefix: pref,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
        holdSeconds,
        investedUsd: t.totalInvestedUsd || 5,
        pnl: t.realizedPnlUsd || 0,
        roi: t.roiPct || 0,
        exitReason: t.exitReason || '',
        whaleInTime: wBuy?.time || '-',
        whalePrice: wBuy?.price ? `$${parseFloat(wBuy.price).toFixed(7)}` : '-',
        bundlerRate: bRate || '-',
        whaleSellTime: wSell || '-',
        whaleSellAllTime: wSellAll || '-'
      });
    }
  }

  // Ambil 8 trade terbaru berdasarkan waktu closedAt
  recentClosed.sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));
  const topTrades = recentClosed.slice(0, 8);

  // 4. Bangun Desain HTML Infografis (Clean Dark Mode)
  const nowWib = formatWibDateTime(Date.now());
  const net10WinRate = net10Trades ? ((net10Wins / net10Trades) * 100).toFixed(1) : '0.0';
  const stdWinRate = stdTrades ? ((stdWins / stdTrades) * 100).toFixed(1) : '0.0';

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
      body { background: #0b1120; color: #f8fafc; padding: 24px; width: 960px; margin: 0 auto; }
      .card { background: #131d31; border-radius: 18px; border: 1px solid #22324e; padding: 24px; box-shadow: 0 16px 36px rgba(0,0,0,0.6); }
      
      .top-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #22324e; padding-bottom: 16px; margin-bottom: 20px; }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-icon { font-size: 24px; }
      .brand-title { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; color: #38bdf8; }
      .meta-pills { display: flex; align-items: center; gap: 8px; }
      .pill { padding: 4px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
      .pill-blue { background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
      .pill-gray { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
      
      .section-label { font-size: 12px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
      
      .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
      .group-card { background: #182338; border: 1px solid #263857; border-radius: 14px; padding: 16px; }
      .group-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; border-bottom: 1px dashed #263857; padding-bottom: 8px; }
      .group-name { font-size: 14px; font-weight: 700; color: #f1f5f9; }
      .group-tag { font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
      .tag-net10 { background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
      .tag-std { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); }
      
      .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
      .kpi-box { background: #0f172a; border-radius: 8px; padding: 10px 8px; text-align: center; border: 1px solid #1e293b; }
      .kpi-title { font-size: 10px; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; font-weight: 600; }
      .kpi-num { font-size: 16px; font-weight: 800; }
      
      .lane-subtable { width: 100%; border-collapse: collapse; font-size: 11px; }
      .lane-subtable th { text-align: left; color: #64748b; font-weight: 600; padding: 4px 6px; border-bottom: 1px solid #263857; }
      .lane-subtable td { padding: 6px; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
      
      .val-green { color: #34d399; font-weight: 700; }
      .val-red { color: #f87171; font-weight: 700; }
      .val-cyan { color: #38bdf8; font-weight: 700; }
      .val-amber { color: #fbbf24; font-weight: 700; }
      
      .main-table-wrap { background: #182338; border: 1px solid #263857; border-radius: 14px; padding: 16px; margin-bottom: 20px; }
      .trade-table { width: 100%; border-collapse: collapse; font-size: 11px; }
      .trade-table th { background: #0f172a; color: #94a3b8; text-align: left; padding: 9px 8px; font-weight: 600; border-top: 1px solid #263857; border-bottom: 1px solid #263857; }
      .trade-table td { padding: 8px; border-bottom: 1px solid #1e293b; }
      
      .coin-badge { font-family: monospace; font-size: 9px; padding: 2px 4px; border-radius: 4px; background: #0f172a; border: 1px solid #263857; color: #94a3b8; }
      .lane-badge { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
      .badge-ap10 { background: rgba(16, 185, 129, 0.15); color: #34d399; }
      .badge-ap { background: rgba(56, 189, 248, 0.15); color: #38bdf8; }
      
      .tag-win { background: rgba(52, 211, 153, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.3); padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; }
      .tag-loss { background: rgba(248, 113, 113, 0.15); color: #f87171; border: 1px solid rgba(248, 113, 113, 0.3); padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 10px; }
      
      .open-box { background: rgba(56, 189, 248, 0.08); border: 1px dashed rgba(56, 189, 248, 0.3); border-radius: 12px; padding: 12px; margin-bottom: 16px; }
      .open-title { font-size: 11px; font-weight: 700; color: #38bdf8; margin-bottom: 8px; display: flex; justify-content: space-between; }
      .open-item { display: inline-flex; align-items: center; gap: 8px; background: #131d31; border: 1px solid #22324e; padding: 4px 10px; border-radius: 6px; font-size: 11px; margin-right: 8px; margin-bottom: 4px; }
      
      .footer { display: flex; justify-content: space-between; align-items: center; font-size: 10px; color: #64748b; padding-top: 10px; border-top: 1px solid #22324e; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="top-header">
        <div class="brand">
          <span class="brand-icon">⚡</span>
          <div>
            <div class="brand-title">CRYPTO BOT FOLLOWER SCORECARD</div>
            <div style="font-size: 11px; color: #94a3b8;">Target Wallet: 3azG8rmt... · Headless AMM Router Proxy</div>
          </div>
        </div>
        <div class="meta-pills">
          <div class="pill pill-blue">PAPER SWAP QUOTE</div>
          <div class="pill pill-gray">${nowWib}</div>
        </div>
      </div>
      
      <div class="summary-grid">
        <!-- GROUP 1: AP NET 10% -->
        <div class="group-card">
          <div class="group-title-row">
            <span class="group-name">AP NET 10% (Target Likuidasi Pasti +10%)</span>
            <span class="group-tag tag-net10">PAPER ONLY</span>
          </div>
          <div class="kpi-row">
            <div class="kpi-box">
              <div class="kpi-title">Realized PnL</div>
              <div class="kpi-num val-green">+$${net10Pnl.toFixed(4)}</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-title">Win Rate</div>
              <div class="kpi-num val-cyan">${net10WinRate}%</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-title">Win / Loss</div>
              <div class="kpi-num">${net10Wins}W / ${net10Losses}L</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-title">Stake</div>
              <div class="kpi-num val-amber">$5.00</div>
            </div>
          </div>
          <table class="lane-subtable">
            <thead>
              <tr><th>Lane</th><th>Saldo</th><th>Trades</th><th>W/L</th><th>PnL</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>AP1-10%</strong> (Bundler)</td>
                <td>$${laneStats['s14_net10'].availableCash.toFixed(2)}</td>
                <td>${laneStats['s14_net10'].tradesCount}</td>
                <td>${laneStats['s14_net10'].wins}/${laneStats['s14_net10'].losses}</td>
                <td class="val-green">+$${laneStats['s14_net10'].pnl.toFixed(4)}</td>
              </tr>
              <tr>
                <td><strong>AP2-10%</strong> (+60s Grace)</td>
                <td>$${laneStats['s14_alpha_net10'].availableCash.toFixed(2)}</td>
                <td>${laneStats['s14_alpha_net10'].tradesCount}</td>
                <td>${laneStats['s14_alpha_net10'].wins}/${laneStats['s14_alpha_net10'].losses}</td>
                <td class="val-green">+$${laneStats['s14_alpha_net10'].pnl.toFixed(4)}</td>
              </tr>
              <tr>
                <td><strong>AP3-10%</strong> (Hoarding Def)</td>
                <td>$${laneStats['s14_beta_net10'].availableCash.toFixed(2)}</td>
                <td>${laneStats['s14_beta_net10'].tradesCount}</td>
                <td>${laneStats['s14_beta_net10'].wins}/${laneStats['s14_beta_net10'].losses}</td>
                <td class="val-green">+$${laneStats['s14_beta_net10'].pnl.toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- GROUP 2: AP STANDAR -->
        <div class="group-card">
          <div class="group-title-row">
            <span class="group-name">AP STANDAR (TP Bertahap 50%/100% & Wave Ride)</span>
            <span class="group-tag tag-std">MODAL $5</span>
          </div>
          <div class="kpi-row">
            <div class="kpi-box">
              <div class="kpi-title">Realized PnL</div>
              <div class="kpi-num val-green">+$${stdPnl.toFixed(4)}</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-title">Win Rate</div>
              <div class="kpi-num val-cyan">${stdWinRate}%</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-title">Win / Loss</div>
              <div class="kpi-num">${stdWins}W / ${stdLosses}L</div>
            </div>
            <div class="kpi-box">
              <div class="kpi-title">Open Pos</div>
              <div class="kpi-num val-amber">${allOpenPositions.length}</div>
            </div>
          </div>
          <table class="lane-subtable">
            <thead>
              <tr><th>Lane</th><th>Saldo</th><th>Trades</th><th>W/L</th><th>PnL</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>AP1</strong> (Wave Rider)</td>
                <td>$${laneStats['s14'].availableCash.toFixed(2)}</td>
                <td>${laneStats['s14'].tradesCount}</td>
                <td>${laneStats['s14'].wins}/${laneStats['s14'].losses}</td>
                <td class="val-green">+$${laneStats['s14'].pnl.toFixed(4)}</td>
              </tr>
              <tr>
                <td><strong>AP2</strong> (+60s Grace)</td>
                <td>$${laneStats['s14_alpha'].availableCash.toFixed(2)}</td>
                <td>${laneStats['s14_alpha'].tradesCount}</td>
                <td>${laneStats['s14_alpha'].wins}/${laneStats['s14_alpha'].losses}</td>
                <td class="val-green">+$${laneStats['s14_alpha'].pnl.toFixed(4)}</td>
              </tr>
              <tr>
                <td><strong>AP3</strong> (Hoarding Def)</td>
                <td>$${laneStats['s14_beta'].availableCash.toFixed(2)}</td>
                <td>${laneStats['s14_beta'].tradesCount}</td>
                <td>${laneStats['s14_beta'].wins}/${laneStats['s14_beta'].losses}</td>
                <td class="val-green">+$${laneStats['s14_beta'].pnl.toFixed(4)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      ${allOpenPositions.length ? `
      <!-- POSISI TERBUKA (FLOATING) -->
      <div class="open-box">
        <div class="open-title">
          <span>🚨 POSISI TERBUKA AKTIF (SEDANG FLOATING)</span>
          <span>${allOpenPositions.length} Posisi</span>
        </div>
        <div>
          ${allOpenPositions.map(p => `
            <div class="open-item">
              <span class="lane-badge badge-ap">${p.laneLabel}</span>
              <strong>${p.symbol}</strong>
              <span class="coin-badge">${p.mintPrefix}</span>
              <span>Modal: $${p.costBasisUsd}</span>
              <span class="${p.unrealizedPnlUsd >= 0 ? 'val-green' : 'val-red'}">
                Float: ${p.unrealizedPnlUsd >= 0 ? '+' : ''}$${p.unrealizedPnlUsd.toFixed(2)}
              </span>
              <span style="color: #64748b;">${formatWib(p.openedAt)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <!-- DETAIL KRONOLOGI TRANSAKSI TERAKHIR -->
      <div class="main-table-wrap">
        <div class="section-label">
          <span>📋 DETAIL KRONOLOGI TRANSAKSI TERAKHIR (VS AKSI WHALE)</span>
        </div>
        <table class="trade-table">
          <thead>
            <tr>
              <th>Token & Mint</th>
              <th>Lane</th>
              <th>Whale In</th>
              <th>Bundler</th>
              <th>Kita In</th>
              <th>Kita Out (Hold)</th>
              <th>Whale Dump</th>
              <th>Hasil Realized</th>
            </tr>
          </thead>
          <tbody>
            ${topTrades.map(t => `
              <tr>
                <td>
                  <strong>${t.symbol}</strong>
                  <span class="coin-badge">${t.mintPrefix}</span>
                </td>
                <td>
                  <span class="lane-badge ${t.type === 'NET10' ? 'badge-ap10' : 'badge-ap'}">${t.laneLabel}</span>
                </td>
                <td>
                  ${t.whaleInTime}<br>
                  <span style="color:#64748b; font-size:9px;">${t.whalePrice}</span>
                </td>
                <td>
                  <span class="val-amber">${t.bundlerRate}</span>
                </td>
                <td>
                  ${formatWib(t.openedAt)}
                </td>
                <td>
                  ${formatWib(t.closedAt)}<br>
                  <span style="color:#94a3b8; font-size:9px;">hold ${t.holdSeconds}</span>
                </td>
                <td>
                  ${t.whaleSellAllTime !== '-' ? `<span style="color:#f87171; font-weight:700;">${t.whaleSellAllTime} (ALL)</span>` : (t.whaleSellTime !== '-' ? `${t.whaleSellTime} (part)` : '-')}
                </td>
                <td>
                  <span class="${t.pnl >= 0 ? 'tag-win' : 'tag-loss'}">
                    ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(4)} (${t.roi >= 0 ? '+' : ''}${t.roi.toFixed(1)}%)
                  </span>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="footer">
        <span>* Kuotasi AMM riil on-chain via GMGN Route Proxy · Flat DEX gas fee $0.025/leg ($0.050 roundtrip)</span>
        <span>Auto-Buy Live: ⚪ DRY_RUN (OFF)</span>
      </div>
    </div>
  </body>
  </html>
  `;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage({
    viewport: { width: 980, height: 1200, deviceScaleFactor: 2 }
  });

  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: outPath, fullPage: true });
  await browser.close();

  console.log(`[SCORECARD_GENERATED_SUCCESS] Image saved to: ${outPath}`);
  console.log(`SUMMARY: Net10 PnL: +$${net10Pnl.toFixed(4)} (${net10Wins}W/${net10Losses}L) | Std PnL: +$${stdPnl.toFixed(4)} (${stdWins}W/${stdLosses}L)`);
}

main().catch(err => {
  console.error('[SCORECARD_ERROR]', err);
  process.exit(1);
});
