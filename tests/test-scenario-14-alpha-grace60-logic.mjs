import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 14-ALPHA (BUNDLER RUNNER + 60S GRACE PERIOD ANTI-RUGPULL 100%) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s14-alpha-' + Date.now());
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
// TEST 1: Inisialisasi State Skenario 14-Alpha
// ==========================================================
console.log('1. Memeriksa Inisialisasi Skenario 14-Alpha:');
assert(engine.scenarios.s14_alpha !== undefined, 'Skenario 14-Alpha terdaftar di engine');
assert(engine.scenarios.s14_alpha.availableCash === 5.0, 'Kas Awal S14-Alpha $5.00');
assert(engine.scenarios.s14_alpha.totalTrades === 0, 'Total Trades awal 0');
assert(engine.scenarios.s14_alpha.name.includes('Skenario 14-Alpha'), 'Nama skenario valid mengandung Skenario 14-Alpha');
assert(engine.scenarios.s14_alpha.description.includes('60 detik'), 'Deskripsi mengandung Grace Period 60 detik');

// ==========================================================
// TEST 2: Simulasi Rugpull Kilat (Kasus HCAT Gen 2 - Mati di detik 42)
// ==========================================================
console.log('\n2. Simulasi Koin Rugpull Kilat (Kasus HCAT Gen 2 - Bundler melompat 7.0% di detik 38, Dev kuras di detik 42):');
const rugMint = 'HcatGen2RugMint111111111111111111111111111';
const now = Date.now();

const rugSignal = {
  action: 'buy',
  mint: rugMint,
  symbol: 'HCAT2',
  tokenName: 'HCAT Gen 2 Rug',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000035,
  txHash: 'hcat2_whale_genesis_tx',
  timestamp: Math.floor(now / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'Hcat2PoolAddress1111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
};

engine.handleTargetBuy(rugSignal, true);
assert(engine.scenarios.s14_alpha.openPositions.length === 0, 'S14-Alpha STANDBY di Detik 0');

// Detik ke-38: Bundler melonjak ke 7.03% (di S14 biasa masuk, tapi S14-Alpha punya Grace Period 60s):
engine.evaluateS14AlphaBundlerEntry(rugMint, 7.03, 0.000070);
assert(engine.scenarios.s14_alpha.openPositions.length === 0, 'S14-Alpha MENAHAN DIRI di Detik 38 (Grace Period 60s belum lewat)!');
assert(engine.scenarios.s14_alpha.availableCash === 5.0, 'Kas S14-Alpha tetap utuh $5.00');

// Detik ke-42: Dev / Whale dump kuras kas kolam (Whale Giant Sell 18 SOL):
engine.handleTargetSell({
  action: 'sell',
  mint: rugMint,
  symbol: 'HCAT2',
  tokenName: 'HCAT Gen 2 Rug',
  tokenAmount: 35000000,
  remainingHolding: 10000000,
  solAmount: 18,
  usdAmount: 1500,
  priceUsd: 0.000020,
  txHash: 'hcat2_dev_drain_tx',
  timestamp: Math.floor((now + 42000) / 1000),
  isOpenOrClose: false,
  isFirstBuy: false,
  pairAddress: 'Hcat2PoolAddress1111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
});

// S14-Alpha harus membatalkan observasi koin ini karena Whale dump raksasa:
assert(engine.scenarios.s14_alpha.openPositions.length === 0, 'S14-Alpha 100% BEBAS DARI RUGPULL KILAT!');
assert(engine.scenarios.s14_alpha.availableCash === 5.0, 'Kas S14-Alpha TETAP UTUH $5.00 (0 KERUGIAN, ZERO LOSS)!');

// ==========================================================
// TEST 3: Simulasi Runner Sejati (Kasus Peanut / HCAT Gen 1 - Bertahan & Lari di Detik 60)
// ==========================================================
console.log('\n3. Simulasi Koin Runner Sejati (Lolos Grace Period 60 detik & Bundler >= 5%):');
const runnerMint = 'PeanutRunnerMint111111111111111111111111111';
const runnerStartTime = Date.now() - 65000; // Simulasikan koin sudah berumur 65 detik

const runnerSignal = {
  action: 'buy',
  mint: runnerMint,
  symbol: 'PEANUT',
  tokenName: 'Peanut Runner',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000035,
  txHash: 'peanut_whale_genesis_tx',
  timestamp: Math.floor(runnerStartTime / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'PeanutPoolAddress11111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
};

engine.handleTargetBuy(runnerSignal, true);

// Set first buy time agar terhitung 65 detik lalu:
const alphaTracker = engine['s14AlphaTrackers'].get(runnerMint);
alphaTracker.whaleFirstBuyAt = runnerStartTime;

// Evaluasi entry S14-Alpha di detik 65 saat Bundler terkonfirmasi 7.23%:
engine.evaluateS14AlphaBundlerEntry(runnerMint, 7.23, 0.000063);
assert(engine.scenarios.s14_alpha.openPositions.length === 1, 'S14-Alpha SUKSES BUY saat umur 65s >= 60s & Bundler 7.23% >= 5%!');
assert(engine.scenarios.s14_alpha.availableCash <= 0.1, 'Kas S14-Alpha terpakai modal $5.00');

// ==========================================================
// TEST 4: Take Profit Bertahap 2-Stage (+50% TP 50% -> +100% TP Moonbag)
// ==========================================================
console.log('\n4. Simulasi Take Profit Bertahap S14-Alpha:');
// 4a. Harga koin melesat ke $0.000098 (+55.5% >= +50%):
engine.updatePriceTick(runnerMint, 0.000098);
assert(engine.scenarios.s14_alpha.openPositions.length === 1, 'Posisi tetap aktif setelah TP 50% Tahap 1');
const runnerPos = engine.scenarios.s14_alpha.openPositions[0];
assert(runnerPos.stage1Exited === true, 'S14-Alpha SUKSES TAKE PROFIT 50% TAHAP 1 saat Gain >= +50%!');
assert(engine.scenarios.s14_alpha.availableCash >= 2.0, 'Modal aman kembali ke kas!');

// 4b. Harga koin terbang ke $0.000130 (+106.3% >= +100%):
engine.updatePriceTick(runnerMint, 0.000130);
assert(engine.scenarios.s14_alpha.openPositions.length === 0, 'S14-Alpha SUKSES TAKE PROFIT 100% MOONBAG di Puncak!');
assert(engine.scenarios.s14_alpha.closedTrades.length === 1, 'Trade tercatat di closedTrades');
assert(engine.scenarios.s14_alpha.closedTrades[0].isWin === true, 'Hasil trade adalah WIN 🟢');
assert(engine.scenarios.s14_alpha.availableCash > 5.0, 'Kas S14-Alpha bertambah cuan bersih di atas $5.00!');

// ==========================================================
// TEST 5: Cut Loss Disiplin -20% Dari Entry
// ==========================================================
console.log('\n5. Simulasi Cut Loss Disiplin -20% dari Entry Price:');
const slMint = 'CutLossMint1111111111111111111111111111111';
const slStartTime = Date.now() - 70000;

engine.handleTargetBuy({
  action: 'buy',
  mint: slMint,
  symbol: 'LOSSER',
  tokenName: 'Losser Coin',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000050,
  txHash: 'sl_genesis_tx',
  timestamp: Math.floor(slStartTime / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'SlPoolAddress11111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, true);

const slTracker = engine['s14AlphaTrackers'].get(slMint);
slTracker.whaleFirstBuyAt = slStartTime;

engine.evaluateS14AlphaBundlerEntry(slMint, 6.00, 0.000050);
assert(engine.scenarios.s14_alpha.openPositions.length === 1, 'S14-Alpha masuk posisi di $0.000050');

// Harga drop -22% ke $0.000039:
engine.updatePriceTick(slMint, 0.000039);
assert(engine.scenarios.s14_alpha.openPositions.length === 0, 'S14-Alpha langsung CUT LOSS saat harga drop <= -20%!');
const slTrade = engine.scenarios.s14_alpha.closedTrades.find(t => t.mint === slMint);
assert(slTrade && slTrade.exitReason.includes('STOP_LOSS_20%_ENTRY'), 'Alasan exit adalah Stop Loss -20% Entry');

console.log(`\n=========================================================`);
console.log(`HASIL AKHIR UNIT TEST S14-ALPHA: ${testsPassed}/${totalTests} TESTS PASSED!`);
console.log(`=========================================================\n`);

try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}
