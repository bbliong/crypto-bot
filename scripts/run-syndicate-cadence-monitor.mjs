#!/usr/bin/env -S node --import tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { HeliusScheduledCollector } from '../src/helius-scheduled-collector.js';
import { SyndicateWalletSelector } from '../src/syndicate-wallet-selector.js';
import { GmgnWalletInflowMonitor } from '../src/gmgn-wallet-inflow-monitor.js';
import { SyndicateDetailLaneWatcher } from '../src/syndicate-detail-lane-watcher.js';
import { SyndicateSqliteStorage } from '../src/storage/syndicate-sqlite.js';
import { HeliusDeployerStream } from '../src/helius-deployer-stream.js';

const rootDir = '/home/bbliong/project/crypto-bot';
const dataDir = path.join(rootDir, 'data', 'syndicate-watch');
mkdirSync(dataDir, { recursive: true });

const controlFile = path.join(dataDir, 'cadence-control.json');
const stopFile = path.join(dataDir, 'stop-request.json');

// Parse CLI flags
const heliusMinutesIdx = process.argv.indexOf('--helius-minutes');
const gmgnMinutesIdx = process.argv.indexOf('--gmgn-minutes');
const onceFlag = process.argv.includes('--once');

const HELIUS_WINDOW_SEC = heliusMinutesIdx !== -1 ? Number(process.argv[heliusMinutesIdx + 1]) * 60 : 15 * 60; // default 15 min (hemat)
const GMGN_WINDOW_SEC = gmgnMinutesIdx !== -1 ? Number(process.argv[gmgnMinutesIdx + 1]) * 60 : 30 * 60; // default 30 min GMGN / Helius OFF

let isRunning = true;
let currentMonitor = null;
let currentWatcher = null;
let currentStream = null;
let storage = null;

function updateControlState(patch) {
  try {
    let state = {};
    if (existsSync(controlFile)) {
      try { state = JSON.parse(readFileSync(controlFile, 'utf8')); } catch {}
    }
    const merged = {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      heliusWindowMinutes: HELIUS_WINDOW_SEC / 60,
      gmgnWindowMinutes: GMGN_WINDOW_SEC / 60,
      ...state,
      ...patch
    };
    writeFileSync(controlFile, JSON.stringify(merged, null, 2), 'utf8');
  } catch {}
}

function shouldStop() {
  return !isRunning || existsSync(stopFile);
}

const cleanup = () => {
  console.log('\n[CADENCE-MONITOR] 🛑 Shutdown requested, cleaning up...');
  isRunning = false;
  if (currentStream) currentStream.stop();
  if (currentMonitor) currentMonitor.stop();
  if (currentWatcher) currentWatcher.stop();
  if (storage) {
    try { storage.close(); } catch {}
  }
  updateControlState({ status: 'stopped', phase: 'IDLE' });
  try { if (existsSync(stopFile)) unlinkSync(stopFile); } catch {}
  process.exit(0);
};

process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);

async function runDutyCycle() {
  storage = new SyndicateSqliteStorage();
  updateControlState({ status: 'running', phase: 'INITIALIZING' });

  let cycleCount = 0;

  while (!shouldStop()) {
    cycleCount++;
    const cycleStart = Date.now();
    const cycleId = new Date(cycleStart).toISOString().replace(/[:.]/g, '-');
    console.log(`\n================================================================`);
    console.log(`🌀 SIKLUS CADENCE #${cycleCount} [Cycle ID: ${cycleId}]`);
    console.log(`   Helius Active: ${HELIUS_WINDOW_SEC / 60}m | GMGN Active: ${GMGN_WINDOW_SEC / 60}m`);
    console.log(`================================================================`);

    // ==============================================================
    // FASE 1: HELIUS 30-MENIT ON-CHAIN INGESTION
    // ==============================================================
    console.log(`\n[FASE 1/3] 📡 Mengaktifkan Helius Ingestion Collector (${HELIUS_WINDOW_SEC / 60} menit)...`);
    updateControlState({
      phase: 'HELIUS_ACTIVE',
      cycleId,
      cycleCount,
      heliusStartedAt: new Date().toISOString()
    });

    const collector = new HeliusScheduledCollector({
      storage,
      durationSeconds: HELIUS_WINDOW_SEC
    });

    const heliusResult = await collector.runWindow();
    console.log(`[FASE 1/3] ✅ Helius selesai. ${heliusResult.transfersSaved} transfer tersimpan, ${heliusResult.totalCandidates} token terdaftar di SQLite.`);

    if (shouldStop()) break;

    // ==============================================================
    // FASE 2: SELEKSI TOP 5 TOKEN TERBARU (>=4 WALLET) -> 1 WALLET/TOKEN
    // ==============================================================
    console.log(`\n[FASE 2/3] 🎯 Evaluasi Seleksi: Top 5 Token Sindikat Terbaru (>=4 Wallet)...`);
    updateControlState({ phase: 'TARGET_SELECTION' });

    const selector = new SyndicateWalletSelector({
      storage,
      minWallets: 4,
      topLimit: 5
    });

    const watchingTargets = selector.selectAndExport();
    console.log(`[FASE 2/3] ✅ ${watchingTargets.length} wallet perwakilan sindikat siap dipantau di GMGN:`);
    for (let i = 0; i < watchingTargets.length; i++) {
      const wt = watchingTargets[i];
      console.log(`   ${i + 1}. ${wt.tokenName} (${wt.tokenMint.slice(0, 8)}...): ${wt.totalSyndicateWallets} wallet -> Monitored: ${wt.monitoredWallet}`);
    }

    updateControlState({
      watchingTargetsCount: watchingTargets.length,
      targets: watchingTargets
    });

    if (shouldStop()) break;

    // ==============================================================
    // FASE 3: 90 MENIT MONITORING GMGN CDP (ZERO-TAB INJECTION)
    // ==============================================================
    console.log(`\n[FASE 3/3] 🛰️ Memulai GMGN Chrome Inflow Monitor (${GMGN_WINDOW_SEC / 60} menit, Helius IDLE)...`);
    updateControlState({
      phase: 'GMGN_WALLET_MONITOR_ACTIVE',
      gmgnStartedAt: new Date().toISOString()
    });

    currentMonitor = new GmgnWalletInflowMonitor();
    currentWatcher = new SyndicateDetailLaneWatcher({
      activeLanes: ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'S1', 'S2', 'S3', 'S4', 'S5']
    });

    // Hubungkan browser tab yang sudah aktif ke watcher (Zero-Tab)
    try {
      const activePage = await currentMonitor.initBrowserSession();
      await currentWatcher.attachPage(activePage);
    } catch (err) {
      console.warn(`[CDP-ATTACH-WARN] Tidak dapat attach browser CDP (periksa port 9222): ${err.message}`);
    }

    // Sambungkan event inflow -> eskalasi token langsung ke lane watcher
    currentMonitor.onInflow((inflow) => {
      console.log(`\n🚨 [INFLOW DETECTED] Wallet sindikat ${inflow.wallet.slice(0, 8)} menerima token ${inflow.symbol} (${inflow.mint.slice(0, 8)})!`);
      currentWatcher.escalateToken(inflow.mint, inflow.symbol, `INFLOW_ON_${inflow.wallet.slice(0, 8)}`);
      updateControlState({
        lastInflowAt: new Date().toISOString(),
        activeDetailTokens: currentWatcher.getTrackedMints()
      });
    });

    currentWatcher.on('signal', (sig) => {
      console.log(`🔔 [STRATEGY SIGNAL] Lane ${sig.lane} signal on ${sig.symbol}: Phase ${sig.phase}`);
    });

    // Aktifkan Helius Deployer Stream secara bersamaan (push notifications instan)
    const activeDeployers = watchingTargets.map(t => t.deployerAddress).filter(Boolean);
    currentStream = new HeliusDeployerStream({
      rootDir,
      deployers: activeDeployers
    });
    currentStream.on('transfer', (ev) => {
      console.log(`\n⚡ [INSTANT DEPLOYER PUSH] Deployer ${ev.deployer.slice(0, 8)}... airdropped ${ev.mint.slice(0, 8)} (${ev.recipientsCount} wallets)`);
      currentWatcher.escalateToken(ev.mint, 'SOL', `PUSH_${ev.deployer.slice(0, 8)}`);
      updateControlState({
        lastPushAt: new Date().toISOString(),
        activeDetailTokens: currentWatcher.getTrackedMints()
      });
    });
    currentStream.start();

    // Jalankan monitoring GMGN selama jendela waktu GMGN
    await currentMonitor.start(GMGN_WINDOW_SEC);

    console.log(`[FASE 3/3] 🏁 Jendela GMGN selesai.`);
    if (currentStream) {
      currentStream.stop();
      currentStream = null;
    }
    currentWatcher.stop();

    if (onceFlag || shouldStop()) {
      console.log(`[CADENCE-MONITOR] Selesai 1 siklus (--once mode atau stop request).`);
      break;
    }
  }

  cleanup();
}

runDutyCycle().catch(err => {
  console.error('[CADENCE-FATAL-ERR]', err);
  process.exit(1);
});
