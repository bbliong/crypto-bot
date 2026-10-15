import fs from "fs";
import path from "path";
import readline from "readline";
import { TargetObservation } from "../src/distribution-target-lane.ts";
import { DistributionTargetLane, validateTargetRules } from "../src/distribution-target-lane.ts";

const TARGET_FILE = "data/profit4-watch/historical_target_trades.json";
const CACHE_DIR = "data/profit4-watch/cached-mints";

const targets = JSON.parse(fs.readFileSync(TARGET_FILE, "utf-8"));

async function readMintTrades(mint) {
  const filePath = path.join(CACHE_DIR, `${mint}.jsonl`);
  if (!fs.existsSync(filePath)) return [];

  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (e) {}
  }
  return rows;
}

function runSimulationForToken(meta, rows, variantConfig) {
  if (!rows || rows.length === 0) return null;

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

  const lane = new DistributionTargetLane(meta.mint, rules, e => events.push(e), {
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
        if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > 60) {
          reasons.push('TOP_BUYER_CONCENTRATION_RISK');
        }
      }

      // SOLUSI 3: Deeper Recovery Volume Gate
      if (variantConfig.enableSolusi3) {
        if (f.meaningfulBuyUsd < 18 || f.meaningfulBuyers < 3) {
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
    return { entered: false };
  } else {
    const net = sellEvent?.netReturnPercent ?? 0;
    const pnl = sellEvent?.pnlUsd ?? (net / 100 * 5);
    const reason = sellEvent?.reason || "OPEN";
    return { entered: true, net, pnl, reason };
  }
}

async function main() {
  console.log("Loading all mint trades from local cache...");
  const tokenTradesMap = new Map();
  for (const t of targets) {
    const rows = await readMintTrades(t.mint);
    tokenTradesMap.set(t.mint, rows);
  }
  console.log(`Loaded trades for ${tokenTradesMap.size} tokens! Running evaluation...\n`);

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
    let enteredCount = 0;
    let wins = 0;
    let losses = 0;
    let winSum = 0;
    let lossSum = 0;
    let totalPnl = 0;
    const exitReasonCounts = {};

    for (const meta of targets) {
      const rows = tokenTradesMap.get(meta.mint) || [];
      const res = runSimulationForToken(meta, rows, v);
      if (!res || !res.entered) continue;

      enteredCount++;
      exitReasonCounts[res.reason] = (exitReasonCounts[res.reason] || 0) + 1;
      if (res.pnl > 0) {
        wins++;
        winSum += res.pnl;
      } else {
        losses++;
        lossSum += res.pnl;
      }
      totalPnl += res.pnl;
    }

    results.push({
      name: v.title,
      enteredCount,
      wins,
      losses,
      winRate: enteredCount > 0 ? (wins / enteredCount * 100) : 0,
      totalPnl,
      winSum,
      lossSum,
      profitFactor: lossSum !== 0 ? Math.abs(winSum / lossSum) : 999,
      exitReasons: exitReasonCounts
    });
  }

  console.log("=".repeat(105));
  console.log("KOMPARASI EVALUASI SOLUSI ANTI-SLIPPAGE PADA DATA LENGKAP S3 (10 - 13 OKTOBER 2026)");
  console.log("=".repeat(105));
  console.log(String("Model Strategi").padEnd(32) +
              String("Trade").padEnd(8) +
              String("Win").padEnd(6) +
              String("Loss").padEnd(7) +
              String("Win Rate").padEnd(12) +
              String("Total Win $").padEnd(14) +
              String("Total Loss $").padEnd(14) +
              String("NET PnL ($)").padEnd(14) +
              String("Profit Factor"));
  console.log("-".repeat(105));

  for (const r of results) {
    console.log(
      String(r.name).padEnd(32) +
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
  console.log("=".repeat(105));

  console.log("\nRincian Exit Reasons:");
  for (const r of results) {
    console.log(`\n* ${r.name}:`);
    for (const [reason, count] of Object.entries(r.exitReasons)) {
      console.log(`    - ${reason}: ${count}`);
    }
  }
}

main().catch(console.error);
