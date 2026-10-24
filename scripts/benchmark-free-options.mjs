import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const topWallets = JSON.parse(readFileSync("data/.benchmark-top50-wallets.json", "utf8"));
console.log(`[BENCHMARK] Starting parallel test with ${topWallets.length} target smart wallets...`);

const stats = {
  opt1_pumpportal: {
    status: "STARTING",
    eventsReceived: 0,
    trades: [],
    errors: [],
    connectTimeMs: 0,
    firstEventLatencyMs: null
  },
  opt2_gmgn_cdp: {
    status: "STARTING",
    scansCompleted: 0,
    tokensFound: 0,
    matchingTradersFound: 0,
    cycleTimesMs: [],
    errors: []
  },
  opt3_public_rpc: {
    status: "STARTING",
    requestsSent: 0,
    successResponses: 0,
    rateLimitedCount: 0,
    errors: [],
    avgResponseTimeMs: 0,
    signaturesDetected: 0
  }
};

const startTime = Date.now();

// ==========================================
// OPTION 1: PumpPortal Real-Time WebSocket
// ==========================================
async function runOption1() {
  const t0 = Date.now();
  try {
    const ws = new WebSocket("wss://pumpportal.fun/api/data");
    
    ws.on("open", () => {
      stats.opt1_pumpportal.connectTimeMs = Date.now() - t0;
      stats.opt1_pumpportal.status = "CONNECTED";
      console.log(`[OPT 1 - PumpPortal] Connected in ${stats.opt1_pumpportal.connectTimeMs}ms. Subscribing to ${topWallets.length} wallets...`);
      
      // Subscribe to trades from these wallets
      ws.send(JSON.stringify({
        method: "subscribeAccountTrade",
        keys: topWallets
      }));

      // Also subscribe to Raydium / token migrations on pump if supported, or sample test
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        stats.opt1_pumpportal.eventsReceived++;
        if (!stats.opt1_pumpportal.firstEventLatencyMs) {
          stats.opt1_pumpportal.firstEventLatencyMs = Date.now() - t0;
        }
        
        if (msg.txType || msg.traderPublicKey || msg.signature) {
          stats.opt1_pumpportal.trades.push({
            trader: msg.traderPublicKey,
            mint: msg.mint,
            txType: msg.txType,
            solAmount: msg.solAmount,
            marketCapSol: msg.marketCapSol,
            receivedAt: new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" })
          });
          console.log(`[OPT 1 - PumpPortal] ⚡ Trade detected! Type: ${msg.txType} | Trader: ${msg.traderPublicKey?.slice(0, 8)}... | Token: ${msg.mint?.slice(0, 8)}... | SOL: ${msg.solAmount}`);
        }
      } catch (err) {
        stats.opt1_pumpportal.errors.push(err.message);
      }
    });

    ws.on("error", (err) => {
      stats.opt1_pumpportal.status = "ERROR";
      stats.opt1_pumpportal.errors.push(err.message);
    });

    ws.on("close", (code, reason) => {
      stats.opt1_pumpportal.status = `CLOSED (${code})`;
    });

    return () => {
      try { ws.close(); } catch {}
    };
  } catch (e) {
    stats.opt1_pumpportal.status = "FAILED";
    stats.opt1_pumpportal.errors.push(e.message);
    return () => {};
  }
}

// ==========================================
// OPTION 2: GMGN CDP Polling (0 Credits)
// ==========================================
async function runOption2() {
  let isRunning = true;
  (async () => {
    try {
      const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
      const context = browser.contexts()[0];
      const page = context.pages().find(p => p.url().includes("gmgn.ai")) || context.pages()[0];
      stats.opt2_gmgn_cdp.status = "ACTIVE";
      console.log("[OPT 2 - GMGN CDP] Connected to CDP session. Starting polling loops...");

      const walletSet = new Set(topWallets);

      while (isRunning) {
        const cycleStart = Date.now();
        try {
          const res = await page.evaluate(async () => {
            const r = await fetch("https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?limit=20&min_marketcap=5000&max_marketcap=100000");
            return await r.json();
          });
          const tokens = res.data?.rank || [];
          stats.opt2_gmgn_cdp.tokensFound = tokens.length;

          // Check top 3 tokens for smart traders
          for (const t of tokens.slice(0, 3)) {
            if (!isRunning) break;
            const tradersRes = await page.evaluate(async (mint) => {
              const r = await fetch(`https://gmgn.ai/vas/api/v1/token_traders/sol/${mint}?limit=30&orderby=profit&direction=desc`);
              return await r.json();
            }, t.address);
            const list = tradersRes.data?.list || [];
            const matches = list.filter(tr => walletSet.has(tr.address));
            if (matches.length > 0) {
              stats.opt2_gmgn_cdp.matchingTradersFound += matches.length;
              console.log(`[OPT 2 - GMGN CDP] 🎯 Found ${matches.length} smart wallet(s) in token ${t.symbol} ($${Math.round(t.market_cap || 0).toLocaleString()} MC)`);
            }
          }

          const cycleDuration = Date.now() - cycleStart;
          stats.opt2_gmgn_cdp.cycleTimesMs.push(cycleDuration);
          stats.opt2_gmgn_cdp.scansCompleted++;
          console.log(`[OPT 2 - GMGN CDP] Cycle #${stats.opt2_gmgn_cdp.scansCompleted} done in ${(cycleDuration / 1000).toFixed(1)}s (20 tokens scanned).`);
        } catch (e) {
          stats.opt2_gmgn_cdp.errors.push(e.message);
        }
        // Rest 15s between cycles in benchmark
        for (let i = 0; i < 15 && isRunning; i++) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      await browser.close();
    } catch (e) {
      stats.opt2_gmgn_cdp.status = "FAILED";
      stats.opt2_gmgn_cdp.errors.push(e.message);
    }
  })();

  return () => { isRunning = false; };
}

// ==========================================
// OPTION 3: Public Free Solana RPC (Mainnet Beta Official)
// ==========================================
async function runOption3() {
  let isRunning = true;
  (async () => {
    stats.opt3_public_rpc.status = "ACTIVE";
    console.log("[OPT 3 - Public RPC] Starting probe on https://api.mainnet-beta.solana.com...");
    const RPC_URL = "https://api.mainnet-beta.solana.com";

    const responseTimes = [];

    // Probe 10 wallets every 15s to test rate limits & latency
    const sampleWallets = topWallets.slice(0, 10);

    while (isRunning) {
      for (const wallet of sampleWallets) {
        if (!isRunning) break;
        const reqStart = Date.now();
        stats.opt3_public_rpc.requestsSent++;
        try {
          const resp = await fetch(RPC_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getSignaturesForAddress",
              params: [wallet, { limit: 1 }]
            }),
            signal: AbortSignal.timeout(5000)
          });

          const duration = Date.now() - reqStart;
          responseTimes.push(duration);

          if (resp.status === 429) {
            stats.opt3_public_rpc.rateLimitedCount++;
            console.log(`[OPT 3 - Public RPC] ⚠️ Rate limit 429 hit!`);
          } else if (resp.ok) {
            const data = await resp.json();
            if (data.result && data.result.length > 0) {
              stats.opt3_public_rpc.signaturesDetected++;
            }
            stats.opt3_public_rpc.successResponses++;
          } else {
            stats.opt3_public_rpc.errors.push(`HTTP ${resp.status}`);
          }
        } catch (e) {
          stats.opt3_public_rpc.errors.push(e.message);
        }
        await new Promise(r => setTimeout(r, 200)); // 200ms throttle
      }

      stats.opt3_public_rpc.avgResponseTimeMs = responseTimes.length > 0 
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) 
        : 0;

      console.log(`[OPT 3 - Public RPC] Batch of 10 wallets completed. Avg latency: ${stats.opt3_public_rpc.avgResponseTimeMs}ms. 429 errors: ${stats.opt3_public_rpc.rateLimitedCount}`);
      
      // Rest 15s between batches
      for (let i = 0; i < 15 && isRunning; i++) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  })();

  return () => { isRunning = false; };
}

// RUN BENCHMARK FOR 60 SECONDS
async function main() {
  const stopOpt1 = await runOption1();
  const stopOpt2 = await runOption2();
  const stopOpt3 = await runOption3();

  const BENCHMARK_DURATION_SEC = 50;
  console.log(`\n⏳ Benchmark is running in parallel for ${BENCHMARK_DURATION_SEC} seconds...\n`);

  await new Promise(r => setTimeout(r, BENCHMARK_DURATION_SEC * 1000));

  stopOpt1();
  stopOpt2();
  stopOpt3();

  console.log("\n" + "=".repeat(80));
  console.log("   📊 PARALLEL BENCHMARK RESULTS (100% FREE OPTIONS)");
  console.log("=".repeat(80));

  console.log("\n1️⃣  OPTION 1: PumpPortal Real-Time WebSocket");
  console.log(`   - Status: ${stats.opt1_pumpportal.status}`);
  console.log(`   - Connection Time: ${stats.opt1_pumpportal.connectTimeMs}ms`);
  console.log(`   - Target Wallets Subscribed: ${topWallets.length}`);
  console.log(`   - Real-Time Trade Events Captured: ${stats.opt1_pumpportal.trades.length}`);
  console.log(`   - Errors/Disconnects: ${stats.opt1_pumpportal.errors.length}`);

  console.log("\n2️⃣  OPTION 2: GMGN CDP Polling (Local Chrome 9223)");
  console.log(`   - Status: ${stats.opt2_gmgn_cdp.status}`);
  console.log(`   - Scans Completed (Cycles): ${stats.opt2_gmgn_cdp.scansCompleted}`);
  console.log(`   - Low-Cap Tokens Scanned per Cycle: ${stats.opt2_gmgn_cdp.tokensFound}`);
  console.log(`   - Avg Cycle Time: ${stats.opt2_gmgn_cdp.cycleTimesMs.length ? (stats.opt2_gmgn_cdp.cycleTimesMs.reduce((a,b)=>a+b,0)/stats.opt2_gmgn_cdp.cycleTimesMs.length/1000).toFixed(1) : 0}s`);
  console.log(`   - Matching Smart Wallets Identified: ${stats.opt2_gmgn_cdp.matchingTradersFound}`);
  console.log(`   - Errors: ${stats.opt2_gmgn_cdp.errors.length}`);

  console.log("\n3️⃣  OPTION 3: Public Free RPC (Ankr Solana)");
  console.log(`   - Status: ${stats.opt3_public_rpc.status}`);
  console.log(`   - Requests Sent: ${stats.opt3_public_rpc.requestsSent}`);
  console.log(`   - Success Responses: ${stats.opt3_public_rpc.successResponses}`);
  console.log(`   - Rate-Limited (HTTP 429): ${stats.opt3_public_rpc.rateLimitedCount}`);
  console.log(`   - Avg Network Latency: ${stats.opt3_public_rpc.avgResponseTimeMs}ms`);
  console.log(`   - Errors: ${stats.opt3_public_rpc.errors.length}`);

  console.log("\n" + "=".repeat(80));
  process.exit(0);
}

main();
