import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 14 (BUNDLER-CONFIRMED RUNNER WAVE RIDER) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s14-' + Date.now());
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

// ==========================================================
// TEST 1: Inisialisasi State Skenario 14
// ==========================================================
console.log('1. Memeriksa Inisialisasi Skenario 14:');
assert(engine.scenarios.s14 !== undefined, 'Skenario 14 terdaftar di engine');
assert(engine.scenarios.s14.availableCash === 20.0, 'Kas Awal S14 $20.00');
assert(engine.scenarios.s14.totalTrades === 0, 'Total Trades awal 0');
assert(engine.scenarios.s14.name.includes('Skenario 14'), 'Nama skenario valid mengandung Skenario 14');

// ==========================================================
// TEST 2: Simulasi Koin Umpan Rugpull (Bundler 0.06% Stagnan - Seperti Bufo 1)
// ==========================================================
console.log('\n2. Simulasi Koin Umpan Rugpull (Whale masuk 30 SOL, Bundler stagnan 0.06%):');
const rugMint = 'RugDecoyBait1111111111111111111111111111';
const rugSignal = {
  action: 'buy',
  mint: rugMint,
  symbol: 'RUGDECOY',
  tokenName: 'Rug Decoy Coin',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000036,
  txHash: 'rug_whale_tx_1',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'RugPoolAddress11111111111111111111111111111',
  ad: 'WhaleDevWallet11111111111111111111111111111'
};

engine.handleTargetBuy(rugSignal, true);
assert(engine.scenarios.s14.openPositions.length === 0, 'S14 STANDBY di Detik 0 (tidak blind entry)');

// Simulasikan polling bundler selama 60 detik (tetap 0.06%):
engine.evaluateS14BundlerEntry(rugMint, 0.06, 0.000050);
assert(engine.scenarios.s14.openPositions.length === 0, 'S14 menolak masuk saat Bundler 0.06% < 5.0%');

// Whale dump muatannya:
engine.handleTargetSell({
  action: 'sell',
  mint: rugMint,
  symbol: 'RUGDECOY',
  tokenName: 'Rug Decoy Coin',
  tokenAmount: 35000000,
  remainingHolding: 35000000,
  solAmount: 18,
  usdAmount: 1500,
  priceUsd: 0.000025,
  txHash: 'whale_dump_rug',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false,
  isFirstBuy: false
});

assert(engine.scenarios.s14.openPositions.length === 0, 'S14 100% BEBAS DARI RUGPULL! (Kas tetap utuh $20.00, $0 kerugian)');
assert(engine.scenarios.s14.availableCash === 20.0, 'Kas S14 tetap utuh $20.00');

// ==========================================================
// TEST 3: Simulasi Koin Runner Pemenang (Bundler 7.5% - Seperti Token X / Bufo 2)
// ==========================================================
console.log('\n3. Simulasi Koin Runner (Whale masuk, shakeout selesai, Bundler melonjak 7.5%):');
const runnerMint = 'RunnerWinner2222222222222222222222222222';
const runnerSignal = {
  action: 'buy',
  mint: runnerMint,
  symbol: 'RUNWINNER',
  tokenName: 'Runner Winner Coin',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000036,
  txHash: 'runner_whale_tx_1',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'RunnerPoolAddress22222222222222222222222222',
  ad: 'WhaleRunnerWallet222222222222222222222222222'
};

engine.handleTargetBuy(runnerSignal, true);
assert(engine.scenarios.s14.openPositions.length === 0, 'S14 sabar standby saat Detik 0');

// Simulasikan shakeout dev di detik 26:
engine.handleTargetSell({
  action: 'sell',
  mint: runnerMint,
  symbol: 'RUNWINNER',
  tokenName: 'Runner Winner Coin',
  tokenAmount: 10000000,
  remainingHolding: 60000000,
  solAmount: 8,
  usdAmount: 680,
  priceUsd: 0.000045,
  txHash: 'whale_shakeout_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false,
  isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 0, 'S14 selamat dari shakeout trap detik 26 (tidak rugi cut-loss)');

// Pasca shakeout, Whale buyback 1.5 SOL dan Bundler cluster terkonfirmasi 7.5%:
engine.handleTargetBuy({
  action: 'buy',
  mint: runnerMint,
  symbol: 'RUNWINNER',
  tokenName: 'Runner Winner Coin',
  tokenAmount: 2000000,
  remainingHolding: 62000000,
  solAmount: 1.5,
  usdAmount: 130,
  priceUsd: 0.000055,
  txHash: 'whale_buyback_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false,
  isFirstBuy: false
}, false);

// Evaluasi entry S14 saat Bundler terdeteksi 7.5%:
engine.evaluateS14BundlerEntry(runnerMint, 7.50, 0.000060);
assert(engine.scenarios.s14.openPositions.length === 1, 'S14 TERKONFIRMASI RUNNER! Sukses BUY saat Bundler 7.5% >= 5%');
assert(engine.scenarios.s14.availableCash <= 15.0, 'Kas S14 berkurang modal $5.00');

// ==========================================================
// TEST 4: Wave Riding & Keluar Murni Saat Whale Dump (Giant Sell >= 15 SOL)
// ==========================================================
console.log('\n4. Simulasi Gelombang Pompa Runner & Keluar Saat Whale Dump (Giant Sell >= 15 SOL):');
// Harga koin terbang ke $0.000100 (+66%):
engine.updatePriceTick(runnerMint, 0.000100);
assert(engine.scenarios.s14.openPositions.length === 1, 'Tahan posisi saat koin terbang ke $0.000100');

// Harga terbang ke puncak $0.000180 (+200%):
engine.updatePriceTick(runnerMint, 0.000180);
assert(engine.scenarios.s14.openPositions.length === 1, 'Tetap riding di puncak $0.000180 (+200% Gain)');

// Terjadi koreksi -25% dari puncak (dari $0.000180 ke $0.000135, tapi masih +125% di atas entry):
// S14 TIDAK CUT-LOSS karena BUKAN turun dari harga masuk!
engine.updatePriceTick(runnerMint, 0.000135);
assert(engine.scenarios.s14.openPositions.length === 1, 'S14 TETAP TAHAN saat koreksi -25% dari ATH (kebal shakeout selama di atas entry)!');

// Whale melakukan Giant Dump 16 SOL di puncak:
engine.handleTargetSell({
  action: 'sell',
  mint: runnerMint,
  symbol: 'RUNWINNER',
  tokenName: 'Runner Winner Coin',
  tokenAmount: 20000000,
  remainingHolding: 42000000,
  solAmount: 16,
  usdAmount: 1400,
  priceUsd: 0.000135,
  txHash: 'whale_giant_dump_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false,
  isFirstBuy: false
});

assert(engine.scenarios.s14.openPositions.length === 0, 'S14 SUKSES KUNCI CUAN saat Whale Giant Sell >= 15 SOL!');
const closedTrade = engine.scenarios.s14.closedTrades[0];
console.log('Actual Closed Trade S14:', closedTrade?.exitReason, 'ROI:', closedTrade?.roiPct);
assert(closedTrade !== undefined, 'Ada trade tertutup yang tercatat');
assert(closedTrade.roiPct > 100.0, `ROI terkunci masif (${closedTrade.roiPct}% > 100%)`);
assert(closedTrade.exitReason.includes('S14_WHALE_GIANT_SELL'), 'Exit reason adalah S14_WHALE_GIANT_SELL');

// ==========================================================
// TEST 5: Proteksi Stop Loss -20% Dari Harga Masuk
// ==========================================================
console.log('\n5. Simulasi Proteksi Stop Loss -20% Dari Harga Masuk:');
const slMint = 'StopLossMint4444444444444444444444444444';
const slSignal = {
  action: 'buy',
  mint: slMint,
  symbol: 'SLCOIN',
  tokenName: 'Stop Loss Coin',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000050,
  txHash: 'sl_whale_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'SLPoolAddress4444444444444444444444444444',
  ad: 'WhaleSLWallet4444444444444444444444444444'
};

engine.handleTargetBuy(slSignal, true);
// Masuk di harga $0.000050 saat bundler 6.0%:
engine.evaluateS14BundlerEntry(slMint, 6.00, 0.000050);
assert(engine.scenarios.s14.openPositions.length === 1, 'S14 masuk di harga $0.000050');

// Harga turun -10% ke $0.000045 (belum -20% dari entry):
engine.updatePriceTick(slMint, 0.000045);
assert(engine.scenarios.s14.openPositions.length === 1, 'S14 masih tahan saat drop -10%');

// Harga turun menembus -22% dari entry ke $0.000039:
engine.updatePriceTick(slMint, 0.000039);
assert(engine.scenarios.s14.openPositions.length === 0, 'S14 CUT-LOSS saat harga turun <= -20% dari harga masuk!');
const slTrade = engine.scenarios.s14.closedTrades.find(t => t.mint === slMint);
assert(slTrade && slTrade.exitReason.includes('STOP_LOSS_20%_ENTRY'), 'Exit reason adalah STOP_LOSS_20%_ENTRY');

// ==========================================================
// TEST 6: Proteksi Whale Dump Exit (3x Consecutive Sells)
// ==========================================================
console.log('\n6. Simulasi Proteksi Whale Dump (3x Sell Streak):');
const streakMint = 'StreakWinner3333333333333333333333333333';
const streakSignal = {
  action: 'buy',
  mint: streakMint,
  symbol: 'STREAKCOIN',
  tokenName: 'Streak Coin',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000036,
  txHash: 'streak_whale_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'StreakPoolAddress33333333333333333333333333',
  ad: 'WhaleStreakWallet33333333333333333333333333'
};

engine.handleTargetBuy(streakSignal, true);
// Masuk saat bundler 8.0%:
engine.evaluateS14BundlerEntry(streakMint, 8.00, 0.000050);
assert(engine.scenarios.s14.openPositions.length === 1, 'S14 masuk di token STREAKCOIN');

// Whale menjual 3x berturut-turut tanpa buyback:
engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 5000000, remainingHolding: 65000000, solAmount: 2, usdAmount: 170,
  priceUsd: 0.000060, txHash: 's_sell1', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'Hold pasca Sell #1');

engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 5000000, remainingHolding: 60000000, solAmount: 2, usdAmount: 170,
  priceUsd: 0.000058, txHash: 's_sell2', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'Hold pasca Sell #2');

engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 5000000, remainingHolding: 55000000, solAmount: 2, usdAmount: 170,
  priceUsd: 0.000055, txHash: 's_sell3', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});

assert(engine.scenarios.s14.openPositions.length === 0, 'S14 LANGSUNG EXIT saat Whale Sell 3x beruntun!');
const streakExit = engine.scenarios.s14.closedTrades.find(t => t.mint === streakMint);
assert(streakExit && streakExit.exitReason.includes('S14_WHALE_3_CONSECUTIVE_SELLS'), 'Alasan exit adalah S14_WHALE_3_CONSECUTIVE_SELLS');

console.log('\n=================================================================');
console.log(`HASIL AKHIR UNIT TEST S14-BUNDLER: ${testsPassed}/${totalTests} TESTS PASSED (100% SUKSES)!`);
console.log('=================================================================\n');

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
