export type HolderGateRow = {
  amountPercentage: number | null;
  isDev: boolean;
  walletTagV2?: string;
  raw: Record<string, string | number | boolean | null>;
};

export type HolderGateStatus = {
  status: number;
  observedAt: number;
  source: 'network_intercept' | 'replayed_xhr';
};

export type HolderPreBuyGate = {
  allowed: boolean;
  reason: string;
  holderStatus: number | null;
  holderAgeMs: number | null;
  devTagStatus: number | null;
  devTagAgeMs: number | null;
  userHolderRows: number;
  top1Percent: number | null;
  top5Percent: number | null;
  devPercent: number | null;
  maximumTop1Percent: number;
  maximumAgeMs: number;
};

const poolOrLp = (holder: HolderGateRow) => holder.raw.addr_type === 2
  || Boolean(holder.raw.exchange)
  || holder.walletTagV2?.toLowerCase().includes('lp') === true;

/**
 * Entry-side holder evidence gate.
 *
 * A `tag=dev` endpoint is only evidence about developer wallets. It is never
 * used to calculate Top-1 or Top-5 ownership. Those metrics require an
 * untagged full-holder response. Missing data fails closed; inferred balances
 * from websocket trades are intentionally not accepted here.
 */
export function assessPreBuyHolderGate(input: {
  now: number;
  holders: Iterable<HolderGateRow> | null | undefined;
  holderStatus: HolderGateStatus | null | undefined;
  developerStatus: HolderGateStatus | null | undefined;
  maximumAgeMs?: number;
  maximumTop1Percent?: number;
}): HolderPreBuyGate {
  const maximumAgeMs = input.maximumAgeMs ?? 30_000;
  const maximumTop1Percent = input.maximumTop1Percent ?? 50;
  const holderAgeMs = input.holderStatus ? input.now - input.holderStatus.observedAt : null;
  const devTagAgeMs = input.developerStatus ? input.now - input.developerStatus.observedAt : null;
  const base = {
    holderStatus: input.holderStatus?.status ?? null, holderAgeMs,
    devTagStatus: input.developerStatus?.status ?? null, devTagAgeMs,
    userHolderRows: 0, top1Percent: null, top5Percent: null, devPercent: null,
    maximumTop1Percent, maximumAgeMs,
  };
  if (!input.holderStatus || input.holderStatus.status !== 200) return { allowed: false, reason: 'HOLDER_FULL_RESPONSE_NOT_200', ...base };
  if (holderAgeMs === null || holderAgeMs < 0 || holderAgeMs > maximumAgeMs) return { allowed: false, reason: 'HOLDER_FULL_RESPONSE_STALE', ...base };
  if (!input.developerStatus || input.developerStatus.status !== 200) return { allowed: false, reason: 'HOLDER_DEV_TAG_NOT_200', ...base };
  if (devTagAgeMs === null || devTagAgeMs < 0 || devTagAgeMs > maximumAgeMs) return { allowed: false, reason: 'HOLDER_DEV_TAG_STALE', ...base };
  const users = [...(input.holders ?? [])].filter(holder => !poolOrLp(holder));
  if (!users.length) return { allowed: false, reason: 'HOLDER_FULL_RESPONSE_EMPTY', ...base };
  if (users.some(holder => typeof holder.amountPercentage !== 'number' || !Number.isFinite(holder.amountPercentage) || holder.amountPercentage < 0)) {
    return { allowed: false, reason: 'HOLDER_PERCENTAGE_INCOMPLETE', ...base, userHolderRows: users.length };
  }
  const sorted = [...users].sort((left, right) => right.amountPercentage! - left.amountPercentage!);
  const top1Percent = sorted[0]!.amountPercentage!;
  const top5Percent = sorted.slice(0, 5).reduce((sum, holder) => sum + holder.amountPercentage!, 0);
  const devPercent = users.filter(holder => holder.isDev).reduce((sum, holder) => sum + holder.amountPercentage!, 0);
  const metrics = { ...base, userHolderRows: users.length, top1Percent, top5Percent, devPercent };
  if (top1Percent > maximumTop1Percent) return { allowed: false, reason: 'HOLDER_TOP1_ABOVE_LIMIT', ...metrics };
  return { allowed: true, reason: 'HOLDER_FULL_AND_DEV_TAG_FRESH', ...metrics };
}
