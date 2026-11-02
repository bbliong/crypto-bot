import assert from 'node:assert/strict';
import { renderScenarioTimelineHtml } from '../scripts/render-scenario-timeline.mjs';
import { getScenarioTokensList } from '../scripts/scenarios-timeline-aggregator.mjs';

async function run() {
  console.log('Testing renderScenarioTimelineHtml...');

  const tokens = await getScenarioTokensList('sce4');
  const testToken = tokens.length > 0 ? tokens[0].symbol : 'DOGE';

  // Test S4 with testToken
  const htmlS4 = await renderScenarioTimelineHtml({ scenarioId: 'sce4', tokenQuery: testToken });
  assert(typeof htmlS4 === 'string', 'Renderer must return a string');
  assert(htmlS4.includes('Skenario 4: Single Buy'), 'Must contain S4 title');
  assert(htmlS4.includes(testToken), `Must display requested token ${testToken}`);
  assert(htmlS4.includes('timeline-container'), 'Must include timeline-container element');
  assert(htmlS4.includes('Lihat Request & Response'), 'Must include payload inspection drawer');
  console.log('✅ HTML S4 render verified (length:', htmlS4.length, 'chars)');

  // Test S6 with testToken
  const htmlS6 = await renderScenarioTimelineHtml({ scenarioId: 'sce6', tokenQuery: testToken });
  assert(typeof htmlS6 === 'string', 'Renderer must return a string');
  assert(htmlS6.includes('Skenario 6: Re-Deploy Sniper V2'), 'Must contain S6 title');
  assert(htmlS6.includes(testToken), `Must display requested token ${testToken}`);
  console.log('✅ HTML S6 render verified (length:', htmlS6.length, 'chars)');

  console.log('\n✅ Task 3 Renderer test passed successfully!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
