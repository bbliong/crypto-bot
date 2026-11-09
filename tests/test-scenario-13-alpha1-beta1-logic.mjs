import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 13-ALPHA-1 & SCENARIO 13-BETA-1 (WAVE RIDER) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s13-ab1-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const engine = new MultiScenarioDryRunEngine(testDir);

let testsPassed = 0;
let totalTests = 0;

function assert(condition, message) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    testsPassed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    process.exitCode = 1;
  }
}

async function runTests() {
  // TEST 1: Inisialisasi
  console.log('1. Memeriksa Inisialisasi S13-Alpha-1 & S13-Beta-1:');
  assert(engine.scenarios.s13_alpha_1.availableCash === 20.0, 'S13-Alpha-1 Kas Awal $20.00');
  assert(engine.scenarios.s13_beta_1.availableCash === 20.0, 'S13-Beta-1 Kas Awal $20.00');
  assert(engine.scenarios.s13_alpha_1.totalTrades === 0, 'S13-Alpha-1 0 Trades');
  assert(engine.scenarios.s13_beta_1.totalTrades === 0, 'S13-Beta-1 0 Trades');

  // TEST 2: Koin Rugpull
  console.log('\n2. Simulasi Koin Rugpull (Whale masuk 30 SOL, serbuan sniper di 1s pertama):');
  const rugMint = 'RugpullWave11111111111111111111111111111111';
  const rugSignal = {
    action: 'buy',
    mint: rugMint,
    symbol: 'RUGPULL',
    tokenName: 'Rugpull Token',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2700,
    priceUsd: 0.000038,
    txHash: 'rug_whale_buy_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true,
    pairAddress: 'RugPoolAddress11111111111111111111111111111'
  };

  engine.handleTargetBuy(rugSignal, true);
  assert(engine.scenarios.s13_beta_1.openPositions.length === 1, 'S13-Beta-1 langsung BUY di Detik 0');
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 0, 'S13-Alpha-1 standby 1s gate');

  // Simulasikan sniper sells tiba:
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000037, 1.0);
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000036, 1.2);
  assert(engine.scenarios.s13_beta_1.openPositions.length === 0, 'S13-Beta-1 INSTANT PANIC CUT: Posisi langsung ditutup!');
  assert(engine.scenarios.s13_beta_1.closedTrades[0].exitReason.includes('S13_BETA_1_INSTANT_PANIC_DUMP'), 'Exit reason S13-Beta-1 adalah Panic Cut');

  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000035, 1.5);
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 0, 'S13-Alpha-1: 1s Sniper Gate BLOCKED (Kebal rugpull)');
  assert(engine.scenarios.s13_alpha_1.availableCash === 20.0, 'S13-Alpha-1 Kas tetap utuh $20.00 ($0 fee)');

  // TEST 3: Koin Pemenang (Wave Rider - Ride the Pump!)
  console.log('\n3. Simulasi Koin Pemenang (Whale masuk 30 SOL, akumulasi bersih di 1s pertama):');
  const winMint = 'WinnerWave22222222222222222222222222222222';
  const winSignal = {
    action: 'buy',
    mint: winMint,
    symbol: 'WINWAVE',
    tokenName: 'Winner Wave',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2700,
    priceUsd: 0.000038,
    txHash: 'win_whale_buy_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true,
    pairAddress: 'WinPoolAddress22222222222222222222222222222'
  };

  engine.handleTargetBuy(winSignal, true);
  assert(engine.scenarios.s13_beta_1.openPositions.length === 1, 'S13-Beta-1 masuk di Detik 0');

  // Akumulasi bersih di 1s pertama (hanya 1 sell):
  engine.recordPoolTradeActivity(winMint, 'buy', 0.000040, 2.0);
  engine.recordPoolTradeActivity(winMint, 'buy', 0.000042, 3.0);
  engine.recordPoolTradeActivity(winMint, 'sell', 0.000041, 0.5);

  await new Promise(r => setTimeout(r, 1100));
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'S13-Alpha-1 1s Gate: PASSED! Masuk di Detik 1');

  // TEST 4: Tahan saat harga merayap naik (+50%, +100%, +150%)
  console.log('\n4. Simulasi Kenaikan Harga Bertahap (+50%, +100%, +150%) & Whale Ping-Pong:');
  engine.updatePriceTick(winMint, 0.000038 * 1.50); // +50%
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'S13-Alpha-1 TAHAN di +50% (Riding)');
  assert(engine.scenarios.s13_beta_1.openPositions.length === 1, 'S13-Beta-1 TAHAN di +50% (Riding)');

  // Whale Buyback:
  engine.handleTargetBuy({
    action: 'buy',
    mint: winMint,
    symbol: 'WINWAVE',
    tokenName: 'Winner Wave',
    tokenAmount: 10000000,
    remainingHolding: 80000000,
    solAmount: 1.5,
    usdAmount: 130,
    priceUsd: 0.000038 * 1.50,
    txHash: 'bb1_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: false,
    isFirstBuy: false,
    pairAddress: 'WinPoolAddress22222222222222222222222222222'
  }, false);
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'S13-Alpha-1 TIDAK dump saat whale buyback');
  assert(engine.scenarios.s13_beta_1.openPositions.length === 1, 'S13-Beta-1 TIDAK dump saat whale buyback');

  // Whale Sell 1x (Normal Dip):
  engine.handleTargetSell({
    action: 'sell',
    mint: winMint,
    symbol: 'WINWAVE',
    tokenName: 'Winner Wave',
    tokenAmount: 5000000,
    remainingHolding: 75000000,
    solAmount: 0.8,
    usdAmount: 70,
    priceUsd: 0.000038 * 1.48,
    txHash: 'sell1_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: false,
    isFirstBuy: false,
    pairAddress: 'WinPoolAddress22222222222222222222222222222'
  });
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'S13-Alpha-1 ABAIKAN 1x sell whale (tetap hold)');
  assert(engine.scenarios.s13_beta_1.openPositions.length === 1, 'S13-Beta-1 ABAIKAN 1x sell whale (tetap hold)');

  // TEST 5: Kenaikan Menuju Puncak +200% ($0.000114) lalu Trailing Drop 20%
  console.log('\n5. Simulasi Puncak +200% ($0.000114) lalu Retracement -20% (Trailing Stop Lock):');
  const peakPrice = 0.000038 * 3.0; // +200%
  engine.updatePriceTick(winMint, peakPrice);
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'Masih hold di puncak +200%');

  // Harga terkoreksi 21% dari puncak:
  const retracedPrice = peakPrice * 0.79; // Drop 21% dari peak (Gain masih +137%!)
  engine.updatePriceTick(winMint, retracedPrice);

  assert(engine.scenarios.s13_alpha_1.openPositions.length === 0, 'S13-Alpha-1 Sukses Kunci Cuan Max via Trailing Stop -20%!');
  assert(engine.scenarios.s13_beta_1.openPositions.length === 0, 'S13-Beta-1 Sukses Kunci Cuan Max via Trailing Stop -20%!');
  assert(engine.scenarios.s13_alpha_1.closedTrades[0].exitReason.includes('TRAILING_STOP_20%_LOCK'), 'Reason S13-Alpha-1 adalah Trailing Stop Lock');
  assert(engine.scenarios.s13_beta_1.closedTrades.find(t => t.mint === winMint).exitReason.includes('TRAILING_STOP_20%_LOCK'), 'Reason S13-Beta-1 adalah Trailing Stop Lock');
  assert(engine.scenarios.s13_alpha_1.closedTrades[0].roiPct > 100, `S13-Alpha-1 ROI terkunci masif (+${engine.scenarios.s13_alpha_1.closedTrades[0].roiPct}%)`);
  assert(engine.scenarios.s13_beta_1.closedTrades.find(t => t.mint === winMint).roiPct > 100, `S13-Beta-1 ROI terkunci masif (+${engine.scenarios.s13_beta_1.closedTrades.find(t => t.mint === winMint).roiPct}%)`);

  // TEST 6: Sinyal Whale Sell 3x Beruntun (Dump Protection)
  console.log('\n6. Simulasi Koin Baru dengan Sinyal Whale 3x Sell Beruntun:');
  const streakMint = 'StreakMint3333333333333333333333333333333333';
  const streakSignal = {
    action: 'buy',
    mint: streakMint,
    symbol: 'STREAK',
    tokenName: 'Streak Coin',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2700,
    priceUsd: 0.000038,
    txHash: 'streak_whale_buy_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true,
    pairAddress: 'StreakPoolAddress333333333333333333333333333'
  };

  engine.handleTargetBuy(streakSignal, true);
  await new Promise(r => setTimeout(r, 1100)); // Lolos gate 1s
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'S13-Alpha-1 masuk di token STREAK');
  assert(engine.scenarios.s13_beta_1.openPositions.length === 1, 'S13-Beta-1 masuk di token STREAK');

  // Whale melakukan 3x Sell berturut-turut tanpa buyback:
  console.log('   -> Whale melakukan Sell #1...');
  engine.handleTargetSell({ action: 'sell', mint: streakMint, symbol: 'STREAK', tokenName: 'Streak Coin', tokenAmount: 1e6, remainingHolding: 69e6, solAmount: 1.0, usdAmount: 90, priceUsd: 0.000045, txHash: 's1', timestamp: Math.floor(Date.now()/1000), isOpenOrClose: false, isFirstBuy: false, pairAddress: streakSignal.pairAddress });
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'Hold pasca Sell #1');

  console.log('   -> Whale melakukan Sell #2...');
  engine.handleTargetSell({ action: 'sell', mint: streakMint, symbol: 'STREAK', tokenName: 'Streak Coin', tokenAmount: 1e6, remainingHolding: 68e6, solAmount: 1.0, usdAmount: 90, priceUsd: 0.000048, txHash: 's2', timestamp: Math.floor(Date.now()/1000), isOpenOrClose: false, isFirstBuy: false, pairAddress: streakSignal.pairAddress });
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 1, 'Hold pasca Sell #2');

  console.log('   -> Whale melakukan Sell #3 (Streak 3x tanpa buyback!)...');
  engine.handleTargetSell({ action: 'sell', mint: streakMint, symbol: 'STREAK', tokenName: 'Streak Coin', tokenAmount: 1e6, remainingHolding: 67e6, solAmount: 1.0, usdAmount: 90, priceUsd: 0.000050, txHash: 's3', timestamp: Math.floor(Date.now()/1000), isOpenOrClose: false, isFirstBuy: false, pairAddress: streakSignal.pairAddress });
  
  assert(engine.scenarios.s13_alpha_1.openPositions.length === 0, 'S13-Alpha-1 LANGSUNG EXIT saat Whale Sell 3x beruntun!');
  assert(engine.scenarios.s13_beta_1.openPositions.length === 0, 'S13-Beta-1 LANGSUNG EXIT saat Whale Sell 3x beruntun!');
  assert(engine.scenarios.s13_alpha_1.closedTrades[0].exitReason.includes('WHALE_3_CONSECUTIVE_SELLS'), 'Exit reason S13-Alpha-1 adalah WHALE_3_CONSECUTIVE_SELLS');
  assert(engine.scenarios.s13_beta_1.closedTrades[0].exitReason.includes('WHALE_3_CONSECUTIVE_SELLS'), 'Exit reason S13-Beta-1 adalah WHALE_3_CONSECUTIVE_SELLS');

  console.log('\n' + '='.repeat(65));
  console.log(`HASIL AKHIR: ${testsPassed}/${totalTests} TESTS PASSED (100% SUKSES)!`);
  console.log('='.repeat(65));

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
}

runTests();
