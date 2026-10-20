import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionMomentumScalpLane,
  DistributionMomentumTrendLane,
  M_SCALP_RULES,
  M_TREND_RULES,
} from '../src/distribution-evolved-momentum-lanes.js';
import type { TargetFacts, TargetPaperEvent, TargetEvent } from '../src/distribution-target-lane.js';

function baseFacts(now: number, price: number, mcap: number, buyers = 5, buyUsd = 100): TargetFacts {
  return {
    now,
    transferAt: now - 35000,
    firstAt: now - 20000,
    price,
    priceAt: now,
    momentumPercent: 5.0,
    drawdownPercent: 1.0,
    entryReturnPercent: 0,
    holderCount: 50,
    holderGrowth15s: 5,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: buyUsd,
    meaningfulBuyers: buyers,
    topBuyerSharePercent: 30,
    sellUsd: 10,
    largestSellUsd: 10,
    riskWalletsPresent: [],
    peakPrice: price,
    troughPrice: price * 0.98,
    troughAgeSeconds: 10,
    troughAt: now - 10000,
    bounceFromTroughPercent: 2.0,
    devWallet: 'test',
    devBalance: 0,
    devHoldingSharePercent: 5,
    holderDeclineEverSeen: false,
  };
}

test('M-Scalp rejects low mcap (< $15k) and weak buy flow', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumScalpLane('MintScalp1', e => events.push(e));

  const now = 100000;
  // Mcap $12k -> reject
  const lowMcapFacts = baseFacts(now, 0.000012, 12000);
  lane.step(lowMcapFacts);
  const entrySignals = events.filter(e => e.type === 'PAPER_ENTRY_SIGNAL');
  assert.equal(entrySignals.length, 0);

  // Mcap $16k tapi buyer cuma 2 -> reject
  const weakFlowFacts = baseFacts(now, 0.000016, 16000, 2, 20);
  lane.step(weakFlowFacts);
  assert.equal(events.filter(e => e.type === 'PAPER_ENTRY_SIGNAL').length, 0);
});

test('M-Scalp enters on high quality flow and triggers trailing exit', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumScalpLane('MintScalp2', e => events.push(e));

  let now = 100000;
  const goodFacts = baseFacts(now, 0.000020, 20000, 5, 80);

  // Step confirmSeconds: 2 + delay
  lane.step({ ...goodFacts, now, priceAt: now });
  now += 1000;
  lane.step({ ...goodFacts, now, priceAt: now });
  now += 1100;
  lane.step({ ...goodFacts, now, priceAt: now }); // ENTRY_PENDING
  now += 1200; // > executionDelayMs
  lane.step({ ...goodFacts, now, priceAt: now }); // FILLS into OPEN

  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, 0.000020);

  const buySignal = events.find(e => e.type === 'PAPER_ENTRY_SIGNAL');
  assert.ok(buySignal, 'Harus memicu PAPER_ENTRY_SIGNAL');
  assert.equal((buySignal as any).laneLabel, 'M-Scalp');

  // Simulasi naik +10% (memicu trailing start +8%)
  now += 10000;
  const rallyFacts: TargetFacts = {
    ...goodFacts,
    now,
    price: 0.000022,
    priceAt: now,
    peakPrice: 0.000022,
  };
  lane.step(rallyFacts);

  // Drop -3% dari peak (memicu trailing drawdown exit 2.5%)
  now += 1000;
  const dropFacts: TargetFacts = {
    ...rallyFacts,
    now,
    price: 0.0000213,
    priceAt: now,
  };
  lane.step(dropFacts); // Triggers EXIT_PENDING

  const exitSignal = events.find(e => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitSignal, 'Harus memicu trailing profit exit');

  // Fill exit
  now += 1200;
  lane.step({ ...dropFacts, now, priceAt: now });
  assert.equal(lane.phase, 'CLOSED');
});

test('M-Trend rejects mcap < $20k and buyers < 5', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionMomentumTrendLane('MintTrend1', e => events.push(e));

  const now = 100000;
  // Mcap $18k -> reject
  const lowMcapFacts = baseFacts(now, 0.000018, 18000, 6, 120);
  lane.step(lowMcapFacts);
  assert.equal(events.filter(e => e.type === 'PAPER_ENTRY_SIGNAL').length, 0);

  // Mcap $25k tapi buyers cuma 3 -> reject
  const weakBuyersFacts = baseFacts(now, 0.000025, 25000, 3, 150);
  lane.step(weakBuyersFacts);
  assert.equal(events.filter(e => e.type === 'PAPER_ENTRY_SIGNAL').length, 0);
});
