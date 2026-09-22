import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Standalone probe script to inspect GMGN WebSocket & Holder API
// Does NOT touch or modify any production collector logic.

interface TopHolder {
  wallet: string;
  amountPercentage: number | null;
  amount: number | null;
  usdValue?: number | null;
  tags?: string[];
  rank?: number;
}

interface TradeEvent {
  signature?: string;
  side: 'buy' | 'sell';
  makerWallet: string | null;
  price: number | null;
  amount: number | null;
  amountUsd: number | null;
  timestamp: number;
}

async function runProbe() {
  console.log('=== GMGN PLAYWRIGHT STANDALONE SOCKET & API PROBE ===\n');

  let testMint = process.argv[2];
  const profileDir = 'C:/Projects/Crypto/profiles/aria-tele01';
  const profileName = 'Profile 12';

  console.log(`[1] Launching Playwright browser (Profile: ${profileName})...`);
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--profile-directory=' + profileName, '--disable-blink-features=AutomationControlled'],
  });

  const page = await context.newPage();

  // If no mint passed, open feed to discover a fresh live token
  if (!testMint) {
    console.log('[2] No mint provided. Opening GMGN feed to discover a fresh live token...');
    let discoveredMint: string | null = null;

    page.on('websocket', ws => {
      if (!ws.url().includes('ws.gmgn.ai')) return;
      ws.on('framereceived', ({ payload }) => {
        if (discoveredMint) return;
        try {
          const text = typeof payload === 'string' ? payload : payload.toString('utf8');
          const json = JSON.parse(text);
          const channel = json?.channel;
          if (channel === 'public_broadcast' && Array.isArray(json?.data)) {
            for (const item of json.data) {
              const mint = item?.ed?.d?.a || item?.ed?.a || item?.a;
              if (typeof mint === 'string' && mint.length >= 32 && mint.length <= 44 && mint.endsWith('pump')) {
                discoveredMint = mint;
                console.log(`    🎯 Discovered fresh live token: ${mint}`);
                break;
              }
            }
          }
        } catch {}
      });
    });

    await page.goto('https://gmgn.ai/?chain=sol', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const waitStart = Date.now();
    while (!discoveredMint && Date.now() - waitStart < 15000) {
      await page.waitForTimeout(500);
    }
    testMint = discoveredMint || 'DHhpLFnQ5TfcWHtHKdRrwb1QEFgRky1xRvPwQTospump';
  }

  console.log(`\n[3] Target token to probe: ${testMint}`);

  const capturedChannels = new Set<string>();
  const tradeEvents: TradeEvent[] = [];
  const holderFrames: unknown[] = [];
  let rawSocketSample: unknown = null;
  let rawHolderSocketSample: unknown = null;

  page.on('websocket', ws => {
    if (!ws.url().includes('ws.gmgn.ai')) return;
    console.log('[Detail WebSocket Connected]', ws.url().slice(0, 80) + '...');

    ws.on('framereceived', ({ payload }) => {
      try {
        const text = typeof payload === 'string' ? payload : payload.toString('utf8');
        const json = JSON.parse(text);
        const channel = json?.channel;
        if (channel) capturedChannels.add(channel);

        if (!rawSocketSample && (channel === 'token_activity' || channel === 'token_activity_info_all')) {
          rawSocketSample = json;
          console.log(`[Captured First Trade Frame! Channel: ${channel}]`);
        }

        // Trade activity stream
        if (channel === 'token_activity' || channel === 'token_activity_info_all') {
          const rows = Array.isArray(json?.data) ? json.data : [];
          for (const row of rows) {
            const side = row?.e; // 'buy' or 'sell'
            if (side !== 'buy' && side !== 'sell') continue;
            const makerWallet = row?.m || row?.wa || row?.ad || row?.u || null;
            const trade: TradeEvent = {
              signature: row?.h,
              side,
              makerWallet,
              price: Number(row?.p || row?.pu) || null,
              amount: Number(row?.amount || row?.a || row?.au) || null,
              amountUsd: Number(row?.amount_usd || row?.u || row?.vol) || null,
              timestamp: Number(row?.t) || Date.now(),
            };
            tradeEvents.push(trade);
          }
        }

        // Holder activity stream
        if (channel === 'token_holding' || channel === 'token_tag_holding') {
          if (!rawHolderSocketSample) {
            rawHolderSocketSample = json;
            console.log(`[Captured First Holder Socket Frame! Channel: ${channel}]`);
          }
          holderFrames.push(json);
        }
      } catch {}
    });
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('token_holders') || url.includes('token_stat')) {
      const status = res.status();
      const text = await res.text().catch(() => '');
      console.log(`[HTTP Intercept] ${res.request().method()} ${url.slice(0, 85)}... -> Status ${status}`);
      try {
        const json = JSON.parse(text);
        if (url.includes('token_holders')) {
          writeFileSync('research/probe-api-sample.json', JSON.stringify(json, null, 2));
          const items = json?.data?.list || json?.data?.holders || [];
          console.log(`[HTTP Holder Response] Total items in list: ${items.length}`);
          if (items.length > 0) {
            console.log(`    Sample Item Keys:`, Object.keys(items[0]));
            const item0 = items[0];
            const w = item0.wallet_address || item0.address || item0.wallet;
            const pct = item0.amount_percentage || item0.percentage;
            console.log(`    Item[0]: Wallet=${w?.slice(0, 10)}... %=${pct} Tag=${item0.tag || item0.wallet_tag_v2 || JSON.stringify(item0.tags)}`);
          }
        }
      } catch {}
    }
  });

  const targetUrl = `https://gmgn.ai/sol/token/${testMint}`;
  console.log(`[4] Navigating to GMGN Token page: ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: 'commit', timeout: 30000 }).catch(() => {});

  // Wait a few seconds for the page & websocket to connect
  console.log('[3] Waiting 6 seconds for page to load and WebSocket to connect...');
  await page.waitForTimeout(6000);
  console.log('    Page Title:', await page.title());

  console.log('\n[4] Querying GMGN Top Holders API from browser session...');
  const topHoldersResult = await page.evaluate(async (mint: string) => {
    try {
      const url = `/vas/api/v1/token_holders/sol/${encodeURIComponent(mint)}?limit=20&cost=20&orderby=amount_percentage&direction=desc`;
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      const json = await res.json().catch(() => null);
      return { status: res.status, ok: res.ok, data: json };
    } catch (err) {
      return { status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, testMint);

  console.log(`    API Status: ${topHoldersResult.status} (OK: ${topHoldersResult.ok})`);
  console.log(`    API Raw Data Keys:`, topHoldersResult.data ? Object.keys(topHoldersResult.data) : 'null');
  if (topHoldersResult.data?.data) {
    console.log(`    API data.data Keys:`, Object.keys(topHoldersResult.data.data));
  } else {
    console.log(`    API Raw Full Sample:`, JSON.stringify(topHoldersResult.data)?.slice(0, 300));
  }

  // Also test /defi/quotation/v1/tokens/top_holders or similar if vas doesn't have it
  const altHoldersResult = await page.evaluate(async (mint: string) => {
    try {
      const url = `/defi/quotation/v1/tokens/top_holders/sol/${encodeURIComponent(mint)}?limit=20&cost=20&orderby=amount_percentage&direction=desc`;
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      const json = await res.json().catch(() => null);
      return { status: res.status, ok: res.ok, data: json };
    } catch (err) {
      return { status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, testMint);
  console.log(`    Alternative Defi Endpoint Status: ${altHoldersResult.status}`);
  if (altHoldersResult.data?.data) console.log(`    Alt data.data Keys:`, Object.keys(altHoldersResult.data.data));

  const topHolders: TopHolder[] = [];
  const rawList = topHoldersResult.data?.data?.list
    || topHoldersResult.data?.data?.holders
    || altHoldersResult.data?.data?.list
    || altHoldersResult.data?.data?.holders
    || (Array.isArray(topHoldersResult.data?.data) ? topHoldersResult.data.data : []);
  if (Array.isArray(rawList)) {
    rawList.slice(0, 10).forEach((item: Record<string, unknown>, idx: number) => {
      topHolders.push({
        rank: idx + 1,
        wallet: String(item.wallet_address || item.address || item.wallet || ''),
        amountPercentage: Number(item.amount_percentage ?? item.percentage ?? item.percent) || null,
        amount: Number(item.amount || item.balance) || null,
        usdValue: Number(item.usd_value) || null,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      });
    });
  }

  console.log(`    Retrieved ${topHolders.length} Top Holders:`);
  for (const h of topHolders.slice(0, 5)) {
    console.log(`    #${h.rank}: Wallet=${h.wallet.slice(0, 8)}... (${(h.amountPercentage ?? 0).toFixed(2)}%) Tags=${JSON.stringify(h.tags)}`);
  }

  console.log('\n[5] Querying GMGN DEV Holders API from browser session...');
  const devHoldersResult = await page.evaluate(async (mint: string) => {
    try {
      const url = `/vas/api/v1/token_holders/sol/${encodeURIComponent(mint)}?limit=50&cost=20&tag=dev&orderby=amount_percentage&direction=desc`;
      const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      const json = await res.json().catch(() => null);
      return { status: res.status, ok: res.ok, data: json };
    } catch (err) {
      return { status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, testMint);

  console.log(`    DEV API Status: ${devHoldersResult.status} (OK: ${devHoldersResult.ok})`);
  const devHoldersList = devHoldersResult.data?.data?.list || devHoldersResult.data?.data?.holders || [];
  console.log(`    Tagged DEV Holders found: ${Array.isArray(devHoldersList) ? devHoldersList.length : 0}`);

  console.log('\n[6] Monitoring live WebSocket trades for 15 seconds to test wallet matching...');
  const topHolderWallets = new Map(topHolders.map(h => [h.wallet, h]));
  let matchedSells = 0;
  let totalSells = 0;
  let totalBuys = 0;

  const startTradesLen = tradeEvents.length;
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000);
    while (tradeEvents.length > startTradesLen + totalSells + totalBuys) {
      const idx = startTradesLen + totalSells + totalBuys;
      const t = tradeEvents[idx];
      if (!t) break;
      if (t.side === 'sell') {
        totalSells++;
        if (t.makerWallet && topHolderWallets.has(t.makerWallet)) {
          matchedSells++;
          const holder = topHolderWallets.get(t.makerWallet)!;
          console.log(`    🚨 [TOP HOLDER SELL DETECTED] Rank #${holder.rank} (${(holder.amountPercentage ?? 0).toFixed(2)}% supply) Wallet=${t.makerWallet.slice(0, 8)}... Sold: $${t.amountUsd ?? '?'}`);
        } else {
          console.log(`    [Normal Sell] Wallet=${t.makerWallet ? t.makerWallet.slice(0, 8) + '...' : 'unknown'} Sold: $${t.amountUsd ?? '?'}`);
        }
      } else {
        totalBuys++;
      }
    }
  }

  console.log('\n=== PROBE SUMMARY ===');
  console.log(`Captured WebSocket Channels: ${[...capturedChannels].join(', ')}`);
  console.log(`Total Trades Observed: ${totalBuys} buys, ${totalSells} sells (Matched Top Holder Sells: ${matchedSells})`);
  console.log(`Holder Frames Received via Socket: ${holderFrames.length}`);

  // Save diagnostic output
  mkdirSync('research', { recursive: true });
  const dumpPath = join('research', 'probe-holder-results.json');
  writeFileSync(dumpPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    testMint,
    capturedChannels: [...capturedChannels],
    topHoldersSample: topHolders,
    devHoldersSample: devHoldersList,
    sampleRawSocketFrame: rawSocketSample,
    recentTradesCount: { buys: totalBuys, sells: totalSells, matchedSells },
  }, null, 2));

  console.log(`\nDiagnostic results saved to: ${dumpPath}`);
  console.log('Closing probe browser cleanly...');
  await context.close();
  console.log('Probe finished successfully.');
}

runProbe().catch(err => {
  console.error('Probe failed with error:', err);
  process.exit(1);
});
