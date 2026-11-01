import assert from 'node:assert/strict';

async function testRoutes() {
  const base = 'http://127.0.0.1:4192';

  console.log('Testing S4 route on port 4192...');
  const resS4 = await fetch(`${base}/3scenarios/sce4?token=shegoin`);
  assert.equal(resS4.status, 200, 'S4 route must return 200 OK');
  const textS4 = await resS4.text();
  assert(textS4.includes('Skenario 4: Single Buy $5'), 'Should render S4 page');
  assert(textS4.includes('shegoin'), 'Should include shegoin in S4 page');
  assert(textS4.includes('timeline-container'), 'Should contain timeline container');
  console.log('✅ /3scenarios/sce4 route verified (HTML length:', textS4.length, 'bytes)');

  console.log('Testing S6 route on port 4192...');
  const resS6 = await fetch(`${base}/3scenarios/sce6?token=shegoin`);
  assert.equal(resS6.status, 200, 'S6 route must return 200 OK');
  const textS6 = await resS6.text();
  assert(textS6.includes('Skenario 6: Re-Deploy Sniper V2'), 'Should render S6 page');
  assert(textS6.includes('shegoin'), 'Should include shegoin in S6 page');
  console.log('✅ /3scenarios/sce6 route verified (HTML length:', textS6.length, 'bytes)');

  console.log('Testing API timeline JSON endpoint...');
  const resApi = await fetch(`${base}/api/scenarios/timeline?scenario=sce4&token=shegoin`);
  assert.equal(resApi.status, 200, 'API route must return 200 OK');
  const jsonApi = await resApi.json();
  assert(jsonApi.steps, 'API should return steps array');
  assert(jsonApi.steps.length > 0, 'Steps array should not be empty');
  assert(jsonApi.token, 'Token info should be returned');
  assert.equal(jsonApi.token.symbol.toLowerCase(), 'shegoin');
  console.log(`✅ /api/scenarios/timeline verified (${jsonApi.steps.length} steps returned)`);

  console.log('\n✅ All scenario timeline HTTP routes verified successfully!');
}

testRoutes().catch(err => {
  console.error('❌ Route test failed:', err);
  process.exit(1);
});
