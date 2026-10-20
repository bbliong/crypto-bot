import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSolanaRpcUrl } from './solana-rpc-config.mjs';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));

export async function fetchTransactionWithRetry(rpcUrl, txHash, maxRetries = 4) {
  const reqData = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const resp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqData)
      });
      if (resp.status === 429) {
        const waitMs = 1500 * attempt;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      return data.result ?? null;
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn(`[WARN] Gagal fetch tx ${txHash.slice(0, 12)} setelah ${maxRetries} percobaan: ${err.message}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 1200 * attempt));
    }
  }
  return null;
}

export function parseTransactionRecipients(txResult) {
  if (!txResult) return [];
  const instructions = txResult.transaction?.message?.instructions || [];
  const recipients = [];
  const seen = new Set();

  for (const ix of instructions) {
    const parsed = ix.parsed;
    if (!parsed) continue;
    if (parsed.type === 'createIdempotent') {
      const wallet = parsed.info?.wallet;
      if (wallet && !seen.has(wallet)) {
        seen.add(wallet);
        recipients.push({ wallet, mint: parsed.info?.mint || null });
      }
    } else if (parsed.type === 'transfer' || parsed.type === 'transferChecked') {
      const dest = parsed.info?.destination;
      const amt = parsed.info?.amount || parsed.info?.tokenAmount?.amount;
      if (dest && !seen.has(dest)) {
        // Destination is token account, but createIdempotent captures main wallet
      }
    }
  }

  return recipients;
}

export function buildClustersFromTransfers({ root = defaultRoot, rpcUrl = getSolanaRpcUrl(root), fetchRemote = true } = {}) {
  const dataDir = join(root, 'data', 'profit4-watch');
  mkdirSync(dataDir, { recursive: true });
  const cacheFile = join(dataDir, 'tx-cluster-cache.json');
  const outputFile = join(dataDir, 'airdrop-clusters.json');
  const configFile = join(dataDir, 'dashboard-config.json');

  let activeTracked = [];
  try {
    const cfg = JSON.parse(readFileSync(configFile, 'utf8'));
    if (Array.isArray(cfg.addresses)) activeTracked = cfg.addresses;
  } catch {}

  let txCache = {};
  if (existsSync(cacheFile)) {
    try {
      txCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {}
  }

  // Find all transfers across all chunk directories
  const rawTransfers = [];
  const runDirs = existsSync(dataDir) ? readdirSync(dataDir, { withFileTypes: true }).filter(d => d.isDirectory()) : [];
  for (const runDir of runDirs) {
    const chunksDir = join(dataDir, runDir.name, 'chunks');
    if (!existsSync(chunksDir)) continue;
    const chunkDirs = readdirSync(chunksDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const chunkDir of chunkDirs) {
      const transferFile = join(chunksDir, chunkDir.name, 'transfers.jsonl');
      if (!existsSync(transferFile)) continue;
      const lines = readFileSync(transferFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const t = JSON.parse(line);
          if (t.tx && t.wallet) rawTransfers.push(t);
        } catch {}
      }
    }
  }

  return { dataDir, cacheFile, outputFile, activeTracked, txCache, rawTransfers, rpcUrl, fetchRemote };
}

export async function runClusterScan(options = {}) {
  const ctx = buildClustersFromTransfers(options);
  const { dataDir, cacheFile, outputFile, activeTracked, txCache, rawTransfers, rpcUrl, fetchRemote } = ctx;

  const uniqueTxs = new Map();
  for (const t of rawTransfers) {
    if (!uniqueTxs.has(t.tx)) {
      uniqueTxs.set(t.tx, {
        tx: t.tx,
        mint: t.mint,
        symbol: t.symbol,
        amount: t.amount,
        from: t.from,
        wallet: t.wallet,
        timestamp: t.timestamp || Math.floor((t.observedAt || Date.now()) / 1000)
      });
    }
  }

  for (const [txHash, cached] of Object.entries(txCache)) {
    if (!cached || cached.isAirdrop === false || !cached.recipients || cached.recipients.length < 2) continue;
    if (!uniqueTxs.has(txHash)) {
      uniqueTxs.set(txHash, {
        tx: txHash,
        mint: cached.mint,
        symbol: cached.symbol || 'PumpToken',
        amount: cached.amount || '360500',
        from: cached.from,
        wallet: cached.recipients?.[0],
        timestamp: cached.timestamp || Math.floor(Date.now() / 1000)
      });
    }
  }

  console.log(`[SCAN] Menemukan ${rawTransfers.length} transfer (${uniqueTxs.size} transaksi unik on-chain).`);

  let cacheUpdated = false;
  if (fetchRemote) {
    for (const [txHash, tInfo] of uniqueTxs.entries()) {
      if (txCache[txHash] && txCache[txHash].recipients?.length > 0) continue;

      console.log(`[RPC] Memindai transaksi on-chain: ${txHash.slice(0, 16)}.. (${tInfo.symbol || 'Unknown'})`);
      const txResult = await fetchTransactionWithRetry(rpcUrl, txHash);
      if (txResult) {
        const recipients = parseTransactionRecipients(txResult);
        txCache[txHash] = {
          tx: txHash,
          symbol: tInfo.symbol,
          mint: tInfo.mint,
          from: tInfo.from,
          amount: tInfo.amount,
          timestamp: tInfo.timestamp,
          recipients: recipients.map(r => r.wallet),
          fetchedAt: Date.now()
        };
        cacheUpdated = true;
      }
      await new Promise(r => setTimeout(r, 350));
    }

    if (cacheUpdated) {
      writeFileSync(cacheFile, JSON.stringify(txCache, null, 2), 'utf8');
      console.log(`[CACHE] Berhasil memperbarui cache transaksi ke ${cacheFile}`);
    }
  }

  // Union-Find algorithm to cluster wallets that co-occur in the same transaction
  const parent = new Map();
  function find(w) {
    if (!parent.has(w)) parent.set(w, w);
    if (parent.get(w) !== w) parent.set(w, find(parent.get(w)));
    return parent.get(w);
  }
  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }

  const txDetails = [];
  for (const [txHash, tInfo] of uniqueTxs.entries()) {
    const cached = txCache[txHash];
    const recipients = cached?.recipients?.length ? cached.recipients : [tInfo.wallet];
    txDetails.push({ ...tInfo, recipients });

    for (let i = 0; i < recipients.length; i++) {
      for (let j = i + 1; j < recipients.length; j++) {
        union(recipients[i], recipients[j]);
      }
    }
  }

  // Group into clusters
  // Satukan transaksi yang membagikan Token Mint yang sama menjadi 1 kluster kampanye
  const clustersMap = new Map();
  for (const tx of txDetails) {
    const root = (tx.mint && typeof tx.mint === 'string' && tx.mint.trim()) ? tx.mint.trim() : find(tx.recipients[0] || tx.wallet);
    if (!clustersMap.has(root)) {
      clustersMap.set(root, {
        root,
        wallets: new Set(),
        tokens: new Map(),
        senders: new Set(),
        txHashes: new Set(),
        lastActivityAt: 0
      });
    }
    const c = clustersMap.get(root);
    for (const w of tx.recipients) c.wallets.add(w);
    c.senders.add(tx.from);
    c.txHashes.add(tx.tx);
    const txTime = (tx.timestamp ? tx.timestamp * 1000 : Date.now());
    if (txTime > c.lastActivityAt) c.lastActivityAt = txTime;

    if (!c.tokens.has(tx.mint)) {
      c.tokens.set(tx.mint, {
        mint: tx.mint,
        symbol: tx.symbol || 'UNKNOWN',
        lastSeen: txTime,
        txCount: 1
      });
    } else {
      const tok = c.tokens.get(tx.mint);
      tok.txCount++;
      if (txTime > tok.lastSeen) tok.lastSeen = txTime;
    }
  }

  // Format clusters
  let clusterIdx = 1;
  const formattedClusters = Array.from(clustersMap.values())
    .map(c => {
      const walletsList = Array.from(c.wallets);
      const trackedInCluster = walletsList.filter(w => activeTracked.includes(w));
      const tokensList = Array.from(c.tokens.values()).sort((a, b) => b.lastSeen - a.lastSeen);
      const id = `cluster-${clusterIdx++}`;
      const primaryTracked = trackedInCluster[0] || walletsList[0] || 'Unknown';
      const label = `Cluster ${clusterIdx - 1} • ${primaryTracked.slice(0, 6)}...${primaryTracked.slice(-4)}`;

      return {
        id,
        label,
        primaryTracked,
        trackedWallets: trackedInCluster,
        walletsCount: walletsList.length,
        wallets: walletsList.map(w => ({
          address: w,
          isTracked: activeTracked.includes(w)
        })),
        tokensCount: tokensList.length,
        tokens: tokensList,
        sendersCount: c.senders.size,
        senders: Array.from(c.senders),
        txCount: c.txHashes.size,
        lastActivityAt: c.lastActivityAt
      };
    })
    .sort((a, b) => b.tokensCount - a.tokensCount || b.lastActivityAt - a.lastActivityAt);

  // Tier-2: Group Token Clusters into Syndicate Entities (Macro-Syndicates)
  // Kluster yang berbagi >= 3 dompet boneka atau berbagi deployer yang sama disatukan ke sindikat master
  const synParent = new Map();
  function findSyn(i) {
    if (synParent.get(i) === i) return i;
    synParent.set(i, findSyn(synParent.get(i)));
    return synParent.get(i);
  }
  function unionSyn(i, j) {
    const ri = findSyn(i);
    const rj = findSyn(j);
    if (ri !== rj) synParent.set(ri, rj);
  }

  const clusterWalletSets = new Map();
  const clusterSenderSets = new Map();
  for (const c of formattedClusters) {
    synParent.set(c.id, c.id);
    clusterWalletSets.set(c.id, new Set(c.wallets.map(w => w.address)));
    clusterSenderSets.set(c.id, new Set(c.senders));
  }

  for (let i = 0; i < formattedClusters.length; i++) {
    for (let j = i + 1; j < formattedClusters.length; j++) {
      const c1 = formattedClusters[i];
      const c2 = formattedClusters[j];
      const wset1 = clusterWalletSets.get(c1.id);
      const wset2 = clusterWalletSets.get(c2.id);
      let sharedW = 0;
      for (const w of wset1) {
        if (wset2.has(w)) {
          sharedW++;
          if (sharedW >= 3) break;
        }
      }
      const sset1 = clusterSenderSets.get(c1.id);
      const sset2 = clusterSenderSets.get(c2.id);
      let sharedS = false;
      for (const s of sset1) {
        if (sset2.has(s)) {
          sharedS = true;
          break;
        }
      }
      if (sharedW >= 3 || sharedS) {
        unionSyn(c1.id, c2.id);
      }
    }
  }

  // Aggregate syndicates
  const syndicatesMap = new Map();
  for (const c of formattedClusters) {
    const rootId = findSyn(c.id);
    if (!syndicatesMap.has(rootId)) {
      syndicatesMap.set(rootId, []);
    }
    syndicatesMap.get(rootId).push(c);
  }

  let synIdx = 1;
  const syndicatesList = Array.from(syndicatesMap.entries())
    .map(([rootId, clList]) => {
      const allWallets = new Set();
      const allSenders = new Set();
      const tokensSet = [];
      let totalTx = 0;
      let lastAct = 0;

      for (const cl of clList) {
        for (const w of cl.wallets) allWallets.add(w.address);
        for (const s of cl.senders) allSenders.add(s);
        for (const t of cl.tokens) {
          if (t.symbol && !tokensSet.includes(t.symbol) && !t.symbol.startsWith('Airdrop-') && t.symbol !== 'UNKNOWN') {
            tokensSet.push(t.symbol);
          }
        }
        totalTx += cl.txCount || 0;
        if ((cl.lastActivityAt || 0) > lastAct) lastAct = cl.lastActivityAt;
      }
      if (tokensSet.length === 0) {
        for (const cl of clList) {
          for (const t of cl.tokens) {
            if (t.symbol && !tokensSet.includes(t.symbol)) tokensSet.push(t.symbol);
          }
        }
      }

      const id = `syn-${synIdx++}`;
      const name = tokensSet.length > 0 ? tokensSet.slice(0, 3).join(' / ') : `Sindikat ${id}`;
      return {
        id,
        name: `Sindikat ${name}`,
        rootClusterId: rootId,
        campaignsCount: clList.length,
        walletsCount: allWallets.size,
        sendersCount: allSenders.size,
        txCount: totalTx,
        lastActivityAt: lastAct,
        tokens: tokensSet.slice(0, 10),
        clusters: clList.map(cl => cl.id)
      };
    })
    .sort((a, b) => b.walletsCount - a.walletsCount);

  // Map syndicate metadata back to each cluster
  const clusterToSyn = new Map();
  for (const syn of syndicatesList) {
    for (const cid of syn.clusters) {
      clusterToSyn.set(cid, syn);
    }
  }

  for (const c of formattedClusters) {
    const syn = clusterToSyn.get(c.id);
    if (syn) {
      c.syndicateId = syn.id;
      c.syndicateName = syn.name;
    }
  }

  const totalWallets = new Set();
  const totalTokens = new Set();
  for (const c of formattedClusters) {
    for (const w of c.wallets) totalWallets.add(w.address);
    for (const t of c.tokens) totalTokens.add(t.mint);
  }

  const result = {
    updatedAt: Date.now(),
    totalSyndicates: syndicatesList.length,
    totalClusters: formattedClusters.length,
    totalWallets: totalWallets.size,
    totalTokens: totalTokens.size,
    syndicates: syndicatesList,
    clusters: formattedClusters
  };

  writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`[OUTPUT] Berhasil menyimpan data ${formattedClusters.length} cluster (${totalWallets.size} wallets) ke ${outputFile}`);

  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runClusterScan()
    .then(res => {
      console.log(`[SELESAI] Sukses: ${res.totalClusters} cluster, ${res.totalWallets} wallet, ${res.totalTokens} token.`);
      process.exit(0);
    })
    .catch(err => {
      console.error('[FATAL]', err);
      process.exit(1);
    });
}
