#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { getWibSlot, syncSingleRunToSqlite } from './crypto-db.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

function parseArgs() {
  const rawArgs = process.argv.slice(2);
  const defaultProfileDir = existsSync(join(projectRoot, 'profiles/research-vps'))
    ? 'profiles/research-vps'
    : 'profiles/research-aria-tele01';
  const defaultProfileName = defaultProfileDir === 'profiles/research-vps' ? 'Default' : 'Profile 12';

  const autoBuyCfgFile = join(projectRoot, 'config/autobuy-settings.json');
  let configStake = '0.5';
  if (existsSync(autoBuyCfgFile)) {
    try {
      const cfg = JSON.parse(readFileSync(autoBuyCfgFile, 'utf8'));
      if (cfg.stakeUsd) configStake = String(cfg.stakeUsd);
    } catch {}
  }

  const options = {
    workers: '2',
    seconds: '0',
    detailSeconds: '90',
    slotHours: '3',
    stakeUsd: configStake,
    profileDir: defaultProfileDir,
    profileName: defaultProfileName,
    output: null,
    onlyLane: null,
    quoteSimulation: true,
    simulateOrder: true,
    orderCapturePayloads: true,
    passThrough: [],
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--workers' && rawArgs[i + 1]) {
      options.workers = rawArgs[++i];
    } else if (arg.startsWith('--workers=')) {
      options.workers = arg.split('=')[1];
    } else if (arg === '--seconds' && rawArgs[i + 1]) {
      options.seconds = rawArgs[++i];
    } else if (arg.startsWith('--seconds=')) {
      options.seconds = arg.split('=')[1];
    } else if (arg === '--detailSeconds' && rawArgs[i + 1]) {
      options.detailSeconds = rawArgs[++i];
    } else if (arg.startsWith('--detailSeconds=')) {
      options.detailSeconds = arg.split('=')[1];
    } else if (arg === '--slotHours' && rawArgs[i + 1]) {
      options.slotHours = rawArgs[++i];
    } else if (arg.startsWith('--slotHours=')) {
      options.slotHours = arg.split('=')[1];
    } else if (arg === '--stakeUsd' && rawArgs[i + 1]) {
      options.stakeUsd = rawArgs[++i];
    } else if (arg.startsWith('--stakeUsd=')) {
      options.stakeUsd = arg.split('=')[1];
    } else if (arg === '--profileDir' && rawArgs[i + 1]) {
      options.profileDir = rawArgs[++i];
    } else if (arg.startsWith('--profileDir=')) {
      options.profileDir = arg.split('=')[1];
    } else if (arg === '--profileName' && rawArgs[i + 1]) {
      options.profileName = rawArgs[++i];
    } else if (arg.startsWith('--profileName=')) {
      options.profileName = arg.split('=')[1];
    } else if (arg === '--output' && rawArgs[i + 1]) {
      options.output = rawArgs[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    } else if ((arg === '--onlyLane' || arg === '--lane') && rawArgs[i + 1]) {
      options.onlyLane = rawArgs[++i];
    } else if (arg.startsWith('--onlyLane=')) {
      options.onlyLane = arg.split('=')[1];
    } else if (arg.startsWith('--lane=')) {
      options.onlyLane = arg.split('=')[1];
    } else {
      options.passThrough.push(arg);
    }
  }

  return options;
}

const opts = parseArgs();

let isShuttingDown = false;
let currentChild = null;

function handleExit(signal) {
  console.log(`\n[AGY Aggressive Supervisor] Received ${signal}. Shutting down current session gracefully...`);
  isShuttingDown = true;
  if (currentChild && !currentChild.killed) {
    currentChild.kill(signal);
  }
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

async function startSupervisor() {
  while (!isShuttingDown) {
    const slot = getWibSlot(new Date(), Number(opts.slotHours || 3));
    const outputDir = opts.output || slot.folderName;
    const fullOutputDir = join(projectRoot, outputDir);
    if (!existsSync(fullOutputDir)) {
      mkdirSync(fullOutputDir, { recursive: true });
    }

    const isResuming = existsSync(join(fullOutputDir, 'manifest.json'));

    console.log('=============================================================================');
    console.log('         🚀 AGY AGGRESSIVE 3-HOUR WINDOW SUPERVISOR 🚀                       ');
    console.log('=============================================================================');
    console.log(` Sesi Window      : ${slot.friendlyLabel}`);
    console.log(` Window Dimulai   : ${new Date(slot.slotStartUtcMs).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
    console.log(` Window Berakhir  : ${new Date(slot.slotEndUtcMs).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
    console.log(` Sisa Waktu Sesi  : ${Math.round(slot.remainingSeconds / 60)} menit`);
    console.log(` Status Sesi      : ${isResuming ? '🔄 MELANJUTKAN SESI YANG SAMA (TIDAK MEMBUAT BARU)' : '🆕 MEMULAI SESI BARU'}`);
    console.log(` Output Folder    : ${outputDir}`);
    console.log(` Parallel Workers : ${opts.workers} workers`);
    console.log(` Detail Window    : ${opts.detailSeconds}s per token`);
    console.log(` Stake USD        : $${opts.stakeUsd}`);
    console.log(` Profile Dir      : ${opts.profileDir} (${opts.profileName})`);
    console.log(` Active Lane Filter: ${opts.onlyLane ? `🎯 ${opts.onlyLane.toUpperCase()} ONLY` : 'ALL LANES (8-Lane Parallel)'}`);
    console.log('-----------------------------------------------------------------------------');
    console.log(' Parallel Plans Active (8-Lane Comparison):');
    console.log('   🟢 Safe | 🟣 Optimal | 🟠 Wide | 🌊 Swing 100k | ⚡ Wave Scalper | 🔵 Momentum V2 | ✨ Momentum V3 | 🟡 R5 Band');
    console.log(' Validasi Auto-Archive 3 Jam:');
    console.log('   • Hentikan pengambilan detail baru saat window selesai');
    console.log('   • Tuntas pemantauan token aktif & posisi terbuka sebelum arsip');
    console.log('   • Pause buy order baru dan tunggu order in-flight selesai');
    console.log('   • Auto-sync ke database SQLite saat sesi berganti');
    console.log('-----------------------------------------------------------------------------');
    console.log(' 📊 Dashboard: Run "npm run dashboard:aggressive" -> http://localhost:4180');
    console.log('=============================================================================\n');

    const commandArgs = [
      'scripts/run.mjs',
      'research',
      '--strategy', 'momentum-aggressive',
      '--workers', opts.workers,
      '--seconds', opts.seconds,
      '--sessionSlotEndMs', String(slot.slotEndUtcMs),
      '--detailSeconds', opts.detailSeconds,
      '--stakeUsd', opts.stakeUsd,
      '--profileDir', opts.profileDir,
      '--profileName', opts.profileName,
      '--output', outputDir,
      '--simulateOrder',
      '--quoteSimulation',
      '--browserAutoTrade',
      '--orderOutcomeCapture',
      '--orderCapturePayloads',
      ...(opts.onlyLane ? ['--onlyLane', opts.onlyLane] : []),
      ...opts.passThrough,
    ];

    const exitCode = await new Promise(resolve => {
      currentChild = spawn(process.execPath, commandArgs, {
        cwd: projectRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          AGGRESSIVE_RUN_FOLDER: outputDir,
        },
      });

      currentChild.on('close', code => {
        currentChild = null;
        resolve(code ?? 0);
      });
    });

    console.log(`\n[Supervisor] Sesi ${slot.friendlyLabel} selesai dengan exit code: ${exitCode}`);

    // Auto-sync SQLite
    try {
      const syncResult = syncSingleRunToSqlite(fullOutputDir);
      console.log(`[Supervisor] ✅ Auto-archive SQLite berhasil untuk ${outputDir}:`, syncResult);
    } catch (err) {
      console.error('[Supervisor] ❌ Gagal auto-archive SQLite:', err);
    }

    if (isShuttingDown || opts.output || opts.seconds !== '0') {
      break;
    }

    console.log(`[Supervisor] ⏳ Bersiap beralih ke slot 3 jam berikutnya dalam 3 detik...\n`);
    await new Promise(r => setTimeout(r, 3000));
  }

  console.log('[Supervisor] Supervisor selesai.');
  process.exit(0);
}

startSupervisor().catch(err => {
  console.error('[Supervisor Fatal Error]:', err);
  process.exit(1);
});
