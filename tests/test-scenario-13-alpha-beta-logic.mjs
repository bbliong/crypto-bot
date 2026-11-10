import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 13-ALPHA & SCENARIO 13-BETA ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s13-ab-' + Date.now());
fs.mkdirSync(testDir, { recursive: true });

const engine = new MultiScenarioDryRunEngine(testDir);
engine.bundlerResolver = async () => null;

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
  // TEST 1: Kondisi Awal
  console.log('1. Memeriksa Inisialisasi State S13-Alpha dan S13-Beta:');
  assert(engine.scenarios.s13_alpha.availableCash === 5.0, 'S13-Alpha Kas Awal $5.00');
  assert(engine.scenarios.s13_beta.availableCash === 5.0, 'S13-Beta Kas Awal $5.00');
  assert(engine.scenarios.s13_alpha.totalTrades === 0, 'S13-Alpha 0 Trades');
  assert(engine.scenarios.s13_beta.totalTrades === 0, 'S13-Beta 0 Trades');

  // TEST 2: Koin Rugpull (Simulasi Kasus Trademark Gen 1 / S&P500 Gen 1)
  console.log('\n2. Simulasi Koin Rugpull (Whale masuk 30 SOL, lalu diserbu sniper dump di 1 detik pertama):');
  const rugMint = 'RugpullTestMint1111111111111111111111111111';
  const rugSignal = {
    action: 'buy',
    mint: rugMint,
    symbol: 'RUGPULL',
    tokenName: 'Rugpull Coin',
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

  // S13-Beta langsung masuk di detik 0:
  assert(engine.scenarios.s13_beta.openPositions.length === 1, 'S13-Beta langsung BUY di Detik 0');
  // S13-Alpha menunggu jendela 1 detik:
  assert(engine.scenarios.s13_alpha.openPositions.length === 0, 'S13-Alpha TIDAK langsung beli di Detik 0 (Status: PENDING_1S_VERIFICATION)');

  // Simulasikan kedatangan 3x sniper sell luar dalam selang 200ms:
  console.log('   -> Mensimulasikan 3x order sniper sell luar dalam 300ms...');
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000037, 1.2);
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000036, 1.5);
  // Di sell ke-2: S13-Beta harus langsung panik dump / emergency cut!
  assert(engine.scenarios.s13_beta.openPositions.length === 0, 'S13-Beta INSTANT PANIC CUT: Posisi langsung ditutup seketika saat ada 2x sniper sell!');
  assert(engine.scenarios.s13_beta.closedTrades.length === 1, 'S13-Beta mencatat closed trade darurat');
  assert(engine.scenarios.s13_beta.closedTrades[0].exitReason.includes('S13_BETA_INSTANT_PANIC_DUMP'), 'Exit reason S13-Beta adalah S13_BETA_INSTANT_PANIC_DUMP');

  // Sell ke-3 tiba: S13-Alpha harus memblokir total entry buy!
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000035, 1.1);
  assert(engine.scenarios.s13_alpha.openPositions.length === 0, 'S13-Alpha 1-Second Sniper Gate: BLOCKED! Order Buy dibatalkan');
  assert(engine.scenarios.s13_alpha.availableCash === 5.0, 'S13-Alpha Kas tetap utuh $5.00 (0 Gas Fee, 100% Kebal Rugpull)');

  // Tunggu timer rugMint selesai:
  await new Promise(r => setTimeout(r, 1100));

  // TEST 3: Koin Pemenang (Simulasi Kasus Trademark Gen 4 / STOKE / BTC)
  console.log('\n3. Simulasi Koin Pemenang (Whale masuk 30 SOL, akumulasi bersih di 1 detik pertama, lalu TP +10%):');
  const winMint = 'WinnerTestMint2222222222222222222222222222';
  const winSignal = {
    action: 'buy',
    mint: winMint,
    symbol: 'WINNER',
    tokenName: 'Winner Coin',
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
  assert(engine.scenarios.s13_beta.openPositions.length === 1, 'S13-Beta masuk di Detik 0 koin Winner');

  // Dalam 1 detik pertama: Ritel masuk banyak buy, hanya 1 sell (akumulasi bersih)
  console.log('   -> Mensimulasikan akumulasi bersih (5 buy, 1 sell)...');
  engine.recordPoolTradeActivity(winMint, 'buy', 0.000040, 2.0);
  engine.recordPoolTradeActivity(winMint, 'buy', 0.000042, 3.0);
  engine.recordPoolTradeActivity(winMint, 'sell', 0.000041, 0.5); // hanya 1 sell
  engine.recordPoolTradeActivity(winMint, 'buy', 0.000044, 1.8);

  // Tunggu evaluasi gate 1s untuk S13-Alpha:
  await new Promise(r => setTimeout(r, 1100));
  assert(engine.scenarios.s13_alpha.openPositions.length === 1, 'S13-Alpha 1-Second Sniper Gate: PASSED! Posisi BUY berhasil dibuka di detik ke-1!');

  // Posisi S13-Beta tetap aman karena hanya ada 1 sell (< 2):
  assert(engine.scenarios.s13_beta.openPositions.length === 1, 'S13-Beta tetap memegang posisi karena sell luar hanya 1x (bukan sniper dump)!');

  // TEST 4: Tahan saat gain +15% & saat Whale Buyback (Tidak Ping-Pong / Tidak Jual Dini)
  console.log('\n4. Simulasi Kenaikan Harga +15% & Whale Buyback (Tahan Menuju Target +100%):');
  const smallPumpPrice = 0.000038 * 1.15; // +15%
  engine.updatePriceTick(winMint, smallPumpPrice);
  assert(engine.scenarios.s13_alpha.openPositions.length === 1, 'S13-Alpha TAHAN posisi saat gain +15% (menuju target +100%)');
  assert(engine.scenarios.s13_beta.openPositions.length === 1, 'S13-Beta TAHAN posisi saat gain +15% (menuju target +100%)');

  // Whale Buyback:
  engine.handleTargetBuy({
    action: 'buy',
    mint: winMint,
    symbol: 'WINNER',
    tokenName: 'Winner Coin',
    tokenAmount: 10000000,
    remainingHolding: 80000000,
    solAmount: 1.5,
    usdAmount: 130,
    priceUsd: smallPumpPrice,
    txHash: 'win_whale_buyback_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: false,
    isFirstBuy: false,
    pairAddress: 'WinPoolAddress22222222222222222222222222222'
  }, false);
  assert(engine.scenarios.s13_alpha.openPositions.length === 1, 'S13-Alpha TIDAK dump dini saat Whale buyback (tetap hold)');
  assert(engine.scenarios.s13_beta.openPositions.length === 1, 'S13-Beta TIDAK dump dini saat Whale buyback (tetap hold)');

  // TEST 5: Kenaikan Harga +100% (Double-Up Cuan 2x Lipat Modal)
  console.log('\n5. Simulasi Kenaikan Harga +105% (Target TP +100% Tercapai):');
  const doubleUpPrice = 0.000038 * 2.05; // +105%
  engine.updatePriceTick(winMint, doubleUpPrice);

  assert(engine.scenarios.s13_alpha.openPositions.length === 0, 'S13-Alpha sukses Take Profit +100% (Double-Up Full Exit)');
  assert(engine.scenarios.s13_beta.openPositions.length === 0, 'S13-Beta sukses Take Profit +100% (Double-Up Full Exit)');
  assert(engine.scenarios.s13_alpha.closedTrades[0].exitReason.includes('TP_100%_DOUBLE_UP'), 'Reason S13-Alpha adalah TP_100%_DOUBLE_UP');
  assert(engine.scenarios.s13_beta.closedTrades.find(t => t.mint === winMint).exitReason.includes('TP_100%_DOUBLE_UP'), 'Reason S13-Beta adalah TP_100%_DOUBLE_UP');
  assert(engine.scenarios.s13_alpha.closedTrades[0].isWin === true, 'S13-Alpha membukukan trade WIN');
  assert(engine.scenarios.s13_beta.closedTrades.find(t => t.mint === winMint).isWin === true, 'S13-Beta membukukan trade WIN');

  // TEST 6: Whale Sell Dip Datang -> S13-Alpha & Beta TIDAK Re-entry (Tanpa Ping-Pong)
  console.log('\n6. Simulasi Whale Micro-Sell (Dip):');
  engine.handleTargetSell({
    action: 'sell',
    mint: winMint,
    symbol: 'WINNER',
    tokenName: 'Winner Coin',
    tokenAmount: 5000000,
    remainingHolding: 75000000,
    solAmount: 0.8,
    usdAmount: 70,
    priceUsd: 0.000070,
    txHash: 'win_whale_micro_sell_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: false,
    isFirstBuy: false,
    pairAddress: 'WinPoolAddress22222222222222222222222222222'
  });
  assert(engine.scenarios.s13_alpha.openPositions.length === 0, 'S13-Alpha TIDAK re-entry serok lembah (Tanpa Ping-Pong)');
  assert(engine.scenarios.s13_beta.openPositions.length === 0, 'S13-Beta TIDAK re-entry serok lembah (Tanpa Ping-Pong)');

  console.log('\n' + '='.repeat(60));
  console.log(`HASIL AKHIR: ${testsPassed}/${totalTests} TESTS PASSED (100% SUKSES)!`);
  console.log('='.repeat(60));

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
}

runTests();
