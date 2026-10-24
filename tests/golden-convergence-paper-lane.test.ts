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
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH });

  const pos = lane.openPosition({
    lane: "LANE_GMGN_DISCOVERY",
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
    lane: "LANE_GMGN_DISCOVERY",
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

test("GoldenConvergencePaperLane - Take Profit (+35%) triggers accurately", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH });

  const pos = lane.openPosition({
    lane: "LANE_GMGN_DISCOVERY",
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

test("GoldenConvergencePaperLane - Trailing Stop triggers after reaching +20% and dropping 7%", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH });

  const pos = lane.openPosition({
    lane: "LANE_SOLANA_RPC",
    mint: "MintTrail111111111111111111111111111111111",
    symbol: "TRAIL",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1000,
    wallet1: { address: "W1", enteredAtWib: "10.00 WIB" },
    wallet2: { address: "W2", enteredAtWib: "10.04 WIB", deltaSecFromFirst: 240 }
  })!;

  // 1. Price climbs to +28% (activates trailing)
  lane.evaluatePriceTick(pos, {
    priceUsd: 0.00128,
    highPriceUsd: 0.00128,
    timestamp: 1100
  });
  assert.equal(pos.trailingActivated, true);
  assert.equal(pos.status, "OPEN");

  // 2. Price drops from 0.00128 to 0.00118 (drop of 7.8% from peak)
  const res = lane.evaluatePriceTick(pos, {
    priceUsd: 0.00118,
    timestamp: 1160
  });

  assert.equal(res.closed, true);
  assert.equal(res.reason, "TRAILING_STOP_7PCT");
  assert.equal(pos.status, "CLOSED");
  // 18% gross - 2% fee = 16% net ($16 profit)
  assert.equal(pos.netReturnPct, 16);
  assert.equal(pos.pnlUsd, 16);
  assert.equal(pos.isProfitable, true);
  cleanup();
});

test("GoldenConvergencePaperLane - Stop Loss (-12%) cuts losses promptly", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH });

  const pos = lane.openPosition({
    lane: "LANE_SOLANA_RPC",
    mint: "MintSL111111111111111111111111111111111111",
    symbol: "SL_COIN",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1000,
    wallet1: { address: "W1", enteredAtWib: "10.00 WIB" },
    wallet2: { address: "W2", enteredAtWib: "10.05 WIB", deltaSecFromFirst: 300 }
  })!;

  // Price drops -15%
  const res = lane.evaluatePriceTick(pos, {
    priceUsd: 0.00085,
    lowPriceUsd: 0.00085,
    timestamp: 1100
  });

  assert.equal(res.closed, true);
  assert.equal(res.reason, "STOP_LOSS_12");
  assert.equal(pos.status, "CLOSED");
  // -12% gross - 2% fee = -14% net (-$14 loss)
  assert.equal(pos.grossReturnPct, -12);
  assert.equal(pos.netReturnPct, -14);
  assert.equal(pos.pnlUsd, -14);
  assert.equal(pos.isProfitable, false);
  cleanup();
});

test("GoldenConvergencePaperLane - Timeout (30 min) auto-exits at market price", () => {
  cleanup();
  const lane = new GoldenConvergencePaperLane({ storePath: TEST_STORE_PATH });

  const pos = lane.openPosition({
    lane: "LANE_GMGN_DISCOVERY",
    mint: "MintTimeout11111111111111111111111111111111",
    symbol: "FLAT_COIN",
    entryPriceUsd: 0.001,
    entryMcapUsd: 10000,
    entryTimestamp: 1000,
    wallet1: { address: "W1", enteredAtWib: "10.00 WIB" },
    wallet2: { address: "W2", enteredAtWib: "10.05 WIB", deltaSecFromFirst: 300 }
  })!;

  // 31 minutes later (1860s), price is only +5%
  const res = lane.evaluatePriceTick(pos, {
    priceUsd: 0.00105,
    timestamp: 1000 + 1860
  });

  assert.equal(res.closed, true);
  assert.equal(res.reason, "TIMEOUT_30M");
  assert.equal(pos.status, "CLOSED");
  assert.equal(pos.grossReturnPct, 5);
  assert.equal(pos.netReturnPct, 3); // 5% - 2% = 3%
  assert.equal(pos.pnlUsd, 3);
  cleanup();
});
