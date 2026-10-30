export interface TargetDnaPattern {
  minStakeUsd: number;      // e.g. 80
  maxStakeUsd: number;      // e.g. 400
  minHoldSec: number;        // e.g. 5
  maxHoldSec: number;        // e.g. 300
  minProfitUsd: number;      // e.g. 10
  minSolBalance: number;     // e.g. 0.5 SOL
  disallowCreator: boolean;  // true
  disallowTransferIn: boolean; // true
}

export interface DiscoveredCloneWallet {
  address: string;
  name?: string;
  firstDiscoveredAt: number;
  lastActiveAt: number;
  hitCount: number; // how many different tokens matched
  solBalance: number;
  totalRealizedProfitUsd: number;
  avgHoldSec: number;
  avgStakeUsd: number;
  tokensTraded: Array<{
    mint: string;
    symbol: string;
    stakeUsd: number;
    profitUsd: number;
    roiPct: number;
    holdSec: number;
    sellCount: number;
    timestamp: number;
    timeWib: string;
  }>;
  tags: string[];
  score: number; // 0 - 100
}

export interface FreshTokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  marketCap: number;
  openTimestamp: number;
  ageMinutes: number;
  source: 'pump_trenches' | 'swaps_1h';
  dexUrl: string;
}
