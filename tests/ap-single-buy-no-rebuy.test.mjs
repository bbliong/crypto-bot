/**
 * Regression Test: AP1/AP2/AP3 — 1 Entry Per Mint, No Rebuy After Exit
 *
 * Context: Mint F98d9RHir1UGqCgVAtbNc2EsQNqGF5txyJq9PNqoVuE2 triggered a rebuy
 * after whale zeroed out and feed replayed isFirstBuy=true + groundZero=true.
 *
 * Root cause: evaluateS14AlphaBundlerEntry (AP2) and evaluateS14BetaBundlerEntry (AP3)
 * lacked the closedTrades/openPositions guard that AP1 (evaluateS14BundlerEntry)
 * already had. processScenarioBuy with allowReEntryCycle:true bypasses the common
 * alreadyTraded guard, so the per-evaluator guard is authoritative.
 *
 * Fix: add identical guard to AP2 and AP3 evaluators, and consolidate into
 * processScenarioBuy as a secondary safety net for the AP family.
 *
 * Provenance: Hermes dirty patch (AP1-only) in
 *   /home/bbliong/.hermes/cache/scratch/ap-no-rebuy-before.patch
 *   This test covers the full AP1/AP2/AP3 scope and restart-persistence requirement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MultiScenarioDryRunEngine } from '../src/multi-scenario-dryrun-engine.ts';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

// Use a stable mint from the real case for regression traceability
const CASE_MINT = 'F98d9RHir1UGqCgVAtbNc2EsQNqGF5txyJq9PNqoVuE2';
const ALT_MINT  = 'AltMintDifferent111111111111111111111111111111'; // different mint same symbol

function makeScratch(label) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), `test-ap-no-rebuy-${label}-`));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEngine(dir) {
  const engine = new MultiScenarioDryRunEngine(dir);
  // Stub network calls
  engine.bundlerResolver = async () => null;
  engine.startBundlerResearchTracker = () => {};
  engine.queryGmgnTokenStatRaw = async () => null;
  // Offline executable quote fixture: intent alone must never close or fill AP.
  // Retain observers used by callback-count assertions without bypassing settlement.
  let observer;
  Object.defineProperty(engine, 'onTradeAction', {
    get: () => (action, id, signal, details) => {
      observer?.(action, id, signal, details);
      const ticket=details.quoteTicket;
      if (!ticket) return;
      if (action==='BUY') {
        const units=Math.floor(details.stakeUsd / signal.priceUsd * 1e6).toString();
        const tokens=Number(units)/1e6;
        engine.syncRealBuyExecution(id,signal.mint,details.stakeUsd/tokens,tokens,details.stakeUsd,
          {...ticket,baseUnits:units,decimals:6});
      } else engine.syncRealSellExecution(id,signal.mint,details.priceUsd,
        ticket.tokens*details.priceUsd,details.reason,ticket);
    },
    set: value => { observer=value; },
    configurable:true,
  });
  return engine;
}

/**
 * Build a minimal first-buy signal that qualifies for S14 tracking.
 * ageSec: simulated token age (seconds before now), so whaleFirstBuyAt = now - ageSec*1000
 */
function mkFirstBuySignal(mint, { symbol = 'TESTTKN', ageSec = 0, priceUsd = 0.000036 } = {}) {
  const ts = Math.floor((Date.now() - ageSec * 1000) / 1000);
  return {
    action: 'buy',
    mint,
    symbol,
    tokenName: symbol,
    tokenAmount:        70_000_000,
    remainingHolding:   70_000_000,
    solAmount:          30,
    usdAmount:          2700,
    priceUsd,
    txHash:             `first_buy_${mint.slice(0,8)}_${Date.now()}`,
    timestamp:          ts,
    isOpenOrClose:      true,
    isFirstBuy:         true,
    pairAddress:        '', // no RPC path in offline tests
    exchange:           'raydium',
    ad:                 `WhaleWallet${mint.slice(0,8)}`,
  };
}

/**
 * Force tracker timestamps to simulate age >= 60 s (for AP2/AP3 grace period).
 */
function backdateTrackers(engine, mint, ageSec = 65) {
  const t = Date.now() - ageSec * 1000;
  const a = engine['s14AlphaTrackers'].get(mint);
  const b = engine['s14BetaTrackers'].get(mint);
  if (a) a.whaleFirstBuyAt = t;
  if (b) b.whaleFirstBuyAt = t;
}

/**
 * Trigger a qualifying bundler entry for all three APs at once.
 * bundlerPct >= 5; ageSec must be >= 60 for AP2/AP3 to qualify.
 */
function triggerBundlerEntry(engine, mint, bundlerPct = 7.5, currentPrice = 0.000063) {
  engine.evaluateS14BundlerEntry(mint, bundlerPct, currentPrice);
  engine.evaluateS14AlphaBundlerEntry(mint, bundlerPct, currentPrice);
  engine.evaluateS14BetaBundlerEntry(mint, bundlerPct, currentPrice);
}

/**
 * Trigger a giant whale sell that exits all three APs.
 */
function triggerWhaleExit(engine, mint, symbol = 'TESTTKN') {
  engine.handleTargetSell({
    action: 'sell',
    mint,
    symbol,
    tokenName: symbol,
    tokenAmount:        50_000_000,
    remainingHolding:   0,            // whale zeroes out
    solAmount:          20,           // >= 15 SOL → giant sell
    usdAmount:          1800,
    priceUsd:           0.000036,
    txHash:             `exit_${mint.slice(0,8)}_${Date.now()}`,
    timestamp:          Math.floor(Date.now() / 1000),
    isOpenOrClose:      false,
    isFirstBuy:         false,
  });
}

// ============================================================
// TEST 1: AP1 — no rebuy after exit (pre-existing guard)
// ============================================================
test('AP1 (S14): no second BUY for same mint after exit + feed replay isFirstBuy=true', async () => {
  const dir = makeScratch('ap1');
  const engine = makeEngine(dir);

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);

  // --- First entry ---
  const cashBefore = engine.scenarios.s14.availableCash;
  triggerBundlerEntry(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14.openPositions.length, 1, 'AP1: first BUY created');
  assert.ok(engine.scenarios.s14.availableCash < cashBefore, 'AP1: cash reduced on first buy');

  // --- Exit position ---
  triggerWhaleExit(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14.openPositions.length, 0,  'AP1: position exited');
  assert.equal(engine.scenarios.s14.closedTrades.length, 1,   'AP1: trade in closedTrades');

  const cashAfterExit = engine.scenarios.s14.availableCash;

  // --- Feed replays first-buy + ground-zero for same mint ---
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);

  assert.equal(engine.scenarios.s14.openPositions.length, 0,  'AP1: NO rebuy after exit');
  assert.equal(engine.scenarios.s14.closedTrades.length, 1,   'AP1: closedTrades count unchanged');
  assert.equal(engine.scenarios.s14.availableCash, cashAfterExit, 'AP1: cash unchanged (no second buy)');

  // Check SKIP event logged
  const skipEvent = engine.scenarios.s14.recentEvents.find(
    e => e.action === 'SKIP' && e.mint === CASE_MINT && e.reason.includes('REJECT_ALREADY_TRADED')
  );
  assert.ok(skipEvent, 'AP1: REJECT_ALREADY_TRADED SKIP event emitted');
});

// ============================================================
// TEST 2: AP2 — no rebuy after exit (THE ACTUAL REGRESSION)
// ============================================================
test('AP2 (S14-Alpha): no second BUY for same mint after exit + feed replay isFirstBuy=true', async () => {
  const dir = makeScratch('ap2');
  const engine = makeEngine(dir);

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);

  // --- First entry ---
  const cashBefore = engine.scenarios.s14_alpha.availableCash;
  triggerBundlerEntry(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'AP2: first BUY created');
  assert.ok(engine.scenarios.s14_alpha.availableCash < cashBefore, 'AP2: cash reduced on first buy');

  // --- Exit position ---
  triggerWhaleExit(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 0,  'AP2: position exited');
  assert.equal(engine.scenarios.s14_alpha.closedTrades.length, 1,   'AP2: trade in closedTrades');

  const cashAfterExit = engine.scenarios.s14_alpha.availableCash;

  // --- Feed replays first-buy + ground-zero for same mint ---
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);

  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 0,  'AP2: NO rebuy after exit');
  assert.equal(engine.scenarios.s14_alpha.closedTrades.length, 1,   'AP2: closedTrades count unchanged');
  assert.equal(engine.scenarios.s14_alpha.availableCash, cashAfterExit, 'AP2: cash unchanged (no second buy)');

  // Check SKIP event logged
  const skipEvent = engine.scenarios.s14_alpha.recentEvents.find(
    e => e.action === 'SKIP' && e.mint === CASE_MINT && e.reason.includes('REJECT_ALREADY_TRADED')
  );
  assert.ok(skipEvent, 'AP2: REJECT_ALREADY_TRADED SKIP event emitted');
});

// ============================================================
// TEST 3: AP3 — no rebuy after exit (THE ACTUAL REGRESSION)
// ============================================================
test('AP3 (S14-Beta): no second BUY for same mint after exit + feed replay isFirstBuy=true', async () => {
  const dir = makeScratch('ap3');
  const engine = makeEngine(dir);

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);

  // --- First entry ---
  const cashBefore = engine.scenarios.s14_beta.availableCash;
  triggerBundlerEntry(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_beta.openPositions.length, 1, 'AP3: first BUY created');
  assert.ok(engine.scenarios.s14_beta.availableCash < cashBefore, 'AP3: cash reduced on first buy');

  // --- Exit position ---
  triggerWhaleExit(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_beta.openPositions.length, 0,  'AP3: position exited');
  assert.equal(engine.scenarios.s14_beta.closedTrades.length, 1,   'AP3: trade in closedTrades');

  const cashAfterExit = engine.scenarios.s14_beta.availableCash;

  // --- Feed replays first-buy + ground-zero for same mint ---
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);

  assert.equal(engine.scenarios.s14_beta.openPositions.length, 0,  'AP3: NO rebuy after exit');
  assert.equal(engine.scenarios.s14_beta.closedTrades.length, 1,   'AP3: closedTrades count unchanged');
  assert.equal(engine.scenarios.s14_beta.availableCash, cashAfterExit, 'AP3: cash unchanged (no second buy)');

  // Check SKIP event logged
  const skipEvent = engine.scenarios.s14_beta.recentEvents.find(
    e => e.action === 'SKIP' && e.mint === CASE_MINT && e.reason.includes('REJECT_ALREADY_TRADED')
  );
  assert.ok(skipEvent, 'AP3: REJECT_ALREADY_TRADED SKIP event emitted');
});

// ============================================================
// TEST 4: Per-AP isolation — AP2/AP3 reject does NOT block AP1
// ============================================================
test('AP isolation: AP2 reject does not block AP1 on different mint', async () => {
  const dir = makeScratch('isolation');
  const engine = makeEngine(dir);

  // AP2: buy+exit on CASE_MINT
  const sig1 = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig1, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'isolation: AP2 first buy CASE_MINT');
  triggerWhaleExit(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_alpha.closedTrades.length, 1,  'isolation: AP2 closed CASE_MINT');

  // AP1: buy ALT_MINT — should still be eligible (different mint)
  const sig2 = mkFirstBuySignal(ALT_MINT, { symbol: 'ALTTK', ageSec: 65 });
  engine.handleTargetBuy(sig2, true);
  backdateTrackers(engine, ALT_MINT, 65);
  engine.evaluateS14BundlerEntry(ALT_MINT, 7.5, 0.000063);
  assert.equal(engine.scenarios.s14.openPositions.length, 1, 'isolation: AP1 buys ALT_MINT (not blocked)');
});

// ============================================================
// TEST 5: Same symbol, different mint — eligible
// ============================================================
test('Same symbol different mint stays eligible for each AP', async () => {
  const dir = makeScratch('sym-diff-mint');
  const engine = makeEngine(dir);

  // Buy + exit CASE_MINT
  const sig1 = mkFirstBuySignal(CASE_MINT, { symbol: 'SHRD', ageSec: 65 });
  engine.handleTargetBuy(sig1, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);
  triggerWhaleExit(engine, CASE_MINT, 'SHRD');

  assert.equal(engine.scenarios.s14_alpha.closedTrades.length, 1,       'sym-diff: AP2 closed CASE_MINT');

  // Different mint, same symbol — must still be eligible
  const sig2 = mkFirstBuySignal(ALT_MINT, { symbol: 'SHRD', ageSec: 65 });
  engine.handleTargetBuy(sig2, true);
  backdateTrackers(engine, ALT_MINT, 65);
  engine.evaluateS14AlphaBundlerEntry(ALT_MINT, 7.5, 0.000063);

  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1,
    'sym-diff: AP2 BUY different mint same symbol (not blocked by symbol match)');
});

// ============================================================
// TEST 6: AP isolation — AP1 blocked does NOT block AP2/AP3
// ============================================================
test('AP isolation: separate scenarios do not cross-block', async () => {
  const dir = makeScratch('cross-block');
  const engine = makeEngine(dir);

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);

  // All three buy first time
  assert.equal(engine.scenarios.s14.openPositions.length,       1, 'cross: AP1 bought');
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'cross: AP2 bought');
  assert.equal(engine.scenarios.s14_beta.openPositions.length,  1, 'cross: AP3 bought');

  // Only exit AP1 (simulate partial exit)
  const posIdx = engine.scenarios.s14.openPositions.findIndex(p => p.mint === CASE_MINT);
  if (posIdx >= 0) {
    engine.executeScenarioExit(engine.scenarios.s14, posIdx, 0.000040, Date.now(), 'WIB', 'TEST_PARTIAL_EXIT');
  }

  assert.equal(engine.scenarios.s14.closedTrades.length, 1,       'cross: AP1 closed');
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1,'cross: AP2 still open (not blocked by AP1 close)');
  assert.equal(engine.scenarios.s14_beta.openPositions.length,  1,'cross: AP3 still open (not blocked by AP1 close)');
});

// ============================================================
// TEST 7: Restart persistence — load from disk, block rebuy
// ============================================================
test('Restart: loadState from disk blocks rebuy across engine restart', async () => {
  const dir = makeScratch('restart');

  // Phase 1: initial run — buy + exit
  {
    const engine = makeEngine(dir);
    const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
    engine.handleTargetBuy(sig, true);
    backdateTrackers(engine, CASE_MINT, 65);
    triggerBundlerEntry(engine, CASE_MINT);
    assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'restart: AP2 first buy');
    triggerWhaleExit(engine, CASE_MINT);
    assert.equal(engine.scenarios.s14_alpha.closedTrades.length, 1,  'restart: AP2 trade closed');
    // State persisted to disk by saveState() inside triggerWhaleExit path
  }

  // Phase 2: new engine instance (simulating service restart) — same dir
  {
    const engine2 = makeEngine(dir);
    // Trackers are in-memory only → fresh (empty) after restart
    // closedTrades are on disk → loaded
    assert.equal(engine2.scenarios.s14_alpha.closedTrades.length, 1,
      'restart: closedTrades loaded from disk after restart');

    // Feed replays same mint
    const sig2 = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
    engine2.handleTargetBuy(sig2, true);
    backdateTrackers(engine2, CASE_MINT, 65);
    const balances = Object.fromEntries(['s14', 's14_alpha', 's14_beta'].map(key =>
      [key, [engine2.scenarios[key].availableCash, engine2.scenarios[key].totalFeesPaid]]));
    let replayBuys = 0;
    engine2.onTradeAction = action => { if (action === 'BUY') replayBuys++; };
    triggerBundlerEntry(engine2, CASE_MINT);
    for (const key of ['s14', 's14_alpha', 's14_beta']) {
      assert.equal(engine2.scenarios[key].openPositions.length, 0, `${key}: no restart rebuy`);
      assert.equal(engine2.scenarios[key].closedTrades.length, 1, `${key}: history preserved`);
      assert.deepEqual([engine2.scenarios[key].availableCash, engine2.scenarios[key].totalFeesPaid], balances[key]);
    }
    assert.equal(replayBuys, 0, 'No BUY callback in any AP after restart');

    assert.equal(engine2.scenarios.s14_alpha.openPositions.length, 0,
      'restart: AP2 NO rebuy after restart (closedTrades guard active)');
    assert.equal(engine2.scenarios.s14_alpha.closedTrades.length, 1,
      'restart: closedTrades count unchanged after rejected rebuy');
  }
});

// ============================================================
// TEST 8: Open duplicate inflight — existing open position blocks re-entry
// ============================================================
test('Open duplicate: existing open position blocks second entry', async () => {
  const dir = makeScratch('duplicate');
  const engine = makeEngine(dir);

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);

  // First entry succeeds
  triggerBundlerEntry(engine, CASE_MINT);
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'dup: first buy OK');

  // Position still open — attempt second entry directly
  engine.evaluateS14AlphaBundlerEntry(CASE_MINT, 7.5, 0.000070);
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'dup: open position not duplicated');
});

// ============================================================
// TEST 9: Callback repeat/inflight — onTradeAction called only once per AP
// ============================================================
test('Callback repeat: onTradeAction fires only once per AP per mint', async () => {
  const dir = makeScratch('callback');
  const engine = makeEngine(dir);

  const buyCallCounts = { s14: 0, s14_alpha: 0, s14_beta: 0 };
  engine.onTradeAction = (action, scenarioId) => {
    if (action === 'BUY') {
      if (scenarioId === 'SCENARIO_14_BUNDLER_RUNNER')      buyCallCounts.s14++;
      if (scenarioId === 'SCENARIO_14_ALPHA_60S_GRACE')     buyCallCounts.s14_alpha++;
      if (scenarioId === 'SCENARIO_14_BETA_HOARDING_DEFENSE') buyCallCounts.s14_beta++;
    }
  };

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);

  // First cycle
  triggerBundlerEntry(engine, CASE_MINT);
  triggerWhaleExit(engine, CASE_MINT);

  // Second cycle replay
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);
  triggerBundlerEntry(engine, CASE_MINT);

  assert.equal(buyCallCounts.s14,       1, 'callback: AP1 BUY callback fired exactly once');
  assert.equal(buyCallCounts.s14_alpha, 1, 'callback: AP2 BUY callback fired exactly once');
  assert.equal(buyCallCounts.s14_beta,  1, 'callback: AP3 BUY callback fired exactly once');
});

// ============================================================
// TEST 10: Partial exit — rebuy blocked even after partial exit
// ============================================================
test('Partial exit: rebuy blocked even if position only partially exited', async () => {
  const dir = makeScratch('partial');
  const engine = makeEngine(dir);

  const sig = mkFirstBuySignal(CASE_MINT, { ageSec: 65 });
  engine.handleTargetBuy(sig, true);
  backdateTrackers(engine, CASE_MINT, 65);
  engine.evaluateS14AlphaBundlerEntry(CASE_MINT, 7.5, 0.000063);
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'partial: first buy');

  // Update price to trigger stage1 exit (partial TP at +50%)
  engine.updatePriceTick(CASE_MINT, 0.000098); // ~+55% from 0.000063
  assert.equal(engine.scenarios.s14_alpha.openPositions[0]?.stage1Exited, true, 'Partial TP actually executed');
  // Position still open (stage1 partial exit only), stage1Exited = true
  // We're only testing the guard for open position — just check it blocks evaluator
  engine.evaluateS14AlphaBundlerEntry(CASE_MINT, 7.5, 0.000098);
  // tracker.hasEntered=true so evaluator returns early anyway — position count unchanged
  assert.equal(engine.scenarios.s14_alpha.openPositions.length, 1, 'partial: position not duplicated after partial exit tick');
});

for (const key of ['s14', 's14_alpha', 's14_beta']) {
  test(`${key}: common BUY guard cannot permit accumulation with permissive flags`, () => {
    const engine = makeEngine(makeScratch(`common-${key}`));
    const scenario = engine.scenarios[key];
    const sig = mkFirstBuySignal(CASE_MINT);
    const rules = { maxTokenExposure: 10, getStake: () => 0.5,
      allowReEntryCycle: true, disallowAccumulation: false };
    let callbacks = 0;
    engine.onTradeAction = (action) => { if (action === 'BUY') callbacks++; };
    scenario.availableCash = 20; // avoid a vacuous pass caused by exhausted cash
    engine.processScenarioBuy(scenario, sig, true, 2700, Date.now(), 'fixture', rules);
    assert.equal(callbacks, 1);
    const before = JSON.stringify({cash: scenario.availableCash,
      fees: scenario.totalFeesPaid, positions: scenario.openPositions});
    engine.processScenarioBuy(scenario, sig, true, 2700, Date.now(), 'fixture', rules);
    assert.equal(callbacks, 1, 'No second BUY callback despite permissive flags');
    assert.equal(JSON.stringify({cash: scenario.availableCash,
      fees: scenario.totalFeesPaid, positions: scenario.openPositions}), before);
    assert.match(scenario.recentEvents[0].reason, /REJECT_ALREADY_TRADED/);
  });
}
