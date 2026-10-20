import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { MonitoredTarget } from './syndicate-wallet-selector.js';

export interface InflowEvent {
  observedAt: number;
  wallet: string;
  mint: string;
  symbol: string;
  amount: string;
  txHash: string;
  timestamp: number;
  timeWib: string;
}

export interface InflowMonitorOptions {
  configPath?: string;
  inflowLogPath?: string;
  cdpUrl?: string;
  pollIntervalMs?: number;
}

export class GmgnWalletInflowMonitor extends EventEmitter {
  private configPath: string;
  private inflowLogPath: string;
  private cdpUrl: string;
  private pollIntervalMs: number;
  private seenTxs: Set<string> = new Set();
  private isRunning: boolean = false;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(options: InflowMonitorOptions = {}) {
    super();
    this.configPath = options.configPath || '/home/bbliong/project/crypto-bot/data/syndicate-watch/gmgn-monitored-wallets.json';
    this.inflowLogPath = options.inflowLogPath || '/home/bbliong/project/crypto-bot/data/syndicate-watch/syndicate-inflows.jsonl';
    this.cdpUrl = options.cdpUrl || 'http://127.0.0.1:9222';
    this.pollIntervalMs = options.pollIntervalMs || 5000;
  }

  public onInflow(callback: (event: InflowEvent) => void): this {
    return this.on('inflow', callback);
  }

  public loadTargets(): MonitoredTarget[] {
    if (!fs.existsSync(this.configPath)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return data.targets || [];
    } catch {
      return [];
    }
  }

  public processWalletActivities(wallet: string, activities: any[]): InflowEvent[] {
    if (!Array.isArray(activities)) return [];
    const newInflows: InflowEvent[] = [];

    for (const act of activities) {
      const eventType = String(act.event_type || act.event || '').toLowerCase();
      // Track transfers, airdrops, and token deployments from bandar / recipient
      if (!['transfer_in', 'transfer_out', 'transfer', 'create', 'sell', 'buy'].includes(eventType)) continue;

      const txHash = act.tx_hash || act.signature || act.hash || `${wallet}_${act.timestamp}`;
      if (this.seenTxs.has(txHash)) continue;
      this.seenTxs.add(txHash);

      const mint = act.token?.address || act.token_address || act.mint || '';
      const symbol = act.token?.symbol || act.symbol || 'UNKNOWN';
      const amount = String(act.amount || act.token_amount || '0');
      const ts = Number(act.timestamp) || Math.floor(Date.now() / 1000);
      const timeWib = new Date(ts * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) + ' WIB';

      const inflow: InflowEvent = {
        observedAt: Date.now(),
        wallet,
        mint,
        symbol,
        amount,
        txHash,
        timestamp: ts,
        timeWib
      };

      newInflows.push(inflow);
      this.recordInflowLog(inflow);
      this.emit('inflow', inflow);
      console.log(`[GMGN-INFLOW-HIT] 🚨 Activity '${eventType}' on wallet ${wallet.slice(0, 8)}... Token: ${symbol} (${mint.slice(0, 8)}...) @ ${timeWib}`);
    }

    return newInflows;
  }

  private recordInflowLog(inflow: InflowEvent): void {
    try {
      const dir = path.dirname(this.inflowLogPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(this.inflowLogPath, JSON.stringify(inflow) + '\n', 'utf8');
    } catch (err: any) {
      console.warn(`[GMGN-MONITOR] Failed to write inflow log: ${err?.message}`);
    }
  }

  public async initBrowserSession(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    // Try port 9223 (headed Chrome with cleared Cloudflare) first, fallback to configured cdpUrl
    const cdpUrls = ['http://127.0.0.1:9223', this.cdpUrl];
    for (const u of cdpUrls) {
      try {
        this.browser = await chromium.connectOverCDP(u);
        this.cdpUrl = u;
        break;
      } catch {}
    }
    if (!this.browser) {
      this.browser = await chromium.connectOverCDP(this.cdpUrl);
    }

    const contexts = this.browser.contexts();
    this.context = contexts.length > 0 ? contexts[0] : await this.browser.newContext();
    const pages = this.context.pages();

    // Prefer page on gmgn.ai if open
    this.page = pages.find(p => !p.isClosed() && p.url().includes('gmgn.ai')) ||
                pages.find(p => !p.isClosed()) ||
                (await this.context.newPage());

    // Ensure tab is loaded on GMGN
    try {
      const currentUrl = this.page.url();
      if (!currentUrl.includes('gmgn.ai')) {
        const targets = this.loadTargets();
        const firstWallet = targets[0]?.deployerAddress || targets[0]?.monitoredWallet || 'DHZYnMyqknLmJkrwySqQqiJ7qrNZSGg5Nw4AXLZYN2Hz';
        console.log(`[GMGN-MONITOR] Navigating tab to GMGN: https://gmgn.ai/sol/address/${firstWallet}`);
        await this.page.goto(`https://gmgn.ai/sol/address/${firstWallet}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      }
    } catch {}

    return this.page;
  }

  public async start(durationSeconds?: number): Promise<void> {
    this.isRunning = true;
    const deadlineMs = durationSeconds ? Date.now() + (durationSeconds * 1000) : Infinity;

    console.log(`[GMGN-MONITOR] 🛰️ Starting GMGN live inflow polling (duration: ${durationSeconds ? durationSeconds + 's' : 'continuous'})...`);

    try {
      let page = await this.initBrowserSession();

      while (this.isRunning && Date.now() < deadlineMs) {
        const targets = this.loadTargets();
        if (targets.length === 0) {
          console.log(`[GMGN-MONITOR] No targets in config, waiting...`);
          await new Promise(r => setTimeout(r, this.pollIntervalMs));
          continue;
        }

        for (const target of targets) {
          if (!this.isRunning || Date.now() >= deadlineMs) break;

          // Target deployer/bandar wallet first, then recipient
          const walletsToCheck = [target.deployerAddress, target.monitoredWallet].filter(Boolean) as string[];

          for (const wallet of walletsToCheck) {
            if (!this.isRunning || Date.now() >= deadlineMs) break;

            try {
              if (!page || page.isClosed()) {
                page = await this.initBrowserSession();
              }

              const query = new URLSearchParams({ wallet, limit: '20', cost: 'usd' });
              const body = await page.evaluate(async url => {
                const resp = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(10000) });
                if (!resp.ok) return { code: resp.status, msg: 'Fetch failed' };
                return await resp.json();
              }, `/vas/api/v1/wallet_activity/sol?${query}`);

              if (body?.code === 429 || body?.status === 429) {
                console.warn(`[GMGN-MONITOR] Rate limit (429) hit. Pausing 15s for Cloudflare cool down...`);
                await new Promise(r => setTimeout(r, 15000));
                break;
              }

              if (body && Array.isArray(body?.data?.activities)) {
                this.processWalletActivities(wallet, body.data.activities);
              }
            } catch (err: any) {
              console.warn(`[GMGN-MONITOR-WARN] Poll error on ${wallet.slice(0, 8)}: ${err?.message}`);
            }

            // Polite gap between queries to respect GMGN limits
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        await new Promise(r => setTimeout(r, this.pollIntervalMs));
      }
    } catch (err: any) {
      console.error(`[GMGN-MONITOR-ERR] Error running GMGN monitor:`, err?.message);
    } finally {
      this.stop();
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.emit('stopped');
  }

  public getPage(): Page | null {
    return this.page;
  }
}
