import test from "node:test";
import assert from "node:assert/strict";
import { GmgnTokenWebSocketManager } from "../src/gmgn-token-websocket.js";

// Mock page object for unit testing without headless browser
function createMockPage() {
  const sentFrames: Array<{ action: string; mint: string }> = [];
  return {
    isClosed: () => false,
    evaluate: async (fn: any, args: any) => {
      sentFrames.push(args);
      return true;
    },
    sentFrames,
  } as any;
}

// Generate valid Solana Base58 address (32-44 chars, no 0, O, I, l)
function makeBase58(prefix: string, index: number): string {
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const numChar = chars[(index % chars.length)];
  return `${prefix}${numChar}111111111111111111111111111111111`.slice(0, 44);
}

test("GmgnTokenWebSocketManager: partitions quota strictly 10-10-10 across 3 pools", async () => {
  const mockPage = createMockPage();
  const manager = new GmgnTokenWebSocketManager(mockPage, 10, 10);

  // 1. Isi pool 'momentum' dengan 11 token
  for (let i = 1; i <= 11; i++) {
    const mint = makeBase58("MomMint", i);
    const ok = await manager.subscribeToken(mint, "momentum");
    assert.equal(ok, true, `Mint ${mint} harus valid`);
  }

  const counts1 = manager.getPoolCounts();
  assert.equal(counts1.momentum, 10, "Momentum pool harus tepat 10 slot");
  assert.equal(counts1.smartmoney, 0);
  assert.equal(counts1.trend20m, 0);
  assert.equal(counts1.total, 10);

  // Mint pertama (oldest) harus sudah di-evict dari pool momentum
  const firstMomMint = makeBase58("MomMint", 1);
  assert.equal(manager.getSubscribedMints().includes(firstMomMint), false);

  // 2. Isi pool 'smartmoney' dengan 10 token
  for (let i = 1; i <= 10; i++) {
    const mint = makeBase58("SmrtMnt", i);
    const ok = await manager.subscribeToken(mint, "smartmoney");
    assert.equal(ok, true, `Mint ${mint} harus valid`);
  }

  const counts2 = manager.getPoolCounts();
  assert.equal(counts2.momentum, 10);
  assert.equal(counts2.smartmoney, 10, "SmartMoney pool harus tepat 10 slot");
  assert.equal(counts2.trend20m, 0);
  assert.equal(counts2.total, 20);

  // 3. Isi pool 'trend20m' dengan 12 token
  for (let i = 1; i <= 12; i++) {
    const mint = makeBase58("TrndMnt", i);
    const ok = await manager.subscribeToken(mint, "trend20m");
    assert.equal(ok, true, `Mint ${mint} harus valid`);
  }

  const counts3 = manager.getPoolCounts();
  assert.equal(counts3.momentum, 10, "Momentum pool tidak terganggu");
  assert.equal(counts3.smartmoney, 10, "SmartMoney pool tidak terganggu");
  assert.equal(counts3.trend20m, 10, "Trend20m pool tepat 10 slot");
  assert.equal(counts3.total, 30, "Total tepat 30 slot (10-10-10)");

  // 4. Isi pool 'syndicate' dengan 11 token
  for (let i = 1; i <= 11; i++) {
    const mint = makeBase58("SyndMnt", i);
    const ok = await manager.subscribeToken(mint, "syndicate");
    assert.equal(ok, true, `Mint ${mint} harus valid`);
  }

  const counts4 = manager.getPoolCounts();
  assert.equal(counts4.momentum, 10, "Momentum pool tidak terganggu");
  assert.equal(counts4.smartmoney, 10, "SmartMoney pool tidak terganggu");
  assert.equal(counts4.trend20m, 10, "Trend20m pool tidak terganggu");
  assert.equal(counts4.syndicate, 10, "Syndicate pool tepat 10 slot");
  assert.equal(counts4.total, 40, "Total tepat 40 slot (10-10-10-10)");

  // SyndMnt 1 harus sudah di-evict karena FIFO kapasitas 10
  assert.equal(manager.getSubscribedMints().includes(makeBase58("SyndMnt", 1)), false);
  assert.equal(manager.getSubscribedMints().includes(makeBase58("SyndMnt", 11)), true);
});

test("GmgnTokenWebSocketManager: auto-sweeps tokens older than maxDurationSeconds (2 jam)", async () => {
  const mockPage = createMockPage();
  const manager = new GmgnTokenWebSocketManager(mockPage, 10, 10);

  const mintOld = makeBase58("AgedTok", 1);
  const mintFresh = makeBase58("FrshTok", 2);

  const ok1 = await manager.subscribeToken(mintOld, "trend20m", 7200);
  const ok2 = await manager.subscribeToken(mintFresh, "trend20m", 7200);
  assert.equal(ok1, true);
  assert.equal(ok2, true);

  // Simulasi waktu maju 2 jam + 5 detik (7205s)
  const metaOld = manager.getTokenMeta(mintOld);
  assert.ok(metaOld);
  metaOld.subscribedAt = Date.now() - 7205 * 1000;

  // Panggil sweepExpired
  const swept = await manager.sweepExpired();
  assert.deepEqual(swept, [mintOld]);

  const counts = manager.getPoolCounts();
  assert.equal(counts.trend20m, 1);
  assert.equal(manager.getSubscribedMints().includes(mintOld), false);
  assert.equal(manager.getSubscribedMints().includes(mintFresh), true);
});
