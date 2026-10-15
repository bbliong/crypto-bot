import fs from "fs";
import path from "path";
import readline from "readline";
import { TargetObservation } from "../src/distribution-target-lane.ts";
import { DistributionBounceLaneV6, DistributionBounceLaneV7 } from "../src/distribution-bounce-lane.ts";

const TARGET_FILE = "data/profit4-watch/historical_target_trades.json";
const CACHE_DIR = "data/profit4-watch/cached-mints";
const OUTPUT_FILE = "data/profit4-watch/all_historical_v6_v7_results.json";

const targets = JSON.parse(fs.readFileSync(TARGET_FILE, "utf-8"));
console.log(`Starting backtest of Lane V6 vs Lane V7 on ALL ${targets.length} historical tokens...`);

async function testToken(meta) {
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
        buyPrice: 0,
        sellPrice: 0,
        holdSeconds: 0,
        exitReason: null
      };
    }

    const net = sell?.netReturnPercent ?? 0;
    const pnl = sell?.pnlUsd ?? (net / 100 * 5);
    const holdSeconds = (sell && buy) ? ((sell.at - buy.at) / 1000) : 0;

    return {
      entered: true,
      reasons: [],
      net,
      pnl,
      buyPrice: buy.price ?? 0,
      sellPrice: sell?.price ?? 0,
      holdSeconds,
      exitReason: sell?.reason || "OPEN"
    };
  }

  const resV6 = runLane(DistributionBounceLaneV6);
  const resV7 = runLane(DistributionBounceLaneV7);

  return {
    symbol: meta.symbol,
    mint: meta.mint,
    shortMint: meta.mint.slice(0, 8),
    run: meta.run,
    transferAt: meta.transferAt,
    oldNet: meta.oldNet,
    v6: resV6,
    v7: resV7
  };
}

const allResults = [];
const t0 = Date.now();

for (let i = 0; i < targets.length; i++) {
  const meta = targets[i];
  const r = await testToken(meta);
  if (r) allResults.push(r);
  if ((i + 1) % 15 === 0 || i === targets.length - 1) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${i + 1}/${targets.length}] tokens processed (${elapsed}s elapsed)...`);
  }
}

fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allResults, null, 2));
console.log(`Saved detailed results to ${OUTPUT_FILE}`);

// Calculate metrics
let v6Entered = 0, v6Wins = 0, v6Losses = 0, v6Pnl = 0, v6TotalReturn = 0;
let v7Entered = 0, v7Wins = 0, v7Losses = 0, v7Pnl = 0, v7TotalReturn = 0;

let savedLossCount = 0;
let savedLossUsd = 0;
let filteredWinCount = 0;
let filteredWinUsd = 0;

const savedLossList = [];
const filteredWinList = [];

for (const item of allResults) {
  const s6 = item.v6;
  const s7 = item.v7;

  if (s6.entered) {
    v6Entered++;
    v6Pnl += s6.pnl;
    v6TotalReturn += s6.net;
    if (s6.pnl > 0) v6Wins++;
    else v6Losses++;
  }

  if (s7.entered) {
    v7Entered++;
    v7Pnl += s7.pnl;
    v7TotalReturn += s7.net;
    if (s7.pnl > 0) v7Wins++;
    else v7Losses++;
  }

  // Saved loss: V6 lost money, but V7 blocked the entry!
  if (s6.entered && s6.pnl <= 0 && !s7.entered) {
    savedLossCount++;
    savedLossUsd += Math.abs(s6.pnl);
    savedLossList.push({
      symbol: item.symbol,
      mint: item.shortMint,
      v6Net: s6.net.toFixed(1) + "%",
      v6Pnl: "$" + s6.pnl.toFixed(2),
      v6Reason: s6.exitReason,
      v7BlockedReason: s7.reasons.join(", ")
    });
  }

  // Filtered win: V6 made money, but V7 blocked the entry
  if (s6.entered && s6.pnl > 0 && !s7.entered) {
    filteredWinCount++;
    filteredWinUsd += s6.pnl;
    filteredWinList.push({
      symbol: item.symbol,
      mint: item.shortMint,
      v6Net: s6.net.toFixed(1) + "%",
      v6Pnl: "$" + s6.pnl.toFixed(2),
      v7BlockedReason: s7.reasons.join(", ")
    });
  }
}

console.log("\n" + "=".repeat(85));
console.log(`HASIL EVALUASI KOMPARASI MENYELURUH: LANE V6 VS LANE V7 (116 TOKENS)`);
console.log("=".repeat(85));
console.log(`\nLANE V6 (Benchmark Live):`);
console.log(`  - Total Trade Masuk : ${v6Entered} dari ${targets.length} token (${(v6Entered/targets.length*100).toFixed(1)}%)`);
console.log(`  - Win / Loss        : ${v6Wins} Win / ${v6Losses} Loss`);
console.log(`  - Win Rate          : ${(v6Wins / (v6Entered || 1) * 100).toFixed(1)}%`);
console.log(`  - Total Return      : ${v6TotalReturn.toFixed(1)}%`);
console.log(`  - Net PnL ($5 stake): $${v6Pnl.toFixed(2)} USD`);

console.log(`\nLANE V7 (Solusi Baru):`);
console.log(`  - Total Trade Masuk : ${v7Entered} dari ${targets.length} token (${(v7Entered/targets.length*100).toFixed(1)}%)`);
console.log(`  - Win / Loss        : ${v7Wins} Win / ${v7Losses} Loss`);
console.log(`  - Win Rate          : ${(v7Wins / (v7Entered || 1) * 100).toFixed(1)}%`);
console.log(`  - Total Return      : ${v7TotalReturn.toFixed(1)}%`);
console.log(`  - Net PnL ($5 stake): $${v7Pnl.toFixed(2)} USD`);

console.log(`\nANALISIS PERLINDUNGAN & EFISIENSI:`);
console.log(`  - Loss Berhasil Dicegah (Saved Loss)   : ${savedLossCount} token (Selamatkan uang: +$${savedLossUsd.toFixed(2)})`);
console.log(`  - Win Terlewat Akibat Filter Ketat     : ${filteredWinCount} token (Nilai profit: $${filteredWinUsd.toFixed(2)})`);
console.log(`  - Net Tradeoff PnL (Saved - Missed)    : $${(savedLossUsd - filteredWinUsd).toFixed(2)}`);

if (savedLossList.length > 0) {
  console.log(`\nSample Loss yang Berhasil Dieliminasi oleh V7:`);
  console.table(savedLossList.slice(0, 10));
}
