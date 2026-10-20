import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { GmgnTokenWebSocketManager, type GmgnTradeTick } from './gmgn-token-websocket.js';
import {
  DistributionBounceLane,
  DistributionBounceLaneV2,
  DistributionBounceLaneV3,
  DistributionBounceLaneV4,
  DistributionBounceLaneV5,
  DistributionBounceLaneV6,
  DistributionBounceLaneV7,
} from './distribution-bounce-lane.js';
import {
  DistributionStaircaseLaneS1,
  DistributionStaircaseLaneS2,
  DistributionStaircaseLaneS3,
  DistributionStaircaseLaneS4,
  DistributionStaircaseLaneS5,
} from './distribution-staircase-lane.js';
import type { TargetEvent, TargetFacts, TargetTrade } from './distribution-target-lane.js';

export interface WatcherOptions {
  watchEventsLogPath?: string;
  profit4EventsLogPath?: string;
  activeLanes?: string[];
  page?: Page;
}

interface TrackedTokenState {
  mint: string;
  symbol: string;
  subscribedAt: number;
  reason: string;
  tradeCount: number;
  lanes: Map<string, any>;
  lastPrice: number;
  highPrice: number;
  lowPrice: number;
}

export class SyndicateDetailLaneWatcher extends EventEmitter {
  private watchEventsLogPath: string;
  private profit4EventsLogPath: string;
  private activeLanes: string[];
  private page: Page | null = null;
  private wsManager: GmgnTokenWebSocketManager | null = null;
  private trackedTokens = new Map<string, TrackedTokenState>();

  constructor(options: WatcherOptions = {}) {
    super();
    this.watchEventsLogPath = options.watchEventsLogPath || '/home/bbliong/project/crypto-bot/data/profit4-watch/watch-events.jsonl';
    this.profit4EventsLogPath = options.profit4EventsLogPath || '/home/bbliong/project/crypto-bot/data/profit4-watch/profit4-events.jsonl';
    this.activeLanes = options.activeLanes || [
      'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7',
      'S1', 'S2', 'S3', 'S4', 'S5'
    ];
    if (options.page) {
      this.attachPage(options.page);
    }
  }

  public async attachPage(page: Page): Promise<void> {
    this.page = page;
    this.wsManager = new GmgnTokenWebSocketManager(page, 15, 15);
    await this.wsManager.init();

    this.wsManager.on('trade', (trade: GmgnTradeTick) => {
      this.feedTradeTick(trade);
    });

    this.wsManager.on('stat', (stat: any) => {
      if (stat.mint && stat.price > 0) {
        this.feedTradeTick({
          mint: stat.mint,
          side: 'buy',
          price: stat.price,
          usd: 0,
          sol: 0,
          wallet: 'gmgn_stat',
          signature: 'stat_' + Date.now(),
          timestamp: Math.floor(stat.at / 1000),
          at: stat.at
        });
      }
    });

    console.log(`[LANE-WATCHER] 🔌 GmgnTokenWebSocketManager attached to GMGN tab (Zero-Tab Mode).`);
  }

  public escalateToken(mint: string, symbol: string = 'TOKEN', reason: string = 'INFLOW_DETECTED'): void {
    if (!mint) return;
    if (this.trackedTokens.has(mint)) {
      console.log(`[LANE-WATCHER] Token ${symbol} (${mint.slice(0, 8)}) already tracked.`);
      return;
    }

    console.log(`[LANE-WATCHER] 🚀 Escalating ${symbol} (${mint.slice(0, 8)}...) to Detail Watching [Lanes: ${this.activeLanes.join(',')}] | Reason: ${reason}`);

    // If WebSocket manager attached, inject subscribe frame to native GMGN WS
    if (this.wsManager) {
      this.wsManager.subscribeToken(mint, 'momentum', 7200).catch(err => {
        console.warn(`[LANE-WATCHER-WARN] Failed to inject WS subscribe for ${mint}: ${err.message}`);
      });
    }

    const lanesMap = new Map<string, any>();
    const onLaneEvent = (laneName: string, event: TargetEvent) => {
      this.handleLaneEvent(mint, symbol, laneName, event);
    };

    // Instantiate Bounce Lanes
    if (this.activeLanes.includes('V1')) lanesMap.set('V1', new DistributionBounceLane(mint, e => onLaneEvent('V1', e)));
    if (this.activeLanes.includes('V2')) lanesMap.set('V2', new DistributionBounceLaneV2(mint, e => onLaneEvent('V2', e)));
    if (this.activeLanes.includes('V3')) lanesMap.set('V3', new DistributionBounceLaneV3(mint, e => onLaneEvent('V3', e)));
    if (this.activeLanes.includes('V4')) lanesMap.set('V4', new DistributionBounceLaneV4(mint, e => onLaneEvent('V4', e)));
    if (this.activeLanes.includes('V5')) lanesMap.set('V5', new DistributionBounceLaneV5(mint, e => onLaneEvent('V5', e)));
    if (this.activeLanes.includes('V6')) lanesMap.set('V6', new DistributionBounceLaneV6(mint, e => onLaneEvent('V6', e)));
    if (this.activeLanes.includes('V7')) lanesMap.set('V7', new DistributionBounceLaneV7(mint, e => onLaneEvent('V7', e)));

    // Instantiate Staircase Lanes
    if (this.activeLanes.includes('S1')) lanesMap.set('S1', new DistributionStaircaseLaneS1(mint, e => onLaneEvent('S1', e)));
    if (this.activeLanes.includes('S2')) lanesMap.set('S2', new DistributionStaircaseLaneS2(mint, e => onLaneEvent('S2', e)));
    if (this.activeLanes.includes('S3')) lanesMap.set('S3', new DistributionStaircaseLaneS3(mint, e => onLaneEvent('S3', e)));
    if (this.activeLanes.includes('S4')) lanesMap.set('S4', new DistributionStaircaseLaneS4(mint, e => onLaneEvent('S4', e)));
    if (this.activeLanes.includes('S5')) lanesMap.set('S5', new DistributionStaircaseLaneS5(mint, e => onLaneEvent('S5', e)));

    this.trackedTokens.set(mint, {
      mint,
      symbol,
      subscribedAt: Date.now(),
      reason,
      tradeCount: 0,
      lanes: lanesMap,
      lastPrice: 0,
      highPrice: 0,
      lowPrice: Infinity
    });

    this.logEvent(this.watchEventsLogPath, {
      type: 'TOKEN_ESCALATED',
      observedAt: Date.now(),
      mint,
      symbol,
      reason,
      activeLanes: this.activeLanes
    });
  }

  public feedTradeTick(trade: GmgnTradeTick): void {
    const tokenState = this.trackedTokens.get(trade.mint);
    if (!tokenState) return;

    tokenState.tradeCount++;
    tokenState.lastPrice = trade.price;
    if (trade.price > tokenState.highPrice) tokenState.highPrice = trade.price;
    if (trade.price < tokenState.lowPrice) tokenState.lowPrice = trade.price;

    const targetTrade: TargetTrade = {
      at: trade.at,
      timestamp: trade.timestamp,
      price: trade.price,
      usd: trade.usd,
      side: trade.side,
      wallet: trade.wallet,
      signature: trade.signature
    };

    // Forward trade tick to each active lane
    for (const [laneName, laneInstance] of tokenState.lanes.entries()) {
      try {
        if (typeof laneInstance.onTrade === 'function') {
          laneInstance.onTrade(targetTrade);
        }
      } catch (err: any) {
        console.warn(`[LANE-WATCHER-ERR] Lane ${laneName} onTrade error: ${err.message}`);
      }
    }
  }

  private handleLaneEvent(mint: string, symbol: string, laneName: string, event: TargetEvent): void {
    const isTrigger = event.phase === 'OPEN' || event.phase === 'ENTERED' || String(event.reasons || '').includes('TARGET');
    if (isTrigger) {
      console.log(`[LANE-SIGNAL] ⚡ ${laneName} SIGNAL on ${symbol} (${mint.slice(0, 8)}): Phase=${event.phase} | Reasons=${event.reasons || '-'}`);
    }

    const payload = {
      observedAt: Date.now(),
      mint,
      symbol,
      lane: laneName,
      phase: event.phase,
      event
    };

    this.logEvent(this.watchEventsLogPath, payload);
    if (isTrigger) {
      this.logEvent(this.profit4EventsLogPath, payload);
      this.emit('signal', payload);
    }
  }

  private logEvent(filePath: string, event: Record<string, any>): void {
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch {}
  }

  public isTokenTracked(mint: string): boolean {
    return this.trackedTokens.has(mint);
  }

  public getTrackedMints(): string[] {
    return Array.from(this.trackedTokens.keys());
  }

  public getTradeCount(mint: string): number {
    return this.trackedTokens.get(mint)?.tradeCount ?? 0;
  }

  public unsubscribeToken(mint: string): void {
    this.trackedTokens.delete(mint);
    if (this.wsManager) {
      this.wsManager.unsubscribeToken(mint).catch(() => {});
    }
  }

  public stop(): void {
    for (const mint of this.getTrackedMints()) {
      this.unsubscribeToken(mint);
    }
    this.trackedTokens.clear();
  }
}
