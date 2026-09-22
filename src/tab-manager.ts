export interface SlotTrade {
  side: 'buy' | 'sell';
  amountUsd: number;
  priceUsd: number;
  occurredAt: number;
  wallet?: string;
  isBigSell?: boolean;
}

export interface SlotAlert {
  type: 'WHALE_SELL' | 'DEV_SELL' | 'HOLDER_DROP' | 'SELL_PRESSURE' | 'PRICE_CRASH';
  level: 'DANGER' | 'WARNING';
  title: string;
  detail: string;
  occurredAt: number;
}

export interface ActiveTabInfo {
  mint: string;
  symbol: string;
  name?: string;
  imageUrl?: string;
  url: string;
  openedAt: number;
  initialPriceUsd?: number;
  lastPriceUsd?: number;
  peakPriceUsd?: number;
  priceChangePercent?: number;
  drawdownPercent?: number;
  holders?: number;
  initialHolders?: number;
  holderDelta?: number;
  holderDeclineStreak?: number;
  holderHistory?: { observedAt: number; count: number }[];
  buysCount?: number;
  sellsCount?: number;
  buyUsd?: number;
  sellUsd?: number;
  netFlowUsd?: number;
  buyRatioPercent?: number;
  // Holder Distribution
  top10Percent?: number;
  top5Percent?: number;
  developerPercent?: number;
  singlePercent?: number;
  retailPercent?: number;
  bundledPercent?: number;
  // Token Market Details
  liquidityUsd?: number;
  marketCapUsd?: number;
  createdAt?: number;
  // Socket Trades & Alerts
  recentTrades?: SlotTrade[];
  alerts?: SlotAlert[];
  hasWarning?: boolean;
}

export interface ClosedTabHistory {
  index: number;
  mint: string;
  symbol: string;
  name?: string;
  imageUrl?: string;
  url: string;
  openedAt: number;
  closedAt: number;
  durationSeconds: number;
  lastPriceUsd?: number;
  holders?: number;
  marketCapUsd?: number;
  top10Percent?: number;
  buyRatioPercent?: number;
}

export interface SlotState {
  slotNumber: number;
  isEmpty: boolean;
  tab?: ActiveTabInfo;
}

export class TabManager {
  private activeTabs = new Map<string, ActiveTabInfo>();
  private closedHistory: ClosedTabHistory[] = [];
  private historyCounter = 0;

  constructor(public readonly maxTabs = 1) {
    if (!Number.isInteger(maxTabs) || maxTabs < 1) {
      throw new Error('maxTabs must be a positive integer');
    }
  }

  canOpen(): boolean {
    return this.activeTabs.size < this.maxTabs;
  }

  getMaxTabs(): number {
    return this.maxTabs;
  }

  getActiveCount(): number {
    return this.activeTabs.size;
  }

  isTabActive(mint: string): boolean {
    return this.activeTabs.has(mint);
  }

  getActiveTabs(): ActiveTabInfo[] {
    return Array.from(this.activeTabs.values());
  }

  getClosedHistory(): ClosedTabHistory[] {
    return [...this.closedHistory];
  }

  openTab(
    mint: string,
    symbol: string,
    url: string,
    name?: string,
    openedAt = Date.now(),
    initialPrice?: number,
    holders?: number,
    extra?: Partial<ActiveTabInfo>
  ): boolean {
    if (this.activeTabs.has(mint)) return false;
    if (this.activeTabs.size >= this.maxTabs) return false;
    const tab: ActiveTabInfo = {
      mint,
      symbol,
      name,
      url,
      openedAt,
      initialPriceUsd: initialPrice,
      lastPriceUsd: initialPrice,
      peakPriceUsd: initialPrice,
      priceChangePercent: 0,
      drawdownPercent: 0,
      holders,
      initialHolders: holders,
      holderDelta: 0,
      holderDeclineStreak: 0,
      holderHistory: holders ? [{ observedAt: openedAt, count: holders }] : [],
      buysCount: 0,
      sellsCount: 0,
      buyUsd: 0,
      sellUsd: 0,
      netFlowUsd: 0,
      buyRatioPercent: 50,
      recentTrades: [],
      alerts: [],
      hasWarning: false,
      ...(extra ?? {}),
    };

    if (typeof tab.top10Percent === 'number' && Number.isFinite(tab.top10Percent)) {
      tab.retailPercent = Math.max(0, Math.round((100 - tab.top10Percent) * 10) / 10);
    }

    this.activeTabs.set(mint, tab);
    return true;
  }

  updateTab(mint: string, updates: Partial<ActiveTabInfo>): void {
    const current = this.activeTabs.get(mint);
    if (!current) return;
    Object.assign(current, updates);
    if (typeof current.top10Percent === 'number' && Number.isFinite(current.top10Percent)) {
      current.retailPercent = Math.max(0, Math.round((100 - current.top10Percent) * 10) / 10);
    }
  }

  updateTokenMetrics(mint: string, metrics: Partial<ActiveTabInfo>): void {
    const tab = this.activeTabs.get(mint);
    if (!tab) return;
    for (const [k, v] of Object.entries(metrics)) {
      if (v !== undefined && v !== null) {
        (tab as any)[k] = v;
      }
    }
    if (typeof tab.top10Percent === 'number' && Number.isFinite(tab.top10Percent)) {
      tab.retailPercent = Math.max(0, Math.round((100 - tab.top10Percent) * 10) / 10);
    }
    const bUsd = tab.buyUsd ?? 0;
    const sUsd = tab.sellUsd ?? 0;
    const totalUsd = bUsd + sUsd;
    if (totalUsd > 0) {
      tab.buyRatioPercent = Math.round((bUsd / totalUsd) * 1000) / 10;
    }
  }

  recordTrade(
    mint: string,
    trade: {
      side: 'buy' | 'sell';
      amountUsd: number;
      priceUsd: number;
      occurredAt?: number;
      wallet?: string;
    }
  ): void {
    const tab = this.activeTabs.get(mint);
    if (!tab) return;

    const now = trade.occurredAt ?? Date.now();
    tab.lastPriceUsd = trade.priceUsd;

    if (!tab.initialPriceUsd && trade.priceUsd > 0) {
      tab.initialPriceUsd = trade.priceUsd;
    }
    if (!tab.peakPriceUsd || trade.priceUsd > tab.peakPriceUsd) {
      tab.peakPriceUsd = trade.priceUsd;
    }
    if (tab.initialPriceUsd && tab.initialPriceUsd > 0) {
      tab.priceChangePercent = ((trade.priceUsd - tab.initialPriceUsd) / tab.initialPriceUsd) * 100;
    }
    if (tab.peakPriceUsd && tab.peakPriceUsd > 0) {
      tab.drawdownPercent = ((trade.priceUsd - tab.peakPriceUsd) / tab.peakPriceUsd) * 100;
    }

    const isBigSell = trade.side === 'sell' && trade.amountUsd >= 80;
    const slotTrade: SlotTrade = {
      side: trade.side,
      amountUsd: trade.amountUsd,
      priceUsd: trade.priceUsd,
      occurredAt: now,
      wallet: trade.wallet,
      isBigSell,
    };

    const tradesList = tab.recentTrades ?? [];
    tradesList.unshift(slotTrade);
    // Keep last 30 trades within 45 seconds
    tab.recentTrades = tradesList.filter(t => now - t.occurredAt <= 45_000).slice(0, 30);

    // Calculate flow statistics
    let bCount = 0, sCount = 0, bUsd = 0, sUsd = 0;
    for (const t of tab.recentTrades) {
      if (t.side === 'buy') {
        bCount++;
        bUsd += t.amountUsd;
      } else {
        sCount++;
        sUsd += t.amountUsd;
      }
    }
    tab.buysCount = bCount;
    tab.sellsCount = sCount;
    tab.buyUsd = bUsd;
    tab.sellUsd = sUsd;
    tab.netFlowUsd = bUsd - sUsd;
    const totalUsd = bUsd + sUsd;
    tab.buyRatioPercent = totalUsd > 0 ? Math.round((bUsd / totalUsd) * 1000) / 10 : 50;

    // Check Whale / Big Sell alert
    if (isBigSell) {
      this.addAlert(mint, {
        type: 'WHALE_SELL',
        level: 'DANGER',
        title: '🚨 PENJUALAN BESAR TERDETEKSI',
        detail: `Whale menjual $${trade.amountUsd.toFixed(1)} pada harga $${trade.priceUsd.toFixed(8)}!`,
        occurredAt: now,
      });
    }

    // Check Heavy Sell Pressure alert
    if (totalUsd > 100 && (bCount + sCount) >= 5) {
      const sellRatio = sUsd / totalUsd;
      if (sellRatio >= 0.70) {
        this.addAlert(mint, {
          type: 'SELL_PRESSURE',
          level: 'DANGER',
          title: '🚨 TEKANAN JUAL TINGGI',
          detail: `Volume jual mencapai ${(sellRatio * 100).toFixed(0)}% ($${sUsd.toFixed(0)} jual vs $${bUsd.toFixed(0)} beli)!`,
          occurredAt: now,
        });
      }
    }

    // Check Rapid Price Crash alert
    if (tab.drawdownPercent !== undefined && tab.drawdownPercent <= -8.0) {
      this.addAlert(mint, {
        type: 'PRICE_CRASH',
        level: 'DANGER',
        title: '🚨 HARGA ANJLOK TAJAM',
        detail: `Drawdown ${tab.drawdownPercent.toFixed(1)}% dari puncak ($${tab.peakPriceUsd?.toFixed(8)})! Segera SELL!`,
        occurredAt: now,
      });
    }
  }

  recordHolderSample(mint: string, holderCount: number, observedAt = Date.now()): void {
    const tab = this.activeTabs.get(mint);
    if (!tab) return;

    if (tab.holders !== undefined && tab.holders !== holderCount) {
      const delta = holderCount - tab.holders;
      tab.holderDelta = delta;
      if (delta < 0) {
        tab.holderDeclineStreak = (tab.holderDeclineStreak ?? 0) + 1;
      } else if (delta > 0) {
        tab.holderDeclineStreak = 0;
      }
    }

    tab.holders = holderCount;
    if (!tab.initialHolders) tab.initialHolders = holderCount;

    const history = tab.holderHistory ?? [];
    history.push({ observedAt, count: holderCount });
    tab.holderHistory = history.filter(h => observedAt - h.observedAt <= 60_000);

    // Check Holder Drop Streak Alert
    if ((tab.holderDeclineStreak ?? 0) >= 2) {
      this.addAlert(mint, {
        type: 'HOLDER_DROP',
        level: 'DANGER',
        title: '🚨 HOLDER TURUN BERTURUT-TURUT',
        detail: `Holder berkurang ${Math.abs(tab.holderDelta ?? 0)} (${tab.holderDeclineStreak}x berturut-turut)! Sinyal dump!`,
        occurredAt: observedAt,
      });
    }
  }

  addAlert(mint: string, alert: SlotAlert): void {
    const tab = this.activeTabs.get(mint);
    if (!tab) return;
    const alerts = tab.alerts ?? [];
    // Deduplicate same alert within 15 seconds
    const recentSame = alerts.find(a => a.type === alert.type && alert.occurredAt - a.occurredAt < 15_000);
    if (!recentSame) {
      alerts.unshift(alert);
      tab.alerts = alerts.slice(0, 5);
      tab.hasWarning = true;
    }
  }

  clearOldAlerts(now = Date.now()): void {
    for (const tab of this.activeTabs.values()) {
      if (!tab.alerts?.length) continue;
      tab.alerts = tab.alerts.filter(a => now - a.occurredAt <= 30_000);
      tab.hasWarning = tab.alerts.length > 0;
    }
  }

  closeTab(mint: string, closedAt = Date.now()): ClosedTabHistory | null {
    const current = this.activeTabs.get(mint);
    if (!current) return null;
    this.activeTabs.delete(mint);
    this.historyCounter++;
    const durationSeconds = Math.max(0, Math.round((closedAt - current.openedAt) / 1000));
    const historyItem: ClosedTabHistory = {
      index: this.historyCounter,
      mint: current.mint,
      symbol: current.symbol,
      name: current.name,
      imageUrl: current.imageUrl,
      url: current.url,
      openedAt: current.openedAt,
      closedAt,
      durationSeconds,
      lastPriceUsd: current.lastPriceUsd,
      holders: current.holders,
      marketCapUsd: current.marketCapUsd,
      top10Percent: current.top10Percent,
      buyRatioPercent: current.buyRatioPercent,
    };
    this.closedHistory.unshift(historyItem);
    if (this.closedHistory.length > 100) this.closedHistory.pop();
    return historyItem;
  }

  findClosed(query: string | number): ClosedTabHistory | undefined {
    if (typeof query === 'number' || /^\d+$/.test(String(query).trim())) {
      const idx = Number(query);
      return this.closedHistory.find(item => item.index === idx);
    }
    const q = String(query).trim().toLowerCase();
    return this.closedHistory.find(
      item => item.mint.toLowerCase() === q || item.symbol.toLowerCase() === q
    );
  }

  reopenTab(query: string | number, now = Date.now()): { success: boolean; item?: ClosedTabHistory; reason?: string } {
    const item = this.findClosed(query);
    if (!item) {
      return { success: false, reason: `Token "${query}" tidak ditemukan di riwayat tab yang ditutup.` };
    }
    if (this.activeTabs.has(item.mint)) {
      return { success: false, reason: `Token ${item.symbol} (${item.mint}) sudah aktif di salah satu tab.` };
    }
    if (!this.canOpen()) {
      return {
        success: false,
        reason: `Maksimum ${this.maxTabs} tab aktif sudah tercapai. Tutup salah satu tab terlebih dahulu sebelum membuka kembali ${item.symbol}.`,
      };
    }

    this.openTab(item.mint, item.symbol, item.url, item.name, now, item.lastPriceUsd, item.holders, {
      imageUrl: item.imageUrl,
      marketCapUsd: item.marketCapUsd,
      top10Percent: item.top10Percent,
      buyRatioPercent: item.buyRatioPercent,
    });
    this.closedHistory = this.closedHistory.filter(h => h.mint !== item.mint);
    return { success: true, item };
  }

  /**
   * Returns exactly `maxTabs` (default 5) slots.
   * If an active tab exists at index i, it populates that slot.
   * Otherwise, it marks the slot as empty so the dashboard always has 5 active boxes.
   */
  getFiveSlots(): SlotState[] {
    const activeList = this.getActiveTabs();
    const slots: SlotState[] = [];
    for (let i = 0; i < this.maxTabs; i++) {
      if (i < activeList.length) {
        slots.push({
          slotNumber: i + 1,
          isEmpty: false,
          tab: activeList[i],
        });
      } else {
        slots.push({
          slotNumber: i + 1,
          isEmpty: true,
        });
      }
    }
    return slots;
  }

  getStatusSummary() {
    this.clearOldAlerts();
    return {
      activeCount: this.activeTabs.size,
      maxTabs: this.maxTabs,
      availableSlots: Math.max(0, this.maxTabs - this.activeTabs.size),
      slots: this.getFiveSlots(),
      activeTabs: this.getActiveTabs(),
      closedCount: this.closedHistory.length,
      closedHistory: this.closedHistory.slice(0, 20),
    };
  }
}
