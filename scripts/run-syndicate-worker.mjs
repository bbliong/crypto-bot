#!/usr/bin/env node
import { mkdirSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeedHubClient } from '../src/feed-hub-client.js';
import { DistributionProfit4Runtime, atomicProfit4Json } from '../src/distribution-profit4-runtime.js';
import { RotatingJsonlWriter } from '../src/rotating-jsonl.js';

const dataDir = join(process.cwd(), 'data', 'syndicate-watch');
mkdirSync(dataDir, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(dataDir, runId);
mkdirSync(runDir, { recursive: true });

const controlFile = join(dataDir, 'worker-control.json');
atomicProfit4Json(controlFile, {
  pid: process.pid,
  run: `data/syndicate-watch/${runId}`,
  startedAt: Date.now(),
  mode: 'syndicate-watch',
  status: 'running',
});

const cleanup = () => {
  try {
    atomicProfit4Json(controlFile, {
      pid: process.pid,
      run: `data/syndicate-watch/${runId}`,
      status: 'stopped',
      stoppedAt: Date.now(),
    });
  } catch {}
  process.exit(0);
};
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
process.once('exit', cleanup);

const logWriter = new RotatingJsonlWriter(runDir);
const write = (name, val) => logWriter.write(name, val);
const runtime = new DistributionProfit4Runtime(runDir, write, dataDir, 'syndicate');

const client = new FeedHubClient(process.env.FEED_HUB_URL || 'ws://127.0.0.1:8765', 'worker-syndicate');

client.on('candidate', (ev) => {
  if (ev.source === 'syndicate_inflow') {
    runtime.register(ev.transfer, ev.observedAt || Date.now());
    if (ev.transfer?.mint) {
      client.subscribeMint(ev.transfer.mint, 'syndicate', 7200);
    }
  }
});

client.on('trade', (ev) => {
  runtime.trade(ev.mint, ev.trade);
});

client.on('holderFrame', (ev) => {
  runtime.holderFrame(ev.mint, ev.body, ev.observedAt || Date.now());
});

client.on('walletSold', (ev) => {
  if (ev.source === 'syndicate') {
    runtime.onTrackedWalletSold?.(ev.mint, ev.wallet, ev.observedAt || Date.now());
  }
});

client.on('detailClosed', (ev) => {
  if (ev.mint) {
    client.unsubscribeMint(ev.mint);
  }
  runtime.end(ev.mint, ev.observedAt || Date.now(), ev.reason || 'DETAIL_CLOSED');
});

const interval = setInterval(() => {
  try {
    runtime.evaluate(Date.now());
  } catch (err) {
    console.warn(`[worker-syndicate-step-error]`, err.message);
  }
}, 250);

process.once('exit', () => {
  clearInterval(interval);
  client.close();
  logWriter.close();
});

client.connect();
console.log(`[worker-syndicate] 👥 Syndicate Worker started (PID ${process.pid}) in ${runDir}`);

// Auto-register canonical syndicate targets so they are immediately watched
const targetsFile = join(dataDir, 'gmgn-monitored-wallets.json');
if (existsSync(targetsFile)) {
  try {
    const raw = JSON.parse(readFileSync(targetsFile, 'utf8'));
    if (Array.isArray(raw.targets)) {
      console.log(`[worker-syndicate] 🎯 Registering ${raw.targets.length} initial canonical syndicate targets...`);
      for (const t of raw.targets) {
        if (!t.tokenMint) continue;
        const candidate = {
          wallet: t.monitoredWallet || 'syndicate_leader',
          mint: t.tokenMint,
          symbol: t.symbol || t.tokenName || 'SOL',
          timestamp: Math.floor(Date.now() / 1000),
          from: t.deployerAddress || 'deployer',
          source: 'syndicate_inflow',
          syndicateWalletsCount: t.totalSyndicateWallets || 50,
          syndicateTier: (t.totalSyndicateWallets || 0) >= 120 ? 'Tier 4 (120+ W)' :
                         (t.totalSyndicateWallets || 0) >= 88 ? 'Tier 3 (88-112 W)' :
                         (t.totalSyndicateWallets || 0) >= 56 ? 'Tier 2 (56-80 W)' : 'Tier 1 (8-48 W)'
        };
        runtime.register(candidate, Date.now());
        client.subscribeMint(t.tokenMint, 'syndicate', 7200);
      }
    }
  } catch (err) {
    console.warn('[worker-syndicate] Error loading initial targets:', err.message);
  }
}
