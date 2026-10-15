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
    targetPercent: 22,
    observationSeconds: 20,
    minTransferAgeSeconds: 30,
    maxTransferLagSeconds: 60,
    maxEntryWaitSeconds: 600,
    confirmSeconds: 1,
    minBuySharePercent: 55,
    minMeaningfulBuyUsd: variantConfig.minMeaningfulBuyUsd,
    minMeaningfulBuyers: variantConfig.minMeaningfulBuyers,
    maxBuyerSharePercent: variantConfig.maxBuyerSharePercent,
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

      // Dump Tuntas Check (>= 75%)
      const dd = f.drawdownPercent ?? 0;
      if (dd >= 75) dumpObserved = true;
      if (dd > maxDrawdownSeen) maxDrawdownSeen = dd;
      if (!dumpObserved && maxDrawdownSeen < 75) reasons.push('NOT_YET_DUMPED_SEVERELY');

      // Flow Check
      if ((f.buyShareUsdPercent ?? 0) < r.minBuySharePercent || f.meaningfulBuyUsd < r.minMeaningfulBuyUsd) reasons.push('BUY_FLOW_NOT_RECOVERED');
      if (f.meaningfulBuyers < r.minMeaningfulBuyers) reasons.push('INSUFFICIENT_BUYERS_NEED_MULTI_WALLET');
      if (f.topBuyerSharePercent !== null && f.topBuyerSharePercent > r.maxBuyerSharePercent) reasons.push('BUYER_CONCENTRATION_TOO_HIGH_SINGLE_WALLET');

      // Progressive Staircase Dwell
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
      if (net <= -25) return 'HARD_CAP_RUGPULL_PROTECTION';
      if (net >= 20) return 'TARGET_BOUNCE_20_22';
      if (net >= 18 && (f.bounceFromTroughPercent ?? 0) < 15) return 'PULLBACK_AFTER_NEAR_TARGET';
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

  const entered = events.some(e => e.type === "PAPER_BUY");
  const exitEvent = events.find(e => e.type === "PAPER_SELL");

  if (!entered) return { mint: meta.mint, entered: false };

  const netReturn = exitEvent?.netReturnPercent ?? 0;
  const pnlUsd = (5 * netReturn) / 100;
  const isWin = netReturn > 0;

  return {
    mint: meta.mint,
    entered: true,
    netReturn,
    pnlUsd,
    isWin,
    exitReason: exitEvent?.reason || "OPEN_HOLDING"
  };
}

async function main() {
  console.log("Memuat trade historis...");
  const tokenTradeMap = new Map();
  for (const t of targets) {
    const rows = await readMintTrades(t.mint);
    if (rows.length > 0) tokenTradeMap.set(t.mint, rows);
  }
  console.log(`Berhasil memuat ${tokenTradeMap.size} token ber-cache.\n`);

  const variants = [
    { name: "Lane V6 Sekarang ($18, 3 buyer, max 70%)", minMeaningfulBuyUsd: 18, minMeaningfulBuyers: 3, maxBuyerSharePercent: 70 },
    { name: "Opsi 2A: Sedang ($12, 2 buyer, max 75%)", minMeaningfulBuyUsd: 12, minMeaningfulBuyers: 2, maxBuyerSharePercent: 75 },
    { name: "Opsi 2B: Longgar ($10, 2 buyer, max 80%)", minMeaningfulBuyUsd: 10, minMeaningfulBuyers: 2, maxBuyerSharePercent: 80 },
    { name: "Opsi 2C: Presisi ($14, 2 buyer, max 75%)", minMeaningfulBuyUsd: 14, minMeaningfulBuyers: 2, maxBuyerSharePercent: 75 },
    { name: "Base V5 ($5, 2 buyer, max 80%)", minMeaningfulBuyUsd: 5, minMeaningfulBuyers: 2, maxBuyerSharePercent: 80 },
  ];

  for (const v of variants) {
    let enteredCount = 0;
    let wins = 0;
    let losses = 0;
    let totalPnl = 0;
    let totalPct = 0;

    for (const t of targets) {
      const rows = tokenTradeMap.get(t.mint);
      if (!rows) continue;
      const res = runSimulationForToken(t, rows, v);
      if (res && res.entered) {
        enteredCount++;
        if (res.isWin) wins++;
        else losses++;
        totalPnl += res.pnlUsd;
        totalPct += res.netReturn;
      }
    }

    const wr = enteredCount > 0 ? (wins / enteredCount * 100).toFixed(1) : 0;
    const avgPct = enteredCount > 0 ? (totalPct / enteredCount).toFixed(2) : 0;
    console.log(`=== ${v.name} ===`);
    console.log(`  Total Trades Masuk: ${enteredCount}`);
    console.log(`  Win: ${wins} | Loss: ${losses}`);
    console.log(`  Win Rate: ${wr}%`);
    console.log(`  Net PnL: $${totalPnl.toFixed(2)} USD`);
    console.log(`  Rata-rata Return: ${avgPct}%\n`);
  }
}

main().catch(console.error);
