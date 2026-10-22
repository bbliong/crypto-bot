#!/usr/bin/env node
import { mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FeedHubClient } from '../src/feed-hub-client.js';
import { DistributionProfit4Runtime, atomicProfit4Json } from '../src/distribution-profit4-runtime.js';
import { RotatingJsonlWriter } from '../src/rotating-jsonl.js';

const dataDir = join(process.cwd(), 'data', 'trend20m-watch');
mkdirSync(dataDir, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(dataDir, runId);
mkdirSync(runDir, { recursive: true });

const controlFile = join(dataDir, 'worker-control.json');
atomicProfit4Json(controlFile, {
  pid: process.pid,
  run: `data/trend20m-watch/${runId}`,
  startedAt: Date.now(),
  mode: 'trend20m-watch',
  status: 'running',
  maxWatchingTokens: 10,
  maxWatchingHours: 2,
  rules: {
    lanes: ['T-Cons', 'T-Bal', 'T-Wide', 'T-Run', 'T-Golden', 'T-Sniper', 'T-Phoenix', 'T-AntiDump', 'T-Titan', 'T-Apex'],
    targetProfitPercent: 20.0,
    trailingStartPercent: 60.0,
    trailingDrawdownPercent: 6.0,
    profitFloorPercent: 15.0,
    stopLossPercent: 10.0,
    minTokenAgeSeconds: 1200,
  },
});

const cleanup = () => {
  try { unlinkSync(controlFile); } catch {}
  process.exit(0);
};
process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);
process.once('exit', () => { try { unlinkSync(controlFile); } catch {} });

const logWriter = new RotatingJsonlWriter(runDir);
const write = (name, val) => logWriter.write(name, val);
const runtime = new DistributionProfit4Runtime(runDir, write, dataDir, 'trend20m');

const client = new FeedHubClient(process.env.FEED_HUB_URL || 'ws://127.0.0.1:8765', 'worker-trend20m');

client.on('candidate', (ev) => {
  if (ev.source === 'gmgn_trend_ws') {
    const mcap = ev.transfer?.marketCapUsd ?? (ev.transfer?.priceUsd ? ev.transfer.priceUsd * 1_000_000_000 : null);
    if (!mcap || mcap < 10000) return;
    runtime.register(ev.transfer, ev.observedAt || Date.now());
    if (ev.transfer?.mint) {
      client.subscribeMint(ev.transfer.mint, 'trend20m', 7200);
    }
  }
});

client.on('trade', (ev) => {
  runtime.trade(ev.mint, ev.trade);
});

client.on('holderFrame', (ev) => {
  runtime.holderFrame(ev.mint, ev.body, ev.observedAt || Date.now());
});

client.on('detailClosed', (ev) => {
  if (ev.mint) {
    client.unsubscribeMint(ev.mint);
  }
  runtime.end(ev.mint, ev.observedAt || Date.now(), ev.reason || 'DETAIL_CLOSED');
});

// Loop evaluasi berkala untuk trailing stop, SL, TP, dan timeout 2 jam
const interval = setInterval(() => {
  try {
    runtime.evaluate(Date.now());
  } catch (err) {
    console.warn(`[worker-trend20m-step-error]`, err.message);
  }
}, 250);

process.once('exit', () => {
  clearInterval(interval);
  client.close();
  logWriter.close();
});

client.connect();
console.log(`[worker-trend20m] 📈 Trend 20m Worker started (PID ${process.pid}) in ${runDir}`);
