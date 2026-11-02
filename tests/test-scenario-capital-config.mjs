import assert from 'node:assert/strict';
import { readFollowerLiveConfig, saveFollowerLiveConfig } from '../src/follower-live-store.js';

const dataDir = './data';

console.log('Testing scenario capital configuration...');

const original = readFollowerLiveConfig(dataDir);

const updated = saveFollowerLiveConfig(dataDir, {
  stakeUsdS4: 8.5,
  stakeUsdS6Pool1: 6.0,
  stakeUsdS6Pool2: 12.0
});

assert.equal(updated.stakeUsdS4, 8.5, 'stakeUsdS4 must be updated to 8.5');
assert.equal(updated.stakeUsdS6Pool1, 6.0, 'stakeUsdS6Pool1 must be updated to 6.0');
assert.equal(updated.stakeUsdS6Pool2, 12.0, 'stakeUsdS6Pool2 must be updated to 12.0');

const readBack = readFollowerLiveConfig(dataDir);
assert.equal(readBack.stakeUsdS4, 8.5, 'readBack.stakeUsdS4 must be 8.5');
assert.equal(readBack.stakeUsdS6Pool1, 6.0, 'readBack.stakeUsdS6Pool1 must be 6.0');
assert.equal(readBack.stakeUsdS6Pool2, 12.0, 'readBack.stakeUsdS6Pool2 must be 12.0');

// Restore original values or defaults
saveFollowerLiveConfig(dataDir, {
  stakeUsdS4: original.stakeUsdS4 || 5.0,
  stakeUsdS6Pool1: original.stakeUsdS6Pool1 || 5.0,
  stakeUsdS6Pool2: original.stakeUsdS6Pool2 || 7.0,
  autobuyScenario: original.autobuyScenario || 'S4',
  enabled: original.enabled !== undefined ? original.enabled : true
});

console.log('✅ Configuration schema test passed!');
