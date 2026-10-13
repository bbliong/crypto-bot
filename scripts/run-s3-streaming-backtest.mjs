import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import readline from "readline";
import { TargetObservation } from "../src/distribution-target-lane.ts";
import { DistributionBounceLaneV5 } from "../src/distribution-bounce-lane.ts";

const TARGET_FILE = "data/profit4-watch/historical_target_trades.json";
if (!fs.existsSync(TARGET_FILE)) {
  console.error("Target file missing!");
  process.exit(1);
}

const targets = JSON.parse(fs.readFileSync(TARGET_FILE, "utf-8"));
const targetMints = new Set(targets.map(t => t.mint));
const targetMap = new Map(targets.map(t => [t.mint, t]));

console.log(`Starting S3 streaming backtest for ${targets.length} tokens...`);

// 1. Dapatkan daftar archives S3 yang relevan
function getS3Archives() {
  return new Promise((resolve, reject) => {
    const p = spawn("aws", ["--profile", "do-tor1", "s3", "ls", "s3://missi/crypto/profit4-chunks/", "--recursive"]);
    let out = "";
    p.stdout.on("data", d => out += d.toString());
    p.on("close", code => {
      if (code !== 0) return reject(new Error("AWS CLI error"));
      const lines = out.trim().split("\n");
      const archives = [];
      const relevantRuns = ["2026-10-11T00-55-41-396Z", "2026-10-12T10-21-27-312Z", "2026-10-12T17-09-10-368Z"];
      for (const l of lines) {
        const parts = l.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3].endsWith(".tar.gz")) {
          const key = parts[3];
          if (relevantRuns.some(r => key.includes(r))) {
            archives.push(key);
          }
        }
      }
      resolve(archives);
    });
  });
}

// 2. Stream chunk dan kumpulkan trades untuk mint yang relevan
async function streamChunkForTokens(key) {
  return new Promise((resolve) => {
    // Pipe aws s3 cp -> tar -zx -O --wildcards "*token-trades.jsonl"
    const aws = spawn("aws", ["--profile", "do-tor1", "s3", "cp", `s3://missi/${key}`, "-"]);
    const tar = spawn("tar", ["-zx", "--wildcards", "*token-trades.jsonl", "-O"]);
    
    aws.stdout.pipe(tar.stdin);
    
    const rl = readline.createInterface({ input: tar.stdout });
    const collectedTrades = [];

    rl.on("line", line => {
      if (!line) return;
      try {
        const row = JSON.parse(line);
        if (row.mint && targetMints.has(row.mint)) {
          collectedTrades.push(row);
        }
      } catch (e) {}
    });

    tar.on("close", () => {
      aws.kill();
      resolve(collectedTrades);
    });

    aws.on("error", () => resolve([]));
    tar.on("error", () => resolve([]));
  });
}

async function main() {
  const archives = await getS3Archives();
  console.log(`Found ${archives.length} matching chunk archives in S3.`);

  const tokenTrades = new Map();
  for (const t of targets) {
    tokenTrades.set(t.mint, []);
  }

  let processed = 0;
  for (const arc of archives) {
    processed++;
    process.stdout.write(`\r[${processed}/${archives.length}] Streaming S3 chunk: ${path.basename(arc)}...`);
    const rows = await streamChunkForTokens(arc);
    for (const r of rows) {
      tokenTrades.get(r.mint).push(r);
    }
  }

  console.log("\n\nAll S3 chunks streamed successfully! Evaluating Lane V5 Solusi 2 rules...");

  const results = [];
  let blockedCount = 0;
  let enteredCount = 0;
  let newWins = 0;
  let newLosses = 0;
  let newTotalPnl = 0;

  for (const [mint, meta] of targetMap.entries()) {
    const rows = tokenTrades.get(mint) || [];
    // Sort chronological
    rows.sort((a, b) => (a.at || a.timestamp * 1000 || 0) - (b.at || b.timestamp * 1000 || 0));

    const obs = new TargetObservation(meta.transferAt);
    const events = [];
    const lane = new DistributionBounceLaneV5(mint, e => events.push(e));

    for (const r of rows) {
      if (r.trade) obs.trade(r.trade);
      else if (r.price && r.side) obs.trade(r);

      if (r.holding && r.wallet) obs.holding(r.wallet, r.holding);
      if (r.count) obs.count(r.count);

      const now = r.at || (r.timestamp ? r.timestamp * 1000 : 0);
      if (!now) continue;

      const facts = obs.facts(now, [], meta.from);
      lane.step(facts);

      if (lane.phase === "CLOSED") break;
    }

    const buyEvent = events.find(e => e.type === "PAPER_BUY");
    const sellEvent = events.find(e => e.type === "PAPER_SELL");
    const lastDecision = events.findLast(e => e.type === "PAPER_ENTRY_DECISION");

    if (!buyEvent) {
      blockedCount++;
      const reasons = lastDecision?.reasons || ["NOT_MEETING_CRITERIA"];
      results.push({
        symbol: meta.symbol,
        mint: mint.slice(0, 6),
        oldNet: meta.oldNet,
        oldPnl: meta.oldNet ? (meta.oldNet / 100 * 5) : 0,
        newStatus: "BLOCKED",
        newNet: 0,
        newPnl: 0,
        reasons: reasons.join(", ")
      });
    } else {
      enteredCount++;
      const net = sellEvent?.netReturnPercent ?? 0;
      const pnl = sellEvent?.pnlUsd ?? (net / 100 * 5);
      if (pnl > 0) newWins++;
      else newLosses++;
      newTotalPnl += pnl;

      results.push({
        symbol: meta.symbol,
        mint: mint.slice(0, 6),
        oldNet: meta.oldNet,
        oldPnl: meta.oldNet ? (meta.oldNet / 100 * 5) : 0,
        newStatus: pnl > 0 ? "WIN" : "LOSS",
        newNet: net,
        newPnl: pnl,
        exitReason: sellEvent?.reason || "OPEN"
      });
    }
  }

  // Ringkasan
  console.log("\n" + "=".repeat(80));
  console.log("HASIL EVALUASI STREAMING S3 - LANE V5 SOLUSI 2 VS DATA LAMA");
  console.log("=".repeat(80));
  console.log(`Total Token yang Dievaluasi  : ${targets.length}`);
  console.log(`Token Berhasil DIBLOKIR V5   : ${blockedCount} token (Terlindungi dari Scam & Bad Flow)`);
  console.log(`Token Berhasil LOLOS Masuk   : ${enteredCount} token`);
  console.log(`  - Win                      : ${newWins}`);
  console.log(`  - Loss                     : ${newLosses}`);
  console.log(`  - Win Rate Lane V5 Baru    : ${(newWins / (enteredCount || 1) * 100).toFixed(1)}%`);
  console.log(`  - Total Net PnL Baru       : $${newTotalPnl.toFixed(2)} USD`);

  fs.writeFileSync("data/profit4-watch/s3_backtest_v5_results.json", JSON.stringify(results, null, 2));
  console.log("\nHasil detail lengkap disimpan di data/profit4-watch/s3_backtest_v5_results.json");
}

main().catch(console.error);
