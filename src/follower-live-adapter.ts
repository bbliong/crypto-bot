import type { Page } from 'playwright';
import { readProfit4WalletBalance } from './profit4-wallet-balance.js';
import { SOL_MINT } from './browser-swap-route.js';
import type { FollowerLiveConfig } from './follower-live-store.js';

export interface SubmitOrderParams {
  side: 'BUY' | 'SELL';
  mint: string;
  wallet: string;
  amountBaseUnits: string;
  routeData: any;
  config: FollowerLiveConfig;
  solUsd: number;
  tokenPriceUsd: number;
  authorization?: string;
}

export interface SubmitOrderResult {
  ok: boolean;
  status: number;
  orderId: string | null;
  hash: string | null;
  error?: string;
}

export class FollowerLiveAdapter {
  private cachedAuth: string = '';
  private cachedWallet: string | null = null;

  constructor() {}

  /**
   * Deteksi alamat wallet aktif dan Authorization Bearer token dari sesi GMGN di browser.
   */
  public async detectWalletAndAuth(page: Page): Promise<{ wallet: string | null; auth: string | null }> {
    if (page.isClosed()) {
      return { wallet: this.cachedWallet, auth: this.cachedAuth || null };
    }

    try {
      const detected = await page.evaluate(() => {
        let auth = '';
        const storages = [window.localStorage, window.sessionStorage];
        for (const storage of storages) {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i) || '';
            if (!/(token|auth|jwt)/i.test(key)) continue;
            const value = storage.getItem(key) || '';
            if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
              auth = value.startsWith('Bearer ') ? value : 'Bearer ' + value;
              break;
            }
          }
          if (auth) break;
        }

        // Cari wallet dari userInfo atau storage
        let wallet = '';
        try {
          const uInfo = JSON.parse(window.localStorage.getItem('userInfo') || '{}');
          if (uInfo && uInfo.address && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(uInfo.address)) {
            wallet = uInfo.address;
          }
        } catch {}

        if (!wallet) {
          for (const storage of storages) {
            for (let i = 0; i < storage.length; i++) {
              const key = storage.key(i) || '';
              const val = storage.getItem(key) || '';
              if (/(user_wallet|current_wallet|account|address)/i.test(key) && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(val)) {
                wallet = val;
                break;
              }
            }
            if (wallet) break;
          }
        }

        return { auth, wallet };
      });

      if (detected.auth) this.cachedAuth = detected.auth;
      if (detected.wallet) this.cachedWallet = detected.wallet;

      return {
        wallet: this.cachedWallet,
        auth: this.cachedAuth || null,
      };
    } catch {
      return { wallet: this.cachedWallet, auth: this.cachedAuth || null };
    }
  }

  /**
   * Cek saldo SOL live dan kurs SOL/USD melalui multi-RPC Solana.
   */
  public async getWalletBalance(wallet: string): Promise<{ balanceSol: number | null; solUsd: number | null; error?: string }> {
    try {
      const res = await readProfit4WalletBalance(wallet);
      return {
        balanceSol: res.balanceSol,
        solUsd: res.solUsd,
        error: res.balanceError || res.priceError,
      };
    } catch (err: any) {
      return { balanceSol: null, solUsd: null, error: err?.message };
    }
  }

  /**
   * Kirim real swap order ke GMGN /mrtapi/v2/swap_batch_order melalui sesi Playwright.
   */
  public async submitSwapOrder(page: Page, params: SubmitOrderParams): Promise<SubmitOrderResult> {
    if (page.isClosed()) {
      return { ok: false, status: 499, orderId: null, hash: null, error: 'PAGE_CLOSED' };
    }

    const auth = params.authorization || this.cachedAuth;
    if (!auth) {
      return { ok: false, status: 401, orderId: null, hash: null, error: 'MISSING_GMGN_AUTH_SESSION' };
    }

    try {
      return await page.evaluate(
        async ({ side, mint, wallet, amountBaseUnits, routeData, config, solUsd, tokenPriceUsd, auth, SOL_MINT }) => {
          const q = routeData.quote;
          const info = q.routePlan?.[0]?.swapInfo ?? {};
          const now = Date.now();

          const input = side === 'BUY' ? SOL_MINT : mint;
          const output = side === 'BUY' ? mint : SOL_MINT;
          const slippage = side === 'BUY' ? config.buySlippagePercent : config.sellSlippagePercent;

          const payload = {
            is_auto_tip_fee: false,
            is_auto_priority_fee: false,
            max_auto_fee: String(config.priorityFeeSol + config.tipFeeSol),
            token_in_chain: 'sol',
            token_out_chain: 'sol',
            from_address: wallet,
            token_in_address: input,
            token_out_address: output,
            is_anti_mev: false,
            token_in_price: String(side === 'BUY' ? solUsd : tokenPriceUsd),
            token_out_price: String(side === 'BUY' ? tokenPriceUsd : solUsd),
            chain: 'sol',
            retry_on_submit_failed: 0,
            simulate_before_submit: false,
            input_token: input,
            output_token: output,
            source: 'swap_web',
            decimals: q.outDecimals ?? 6,
            swap_mode: 'ExactIn',
            input_amount: amountBaseUnits,
            market_cap: 0,
            priority_gas_price: String(config.priorityFeeSol),
            gas_price: String(config.priorityFeeSol),
            auto_slippage: false,
            slippage,
            fee: '0.0002',
            tip_fee: String(config.tipFeeSol),
            priority_fee: String(config.priorityFeeSol),
            tx_build_info: {
              ok: true,
              fallback: false,
              error: {
                code: '',
                message: '',
                stage: 'browser_prompt_route',
                exchange: routeData.exchange ?? '',
                pool: info.ammKey ?? '',
              },
              summary: {
                totalMs: Number(q.timeTaken ?? 0) * 1000,
                method: 'browser_prompt_route',
                entryCount: q.routePlan?.length ?? 0,
              },
              traceFields: {
                query: {
                  userId: wallet,
                  tokenIn: {
                    address: input,
                    decimals: q.inDecimals,
                    price: side === 'BUY' ? solUsd : tokenPriceUsd,
                  },
                  tokenOut: {
                    address: output,
                    decimals: q.outDecimals,
                    price: side === 'BUY' ? tokenPriceUsd : solUsd,
                  },
                  swapMode: 'ExactIn',
                  slippage,
                  mc: 0,
                  isAntiMev: false,
                  fee: 0.0002,
                  exchange: routeData.exchange ?? '',
                  pool: info.ammKey ?? '',
                  tipFee: config.tipFeeSol,
                  priorityFee: config.priorityFeeSol,
                  amountIn: amountBaseUnits,
                  legacy: true,
                },
                serverTimeMs: now,
              },
              client_click_at_ms: now,
              order_type: 'browser_prompt_submit',
              ws_status: 'Stable',
              ws_latency_ms: 0,
              ws_chain_stat_ts: now,
              ws_route_info_ts: now,
            },
          };

          const res = await fetch('/mrtapi/v2/swap_batch_order', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'content-type': 'application/json',
              authorization: auth,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
          });

          const body = await res.json().catch(() => null);
          return {
            ok: res.ok && body?.code === 0,
            status: res.status,
            orderId: body?.data?.order_id ?? null,
            hash: body?.data?.hash ?? null,
            error: body?.msg ?? body?.message ?? (res.ok ? undefined : `HTTP_${res.status}`),
          };
        },
        {
          side: params.side,
          mint: params.mint,
          wallet: params.wallet,
          amountBaseUnits: params.amountBaseUnits,
          routeData: params.routeData,
          config: params.config,
          solUsd: params.solUsd,
          tokenPriceUsd: params.tokenPriceUsd,
          auth,
          SOL_MINT,
        }
      );
    } catch (err: any) {
      return { ok: false, status: 500, orderId: null, hash: null, error: err?.message || 'SUBMIT_EXCEPTION' };
    }
  }

  /**
   * Konfirmasi status transaksi on-chain menggunakan Solana RPC getTransaction.
   */
  public async confirmOnChain(
    rpcUrl: string,
    signature: string,
    wallet: string,
    mint: string
  ): Promise<{ confirmed: boolean; tokenDelta: number; cashflowSol: number; error?: string }> {
    for (let i = 0; i < 15; i++) {
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getTransaction',
            params: [
              signature,
              { commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
            ],
          }),
          signal: AbortSignal.timeout(6000),
        });

        if (!res.ok) continue;
        const body = (await res.json()) as any;
        const tx = body?.result;

        if (tx && tx.meta) {
          if (tx.meta.err) {
            return { confirmed: false, tokenDelta: 0, cashflowSol: 0, error: 'ON_CHAIN_TX_FAILED' };
          }

          // Hitung token balance change
          const keys = (tx.transaction?.message?.accountKeys || []).map((k: any) =>
            typeof k === 'string' ? k : k.pubkey
          );
          const walletIdx = keys.indexOf(wallet);

          const preTokens = (tx.meta.preTokenBalances || [])
            .filter((r: any) => r.owner === wallet && r.mint === mint)
            .reduce((acc: number, r: any) => acc + Number(r.uiTokenAmount.uiAmount || 0), 0);

          const postTokens = (tx.meta.postTokenBalances || [])
            .filter((r: any) => r.owner === wallet && r.mint === mint)
            .reduce((acc: number, r: any) => acc + Number(r.uiTokenAmount.uiAmount || 0), 0);

          const tokenDelta = postTokens - preTokens;

          let cashflowSol = 0;
          if (walletIdx >= 0 && tx.meta.preBalances && tx.meta.postBalances) {
            cashflowSol = (tx.meta.postBalances[walletIdx] - tx.meta.preBalances[walletIdx]) / 1e9;
          }

          return { confirmed: true, tokenDelta, cashflowSol };
        }
      } catch {}

      await new Promise((r) => setTimeout(r, 1000));
    }

    return { confirmed: false, tokenDelta: 0, cashflowSol: 0, error: 'CONFIRMATION_TIMEOUT' };
  }
}
