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
    'G1', 'G1.2', 'G2', 'G2.1', 'G2.2', 'OZ1', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7',
    'Safe', 'Opt', 'Wide', 'Swing', 'Wave', 'V2M', 'V3M',
    'S1', 'S2', 'S3', 'S4', 'S1.2', 'S5', 'R5', 'R5.1'
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
      recentClosed: 0,
      recentWins: 0,
      recentLosses: 0,
      recentPnl: 0,
      recentRets: [],
      rejections: {}
    };
  }

  let anomalyCount = 0;
  entered.forEach(p => {
    const l = p.laneLabel || 'Unknown';
    if (!laneStats[l]) {
      laneStats[l] = { 
        label: l, 
        total: 0, 
        open: 0, 
        closed: 0, 
        wins: 0, 
        losses: 0, 
        pnlUsd: 0, 
        rets: [], 
        // 30 menit terakhir saja
        recentClosed: 0, 
        recentWins: 0, 
        recentLosses: 0,
        recentPnl: 0, 
        recentRets: [],
        rejections: {} 
      };
    }
    const s = laneStats[l];
    s.total++;
    if (p.phase === 'OPEN') s.open++;
    if (p.phase === 'CLOSED') {
      const entryPrice = p.entryPrice;
      const exitPrice = p.exitPrice;
      const ret = p.netReturnPercent || 0;
      const pnl = p.pnlUsd || 0;

      // Filter anomali glitch desimal harga (< 0.000001 atau return > 300% pada TP normal 25-80%)
      if ((entryPrice != null && entryPrice < 0.000001) || (exitPrice != null && exitPrice < 0.000001) || ret > 300) {
        anomalyCount++;
        return;
      }

      // Kumulatif
      s.closed++;
      s.pnlUsd += pnl;
      s.rets.push(ret);
      if (ret > 0) s.wins++;
      else s.losses++;

      // Khusus jendela 30 menit terakhir
      const exitTime = p.exitAt || p.entryAt || 0;
      if (exitTime >= window30m) {
        s.recentClosed++;
        s.recentPnl += pnl;
        s.recentRets.push(ret);
        if (ret > 0) s.recentWins++;
        else s.recentLosses++;
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

  // Ranking data khusus 30 MENIT TERAKHIR
  const statList = Object.values(laneStats);

  // 1. Diurutkan berdasarkan PnL 30 Menit (Paling Untung ➔ Terendah)
  const byProfit30m = [...statList]
    .filter(l => l.recentClosed > 0)
    .sort((a, b) => b.recentPnl - a.recentPnl);

  // 2. Diurutkan berdasarkan Win Rate Tertinggi 30 Menit
  const byWinRate30m = [...statList]
    .filter(l => l.recentClosed >= 3)
    .sort((a, b) => (b.recentWins / b.recentClosed) - (a.recentWins / a.recentClosed));

  // 3. Lane yang Merugi 30 Menit
  const lossLanes30m = [...statList]
    .filter(l => l.recentClosed > 0 && l.recentPnl < 0)
    .sort((a, b) => a.recentPnl - b.recentPnl);

  // 4. Lane Sepi / Tidak Ada Aktivitas 30 Menit
  const starvedLanes = [...statList].filter(l => l.recentClosed === 0);

  // 5. Metrik Total 30 Menit Terakhir
  const recent30mPnl = statList.reduce((sum, l) => sum + l.recentPnl, 0);
  const recent30mTrades = statList.reduce((sum, l) => sum + l.recentClosed, 0);
  const recent30mWins = statList.reduce((sum, l) => sum + l.recentWins, 0);
  const recent30mWinRate = recent30mTrades > 0 ? ((recent30mWins / recent30mTrades) * 100).toFixed(1) : '0.0';

  const totalClosed = statList.reduce((sum, l) => sum + l.closed, 0);
  const totalOpen = statList.reduce((sum, l) => sum + l.open, 0);
  const totalPnl = statList.reduce((sum, l) => sum + l.pnlUsd, 0);

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
  let md = `📊 **LAPORAN PERFORMA LANE PROFIT4 (MURNI 30 MENIT TERAKHIR)**\n`;
  md += `🕒 *Waktu Evaluasi*: ${nowWib} WIB (Jendela: 30 menit ke belakang)\n`;
  if (anomalyCount > 0) {
    md += `🛡️ *Filter Glitch*: **${anomalyCount} trade anomali dibersihkan** (harga < $0.000001 diabaikan)\n`;
  }
  md += `⏱️ *Hasil 30 Menit Ini*: **${recent30mTrades} Trade** | Win Rate: **${recent30mWinRate}%** | PnL: **${recent30mPnl >= 0 ? '+' : ''}$${recent30mPnl.toFixed(2)} USD**\n`;
  md += `📈 *Akumulasi Riil Sejak Mulai*: ${totalClosed} Trade Selesai | ${totalOpen} Aktif | Total PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} USD\n\n`;

  // Bagian 1: Diurutkan Berdasarkan Yang Paling Untung (PnL 30 Menit)
  md += `💰 **1. DIURUTKAN PALING UNTUNG (30 Menit Terakhir)**:\n`;
  const profitableLanes = byProfit30m.filter(l => l.recentPnl > 0);
  if (profitableLanes.length) {
    profitableLanes.forEach((l, idx) => {
      const wr = ((l.recentWins / l.recentClosed) * 100).toFixed(1);
      const avg = l.recentRets.length ? (l.recentRets.reduce((a,b)=>a+b,0)/l.recentRets.length).toFixed(1) : '0';
      md += `${idx + 1}. **Lane ${l.label}**: **+$${l.recentPnl.toFixed(2)} USD** (${l.recentClosed} trade | WR: **${wr}%** | avg: +${avg}%)\n`;
    });
  } else {
    md += `• *(Tidak ada lane profit dalam 30 menit terakhir)*\n`;
  }

  // Bagian 2: Diurutkan Berdasarkan Win Rate Tertinggi (30 Menit)
  md += `\n🎯 **2. DIURUTKAN WIN RATE TERTINGGI (Min 3 Trade - 30 Menit Terakhir)**:\n`;
  if (byWinRate30m.length) {
    byWinRate30m.forEach((l, idx) => {
      const wr = ((l.recentWins / l.recentClosed) * 100).toFixed(1);
      md += `${idx + 1}. **Lane ${l.label}**: Win Rate **${wr}%** (${l.recentWins}W / ${l.recentLosses}L dari ${l.recentClosed} trade | PnL: ${l.recentPnl >= 0 ? '+' : ''}$${l.recentPnl.toFixed(2)})\n`;
    });
  } else {
    md += `• *(Data sampel trade belum mencukupi min 3 trade)*\n`;
  }

  // Bagian 3: Diurutkan Berdasarkan Yang Merugi (30 Menit)
  md += `\n⚠️ **3. DIURUTKAN YANG MERUGI (Loss Terbesar - 30 Menit Terakhir)**:\n`;
  if (lossLanes30m.length) {
    lossLanes30m.forEach((l, idx) => {
      const avg = l.recentRets.length ? (l.recentRets.reduce((a,b)=>a+b,0)/l.recentRets.length).toFixed(1) : '0';
      md += `${idx + 1}. **Lane ${l.label}**: **-$${Math.abs(l.recentPnl).toFixed(2)} USD** (${l.recentLosses} loss / ${l.recentClosed} trade | avg: ${avg}%)\n`;
    });
  } else {
    md += `• *Nihil (Tidak ada lane yang merugi dalam 30 menit terakhir)*\n`;
  }

  // Bagian 4: Head-to-Head Perbandingan Baseline vs Varian Baru (30 Menit)
  md += `\n⚖️ **4. KOMPARASI HEAD-TO-HEAD (30 Menit Terakhir)**:\n`;
  const pairs = [
    { base: 'G1', variant: 'G1.2', name: 'Genesis Surge (G1 vs G1.2 Sunset)' },
    { base: 'G2', variant: 'G2.1', name: 'Smart Money (G2 Conv vs G2.1 Single Whale)' },
    { base: 'G2', variant: 'G2.2', name: 'Smart Money (G2 Conv vs G2.2 Multi-Whale)' },
    { base: 'S1', variant: 'S1.2', name: 'Staircase Fast (S1 vs S1.2)' },
    { base: 'S1', variant: 'S5', name: 'Staircase Tier4 Pre-Dump Rider (S1 vs S5)' },
    { base: 'R5', variant: 'R5.1', name: 'Momentum Dynamic (R5 vs R5.1)' }
  ];

  pairs.forEach(p => {
    const b = laneStats[p.base] || { recentClosed: 0, recentPnl: 0, recentWins: 0, open: 0 };
    const v = laneStats[p.variant] || { recentClosed: 0, recentPnl: 0, recentWins: 0, open: 0 };
    const bWr = b.recentClosed ? ((b.recentWins / b.recentClosed) * 100).toFixed(1) : '0';
    const vWr = v.recentClosed ? ((v.recentWins / v.recentClosed) * 100).toFixed(1) : '0';

    md += `• **${p.name}**:\n`;
    md += `  - Baseline **${p.base}**: ${b.recentClosed} trade, WR ${bWr}%, PnL **${b.recentPnl >= 0 ? '+' : ''}$${b.recentPnl.toFixed(2)}**\n`;
    md += `  - Varian Baru **${p.variant}**: ${v.recentClosed} trade (${v.open} aktif), WR ${vWr}%, PnL **${v.recentPnl >= 0 ? '+' : ''}$${v.recentPnl.toFixed(2)}**\n`;
  });

  // Bagian 5: Lane Sepi (0 Token Masuk dalam 30 Menit) & Akar Masalah
  if (starvedLanes.length) {
    md += `\n🔍 **5. LANE SEPI (0 Trade Masuk 30 Menit Ini)**:\n`;
    starvedLanes.forEach(l => {
      const topRej = Object.entries(l.rejections).sort((a,b)=>b[1]-a[1]).slice(0, 1);
      const rej = topRej.length ? `${topRej[0][0]} (${topRej[0][1]}x)` : 'Menunggu kriteria trigger';
      md += `• **Lane ${l.label}**: 0 entry 30m → *${rej}*\n`;
    });
  }

  md += `\n🔄 *Evaluator berjalan otomatis tiap 30 menit. Review harian semalam dikirim pukul 07:00 WIB.*`;

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
