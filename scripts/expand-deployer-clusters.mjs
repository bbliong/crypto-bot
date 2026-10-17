import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTransactionWithRetry, parseTransactionRecipients, runClusterScan } from './scan-airdrop-clusters.mjs';
import { getSolanaRpcUrl } from './solana-rpc-config.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

async function fetchSignaturesWithRetry(rpcUrl, address, limit = 20, maxRetries = 4) {
  const reqData = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [address, { limit }]
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqData)
      });
      if (resp.status === 429) {
        const waitMs = 2000 * attempt;
        console.log(`[RPC 429] Rate limit saat getSignatures, menunggu ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return (data.result || []).map(s => s.signature);
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn(`[WARN] Gagal getSignatures untuk ${address.slice(0, 10)}: ${err.message}`);
        return [];
      }
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  return [];
}

export async function expandDeployerClusters({
  root = defaultRoot,
  rpcUrl = getSolanaRpcUrl(root),
  limitPerDeployer = 20
} = {}) {
  const dataDir = join(root, 'data', 'profit4-watch');
  const cacheFile = join(dataDir, 'tx-cluster-cache.json');
  const clusterFile = join(dataDir, 'airdrop-clusters.json');

  let txCache = {};
  if (existsSync(cacheFile)) {
    try {
      txCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {}
  }

  // Kumpulkan deployers dari airdrop-clusters.json dan txCache
  const deployers = new Set();
  if (existsSync(clusterFile)) {
    try {
      const cData = JSON.parse(readFileSync(clusterFile, 'utf8'));
      for (const cl of (cData.clusters || [])) {
        for (const s of (cl.senders || [])) deployers.add(s);
      }
    } catch {}
  }

  for (const item of Object.values(txCache)) {
    if (item.from) deployers.add(item.from);
  }

  console.log(`[EXPAND] Ditemukan ${deployers.size} deployer sindikat untuk dianalisis.`);

  let newlyFoundTx = 0;
  for (const deployer of deployers) {
    if (!deployer || typeof deployer !== 'string') continue;
    console.log(`\n[DEPLOYER] Menyisir aktivitas on-chain deployer: ${deployer.slice(0, 12)}...`);
    const sigs = await fetchSignaturesWithRetry(rpcUrl, deployer, limitPerDeployer);
    console.log(`  -> Menemukan ${sigs.length} signature transaksi.`);
    await new Promise(r => setTimeout(r, 120));

    for (const sig of sigs) {
      if (txCache[sig]) continue; // Sudah ada di cache

      console.log(`  [RPC] Cek transaksi: ${sig.slice(0, 16)}...`);
      const txResult = await fetchTransactionWithRetry(rpcUrl, sig);
      if (!txResult) {
        await new Promise(r => setTimeout(r, 400));
        continue;
      }

      // Periksa apakah ini transaksi airdrop ke cluster
      const ixs = txResult.transaction?.message?.instructions || [];
      const createIdempotentWallets = [];
      let tokenMint = null;

      for (const ix of ixs) {
        if (ix.program === 'spl-associated-token-account' && ix.parsed?.type === 'createIdempotent') {
          const w = ix.parsed.info?.wallet;
          tokenMint = ix.parsed.info?.mint || tokenMint;
          if (w && !createIdempotentWallets.includes(w)) {
            createIdempotentWallets.push(w);
          }
        }
      }

      // Deteksi pola airdrop (minimal 4 wallet serentak, biasanya 8 wallet)
      if (createIdempotentWallets.length >= 4) {
        console.log(`  🎯 [CLUSTER AIRDROP FOUND!] ${createIdempotentWallets.length} wallet penerima. Token: ${tokenMint?.slice(0, 8)}...`);
        txCache[sig] = {
          tx: sig,
          symbol: `Airdrop-${tokenMint ? tokenMint.slice(0, 5) : 'Pump'}`,
          mint: tokenMint,
          from: deployer,
          amount: '360500',
          timestamp: txResult.blockTime || Math.floor(Date.now() / 1000),
          recipients: createIdempotentWallets,
          fetchedAt: Date.now()
        };
        newlyFoundTx++;
        // Update cache langsung agar tersimpan permanen
        writeFileSync(cacheFile, JSON.stringify(txCache, null, 2), 'utf8');
      } else {
        txCache[sig] = {
          tx: sig,
          isAirdrop: false,
          fetchedAt: Date.now()
        };
        writeFileSync(cacheFile, JSON.stringify(txCache, null, 2), 'utf8');
      }

      await new Promise(r => setTimeout(r, 120));
    }
  }

  console.log(`\n[EXPAND COMPLETED] Menemukan ${newlyFoundTx} transaksi airdrop cluster baru!`);

  // Jalankan cluster scan untuk menyusun ulang database cluster
  const result = await runClusterScan({ root, rpcUrl, fetchRemote: false });
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  expandDeployerClusters()
    .then(res => {
      console.log(`\n✅ Hasil Akhir: Total ${res.totalClusters} Cluster | Total ${res.totalWallets} Wallet.`);
      process.exit(0);
    })
    .catch(err => {
      console.error('Error saat ekspansi:', err);
      process.exit(1);
    });
}
