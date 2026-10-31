import { chromium, type Browser, type Page } from 'playwright';
import { CloneWalletStore } from '../src/dna-wallet-scanner/clone-store.js';
import { evaluateTraderDna, TARGET_DNA } from '../src/dna-wallet-scanner/dna-filter.js';
import { FreshTokenCandidate } from '../src/dna-wallet-scanner/types.js';

const CDP_URL = 'http://127.0.0.1:9223';
const SCAN_INTERVAL_MS = 35_000; // 35s per scan cycle

class DnaWalletScanner {
  private store: CloneWalletStore;
  private isScanning = false;
  private processedMints = new Set<string>();

  constructor() {
    this.store = new CloneWalletStore();
  }

  public async start(): Promise<void> {
    console.log('='.repeat(80));
    console.log('🧬 DNA SMART WALLET SCANNER: CLONE HUNTER FOR 3azG8rmt... BOT ARCHITECTURE');
    console.log('='.repeat(80));
    console.log(`Scan Target: Fresh Lowcaps ($5k - $50k MC, Age <= 15m)`);
    console.log(`Target DNA : Stake $80-$450 | Hold 4s-360s | Profit >= $15 | Non-Dev | Skin >= 0.3 SOL`);
    console.log(`CDP Proxy  : ${CDP_URL}`);
    console.log(`Interval   : ${SCAN_INTERVAL_MS / 1000}s`);
    console.log(`Current DB : ${this.store.wallets.size} cloned wallets already on record\n`);

    // Initial immediate scan
    await this.runScanCycle();

    // Continuous loop
    setInterval(async () => {
      if (this.isScanning) return;
      await this.runScanCycle();
    }, SCAN_INTERVAL_MS);
  }

  private async runScanCycle(): Promise<void> {
    this.isScanning = true;
    const t0 = Date.now();
    let browser: Browser | null = null;

    try {
      browser = await chromium.connectOverCDP(CDP_URL);
      const contexts = browser.contexts();
      if (!contexts.length) {
        console.warn('[SCANNER] No browser contexts found on CDP port 9223.');
        return;
      }

      const page = contexts[0].pages().find(p => p.url().includes('gmgn.ai')) || contexts[0].pages()[0];
      if (!page) {
        console.warn('[SCANNER] No page found on CDP.');
        return;
      }

      // 1. Fetch fresh tokens
      const candidates = await this.fetchFreshTokens(page);
      console.log(`[SCAN CYCLE] Ditemukan ${candidates.length} kandidat token baru ($5k - $50k MC)...`);

      let totalTradersAudited = 0;
      let matchedCountThisCycle = 0;

      for (const tok of candidates) {
        try {
          const traders = await this.fetchTokenTraders(page, tok.mint);
          totalTradersAudited += traders.length;

          for (const tr of traders) {
            const evalRes = evaluateTraderDna(tr, tok.symbol, tok.mint, TARGET_DNA);
            if (evalRes.matched && evalRes.tradeRecord) {
              // Verify GMGN overall wallet profile (Reject overall negative/losing wallets)
              let gmgnProfile: any = null;
              try {
                gmgnProfile = await this.fetchWalletGmgnProfile(page, tr.address);
                if (gmgnProfile) {
                  const totProf = Number(gmgnProfile.total_profit || 0);
                  const real7d = Number(gmgnProfile.realized_profit_7d || 0);
                  if (totProf < 0 && real7d < 0) {
                    continue; // Reject losing trader
                  }
                }
              } catch {}

              const res = this.store.recordMatch(
                tr.address,
                evalRes.tradeRecord,
                evalRes.balanceSol || 0,
                tr.tags || []
              );

              // Attach GMGN profile & calendar if available
              const stored = this.store.wallets.get(tr.address);
              if (stored) {
                if (gmgnProfile) {
                  (stored as any).gmgnProfile = {
                    realized7d: Math.round(Number(gmgnProfile.realized_profit_7d || 0)),
                    totalProfit: Math.round(Number(gmgnProfile.total_profit || 0)),
                    totalBuys: Number(gmgnProfile.buy || gmgnProfile.buy_30d || 0),
                    totalSells: Number(gmgnProfile.sell || gmgnProfile.sell_30d || 0)
                  };
                }
                if (!stored.calendarPnl) {
                  try {
                    const cal = await this.fetchWalletDailyProfits(page, tr.address);
                    if (cal) stored.calendarPnl = cal;
                  } catch {}
                }
                this.store.save();
              }

              matchedCountThisCycle++;
              const flag = res.isNew ? '🌟 NEW CLONE' : `⚡ REPEAT HIT (${res.hitCount}x)`;
              console.log(`  ${flag} [${tok.symbol}]: ${tr.address.slice(0, 10)}... | Stake: $${evalRes.tradeRecord.stakeUsd} | Cuan: +$${evalRes.tradeRecord.profitUsd} (+${evalRes.tradeRecord.roiPct}%) | Hold: ${evalRes.tradeRecord.holdSec}s | Sells: ${evalRes.tradeRecord.sellCount}x`);
            }
          }

          // Small jitter delay between token trader queries to keep CDP responsive
          await new Promise(r => setTimeout(r, 200));
        } catch (tokErr: any) {
          // Token fetch error, continue next
        }
      }

      const durationSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[SCAN FINISHED ${durationSec}s] Audited ${totalTradersAudited} traders across ${candidates.length} tokens. Matched this cycle: ${matchedCountThisCycle}. Total Clones in DB: ${this.store.wallets.size}\n`);
    } catch (err: any) {
      console.error(`[SCANNER ERROR] ${err?.message}`);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
      this.isScanning = false;
    }
  }

  private async fetchFreshTokens(page: Page): Promise<FreshTokenCandidate[]> {
    return await page.evaluate(async () => {
      const candidates: Array<{
        mint: string;
        symbol: string;
        name: string;
        marketCap: number;
        openTimestamp: number;
        ageMinutes: number;
        source: 'pump_trenches' | 'swaps_1h';
        dexUrl: string;
      }> = [];

      const nowSec = Math.floor(Date.now() / 1000);

      // A. Query Pump Trenches ($5k - $50k)
      try {
        const r1 = await fetch('https://gmgn.ai/defi/quotation/v1/pairs/sol/new_pairs/pump?limit=25&min_marketcap=5000&max_marketcap=50000', { credentials: 'include' });
        const d1 = await r1.json();
        const list1 = d1?.data?.pairs || [];
        for (const p of list1) {
          const mint = p.base_address;
          if (!mint || candidates.some(c => c.mint === mint)) continue;
          const openTs = p.open_timestamp || nowSec;
          const ageMin = Math.round((nowSec - openTs) / 60);
          if (ageMin <= 25) { // younger than 25 mins
            candidates.push({
              mint,
              symbol: p.base_token_info?.symbol || 'UNKNOWN',
              name: p.base_token_info?.name || '',
              marketCap: Math.round(Number(p.market_cap || 0)),
              openTimestamp: openTs,
              ageMinutes: Math.max(0, ageMin),
              source: 'pump_trenches',
              dexUrl: `https://gmgn.ai/sol/token/${mint}`
            });
          }
        }
      } catch {}

      // B. Query Swaps 1h ($5k - $50k)
      try {
        const r2 = await fetch('https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?limit=15&min_marketcap=5000&max_marketcap=50000&orderby=swaps&direction=desc', { credentials: 'include' });
        const d2 = await r2.json();
        const list2 = d2?.data?.rank || [];
        for (const p of list2) {
          const mint = p.address;
          if (!mint || candidates.some(c => c.mint === mint)) continue;
          const openTs = p.open_timestamp || nowSec;
          const ageMin = Math.round((nowSec - openTs) / 60);
          if (ageMin <= 30) {
            candidates.push({
              mint,
              symbol: p.symbol || 'UNKNOWN',
              name: p.name || '',
              marketCap: Math.round(Number(p.market_cap || 0)),
              openTimestamp: openTs,
              ageMinutes: Math.max(0, ageMin),
              source: 'swaps_1h',
              dexUrl: `https://gmgn.ai/sol/token/${mint}`
            });
          }
        }
      } catch {}

      return candidates;
    });
  }

  private async fetchTokenTraders(page: Page, mint: string): Promise<any[]> {
    return await page.evaluate(async (m: string) => {
      try {
        const res = await fetch(`https://gmgn.ai/vas/api/v1/token_traders/sol/${m}?limit=25&orderby=profit&direction=desc`, { credentials: 'include' });
        const data = await res.json();
        return data?.data?.list || [];
      } catch {
        return [];
      }
    }, mint);
  }

  private async fetchWalletGmgnProfile(page: Page, address: string): Promise<any> {
    return await page.evaluate(async (addr: string) => {
      try {
        const res = await fetch(`https://gmgn.ai/defi/quotation/v1/smartmoney/sol/walletNew/${addr}?period=7d`, { credentials: 'include' });
        const d = await res.json();
        return d?.data || null;
      } catch {
        return null;
      }
    }, address);
  }

  private async fetchWalletDailyProfits(page: Page, address: string): Promise<any> {
    return await page.evaluate(async (addr: string) => {
      try {
        const now = Math.floor(Date.now() / 1000);
        const start_at = now - 60 * 86400;
        const r = await fetch("https://gmgn.ai/pf/api/v1/wallets/sol/daily_profits", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            wallet_addresses: [addr],
            start_at,
            end_at: now
          })
        });
        const res = await r.json();
        const list = res?.data?.list || [];
        let pos = 0, neg = 0, zero = 0, tot = 0;
        for (const d of list) {
          const p = parseFloat(d.total_profit || "0");
          tot += p;
          if (p > 0) pos++;
          else if (p < 0) neg++;
          else zero++;
        }
        const activeDays = pos + neg;
        const calWinRate = activeDays > 0 ? Number((pos / activeDays * 100).toFixed(1)) : 0;
        return {
          totalDays: list.length,
          positiveDays: pos,
          negativeDays: neg,
          zeroDays: zero,
          calendarWinRate: calWinRate,
          totalNetPnl: Math.round(tot)
        };
      } catch {
        return null;
      }
    }, address);
  }
}

const scanner = new DnaWalletScanner();
scanner.start().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
