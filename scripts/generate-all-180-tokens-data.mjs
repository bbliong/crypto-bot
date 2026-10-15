import fs from "fs";
import path from "path";
import readline from "readline";
import { TargetObservation } from "../src/distribution-target-lane.ts";
import { DistributionBounceLaneV6, DistributionBounceLaneV7 } from "../src/distribution-bounce-lane.ts";

const HISTORICAL_TARGET_FILE = "data/profit4-watch/historical_target_trades.json";
const CACHE_DIR = "data/profit4-watch/cached-mints";
const SEMALAM_FILE = "data/profit4-watch/comparison-v6-v7.json";
const OUTPUT_FILE = "data/profit4-watch/comparison-v6-v7-all.json";

// 1. Load historical targets
const historicalTargets = JSON.parse(fs.readFileSync(HISTORICAL_TARGET_FILE, "utf-8"));
console.log(`Loaded ${historicalTargets.length} historical tokens.`);

// 2. Load semalam 64 tokens (if file exists and contains semalam tokens)
let semalamTokens = [];
if (fs.existsSync(SEMALAM_FILE)) {
  const raw = JSON.parse(fs.readFileSync(SEMALAM_FILE, "utf-8"));
  // Filter only semalam tokens (or take all if it has 64 items)
  semalamTokens = raw.filter(item => !item.dataset || item.dataset === "semalam");
  console.log(`Loaded ${semalamTokens.length} semalam tokens.`);
}

async function testHistoricalToken(meta) {
  const filePath = path.join(CACHE_DIR, `${meta.mint}.jsonl`);
  if (!fs.existsSync(filePath)) return null;

  const rows = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch(e) {}
  }
  rows.sort((a, b) => {
    const tA = a.at || a.observedAt || (a.timestamp ? a.timestamp * 1000 : 0);
    const tB = b.at || b.observedAt || (b.timestamp ? b.timestamp * 1000 : 0);
    return tA - tB;
  });

  function runLane(LaneClass) {
    const obs = new TargetObservation(meta.transferAt);
    const events = [];
    const lane = new LaneClass(meta.mint, e => events.push(e));
    let lastStepAt = 0;
    let entryFacts = null;

    for (const r of rows) {
      const now = r.at || r.observedAt || (r.timestamp ? r.timestamp * 1000 : 0);

      const tradeObj = r.trade || (r.price && r.side ? {
        at: now,
        timestamp: r.timestamp || Math.floor(now / 1000),
        wallet: r.wallet,
        price: r.price,
        usd: r.usd || 0,
        side: r.side
      } : null);

      if (tradeObj) obs.trade(tradeObj);
      if (r.holding && r.wallet) obs.holding(r.wallet, r.holding);
      if (r.count) obs.count(r.count);

      if (now - lastStepAt >= 1000) {
        lastStepAt = now;
        const facts = obs.facts(now, [], meta.from);
        lane.step(facts);
        if (lane.phase === "ENTRY_PENDING" || lane.phase === "HOLDING") {
          if (!entryFacts) entryFacts = facts;
        }
        if (lane.phase === "CLOSED") break;
      }
    }

    const buy = events.find(e => e.type === "PAPER_BUY");
    const sell = events.find(e => e.type === "PAPER_SELL");
    const lastDec = events.findLast(e => e.type === "PAPER_ENTRY_DECISION");

    if (!buy) {
      return {
        entered: false,
        reasons: lastDec?.reasons || ["NOT_QUALIFIED"],
        net: 0,
        pnl: 0,
        entryPrice: null,
        exitPrice: null,
        holdSeconds: 0,
        exitReason: null,
        facts: lastDec?.facts || entryFacts
      };
    }

    const net = sell?.netReturnPercent ?? 0;
    const pnl = sell?.pnlUsd ?? (net / 100 * 5);
    const holdSeconds = (sell && buy && sell.observedAt && buy.observedAt)
      ? Math.round((sell.observedAt - buy.observedAt) / 1000)
      : (sell?.holdSeconds ?? 0);

    return {
      entered: true,
      reasons: [],
      net: Number(net.toFixed(2)),
      pnl: Number(pnl.toFixed(2)),
      entryPrice: buy.priceUsd ?? buy.price ?? 0,
      exitPrice: sell?.priceUsd ?? sell?.price ?? 0,
      holdSeconds,
      exitReason: sell?.reason || "OPEN",
      facts: buy.facts || entryFacts
    };
  }

  const resV6 = runLane(DistributionBounceLaneV6);
  const resV7 = runLane(DistributionBounceLaneV7);

  // Determine category & narrative
  let category = "FILTERED_BOTH";
  let narrative = "";
  let filterReason = "";

  const f = resV7.facts || resV6.facts || {};
  const meaningfulBuyUsd = Number((f.meaningfulBuyUsd ?? 0).toFixed(2));
  const meaningfulBuyers = f.meaningfulBuyers ?? 0;
  const largestSellUsd = Number((f.largestSellUsd ?? 0).toFixed(2));
  const drawdown = Number((f.drawdownPercent ?? 0).toFixed(2));
  const bounce = Number((f.bounceFromTroughPercent ?? 0).toFixed(2));

  if (resV6.entered && resV6.pnl <= 0 && !resV7.entered) {
    category = "LOSS_V6_SAVED_V7";
    filterReason = resV7.reasons.slice(0, 2).join(" & ");
    narrative = `V6 rug/loss ${resV6.net}% (${resV6.exitReason}). V7 berhasil mendeteksi risiko dan memblokir entry lewat filter: ${resV7.reasons.join(", ")}. Modal terselamatkan!`;
  } else if (resV6.entered && resV6.pnl > 0 && resV7.entered && resV7.pnl > 0) {
    category = "PRESERVED_WIN";
    narrative = `Trade solid terkonfirmasi di kedua lane. V6 net +${resV6.net}%, V7 net +${resV7.net}% (${resV7.exitReason}). Akumulasi organik $${meaningfulBuyUsd} lolos filter V7.`;
  } else if (resV6.entered && resV6.pnl > 0 && !resV7.entered) {
    category = "FILTERED_WIN";
    filterReason = resV7.reasons.slice(0, 2).join(" & ");
    narrative = `V6 berhasil take profit +${resV6.net}%, namun V7 memilih konservatif memblokir entry (${resV7.reasons.slice(0, 2).join(", ")}) untuk menghindari noise micro-volume.`;
  } else if (resV6.entered && resV7.entered && resV7.pnl <= 0) {
    category = "LOSS_V7";
    narrative = `V7 mengalami stop loss / exit ${resV7.net}% (${resV7.exitReason}).`;
  } else {
    category = "FILTERED_BOTH";
    filterReason = resV7.reasons.slice(0, 2).join(" & ") || "CRITERIA_NOT_MET";
    narrative = `Kedua lane secara disiplin memblokir entry: ${resV7.reasons.slice(0, 2).join(", ")}.`;
  }

  // Format date/time from meta.transferAt
  const d = new Date(meta.transferAt);
  const wibTime = new Date(meta.transferAt + 7 * 3600 * 1000);
  const dateStr = wibTime.toISOString().slice(0, 10);
  const timeStr = wibTime.toISOString().slice(11, 19) + " WIB";

  return {
    dataset: "historical",
    mint: meta.mint,
    shortMint: meta.mint.slice(0, 8),
    symbol: meta.symbol,
    date: dateStr,
    time: timeStr,
    timestamp: meta.transferAt,
    from: meta.from,
    wallet: meta.run,
    v6Entered: resV6.entered,
    v6Status: resV6.entered ? (resV6.pnl > 0 ? "WIN" : "LOSS") : "NO_ENTRY",
    v6Net: resV6.entered ? resV6.net : null,
    v6Pnl: resV6.entered ? resV6.pnl : 0,
    v6EntryPrice: resV6.entryPrice,
    v6ExitPrice: resV6.exitPrice,
    v6Reason: resV6.exitReason,
    v6HoldSeconds: resV6.holdSeconds,
    v7Entered: resV7.entered,
    v7Status: resV7.entered ? (resV7.pnl > 0 ? "WIN" : "LOSS") : "NO_ENTRY",
    v7Net: resV7.entered ? resV7.net : null,
    v7Pnl: resV7.entered ? resV7.pnl : 0,
    v7EntryPrice: resV7.entryPrice,
    v7ExitPrice: resV7.exitPrice,
    v7Reason: resV7.entered ? resV7.exitReason : "BLOCKED_BY_V7_GATES",
    v7HoldSeconds: resV7.holdSeconds,
    filterReason,
    category,
    narrative,
    meaningfulBuyUsd,
    meaningfulBuyers,
    largestSellUsd,
    whaleWaves: largestSellUsd >= 150 ? 1 : 0,
    drawdown,
    bounce
  };
}

const t0 = Date.now();
const historicalResults = [];

for (let i = 0; i < historicalTargets.length; i++) {
  const meta = historicalTargets[i];
  const r = await testHistoricalToken(meta);
  if (r) historicalResults.push(r);
  if ((i + 1) % 25 === 0 || i === historicalTargets.length - 1) {
    console.log(`[${i + 1}/${historicalTargets.length}] historical tokens processed...`);
  }
}

// Ensure semalam tokens have dataset: "semalam"
const formattedSemalam = semalamTokens.map(item => ({
  ...item,
  dataset: "semalam"
}));

// Combine all tokens
const allTokensCombined = [...formattedSemalam, ...historicalResults];
console.log(`\nTotal Tokens Combined: ${allTokensCombined.length} (${formattedSemalam.length} semalam + ${historicalResults.length} historis)`);

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allTokensCombined, null, 2));
// Also update the active comparison-v6-v7.json so the API automatically serves all 180 tokens!
fs.writeFileSync(SEMALAM_FILE, JSON.stringify(allTokensCombined, null, 2));

console.log(`Saved combined dataset to ${SEMALAM_FILE} and ${OUTPUT_FILE}`);
console.log(`Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
