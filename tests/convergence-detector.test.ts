import test from "node:test";
import assert from "node:assert/strict";
import {
  ConvergenceDetector,
  type TradeEvent,
  type DexTokenInfo,
  type CandleKline
} from "../src/convergence-detector.js";

test("ConvergenceDetector - Sliding Window & Ingestion", () => {
  const detector = new ConvergenceDetector({ timeWindowSec: 1800 });

  const now = Math.floor(Date.now() / 1000);
  const trade1: TradeEvent = {
    wallet: "WalletA",
    mint: "Token111111111111111111111111111111111111",
    symbol: "ALPHA",
    side: "buy",
    timestamp: now - 3600, // 1 hour ago (expired)
    solAmount: 1.5,
    txSignature: "sig1"
  };

  detector.recordTrade(trade1);
  assert.equal(detector.getActiveMintsCount(), 0, "Expired trade should be evicted");

  const trade2: TradeEvent = {
    wallet: "WalletA",
    mint: "Token111111111111111111111111111111111111",
    symbol: "ALPHA",
    side: "buy",
    timestamp: now - 300, // 5 minutes ago (active)
    solAmount: 2.0,
    txSignature: "sig2"
  };

  detector.recordTrade(trade2);
  assert.equal(detector.getActiveMintsCount(), 1, "Active trade should be retained");
});

test("ConvergenceDetector - Detects Multi-Wallet Convergence", async () => {
  const detector = new ConvergenceDetector({ timeWindowSec: 1800 });
  const now = 1729650000;

  // Mock external APIs
  detector.setDexFetcher(async (mint: string): Promise<DexTokenInfo | null> => {
    return {
      mint,
      symbol: "TEST",
      name: "Test Token",
      dexId: "pumpswap",
      priceUsd: 0.00005,
      liquidityUsd: 15000,
      fdv: 50000, // $50k market cap (< 100k)
      volume24h: 30000,
      priceChange24h: 120
    };
  });

  detector.setCandleFetcher(async (mint: string): Promise<CandleKline[]> => {
    return [
      { time: now - 600, open: 0.004, high: 0.005, low: 0.004, close: 0.0048, volume: 5000 },
      { time: now, open: 0.0048, high: 0.0052, low: 0.0047, close: 0.0051, volume: 8000 }
    ];
  });

  let convergenceEmitted = false;
  detector.on("convergence", (report) => {
    convergenceEmitted = true;
    assert.equal(report.classification, "GOLDEN_ORGANIC_CONVERGENCE");
    assert.equal(report.wallets.length, 2);
    assert.equal(report.entryDeltaSec, 600); // 10 minutes apart
    assert.equal(report.walletEntries?.length, 2);
    assert.equal(report.walletEntries?.[0].wallet, "WalletA");
    assert.equal(report.walletEntries?.[0].deltaSecFromFirst, 0);
    assert.equal(report.walletEntries?.[1].wallet, "WalletB");
    assert.equal(report.walletEntries?.[1].deltaSecFromFirst, 600);
    assert.ok(report.walletEntries?.[0].enteredAtWib.includes("WIB"));
  });

  // Wallet A buys
  await detector.recordTrade({
    wallet: "WalletA",
    mint: "TokenRunner1111111111111111111111111111111",
    symbol: "TEST",
    side: "buy",
    timestamp: now - 600,
    solAmount: 2.5,
    txSignature: "sigA"
  });

  // Wallet B buys 10 minutes later
  await detector.recordTrade({
    wallet: "WalletB",
    mint: "TokenRunner1111111111111111111111111111111",
    symbol: "TEST",
    side: "buy",
    timestamp: now,
    solAmount: 3.0,
    txSignature: "sigB"
  });

  assert.ok(convergenceEmitted, "Convergence event should be emitted");
});

test("ConvergenceDetector - Flags Syndicate Dump Pattern", async () => {
  const detector = new ConvergenceDetector({ timeWindowSec: 1800 });
  const now = 1729650000;

  // Mock external APIs for a dumped token (liquidity 0, price crashed)
  detector.setDexFetcher(async (mint: string): Promise<DexTokenInfo | null> => {
    return {
      mint,
      symbol: "DUMP",
      name: "Dump Token",
      dexId: "pumpswap",
      priceUsd: 0.000001,
      liquidityUsd: 500, // Likuiditas mati
      fdv: 1000,
      volume24h: 15000,
      priceChange24h: -98
    };
  });

  detector.setCandleFetcher(async (mint: string): Promise<CandleKline[]> => {
    return [
      { time: now - 20, open: 0.0001, high: 0.00012, low: 0.00005, close: 0.00005, volume: 10000 },
      { time: now, open: 0.00005, high: 0.00005, low: 0.000001, close: 0.000001, volume: 20000 }
    ];
  });

  let syndicateFlagged = false;
  detector.on("syndicate_detected", (report) => {
    syndicateFlagged = true;
    assert.equal(report.classification, "SYNDICATE_DUMP_RISK");
    assert.ok(report.entryDeltaSec <= 15, "Entry delta should be <= 15 seconds");
    assert.ok(report.isLiquidityDrained, "Liquidity should be marked drained");
  });

  // Wallet 1 buys
  await detector.recordTrade({
    wallet: "PuppetWallet1",
    mint: "TokenDump111111111111111111111111111111111",
    symbol: "DUMP",
    side: "buy",
    timestamp: now - 8,
    solAmount: 5.0,
    txSignature: "sigP1"
  });

  // Wallet 2 buys 8 seconds later (serempak!)
  await detector.recordTrade({
    wallet: "PuppetWallet2",
    mint: "TokenDump111111111111111111111111111111111",
    symbol: "DUMP",
    side: "buy",
    timestamp: now,
    solAmount: 5.0,
    txSignature: "sigP2"
  });

  assert.ok(syndicateFlagged, "Syndicate alert should be triggered");
  assert.ok(detector.isQuarantined("PuppetWallet1"), "Wallet 1 should be quarantined");
  assert.ok(detector.isQuarantined("PuppetWallet2"), "Wallet 2 should be quarantined");
});

test("ConvergenceDetector - Rejects tokens with MC > 100k or price > $0.50 (stocks/large caps)", async () => {
  const detector = new ConvergenceDetector({ 
    timeWindowSec: 1800,
    maxMarketCapUsd: 100_000,
    maxPriceUsd: 0.50
  });
  const now = 1729650000;

  // Mock a large cap token like TTWO (Take-Two software stock, price $208)
  detector.setDexFetcher(async (mint: string): Promise<DexTokenInfo | null> => {
    return {
      mint,
      symbol: "TTWO",
      name: "Take-Two Interactive",
      dexId: "raydium",
      priceUsd: 208.0, // High price stock
      liquidityUsd: 700000,
      fdv: 200000000,
      volume24h: 4000000,
      priceChange24h: 1.5
    };
  });

  let convergenceEmitted = false;
  detector.on("convergence", () => {
    convergenceEmitted = true;
  });

  await detector.recordTrade({
    wallet: "Wallet1",
    mint: "LargeToken111111111111111111111111111111111",
    symbol: "TTWO",
    side: "buy",
    timestamp: now - 300,
    solAmount: 2.0,
    txSignature: "sig1"
  });

  await detector.recordTrade({
    wallet: "Wallet2",
    mint: "LargeToken111111111111111111111111111111111",
    symbol: "TTWO",
    side: "buy",
    timestamp: now,
    solAmount: 2.0,
    txSignature: "sig2"
  });

  assert.equal(convergenceEmitted, false, "Large cap / stock token must NOT trigger convergence");
});

test("ConvergenceDetector - Tier SSS/SS/S/A/B triggers Golden Convergence while Tier D+D is demoted to Accumulation Watch", async () => {
const detector = new ConvergenceDetector({
  timeWindowSec: 1800,
  monitoredWallets: ["ApexSSS", "MasterSS", "WhaleS", "RetailD1", "RetailD2", "ScalperB1", "ScalperB2"]
});
detector.setWalletTier("ApexSSS", "SSS");
detector.setWalletTier("MasterSS", "SS");
detector.setWalletTier("WhaleS", "S");
detector.setWalletTier("RetailD1", "D");
detector.setWalletTier("RetailD2", "D");
detector.setWalletTier("ScalperB1", "B");
detector.setWalletTier("ScalperB2", "B");

  const now = 1729650000;

  detector.setDexFetcher(async (mint: string): Promise<DexTokenInfo | null> => {
    return {
      mint,
      symbol: "PUMP",
      name: "Pump Token",
      dexId: "pumpswap",
      priceUsd: 0.0001,
      liquidityUsd: 10000,
      fdv: 40000,
      volume24h: 20000,
      priceChange24h: 50
    };
  });
  detector.setCandleFetcher(async () => []);

  // 1. Two Tier D punters meet (Birthday paradox) -> should NOT be GOLDEN_ORGANIC_CONVERGENCE
  await detector.recordTrade({
    wallet: "RetailD1",
    mint: "TokenNoise11111111111111111111111111111111",
    symbol: "NOISE",
    side: "buy",
    timestamp: now - 300,
    solAmount: 0.1
  });

  const repNoise = await detector.recordTrade({
    wallet: "RetailD2",
    mint: "TokenNoise11111111111111111111111111111111",
    symbol: "NOISE",
    side: "buy",
    timestamp: now,
    solAmount: 0.1
  });

  assert.ok(repNoise);
  assert.equal(repNoise.classification, "ACCUMULATION_WATCH", "D+D punters should be demoted to ACCUMULATION_WATCH");
  assert.ok(repNoise.reason.includes("retail/scout"));

  // 2. Whale Tier S + Retail D2 -> SHOULD trigger GOLDEN_ORGANIC_CONVERGENCE
  await detector.recordTrade({
    wallet: "WhaleS",
    mint: "TokenGolden1111111111111111111111111111111",
    symbol: "GOLD",
    side: "buy",
    timestamp: now - 300,
    solAmount: 5.0
  });

  const repGold = await detector.recordTrade({
    wallet: "RetailD2",
    mint: "TokenGolden1111111111111111111111111111111",
    symbol: "GOLD",
    side: "buy",
    timestamp: now,
    solAmount: 0.5
  });

  assert.ok(repGold);
  assert.equal(repGold.classification, "GOLDEN_ORGANIC_CONVERGENCE", "Whale Tier S + Retail D must trigger Golden Convergence");
  assert.equal(repGold.walletEntries?.[0].tier, "S");
  assert.equal(repGold.walletEntries?.[1].tier, "D");

  // 3. Scalper B1 + Scalper B2 -> SHOULD trigger GOLDEN_ORGANIC_CONVERGENCE
  await detector.recordTrade({
    wallet: "ScalperB1",
    mint: "TokenScalp11111111111111111111111111111111",
    symbol: "SCALP",
    side: "buy",
    timestamp: now - 300,
    solAmount: 1.0
  });

  const repScalp = await detector.recordTrade({
    wallet: "ScalperB2",
    mint: "TokenScalp11111111111111111111111111111111",
    symbol: "SCALP",
    side: "buy",
    timestamp: now,
    solAmount: 1.0
  });

  assert.ok(repScalp);
  assert.equal(repScalp.classification, "GOLDEN_ORGANIC_CONVERGENCE", "Two Tier B scalpers must trigger Golden Convergence");

  // 4. Apex SSS + Master SS -> SHOULD trigger GOLDEN_ORGANIC_CONVERGENCE
  await detector.recordTrade({
    wallet: "ApexSSS",
    mint: "TokenApex111111111111111111111111111111111",
    symbol: "APEX",
    side: "buy",
    timestamp: now - 120,
    solAmount: 15.0
  });

  const repApex = await detector.recordTrade({
    wallet: "MasterSS",
    mint: "TokenApex111111111111111111111111111111111",
    symbol: "APEX",
    side: "buy",
    timestamp: now,
    solAmount: 5.0
  });

  assert.ok(repApex);
  assert.equal(repApex.classification, "GOLDEN_ORGANIC_CONVERGENCE", "Tier SSS + SS must trigger Golden Convergence");
  assert.equal(repApex.walletEntries?.[0].tier, "SSS");
  assert.equal(repApex.walletEntries?.[1].tier, "SS");
});
