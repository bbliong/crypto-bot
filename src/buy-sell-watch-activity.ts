import { validMint } from './parser.js';

export const defaultBuySellWallets = [
  '5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT',
  '3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD',
  '2dVDVvzH4D3ihpUTbiG9yNSEsQBs8iFNRifcZP6TLqVK',
];

export type WalletBuy = {
  wallet: string; mint: string; symbol?: string; timestamp: number;
  priceUsd?: number; amount?: string; tx?: string;
};

export function walkActivity(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) value.forEach(item => walkActivity(item, out));
  else if (value && typeof value === 'object') {
    out.push(value as Record<string, unknown>);
    Object.values(value).forEach(item => walkActivity(item, out));
  }
  return out;
}

export function activityFields(row: Record<string, unknown>) {
  const token = row.token as Record<string, unknown> | undefined;
  const rawSide = String(row.event_type ?? row.e ?? '').toLowerCase();
  const side = rawSide === 'swap_buy' ? 'buy' : rawSide === 'swap_sell' ? 'sell' : rawSide;
  return {
    side, mint: String(token?.address ?? row.token_address ?? row.a ?? ''),
    timestamp: Number(row.timestamp ?? row.t) || 0, token,
  };
}

export function walletBuys(body: unknown, wallet: string): WalletBuy[] {
  return walkActivity(body).flatMap(row => {
    const f = activityFields(row);
    if (f.side !== 'buy' || !validMint(f.mint) || !Number.isFinite(f.timestamp) || f.timestamp <= 0) return [];
    const priceUsd = Number(row.price_usd ?? row.pu);
    return [{ wallet, mint: f.mint, timestamp: f.timestamp, symbol: String(f.token?.symbol ?? ''),
      priceUsd: Number.isFinite(priceUsd) ? priceUsd : undefined,
      amount: String(row.token_amount ?? row.ba ?? ''), tx: String(row.tx_hash ?? row.h ?? '') }];
  }).sort((a, b) => b.timestamp - a.timestamp);
}

export function buyKey(buy: WalletBuy): string {
  return `${buy.wallet}:${buy.mint}:${buy.tx || buy.timestamp}`;
}

export function sellAfterBuy(body: unknown, buy: WalletBuy): Record<string, unknown> | undefined {
  return walkActivity(body).filter(row => {
    const f = activityFields(row);
    return f.side === 'sell' && f.mint === buy.mint && f.timestamp > buy.timestamp;
  }).sort((a, b) => activityFields(a).timestamp - activityFields(b).timestamp)[0];
}

// Use only the first row of GMGN's unfiltered, newest-first wallet feed.
// Never search older buys when the top activity is a sell/transfer/invalid row.
export function latestActivityBuy(body: unknown, wallet: string): WalletBuy | undefined {
  const activities = (body as { data?: { activities?: unknown[] } } | null)?.data?.activities;
  if (!Array.isArray(activities) || !activities.length) return;
  return walletBuys({ data: { activities: [activities[0]] } }, wallet)[0];
}

export function detailWalletSell(body: unknown, buy: WalletBuy): Record<string, unknown> | undefined {
  const packet = body as { channel?: string; data?: unknown[] } | null;
  if (!packet || !['token_activity', 'token_activity_info_all'].includes(packet.channel ?? '') || !Array.isArray(packet.data)) return;
  return packet.data.find((value): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>, f = activityFields(row);
    const actor = [row.m, row.wallet, row.ad].find(validMint);
    return row.n === 'sol' && f.side === 'sell' && f.mint === buy.mint && actor === buy.wallet
      && Number.isFinite(f.timestamp) && f.timestamp >= buy.timestamp
      && !(buy.tx && String(row.h ?? row.tx_hash ?? '') === buy.tx);
  });
}
