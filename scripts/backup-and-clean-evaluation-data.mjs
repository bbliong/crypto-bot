import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';

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

  // Reset dryrun-3scenarios-live.json using complete fresh scenarios from MultiScenarioDryRunEngine
  const tmpScratch = mkdtempSync(join(tmpdir(), 'fresh-dryrun-'));
  const engine = new MultiScenarioDryRunEngine(tmpScratch);
  const freshScenarios = engine.scenarios;
  writeFileSync(join(dataDir, 'dryrun-3scenarios-live.json'), JSON.stringify(freshScenarios, null, 2), 'utf8');
  rmSync(tmpScratch, { recursive: true, force: true });

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
