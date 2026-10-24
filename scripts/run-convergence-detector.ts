import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ConvergenceDetector, type TradeEvent } from "../src/convergence-detector.js";
import { SnowballCollector } from "../src/snowball-collector.js";
import { GoldenConvergencePaperLane, type PaperPosition } from "../src/golden-convergence-paper-lane.js";

async function main() {
  console.log("================================================================================");
  console.log("   🛰️  SMART WALLET LIVE CONVERGENCE & ANTI-SYNDICATE DETECTOR (SNOWBALL MODE)");
  console.log("================================================================================\n");

  const isDaemonMode = process.argv.includes("--daemon");
  const isScanMode = process.argv.includes("--scan") || !process.argv.includes("--live");

  // Initialize Golden Convergence Paper Lane ($5 stake default)
  const defaultStake = Number(process.env.PAPER_STAKE_USD || 5);
  const paperLane = new GoldenConvergencePaperLane({ stakePerTradeUsd: defaultStake });

  // 1. Initialize Snowball Collector and Load Clean Wallets
  const snowball = new SnowballCollector();
  let cleanWallets: string[] = snowball.getAllAddresses();
  console.log(`[INIT] Loaded ${cleanWallets.length} clean organic wallets from Snowball Collector.`);

  // 2. Initialize Detector with strict Lowcap boundary (< $100k MC, price < $0.50)
  const detector = new ConvergenceDetector({
    timeWindowSec: 7200, // 2 hours sliding window for organic multi-wallet accumulation
    cdpUrl: "http://127.0.0.1:9223",
    monitoredWallets: cleanWallets,
    outputFile: "data/convergence-monitor-events.json",
    maxMarketCapUsd: 100_000, // Hard limit: < $100k Lowcaps only
    maxPriceUsd: 0.50 // Hard limit: filter out tokenized stocks ($200+) and large caps
  });

  // Connect to Chrome CDP on port 9223
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const page = browser.contexts()[0].pages().find(p => p.url().includes("gmgn.ai")) || browser.contexts()[0].pages()[0];
  console.log(`[CDP] Attached to active GMGN tab: ${page.url()}`);

  const subscribedMints = new Set<string>();

  async function subscribeTokenWs(mint: string) {
    if (subscribedMints.has(mint)) return;
    subscribedMints.add(mint);
    try {
      await page.evaluate((address: string) => {
        const ws = (window as any).__gmgnWs;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            action: "subscribe",
            channel: "token_activity",
            f: "w",
            id: `sub_${address.slice(0, 8)}_act`,
            data: [{ chain: "sol", addresses: address }]
          }));
          ws.send(JSON.stringify({
            action: "subscribe",
            channel: "token_stat",
            f: "w",
            id: `sub_${address.slice(0, 8)}_stat`,
            data: [{ chain: "sol", addresses: address }]
          }));
        }
      }, mint);
      console.log(`[WS-SUBSCRIBE] 📡 Subscribed ${mint.slice(0, 8)}... to live GMGN WebSocket stream`);
    } catch (err: any) {
      console.warn(`[WS-SUB-ERR] Failed subscribing ${mint.slice(0, 8)}...:`, err.message);
    }
  }

  async function unsubscribeTokenWs(mint: string) {
    subscribedMints.delete(mint);
    try {
      await page.evaluate((address: string) => {
        const ws = (window as any).__gmgnWs;
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({
            action: "unsubscribe",
            channel: "token_activity",
            f: "w",
            id: `unsub_${address.slice(0, 8)}_act`,
            data: [{ chain: "sol", addresses: address }]
          }));
          ws.send(JSON.stringify({
            action: "unsubscribe",
            channel: "token_stat",
            f: "w",
            id: `unsub_${address.slice(0, 8)}_stat`,
            data: [{ chain: "sol", addresses: address }]
          }));
        }
      }, mint);
      console.log(`[WS-UNSUBSCRIBE] ⏹️ Unsubscribed ${mint.slice(0, 8)}... from GMGN WebSocket stream`);
    } catch {}
  }

  async function handlePaperBuy(report: any): Promise<boolean> {
    if (!report.walletEntries || report.walletEntries.length < 2) return false;
    const w1 = report.walletEntries[0];
    const organicWallet = report.walletEntries.find((w: any) => (w.deltaSecFromFirst || 0) >= 180) || report.walletEntries[1];
    const w2 = organicWallet;
    const delta = w2.deltaSecFromFirst || report.entryDeltaSec || 0;

    let entryPrice = report.dexInfo?.priceUsd || (report.dexInfo?.marketCapUsd ? report.dexInfo.marketCapUsd / 1e9 : 0.00001);
    const entryMcap = report.dexInfo?.marketCapUsd || 15000;

    // Strict Anti-Syndicate Gate:
    // 1. Delta WAJIB >= 180 detik (tolak mutlak bundler / sindikat <= 30s)
    // 2. Likuiditas >= $2,000 dan tidak drained
    // 3. Status GOLDEN_ORGANIC_CONVERGENCE atau (delta >= 180s && cuanWallets >= 2)
    // 4. Live Fresh Only: Wajib entry dari masa uji aktif (2 jam terakhir)
    const LIVE_TRIAL_START_TS = Math.floor(Date.now() / 1000) - 7200;
    if (w2.timestamp < LIVE_TRIAL_START_TS) {
      return false;
    }

    const cuanWallets = (report.walletEntries || []).filter((w: any) => (w.profitUsd || 0) > 0);
    const isStrictGolden = (
      report.classification === "GOLDEN_ORGANIC_CONVERGENCE" ||
      (delta >= 180 && cuanWallets.length >= 2)
    ) && delta >= 180 && !report.isLiquidityDrained && (report.dexInfo?.liquidityUsd || 0) >= 2000;

    if (!isStrictGolden) {
      return false;
    }

    // Hit real GMGN swap route API (/txproxy/v1/get_swap_route) via CDP
    let realBuyRoute: any = null;
    try {
      realBuyRoute = await detector.fetchRealSwapRoute(report.mint, "buy", defaultStake);
      if (realBuyRoute?.ok && realBuyRoute.impliedPriceUsd && realBuyRoute.impliedPriceUsd > 0) {
        console.log(`[SWAP-ROUTE-BUY] 🎯 Real GMGN execution price: $${realBuyRoute.impliedPriceUsd} (Latency: ${realBuyRoute.latencyMs}ms, Exchange: ${realBuyRoute.routeData?.exchange || "AMM"})`);
        entryPrice = realBuyRoute.impliedPriceUsd;
      }
    } catch {}

    const stakeAmount = defaultStake;
    // 1. Lane A: Golden Scalp Bot (+35% TP / -12% SL / Trailing 7% dari +20% / Max 30m)
    const posScalp = paperLane.openPosition({
      lane: "LANE_GOLDEN_SCALP",
      mint: report.mint,
      symbol: report.symbol,
      entryPriceUsd: entryPrice,
      entryMcapUsd: entryMcap,
      entryTimestamp: w2.timestamp,
      wallet1: { address: w1.wallet, enteredAtWib: w1.enteredAtWib },
      wallet2: { address: w2.wallet, enteredAtWib: w2.enteredAtWib, deltaSecFromFirst: w2.deltaSecFromFirst },
      realSwapRouteBuy: realBuyRoute?.ok ? {
        exchange: realBuyRoute.routeData?.exchange,
        impliedPriceUsd: realBuyRoute.impliedPriceUsd,
        tokensOut: realBuyRoute.quote?.outAmount,
        latencyMs: realBuyRoute.latencyMs,
        priceImpactPct: realBuyRoute.quote?.priceImpactPct
      } : undefined
    });
    if (posScalp) {
      console.log(`[PAPER-BUY] ⚡ Opened Scalp Bot position on ${report.symbol} at Wallet #2 entry (${w2.enteredAtWib}) | Stake: $${stakeAmount} | MC: $${Math.round(entryMcap).toLocaleString()}`);
    }

    // 2. Lane B: Golden Moonbag Runner (+50% TP1, +120% TP2 / -15% SL / Trailing 10% / Max 60m)
    const posMoon = paperLane.openPosition({
      lane: "LANE_GOLDEN_MOONBAG",
      mint: report.mint,
      symbol: report.symbol,
      entryPriceUsd: entryPrice,
      entryMcapUsd: entryMcap,
      entryTimestamp: w2.timestamp,
      wallet1: { address: w1.wallet, enteredAtWib: w1.enteredAtWib },
      wallet2: { address: w2.wallet, enteredAtWib: w2.enteredAtWib, deltaSecFromFirst: w2.deltaSecFromFirst },
      realSwapRouteBuy: realBuyRoute?.ok ? {
        exchange: realBuyRoute.routeData?.exchange,
        impliedPriceUsd: realBuyRoute.impliedPriceUsd,
        tokensOut: realBuyRoute.quote?.outAmount,
        latencyMs: realBuyRoute.latencyMs,
        priceImpactPct: realBuyRoute.quote?.priceImpactPct
      } : undefined
    });
    if (posMoon) {
      console.log(`[PAPER-BUY] 🚀 Opened Moonbag Runner position on ${report.symbol} at Wallet #2 entry (${w2.enteredAtWib}) | Stake: $${stakeAmount} | MC: $${Math.round(entryMcap).toLocaleString()}`);
    }

    if (posScalp || posMoon) {
      paperLane.saveState();
      await subscribeTokenWs(report.mint);
      return true;
    }
    return false;
  }

  // Listen for detector events
  detector.on("golden_signal", async (report) => {
    await handlePaperBuy(report);
    console.log("\n" + "=".repeat(75));
    console.log(`🌟 [GOLDEN CONVERGENCE SIGNAL] Token: ${report.symbol} (${report.mint.slice(0, 8)}...)`);
    console.log(`   Wallets involved (${report.wallets.length}):`);
    if (report.walletEntries && report.walletEntries.length > 0) {
      for (const [idx, we] of report.walletEntries.entries()) {
        const deltaStr = we.deltaSecFromFirst === 0 ? "First Pioneer (0s)" : `+${Math.round(we.deltaSecFromFirst / 60)}m (${we.deltaSecFromFirst}s)`;
        const exitStr = we.exitedAtWib ? (we.isHolding ? `Exit: HOLDING` : `Exit: ${we.exitedAtWib} (${we.holdingDurationStr || '-'})`) : "";
        const profitStr = we.profitUsd !== null && we.profitUsd !== undefined ? ` | Cuan: ${we.profitUsd >= 0 ? '+' : ''}$${we.profitUsd.toLocaleString()} (${we.pnlPercent || 0}%)` : "";
        console.log(`     ${idx + 1}. ${we.wallet.slice(0, 8)}...${we.wallet.slice(-6)} | Masuk: ${we.enteredAtWib} | ${exitStr}${profitStr} | Selisih: ${deltaStr}`);
      }
    }
    console.log(`   Entry Delta: ~${Math.round(report.entryDeltaSec / 60)} menit`);
    console.log(`   DEX: ${report.dexInfo?.dexId || 'N/A'} | Price: $${report.dexInfo?.priceUsd || '0'} | Liquidity: $${report.dexInfo?.liquidityUsd?.toLocaleString() || '0'}`);
    console.log("=".repeat(75) + "\n");
  });

  detector.on("syndicate_detected", (report) => {
    console.log(`🚨 [SYNDICATE DUMP DETECTED] Token: ${report.symbol} (${report.mint.slice(0, 8)}...) | Delta: ${report.entryDeltaSec}s -> QUARANTINED`);
  });

  // Real-time WebSocket tick handler
  async function handleWebSocketTick(mint: string, priceUsd: number, rawItem: any) {
    const openPositions = paperLane.getOpenPositions().filter(p => p.mint === mint && !(p as any)._closing);
    if (openPositions.length === 0) {
      if (subscribedMints.has(mint)) {
        await unsubscribeTokenWs(mint);
      }
      return;
    }

    const nowSec = Math.floor(Date.now() / 1000);

    for (const pos of openPositions) {
      if (!pos.peakPriceUsd || priceUsd > pos.peakPriceUsd) {
        pos.peakPriceUsd = priceUsd;
      }
      pos.currentPriceUsd = priceUsd;
      const curGain = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
      const curLoss = curGain;
      pos.currentGainPct = Number((curGain * 100).toFixed(2));

      let triggered = false;
      let reason: any = "";

      if (pos.lane === "LANE_GOLDEN_SCALP") {
        if (curGain >= 0.35) {
          triggered = true;
          reason = "TAKE_PROFIT_35";
        } else if (pos.peakPriceUsd >= pos.entryPriceUsd * 1.20 && (pos.peakPriceUsd - priceUsd) / pos.peakPriceUsd >= 0.07) {
          triggered = true;
          reason = "TRAILING_STOP_7PCT";
        } else if (curLoss <= -0.12) {
          triggered = true;
          reason = "STOP_LOSS_12";
        }
      } else if (pos.lane === "LANE_GOLDEN_MOONBAG") {
        if (!pos.tp1Hit && curGain >= 0.50) {
          pos.tp1Hit = true;
          pos.realizedFraction = 0.5 * 1.50;
          console.log(`[WS-TICK] 🎯 ${pos.symbol} locked TP1 (+50%) via live WebSocket tick ($${priceUsd})!`);
          paperLane.saveState();
        }

        if (curGain >= 1.20) {
          triggered = true;
          reason = "TP1_50_TP2_120_HIT";
        } else if (pos.peakPriceUsd >= pos.entryPriceUsd * 1.30 && (pos.peakPriceUsd - priceUsd) / pos.peakPriceUsd >= 0.10) {
          triggered = true;
          reason = "TP1_50_TRAILING_10";
        } else if (!pos.tp1Hit && curLoss <= -0.15) {
          triggered = true;
          reason = "STOP_LOSS_15";
        }
      }

      if (triggered) {
        (pos as any)._closing = true;
        console.log(`\n[WS-TICK-TRIGGER] 🚨 ${pos.symbol} (${pos.lane}) hit ${reason} at live tick $${priceUsd}! Fetching real GMGN sell swap quote...`);

        let realSellRoute: any = null;
        try {
          const tokenUnits = pos.realSwapRouteBuy?.tokensOut || undefined;
          realSellRoute = await detector.fetchRealSwapRoute(pos.mint, "sell", pos.stakeUsd, tokenUnits);
          if (realSellRoute?.ok && realSellRoute.impliedPriceUsd && realSellRoute.impliedPriceUsd > 0) {
            console.log(`[WS-SWAP-ROUTE-SELL] ⚡ AMM execution quote for ${pos.symbol}: $${realSellRoute.impliedPriceUsd} (Latency: ${realSellRoute.latencyMs}ms, Out: $${realSellRoute.quote?.amountOutUsd})`);
          }
        } catch (err: any) {
          console.warn(`[WS-SWAP-WARN] Sell route failed: ${err.message}`);
        }

        const res = paperLane.evaluatePriceTick(pos, {
          priceUsd: realSellRoute?.impliedPriceUsd || priceUsd,
          timestamp: nowSec,
          realSwapRouteSell: realSellRoute?.ok ? {
            exchange: realSellRoute.routeData?.exchange,
            impliedPriceUsd: realSellRoute.impliedPriceUsd,
            amountOutUsd: realSellRoute.quote?.amountOutUsd ?? (realSellRoute.routeData?.amount_out_usd ? Number(realSellRoute.routeData.amount_out_usd) : undefined),
            latencyMs: realSellRoute.latencyMs,
            priceImpactPct: realSellRoute.quote?.priceImpactPct
          } : undefined
        });

        if (res.closed) {
          console.log(`[WS-PAPER-EXIT] 🏁 Closed ${pos.symbol} (${pos.lane}) | Reason: ${res.reason} | Real PnL: ${pos.pnlUsd! >= 0 ? '+' : ''}$${pos.pnlUsd} (${pos.netReturnPct}%) | Latency: ${realSellRoute?.latencyMs || 0}ms`);
          paperLane.saveState();

          const remaining = paperLane.getOpenPositions().filter(p => p.mint === mint);
          if (remaining.length === 0) {
            await unsubscribeTokenWs(mint);
          }
        } else {
          (pos as any)._closing = false;
        }
      }
    }
  }

  // Setup CDP WebSocket listener
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");

  cdp.on("Network.webSocketFrameReceived", async (p) => {
    try {
      const payload = p.response.payloadData;
      if (!payload || !payload.startsWith("{")) return;
      const j = JSON.parse(payload);
      if ((j.channel === "token_activity" || j.channel === "token_stat") && Array.isArray(j.data)) {
        for (const item of j.data) {
          const mint = item.a;
          if (!mint || !subscribedMints.has(mint)) continue;
          const price = Number(item.pu || item.p);
          if (!price || isNaN(price) || price <= 0) continue;
          await handleWebSocketTick(mint, price, item);
        }
      }
    } catch {}
  });

  // Subscribe initial open positions
  const initialOpen = paperLane.getOpenPositions();
  for (const pos of initialOpen) {
    await subscribeTokenWs(pos.mint);
  }
  if (initialOpen.length > 0) {
    console.log(`[DAEMON-INIT] ⚡ Subscribed ${subscribedMints.size} existing open positions to WebSocket stream.`);
  }

  // Common Discovery Function
  async function runDiscoveryCycle(): Promise<number> {
    const allTrades: TradeEvent[] = [];
    try {
      const lowcapTokens = await page.evaluate(async () => {
        try {
          const r = await fetch("/defi/quotation/v1/rank/sol/swaps/1h?limit=30&min_marketcap=5000&max_marketcap=100000");
          const j = await r.json().catch(() => null);
          return j?.data?.rank || [];
        } catch {
          return [];
        }
      });

      console.log(`[LOWCAP-DISCOVERY] Inspecting ${lowcapTokens.length} tokens in $5k-$100k MC range...`);

      for (const t of lowcapTokens.slice(0, 20)) {
        try {
          await new Promise((r) => setTimeout(r, 60));
          const tradersData = await page.evaluate(async (mint: string) => {
            try {
              const res = await fetch(`/vas/api/v1/token_traders/sol/${mint}?limit=50&orderby=profit&direction=desc`, {
                credentials: "include"
              });
              return await res.json().catch(() => null);
            } catch {
              return null;
            }
          }, t.address);

          const list = tradersData.data?.list || [];
          for (const tr of list) {
            const { isNew, wallet } = snowball.ingestTrader(tr, t.symbol, t.address);
            if (wallet) {
              detector.addMonitoredWallet(wallet.address);
              const tradeTime = tr.start_holding_at || tr.last_active_timestamp || Math.floor(Date.now() / 1000);
              const exitTime = tr.end_holding_at ? Number(tr.end_holding_at) : null;
              const isHolding = (Number(tr.amount_cur || 0) > 0) || !exitTime;
              const exitDate = exitTime ? new Date(exitTime * 1000) : null;
              const exitedAtWib = exitDate ? exitDate.toLocaleTimeString("id-ID", {
                timeZone: "Asia/Jakarta",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
              }) + " WIB" : (isHolding ? "HOLDING" : null);

              const startTs = tr.start_holding_at || tradeTime;
              const durSec = exitTime ? Math.max(0, exitTime - startTs) : Math.max(0, Math.floor(Date.now() / 1000) - startTs);
              const durM = Math.floor(durSec / 60);
              const durS = durSec % 60;
              const holdingDurationStr = durM > 0 ? `${durM}m ${durS}s` : `${durS}s`;

              const profitUsd = Math.round(Number(tr.profit ?? tr.realized_profit ?? 0));
              const pnlPercent = Number(((tr.realized_pnl ?? 0) * 100).toFixed(1));
              const totalCostUsd = Math.round(Number(tr.total_cost ?? tr.cost_cur ?? 0));

              allTrades.push({
                wallet: wallet.address,
                mint: t.address,
                symbol: t.symbol,
                side: "buy",
                timestamp: tradeTime,
                solAmount: Number(((tr.cost_cur || 100) / 180).toFixed(3)),
                tokenAmount: tr.buy_amount_cur || 0,
                txSignature: `gmgn_${wallet.address.slice(0, 6)}_${t.address.slice(0, 6)}`,
                exitedAt: exitDate ? exitDate.toISOString() : null,
                exitedAtWib,
                exitTimestamp: exitTime,
                holdingDurationSec: durSec,
                holdingDurationStr,
                isHolding,
                profitUsd,
                pnlPercent,
                totalCostUsd
              });
            }
          }
        } catch {}
      }

      snowball.saveSnowball();

      allTrades.sort((a, b) => a.timestamp - b.timestamp);
      for (const t of allTrades) {
        await detector.recordTrade(t);
      }
      return allTrades.length;
    } catch (err: any) {
      console.warn(`[DISCOVERY-CYCLE-WARN] ${err.message}`);
      return 0;
    }
  }

  if (isDaemonMode) {
    console.log(`\n🚀 [DAEMON-MODE] Running persistent Golden Radar + Live GMGN WebSocket Stream`);
    console.log(`   Evaluation: Real-time Tick-by-Tick via WebSocket frames`);
    console.log(`   Execution: Direct AMM Swap sell (/txproxy/v1/get_swap_route) on TP/SL triggers\n`);

    while (true) {
      try {
        const count = await runDiscoveryCycle();
        console.log(`[DAEMON-CYCLE] Processed ${count} buyer events. Active Mints Tracked: ${detector.getActiveMintsCount()} | Open WS Mints: ${subscribedMints.size}`);

        // Timeout Fallback Check for open positions
        const openPos = paperLane.getOpenPositions();
        const nowSec = Math.floor(Date.now() / 1000);
        for (const pos of openPos) {
          const durSec = nowSec - pos.entryTimestamp;
          const maxSec = pos.lane === "LANE_GOLDEN_SCALP" ? 1800 : 3600;
          if (durSec >= maxSec && !(pos as any)._closing) {
            console.log(`[TIMEOUT-FALLBACK] ⏳ Position on ${pos.symbol} (${pos.lane}) reached timeout (${Math.round(durSec/60)}m). Closing with real swap quote...`);
            (pos as any)._closing = true;
            let realSellRoute: any = null;
            try {
              realSellRoute = await detector.fetchRealSwapRoute(pos.mint, "sell", pos.stakeUsd, pos.realSwapRouteBuy?.tokensOut);
            } catch {}

            paperLane.evaluatePriceTick(pos, {
              priceUsd: realSellRoute?.impliedPriceUsd || pos.currentPriceUsd,
              timestamp: nowSec,
              realSwapRouteSell: realSellRoute?.ok ? {
                exchange: realSellRoute.routeData?.exchange,
                impliedPriceUsd: realSellRoute.impliedPriceUsd,
                amountOutUsd: realSellRoute.quote?.amountOutUsd ?? (realSellRoute.routeData?.amount_out_usd ? Number(realSellRoute.routeData.amount_out_usd) : undefined),
                latencyMs: realSellRoute.latencyMs,
                priceImpactPct: realSellRoute.quote?.priceImpactPct
              } : undefined
            });
            paperLane.saveState();
            const rem = paperLane.getOpenPositions().filter(p => p.mint === pos.mint);
            if (rem.length === 0) await unsubscribeTokenWs(pos.mint);
          }
        }
        paperLane.saveState();
      } catch (err: any) {
        console.error(`[DAEMON-ERR] Loop error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 45_000));
    }
  } else if (isScanMode) {
    // One-shot scan mode
    await runDiscoveryCycle();
    
    // Evaluate open positions once via candles / fallback
    const openPositions = paperLane.getOpenPositions();
    if (openPositions.length > 0) {
      console.log(`\n[PAPER-UPDATE] Evaluating ${openPositions.length} open paper positions against latest prices...`);
      for (const pos of openPositions) {
        try {
          let priceUsd = pos.currentPriceUsd;
          let mcapUsd = pos.currentMcapUsd;
          let highPriceUsd: number | undefined;
          let lowPriceUsd: number | undefined;

          const candles = await detector.fetchCandles(pos.mint);
          if (candles && candles.length > 0) {
            const sinceEntry = candles.filter(c => c.time >= (pos.entryTimestamp - 60) * 1000);
            const evalCandles = sinceEntry.length > 0 ? sinceEntry : candles.slice(-5);
            const peakHighMcap = Math.max(...evalCandles.map(c => c.high));
            const deepLowMcap = Math.min(...evalCandles.map(c => c.low));
            const lastCandle = evalCandles[evalCandles.length - 1];
            mcapUsd = lastCandle.close;
            const ratioHigh = peakHighMcap / (pos.entryMcapUsd || 15000);
            const ratioLow = deepLowMcap / (pos.entryMcapUsd || 15000);
            const ratioClose = lastCandle.close / (pos.entryMcapUsd || 15000);
            highPriceUsd = pos.entryPriceUsd * ratioHigh;
            lowPriceUsd = pos.entryPriceUsd * ratioLow;
            priceUsd = pos.entryPriceUsd * ratioClose;
          }

          let realSellRoute: any = null;
          try {
            const tokenUnits = pos.realSwapRouteBuy?.tokensOut || undefined;
            realSellRoute = await detector.fetchRealSwapRoute(pos.mint, "sell", pos.stakeUsd, tokenUnits);
            if (realSellRoute?.ok && realSellRoute.impliedPriceUsd && realSellRoute.impliedPriceUsd > 0) {
              priceUsd = realSellRoute.impliedPriceUsd;
              if (!highPriceUsd || priceUsd > highPriceUsd) highPriceUsd = priceUsd;
              if (!lowPriceUsd || priceUsd < lowPriceUsd) lowPriceUsd = priceUsd;
            }
          } catch {}

          if (priceUsd && priceUsd > 0) {
            const res = paperLane.evaluatePriceTick(pos, {
              priceUsd,
              mcapUsd,
              highPriceUsd,
              lowPriceUsd,
              timestamp: Math.floor(Date.now() / 1000),
              realSwapRouteSell: realSellRoute?.ok ? {
                exchange: realSellRoute.routeData?.exchange,
                impliedPriceUsd: realSellRoute.impliedPriceUsd,
                amountOutUsd: realSellRoute.quote?.amountOutUsd ?? (realSellRoute.routeData?.amount_out_usd ? Number(realSellRoute.routeData.amount_out_usd) : undefined),
                latencyMs: realSellRoute.latencyMs,
                priceImpactPct: realSellRoute.quote?.priceImpactPct
              } : undefined
            });
            if (res.closed) {
              console.log(`[PAPER-EXIT] 🏁 Closed position on ${pos.symbol} (${pos.lane}) | Reason: ${res.reason} | PnL: ${pos.pnlUsd! >= 0 ? '+' : ''}$${pos.pnlUsd} (${pos.netReturnPct}%)`);
            }
          }
        } catch {}
      }
    }
    paperLane.saveState();
    await detector.close();
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal error running convergence detector:", err);
  process.exit(1);
});
