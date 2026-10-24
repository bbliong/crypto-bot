import test from "node:test";
import assert from "node:assert/strict";
import { SolanaRpcQueue, type Priority } from "../src/solana-rpc-queue.js";

test("SolanaRpcQueue - respects minIntervalBetweenReqMs strictly", async () => {
  const queue = new SolanaRpcQueue({
    minIntervalBetweenReqMs: 80,
    maxRequestsPerWindow: 20,
    windowDurationMs: 5000
  });

  const timestamps: number[] = [];
  const promises = [];

  for (let i = 0; i < 5; i++) {
    promises.push(
      queue.enqueue(async () => {
        timestamps.push(Date.now());
        return i;
      })
    );
  }

  const results = await Promise.all(promises);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(timestamps.length, 5);

  for (let i = 1; i < timestamps.length; i++) {
    const diff = timestamps[i] - timestamps[i - 1];
    assert.ok(diff >= 75, `Expected diff >= 75ms, got ${diff}ms between request ${i-1} and ${i}`);
  }
});

test("SolanaRpcQueue - executes HIGH priority tasks ahead of NORMAL and LOW", async () => {
  const queue = new SolanaRpcQueue({
    minIntervalBetweenReqMs: 50,
    maxRequestsPerWindow: 10,
    windowDurationMs: 5000
  });

  const executionOrder: string[] = [];

  // Start with a blocking first task
  queue.enqueue(async () => {
    await new Promise(r => setTimeout(r, 60));
    executionOrder.push("FIRST");
  }, "NORMAL");

  // Enqueue lower priority tasks while first is running
  queue.enqueue(async () => executionOrder.push("LOW_1"), "LOW");
  queue.enqueue(async () => executionOrder.push("NORMAL_1"), "NORMAL");
  queue.enqueue(async () => executionOrder.push("HIGH_1"), "HIGH");
  queue.enqueue(async () => executionOrder.push("NORMAL_2"), "NORMAL");
  queue.enqueue(async () => executionOrder.push("HIGH_2"), "HIGH");

  await new Promise(r => setTimeout(r, 450));

  assert.equal(executionOrder[0], "FIRST");
  assert.equal(executionOrder[1], "HIGH_1");
  assert.equal(executionOrder[2], "HIGH_2");
  assert.equal(executionOrder[3], "NORMAL_1");
  assert.equal(executionOrder[4], "NORMAL_2");
  assert.equal(executionOrder[5], "LOW_1");
});

test("SolanaRpcQueue - sliding window restricts bursts to maxRequestsPerWindow", async () => {
  const windowDurationMs = 500;
  const maxRequestsPerWindow = 3;

  const queue = new SolanaRpcQueue({
    minIntervalBetweenReqMs: 20,
    maxRequestsPerWindow,
    windowDurationMs
  });

  const timestamps: number[] = [];
  const promises = [];

  for (let i = 0; i < 5; i++) {
    promises.push(
      queue.enqueue(async () => {
        timestamps.push(Date.now());
        return i;
      })
    );
  }

  await Promise.all(promises);
  assert.equal(timestamps.length, 5);

  // The 4th request must be delayed until windowDurationMs passes from the 1st request
  const diff1to4 = timestamps[3] - timestamps[0];
  assert.ok(diff1to4 >= windowDurationMs - 50, `Diff between 1st and 4th (${diff1to4}ms) should be >= ${windowDurationMs}ms`);
});

test("SolanaRpcQueue - automatically handles 429 and retries successfully", async () => {
  const queue = new SolanaRpcQueue({
    minIntervalBetweenReqMs: 20,
    cooldownOn429Ms: 200,
    maxRetriesOn429: 2
  });

  let attempts = 0;
  const result = await queue.enqueue(async () => {
    attempts++;
    if (attempts === 1) {
      throw new Error("HTTP_429");
    }
    return "SUCCESS_AFTER_RETRY";
  });

  assert.equal(result, "SUCCESS_AFTER_RETRY");
  assert.equal(attempts, 2);
  const stats = queue.getStats();
  assert.equal(stats.total429s, 1);
  assert.equal(stats.totalCompleted, 1);
});
