import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DistributionTrend20mLane,
  DistributionTrendBaseLane,
  DistributionTrendConsLane,
  DistributionTrendBalLane,
  DistributionTrendWideLane,
  DistributionTrendRunLane,
  DistributionTrendGoldenLane,
  TREND_20M_GOLDEN_RULES,
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

test('Trend20mLane rejects token with Entry Market Cap > $25k when configured with MC cap', () => {
  const events: TargetEvent[] = [];
  const customRules = { ...TREND_20M_RULES, maxMarketCapUsd: 25000 };
  const lane = new DistributionTrendBaseLane('MintMcapHigh1111111111111111111111111111111', customRules, 'Trend20m', 20.0, (e) => events.push(e));

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
  // Seluruh lane (T-Cons, T-Bal, T-Wide, T-Run) lolos kriteria MC (tanpa batas MC atas)
  const f18k = baseFacts({ now, price: 0.000018, priceAt: now });
  laneCons.step(f18k);
  laneBal.step(f18k);
  laneWide.step(f18k);
  laneRun.step(f18k);

  // Tidak ada rejection MC pada f18k
  assert.equal(eventsCons.length, 0);
  assert.equal(eventsBal.length, 0);
  assert.equal(eventsWide.length, 0);
  assert.equal(eventsRun.length, 0);

  // Stepping 3 detik untuk konfirmasi sinyal entry
  for (let i = 1; i <= 3; i++) {
    const stepF = baseFacts({ now: now + i * 1000, price: 0.000018, priceAt: now + i * 1000 });
    laneCons.step(stepF);
    laneBal.step(stepF);
    laneWide.step(stepF);
    laneRun.step(stepF);
  }

  // Verifikasi sinyal entry & buy ter-emit dengan label masing-masing
  assert.ok(eventsCons.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Cons'));
  assert.ok(eventsBal.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Bal'));
  assert.ok(eventsWide.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Wide'));
  assert.ok(eventsRun.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Run'));

  // Case 2: Token dengan Market Cap $30k (0.000030)
  // T-Bal & lanes lain tetap lolos tanpa rejection MC
  const eventsBal2: TargetEvent[] = [];
  const laneBal2 = new DistributionTrendBalLane('MintMcap30k', (e) => eventsBal2.push(e));
  laneBal2.step(baseFacts({ now, price: 0.000030, priceAt: now }));
  assert.equal(eventsBal2.length, 0);
});

test('T-Golden applies loop-engineered gates: Mcap $50k-$500k, buyers >= 5, buyShare >= 40% and trailing profit', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendGoldenLane('MintGolden1111111111111111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;

  // 1. Rejects if Mcap < $50k ($20k = 0.000020)
  lane.step(baseFacts({ now, price: 0.000020, priceAt: now, meaningfulBuyers: 6, buyShareUsdPercent: 50.0 }));
  assert.ok(events.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('ENTRY_MCAP_TOO_LOW')));

  // Reset lane
  const events2: TargetEvent[] = [];
  const lane2 = new DistributionTrendGoldenLane('MintGolden2222222222222222222222222222222', (e) => events2.push(e));

  // 2. Rejects if Buyers < 5 (e.g. 3 buyers)
  lane2.step(baseFacts({ now, price: 0.000100, priceAt: now, meaningfulBuyers: 3, buyShareUsdPercent: 50.0 }));
  assert.ok(events2.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('NOT_ENOUGH_BUYERS')));

  // 3. Enters when Mcap $100k, buyers 6, buyShare 50%
  const events3: TargetEvent[] = [];
  const lane3 = new DistributionTrendGoldenLane('MintGolden3333333333333333333333333333333', (e) => events3.push(e));
  let curTime = now;
  for (let i = 0; i < 5; i++) {
    lane3.step(baseFacts({
      now: curTime,
      price: 0.000100,
      priceAt: curTime,
      meaningfulBuyers: 6,
      buyShareUsdPercent: 50.0,
      meaningfulBuyUsd: 100
    }));
    curTime += 1100;
  }
  assert.ok(events3.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Golden'));

  // 4. Test trailing exit on +20% pump followed by 5% pullback
  const buyEvent = events3.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000100;

  // Pump to +20%
  curTime += 2000;
  lane3.step(baseFacts({ now: curTime, price: entryPrice * 1.20, priceAt: curTime, meaningfulBuyers: 6 }));
  // Pullback to +15% (5% drop from peak > 4% trailing pullback)
  curTime += 2000;
  lane3.step(baseFacts({ now: curTime, price: entryPrice * 1.15, priceAt: curTime, meaningfulBuyers: 6 }));

  assert.ok(events3.some((e) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && (e as any).reason?.startsWith('TRAILING_PROFIT')));
});
