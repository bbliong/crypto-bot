import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing Scenario 9.5 Engine Logic (Split TP 50/50 + 1-Min Moonbag)...');

  const testDir = path.resolve(process.cwd(), 'data/test-s95-logic');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDir);
  const now = Date.now();

  assert(engine.scenarios.s9_5, 'Scenario 9.5 must be defined in engine');
  assert.equal(engine.scenarios.s9_5.availableCash, 20.0, 'S9.5 initial cash must be $20.00');

  // =========================================================================
  // Case 1: Initial Swap Gain >= +300% -> Sell 50% Moonbag -> Hold 1m -> Exit
  // =========================================================================
  console.log('\n--- Case 1: Gain >= +300% -> Jual 50% -> Hold 1m -> Timeout Exit ---');
  const mint1 = 'MintMoonbag11111111111111111111111111111111';

  // 1. Entry Detik 0
  engine.handleEarlyRedeployBuy({
    oldMint: 'OldMint001',
    newMint: mint1,
    symbol: 'COIN_PUMP',
    devWallet: 'DevWallet001',
    signature: 'Sig001',
    timestamp: now - 70000,
    mainExchange: 'pumpswap',
    mainPairAddress: 'Pair001',
    isSameSymbol: false
  }, 0.25);

  assert.equal(engine.scenarios.s9_5.openPositions.length, 1, 'S9.5 must hold position');
  const pos1 = engine.scenarios.s9_5.openPositions[0];
  const initialTokens = pos1.tokens;
  assert.equal(pos1.costBasisUsd, 0.25);
  console.log(`   ✅ S9.5 entered at Detik 0: ${initialTokens} tokens with $0.25`);

  // 2. Whale Masuk dengan modal besar ($2500) & harga terbang +500% ($0.000060 vs entry $0.0000096)
  engine.handleTargetBuy({
    action: 'buy',
    mint: mint1,
    symbol: 'COIN_PUMP',
    tokenName: 'Coin Pump',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2600,
    priceUsd: 0.000060, // +525% gain
    txHash: 'TxWhaleBuy1',
    timestamp: Math.floor((now - 65000) / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  // Verifikasi Stage 1 sudah dieksekusi (Jual 50%)
  assert.equal(pos1.stage1Exited, true, 'Stage 1 must be marked exited');
  assert.ok(pos1.stage1RealUsdReturned > 0, 'Stage 1 proceeds must be returned');
  assert.ok(Math.abs(pos1.tokens - (initialTokens * 0.5)) < 1, 'Remaining tokens must be 50%');
  assert.equal(engine.scenarios.s9_5.openPositions.length, 1, 'Position must remain OPEN with 50% moonbag');
  console.log(`   ✅ Stage 1 Executed: Sold 50% tokens, received $${pos1.stage1RealUsdReturned}. Sisa tokens: ${pos1.tokens}`);

  // 3. Waktu berjalan lewat 1 menit (60 detik) sejak Stage 1
  pos1.stage1ExitedAt = now - 65000; // paksa 65 detik berlalu
  engine.checkTimeStopExits(28000);

  // Verifikasi Stage 2 sudah tereksekusi dan posisi selesai 100%
  assert.equal(engine.scenarios.s9_5.openPositions.length, 0, 'S9.5 position must be CLOSED after 1 minute');
  assert.equal(engine.scenarios.s9_5.closedTrades.length, 1, 'Must have 1 closed trade');
  const trade1 = engine.scenarios.s9_5.closedTrades[0];
  assert.ok(trade1.isWin, 'Trade must be profitable');
  assert(trade1.exitReason.includes('STAGE_2_MOONBAG_60S_TIMEOUT_EXIT'), 'Exit reason must be 1m moonbag timeout');
  console.log(`   ✅ Stage 2 Executed: Remaining 50% sold after 1m! Net PnL: +$${trade1.realizedPnlUsd} (${trade1.roiPct}%)`);

  // =========================================================================
  // Case 2: Gain >= +300% -> Sell 50% -> Target DUMP 100% di detik 10s -> DUMP ALL
  // =========================================================================
  console.log('\n--- Case 2: Gain >= +300% -> Jual 50% -> Target DUMP 100% -> Jual Sisa Moonbag Seketika ---');
  const mint2 = 'MintDump222222222222222222222222222222222222';

  engine.handleEarlyRedeployBuy({
    oldMint: 'OldMint002',
    newMint: mint2,
    symbol: 'COIN_DUMP',
    devWallet: 'DevWallet002',
    signature: 'Sig002',
    timestamp: now - 30000,
    mainExchange: 'pumpswap',
    mainPairAddress: 'Pair002',
    isSameSymbol: false
  }, 0.25);

  const pos2 = engine.scenarios.s9_5.openPositions.find(p => p.mint === mint2);
  assert(pos2, 'Position 2 must exist');

  // Whale buy pump +400%
  engine.handleTargetBuy({
    action: 'buy',
    mint: mint2,
    symbol: 'COIN_DUMP',
    tokenName: 'Coin Dump',
    tokenAmount: 50000000,
    remainingHolding: 50000000,
    solAmount: 25,
    usdAmount: 2200,
    priceUsd: 0.000050, // +420% gain
    txHash: 'TxWhaleBuy2',
    timestamp: Math.floor((now - 25000) / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  assert.equal(pos2.stage1Exited, true, 'Stage 1 must be exited');
  console.log(`   ✅ Stage 1 Sold 50% tokens into Whale pump`);

  // Baru berjalan 10 detik (belum 1 menit), tapi Whale mendadak DUMP 100% / Full Exit!
  engine.handleTargetSell({
    action: 'sell',
    mint: mint2,
    symbol: 'COIN_DUMP',
    tokenName: 'Coin Dump',
    tokenAmount: 50000000,
    remainingHolding: 0, // DUMP HABIS (100% FULL EXIT)
    solAmount: 24,
    usdAmount: 2100,
    priceUsd: 0.000045,
    txHash: 'TxWhaleDump2',
    timestamp: Math.floor((now - 15000) / 1000),
    isOpenOrClose: false,
    isFirstBuy: false
  });

  // Verifikasi: sisa 50% moonbag LANGSUNG DIJUAL SEMUA tanpa menunggu 1 menit!
  const pos2StillOpen = engine.scenarios.s9_5.openPositions.some(p => p.mint === mint2);
  assert.equal(pos2StillOpen, false, 'Position must be CLOSED immediately upon target 100% dump');
  const trade2 = engine.scenarios.s9_5.closedTrades.find(t => t.mint === mint2);
  assert(trade2, 'Closed trade must exist');
  assert(trade2.exitReason.includes('S95_TARGET_WHALE_FULL_DUMP_EXIT'), 'Exit reason must be target whale full dump exit');
  console.log(`   ✅ Target dump 100% detected: Remaining 50% moonbag dumped instantly! Exit: ${trade2.exitReason}`);

  // =========================================================================
  // Case 3: Gain < 300% (Normal +35%) -> Auto TP 25% Full Exit (Persis S9)
  // =========================================================================
  console.log('\n--- Case 3: Gain < 300% (+35%) -> Auto TP 25% Jual 100% Persis S9 ---');
  const mint3 = 'MintNormal3333333333333333333333333333333333';

  engine.handleEarlyRedeployBuy({
    oldMint: 'OldMint003',
    newMint: mint3,
    symbol: 'COIN_NORMAL',
    devWallet: 'DevWallet003',
    signature: 'Sig003',
    timestamp: now - 20000,
    mainExchange: 'pumpswap',
    mainPairAddress: 'Pair003',
    isSameSymbol: false
  }, 0.25);

  const pos3 = engine.scenarios.s9_5.openPositions.find(p => p.mint === mint3);
  assert(pos3, 'Position 3 must exist');

  // Whale buy dengan kenaikan normal (+35%, tidak tembus 300%)
  engine.handleTargetBuy({
    action: 'buy',
    mint: mint3,
    symbol: 'COIN_NORMAL',
    tokenName: 'Coin Normal',
    tokenAmount: 10000000,
    remainingHolding: 10000000,
    solAmount: 10,
    usdAmount: 900,
    priceUsd: 0.000013, // +35% gain (< 300%)
    txHash: 'TxWhaleBuy3',
    timestamp: Math.floor((now - 10000) / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  // Update harga mencapai +30% -> harus trigger AUTO_TAKE_PROFIT_25% jual 100%
  engine.updatePriceTick(mint3, 0.000013);

  const pos3StillOpen = engine.scenarios.s9_5.openPositions.some(p => p.mint === mint3);
  assert.equal(pos3StillOpen, false, 'Position 3 must be FULLY closed at TP +25%');
  const trade3 = engine.scenarios.s9_5.closedTrades.find(t => t.mint === mint3);
  assert(trade3, 'Trade 3 must exist');
  assert(trade3.exitReason.includes('AUTO_TAKE_PROFIT_25%'), 'Exit reason must be normal AUTO_TAKE_PROFIT_25%');
  console.log(`   ✅ Normal gain (+35% < 300%): Jual 100% di TP +25% persis S9! Exit: ${trade3.exitReason}`);

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n🎉 ALL SCENARIO 9.5 LOGIC TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
