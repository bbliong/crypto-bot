import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.js';

async function run() {
  console.log('Testing abortScenarioBuy Revert for Fast-Tick Closed Trades...');

  const testDir = path.resolve(process.cwd(), 'data/test-abort-revert');
  fs.mkdirSync(testDir, { recursive: true });
  const testFile = path.join(testDir, 'dryrun-3scenarios-live.json');
  if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

  const engine = new MultiScenarioDryRunEngine(testDir);
  const now = Date.now();
  const mint = 'MintPhantom1111111111111111111111111111111';

  const initialCash = engine.scenarios.s9.availableCash;

  // 1. Simulasikan S9 buy di Detik 0 via Dev Genesis
  engine.handleEarlyRedeployBuy({
    oldMint: mint,
    newMint: mint,
    symbol: 'PHANTOM',
    devWallet: 'Dev111111111111111111111111111111111',
    signature: 'Sig111111111111111111111111111111111',
    timestamp: now,
    mainExchange: 'pumpswap',
    mainPairAddress: 'Pool111111111111111111111111111111111'
  });

  assert.equal(engine.scenarios.s9.openPositions.length, 1);
  assert.ok(engine.scenarios.s9.availableCash < initialCash);

  // 2. Simulasikan event fast-tick (Whale Buy + Price Tick melonjak +500%) yang menutup posisi sebelum rute AMM selesai
  engine.handleTargetBuy({
    action: 'buy',
    mint: mint,
    symbol: 'PHANTOM',
    tokenName: 'Phantom Token',
    tokenAmount: 70000000,
    remainingHolding: 70000000,
    solAmount: 30,
    usdAmount: 2600,
    priceUsd: 0.000060, // melonjak +500%
    txHash: 'TxWhaleFastTick',
    timestamp: Math.floor(now / 1000),
    isOpenOrClose: true,
    isFirstBuy: true
  }, true);

  engine.updatePriceTick(mint, 0.000060); // Trigger auto take-profit 25%

  assert.equal(engine.scenarios.s9.openPositions.length, 0);
  assert.equal(engine.scenarios.s9.closedTrades.length, 1);
  const phantomTrade = engine.scenarios.s9.closedTrades[0];
  console.log(`   Fast-tick closed trade terbentuk: PnL +$${phantomTrade.realizedPnlUsd}`);
  assert.ok(phantomTrade.realizedPnlUsd > 0);

  // 3. Sekarang probe swap AMM riil selesai (168ms kemudian) dan MENGHASILKAN 422 ABORT_PRICE_CAP_EXCEEDED!
  console.log('   Memanggil abortScenarioBuy karena kuotasi swap AMM melebihi batas anti-pucuk...');
  engine.abortScenarioBuy('SCENARIO_9_DEV_FRONTRUN_SYNC', mint, 'ABORT_PRICE_CAP_EXCEEDED ($0.000071 > $0.000020)');

  // 4. Verifikasi trade hantu DIHAPUS dari closedTrades dan kas dikembalikan ke saldo semula!
  assert.equal(engine.scenarios.s9.closedTrades.length, 0, 'Closed trade hantu harus dihapus');
  assert.equal(engine.scenarios.s9.realizedPnl, 0.0, 'Realized PnL harus kembali ke 0');
  assert.equal(engine.scenarios.s9.availableCash, initialCash, 'Available cash harus kembali ke saldo awal');
  assert.equal(engine.scenarios.s9.wins, 0, 'Wins harus 0');
  assert.equal(engine.scenarios.s9.totalTrades, 0, 'Total trades harus 0');

  // 5. Verifikasi syncRealSellExecution juga diabaikan jika dipanggil setelah abort
  engine.syncRealSellExecution('SCENARIO_9_DEV_FRONTRUN_SYNC', mint, 0.000070, 1.50, 'AUTO_TAKE_PROFIT_25%');
  assert.equal(engine.scenarios.s9.closedTrades.length, 0, 'Sync sell tidak boleh memasukkan trade hantu baru');

  // Cleanup
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('\n🎉 ALL ABORT REVERT TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
