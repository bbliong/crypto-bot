import { chromium } from "playwright";
import WebSocket from "ws";

function parseTokenActivities(payload, observedAt) {
  const channel = payload?.channel;
  if (channel !== "token_activity_info_all" && channel !== "token_activity") return [];
  const records = payload?.data;
  if (!Array.isArray(records)) return [];
  const result = [];
  for (const record of records) {
    if (record?.n !== "sol") continue;
    const mint = record?.a;
    const side = record?.e;
    if (!mint || (side !== "buy" && side !== "sell")) continue;
    const seconds = Number(record?.t);
    const occurredAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : observedAt;
    const rawPrice = Number(record?.pu);
    const rawAmount = Number(record?.au);
    const actor = record?.m || record?.ad;
    result.push({
      mint,
      side,
      occurredAt,
      observedAt,
      priceUsd: rawPrice,
      amount: rawAmount,
      actorAddress: actor,
    });
  }
  return result;
}

const TOKEN_MINT = process.argv[2] || "7jNwX4Me9zGEjmWY7zARDG2LYjVs1WXD6DZ1JvSfpump";
const DURATION_SECONDS = 30;

console.log(`=======================================================`);
console.log(`LIVE 30-SECOND BENCHMARK: DIRECT WEBSOCKET vs CHROME GMGN`);
console.log(`Token Mint: ${TOKEN_MINT}`);
console.log(`Duration  : ${DURATION_SECONDS} seconds`);
console.log(`=======================================================\n`);

const directTrades = [];
const chromeTrades = [];
let directFramesCount = 0;
let chromeFramesCount = 0;
let directBytes = 0;
let chromeBytes = 0;

// 1. Setup Direct WebSocket
function setupDirectWs() {
  return new Promise((resolve, reject) => {
    const wsUrl = "wss://ws.gmgn.ai/v2/ws?device_id=2d641f4c-9eb7-4dda-8e7e-9a0e273b7757&tab_id=mv8zjbaz0kmy&fp_did=53b08a7a5aa335d9621f3643748ed83f&client_id=gmgn_web_20261015-5468-4781410&from_app=gmgn&app_ver=20261015-5468-4781410&tz_name=Asia_Jakarta&tz_offset=25200&app_lang=en-US&os=web&worker=0&uuid=4c7c17f94ae78782&reconnect=0";
    const ws = new WebSocket(wsUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X-UA-Compatible; Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Origin": "https://gmgn.ai"
      }
    });

    ws.on("open", () => {
      console.log("[Direct WS] Connected successfully!");
      // Subscribe to token activity
      ws.send(JSON.stringify({
        action: "subscribe",
        channel: "token_activity",
        f: "w",
        id: "dir_" + Math.random().toString(16).slice(2, 10),
        data: [{ chain: "sol", addresses: TOKEN_MINT }]
      }));
      resolve(ws);
    });

    ws.on("message", (data) => {
      directFramesCount++;
      directBytes += data.length;
      const now = Date.now();
      try {
        const payload = JSON.parse(data.toString());
        const activities = parseTokenActivities(payload, now);
        for (const act of activities) {
          if (act.mint === TOKEN_MINT) {
            directTrades.push({
              receivedAt: now,
              occurredAt: act.occurredAt,
              side: act.side,
              priceUsd: act.priceUsd,
              amount: act.amount,
              actorAddress: act.actorAddress,
              source: "direct_ws"
            });
          }
        }
      } catch (err) {
        // ignore parse errors for ping/pong
      }
    });

    ws.on("error", (err) => {
      console.error("[Direct WS] Error:", err.message);
    });
  });
}

// 2. Setup Chrome GMGN Page via CDP
async function setupChromeGmgn() {
  console.log("[Chrome GMGN] Connecting over CDP to port 9223...");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const context = browser.contexts()[0];
  const page = await context.newPage();

  page.on("websocket", (socket) => {
    if (!socket.url().includes("gmgn.ai")) return;
    console.log("[Chrome GMGN] Page attached to GMGN WebSocket:", socket.url().slice(0, 50) + "...");
    socket.on("framereceived", ({ payload }) => {
      chromeFramesCount++;
      chromeBytes += (typeof payload === "string" ? payload.length : payload?.byteLength || 0);
      const now = Date.now();
      try {
        const parsed = typeof payload === "string" ? JSON.parse(payload) : null;
        if (!parsed) return;
        const activities = parseTokenActivities(parsed, now);
        for (const act of activities) {
          if (act.mint === TOKEN_MINT) {
            chromeTrades.push({
              receivedAt: now,
              occurredAt: act.occurredAt,
              side: act.side,
              priceUsd: act.priceUsd,
              amount: act.amount,
              actorAddress: act.actorAddress,
              source: "chrome_gmgn"
            });
          }
        }
      } catch (err) {}
    });
  });

  console.log(`[Chrome GMGN] Navigating to https://gmgn.ai/sol/token/${TOKEN_MINT}...`);
  await page.goto(`https://gmgn.ai/sol/token/${TOKEN_MINT}`, {
    timeout: 30000,
    waitUntil: "domcontentloaded"
  });
  console.log("[Chrome GMGN] Page loaded successfully!");

  return { browser, page };
}

async function run() {
  const [directWs, chromeObj] = await Promise.all([
    setupDirectWs(),
    setupChromeGmgn()
  ]);

  console.log(`\n>>> STARTING 30-SECOND SIMULTANEOUS OBSERVATION <<<\n`);
  const startTime = Date.now();

  for (let s = 1; s <= DURATION_SECONDS; s++) {
    await new Promise(r => setTimeout(r, 1000));
    if (s % 5 === 0 || s === DURATION_SECONDS) {
      console.log(`[${s}s / ${DURATION_SECONDS}s] Direct Trades: ${directTrades.length} | Chrome Trades: ${chromeTrades.length}`);
    }
  }

  const endTime = Date.now();
  console.log(`\n>>> OBSERVATION FINISHED (${((endTime - startTime) / 1000).toFixed(1)}s) <<<\n`);

  // Cleanup
  directWs.close();
  await chromeObj.page.close().catch(() => {});
  // Do not close browser so we don't disrupt daemon

  // Analysis & Comparison
  console.log(`=======================================================`);
  console.log(`COMPARISON RESULTS SUMMARY`);
  console.log(`=======================================================`);

  console.log(`1. DATA CAPTURE METRICS:`);
  console.log(`   - Direct WebSocket Trades Captured: ${directTrades.length}`);
  console.log(`   - Chrome GMGN Trades Captured     : ${chromeTrades.length}`);
  console.log(`   - Direct WS Frames Received       : ${directFramesCount} (${(directBytes / 1024).toFixed(1)} KB)`);
  console.log(`   - Chrome WS Frames Received       : ${chromeFramesCount} (${(chromeBytes / 1024).toFixed(1)} KB)`);

  // Match trades between direct and chrome to compare latency and values
  // A match is when occurredAt, side, and priceUsd (within 0.001%) or actor match
  const matches = [];
  for (const dt of directTrades) {
    const match = chromeTrades.find(ct =>
      Math.abs(ct.occurredAt - dt.occurredAt) <= 2000 &&
      ct.side === dt.side &&
      Math.abs(ct.priceUsd - dt.priceUsd) < 0.0000001
    );
    if (match) {
      matches.push({
        direct: dt,
        chrome: match,
        latencyDeltaMs: match.receivedAt - dt.receivedAt // positive means Direct was faster
      });
    }
  }

  console.log(`\n2. TRADE MATCHING & LATENCY:`);
  console.log(`   - Matched Trades: ${matches.length}`);
  if (matches.length > 0) {
    const latencies = matches.map(m => m.latencyDeltaMs);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const directFasterCount = latencies.filter(l => l > 0).length;
    const chromeFasterCount = latencies.filter(l => l < 0).length;

    console.log(`   - Avg Arrival Delta (Chrome - Direct): ${avgLatency.toFixed(1)} ms`);
    console.log(`   - Direct arrived faster in: ${directFasterCount} / ${matches.length} trades`);
    console.log(`   - Chrome arrived faster in: ${chromeFasterCount} / ${matches.length} trades`);
  }

  console.log(`\n3. SAMPLE MATCHED TRADES:`);
  matches.slice(0, 5).forEach((m, idx) => {
    console.log(`   [Trade #${idx + 1}] Side: ${m.direct.side.toUpperCase()} | Price: $${m.direct.priceUsd.toFixed(8)}`);
    console.log(`     - Direct WS Time: ${new Date(m.direct.receivedAt).toISOString().slice(11, 23)}`);
    console.log(`     - Chrome WS Time: ${new Date(m.chrome.receivedAt).toISOString().slice(11, 23)}`);
    console.log(`     - Latency Delta : ${m.latencyDeltaMs > 0 ? "+" : ""}${m.latencyDeltaMs} ms (${m.latencyDeltaMs > 0 ? "Direct WS is FASTER" : "Chrome is faster"})`);
  });

  if (matches.length === 0 && (directTrades.length > 0 || chromeTrades.length > 0)) {
    console.log(`\nSample Direct Trades:`, directTrades.slice(0, 3));
    console.log(`\nSample Chrome Trades:`, chromeTrades.slice(0, 3));
  }

  process.exit(0);
}

run().catch(err => {
  console.error("Fatal error during benchmark:", err);
  process.exit(1);
});
