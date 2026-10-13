import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfit4Dashboard } from "../scripts/serve-profit4-dashboard.mjs";
import { atomicJson, readLiveConfig } from "../src/profit4-live-store.ts";
const wallet = "F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6",
  mint = "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT";
test("Profit4 protects controls, validates config, scopes audit, queues idempotent sells and guards restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "profit4-api-")),
    dir = join(root, "data", "profit4-watch");
  mkdirSync(dir, { recursive: true });
  const server = createProfit4Dashboard({
    root,
    adminPassword: "test-password",
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/profit4`;
  let cookie = "";
  const post = (path, body = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
  const pos = {
    id: "a".repeat(64),
    run: "one",
    symbol: "TOKEN",
    mint,
    lane: "V4",
    wallet,
    status: "HOLDING",
    createdAt: 1,
    remainingAmount: "1000",
    buys: [],
    sells: [],
    audit: [{ authorization: "secret" }],
    rules: {},
    pnlUsd: null,
  };
  const state = {
    updatedAt: Date.now(),
    positions: [
      pos,
      { ...pos, id: "b".repeat(64), run: "two", status: "CLOSED", pnlUsd: 2 },
    ],
    readiness: {
      sessionReady: true,
      wallet,
      balanceSol: 1,
      solUsd: 100,
      observedAt: Date.now(),
      workerPid: process.pid,
      activeLanes: ["V1", "V2", "V3", "V4"],
    },
  };
  writeFileSync(
    join(dir, "worker-control.json"),
    JSON.stringify({ pid: process.pid, mode: "profit4-watch" }),
  );
  atomicJson(join(dir, "real-state.json"), state);
  try {
    assert.equal((await post("/api/autobuy", { enabled: true })).status, 200);
    assert.equal((await fetch(url + "/api/real-trades")).status, 200);
    assert.equal((await post("/api/worker/stop")).status, 500);
    assert.equal(
      (await post("/api/admin/login", { password: "wrong" })).status,
      200,
    );
    const login = await post("/api/admin/login", { password: "test-password" });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get("set-cookie"), null);
    assert.equal((await post("/api/autobuy", { stakeUsd: -1 })).status, 400);
    assert.equal(
      (await post("/api/autobuy", { enabled: true, activeLane: "P4" })).status,
      409,
    );
    assert.equal(
      (
        await post("/api/autobuy", {
          enabled: true,
          activeLane: "V4",
          stakeUsd: 0.75,
        })
      ).status,
      200,
    );
    assert.equal(readLiveConfig(dir).stakeUsd, 0.75);
    const publicState = await (await fetch(url + "/api/state")).json();
    assert.equal(publicState.autoBuy.positions, undefined);
    assert.equal(publicState.admin.authenticated, true);
    const result = await (
      await fetch(url + "/api/real-trades?run=two", { headers: { cookie } })
    ).json();
    assert.equal(result.total, 1);
    assert.equal(result.summary.pnlUsd, 2);
    assert.equal(result.activePositions.length, 1);
    assert.equal(result.trades[0].audit, undefined);
    const detail = await (
      await fetch(url + "/api/real-trades/" + pos.id, { headers: { cookie } })
    ).json();
    assert.equal(detail.audit[0].authorization, "[redacted]");
    assert.equal(
      (
        await post("/api/real-positions/" + pos.id + "/sell", {
          idempotencyKey: "command-123",
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await post("/api/real-positions/" + pos.id + "/sell", {
          idempotencyKey: "command-123",
        })
      ).status,
      202,
    );
    assert.equal(readdirSync(join(dir, "real-commands")).length, 1);
    assert.equal(
      (
        await post(`/api/real-positions/${pos.id}/reconcile`, {
          signature: "3".repeat(88),
        })
      ).status,
      409,
    );
    state.positions[0].status = "UNKNOWN";
    state.positions[0].buys = [
      {
        side: "BUY",
        status: "UNKNOWN",
        amount: "5000000",
        submittedAt: Date.now(),
        solUsd: 100,
      },
    ];
    atomicJson(join(dir, "real-state.json"), state);
    assert.equal(
      (
        await post(`/api/real-positions/${pos.id}/reconcile`, {
          signature: "invalid",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(`/api/real-positions/${pos.id}/reconcile`, {
          signature: "3".repeat(88),
        })
      ).status,
      202,
    );
    assert.equal((await post("/api/worker/stop")).status, 500);
    assert.equal((await post("/api/worker/start")).status, 500);
    assert.equal(
      (await post("/api/wallets", { addresses: [wallet] })).status,
      500,
    );
    assert.equal((await post("/api/autobuy", { enabled: false })).status, 200);
    await post("/api/admin/logout");
    assert.equal((await post("/api/autobuy", { enabled: true })).status, 200);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});
