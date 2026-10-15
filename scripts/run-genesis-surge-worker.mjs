import { register } from 'tsx/esm/api';
register();
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  DistributionGenesisSurgeLaneG1,
  GENESIS_SURGE_TARGET_PERCENT,
  GENESIS_SURGE_STOP_LOSS_PERCENT,
  GENESIS_SURGE_RULES
} from '../src/distribution-genesis-surge-lane.ts';
import { TargetObservation } from '../src/distribution-target-lane.ts';

export async function runGenesisSurgeWatcher(options = {}) {
  const root = options.root || process.cwd();
  const dataDir = join(root, 'data', 'genesis-surge');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const stateFile = join(dataDir, 'genesis-surge-state.json');
  const controlFile = join(dataDir, 'worker-control.json');
  const tradesFile = join(dataDir, 'trades.jsonl');
  const profit4TransfersFile = join(root, 'data', 'profit4-watch');
  const clusterFile = join(root, 'data', 'profit4-watch', 'airdrop-clusters.json');

  let running = true;
  let pumpWs = null;
  const activeLanes = new Map(); // mint -> { lane, obs, transfer, detectedAt, symbol, lastPriceFetchAt }
  const positions = [];

  // Tulis control file (PID & status)
  writeFileSync(controlFile, JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    rules: {
      targetPercent: GENESIS_SURGE_TARGET_PERCENT,
      stopLossPercent: GENESIS_SURGE_STOP_LOSS_PERCENT,
      stakeUsd: options.stakeUsd || 5
    }
  }, null, 2), 'utf8');

  const cleanup = () => {
    running = false;
    try {
      if (pumpWs) {
        pumpWs.terminate();
        pumpWs = null;
      }
    } catch {}
    try {
      if (existsSync(controlFile)) {
        writeFileSync(controlFile, JSON.stringify({ pid: null, stoppedAt: Date.now() }, null, 2), 'utf8');
      }
    } catch {}
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);

  console.log(`[GENESIS-SURGE WORKER] Aktif (PID ${process.pid}). Target: +${GENESIS_SURGE_TARGET_PERCENT}%, Stop: -${GENESIS_SURGE_STOP_LOSS_PERCENT}%`);

  // Load known cluster wallets to track for dump emergency exit
  const clusterWallets = new Set();
  try {
    if (existsSync(clusterFile)) {
      const cData = JSON.parse(readFileSync(clusterFile, 'utf8'));
      for (const cl of (cData.clusters || [])) {
        if (cl.primaryTracked) clusterWallets.add(cl.primaryTracked);
        for (const w of (cl.wallets || [])) clusterWallets.add(w.address);
        for (const s of (cl.senders || [])) clusterWallets.add(s);
      }
    }
  } catch {}
  console.log(`[GENESIS-SURGE] Memuat ${clusterWallets.size} address cluster & deployer untuk deteksi kilat & pemantauan dump.`);

  const seenTransfers = new Set();
  let lastTradesOffset = 0;
  let currentTradesFile = null;

  function handleNewToken(tf) {
    if (!tf.mint || seenTransfers.has(tf.mint)) return;
    seenTransfers.add(tf.mint);

    const transferTime = (tf.timestamp ? tf.timestamp * 1000 : tf.observedAt) || Date.now();
    const ageMs = Date.now() - transferTime;
    if (ageMs > 90000) return; // Jendela masuk G1 maksimal 90 detik, abaikan token lama

    console.log(`🎯 [GENESIS TOKEN DETECTED!] Mint: ${tf.mint.slice(0, 8)}... (${tf.symbol || 'PumpToken'}) | Usia: ${(ageMs / 1000).toFixed(0)}s`);

    const obs = new TargetObservation(transferTime);
    // Jika ada info initial virtual liquidity dari pembuatan token di pump.fun
    if (tf.vTokens && tf.vSol && Number(tf.vTokens) > 0) {
      const priceSol = Number(tf.vSol) / Number(tf.vTokens);
      const estPriceUsd = priceSol * 153.0; // patokan SOL USD wajar
      obs.trade({
        at: Date.now(),
        timestamp: Math.floor(Date.now() / 1000),
        price: estPriceUsd,
        side: 'buy',
        wallet: tf.wallet,
        usd: (tf.initialSol || 0) * 153.0,
        signature: 'init_create'
      });
    }

    const lane = new DistributionGenesisSurgeLaneG1(tf.mint, (event) => {
      console.log(`[GENESIS EVENT] ${tf.mint.slice(0, 8)}: ${event.type} -> ${event.reason || ''}`);
      appendFileSync(tradesFile, JSON.stringify({ observedAt: Date.now(), ...event }) + '\n', 'utf8');

      if (event.type === 'PAPER_SELL' || event.type === 'TARGET_FILLED' || event.type === 'TARGET_CLOSED') {
        positions.unshift({
          mint: tf.mint,
          symbol: tf.symbol,
          event: event.type,
          pnlPercent: event.netReturnPercent ?? event.pnlPercent ?? 0,
          entryPriceUsd: event.entryPriceUsd,
          exitPriceUsd: event.priceUsd ?? event.exitPriceUsd,
          reason: event.reason,
          holdSeconds: event.holdSeconds,
          time: new Date().toISOString()
        });
        positions.splice(50);
      }
    });

    activeLanes.set(tf.mint, {
      lane,
      obs,
      transfer: tf,
      detectedAt: Date.now(),
      mint: tf.mint,
      symbol: tf.symbol,
      lastPriceFetchAt: 0
    });
  }

  // Koneksi direct single WebSocket ke PumpPortal (ultra low latency token discovery)
  function connectPumpPortal() {
    if (!running) return;
    try {
      pumpWs = new WebSocket('wss://pumpportal.fun/api/data');
      pumpWs.on('open', () => {
        console.log('[GENESIS PUMPPORTAL] Terhubung ke direct PumpPortal WebSocket (Single Socket Headless).');
        pumpWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
      });
      pumpWs.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.txType === 'create' && msg.mint) {
            // Cek apakah pembuat token adalah salah satu deployer / anggota klaster sindikat
            if (clusterWallets.has(msg.traderPublicKey)) {
              console.log(`⚡ [DIRECT SYNDICATE LAUNCH DETECTED!] Mint: ${msg.mint.slice(0, 8)}... (${msg.symbol}) Deployer: ${msg.traderPublicKey.slice(0, 8)}...`);
              handleNewToken({
                mint: msg.mint,
                symbol: msg.symbol,
                wallet: msg.traderPublicKey,
                from: msg.traderPublicKey,
                timestamp: Math.floor(Date.now() / 1000),
                observedAt: Date.now(),
                initialSol: msg.solAmount,
                marketCapSol: msg.marketCapSol,
                vTokens: msg.vTokensInBondingCurve,
                vSol: msg.vSolInBondingCurve
              });
            }
          }
        } catch {}
      });
      pumpWs.on('error', () => {});
      pumpWs.on('close', () => {
        if (running) setTimeout(connectPumpPortal, 5000);
      });
    } catch {}
  }

  connectPumpPortal();

  function findRecentTransferFiles() {
    const files = [];
    if (!existsSync(profit4TransfersFile)) return files;
    const runs = readdirSync(profit4TransfersFile, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('2026-'))
      .sort((a, b) => b.name.localeCompare(a.name));

    for (const r of runs.slice(0, 2)) {
      const flat = join(profit4TransfersFile, r.name, 'transfers.jsonl');
      if (existsSync(flat)) files.push(flat);
      const chunksDir = join(profit4TransfersFile, r.name, 'chunks');
      if (existsSync(chunksDir)) {
        const chunks = readdirSync(chunksDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name));
        for (const ch of chunks.slice(0, 6)) {
          const p = join(chunksDir, ch.name, 'transfers.jsonl');
          if (existsSync(p)) files.push(p);
        }
      }
    }
    return files;
  }

  function getLatestTokenTradesFile() {
    if (!existsSync(profit4TransfersFile)) return null;
    const runs = readdirSync(profit4TransfersFile, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('2026-'))
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const r of runs.slice(0, 2)) {
      const chunksDir = join(profit4TransfersFile, r.name, 'chunks');
      if (existsSync(chunksDir)) {
        const chunks = readdirSync(chunksDir, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name));
        for (const ch of chunks.slice(0, 3)) {
          const p = join(chunksDir, ch.name, 'token-trades.jsonl');
          if (existsSync(p)) return p;
        }
      }
    }
    return null;
  }

  while (running) {
    try {
      // 1. Periksa transfer token terbaru dari profit4-watch chunks (redundansi)
      const tfFiles = findRecentTransferFiles();
      for (const tfPath of tfFiles) {
        const lines = readFileSync(tfPath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const tf = JSON.parse(line);
            handleNewToken(tf);
          } catch {}
        }
      }

      // 2. Baca trade stream dari token-trades.jsonl terkini jika ada lane aktif
      if (activeLanes.size > 0) {
        const tradesPath = getLatestTokenTradesFile();
        if (tradesPath) {
          if (tradesPath !== currentTradesFile) {
            currentTradesFile = tradesPath;
            const size = statSync(tradesPath).size;
            lastTradesOffset = Math.max(0, size - 2000000);
          }

          const currentSize = statSync(tradesPath).size;
          if (currentSize > lastTradesOffset) {
            const fd = openSync(tradesPath, 'r');
            const bytesToRead = currentSize - lastTradesOffset;
            const buffer = Buffer.alloc(bytesToRead);
            readSync(fd, buffer, 0, bytesToRead, lastTradesOffset);
            closeSync(fd);
            lastTradesOffset = currentSize;

            const chunkLines = buffer.toString('utf8').split('\n');
            for (const cLine of chunkLines) {
              if (!cLine.trim()) continue;
              try {
                const tr = JSON.parse(cLine);
                const item = activeLanes.get(tr.mint);
                if (item) {
                  item.obs.trade({
                    at: tr.observedAt || Date.now(),
                    timestamp: tr.timestamp,
                    price: tr.price,
                    side: tr.side,
                    wallet: tr.wallet,
                    usd: tr.usd,
                    signature: tr.signature
                  });
                  item.lane.onTrade({
                    at: tr.observedAt || Date.now(),
                    timestamp: tr.timestamp,
                    price: tr.price,
                    side: tr.side,
                    wallet: tr.wallet,
                    usd: tr.usd,
                    signature: tr.signature
                  });
                  if (tr.side === 'sell' && clusterWallets.has(tr.wallet)) {
                    item.lane.reportDevDump(tr.wallet, tr.usd || 0);
                  }
                }
              } catch {}
            }
          }
        }

        // 3. Evaluasi setiap lane aktif & segarkan harga jika ada jeda
        const now = Date.now();
        for (const [mint, item] of activeLanes.entries()) {
          const facts = item.obs.facts(now, [], item.transfer.from);

          // Segarkan harga secara non-blocking via DexScreener jika data harga sudah > 3500ms
          if ((facts.priceAt === null || now - facts.priceAt > 3500) && (now - item.lastPriceFetchAt > 3000)) {
            item.lastPriceFetchAt = now;
            fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`)
              .then(res => res.json())
              .then(data => {
                const pair = data?.pairs?.[0];
                if (pair && Number(pair.priceUsd) > 0) {
                  const fetchNow = Date.now();
                  const pUsd = Number(pair.priceUsd);
                  item.obs.trade({
                    at: fetchNow,
                    timestamp: Math.floor(fetchNow / 1000),
                    price: pUsd,
                    side: 'buy',
                    wallet: 'dex_quote_feed',
                    usd: 10,
                    signature: 'quote_refresh'
                  });
                  item.lane.onTrade({
                    at: fetchNow,
                    timestamp: Math.floor(fetchNow / 1000),
                    price: pUsd,
                    side: 'buy',
                    wallet: 'dex_quote_feed',
                    usd: 10,
                    signature: 'quote_refresh'
                  });
                }
              })
              .catch(() => {});
          }

          if (item.lane.entryAt === null && facts.firstAt !== null && now - facts.firstAt > item.lane.rules.maxEntryWaitSeconds * 1000) {
            item.lane.end(now, 'ENTRY_WINDOW_EXPIRED');
          } else {
            item.lane.step(facts);
          }

          if (item.lane.phase === 'CLOSED' || item.lane.phase === 'CENSORED') {
            console.log(`[GENESIS LANE CLOSED] ${mint.slice(0, 8)} (${item.symbol}) -> Net PnL: ${item.lane.netReturnPercent?.toFixed(2)}% (${item.lane.phase})`);
            activeLanes.delete(mint);
          }
        }
      }

      // 4. Simpan status live
      const state = {
        observedAt: Date.now(),
        workerPid: process.pid,
        activeLanesCount: activeLanes.size,
        trackedClustersWallets: clusterWallets.size,
        activePositions: Array.from(activeLanes.values()).map(a => ({
          mint: a.mint,
          symbol: a.symbol,
          phase: a.lane.phase,
          entryPrice: a.lane.entryPrice,
          detectedAt: a.detectedAt
        })),
        targetRules: {
          takeProfit: `+${GENESIS_SURGE_TARGET_PERCENT}%`,
          stopLoss: `-${GENESIS_SURGE_STOP_LOSS_PERCENT}%`,
          trailingStart: '+35%',
          trailingDrawdown: '8%'
        },
        recentPositions: positions
      };
      writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    } catch (err) {
      console.error('[GENESIS-SURGE ERROR]', err.message);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  cleanup();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stakeArg = process.argv.find(a => a.startsWith('--stake='));
  const stakeUsd = stakeArg ? Number(stakeArg.split('=')[1]) : 5;

  runGenesisSurgeWatcher({ stakeUsd }).catch(err => {
    console.error('Fatal genesis surge error:', err);
    process.exit(1);
  });
}
