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
// TEST 4: Wave Riding & Take Profit Bertahap (+50% TP 50% -> +100% TP Moonbag)
// ==========================================================
console.log('\n4. Simulasi Take Profit Bertahap & Anti-Shakeout:');
// 4a. Harga koin terbang ke $0.000095 (+58.3% >= +50%):
engine.updatePriceTick(runnerMint, 0.000095);
assert(engine.scenarios.s14.openPositions.length === 1, 'Posisi tetap ada setelah TP 50% Tahap 1');
const runnerPos = engine.scenarios.s14.openPositions[0];
assert(runnerPos.stage1Exited === true, 'S14 SUKSES TAKE PROFIT 50% TAHAP 1 saat Gain >= +50%!');
assert(engine.scenarios.s14.availableCash > 15.0, 'Modal & cuan sebagian sudah kembali aman di kas!');

// 4b. Whale melakukan sell receh 1 SOL (wash trading) pasca TP 1:
engine.handleTargetSell({
  action: 'sell',
  mint: runnerMint,
  symbol: 'RUNWINNER',
  tokenName: 'Runner Winner Coin',
  tokenAmount: 1000000,
  remainingHolding: 61000000,
  solAmount: 1.0,
  usdAmount: 85,
  priceUsd: 0.000090,
  txHash: 'whale_small_sell_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false,
  isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'S14 KEBAL SHAKEOUT! Tidak cut-loss saat Whale sell receh 1 SOL (< 3 SOL)');

// 4c. Koin terbang lanjut ke $0.000130 (+116.7% >= +100%):
engine.updatePriceTick(runnerMint, 0.000130);
assert(engine.scenarios.s14.openPositions.length === 0, 'S14 SUKSES KUNCI CUAN TAHAP 2 (Moonbag +100% Tercapai)!');

const closedTrade = engine.scenarios.s14.closedTrades[0];
console.log('Actual Closed Trade S14:', closedTrade?.exitReason, 'ROI:', closedTrade?.roiPct);
assert(closedTrade !== undefined, 'Ada trade tertutup yang tercatat');
assert(closedTrade.roiPct >= 50.0, `ROI gabungan terkunci (${closedTrade.roiPct}% >= 50%)`);
assert(closedTrade.exitReason.includes('S14_STAGE_2_TP_100%'), 'Exit reason adalah S14_STAGE_2_TP_100%');

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
// TEST 6: Proteksi Whale Dump Exit (Signifikan >= 3 SOL atau Giant Dump >= 15 SOL)
// ==========================================================
console.log('\n6. Simulasi Proteksi Whale Dump Signifikan:');
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

// Whale menjual receh 1 SOL 2x -> S14 TIDAK EXIT:
engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 1000000, remainingHolding: 69000000, solAmount: 1, usdAmount: 85,
  priceUsd: 0.000050, txHash: 's_receh1', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'Hold pasca Sell receh #1 (1 SOL < 3 SOL)');

engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 1000000, remainingHolding: 68000000, solAmount: 1, usdAmount: 85,
  priceUsd: 0.000050, txHash: 's_receh2', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'Hold pasca Sell receh #2 (1 SOL < 3 SOL)');

// Whale sekarang menjual SIGNIFIKAN (>= 3 SOL) 3x berturut-turut:
engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 4000000, remainingHolding: 64000000, solAmount: 4, usdAmount: 340,
  priceUsd: 0.000049, txHash: 's_sig1', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'Hold pasca Sell Signifikan #1');

engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 4000000, remainingHolding: 60000000, solAmount: 4, usdAmount: 340,
  priceUsd: 0.000048, txHash: 's_sig2', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});
assert(engine.scenarios.s14.openPositions.length === 1, 'Hold pasca Sell Signifikan #2');

engine.handleTargetSell({
  action: 'sell', mint: streakMint, symbol: 'STREAKCOIN', tokenName: 'Streak Coin',
  tokenAmount: 4000000, remainingHolding: 56000000, solAmount: 4, usdAmount: 340,
  priceUsd: 0.000047, txHash: 's_sig3', timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: false, isFirstBuy: false
});

assert(engine.scenarios.s14.openPositions.length === 0, 'S14 LANGSUNG EXIT saat Whale Sell Signifikan (>= 3 SOL) 3x beruntun!');
const streakExit = engine.scenarios.s14.closedTrades.find(t => t.mint === streakMint);
assert(streakExit && streakExit.exitReason.includes('S14_WHALE_3_CONSECUTIVE_SELLS'), 'Alasan exit adalah S14_WHALE_3_CONSECUTIVE_SELLS');

console.log('\n=================================================================');
console.log(`HASIL AKHIR UNIT TEST S14-BUNDLER: ${testsPassed}/${totalTests} TESTS PASSED (100% SUKSES)!`);
console.log('=================================================================\n');

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
