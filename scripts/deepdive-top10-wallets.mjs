import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function main() {
  console.log('=== DEEP DIVE TOP 10 SMART WALLETS ===\n');
  const jsonPath = join(process.cwd(), 'data', 'curated-lowcap-smart-wallets.json');
  const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const top10 = data.wallets.slice(0, 10);

  console.log(`Top 10 Target Wallets loaded. Connecting to Chrome CDP at port 9223...`);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages()[0];

  // Map to collect token overlap across wallets:
  // tokenMint -> { symbol, wallets: Set<string>, buyEvents: Array<{ wallet, costUsd, time, price }> }
  const tokenMap = new Map();
  const walletDeepDives = [];

  for (let i = 0; i < top10.length; i++) {
    const w = top10[i];
    console.log(`[${i + 1}/10] Querying wallet: ${w.address} (30d WR: ${w.winrate30d}%, PnL: +$${w.pnl30d.toLocaleString()})...`);

    const result = await page.evaluate(async (addr) => {
      try {
        const [actsRes, sellsRes] = await Promise.all([
          fetch(`/vas/api/v1/wallet_activity/sol?wallet=${addr}&limit=30&cost=usd`).then(r => r.json()).catch(() => ({})),
          fetch(`/vas/api/v1/wallet_activity/sol?wallet=${addr}&type=sell&limit=10&cost=usd`).then(r => r.json()).catch(() => ({}))
        ]);
        return {
          activities: actsRes.data?.activities || [],
          sells: sellsRes.data?.activities || []
        };
      } catch (err) {
        return { activities: [], sells: [], error: err.message };
      }
    }, w.address);

    const activities = result.activities;
    const sells = result.sells;

    // Analyze Last Sell / Realized Trade
    let lastRealizedTrade = null;
    if (sells.length > 0) {
      const s = sells[0];
      const sellProceeds = Number(s.cost_usd) || 0;
      const buyCost = Number(s.buy_cost_usd) || 0;
      const netPnl = sellProceeds - buyCost;
      const roiPct = buyCost > 0 ? (netPnl / buyCost) * 100 : 0;
      lastRealizedTrade = {
        type: 'SELL',
        tokenSymbol: s.token?.symbol || 'UNKNOWN',
        tokenMint: s.token?.address || '',
        time: new Date(s.timestamp * 1000).toISOString(),
        sellProceedsUsd: Number(sellProceeds.toFixed(2)),
        buyCostUsd: Number(buyCost.toFixed(2)),
        netPnlUsd: Number(netPnl.toFixed(2)),
        roiPct: Number(roiPct.toFixed(1)),
        isProfitable: netPnl > 0
      };
    }

    // Analyze Recent Buys (to see active positions and check convergence)
    const recentBuys = activities.filter(a => a.event_type === 'buy');
    const recentTokensTraded = new Set();

    for (const act of activities) {
      const mint = act.token?.address;
      const symbol = act.token?.symbol || 'UNKNOWN';
      if (!mint) continue;

      recentTokensTraded.add(mint);

      if (!tokenMap.has(mint)) {
        tokenMap.set(mint, {
          mint,
          symbol,
          wallets: new Set(),
          events: []
        });
      }

      const entry = tokenMap.get(mint);
      entry.wallets.add(w.address);
      entry.events.push({
        wallet: w.address,
        event: act.event_type,
        time: new Date(act.timestamp * 1000).toISOString(),
        costUsd: Number(act.cost_usd) || 0,
        priceUsd: Number(act.price_usd) || 0
      });
    }

    walletDeepDives.push({
      rank: i + 1,
      address: w.address,
      solBalance: w.solBalance,
      pnl30d: w.pnl30d,
      winrate30d: w.winrate30d,
      lastRealizedTrade,
      totalRecentActivities: activities.length,
      recentTokensTradedCount: recentTokensTraded.size
    });

    await new Promise(r => setTimeout(r, 200)); // friendly pacing
  }

  // Find Convergence (Tokens entered/traded by 2 or more wallets in Top 10)
  const sharedTokens = [];
  for (const [mint, info] of tokenMap.entries()) {
    if (info.wallets.size >= 2) {
      sharedTokens.push({
        mint,
        symbol: info.symbol,
        walletCount: info.wallets.size,
        wallets: Array.from(info.wallets),
        events: info.events
      });
    }
  }

  sharedTokens.sort((a, b) => b.walletCount - a.walletCount);

  // Write detailed report
  const output = {
    analyzedAt: new Date().toISOString(),
    top10Wallets: walletDeepDives,
    sharedTokensSummary: sharedTokens
  };

  const outPath = join(process.cwd(), 'data', 'top10-deepdive-report.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nSaved deep-dive results to: ${outPath}`);

  // Print Summary
  console.log('\n========================================================================================');
  console.log('📌 STATUS TRANSAKSI TERAKHIR DARI TOP 10 WALLET (UNTUNG vs RUGI):');
  console.log('========================================================================================');
  for (const d of walletDeepDives) {
    const t = d.lastRealizedTrade;
    const rankStr = `#${d.rank}`.padEnd(4, ' ');
    const addrStr = `${d.address.slice(0, 4)}...${d.address.slice(-4)}`.padEnd(12, ' ');
    if (t) {
      const statusStr = t.isProfitable ? '✅ UNTUNG' : '❌ RUGI ';
      const pnlStr = (t.netPnlUsd >= 0 ? `+$${t.netPnlUsd}` : `-$${Math.abs(t.netPnlUsd)}`).padEnd(10, ' ');
      const roiStr = `(${t.roiPct >= 0 ? '+' : ''}${t.roiPct}%)`.padEnd(10, ' ');
      console.log(`${rankStr} | ${addrStr} | Last Sell: ${t.tokenSymbol.padEnd(12, ' ')} | Status: ${statusStr} | PnL: ${pnlStr} | ROI: ${roiStr} | Waktu: ${t.time}`);
    } else {
      console.log(`${rankStr} | ${addrStr} | Belum ada riwayat SELL tercatat di GMGN activity`);
    }
  }

  console.log('\n========================================================================================');
  console.log(`🤝 CONVERGENCE / TOKEN BERSAMA (Di-trade oleh ≥ 2 Wallet Top 10):`);
  console.log('========================================================================================');
  if (sharedTokens.length === 0) {
    console.log('Tidak ada token yang di-trade bersamaan oleh Top 10 wallet dalam aktivitas terakhir.');
  } else {
    for (const st of sharedTokens) {
      console.log(`🔥 Token: ${st.symbol} (${st.mint})`);
      console.log(`   Jumlah Wallet: ${st.walletCount} wallet dari Top 10`);
      console.log(`   Daftar Wallet: ${st.wallets.map(w => w.slice(0, 6) + '...' + w.slice(-4)).join(', ')}`);
      for (const ev of st.events.slice(0, 4)) {
        console.log(`    - [${ev.wallet.slice(0, 6)}] ${ev.event.toUpperCase()} $${ev.costUsd.toFixed(1)} pada ${ev.time}`);
      }
      console.log('');
    }
  }

  await browser.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Error in deepdive:', err);
  process.exit(1);
});
