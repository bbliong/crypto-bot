import assert from 'node:assert/strict';
import { getBrowserBuySwapRoute } from '../src/browser-swap-route.js';

async function run() {
  console.log('Testing Ultra-Low Latency Anti-Pucuk Swap Gate...');

  // --- Test 1: Price Cap Gate Exceeded (Whale already bought in Jito bundle) ---
  console.log('\n--- Test 1: Price Cap Exceeded ($0.00007182 > $0.000020) ---');
  const mockPumpedPage = {
    isClosed: () => false,
    evaluate: async () => {
      // Simulate AMM router quote returning already-pumped price
      return {
        status: 200,
        latencyMs: 145,
        ok: true,
        routeData: {
          exchange: 'pump_amm',
          quote: {
            outAmount: '3480000', // only 3,480 tokens for $0.25 (price $0.0000718)
            outDecimals: 6
          },
          amount_in_usd: 0.25
        },
        impliedPriceUsd: 0.00007182
      };
    }
  };

  const res1 = await getBrowserBuySwapRoute(
    mockPumpedPage,
    'MintPumped1111111111111111111111111111111111',
    'Wallet1111111111111111111111111111111111111',
    0.25,
    90,
    15,
    1,
    'Pair1111111111111111111111111111111111111111',
    0,
    () => false, // target not yet recorded in WS
    0.000020    // MAX Ground Zero Floor
  );

  assert.equal(res1.ok, false, 'Must reject pumped price');
  assert.equal(res1.status, 422, 'Must return 422 for price cap exceeded');
  assert(res1.error.includes('ABORT_PRICE_CAP_EXCEEDED'), 'Error must specify ABORT_PRICE_CAP_EXCEEDED');
  console.log('   ✅ Test 1 PASSED: Harga pucuk $0.00007182 langsung ditolak dalam 145ms!');

  // --- Test 2: Target Whale Already Entered Gate ---
  console.log('\n--- Test 2: Target Whale Already Entered (isTargetEntered === true) ---');
  let targetEnteredFlag = true;

  const mockFloorPage = {
    isClosed: () => false,
    evaluate: async () => {
      // Normal floor quote
      return {
        status: 200,
        latencyMs: 140,
        ok: true,
        routeData: {
          exchange: 'pump_amm',
          quote: {
            outAmount: '26041666',
            outDecimals: 6
          },
          amount_in_usd: 0.25
        },
        impliedPriceUsd: 0.00000960
      };
    }
  };

  const res2 = await getBrowserBuySwapRoute(
    mockFloorPage,
    'MintTargetIn222222222222222222222222222222222',
    'Wallet1111111111111111111111111111111111111',
    0.25,
    90,
    15,
    1,
    'Pair2222222222222222222222222222222222222222',
    0,
    () => targetEnteredFlag, // Target whale already in!
    0.000020
  );

  assert.equal(res2.ok, false, 'Must reject if target whale already entered');
  assert.equal(res2.status, 409, 'Must return 409 conflict');
  assert.equal(res2.error, 'ABORT_TARGET_ALREADY_ENTERED');
  console.log('   ✅ Test 2 PASSED: Target Whale masuk duluan langsung dibatalkan dalam 0ms!');

  // --- Test 3: Normal Floor Price & Target Whale Not Yet In (Golden Window) ---
  console.log('\n--- Test 3: Normal Floor Price ($0.0000096) & Target Not In (Golden Window) ---');
  targetEnteredFlag = false;

  const res3 = await getBrowserBuySwapRoute(
    mockFloorPage,
    'MintGolden33333333333333333333333333333333333',
    'Wallet1111111111111111111111111111111111111',
    0.25,
    90,
    15,
    1,
    'Pair3333333333333333333333333333333333333333',
    0,
    () => targetEnteredFlag,
    0.000020
  );

  assert.equal(res3.ok, true, 'Must pass floor quote');
  assert.equal(res3.impliedPriceUsd, 0.00000960, 'Must record floor price');
  console.log('   ✅ Test 3 PASSED: Harga lantai $0.00000960 lolos instan (siap mendahului Whale)!');

  console.log('\n🎉 ALL ULTRA-LOW LATENCY ANTI-PUCUK TESTS PASSED 100%!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
