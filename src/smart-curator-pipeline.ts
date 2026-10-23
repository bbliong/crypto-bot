import { chromium, type Page, type Browser } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RawGmgnWallet {
  wallet_address: string;
  name?: string;
  nickname?: string;
  twitter_name?: string;
  tags?: string[];
  sol_balance?: string | number;
  realized_profit_30d?: string | number;
  realized_profit_7d?: string | number;
  pnl_30d?: string | number;
  pnl_7d?: string | number;
  winrate_30d?: number;
  winrate_7d?: number;
  txs_30d?: number;
  txs_7d?: number;
  buy_30d?: number;
  sell_30d?: number;
  last_active?: number;
  avg_holding_period_30d?: number;
  volume_30d?: string | number;
}

export interface CandidateWallet {
  address: string;
  name: string;
  tags: string[];
  solBalance: number;
  pnl30d: number;
  pnl7d: number;
  winrate30d: number;
  winrate7d: number;
  txs30d: number;
  avgHoldingSeconds: number;
  gmgnLastActiveHoursAgo: number;
}

export interface HeliusVerifiedWallet extends CandidateWallet {
  heliusActive: boolean;
  heliusLastTxSignature: string;
  heliusLastBlockTime: number;
  heliusLastTxHoursAgo: number;
  hasPumpFunSwap: boolean;
  hasRaydiumSwap: boolean;
  recentTxTypes: string[];
  recentSources: string[];
  score: number;
}

export const TOXIC_TAGS = new Set([
  'wash_trader',
  'sandwich_bot',
  'mev_bot',
  'bot',
  'scammer',
  'phishing'
]);

/**
 * Filter rules for identifying consistent lowcap profitable traders from GMGN
 */
export function filterGmgnCandidate(w: RawGmgnWallet, nowSec: number = Math.floor(Date.now() / 1000)): CandidateWallet | null {
  const address = w.wallet_address;
  if (!address || address.length < 32) return null;

  const tags = (w.tags || []).map(t => t.toLowerCase());
  if (tags.some(t => TOXIC_TAGS.has(t))) return null;

  const pnl30d = Number(w.realized_profit_30d) || 0;
  const pnl7d = Number(w.realized_profit_7d) || 0;
  const wr30d = Number(w.winrate_30d) || 0;
  const wr7d = Number(w.winrate_7d) || 0;
  const txs30d = Number(w.txs_30d) || 0;
  const solBal = Number(w.sol_balance) || 0;
  const lastActive = Number(w.last_active) || 0;
  const ageHrs = lastActive > 0 ? (nowSec - lastActive) / 3600 : 999;
  const avgHold = Number(w.avg_holding_period_30d) || 0;

  // 1. Must be active within 48 hours
  if (ageHrs > 48) return null;

  // 2. Win rate at least 45% on 30d or 7d
  if (wr30d < 0.45 && wr7d < 0.45) return null;

  // 3. Meaningful profit: >= $3,000 in 30d OR >= $1,000 in 7d
  if (pnl30d < 3000 && pnl7d < 1000) return null;

  // 4. Human trading activity: 20 to 2,500 trades per 30 days
  if (txs30d < 20 || txs30d > 2500) return null;

  // 5. Active SOL balance: at least 0.1 SOL (~$18)
  if (solBal < 0.1) return null;

  return {
    address,
    name: w.name || w.twitter_name || w.nickname || '',
    tags: w.tags || [],
    solBalance: Number(solBal.toFixed(3)),
    pnl30d: Math.round(pnl30d),
    pnl7d: Math.round(pnl7d),
    winrate30d: Math.round(wr30d * 100),
    winrate7d: Math.round(wr7d * 100),
    txs30d,
    avgHoldingSeconds: Math.round(avgHold),
    gmgnLastActiveHoursAgo: Number(ageHrs.toFixed(1))
  };
}

/**
 * Fetch discovery wallets from GMGN via 1 open tab over CDP
 */
export async function fetchGmgnLowcapCandidates(cdpUrl: string = 'http://127.0.0.1:9223'): Promise<CandidateWallet[]> {
  console.log(`[CURATOR-GMGN] Connecting to Chrome CDP at ${cdpUrl}...`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const context = browser.contexts()[0];
  let page: Page | undefined = context?.pages().find(p => p.url().includes('gmgn.ai'));
  
  if (!page) {
    page = context?.pages()[0] || await context?.newPage();
    if (!page) throw new Error('Could not open page in Chrome context');
    console.log('[CURATOR-GMGN] Navigating 1 tab to https://gmgn.ai/?chain=sol...');
    await page.goto('https://gmgn.ai/?chain=sol', { waitUntil: 'domcontentloaded', timeout: 35000 });
  }

  console.log(`[CURATOR-GMGN] Connected to GMGN tab: ${page.url()}`);

  const endpoints = [
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/30d?tag=launchpad_smart&orderby=pnl_30d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?tag=launchpad_smart&orderby=pnl_7d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/1d?tag=launchpad_smart&orderby=pnl_1d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?tag=launchpad_smart&orderby=winrate_7d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/30d?tag=smart_degen&orderby=pnl_30d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?tag=smart_degen&orderby=pnl_7d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?tag=smart_degen&orderby=winrate_7d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/30d?tag=fresh_wallet&orderby=pnl_30d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/7d?tag=fresh_wallet&orderby=pnl_7d&direction=desc&limit=100',
    'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/1d?tag=fresh_wallet&orderby=pnl_1d&direction=desc&limit=100'
  ];

  console.log(`[CURATOR-GMGN] Fetching rankings across ${endpoints.length} lowcap discovery categories...`);
  const rawList: RawGmgnWallet[] = await page.evaluate(async (urls) => {
    const combined: any[] = [];
    for (const url of urls) {
      try {
        const res = await fetch(url);
        const json = await res.json();
        if (json?.data?.rank && Array.isArray(json.data.rank)) {
          combined.push(...json.data.rank);
        }
      } catch {
        // continue gracefully
      }
    }
    return combined;
  }, endpoints);

  console.log(`[CURATOR-GMGN] Total raw wallets fetched: ${rawList.length}`);

  // Deduplicate and filter candidates
  const map = new Map<string, RawGmgnWallet>();
  for (const item of rawList) {
    if (item.wallet_address && !map.has(item.wallet_address)) {
      map.set(item.wallet_address, item);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const candidates: CandidateWallet[] = [];
  for (const raw of map.values()) {
    const filtered = filterGmgnCandidate(raw, nowSec);
    if (filtered) {
      candidates.push(filtered);
    }
  }

  console.log(`[CURATOR-GMGN] Deduplicated ${map.size} unique wallets -> ${candidates.length} qualified candidates passed initial filters.`);
  return candidates;
}

/**
 * Verify candidate wallets against Helius RPC and Enhanced Transactions API
 */
export async function verifyWithHelius(
  candidates: CandidateWallet[],
  heliusApiKey: string,
  concurrency: number = 5
): Promise<HeliusVerifiedWallet[]> {
  console.log(`[CURATOR-HELIUS] Starting on-chain verification for ${candidates.length} candidate wallets (concurrency: ${concurrency})...`);
  const verifiedList: HeliusVerifiedWallet[] = [];
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
  const nowSec = Math.floor(Date.now() / 1000);

  for (let i = 0; i < candidates.length; i += concurrency) {
    const chunk = candidates.slice(i, i + concurrency);
    const promises = chunk.map(async (candidate) => {
      try {
        // 1. Query Helius RPC for recent signatures
        const rpcRes = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [candidate.address, { limit: 5 }]
          })
        });
        const rpcJson = await rpcRes.json().catch(() => ({}));
        const sigs: any[] = rpcJson?.result || [];
        const latestSig = sigs[0];
        const lastBlockTime = latestSig?.blockTime || 0;
        const lastTxHoursAgo = lastBlockTime > 0 ? Number(((nowSec - lastBlockTime) / 3600).toFixed(1)) : 999;
        const heliusActive = lastTxHoursAgo <= 48;

        // 2. Query Helius Enhanced Transactions API for parsed DEX swaps
        const enhancedUrl = `https://api.helius.xyz/v0/addresses/${candidate.address}/transactions?api-key=${heliusApiKey}&limit=5`;
        const enhRes = await fetch(enhancedUrl);
        const enhData = await enhRes.json().catch(() => []);
        const txs: any[] = Array.isArray(enhData) ? enhData : [];

        let hasPumpFunSwap = false;
        let hasRaydiumSwap = false;
        const recentTypes = new Set<string>();
        const recentSources = new Set<string>();

        for (const tx of txs) {
          if (tx.type) recentTypes.add(String(tx.type));
          if (tx.source) recentSources.add(String(tx.source));
          if (tx.source === 'PUMP_FUN' || tx.description?.toLowerCase().includes('pump.fun')) {
            hasPumpFunSwap = true;
          }
          if (tx.source === 'RAYDIUM' || tx.description?.toLowerCase().includes('raydium')) {
            hasRaydiumSwap = true;
          }
        }

        // 3. Compute Composite Score (0 - 100)
        // Win Rate component (up to 35 pts)
        const bestWinrate = Math.max(candidate.winrate30d, candidate.winrate7d);
        const wrScore = Math.min(35, (bestWinrate / 100) * 35);

        // PnL component (up to 35 pts, log-scaled: $100k+ reaches 35)
        const bestPnl = Math.max(candidate.pnl30d, candidate.pnl7d * 3);
        const pnlRatio = Math.max(0, Math.log10(Math.max(1, bestPnl)) / 5); // log10(100,000) = 5
        const pnlScore = Math.min(35, pnlRatio * 35);

        // Recency component (up to 20 pts: 0-4h = 20, 4-24h = 15, 24-48h = 10)
        let recencyScore = 5;
        if (lastTxHoursAgo <= 4) recencyScore = 20;
        else if (lastTxHoursAgo <= 12) recencyScore = 17;
        else if (lastTxHoursAgo <= 24) recencyScore = 14;
        else if (lastTxHoursAgo <= 48) recencyScore = 10;

        // Lowcap DEX activity bonus (up to 10 pts)
        let dexBonus = 0;
        if (hasPumpFunSwap) dexBonus += 7;
        if (hasRaydiumSwap) dexBonus += 3;

        const totalScore = Number((wrScore + pnlScore + recencyScore + dexBonus).toFixed(1));

        const verified: HeliusVerifiedWallet = {
          ...candidate,
          heliusActive,
          heliusLastTxSignature: latestSig?.signature || '',
          heliusLastBlockTime: lastBlockTime,
          heliusLastTxHoursAgo: lastTxHoursAgo,
          hasPumpFunSwap,
          hasRaydiumSwap,
          recentTxTypes: Array.from(recentTypes),
          recentSources: Array.from(recentSources),
          score: totalScore
        };

        return verified;
      } catch (err: any) {
        console.warn(`  [CURATOR-HELIUS] Failed verifying ${candidate.address.slice(0, 8)}:`, err?.message);
        return {
          ...candidate,
          heliusActive: false,
          heliusLastTxSignature: '',
          heliusLastBlockTime: 0,
          heliusLastTxHoursAgo: 999,
          hasPumpFunSwap: false,
          hasRaydiumSwap: false,
          recentTxTypes: [],
          recentSources: [],
          score: 0
        };
      }
    });

    const chunkResults = await Promise.all(promises);
    for (const r of chunkResults) {
      if (r.heliusActive) {
        verifiedList.push(r);
      }
    }

    console.log(`  Progress: ${Math.min(i + concurrency, candidates.length)}/${candidates.length} candidate wallets verified via Helius (Active: ${verifiedList.length})...`);
    await new Promise(res => setTimeout(res, 100)); // Respect RPC rate limits
  }

  // Sort descending by composite score
  verifiedList.sort((a, b) => b.score - a.score);
  console.log(`[CURATOR-HELIUS] Verification complete. ${verifiedList.length} wallets confirmed active and ranked.`);
  return verifiedList;
}

/**
 * Export results to structured JSON and CSV
 */
export function exportCuratedWallets(
  wallets: HeliusVerifiedWallet[],
  outputDir: string = '/home/bbliong/project/crypto-bot/data'
): { jsonPath: string; csvPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const jsonPath = join(outputDir, 'curated-lowcap-smart-wallets.json');
  const csvPath = join(outputDir, 'curated-lowcap-smart-wallets.csv');

  // 1. JSON Payload
  const jsonPayload = {
    updatedAt: new Date().toISOString(),
    totalCurated: wallets.length,
    criteria: {
      timeframe: '6 months / 30 days consistency',
      target: 'Lowcap / Launchpad / Pump.fun specialists',
      minWinrate: '>= 45%',
      minProfit30d: '$3,000 USD',
      onChainProof: 'Helius Verified < 48 hours activity'
    },
    wallets
  };
  writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), 'utf8');

  // 2. CSV Payload (Formatted for Excel / Google Sheets)
  const csvHeader = [
    'Rank',
    'Score',
    'Address',
    'Name',
    '30D_Profit_USD',
    '7D_Profit_USD',
    'Winrate_30D',
    'Winrate_7D',
    'SOL_Balance',
    '30D_Trades',
    'Last_Active_Hours_Ago',
    'Has_PumpFun_Swap',
    'Has_Raydium_Swap',
    'GMGN_Url'
  ].join(',');

  const csvRows = wallets.map((w, index) => {
    return [
      index + 1,
      w.score,
      w.address,
      `"${(w.name || '').replace(/"/g, '""')}"`,
      w.pnl30d,
      w.pnl7d,
      `${w.winrate30d}%`,
      `${w.winrate7d}%`,
      w.solBalance,
      w.txs30d,
      w.heliusLastTxHoursAgo,
      w.hasPumpFunSwap ? 'YES' : 'NO',
      w.hasRaydiumSwap ? 'YES' : 'NO',
      `https://gmgn.ai/sol/address/${w.address}`
    ].join(',');
  });

  writeFileSync(csvPath, [csvHeader, ...csvRows].join('\n'), 'utf8');
  console.log(`[CURATOR-EXPORT] Saved ${wallets.length} curated wallets to:\n - ${jsonPath}\n - ${csvPath}`);

  return { jsonPath, csvPath };
}
