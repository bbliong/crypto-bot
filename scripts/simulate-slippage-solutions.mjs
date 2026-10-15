import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import readline from "readline";
import { TargetObservation } from "../src/distribution-target-lane.ts";
import { DistributionTargetLane, validateTargetRules } from "../src/distribution-target-lane.ts";

const TARGET_FILE = "data/profit4-watch/historical_target_trades.json";
const CACHE_DIR = "data/profit4-watch/cached-mints";
const targets = JSON.parse(fs.readFileSync(TARGET_FILE, "utf-8"));
const targetMints = new Set(targets.map(t => t.mint));
const targetMap = new Map(targets.map(t => [t.mint, t]));

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

async function loadOrExtractTrades() {
  const cachedFiles = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".json"));
  if (cachedFiles.length >= 80) {
    console.log(`Loading trades from ${cachedFiles.length} local mint cache files...`);
    const map = new Map();
    for (const f of cachedFiles) {
      const mint = f.replace(".json", "");
      const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8"));
      map.set(mint, data);
    }
    return map;
  }

  console.log("Streaming from S3 and caching to local mint files...");
  const archives = await new Promise((resolve, reject) => {
    const p = spawn("aws", ["--profile", "do-tor1", "s3", "ls", "s3://missi/crypto/profit4-chunks/", "--recursive"]);
    let out = "";
    p.stdout.on("data", d => out += d.toString());
    p.on("close", code => {
      if (code !== 0) return reject(new Error("AWS error"));
      const lines = out.trim().split("\n");
      const list = [];
      const relevantRuns = ["2026-10-11T00-55-41-396Z", "2026-10-12T10-21-27-312Z", "2026-10-12T17-09-10-368Z"];
      for (const l of lines) {
        const parts = l.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3].endsWith(".tar.gz")) {
          const key = parts[3];
          if (relevantRuns.some(r => key.includes(r))) list.push(key);
        }
      }
      resolve(list);
    });
  });

  const tokenTrades = new Map();
  for (const t of targets) tokenTrades.set(t.mint, []);

  const CONCURRENCY = 6;
  let cursor = 0;
  let completed = 0;

  function streamChunk(key) {
    return new Promise(res => {
      const aws = spawn("aws", ["--profile", "do-tor1", "s3", "cp", `s3://missi/${key}`, "-"]);
      const tar = spawn("tar", ["-zx", "--wildcards", "*token-trades.jsonl", "-O"]);
      aws.stdout.on("error", () => {});
      tar.stdin.on("error", () => {});
      tar.stdout.on("error", () => {});
      aws.stdout.pipe(tar.stdin);
      const rl = readline.createInterface({ input: tar.stdout });
      const collected = [];
      rl.on("line", line => {
        if (!line) return;
        try {
          const r = JSON.parse(line);
          if (r.mint && targetMints.has(r.mint)) collected.push(r);
        } catch (e) {}
      });
      let finished = false;
      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try { aws.kill(); } catch (e) {}
          try { tar.kill(); } catch (e) {}
          res(collected);
        }
      }, 20000);
      tar.on("close", () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          try { aws.kill(); } catch (e) {}
          res(collected);
        }
      });
      aws.on("error", () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          res([]);
        }
      });
      tar.on("error", () => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          res([]);
        }
      });
    });
  }

  async function worker() {
    while (cursor < archives.length) {
      const idx = cursor++;
      const arc = archives[idx];
      const rows = await streamChunk(arc);
      for (const r of rows) tokenTrades.get(r.mint).push(r);
      completed++;
      if (completed % 25 === 0 || completed === archives.length) {
        console.log(`[${completed}/${archives.length}] archives extracted...`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Save to per-mint cache files (compact and never exceeds string limit)
  for (const [mint, rows] of tokenTrades.entries()) {
    if (rows.length > 0) {
      fs.writeFileSync(path.join(CACHE_DIR, `${mint}.json`), JSON.stringify(rows));
    }
  }
  console.log(`Saved ${tokenTrades.size} mint cache files to ${CACHE_DIR}`);
  return tokenTrades;
}

// Custom Simulation Function
function runSimulationVariant(tokenTrades, variantConfig) {
  let blockedCount = 0;
  let enteredCount = 0;
  let wins = 0;
  let losses = 0;
  let totalPnl = 0;
  let winSum = 0;
  let lossSum = 0;
  const exitReasonCounts = {};

  for (const meta of targets) {
    const mint = meta.mint;
    const rows = tokenTrades.get(mint) || [];
    if (!rows.length) continue;

    rows.sort((a, b) => {
      const tA = a.at || a.observedAt || (a.timestamp ? a.timestamp * 1000 : 0);
      const tB = b.at || b.observedAt || (b.timestamp ? b.timestamp * 1000 : 0);
      return tA - tB;
    });

    const obs = new TargetObservation(meta.transferAt);
    const events = [];

    const rules = validateTargetRules({
      version: variantConfig.name,
      paperOnly: true,
      enabled: true,
      targetPercent: 22, // Sweet spot 22%
      observationSeconds: 20,
      minTransferAgeSeconds: 30,
      maxTransferLagSeconds: 60,
      maxEntryWaitSeconds: 600,
      confirmSeconds: 1,
      minBuySharePercent: 55,
      minMeaningfulBuyUsd: variantConfig.minMeaningfulBuyUsd ?? 5,
      minMeaningfulBuyers: variantConfig.minMeaningfulBuyers ?? 2,
      maxBuyerSharePercent: variantConfig.maxBuyerSharePercent ?? 80,
      minMomentumPercent: 0,
      maxMomentumPercent: 50,
      maxEntryReturnPercent: 100,
      maxDrawdownPercent: 99,
      stopLossPercent: 12,
      trailingStartPercent: 18,
      trailingDrawdownPercent: 3,
      maxHoldSeconds: 300,
      executionDelayMs: 1000,
      maxFillWaitMs: 5000,
      feePercentPerSide: 1,
      slippagePercentPerSide: 0.5,
      fixedFeeUsdPerSide: 0.005,
      stakeUsd: 5,
      blockKnownDumpSellers: false,
    });

    let initialStep = null;
    let staircaseConfirmed = false;
    let dumpObserved = false;
    let maxDrawdownSeen = 0;
    let lastWhaleSellSeenAt = null;
    let peakNetSeen = -Infinity;

    const lane = new DistributionTargetLane(mint, rules, e => events.push(e), {
      name: variantConfig.name,
      paperLane: variantConfig.name,
      prioritizeCustomExit: true,
      trailingEnabled: true,
      flowExitEnabled: false,
      overrideEntryReasons: (f, r) => {
        const reasons = [];
        if (!r.enabled) reasons.push('LANE_DISABLED');
        if (f.firstAt === null || f.now - f.firstAt < r.observationSeconds * 1000 || f.now - f.transferAt < r.minTransferAgeSeconds * 1000) reasons.push('OBSERVATION_NOT_COMPLETE');
        if (f.firstAt !== null && f.now - f.firstAt > r.maxEntryWaitSeconds * 1000) reasons.push('ENTRY_WINDOW_EXPIRED');
        if (f.price === null || f.priceAt === null || f.priceAt > f.now || f.now - f.priceAt > 2000) reasons.push('PRICE_MISSING_OR_STALE');

        // Dev Supply Check
        if (f.devHoldingSharePercent !== null && f.devHoldingSharePercent > 2.0) reasons.push('DEV_STILL_HOLDING_SUPPLY_DUMP_RISK');
        else if (f.devBalance !== null && f.devBalance > 20_000_000) reasons.push('DEV_BALANCE_TOO_LARGE');

        // Holder Flight Check
        if (f.holderDeclineEverSeen || (f.holderGrowth15s !== null && f.holderGrowth15s < -3)) reasons.push('HOLDERS_DECLINING_FLIGHT_RISK');

        // Whale Sell Cooldown (45s)
        if (f.largestSellUsd >= 150) {
          lastWhaleSellSeenAt = f.now;
          reasons.push('WHALE_SELL_ACTIVE_IN_WINDOW');
        }
        if (lastWhaleSellSeenAt !== null && (f.now - lastWhaleSellSeenAt) < 45_000) reasons.push('WHALE_SELL_COOLDOWN_ACTIVE');

        // Dump Tuntas Check
        const dd = f.drawdownPercent ?? 0;
        if (dd >= 75) dumpObserved = true;
        if (dd > maxDrawdownSeen) maxDrawdownSeen = dd;
        if (!dumpObserved && maxDrawdownSeen < 75) reasons.push('NOT_YET_DUMPED_SEVERELY');

        // Flow Check
        if ((f.buyShareUsdPercent ?? 0) < r.minBuySharePercent || f.meaningfulBuyUsd < r.minMeaningfulBuyUsd) reasons.push('BUY_FLOW_NOT_RECOVERED');
        if (f.meaningfulBuyers < r.minMeaningfulBuyers) reasons.push('INSUFFICIENT_BUYERS_NEED_MULTI_WALLET');
        if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > r.maxBuyerSharePercent) reasons.push('BUYER_CONCENTRATION_TOO_HIGH_SINGLE_WALLET');

        // SOLUSI 1: Top Holder Supply Concentration Gate
        if (variantConfig.enableSolusi1) {
          // Jika buyer teratas mengambil > 60% pemulihan ATAU ada indikasi konsentrasi tinggi
          if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 60) {
            reasons.push('TOP_BUYER_CONCENTRATION_RISK');
          }
        }

        // SOLUSI 3: Deeper Recovery Volume Gate
        if (variantConfig.enableSolusi3) {
          if (f.meaningfulBuyUsd < 20 || f.meaningfulBuyers < 3) {
            reasons.push('RECOVERY_VOLUME_TOO_THIN');
          }
        }

        // Progressive Staircase Dwell (3.0 - 7.0s)
        const bounce = f.bounceFromTroughPercent ?? 0;
        const currentPrice = f.price ?? 0;
        const currentTrough = f.troughPrice ?? currentPrice;

        if (!initialStep) {
          if (bounce < 3.5) reasons.push('BOUNCE_FROM_TROUGH_TOO_SMALL');
          else if (bounce > 15.0) reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
          else if (currentPrice > 0) {
            initialStep = { price: currentPrice, time: f.now, troughAtStep: currentTrough };
            reasons.push('STAIRCASE_WAITING_CONFIRMATION');
          }
        } else if (!staircaseConfirmed) {
          const dtSeconds = (f.now - initialStep.time) / 1000;
          if (currentPrice < initialStep.troughAtStep * 0.98) {
            initialStep = null;
            reasons.push('STAIRCASE_BREAKDOWN_BELOW_TROUGH');
          } else if (dtSeconds < 3.0) {
            reasons.push('STAIRCASE_WAITING_CONFIRMATION');
          } else if (dtSeconds >= 3.0 && dtSeconds <= 7.0) {
            if (currentPrice < initialStep.price * 0.90) {
              initialStep = null;
              reasons.push('STAIRCASE_SPIKE_COLLAPSED');
            } else if (bounce > 16.0) {
              initialStep = null;
              reasons.push('BOUNCE_OVEREXTENDED_LATE_ENTRY');
            } else if (currentPrice >= initialStep.price * 0.97) {
              staircaseConfirmed = true;
            } else {
              reasons.push('STAIRCASE_WAITING_CONFIRMATION');
            }
          } else {
            initialStep = null;
            reasons.push('STAIRCASE_CONFIRMATION_TIMEOUT');
          }
        }
        return reasons;
      },
      exitReason: (f, net) => {
        if (net > peakNetSeen) peakNetSeen = net;
        if (net <= -25) return 'HARD_CAP_RUGPULL_PROTECTION';

        // SOLUSI 2: Emergency Whale Bailout (Cut seketika jika ada order sell >= $75 tanpa tunggu -12%)
        if (variantConfig.enableSolusi2) {
          if (f.largestSellUsd >= 75) {
            return 'EMERGENCY_WHALE_SELL_BAILOUT';
          }
        }

        // Target Take Profit Penuh: 20% - 22%
        if (net >= 20) return 'TARGET_BOUNCE_20_22';

        // Profit Locks
        if (peakNetSeen >= 18) {
          if (peakNetSeen - net >= 3 || net <= 14) return 'PROFIT_LOCK_18_EXIT';
        }
        if (peakNetSeen >= 15) {
          if (peakNetSeen - net >= 3 || net <= 10) return 'PROFIT_LOCK_15_EXIT';
        }
        if (net >= 8 && f.largestSellUsd >= 80) return 'PROFIT_SECURED_ON_WHALE_SELL';

        return null;
      }
    });

    let clock = meta.transferAt;
    for (const r of rows) {
      const now = r.at || r.observedAt || (r.timestamp ? r.timestamp * 1000 : 0);
      if (now > clock) clock = now;

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

      const facts = obs.facts(clock, [], meta.from);
      lane.step(facts);
      if (lane.phase === "CLOSED") break;
    }

    const buyEvent = events.find(e => e.type === "PAPER_BUY");
    const sellEvent = events.find(e => e.type === "PAPER_SELL");

    if (!buyEvent) {
      blockedCount++;
    } else {
      enteredCount++;
      const net = sellEvent?.netReturnPercent ?? 0;
      const pnl = sellEvent?.pnlUsd ?? (net / 100 * 5);
      const reason = sellEvent?.reason || "OPEN";
      exitReasonCounts[reason] = (exitReasonCounts[reason] || 0) + 1;

      if (pnl > 0) {
        wins++;
        winSum += pnl;
      } else {
        losses++;
        lossSum += pnl;
      }
      totalPnl += pnl;
    }
  }

  return {
    name: variantConfig.title,
    blockedCount,
    enteredCount,
    wins,
    losses,
    winRate: enteredCount > 0 ? (wins / enteredCount * 100) : 0,
    totalPnl,
    winSum,
    lossSum,
    profitFactor: lossSum !== 0 ? Math.abs(winSum / lossSum) : 999,
    exitReasons: exitReasonCounts
  };
}

async function main() {
  const tokenTrades = await loadOrExtractTrades();
  console.log("\nSimulating all solutions across 116 historical tokens...\n");

  const variants = [
    {
      name: "base-v5",
      title: "Base V5 (TP 20-22%)",
      enableSolusi1: false,
      enableSolusi2: false,
      enableSolusi3: false,
    },
    {
      name: "solusi-1",
      title: "Solusi 1 (Top Holder Gate)",
      enableSolusi1: true,
      enableSolusi2: false,
      enableSolusi3: false,
      maxBuyerSharePercent: 60,
    },
    {
      name: "solusi-2",
      title: "Solusi 2 (Whale Bailout >=$75)",
      enableSolusi1: false,
      enableSolusi2: true,
      enableSolusi3: false,
    },
    {
      name: "solusi-3",
      title: "Solusi 3 (Deeper Recovery Vol)",
      enableSolusi1: false,
      enableSolusi2: false,
      enableSolusi3: true,
      minMeaningfulBuyUsd: 12,
      minMeaningfulBuyers: 3,
    },
    {
      name: "combo-1-2",
      title: "Kombinasi Solusi 1 + 2",
      enableSolusi1: true,
      enableSolusi2: true,
      enableSolusi3: false,
      maxBuyerSharePercent: 60,
    }
  ];

  const results = [];
  for (const v of variants) {
    console.log(`Running simulation for: ${v.title}...`);
    const res = runSimulationVariant(tokenTrades, v);
    results.push(res);
  }

  console.log("\n" + "=".repeat(100));
  console.log("KOMPARASI EVALUASI SOLUSI ANTI-SLIPPAGE PADA DATA LENGKAP S3 (10 - 13 OKTOBER 2026)");
  console.log("=".repeat(100));
  console.log(String("Model Strategi").padEnd(30) +
              String("Trade").padEnd(8) +
              String("Win").padEnd(6) +
              String("Loss").padEnd(7) +
              String("Win Rate").padEnd(12) +
              String("Total Win $").padEnd(14) +
              String("Total Loss $").padEnd(14) +
              String("NET PnL ($)").padEnd(14) +
              String("Profit Factor"));
  console.log("-".repeat(100));

  for (const r of results) {
    console.log(
      String(r.name).padEnd(30) +
      String(r.enteredCount).padEnd(8) +
      String(r.wins).padEnd(6) +
      String(r.losses).padEnd(7) +
      String(`${r.winRate.toFixed(1)}%`).padEnd(12) +
      String(`+$${r.winSum.toFixed(2)}`).padEnd(14) +
      String(`-$${Math.abs(r.lossSum).toFixed(2)}`).padEnd(14) +
      String(`+$${r.totalPnl.toFixed(2)}`).padEnd(14) +
      String(`${r.profitFactor.toFixed(2)}x`)
    );
  }
  console.log("=".repeat(100));

  console.log("\nRincian Exit Reasons per Strategi:");
  for (const r of results) {
    console.log(`\n* ${r.name}:`);
    for (const [reason, count] of Object.entries(r.exitReasons)) {
      console.log(`    - ${reason}: ${count}`);
    }
  }
}

main().catch(console.error);
