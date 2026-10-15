#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '/home/bbliong/project/crypto-bot';
const DATA_DIR = join(ROOT, 'data', 'profit4-watch');
const REPORT_DIR = join(ROOT, 'reports', 'lane-evaluations');
mkdirSync(REPORT_DIR, { recursive: true });

function loadRuns() {
  const dirs = readdirSync(DATA_DIR)
    .filter(d => d.startsWith('2026-'))
    .sort()
    .reverse();
  const runs = [];
  for (const d of dirs) {
    const p = join(DATA_DIR, d, 'profit4-state.json');
    if (existsSync(p)) {
      try {
        const state = JSON.parse(readFileSync(p, 'utf8'));
        runs.push({ id: d, state });
      } catch {}
    }
  }
  return runs;
}

export async function runEvaluation() {
  const runs = loadRuns();
  if (!runs.length) {
    console.log('Tidak ada data run yang ditemukan.');
    return;
  }

  const now = Date.now();
  const window30m = now - 30 * 60 * 1000;

  // Kumpulkan posisi dari run aktif dan terbaru
  const allPositions = [];
  const latestRun = runs[0];
  for (const r of runs.slice(0, 3)) {
    if (Array.isArray(r.state.positions)) {
      for (const p of r.state.positions) {
        allPositions.push({ ...p, runId: r.id });
      }
    }
  }

  const entered = allPositions.filter(p => p.entryAt != null);

  // Grouping per lane (Baseline + Varian Baru)
  const laneStats = {};
  const allLanes = new Set([
    'G1', 'G1.2', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7',
    'Safe', 'Opt', 'Wide', 'Swing', 'Wave', 'V2M', 'V3M',
    'S1', 'S2', 'S3', 'S4', 'S1.2', 'R5', 'R5.1'
  ]);

  for (const l of allLanes) {
    laneStats[l] = {
      label: l,
      total: 0,
      open: 0,
      closed: 0,
      wins: 0,
      losses: 0,
      pnlUsd: 0,
      rets: [],
      recentCount: 0,
      recentPnl: 0,
      recentWins: 0,
      rejections: {}
    };
  }

  entered.forEach(p => {
    const l = p.laneLabel || 'Unknown';
    if (!laneStats[l]) {
      laneStats[l] = { label: l, total: 0, open: 0, closed: 0, wins: 0, losses: 0, pnlUsd: 0, rets: [], recentCount: 0, recentPnl: 0, recentWins: 0, rejections: {} };
    }
    const s = laneStats[l];
    s.total++;
    if (p.phase === 'OPEN') s.open++;
    if (p.phase === 'CLOSED') {
      s.closed++;
      const ret = p.netReturnPercent || 0;
      const pnl = p.pnlUsd || 0;
      s.pnlUsd += pnl;
      s.rets.push(ret);
      if (ret > 0) s.wins++;
      else s.losses++;

      if ((p.exitAt || p.entryAt || 0) >= window30m) {
        s.recentCount++;
        s.recentPnl += pnl;
        if (ret > 0) s.recentWins++;
      }
    }
  });

  // Hitung rejection token per lane
  const unentered = (latestRun.state.positions || []).filter(p => p.entryAt == null);
  unentered.forEach(p => {
    const l = p.laneLabel || 'Unknown';
    if (laneStats[l]) {
      const reasons = p.lastDecision?.reasons || p.lastEvent?.reasons || [p.lastEvent?.reason || 'BLOCKED'];
      reasons.forEach(r => {
        if (r && !r.startsWith('STAIRCASE_OBSERVING')) {
          laneStats[l].rejections[r] = (laneStats[l].rejections[r] || 0) + 1;
        } else if (r && r.startsWith('STAIRCASE_OBSERVING')) {
          laneStats[l].rejections['OBSERVATION_120S_TOO_LONG'] = (laneStats[l].rejections['OBSERVATION_120S_TOO_LONG'] || 0) + 1;
        }
      });
    }
  });

  // Ranking data
  const statList = Object.values(laneStats);

  // 1. Diurutkan berdasarkan PnL (Paling Untung ➔ Terendah)
  const byProfit = [...statList]
    .filter(l => l.closed > 0)
    .sort((a, b) => b.pnlUsd - a.pnlUsd);

  // 2. Diurutkan berdasarkan Win Rate Tertinggi
  const byWinRate = [...statList]
    .filter(l => l.closed >= 3)
    .sort((a, b) => (b.wins / b.closed) - (a.wins / a.closed));

  // 3. Lane yang Merugi
  const lossLanes = [...statList]
    .filter(l => l.closed > 0 && l.pnlUsd < 0)
    .sort((a, b) => a.pnlUsd - b.pnlUsd);

  // 4. Lane Sepi (0 Entry)
  const starvedLanes = [...statList].filter(l => l.total === 0);

  // 5. Metrik 30 Menit Terakhir
  const recent30mPnl = statList.reduce((sum, l) => sum + l.recentPnl, 0);
  const recent30mTrades = statList.reduce((sum, l) => sum + l.recentCount, 0);
  const totalClosed = statList.reduce((sum, l) => sum + l.closed, 0);
  const totalOpen = statList.reduce((sum, l) => sum + l.open, 0);
  const totalPnl = statList.reduce((sum, l) => sum + l.pnlUsd, 0);
  const totalWins = statList.reduce((sum, l) => sum + l.wins, 0);
  const overallWinRate = totalClosed > 0 ? ((totalWins / totalClosed) * 100).toFixed(1) : '0.0';

  const nowWib = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  // Format Pesan Markdown
  let md = `📊 **LAPORAN EVALUASI PERFORMA LANE PROFIT4 (30 MENITAN)**\n`;
  md += `🕒 *Waktu Evaluasi*: ${nowWib} WIB\n`;
  md += `⏱️ *Kinerja 30 Menit Terakhir*: **${recent30mTrades} Trade** | PnL: **${recent30mPnl >= 0 ? '+' : ''}$${recent30mPnl.toFixed(2)} USD**\n`;
  md += `📈 *Akumulasi Total*: **${totalClosed} Trade Selesai** | **${totalOpen} Aktif** | Win Rate: **${overallWinRate}%** | Total PnL: **+$${totalPnl.toFixed(2)} USD**\n\n`;

  // Bagian 1: Diurutkan Berdasarkan Yang Paling Untung (PnL)
  md += `💰 **1. DIURUTKAN PALING UNTUNG (PnL Terbesar)**:\n`;
  const profitableLanes = byProfit.filter(l => l.pnlUsd > 0);
  if (profitableLanes.length) {
    profitableLanes.forEach((l, idx) => {
      const wr = ((l.wins / l.closed) * 100).toFixed(1);
      const avg = l.rets.length ? (l.rets.reduce((a,b)=>a+b,0)/l.rets.length).toFixed(1) : '0';
      md += `${idx + 1}. **Lane ${l.label}**: **+$${l.pnlUsd.toFixed(2)} USD** (${l.closed} trade | WR: **${wr}%** | avg: +${avg}%)\n`;
    });
  } else {
    md += `• *(Belum ada lane dengan profit)*\n`;
  }

  // Bagian 2: Diurutkan Berdasarkan Win Rate Tertinggi
  md += `\n🎯 **2. DIURUTKAN WIN RATE TERTINGGI (Min 3 Trade)**:\n`;
  if (byWinRate.length) {
    byWinRate.forEach((l, idx) => {
      const wr = ((l.wins / l.closed) * 100).toFixed(1);
      md += `${idx + 1}. **Lane ${l.label}**: Win Rate **${wr}%** (${l.wins} win / ${l.closed} trade | PnL: ${l.pnlUsd >= 0 ? '+' : ''}$${l.pnlUsd.toFixed(2)})\n`;
    });
  } else {
    md += `• *(Data sampel trade belum mencukupi)*\n`;
  }

  // Bagian 3: Diurutkan Berdasarkan Yang Merugi
  md += `\n⚠️ **3. DIURUTKAN YANG MERUGI (Loss Terbesar)**:\n`;
  if (lossLanes.length) {
    lossLanes.forEach((l, idx) => {
      const avg = l.rets.length ? (l.rets.reduce((a,b)=>a+b,0)/l.rets.length).toFixed(1) : '0';
      md += `${idx + 1}. **Lane ${l.label}**: **-$${Math.abs(l.pnlUsd).toFixed(2)} USD** (${l.losses} loss / ${l.closed} trade | avg: ${avg}%)\n`;
    });
  } else {
    md += `• *Nihil (Tidak ada lane yang mengalami kerugian)*\n`;
  }

  // Bagian 4: Head-to-Head Perbandingan Baseline vs Varian Baru
  md += `\n⚖️ **4. KOMPARASI HEAD-TO-HEAD (Baseline vs Varian Baru - Tidak Ditiban)**:\n`;
  const pairs = [
    { base: 'G1', variant: 'G1.2', name: 'Genesis Surge' },
    { base: 'S1', variant: 'S1.2', name: 'Staircase Fast' },
    { base: 'R5', variant: 'R5.1', name: 'Momentum Dynamic' }
  ];

  pairs.forEach(p => {
    const b = laneStats[p.base] || { closed: 0, pnlUsd: 0, wins: 0, open: 0 };
    const v = laneStats[p.variant] || { closed: 0, pnlUsd: 0, wins: 0, open: 0 };
    const bWr = b.closed ? ((b.wins / b.closed) * 100).toFixed(1) : '0';
    const vWr = v.closed ? ((v.wins / v.closed) * 100).toFixed(1) : '0';

    md += `• **${p.name}**:\n`;
    md += `  - Baseline **${p.base}**: ${b.closed} trade, WR ${bWr}%, PnL **${b.pnlUsd >= 0 ? '+' : ''}$${b.pnlUsd.toFixed(2)}**\n`;
    md += `  - Varian Baru **${p.variant}**: ${v.closed} trade (${v.open} aktif), WR ${vWr}%, PnL **${v.pnlUsd >= 0 ? '+' : ''}$${v.pnlUsd.toFixed(2)}**\n`;
  });

  // Bagian 5: Lane Sepi (0 Token Masuk) & Akar Masalah
  if (starvedLanes.length) {
    md += `\n🔍 **5. LANE SEPI (0 Token Masuk) & PENYEBAB**:\n`;
    starvedLanes.forEach(l => {
      const topRej = Object.entries(l.rejections).sort((a,b)=>b[1]-a[1]).slice(0, 1);
      const rej = topRej.length ? `${topRej[0][0]} (${topRej[0][1]}x)` : 'Menunggu kriteria trigger';
      md += `• **Lane ${l.label}**: 0 entry → *${rej}*\n`;
    });
  }

  md += `\n🔄 *Auto-tuning loop berjalan mandiri tiap 30m. Rekap akumulatif semalam disiapkan untuk review pagi besok.*`;

  // Simpan arsip
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = join(REPORT_DIR, `eval-${ts}.md`);
  writeFileSync(reportPath, md, 'utf8');

  console.log(md);
  return { reportPath, summary: md };
}

if (process.argv[1] && process.argv[1].endsWith('evaluate-and-tune-lanes.mjs')) {
  runEvaluation().catch(err => {
    console.error('Evaluasi gagal:', err);
    process.exit(1);
  });
}
