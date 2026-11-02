import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const settingsPath = join(__dirname, '../data/follower-autobuy-settings.json');
const baseUrl = 'http://127.0.0.1:4192';

async function postConfig(payload) {
  const res = await fetch(`${baseUrl}/api/autobuy/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(res.status, 200, 'Config endpoint must return 200');
  return await res.json();
}

async function run() {
  console.log('Running E2E tests for dynamic scenario stakes on port 4192...');

  // 1. Update S4 stake to $7.50
  console.log('1. Updating S4 stake to $7.50...');
  const resS4 = await postConfig({ stakeUsdS4: 7.5 });
  assert.equal(resS4.ok, true);
  assert.equal(resS4.config.stakeUsdS4, 7.5);

  const fileAfterS4 = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(fileAfterS4.stakeUsdS4, 7.5);

  const htmlS4 = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlS4.includes('value="7.50"'), 'HTML must render updated S4 stake 7.50');
  assert(htmlS4.includes('Aktif: $7.50'), 'HTML must show Aktif: $7.50');
  console.log('   ✅ S4 stake update verified in file and HTML!');

  // 2. Update S6 stake to Pool 1 = $6.00, Pool 2 = $10.00
  console.log('2. Updating S6 Pool 1 to $6.00 and Pool 2 to $10.00...');
  const resS6 = await postConfig({ stakeUsdS6Pool1: 6.0, stakeUsdS6Pool2: 10.0 });
  assert.equal(resS6.ok, true);
  assert.equal(resS6.config.stakeUsdS6Pool1, 6.0);
  assert.equal(resS6.config.stakeUsdS6Pool2, 10.0);

  const fileAfterS6 = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(fileAfterS6.stakeUsdS6Pool1, 6.0);
  assert.equal(fileAfterS6.stakeUsdS6Pool2, 10.0);

  const htmlS6 = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlS6.includes('id="s6Pool1Input" value="6.00"'), 'HTML must render updated S6 Pool 1 stake 6.00');
  assert(htmlS6.includes('id="s6Pool2Input" value="10.00"'), 'HTML must render updated S6 Pool 2 stake 10.00');
  assert(htmlS6.includes('P1: $6.00 | P2: $10.00'), 'HTML must show P1: $6.00 | P2: $10.00');
  console.log('   ✅ S6 stakes update verified in file and HTML!');

  // 3. Reset back to user defaults ($5.00 for S4, $5.00 / $7.00 for S6)
  console.log('3. Resetting back to default values ($5.00 for S4, $5.00 & $7.00 for S6)...');
  await postConfig({
    stakeUsdS4: 5.0,
    stakeUsdS6Pool1: 5.0,
    stakeUsdS6Pool2: 7.0,
    autobuyScenario: 'S4',
    enabled: true
  });
  const fileFinal = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(fileFinal.stakeUsdS4, 5.0);
  assert.equal(fileFinal.stakeUsdS6Pool1, 5.0);
  assert.equal(fileFinal.stakeUsdS6Pool2, 7.0);
  assert.equal(fileFinal.autobuyScenario, 'S4');
  console.log('   ✅ Reset to standard defaults verified!');

  console.log('\n✅ All Scenario Capital Stake E2E tests passed successfully!');
}

run().catch(err => {
  console.error('❌ E2E test failed:', err);
  process.exit(1);
});
