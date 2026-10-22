import test from 'node:test';
import assert from 'node:assert/strict';
import { DistributionBounceLane, DistributionBounceLaneV2, DistributionBounceLaneV3, DistributionBounceLaneV5, DistributionBounceLaneV6, DistributionBounceLaneV7, BOUNCE_RULES, BOUNCE_RULES_V2, BOUNCE_RULES_V3, BOUNCE_RULES_V5, BOUNCE_RULES_V6, BOUNCE_RULES_V7, BOUNCE_TARGET_PERCENT } from '../src/distribution-bounce-lane.js';
import type { TargetEvent, TargetFacts } from '../src/distribution-target-lane.js';

const mockFacts = (now = 100000, price = 1, extra: Partial<TargetFacts> = {}): TargetFacts => ({
  now,
  transferAt: 0,
  firstAt: 1000,
  price,
  priceAt: now,
  momentumPercent: 1,
  drawdownPercent: 0,
  entryReturnPercent: 0,
  holderCount: 100,
  holderGrowth15s: 1,
  buyShareUsdPercent: 60,
  meaningfulBuyUsd: 25,
  meaningfulBuyers: 2,
  topBuyerSharePercent: 50,
  sellUsd: 5,
  largestSellUsd: 0,
  riskWalletsPresent: [],
  bounceFromTroughPercent: 0,
  ...extra,
});

test('DistributionBounceLane waits for severe dump and bounce before entering', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLane('mint1', e => events.push(e));

  // 1. Initial observation: No dump yet -> rejected
  lane.step(mockFacts(100000, 1.0, { drawdownPercent: 10, bounceFromTroughPercent: 0 }));
  assert.equal(lane.phase, 'WATCHING');
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), false);

  // 2. Token dumps severely (drawdown 60%), but still at bottom without bounce -> rejected
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 0.5 }));
  assert.equal(lane.phase, 'WATCHING');

  // 3. Token starts to bounce (+4% from trough) with good buy flow -> ENTRY triggered
  lane.step(mockFacts(102000, 0.42, { drawdownPercent: 58, bounceFromTroughPercent: 5.0, buyShareUsdPercent: 70, meaningfulBuyUsd: 15 }));
  lane.step(mockFacts(103000, 0.42, { drawdownPercent: 58, bounceFromTroughPercent: 5.0, buyShareUsdPercent: 70, meaningfulBuyUsd: 15 }));

  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, 0.42);
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), true);
});

test('DistributionBounceLane takes profit at 14-18% gain', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLane('mint2', e => events.push(e));

  // Setup entry after dump
  lane.step(mockFacts(100000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  assert.equal(lane.phase, 'OPEN');

  // Price surges by +20% (e.g. from 0.40 to 0.48)
  lane.step(mockFacts(102000, 0.48));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(103000, 0.48));
  assert.equal(lane.phase, 'CLOSED');
  assert.ok(lane.netReturnPercent! >= 14);
  assert.ok(['TARGET_BOUNCE_16', 'TARGET_NET'].includes(events.at(-1)?.reason!));
});

test('DistributionBounceLane exits when stagnant without movement after dump', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLane('mint3', e => events.push(e));

  // Enter
  lane.step(mockFacts(100000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5 }));
  assert.equal(lane.phase, 'OPEN');

  // Hold past 90 seconds with no price change (<1% move)
  lane.step(mockFacts(150000, 0.401)); // 50s
  assert.equal(lane.phase, 'OPEN');

  lane.step(mockFacts(200000, 0.401)); // 100s, stagnant for >60s
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(201000, 0.401));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'STAGNANT_NO_MOVEMENT_AFTER_DUMP');
});

test('DistributionBounceLaneV2 blocks entry if whale sell >= 300 USD is present', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV2('mint-v2-whale', e => events.push(e));

  // Bounce conditions met, but whale sell is $350
  lane.step(mockFacts(100000, 0.42, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 5.0,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
    largestSellUsd: 350,
  }));
  lane.step(mockFacts(101000, 0.42, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 5.0,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
    largestSellUsd: 350,
  }));

  assert.equal(lane.phase, 'WATCHING');
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), false);
});

test('DistributionBounceLaneV2 triggers emergency exit on large whale sell >= 75 USD during hold', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV2('mint-v2-dump', e => events.push(e));

  // Valid entry (clean sell flow)
  lane.step(mockFacts(100000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 20 }));
  lane.step(mockFacts(101000, 0.4, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 20 }));
  assert.equal(lane.phase, 'OPEN');

  // Whale sells $80 while holding
  lane.step(mockFacts(102000, 0.41, { largestSellUsd: 80 }));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(103000, 0.41));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'EMERGENCY_WHALE_SELL_EXIT');
});

test('DistributionBounceLaneV2 triggers profit lock exit when peak >= 5.5% reverses', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV2('mint-v2-lock', e => events.push(e));

  // Entry at 0.40
  lane.step(mockFacts(100000, 0.40, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 10 }));
  lane.step(mockFacts(101000, 0.40, { drawdownPercent: 60, bounceFromTroughPercent: 5, largestSellUsd: 10 }));
  assert.equal(lane.phase, 'OPEN');

  // Price surges to 0.45 (+12.5% gain) -> peak records +9.5% net
  lane.step(mockFacts(102000, 0.45, { largestSellUsd: 10 }));
  assert.equal(lane.phase, 'OPEN');

  // Price pulls back to 0.405 (+1.25% gain, triggers breakeven lock)
  lane.step(mockFacts(103000, 0.405, { largestSellUsd: 10 }));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(104000, 0.405, { largestSellUsd: 10 }));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'BREAKEVEN_PROFIT_LOCK');
});

test('DistributionBounceLaneV3 rejects overextended bounce > 15% and insufficient buyers < 2', () => {
  const events: TargetEvent[] = [];
  const laneOverextended = new DistributionBounceLaneV3('mint-v3-over', e => events.push(e));

  // Overextended bounce: 20% from trough
  laneOverextended.step(mockFacts(100000, 0.48, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 20.0,
    meaningfulBuyers: 10,
    buyShareUsdPercent: 70,
  }));
  assert.equal(laneOverextended.phase, 'WATCHING');
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), false);

  // Insufficient buyers: only 1 buyer (wash trade)
  const laneFewBuyers = new DistributionBounceLaneV3('mint-v3-few', e => events.push(e));
  laneFewBuyers.step(mockFacts(100000, 0.42, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 1,
    buyShareUsdPercent: 70,
  }));
  assert.equal(laneFewBuyers.phase, 'WATCHING');
  assert.equal(events.some(e => e.type === 'PAPER_BUY'), false);
});

test('DistributionBounceLaneV3 takes quick profit at 14-15% gain', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV3('mint-v3-win', e => events.push(e));

  // Entry in early bounce zone (6% from trough) with 12 buyers
  lane.step(mockFacts(100000, 0.40, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 12,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
  }));
  lane.step(mockFacts(101000, 0.40, {
    drawdownPercent: 60,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 12,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
  }));
  assert.equal(lane.phase, 'OPEN');

  // Price surges to 0.47 (+17.5% net) -> Take Profit triggers
  lane.step(mockFacts(102000, 0.47));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(103000, 0.47));
  assert.equal(lane.phase, 'CLOSED');
  assert.ok(['TARGET_BOUNCE_15', 'TARGET_NET'].includes(events.at(-1)?.reason!));
});

test('DistributionBounceLaneV5 Solusi 2 Gate 1: blocks entry if dev still holds supply (Claude AI pattern)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-dev-trap', e => events.push(e));

  // Severe dump observed (drawdown 80%)
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 80,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 20,
    // Dev still holds 82% supply (Claude AI trap)
    devHoldingSharePercent: 82.0,
    devBalance: 820_000_000,
  }));

  assert.equal(lane.phase, 'WATCHING');
  const lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('DEV_STILL_HOLDING_SUPPLY_DUMP_RISK'));
});

test('DistributionBounceLaneV5 Solusi 2 Gate 2: blocks entry if rapid holder decline was seen (Taylor pattern)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-taylor-flight', e => events.push(e));

  // Token dumped 78% and bounced, but holder decline ever seen (bundler wallet exodus)
  lane.step(mockFacts(100000, 0.22, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 25,
    devHoldingSharePercent: 0,
    devBalance: 0,
    holderDeclineEverSeen: true,
  }));

  assert.equal(lane.phase, 'WATCHING');
  const lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('HOLDERS_DECLINING_FLIGHT_RISK'));
});

test('DistributionBounceLaneV5 Solusi 2 Gate 3: blocks entry if large whale sell active in window', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-whale-active', e => events.push(e));

  // Token bounced, dev balance 0, but whale sell $200 active in window
  lane.step(mockFacts(100000, 0.25, {
    drawdownPercent: 76,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 65,
    meaningfulBuyUsd: 15,
    devHoldingSharePercent: 0,
    devBalance: 0,
    largestSellUsd: 200,
  }));

  assert.equal(lane.phase, 'WATCHING');
  const lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('WHALE_SELL_ACTIVE_IN_WINDOW'));
});

test('DistributionBounceLaneV5 enters clean staircase bounce when dev balance 0 and steady flow (Mr Beast / Grok)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-clean-win', e => events.push(e));

  // Step 1: Severe dump observed (drawdown 78%), trough established at 0.20, starts bounce to 0.21 (+5%)
  lane.step(mockFacts(100000, 0.21, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 20,
    topBuyerSharePercent: 40,
    devHoldingSharePercent: 0,
    devBalance: 0,
    holderDeclineEverSeen: false,
    holderGrowth15s: 2,
    largestSellUsd: 10,
  }));
  assert.equal(lane.phase, 'WATCHING');

  // Step 2: Dwell time 3.5 seconds later, price holds steady at 0.212 -> staircase confirmed
  lane.step(mockFacts(103500, 0.212, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
    topBuyerSharePercent: 35,
    devHoldingSharePercent: 0,
    devBalance: 0,
    holderDeclineEverSeen: false,
    holderGrowth15s: 3,
    largestSellUsd: 5,
  }));

  // Step 3: Confirm execution delay -> OPEN
  lane.step(mockFacts(104600, 0.212, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'OPEN');

  // Step 4: Price reaches target +20-22% gain -> TARGET_BOUNCE_20_22
  lane.step(mockFacts(106000, 0.27)); // clean target gain
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(107100, 0.27));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'TARGET_BOUNCE_20_22');
});

test('DistributionBounceLaneV5 enforces hard-cap rugpull loss protection if flash dump occurs', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-hard-cap', e => events.push(e));

  // Enter clean position
  lane.step(mockFacts(100000, 0.21, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 20,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(103500, 0.212, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(104600, 0.212));
  assert.equal(lane.phase, 'OPEN');

  // Sudden catastrophic dump to 0.10 (-52% net)
  lane.step(mockFacts(106000, 0.10));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(107100, 0.10));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'HARD_CAP_RUGPULL_PROTECTION');
});

test('DistributionBounceLaneV5 blocks entry during 45s whale sell cooldown (FOMO pattern)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-whale-cooldown', e => events.push(e));

  // T = 100s: Whale sell $180 occurs (largestSellUsd = 180)
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 70,
    meaningfulBuyUsd: 15,
    devHoldingSharePercent: 0,
    devBalance: 0,
    largestSellUsd: 180,
  }));
  assert.equal(lane.phase, 'WATCHING');
  let lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('WHALE_SELL_ACTIVE_IN_WINDOW'));

  // T = 120s (20s later): Price is trying to bounce, current largestSellUsd is small ($10), but 45s cooldown is still active
  lane.step(mockFacts(120000, 0.21, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 20,
    devHoldingSharePercent: 0,
    devBalance: 0,
    largestSellUsd: 10,
  }));
  assert.equal(lane.phase, 'WATCHING');
  lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('WHALE_SELL_COOLDOWN_ACTIVE'));
});

test('DistributionBounceLaneV5 locks profit at +15% when pullback occurs from +19% peak (DeepSeek pattern)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV5('mint-v5-deepseek-lock', e => events.push(e));

  // Enter clean position at 0.20
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 20,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(103500, 0.202, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(104600, 0.202));
  assert.equal(lane.phase, 'OPEN');

  // Price surges to 0.245 (peak net ~ +18.4%)
  lane.step(mockFacts(106000, 0.245));
  assert.equal(lane.phase, 'OPEN');

  // Pullback drops to 0.235 (net ~ +13.5%, trailing drop is > 4% from peak)
  lane.step(mockFacts(107000, 0.235));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(108100, 0.235));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'PROFIT_LOCK_15_EXIT');
});

test('DistributionBounceLaneV6 blocks entry when recovery volume < $18 or buyers < 3 (thin pool protection)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV6('mint-v6-thin-pool', e => events.push(e));

  // T = 100s: Severe dump occurred (78%), but meaningful buyers only 2 and volume only $10 -> rejected
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 2, // V6 requires 3+
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 10, // V6 requires $18+
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  assert.equal(lane.phase, 'WATCHING');
  let lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('BUY_FLOW_NOT_RECOVERED'));
  assert.ok((lastDecision?.reasons as string[]).includes('INSUFFICIENT_BUYERS_NEED_MULTI_WALLET'));
});

test('DistributionBounceLaneV6 enters when recovery volume >= $18 with 3+ buyers and takes profit at +20-22%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV6('mint-v6-clean-flow', e => events.push(e));

  // T = 100s: Initial step with solid volume ($25) and 4 buyers
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 25,
    topBuyerSharePercent: 35,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(103500, 0.202, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
    topBuyerSharePercent: 35,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(104600, 0.202, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'OPEN');

  // Price surges to 0.27 (net gain >= +20%) -> triggers TARGET_BOUNCE_20_22
  lane.step(mockFacts(106000, 0.27));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(107100, 0.27));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'TARGET_BOUNCE_20_22');
});

test('DistributionBounceLaneV7 Gate 3: blocks entry on staggered multi-wave whale dumps (TRALA pattern)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV7('mint-v7-staggered-whale', e => events.push(e));

  // Whale Sell Wave 1 at T = 100s ($500)
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    largestSellUsd: 500,
    meaningfulBuyers: 4,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'WATCHING');

  // Whale Sell Wave 2 at T = 120s ($400)
  lane.step(mockFacts(120000, 0.18, {
    drawdownPercent: 80,
    bounceFromTroughPercent: 4.0,
    largestSellUsd: 400,
    meaningfulBuyers: 4,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'WATCHING');

  // T = 180s (60s after 2nd sell): Price attempts to bounce, but staggered dump pattern is flagged
  lane.step(mockFacts(180000, 0.19, {
    drawdownPercent: 79,
    bounceFromTroughPercent: 5.5,
    largestSellUsd: 10,
    meaningfulBuyers: 4,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'WATCHING');
  const lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('STAGGERED_WHALE_DUMP_ACTIVE'));
});

test('DistributionBounceLaneV7 Gate 3: enforces 60s cooldown for large dump >= $2,000 (MarsX pattern)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV7('mint-v7-cooldown-60s', e => events.push(e));

  // Massive Dump $2,500 occurs at T = 100s
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    largestSellUsd: 2500,
  }));
  assert.equal(lane.phase, 'WATCHING');

  // At T = 150s (50s later): in V6 (45s) this would be allowed, but V7 enforces 60s cooldown for >= $2k
  lane.step(mockFacts(150000, 0.21, {
    drawdownPercent: 77,
    bounceFromTroughPercent: 5.0,
    largestSellUsd: 10,
    meaningfulBuyers: 4,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'WATCHING');
  let lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('WHALE_SELL_COOLDOWN_ACTIVE'));

  // At T = 165s (65s later): Cooldown elapsed -> allowed to initiate staircase
  lane.step(mockFacts(165000, 0.21, {
    drawdownPercent: 77,
    bounceFromTroughPercent: 5.0,
    largestSellUsd: 10,
    meaningfulBuyers: 4,
    meaningfulBuyUsd: 30,
    topBuyerSharePercent: 35,
  }));
  lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('STAIRCASE_WAITING_CONFIRMATION'));
});

test('DistributionBounceLaneV7 Gate 5: blocks entry when meaningful buy volume < $22 (Anti-Wash filter)', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV7('mint-v7-anti-wash', e => events.push(e));

  // Token bounced, but meaningful buy volume is only $19 (< $22 required)
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 3,
    buyShareUsdPercent: 75,
    meaningfulBuyUsd: 19, // Under $22
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  assert.equal(lane.phase, 'WATCHING');
  const lastDecision = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');
  assert.ok((lastDecision?.reasons as string[]).includes('BUY_FLOW_NOT_RECOVERED'));
});

test('DistributionBounceLaneV7 enters clean staircase bounce and takes profit at +20-22%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionBounceLaneV7('mint-v7-win', e => events.push(e));

  // Step 1: Initial step with solid volume ($28) and 4 buyers
  lane.step(mockFacts(100000, 0.20, {
    drawdownPercent: 78,
    bounceFromTroughPercent: 5.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 28,
    topBuyerSharePercent: 35,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(103500, 0.202, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
    topBuyerSharePercent: 35,
    devHoldingSharePercent: 0,
    devBalance: 0,
  }));
  lane.step(mockFacts(104600, 0.202, {
    drawdownPercent: 77.8,
    bounceFromTroughPercent: 6.0,
    meaningfulBuyers: 4,
    buyShareUsdPercent: 80,
    meaningfulBuyUsd: 30,
  }));
  assert.equal(lane.phase, 'OPEN');

  // Step 2: Price surges to 0.27 (net gain >= +20%) -> triggers TARGET_BOUNCE_20_22
  lane.step(mockFacts(106000, 0.27));
  assert.equal(lane.phase, 'EXIT_PENDING');

  lane.step(mockFacts(107100, 0.27));
  assert.equal(lane.phase, 'CLOSED');
  assert.equal(events.at(-1)?.reason, 'TARGET_BOUNCE_20_22');
});


