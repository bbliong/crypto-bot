import { SolanaRpcQueue } from "../src/solana-rpc-queue.js";
import { readFileSync } from "node:fs";

async function main() {
  console.log("================================================================================");
  console.log("   🛡️  TESTING LIVE SOLANA RPC QUEUE (RATE-LIMIT IMMUNITY PROOF)");
  console.log("================================================================================\n");

  const topWallets = JSON.parse(readFileSync("data/.benchmark-top50-wallets.json", "utf8")).slice(0, 20);
  console.log(`[INIT] Loaded ${topWallets.length} target wallets for live queue test.`);

  // Instantiate queue with auto rate-limiting (max 6 req/10s, min 1000ms interval)
  const queue = new SolanaRpcQueue({
    rpcUrl: "https://api.mainnet-beta.solana.com"
  });

  const startTime = Date.now();
  console.log("[START] Enqueuing 20 wallet signature queries simultaneously...\n");

  const results = await Promise.all(
    topWallets.map(async (wallet: string, idx: number) => {
      const priority = idx < 3 ? "HIGH" : "NORMAL";
      try {
        const sigs = await queue.getSignaturesForAddress(wallet, 1, priority);
        const lastSig = sigs[0]?.signature ? sigs[0].signature.slice(0, 12) + "..." : "No tx";
        const blockTime = sigs[0]?.blockTime ? new Date(sigs[0].blockTime * 1000).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }) : "N/A";
        console.log(`  ✅ [#${idx + 1}] Priority: ${priority.padEnd(6)} | Wallet: ${wallet.slice(0, 8)}... | Last Tx: ${lastSig} (${blockTime})`);
        return { wallet, success: true };
      } catch (err: any) {
        console.log(`  ❌ [#${idx + 1}] Wallet: ${wallet.slice(0, 8)}... | Error: ${err.message}`);
        return { wallet, success: false, error: err.message };
      }
    })
  );

  const totalDurationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const stats = queue.getStats();

  console.log("\n" + "=".repeat(80));
  console.log("   📊 QUEUE PERFORMANCE REPORT");
  console.log("=".repeat(80));
  console.log(`Total Requests Enqueued:   ${stats.totalEnqueued}`);
  console.log(`Total Completed:           ${stats.totalCompleted} / ${topWallets.length}`);
  console.log(`HTTP 429 Errors Hit:       ${stats.total429s} (TARGET: 0)`);
  console.log(`Other Errors:              ${stats.totalErrors}`);
  console.log(`Average Latency per Call:  ${stats.avgLatencyMs} ms`);
  console.log(`Total Execution Time:      ${totalDurationSec}s`);
  console.log("=".repeat(80));

  if (stats.total429s === 0 && stats.totalCompleted === topWallets.length) {
    console.log("🏆 VERIFIED: Queue successfully prevented any rate-limiting!");
  }
}

main();
