import assert from 'node:assert/strict';
import { renderScenarioTimelineHtml } from '../scripts/render-scenario-timeline.mjs';

async function run() {
  console.log('Testing renderScenarioTimelineHtml...');

  // Test S4 with shegoin
  const htmlS4 = await renderScenarioTimelineHtml({ scenarioId: 'sce4', tokenQuery: 'shegoin' });
  assert(typeof htmlS4 === 'string', 'Renderer must return a string');
  assert(htmlS4.includes('Skenario 4: Single Buy $5'), 'Must contain S4 title');
  assert(htmlS4.includes('shegoin'), 'Must display requested token shegoin');
  assert(htmlS4.includes('timeline-container'), 'Must include timeline-container element');
  assert(htmlS4.includes('Lihat Request & Response'), 'Must include payload inspection drawer');
  console.log('✅ HTML S4 render verified (length:', htmlS4.length, 'chars)');

  // Test S6 with pairless
  const htmlS6 = await renderScenarioTimelineHtml({ scenarioId: 'sce6', tokenQuery: 'pairless' });
  assert(typeof htmlS6 === 'string', 'Renderer must return a string');
  assert(htmlS6.includes('Skenario 6: Re-Deploy Sniper V2'), 'Must contain S6 title');
  assert(htmlS6.includes('pairless'), 'Must display requested token pairless');
  console.log('✅ HTML S6 render verified (length:', htmlS6.length, 'chars)');

  console.log('\n✅ Task 3 Renderer test passed successfully!');
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
