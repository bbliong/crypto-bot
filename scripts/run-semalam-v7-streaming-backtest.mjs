import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import readline from "readline";
import { TargetObservation } from "../src/distribution-target-lane.ts";
import { DistributionBounceLaneV6, DistributionBounceLaneV7 } from "../src/distribution-bounce-lane.ts";

const TOKENS_FILE = "data/profit4-watch/semalam-28-tokens.json";
const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf-8"));
const tokenMints = new Set(tokens.map(t => t.mint));
const tokenMap = new Map(tokens.map(t => [t.mint, t]));

console.log(`Starting Streaming Backtest: Lane V6 vs Lane V7 on ${tokens.length} tokens from semalam...`);

// Mapping chunk archive for each token based on first_seen timestamp
function getChunkNameForTimestamp(ts) {
  // Convert timestamp to WIB (+7)
  const d = new Date(ts + (7 * 3600 * 1000));
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hour = String(d.getUTCHours()).padStart(2, "0");
  const minute = d.getUTCMinutes() < 30 ? "00" : "30";
  return `${year}-${month}-${day}T${hour}-${minute}-00-000-WIB`;
}

// Find all needed chunks
const neededChunks = new Set();
for (const t of tokens) {
  const c1 = getChunkNameForTimestamp(t.first_seen);
  neededChunks.add(c1);
  // Also add next chunk (30m later) in case trades span across boundary
  const c2 = getChunkNameForTimestamp(t.first_seen + 30 * 60 * 1000);
  neededChunks.add(c2);
}

const chunkList = Array.from(neededChunks).sort();
console.log(`Needed chunks: ${chunkList.length} chunks (${chunkList[0]} to ${chunkList[chunkList.length - 1]})`);

const tokenTrades = new Map();
for (const t of tokens) tokenTrades.set(t.mint, []);

function streamFromS3(chunkName) {
  return new Promise((resolve) => {
    const s3Key = `crypto/profit4-chunks/2026-10-13T16-35-27-642Z/${chunkName}.tar.gz`;
    const aws = spawn("aws", ["--profile", "do-tor1", "s3", "cp", `s3://missi/${s3Key}`, "-"]);
    const tar = spawn("tar", ["-zx", "--wildcards", "*token-trades.jsonl", "-O"]);
    aws.stdout.pipe(tar.stdin);

    const rl = readline.createInterface({ input: tar.stdout });
    let count = 0;

    rl.on("line", line => {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        if (row.mint && tokenMints.has(row.mint)) {
          tokenTrades.get(row.mint).push(row);
          count++;
        }
      } catch (e) {}
    });

    tar.on("close", () => {
      aws.kill();
      resolve(count);
    });
    aws.on("error", () => resolve(0));
    tar.on("error", () => resolve(0));
  });
}

function readFromLocal(chunkName) {
  return new Promise((resolve) => {
    const localPath = `data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/${chunkName}/token-trades.jsonl`;
    if (!fs.existsSync(localPath)) return resolve(0);

    const stream = fs.createReadStream(localPath);
    const rl = readline.createInterface({ input: stream });
    let count = 0;

    rl.on("line", line => {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        if (row.mint && tokenMints.has(row.mint)) {
          tokenTrades.get(row.mint).push(row);
          count++;
        }
      } catch (e) {}
    });

    rl.on("close", () => resolve(count));
  });
}

async function collectTrades() {
  for (let i = 0; i < chunkList.length; i++) {
    const chunk = chunkList[i];
    const localDir = `data/profit4-watch/2026-10-13T16-35-27-642Z/chunks/${chunk}`;
    if (fs.existsSync(localDir)) {
      const c = await readFromLocal(chunk);
      console.log(`[${i+1}/${chunkList.length}] Read local chunk ${chunk}: ${c} trades matched`);
    } else {
      const c = await streamFromS3(chunk);
      console.log(`[${i+1}/${chunkList.length}] Streamed S3 chunk ${chunk}: ${c} trades matched`);
    }
  }
}

function runLane(LaneClass, mint, meta, trades) {
  const obs = new TargetObservation(meta.transferAt || meta.first_seen);
  const events = [];
  const lane = new LaneClass(mint, e => events.push(e));

  for (const r of trades) {
    if (r.trade) obs.trade(r.trade);
    else if (r.price && r.side) obs.trade(r);

    if (r.holding && r.wallet) obs.holding(r.wallet, r.holding);
    if (r.count) obs.count(r.count);

    const now = r.at || (r.timestamp ? r.timestamp * 1000 : (r.observedAt || 0));
    if (!now) continue;

    const facts = obs.facts(now, [], meta.from);
    lane.step(facts);

    if (lane.phase === "CLOSED") break;
  }

  const buy = events.find(e => e.type === "PAPER_BUY");
  const sell = events.find(e => e.type === "PAPER_SELL");
  const lastDec = events.findLast(e => e.type === "PAPER_ENTRY_DECISION");

  if (!buy) {
    return {
      entered: false,
      reasons: lastDec?.reasons || ["NOT_QUALIFIED"],
      netReturn: 0,
      pnlUsd: 0,
      entryPrice: 0,
      exitPrice: 0,
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
    netReturn: net,
    pnlUsd: pnl,
    entryPrice: buy.price ?? 0,
    exitPrice: sell?.price ?? 0,
    holdSeconds,
    exitReason: sell?.reason || "OPEN"
  };
}

async function main() {
  await collectTrades();

  console.log("\nProcessing simulation for all 28 tokens...\n");

  const comparison = [];

  for (const t of tokens) {
    const rows = tokenTrades.get(t.mint) || [];
    rows.sort((a, b) => (a.at || a.observedAt || a.timestamp * 1000 || 0) - (b.at || b.observedAt || b.timestamp * 1000 || 0));

    const resV6 = runLane(DistributionBounceLaneV6, t.mint, t, rows);
    const resV7 = runLane(DistributionBounceLaneV7, t.mint, t, rows);

    comparison.push({
      symbol: t.symbol,
      mint: t.mint,
      shortMint: t.mint.slice(0, 8),
      firstSeen: t.first_seen,
      liveV6Return: t.v6_return,
      liveV6Entered: t.v6_entered,
      liveV6Reason: t.v6_reason,
      simV6: resV6,
      simV7: resV7,
    });
  }

  // Print results
  console.log("=" .repeat(120));
  console.log("SIMULASI HASIL SEMALAM (13-14 OKTOBER 2026): LANE V6 VS LANE V7");
  console.log("=" .repeat(120));

  let v6Wins = 0, v6Losses = 0, v6Pnl = 0, v6TotalReturn = 0, v6Trades = 0;
  let v7Wins = 0, v7Losses = 0, v7Pnl = 0, v7TotalReturn = 0, v7Trades = 0;

  for (const c of comparison) {
    const s6 = c.simV6;
    const s7 = c.simV7;

    if (s6.entered) {
      v6Trades++;
      if (s6.netReturn > 0) v6Wins++; else v6Losses++;
      v6Pnl += s6.pnlUsd;
      v6TotalReturn += s6.netReturn;
    }

    if (s7.entered) {
      v7Trades++;
      if (s7.netReturn > 0) v7Wins++; else v7Losses++;
      v7Pnl += s7.pnlUsd;
      v7TotalReturn += s7.netReturn;
    }

    const v6Status = s6.entered ? `${s6.netReturn >= 0 ? '+' : ''}${s6.netReturn.toFixed(1)}% (${s6.exitReason})` : `BLOCKED (${s6.reasons[0] || 'REJECTED'})`;
    const v7Status = s7.entered ? `${s7.netReturn >= 0 ? '+' : ''}${s7.netReturn.toFixed(1)}% (${s7.exitReason})` : `BLOCKED (${s7.reasons[0] || 'REJECTED'})`;

    console.log(`${c.symbol.padEnd(10)} | ${c.shortMint} | V6: ${v6Status.padEnd(35)} | V7: ${v7Status}`);
  }

  console.log("=" .repeat(120));
  console.log(`RINGKASAN PERBANDINGAN:`);
  console.log(`LANE V6:`);
  console.log(`  - Total Trades   : ${v6Trades}`);
  console.log(`  - Win / Loss     : ${v6Wins} Win / ${v6Losses} Loss`);
  console.log(`  - Win Rate       : ${v6Trades > 0 ? (v6Wins / v6Trades * 100).toFixed(1) : 0}%`);
  console.log(`  - Total Net Return: ${v6TotalReturn.toFixed(2)}%`);
  console.log(`  - Total Net PnL  : $${v6Pnl.toFixed(2)} USD (pada stake $5)`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`LANE V7:`);
  console.log(`  - Total Trades   : ${v7Trades}`);
  console.log(`  - Win / Loss     : ${v7Wins} Win / ${v7Losses} Loss`);
  console.log(`  - Win Rate       : ${v7Trades > 0 ? (v7Wins / v7Trades * 100).toFixed(1) : 0}%`);
  console.log(`  - Total Net Return: ${v7TotalReturn.toFixed(2)}%`);
  console.log(`  - Total Net PnL  : $${v7Pnl.toFixed(2)} USD (pada stake $5)`);
  console.log("=" .repeat(120));

  fs.writeFileSync("data/profit4-watch/semalam-v6-vs-v7-comparison.json", JSON.stringify(comparison, null, 2));
  console.log("\nHasil lengkap disimpan di data/profit4-watch/semalam-v6-vs-v7-comparison.json");
}

main().catch(console.error);
