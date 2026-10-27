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
  stakeUsdLane1: number;
  stakeUsdLane2: number;
  maxBuysQuota: number;
  maxActiveRealPositions: number;
  buySlippagePercent: number;
  sellSlippagePercent: number;
  priorityFeeSol: number;
  tipFeeSol: number;
  minSolReserve: number;
  autoSell: boolean;
  quotaResetAt: number;
  updatedAt: number;
}

export const FOLLOWER_LIVE_DEFAULTS: FollowerLiveConfig = {
  enabled: false,
  activeLane: 'LANE_2',
  stakeUsdLane1: 2.0,
  stakeUsdLane2: 5.0,
  maxBuysQuota: 3,
  maxActiveRealPositions: 1,
  buySlippagePercent: 15,
  sellSlippagePercent: 20,
  priorityFeeSol: 0.0001,
  tipFeeSol: 0.0001,
  minSolReserve: 0.025,
  autoSell: true,
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
  costBasisUsd: number;
  realizedPnlUsd: number;
  entryPriceUsd: number;
  exitPriceUsd?: number;
  buys: FollowerRealOrder[];
  sells: FollowerRealOrder[];
  audit: Array<{ at: number; type: string; details: any }>;
  lastError?: string;
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

  // Sanitasi & boundary checks
  updated.stakeUsdLane1 = Math.max(0.1, Math.min(1000, Number(updated.stakeUsdLane1) || 2.0));
  updated.stakeUsdLane2 = Math.max(0.1, Math.min(1000, Number(updated.stakeUsdLane2) || 5.0));
  updated.maxBuysQuota = Math.max(0, Math.min(1000, Number(updated.maxBuysQuota) || 3));
  updated.maxActiveRealPositions = Math.max(1, Math.min(10, Number(updated.maxActiveRealPositions) || 1));
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

export function getCompletedRealBuysCount(state: FollowerRealState, config: FollowerLiveConfig): number {
  let count = 0;
  for (const p of state.positions) {
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
