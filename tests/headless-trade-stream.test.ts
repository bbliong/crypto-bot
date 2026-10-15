import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadlessTradeStream } from '../src/headless-trade-stream.js';
import type { TargetTrade } from '../src/distribution-target-lane.js';

test('HeadlessTradeStream registers, emits trades and unregisters mints cleanly', async () => {
  const stream = new HeadlessTradeStream({
    dexPollIntervalMs: 10000,
    solPriceUsd: 150.0,
  });

  const testMint = '6PaFLp8BW531vmtReYBpb8GaV4rmhp6d5d8TeZ3cuFyS';
  const receivedTrades: TargetTrade[] = [];

  stream.on('trade', (mint, trade) => {
    assert.equal(mint, testMint);
    receivedTrades.push(trade);
  });

  stream.registerMint(testMint, { symbol: 'Grok', priceUsd: 0.000002 });
  assert.equal(stream.hasMint(testMint), true);
  assert.deepEqual(stream.getTrackedMints(), [testMint]);

  // Emit trade
  const now = Date.now();
  const mockTrade: TargetTrade = {
    at: now,
    timestamp: Math.floor(now / 1000),
    price: 0.0000025,
    side: 'buy',
    wallet: 'test_trader',
    usd: 50,
    signature: 'test_sig_123',
  };
  stream.emitTrade(testMint, mockTrade);

  assert.equal(receivedTrades.length, 1);
  assert.equal(receivedTrades[0].price, 0.0000025);
  assert.equal(receivedTrades[0].side, 'buy');

  // Unregister
  stream.unregisterMint(testMint);
  assert.equal(stream.hasMint(testMint), false);
  assert.equal(stream.getTrackedMints().length, 0);

  stream.stop();
});

test('HeadlessTradeStream parses PumpPortal new token message into NewTokenEvent', async () => {
  const stream = new HeadlessTradeStream({
    dexPollIntervalMs: 10000,
    solPriceUsd: 150.0,
  });

  let capturedEvent: any = null;
  stream.on('newToken', (event) => {
    capturedEvent = event;
  });

  const rawPumpPortalMsg = {
    txType: 'create',
    mint: 'TokenTest11111111111111111111111111111111111',
    traderPublicKey: 'DevWallet11111111111111111111111111111111111',
    name: 'MoonRocket',
    symbol: 'MOON',
    initialBuy: 1.5,
    bondingCurveKey: 'Curve111111111111111111111111111111111111111',
    vTokensInBondingCurve: 1073000000,
    vSolInBondingCurve: 30,
    marketCapSol: 29.5,
  };

  (stream as any).handlePumpPortalMessage(rawPumpPortalMsg);

  assert.ok(capturedEvent);
  assert.equal(capturedEvent.mint, 'TokenTest11111111111111111111111111111111111');
  assert.equal(capturedEvent.symbol, 'MOON');
  assert.equal(capturedEvent.initialBuy, 1.5);
  assert.equal(capturedEvent.vSolInBondingCurve, 30);

  stream.stop();
});
