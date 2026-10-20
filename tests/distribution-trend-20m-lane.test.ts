import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionTrend20mLane,
  DistributionTrendConsLane,
  DistributionTrendBalLane,
  DistributionTrendWideLane,
  DistributionTrendRunLane,
  TREND_20M_RULES,
} from '../src/distribution-trend-20m-lane.js';
import type { TargetFacts, TargetEvent } from '../src/distribution-target-lane.js';

function baseFacts(overrides: Partial<TargetFacts> = {}): TargetFacts {
  const now = 1_700_000_000_000;
  return {
    now,
    firstAt: now - 35_000,
    transferAt: now - 1_500_000, // 25 menit lalu (> 20m)
    price: 0.000015, // $15k MC (<= $25k max Entry Mcap)
    priceAt: now,
    momentumPercent: 1.5,
    drawdownPercent: 2.0,
    entryReturnPercent: 2.0,
    holderCount: 150, // >= 100
    holderGrowth15s: 2, // Positif
    buyShareUsdPercent: 70, // >= 50%
    meaningfulBuyUsd: 50,
    meaningfulBuyers: 4,
    topBuyerSharePercent: 30,
    sellUsd: 20,
    largestSellUsd: 10,
    riskWalletsPresent: [],
    holderDeclineEverSeen: false,
    ...overrides,
  };
}

function establishOpenPosition(lane: DistributionTrend20mLane, startNow = 1_700_000_000_000, price = 0.000015): number {
  let now = startNow;
  lane.step(baseFacts({ now, price, priceAt: now }));
  now += 1000;
  lane.step(baseFacts({ now, price, priceAt: now }));
  now += 1100;
  lane.step(baseFacts({ now, price, priceAt: now })); // ENTRY_PENDING at 3100
  now += 1200; // > executionDelayMs (1000ms)
  lane.step(baseFacts({ now, price, priceAt: now })); // Fills and enters OPEN
  assert.equal(lane.phase, 'OPEN');
  assert.equal(lane.entryPrice, price);
  return now;
}

test('Trend20mLane rejects token younger than 20 minutes', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintYoung11111111111111111111111111111111', (e) => events.push(e));

  const now = 1_700_000_000_000;
  const f = baseFacts({
    now,
    transferAt: now - 600_000, // Baru 10 menit
  });

  lane.step(f);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'PAPER_ENTRY_DECISION');
  assert.equal(events[0]?.allowed, false);
  const reasons = (events[0] as any)?.reasons || [];
  assert.ok(reasons.includes('TOKEN_AGE_LESS_THAN_20M'));
});

test('Trend20mLane rejects token with holders less than 100', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintHoldersFew11111111111111111111111111111', (e) => events.push(e));

  const now = 1_700_000_000_000;
  const f = baseFacts({
    now,
    holderCount: 85, // Di bawah 100
  });

  lane.step(f);
  assert.equal(events[0]?.type, 'PAPER_ENTRY_DECISION');
  assert.equal(events[0]?.allowed, false);
  const reasons = (events[0] as any)?.reasons || [];
  assert.ok(reasons.includes('HOLDERS_LESS_THAN_100'));
});

test('Trend20mLane rejects token with Entry Market Cap > $25k', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintMcapHigh1111111111111111111111111111111', (e) => events.push(e));

  const now = 1_700_000_000_000;
  const f = baseFacts({
    now,
    price: 0.000035, // $35k MC (> $25k)
  });

  lane.step(f);
  assert.equal(events[0]?.type, 'PAPER_ENTRY_DECISION');
  assert.equal(events[0]?.allowed, false);
  const reasons = (events[0] as any)?.reasons || [];
  assert.ok(reasons.includes('ENTRY_MCAP_TOO_HIGH'));
});

test('Trend20mLane enters and holds when reaching 25% profit while holders are growing', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintGrowth111111111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Harga naik 25% (0.00001875), holder terus bertambah
  now += 30_000;
  lane.step(baseFacts({
    now,
    price: 0.00001875, // +25%
    priceAt: now,
    holderCount: 220,
    holderGrowth15s: 5, // Bertambah sehat
    holderDeclineEverSeen: false,
  }));

  // Posisi HARUS tetap OPEN (tidak buru-buru cut, let winners run!)
  assert.equal(lane.phase, 'OPEN');
});

test('Trend20mLane takes profit at 20%+ when holders start declining', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintDecline11111111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Harga naik 22% (0.0000183), tapi holder tiba-tiba dump / decline!
  now += 20_000;
  lane.step(baseFacts({
    now,
    price: 0.0000183, // +22%
    priceAt: now,
    holderCount: 180,
    holderGrowth15s: -4, // Penurunan drastis
    holderDeclineEverSeen: true,
  }));

  // Harus trigger EXIT amankan profit minimal 20%
  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.equal(exitEvent?.reason, 'HOLDER_DECLINING_TAKE_PROFIT_20');
});

test('Trend20mLane locks profit floor at +15% if price drops after hitting +25%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintFloor111111111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Naik ke +25%
  now += 30_000;
  lane.step(baseFacts({ now, price: 0.00001875, priceAt: now, holderGrowth15s: 2 }));
  assert.equal(lane.phase, 'OPEN');

  // Kemudian pullback turun ke +14.5% (di bawah profit floor 15% atau kena trailing)
  now += 10_000;
  lane.step(baseFacts({ now, price: 0.000017175, priceAt: now, holderGrowth15s: 1 }));
  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.ok(exitEvent?.reason === 'PROFIT_FLOOR_SECURED_15' || exitEvent?.reason === 'TRAILING_PROFIT_ABOVE_20');
});

test('Trend20mLane executes trailing stop above 60% on 4% pullback', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintTrail111111111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Token meledak naik 70% (0.0000255)
  now += 60_000;
  lane.step(baseFacts({ now, price: 0.0000255, priceAt: now, holderGrowth15s: 3 }));
  assert.equal(lane.phase, 'OPEN');

  // Pullback 5% dari peak (turun ke 0.000024225 = +61.5%, drawdown >= 4%)
  now += 5_000;
  lane.step(baseFacts({ now, price: 0.000024225, priceAt: now, holderGrowth15s: 1 }));
  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.equal(exitEvent?.reason, 'TRAILING_PROFIT_ABOVE_60');
});

test('Trend20mLane hits Stop Loss at -7%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintSL111111111111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Drop ke -8% (0.0000138 <= -7%)
  now += 15_000;
  lane.step(baseFacts({ now, price: 0.0000138, priceAt: now }));
  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.equal(exitEvent?.reason, 'STOP_LOSS_7PCT');
});

test('Trend20mLane closes after 40 minutes (2400s) timeout', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrend20mLane('MintTimeout1111111111111111111111111111111', (e) => events.push(e));

  let now = establishOpenPosition(lane);

  // Waktu berlalu 2401 detik (40 menit lebih)
  now += 2401 * 1000;
  lane.step(baseFacts({ now, price: 0.0000155, priceAt: now }));
  assert.equal(lane.phase, 'EXIT_PENDING');
  const exitEvent = events.find((e) => e.type === 'PAPER_EXIT_SIGNAL');
  assert.ok(exitEvent);
  assert.ok(exitEvent?.reason === 'MAX_HOLD' || exitEvent?.reason === 'MAX_HOLD_TIMEOUT_40M');
});

test('4 Dedicated Trend 20m Lanes apply distinct risk & market cap rules', () => {
  const eventsCons: TargetEvent[] = [];
  const eventsBal: TargetEvent[] = [];
  const eventsWide: TargetEvent[] = [];
  const eventsRun: TargetEvent[] = [];

  const laneCons = new DistributionTrendConsLane('Mint4Lane1111111111111111111111111111111', (e) => eventsCons.push(e));
  const laneBal = new DistributionTrendBalLane('Mint4Lane1111111111111111111111111111111', (e) => eventsBal.push(e));
  const laneWide = new DistributionTrendWideLane('Mint4Lane1111111111111111111111111111111', (e) => eventsWide.push(e));
  const laneRun = new DistributionTrendRunLane('Mint4Lane1111111111111111111111111111111', (e) => eventsRun.push(e));

  const now = 1_700_000_000_000;

  // Case 1: Token dengan Market Cap $18k (0.000018)
  // T-Cons: Rejects (> $15k)
  // T-Bal, T-Wide, T-Run: Lolos kriteria MC
  const f18k = baseFacts({ now, price: 0.000018, priceAt: now });
  laneCons.step(f18k);
  laneBal.step(f18k);
  laneWide.step(f18k);
  laneRun.step(f18k);

  assert.equal(eventsCons[0]?.type, 'PAPER_ENTRY_DECISION');
  assert.equal(eventsCons[0]?.allowed, false);
  assert.ok(((eventsCons[0] as any)?.reasons || []).includes('ENTRY_MCAP_TOO_HIGH'));
  assert.equal(eventsCons[0]?.laneLabel, 'T-Cons');

  // Bal, Wide, Run belum reject (tidak ada event rejeksi)
  assert.equal(eventsBal.length, 0);
  assert.equal(eventsWide.length, 0);
  assert.equal(eventsRun.length, 0);

  // Stepping 3 detik untuk konfirmasi sinyal entry
  for (let i = 1; i <= 3; i++) {
    const stepF = baseFacts({ now: now + i * 1000, price: 0.000018, priceAt: now + i * 1000 });
    laneBal.step(stepF);
    laneWide.step(stepF);
    laneRun.step(stepF);
  }

  // Verifikasi sinyal entry & buy ter-emit dengan label masing-masing
  assert.ok(eventsBal.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Bal'));
  assert.ok(eventsWide.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Wide'));
  assert.ok(eventsRun.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Run'));

  // Case 2: Token dengan Market Cap $30k (0.000030)
  // T-Bal: Rejects (> $25k)
  // T-Wide & T-Run: Tetap lolos
  const eventsBal2: TargetEvent[] = [];
  const laneBal2 = new DistributionTrendBalLane('MintMcap30k', (e) => eventsBal2.push(e));
  laneBal2.step(baseFacts({ now, price: 0.000030, priceAt: now }));
  assert.equal(eventsBal2[0]?.type, 'PAPER_ENTRY_DECISION');
  assert.equal(eventsBal2[0]?.allowed, false);
  assert.ok(((eventsBal2[0] as any)?.reasons || []).includes('ENTRY_MCAP_TOO_HIGH'));
  assert.equal(eventsBal2[0]?.laneLabel, 'T-Bal');
});
