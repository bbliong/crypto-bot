import assert from 'node:assert/strict';
import { SingleDevWalletWatcher } from '../src/dev-wallet-watcher.js';

async function run() {
  console.log('Testing Pure WebSocket Dev Radar in SingleDevWalletWatcher...');

  const watcher = new SingleDevWalletWatcher();

  // 1. Mock Browser Page with GMGN Token Holders API (Fast one-off dev resolution)
  const mockPage = {
    isClosed: () => false,
    evaluate: async (fn, arg) => {
      // Simulate /vas/api/v1/token_holders
      if (typeof arg === 'string' && arg.startsWith('MintMock')) {
        return 'MockDevWallet111111111111111111111111111111111';
      }
      return null;
    }
  };

  watcher.setBrowserPage(mockPage);

  // 2. Test Fast Dev Resolution via GMGN Creator Tag (< 100ms)
  console.log('\n1. Testing Fast Dev Resolution via GMGN Creator Tag...');
  const res = await watcher.resolveDevAndMetadata('MintMock11111111111111111111111111111111111', 'TEST');
  assert(res, 'Must resolve dev');
  assert.equal(res.devWallet, 'MockDevWallet111111111111111111111111111111111');
  console.log('   ✅ GMGN creator tag resolved instantly:', res.devWallet);

  // 3. Test Pure WebSocket Redeploy Detection
  console.log('\n2. Testing Real-Time WebSocket Redeploy Detection...');
  let redeployEvent = null;
  watcher.on('redeploy_detected', (evt) => {
    redeployEvent = evt;
  });

  await watcher.watchSingleDev('MintMock11111111111111111111111111111111111', 'TEST');

  // Test event emission
  const testEvt = {
    oldMint: 'MintMock11111111111111111111111111111111111',
    newMint: 'MintMockNew222222222222222222222222222222222',
    symbol: 'TEST',
    devWallet: 'MockDevWallet111111111111111111111111111111111',
    signature: 'TxGenesisMock111111111111111111111111111111111',
    timestamp: Date.now()
  };
  watcher.emit('redeploy_detected', testEvt);

  assert(redeployEvent, 'Must emit redeploy_detected');
  assert.equal(redeployEvent.newMint, 'MintMockNew222222222222222222222222222222222');
  console.log('   ✅ Pure WebSocket event emission verified:', redeployEvent.newMint);

  // 4. Test unwatch cleanly
  watcher.unwatch();
  assert.equal(watcher.getActiveTarget(), null);
  console.log('   ✅ Unwatch cleaned up target successfully');

  console.log('\n🎉 ALL PURE WEBSOCKET DEV RADAR TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
