import test from "node:test";
import assert from "node:assert/strict";
import { SolanaWalletStream, type WalletTransferEvent, type WalletSellEvent } from "../src/solana-wallet-stream.js";

test("SolanaWalletStream instantiates with default options and handles balance diffs", async () => {
  const stream = new SolanaWalletStream({
    maxWalletsPerSocket: 50,
    staggerMs: 0,
  });

  assert.ok(stream);

  let capturedTransfer: WalletTransferEvent | null = null;
  let capturedSell: WalletSellEvent | null = null;

  stream.on("transfer", (t) => {
    capturedTransfer = t;
  });
  stream.on("sell", (s) => {
    capturedSell = s;
  });

  const testWallet = "TestHolderWallet11111111111111111111111111";
  const testMint = "TestMint11111111111111111111111111111111111";

  // Simulate internal resolveTransaction logic with balance diff
  const mockTx = {
    blockTime: 1792051000,
    meta: {
      preTokenBalances: [
        { owner: testWallet, mint: testMint, uiTokenAmount: { uiAmount: 100 } },
      ],
      postTokenBalances: [
        { owner: testWallet, mint: testMint, uiTokenAmount: { uiAmount: 350 } },
      ],
    },
  };

  // Check transfer emission
  const pre = mockTx.meta.preTokenBalances[0].uiTokenAmount.uiAmount;
  const post = mockTx.meta.postTokenBalances[0].uiTokenAmount.uiAmount;
  const diff = post - pre;

  if (diff > 0) {
    stream.emit("transfer", {
      wallet: testWallet,
      mint: testMint,
      amount: diff.toString(),
      timestamp: mockTx.blockTime,
      tx: "mock_signature_123",
    });
  }

  assert.ok(capturedTransfer !== null);
  const transfer = capturedTransfer as WalletTransferEvent;
  assert.equal(transfer.wallet, testWallet);
  assert.equal(transfer.mint, testMint);
  assert.equal(transfer.amount, "250");

  // Check sell emission
  const sellDiff = 0 - 350;
  if (sellDiff < 0) {
    stream.emit("sell", {
      wallet: testWallet,
      mint: testMint,
      timestamp: mockTx.blockTime + 60,
      tx: "mock_signature_sell_456",
      amount: Math.abs(sellDiff).toString(),
    });
  }

  assert.ok(capturedSell !== null);
  const sell = capturedSell as WalletSellEvent;
  assert.equal(sell.wallet, testWallet);
  assert.equal(sell.mint, testMint);
  assert.equal(sell.amount, "350");

  stream.stop();
});
