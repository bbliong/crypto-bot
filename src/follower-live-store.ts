import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type FollowerLiveLane = 'LANE_1' | 'LANE_2' | 'BOTH';

export interface FollowerLiveConfig {
  enabled: boolean;
  activeLane: FollowerLiveLane;
  autobuyScenario?: 'OFF' | 'DRY_RUN' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'S9' | 'S10' | 'S13' | 'S13_ALPHA' | 'S13_BETA' | 'S13_ALPHA_1' | 'S13_BETA_1' | 'S14' | 'S14_ALPHA' | 'S14_BETA' | 'S15' | 'BOTH' | string;
  stakeUsdLane1: number;
  stakeUsdLane2: number;
  stakeUsdS4?: number;
  stakeUsdS5?: number;
  stakeUsdS6Pool1?: number;
  stakeUsdS6Pool2?: number;
  stakeUsdS7Pool1?: number;
  stakeUsdS7Pool2?: number;
  stakeUsdS8?: number;
  stakeUsdS9?: number;
  stakeUsdS10?: number;
  stakeUsdS13?: number;
  stakeUsdS13Beta?: number;
  stakeUsdS13Alpha?: number;
  stakeUsdS13Beta1?: number;
  stakeUsdS13Alpha1?: number;
  stakeUsdS14?: number;
  stakeUsdS14Alpha?: number;
  stakeUsdS14Beta?: number;
  stakeUsdS15?: number;
  stakeUsdAP1?: number;
  stakeUsdAP2?: number;
  stakeUsdAP3?: number;
  maxBuysQuota: number;
  maxActiveRealPositions: number;
  buySlippagePercent: number;
  sellSlippagePercent: number;
  priorityFeeSol: number;
  tipFeeSol: number;
  minSolReserve: number;
  autoSell: boolean;
  reboundBuyEnabled: boolean;
  maxCyclesPerToken: number;
  quotaResetAt: number;
  updatedAt: number;
}

export const FOLLOWER_LIVE_DEFAULTS: FollowerLiveConfig = {
  enabled: false,
  activeLane: 'LANE_2',
  autobuyScenario: 'OFF',
  stakeUsdLane1: 1.0,
  stakeUsdLane2: 1.0,
  stakeUsdS4: 1.0,
  stakeUsdS5: 1.0,
  stakeUsdS6Pool1: 1.0,
  stakeUsdS6Pool2: 1.0,
  stakeUsdS7Pool1: 1.0,
  stakeUsdS7Pool2: 1.0,
  stakeUsdS8: 1.0,
  stakeUsdS9: 1.0,
  stakeUsdS10: 1.0,
  stakeUsdS13: 5.0,
  stakeUsdS13Beta: 0.25,
  stakeUsdS13Alpha: 5.0,
  stakeUsdS13Beta1: 0.25,
  stakeUsdS13Alpha1: 5.0,
  stakeUsdS14: 5.0,
  stakeUsdS14Alpha: 5.0,
  stakeUsdS14Beta: 5.0,
  stakeUsdS15: 5.0,
  stakeUsdAP1: 5.0,
  stakeUsdAP2: 5.0,
  stakeUsdAP3: 5.0,
  maxBuysQuota: 3,
  maxActiveRealPositions: 1,
  buySlippagePercent: 15,
  sellSlippagePercent: 20,
  priorityFeeSol: 0.0001,
  tipFeeSol: 0.0001,
  minSolReserve: 0.025,
  autoSell: true,
  reboundBuyEnabled: false,
  maxCyclesPerToken: 1,
  quotaResetAt: 0,
  updatedAt: 0,
};

export type FollowerRealStatus =
  | 'BUY_PENDING'
  | 'HOLDING'
  | 'SELL_PENDING'
  | 'CLOSED'
  | 'FAILED'
  | 'UNKNOWN';

export interface FollowerRealOrder {
  side: 'BUY' | 'SELL';
  lane: 'LANE_1' | 'LANE_2';
  submittedAt: number;
  status: 'INTENT' | 'SUBMITTING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';
  orderId?: string | null;
  hash?: string | null;
  stakeUsd: number;
  tokenAmount: string;
  decimals: number;
  solUsd: number;
  solCashflow?: number;
  networkFeeSol?: number;
  confirmedAt?: number;
  error?: string;
}

export interface FollowerRealPosition {
  id: string;
  mint: string;
  symbol: string;
  lane: 'LANE_1' | 'LANE_2';
  status: FollowerRealStatus;
  createdAt: number;
  updatedAt: number;
  wallet: string;
  acquiredTokens: number;
  remainingTokens: number;
  remainingBaseUnits?: string;
  costBasisUsd: number;
  realizedPnlUsd: number;
  entryPriceUsd: number;
  exitPriceUsd?: number;
  buys: FollowerRealOrder[];
  sells: FollowerRealOrder[];
  audit: Array<{ at: number; type: string; details: any }>;
  lastError?: string;
  pendingSellRatio?: number;
  firstSellFailedAt?: number;
  stage1Exited?: boolean;
  peakTargetHolding?: number;
}

export interface FollowerLiveReadiness {
  sessionReady: boolean;
  wallet: string | null;
  balanceSol: number | null;
  solUsd: number | null;
  reclaimableRentSol?: number;
  emptyAccountsCount?: number;
  observedAt: number;
  workerPid?: number;
  error?: string;
}

export interface FollowerRealState {
  updatedAt: number;
  positions: FollowerRealPosition[];
  readiness: FollowerLiveReadiness;
}

export const REAL_ACTIVE_STATUSES = new Set<FollowerRealStatus>([
  'BUY_PENDING',
  'HOLDING',
  'SELL_PENDING',
  'UNKNOWN',
]);

export function readJsonSafe<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function readFollowerLiveConfig(dataDir: string): FollowerLiveConfig {
  const stored = readJsonSafe<Record<string, unknown>>(
    join(dataDir, 'follower-autobuy-settings.json'),
    {}
  );
  return { ...FOLLOWER_LIVE_DEFAULTS, ...stored } as FollowerLiveConfig;
}

export function saveFollowerLiveConfig(
  dataDir: string,
  patch: Partial<FollowerLiveConfig> & { resetQuota?: boolean }
): FollowerLiveConfig {
  const current = readFollowerLiveConfig(dataDir);
  const updated: FollowerLiveConfig = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };

  if (patch.resetQuota) {
    updated.quotaResetAt = Date.now();
  }

  if (patch.autobuyScenario !== undefined) {
    const sc = String(patch.autobuyScenario).toUpperCase().trim();
    // Canonical allowlist — exact matches only; no generic substring includes()
    // S14 group must come before S4/S5 to prevent '4'/'5' substring collisions.
    // S13 group ALPHA/BETA checked with explicit prefix, not generic includes.
    const KNOWN_SCENARIOS = new Set([
      'OFF', 'DRY_RUN', 'BOTH', 'ALL',
      'AP1', 'AP2', 'AP3',
      'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10',
      'S13', 'S13_ALPHA', 'S13_BETA', 'S13_ALPHA_1', 'S13_BETA_1', 'S13_CENTAUR',
      'S14', 'S14_ALPHA', 'S14_BETA', 'S15',
    ]);
    // Also allow composite multi-scenario strings (e.g. 'S14+S14_ALPHA', 'S5,S9')
    const isComposite = /[+,\s]/.test(sc) && sc.split(/[+,\s]+/).every(p => KNOWN_SCENARIOS.has(p.trim()));
    if (!(KNOWN_SCENARIOS.has(sc) || isComposite) || (isComposite && sc.split(/[+,\s]+/).some(p => ['OFF', 'DRY_RUN'].includes(p)))) throw new Error('Invalid autobuyScenario');
    if (KNOWN_SCENARIOS.has(sc) || isComposite) {
      updated.autobuyScenario = sc as any;
      // Selecting a target alone does not arm it; explicit boolean opt-in is required.
      updated.enabled = patch.enabled === true && sc !== 'OFF' && sc !== 'DRY_RUN';
    }
  } else if (patch.enabled !== undefined) {
    updated.enabled = Boolean(patch.enabled);
    if (!updated.enabled) {
      updated.autobuyScenario = 'OFF';
    } else if (!updated.autobuyScenario || updated.autobuyScenario === 'OFF') {
      updated.autobuyScenario = 'BOTH';
    }
  }

  // Sanitasi & boundary checks
  updated.stakeUsdLane1 = Math.max(0.05, Math.min(1000, Number(updated.stakeUsdLane1) || 2.0));
  updated.stakeUsdLane2 = Math.max(0.05, Math.min(1000, Number(updated.stakeUsdLane2) || 5.0));
  if (patch.stakeUsdS4 !== undefined || updated.stakeUsdS4 === undefined) {
    updated.stakeUsdS4 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS4 !== undefined ? patch.stakeUsdS4 : updated.stakeUsdS4) || 5.0));
  }
  if (patch.stakeUsdS5 !== undefined || updated.stakeUsdS5 === undefined) {
    updated.stakeUsdS5 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS5 !== undefined ? patch.stakeUsdS5 : updated.stakeUsdS5) || 1.0));
  }
  if (patch.stakeUsdS6Pool1 !== undefined || updated.stakeUsdS6Pool1 === undefined) {
    updated.stakeUsdS6Pool1 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS6Pool1 !== undefined ? patch.stakeUsdS6Pool1 : updated.stakeUsdS6Pool1) || 5.0));
  }
  if (patch.stakeUsdS6Pool2 !== undefined || updated.stakeUsdS6Pool2 === undefined) {
    updated.stakeUsdS6Pool2 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS6Pool2 !== undefined ? patch.stakeUsdS6Pool2 : updated.stakeUsdS6Pool2) || 7.0));
  }
  if (patch.stakeUsdS7Pool1 !== undefined || updated.stakeUsdS7Pool1 === undefined) {
    updated.stakeUsdS7Pool1 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS7Pool1 !== undefined ? patch.stakeUsdS7Pool1 : updated.stakeUsdS7Pool1) || 1.0));
  }
  if (patch.stakeUsdS7Pool2 !== undefined || updated.stakeUsdS7Pool2 === undefined) {
    updated.stakeUsdS7Pool2 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS7Pool2 !== undefined ? patch.stakeUsdS7Pool2 : updated.stakeUsdS7Pool2) || 2.0));
  }
  if (patch.stakeUsdS8 !== undefined || updated.stakeUsdS8 === undefined) {
    updated.stakeUsdS8 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS8 !== undefined ? patch.stakeUsdS8 : updated.stakeUsdS8) || 1.0));
  }
  if (patch.stakeUsdS9 !== undefined || updated.stakeUsdS9 === undefined) {
    updated.stakeUsdS9 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS9 !== undefined ? patch.stakeUsdS9 : updated.stakeUsdS9) || 1.0));
  }
  if (patch.stakeUsdS10 !== undefined || updated.stakeUsdS10 === undefined) {
    updated.stakeUsdS10 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS10 !== undefined ? patch.stakeUsdS10 : updated.stakeUsdS10) || 1.0));
  }
  if (patch.stakeUsdS13 !== undefined || updated.stakeUsdS13 === undefined) {
    updated.stakeUsdS13 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS13 !== undefined ? patch.stakeUsdS13 : updated.stakeUsdS13) || 5.0));
  }
  if (patch.stakeUsdS13Beta !== undefined || updated.stakeUsdS13Beta === undefined) {
    updated.stakeUsdS13Beta = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS13Beta !== undefined ? patch.stakeUsdS13Beta : updated.stakeUsdS13Beta) || 0.25));
  }
  if (patch.stakeUsdS13Alpha !== undefined || updated.stakeUsdS13Alpha === undefined) {
    updated.stakeUsdS13Alpha = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS13Alpha !== undefined ? patch.stakeUsdS13Alpha : updated.stakeUsdS13Alpha) || 5.0));
  }
  if (patch.stakeUsdS13Beta1 !== undefined || updated.stakeUsdS13Beta1 === undefined) {
    updated.stakeUsdS13Beta1 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS13Beta1 !== undefined ? patch.stakeUsdS13Beta1 : updated.stakeUsdS13Beta1) || 0.25));
  }
  if (patch.stakeUsdS13Alpha1 !== undefined || updated.stakeUsdS13Alpha1 === undefined) {
    updated.stakeUsdS13Alpha1 = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdS13Alpha1 !== undefined ? patch.stakeUsdS13Alpha1 : updated.stakeUsdS13Alpha1) || 5.0));
  }
  // S14 / S14_ALPHA / S14_BETA (alias) / S15 / AP1 / AP2 / AP3 stake bounds
  if (patch.stakeUsdAP1 !== undefined || patch.stakeUsdS14 !== undefined || updated.stakeUsdS14 === undefined) {
    const v = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdAP1 !== undefined ? patch.stakeUsdAP1 : (patch.stakeUsdS14 !== undefined ? patch.stakeUsdS14 : updated.stakeUsdS14)) || 5.0));
    updated.stakeUsdS14 = v;
    updated.stakeUsdAP1 = v;
  }
  if (patch.stakeUsdAP2 !== undefined || patch.stakeUsdS14Alpha !== undefined || updated.stakeUsdS14Alpha === undefined) {
    const v = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdAP2 !== undefined ? patch.stakeUsdAP2 : (patch.stakeUsdS14Alpha !== undefined ? patch.stakeUsdS14Alpha : updated.stakeUsdS14Alpha)) || 5.0));
    updated.stakeUsdS14Alpha = v;
    updated.stakeUsdAP2 = v;
  }
  if (patch.stakeUsdAP3 !== undefined || patch.stakeUsdS15 !== undefined || patch.stakeUsdS14Beta !== undefined || updated.stakeUsdS15 === undefined) {
    const v = Math.max(0.05, Math.min(1000, Number(patch.stakeUsdAP3 !== undefined ? patch.stakeUsdAP3 : (patch.stakeUsdS15 !== undefined ? patch.stakeUsdS15 : (patch.stakeUsdS14Beta !== undefined ? patch.stakeUsdS14Beta : updated.stakeUsdS15))) || 5.0));
    updated.stakeUsdS15 = v;
    updated.stakeUsdS14Beta = v;
    updated.stakeUsdAP3 = v;
  }
  // S15 and S14-Beta name the same strategy. Explicit S15 wins if both supplied.
  if (patch.stakeUsdS15 !== undefined || patch.stakeUsdS14Beta !== undefined) {
    const n = Number(patch.stakeUsdS15 ?? patch.stakeUsdS14Beta);
    const stake = Number.isFinite(n) ? Math.max(0.05, Math.min(1000, n)) : 5;
    updated.stakeUsdS15 = stake;
    updated.stakeUsdS14Beta = stake;
  }
  const rawQuota = Number(updated.maxBuysQuota);
  updated.maxBuysQuota = Number.isFinite(rawQuota) && rawQuota >= 0 ? Math.min(99999, rawQuota) : 0;
  updated.maxActiveRealPositions = Math.max(1, Math.min(10, Number(updated.maxActiveRealPositions) || 1));
  updated.maxCyclesPerToken = Math.max(1, Math.min(10, Number(updated.maxCyclesPerToken) || 1));
  updated.buySlippagePercent = Math.max(1, Math.min(50, Number(updated.buySlippagePercent) || 15));
  updated.sellSlippagePercent = Math.max(1, Math.min(50, Number(updated.sellSlippagePercent) || 20));
  updated.minSolReserve = Math.max(0.005, Math.min(10, Number(updated.minSolReserve) || 0.025));

  mkdirSync(dataDir, { recursive: true });
  atomicWriteJson(join(dataDir, 'follower-autobuy-settings.json'), updated);
  return updated;
}

export function readFollowerRealState(dataDir: string): FollowerRealState {
  return readJsonSafe<FollowerRealState>(join(dataDir, 'follower-real-state.json'), {
    updatedAt: 0,
    positions: [],
    readiness: {
      sessionReady: false,
      wallet: null,
      balanceSol: null,
      solUsd: null,
      observedAt: 0,
    },
  });
}

export function writeFollowerRealState(dataDir: string, state: FollowerRealState): void {
  state.updatedAt = Date.now();
  mkdirSync(dataDir, { recursive: true });
  atomicWriteJson(join(dataDir, 'follower-real-state.json'), state);
}

export function auditFollowerReal(
  dataDir: string,
  state: FollowerRealState,
  pos: FollowerRealPosition | null,
  type: string,
  details: unknown
): void {
  const at = Date.now();
  const clean = sanitizeAudit(details);
  const entry = { at, type, details: clean };

  if (pos) {
    pos.updatedAt = at;
    pos.audit.push(entry);
  }

  mkdirSync(dataDir, { recursive: true });
  appendFileSync(
    join(dataDir, 'follower-real-ledger.jsonl'),
    JSON.stringify({ ...entry, positionId: pos?.id ?? null }) + '\n',
    { mode: 0o600 }
  );

  state.updatedAt = at;
  atomicWriteJson(join(dataDir, 'follower-real-state.json'), state);
}

export function sanitizeAudit(value: any, key = ''): any {
  if (
    /authorization|cookie|password|secret|private.?key|seed|raw_tx|signed|transactionBytes|swapTransaction/i.test(
      key
    )
  ) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 8000);
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeAudit(v));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeAudit(v, k)])
    );
  }
  return value;
}

export function getCompletedRealBuysCount(state: FollowerRealState, config: FollowerLiveConfig, lane?: 'LANE_1' | 'LANE_2'): number {
  let count = 0;
  for (const p of state.positions) {
    if (lane && p.lane !== lane) continue;
    for (const b of p.buys) {
      if (b.status === 'CONFIRMED' && b.confirmedAt && b.confirmedAt > config.quotaResetAt) {
        count++;
      }
    }
  }
  return count;
}

export function generateFollowerPositionId(mint: string, lane: string, timestamp: number): string {
  return createHash('sha256').update(`${mint}:${lane}:${timestamp}`).digest('hex').slice(0, 32);
}
