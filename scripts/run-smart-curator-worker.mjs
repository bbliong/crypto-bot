#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchGmgnLowcapCandidates,
  verifyWithHelius,
  exportCuratedWallets
} from '../src/smart-curator-pipeline.js';

const rootDir = fileURLToPath(new URL('../', import.meta.url));

function getHeliusKey() {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY.trim();
  try {
    const envPath = join(rootDir, '.env');
    if (existsSync(envPath)) {
      const match = readFileSync(envPath, 'utf8').match(/HELIUS_API_KEY=([^\s\r\n]+)/);
      if (match) return match[1].trim();
    }
  } catch {}
  return '';
}

async function isCdpAlive(url = 'http://127.0.0.1:9223') {
  try {
    const res = await fetch(`${url}/json/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureChromeCdp(url = 'http://127.0.0.1:9223') {
  if (await isCdpAlive(url)) {
    return true;
  }
  console.log('[CURATOR] Chrome CDP port 9223 not responding. Attempting to start chrome-x-cdp.service...');
  try {
    execSync('systemctl --user start chrome-x-cdp.service', { stdio: 'inherit' });
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isCdpAlive(url)) {
        console.log('[CURATOR] Chrome CDP is now active.');
        return true;
      }
    }
  } catch (err) {
    console.warn('[CURATOR] Failed starting chrome-x-cdp:', err.message);
  }
  return false;
}

async function runCycle(cdpUrl, heliusKey) {
  const startTime = Date.now();
  console.log(`\n================================================================`);
  console.log(`🚀 [CURATOR CYCLE START] ${new Date().toISOString()}`);
  console.log(`================================================================`);

  const cdpReady = await ensureChromeCdp(cdpUrl);
  if (!cdpReady) {
    throw new Error(`Cannot reach Chrome CDP on ${cdpUrl}. Aborting cycle.`);
  }

  // 1. GMGN Discovery Phase
  console.log('\n[PHASE 1] 🔍 Discovery via 1-Tab GMGN CDP...');
  const candidates = await fetchGmgnLowcapCandidates(cdpUrl);
  console.log(`[PHASE 1] Found ${candidates.length} candidate wallets meeting initial lowcap & PnL criteria.`);

  if (candidates.length === 0) {
    console.warn('[PHASE 1] No candidates found. Skipping verification.');
    return [];
  }

  // 2. Helius Verification Phase
  console.log('\n[PHASE 2] 🛡️ Verifying on-chain activity via Helius RPC & Enhanced API...');
  const verifiedWallets = await verifyWithHelius(candidates, heliusKey, 5);

  // 3. Export Phase
  console.log('\n[PHASE 3] 💾 Exporting results to CSV and JSON...');
  const { jsonPath, csvPath } = exportCuratedWallets(verifiedWallets);

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ [CURATOR CYCLE COMPLETED] In ${durationSec}s. Curated ${verifiedWallets.length} smart wallets.`);

  // 4. Print Summary Table of Top 15
  console.log('\n📊 TOP 15 CURATED LOWCAP SMART WALLETS:');
  console.log('-------------------------------------------------------------------------------------------------------------------');
  console.log('Rank | Score | Wallet Address                               | WinRate | 30d PnL ($) | SOL Bal | Pump.fun | Raydium');
  console.log('-------------------------------------------------------------------------------------------------------------------');
  for (let i = 0; i < Math.min(15, verifiedWallets.length); i++) {
    const w = verifiedWallets[i];
    const rankStr = String(i + 1).padStart(4, ' ');
    const scoreStr = String(w.score).padStart(5, ' ');
    const addrStr = w.address.padEnd(44, ' ');
    const wrStr = `${w.winrate30d}%`.padStart(7, ' ');
    const pnlStr = `+$${w.pnl30d.toLocaleString()}`.padStart(11, ' ');
    const solStr = String(w.solBalance.toFixed(1)).padStart(7, ' ');
    const pfStr = (w.hasPumpFunSwap ? 'YES' : 'NO').padEnd(8, ' ');
    const rayStr = (w.hasRaydiumSwap ? 'YES' : 'NO').padEnd(7, ' ');
    console.log(`${rankStr} | ${scoreStr} | ${addrStr} | ${wrStr} | ${pnlStr} | ${solStr} | ${pfStr} | ${rayStr}`);
  }
  console.log('-------------------------------------------------------------------------------------------------------------------');
  console.log(`Files saved at:\n - JSON: ${jsonPath}\n - CSV:  ${csvPath}\n`);

  return verifiedWallets;
}

async function main() {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');
  const cdpIdx = args.indexOf('--cdp');
  const cdpUrl = cdpIdx !== -1 ? args[cdpIdx + 1] : 'http://127.0.0.1:9223';

  const intervalIdx = args.indexOf('--interval-hours');
  const intervalHours = intervalIdx !== -1 ? Number(args[intervalIdx + 1]) : 24;

  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    console.error('[ERROR] HELIUS_API_KEY is not defined in environment or .env!');
    process.exit(1);
  }

  console.log(`[CURATOR-WORKER] Started (PID: ${process.pid})`);
  console.log(` - Mode: ${runOnce ? 'SINGLE RUN (--once)' : `CONTINUOUS (Every ${intervalHours} hours)`}`);
  console.log(` - CDP Endpoint: ${cdpUrl}`);

  if (runOnce) {
    try {
      await runCycle(cdpUrl, heliusKey);
      process.exit(0);
    } catch (err) {
      console.error('[FATAL] Cycle execution error:', err);
      process.exit(1);
    }
  }

  // Continuous Worker Loop
  while (true) {
    try {
      await runCycle(cdpUrl, heliusKey);
    } catch (err) {
      console.error('[ERROR] Cycle failed with error:', err.message);
    }

    const sleepMs = intervalHours * 3600 * 1000;
    console.log(`[CURATOR-WORKER] Sleeping for ${intervalHours} hours until next curation cycle...`);
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

main().catch(err => {
  console.error('[FATAL] Worker encountered unhandled error:', err);
  process.exit(1);
});
