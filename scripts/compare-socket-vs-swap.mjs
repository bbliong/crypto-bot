#!/usr/bin/env node
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

if (!process.env.DISPLAY) {
  process.env.DISPLAY = ':99';
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mint: 'DGjrLt5vt95n3PyftANRih9g9EJZewx6PefFEPMEfyUG',
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

console.log('='.repeat(95));
console.log('       🔬 WEBSOCKET vs SWAP ROUTE REAL-TIME COMPARISON (1-MINUTE RUN) 🔬');
console.log('='.repeat(95));
console.log(` Target Mint     : ${opts.mint}`);
console.log(` Target URL      : https://gmgn.ai/sol/token/${opts.mint}`);
console.log(` Swap Interval   : ${opts.intervalMs} ms (2 checks/sec)`);
console.log(` Test Duration   : ${opts.durationSec} seconds (~${Math.floor(opts.durationSec * 1000 / opts.intervalMs)} swap checks)`);
console.log(` Profile         : ${opts.profileDir} (${opts.profileName})`);
console.log(` Display         : ${process.env.DISPLAY}`);
console.log('='.repeat(95) + '\n');

async function main() {
  console.log('[1/4] Launching Playwright Chromium...');
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

  let capturedWallet = 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6'; // default wallet
  page.on('request', req => {
    const m = req.url().match(/\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (m && m[1]) capturedWallet = m[1];
  });

  // Data storage for comparison
  const socketTrades = [];
  let latestSocket = {
    priceUsd: null,
    side: null,
    amountUsd: null,
    observedAt: null,
    occurredAt: null,
  };

  // Attach WebSocket listener
  page.on('websocket', ws => {
    const url = ws.url();
    if (!url.includes('gmgn.ai')) return;
    console.log(`[WS-CONNECTED] ${url}`);

    ws.on('framereceived', ({ payload }) => {
      try {
        const text = payload.toString();
        if (text.length > 2_000_000) return;
        const msg = JSON.parse(text);
        const channel = msg.channel;
        const rows = msg.data;

        if ((channel === 'token_activity' || channel === 'token_activity_info_all') && Array.isArray(rows)) {
          const now = Date.now();
          for (const row of rows) {
            if (row.a === opts.mint && (row.e === 'buy' || row.e === 'sell')) {
              const priceUsd = Number(row.pu);
              const amountUsd = Number(row.au ?? row.amount_usd ?? 0);
              const sec = Number(row.t);
              const occurredAt = Number.isFinite(sec) && sec > 0 ? sec * 1000 : now;

              if (Number.isFinite(priceUsd) && priceUsd > 0) {
                const tick = {
                  observedAt: now,
                  occurredAt,
                  side: row.e,
                  priceUsd,
                  amountUsd,
                  maker: row.m,
                  signature: row.h,
                };
                socketTrades.push(tick);
                latestSocket = tick;
              }
            }
          }
        }
      } catch { /* ignore non-json frames */ }
    });
  });

  const targetUrl = `https://gmgn.ai/sol/token/${opts.mint}`;
  console.log(`[2/4] Navigating to detail page: ${targetUrl}`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (err) {
    console.warn(`[WARN] Navigation slow, continuing... (${err.message})`);
  }

  console.log('[3/4] Waiting 5s for page scripts, WebSocket stream, and wallet initialization...');
  await page.waitForTimeout(5000);

  const title = await page.title().catch(() => 'Unknown Title');
  console.log(` Page Title     : "${title}"`);
  console.log(` Wallet Address : ${capturedWallet}`);

  // If no trade received yet from socket, get initial price from page DOM/evaluate
  const initialPagePrice = await page.evaluate(() => {
    // Try to get token price from document
    const el = document.querySelector('[class*="price"]') || document.querySelector('title');
    return el?.textContent || null;
  });
  console.log(` Page Initial Price hint: ${initialPagePrice}`);

  // Test initial swap probe
  const probe = await page.evaluate(async ({ mint, fromAddress }) => {
    const params = new URLSearchParams({
      web_from_source: 'token_poll', token_in_chain: 'sol', token_out_chain: 'sol',
      from_address: fromAddress, token_in_address: 'So11111111111111111111111111111111111111112',
      token_out_address: mint, in_amount: '41800000', slippage: '15',
      is_anti_mev: 'false', fee: '0.0002', tip_fee: '0.0001', priority_fee: '0.0001', legacy: 'true'
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
    console.warn(`[WARN] Probe swap route: status ${probe.status} (msg: ${probe.body?.msg || probe.error})`);
  } else {
    const q = probe.body?.data?.quote;
    const tokens = q?.outAmount ? Number(q.outAmount) / 10 ** (q.outDecimals || 6) : 0;
    const inUsd = Number(probe.body?.data?.amount_in_usd || 5.0);
    const impliedPrice = tokens > 0 ? inUsd / tokens : 0;
    console.log(`✔ Initial Swap Probe: 200 OK | Latency: ${probe.latency}ms | Exchange: ${probe.body?.data?.exchange} | Implied Price: $${impliedPrice.toFixed(8)} | Tokens: ${tokens.toFixed(2)}`);
  }

  console.log('\n' + '='.repeat(105));
  console.log('STARTING COMPARISON STREAM (60 SECONDS): Every 500ms Swap Hit vs WebSocket Ticks');
  console.log('='.repeat(105));
  console.log(
    'Req#'.padEnd(6) +
    'Time'.padEnd(7) +
    'WebSocket Price'.padEnd(20) +
    'Swap Route Price'.padEnd(20) +
    'Spread(Route vs WS)'.padEnd(22) +
    'ΔSwap(500ms)'.padEnd(16) +
    'Latency'
  );
  console.log('-'.repeat(105));

  const comparisonRecords = [];
  const startTime = Date.now();
  const endTime = startTime + opts.durationSec * 1000;
  let reqSeq = 0;
  let prevRoutePrice = null;
  let prevSocketPrice = null;

  while (Date.now() < endTime) {
    reqSeq++;
    const reqStart = Date.now();
    const elapsedSec = ((reqStart - startTime) / 1000).toFixed(1);

    // Snapshot current socket state
    const socketSnap = { ...latestSocket };

    // Execute swap route query in browser context
    const res = await page.evaluate(async ({ mint, fromAddress }) => {
      const params = new URLSearchParams({
        web_from_source: 'token_poll', token_in_chain: 'sol', token_out_chain: 'sol',
        from_address: fromAddress, token_in_address: 'So11111111111111111111111111111111111111112',
        token_out_address: mint, in_amount: '41800000', slippage: '15',
        is_anti_mev: 'false', fee: '0.0002', tip_fee: '0.0001', priority_fee: '0.0001', legacy: 'true'
      });
      const t0 = performance.now();
      try {
        const r = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
        const latency = Math.round(performance.now() - t0);
        const body = await r.json().catch(() => null);
        return { status: r.status, latency, body, ok: true };
      } catch (e) {
        return { status: null, latency: Math.round(performance.now() - t0), error: e.message, ok: false };
      }
    }, { mint: opts.mint, fromAddress: capturedWallet });

    let routePrice = null;
    let outTokens = null;
    let exchange = null;
    let priceImpact = null;

    if (res.status === 200 && res.body?.code === 0) {
      const q = res.body?.data?.quote;
      const dec = q?.outDecimals || 6;
      outTokens = q?.outAmount ? Number(q.outAmount) / 10 ** dec : null;
      const inUsd = Number(res.body?.data?.amount_in_usd || 5.0);
      routePrice = outTokens && outTokens > 0 ? inUsd / outTokens : null;
      exchange = res.body?.data?.exchange;
      priceImpact = q?.priceImpactPct;
    }

    const socketPrice = socketSnap.priceUsd;
    let spreadPct = null;
    if (routePrice && socketPrice && socketPrice > 0) {
      spreadPct = ((routePrice / socketPrice) - 1) * 100;
    }

    let deltaSwapPct = null;
    if (routePrice && prevRoutePrice && prevRoutePrice > 0) {
      deltaSwapPct = ((routePrice / prevRoutePrice) - 1) * 100;
    }

    let deltaSocketPct = null;
    if (socketPrice && prevSocketPrice && prevSocketPrice > 0) {
      deltaSocketPct = ((socketPrice / prevSocketPrice) - 1) * 100;
    }

    const record = {
      seq: reqSeq,
      elapsedSec: Number(elapsedSec),
      timestamp: reqStart,
      socketPrice,
      socketSide: socketSnap.side,
      socketAgeMs: socketSnap.observedAt ? reqStart - socketSnap.observedAt : null,
      routePrice,
      outTokens,
      spreadPct,
      deltaSwapPct,
      deltaSocketPct,
      latencyMs: res.latency,
      status: res.status,
      exchange,
      priceImpact
    };
    comparisonRecords.push(record);

    // Format output line
    const seqStr = `#${String(reqSeq).padStart(3, '0')}`;
    const timeStr = `${elapsedSec.padStart(4, ' ')}s`;
    const wsStr = socketPrice ? `$${socketPrice.toFixed(8)} (${socketSnap.side || ' '})` : 'Waiting Trade...';
    const swapStr = routePrice ? `$${routePrice.toFixed(8)}` : 'No Route';
    const spreadStr = spreadPct !== null ? `${spreadPct >= 0 ? '+' : ''}${spreadPct.toFixed(2)}% ${spreadPct > 0 ? '🔺' : '🔻'}` : 'N/A';
    const deltaStr = deltaSwapPct !== null ? `${deltaSwapPct >= 0 ? '+' : ''}${deltaSwapPct.toFixed(3)}%` : '---';
    const latStr = `${res.latency}ms`;

    console.log(
      seqStr.padEnd(6) +
      timeStr.padEnd(7) +
      wsStr.padEnd(20) +
      swapStr.padEnd(20) +
      spreadStr.padEnd(22) +
      deltaStr.padEnd(16) +
      latStr
    );

    if (routePrice) prevRoutePrice = routePrice;
    if (socketPrice) prevSocketPrice = socketPrice;

    const elapsedTotal = Date.now() - reqStart;
    const sleepMs = Math.max(0, opts.intervalMs - elapsedTotal);
    if (sleepMs > 0 && Date.now() + sleepMs < endTime) {
      await page.waitForTimeout(sleepMs);
    }
  }

  console.log('\n' + '='.repeat(95));
  console.log('              📊 HASIL ANALISA KOMPARASI WEBSOCKET vs SWAP ROUTE (60 DETIK) 📊');
  console.log('='.repeat(95));

  const validPairs = comparisonRecords.filter(r => r.socketPrice && r.routePrice);
  const spreads = validPairs.map(r => r.spreadPct).filter(s => s !== null);
  const swapDeltas = comparisonRecords.map(r => r.deltaSwapPct).filter(d => d !== null);
  const socketDeltas = comparisonRecords.map(r => r.deltaSocketPct).filter(d => d !== null);

  const avgSpread = spreads.length > 0 ? spreads.reduce((a, b) => a + b, 0) / spreads.length : 0;
  const minSpread = spreads.length > 0 ? Math.min(...spreads) : 0;
  const maxSpread = spreads.length > 0 ? Math.max(...spreads) : 0;

  const avgSwapDelta = swapDeltas.length > 0 ? swapDeltas.reduce((a, b) => a + Math.abs(b), 0) / swapDeltas.length : 0;
  const maxSwapDelta = swapDeltas.length > 0 ? Math.max(...swapDeltas.map(d => Math.abs(d))) : 0;

  const totalTrades = socketTrades.length;
  const totalSwapHits = comparisonRecords.length;

  console.log(` Total Transaksi WebSocket Diterima : ${totalTrades} ticks`);
  console.log(` Total Swap Route Hits (500ms)      : ${totalSwapHits} checks`);
  console.log(` Titik Perbandingan Valid (Paired)  : ${validPairs.length} titik`);
  console.log('-'.repeat(95));
  console.log(` 1. SPREAD / SELISIH HARGA (Swap Route vs WebSocket):`);
  console.log(`    - Rata-rata Selisih Beli Pool   : +${avgSpread.toFixed(2)}% (Harga Route selalu lebih tinggi karena price impact pool)`);
  console.log(`    - Minimum Selisih               : ${minSpread >= 0 ? '+' : ''}${minSpread.toFixed(2)}%`);
  console.log(`    - Maksimum Selisih              : +${maxSpread.toFixed(2)}%`);
  console.log('-'.repeat(95));
  console.log(` 2. DINAMIKA PER JEDA 500ms (Delta Antar-Swap):`);
  console.log(`    - Rata-rata Pergeseran Harga/500ms : ±${avgSwapDelta.toFixed(3)}%`);
  console.log(`    - Pergeseran Maksimum per 500ms   : ±${maxSwapDelta.toFixed(3)}%`);
  console.log('-'.repeat(95));

  // Dump full raw data to scratch
  const dumpPath = '/home/bbliong/.gemini/antigravity-cli/brain/100f1812-6fbb-4a3e-8297-f687be9adece/scratch/socket_vs_swap_comparison.json';
  writeFileSync(dumpPath, JSON.stringify({
    mint: opts.mint,
    intervalMs: opts.intervalMs,
    durationSec: opts.durationSec,
    summary: {
      totalSocketTrades: totalTrades,
      totalSwapHits,
      pairedPoints: validPairs.length,
      avgSpreadPercent: avgSpread,
      minSpreadPercent: minSpread,
      maxSpreadPercent: maxSpread,
      avgSwapDelta500ms: avgSwapDelta,
      maxSwapDelta500ms: maxSwapDelta
    },
    comparisonRecords,
    socketTrades
  }, null, 2));

  console.log(` Data mentah per milidetik disimpan ke: ${dumpPath}`);
  console.log('='.repeat(95));

  await context.close();
  console.log('Browser ditutup. Pengujian selesai.');
}

main().catch(err => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
