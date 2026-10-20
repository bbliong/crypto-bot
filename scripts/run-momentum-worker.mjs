#!/usr/bin/env node
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { FeedHubClient } from '../src/feed-hub-client.js';
import { DistributionProfit4Runtime, atomicProfit4Json } from '../src/distribution-profit4-runtime.js';
import { RotatingJsonlWriter } from '../src/rotating-jsonl.js';

const dataDir = join(process.cwd(), 'data', 'momentum-watch');
mkdirSync(dataDir, { recursive: true });

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(dataDir, runId);
mkdirSync(runDir, { recursive: true });

const controlFile = join(dataDir, 'worker-control.json');
atomicProfit4Json(controlFile, {
  pid: process.pid,
  run: `data/momentum-watch/${runId}`,
  startedAt: Date.now(),
  mode: 'momentum-watch',
  status: 'running',
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
const runtime = new DistributionProfit4Runtime(runDir, write, dataDir, 'momentum');

const client = new FeedHubClient(process.env.FEED_HUB_URL || 'ws://127.0.0.1:8765', 'worker-momentum');

client.on('candidate', (ev) => {
  if (ev.source === 'gmgn_research_ws' || ev.source === 'new_pair') {
    const mcap = ev.transfer?.marketCapUsd ?? (ev.transfer?.priceUsd ? ev.transfer.priceUsd * 1_000_000_000 : null);
    if (mcap !== null && (mcap < 10000 || mcap > 100000)) {
      return;
    }
    runtime.register(ev.transfer, ev.observedAt || Date.now());
    if (ev.transfer?.mint) {
      client.subscribeMint(ev.transfer.mint, 'momentum', 7200);
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

// Periodic step loop to evaluate SL, TP, Trailing Stop, and persist state
const interval = setInterval(() => {
  try {
    runtime.evaluate(Date.now());
  } catch (err) {
    console.warn(`[worker-momentum-step-error]`, err.message);
  }
}, 250);

process.once('exit', () => {
  clearInterval(interval);
  client.close();
  logWriter.close();
});

client.connect();
console.log(`[worker-momentum] 🚀 Momentum Worker started (PID ${process.pid}) in ${runDir}`);
