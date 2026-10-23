import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface WalletTxRecord {
  wallet: string;
  signature: string;
  timestamp: number;
  timeIso: string;
  type: string;
  source: string;
  mint: string;
  isBuy: boolean;
  isSell: boolean;
  solAmount: number;
  tokenAmount: number;
}

interface SharedTokenReport {
  mint: string;
  symbol: string;
  name: string;
  walletCount: number;
  wallets: string[];
  dexInfo?: {
    dexId: string;
    priceUsd: string;
    fdv: number;
    liquidityUsd: number;
    h1Change: number;
    h6Change: number;
  };
  minEntryDeltaSec: number;
  avgHoldSec: number;
  isSyndicateDump: boolean;
  verdict: 'SYNDICATE_DUMP' | 'ORGANIC_CONSENSUS' | 'SCALP_ARBITRAGE';
  verdictDetail: string;
  walletTimelines: Array<{
    wallet: string;
    firstBuyTime?: string;
    lastSellTime?: string;
    holdSec?: number;
    solSpent: number;
    solReceived: number;
    netSolProfit: number;
  }>;
}

function getHeliusKey(): string {
  if (process.env.HELIUS_API_KEY) return process.env.HELIUS_API_KEY.trim();
  const envPath = join(process.cwd(), '.env');
  const match = readFileSync(envPath, 'utf8').match(/HELIUS_API_KEY=([^\s\r\n]+)/);
  return match ? match[1].trim() : '';
}

async function fetchDexScreener(mint: string) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(4000)
    });
    const data = await res.json();
    const pair = data.pairs?.[0];
    if (pair) {
      return {
        symbol: pair.baseToken?.symbol || 'UNKNOWN',
        name: pair.baseToken?.name || 'UNKNOWN',
        dexId: pair.dexId || 'solana',
        priceUsd: pair.priceUsd || '0',
        fdv: Number(pair.fdv) || 0,
        liquidityUsd: Number(pair.liquidity?.usd) || 0,
        h1Change: Number(pair.priceChange?.h1) || 0,
        h6Change: Number(pair.priceChange?.h6) || 0
      };
    }
  } catch {}
  return null;
}

async function main() {
  console.log('========================================================================================');
  console.log('🛡️ ANTI-SYNDICATE DEEP TOKEN & CANDLE AUDIT PIPELINE');
  console.log('========================================================================================\n');

  const heliusKey = getHeliusKey();
  if (!heliusKey) {
    console.error('HELIUS_API_KEY not found in .env!');
    process.exit(1);
  }

  const jsonPath = join(process.cwd(), 'data', 'curated-lowcap-smart-wallets.json');
  const candidateData = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const candidates = candidateData.wallets.slice(0, 100); // Audit up to top 100 wallets

  console.log(`Auditing ${candidates.length} smart wallet candidates on-chain...`);
  const t0 = Date.now();

  // 1. Fetch recent transactions for all candidates in parallel batches
  const tokenToTxs = new Map<string, WalletTxRecord[]>();
  const walletTokens = new Map<string, Set<string>>();

  const BATCH_SIZE = 3;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const chunk = candidates.slice(i, i + BATCH_SIZE);
    const promises = chunk.map(async (candidate: any) => {
      const url = `https://api.helius.xyz/v0/addresses/${candidate.address}/transactions?api-key=${heliusKey}&limit=30`;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          if (res.status === 429) {
            await new Promise(r => setTimeout(r, 1200 * attempt));
            continue;
          }
          const txs: any[] = await res.json();
          if (!Array.isArray(txs)) return [];

          const records: WalletTxRecord[] = [];
          const heldMints = new Set<string>();

          for (const tx of txs) {
            const transfers = tx.tokenTransfers || [];
            for (const tt of transfers) {
              const mint = tt.mint;
              if (!mint || mint === 'So11111111111111111111111111111111111111112' || mint.startsWith('EPjF')) {
                continue; // skip SOL & USDC
              }

              heldMints.add(mint);

              // Determine if wallet bought or sold
              const isBuy = tt.toUserAccount === candidate.address;
              const isSell = tt.fromUserAccount === candidate.address;

              // Approximate SOL involved
              let solAmount = 0;
              for (const nt of (tx.nativeTransfers || [])) {
                if (nt.toUserAccount === candidate.address || nt.fromUserAccount === candidate.address) {
                  solAmount += (Number(nt.amount) || 0) / 1e9;
                }
              }

              records.push({
                wallet: candidate.address,
                signature: tx.signature,
                timestamp: tx.timestamp,
                timeIso: new Date(tx.timestamp * 1000).toISOString(),
                type: tx.type || 'SWAP',
                source: tx.source || 'UNKNOWN',
                mint,
                isBuy,
                isSell,
                solAmount: Number(solAmount.toFixed(4)),
                tokenAmount: Number(tt.tokenAmount) || 0
              });
            }
          }

          walletTokens.set(candidate.address, heldMints);
          return records;
        } catch (err: any) {
          if (attempt === 3) {
            console.warn(`  Failed fetching txs for ${candidate.address.slice(0, 8)}:`, err?.message);
          }
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      return [];
    });

    const chunkResults = await Promise.all(promises);
    for (const recs of chunkResults) {
      for (const r of recs) {
        if (!tokenToTxs.has(r.mint)) {
          tokenToTxs.set(r.mint, []);
        }
        tokenToTxs.get(r.mint)!.push(r);
      }
    }
    await new Promise(r => setTimeout(r, 300)); // Respect RPC rate limit
  }

  console.log(`[STAGE 1 DONE] In ${((Date.now() - t0) / 1000).toFixed(1)}s. Total unique tokens mapped: ${tokenToTxs.size}`);

  // 2. Identify tokens with convergence (>= 2 candidate wallets)
  const sharedMints: string[] = [];
  for (const [mint, records] of tokenToTxs.entries()) {
    const uniqueWallets = new Set(records.map(r => r.wallet));
    if (uniqueWallets.size >= 2) {
      sharedMints.push(mint);
    }
  }

  console.log(`\n[STAGE 2] Found ${sharedMints.length} tokens entered by 2 or more candidate wallets!`);

  // 3. Inspect each shared token: DexScreener, Entry Deltas, Hold Durations & Dumps
  const sharedReports: SharedTokenReport[] = [];
  const syndicateWallets = new Set<string>();

  for (const mint of sharedMints) {
    const allRecords = tokenToTxs.get(mint)!;
    const uniqueWallets = Array.from(new Set(allRecords.map(r => r.wallet)));

    // Fetch market cap, liquidity, candle changes
    const dex = await fetchDexScreener(mint);

    // Analyze per wallet timeline
    const walletTimelines = uniqueWallets.map(wAddr => {
      const wRecs = allRecords.filter(r => r.wallet === wAddr).sort((a, b) => a.timestamp - b.timestamp);
      const buys = wRecs.filter(r => r.isBuy);
      const sells = wRecs.filter(r => r.isSell);

      const firstBuy = buys[0];
      const lastSell = sells[sells.length - 1];

      let holdSec: number | undefined;
      if (firstBuy && lastSell && lastSell.timestamp >= firstBuy.timestamp) {
        holdSec = lastSell.timestamp - firstBuy.timestamp;
      }

      let solSpent = 0;
      let solReceived = 0;
      for (const b of buys) solSpent += b.solAmount;
      for (const s of sells) solReceived += s.solAmount;

      return {
        wallet: wAddr,
        firstBuyTime: firstBuy?.timeIso,
        firstBuyTs: firstBuy?.timestamp,
        lastSellTime: lastSell?.timeIso,
        lastSellTs: lastSell?.timestamp,
        holdSec,
        solSpent: Number(solSpent.toFixed(3)),
        solReceived: Number(solReceived.toFixed(3)),
        netSolProfit: Number((solReceived - solSpent).toFixed(3))
      };
    });

    // Check entry delta between wallets
    const entryTimestamps = walletTimelines
      .map(wt => wt.firstBuyTs)
      .filter((ts): ts is number => typeof ts === 'number');

    let minEntryDeltaSec = 999999;
    if (entryTimestamps.length >= 2) {
      for (let i = 0; i < entryTimestamps.length; i++) {
        for (let j = i + 1; j < entryTimestamps.length; j++) {
          const delta = Math.abs(entryTimestamps[i] - entryTimestamps[j]);
          if (delta < minEntryDeltaSec) minEntryDeltaSec = delta;
        }
      }
    }

    const completedHolds = walletTimelines
      .map(wt => wt.holdSec)
      .filter((h): h is number => typeof h === 'number');

    const avgHoldSec = completedHolds.length > 0
      ? Math.round(completedHolds.reduce((a, b) => a + b, 0) / completedHolds.length)
      : 999;

    // Decision Logic:
    let isSyndicateDump = false;
    let verdict: 'SYNDICATE_DUMP' | 'ORGANIC_CONSENSUS' | 'SCALP_ARBITRAGE' = 'ORGANIC_CONSENSUS';
    let verdictDetail = '';

    const isPoolDrained = (dex?.liquidityUsd || 0) < 500 && (dex?.fdv || 0) < 50000;
    const isDumpCrash = (dex?.h1Change || 0) < -50 || (dex?.h6Change || 0) < -50;

    if (minEntryDeltaSec <= 30 && avgHoldSec <= 120 && (isPoolDrained || isDumpCrash)) {
      isSyndicateDump = true;
      verdict = 'SYNDICATE_DUMP';
      verdictDetail = `🚨 SINDIKAT TERBUKTI: Entry serentak (${minEntryDeltaSec} dtk), dump kilat (avg hold ${avgHoldSec} dtk), dan likuiditas terkuras ($${dex?.liquidityUsd?.toFixed(0) || 0})!`;
      for (const w of uniqueWallets) syndicateWallets.add(w);
    } else if (minEntryDeltaSec <= 10 && avgHoldSec <= 60) {
      isSyndicateDump = true;
      verdict = 'SYNDICATE_DUMP';
      verdictDetail = `🚨 SINDIKAT TERBUKTI: Bot multi-wallet sniper (selisih entry ${minEntryDeltaSec} dtk, hold ${avgHoldSec} dtk).`;
      for (const w of uniqueWallets) syndicateWallets.add(w);
    } else if (dex?.liquidityUsd && dex.liquidityUsd > 100000) {
      verdict = 'ORGANIC_CONSENSUS';
      verdictDetail = `✅ ORGANIC CONSENSUS: Token likuiditas sehat ($${(dex.liquidityUsd / 1000).toFixed(0)}k), bukan koordinasi dump.`;
    } else {
      verdict = 'ORGANIC_CONSENSUS';
      verdictDetail = `✅ ORGANIC INDEPENDENT: Entry independen (${minEntryDeltaSec} dtk), durasi hold wajar (${avgHoldSec} dtk).`;
    }

    sharedReports.push({
      mint,
      symbol: dex?.symbol || 'UNKNOWN',
      name: dex?.name || 'UNKNOWN',
      walletCount: uniqueWallets.length,
      wallets: uniqueWallets,
      dexInfo: dex || undefined,
      minEntryDeltaSec,
      avgHoldSec,
      isSyndicateDump,
      verdict,
      verdictDetail,
      walletTimelines
    });
  }

  // 4. Print Detailed Inspection Report
  console.log('\n========================================================================================');
  console.log('📌 HASIL INSPEKSI TOKEN BERSAMA & ANALISIS CANDLE/DUMP:');
  console.log('========================================================================================');
  for (const sr of sharedReports) {
    console.log(`\nToken: ${sr.symbol} (${sr.mint})`);
    console.log(` - DexScreener: FDV $${sr.dexInfo?.fdv?.toLocaleString() || 'N/A'} | Liquidity: $${sr.dexInfo?.liquidityUsd?.toLocaleString() || 'N/A'} | 1h: ${sr.dexInfo?.h1Change || 0}%`);
    console.log(` - Wallets (${sr.walletCount}): ${sr.wallets.map(w => w.slice(0, 6) + '...' + w.slice(-4)).join(', ')}`);
    console.log(` - Selisih Entry : ${sr.minEntryDeltaSec === 999999 ? 'N/A' : `${sr.minEntryDeltaSec} detik`}`);
    console.log(` - Rata-rata Hold: ${sr.avgHoldSec === 999 ? 'Belum Exit / Masih Hold' : `${sr.avgHoldSec} detik`}`);
    console.log(` - Status        : ${sr.verdictDetail}`);
    for (const wt of sr.walletTimelines) {
      console.log(`   * [${wt.wallet.slice(0, 6)}...] Buy: ${wt.firstBuyTime || 'N/A'} | Sell: ${wt.lastSellTime || 'Belum'} | Hold: ${wt.holdSec !== undefined ? `${wt.holdSec}s` : '—'} | Net SOL: ${wt.netSolProfit >= 0 ? '+' : ''}${wt.netSolProfit}`);
    }
  }

  // 5. Filter Verified Organic Wallets
  console.log('\n========================================================================================');
  console.log('🛡️ HASIL PURGING: MEMISAHKAN SINDIKAT DARI WALLET ORGANIK MURNI:');
  console.log('========================================================================================');
  console.log(`Total Wallet Sindikat Teridentifikasi & Dieliminasi: ${syndicateWallets.size}`);
  for (const sw of syndicateWallets) {
    console.log(`  ❌ DIBUANG: ${sw}`);
  }

  const cleanOrganicWallets = candidates.filter((c: any) => !syndicateWallets.has(c.address));
  console.log(`\nTotal Wallet Valid Organik (Lolos Uji Tanpa Sindikat): ${cleanOrganicWallets.length} dari ${candidates.length} kandidat`);
  console.log('-----------------------------------------------------------------------------------------------------------------');
  console.log('Rank | Wallet Address                               | WinRate | 30d PnL ($) | SOL Bal | Status');
  console.log('-----------------------------------------------------------------------------------------------------------------');
  cleanOrganicWallets.slice(0, 15).forEach((w: any, idx: number) => {
    const rStr = String(idx + 1).padStart(4, ' ');
    const aStr = w.address.padEnd(44, ' ');
    const wrStr = `${w.winrate30d}%`.padStart(7, ' ');
    const pnlStr = `+$${w.pnl30d.toLocaleString()}`.padStart(11, ' ');
    const solStr = String(w.solBalance.toFixed(1)).padStart(7, ' ');
    console.log(`${rStr} | ${aStr} | ${wrStr} | ${pnlStr} | ${solStr} | ✅ VERIFIED ORGANIC SMART`);
  });
  console.log('-----------------------------------------------------------------------------------------------------------------');

  // Save audit output
  const outputPayload = {
    auditedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
    syndicatesDetected: Array.from(syndicateWallets),
    verifiedOrganicCount: cleanOrganicWallets.length,
    sharedTokensInspection: sharedReports,
    cleanOrganicWallets
  };

  const auditPath = join(process.cwd(), 'data', 'syndicate-candle-audit-results.json');
  writeFileSync(auditPath, JSON.stringify(outputPayload, null, 2), 'utf8');
  console.log(`\n💾 Laporan audit lengkap tersimpan di:\n -> ${auditPath}\n`);
}

main().catch(err => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
