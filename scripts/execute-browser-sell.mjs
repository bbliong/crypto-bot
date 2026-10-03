#!/usr/bin/env node
import { chromium } from 'playwright';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initCryptoDb, upsertRealTrade, getRealTrades } from './crypto-db.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

const TARGET_MINT = process.argv[2] || '4NKVTgY1VftkPxjgzmm451VGeSvZ4GDX8bo6cuQCpump';
const PROFILE_DIR = join(projectRoot, 'profiles/research-vps');
const PROFILE_NAME = 'Default';

console.log('='.repeat(78));
console.log('       ⚡ GMGN BROWSER SELL EXECUTION (SELLING 100% POSITION) ⚡');
console.log('='.repeat(78));
console.log(` Target Mint   : ${TARGET_MINT}`);
console.log(` Profile Dir   : ${PROFILE_DIR} (${PROFILE_NAME})`);
console.log(` Display       : ${process.env.DISPLAY || ':99'}`);
console.log('='.repeat(78) + '\n');

if (!process.env.DISPLAY) {
  process.env.DISPLAY = ':99';
}

async function getOnChainTokenBalance(wallet, mint) {
  const rpc = 'https://api.mainnet-beta.solana.com';
  for (const prog of ['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA']) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [wallet, { programId: prog }, { encoding: 'jsonParsed' }]
        })
      });
      const data = await res.json();
      const accounts = data.result?.value || [];
      for (const acc of accounts) {
        const info = acc.account.data.parsed.info;
        if (info.mint === mint) {
          return {
            amountBaseUnits: info.tokenAmount.amount,
            uiAmount: info.tokenAmount.uiAmount,
            uiAmountString: info.tokenAmount.uiAmountString,
            decimals: info.tokenAmount.decimals
          };
        }
      }
    } catch {}
  }
  return null;
}

async function main() {
  console.log('[1/5] Launching Chrome with GMGN persistent profile...');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--start-maximized', `--profile-directory=${PROFILE_NAME}`],
    ignoreDefaultArgs: ['--disable-extensions']
  });

  const page = context.pages()[0] || await context.newPage();

  let liveAuthorization = null;
  let liveWalletAddress = 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6';

  page.on('request', req => {
    const headers = req.headers();
    if (headers.authorization && headers.authorization.startsWith('Bearer ')) {
      liveAuthorization = headers.authorization;
    }
    const walletMatch = req.url().match(/\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    if (walletMatch && walletMatch[1]) {
      liveWalletAddress = walletMatch[1];
    }
  });

  console.log(`[2/5] Navigating to GMGN token page: https://gmgn.ai/sol/token/${TARGET_MINT}...`);
  await page.goto(`https://gmgn.ai/sol/token/${TARGET_MINT}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000
  });

  // Wait for authorization to be captured
  console.log('[3/5] Waiting for authenticated GMGN session...');
  for (let i = 0; i < 20; i++) {
    if (liveAuthorization) break;
    await page.waitForTimeout(500);
  }

  if (!liveAuthorization) {
    console.log('  ⚠️ Header belum tertangkap via event, memicu reload page...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    for (let i = 0; i < 20; i++) {
      if (liveAuthorization) break;
      await page.waitForTimeout(500);
    }
  }

  console.log(`  ✅ Wallet Address: ${liveWalletAddress}`);
  console.log(`  ✅ Authorization : ${liveAuthorization ? liveAuthorization.slice(0, 30) + '...' : 'TIDAK DITEMUKAN'}`);

  if (!liveAuthorization) {
    console.error('❌ Gagal mendapatkan Authorization header dari sesi GMGN.');
    await context.close();
    process.exit(1);
  }

  // Check on-chain balance
  const bal = await getOnChainTokenBalance(liveWalletAddress, TARGET_MINT);
  console.log(`\n[4/5] On-Chain Balance Token: ${bal ? bal.uiAmountString : '0'} (Base Units: ${bal ? bal.amountBaseUnits : '0'})`);

  if (!bal || Number(bal.amountBaseUnits) === 0) {
    console.log('⚠️ Saldo token 0 atau tidak ditemukan di wallet. Mungkin sudah terjual sebelumnya.');
    await context.close();
    process.exit(0);
  }

  const inputAmount = bal.amountBaseUnits;
  const tokenDecimals = bal.decimals;

  console.log('\n[5/5] Meminta route sell ke GMGN internal txproxy...');
  const routeResult = await page.evaluate(async ({ mint, fromAddress, inputAmount }) => {
    const params = new URLSearchParams({
      web_from_source: 'token_poll',
      token_in_chain: 'sol',
      token_out_chain: 'sol',
      from_address: fromAddress,
      token_in_address: mint,
      token_out_address: 'So11111111111111111111111111111111111111112',
      in_amount: inputAmount,
      slippage: '15',
      is_anti_mev: 'false',
      fee: '0.0002',
      tip_fee: '0.0001',
      priority_fee: '0.0001',
      legacy: 'true'
    });
    const res = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, { mint: TARGET_MINT, fromAddress: liveWalletAddress, inputAmount });

  console.log('  Route Response Status:', routeResult.status, 'Code:', routeResult.body?.code, 'Msg:', routeResult.body?.msg);

  const routeData = routeResult.body?.data;
  if (!routeData?.quote) {
    console.error('❌ Gagal mendapatkan route quote dari GMGN txproxy:', routeResult.body);
    await context.close();
    process.exit(1);
  }

  const quote = routeData.quote;
  const outSolLamports = quote.outAmount;
  const outSol = Number(outSolLamports) / 1e9;
  console.log(`  ✅ Expected Output SOL: ${outSol.toFixed(6)} SOL (~$${(outSol * 117.7).toFixed(2)})`);

  console.log('\n🚀 MENGIRIM ORDER SELL KE GMGN /mrtapi/v2/swap_batch_order...');
  const submitResult = await page.evaluate(async ({ mint, fromAddress, authorization, inputAmount, tokenDecimals, routeData }) => {
    const quote = routeData.quote;
    const swapInfo = quote.routePlan?.[0]?.swapInfo ?? {};
    const now = Date.now();

    const payload = {
      is_auto_tip_fee: false,
      is_auto_priority_fee: false,
      max_auto_fee: '0.001',
      token_in_chain: 'sol',
      token_out_chain: 'sol',
      from_address: fromAddress,
      token_in_address: mint,
      token_out_address: 'So11111111111111111111111111111111111111112',
      is_anti_mev: false,
      token_in_price: '0.0000095',
      token_out_price: '117.7',
      chain: 'sol',
      retry_on_submit_failed: 0,
      simulate_before_submit: false,
      input_token: mint,
      output_token: 'So11111111111111111111111111111111111111112',
      source: 'swap_web',
      decimals: tokenDecimals,
      swap_mode: 'ExactIn',
      input_amount: inputAmount,
      market_cap: 0,
      priority_gas_price: '0.0001',
      gas_price: '0.0001',
      auto_slippage: false,
      slippage: 15,
      fee: '0.0002',
      tip_fee: '0.0001',
      priority_fee: '0.0001',
      tx_build_info: {
        ok: true,
        fallback: false,
        error: { code: '', message: '', stage: 'browser_prompt_sell_route', exchange: routeData.exchange ?? '', pool: swapInfo.ammKey ?? '' },
        summary: { totalMs: Number(quote.timeTaken ?? 0) * 1000, method: 'browser_prompt_sell_route', entryCount: Array.isArray(quote.routePlan) ? quote.routePlan.length : 0 },
        traceFields: {
          query: {
            userId: fromAddress,
            tokenIn: { address: mint, decimals: tokenDecimals, price: 0.0000095 },
            tokenOut: { address: 'So11111111111111111111111111111111111111112', decimals: 9, price: 117.7 },
            swapMode: 'ExactIn',
            slippage: 15,
            mc: 0,
            isAntiMev: false,
            fee: 0.0002,
            exchange: routeData.exchange ?? '',
            pool: swapInfo.ammKey ?? '',
            tipFee: 0.0001,
            priorityFee: 0.0001,
            amountIn: inputAmount,
            legacy: true
          },
          serverTimeMs: now
        },
        client_click_at_ms: now,
        order_type: 'browser_prompt_sell_submit',
        ws_status: 'Stable',
        ws_latency_ms: 0,
        ws_chain_stat_ts: now,
        ws_route_info_ts: now
      }
    };

    const res = await fetch('/mrtapi/v2/swap_batch_order', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        authorization
      },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => null);
    return {
      status: res.status,
      code: body?.code,
      message: body?.message || body?.msg,
      orderId: body?.data?.order_id || null,
      hash: body?.data?.hash || null,
      raw: body
    };
  }, {
    mint: TARGET_MINT,
    fromAddress: liveWalletAddress,
    authorization: liveAuthorization,
    inputAmount,
    tokenDecimals,
    routeData
  });

  console.log('='.repeat(78));
  console.log('  HASIL SUBMIT ORDER SELL:');
  console.log('  Status Code :', submitResult.status);
  console.log('  GMGN Code   :', submitResult.code);
  console.log('  Message     :', submitResult.message);
  console.log('  Order ID    :', submitResult.orderId);
  console.log('  TX Hash     :', submitResult.hash);
  console.log('='.repeat(78));

  if (submitResult.code === 0 || submitResult.hash || submitResult.orderId) {
    console.log('🎉 ORDER SELL BERHASIL TERKIRIM KE JARINGAN SOLANA!');
    if (submitResult.hash) {
      console.log(`🔗 Solscan Link: https://solscan.io/tx/${submitResult.hash}`);
    }

    // Update SQLite real_trades table
    try {
      const existingRealTrades = getRealTrades();
      const existingTrade = existingRealTrades.find(t => t.mint === TARGET_MINT);
      const sellTime = Date.now();
      const updatedTrade = {
        ...(existingTrade || {}),
        mint: TARGET_MINT,
        symbol: existingTrade?.symbol || 'Ronald',
        name: existingTrade?.name || 'ロナルド',
        lane: existingTrade?.lane || 'aggressive-safe',
        laneLabel: existingTrade?.laneLabel || 'Safe Aggressive',
        status: 'COMPLETED',
        sell: {
          time: sellTime,
          ok: true,
          status: submitResult.status,
          code: submitResult.code,
          message: submitResult.message,
          orderId: submitResult.orderId,
          hash: submitResult.hash,
          solscanUrl: submitResult.hash ? `https://solscan.io/tx/${submitResult.hash}` : null,
          inputAmount,
          tokenPriceUsd: 0.0000095,
          payloads: []
        },
        durationSec: existingTrade?.buy?.time ? Math.round((sellTime - existingTrade.buy.time) / 1000) : 0,
        walletSoldIncome: outSol * 117.7,
        walletPnlUsd: (outSol * 117.7) - (existingTrade?.walletBuyCost || 2.0)
      };
      upsertRealTrade(updatedTrade);
      console.log('✅ SQLite `real_trades` berhasil diupdate (status: COMPLETED)');

      // Also append to latest run live-trade-ledger.jsonl
      const latestRunFolder = join(projectRoot, 'research/momentum-aggressive-2026-10-01T09-52-58-971Z');
      const ledgerFile = join(latestRunFolder, 'live-trade-ledger.jsonl');
      if (existsSync(ledgerFile)) {
        const ledgerEntry = {
          type: 'LIVE_ORDER_SUBMITTED',
          side: 'SELL',
          mint: TARGET_MINT,
          observedAt: sellTime,
          orderId: submitResult.orderId,
          hash: submitResult.hash,
          inputAmount,
          tokenDecimals,
          ok: true,
          status: submitResult.status,
          code: submitResult.code,
          message: submitResult.message,
          outSolLamports,
          outSol
        };
        appendFileSync(ledgerFile, JSON.stringify(ledgerEntry) + '\n', 'utf8');
        console.log('✅ Entry sell dicatat ke live-trade-ledger.jsonl');
      }
    } catch (e) {
      console.error('Error updating SQLite/ledger:', e.message);
    }

    // Auto-reclaim rent SOL from empty ATA
    try {
      const { reclaimRentForMint } = await import('./solana-rent-reclaimer.mjs');
      console.log('\n[Auto-Reclaim] Memeriksa rent SOL dari token account...');
      const reclaimRes = await reclaimRentForMint(TARGET_MINT);
      if (reclaimRes.ok && reclaimRes.reclaimedSol > 0) {
        console.log(`🎉 BERHASIL AUTO-RECLAIM RENT: +${reclaimRes.reclaimedSol.toFixed(6)} SOL (~$${(reclaimRes.reclaimedSol * 117.7).toFixed(2)})`);
        if (reclaimRes.urls?.[0]) console.log(`🔗 Reclaim Tx: ${reclaimRes.urls[0]}`);
      } else {
        console.log(`ℹ️ Auto-reclaim info: ${reclaimRes.message || 'Tidak ada aksi'}`);
      }
    } catch (err) {
      console.warn('⚠️ Auto-reclaim rent skipped:', err.message);
    }
  } else {
    console.error('❌ Submit sell gagal:', submitResult.raw);
  }

  await page.waitForTimeout(3000);
  await context.close();
  console.log('\n[SELESAI]');
}

main().catch(async err => {
  console.error('Fatal error during sell execution:', err);
  process.exit(1);
});
