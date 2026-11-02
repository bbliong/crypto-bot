import assert from 'node:assert/strict';
import { render3ScenariosLiveHtml } from '../scripts/render-3scenarios-live.mjs';

console.log('Testing scenario capital inputs rendering in 3scenarios dashboard...');

const html = render3ScenariosLiveHtml();

// Check S4 has 1 stake input
assert(html.includes('id="s4StakeInput"'), 'Must include s4StakeInput');
assert(html.includes('saveS4Stake()'), 'Must include saveS4Stake() function call');

// Check S6 has 2 stake inputs
assert(html.includes('id="s6Pool1Input"'), 'Must include s6Pool1Input');
assert(html.includes('id="s6Pool2Input"'), 'Must include s6Pool2Input');
assert(html.includes('saveS6Stake()'), 'Must include saveS6Stake() function call');

// Check scripts contain handler functions
assert(html.includes('function saveS4Stake()'), 'Script must define saveS4Stake()');
assert(html.includes('function saveS6Stake()'), 'Script must define saveS6Stake()');

console.log('✅ Scenario capital inputs HTML test passed!');
