import { readFileSync, existsSync } from "node:fs";
import { ConvergenceDetector, type TradeEvent } from "../src/convergence-detector.js";

async function main() {
  console.log("================================================================================");
  console.log("   🛰️  SMART WALLET LIVE CONVERGENCE & ANTI-SYNDICATE DETECTOR");
  console.log("================================================================================\n");

  // 1. Load Clean Organic Wallets
  const auditPath = "data/syndicate-candle-audit-results.json";
  let cleanWallets: string[] = [];

  if (existsSync(auditPath)) {
    try {
      const data = JSON.parse(readFileSync(auditPath, "utf8"));
      cleanWallets = data.cleanOrganicWallets.map((w: any) => w.address);
      console.log(`[INIT] Loaded ${cleanWallets.length} clean organic wallets from audit results.`);
    } catch {}
  }

  if (cleanWallets.length === 0) {
    const curatedPath = "data/curated-lowcap-smart-wallets.json";
    if (existsSync(curatedPath)) {
      const data = JSON.parse(readFileSync(curatedPath, "utf8"));
      cleanWallets = data.slice(0, 25).map((w: any) => w.address);
      console.log(`[INIT] Fallback: Loaded ${cleanWallets.length} curated wallets.`);
    }
  }

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
    console.log(`   Wallets involved (${report.wallets.length}): ${report.wallets.map((w: string) => w.slice(0, 6) + '...').join(', ')}`);
    console.log(`   Entry Delta: ~${Math.round(report.entryDeltaSec / 60)} menit`);
    console.log(`   DEX: ${report.dexInfo?.dexId || 'N/A'} | Price: $${report.dexInfo?.priceUsd || '0'} | Liquidity: $${report.dexInfo?.liquidityUsd?.toLocaleString() || '0'}`);
    console.log(`   24h Volume: $${report.dexInfo?.volume24h?.toLocaleString() || '0'} | 24h Change: ${report.dexInfo?.priceChange24h || 0}%`);
    console.log(`   Reason: ${report.reason}`);
    console.log("=".repeat(75) + "\n");
  });

  detector.on("syndicate_detected", (report) => {
    console.log("\n" + "!".repeat(75));
    console.log(`🚨 [SYNDICATE DUMP DETECTED] Token: ${report.symbol} (${report.mint.slice(0, 8)}...)`);
    console.log(`   Cluster Wallets (${report.wallets.length}): ${report.wallets.map((w: string) => w.slice(0, 6) + '...').join(', ')}`);
    console.log(`   Entry Delta: ${report.entryDeltaSec} DETIK (RAPAT / SEREMPAK!)`);
    console.log(`   Liquidity Status: ${report.isLiquidityDrained ? 'DRAINED / MATI' : '$' + report.dexInfo?.liquidityUsd?.toLocaleString()}`);
    console.log(`   Max Drop: -${report.maxDropPercent}%`);
    console.log(`   Action: Wallets ${report.wallets.map((w: string) => w.slice(0, 6) + '...').join(', ')} TELAH DI-QUARANTINE!`);
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

      for (const t of lowcapTokens.slice(0, 12)) {
        if (t.smart_degen_count < 2) continue;
        try {
          const tradersData = await page.evaluate(async (mint) => {
            const res = await fetch(`https://gmgn.ai/vas/api/v1/token_traders/sol/${mint}?limit=25&orderby=profit&direction=desc`);
            return await res.json();
          }, t.address);

          const list = tradersData.data?.list || [];
          const smartTraders = list.filter((tr: any) => 
            tr.profit > 50 && 
            !tr.is_suspicious && 
            (!tr.maker_token_tags || !tr.maker_token_tags.includes("bundler"))
          );

          for (const tr of smartTraders) {
            detector.addMonitoredWallet(tr.address);
            const tradeTime = tr.start_holding_at || tr.last_active_timestamp || Math.floor(Date.now() / 1000);
            allTrades.push({
              wallet: tr.address,
              mint: t.address,
              symbol: t.symbol,
              side: "buy",
              timestamp: tradeTime,
              solAmount: Number(((tr.cost_cur || 100) / 180).toFixed(3)),
              tokenAmount: tr.buy_amount_cur || 0,
              txSignature: `gmgn_${tr.address.slice(0, 6)}_${t.address.slice(0, 6)}`
            });
          }
        } catch {}
      }
      console.log(`[LOWCAP-DISCOVERY] Harvested ${allTrades.length} lowcap trades across top runners.`);
    } catch (e: any) {
      console.log(`[LOWCAP-DISCOVERY] Skipped phase 1: ${e.message}`);
    }

    // PHASE 2: Top-down Scan of Clean Wallets on Helius
    console.log(`\n[PHASE 2] 🔍 Scanning on-chain transactions across ${cleanWallets.length} clean wallets...`);
    
    const env = readFileSync(".env", "utf8");
    const heliusKey = env.match(/HELIUS_API_KEY=([^\s\r\n]+)/)?.[1] || "";
    
    const BATCH_SIZE = 4;

    for (let i = 0; i < cleanWallets.length; i += BATCH_SIZE) {
      const chunk = cleanWallets.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map(async (wallet) => {
        try {
          const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&limit=25`;
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (res.status === 429) {
            await new Promise(r => setTimeout(r, 1500));
            return;
          }
          const txs: any[] = await res.json();
          if (!Array.isArray(txs)) return;

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

              allTrades.push(trade);
            }
          }
        } catch {}
      }));
      await new Promise(r => setTimeout(r, 200));
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
