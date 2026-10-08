import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

export interface SwapRouteResult {
  status: number | null;
  latencyMs: number;
  ok: boolean;
  error?: string | null;
  routeData?: any;
  quote?: {
    inAmount: string | null;
    outAmount: string | null;
    inDecimals: number | null;
    outDecimals: number | null;
    priceImpactPct: string | number | null;
    exchange: string | null;
    amountInUsd: number | null;
    amountOutUsd: number | null;
  } | null;
  impliedPriceUsd?: number | null;
}

export const DEFAULT_SWAP_WALLET = 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Panggil GMGN Swap Route API untuk BUY token menggunakan SOL.
 * Dilakukan di dalam browser context page token GMGN.
 */
export async function getBrowserBuySwapRoute(
  page: Page,
  mint: string,
  fromAddress: string = DEFAULT_SWAP_WALLET,
  stakeUsd: number = 5.0,
  solPriceUsd: number = 145.0,
  slippage: number = 15
): Promise<SwapRouteResult> {
  if (page.isClosed()) {
    return { status: 499, latencyMs: 0, ok: false, error: 'PAGE_CLOSED' };
  }

  // Hitung lamports berdasarkan stakeUsd / solPriceUsd
  const inputLamports = Math.floor((stakeUsd / (solPriceUsd > 0 ? solPriceUsd : 145.0)) * 1_000_000_000).toString();

  try {
    return await page.evaluate(
      async ({ mint, fromAddress, inputLamports, slippage, SOL_MINT }) => {
        const params = new URLSearchParams({
          web_from_source: 'token_poll',
          token_in_chain: 'sol',
          token_out_chain: 'sol',
          from_address: fromAddress,
          token_in_address: SOL_MINT,
          token_out_address: mint,
          in_amount: inputLamports,
          slippage: String(slippage),
          is_anti_mev: 'false',
          fee: '0.0002',
          tip_fee: '0.0001',
          priority_fee: '0.0001',
          legacy: 'true',
        });
        const t0 = performance.now();
        try {
          const res = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
          const latency = Math.round(performance.now() - t0);
          const body = await res.json().catch(() => null);
          if (res.status === 200 && body?.code === 0 && body?.data?.quote) {
            const data = body.data;
            const q = data.quote;
            const outDecimals = q.outDecimals ?? 6;
            const tokens = q.outAmount ? Number(q.outAmount) / 10 ** outDecimals : 0;
            const amountInUsd = Number(data.amount_in_usd ?? 0);
            const amountOutUsd = Number(data.amount_out_usd ?? 0);
            const impliedPrice = tokens > 0 && amountInUsd > 0 ? amountInUsd / tokens : null;

            return {
              status: res.status,
              latencyMs: latency,
              ok: true,
              routeData: data,
              quote: {
                inAmount: q.inAmount ?? null,
                outAmount: q.outAmount ?? null,
                inDecimals: q.inDecimals ?? null,
                outDecimals: q.outDecimals ?? null,
                priceImpactPct: q.priceImpactPct ?? null,
                exchange: data.exchange ?? null,
                amountInUsd,
                amountOutUsd,
              },
              impliedPriceUsd: impliedPrice,
            };
          }
          return {
            status: res.status,
            latencyMs: latency,
            ok: false,
            error: body?.msg || body?.message || `HTTP_${res.status}`,
            routeData: body?.data ?? null,
          };
        } catch (e: any) {
          return {
            status: null,
            latencyMs: Math.round(performance.now() - t0),
            ok: false,
            error: e?.message || 'NETWORK_FETCH_ERROR',
          };
        }
      },
      { mint, fromAddress, inputLamports, slippage, SOL_MINT }
    );
  } catch (err: any) {
    return { status: 500, latencyMs: 0, ok: false, error: err?.message || 'EVALUATE_EXCEPTION' };
  }
}

/**
 * Panggil GMGN Swap Route API untuk SELL token ke SOL.
 * Dilakukan di dalam browser context page token GMGN.
 */
export async function getBrowserSellSwapRoute(
  page: Page,
  mint: string,
  fromAddress: string = DEFAULT_SWAP_WALLET,
  inputTokenAmountBaseUnits: string,
  tokenDecimals: number = 6,
  slippage: number = 15
): Promise<SwapRouteResult> {
  if (page.isClosed()) {
    return { status: 499, latencyMs: 0, ok: false, error: 'PAGE_CLOSED' };
  }

  try {
    return await page.evaluate(
      async ({ mint, fromAddress, inputTokenAmountBaseUnits, tokenDecimals, slippage, SOL_MINT }) => {
        const params = new URLSearchParams({
          web_from_source: 'token_poll',
          token_in_chain: 'sol',
          token_out_chain: 'sol',
          from_address: fromAddress,
          token_in_address: mint,
          token_out_address: SOL_MINT,
          in_amount: inputTokenAmountBaseUnits,
          slippage: String(slippage),
          is_anti_mev: 'false',
          fee: '0.0002',
          tip_fee: '0.0001',
          priority_fee: '0.0001',
          legacy: 'true',
        });
        const t0 = performance.now();
        try {
          const res = await fetch(`/txproxy/v1/get_swap_route?${params}`, { credentials: 'include' });
          const latency = Math.round(performance.now() - t0);
          const body = await res.json().catch(() => null);
          if (res.status === 200 && body?.code === 0 && body?.data?.quote) {
            const data = body.data;
            const q = data.quote;
            const inDecimals = q.inDecimals ?? tokenDecimals;
            const tokens = Number(inputTokenAmountBaseUnits) / 10 ** inDecimals;
            const amountInUsd = Number(data.amount_in_usd ?? 0);
            const amountOutUsd = Number(data.amount_out_usd ?? 0);
            // Nilai token per unit saat sell = amountOutUsd / tokens
            const impliedPrice = tokens > 0 && amountOutUsd > 0 ? amountOutUsd / tokens : null;

            return {
              status: res.status,
              latencyMs: latency,
              ok: true,
              routeData: data,
              quote: {
                inAmount: q.inAmount ?? null,
                outAmount: q.outAmount ?? null,
                inDecimals: q.inDecimals ?? null,
                outDecimals: q.outDecimals ?? null,
                priceImpactPct: q.priceImpactPct ?? null,
                exchange: data.exchange ?? null,
                amountInUsd,
                amountOutUsd,
              },
              impliedPriceUsd: impliedPrice,
            };
          }
          return {
            status: res.status,
            latencyMs: latency,
            ok: false,
            error: body?.msg || body?.message || `HTTP_${res.status}`,
            routeData: body?.data ?? null,
          };
        } catch (e: any) {
          return {
            status: null,
            latencyMs: Math.round(performance.now() - t0),
            ok: false,
            error: e?.message || 'NETWORK_FETCH_ERROR',
          };
        }
      },
      { mint, fromAddress, inputTokenAmountBaseUnits, tokenDecimals, slippage, SOL_MINT }
    );
  } catch (err: any) {
    return { status: 500, latencyMs: 0, ok: false, error: err?.message || 'EVALUATE_EXCEPTION' };
  }
}

export interface DualSellSwapResult {
  quote1: SwapRouteResult;
  quote2: SwapRouteResult;
  priceDeltaPct: number | null;
  avgPriceUsd: number | null;
}

/**
 * Panggil GMGN Swap Route API untuk SELL sebanyak 2 kali dengan jeda gapMs (default 1000ms).
 * Digunakan untuk memverifikasi stabilitas quote swap sebelum/saat eksekusi exit.
 */
export async function getBrowserDualSellSwapRoute(
  page: Page,
  mint: string,
  fromAddress: string = DEFAULT_SWAP_WALLET,
  inputTokenAmountBaseUnits: string,
  tokenDecimals: number = 6,
  slippage: number = 15,
  gapMs: number = 1000
): Promise<DualSellSwapResult> {
  const quote1 = await getBrowserSellSwapRoute(page, mint, fromAddress, inputTokenAmountBaseUnits, tokenDecimals, slippage);
  await delay(gapMs);
  const quote2 = await getBrowserSellSwapRoute(page, mint, fromAddress, inputTokenAmountBaseUnits, tokenDecimals, slippage);

  let priceDeltaPct: number | null = null;
  let avgPriceUsd: number | null = null;

  const p1 = quote1.impliedPriceUsd;
  const p2 = quote2.impliedPriceUsd;

  if (p1 !== null && p1 !== undefined && p2 !== null && p2 !== undefined && p1 > 0) {
    priceDeltaPct = ((p2 - p1) / p1) * 100;
    avgPriceUsd = (p1 + p2) / 2;
  } else if (p2 !== null && p2 !== undefined) {
    avgPriceUsd = p2;
  } else if (p1 !== null && p1 !== undefined) {
    avgPriceUsd = p1;
  }

  return { quote1, quote2, priceDeltaPct, avgPriceUsd };
}
