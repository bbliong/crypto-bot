export const numericFields = [
  'createdAt', 'tradingStartedAt', 'holders', 'priceUsd', 'liquidityUsd',
  'price1mUsd', 'price5mUsd', 'price1hUsd',
  'marketCapUsd', 'buys', 'sells', 'risePercent', 'drawdownPercent',
  'top5Percent', 'top10Percent', 'singlePercent', 'bundledPercent',
  'sameSlotWallets', 'sharedFunderWallets', 'largestClusterPercent',
  'developerPercent', 'developerSoldPercent', 'transferFeePercent',
] as const;
export const booleanFields = [
  'holdersComplete', 'ownersResolved', 'bundlingComplete', 'walletMapComplete',
  'developerLinkedCluster', 'developerComplete', 'mintAuthorityActive',
  'freezeAuthorityActive', 'lpWithdrawable', 'lpVerified', 'tokenExtensionsVerified',
  'transferHookActive', 'mintVerified',
] as const;
export type Field = typeof numericFields[number] | typeof booleanFields[number];
export interface Evidence { value: number | boolean; observedAt: number; source: string }
export interface TokenMetadata { name?: string; symbol?: string; imageUrl?: string }
export interface Candidate {
  mint: string; firstSeenAt: number; updatedAt: number;
  fields: Partial<Record<Field, Evidence>>;
  metadata?: TokenMetadata;
  invalidatedFields?: Partial<Record<Field, Omit<Evidence, 'value'>>>;
}
export interface FieldMapping { path: string; unit?: 'seconds' | 'milliseconds'; scale?: number }
export interface Mapping {
  channel: string; recordsPath: string; chainPath: string; chainValue: 'sol';
  mintPath: string; eventPath?: string; eventValue?: string;
  fields: Partial<Record<Field, FieldMapping>>;
  metadata?: Partial<Record<keyof TokenMetadata, string>>;
}
export interface Config {
  mode: 'observation' | 'paper' | 'manual'; phase: 1 | 2; feedUrl: string; tokenUrlTemplate: string;
  gmgnCookiesFile?: string; fomoCookiesFile?: string;
  /** Existing Chrome user-data parent directory and profile folder to reuse. */
  browserUserDataDir?: string; browserProfileDirectory?: string; browserRemoteDebuggingPort?: number;
  browserChannel: string; headless: boolean; workers: number; queueCapacity: number;
  workerTimeoutMs: number; activeMonitorSeconds: number; evidenceMaxAgeMs: number; candidateTtlMs: number;
  minimumAgeSeconds: number; maximumAgeSeconds: number; minimumHolders: number; minimumLiquidityUsd: number; maximumLiquidityUsd: number;
  minimumBuys: number; maximumSellBuyRatio: number; maximumRisePercent: number;
  maximumDrawdownPercent: number; maximumTop5Percent: number; maximumTop10Percent: number;
  maximumSinglePercent: number; maximumBundledPercent: number; maximumSameSlotWallets: number;
  maximumSharedFunderWallets: number; maximumClusterPercent: number;
  maximumDeveloperPercent: number; maximumDeveloperSoldPercent: number;
  fomoUrlTemplate: string | null; mappings: Mapping[];
}
export interface Check { name: string; status: 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'; detail: string }
export interface Report {
  mint: string; firstSeenAt: number; signalAt: number; mode: Config['mode'];
  status: 'ENTRY_READY' | 'WATCH' | 'REJECT' | 'INSUFFICIENT_EVIDENCE';
  checks: Check[]; fields: Candidate['fields'];
}
