import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

async function main() {
  const root = process.cwd();
  const eventsPath = join(root, "data", "convergence-monitor-events.json");
  const events = JSON.parse(readFileSync(eventsPath, "utf8"));

  // Filter unique golden tokens
  const goldenEvents = events.filter(e => 
    e.classification === "GOLDEN_ORGANIC_CONVERGENCE" || 
    e.confidence === "HIGH" ||
    (e.walletEntries && e.walletEntries.length >= 2 && e.walletEntries.filter(w => w.profitUsd > 0).length >= 2)
  );

  // Deduplicate by mint to avoid duplicate runs
  const uniqueGoldenMap = new Map();
  for (const g of goldenEvents) {
    if (!uniqueGoldenMap.has(g.mint)) {
      uniqueGoldenMap.set(g.mint, g);
    }
  }
  const goldenList = Array.from(uniqueGoldenMap.values());
  console.log(`Found ${goldenList.length} unique Golden Convergence tokens for buy simulation.\n`);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes("gmgn.ai")) || context.pages()[0];

  const simulationResults = [];

  for (let idx = 0; idx < goldenList.length; idx++) {
    const token = goldenList[idx];
    const mint = token.mint;
    const symbol = token.symbol || "UNKNOWN";
    const wallets = token.walletEntries || [];

    if (wallets.length < 2) continue;

    // Entry timing: Triggered when the 2nd smart wallet confirms convergence
    const entryWallet = wallets[1] || wallets[0];
    const entryTsSec = entryWallet.timestamp;
    const entryDate = new Date(entryTsSec * 1000);
    const entryWib = entryDate.toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }) + " WIB";

    // Earliest and median wallet exit times
    const exitTimestamps = wallets
      .map(w => w.exitTimestamp)
      .filter(t => t && t > entryTsSec)
      .sort((a, b) => a - b);
    const earliestSmartExitTs = exitTimestamps[0] || (entryTsSec + 900); // fallback 15m
    const medianSmartExitTs = exitTimestamps[Math.floor(exitTimestamps.length / 2)] || earliestSmartExitTs;

    // Fetch 1m candles from GMGN
    const params = "device_id=2d641f4c-9eb7-4dda-8e7e-9a0e273b7757&tab_id=mvldfuria11j&fp_did=53b08a7a5aa335d9621f3643748ed83f&client_id=gmgn_web_20261023-5847-47b0c03&from_app=gmgn&app_ver=20261023-5847-47b0c03&tz_name=Asia_Jakarta&tz_offset=25200&app_lang=en-US&os=web&worker=0&pool_type=tpool";
    const candleUrl = `https://gmgn.ai/api/v1/token_mcap_candles/sol/${mint}?${params}&resolution=1m&limit=300`;

    let candles = [];
    try {
      const res = await page.evaluate(async (url) => {
        try {
          const resp = await fetch(url);
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }, candleUrl);
      candles = res.data?.list || [];
    } catch (e) {
      console.error(`Error fetching candles for ${symbol}:`, e.message);
    }

    if (candles.length === 0) {
      console.log(`[${idx + 1}/${goldenList.length}] ⚠️  ${symbol} (${mint.slice(0, 6)}...): No candles returned, skipping.`);
      continue;
    }

    // Sort candles chronologically (time in ms)
    candles.sort((a, b) => Number(a.time) - Number(b.time));

    // Find entry candle closest to entryTsSec
    let closestIdx = 0;
    let minDiffSec = Infinity;
    for (let cIdx = 0; cIdx < candles.length; cIdx++) {
      const cSec = Math.floor(Number(candles[cIdx].time) / 1000);
      const diff = Math.abs(cSec - entryTsSec);
      if (diff < minDiffSec) {
        minDiffSec = diff;
        closestIdx = cIdx;
      }
    }

    const validEntryIdx = closestIdx;
    const entryCandle = candles[validEntryIdx];
    const entryMcap = Number(entryCandle.close || entryCandle.open);

    if (!entryMcap || entryMcap <= 0) {
      continue;
    }

    // Subsequent candles after entry
    const forwardCandles = candles.slice(validEntryIdx);
    if (forwardCandles.length < 2) continue;

    // Calculate maximum peak reached post-entry
    let peakMcap = entryMcap;
    let minMcap = entryMcap;
    for (const c of forwardCandles) {
      const high = Number(c.high || c.close);
      const low = Number(c.low || c.close);
      if (high > peakMcap) peakMcap = high;
      if (low < minMcap) minMcap = low;
    }
    const maxMultiplier = (peakMcap / entryMcap).toFixed(2);
    const maxGainPct = Math.round(((peakMcap - entryMcap) / entryMcap) * 100);

    const INITIAL_BET_USD = 100;
    const FEE_AND_SLIPPAGE_RATE = 0.02; // 2% round-trip fee & slippage

    // ----------------------------------------------------
    // STRATEGY 1: Smart Mirror Exit (Ikuti Exit Smart Wallet)
    // ----------------------------------------------------
    // Cari candle saat median wallet exit
    let strat1ExitCandle = forwardCandles.find(c => {
      const cSec = Math.floor(Number(c.time) / 1000);
      return cSec >= medianSmartExitTs;
    }) || forwardCandles[forwardCandles.length - 1];

    const strat1ExitMcap = Number(strat1ExitCandle.close || strat1ExitCandle.open);
    const strat1RawReturn = (strat1ExitMcap - entryMcap) / entryMcap;
    const strat1NetReturn = strat1RawReturn - FEE_AND_SLIPPAGE_RATE;
    const strat1PnlUsd = Math.round(INITIAL_BET_USD * strat1NetReturn);
    const strat1DurationM = Math.max(1, Math.round((Number(strat1ExitCandle.time) - Number(entryCandle.time)) / 60000));
    const strat1ExitWib = new Date(Number(strat1ExitCandle.time)).toLocaleTimeString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }) + " WIB";

    // ----------------------------------------------------
    // STRATEGY 2: Disciplined Scalp Bot (+35% TP, -12% SL, Trailing 7%)
    // ----------------------------------------------------
    let strat2PnlUsd = 0;
    let strat2ExitReason = "Timeout 30m";
    let strat2ExitMcap = entryMcap;
    let strat2DurationM = 0;
    let strat2ExitWib = entryWib;

    let s2Peak = entryMcap;
    const S2_MAX_MINUTES = 30;

    for (let m = 1; m < Math.min(forwardCandles.length, S2_MAX_MINUTES + 1); m++) {
      const c = forwardCandles[m];
      const high = Number(c.high || c.close);
      const low = Number(c.low || c.close);
      const close = Number(c.close);

      if (high > s2Peak) s2Peak = high;

      const curGain = (high - entryMcap) / entryMcap;
      const curLoss = (low - entryMcap) / entryMcap;
      const pullbackFromPeak = (s2Peak - low) / s2Peak;

      strat2DurationM = m;
      strat2ExitWib = new Date(Number(c.time)).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }) + " WIB";

      // TP hit at +35%
      if (curGain >= 0.35) {
        strat2ExitReason = "Take Profit (+35%)";
        strat2ExitMcap = entryMcap * 1.35;
        break;
      }
      // Trailing stop: activated if peak >= +20% and pulled back 7%
      if (s2Peak >= entryMcap * 1.20 && pullbackFromPeak >= 0.07) {
        strat2ExitReason = `Trailing Stop (+${Math.round(((s2Peak * 0.93 - entryMcap) / entryMcap) * 100)}%)`;
        strat2ExitMcap = s2Peak * 0.93;
        break;
      }
      // Stop Loss hit at -12%
      if (curLoss <= -0.12) {
        strat2ExitReason = "Stop Loss (-12%)";
        strat2ExitMcap = entryMcap * 0.88;
        break;
      }

      // If last candle reached within 30m
      if (m === Math.min(forwardCandles.length, S2_MAX_MINUTES) - 1) {
        strat2ExitReason = "Market Timeout (30m)";
        strat2ExitMcap = close;
      }
    }

    const strat2RawReturn = (strat2ExitMcap - entryMcap) / entryMcap;
    const strat2NetReturn = strat2RawReturn - FEE_AND_SLIPPAGE_RATE;
    strat2PnlUsd = Math.round(INITIAL_BET_USD * strat2NetReturn);

    // ----------------------------------------------------
    // STRATEGY 3: Moonbag / Swing Runner (+50% TP1, +120% TP2, -15% SL, Trailing 10%)
    // ----------------------------------------------------
    let strat3ExitReason = "Timeout 60m";
    let strat3ExitMcap = entryMcap;
    let strat3DurationM = 0;
    let strat3ExitWib = entryWib;

    let s3Peak = entryMcap;
    let tp1Sold = false;
    let s3RealizedFraction = 0;
    const S3_MAX_MINUTES = 60;

    for (let m = 1; m < Math.min(forwardCandles.length, S3_MAX_MINUTES + 1); m++) {
      const c = forwardCandles[m];
      const high = Number(c.high || c.close);
      const low = Number(c.low || c.close);
      const close = Number(c.close);

      if (high > s3Peak) s3Peak = high;

      const curGain = (high - entryMcap) / entryMcap;
      const curLoss = (low - entryMcap) / entryMcap;
      const pullbackFromPeak = (s3Peak - low) / s3Peak;

      strat3DurationM = m;
      strat3ExitWib = new Date(Number(c.time)).toLocaleTimeString("id-ID", {
        timeZone: "Asia/Jakarta",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }) + " WIB";

      // TP1 hit at +50% -> sell 50%
      if (!tp1Sold && curGain >= 0.50) {
        tp1Sold = true;
        s3RealizedFraction += 0.5 * 1.50; // 50% capital at 1.5x
      }

      // TP2 hit at +120% -> sell remaining 50%
      if (curGain >= 1.20) {
        strat3ExitReason = tp1Sold ? "TP1 (+50%) & TP2 (+120%) Full Hit" : "TP2 (+120%) Hit";
        s3RealizedFraction += tp1Sold ? (0.5 * 2.20) : 2.20;
        strat3ExitMcap = entryMcap * 2.20;
        break;
      }

      // Trailing stop: activated if peak >= +30% and pulled back 10%
      if (s3Peak >= entryMcap * 1.30 && pullbackFromPeak >= 0.10) {
        const trailPrice = s3Peak * 0.90;
        const trailMult = trailPrice / entryMcap;
        strat3ExitReason = `Trailing Stop (Peak +${Math.round(((s3Peak - entryMcap)/entryMcap)*100)}%)`;
        s3RealizedFraction += tp1Sold ? (0.5 * trailMult) : trailMult;
        strat3ExitMcap = trailPrice;
        break;
      }

      // Stop loss at -15%
      if (!tp1Sold && curLoss <= -0.15) {
        strat3ExitReason = "Stop Loss (-15%)";
        s3RealizedFraction = 0.85;
        strat3ExitMcap = entryMcap * 0.85;
        break;
      }

      if (m === Math.min(forwardCandles.length, S3_MAX_MINUTES) - 1) {
        const closeMult = close / entryMcap;
        strat3ExitReason = "Market Timeout (60m)";
        s3RealizedFraction += tp1Sold ? (0.5 * closeMult) : closeMult;
        strat3ExitMcap = close;
      }
    }

    const strat3NetMultiplier = s3RealizedFraction - FEE_AND_SLIPPAGE_RATE;
    const strat3PnlUsd = Math.round(INITIAL_BET_USD * (strat3NetMultiplier - 1));

    simulationResults.push({
      symbol,
      mint,
      entryWib,
      entryMcap: Math.round(entryMcap),
      peakMcap: Math.round(peakMcap),
      maxMultiplier: `${maxMultiplier}x (+${maxGainPct}%)`,
      walletsCount: wallets.length,
      cuanWalletsCount: wallets.filter(w => w.profitUsd > 0).length,
      strat1: {
        name: "Smart Mirror Exit",
        exitWib: strat1ExitWib,
        durationM: strat1DurationM,
        pnlUsd: strat1PnlUsd,
        roiPct: Math.round(strat1NetReturn * 100),
        reason: "Follow Smart Wallet Sell"
      },
      strat2: {
        name: "Scalp Bot (+35% / -12%)",
        exitWib: strat2ExitWib,
        durationM: strat2DurationM,
        pnlUsd: strat2PnlUsd,
        roiPct: Math.round(strat2NetReturn * 100),
        reason: strat2ExitReason
      },
      strat3: {
        name: "Moonbag Runner (+50% / +120%)",
        exitWib: strat3ExitWib,
        durationM: strat3DurationM,
        pnlUsd: strat3PnlUsd,
        roiPct: Math.round((strat3NetMultiplier - 1) * 100),
        reason: strat3ExitReason
      }
    });

    console.log(`[${idx + 1}/${goldenList.length}] ✅ Simulated: ${symbol.padEnd(10)} | Entry: $${Math.round(entryMcap).toLocaleString()} | Peak: ${maxMultiplier}x | Strat1: $${strat1PnlUsd > 0 ? '+' : ''}${strat1PnlUsd} | Strat2: $${strat2PnlUsd > 0 ? '+' : ''}${strat2PnlUsd} | Strat3: $${strat3PnlUsd > 0 ? '+' : ''}${strat3PnlUsd}`);
    await new Promise(r => setTimeout(r, 200));
  }

  // Summary Metrics
  const summary = (stratKey) => {
    const trades = simulationResults.map(r => r[stratKey]);
    const wins = trades.filter(t => t.pnlUsd > 0);
    const losses = trades.filter(t => t.pnlUsd <= 0);
    const winRate = ((wins.length / trades.length) * 100).toFixed(1);
    const totalPnl = trades.reduce((acc, t) => acc + t.pnlUsd, 0);
    const grossProfit = wins.reduce((acc, t) => acc + t.pnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.pnlUsd, 0));
    const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞";
    const avgDuration = Math.round(trades.reduce((acc, t) => acc + t.durationM, 0) / trades.length);
    return {
      winRate: `${winRate}% (${wins.length}/${trades.length})`,
      totalPnl: `$${totalPnl >= 0 ? '+' : ''}${totalPnl}`,
      profitFactor,
      avgDuration: `${avgDuration} menit`,
      grossProfit: `+$${grossProfit}`,
      grossLoss: `-$${grossLoss}`
    };
  };

  const report = {
    executedAtWib: new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }) + " WIB",
    totalTokensTested: simulationResults.length,
    betPerTrade: "$100 USD (Fee & Slippage 2.0% deducted)",
    strategySummaries: {
      strategy1_smart_mirror: summary("strat1"),
      strategy2_scalp_bot: summary("strat2"),
      strategy3_moonbag_runner: summary("strat3")
    },
    results: simulationResults
  };

  const outPath = join(root, "data", "golden-simulation-results.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n======================================================`);
  console.log(`SIMULATION SUMMARY (Modal $100 per Token):`);
  console.log(`Total Tokens Tested: ${report.totalTokensTested}`);
  console.log(`------------------------------------------------------`);
  console.log(`1. Skenario Smart Mirror Exit (Ikuti Jual Smart Wallet):`);
  console.log(`   - Win Rate:      ${report.strategySummaries.strategy1_smart_mirror.winRate}`);
  console.log(`   - Total Net PnL: ${report.strategySummaries.strategy1_smart_mirror.totalPnl}`);
  console.log(`   - Profit Factor: ${report.strategySummaries.strategy1_smart_mirror.profitFactor}`);
  console.log(`   - Avg Durasi:    ${report.strategySummaries.strategy1_smart_mirror.avgDuration}`);
  console.log(`------------------------------------------------------`);
  console.log(`2. Skenario Scalp Bot (+35% TP / -12% SL / Trailing 7%):`);
  console.log(`   - Win Rate:      ${report.strategySummaries.strategy2_scalp_bot.winRate}`);
  console.log(`   - Total Net PnL: ${report.strategySummaries.strategy2_scalp_bot.totalPnl}`);
  console.log(`   - Profit Factor: ${report.strategySummaries.strategy2_scalp_bot.profitFactor}`);
  console.log(`   - Avg Durasi:    ${report.strategySummaries.strategy2_scalp_bot.avgDuration}`);
  console.log(`------------------------------------------------------`);
  console.log(`3. Skenario Moonbag Runner (+50% TP1 / +120% TP2 / Trailing 10%):`);
  console.log(`   - Win Rate:      ${report.strategySummaries.strategy3_moonbag_runner.winRate}`);
  console.log(`   - Total Net PnL: ${report.strategySummaries.strategy3_moonbag_runner.totalPnl}`);
  console.log(`   - Profit Factor: ${report.strategySummaries.strategy3_moonbag_runner.profitFactor}`);
  console.log(`   - Avg Durasi:    ${report.strategySummaries.strategy3_moonbag_runner.avgDuration}`);
  console.log(`======================================================\n`);
  console.log(`Saved detailed report to ${outPath}`);

  await browser.close();
}

main().catch(err => {
  console.error("Simulation error:", err);
  process.exit(1);
});
