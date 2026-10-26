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

  // 1. Initialize Snowball Collector and Load Clean Wallets with Tiers
  const snowball = new SnowballCollector();
  const allWallets = snowball.getAllWallets();
  const walletTiers = new Map<string, any>();
  for (const w of allWallets) {
    walletTiers.set(w.address, w.tier);
  }
  let cleanWallets: string[] = snowball.getAllAddresses();
  console.log(`[INIT] Loaded ${cleanWallets.length} clean organic wallets from Snowball Collector (Tiers S-E).`);

  // 2. Initialize Detector with strict Lowcap boundary (< $100k MC, price < $0.50) and Wallet Tiers
  const detector = new ConvergenceDetector({
    timeWindowSec: 7200, // 2 hours sliding window for organic multi-wallet accumulation
    cdpUrl: "http://127.0.0.1:9223",
    monitoredWallets: cleanWallets,
    walletTiers,
    outputFile: "data/convergence-monitor-events.json",
    maxMarketCapUsd: 100_000, // Hard limit: < $100k Lowcaps only
    maxPriceUsd: 0.50 // Hard limit: filter out tokenized stocks ($200+) and large caps
  });

  // Connect to Chrome CDP on port 9223
  const { chromium } = await import("playwright");
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const page = browser.contexts()[0].pages().find(p => p.url().includes("gmgn.ai")) || browser.contexts()[0].pages()[0];
  if (!page.url().includes("gmgn.ai/?chain=sol") && page.url() !== "https://gmgn.ai/") {
    console.log(`[CDP] 🌐 Navigating tab to GMGN Trenches: https://gmgn.ai/?chain=sol`);
    await page.goto("https://gmgn.ai/?chain=sol", { waitUntil: "commit" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`[CDP] Attached to active GMGN Trenches tab: ${page.url()}`);

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

  const BOOT_TIME_SEC = Math.floor(Date.now() / 1000);

  async function handlePaperBuy(report: any): Promise<boolean> {
    if (!report.walletEntries || report.walletEntries.length < 2) return false;
    const w1 = report.walletEntries[0];

    // Strict Anti-Syndicate & Quality Gates:
    // 0. Quality Tier Consensus Gate: Wajib melibatkan Smart Money nyata (min 1x Tier ULTRA/SSS/SS/S/A atau 2x Tier B)
    const tiers = (report.walletEntries || []).map((w: any) => w.tier || "D");
    const hasTierWhale = tiers.some((t: string) => ["ULTRA", "SSS", "SS", "S"].includes(t));
    const hasTierA = tiers.includes("A");
    const tierBCount = tiers.filter((t: string) => t === "B").length;
    const isQualityConvergence = hasTierWhale || hasTierA || (tierBCount >= 2);

    if (!isQualityConvergence) {
      console.log(`[GATE-REJECT] 🎯 Sinyal ${report.symbol} ditolak: Kombinasi Tier [${tiers.join("+")}] belum memenuhi standar (min 1x Tier ULTRA/SSS/SS/S/A atau 2x Tier B)`);
      return false;
    }

    // 1. Anti-Cabal Supply Gate: Dev/Insider tidak boleh mendominasi suplai di detik 0 (Cegah kasus PUMPGOBLIN 41 SOL)
    const zeroSecEntries = (report.walletEntries || []).filter((w: any) => (w.deltaSecFromFirst || 0) === 0);
    const zeroSecSolTotal = zeroSecEntries.reduce((sum: number, w: any) => sum + (w.solAmount || 0), 0);
    const w1Sol = w1.solAmount || 0;

    if (w1Sol > 15.0 || zeroSecSolTotal > 20.0) {
      console.log(`[GATE-REJECT] 🚨 Cabal supply risk pada ${report.symbol}: Pioneer detik 0 memborong ${w1Sol.toFixed(1)} SOL (total detik 0: ${zeroSecSolTotal.toFixed(1)} SOL > 20 SOL batas aman). Dominasi suplai siap dump!`);
      return false;
    }

    // 2. Zero-Exit Gate: TIDAK BOLEH ada satupun smart wallet yang sudah mulai exit/TP sebelum bot masuk
    const exitedWallet = (report.walletEntries || []).find((w: any) => w.isHolding === false);
    if (exitedWallet) {
      console.log(`[GATE-REJECT] 🚨 Sinyal ${report.symbol} ditolak: Smart Wallet (${exitedWallet.wallet?.slice(0, 6)}... [Tier ${exitedWallet.tier || "D"}]) sudah EXIT/TP (cuan +$${exitedWallet.profitUsd || 0}). Fase dump sudah dimulai!`);
      return false;
    }

    // 3. Breadth & Heavyweight Confirmation Gate:
    // Sinyal lolos jika ada Paus Jumbo Tier ULTRA/SSS/SS/S/A (modal >= $1,500 / >= 7 SOL) ATAU didukung minimal 3 smart wallet unik (breadth >= 3)
    const smartEntries = (report.walletEntries || []);
    const heavyWhale = smartEntries.find((w: any) => {
      const isQuality = ["ULTRA", "SSS", "SS", "S", "A"].includes(w.tier);
      const cost = w.totalCostUsd || (w.solAmount ? w.solAmount * 180 : 0);
      return isQuality && (cost >= 1500 || (w.solAmount || 0) >= 7.0);
    });

    const isHeavyWhale = !!heavyWhale;
    const hasSufficientBreadth = smartEntries.length >= 3;

    if (!isHeavyWhale && !hasSufficientBreadth) {
      console.log(`[GATE-REJECT] ⚠️ Sinyal ${report.symbol} ditolak: Hanya didukung ${smartEntries.length} wallet tanpa Paus Jumbo Tier ULTRA/SSS/SS/S/A (butuh min 3 wallet unik atau Tier ULTRA/SSS/SS/S/A modal >= $1,500)`);
      return false;
    }

    // 4. Whale Capital Ratio Gate:
    // Jika W1 adalah scout (Tier C/D/E), konfirmasi Tier ULTRA/SSS/SS/S/A wajib membawa komitmen dana nyata (>= 1.5 SOL atau >= $300)
    const isW1Scout = w1.tier && !["ULTRA", "SSS", "SS", "S", "A"].includes(w1.tier);
    if (isW1Scout) {
      const qualityConfirmers = smartEntries.slice(1).filter((w: any) => ["ULTRA", "SSS", "SS", "S", "A"].includes(w.tier));
      const hasSignificantCapital = qualityConfirmers.some((w: any) => {
        const cost = w.totalCostUsd || (w.solAmount ? w.solAmount * 180 : 0);
        return cost >= 300 || (w.solAmount || 0) >= 1.5;
      });
      if (qualityConfirmers.length > 0 && !hasSignificantCapital && !isHeavyWhale) {
        console.log(`[GATE-REJECT] ⚠️ Sinyal ${report.symbol} ditolak: Tier ULTRA/SSS/SS/S/A pengkonfirmasi hanya membawa modal kecil (< $300 / < 1.5 SOL), berisiko jadi exit liquidity bagi pioneer`);
        return false;
      }
    }

    // Aturan delta 45 detik dihilangkan untuk Tier S/A/B: w2 diambil langsung dari urutan transaksi riil
    const organicWallet = isQualityConvergence ? report.walletEntries[1] : (report.walletEntries.find((w: any) => (w.deltaSecFromFirst || 0) >= 45) || report.walletEntries[1]);
    const w2 = organicWallet;
    const delta = w2.deltaSecFromFirst || report.entryDeltaSec || 0;

    let entryPrice = report.dexInfo?.priceUsd || (report.dexInfo?.marketCapUsd ? report.dexInfo.marketCapUsd / 1e9 : 0.00001);
    const entryMcap = report.dexInfo?.marketCapUsd || 15000;

    // 1. Delta WAJIB >= 45 detik (DIHILANGKAN untuk Tier S/A/B sesuai arahan user)
    // 2. Likuiditas >= $2,000 dan tidak drained
    const cuanWallets = (report.walletEntries || []).filter((w: any) => (w.profitUsd || 0) > 0);
    const isStrictGolden = (
      report.classification === "GOLDEN_ORGANIC_CONVERGENCE" ||
      cuanWallets.length >= 2 ||
      isQualityConvergence
    ) && (isQualityConvergence || delta >= 45) && !report.isLiquidityDrained && (report.dexInfo?.liquidityUsd || 0) >= 2000;

    if (!isStrictGolden) {
      return false;
    }

    // 5. Max Co-Entry Spacing Gate: Akumulasi multi-wallet harus terjadi dalam kurun waktu masuk akal (maksimal 30 menit / 1800s)
    const maxAllowedDeltaSec = 1800; // 30 menit
    if (delta > maxAllowedDeltaSec) {
      console.log(`[GATE-REJECT] ⏳ Sinyal ${report.symbol} ditolak: Jeda masuk W1 ke W2 terlalu renggang (${delta}s / ${Math.round(delta / 60)}m > 30m). Bukan akumulasi bersama!`);
      return false;
    }

    // 6. Hard Freshness Gate: Sinyal W2 harus segar (maksimal 15 menit / 900s untuk Tier Mutu, 180s untuk scout)
    const nowSec = Math.floor(Date.now() / 1000);
    const signalAgeSec = nowSec - (w2.timestamp || 0);
    const maxAllowedAgeSec = isQualityConvergence ? 900 : 180;

    if (signalAgeSec > maxAllowedAgeSec) {
      console.log(`[GATE-REJECT] ⏱️ Sinyal ${report.symbol} ditolak: Usia sinyal W2 ${signalAgeSec}s (> ${maxAllowedAgeSec}s batas toleransi ${isQualityConvergence ? "15m Tier Mutu" : "3m Scout"}). Sinyal sudah basi!`);
      return false;
    }

    // 7. Mandatory Pre-Buy Retrace Gate: Koin yang sedang drop tajam (> 20% dari puncak) wajib ditolak di SEMUA Tier!
    if (report.maxDropPercent && report.maxDropPercent > 20) {
      console.log(`[GATE-REJECT] 📉 Sinyal ${report.symbol} ditolak: Token mengalami koreksi drop -${report.maxDropPercent.toFixed(1)}% (> 20% batas aman). Berisiko tangkap pisau jatuh!`);
      return false;
    }

    // 8. Whale Unrealized Profit Ceiling: Tolak jika smart wallet sudah cuan ratusan persen saat bot mendeteksi
    const walletList = report.walletEntries || [];
    const maxWalletPnl = Math.max(...walletList.map((w: any) => w.pnlPercent || 0));
    const avgWalletPnl = walletList.reduce((s: number, w: any) => s + (w.pnlPercent || 0), 0) / (walletList.length || 1);

    if (maxWalletPnl >= 120 || avgWalletPnl >= 75) {
      console.log(`[GATE-REJECT] 🏔️ Sinyal ${report.symbol} ditolak: Smart wallet sudah cuan besar sebelum bot masuk (Peak: +${maxWalletPnl.toFixed(1)}%, Rata-rata: +${avgWalletPnl.toFixed(1)}%). Risiko bot jadi exit liquidity di pucuk!`);
      return false;
    }

    console.log(`[GATE-PASS] 🚀 Sinyal ${report.symbol} LOLOS SEMUA GATE (Age: ${signalAgeSec}s | Delta: ${delta}s | Drop: -${report.maxDropPercent || 0}% | Smart PnL: Peak +${maxWalletPnl.toFixed(1)}%, Avg +${avgWalletPnl.toFixed(1)}%)`);

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
    const executionNowSec = Math.floor(Date.now() / 1000);

    // 1. Lane A: Golden Scalp Bot (+35% TP / -12% SL / Trailing 7% dari +20% / Max 30m)
    const posScalp = paperLane.openPosition({
      lane: "LANE_GOLDEN_SCALP",
      mint: report.mint,
      symbol: report.symbol,
      entryPriceUsd: entryPrice,
      entryMcapUsd: entryMcap,
      entryTimestamp: executionNowSec,
      wallet1: { address: w1.wallet, tier: w1.tier, enteredAtWib: w1.enteredAtWib },
      wallet2: { address: w2.wallet, tier: w2.tier, enteredAtWib: w2.enteredAtWib, deltaSecFromFirst: w2.deltaSecFromFirst },
      walletEntries: report.walletEntries || [],
      realSwapRouteBuy: realBuyRoute?.ok ? {
        exchange: realBuyRoute.routeData?.exchange,
        impliedPriceUsd: realBuyRoute.impliedPriceUsd,
        tokensOut: realBuyRoute.quote?.outAmount,
        latencyMs: realBuyRoute.latencyMs,
        priceImpactPct: realBuyRoute.quote?.priceImpactPct
      } : undefined
    });
    if (posScalp) {
      console.log(`[PAPER-BUY] ⚡ Opened Scalp Bot position on ${report.symbol} at Wallet #2 entry (${w2.enteredAtWib}) [Tier: ${w1.tier || 'D'}+${w2.tier || 'D'}] | Stake: $${stakeAmount} | MC: $${Math.round(entryMcap).toLocaleString()}`);
    }

    // 2. Lane B: Golden Moonbag Runner (+50% TP1, +120% TP2 / -15% SL / Trailing 10% / Max 60m)
    const posMoon = paperLane.openPosition({
      lane: "LANE_GOLDEN_MOONBAG",
      mint: report.mint,
      symbol: report.symbol,
      entryPriceUsd: entryPrice,
      entryMcapUsd: entryMcap,
      entryTimestamp: executionNowSec,
      wallet1: { address: w1.wallet, tier: w1.tier, enteredAtWib: w1.enteredAtWib },
      wallet2: { address: w2.wallet, tier: w2.tier, enteredAtWib: w2.enteredAtWib, deltaSecFromFirst: w2.deltaSecFromFirst },
      walletEntries: report.walletEntries || [],
      realSwapRouteBuy: realBuyRoute?.ok ? {
        exchange: realBuyRoute.routeData?.exchange,
        impliedPriceUsd: realBuyRoute.impliedPriceUsd,
        tokensOut: realBuyRoute.quote?.outAmount,
        latencyMs: realBuyRoute.latencyMs,
        priceImpactPct: realBuyRoute.quote?.priceImpactPct
      } : undefined
    });
    if (posMoon) {
      console.log(`[PAPER-BUY] 🚀 Opened Moonbag Runner position on ${report.symbol} at Wallet #2 entry (${w2.enteredAtWib}) [Tier: ${w1.tier || 'D'}+${w2.tier || 'D'}] | Stake: $${stakeAmount} | MC: $${Math.round(entryMcap).toLocaleString()}`);
    }

    // 3. Lane C: Golden Quick Micro-Scalp (+15% TP / -8% SL / Trailing 3% dari +10% / Max 15m)
    const posMicro = paperLane.openPosition({
      lane: "LANE_GOLDEN_MICRO_SCALP",
      mint: report.mint,
      symbol: report.symbol,
      entryPriceUsd: entryPrice,
      entryMcapUsd: entryMcap,
      entryTimestamp: executionNowSec,
      wallet1: { address: w1.wallet, tier: w1.tier, enteredAtWib: w1.enteredAtWib },
      wallet2: { address: w2.wallet, tier: w2.tier, enteredAtWib: w2.enteredAtWib, deltaSecFromFirst: w2.deltaSecFromFirst },
      walletEntries: report.walletEntries || [],
      realSwapRouteBuy: realBuyRoute?.ok ? {
        exchange: realBuyRoute.routeData?.exchange,
        impliedPriceUsd: realBuyRoute.impliedPriceUsd,
        tokensOut: realBuyRoute.quote?.outAmount,
        latencyMs: realBuyRoute.latencyMs,
        priceImpactPct: realBuyRoute.quote?.priceImpactPct
      } : undefined
    });
    if (posMicro) {
      console.log(`[PAPER-BUY] 🎯 Opened Quick Micro-Scalp position on ${report.symbol} at Wallet #2 entry (${w2.enteredAtWib}) [Tier: ${w1.tier || 'D'}+${w2.tier || 'D'}] | Stake: $${stakeAmount} | MC: $${Math.round(entryMcap).toLocaleString()}`);
    }

    if (posScalp || posMoon || posMicro) {
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
        const tierBadge = `[Tier ${we.tier || 'D'}]`;
        console.log(`     ${idx + 1}. ${tierBadge} ${we.wallet.slice(0, 8)}...${we.wallet.slice(-6)} | Masuk: ${we.enteredAtWib} | ${exitStr}${profitStr} | Selisih: ${deltaStr}`);
      }
    }
    console.log(`   Entry Delta: ~${Math.round(report.entryDeltaSec / 60)} menit`);
    console.log(`   DEX: ${report.dexInfo?.dexId || 'N/A'} | Price: $${report.dexInfo?.priceUsd || '0'} | Liquidity: $${report.dexInfo?.liquidityUsd?.toLocaleString() || '0'}`);
    console.log("=".repeat(75) + "\n");
  });

  detector.on("syndicate_detected", (report) => {
    console.log(`🚨 [SYNDICATE DUMP DETECTED] Token: ${report.symbol} (${report.mint.slice(0, 8)}...) | Delta: ${report.entryDeltaSec}s -> QUARANTINED`);
  });

  // Dynamic Whale-Backed Stop Loss Helper
  const whaleHoldingCache = new Map<string, { holding: boolean; exited: boolean; checkedAt: number }>();

  async function checkPositionWhaleStatus(pos: any): Promise<{ whaleStillHolding: boolean; whaleExited: boolean }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const cached = whaleHoldingCache.get(pos.mint);
    if (cached && nowSec - cached.checkedAt < 30) {
      return { whaleStillHolding: cached.holding, whaleExited: cached.exited };
    }

    const highTierWallets: string[] = (pos.walletEntries || [])
      .filter((w: any) => ["S", "A", "B"].includes(w.tier))
      .map((w: any) => w.wallet);

    if (pos.wallet1?.address && !highTierWallets.includes(pos.wallet1.address)) {
      highTierWallets.push(pos.wallet1.address);
    }
    if (pos.wallet2?.address && !highTierWallets.includes(pos.wallet2.address)) {
      highTierWallets.push(pos.wallet2.address);
    }

    if (highTierWallets.length === 0) {
      return { whaleStillHolding: false, whaleExited: false };
    }

    try {
      let anyStillHolding = false;
      let anyExited = false;
      const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

      for (const w of highTierWallets.slice(0, 3)) {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenAccountsByOwner",
            params: [w, { mint: pos.mint }, { encoding: "jsonParsed", commitment: "confirmed" }]
          }),
          signal: AbortSignal.timeout(3000)
        });
        const data: any = await res.json();
        const accounts = data?.result?.value || [];
        let ui = 0;
        for (const a of accounts) {
          ui += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
        }
        if (ui > 0) {
          anyStillHolding = true;
        } else {
          anyExited = true;
        }
      }

      const holding = anyStillHolding;
      const exited = !anyStillHolding && anyExited;
      whaleHoldingCache.set(pos.mint, { holding, exited, checkedAt: nowSec });
      return { whaleStillHolding: holding, whaleExited: exited };
    } catch {
      return { whaleStillHolding: true, whaleExited: false };
    }
  }

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
      pos.peakGainPct = Number(((pos.peakPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100).toFixed(2));

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
        } else if (!pos.tp1Hit && curLoss <= -0.05) {
          // Dynamic Whale-Backed Stop Loss Check:
          const { whaleStillHolding, whaleExited } = await checkPositionWhaleStatus(pos);
          (pos as any)._whaleStillHolding = whaleStillHolding;
          (pos as any)._whaleExited = whaleExited;

          if (curLoss <= -0.40) {
            triggered = true;
            reason = "CATASTROPHE_STOP_40";
          } else if (whaleExited) {
            triggered = true;
            reason = "WHALE_EXIT_TRIGGER";
          } else if (curLoss <= -0.15 && !whaleStillHolding) {
            triggered = true;
            reason = "STOP_LOSS_15";
          } else if (whaleStillHolding) {
            const nowTime = Math.floor(Date.now() / 1000);
            if (!pos._lastWhaleLog || nowTime - pos._lastWhaleLog > 60) {
              console.log(`[WHALE-BACKED-HOLD] 🐋 ${pos.symbol} [Moonbag] floating loss ${(curLoss * 100).toFixed(1)}%, tapi Smart Wallet masih HOLD! Tahan posisi.`);
              pos._lastWhaleLog = nowTime;
            }
          }
        }
      } else if (pos.lane === "LANE_GOLDEN_MICRO_SCALP") {
        if (curGain >= 0.15) {
          triggered = true;
          reason = "TAKE_PROFIT_15";
        } else if (pos.peakPriceUsd >= pos.entryPriceUsd * 1.10 && (pos.peakPriceUsd - priceUsd) / pos.peakPriceUsd >= 0.03) {
          triggered = true;
          reason = "TRAILING_STOP_FROM_10";
        } else if (curLoss <= -0.08) {
          triggered = true;
          reason = "STOP_LOSS_8";
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
          whaleStillHolding: (pos as any)._whaleStillHolding,
          whaleExited: (pos as any)._whaleExited,
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
    paperLane.saveState();
  }

  // Trenches Live WebSocket Queue & Ingestion Engine
  const trenchesEvaluatedCooldown = new Map<string, number>();
  const trenchesProcessingQueue: Array<{
    mint: string;
    symbol: string;
    marketCap: number;
    progress: number;
    exchange: string;
    liquidity: number;
    category: string;
  }> = [];
  let isProcessingTrenchesQueue = false;
  let trenchesBackoffUntil = 0;

  async function processTrenchesQueue() {
    if (isProcessingTrenchesQueue) return;
    isProcessingTrenchesQueue = true;

    while (trenchesProcessingQueue.length > 0) {
      if (Date.now() < trenchesBackoffUntil) {
        const waitMs = trenchesBackoffUntil - Date.now();
        await new Promise((r) => setTimeout(r, waitMs));
      }

      const item = trenchesProcessingQueue.shift();
      if (!item) continue;

      try {
        await new Promise((r) => setTimeout(r, 1200)); // Pacing 1,200ms (safe threshold for GMGN API)
        const tradersData = await page.evaluate(async (mint: string) => {
          try {
            const res = await fetch(`/vas/api/v1/token_traders/sol/${mint}?limit=50&orderby=profit&direction=desc`, {
              credentials: "include"
            });
            if (res.status === 429) {
              return { rateLimited: true, status: 429 };
            }
            return await res.json().catch(() => null);
          } catch {
            return null;
          }
        }, item.mint);

        if (tradersData?.rateLimited) {
          console.warn(`[TRENCHES-RATE-LIMIT] ⚠️ HTTP 429 on /vas/api/v1/token_traders. Backing off 20s...`);
          trenchesBackoffUntil = Date.now() + 20000;
          continue;
        }

        const list = tradersData?.data?.list || [];
        let smartWalletsFound = 0;
        const allTrades: TradeEvent[] = [];

        for (const tr of list) {
          const { isNew, wallet } = snowball.ingestTrader(tr, item.symbol, item.mint);
          if (wallet) {
            detector.addMonitoredWallet(wallet.address, wallet.tier);
            if (["ULTRA", "SSS", "SS", "S", "A", "B"].includes(wallet.tier)) {
              smartWalletsFound++;
            }
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
              tier: wallet.tier,
              mint: item.mint,
              symbol: item.symbol,
              side: "buy",
              timestamp: tradeTime,
              solAmount: Number(((tr.cost_cur || 100) / 180).toFixed(3)),
              tokenAmount: tr.buy_amount_cur || 0,
              txSignature: `gmgn_${wallet.address.slice(0, 6)}_${item.mint.slice(0, 6)}`,
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

        if (smartWalletsFound > 0) {
          console.log(`[TRENCHES-SMART] 🎯 ${item.symbol} (${item.mint.slice(0, 8)}...): ${smartWalletsFound} Smart Wallet (S/A/B) terdeteksi! [${item.category.toUpperCase()}] MC: $${Math.round(item.marketCap).toLocaleString()}`);
          allTrades.sort((a, b) => a.timestamp - b.timestamp);
          const currentWallSec = Math.floor(Date.now() / 1000);
          // Hanya rekam transaksi 2 jam terakhir ke detektor konvergensi agar tidak mencampuradukkan holder purba
          const recentTrades = allTrades.filter(t => (currentWallSec - t.timestamp) <= 7200);
          for (const t of recentTrades) {
            await detector.recordTrade(t);
          }
          snowball.saveSnowball();
        }
      } catch (err: any) {
        // quiet error
      }
    }
    isProcessingTrenchesQueue = false;
  }

  // Setup CDP WebSocket listener
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");

  cdp.on("Network.webSocketFrameReceived", async (p) => {
    try {
      const payload = p.response.payloadData;
      if (!payload || !payload.startsWith("{")) return;
      const j = JSON.parse(payload);

      // 1. Tick-by-tick evaluation for subscribed open positions
      if ((j.channel === "token_activity" || j.channel === "token_stat") && Array.isArray(j.data)) {
        for (const item of j.data) {
          const mint = item.a;
          if (!mint || !subscribedMints.has(mint)) continue;
          const price = Number(item.pu || item.p);
          if (!price || isNaN(price) || price <= 0) continue;
          await handleWebSocketTick(mint, price, item);
        }
      }

      // 2. Live Trenches Stream: New Creation, Almost Bonded, Migrated
      if (j.channel === "public_broadcast" && Array.isArray(j.data)) {
        for (const d of j.data) {
          if (d.et === "signal" && d.ed?.d?.a) {
            const sig = d.ed;
            const mint = sig.d.a;
            const symbol = sig.d.s || "UNKNOWN";
            const mc = Number(sig.d.mc || 0);
            const progress = Number(sig.d.pg || 0);
            const exchange = sig.d.ex || "pump";
            const liquidity = Number(sig.d.lq || 0);

            // Pre-Filter Anti-Spam: Hindari membuang kuota rate limit pada ribuan koin baru lahir (0s, $2 liq, 0 buyers).
            // Hanya koin dengan traksi awal nyata yang dikirim ke trader inspection:
            // 1. Almost Bonded (progress 20% - 99%)
            // 2. Migrated (progress 100% atau Raydium / Meteora)
            // 3. New Creation bertraksi nyata: progress >= 15% ATAU (MC >= $6,000 & Liq >= $1,000)
            const hasTraction = (progress >= 0.15) || (mc >= 6000 && liquidity >= 1000);
            const isTargetLowcap = mc <= 100000;
            if (!hasTraction || !isTargetLowcap) continue;

            const nowSec = Math.floor(Date.now() / 1000);
            const lastEval = trenchesEvaluatedCooldown.get(mint) || 0;
            if (nowSec - lastEval < 45) continue; // Cooldown 45 detik per mint
            trenchesEvaluatedCooldown.set(mint, nowSec);

            let category = "new_creation";
            if (progress >= 0.20 && progress < 1.00) {
              category = "almost_bonded";
            } else if (progress >= 1.00 || exchange !== "pump") {
              category = "migrated";
            }

            console.log(`[TRENCHES-WS] 🌊 [${category.toUpperCase()}] ${symbol} (${mint.slice(0, 8)}...) | MC: $${Math.round(mc).toLocaleString()} | Progress: ${(progress * 100).toFixed(0)}% | Liq: $${Math.round(liquidity).toLocaleString()} | Ex: ${exchange}`);

            if (trenchesProcessingQueue.length >= 25) {
              trenchesProcessingQueue.shift(); // Drop oldest to keep queue ultra-fresh
            }

            trenchesProcessingQueue.push({
              mint,
              symbol,
              marketCap: mc,
              progress,
              exchange,
              liquidity,
              category
            });

            processTrenchesQueue().catch(() => {});
          }
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
          const intervals = ["1m", "5m", "1h"];
          const ranks = await Promise.all(intervals.map(async (iv) => {
            const res = await fetch(`/defi/quotation/v1/rank/sol/swaps/${iv}?limit=15&min_marketcap=5000&max_marketcap=100000`);
            const json = await res.json().catch(() => null);
            return json?.data?.rank || [];
          }));

          const seen = new Set<string>();
          const combined: any[] = [];
          for (const list of ranks) {
            for (const item of (list || [])) {
              if (item && item.address && !seen.has(item.address)) {
                seen.add(item.address);
                combined.push(item);
              }
            }
          }

          return { tokens: combined, err: null };
        } catch (err: any) {
          return { tokens: [], err: err?.message || String(err) };
        }
      });

      console.log(`[LOWCAP-DISCOVERY] Inspecting ${(lowcapTokens as any)?.tokens?.length} tokens (1m, 5m, 1h ranks) in $5k-$100k MC range...`);

      for (const t of ((lowcapTokens as any)?.tokens || []).slice(0, 10)) {
        if (!t || !t.address) continue;
        const nowSec = Math.floor(Date.now() / 1000);
        const lastEval = trenchesEvaluatedCooldown.get(t.address) || 0;
        if (nowSec - lastEval < 60) continue;
        trenchesEvaluatedCooldown.set(t.address, nowSec);

        if (trenchesProcessingQueue.length >= 25) {
          trenchesProcessingQueue.shift();
        }

        trenchesProcessingQueue.push({
          mint: t.address,
          symbol: t.symbol || "UNKNOWN",
          marketCap: Number(t.market_cap || 0),
          progress: 0.5,
          exchange: "swap_rank",
          liquidity: Number(t.liquidity || 0),
          category: "swap_rank"
        });
      }

      processTrenchesQueue().catch(() => {});
      return trenchesProcessingQueue.length;
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

        // Active Periodic Price & TP/SL Audit for Open Positions (Raydium / AMM / Dexscreener)
        const openPosForAudit = paperLane.getOpenPositions().filter(p => !(p as any)._closing);
        const uniqueOpenMints = [...new Set(openPosForAudit.map(p => p.mint))];
        for (const m of uniqueOpenMints) {
          try {
            const dexInfo = await detector.fetchDexInfo(m);
            if (dexInfo?.priceUsd && dexInfo.priceUsd > 0) {
              await handleWebSocketTick(m, dexInfo.priceUsd, { priceUsd: dexInfo.priceUsd, source: "PERIODIC_DEX_AUDIT" });
            }
          } catch (err: any) {
            console.warn(`[AUDIT-WARN] Periodic price audit failed for ${m}: ${err.message}`);
          }
        }

        // Timeout Fallback Check for open positions
        const openPos = paperLane.getOpenPositions();
        const nowSec = Math.floor(Date.now() / 1000);
        for (const pos of openPos) {
          const durSec = nowSec - pos.entryTimestamp;
          let maxSec = pos.lane === "LANE_GOLDEN_SCALP" ? 1800 : (pos.lane === "LANE_GOLDEN_MICRO_SCALP" ? 900 : 3600);
          if (pos.lane === "LANE_GOLDEN_MOONBAG" && (pos as any)._whaleStillHolding) {
            maxSec = 7200; // Allow Moonbag runner up to 2 hours while whale is holding
          }
          if (durSec >= maxSec && !(pos as any)._closing) {
            console.log(`[TIMEOUT-FALLBACK] ⏳ Position on ${pos.symbol} (${pos.lane}) reached timeout (${Math.round(durSec/60)}m). Closing with real swap quote...`);
            (pos as any)._closing = true;
            let realSellRoute: any = null;
            try {
              realSellRoute = await detector.fetchRealSwapRoute(pos.mint, "sell", pos.stakeUsd, pos.realSwapRouteBuy?.tokensOut);
            } catch {}

            const res = paperLane.evaluatePriceTick(pos, {
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
            if (res.closed) {
              paperLane.saveState();
              const rem = paperLane.getOpenPositions().filter(p => p.mint === pos.mint);
              if (rem.length === 0) await unsubscribeTokenWs(pos.mint);
            } else {
              (pos as any)._closing = false;
            }
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
