import assert from 'node:assert/strict';

async function testRoutes() {
  const base = 'http://127.0.0.1:4192';

  console.log('Testing S4 route on port 4192...');
  const resS4 = await fetch(`${base}/3scenarios/sce4`);
  assert.equal(resS4.status, 200, 'S4 route must return 200 OK');
  const textS4 = await resS4.text();
  assert(textS4.includes('Skenario 4'), 'Should render S4 page');
  console.log('✅ /3scenarios/sce4 route verified (HTML length:', textS4.length, 'bytes)');

  console.log('Testing S5 route on port 4192...');
  const resS5 = await fetch(`${base}/3scenarios/sce5`);
  assert.equal(resS5.status, 200, 'S5 route must return 200 OK');
  const textS5 = await resS5.text();
  assert(textS5.includes('Skenario 5'), 'Should render S5 page');
  console.log('✅ /3scenarios/sce5 route verified (HTML length:', textS5.length, 'bytes)');

  console.log('Testing S6 route on port 4192...');
  const resS6 = await fetch(`${base}/3scenarios/sce6`);
  assert.equal(resS6.status, 200, 'S6 route must return 200 OK');
  const textS6 = await resS6.text();
  assert(textS6.includes('Skenario 6: Re-Deploy Sniper V2'), 'Should render S6 page');
  console.log('✅ /3scenarios/sce6 route verified (HTML length:', textS6.length, 'bytes)');

  console.log('Testing S9 route on port 4192...');
  const resS9 = await fetch(`${base}/3scenarios/sce9`);
  assert.equal(resS9.status, 200, 'S9 route must return 200 OK');
  const textS9 = await resS9.text();
  assert(textS9.includes('Skenario 9'), 'Should render S9 page');
  console.log('✅ /3scenarios/sce9 route verified (HTML length:', textS9.length, 'bytes)');

  console.log('Testing API timeline JSON endpoint...');
  const resApi = await fetch(`${base}/api/scenarios/timeline?scenario=sce4`);
  assert.equal(resApi.status, 200, 'API route must return 200 OK');
  const jsonApi = await resApi.json();
  assert(jsonApi.steps, 'API should return steps array');
  assert(jsonApi.token, 'Token info should be returned');
  console.log(`✅ /api/scenarios/timeline verified (${jsonApi.steps.length} steps returned for token: ${jsonApi.token?.symbol})`);

  console.log('\n✅ All scenario timeline HTTP routes verified successfully!');
}

testRoutes().catch(err => {
  console.error('❌ Route test failed:', err);
  process.exit(1);
});
