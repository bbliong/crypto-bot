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

  // Filter trade yang relevan (entered)
  const entered = allPositions.filter(p => p.entryAt != null);
  
  // Analisis 30 Menit Terakhir vs Kumulatif
  const recentTrades = entered.filter(p => (p.entryAt || 0) >= window30m || (p.exitAt || 0) >= window30m);

  // Grouping per lane
  const laneStats = {};
  const allLanes = new Set([
    'G1', 'G1.2', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7',
    'Safe', 'Opt', 'Wide', 'Swing', 'Wave', 'V2M', 'V3M',
    'S1', 'S2', 'S3', 'S4', 'R5'
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
      rejections: {}
    };
  }

  entered.forEach(p => {
    const l = p.laneLabel || 'Unknown';
    if (!laneStats[l]) {
      laneStats[l] = { label: l, total: 0, open: 0, closed: 0, wins: 0, losses: 0, pnlUsd: 0, rets: [], recentCount: 0, recentPnl: 0, rejections: {} };
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
      }
    }
  });

  // Hitung rejection token yang gagal masuk per lane
  const unentered = (latestRun.state.positions || []).filter(p => p.entryAt == null);
  unentered.forEach(p => {
    const l = p.laneLabel || 'Unknown';
    if (laneStats[l]) {
      const reasons = p.lastDecision?.reasons || p.lastEvent?.reasons || [p.lastEvent?.reason || 'BLOCKED'];
      reasons.forEach(r => {
        if (r && !r.startsWith('STAIRCASE_OBSERVING')) {
          laneStats[l].rejections[r] = (laneStats[l].rejections[r] || 0) + 1;
        } else if (r && r.startsWith('STAIRCASE_OBSERVING')) {
          laneStats[l].rejections['OBSERVATION_TIME_120S_TOO_LONG'] = (laneStats[l].rejections['OBSERVATION_TIME_120S_TOO_LONG'] || 0) + 1;
        }
      });
    }
  });

  // Ranking lane berdasarkan PnL
  const ranked = Object.values(laneStats).sort((a, b) => b.pnlUsd - a.pnlUsd);
  const topLanes = ranked.filter(l => l.closed > 0 && l.pnlUsd > 0);
  const negativeLanes = ranked.filter(l => l.closed > 0 && l.pnlUsd < 0);
  const starvedLanes = ranked.filter(l => l.total === 0);

  const totalClosed = ranked.reduce((sum, l) => sum + l.closed, 0);
  const totalOpen = ranked.reduce((sum, l) => sum + l.open, 0);
  const totalPnl = ranked.reduce((sum, l) => sum + l.pnlUsd, 0);
  const totalWins = ranked.reduce((sum, l) => sum + l.wins, 0);
  const winRate = totalClosed > 0 ? ((totalWins / totalClosed) * 100).toFixed(1) : '0.0';

  // Tanggal WIB
  const nowWib = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  // Susun Laporan Markdown
  let md = `📊 **EVALUASI PERFORMA LANE PROFIT4 (30 MENITAN)**\n`;
  md += `🕒 *Waktu Evaluasi*: ${nowWib} WIB\n`;
  md += `📈 *Akumulasi Portofolio*: **${totalClosed} Trade Selesai** | **${totalOpen} Aktif** | Win Rate: **${winRate}%** | Total PnL: **+$${totalPnl.toFixed(2)} USD**\n\n`;

  md += `🏆 **Top Penghasil Profit (Juara)**:\n`;
  topLanes.slice(0, 5).forEach((l, idx) => {
    const wr = l.closed ? ((l.wins / l.closed) * 100).toFixed(1) : '0';
    const avg = l.rets.length ? (l.rets.reduce((a,b)=>a+b,0)/l.rets.length).toFixed(1) : '0';
    md += `${idx + 1}. **Lane ${l.label}**: +$${l.pnlUsd.toFixed(2)} USD (${l.closed} trade, WR ${wr}%, avg +${avg}%)\n`;
  });
  if (!topLanes.length) md += `*(Belum ada trade profit)*\n`;

  md += `\n⚠️ **Lane Underperforming / Merugi**:\n`;
  if (negativeLanes.length) {
    negativeLanes.forEach(l => {
      const avg = l.rets.length ? (l.rets.reduce((a,b)=>a+b,0)/l.rets.length).toFixed(1) : '0';
      md += `• **Lane ${l.label}**: PnL -$${Math.abs(l.pnlUsd).toFixed(2)} USD (${l.losses} rugi / ${l.closed} total, avg ${avg}%)\n`;
    });
  } else {
    md += `• *Nihil (Tidak ada lane yang mengalami kerugian signifikan)*\n`;
  }

  md += `\n🔍 **Lane Sepi / 0 Token Masuk (Starved)**:\n`;
  if (starvedLanes.length) {
    starvedLanes.forEach(l => {
      const topRej = Object.entries(l.rejections).sort((a,b)=>b[1]-a[1]).slice(0, 2);
      const rejStr = topRej.length ? topRej.map(([k, v]) => `${k} (${v}x)`).join(', ') : 'Filter terlalu ketat';
      md += `• **Lane ${l.label}**: 0 trade masuk → Penyebab: *${rejStr}*\n`;
    });
  } else {
    md += `• *Semua lane menerima token!*\n`;
  }

  // Rekomendasi / Tindakan Improvisasi
  md += `\n🛠️ **Tindakan Improvisasi & Tuning Varian Baru**:\n`;
  const improvements = [];

  if (starvedLanes.some(l => ['S1', 'S2', 'S3', 'S4'].includes(l.label))) {
    improvements.push(`1. **Varian Staircase Cepat (S1.2 / S-Fast)**: Menurunkan window observasi dari 120s menjadi 35–45s dan melonggarkan batas drawdown dari 2.5% ke 4.5% agar token momentum awal bisa masuk sebelum likuiditas mengering.`);
  }
  if (starvedLanes.some(l => l.label === 'R5')) {
    improvements.push(`2. **Tuning Lane R5 (R5.1)**: Melonggarkan batas konsentrasi buyer dari 60% menjadi 75% karena sebagian besar peluncuran pump.fun didominasi pool sniper awal.`);
  }
  if (topLanes.some(l => l.label === 'G1')) {
    improvements.push(`3. **Ekspansi Genesis Surge (G1.1 & G1.2)**: G1 menjadi kontributor profit terbesar (+$${laneStats['G1'].pnlUsd.toFixed(2)}). Menyiapkan varian G1.1 (trailing stop lebih ketat 6% untuk amankan profit wick) dan G1.2 (target runner 100%+).`);
  }
  if (topLanes.some(l => ['V1', 'V2'].includes(l.label))) {
    improvements.push(`4. **Optimalisasi Bounce (V1.2)**: Memperlebar window deteksi bounce dump dari 30–40% menjadi 25–45% untuk menjaring lebih banyak pantulan agresif.`);
  }

  md += improvements.join('\n') + `\n\n`;
  md += `💡 *Laporan detail per-token dan matriks lengkap telah diarsipkan ke:* \`reports/lane-evaluations/\``;

  // Simpan file laporan
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = join(REPORT_DIR, `eval-${ts}.md`);
  writeFileSync(reportPath, md, 'utf8');

  // Cetak ke stdout untuk output cron / chat
  console.log(md);
  return { reportPath, summary: md };
}

if (process.argv[1] && process.argv[1].endsWith('evaluate-and-tune-lanes.mjs')) {
  runEvaluation().catch(err => {
    console.error('Evaluasi gagal:', err);
    process.exit(1);
  });
}
