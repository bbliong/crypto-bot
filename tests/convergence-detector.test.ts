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
      priceUsd: 0.005,
      liquidityUsd: 45000,
      fdv: 500000,
      volume24h: 300000,
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
