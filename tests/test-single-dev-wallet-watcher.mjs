import assert from 'node:assert/strict';
import { SingleDevWalletWatcher, extractIpfsHash } from '../src/dev-wallet-watcher.js';

async function run() {
  console.log('Testing SingleDevWalletWatcher...');

  // 1. Test IPFS hash extractor
  const uri = 'https://ipfs.io/ipfs/bafkreic3lgnfczlyjizqp274vacpn45lxye677ymhbvlbxeeszlnpc5rum';
  assert.equal(extractIpfsHash(uri), 'bafkreic3lgnfczlyjizqp274vacpn45lxye677ymhbvlbxeeszlnpc5rum');
  console.log('   ✅ extractIpfsHash verified');

  const watcher = new SingleDevWalletWatcher();

  // 2. Test resolveDevAndMetadata on known mint (Pando #1)
  console.log('2. Resolving dev for Pando #1...');
  const res = await watcher.resolveDevAndMetadata('8TpcMFRMZbadz1Qz1ZxoPwQxuHn1jnkewwniYEF1Waek', 'PANDO');
  assert(res, 'Must resolve dev');
  assert.equal(res.devWallet, 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa', 'Must resolve correct Pando dev wallet');
  assert.equal(res.symbol, 'Pando', 'Must resolve symbol');
  assert(res.uri.includes('bafkreic3lgn'), 'Must resolve IPFS URI');
  console.log('   ✅ Dev wallet resolved:', res.devWallet);

  // 3. Test Strict 1 Dev Watching Rule
  console.log('\n3. Testing Strict 1 Dev Watching Rule...');
  await watcher.watchSingleDev('8TpcMFRMZbadz1Qz1ZxoPwQxuHn1jnkewwniYEF1Waek', 'PANDO');
  const target1 = watcher.getActiveTarget();
  assert(target1, 'Active target must be set');
  assert.equal(target1.devWallet, 'QG37oMaWBsov4Cm9mgP1vHPXn8NMVtcd5pUvmQDENGa');

  // Watch second token -> must replace target 1
  console.log('   Switching to another token (VAUBAN #1)...');
  await watcher.watchSingleDev('G7ijYaSjsor7XvXBJXNzijnstTZaZ1jQ4615CwZgf1CX', 'VAUBAN');
  const target2 = watcher.getActiveTarget();
  assert(target2, 'Active target must be set to VAUBAN dev');
  assert.equal(target2.devWallet, 'BVAUvfcn7FpAgfgwcjF3ZZA1hqGhcuUaLvWsDrwHt1gK');
  assert.notEqual(target2.devWallet, target1.devWallet, 'Must switch dev and drop previous dev');
  console.log('   ✅ Successfully enforced 1 dev watcher at a time (Old dev dropped, new dev locked)');

  // 4. Test unwatch
  console.log('\n4. Testing unwatch...');
  watcher.unwatch();
  assert.equal(watcher.getActiveTarget(), null, 'Active target must be null after unwatch');
  console.log('   ✅ Unwatch verified cleanly');

  console.log('\n🎉 ALL SingleDevWalletWatcher TESTS PASSED SUCCESSFULLY!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
