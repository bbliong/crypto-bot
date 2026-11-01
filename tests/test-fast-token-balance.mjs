import assert from 'node:assert/strict';
import { getOnChainTokenBalance } from '../scripts/solana-rent-reclaimer.mjs';

async function testFastBalance() {
  console.log('Testing fast getOnChainTokenBalance...');

  const target = '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34';
  const pairlessMint = 'DyTwiwr6mVv8Dxp1arobaPfAAxNhsd9qzp3M5JV8U3b';

  const t0 = performance.now();
  const bal = await getOnChainTokenBalance(pairlessMint, target);
  const elapsed = Math.round(performance.now() - t0);

  console.log(`Balance result in ${elapsed}ms:`, bal);
  assert(bal !== null, 'Balance should not be null for active token on target');
  assert(typeof bal.amount === 'string', 'Amount should be a string');
  assert(typeof bal.uiAmount === 'number', 'uiAmount should be a number');
  assert(bal.uiAmount > 0, 'uiAmount should be positive');
  assert(elapsed < 1000, `Execution time (${elapsed}ms) must be under 1,000ms`);

  console.log(`✅ Fast balance test passed! (Latency: ${elapsed}ms < 1,000ms limit)`);
}

testFastBalance().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
