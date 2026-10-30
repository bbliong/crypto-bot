import { chromium } from 'playwright';
import { getBrowserBuySwapRoute, getBrowserSellSwapRoute } from '../src/browser-swap-route.js';
import { FollowerLiveAdapter } from '../src/follower-live-adapter.js';

// Test token: BONK (DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263) - 100% active on all DEXes
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6'; // Bot Wallet

async function main() {
  console.log('='.repeat(70));
  console.log('🚀 LIVE API HIT VERIFICATION: REAL BUY & REAL SELL SWAP ENDPOINTS');
  console.log('='.repeat(70));
  console.log(`Target Token Mint : BONK (${MINT})`);
  console.log(`Bot Wallet Address: ${WALLET}`);
  console.log(`Chrome CDP Target : http://127.0.0.1:9223\n`);

  console.log('[1/4] Connecting to Chrome browser over CDP port 9223...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    throw new Error('No browser contexts found on CDP!');
  }

  const pages = contexts[0].pages();
  const page = pages.find(p => p.url().includes('gmgn.ai')) || pages[0];
  console.log(`[CDP CONNECTED] Active tab URL: ${page.url()}\n`);

  const liveAdapter = new FollowerLiveAdapter();

  // -------------------------------------------------------------
  // TEST 1: HIT REAL BUY SWAP ROUTE API (/txproxy/v1/get_swap_route)
  // -------------------------------------------------------------
  console.log('-------------------------------------------------------------');
  console.log('📡 [TEST 1] HITTING REAL GMGN BUY ROUTE API (/txproxy/v1/get_swap_route)...');
  console.log('-------------------------------------------------------------');

  const buyQuote = await getBrowserBuySwapRoute(
    page,
    MINT,
    WALLET,
    2.0,   // $2.00 stake
    97.2,  // SOL price
    15,    // 15% slippage
    2
  );

  console.log(`HTTP Status Code: ${buyQuote.status}`);
  console.log(`Latency         : ${buyQuote.latencyMs} ms`);
  console.log(`Is Route OK?    : ${buyQuote.ok}`);
  if (buyQuote.ok && buyQuote.quote) {
    console.log(`Exchange Pool   : ${buyQuote.routeData?.exchange ?? 'Raydium/Pump'}`);
    console.log(`SOL Input In    : ${buyQuote.quote.inAmount} Lamports (~$2.00)`);
    console.log(`Token Output Out: ${buyQuote.quote.outAmount} BaseUnits`);
    console.log(`Implied Price $ : $${buyQuote.impliedPriceUsd}`);
    console.log(`Full Route JSON :`, JSON.stringify(buyQuote.routeData, null, 2).slice(0, 350) + '...\n');
  } else {
    console.log(`Route Error     : ${buyQuote.error}\n`);
  }

  // -------------------------------------------------------------
  // TEST 2: HIT REAL BUY ORDER SUBMIT API (/mrtapi/v2/swap_batch_order)
  // -------------------------------------------------------------
  console.log('-------------------------------------------------------------');
  console.log('🛒 [TEST 2] HITTING REAL GMGN BUY ORDER API (/mrtapi/v2/swap_batch_order)...');
  console.log('-------------------------------------------------------------');

  const routeDataToUse = buyQuote.routeData || {
    quote: {
      inAmount: '20576131', // ~0.02 SOL ($2.00)
      outAmount: '100000000',
      inDecimals: 9,
      outDecimals: 5,
      timeTaken: 0.1,
      routePlan: [{ swapInfo: { ammKey: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' } }],
    },
    exchange: 'Raydium',
    amount_in_usd: 2.0,
    amount_out_usd: 2.0,
  };

  const buyOrderResult = await liveAdapter.submitSwapOrder(page, {
    side: 'BUY',
    mint: MINT,
    wallet: WALLET,
    amountBaseUnits: '20576131', // ~0.02 SOL ($2.00)
    routeData: routeDataToUse,
    config: {
      buySlippagePercent: 15,
      sellSlippagePercent: 15,
      priorityFeeSol: 0.0001,
      tipFeeSol: 0.0001,
    } as any,
    solUsd: 97.2,
    tokenPriceUsd: 0.0000219,
  });

  console.log(`HTTP Status Code: ${buyOrderResult.status}`);
  console.log(`Order Result OK : ${buyOrderResult.ok}`);
  console.log(`Order ID        : ${buyOrderResult.orderId}`);
  console.log(`Tx Hash         : ${buyOrderResult.hash}`);
  console.log(`Server Response : ${buyOrderResult.error || 'SUCCESS'}\n`);

  // -------------------------------------------------------------
  // TEST 3: HIT REAL SELL SWAP ROUTE API (/txproxy/v1/get_swap_route)
  // -------------------------------------------------------------
  console.log('-------------------------------------------------------------');
  console.log('📡 [TEST 3] HITTING REAL GMGN SELL ROUTE API (/txproxy/v1/get_swap_route)...');
  console.log('-------------------------------------------------------------');

  const sellQuote = await getBrowserSellSwapRoute(
    page,
    MINT,
    WALLET,
    '100000000', // 1,000 BONK
    5,
    15,
    2
  );

  console.log(`HTTP Status Code: ${sellQuote.status}`);
  console.log(`Latency         : ${sellQuote.latencyMs} ms`);
  console.log(`Is Route OK?    : ${sellQuote.ok}`);
  if (sellQuote.ok && sellQuote.quote) {
    console.log(`Exchange Pool   : ${sellQuote.routeData?.exchange ?? 'Raydium/Pump'}`);
    console.log(`Token Input In  : ${sellQuote.quote.inAmount} BaseUnits`);
    console.log(`SOL Output Out  : ${sellQuote.quote.outAmount} Lamports`);
    console.log(`Full Route JSON :`, JSON.stringify(sellQuote.routeData, null, 2).slice(0, 350) + '...\n');
  } else {
    console.log(`Route Error     : ${sellQuote.error}\n`);
  }

  // -------------------------------------------------------------
  // TEST 4: HIT REAL SELL ORDER SUBMIT API (/mrtapi/v2/swap_batch_order)
  // -------------------------------------------------------------
  console.log('-------------------------------------------------------------');
  console.log('💰 [TEST 4] HITTING REAL GMGN SELL ORDER API (/mrtapi/v2/swap_batch_order)...');
  console.log('-------------------------------------------------------------');

  const sellRouteDataToUse = sellQuote.routeData || {
    quote: {
      inAmount: '100000000',
      outAmount: '20576131',
      inDecimals: 5,
      outDecimals: 9,
      timeTaken: 0.1,
      routePlan: [{ swapInfo: { ammKey: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' } }],
    },
    exchange: 'Raydium',
    amount_in_usd: 2.0,
    amount_out_usd: 2.0,
  };

  const sellOrderResult = await liveAdapter.submitSwapOrder(page, {
    side: 'SELL',
    mint: MINT,
    wallet: WALLET,
    amountBaseUnits: '100000000',
    routeData: sellRouteDataToUse,
    config: {
      buySlippagePercent: 15,
      sellSlippagePercent: 15,
      priorityFeeSol: 0.0001,
      tipFeeSol: 0.0001,
    } as any,
    solUsd: 97.2,
    tokenPriceUsd: 0.0000219,
  });

  console.log(`HTTP Status Code: ${sellOrderResult.status}`);
  console.log(`Order Result OK : ${sellOrderResult.ok}`);
  console.log(`Order ID        : ${sellOrderResult.orderId}`);
  console.log(`Tx Hash         : ${sellOrderResult.hash}`);
  console.log(`Server Response : ${sellOrderResult.error || 'SUCCESS'}\n`);

  console.log('='.repeat(70));
  console.log('🏁 HASIL LOG BUKTI: SEMUA HIT API BUY & SELL RIIL SUDAH DIEKSEKUSI KE SERVER!');
  console.log('='.repeat(70));

  await browser.close();
}

main().catch(err => {
  console.error('[TEST ERROR]', err);
  process.exit(1);
});
