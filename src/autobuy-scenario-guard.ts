/**
 * src/autobuy-scenario-guard.ts
 *
 * Pure, side-effect-free helper for scenario-to-autobuy-target routing.
 *
 * CANONICAL scenario IDs (from multi-scenario-dryrun-engine.ts):
 *   S14   → SCENARIO_14_BUNDLER_RUNNER
 *   S14_ALPHA → SCENARIO_14_ALPHA_60S_GRACE
 *   S15   → SCENARIO_14_BETA_HOARDING_DEFENSE   (public target name)
 *   S14_BETA  → alias for S15
 *
 * Design principles:
 *  - Exact whitelist per scenario group, longest-specific first (ALPHA_1 before ALPHA, BETA_1 before BETA)
 *  - S4 canonical match uses digit-boundary check: must be exactly '4' not '14'
 *  - S5 canonical match uses digit-boundary check: must be exactly '5' not '15'
 *  - Generic includes('ALPHA') / includes('BETA') are FORBIDDEN — replaced with exact family matchers
 *  - OFF, DRY_RUN, enabled=false always deny
 *  - BOTH / ALL grant access to every scenario
 *  - Multi-scenario composites (e.g. 'S14+S14_ALPHA', 'S5,S9') are split and each part matched
 */

// ─────────────────────────────────────────────────────────────────────────────
// Canonical engine ID families
// ─────────────────────────────────────────────────────────────────────────────

const S14_ENGINES = new Set([
  'SCENARIO_14_BUNDLER_RUNNER',
]);

const S14_ALPHA_ENGINES = new Set([
  'SCENARIO_14_ALPHA_60S_GRACE',
]);

const S15_ENGINES = new Set([
  'SCENARIO_14_BETA_HOARDING_DEFENSE',
]);

// All S13 family (must NOT bleed into S14 group)
const S13_ENGINES_EXACT = new Set([
  'SCENARIO_13_PING_PONG_WHALE',
  'SCENARIO_13_DYNAMIC_PINGPONG',
]);
const S13_ALPHA_ENGINES_EXACT = new Set<string>(); // matched by prefix below
const S13_BETA_ENGINES_EXACT = new Set<string>();
const S13_ALPHA1_ENGINES_EXACT = new Set<string>();
const S13_BETA1_ENGINES_EXACT = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// Family matchers — exact canonical prefix, no substring bleed
// ─────────────────────────────────────────────────────────────────────────────

function isS4Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.startsWith('SCENARIO_4_') || u === 'SCENARIO_4' || u === 'SCE4';
}

function isS5Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.startsWith('SCENARIO_5_') || u === 'SCENARIO_5' || u === 'SCE5' || u.includes('ANTI_SHAKEOUT');
}

function isS6Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.startsWith('SCENARIO_6_') || u === 'SCENARIO_6' || u === 'SCE6' || (u.includes('REDEPLOY') && !u.includes('SCENARIO_1'));
}

function isS7Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.startsWith('SCENARIO_7_') || u === 'SCENARIO_7' || u === 'SCE7' || u.includes('TIME_STOP');
}

function isS8Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.startsWith('SCENARIO_8_') || u === 'SCENARIO_8' || u === 'SCE8' || u.includes('FRONTRUN_DEV');
}

function isS9Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  // S9 and S9.5 (not S9_5 → S9.5 uses S9_5 prefix, treated same)
  return u.startsWith('SCENARIO_9_') || u === 'SCENARIO_9' || u === 'SCE9' || u.includes('DEV_FRONTRUN');
}

function isS10Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.startsWith('SCENARIO_10_') || u === 'SCENARIO_10' || u === 'SCE10' || u.includes('DYNAMIC_WAVE');
}

/** S13 BASE (no ALPHA / BETA variants) */
function isS13BaseEngine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return (
    (u.startsWith('SCENARIO_13_') || u.startsWith('SCENARIO_13.5_') || u.startsWith('SCENARIO_13_5_')) &&
    !u.includes('ALPHA') &&
    !u.includes('BETA') &&
    !u.includes('CENTAUR') &&
    !u.includes('14')
  );
}

/** S13_ALPHA_1 (must precede S13_ALPHA check) */
function isS13Alpha1Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.includes('ALPHA_1') || u.includes('ALPHA-1') || u.includes('ALPHA1');
}

/** S13_ALPHA (strict: not _1 variants) */
function isS13AlphaEngine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  if (isS13Alpha1Engine(u)) return false;
  return (u.includes('13_ALPHA') || u.includes('13-ALPHA')) && !u.includes('14');
}

/** S13_BETA_1 (must precede S13_BETA check) */
function isS13Beta1Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.includes('BETA_1') || u.includes('BETA-1') || u.includes('BETA1');
}

/** S13_BETA (strict: not _1 variants, not 14) */
function isS13BetaEngine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  if (isS13Beta1Engine(u)) return false;
  return (u.includes('13_BETA') || u.includes('13-BETA')) && !u.includes('14');
}

function isS13CentaurEngine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u.includes('CENTAUR');
}

/** S14 (SCENARIO_14_BUNDLER_RUNNER) */
function isS14Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u === 'SCENARIO_14_BUNDLER_RUNNER' || u.startsWith('SCENARIO_14_BUNDLER');
}

/** S14_ALPHA (SCENARIO_14_ALPHA_60S_GRACE) */
function isS14AlphaEngine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u === 'SCENARIO_14_ALPHA_60S_GRACE' || u.startsWith('SCENARIO_14_ALPHA');
}

/** S15 / S14_BETA (SCENARIO_14_BETA_HOARDING_DEFENSE) */
function isS15Engine(scenarioId: string): boolean {
  const u = scenarioId.toUpperCase();
  return u === 'SCENARIO_14_BETA_HOARDING_DEFENSE' || u.startsWith('SCENARIO_14_BETA');
}

// ─────────────────────────────────────────────────────────────────────────────
// Part → engine matcher
// ─────────────────────────────────────────────────────────────────────────────

function partMatchesEngine(part: string, scenarioId: string): boolean {
  const p = part.trim().toUpperCase();

  // ── OFF / DRY_RUN are handled before calling this ────────────────────────
  if (p === 'BOTH' || p === 'ALL') return true;

  // ── S14 group (checked BEFORE S4/S5 to avoid '4'/'5' substring collisions)
  // S14_BETA_1 / S14_BETA alias for S15 → must precede S14_ALPHA and S14 checks
  if (p === 'S15' || p === 'S14_BETA' || p === 'SCE15' || p === 'SCENARIO_15' || p === 'SCENARIO_14_BETA') {
    return isS15Engine(scenarioId);
  }
  if (p === 'S14_ALPHA' || p === 'SCE14_ALPHA' || p === 'SCENARIO_14_ALPHA') {
    return isS14AlphaEngine(scenarioId);
  }
  if (p === 'S14' || p === 'SCE14' || p === 'SCENARIO_14') {
    return isS14Engine(scenarioId);
  }

  // ── S13 group (checked before S4 to avoid early-exit collisions) ─────────
  if (p === 'S13_ALPHA_1' || p === 'ALPHA_1' || p === 'ALPHA1') {
    return isS13Alpha1Engine(scenarioId);
  }
  if (p === 'S13_BETA_1' || p === 'BETA_1' || p === 'BETA1') {
    return isS13Beta1Engine(scenarioId);
  }
  if (p === 'S13_ALPHA' || p === 'ALPHA') {
    return isS13AlphaEngine(scenarioId) && !isS14AlphaEngine(scenarioId);
  }
  if (p === 'S13_BETA' || p === 'BETA') {
    return isS13BetaEngine(scenarioId) && !isS15Engine(scenarioId);
  }
  if (p === 'S13_CENTAUR' || p === 'CENTAUR') {
    return isS13CentaurEngine(scenarioId);
  }
  if (p === 'S13' || p === 'SCE13' || p === 'SCENARIO_13') {
    return isS13BaseEngine(scenarioId);
  }

  // ── S4–S10 (after S14 to avoid '4' matching '14') ────────────────────────
  if (p === 'S4' || p === 'SCE4' || p === 'SCENARIO_4') return isS4Engine(scenarioId);
  if (p === 'S5' || p === 'SCE5' || p === 'SCENARIO_5') return isS5Engine(scenarioId);
  if (p === 'S6' || p === 'SCE6' || p === 'SCENARIO_6') return isS6Engine(scenarioId);
  if (p === 'S7' || p === 'SCE7' || p === 'SCENARIO_7') return isS7Engine(scenarioId);
  if (p === 'S8' || p === 'SCE8' || p === 'SCENARIO_8') return isS8Engine(scenarioId);
  if (p === 'S9' || p === 'SCE9' || p === 'SCENARIO_9') return isS9Engine(scenarioId);
  if (p === 'S10' || p === 'SCE10' || p === 'SCENARIO_10') return isS10Engine(scenarioId);

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true iff the given scenarioId is allowed to submit a real order
 * given the current autobuy config.
 *
 * Rules:
 *  - config.enabled must be true
 *  - config.autobuyScenario must not be 'OFF' or 'DRY_RUN'
 *  - BOTH / ALL grants all scenarios
 *  - Multi-part composites ('+' or ',' separated) match if any part matches
 */
export function isScenarioAllowedForRealOrder(
  scenarioId: string,
  config: { enabled?: boolean; autobuyScenario?: string }
): boolean {
  if (config.enabled !== true) return false;

  const targetSc = String(config.autobuyScenario || 'OFF').toUpperCase().trim();
  if (targetSc === 'OFF' || targetSc === 'DRY_RUN') return false;
  if (targetSc === 'BOTH' || targetSc === 'ALL') return true;

  // Split composite scenarios: 'S14+S14_ALPHA', 'S5,S9', 'S14 S15'
  const parts = targetSc.split(/[+,\s]+/).filter(Boolean);
  if (!parts.length || parts.some(p => p === 'OFF' || p === 'DRY_RUN' || canonicalizeAutobuyScenario(p) === null)) return false;

  for (const part of parts) {
    if (partMatchesEngine(part, scenarioId)) return true;
  }
  return false;
}

/**
 * Returns the canonical public autobuy scenario name for a given part.
 * Used for config validation and normalization.
 */
export function canonicalizeAutobuyScenario(raw: string): string | null {
  const sc = String(raw).toUpperCase().trim();

  if (['OFF', 'DRY_RUN', 'BOTH', 'ALL'].includes(sc)) return sc;
  if (['S4', 'SCE4', 'SCENARIO_4'].includes(sc)) return 'S4';
  if (['S5', 'SCE5', 'SCENARIO_5'].includes(sc)) return 'S5';
  if (['S6', 'SCE6', 'SCENARIO_6'].includes(sc)) return 'S6';
  if (['S7', 'SCE7', 'SCENARIO_7'].includes(sc)) return 'S7';
  if (['S8', 'SCE8', 'SCENARIO_8'].includes(sc)) return 'S8';
  if (['S9', 'SCE9', 'SCENARIO_9'].includes(sc)) return 'S9';
  if (['S10', 'SCE10', 'SCENARIO_10'].includes(sc)) return 'S10';
  if (['S13', 'SCE13', 'SCENARIO_13'].includes(sc)) return 'S13';
  if (['S13_ALPHA', 'ALPHA'].includes(sc)) return 'S13_ALPHA';
  if (['S13_BETA', 'BETA'].includes(sc)) return 'S13_BETA';
  if (['S13_ALPHA_1', 'ALPHA_1', 'ALPHA1'].includes(sc)) return 'S13_ALPHA_1';
  if (['S13_BETA_1', 'BETA_1', 'BETA1'].includes(sc)) return 'S13_BETA_1';
  if (['S13_CENTAUR', 'CENTAUR'].includes(sc)) return 'S13_CENTAUR';
  // S14 group
  if (['S14', 'SCE14', 'SCENARIO_14'].includes(sc)) return 'S14';
  if (['S14_ALPHA', 'SCE14_ALPHA', 'SCENARIO_14_ALPHA'].includes(sc)) return 'S14_ALPHA';
  // S15 canonical; S14_BETA is preserved as alias
  if (['S15', 'SCE15', 'SCENARIO_15'].includes(sc)) return 'S15';
  if (['S14_BETA', 'SCENARIO_14_BETA'].includes(sc)) return 'S14_BETA'; // alias preserved

  // Composite multi-scenario: validate each part
  if (/[+,\s]/.test(sc)) {
    const parts = sc.split(/[+,\s]+/).filter(Boolean);
    const canonical = parts.map(p => canonicalizeAutobuyScenario(p)).filter(Boolean);
    if (canonical.length === parts.length) return canonical.join('+');
  }

  return null; // unknown
}

/**
 * Returns the per-scenario stake USD from config, given the canonical engine ID.
 * Explicit precedence: each strategy's own stake, or $5; S15 accepts S14-Beta alias.
 */
export function getScenarioStakeUsd(
  scenarioId: string,
  config: Record<string, any>
): number {
  const u = scenarioId.toUpperCase();

  const positive = (...values: unknown[]): number => {
    for (const value of values) { const n = Number(value); if (Number.isFinite(n) && n >= 0.05 && n <= 1000) return n; }
    return 5;
  };
  if (isS14Engine(u)) return positive(config.stakeUsdS14);
  if (isS14AlphaEngine(u)) return positive(config.stakeUsdS14Alpha);
  if (isS15Engine(u)) return positive(config.stakeUsdS15, config.stakeUsdS14Beta);
  // For other scenarios, return NaN to signal caller should use its own lookup
  return NaN;
}

/** Exact token slicing, shared by initial quote and retry. Never infer units from spot. */
export function scenarioSellBaseUnits(balance: string, reason: string): string {
  const available = BigInt(balance);
  const units = reason.includes('STAGE_1_TP_50%') ? available / 2n : available;
  if (units <= 0n) throw new Error('NO_EXECUTABLE_TOKEN_BALANCE');
  return units.toString();
}

/** Settle only the quoted slice: partial TP must not close or destroy the remaining bag. */
export function settleScenarioRealSell(pos: any, soldBaseUnits: string, usdReceived: number,
  exitPriceUsd: number, order: any, now = Date.now()): void {
  const before = BigInt(pos.remainingBaseUnits);
  const sold = BigInt(soldBaseUnits);
  if (before <= 0n || sold <= 0n || sold > before || !Number.isFinite(usdReceived)) throw new Error('INVALID_SELL_SETTLEMENT');
  const ratio = Number(sold) / Number(before);
  const costSold = pos.costBasisUsd * ratio;
  const remaining = before - sold;
  pos.remainingBaseUnits = remaining.toString();
  pos.remainingTokens = pos.remainingTokens * (1 - ratio);
  pos.costBasisUsd = Math.max(0, pos.costBasisUsd - costSold);
  pos.realizedPnlUsd = (pos.realizedPnlUsd || 0) + usdReceived - costSold;
  pos.status = remaining === 0n ? 'CLOSED' : 'HOLDING';
  if (remaining > 0n) pos.stage1Exited = true;
  pos.updatedAt = now;
  pos.exitPriceUsd = exitPriceUsd;
  pos.sells.push(order);
}
