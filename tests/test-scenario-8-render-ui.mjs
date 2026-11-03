import assert from 'node:assert/strict';
import { render3ScenariosLiveHtml } from '../scripts/render-3scenarios-live.mjs';

console.log('Testing Scenario 8 Render UI...');
const html = render3ScenariosLiveHtml();

assert(html.includes('Skenario 8: Front-Run Dev'), 'HTML must include Scenario 8 name');
assert(html.includes('value="S8"'), 'HTML must include S8 radio option');
assert(html.includes('id="s8StakeInput"'), 'HTML must include S8 stake input');
assert(html.includes('saveS8Stake'), 'HTML must include saveS8Stake function');
assert(html.includes('sce8'), 'HTML must include sce8 scenario card / links');

console.log('🎉 Scenario 8 Render UI Test Passed 100%!');
