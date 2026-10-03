#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.DISPLAY) {
  process.env.DISPLAY = ':99';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mint: 'CEm82kndLRsy1ddMznhm92CbcVzgVf9Tm72BXEDRpump', // Default BabyAI or passed via CLI
    intervalMs: 500,
    durationSec: 60,
    profileDir: '/home/bbliong/project/crypto-bot/profiles/research-vps',
    profileName: 'Default',
    headless: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--mint' && args[i + 1]) opts.mint = args[++i];
    else if (a.startsWith('--mint=')) opts.mint = a.split('=')[1];
    else if (a === '--interval' && args[i + 1]) opts.intervalMs = Number(args[++i]);
    else if (a.startsWith('--interval=')) opts.intervalMs = Number(a.split('=')[1]);
    else if (a === '--duration' && args[i + 1]) opts.durationSec = Number(args[++i]);
    else if (a.startsWith('--duration=')) opts.durationSec = Number(a.split('=')[1]);
    else if (a === '--headless') opts.headless = true;
    else if (a === '--profileDir' && args[i + 1]) opts.profileDir = args[++i];
    else if (a === '--profileName' && args[i + 1]) opts.profileName = args[++i];
  }
  return opts;
}

const opts = parseArgs();

console.log('='.repeat(80));
console.log('       🚀 GMGN SWAP ROUTE RATE-LIMIT BENCHMARK TEST (PLAYWRIGHT) 🚀');
console.log('='.repeat(80));
console.log(` Target Mint   : ${opts.mint}`);
console.log(` Hit Interval  : ${opts.intervalMs} ms (2 requests/sec)`);
console.log(` Total Duration: ${opts.durationSec} seconds (~${Math.floor(opts.durationSec * 1000 / opts.intervalMs)} requests)`);
console.log(` Chrome Profile: ${opts.profileDir} (${opts.profileName})`);
console.log(` Display       : ${process.env.DISPLAY}`);
console.log('='.repeat(80) + '\n');

async function main() {
  console.log('[1/4] Launching Playwright Chromium with persistent session profile...');
  const context = await chromium.launchPersistentContext(opts.profileDir, {
    channel: 'chrome',
    headless: opts.headless,
    viewport: { width: 1440, height: 900 },
    args: [
      '--start-maximized',
      `--profile-directory=${opts.profileName}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ],
    ignoreDefaultArgs: ['--disable-extensions']
  });

  const page = context.pages()[0] || await context.newPage();

  let capturedWallet = 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6'; // fallback default
  page.on('request', req => {
    const m = req.url().match(/\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m && m[1]) {
      capturedWallet = m[1];
    }
  });

  const targetUrl = `https://gmgn.ai/sol/token/${opts.mint}`;
  console.log(`[2/4] Navigating to token detail page: ${targetUrl}`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    console.warn(`[WARN] Page goto timed out or slow, continuing... (${err.message})`);
  }

  // Allow DOM and background scripts to stabilize
  console.log('[3/4] Waiting 5s for page scripts, session cookies, and wallet to initialize...');
  await page.waitForTimeout(5000);

  const title = await page.title().catch(() => 'Unknown Title');
  console.log(` Page Title     : "${title}"`);
  console.log(` Wallet Address : ${capturedWallet}`);

  // Test single probe first
  console.log('\n[4/4] Sending initial probe to verify /txproxy/v1/get_swap_route endpoint...');
  const probe = await page.evaluate(async ({ mint, fromAddress }) => {
    const params = new URLSearchParams({
      web_from_source: 'token_poll',
      token_in_chain: 'sol',
      token_out_chain: 'sol',
      from_address: fromAddress,
      token_in_address: 'So11111111111111111111111111111111111111112',
      token_out_address: mint,
      in_amount: '41800000', // ~0.0418 SOL ($5 USD)
      slippage: '15',
      is_anti_mev: 'false',
      fee: '0.0002',
      tip_fee: '0.0001',
      priority_fee: '0.0001',
      legacy: 'true'
    });
    const t0 = performance.now();
    try {
      const res = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
      const latency = Math.round(performance.now() - t0);
      const body = await res.json().catch(() => null);
      return { status: res.status, latency, body, ok: true };
    } catch (e) {
      return { status: null, latency: Math.round(performance.now() - t0), error: e.message, ok: false };
    }
  }, { mint: opts.mint, fromAddress: capturedWallet });

  if (probe.status !== 200 || probe.body?.code !== 0) {
    console.warn(`[WARN] Probe returned status ${probe.status} (code: ${probe.body?.code}, msg: ${probe.body?.msg || probe.error})`);
  } else {
    const quote = probe.body?.data?.quote;
    console.log(`✔ Initial probe SUCCESS! Status: 200 OK | Latency: ${probe.latency}ms | Exchange: ${probe.body?.data?.exchange} | OutAmount: ${quote?.outAmount || 'N/A'}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log(`STARTING BENCHMARK: Sending requests every ${opts.intervalMs}ms for ${opts.durationSec}s`);
  console.log('='.repeat(80));

  const stats = {
    totalSent: 0,
    success200: 0,
    rateLimit429: 0,
    error5xx: 0,
    otherErr: 0,
    latencies: [],
    first429: null,
    consecutiveErrors: 0,
    headersSample: null
  };

  const startTime = Date.now();
  const endTime = startTime + opts.durationSec * 1000;
  let reqSeq = 0;

  while (Date.now() < endTime) {
    reqSeq++;
    const reqStart = Date.now();
    const elapsedSec = ((reqStart - startTime) / 1000).toFixed(1);

    const res = await page.evaluate(async ({ mint, fromAddress }) => {
      const params = new URLSearchParams({
        web_from_source: 'token_poll',
        token_in_chain: 'sol',
        token_out_chain: 'sol',
        from_address: fromAddress,
        token_in_address: 'So11111111111111111111111111111111111111112',
        token_out_address: mint,
        in_amount: '41800000',
        slippage: '15',
        is_anti_mev: 'false',
        fee: '0.0002',
        tip_fee: '0.0001',
        priority_fee: '0.0001',
        legacy: 'true'
      });
      const t0 = performance.now();
      try {
        const r = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
        const latency = Math.round(performance.now() - t0);
        const headers = {};
        for (const [k, v] of r.headers.entries()) {
          if (k.includes('ratelimit') || k.includes('retry') || k.includes('cf-') || k.includes('cache')) {
            headers[k] = v;
          }
        }
        const body = await r.json().catch(() => null);
        return { status: r.status, latency, body, headers, ok: true };
      } catch (e) {
        return { status: null, latency: Math.round(performance.now() - t0), error: e.message, ok: false };
      }
    }, { mint: opts.mint, fromAddress: capturedWallet });

    stats.totalSent++;
    if (res.latency) stats.latencies.push(res.latency);

    const prefix = `[Req #${String(reqSeq).padStart(3, '0')} | ${elapsedSec.padStart(4, ' ')}s]`;

    if (res.status === 200 && res.body?.code === 0) {
      stats.success200++;
      stats.consecutiveErrors = 0;
      const ex = res.body?.data?.exchange || 'swap';
      const outTokens = res.body?.data?.quote?.outAmount ? Math.round(Number(res.body.data.quote.outAmount) / 1e6) : 'N/A';
      console.log(`${prefix} 🟢 200 OK | Latency: ${String(res.latency).padStart(3, ' ')}ms | Exchange: ${ex.padEnd(6, ' ')} | Tokens: ${outTokens}`);
    } else if (res.status === 429 || res.body?.code === 429) {
      stats.rateLimit429++;
      stats.consecutiveErrors++;
      if (!stats.first429) stats.first429 = { reqSeq, elapsedSec, res };
      if (!stats.headersSample && res.headers) stats.headersSample = res.headers;
      console.log(`${prefix} 🔴 429 RATE LIMIT! | Latency: ${res.latency}ms | Msg: ${res.body?.msg || 'Too Many Requests'}`);
    } else if (res.status >= 500) {
      stats.error5xx++;
      stats.consecutiveErrors++;
      console.log(`${prefix} ⚠️ ${res.status} SERVER ERROR | Latency: ${res.latency}ms | Msg: ${res.body?.msg || res.error}`);
    } else {
      stats.otherErr++;
      stats.consecutiveErrors++;
      console.log(`${prefix} 🟡 STATUS ${res.status} (code: ${res.body?.code}) | Msg: ${res.body?.msg || res.error}`);
    }

    const elapsedTotal = Date.now() - reqStart;
    const sleepMs = Math.max(0, opts.intervalMs - elapsedTotal);
    if (sleepMs > 0 && Date.now() + sleepMs < endTime) {
      await page.waitForTimeout(sleepMs);
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('                     📊 HASIL EVALUASI RATE LIMIT 📊');
  console.log('='.repeat(80));

  const totalTimeSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const avgLatency = stats.latencies.length > 0 ? (stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length).toFixed(1) : 0;
  const minLatency = stats.latencies.length > 0 ? Math.min(...stats.latencies) : 0;
  const maxLatency = stats.latencies.length > 0 ? Math.max(...stats.latencies) : 0;
  const successPct = ((stats.success200 / stats.totalSent) * 100).toFixed(1);

  console.log(` Durasi Tes         : ${totalTimeSec} detik`);
  console.log(` Total Request      : ${stats.totalSent} requests`);
  console.log(` Sukses (200 OK)    : ${stats.success200} (${successPct}%)`);
  console.log(` Terkena 429        : ${stats.rateLimit429} (${((stats.rateLimit429 / stats.totalSent) * 100).toFixed(1)}%)`);
  console.log(` Error 5xx          : ${stats.error5xx}`);
  console.log(` Error Lainnya      : ${stats.otherErr}`);
  console.log(` Latency Rata-rata  : ${avgLatency} ms (Min: ${minLatency}ms, Max: ${maxLatency}ms)`);

  if (stats.first429) {
    console.log(`\n ⚠️ Rate limit pertama kali terjadi pada: Request #${stats.first429.reqSeq} (detik ke-${stats.first429.elapsedSec})`);
    if (stats.headersSample) {
      console.log(' Response Headers Sample:', JSON.stringify(stats.headersSample, null, 2));
    }
  } else {
    console.log('\n 🎉 TIDAK ADA RATE LIMIT 429 TERDETEKSI!');
    console.log(` Endpoint /txproxy/v1/get_swap_route aman di-hit setiap ${opts.intervalMs}ms (2 req/detik).`);
  }
  console.log('='.repeat(80));

  console.log('\nMenutup browser...');
  await context.close();
  console.log('Selesai.');
}

main().catch(err => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
