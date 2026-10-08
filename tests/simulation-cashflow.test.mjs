import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRunCashflow } from '../scripts/simulation-cashflow.mjs';

function jsonl(rows) { return rows.map(row => JSON.stringify(row)).join('\n') + '\n'; }

test('buildRunCashflow replays one run in chronological order and uses complete route quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simulation-cashflow-'));
  try {
    writeFileSync(join(dir, 'simulated-trades.jsonl'), jsonl([
      { type: 'SIMULATED_SELL', positionId: 'one', mint: 'mint-one', paperLane: 'safe', observedAt: 2_000, exitPriceUsd: 1.2, pnlPercent: 20, reason: 'TARGET' },
      { type: 'SIMULATED_BUY', positionId: 'one', mint: 'mint-one', metadata: { symbol: 'ONE' }, paperLane: 'safe', observedAt: 1_000, entryPriceUsd: 1 },
      { type: 'SIMULATED_BUY', positionId: 'two', mint: 'mint-two', metadata: { symbol: 'TWO' }, paperLane: 'safe', observedAt: 3_000, entryPriceUsd: 1 },
    ]));
    writeFileSync(join(dir, 'quote-simulated-orders.jsonl'), jsonl([
      { type: 'QUOTE_BUY_COMPARISON', positionId: 'one', quote: { amountInUsd: 5 } },
      { type: 'QUOTE_SELL_COMPARISON', positionId: 'one', quote: { amountOutUsd: 6 } },
      { type: 'QUOTE_BUY_COMPARISON', positionId: 'two', quote: { amountInUsd: 5 } },
    ]));

    const result = buildRunCashflow(dir, { startingCashUsd: 20, stakeUsd: 5 });
    assert.equal(result.closedTrades, 1);
    assert.equal(result.openTrades, 1);
    assert.ok(Math.abs(result.endingCashUsd - 15.5628784) < 1e-9);
    assert.ok(Math.abs(result.endingEquityUsd - 20.9262) < 1e-9);
    assert.ok(Math.abs(result.netPnlUsd - 0.9262) < 1e-9);
    assert.ok(Math.abs(result.totalNetworkAndTipUsd - 0.0738) < 1e-9);
    assert.ok(Math.abs(result.reclaimableRentUsd - 0.3633216) < 1e-9);
    assert.equal(result.totalGmgnPlatformUsdIncluded, 0.1);
    // GMGN/DEX effects already live in the route return, so only network + tip
    // are deducted separately from the quote result.
    assert.ok(Math.abs(result.trades.find(trade => trade.positionId === 'one').pnlUsd - 0.9508) < 1e-9);
    assert.equal(result.trades.find(trade => trade.positionId === 'one').returnSource, 'ROUTE_QUOTE');
    assert.deepEqual(result.lanes, ['safe']);
    assert.equal(result.lane, 'all');
    assert.equal(result.ledger[0].type, 'BUY');
    assert.equal(result.ledger[1].type, 'SELL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRunCashflow applies a lane filter before replaying cash flow', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simulation-cashflow-'));
  try {
    writeFileSync(join(dir, 'simulated-trades.jsonl'), jsonl([
      { type: 'SIMULATED_BUY', positionId: 'safe', mint: 'safe-mint', metadata: { symbol: 'SAFE' }, paperLane: 'safe', observedAt: 1_000, entryPriceUsd: 1 },
      { type: 'SIMULATED_SELL', positionId: 'safe', mint: 'safe-mint', paperLane: 'safe', observedAt: 2_000, exitPriceUsd: 1.1, pnlPercent: 10 },
      { type: 'SIMULATED_BUY', positionId: 'wide', mint: 'wide-mint', metadata: { symbol: 'WIDE' }, paperLane: 'wide', observedAt: 3_000, entryPriceUsd: 1 },
      { type: 'SIMULATED_SELL', positionId: 'wide', mint: 'wide-mint', paperLane: 'wide', observedAt: 4_000, exitPriceUsd: 0.8, pnlPercent: -20 },
    ]));
    const result = buildRunCashflow(dir, { startingCashUsd: 20, stakeUsd: 5, lane: 'safe' });
    assert.equal(result.lane, 'safe');
    assert.equal(result.closedTrades, 1);
    assert.equal(result.trades[0].symbol, 'SAFE');
    assert.equal(result.ledger.every(event => event.lane === 'safe'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRunCashflow keeps an incomplete live position open and ignores malformed JSONL lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'simulation-cashflow-'));
  try {
    writeFileSync(join(dir, 'simulated-trades.jsonl'), `${JSON.stringify({ type: 'SIMULATED_BUY', positionId: 'open', mint: 'mint-open', observedAt: 1_000, entryPriceUsd: 1 })}\nnot-json\n`);
    const result = buildRunCashflow(dir, { startingCashUsd: 6, stakeUsd: 5 });
    assert.equal(result.closedTrades, 0);
    assert.equal(result.openTrades, 1);
    assert.ok(Math.abs(result.endingCashUsd - 0.7937392) < 1e-9);
    assert.ok(Math.abs(result.endingEquityUsd - 5.9754) < 1e-9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
