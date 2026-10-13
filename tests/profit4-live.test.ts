import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Profit4LiveEngine,
  type LiveSignal,
} from "../src/profit4-live-engine.js";
import {
  saveLiveConfig,
  readLiveState,
  readLiveConfig,
  commandId,
  buysCompleted,
  sanitizeAudit,
  type LiveOrder,
} from "../src/profit4-live-store.js";
import { PROFIT4_RULES } from "../src/distribution-profit4-lane.js";
import {
  parseExecutionFill,
  type LiveAdapter,
  type ExecutionFill,
} from "../src/profit4-gmgn-execution.js";
const wallet = "F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6",
  mint = "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "profit4-real-"));
  let calls = 0,
    ready = true,
    available = "0",
    reject = false,
    unknown = false;
  const adapter: LiveAdapter = {
    readiness: async () => ({
      sessionReady: ready,
      wallet,
      balanceSol: 1,
      solUsd: 100,
      observedAt: Date.now(),
    }),
    balance: async () => ({ amount: available, decimals: 6 }),
    prepare: async () => {},
    restoreMonitor: async () => {},
    release: async () => {},
    quote: async () => ({
      quote: { outAmount: "9999", inDecimals: 9, outDecimals: 6 },
      amount_in_usd: 0.5,
    }),
    submit: async (_id, side) => {
      calls++;
      if (unknown) throw Error("timeout");
      return {
        ok: !reject,
        status: reject ? 400 : 200,
        orderId: side + "-order",
        hash: side + "-hash",
        error: reject ? "rejected" : undefined,
      };
    },
    confirm: async (_w, _m, o) => {
      if (unknown) return null;
      available = o.side === "BUY" ? "1000" : "0";
      return {
        hash: o.hash!,
        failed: false,
        tokenDelta: o.side === "BUY" ? "1000" : "-1000",
        decimals: 6,
        cashflowSol: o.side === "BUY" ? -0.0051 : 0.006,
        networkFeeSol: 0.0001,
        confirmedAt: Date.now(),
      };
    },
  };
  const engine = new Profit4LiveEngine(dir, "run-one", adapter, ["P4", "V4"]);
  const signal: LiveSignal = {
    type: "PAPER_BUY",
    mint,
    laneLabel: "P4",
    observedAt: Date.now(),
    priceUsd: 1,
    rules: { ...PROFIT4_RULES },
    transfer: { symbol: "TEST" },
  };
  return {
    dir,
    engine,
    adapter,
    signal,
    calls: () => calls,
    setReady: (v: boolean) => {
      ready = v;
    },
    setBalance: (v: string) => {
      available = v;
    },
    setReject: (v: boolean) => {
      reject = v;
    },
    setUnknown: (v: boolean) => {
      unknown = v;
    },
    enable: () => saveLiveConfig(dir, { enabled: true, activeLane: "P4" }),
  };
}
test("real engine reserves capacity once, uses confirmed fills, and sells while new buys are OFF", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  f.engine.handleSignal(f.signal);
  f.engine.handleSignal(f.signal);
  f.engine.handleSignal({
    ...f.signal,
    mint: "3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD",
    observedAt: f.signal.observedAt + 1,
  });
  assert.equal(f.engine.state.positions.length, 1);
  await f.engine.tick();
  assert.equal(f.calls(), 1);
  let p = f.engine.state.positions[0];
  assert.equal(p.status, "BUY_PENDING");
  assert.equal(p.acquiredAmount, "0");
  assert.equal(buysCompleted(f.engine.state, readLiveConfig(f.dir)), 0);
  saveLiveConfig(f.dir, { enabled: false });
  await f.engine.tick();
  assert.equal(p.status, "HOLDING");
  assert.equal(p.acquiredAmount, "1000");
  f.engine.handleSignal({
    ...f.signal,
    type: "PAPER_EXIT_SIGNAL",
    laneLabel: "V4",
    reason: "WRONG_LANE",
  });
  assert.equal(p.exitWanted, undefined);
  f.engine.handleSignal({
    ...f.signal,
    type: "PAPER_EXIT_SIGNAL",
    reason: "TARGET_NET_4",
  });
  await f.engine.tick();
  assert.equal(p.status, "SELL_PENDING");
  assert.equal(f.calls(), 2);
  await f.engine.tick();
  assert.equal(p.status, "CLOSED");
  assert.ok(Math.abs(p.pnlSol! - 0.0009) < 1e-12);
  assert.ok(Math.abs(p.pnlUsd! - 0.09) < 1e-12);
  assert.equal(p.buys[0].amount, "5000000");
  assert.equal(p.sells[0].amount, "1000");
  f.enable();
  f.engine.handleSignal({
    ...f.signal,
    observedAt: f.signal.observedAt + 1000,
  });
  assert.equal(f.engine.state.positions.length, 1);
  assert.match(
    readFileSync(join(f.dir, "real-trade-ledger.jsonl"), "utf8"),
    /BUY_CONFIRMED/,
  );
});
test("unknown submissions survive restart and are never retried automatically", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  f.setUnknown(true);
  f.engine.handleSignal(f.signal);
  await f.engine.tick();
  assert.equal(f.engine.state.positions[0].status, "UNKNOWN");
  assert.equal(f.calls(), 1);
  const restored = new Profit4LiveEngine(f.dir, "run-two", f.adapter, ["P4"]);
  await restored.tick();
  await restored.tick();
  assert.equal(f.calls(), 1);
  assert.equal(restored.state.positions[0].status, "UNKNOWN");
  assert.equal(readLiveConfig(f.dir).enabled, false);
});
test("turning OFF before submit, stale sessions and already owned tokens block real BUY", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  f.engine.handleSignal(f.signal);
  saveLiveConfig(f.dir, { enabled: false });
  await f.engine.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.engine.state.positions[0].status, "FAILED");
  const g = fixture();
  await g.engine.tick();
  g.enable();
  g.setBalance("200");
  g.engine.handleSignal(g.signal);
  await g.engine.tick();
  assert.equal(g.calls(), 0);
  assert.equal(g.engine.state.positions[0].status, "FAILED");
  const h = fixture();
  h.setReady(false);
  await h.engine.tick();
  h.enable();
  h.engine.handleSignal(h.signal);
  assert.equal(h.engine.state.positions.length, 0);
});
test("quota counts confirmations, stops new entries and cannot be incremented by failed orders", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  saveLiveConfig(f.dir, { maxBuys: 1 });
  f.engine.handleSignal(f.signal);
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(readLiveConfig(f.dir).enabled, false);
  assert.equal(buysCompleted(f.engine.state, readLiveConfig(f.dir)), 1);
  const g = fixture();
  await g.engine.tick();
  g.enable();
  g.setReject(true);
  g.engine.handleSignal(g.signal);
  await g.engine.tick();
  assert.equal(buysCompleted(g.engine.state, readLiveConfig(g.dir)), 0);
  assert.equal(g.engine.state.positions[0].status, "FAILED");
});
test("manual SELL commands remain idempotent after consumption and use actual bot quantity", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  f.engine.handleSignal(f.signal);
  await f.engine.tick();
  await f.engine.tick();
  saveLiveConfig(f.dir, { autoSell: false, enabled: false });
  const p = f.engine.state.positions[0],
    id = commandId(p.id, "command-123");
  const path = join(f.dir, "real-commands", id + ".json");
  const value = JSON.stringify({ positionId: p.id });
  writeFileSync(path, value);
  await f.engine.tick();
  assert.equal(f.calls(), 2);
  writeFileSync(path, value);
  await f.engine.tick();
  assert.equal(f.calls(), 2);
  assert.equal(p.status, "CLOSED");
});
test("confirmed chain parser measures wallet cashflow, token deltas and network fees", () => {
  const tx = {
    blockTime: 100,
    transaction: { message: { accountKeys: [{ pubkey: wallet }] } },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1000000000],
      postBalances: [999000000],
      preTokenBalances: [],
      postTokenBalances: [
        { owner: wallet, mint, uiTokenAmount: { amount: "2000", decimals: 6 } },
      ],
    },
  };
  const p = parseExecutionFill(tx, wallet, mint, "signature")!;
  assert.equal(p.tokenDelta, "2000");
  assert.equal(p.cashflowSol, -0.001);
  assert.equal(p.networkFeeSol, 0.000005);
  assert.equal(p.confirmedAt, 100000);
  assert.equal(
    parseExecutionFill(tx, "unknown-wallet", mint, "signature"),
    null,
  );
});
test("configuration is validated and audit data redacts credentials and signed payloads", () => {
  const f = fixture();
  assert.throws(() => saveLiveConfig(f.dir, { stakeUsd: -1 }));
  assert.throws(() => saveLiveConfig(f.dir, { maxActiveRealPositions: 1.5 }));
  assert.throws(() => saveLiveConfig(f.dir, { enabled: "true" }));
  assert.throws(() => saveLiveConfig(f.dir, { buysCompleted: 100 }));
  const value = sanitizeAudit({
    authorization: "Bearer secret",
    cookie: "session",
    quote: { raw_tx: "signed", outAmount: "100" },
    message: "Bearer secret",
  });
  assert.equal(value.authorization, "[redacted]");
  assert.equal(value.quote.raw_tx, "[redacted]");
  assert.equal(JSON.stringify(value).includes("secret"), false);
});

test("manual reconciliation confirms an unknown order without another submit", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  f.setUnknown(true);
  f.engine.handleSignal(f.signal);
  await f.engine.tick();
  const p = f.engine.state.positions[0],
    signature = "3".repeat(88),
    id = commandId(p.id, "reconcile-" + signature);
  writeFileSync(
    join(f.dir, "real-commands", id + ".json"),
    JSON.stringify({ type: "RECONCILE", positionId: p.id, signature }),
  );
  f.setUnknown(false);
  await f.engine.tick();
  assert.equal(f.calls(), 1);
  assert.equal(p.status, "HOLDING");
  assert.equal(p.buys[0].hash, signature);
  assert.equal(p.acquiredAmount, "1000");
});
test("configuration changes during quote and early exit cancel BUY before submit", async () => {
  const f = fixture();
  await f.engine.tick();
  f.enable();
  f.engine.handleSignal(f.signal);
  f.adapter.quote = async () => {
    saveLiveConfig(f.dir, { stakeUsd: 1 });
    return { quote: { outAmount: "9999" } };
  };
  await f.engine.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.engine.state.positions[0].status, "FAILED");
  const g = fixture();
  await g.engine.tick();
  g.enable();
  g.engine.handleSignal(g.signal);
  g.engine.handleSignal({
    ...g.signal,
    type: "PAPER_EXIT_SIGNAL",
    reason: "STOP",
  });
  await g.engine.tick();
  assert.equal(g.calls(), 0);
});
test("wrapped SOL changes are included in confirmed wallet cashflow", () => {
  const wsol = "So11111111111111111111111111111111111111112";
  const tx = {
    blockTime: 100,
    transaction: { message: { accountKeys: [wallet] } },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1000000000],
      postBalances: [999995000],
      preTokenBalances: [
        {
          owner: wallet,
          mint: wsol,
          uiTokenAmount: { amount: "5000000", decimals: 9 },
        },
      ],
      postTokenBalances: [
        {
          owner: wallet,
          mint: wsol,
          uiTokenAmount: { amount: "0", decimals: 9 },
        },
        { owner: wallet, mint, uiTokenAmount: { amount: "2000", decimals: 6 } },
      ],
    },
  };
  assert.equal(
    parseExecutionFill(tx, wallet, mint, "sig")!.cashflowSol,
    -0.005005,
  );
});
