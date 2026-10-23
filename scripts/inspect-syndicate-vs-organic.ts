import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface TradeEvent {
  wallet: string;
  rank: number;
  type: 'buy' | 'sell';
  timeSec: number;
  timeIso: string;
  costUsd: number;
  priceUsd: number;
}

interface SharedTokenAnalysis {
  mint: string;
  symbol: string;
  wallets: string[];
  isSyndicate: boolean;
  verdictReason: string;
  minEntryDeltaSec: number;
  avgHoldSec: number;
  candleCrashDetected: boolean;
  events: TradeEvent[];
  candlesSummary?: any;
}

async function main() {
  console.log('========================================================================');
  console.log('🛡️ ANTI-SYNDICATE TOKEN & CANDLE INSPECTION PIPELINE');
  console.log('========================================================================\n');

  const jsonPath = join(process.cwd(), 'data', 'curated-lowcap-smart-wallets.json');
  const fileData = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const candidateWallets = fileData.wallets.slice(0, 20); // Top 20 for deep inspection

  console.log(`Connecting to Chrome CDP at port 9223...`);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];

  // 1. Collect token activities for each candidate
  console.log(`[STAGE 1] Collecting recent token trades across Top 20 candidate wallets...`);
  const tokenToWallets = new Map();
  const walletTokenHoldings = new Map();

  for (let i = 0; i < candidateWallets.length; i++) {
    const w = candidateWallets[i];
    const rank = i + 1;
    const activities = await page.evaluate(async (addr) => {
      try {
        const res = await fetch(`/vas/api/v1/wallet_activity/sol?wallet=${addr}&limit=35&cost=usd`);
        const json = await res.json();
        return json?.data?.activities || [];
      } catch {
        return [];
      }
    }, w.address);

    const tokensTraded = new Set();
    for (const a of activities) {
      const mint = a.token?.address;
      const symbol = a.token?.symbol || 'UNKNOWN';
      if (!mint) continue;
      tokensTraded.add(mint);

      if (!tokenToWallets.has(mint)) {
        tokenToWallets.set(mint, {
          mint,
          symbol,
          wallets: new Set(),
          events: []
        });
      }

      const tRecord = tokenToWallets.get(mint);
      tRecord.wallets.add(w.address);
      tRecord.events.push({
        wallet: w.address,
        rank,
        type: a.event_type,
        timeSec: a.timestamp,
        timeIso: new Date(a.timestamp * 1000).toISOString(),
        costUsd: Number(a.cost_usd) || 0,
        priceUsd: Number(a.price_usd) || 0
      });
    }

    walletTokenHoldings.set(w.address, tokensTraded);
    process.stdout.write(`  [${rank}/20] ${w.address.slice(0, 6)}...: ${activities.length} trades, ${tokensTraded.size} unique tokens\n`);
    await new Promise(r => setTimeout(r, 150));
  }

  // 2. Identify tokens entered by 2 or more wallets
  console.log(`\n[STAGE 2] Finding shared tokens (convergence)...`);
  const sharedTokens = [];
  for (const [mint, info] of tokenToWallets.entries()) {
    if (info.wallets.size >= 2) {
      sharedTokens.push(info);
    }
  }

  console.log(`Found ${sharedTokens.length} tokens entered by >= 2 wallets in Top 20!`);

  // 3. Inspect each shared token: Candles + Timestamps + Holding Duration
  console.log(`\n[STAGE 3] Inspecting Candles & Millisecond Timelines for Shared Tokens...`);
  const sharedAnalyses = [];
  const syndicateWalletsBlacklist = new Set();

  for (const st of sharedTokens) {
    console.log(`\n🔍 Inspecting Shared Token: ${st.symbol} (${st.mint})`);
    console.log(`   Wallets involved (${st.wallets.size}): ${Array.from(st.wallets).map(w => w.slice(0, 6)).join(', ')}`);

    // Fetch 1m candles around this token
    const candlesData = await page.evaluate(async (tokenMint) => {
      try {
        const res = await fetch(`/api/v1/token_mcap_candles/sol/${tokenMint}?resolution=1m&limit=100`);
        const json = await res.json();
        return json?.data?.list || [];
      } catch {
        return [];
      }
    }, st.mint);

    // Sort events chronologically
    st.events.sort((a, b) => a.timeSec - b.timeSec);

    // Calculate Entry Deltas between different wallets
    const buysByWallet = new Map();
    const sellsByWallet = new Map();

    for (const ev of st.events) {
      if (ev.type === 'buy') {
        if (!buysByWallet.has(ev.wallet)) buysByWallet.set(ev.wallet, []);
        buysByWallet.get(ev.wallet).push(ev);
      } else if (ev.type === 'sell') {
        if (!sellsByWallet.has(ev.wallet)) sellsByWallet.set(ev.wallet, []);
        sellsByWallet.get(ev.wallet).push(ev);
      }
    }

    // Measure hold duration per wallet
    const holdDurationsSec = [];
    for (const [wallet, buys] of buysByWallet.entries()) {
      const sells = sellsByWallet.get(wallet) || [];
      if (buys.length > 0 && sells.length > 0) {
        const firstBuy = buys[0].timeSec;
        const lastSell = sells[sells.length - 1].timeSec;
        const hold = lastSell - firstBuy;
        holdDurationsSec.push(hold);
      }
    }

    // Check entry synchronization between wallets
    const buyTimes = Array.from(buysByWallet.values()).map(bList => bList[0].timeSec);
    let minEntryDeltaSec = 999999;
    if (buyTimes.length >= 2) {
      for (let i = 0; i < buyTimes.length; i++) {
        for (let j = i + 1; j < buyTimes.length; j++) {
          const delta = Math.abs(buyTimes[i] - buyTimes[j]);
          if (delta < minEntryDeltaSec) minEntryDeltaSec = delta;
        }
      }
    }

    const avgHold = holdDurationsSec.length > 0
      ? holdDurationsSec.reduce((a, b) => a + b, 0) / holdDurationsSec.length
      : 999;

    // Check candle price action: Did candles collapse by > 50% immediately after exits?
    let candleCrashDetected = false;
    let maxDrawdownInExitWindow = 0;

    if (candlesData.length > 0 && st.events.length > 0) {
      const exitTimesSec = st.events.filter(e => e.type === 'sell').map(e => e.timeSec);
      if (exitTimesSec.length > 0) {
        const minExitTime = Math.min(...exitTimesSec);
        // Find candles in the 5 minutes following minExitTime
        const exitCandles = candlesData.filter(c => {
          const cSec = Math.floor(c.time / 1000);
          return cSec >= minExitTime - 60 && cSec <= minExitTime + 300;
        });

        if (exitCandles.length >= 2) {
          const highs = exitCandles.map(c => Number(c.high) || 0);
          const lows = exitCandles.map(c => Number(c.low) || 0);
          const maxHigh = Math.max(...highs);
          const minLow = Math.min(...lows);
          if (maxHigh > 0) {
            maxDrawdownInExitWindow = ((maxHigh - minLow) / maxHigh) * 100;
            if (maxDrawdownInExitWindow >= 45) {
              candleCrashDetected = true;
            }
          }
        }
      }
    }

    // Verdict Logic:
    // If entered within 60s of each other AND held for < 90 seconds AND caused a crash candle -> SYNDICATE
    let isSyndicate = false;
    let verdictReason = '';

    if (minEntryDeltaSec <= 15 && avgHold <= 120 && candleCrashDetected) {
      isSyndicate = true;
      verdictReason = `🚨 SYNDICATE CONFIRMED: Masuk bersamaan (selisih ${minEntryDeltaSec} dtk), dump kilat (avg hold ${Math.round(avgHold)} dtk), dan candle crash -${maxDrawdownInExitWindow.toFixed(1)}%!`;
      for (const w of st.wallets) syndicateWalletsBlacklist.add(w);
    } else if (avgHold <= 45 && minEntryDeltaSec <= 30) {
      isSyndicate = true;
      verdictReason = `🚨 SYNDICATE CONFIRMED: Ultra-fast scalp flip terkoordinasi (selisih entry ${minEntryDeltaSec} dtk, hold ${Math.round(avgHold)} dtk).`;
      for (const w of st.wallets) syndicateWalletsBlacklist.add(w);
    } else if (st.mint === 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn') {
      isSyndicate = false;
      verdictReason = `✅ ORGANIC CONSENSUS: Token likuiditas raksasa (PUMP official pool), aktivitas independen wajar.`;
    } else {
      isSyndicate = false;
      verdictReason = `✅ ORGANIC TRADING: Entry terpisah (${minEntryDeltaSec}s delta), durasi hold wajar (${Math.round(avgHold)}s).`;
    }

    console.log(`   Verdict: ${verdictReason}`);
    console.log(`   - Selisih Entry Antar Wallet : ${minEntryDeltaSec === 999999 ? 'N/A' : `${minEntryDeltaSec} detik`}`);
    console.log(`   - Rata-rata Durasi Hold     : ${avgHold === 999 ? 'Belum Exit' : `${Math.round(avgHold)} detik`}`);
    console.log(`   - Crash Candle Terdeteksi   : ${candleCrashDetected ? `YA (-${maxDrawdownInExitWindow.toFixed(1)}%)` : 'TIDAK'}`);

    sharedAnalyses.push({
      mint: st.mint,
      symbol: st.symbol,
      wallets: Array.from(st.wallets),
      isSyndicate,
      verdictReason,
      minEntryDeltaSec,
      avgHoldSec: Math.round(avgHold),
      candleCrashDetected,
      events: st.events
    });
  }

  // 4. Filter Curated Wallets: Remove Syndicate Wallets and keep only Clean Organic Wallets
  console.log(`\n========================================================================`);
  console.log(`🎯 HASIL AKHIR AUDIT SINDIKAT VS WALLET VALID ORGANIK:`);
  console.log(`========================================================================`);
  console.log(`Total Wallet Sindikat Terdeteksi & Diblokir : ${syndicateWalletsBlacklist.size}`);
  for (const sw of syndicateWalletsBlacklist) {
    const matched = candidateWallets.find(cw => cw.address === sw);
    console.log(`  ❌ BLACKLIST: ${sw} (Rank #${matched ? candidateWallets.indexOf(matched) + 1 : '?'})`);
  }

  const cleanWallets = candidateWallets.filter(w => !syndicateWalletsBlacklist.has(w.address));
  console.log(`\nTotal Wallet Valid Organik (Bersih Bukan Sindikat) : ${cleanWallets.length} wallet`);
  console.log('-----------------------------------------------------------------------------------------------------');
  console.log('Clean Rank | Wallet Address                               | WinRate | 30d PnL ($) | Saldo SOL | Status');
  console.log('-----------------------------------------------------------------------------------------------------');
  cleanWallets.forEach((w, idx) => {
    const rankStr = String(idx + 1).padStart(10, ' ');
    const addrStr = w.address.padEnd(44, ' ');
    const wrStr = `${w.winrate30d}%`.padStart(7, ' ');
    const pnlStr = `+$${w.pnl30d.toLocaleString()}`.padStart(11, ' ');
    const solStr = String(w.solBalance.toFixed(1)).padStart(9, ' ');
    console.log(`${rankStr} | ${addrStr} | ${wrStr} | ${pnlStr} | ${solStr} | ✅ ORGANIC SMART`);
  });
  console.log('-----------------------------------------------------------------------------------------------------');

  // Export Results
  const exportData = {
    updatedAt: new Date().toISOString(),
    totalAnalyzed: candidateWallets.length,
    syndicateCount: syndicateWalletsBlacklist.size,
    cleanCount: cleanWallets.length,
    syndicateBlacklist: Array.from(syndicateWalletsBlacklist),
    sharedTokenAudits: sharedAnalyses,
    cleanOrganicWallets: cleanWallets
  };

  const outPath = join(process.cwd(), 'data', 'anti-syndicate-wallet-audit.json');
  writeFileSync(outPath, JSON.stringify(exportData, null, 2), 'utf8');
  console.log(`\n📁 Laporan audit tersimpan lengkap di: ${outPath}`);

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
