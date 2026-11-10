import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== UNIT TEST SCENARIO 13-CENTAUR (HYBRID MEV GATE & WAVE RIDER) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-s13-centaur-' + Date.now());
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
  // TEST 1: Inisialisasi
  console.log('1. Memeriksa Inisialisasi S13-Centaur:');
  assert(engine.scenarios.s13_centaur.availableCash === 5.0, 'S13-Centaur Kas Awal $5.00');
  assert(engine.scenarios.s13_centaur.totalTrades === 0, 'S13-Centaur 0 Trades');
  assert(engine.scenarios.s13_centaur.name.includes('Centaur'), 'Nama skenario valid mengandung Centaur');

  // TEST 2: Koin Rugpull / MEV Dump Trap (Trademark, RING, CULPER)
  console.log('\n2. Simulasi Koin Rugpull (Whale masuk 30 SOL, serbuan sell MEV di 1s pertama):');
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
  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur standby di Detik 0 (membuka 1s MEV observation)');

  // Simulasikan serbuan bot MEV / sniper dump di 1s pertama (4x sell vs 2x buy):
  engine.recordPoolTradeActivity(rugMint, 'buy', 0.000062, 0.5);
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000060, 1.2);
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000058, 1.5);
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000055, 1.1);
  engine.recordPoolTradeActivity(rugMint, 'sell', 0.000050, 2.0); // 4th sell -> triggers fast evaluation!
  await new Promise(r => setTimeout(r, 100));

  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur 100% MEMBATALKAN BUY (Kebal Rugpull)!');
  assert(engine.scenarios.s13_centaur.availableCash === 5.0, 'Kas S13-Centaur tetap utuh $5.00 ($0 fee)');
  const lastEv = engine.scenarios.s13_centaur.recentEvents[0];
  assert(lastEv && lastEv.reason.includes('BLOCKED_MEV_DUMP_GATE'), 'Alasan block adalah BLOCKED_MEV_DUMP_GATE');

  // TEST 3: Koin Runner Sejati (Akumulasi Bersih: 10x Buy, 1x Sell kecil)
  console.log('\n3. Simulasi Koin Runner (Whale masuk 35 SOL, akumulasi bersih di 1s pertama):');
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
  // Pembeli ritel masuk (banyak BUY, hanya 1 sell kecil sandwich bot):
  engine.recordPoolTradeActivity(runnerMint, 'buy', 0.000062, 1.0);
  engine.recordPoolTradeActivity(runnerMint, 'buy', 0.000065, 1.5);
  engine.recordPoolTradeActivity(runnerMint, 'buy', 0.000068, 2.0);
  engine.recordPoolTradeActivity(runnerMint, 'sell', 0.000066, 0.5); // hanya 1 sell
  engine.recordPoolTradeActivity(runnerMint, 'buy', 0.000070, 1.2);

  // Evaluasi 1s Gate:
  await engine.evaluateS13Centaur1sGate(runnerMint);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'S13-Centaur LOLOS MEV GATE! Masuk BUY di Detik 1');
  assert(engine.scenarios.s13_centaur.availableCash <= 15.0, 'Kas berkurang modal $5.00');

  // Harga koin terbang didorong ritel (+100% s/d +200%):
  engine.updatePriceTick(runnerMint, 0.000100);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'Tahan posisi saat koin terbang');

  engine.updatePriceTick(runnerMint, 0.000140); // Puncak +268%
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'Tetap riding di puncak $0.000140');

  // Retracement -20% dari puncak ($0.000140 -> $0.000110):
  engine.updatePriceTick(runnerMint, 0.000110);
  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur Sukses Kunci Cuan Max via Trailing Stop -20%!');
  const runnerTrade = engine.scenarios.s13_centaur.closedTrades[0];
  assert(runnerTrade.roiPct >= 180.0, `ROI runner terkunci masif (+${runnerTrade.roiPct}%)`);
  assert(runnerTrade.exitReason.includes('S13_CENTAUR_TRAILING_STOP_20%_LOCK'), 'Reason adalah Trailing Stop Lock');

  // TEST 4: Koin Runner dengan Exit Sebelum Whale Dump (Whale Exhaustion 3x Sell):
  console.log('\n4. Simulasi Koin Runner dengan Exit Sebelum Whale Dump:');
  const streakMint = 'StreakCentaur3333333333333333333333333333';
  engine.handleTargetBuy({ ...runnerSignal, mint: streakMint, symbol: 'STREAK' }, true);
  // Bersih dari MEV dump:
  engine.recordPoolTradeActivity(streakMint, 'buy', 0.000062, 1.0);
  await engine.evaluateS13Centaur1sGate(streakMint);
  assert(engine.scenarios.s13_centaur.openPositions.length === 1, 'Masuk Wave Ride mode di STREAK');

  // Whale mulai sell berturut-turut tanpa buyback (tanda-tanda mau rugpull/exit):
  engine.handleTargetSell({ ...rugSignal, mint: streakMint, action: 'sell', solAmount: 1.0, usdAmount: 90, priceUsd: 0.000070 });
  engine.handleTargetSell({ ...rugSignal, mint: streakMint, action: 'sell', solAmount: 1.1, usdAmount: 95, priceUsd: 0.000068 });
  engine.handleTargetSell({ ...rugSignal, mint: streakMint, action: 'sell', solAmount: 1.2, usdAmount: 105, priceUsd: 0.000066 });

  assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur LANGSUNG EXIT SEBELUM WHALE DUMP (3x Sell Streak)!');
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
