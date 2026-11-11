import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 14-BETA (BUNDLER RUNNER + 60S GRACE + WHALE HOARDING TRAP DEFENSE) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s14-beta-' + Date.now());
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
// TEST 1: Inisialisasi State Skenario 14-Beta
// ==========================================================
console.log('1. Memeriksa Inisialisasi Skenario 14-Beta:');
assert(engine.scenarios.s14_beta !== undefined, 'Skenario 14-Beta terdaftar di engine');
assert(engine.scenarios.s14_beta.availableCash === 5.0, 'Kas Awal S14-Beta $5.00');
assert(engine.scenarios.s14_beta.totalTrades === 0, 'Total Trades awal 0');
assert(engine.scenarios.s14_beta.name.includes('Skenario 14-Beta'), 'Nama skenario valid mengandung Skenario 14-Beta');
assert(engine.scenarios.s14_beta.description.includes('Hoarding'), 'Deskripsi mengandung Whale Hoarding Trap Defense');
assert(engine.scenarios.s14_beta.description.includes('60 detik'), 'Deskripsi mengandung Grace Period 60 detik');

// ==========================================================
// TEST 2: Simulasi Rugpull Kilat (Kasus HCAT Gen 2 - Mati di detik 42)
// ==========================================================
console.log('\n2. Simulasi Koin Rugpull Kilat (Kasus HCAT Gen 2 - Bundler 7.0% di detik 38, Dev kuras di detik 42):');
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
assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta STANDBY di Detik 0');

// Detik ke-38: Bundler melonjak ke 7.03% (di S14 biasa masuk, tapi S14-Beta menahan diri):
engine.evaluateS14BetaBundlerEntry(rugMint, 7.03, 0.000070);
assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta MENAHAN DIRI di Detik 38 (Grace Period 60s belum lewat)!');
assert(engine.scenarios.s14_beta.availableCash === 5.0, 'Kas S14-Beta tetap utuh $5.00');

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

assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta 100% BEBAS DARI RUGPULL KILAT!');
assert(engine.scenarios.s14_beta.availableCash === 5.0, 'Kas S14-Beta TETAP UTUH $5.00 (ZERO LOSS)!');

// ==========================================================
// TEST 3: Simulasi Runner Sejati (Kasus Peanut - 13 Runner Pattern: Bag Datar/Distribusi, 0% False Exit)
// ==========================================================
console.log('\n3. Simulasi Koin Runner Sejati (Peanut: Pertumbuhan Bag Whale Hanya +2.1% <= +10%, Max Bag 6.9% <= 8.0%):');
const runnerMint = 'PeanutRunnerMint111111111111111111111111111';
const runnerStartTime = Date.now() - 65000; // 65 detik lalu

engine.handleTargetBuy({
  action: 'buy',
  mint: runnerMint,
  symbol: 'PEANUT',
  tokenName: 'Peanut Runner',
  tokenAmount: 67000000,
  remainingHolding: 67000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000035,
  txHash: 'peanut_whale_genesis_tx',
  timestamp: Math.floor(runnerStartTime / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'PeanutPoolAddress11111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, true);

const betaTracker = engine['s14BetaTrackers'].get(runnerMint);
betaTracker.whaleFirstBuyAt = runnerStartTime;

// Evaluasi entry S14-Beta di detik 65 saat Bundler terkonfirmasi 7.23%:
engine.evaluateS14BetaBundlerEntry(runnerMint, 7.23, 0.000063);
assert(engine.scenarios.s14_beta.openPositions.length === 1, 'S14-Beta SUKSES BUY saat umur 65s >= 60s & Bundler 7.23% >= 5%!');
assert(engine.scenarios.s14_beta.availableCash <= 0.1, 'Kas S14-Beta terpakai modal $5.00');

// Simulasi Whale buyback mikro di Peanut (Bag Whale naik sedikit dari 67.0M ke 68.4M = +2.09% pertumbuhan):
engine.handleTargetBuy({
  action: 'buy',
  mint: runnerMint,
  symbol: 'PEANUT',
  tokenName: 'Peanut Runner',
  tokenAmount: 1400000,
  remainingHolding: 68400000,
  solAmount: 1.2,
  usdAmount: 110,
  priceUsd: 0.000072,
  txHash: 'peanut_whale_micro_buy',
  timestamp: Math.floor((runnerStartTime + 75000) / 1000),
  isOpenOrClose: false,
  isFirstBuy: false,
  pairAddress: 'PeanutPoolAddress11111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, false);

assert(engine.scenarios.s14_beta.openPositions.length === 1, 'S14-Beta TIDAK FALSE EXIT pada runner sejati (Pertumbuhan +2.1% < +25%)!');

// Harga koin melesat ke $0.000098 (+55.5% >= +50%):
engine.updatePriceTick(runnerMint, 0.000098);
assert(engine.scenarios.s14_beta.openPositions.length === 1, 'Posisi tetap aktif setelah TP 50% Tahap 1');
const runnerPos = engine.scenarios.s14_beta.openPositions[0];
assert(runnerPos.stage1Exited === true, 'S14-Beta SUKSES TAKE PROFIT 50% TAHAP 1 saat Gain >= +50%!');
assert(engine.scenarios.s14_beta.availableCash >= 2.0, 'Modal aman kembali ke kas!');

// Harga koin terbang ke $0.000130 (+106.3% >= +100%):
engine.updatePriceTick(runnerMint, 0.000130);
assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta SUKSES TAKE PROFIT 100% MOONBAG di Puncak!');
assert(engine.scenarios.s14_beta.closedTrades.length === 1, 'Trade tercatat di closedTrades');
assert(engine.scenarios.s14_beta.closedTrades[0].isWin === true, 'Hasil trade adalah WIN 🟢');
assert(engine.scenarios.s14_beta.availableCash > 5.0, 'Kas S14-Beta bertambah cuan bersih di atas $5.00!');

// ==========================================================
// TEST 4: Kasus Koin Jebakan 'mihao' (Forced Absorption / Menelan Barang Sendiri)
// ==========================================================
console.log('\n4. Simulasi Koin Jebakan MIHAO (Whale Bag Membengkak +27.1% di detik 90 -> TRIGGER HOARDING EXIT DARURAT CUAN!):');
const mihaoMint = 'MihaoTrapMint111111111111111111111111111111';
const mihaoStartTime = Date.now() - 95000; // 95s lalu

// Detik +0s: Whale Buy 57.3 Juta (5.73% supply)
engine.handleTargetBuy({
  action: 'buy',
  mint: mihaoMint,
  symbol: 'mihao',
  tokenName: 'ni hao cat',
  tokenAmount: 57300000,
  remainingHolding: 57300000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.00000735,
  txHash: 'mihao_genesis_tx',
  timestamp: Math.floor(mihaoStartTime / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'MihaoPoolAddress11111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, true);

const mihaoTracker = engine['s14BetaTrackers'].get(mihaoMint);
mihaoTracker.whaleFirstBuyAt = mihaoStartTime;

// Detik +60s: Whale buy kecil, bag jadi 62.6M (+9.2%). S14-Beta masuk di detik 60:
mihaoTracker.whaleRemainingHolding = 62600000;
engine.evaluateS14BetaBundlerEntry(mihaoMint, 6.50, 0.00000735);
assert(engine.scenarios.s14_beta.openPositions.length === 1, 'S14-Beta BUY mihao di Detik 60 pada harga $0.00000735');
assert(mihaoTracker.whaleHoldingAtEntry === 62600000, 'Tercatat whaleHoldingAtEntry 62.6M');

// Detik +90s: Gejala Forced Absorption! Retail tidak ada yang masuk, bot Whale terpaksa borong sendiri:
// Bag Whale melonjak dari 57.3M ke 72.8M (+27.05% dari genesis >= +25%!)
// Harga koin terpompa Whale sendiri ke $0.00000887 (+20.68% gain!)
engine.handleTargetBuy({
  action: 'buy',
  mint: mihaoMint,
  symbol: 'mihao',
  tokenName: 'ni hao cat',
  tokenAmount: 10200000,
  remainingHolding: 72800000,
  solAmount: 4.5,
  usdAmount: 400,
  priceUsd: 0.00000887,
  txHash: 'mihao_forced_absorption_tx_90s',
  timestamp: Math.floor((mihaoStartTime + 90000) / 1000),
  isOpenOrClose: false,
  isFirstBuy: false,
  pairAddress: 'MihaoPoolAddress11111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, false);

assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta LANGSUNG FULL EXIT 100% SEKETIKA saat Bag Whale membengkak +27%!');
const mihaoTrade = engine.scenarios.s14_beta.closedTrades.find(t => t.mint === mihaoMint);
assert(mihaoTrade !== undefined, 'Trade mihao tercatat di closedTrades');
assert(mihaoTrade.exitReason.includes('S14_BETA_WHALE_HOARDING_TRAP_EXIT'), 'Alasan exit adalah S14_BETA_WHALE_HOARDING_TRAP_EXIT');
assert(mihaoTrade.isWin === true, 'Hasil trade mihao adalah WIN (CUAN +20.6%!) 🟢');
assert(mihaoTrade.realizedPnlUsd > 0, `Profit teralisasi positif: +$${mihaoTrade.realizedPnlUsd}`);

// Detik +255s: Dev mencabut seluruh likuiditas (Drain LP)
// S14-Beta sudah lama keluar di detik 90 dan mengamankan kas!
assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta 100% AMAN dari LP Drain detik 255!');

// ==========================================================
// TEST 5: Plafon Supply > 80M Token / > 8.0% Supply
// ==========================================================
console.log('\n5. Simulasi Plafon Bag Whale Tembus > 80M Token (> 8.0% Supply):');
const ceilingMint = 'CeilingBreachMint11111111111111111111111111';
const ceilingStartTime = Date.now() - 70000;

engine.handleTargetBuy({
  action: 'buy',
  mint: ceilingMint,
  symbol: 'OVER80',
  tokenName: 'Over 80M Coin',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000040,
  txHash: 'ceiling_genesis_tx',
  timestamp: Math.floor(ceilingStartTime / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'CeilingPoolAddress111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, true);

const cTracker = engine['s14BetaTrackers'].get(ceilingMint);
cTracker.whaleFirstBuyAt = ceilingStartTime;

engine.evaluateS14BetaBundlerEntry(ceilingMint, 6.0, 0.000040);
assert(engine.scenarios.s14_beta.openPositions.length === 1, 'S14-Beta masuk posisi OVER80 di $0.000040');

// Whale borong besar hingga bag tembus 92M (> 80M token / 8.0% supply):
engine.handleTargetBuy({
  action: 'buy',
  mint: ceilingMint,
  symbol: 'OVER80',
  tokenName: 'Over 80M Coin',
  tokenAmount: 22000000,
  remainingHolding: 92000000,
  solAmount: 10,
  usdAmount: 900,
  priceUsd: 0.000050,
  txHash: 'ceiling_huge_buy_tx',
  timestamp: Math.floor((ceilingStartTime + 80000) / 1000),
  isOpenOrClose: false,
  isFirstBuy: false,
  pairAddress: 'CeilingPoolAddress111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, false);

assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta LANGSUNG FULL EXIT saat Whale bag tembus 92M > 80M!');
const cTrade = engine.scenarios.s14_beta.closedTrades.find(t => t.mint === ceilingMint);
assert(cTrade.exitReason.includes('S14_BETA_WHALE_HOARDING_TRAP_EXIT'), 'Exit reason terbukti Whale Hoarding Trap Defense');

// ==========================================================
// TEST 6: Cut Loss Disiplin -20% Dari Entry (Jika bukan hoarding trap)
// ==========================================================
console.log('\n6. Simulasi Cut Loss Disiplin -20% dari Entry Price:');
const slMint = 'CutLossBetaMint1111111111111111111111111111';
const slStartTime = Date.now() - 70000;

engine.handleTargetBuy({
  action: 'buy',
  mint: slMint,
  symbol: 'LOSSERB',
  tokenName: 'Losser Coin Beta',
  tokenAmount: 60000000,
  remainingHolding: 60000000,
  solAmount: 30,
  usdAmount: 2600,
  priceUsd: 0.000050,
  txHash: 'slb_genesis_tx',
  timestamp: Math.floor(slStartTime / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'SlbPoolAddress11111111111111111111111111111',
  ad: 'WhaleWallet3azG8rmt1111111111111111111111111'
}, true);

const slbTracker = engine['s14BetaTrackers'].get(slMint);
slbTracker.whaleFirstBuyAt = slStartTime;

engine.evaluateS14BetaBundlerEntry(slMint, 6.00, 0.000050);
assert(engine.scenarios.s14_beta.openPositions.length === 1, 'S14-Beta masuk posisi di $0.000050');

// Harga drop -22% ke $0.000039:
engine.updatePriceTick(slMint, 0.000039);
assert(engine.scenarios.s14_beta.openPositions.length === 0, 'S14-Beta langsung CUT LOSS saat harga drop <= -20%!');
const slTrade = engine.scenarios.s14_beta.closedTrades.find(t => t.mint === slMint);
assert(slTrade && slTrade.exitReason.includes('STOP_LOSS_20%_ENTRY'), 'Alasan exit adalah Stop Loss -20% Entry');

console.log(`\n=========================================================`);
console.log(`HASIL AKHIR UNIT TEST S14-BETA: ${testsPassed}/${totalTests} TESTS PASSED!`);
console.log(`=========================================================\n`);

try {
  fs.rmSync(testDir, { recursive: true, force: true });
} catch {}
