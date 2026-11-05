import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');

function getTimestamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_${hh}${min}${ss}`;
}

const filesToBackup = [
  'dryrun-3scenarios-live.json',
  'follower-real-ledger.jsonl',
  'follower-real-state.json',
  'wallet-follower-events.json',
  'wallet-follower-positions.json',
  'wallet-follower-trades.json',
  'smart-dip-events.json',
  'smart-dip-positions.json',
  'smart-dip-trades.json',
  'follower-autobuy-settings.json'
];

async function main() {
  const ts = getTimestamp();
  const backupDirName = `backup-evaluation-${ts}`;
  const backupPath = join(dataDir, backupDirName);

  console.log(`📦 [BACKUP] Membuat folder backup di: ${backupPath}...`);
  mkdirSync(backupPath, { recursive: true });

  const backupReport = [];

  for (const filename of filesToBackup) {
    const src = join(dataDir, filename);
    if (existsSync(src)) {
      const dest = join(backupPath, filename);
      copyFileSync(src, dest);
      const sz = statSync(dest).size;
      const szKb = (sz / 1024).toFixed(1);
      backupReport.push({ file: filename, size: `${szKb} KB` });
    }
  }

  console.log('✅ File berhasil di-backup:');
  backupReport.forEach(r => console.log(`   - ${r.file.padEnd(30)} : ${r.size}`));

  // 2. Bersihkan file untuk evaluasi baru
  console.log('\n🧹 [CLEAN] Mengosongkan data aktif untuk evaluasi fresh...');

  // Reset dryrun-3scenarios-live.json
  let s4Stake = 0.25;
  let s5Stake = 1.0;
  let s6Pool1 = 5.0;
  let s6Pool2 = 7.0;
  let s7Pool1 = 1.0;
  let s7Pool2 = 2.0;
  let s8Stake = 0.25;
  try {
    const s = JSON.parse(readFileSync(join(dataDir, 'follower-autobuy-settings.json'), 'utf8'));
    if (s.stakeUsdS4) s4Stake = Number(s.stakeUsdS4);
    if (s.stakeUsdS5) s5Stake = Number(s.stakeUsdS5);
    if (s.stakeUsdS6Pool1) s6Pool1 = Number(s.stakeUsdS6Pool1);
    if (s.stakeUsdS6Pool2) s6Pool2 = Number(s.stakeUsdS6Pool2);
    if (s.stakeUsdS7Pool1) s7Pool1 = Number(s.stakeUsdS7Pool1);
    if (s.stakeUsdS7Pool2) s7Pool2 = Number(s.stakeUsdS7Pool2);
    if (s.stakeUsdS8) s8Stake = Number(s.stakeUsdS8);
  } catch {}

  const freshScenarios = {
    s4: {
      id: 'SCENARIO_4_SINGLE_BUY_5USD',
      name: `Skenario 4: Single Buy $${s4Stake.toFixed(2)} (Hanya 1x Buy)`,
      description: `Saldo Awal $20.00. Hanya 1x Buy $${s4Stake.toFixed(2)} saat First Buy (Tanpa akumulasi). Akumulasi Sell >= 15% -> Full Exit 100%.`,
      initialCash: 20.0,
      availableCash: 20.0,
      investedCash: 0.0,
      totalFeesPaid: 0.0,
      realizedPnl: 0.0,
      unrealizedPnl: 0.0,
      totalPortfolioValue: 20.0,
      wins: 0,
      losses: 0,
      totalTrades: 0,
      winRate: 0.0,
      openPositions: [],
      closedTrades: [],
      recentEvents: [],
    },
    s5: {
      id: 'SCENARIO_5_ANTI_SHAKEOUT_RUNNER',
      name: `Skenario 5: Anti-Shakeout Runner (TP +25% | Hold >= 12s | Time-Stop 35s)`,
      description: `Saldo Awal $20.00. Modal $${s5Stake.toFixed(2)}. Abaikan goyangan dump target di 12 detik pertama (Anti-Shakeout). Auto Take-Profit +25%, Time-Stop 35s, atau ikuti sell target jika dump pasca detik 12.`,
      initialCash: 20.0,
      availableCash: 20.0,
      investedCash: 0.0,
      totalFeesPaid: 0.0,
      realizedPnl: 0.0,
      unrealizedPnl: 0.0,
      totalPortfolioValue: 20.0,
      wins: 0,
      losses: 0,
      totalTrades: 0,
      winRate: 0.0,
      openPositions: [],
      closedTrades: [],
      recentEvents: [],
    },
    s6: {
      id: 'SCENARIO_6_REDEPLOY_SNIPER',
      name: `Skenario 6: Re-Deploy Sniper V2 (Split TP 50/50: 5% & 15%)`,
      description: `Saldo Awal $20.00. Pool 1: $${s6Pool1.toFixed(2)} flat, Pool 2+: $${s6Pool2.toFixed(2)} flat (Strict 1x Buy). Stage 1: TP 50% di >= 5% (Kunci Modal & Anti-Rug). Stage 2: 50% Tahan >= 15% (Mega Runner).`,
      initialCash: 20.0,
      availableCash: 20.0,
      investedCash: 0.0,
      totalFeesPaid: 0.0,
      realizedPnl: 0.0,
      unrealizedPnl: 0.0,
      totalPortfolioValue: 20.0,
      wins: 0,
      losses: 0,
      totalTrades: 0,
      winRate: 0.0,
      openPositions: [],
      closedTrades: [],
      recentEvents: [],
    },
    s7: {
      id: 'SCENARIO_7_TIME_STOP_SNIPER',
      name: 'Skenario 7: Time-Stop Sniper (Stage 1 @ 5% + Force Sell @ 28s)',
      description: `Saldo Awal $20.00. Pool 1: $${s7Pool1.toFixed(2)}, Pool 2+: $${s7Pool2.toFixed(2)}. Stage 1: TP 50% di >= 5% Anti-Rug. Stage 2: Kejar >= 15% ATAU Force Sell 100% tepat di Detik 28 (Puncak Pump) sebelum dev rugpull.`,
      initialCash: 20.0,
      availableCash: 20.0,
      investedCash: 0.0,
      totalFeesPaid: 0.0,
      realizedPnl: 0.0,
      unrealizedPnl: 0.0,
      totalPortfolioValue: 20.0,
      wins: 0,
      losses: 0,
      totalTrades: 0,
      winRate: 0.0,
      openPositions: [],
      closedTrades: [],
      recentEvents: [],
    },
    s8: {
      id: 'SCENARIO_8_FRONTRUN_DEV',
      name: `Skenario 8: Front-Run Dev Floor & Hold 20s Post-Target ($${s8Stake.toFixed(2)})`,
      description: `Saldo Awal $20.00. Stake $${s8Stake.toFixed(2)} di Detik 0 lantai Dev Meteora DAMM v2. Tahan 20 detik pasca target whale masuk (TIME_STOP_20S_POST_TARGET_ENTRY) atau safety exit jika target dump >= 15%.`,
      initialCash: 20.0,
      availableCash: 20.0,
      investedCash: 0.0,
      totalFeesPaid: 0.0,
      realizedPnl: 0.0,
      unrealizedPnl: 0.0,
      totalPortfolioValue: 20.0,
      wins: 0,
      losses: 0,
      totalTrades: 0,
      winRate: 0.0,
      openPositions: [],
      closedTrades: [],
      recentEvents: [],
    }
  };
  writeFileSync(join(dataDir, 'dryrun-3scenarios-live.json'), JSON.stringify(freshScenarios, null, 2), 'utf8');

  // Reset follower-real-ledger.jsonl (0 bytes)
  writeFileSync(join(dataDir, 'follower-real-ledger.jsonl'), '', 'utf8');

  // Reset wallet-follower & smart-dip arrays
  writeFileSync(join(dataDir, 'wallet-follower-events.json'), '[]', 'utf8');
  writeFileSync(join(dataDir, 'wallet-follower-positions.json'), '[]', 'utf8');
  writeFileSync(join(dataDir, 'wallet-follower-trades.json'), '[]', 'utf8');
  writeFileSync(join(dataDir, 'smart-dip-events.json'), '[]', 'utf8');
  writeFileSync(join(dataDir, 'smart-dip-positions.json'), '[]', 'utf8');
  writeFileSync(join(dataDir, 'smart-dip-trades.json'), '[]', 'utf8');

  // Reset follower-real-state.json (pertahankan readiness wallet)
  const stateFile = join(dataDir, 'follower-real-state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8'));
      state.positions = [];
      state.updatedAt = Date.now();
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }

  console.log('✅ Semua data aktif berhasil di-reset ke kondisi bersih awal ($20.00 cash pool per skenario, 0 trades, 0 open positions).');
  console.log(`📁 Lokasi Backup Tersimpan: data/${backupDirName}`);
}

main().catch(err => {
  console.error('❌ Gagal backup & clean:', err);
  process.exit(1);
});
