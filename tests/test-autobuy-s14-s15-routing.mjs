/**
 * Regression tests: S14 / S14_ALPHA / S15 (alias S14_BETA) auto-buy routing
 *
 * RED phase: Tests written BEFORE implementation.
 * Run with: node --import tsx tests/test-autobuy-s14-s15-routing.mjs
 *
 * Contract:
 *  - isScenarioAllowedForRealOrder(scenarioId, config) returns true IFF:
 *      config.enabled === true AND config.autobuyScenario matches canonically.
 *  - OFF, DRY_RUN, enabled=false → always false (no cross-scenario activation).
 *  - S4 canonical match must NOT activate on scenarioId 'SCENARIO_14_BUNDLER_RUNNER'.
 *  - S5 canonical match must NOT activate on scenarioId 'SCENARIO_14_BETA_HOARDING_DEFENSE'.
 *  - S13_ALPHA canonical match must NOT activate on 'SCENARIO_14_ALPHA_60S_GRACE'.
 *  - S13_BETA canonical match must NOT activate on 'SCENARIO_14_BETA_HOARDING_DEFENSE'.
 *  - S14 must activate 'SCENARIO_14_BUNDLER_RUNNER' only.
 *  - S14_ALPHA must activate 'SCENARIO_14_ALPHA_60S_GRACE' only.
 *  - S15 (alias S14_BETA) must activate 'SCENARIO_14_BETA_HOARDING_DEFENSE' only.
 *  - BOTH / ALL must activate all three.
 *  - Composite 'S14+S14_ALPHA' must activate both but not S14_BETA.
 *  - stakeUsdS14, stakeUsdS14Alpha, stakeUsdS14Beta / stakeUsdS15 persist through config API.
 *  - UI render includes radio options value="S14", value="S14_ALPHA", value="S15".
 *  - UI render includes s14StakeInput, s14AlphaStakeInput, s15StakeInput IDs.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Import the pure helper from follower-live-store
// ─────────────────────────────────────────────────────────────────────────────

// We import the compiled JS or TS source via dynamic import.
// Because run-wallet-follower.ts is not compiled separately, we extract the
// isScenarioAllowedForRealOrder logic from its standalone exported helper.
// (Post-implementation this will come from src/autobuy-scenario-guard.ts)

let isScenarioAllowedForRealOrder;
let saveFollowerLiveConfig;
let readFollowerLiveConfig;
let FOLLOWER_LIVE_DEFAULTS;

const tmpDir = mkdtempSync(join(tmpdir(), 'autobuy-s14-test-'));

async function loadModules() {
  // Load follower-live-store from compiled dist or directly from ts via tsx
  try {
    const mod = await import('../src/autobuy-scenario-guard.js');
    isScenarioAllowedForRealOrder = mod.isScenarioAllowedForRealOrder;
  } catch (e) {
    // Fallback: try tsx transpiled version
    try {
      const mod = await import('../src/autobuy-scenario-guard.ts');
      isScenarioAllowedForRealOrder = mod.isScenarioAllowedForRealOrder;
    } catch (e2) {
      throw new Error(
        `Cannot import isScenarioAllowedForRealOrder from src/autobuy-scenario-guard: ${e2.message}.\n` +
        `Ensure src/autobuy-scenario-guard.ts is created (GREEN phase).`
      );
    }
  }

  try {
    // Load follower-live-store helpers
    const lsPath = new URL('../src/follower-live-store.js', import.meta.url);
    let lsMod;
    try {
      lsMod = await import(lsPath.href);
    } catch {
      lsMod = await import('../src/follower-live-store.ts');
    }
    saveFollowerLiveConfig = lsMod.saveFollowerLiveConfig;
    readFollowerLiveConfig = lsMod.readFollowerLiveConfig;
    FOLLOWER_LIVE_DEFAULTS = lsMod.FOLLOWER_LIVE_DEFAULTS;
  } catch (e) {
    throw new Error(`Cannot import follower-live-store: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(autobuyScenario, enabled = true, extra = {}) {
  return { enabled, autobuyScenario, ...extra };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Test suites
// ─────────────────────────────────────────────────────────────────────────────

function runRoutingTests() {
  let pass = 0, fail = 0;
  const results = [];

  function check(label, actual, expected) {
    if (actual === expected) {
      pass++;
      results.push(`  ✅ ${label}`);
    } else {
      fail++;
      results.push(`  ❌ ${label}: expected ${expected}, got ${actual}`);
    }
  }

  // ── Negative: OFF / DRY_RUN / disabled always deny ──────────────────────
  check('OFF → S14: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('OFF')), false);
  check('DRY_RUN → S14: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('DRY_RUN')), false);
  check('enabled=false → S14: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S14', false)), false);
  check('OFF → S14_ALPHA: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('OFF')), false);
  check('DRY_RUN → S15: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('DRY_RUN')), false);
  check('enabled=false → S15: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S15', false)), false);

  // ── CRITICAL collision guard: S4 must NOT match S14 ─────────────────────
  check('S4 → SCENARIO_14_BUNDLER_RUNNER: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S4')), false);
  check('S4 → SCENARIO_14_ALPHA_60S_GRACE: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S4')), false);
  check('S4 → SCENARIO_14_BETA_HOARDING_DEFENSE: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S4')), false);

  // ── CRITICAL collision guard: S5 must NOT match S15 / S14_BETA ──────────
  check('S5 → SCENARIO_14_BETA_HOARDING_DEFENSE: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S5')), false);
  check('S5 → SCENARIO_14_BUNDLER_RUNNER: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S5')), false);

  // ── CRITICAL: S13_ALPHA must NOT match S14_ALPHA ─────────────────────────
  check('S13_ALPHA → SCENARIO_14_ALPHA_60S_GRACE: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S13_ALPHA')), false);
  check('S13_ALPHA → SCENARIO_14_BUNDLER_RUNNER: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S13_ALPHA')), false);

  // ── CRITICAL: S13_BETA must NOT match S14_BETA / S15 ────────────────────
  check('S13_BETA → SCENARIO_14_BETA_HOARDING_DEFENSE: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S13_BETA')), false);
  check('S13_BETA → SCENARIO_14_BUNDLER_RUNNER: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S13_BETA')), false);

  // ── CRITICAL: S13_ALPHA_1 must NOT match S14 group ──────────────────────
  check('S13_ALPHA_1 → S14_ALPHA: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S13_ALPHA_1')), false);
  check('S13_BETA_1 → S14_BETA: NO collision',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S13_BETA_1')), false);

  // ── Reverse: S14 must NOT match S13 group ───────────────────────────────
  check('S14 → SCENARIO_13_PING_PONG: no cross-activate',
    isScenarioAllowedForRealOrder('SCENARIO_13_PING_PONG_WHALE', makeConfig('S14')), false);
  check('S14_ALPHA → SCENARIO_13_ALPHA: no cross-activate',
    isScenarioAllowedForRealOrder('SCENARIO_13_ALPHA_WHALE_RIDER', makeConfig('S14_ALPHA')), false);
  check('S15 → SCENARIO_13_BETA_PANIC: no cross-activate',
    isScenarioAllowedForRealOrder('SCENARIO_13_BETA_PANIC_RESCUE', makeConfig('S15')), false);

  // ── Positive: S14 activates SCENARIO_14_BUNDLER_RUNNER only ─────────────
  check('S14 → SCENARIO_14_BUNDLER_RUNNER: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S14')), true);
  check('S14 → SCENARIO_14_ALPHA_60S_GRACE: deny (not selected)',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S14')), false);
  check('S14 → SCENARIO_14_BETA_HOARDING_DEFENSE: deny (not selected)',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S14')), false);

  // ── Positive: S14_ALPHA activates SCENARIO_14_ALPHA_60S_GRACE only ──────
  check('S14_ALPHA → SCENARIO_14_ALPHA_60S_GRACE: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S14_ALPHA')), true);
  check('S14_ALPHA → SCENARIO_14_BUNDLER_RUNNER: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S14_ALPHA')), false);
  check('S14_ALPHA → SCENARIO_14_BETA_HOARDING_DEFENSE: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S14_ALPHA')), false);

  // ── Positive: S15 activates SCENARIO_14_BETA_HOARDING_DEFENSE ───────────
  check('S15 → SCENARIO_14_BETA_HOARDING_DEFENSE: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S15')), true);
  check('S15 → SCENARIO_14_BUNDLER_RUNNER: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S15')), false);
  check('S15 → SCENARIO_14_ALPHA_60S_GRACE: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S15')), false);

  // ── Alias: S14_BETA accepted as alias for S15 ───────────────────────────
  check('S14_BETA alias → SCENARIO_14_BETA_HOARDING_DEFENSE: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S14_BETA')), true);
  check('S14_BETA alias → SCENARIO_14_BUNDLER_RUNNER: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S14_BETA')), false);

  // ── Composite: S14+S14_ALPHA activates both but not S14_BETA ────────────
  check('S14+S14_ALPHA → S14: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S14+S14_ALPHA')), true);
  check('S14+S14_ALPHA → S14_ALPHA: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S14+S14_ALPHA')), true);
  check('S14+S14_ALPHA → S14_BETA: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S14+S14_ALPHA')), false);

  // ── Composite with S15 ───────────────────────────────────────────────────
  check('S14+S15 → S14: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('S14+S15')), true);
  check('S14+S15 → S15: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('S14+S15')), true);
  check('S14+S15 → S14_ALPHA: deny',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('S14+S15')), false);

  // ── BOTH / ALL activates all including S14 group ─────────────────────────
  check('BOTH → S14: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('BOTH')), true);
  check('BOTH → S14_ALPHA: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_ALPHA_60S_GRACE', makeConfig('BOTH')), true);
  check('BOTH → S15: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BETA_HOARDING_DEFENSE', makeConfig('BOTH')), true);
  check('ALL → S14: allow',
    isScenarioAllowedForRealOrder('SCENARIO_14_BUNDLER_RUNNER', makeConfig('ALL')), true);

  // ── Legacy scenarios still work correctly ────────────────────────────────
  check('S4 → SCENARIO_4_SINGLE_BUY: allow',
    isScenarioAllowedForRealOrder('SCENARIO_4_SINGLE_BUY_5USD', makeConfig('S4')), true);
  check('S5 → SCENARIO_5_ANTI_SHAKEOUT: allow',
    isScenarioAllowedForRealOrder('SCENARIO_5_ANTI_SHAKEOUT', makeConfig('S5')), true);
  check('S13 → SCENARIO_13_PING_PONG: allow',
    isScenarioAllowedForRealOrder('SCENARIO_13_PING_PONG_WHALE', makeConfig('S13')), true);
  check('S13_ALPHA → SCENARIO_13_ALPHA_WHALE: allow',
    isScenarioAllowedForRealOrder('SCENARIO_13_ALPHA_WHALE_RIDER', makeConfig('S13_ALPHA')), true);
  check('S13_BETA → SCENARIO_13_BETA_PANIC: allow',
    isScenarioAllowedForRealOrder('SCENARIO_13_BETA_PANIC_RESCUE', makeConfig('S13_BETA')), true);
  check('S13_ALPHA_1 → SCENARIO_13_ALPHA_1_WAVE_RIDER: allow',
    isScenarioAllowedForRealOrder('SCENARIO_13_ALPHA_1_WAVE_RIDER', makeConfig('S13_ALPHA_1')), true);
  check('S13_BETA_1 → SCENARIO_13_BETA_1_WAVE_RIDER: allow',
    isScenarioAllowedForRealOrder('SCENARIO_13_BETA_1_WAVE_RIDER', makeConfig('S13_BETA_1')), true);

  results.forEach(r => console.log(r));
  return { pass, fail };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Config API tests (saveFollowerLiveConfig)
// ─────────────────────────────────────────────────────────────────────────────

function runConfigTests() {
  let pass = 0, fail = 0;
  const results = [];

  function check(label, actual, expected) {
    if (actual === expected) {
      pass++;
      results.push(`  ✅ ${label}`);
    } else {
      fail++;
      results.push(`  ❌ ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  // S14 scenario saves with correct enabled state
  const c1 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S14' });
  check('S14 saves: enabled=false (real trading guard)', c1.enabled, false);
  check('S14 saves: autobuyScenario=S14', c1.autobuyScenario, 'S14');
  check('S14 saves: stakeUsdS14 defaults to 5.0', c1.stakeUsdS14, 5.0);

  // S14_ALPHA scenario saves correctly
  const c2 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S14_ALPHA' });
  check('S14_ALPHA saves: enabled=false', c2.enabled, false);
  check('S14_ALPHA saves: autobuyScenario=S14_ALPHA', c2.autobuyScenario, 'S14_ALPHA');
  check('S14_ALPHA saves: stakeUsdS14Alpha defaults to 5.0', c2.stakeUsdS14Alpha, 5.0);

  // S15 scenario saves correctly
  const c3 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S15' });
  check('S15 saves: enabled=false', c3.enabled, false);
  check('S15 saves: autobuyScenario=S15', c3.autobuyScenario, 'S15');
  check('S15 saves: stakeUsdS15 defaults to 5.0', c3.stakeUsdS15, 5.0);

  // S14_BETA alias saves as S15 canonical
  const c4 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S14_BETA' });
  check('S14_BETA alias saves: enabled=false', c4.enabled, false);
  // Alias: saved value should be 'S14_BETA' or 'S15' (both acceptable)
  check('S14_BETA alias saves: autobuyScenario preserved', ['S14_BETA', 'S15'].includes(c4.autobuyScenario), true);

  // Custom stake persists for S14
  const c5 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S14', stakeUsdS14: 2.5 });
  check('S14 custom stake: stakeUsdS14=2.5', c5.stakeUsdS14, 2.5);
  check('S14 custom stake: enabled=false', c5.enabled, false);

  // Custom stake persists for S14_ALPHA
  const c6 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S14_ALPHA', stakeUsdS14Alpha: 3.0 });
  check('S14_ALPHA custom stake: stakeUsdS14Alpha=3.0', c6.stakeUsdS14Alpha, 3.0);

  // Custom stake persists for S15
  const c7 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S15', stakeUsdS15: 1.5 });
  check('S15 custom stake: stakeUsdS15=1.5', c7.stakeUsdS15, 1.5);

  // stakeUsdS14Beta alias also sets stakeUsdS15
  const c8 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'S15', stakeUsdS14Beta: 0.75 });
  check('stakeUsdS14Beta alias persists', c8.stakeUsdS14Beta, 0.75);

  // OFF still saves as disabled
  const c9 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'OFF' });
  check('OFF saves: enabled=false', c9.enabled, false);

  // DRY_RUN saves correctly
  const c10 = saveFollowerLiveConfig(tmpDir, { autobuyScenario: 'DRY_RUN' });
  check('DRY_RUN saves: autobuyScenario=DRY_RUN', c10.autobuyScenario, 'DRY_RUN');
  // DRY_RUN must NOT set enabled=true (live trading guard)
  check('DRY_RUN saves: enabled=false (real trading guard)', c10.enabled, false);

  // Stake bounds: below minimum → clamp to 0.05
  const c11 = saveFollowerLiveConfig(tmpDir, { stakeUsdS14: 0.001 });
  check('S14 stake below min clamps to 0.05', c11.stakeUsdS14, 0.05);

  // Stake bounds: above maximum → clamp to 1000
  const c12 = saveFollowerLiveConfig(tmpDir, { stakeUsdS14Alpha: 99999 });
  check('S14_ALPHA stake above max clamps to 1000', c12.stakeUsdS14Alpha, 1000);

  results.forEach(r => console.log(r));
  return { pass, fail };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. UI render tests (render-3scenarios-live.mjs)
// ─────────────────────────────────────────────────────────────────────────────

async function runUiRenderTests() {
  let pass = 0, fail = 0;
  const results = [];

  function check(label, condition) {
    if (condition) {
      pass++;
      results.push(`  ✅ ${label}`);
    } else {
      fail++;
      results.push(`  ❌ ${label}: condition false`);
    }
  }

  // Build a minimal mock autobuy config file for the renderer
  const mockData = {
    enabled: false,
    autobuyScenario: 'DRY_RUN',
    stakeUsdS14: 5.0,
    stakeUsdS14Alpha: 5.0,
    stakeUsdS15: 5.0,
    stakeUsdS14Beta: 5.0,
  };

  // Temporarily write to data dir for the render function
  const dataDir = new URL('../data/', import.meta.url);
  const tmpSettings = join(tmpDir, 'follower-autobuy-settings.json');
  writeFileSync(tmpSettings, JSON.stringify(mockData, null, 2));

  let render3ScenariosLiveHtml;
  try {
    const mod = await import('../scripts/render-3scenarios-live.mjs');
    render3ScenariosLiveHtml = mod.render3ScenariosLiveHtml;
  } catch (e) {
    // If it uses a fixed data dir, we can't override - skip render tests with note
    throw new Error(`UI renderer must import successfully: ${e.message}`);
  }

  // Generate HTML with defaults (DRY_RUN)
  let html = '';
  try {
    html = render3ScenariosLiveHtml({ dataDir: tmpDir });
  } catch (e) {
    throw new Error(`UI render failed: ${e.message}`);
  }

  // Check for new S14 radio option
  check('UI: radio value="S14" present', html.includes('value="S14"'));
  check('UI: S14 radio onchange present', html.includes('S14') && html.includes('setAutobuyScenario'));

  // Check for S14_ALPHA radio option
  check('UI: radio value="S14_ALPHA" present', html.includes('value="S14_ALPHA"'));

  // Check for S15 radio option
  check('UI: radio value="S15" present', html.includes('value="S15"'));

  // Check stake inputs exist
  check('UI: s14StakeInput present', html.includes('s14StakeInput'));
  check('UI: s14AlphaStakeInput present', html.includes('s14AlphaStakeInput'));
  check('UI: s15StakeInput present', html.includes('s15StakeInput'));

  // Check no auto-selection on DRY_RUN (none of S14/S14_ALPHA/S15 should be checked)
  const s14CheckedActive = html.includes('value="S14" checked') || html.includes("value='S14' checked");
  check('UI: S14 NOT auto-selected when DRY_RUN', !s14CheckedActive);

  results.forEach(r => console.log(r));
  return { pass, fail };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Main runner
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   S14 / S14_ALPHA / S15 Auto-Buy Routing — Regression Test  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  try {
    await loadModules();
  } catch (e) {
    console.log(`❌ Module load failed (expected RED): ${e.message}\n`);
    process.exit(2); // RED: modules not yet implemented
  }

  let totalPass = 0, totalFail = 0;

  console.log('── 1. Routing Logic Tests ──────────────────────────────────────');
  const r1 = runRoutingTests();
  totalPass += r1.pass;
  totalFail += r1.fail;
  console.log(`   Routing: ${r1.pass} pass, ${r1.fail} fail\n`);

  console.log('── 2. Config API Tests ─────────────────────────────────────────');
  const r2 = runConfigTests();
  totalPass += r2.pass;
  totalFail += r2.fail;
  console.log(`   Config:  ${r2.pass} pass, ${r2.fail} fail\n`);

  console.log('── 3. UI Render Tests ──────────────────────────────────────────');
  const r3 = await runUiRenderTests();
  if (!r3.skipped) {
    totalPass += r3.pass;
    totalFail += r3.fail;
  }
  console.log(`   UI:      ${r3.skipped ? 'skipped (data dir)' : `${r3.pass} pass, ${r3.fail} fail`}\n`);

  console.log('══════════════════════════════════════════════════════════════');
  if (totalFail === 0) {
    console.log(`✅ ALL TESTS PASSED: ${totalPass} pass, 0 fail`);
    process.exit(0);
  } else {
    console.log(`❌ SOME TESTS FAILED: ${totalPass} pass, ${totalFail} fail`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
