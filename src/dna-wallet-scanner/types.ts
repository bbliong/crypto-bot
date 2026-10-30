export interface TargetDnaPattern {
  minStakeUsd: number;      // e.g. 80
  maxStakeUsd: number;      // e.g. 400
  minHoldSec: number;        // e.g. 5
  maxHoldSec: number;        // e.g. 300
  minProfitUsd: number;      // e.g. 10
  minSolBalance: number;     // e.g. 0.5 SOL
  disallowCreator: boolean;  // true
  disallowTransferIn: boolean; // true (Zero TX IN from personal wallets/airdrop)
  maxConcurrentTokens: number; // 1 (Strictly Serial Trader: 1 token at a time)
  minSellCount: number;        // 2 (Target never does 1 buy -> 1 sell. Always multiple sells)
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
  isStrictSerial: boolean; // TRUE if wallet never holds 2 tokens concurrently
  isMultiStepScalper: boolean; // TRUE if executes multiple sells/actions per token
  isPureDexTrader: boolean; // TRUE if 0 casual tx_in / tx_out during lifecycle
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
  gmgnProfile?: {
    realized7d: number;
    totalProfit: number;
    totalBuys: number;
    totalSells: number;
  };
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
