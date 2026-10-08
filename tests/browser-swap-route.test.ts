import test from 'node:test';
import assert from 'node:assert/strict';
import { getBrowserBuySwapRoute, getBrowserSellSwapRoute, getBrowserDualSellSwapRoute, DEFAULT_SWAP_WALLET } from '../src/browser-swap-route.js';
import { DistributionProfit4Runtime } from '../src/distribution-profit4-runtime.js';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('getBrowserDualSellSwapRoute calls swap twice with interval and calculates price delta', async () => {
  const callTimes: number[] = [];
  let callCount = 0;

  // Mock page object
  const mockPage: any = {
    isClosed: () => false,
    evaluate: async (fn: any, args: any) => {
      callCount++;
      callTimes.push(Date.now());
      // Return simulated quote
      const p = callCount === 1 ? 0.050 : 0.052; // Naik +4%
      return {
        status: 200,
        latencyMs: 120,
        ok: true,
        routeData: { exchange: 'raydium' },
        quote: {
          inAmount: args.inputTokenAmountBaseUnits,
          outAmount: '1000000',
          inDecimals: 6,
          outDecimals: 9,
          priceImpactPct: '0.1',
          exchange: 'raydium',
          amountInUsd: 5.0,
          amountOutUsd: 5.0 * (p / 0.05),
        },
        impliedPriceUsd: p,
      };
    },
  };

  const t0 = Date.now();
  const res = await getBrowserDualSellSwapRoute(mockPage, 'TestMint123', DEFAULT_SWAP_WALLET, '100000000', 6, 15, 100); // 100ms for fast test
  const elapsed = Date.now() - t0;

  assert.equal(callCount, 2);
  assert.ok(elapsed >= 90, `Elapsed ${elapsed}ms should be at least ~100ms`);
  assert.equal(res.quote1.impliedPriceUsd, 0.050);
  assert.equal(res.quote2.impliedPriceUsd, 0.052);
  assert.ok(res.priceDeltaPct !== null);
  // (0.052 - 0.050) / 0.050 * 100 = 4%
  assert.ok(Math.abs(res.priceDeltaPct! - 4.0) < 0.001);
  assert.ok(Math.abs(res.avgPriceUsd! - 0.051) < 0.0001);
});

test('DistributionProfit4Runtime triggers buy and dual sell swap probes and stores them in positions', async () => {
  const data = mkdtempSync(join(tmpdir(), 'profit4-swap-test-')), run = join(data, 'run');
  mkdirSync(run);
  const events: any[] = [];
  const runtime = new DistributionProfit4Runtime(run, (_n, e) => events.push(e), data, 'bounce');

  let buyProbed = false;
  let sellProbed = false;

  runtime.setSwapProbeHandlers({
    getBuyQuote: async (mint: string) => {
      buyProbed = true;
      return {
        status: 200,
        latencyMs: 85,
        ok: true,
        quote: { inAmount: '34482758', outAmount: '100000000', inDecimals: 9, outDecimals: 6, priceImpactPct: '0.05', exchange: 'pump', amountInUsd: 5, amountOutUsd: 5 },
        impliedPriceUsd: 0.050,
      };
    },
    getSellQuotes: async (mint: string, inputTokens?: string) => {
      sellProbed = true;
      return {
        quote1: {
          status: 200, latencyMs: 90, ok: true,
          quote: { inAmount: inputTokens ?? '100000000', outAmount: '35000000', inDecimals: 6, outDecimals: 9, priceImpactPct: '0.05', exchange: 'pump', amountInUsd: 5, amountOutUsd: 6.8 },
          impliedPriceUsd: 0.068,
        },
        quote2: {
          status: 200, latencyMs: 92, ok: true,
          quote: { inAmount: inputTokens ?? '100000000', outAmount: '35100000', inDecimals: 6, outDecimals: 9, priceImpactPct: '0.05', exchange: 'pump', amountInUsd: 5, amountOutUsd: 6.82 },
          impliedPriceUsd: 0.0682,
        },
        priceDeltaPct: 0.294,
        avgPriceUsd: 0.0681,
      };
    },
  });

  runtime.register({ mint: 'testMint', wallet: 'wallet1', timestamp: 1 }, 1000);

  // Initial trades to establish first price and peak at 1.0
  for (let at = 2000; at <= 31000; at += 1000) {
    runtime.trade('testMint', { at, timestamp: at / 1000, price: 1.0, side: 'buy', wallet: 'w1', usd: 5, signature: String(at) });
    runtime.evaluate(at);
  }

  // Dump to 0.40 (60% drawdown)
  runtime.trade('testMint', { at: 32000, timestamp: 32, price: 0.40, side: 'sell', wallet: 'w2', usd: 50, signature: 'dump' });
  runtime.evaluate(32000);

  // Bounce to 0.42 (5% bounce from trough) with strong buy flow
  runtime.trade('testMint', { at: 33000, timestamp: 33, price: 0.42, side: 'buy', wallet: 'w3', usd: 30, signature: 'bounce1' });
  runtime.evaluate(33000);

  // Confirm and enter
  runtime.trade('testMint', { at: 34000, timestamp: 34, price: 0.42, side: 'buy', wallet: 'w3', usd: 30, signature: 'bounce2' });
  runtime.evaluate(34000);

  // Wait tick for async buy probe
  await new Promise(r => setTimeout(r, 60));
  assert.equal(buyProbed, true);

  // Price surges to trigger take profit target (0.70 vs 0.42 entry)
  runtime.trade('testMint', { at: 35000, timestamp: 35, price: 0.70, side: 'buy', wallet: 'w4', usd: 20, signature: 'tp1' });
  runtime.evaluate(35000);

  // Fill delay tick
  // Price surges to trigger take profit target (1.10 vs 0.70 entry = +57% gross)
  runtime.trade('testMint', { at: 37000, timestamp: 37, price: 1.10, side: 'buy', wallet: 'w4', usd: 20, signature: 'tp1' });
  runtime.evaluate(37000);

  // Fill delay tick
  runtime.trade('testMint', { at: 38000, timestamp: 38, price: 1.10, side: 'buy', wallet: 'w4', usd: 20, signature: 'tp2' });
  runtime.evaluate(38000);

  // Wait tick for async dual sell probe
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sellProbed, true);

  const state = JSON.parse(readFileSync(join(run, 'profit4-state.json'), 'utf8'));
  const p = state.positions[0];
  assert.equal(p.mint, 'testMint');
  assert.equal(p.swapBuyPrice, 0.050);
  assert.equal(p.swapSellPrice1, 0.068);
  assert.equal(p.swapSellPrice2, 0.0682);
  assert.ok(p.swapSellDeltaPct !== null);
});
