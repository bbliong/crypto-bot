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

  // 2. Initialize Detector
  const detector = new ConvergenceDetector({
    timeWindowSec: 1800, // 30 minutes sliding window
    cdpUrl: "http://127.0.0.1:9223",
    monitoredWallets: cleanWallets,
    outputFile: "data/convergence-monitor-events.json"
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
    console.log(`[SCAN] Scanning recent on-chain transactions across ${cleanWallets.length} clean wallets...`);
    
    const env = readFileSync(".env", "utf8");
    const heliusKey = env.match(/HELIUS_API_KEY=([^\s\r\n]+)/)?.[1] || "";
    
    const BATCH_SIZE = 3;
    let totalTradesIngested = 0;

    for (let i = 0; i < cleanWallets.length; i += BATCH_SIZE) {
      const chunk = cleanWallets.slice(i, i + BATCH_SIZE);
      await Promise.all(chunk.map(async (wallet) => {
        try {
          const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${heliusKey}&limit=20`;
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

              totalTradesIngested++;
              await detector.recordTrade(trade);
            }
          }
        } catch {}
      }));
      await new Promise(r => setTimeout(r, 250));
    }

    console.log(`\n[SCAN-COMPLETE] Ingested ${totalTradesIngested} buy events. Active mints tracked: ${detector.getActiveMintsCount()}`);
    console.log(`[REPORT-SAVED] Convergence history persisted to data/convergence-monitor-events.json`);
    await detector.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal error running convergence detector:", err);
  process.exit(1);
});
