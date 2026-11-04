import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SingleDevWalletWatcher } from '../src/dev-wallet-watcher.js';

async function run() {
  console.log('Testing Dev Capital Rotation Detection...');
  const testDir = mkdtempSync(join(tmpdir(), 'crypto-dev-rot-'));
  const watcher = new SingleDevWalletWatcher({ dataDir: testDir });

  const parentDev = '5korUZ5haVRS1nkrzpVqhgdoRP3xU2VhBYJNPoGosXnp';
  const childDev = 'BSEziTZLYVx8g7a2no9LaCJBiNEBfGN9JeAAsqEQYQky';

  // Set mock active target
  watcher['activeTarget'] = {
    mint: 'MintParent11111111111111111111111111111111',
    symbol: 'PAIRITY',
    devWallet: parentDev,
    ipfsUri: '',
    subscribedAt: Date.now()
  };

  console.log('1. Testing rotation detection on real Solana tx (140 SOL transfer)...');
  const realTransferSig = '27jazZngse2ZdRLLtUy3kztD64wbTzbGGtvcgVEehSzjFbuNiKusLwjJomPuZsjmcBgNeUwENUiS8J3RxPsCqvmh';

  await watcher['checkDevCapitalRotation'](realTransferSig, watcher['activeTarget']);

  const updatedTarget = watcher.getActiveTarget();
  assert(updatedTarget, 'Target must still be active');
  assert.equal(updatedTarget.devWallet, childDev, 'Target must have migrated to child dev wallet');
  assert.equal(updatedTarget.symbol, 'PAIRITY', 'Symbol must be preserved as PAIRITY');
  console.log('   ✅ Successfully detected and migrated to Child Dev:', updatedTarget.devWallet);

  console.log('🎉 ALL DEV ROTATION TESTS PASSED 100%!');
  watcher.unwatch();
  process.exit(0);
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
