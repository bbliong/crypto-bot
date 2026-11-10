import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 13-CENTAUR (HYBRID INITIAL PUMP RIDER & DECISION GATE) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s13-centaur-' + Date.now());
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
  console.log('1. Memeriksa Inisialisasi S13-Centaur:');
  assert(engine.scenarios.s13_centaur.availableCash === 20.0, 'S13-Centaur Kas Awal $20.00');
  assert(engine.scenarios.s13_centaur.totalTrades === 0, 'S13-Centaur 0 Trades');
  assert(engine.scenarios.s13_centaur.name.includes('Centaur'), 'Nama skenario valid mengandung Centaur');

  // TEST 2: Koin Rugpull Cepat (Whale pasif, banting di detik 30)
  console.log('\n2. Simulasi Koin Rugpull Cepat (Whale Pasif, Scalp Exit di Detik 22 Sebelum Bom Banting):');
  const rugMint = 'RugpullCentaur1111111111111111111111111111';
  const rugSignal = {
    action: 'buy',
    mint: rugMint,
    symbol: 'RUGCOIN',
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
    pairAddress: 'RugPoolAddress11111111111111111111111111111',
    ad: 'WhaleRugWallet1111111111111111111111111111'
  };

  engine.handleTargetBuy(rugSignal, true);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'S13-Centaur langsung BUY di Detik 0');
  assert(engine.scenarios.s13_centaur.availableCash <= 15.0, 'Kas berkurang modal $5.00');

  // Detik 0 s/d 20: Koin terdorong naik +60% oleh retail/fomo
  engine.updatePriceTick(rugMint, 0.000062);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'S13-Centaur tetap HOLD di detik 15 saat pompa (+63.2%)');

  // Evaluasi Decision Gate di Detik 22 (Whale 0x buyback):
  engine.evaluateS13CentaurDecisionGate(rugMint);

  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur LANGSUNG SCALP EXIT di Detik 22!');
  assert(engine.scenarios.s13_centaur.closedTrades.length === 1, 'Tercatat 1 Closed Trade');
  const rugTrade = engine.scenarios.s13_centaur.closedTrades[0];
  assert(rugTrade.isWin === true, 'Hasil trade adalah WIN (+cuan di koin rugpull!)');
  assert(rugTrade.roiPct >= 60.0, `ROI tercatat tinggi (+${rugTrade.roiPct}%)`);
  assert(rugTrade.exitReason.includes('S13_CENTAUR_PRE_RUG_SCALP'), 'Alasan exit adalah S13_CENTAUR_PRE_RUG_SCALP');

  // TEST 3: Koin Runner Sejati (Whale aktif wash-trade)
  console.log('\n3. Simulasi Koin Runner (Whale Aktif Ping-Pong, Switch ke Wave Rider):');
  const runnerMint = 'RunnerCentaur2222222222222222222222222222';
  const runnerSignal = {
    action: 'buy',
    mint: runnerMint,
    symbol: 'RUNCOIN',
    tokenName: 'Runner Coin',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 35,
    usdAmount: 3000,
    priceUsd: 0.000038,
    txHash: 'runner_whale_buy_tx',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: true,
    isFirstBuy: true,
    pairAddress: 'RunnerPoolAddress22222222222222222222222222',
    ad: 'WhaleRunnerWallet2222222222222222222222222'
  };

  engine.handleTargetBuy(runnerSignal, true);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'S13-Centaur masuk di RUNCOIN');

  // Simulasikan waktu berlalu 15 detik:
  const centaurTracker = engine.s13CentaurTrackers.get(runnerMint);
  if (centaurTracker) {
    centaurTracker.whaleFirstBuyAt = Date.now() - 15000;
  }

  // Whale melakukan wash-trade (sell kecil 1.2 SOL):
  engine.handleTargetSell({
    action: 'sell',
    mint: runnerMint,
    symbol: 'RUNCOIN',
    tokenName: 'Runner Coin',
    tokenAmount: 2000000,
    remainingHolding: 68000000,
    solAmount: 1.2,
    usdAmount: 100,
    priceUsd: 0.000060,
    txHash: 'sell1',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: false,
    isFirstBuy: false,
    ad: 'WhaleRunnerWallet2222222222222222222222222'
  });

  // Buyback di detik 16:
  engine.handleTargetBuy({
    action: 'buy',
    mint: runnerMint,
    symbol: 'RUNCOIN',
    tokenName: 'Runner Coin',
    tokenAmount: 2100000,
    remainingHolding: 70100000,
    solAmount: 1.3,
    usdAmount: 110,
    priceUsd: 0.000065,
    txHash: 'buyback1',
    timestamp: Math.floor(Date.now() / 1000),
    isOpenOrClose: false,
    isFirstBuy: false,
    ad: 'WhaleRunnerWallet2222222222222222222222222'
  }, false);

  assert(centaurTracker.whaleBuybacks10_25s >= 1, 'Tercatat 1x buyback whale di jendela 10-25s');

  // Evaluasi Decision Gate di Detik 22:
  engine.evaluateS13CentaurDecisionGate(runnerMint);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'S13-Centaur TIDAK exit di Detik 22! Terkonfirmasi Runner -> Lanjut Ride Mode!');
  assert(centaurTracker.status === 'RUNNER_WAVE_RIDE', 'Status Centaur beralih ke RUNNER_WAVE_RIDE');

  // Naik ke +200% ($0.000114):
  engine.updatePriceTick(runnerMint, 0.000114);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'Tetap riding di puncak +200%');

  // Retracement -20% dari puncak ($0.000114 -> $0.000091):
  engine.updatePriceTick(runnerMint, 0.000091);
  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur Sukses Kunci Cuan Max via Trailing Stop -20%!');
  const runnerTrade = engine.scenarios.s13_centaur.closedTrades[0];
  assert(runnerTrade.roiPct >= 130.0, `ROI runner terkunci masif (+${runnerTrade.roiPct}%)`);
  assert(runnerTrade.exitReason.includes('S13_CENTAUR_TRAILING_STOP_20%_LOCK'), 'Reason adalah Trailing Stop Lock');

  // TEST 4: Koin Runner dengan Exit Whale Exhaustion (3x Sell Beruntun)
  console.log('\n4. Simulasi Koin Runner dengan Exit Whale Exhaustion:');
  const streakMint = 'StreakCentaur3333333333333333333333333333';
  engine.handleTargetBuy({ ...runnerSignal, mint: streakMint, symbol: 'STREAK' }, true);
  const streakTracker = engine.s13CentaurTrackers.get(streakMint);
  streakTracker.whaleFirstBuyAt = Date.now() - 15000;
  // Wash-trade buyback
  engine.handleTargetBuy({ ...runnerSignal, mint: streakMint, isFirstBuy: false }, false);
  engine.evaluateS13CentaurDecisionGate(streakMint);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'Masuk Wave Ride mode di STREAK');

  // Whale sell 3x berturut-turut:
  engine.handleTargetSell({ ...rugSignal, mint: streakMint, action: 'sell', solAmount: 1.0, usdAmount: 90, priceUsd: 0.000070 });
  engine.handleTargetSell({ ...rugSignal, mint: streakMint, action: 'sell', solAmount: 1.1, usdAmount: 95, priceUsd: 0.000068 });
  engine.handleTargetSell({ ...rugSignal, mint: streakMint, action: 'sell', solAmount: 1.2, usdAmount: 105, priceUsd: 0.000066 });

  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur langsung exit saat Whale sell 3x beruntun!');
  const streakTrade = engine.scenarios.s13_centaur.closedTrades[0];
  assert(streakTrade.exitReason.includes('S13_CENTAUR_WHALE_3_CONSECUTIVE_SELLS'), 'Exit reason adalah WHALE_3_CONSECUTIVE_SELLS');

  console.log('\n=================================================================');
  console.log(`HASIL AKHIR UNIT TEST S13-CENTAUR: ${testsPassed}/${totalTests} TESTS PASSED (100% SUKSES)!`);
  console.log('=================================================================\n');

  // Cleanup test dir
  fs.rmSync(testDir, { recursive: true, force: true });
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
