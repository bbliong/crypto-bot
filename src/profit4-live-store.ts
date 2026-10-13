import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export type LiveLane = "P4" | "V1" | "V2" | "V3" | "V4" | "V5";
export type LiveConfig = {
  enabled: boolean;
  activeLane: LiveLane;
  stakeMode: "usd" | "sol";
  stakeUsd: number;
  stakeSol: number;
  maxBuys: number;
  maxActiveRealPositions: number;
  buySlippagePercent: number;
  sellSlippagePercent: number;
  priorityFeeSol: number;
  tipFeeSol: number;
  minSolReserve: number;
  antiMev: boolean;
  autoSell: boolean;
  quotaResetAt: number;
  updatedAt: number;
};
export const LIVE_DEFAULTS: LiveConfig = {
  enabled: false,
  activeLane: "V4",
  stakeMode: "usd",
  stakeUsd: 0.5,
  stakeSol: 0.003,
  maxBuys: 3,
  maxActiveRealPositions: 1,
  buySlippagePercent: 9,
  sellSlippagePercent: 14,
  priorityFeeSol: 0.0001,
  tipFeeSol: 0.0001,
  minSolReserve: 0.025,
  antiMev: false,
  autoSell: true,
  quotaResetAt: 0,
  updatedAt: 0,
};
export type LiveStatus =
  | "BUY_PENDING"
  | "HOLDING"
  | "SELL_PENDING"
  | "CLOSED"
  | "FAILED"
  | "UNKNOWN";
export type LiveOrder = {
  side: "BUY" | "SELL";
  submittedAt: number;
  status:
    | "INTENT"
    | "SUBMITTING"
    | "SUBMITTED"
    | "CONFIRMED"
    | "FAILED"
    | "UNKNOWN";
  orderId?: string | null;
  hash?: string | null;
  amount: string;
  solUsd: number;
  httpStatus?: number;
  error?: string;
  confirmedAt?: number;
  cashflowSol?: number;
  networkFeeSol?: number;
  tokenDelta?: string;
  decimals?: number;
  inputUsd?: number | null;
  outputUsd?: number | null;
};
export type LivePosition = {
  id: string;
  signalId: string;
  run: string;
  mint: string;
  symbol: string;
  lane: LiveLane;
  wallet: string;
  status: LiveStatus;
  createdAt: number;
  updatedAt: number;
  rules: Record<string, any>;
  paperEntryPrice: number;
  acquiredAmount: string;
  remainingAmount: string;
  decimals: number;
  buys: LiveOrder[];
  sells: LiveOrder[];
  audit: { at: number; type: string; details: any }[];
  exitWanted?: string;
  manualExit?: boolean;
  buyConfirmedAt?: number;
  closedAt?: number;
  cashflowComplete: boolean;
  pnlSol: number | null;
  pnlUsd: number | null;
  lastError?: string;
};
export type LiveReadiness = {
  sessionReady: boolean;
  wallet: string | null;
  balanceSol: number | null;
  solUsd: number | null;
  balanceObservedAt?: number;
  balanceError?: string;
  priceError?: string;
  observedAt: number;
  error?: string;
  workerPid?: number;
  activeLanes?: LiveLane[];
};
export type LiveState = {
  updatedAt: number;
  positions: LivePosition[];
  readiness: LiveReadiness;
};
export const LIVE_ACTIVE = new Set<LiveStatus>([
  "BUY_PENDING",
  "HOLDING",
  "SELL_PENDING",
  "UNKNOWN",
]);
export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
export function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
export function readLiveConfig(dir: string): LiveConfig {
  const stored = readJson<Record<string, unknown>>(
    join(dir, "autobuy-settings.json"),
    {},
  );
  delete stored.executionWallet;
  return { ...LIVE_DEFAULTS, ...stored } as LiveConfig;
}
export function saveLiveConfig(
  dir: string,
  patch: Record<string, unknown>,
): LiveConfig {
  const allowed = Object.keys(LIVE_DEFAULTS).filter(
    (k) => !["updatedAt", "quotaResetAt"].includes(k),
  );
  if (
    Object.keys(patch).some((k) => !allowed.includes(k) && k !== "resetQuota")
  )
    throw Error("Pengaturan tidak dikenal.");
  const c = { ...readLiveConfig(dir), ...patch } as LiveConfig;
  delete (c as any).executionWallet;
  if (
    !["P4", "V1", "V2", "V3", "V4"].includes(c.activeLane) ||
    !["usd", "sol"].includes(c.stakeMode)
  )
    throw Error("Lane atau mode modal tidak valid.");
  for (const k of ["enabled", "antiMev", "autoSell"] as const)
    if (typeof c[k] !== "boolean") throw Error(`${k} harus boolean.`);
  const bounds: [keyof LiveConfig, number, number][] = [
    ["stakeUsd", 0.01, 10000],
    ["stakeSol", 0.00001, 100],
    ["maxBuys", 0, 100000],
    ["maxActiveRealPositions", 1, 10],
    ["buySlippagePercent", 0.1, 50],
    ["sellSlippagePercent", 0.1, 50],
    ["priorityFeeSol", 0, 0.1],
    ["tipFeeSol", 0, 0.1],
    ["minSolReserve", 0.001, 10],
  ];
  for (const [k, min, max] of bounds)
    if (
      typeof c[k] !== "number" ||
      !Number.isFinite(c[k]) ||
      Number(c[k]) < min ||
      Number(c[k]) > max
    )
      throw Error(`${k} di luar batas ${min}–${max}.`);
  if (
    !Number.isInteger(c.maxBuys) ||
    !Number.isInteger(c.maxActiveRealPositions)
  )
    throw Error("Kuota dan batas posisi harus bilangan bulat.");
  if ("resetQuota" in patch && typeof patch.resetQuota !== "boolean")
    throw Error("resetQuota harus boolean.");
  if (patch.resetQuota) c.quotaResetAt = Date.now();
  delete (c as any).resetQuota;
  c.updatedAt = Date.now();
  mkdirSync(dir, { recursive: true });
  atomicJson(join(dir, "autobuy-settings.json"), c);
  return c;
}
export function readLiveState(dir: string): LiveState {
  const state = readJson<LiveState>(join(dir, "real-state.json"), {
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
  if (!Array.isArray(state.positions) || !state.readiness)
    throw Error("Snapshot real tidak valid; entry diblokir.");
  return state;
}
export function buysCompleted(state: LiveState, config: LiveConfig) {
  return state.positions.filter(
    (p) => p.buyConfirmedAt != null && p.buyConfirmedAt > config.quotaResetAt,
  ).length;
}
export function auditLive(
  dir: string,
  state: LiveState,
  p: LivePosition | null,
  type: string,
  details: unknown,
) {
  const at = Date.now(),
    clean = sanitizeAudit(details);
  const entry = { at, type, details: clean };
  if (p) {
    p.updatedAt = at;
    p.audit.push(entry);
  }
  appendFileSync(
    join(dir, "real-trade-ledger.jsonl"),
    JSON.stringify({ ...entry, positionId: p?.id ?? null }) + "\n",
    { mode: 0o600 },
  );
  state.updatedAt = at;
  atomicJson(join(dir, "real-state.json"), state);
}
export function sanitizeAudit(value: any, key = ""): any {
  if (
    /authorization|cookie|password|secret|private.?key|seed|raw_tx|signed|transactionBytes|swapTransaction/i.test(
      key,
    )
  )
    return "[redacted]";
  if (typeof value === "string")
    return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 8000);
  if (Array.isArray(value)) return value.map((v) => sanitizeAudit(v));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeAudit(v, k)]),
    );
  return value;
}
export function commandId(positionId: string, key: string) {
  return createHash("sha256").update(`${positionId}:${key}`).digest("hex");
}
