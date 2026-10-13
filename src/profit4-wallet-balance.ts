export type Profit4WalletBalance = {
  balanceSol: number | null;
  solUsd: number | null;
  balanceObservedAt: number;
  balanceError?: string;
  priceError?: string;
};

const cache = new Map<string, { value: Profit4WalletBalance; expiresAt: number }>();
const pending = new Map<string, Promise<Profit4WalletBalance>>();

async function solBalance(wallet: string): Promise<number> {
  const endpoints = [...new Set([
    process.env.SOLANA_RPC_URL,
    "https://api.mainnet-beta.solana.com",
    "https://solana-mainnet.g.alchemy.com/v2/demo",
    "https://rpc.ankr.com/solana",
  ].filter((endpoint): endpoint is string => Boolean(endpoint)))];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet, { commitment: "confirmed" }] }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) continue;
      const body = await response.json() as { result?: { value?: number }; error?: unknown };
      if (!body.error && Number.isSafeInteger(body.result?.value) && body.result!.value! >= 0)
        return body.result!.value! / 1e9;
    } catch { /* Try the next RPC, as the Research dashboard does. */ }
  }
  throw Error("Saldo SOL belum dapat dibaca dari RPC. Akan dicoba kembali.");
}

async function solPrice(): Promise<number> {
  for (const endpoint of [
    "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT",
    "https://api.coinbase.com/v2/prices/SOL-USD/spot",
  ]) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const body = await response.json() as { price?: string; data?: { amount?: string } };
      const price = Number(body.price ?? body.data?.amount);
      if (Number.isFinite(price) && price > 0) return price;
    } catch { /* Fetch prices on the server so browser CORS cannot block them. */ }
  }
  throw Error("Harga SOL belum tersedia.");
}

export function readProfit4WalletBalance(wallet: string): Promise<Profit4WalletBalance> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet))
    return Promise.reject(Error("Alamat wallet tidak valid."));
  const cached = cache.get(wallet);
  if (cached && Date.now() < cached.expiresAt) return Promise.resolve(cached.value);
  const running = pending.get(wallet);
  if (running) return running;
  const request = (async () => {
    const [balance, price] = await Promise.allSettled([solBalance(wallet), solPrice()]);
    const value: Profit4WalletBalance = {
      balanceSol: balance.status === "fulfilled" ? balance.value : null,
      solUsd: price.status === "fulfilled" ? price.value : null,
      balanceObservedAt: Date.now(),
      ...(balance.status === "rejected" ? { balanceError: balance.reason.message } : {}),
      ...(price.status === "rejected" ? { priceError: price.reason.message } : {}),
    };
    cache.set(wallet, { value, expiresAt: Date.now() + (value.balanceError || value.priceError ? 5000 : 15000) });
    return value;
  })().finally(() => pending.delete(wallet));
  pending.set(wallet, request);
  return request;
}
