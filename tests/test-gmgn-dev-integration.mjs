import assert from 'node:assert/strict';
import { SingleDevWalletWatcher } from '../src/dev-wallet-watcher.js';

async function run() {
  console.log('Testing GMGN Dev Integration in SingleDevWalletWatcher...');

  const watcher = new SingleDevWalletWatcher();

  // 1. Mock Browser Page with GMGN Token Holders API
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

  // 2. Test Fast Dev Resolution via GMGN
  console.log('\n1. Testing Fast Dev Resolution via GMGN Creator Tag...');
  const res = await watcher.resolveDevAndMetadata('MintMock11111111111111111111111111111111111', 'TEST');
  assert(res, 'Must resolve dev');
  assert.equal(res.devWallet, 'MockDevWallet111111111111111111111111111111111');
  console.log('   ✅ GMGN creator tag resolved instantly:', res.devWallet);

  // 3. Test Dual-Radar GMGN dev_created_tokens Detection
  console.log('\n2. Testing Dual-Radar GMGN dev_created_tokens Event Emission...');
  let redeployEvent = null;
  watcher.on('redeploy_detected', (evt) => {
    redeployEvent = evt;
  });

  // Setup mock for dev_created_tokens
  let devTokenCalls = 0;
  mockPage.evaluate = async (fn, arg) => {
    // Check if function is calling token_holders or dev_created_tokens
    const fnStr = fn.toString();
    if (fnStr.includes('token_holders')) {
      return 'MockDevWallet111111111111111111111111111111111';
    }
    devTokenCalls++;
    if (devTokenCalls === 1) {
      // First poll returns initial token
      return [{
        token_address: 'MintMock11111111111111111111111111111111111',
        symbol: 'TEST',
        biggest_pool: 'PoolInitial1111111111111111111111111111111'
      }];
    }
    // Second poll returns NEW token released by dev!
    return [
      {
        token_address: 'MintMockNew222222222222222222222222222222222',
        symbol: 'TEST',
        biggest_pool: 'PoolNew222222222222222222222222222222222222',
        pool_liquidity: '25000.0'
      },
      {
        token_address: 'MintMock11111111111111111111111111111111111',
        symbol: 'TEST',
        biggest_pool: 'PoolInitial1111111111111111111111111111111'
      }
    ];
  };

  await watcher.watchSingleDev('MintMock11111111111111111111111111111111111', 'TEST');

  // Wait for poller tick
  await new Promise(r => setTimeout(r, 2600));

  assert(redeployEvent, 'Must emit redeploy_detected when new token appears in GMGN dev_created_tokens');
  assert.equal(redeployEvent.newMint, 'MintMockNew222222222222222222222222222222222');
  assert.equal(redeployEvent.devWallet, 'MockDevWallet111111111111111111111111111111111');
  console.log('   ✅ Detected new token via GMGN dev_created_tokens poller:', redeployEvent.newMint);

  // 4. Test unwatch cleanly
  watcher.unwatch();
  assert.equal(watcher.getActiveTarget(), null);
  console.log('   ✅ Unwatch cleaned up poller and target successfully');

  console.log('\n🎉 ALL GMGN DEV INTEGRATION TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
