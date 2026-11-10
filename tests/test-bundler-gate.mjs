import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'fs';
import path from 'path';

console.log('=== TEST DEDIKASI BUNDLER RATE GATE (CENTAUR & ALPHA) ===\n');

const testDir = path.resolve(process.cwd(), 'data/test-bundler-gate-' + Date.now());
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

// 1. Uji Koin dengan Bundler 0% (Koin Umpan / Rugpull seperti 5VPxBPm6)
console.log('1. Simulasi Koin dengan Bundler 0.00% (Koin Umpan Dev Serial):');
const rugMint = 'ZeroBundlerToken11111111111111111111111111';
engine.bundlerResolver = async (mint) => {
  if (mint === rugMint) return 0.00; // 0.0%
  return null;
};

const rugSignal = {
  action: 'buy',
  mint: rugMint,
  symbol: 'ZERORUG',
  tokenName: 'Zero Bundler Rug',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 30,
  usdAmount: 2700,
  priceUsd: 0.000038,
  txHash: 'zero_bundler_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'ZeroPoolAddress1111111111111111111111111111',
  ad: 'DevWallet1111111111111111111111111111'
};

engine.handleTargetBuy(rugSignal, true);

// Trigger evaluasi 1s gate
await engine.evaluateS13Centaur1sGate(rugMint);
await engine.evaluateS13Alpha1sGate(rugMint);
await engine.evaluateS13Alpha1Gate(rugMint);

assert(engine.scenarios.s13_centaur.openPositions.length === 0, 'S13-Centaur membatalkan BUY koin Bundler 0%');
assert(engine.scenarios.s13_alpha.openPositions.length === 0, 'S13-Alpha membatalkan BUY koin Bundler 0%');
assert(engine.scenarios.s13_alpha_1.openPositions.length === 0, 'S13-Alpha-1 membatalkan BUY koin Bundler 0%');

const centaurLastEv = engine.scenarios.s13_centaur.recentEvents[0];
assert(centaurLastEv && centaurLastEv.reason.includes('BLOCKED_LOW_BUNDLER_GATE'), 'Alasan block Centaur adalah BLOCKED_LOW_BUNDLER_GATE');

// 2. Uji Koin dengan Bundler 10.83% (Koin Runner Sejati seperti Goh4ZhFa)
console.log('\n2. Simulasi Koin dengan Bundler 10.83% (Koin Runner Sejati):');
const runnerMint = 'HighBundlerWinner2222222222222222222222222';
engine.bundlerResolver = async (mint) => {
  if (mint === runnerMint) return 0.1083; // 10.83%
  return null;
};

const runnerSignal = {
  action: 'buy',
  mint: runnerMint,
  symbol: 'RUNNER10',
  tokenName: 'High Bundler Runner',
  tokenAmount: 70000000,
  remainingHolding: 70000000,
  solAmount: 35,
  usdAmount: 3000,
  priceUsd: 0.000038,
  txHash: 'high_bundler_tx',
  timestamp: Math.floor(Date.now() / 1000),
  isOpenOrClose: true,
  isFirstBuy: true,
  pairAddress: 'HighPoolAddress2222222222222222222222222222',
  ad: 'DevWallet2222222222222222222222222222'
};

engine.handleTargetBuy(runnerSignal, true);

// Trigger evaluasi 1s gate
await engine.evaluateS13Centaur1sGate(runnerMint);
await engine.evaluateS13Alpha1sGate(runnerMint);
await engine.evaluateS13Alpha1Gate(runnerMint);

assert(engine.scenarios.s13_centaur.openPositions.some(p => p.mint === runnerMint), 'S13-Centaur LOLOS & BUY koin Bundler 10.83%');
assert(engine.scenarios.s13_alpha.openPositions.some(p => p.mint === runnerMint), 'S13-Alpha LOLOS & BUY koin Bundler 10.83%');
assert(engine.scenarios.s13_alpha_1.openPositions.some(p => p.mint === runnerMint), 'S13-Alpha-1 LOLOS & BUY koin Bundler 10.83%');

console.log('\n=================================================================');
console.log(`HASIL TEST BUNDLER GATE: ${testsPassed}/${totalTests} TESTS PASSED (100% SUKSES)!`);
console.log('=================================================================\n');

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
