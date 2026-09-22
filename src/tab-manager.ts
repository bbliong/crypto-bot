export interface ActiveTabInfo {
  mint: string;
  symbol: string;
  name?: string;
  url: string;
  openedAt: number;
  lastPriceUsd?: number;
  holders?: number;
  buys?: number;
  sells?: number;
}

export interface ClosedTabHistory {
  index: number;
  mint: string;
  symbol: string;
  name?: string;
  url: string;
  openedAt: number;
  closedAt: number;
  durationSeconds: number;
  lastPriceUsd?: number;
  holders?: number;
}

export class TabManager {
  private activeTabs = new Map<string, ActiveTabInfo>();
  private closedHistory: ClosedTabHistory[] = [];
  private historyCounter = 0;

  constructor(public readonly maxTabs = 5) {
    if (!Number.isInteger(maxTabs) || maxTabs < 1) {
      throw new Error('maxTabs must be a positive integer');
    }
  }

  canOpen(): boolean {
    return this.activeTabs.size < this.maxTabs;
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
    holders?: number
  ): boolean {
    if (this.activeTabs.has(mint)) return false;
    if (this.activeTabs.size >= this.maxTabs) return false;
    this.activeTabs.set(mint, {
      mint,
      symbol,
      name,
      url,
      openedAt,
      lastPriceUsd: initialPrice,
      holders,
      buys: 0,
      sells: 0,
    });
    return true;
  }

  updateTab(mint: string, updates: Partial<ActiveTabInfo>): void {
    const current = this.activeTabs.get(mint);
    if (!current) return;
    Object.assign(current, updates);
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
      url: current.url,
      openedAt: current.openedAt,
      closedAt,
      durationSeconds,
      lastPriceUsd: current.lastPriceUsd,
      holders: current.holders,
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

    this.openTab(item.mint, item.symbol, item.url, item.name, now, item.lastPriceUsd, item.holders);
    this.closedHistory = this.closedHistory.filter(h => h.mint !== item.mint);
    return { success: true, item };
  }

  getStatusSummary() {
    return {
      activeCount: this.activeTabs.size,
      maxTabs: this.maxTabs,
      availableSlots: Math.max(0, this.maxTabs - this.activeTabs.size),
      activeTabs: this.getActiveTabs(),
      closedCount: this.closedHistory.length,
      closedHistory: this.closedHistory.slice(0, 20),
    };
  }
}
