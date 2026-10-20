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
  maxWalletsToSync = 5
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

  // 2. Kumpulkan Top 5 wallet representatif dengan DIVERSIFIKASI SINDIKAT MASTER (Round-Robin Fair Allocation)
  // Mencegah dominasi 1 sindikat/botnet yang mengoperasikan puluhan token & ratusan wallet.
  const clusters = clusterResult.clusters || [];
  const nowMs = Date.now();

  const validClusters = clusters
    .filter(cl => {
      if (!cl.primaryTracked) return false;
      if ((cl.walletsCount || 0) < 4) return false; // Abaikan single/micro wallet anomaly
      const toks = cl.tokens || [];
      if (toks.some(t => t.mint === 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn')) return false; // Abaikan pump native token
      return true;
    })
    .map(cl => {
      const toks = cl.tokens || [];
      const latestToken = toks[0] || null;
      const lastAct = cl.lastActivityAt || 0;
      const hoursAgo = lastAct ? (nowMs - lastAct) / (1000 * 3600) : 999;
      const freshness = hoursAgo <= 6 ? 50 : (hoursAgo <= 24 ? 25 : 0);
      const score = ((cl.tokensCount || toks.length) * 2) + ((cl.txCount || 0) * 1.5) + freshness;
      return { cl, latestToken, score };
    })
    .sort((a, b) => b.score - a.score || (b.cl.lastActivityAt || 0) - (a.cl.lastActivityAt || 0));

  // Kelompokkan per Sindikat Master
  const syndMap = new Map();
  for (const item of validClusters) {
    const sid = item.cl.syndicateId || 'syn-default';
    if (!syndMap.has(sid)) syndMap.set(sid, []);
    syndMap.get(sid).push(item);
  }

  const syndList = Array.from(syndMap.entries())
    .map(([sid, items]) => ({
      sid,
      name: items[0]?.cl?.syndicateName || sid,
      items,
      cursor: 0
    }))
    .sort((a, b) => b.items.length - a.items.length);

  const topWallets = [];
  const seenMints = new Set();
  const seenDeployers = new Set();
  const syndicateUsage = new Map();

  // Round-Robin across syndicates
  let hasProgress = true;
  while (topWallets.length < maxWalletsToSync && hasProgress) {
    hasProgress = false;
    for (const syn of syndList) {
      if (topWallets.length >= maxWalletsToSync) break;

      while (syn.cursor < syn.items.length) {
        const item = syn.items[syn.cursor++];
        const mint = item.latestToken?.mint || null;
        const primarySender = item.cl.senders?.[0] || null;

        if (mint && seenMints.has(mint)) continue;
        if (primarySender && seenDeployers.has(primarySender)) continue;

        // Pilih wallet yang belum ada di topWallets
        const candWallets = item.cl.wallets?.map(w => (typeof w === 'string' ? w : w.address)) || [item.cl.primaryTracked];
        const wallet = candWallets.find(w => !topWallets.includes(w));
        if (!wallet) continue;

        topWallets.push(wallet);
        if (mint) seenMints.add(mint);
        if (primarySender) seenDeployers.add(primarySender);
        syndicateUsage.set(syn.name, (syndicateUsage.get(syn.name) || 0) + 1);
        hasProgress = true;
        break; // Lanjut ke sindikat berikutnya (Round-Robin)
      }
    }
  }

  // Fallback jika belum mencapai kuota (relax filter deployer, pertahankan keunikan mint & wallet)
  if (topWallets.length < maxWalletsToSync) {
    for (const item of validClusters) {
      const mint = item.latestToken?.mint || null;
      if (mint && seenMints.has(mint)) continue;
      const candWallets = item.cl.wallets?.map(w => (typeof w === 'string' ? w : w.address)) || [item.cl.primaryTracked];
      const wallet = candWallets.find(w => !topWallets.includes(w));
      if (!wallet) continue;

      topWallets.push(wallet);
      if (mint) seenMints.add(mint);
      if (topWallets.length >= maxWalletsToSync) break;
    }
  }

  console.log(`[SYNC] Distribusi Top ${topWallets.length} antar sindikat:`);
  for (const [sName, cnt] of syndicateUsage.entries()) {
    console.log(`  - ${sName}: ${cnt} wallet`);
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

  // 5. Auto-sync Canonical Syndicate Groups & Watched Targets for Profit4 Dashboard
  try {
    const { syncCanonicalSyndicateOutputs } = await import('../src/syndicate-canonical-grouper.js');
    syncCanonicalSyndicateOutputs(root);
    console.log('[SYNC] Canonical syndicate groups & watched targets auto-synced.');
  } catch (syncErr) {
    console.warn('[SYNC] Auto-sync canonical error:', syncErr?.message);
  }

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
