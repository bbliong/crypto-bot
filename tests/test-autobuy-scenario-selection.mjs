import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const settingsPath = join(__dirname, '../data/follower-autobuy-settings.json');
const baseUrl = 'http://127.0.0.1:4192';

async function updateConfig(payload) {
  const res = await fetch(`${baseUrl}/api/autobuy/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(res.status, 200, 'API must respond with 200 OK');
  return await res.json();
}

async function run() {
  console.log('Testing Auto-Buy Scenario Selection (OFF / S4 / S6 / BOTH)...');

  // 1. Test Select S4
  console.log('1. Setting scenario to S4...');
  const resS4 = await updateConfig({ autobuyScenario: 'S4' });
  assert.equal(resS4.ok, true);
  assert.equal(resS4.config.enabled, true);
  assert.equal(resS4.config.autobuyScenario, 'S4');

  const fileS4 = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(fileS4.enabled, true);
  assert.equal(fileS4.autobuyScenario, 'S4');

  const htmlS4 = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlS4.includes('value="S4" checked'), 'S4 radio button must be checked');
  assert(htmlS4.includes('status-s4'), 'Status pill must have status-s4');
  console.log('   ✅ S4 scenario selection verified');

  // 2. Test Select S6
  console.log('2. Setting scenario to S6...');
  const resS6 = await updateConfig({ autobuyScenario: 'S6' });
  assert.equal(resS6.ok, true);
  assert.equal(resS6.config.enabled, true);
  assert.equal(resS6.config.autobuyScenario, 'S6');

  const htmlS6 = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlS6.includes('value="S6" checked'), 'S6 radio button must be checked');
  assert(htmlS6.includes('status-s6'), 'Status pill must have status-s6');
  console.log('   ✅ S6 scenario selection verified');

  // 3. Test Select OFF (Keduanya OFF)
  console.log('3. Setting scenario to OFF...');
  const resOff = await updateConfig({ autobuyScenario: 'OFF' });
  assert.equal(resOff.ok, true);
  assert.equal(resOff.config.enabled, false);
  assert.equal(resOff.config.autobuyScenario, 'OFF');

  const htmlOff = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlOff.includes('value="OFF" checked'), 'OFF radio button must be checked');
  assert(htmlOff.includes('status-off'), 'Status pill must have status-off');
  console.log('   ✅ OFF scenario selection verified');

  // 4. Test Select BOTH
  console.log('4. Setting scenario to BOTH...');
  const resBoth = await updateConfig({ autobuyScenario: 'BOTH' });
  assert.equal(resBoth.ok, true);
  assert.equal(resBoth.config.enabled, true);
  assert.equal(resBoth.config.autobuyScenario, 'BOTH');

  const htmlBoth = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlBoth.includes('value="BOTH" checked'), 'BOTH radio button must be checked');
  assert(htmlBoth.includes('status-both'), 'Status pill must have status-both');
  console.log('   ✅ BOTH scenario selection verified');

  // 5. Test Select DRY_RUN (Keduanya Dry Run)
  console.log('5. Setting scenario to DRY_RUN...');
  const resDryRun = await updateConfig({ autobuyScenario: 'DRY_RUN' });
  assert.equal(resDryRun.ok, true);
  assert.equal(resDryRun.config.enabled, true);
  assert.equal(resDryRun.config.autobuyScenario, 'DRY_RUN');

  const htmlDryRun = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlDryRun.includes('value="DRY_RUN" checked'), 'DRY_RUN radio button must be checked');
  assert(htmlDryRun.includes('status-dry_run') || htmlDryRun.includes('status-dryrun'), 'Status pill must have status-dryrun');
  console.log('   ✅ DRY_RUN scenario selection verified');

  // 6. Test Select S5
  console.log('6. Setting scenario to S5...');
  const resS5 = await updateConfig({ autobuyScenario: 'S5', stakeUsdS5: 1.25 });
  assert.equal(resS5.ok, true);
  assert.equal(resS5.config.enabled, true);
  assert.equal(resS5.config.autobuyScenario, 'S5');
  assert.equal(resS5.config.stakeUsdS5, 1.25);

  const fileS5 = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(fileS5.enabled, true);
  assert.equal(fileS5.autobuyScenario, 'S5');
  assert.equal(fileS5.stakeUsdS5, 1.25);

  const htmlS5 = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlS5.includes('value="S5" checked'), 'S5 radio button must be checked');
  assert(htmlS5.includes('status-s5'), 'Status pill must have status-s5');
  assert(htmlS5.includes('s5StakeInput'), 'S5 stake input must be present');
  console.log('   ✅ S5 scenario selection & stake verified');

  // 7. Test Select S9
  console.log('7. Setting scenario to S9...');
  const resS9 = await updateConfig({ autobuyScenario: 'S9', stakeUsdS9: 1.50 });
  assert.equal(resS9.ok, true);
  assert.equal(resS9.config.enabled, true);
  assert.equal(resS9.config.autobuyScenario, 'S9');
  assert.equal(resS9.config.stakeUsdS9, 1.50);

  const fileS9 = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(fileS9.enabled, true);
  assert.equal(fileS9.autobuyScenario, 'S9');
  assert.equal(fileS9.stakeUsdS9, 1.50);

  const htmlS9 = await (await fetch(`${baseUrl}/3scenarios`)).text();
  assert(htmlS9.includes('value="S9" checked'), 'S9 radio button must be checked');
  assert(htmlS9.includes('status-s9'), 'Status pill must have status-s9');
  assert(htmlS9.includes('s9StakeInput'), 'S9 stake input must be present');
  console.log('   ✅ S9 scenario selection & stake verified');

  // 8. Restore to DRY_RUN and default stakes
  console.log('8. Restoring to DRY_RUN...');
  await updateConfig({ autobuyScenario: 'DRY_RUN', stakeUsdS5: 1.0, stakeUsdS9: 1.0 });
  console.log('   ✅ Restored to DRY_RUN');

  console.log('\n✅ All Auto-Buy Scenario Selection tests passed successfully!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
