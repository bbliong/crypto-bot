import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandDeployerClusters } from './expand-deployer-clusters.mjs';
import { getSolanaRpcUrl } from './solana-rpc-config.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

function logEvent(dataDir, event) {
  try {
    const file = join(dataDir, 'cluster-sync-events.jsonl');
    appendFileSync(file, JSON.stringify({ observedAt: Date.now(), ...event }) + '\n', 'utf8');
  } catch {}
}

export async function runClusterSyncIteration({
  root = defaultRoot,
  rpcUrl = getSolanaRpcUrl(root),
  maxWalletsToSync = 50
} = {}) {
  const dataDir = join(root, 'data', 'profit4-watch');
  mkdirSync(dataDir, { recursive: true });
  const configFile = join(dataDir, 'dashboard-config.json');
  const statusFile = join(dataDir, 'cluster-sync-status.json');

  const startMs = Date.now();
  console.log(`[SYNC] Memulai pemindaian cluster sindikat... (${new Date().toLocaleTimeString('id-ID')})`);

  let prevTotalClusters = 0;
  try {
    const prevData = JSON.parse(readFileSync(join(dataDir, 'airdrop-clusters.json'), 'utf8'));
    prevTotalClusters = prevData.totalClusters || 0;
  } catch {}

  // 1. Jalankan ekspansi cluster scanner
  const clusterResult = await expandDeployerClusters({ root, rpcUrl, limitPerDeployer: 15 });
  const durationMs = Date.now() - startMs;

  const newClustersFound = Math.max(0, (clusterResult.totalClusters || 0) - prevTotalClusters);
  console.log(`[SYNC] Selesai dalam ${(durationMs / 1000).toFixed(1)}s. Total Cluster: ${clusterResult.totalClusters} (+${newClustersFound} baru).`);

  // 2. Kumpulkan Top 50 wallet representatif berdasarkan aktivitas paling segar & aktif
  const clusters = clusterResult.clusters || [];
  const sortedClusters = [...clusters]
    .filter(cl => cl.primaryTracked)
    .sort((a, b) => {
      const timeA = a.lastActivityAt || 0;
      const timeB = b.lastActivityAt || 0;
      if (timeB !== timeA) return timeB - timeA;
      const txA = a.txCount || 0;
      const txB = b.txCount || 0;
      if (txB !== txA) return txB - txA;
      return (b.tokensCount || 0) - (a.tokensCount || 0);
    });

  const topWallets = [];
  for (const cl of sortedClusters) {
    if (!topWallets.includes(cl.primaryTracked)) {
      topWallets.push(cl.primaryTracked);
    }
    if (topWallets.length >= maxWalletsToSync) break;
  }

  // 3. Baca konfigurasi saat ini dan periksa perbedaan
  let currentAddresses = [];
  try {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    if (Array.isArray(cfg.addresses)) currentAddresses = cfg.addresses;
  } catch {}

  const isChanged = topWallets.length !== currentAddresses.length ||
    topWallets.some((addr, i) => addr !== currentAddresses[i]);

  if (isChanged) {
    console.log(`[SYNC] Memperbarui dashboard-config.json dengan Top ${topWallets.length} cluster teraktif...`);
    writeFileSync(configFile, JSON.stringify({
      addresses: topWallets,
      updatedAt: Date.now(),
      autoSyncedBy: 'cluster-sync-worker',
      lastSyncedAt: new Date().toISOString()
    }, null, 2), 'utf8');

    logEvent(dataDir, {
      type: 'AUTO_SYNCED_TOP_WALLETS',
      totalAddresses: topWallets.length,
      sampleAdded: topWallets.slice(0, 3)
    });
  } else {
    console.log(`[SYNC] Konfigurasi dashboard sudah up-to-date (Top ${topWallets.length} wallet).`);
  }

  // 4. Update status file
  const status = {
    status: 'active',
    lastScanAt: new Date().toISOString(),
    lastScanDurationMs: durationMs,
    totalClusters: clusterResult.totalClusters || 0,
    totalWallets: clusterResult.totalWallets || 0,
    totalTokens: clusterResult.totalTokens || 0,
    newClustersFound,
    syncedWalletsCount: topWallets.length,
    newlyAddedToWatch: isChanged ? topWallets.length : 0
  };
  writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');

  return status;
}

export async function startClusterSyncWorker({
  root = defaultRoot,
  intervalMs = 180000, // 3 menit
  once = false
} = {}) {
  const dataDir = join(root, 'data', 'profit4-watch');
  const controlFile = join(dataDir, 'cluster-sync-control.json');
  const statusFile = join(dataDir, 'cluster-sync-status.json');

  writeFileSync(controlFile, JSON.stringify({
    pid: process.pid,
    mode: 'cluster-sync-worker',
    startedAt: new Date().toISOString(),
    status: 'running'
  }, null, 2), 'utf8');

  let running = true;
  const cleanup = () => {
    running = false;
    try {
      if (existsSync(controlFile)) {
        writeFileSync(controlFile, JSON.stringify({
          pid: process.pid,
          mode: 'cluster-sync-worker',
          stoppedAt: new Date().toISOString(),
          status: 'stopped'
        }, null, 2), 'utf8');
      }
      if (existsSync(statusFile)) {
        const cur = JSON.parse(readFileSync(statusFile, 'utf8'));
        cur.status = 'stopped';
        writeFileSync(statusFile, JSON.stringify(cur, null, 2), 'utf8');
      }
    } catch {}
    console.log('[SYNC] Worker dihentikan.');
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  console.log(`[SYNC WORKER] Aktif (PID ${process.pid}). Interval scan: ${intervalMs / 1000}s`);

  while (running) {
    try {
      await runClusterSyncIteration({ root });
    } catch (err) {
      console.error('[SYNC ERROR]', err.message);
      logEvent(dataDir, { type: 'SYNC_ERROR', message: err.message });
    }

    if (once || !running) break;

    console.log(`[SYNC] Menunggu ${intervalMs / 1000}s sampai siklus berikutnya...`);
    await new Promise(r => setTimeout(r, intervalMs));
  }

  cleanup();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const once = process.argv.includes('--once');
  const intervalArg = process.argv.find(a => a.startsWith('--interval='));
  const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) : 180000;

  startClusterSyncWorker({ once, intervalMs }).catch(err => {
    console.error('Fatal cluster-sync error:', err);
    process.exit(1);
  });
}
