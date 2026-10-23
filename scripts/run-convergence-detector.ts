import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConvergenceDetector, type TradeEvent } from "../src/convergence-detector.js";
import { SnowballCollector } from "../src/snowball-collector.js";

async function main() {
  console.log("================================================================================");
  console.log("   🛰️  SMART WALLET LIVE CONVERGENCE & ANTI-SYNDICATE DETECTOR (SNOWBALL MODE)");
  console.log("================================================================================\n");

  // 1. Initialize Snowball Collector and Load Clean Wallets
  const snowball = new SnowballCollector();
  let cleanWallets: string[] = snowball.getAllAddresses();
  console.log(`[INIT] Loaded ${cleanWallets.length} clean organic wallets from Snowball Collector.`);

  // 2. Initialize Detector with strict Lowcap boundary (< $100k MC, price < $0.50)
  const detector = new ConvergenceDetector({
    timeWindowSec: 7200, // 2 hours sliding window for organic multi-wallet accumulation
    cdpUrl: "http://127.0.0.1:9223",
    monitoredWallets: cleanWallets,
    outputFile: "data/convergence-monitor-events.json",
    maxMarketCapUsd: 100_000, // Hard limit: < $100k Lowcaps only
    maxPriceUsd: 0.50 // Hard limit: filter out tokenized stocks ($200+) and large caps
  });

  // Listen for events
  detector.on("golden_signal", (report) => {
    console.log("\n" + "=".repeat(75));
    console.log(`🌟 [GOLDEN CONVERGENCE SIGNAL] Token: ${report.symbol} (${report.mint.slice(0, 8)}...)`);
    console.log(`   Wallets involved (${report.wallets.length}):`);
    if (report.walletEntries && report.walletEntries.length > 0) {
      for (const [idx, we] of report.walletEntries.entries()) {
        const deltaStr = we.deltaSecFromFirst === 0 ? "First Pioneer (0s)" : `+${Math.round(we.deltaSecFromFirst / 60)}m (${we.deltaSecFromFirst}s)`;
        console.log(`     ${idx + 1}. ${we.wallet.slice(0, 8)}...${we.wallet.slice(-6)} | Jam: ${we.enteredAtWib} | Selisih: ${deltaStr} | ${we.solAmount ? we.solAmount + ' SOL' : ''}`);
      }
    } else {
      console.log(`   ${report.wallets.map((w: string) => w.slice(0, 6) + '...').join(', ')}`);
    }
    console.log(`   Entry Delta: ~${Math.round(report.entryDeltaSec / 60)} menit`);
    console.log(`   DEX: ${report.dexInfo?.dexId || 'N/A'} | Price: $${report.dexInfo?.priceUsd || '0'} | Liquidity: $${report.dexInfo?.liquidityUsd?.toLocaleString() || '0'}`);
    console.log(`   24h Volume: $${report.dexInfo?.volume24h?.toLocaleString() || '0'} | 24h Change: ${report.dexInfo?.priceChange24h || 0}%`);
    console.log(`   Reason: ${report.reason}`);
    console.log("=".repeat(75) + "\n");
  });

  detector.on("syndicate_detected", (report) => {
    console.log("\n" + "!".repeat(75));
    console.log(`🚨 [SYNDICATE DUMP DETECTED] Token: ${report.symbol} (${report.mint.slice(0, 8)}...)`);
    console.log(`   Cluster Wallets (${report.wallets.length}):`);
    if (report.walletEntries && report.walletEntries.length > 0) {
      for (const [idx, we] of report.walletEntries.entries()) {
        console.log(`     ${idx + 1}. ${we.wallet.slice(0, 8)}...${we.wallet.slice(-6)} | Masuk: ${we.enteredAtWib} (+${we.deltaSecFromFirst}s)`);
      }
    } else {
      console.log(`   ${report.wallets.map((w: string) => w.slice(0, 6) + '...').join(', ')}`);
    }
    console.log(`   Entry Delta: ${report.entryDeltaSec} DETIK (RAPAT / SEREMPAK!)`);
    console.log(`   Liquidity Status: ${report.isLiquidityDrained ? 'DRAINED / MATI' : '$' + report.dexInfo?.liquidityUsd?.toLocaleString()}`);
    console.log(`   Max Drop: -${report.maxDropPercent}%`);
    console.log(`   Action: Cluster wallets TELAH DI-QUARANTINE!`);
    console.log("!".repeat(75) + "\n");
  });

  detector.on("convergence", (report) => {
    if (report.classification === "ACCUMULATION_WATCH") {
      console.log(`[ACCUMULATION-WATCH] Multi-wallet overlap on ${report.symbol}: ${report.reason}`);
    }
  });

  // 3. Scan mode: if run with --scan or default, check recent transactions
  const isScanMode = process.argv.includes("--scan") || !process.argv.includes("--live");
  if (isScanMode) {
    const allTrades: TradeEvent[] = [];

    // PHASE 1: Bottom-up Discovery of $5k - $100k Lowcap Runners via GMGN CDP
    console.log(`[PHASE 1] 🎯 Discovering active tokens in target range ($5k - $100k MC)...`);
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
      const page = browser.contexts()[0].pages().find(p => p.url().includes("gmgn.ai")) || browser.contexts()[0].pages()[0];
      
      const lowcapTokens = await page.evaluate(async () => {
        try {
          const r = await fetch("https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?limit=30&min_marketcap=5000&max_marketcap=100000");
          const j = await r.json();
          return j.data?.rank || [];
        } catch {
          return [];
        }
      });

      console.log(`[LOWCAP-DISCOVERY] Found ${lowcapTokens.length} tokens in $5k-$100k range. Fetching early buyers...`);

      for (const t of lowcapTokens.slice(0, 20)) {
        try {
          const tradersData = await page.evaluate(async (mint) => {
            const res = await fetch(`https://gmgn.ai/vas/api/v1/token_traders/sol/${mint}?limit=30&orderby=profit&direction=desc`);
            return await res.json();
          }, t.address);

          const list = tradersData.data?.list || [];
          for (const tr of list) {
            const { isNew, wallet } = snowball.ingestTrader(tr, t.symbol, t.address);
            if (wallet) {
              detector.addMonitoredWallet(wallet.address);
              const tradeTime = tr.start_holding_at || tr.last_active_timestamp || Math.floor(Date.now() / 1000);
              allTrades.push({
                wallet: wallet.address,
                mint: t.address,
                symbol: t.symbol,
                side: "buy",
                timestamp: tradeTime,
                solAmount: Number(((tr.cost_cur || 100) / 180).toFixed(3)),
                tokenAmount: tr.buy_amount_cur || 0,
                txSignature: `gmgn_${wallet.address.slice(0, 6)}_${t.address.slice(0, 6)}`
              });
            }
          }
        } catch (err: any) {
          console.log(`[TRADER-FETCH-ERR] ${t.symbol}: ${err.message}`);
        }
      }

      // Save Snowball results
      const { totalCurated, newSnowballed } = snowball.saveSnowball();
      console.log(`[SNOWBALL-COLLECTOR] ❄️ Pool size: ${totalCurated} wallets (+${newSnowballed} new snowballed this cycle).`);
      console.log(`[LOWCAP-DISCOVERY] Harvested ${allTrades.length} lowcap trades across top runners.`);
    } catch (e: any) {
      console.log(`[LOWCAP-DISCOVERY] Skipped phase 1: ${e.message}`);
    }

    const ENABLE_HELIUS = process.env.ENABLE_HELIUS === "true" || process.argv.includes("--with-helius");
    if (!ENABLE_HELIUS) {
      console.log(`\n[PHASE 2] ⚡ Helius Disabled (0 Credits spent). Active Snowball Pool: ${snowball.getStats().totalCurated} wallets.`);
    } else {
      // PHASE 2: Optimized Top-Down Scan with 1-Credit Signature Probe (95%+ Credit Savings)
      console.log(`\n[PHASE 2] 🔍 Probing on-chain signatures across ${cleanWallets.length} clean wallets...`);
      
      const env = readFileSync(".env", "utf8");
      const heliusKey = env.match(/HELIUS_API_KEY=([^\s\r\n]+)/)?.[1] || "";
      
      const TRADES_CACHE_PATH = "data/.clean-wallet-trades-cache.json";
      let walletCache: Record<string, { lastSig: string; trades: TradeEvent[]; updatedAt: number }> = {};
      if (existsSync(TRADES_CACHE_PATH)) {
        try {
          walletCache = JSON.parse(readFileSync(TRADES_CACHE_PATH, "utf8"));
        } catch {}
      }

      // Step 2.1: Probe latest signatures via standard RPC getSignaturesForAddress (1 credit / call)
      const RPC_BATCH_SIZE = 3;
      const latestSignatures: Record<string, string> = {};
      for (let i = 0; i < cleanWallets.length; i += RPC_BATCH_SIZE) {
        const chunk = cleanWallets.slice(i, i + RPC_BATCH_SIZE);
        const rpcBatch = chunk.map((w, idx) => ({
          jsonrpc: "2.0",
          id: i + idx,
          method: "getSignaturesForAddress",
          params: [w, { limit: 1 }]
        }));

        try {
          const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(rpcBatch),
            signal: AbortSignal.timeout(6000)
          });

          if (res.status === 429) {
            await new Promise(r => setTimeout(r, 1000));
            i -= RPC_BATCH_SIZE;
            continue;
          }

          const results = await res.json();
          if (Array.isArray(results)) {
            for (const r of results) {
              const w = chunk[r.id - i];
              if (w && r.result?.[0]?.signature) {
                latestSignatures[w] = r.result[0].signature;
              }
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 350));
      }

      // Step 2.2: Identify active vs idle wallets
      const nowSec = Math.floor(Date.now() / 1000);
      const PRUNE_WINDOW_SEC = 5400; // 90 minutes
      const activeWallets: string[] = [];
      let skippedIdleCount = 0;

      for (const wallet of cleanWallets) {
        const latestSig = latestSignatures[wallet];
        const cached = walletCache[wallet];

        if (!latestSig) {
          if (cached && cached.trades) {
            allTrades.push(...cached.trades.filter(t => (nowSec - t.timestamp) <= PRUNE_WINDOW_SEC));
          }
          continue;
        }

        if (cached && cached.lastSig === latestSig) {
          // Idle: signature has not changed since last scan!
          skippedIdleCount++;
          allTrades.push(...cached.trades.filter(t => (nowSec - t.timestamp) <= PRUNE_WINDOW_SEC));
        } else {
          // Active: signature changed or new wallet!
          activeWallets.push(wallet);
        }
      }

      const creditsSaved = skippedIdleCount * 100;
      console.log(`[PHASE 2] ⚡ Signature Probe: ${activeWallets.length} active wallets queried, ${skippedIdleCount} idle skipped (~${creditsSaved.toLocaleString()} credits saved!)`);

      // Step 2.3: Fetch Enhanced Transactions (100 credits) ONLY for active wallets
      const ENHANCED_BATCH_SIZE = 3;
      for (let i = 0; i < activeWallets.length; i += ENHANCED_BATCH_SIZE) {
        const chunk = activeWallets.slice(i, i + ENHANCED_BATCH_SIZE);
        await Promise.all(chunk.map(async (wallet) => {
          try {
            const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&limit=15`;
            const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
            if (res.status === 429) {
              await new Promise(r => setTimeout(r, 1500));
              return;
            }
            const txs: any[] = await res.json();
            if (!Array.isArray(txs)) return;

            const newTrades: TradeEvent[] = [];
            for (const tx of txs) {
              for (const tt of (tx.tokenTransfers || [])) {
                const mint = tt.mint;
                if (!mint || mint.startsWith("So11111111111111111111111111111111111111112") || mint.startsWith("EPjF")) {
                  continue;
                }
                const isBuy = tt.toUserAccount === wallet;
                if (!isBuy) continue;

                let solAmount = 0;
                for (const nt of (tx.nativeTransfers || [])) {
                  if (nt.fromUserAccount === wallet) {
                    solAmount += (Number(nt.amount) || 0) / 1e9;
                  }
                }

                const trade: TradeEvent = {
                  wallet,
                  mint,
                  side: "buy",
                  timestamp: tx.timestamp,
                  solAmount: Number(solAmount.toFixed(4)),
                  tokenAmount: Number(tt.tokenAmount) || 0,
                  txSignature: tx.signature
                };
                newTrades.push(trade);
              }
            }

            // Merge new trades into wallet cache (dedupe by signature)
            const existingTrades = (walletCache[wallet]?.trades || []).filter(t => (nowSec - t.timestamp) <= PRUNE_WINDOW_SEC);
            const sigSet = new Set(existingTrades.map(t => t.txSignature));
            for (const nt of newTrades) {
              if (!sigSet.has(nt.txSignature)) {
                existingTrades.push(nt);
                sigSet.add(nt.txSignature);
              }
            }

            walletCache[wallet] = {
              lastSig: latestSignatures[wallet] || txs[0]?.signature || "",
              trades: existingTrades,
              updatedAt: Date.now()
            };

            allTrades.push(...existingTrades);
          } catch {}
        }));
        await new Promise(r => setTimeout(r, 250));
      }

      // Persist clean wallet trades cache
      try {
        writeFileSync(TRADES_CACHE_PATH, JSON.stringify(walletCache, null, 2));
      } catch {}
    }

    // Sort trades chronologically for perfect replay evaluation
    allTrades.sort((a, b) => a.timestamp - b.timestamp);

    for (const t of allTrades) {
      await detector.recordTrade(t);
    }

    console.log(`\n[SCAN-COMPLETE] Ingested ${allTrades.length} buy events. Active mints tracked: ${detector.getActiveMintsCount()}`);
    console.log(`[REPORT-SAVED] Convergence history persisted to data/convergence-monitor-events.json`);
    await detector.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal error running convergence detector:", err);
  process.exit(1);
});
