import assert from 'node:assert/strict';
import { getScenarioTokensList, getScenarioTokenTimeline } from '../scripts/scenarios-timeline-aggregator.mjs';

async function run() {
  console.log('Testing scenarios timeline aggregator...');
  
  // Test sce4 tokens list
  const tokensS4 = await getScenarioTokensList('sce4');
  assert(Array.isArray(tokensS4), 'Tokens list must be an array');
  console.log('Tokens found for sce4:', tokensS4.length);
  if (tokensS4.length > 0) {
    console.log('Latest 3 tokens in sce4:', tokensS4.slice(0, 3).map(t => `${t.symbol} (${t.status})`));
  }

  // Test sce6 tokens list
  const tokensS6 = await getScenarioTokensList('sce6');
  assert(Array.isArray(tokensS6), 'Tokens list must be an array');
  console.log('Tokens found for sce6:', tokensS6.length);

  // Test token timeline
  const targetToken = tokensS4.find(t => t.symbol.toLowerCase() === 'shegoin') || tokensS4[0] || { symbol: 'TEST' };
  console.log(`\nFetching timeline for token: ${targetToken.symbol} on sce4...`);
  const timelineS4 = await getScenarioTokenTimeline('sce4', targetToken.symbol);
  
  assert(timelineS4, 'Timeline must be returned');
  assert(timelineS4.scenarioId === 'sce4', 'Scenario ID must match');
  assert(Array.isArray(timelineS4.steps), 'Steps must be an array');

  console.log(`Timeline steps generated: ${timelineS4.steps.length}`);
  timelineS4.steps.forEach((s, idx) => {
    console.log(`  [Step ${idx + 1}] ${s.timeWib} | ${s.type} | ${s.title}`);
  });

  // Verify request and response payloads exist on steps if present
  const swapStep = timelineS4.steps.find(s => s.type.includes('API_SWAP'));
  if (swapStep) {
    assert(swapStep.request, 'Swap step must have request data');
    assert(swapStep.response, 'Swap step must have response data');
    console.log('\nSample Swap Step Request:', swapStep.request);
    console.log('Sample Swap Step Response:', swapStep.response);
  }

  console.log('\n✅ Task 1 Aggregator tests passed successfully!');
  return;
}

run().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
