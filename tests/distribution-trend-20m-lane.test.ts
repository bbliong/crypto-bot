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
  DistributionTrendSniperLane,
  DistributionTrendPhoenixLane,
  DistributionTrendAntiDumpLane,
  DistributionTrendTitanLane,
  DistributionTrendApexLane,
  TREND_20M_GOLDEN_RULES,
  TREND_20M_SNIPER_RULES,
  TREND_20M_PHOENIX_RULES,
  TREND_20M_ANTIDUMP_RULES,
  TREND_20M_TITAN_RULES,
  TREND_20M_APEX_RULES,
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

test('T-Sniper applies loop-engineered gates: buyers >= 7, buyShare >= 50%, SL 14%, Trailing 20/4', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendSniperLane('MintSniper1111111111111111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;

  // 1. Rejects if Buyers < 7 (e.g. 6 buyers)
  lane.step(baseFacts({ now, price: 0.000100, priceAt: now, meaningfulBuyers: 6, buyShareUsdPercent: 55.0 }));
  assert.ok(events.some((e: any) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('NOT_ENOUGH_BUYERS')));

  // 2. Enters when buyers >= 7 and buyShare >= 50%
  const events2: TargetEvent[] = [];
  const lane2 = new DistributionTrendSniperLane('MintSniper2222222222222222222222222222222', (e) => events2.push(e));
  let curTime = now;
  for (let i = 0; i < 5; i++) {
    lane2.step(baseFacts({
      now: curTime,
      price: 0.000100,
      priceAt: curTime,
      meaningfulBuyers: 7,
      buyShareUsdPercent: 55.0,
      meaningfulBuyUsd: 150
    }));
    curTime += 1100;
  }
  assert.ok(events2.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Sniper'));

  // 3. Stop loss triggers at -14%
  const buyEvent = events2.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000100;
  curTime += 2000;
  lane2.step(baseFacts({ now: curTime, price: entryPrice * 0.85, priceAt: curTime })); // -15% drop (>14% SL)
  assert.ok(events2.some((e: any) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && e.reason?.includes('STOP_LOSS')));
});

test('T-Phoenix applies loop-engineered gates: buyers >= 6, buyShare >= 40%, SL 15%, Trailing 25/6, TP 60%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendPhoenixLane('MintPhoenix1111111111111111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;

  // 1. Rejects if Mcap < $30k ($20k = 0.000020)
  lane.step(baseFacts({ now, price: 0.000020, priceAt: now, meaningfulBuyers: 6, buyShareUsdPercent: 50.0 }));
  assert.ok(events.some((e: any) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('ENTRY_MCAP_TOO_LOW')));

  // 2. Enters when buyers >= 6, buyShare >= 40%, Mcap >= $30k
  const events2: TargetEvent[] = [];
  const lane2 = new DistributionTrendPhoenixLane('MintPhoenix2222222222222222222222222222222', (e) => events2.push(e));
  let curTime = now;
  for (let i = 0; i < 5; i++) {
    lane2.step(baseFacts({
      now: curTime,
      price: 0.000100,
      priceAt: curTime,
      meaningfulBuyers: 6,
      buyShareUsdPercent: 45.0,
      meaningfulBuyUsd: 120
    }));
    curTime += 1100;
  }
  assert.ok(events2.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Phoenix'));

  // 3. Survives -13% dip (unlike T-Golden which dies at -10%), then pumps to +60%
  const buyEvent = events2.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000100;

  curTime += 2000;
  lane2.step(baseFacts({ now: curTime, price: entryPrice * 0.88, priceAt: curTime })); // -12% dip
  assert.equal(lane2.phase, 'OPEN', 'T-Phoenix must survive -12% dip because SL is -15%');

  // Then pump to +60%
  curTime += 2000;
  lane2.step(baseFacts({ now: curTime, price: entryPrice * 1.65, priceAt: curTime }));
  // Pullback from peak (+65% to +55%, >6% pullback)
  curTime += 2000;
  lane2.step(baseFacts({ now: curTime, price: entryPrice * 1.55, priceAt: curTime }));
  assert.ok(events2.some((e: any) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && e.reason?.includes('TRAILING_PROFIT')));
});

test('T-AntiDump rejects tokens where whale/dev dumped >= $100 before entry and passes clean tokens', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendAntiDumpLane('MintDump1111111111111111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;

  // 1. Rejects if largestSellUsd >= $100 (e.g. $150 whale sell)
  lane.step(baseFacts({
    now,
    price: 0.000080,
    priceAt: now,
    meaningfulBuyers: 8,
    buyShareUsdPercent: 50.0,
    largestSellUsd: 150.0,
  }));
  assert.ok(events.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('LARGEST_SELL_TOO_HIGH_WHALE_DUMP')));

  // 2. Enters when largestSellUsd < $100 (e.g. $25)
  const eventsClean: TargetEvent[] = [];
  const laneClean = new DistributionTrendAntiDumpLane('MintClean2222222222222222222222222222222', (e) => eventsClean.push(e));
  let curTime = now;
  for (let i = 0; i < 5; i++) {
    laneClean.step(baseFacts({
      now: curTime,
      price: 0.000080,
      priceAt: curTime,
      meaningfulBuyers: 8,
      buyShareUsdPercent: 50.0,
      meaningfulBuyUsd: 100,
      largestSellUsd: 25.0,
    }));
    curTime += 1100;
  }
  assert.ok(eventsClean.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-AntiDump'));
});

test('T-Titan enforces 83.3% WR setup: buyers >= 10, buyShare >= 65%, sell < $50 and locks profit at +20% ceiling', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendTitanLane('MintTitan1111111111111111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;

  // 1. Rejects if buyers < 10 (e.g. 8 buyers)
  lane.step(baseFacts({
    now,
    price: 0.000080,
    priceAt: now,
    meaningfulBuyers: 8,
    buyShareUsdPercent: 70.0,
    largestSellUsd: 20.0,
  }));
  assert.ok(events.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('NOT_ENOUGH_BUYERS')));

  // 2. Rejects if largestSellUsd >= $50 (e.g. $60 dump)
  const events2: TargetEvent[] = [];
  const lane2 = new DistributionTrendTitanLane('MintTitan2222222222222222222222222222222', (e) => events2.push(e));
  lane2.step(baseFacts({
    now,
    price: 0.000080,
    priceAt: now,
    meaningfulBuyers: 12,
    buyShareUsdPercent: 70.0,
    largestSellUsd: 60.0,
  }));
  assert.ok(events2.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('LARGEST_SELL_TOO_HIGH_WHALE_DUMP')));

  // 3. Rejects if FOMO gain too high (> 25%)
  const events3: TargetEvent[] = [];
  const lane3 = new DistributionTrendTitanLane('MintTitan3333333333333333333333333333333', (e) => events3.push(e));
  lane3.step(baseFacts({
    now,
    price: 0.000080,
    priceAt: now,
    meaningfulBuyers: 12,
    buyShareUsdPercent: 70.0,
    largestSellUsd: 20.0,
    entryReturnPercent: 30.0, // > 25% FOMO
  }));
  assert.ok(events3.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('FOMO_GAIN_TOO_HIGH_TOP_BUY')));

  // 4. Enters when all criteria pass and exits at TAKE_PROFIT_CEILING_20
  const events4: TargetEvent[] = [];
  const lane4 = new DistributionTrendTitanLane('MintTitan4444444444444444444444444444444', (e) => events4.push(e));
  let curTime = now;
  for (let i = 0; i < 5; i++) {
    lane4.step(baseFacts({
      now: curTime,
      price: 0.000080,
      priceAt: curTime,
      meaningfulBuyers: 11,
      buyShareUsdPercent: 68.0,
      meaningfulBuyUsd: 150,
      largestSellUsd: 20.0,
      entryReturnPercent: 10.0,
    }));
    curTime += 1100;
  }
  assert.ok(events4.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Titan'));

  const buyEvent = events4.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000080;

  // Pump to +21% (hits ceiling 20%)
  curTime += 2000;
  lane4.step(baseFacts({ now: curTime, price: entryPrice * 1.21, priceAt: curTime }));
  assert.ok(events4.some((e: any) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && e.reason === 'TAKE_PROFIT_CEILING_20'));
});

test('T-Apex enforces 70.0% WR setup: buyers >= 9, buyShare >= 60%, sell < $60, TP +30%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendApexLane('MintApex1111111111111111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;

  // 1. Rejects if buyers < 9 (e.g. 7 buyers)
  lane.step(baseFacts({
    now,
    price: 0.000080,
    priceAt: now,
    meaningfulBuyers: 7,
    buyShareUsdPercent: 65.0,
    largestSellUsd: 30.0,
  }));
  assert.ok(events.some((e) => e.type === 'PAPER_ENTRY_DECISION' && !e.allowed && e.reasons.includes('NOT_ENOUGH_BUYERS')));

  // 2. Enters and tests breakeven profit lock (peak +9% -> pullback to +3% triggers breakeven lock)
  const events2: TargetEvent[] = [];
  const lane2 = new DistributionTrendApexLane('MintApex2222222222222222222222222222222', (e) => events2.push(e));
  let curTime = now;
  for (let i = 0; i < 5; i++) {
    lane2.step(baseFacts({
      now: curTime,
      price: 0.000080,
      priceAt: curTime,
      meaningfulBuyers: 10,
      buyShareUsdPercent: 65.0,
      meaningfulBuyUsd: 150,
      largestSellUsd: 30.0,
      entryReturnPercent: 12.0,
    }));
    curTime += 1100;
  }
  assert.ok(events2.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Apex'));

  const buyEvent = events2.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000080;

  // Price peaks at +9% (trigger BE @ 8%)
  curTime += 2000;
  lane2.step(baseFacts({ now: curTime, price: entryPrice * 1.09, priceAt: curTime }));

  // Price pulls back to +3.0% (<= lock net 3.5%) -> triggers BREAKEVEN_PROFIT_LOCKED_8_4
  curTime += 2000;
  lane2.step(baseFacts({ now: curTime, price: entryPrice * 1.03, priceAt: curTime }));
  assert.ok(events2.some((e: any) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && e.reason?.includes('BREAKEVEN_PROFIT_LOCKED')));
});

test('T-AntiDump triggers Breakeven Profit Lock after +7% gain drops to +3.5%', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendAntiDumpLane('MintAntiDumpBE11111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;
  let curTime = now;

  for (let i = 0; i < 5; i++) {
    lane.step(baseFacts({
      now: curTime,
      price: 0.000080,
      priceAt: curTime,
      meaningfulBuyers: 9,
      buyShareUsdPercent: 55.0,
      meaningfulBuyUsd: 100,
      largestSellUsd: 25.0,
      entryReturnPercent: 10.0,
    }));
    curTime += 1100;
  }
  assert.ok(events.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-AntiDump'));
  const buyEvent = events.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000080;

  // Price peaks at +8% (trigger BE @ 7%)
  curTime += 2000;
  lane.step(baseFacts({ now: curTime, price: entryPrice * 1.08, priceAt: curTime }));

  // Price pulls back to +2.5% (<= lock net 3.5%) -> triggers BREAKEVEN_PROFIT_LOCKED_7_4
  curTime += 2000;
  lane.step(baseFacts({ now: curTime, price: entryPrice * 1.025, priceAt: curTime }));
  assert.ok(events.some((e: any) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && e.reason?.includes('BREAKEVEN_PROFIT_LOCKED_7_4')));
});

test('T-Titan triggers Emergency Whale Sell Exit on whale sell >= $50 during negative return', () => {
  const events: TargetEvent[] = [];
  const lane = new DistributionTrendTitanLane('MintTitanEmerg11111111111111111111', (e) => events.push(e));
  const now = 1_700_000_000_000;
  let curTime = now;

  for (let i = 0; i < 5; i++) {
    lane.step(baseFacts({
      now: curTime,
      price: 0.000080,
      priceAt: curTime,
      meaningfulBuyers: 11,
      buyShareUsdPercent: 70.0,
      meaningfulBuyUsd: 200,
      largestSellUsd: 20.0,
      entryReturnPercent: 10.0,
    }));
    curTime += 1100;
  }
  assert.ok(events.some((e) => e.type === 'PAPER_ENTRY_SIGNAL' && e.laneLabel === 'T-Titan'));
  const buyEvent = events.find((e) => e.type === 'PAPER_BUY');
  assert.ok(buyEvent);
  const entryPrice = (buyEvent as any).priceUsd || (buyEvent as any).price || 0.000080;

  // Price dips slightly (-1.5%) and whale dump of $75 occurs
  curTime += 2000;
  lane.step(baseFacts({ now: curTime, price: entryPrice * 0.985, largestSellUsd: 75.0, priceAt: curTime }));
  assert.ok(events.some((e: any) => (e.type === 'PAPER_EXIT_SIGNAL' || e.type === 'PAPER_SELL') && e.reason === 'EMERGENCY_WHALE_SELL_EXIT'));
});
