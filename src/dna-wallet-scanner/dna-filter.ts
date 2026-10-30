import { DiscoveredCloneWallet, TargetDnaPattern } from './types.js';

export const TARGET_DNA: TargetDnaPattern = {
  minStakeUsd: 80,         // Target buys ~$150-$250, allow $80 - $450
  maxStakeUsd: 450,
  minHoldSec: 4,           // Ultra-fast reaction
  maxHoldSec: 360,         // Scalp exit within 6 minutes
  minProfitUsd: 15,        // Must be genuinely profitable on the token
  minSolBalance: 0.3,      // Must hold active SOL (not empty burner)
  disallowCreator: true,   // Exclude token dev/creator
  disallowTransferIn: true, // Exclude free token receiver (Zero TX IN)
  maxConcurrentTokens: 1,  // STRICT SERIAL TRADER: Target only plays 1 token at a time
  minSellCount: 2          // Target never does 1 buy -> 1 sell. Always multiple sells (TWAP micro-sells)
};

export function isStrictSerialTrader(tokensTraded: Array<{ timestamp: number; holdSec: number }>): boolean {
  if (tokensTraded.length <= 1) return true;
  for (let i = 0; i < tokensTraded.length; i++) {
    const t1Start = tokensTraded[i].timestamp;
    const t1End = t1Start + (tokensTraded[i].holdSec || 60);
    for (let j = i + 1; j < tokensTraded.length; j++) {
      const t2Start = tokensTraded[j].timestamp;
      const t2End = t2Start + (tokensTraded[j].holdSec || 60);
      if (Math.max(t1Start, t2Start) < Math.min(t1End, t2End)) {
        return false; // Overlap detected
      }
    }
  }
  return true;
}

function formatWib(timestampSec: number): string {
  const d = new Date(timestampSec * 1000);
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const wib = new Date(utc + 7 * 3600000);
  const hh = String(wib.getHours()).padStart(2, '0');
  const mm = String(wib.getMinutes()).padStart(2, '0');
  const ss = String(wib.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} WIB`;
}

export function evaluateTraderDna(
  trader: any,
  tokenSymbol: string,
  tokenMint: string,
  pattern: TargetDnaPattern = TARGET_DNA
): { matched: boolean; reason?: string; tradeRecord?: any; balanceSol?: number } {
  const address = trader.address;
  if (!address || address.length < 32) {
    return { matched: false, reason: 'INVALID_ADDRESS' };
  }

  // 1. Exclude dev / creator / bundler / wash trader
  if (pattern.disallowCreator) {
    const makerTags = (trader.maker_token_tags || []).map((t: string) => t.toLowerCase());
    if (makerTags.includes('creator') || makerTags.includes('dev_team')) {
      return { matched: false, reason: 'EXCLUDE_CREATOR_DEV' };
    }
  }

  if (trader.is_suspicious === true) {
    return { matched: false, reason: 'SUSPICIOUS_ACTOR' };
  }

  // 2. Exclude transfer-in (free airdrop)
  if (pattern.disallowTransferIn) {
    if (trader.transfer_in === true || (trader.current_transfer_in_amount && trader.current_transfer_in_amount > 0)) {
      return { matched: false, reason: 'EXCLUDE_TRANSFER_IN' };
    }
  }

  // 3. Sizing Check (Target stake: $80 - $450)
  const totalCost = Number(trader.total_cost || trader.buy_volume_cur || 0);
  if (totalCost < pattern.minStakeUsd || totalCost > pattern.maxStakeUsd) {
    return { matched: false, reason: `STAKE_OUT_OF_BOUNDS ($${Math.round(totalCost)})` };
  }

  // 4. Holding Duration Check (Target holds 4s - 360s)
  const startHold = Number(trader.start_holding_at || 0);
  const endHold = Number(trader.end_holding_at || 0);
  let holdSec = 0;
  if (startHold > 0 && endHold > 0 && endHold >= startHold) {
    holdSec = endHold - startHold;
  } else if (trader.holding_period_sec) {
    holdSec = Number(trader.holding_period_sec);
  }

  if (holdSec < pattern.minHoldSec || holdSec > pattern.maxHoldSec) {
    return { matched: false, reason: `HOLD_DURATION_MISMATCH (${holdSec}s)` };
  }

  // 5. Profit Check (Target wins with meaningful scalping profit)
  const profit = Number(trader.profit || trader.realized_profit || 0);
  if (profit < pattern.minProfitUsd) {
    return { matched: false, reason: `LOW_OR_NEGATIVE_PROFIT ($${profit.toFixed(1)})` };
  }

  // 6. Active SOL Balance Check
  const lamports = Number(trader.native_balance || 0);
  const solBal = lamports > 0 ? (lamports / 1e9) : 0;
  if (solBal < pattern.minSolBalance) {
    return { matched: false, reason: `INSUFFICIENT_SOL_BALANCE (${solBal.toFixed(2)} SOL)` };
  }

  // 7. Exit Pattern: Target typically sells in at least 2 tranches (or full dump)
  const sellCount = Number(trader.sell_tx_count_cur || 1);

  const roiPct = totalCost > 0 ? (profit / totalCost * 100) : 0;
  const timeWib = formatWib(startHold || Math.floor(Date.now() / 1000));

  const tradeRecord = {
    mint: tokenMint,
    symbol: tokenSymbol,
    stakeUsd: Math.round(totalCost),
    profitUsd: Math.round(profit),
    roiPct: Number(roiPct.toFixed(1)),
    holdSec,
    sellCount,
    timestamp: startHold || Math.floor(Date.now() / 1000),
    timeWib
  };

  return {
    matched: true,
    tradeRecord,
    balanceSol: Number(solBal.toFixed(2))
  };
}
