import test from "node:test";
import assert from "node:assert/strict";
import { GoldenConvergencePaperLane } from "../src/golden-convergence-paper-lane.js";
import { unlinkSync, existsSync } from "node:fs";

const TEST_STORE_PATH = "data/.test-paper-positions.json";

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) {
    try { unlinkSync(TEST_STORE_PATH); } catch {}
  }
}

test("GoldenConvergencePaperLane - open position when wallet 2 enters", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH, stakePerTradeUsd: 100 });

  const pos = lane.openPosition({
    lane: "LANE_GOLDEN_SCALP",
    mint: "MintTest1111111111111111111111111111111111",
    symbol: "TEST1",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1792800000,
    wallet1: { address: "Wallet11111111", enteredAtWib: "10.00.00 WIB" },
    wallet2: { address: "Wallet22222222", enteredAtWib: "10.05.00 WIB", deltaSecFromFirst: 300 }
  });

  assert.ok(pos);
  assert.equal(pos.symbol, "TEST1");
  assert.equal(pos.status, "OPEN");
  assert.equal(pos.stakeUsd, 100);
  assert.equal(pos.wallet2.deltaSecFromFirst, 300);

  // Deduplication check: should return null for same mint & lane
  const duplicate = lane.openPosition({
    lane: "LANE_GOLDEN_SCALP",
    mint: "MintTest1111111111111111111111111111111111",
    symbol: "TEST1",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    wallet1: { address: "Wallet11111111", enteredAtWib: "10.00.00 WIB" },
    wallet2: { address: "Wallet22222222", enteredAtWib: "10.05.00 WIB", deltaSecFromFirst: 300 }
  });
  assert.equal(duplicate, null);
  cleanup();
});

test("GoldenConvergencePaperLane - Scalp Bot Take Profit (+35%) triggers accurately", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH, stakePerTradeUsd: 100 });

  const pos = lane.openPosition({
    lane: "LANE_GOLDEN_SCALP",
    mint: "MintTP1111111111111111111111111111111111111",
    symbol: "TP_COIN",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1000,
    wallet1: { address: "W1", enteredAtWib: "10.00 WIB" },
    wallet2: { address: "W2", enteredAtWib: "10.03 WIB", deltaSecFromFirst: 180 }
  })!;

  // Price surges to +40%
  const res = lane.evaluatePriceTick(pos, {
    priceUsd: 0.0014,
    highPriceUsd: 0.0014,
    timestamp: 1180
  });

  assert.equal(res.closed, true);
  assert.equal(res.reason, "TAKE_PROFIT_35");
  assert.equal(pos.status, "CLOSED");
  assert.equal(pos.exitReason, "TAKE_PROFIT_35");
  // TP is locked at 35% gross - 2% fee = 33% net
  assert.equal(pos.grossReturnPct, 35);
  assert.equal(pos.netReturnPct, 33);
  assert.equal(pos.pnlUsd, 33);
  assert.equal(pos.isProfitable, true);
  cleanup();
});

test("GoldenConvergencePaperLane - Scalp Bot Trailing Stop (peak +20%, drop 7%)", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH });

  const pos = lane.openPosition({
    lane: "LANE_GOLDEN_SCALP",
    mint: "MintTrail111111111111111111111111111111111",
    symbol: "TRAIL",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1000,
    wallet1: { address: "W1", enteredAtWib: "10.00 WIB" },
    wallet2: { address: "W2", enteredAtWib: "10.04 WIB", deltaSecFromFirst: 240 }
  })!;

  // 1. Price climbs to +25%
  lane.evaluatePriceTick(pos, {
    priceUsd: 0.00125,
    highPriceUsd: 0.00125,
    timestamp: 1100
  });
  assert.equal(pos.status, "OPEN");

  // 2. Price drops from 0.00125 to 0.00115 (drop of 8% from peak)
  const res = lane.evaluatePriceTick(pos, {
    priceUsd: 0.00115,
    lowPriceUsd: 0.00115,
    timestamp: 1160
  });

  assert.equal(res.closed, true);
  assert.equal(res.reason, "TRAILING_STOP_7PCT");
  assert.equal(pos.status, "CLOSED");
  assert.ok(pos.pnlUsd! > 0);
  cleanup();
});

test("GoldenConvergencePaperLane - Moonbag Runner (TP1 +50% and TP2 +120%)", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH, stakePerTradeUsd: 100 });

  const pos = lane.openPosition({
    lane: "LANE_GOLDEN_MOONBAG",
    mint: "MintMoon111111111111111111111111111111111",
    symbol: "MOON_RUNNER",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1000,
    wallet1: { address: "W1", enteredAtWib: "10.00 WIB" },
    wallet2: { address: "W2", enteredAtWib: "10.05 WIB", deltaSecFromFirst: 300 }
  })!;

  // 1. Tick reaches +60%: TP1 (+50%) hit! Sells 50%
  lane.evaluatePriceTick(pos, {
    priceUsd: 0.0016,
    highPriceUsd: 0.0016,
    timestamp: 1200
  });
  assert.equal(pos.tp1Hit, true);
  assert.equal(pos.status, "OPEN");

  // 2. Tick reaches +130%: TP2 (+120%) hit! Sells remaining 50%
  const res = lane.evaluatePriceTick(pos, {
    priceUsd: 0.0023,
    highPriceUsd: 0.0023,
    timestamp: 1400
  });

  assert.equal(res.closed, true);
  assert.equal(res.reason, "TP1_50_TP2_120_HIT");
  assert.equal(pos.status, "CLOSED");
  assert.ok(pos.pnlUsd! >= 80); // Massive profit
  cleanup();
});
