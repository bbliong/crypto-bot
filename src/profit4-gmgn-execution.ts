import type { BrowserContext, Page } from "playwright";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeFrame } from "./parser.js";
import { SOL_MINT } from "./browser-swap-route.js";
import { readProfit4WalletBalance } from "./profit4-wallet-balance.js";
import type {
  LiveConfig,
  LiveOrder,
  LiveReadiness,
} from "./profit4-live-store.js";

export type ExecutionFill = {
  hash: string;
  failed: boolean;
  tokenDelta: string;
  decimals: number;
  cashflowSol: number;
  networkFeeSol: number;
  confirmedAt: number;
};
export interface LiveAdapter {
  readiness(): Promise<LiveReadiness>;
  balance(
    wallet: string,
    mint: string,
  ): Promise<{ amount: string; decimals: number }>;
  prepare(id: string, mint: string, wallet: string): Promise<void>;
  quote(
    id: string,
    side: "BUY" | "SELL",
    amount: string,
    config: LiveConfig,
  ): Promise<any>;
  submit(
    id: string,
    side: "BUY" | "SELL",
    amount: string,
    quote: any,
    config: LiveConfig,
    solUsd: number,
    tokenPrice: number,
  ): Promise<{
    ok: boolean;
    status: number;
    orderId: string | null;
    hash: string | null;
    error?: string;
  }>;
  confirm(
    wallet: string,
    mint: string,
    order: LiveOrder,
  ): Promise<ExecutionFill | null>;
  release(id: string): Promise<void>;
  restoreMonitor(id: string, mint: string, wallet: string): Promise<void>;
}
export function parseExecutionFill(
  tx: any,
  wallet: string,
  mint: string,
  hash: string,
): ExecutionFill | null {
  if (!tx?.meta || !tx?.transaction?.message?.accountKeys) return null;
  const keys = tx.transaction.message.accountKeys.map((k: any) =>
    typeof k === "string" ? k : k.pubkey,
  );
  const index = keys.indexOf(wallet);
  if (index < 0) return null;
  const amounts = (rows: any[], tokenMint = mint) =>
    rows.filter((r) => r.owner === wallet && r.mint === tokenMint);
  const before = amounts(tx.meta.preTokenBalances ?? []),
    after = amounts(tx.meta.postTokenBalances ?? []);
  if (!before.length && !after.length && !tx.meta.err) return null;
  const total = (rows: any[]) =>
    rows.reduce((n: bigint, r: any) => n + BigInt(r.uiTokenAmount.amount), 0n);
  return {
    hash,
    failed: Boolean(tx.meta.err),
    tokenDelta: String(total(after) - total(before)),
    decimals: (after[0] ?? before[0])?.uiTokenAmount?.decimals ?? 0,
    cashflowSol:
      (tx.meta.postBalances[index] - tx.meta.preBalances[index]) / 1e9 +
      Number(
        total(amounts(tx.meta.postTokenBalances ?? [], SOL_MINT)) -
          total(amounts(tx.meta.preTokenBalances ?? [], SOL_MINT)),
      ) /
        1e9,
    networkFeeSol: tx.meta.fee / 1e9,
    confirmedAt: tx.blockTime ? tx.blockTime * 1000 : Date.now(),
  };
}
export class GmgnLiveAdapter implements LiveAdapter {
  private authorization = "";
  private wallet: string | null = null;
  private walletStatUrl: string | null = null;
  private pages = new Map<
    string,
    { page: Page; mint: string; wallet: string }
  >();
  private orderHashes = new Map<string, string>();
  private monitorHook?: (mint: string, body: unknown, at: number) => void;
  constructor(
    private context: BrowserContext,
    private controller: Page,
  ) {
    context.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "gmgn.ai") return;
      const auth = request.headers().authorization;
      if (auth) this.authorization = auth;
      const match = url.pathname.match(
        /\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
      );
      if (match) {
        this.wallet = match[1]!;
        this.walletStatUrl = url.pathname + url.search;
      }
      if (
        url.pathname === "/mrtapi/v2/swap_batch_order" &&
        request.method() === "POST"
      ) {
        try {
          const data = request.postDataJSON();
          if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data?.from_address))
            this.wallet = data.from_address;
        } catch {}
      }
    });
    context.on("response", async (response) => {
      if (
        new URL(response.url()).hostname !== "gmgn.ai" ||
        !/order|transaction|swap/.test(response.url())
      )
        return;
      try {
        const walk = (v: any) => {
          if (!v || typeof v !== "object") return;
          const id = v.order_id ?? v.orderId,
            hash = v.hash ?? v.tx_hash ?? v.signature;
          if (
            id &&
            typeof hash === "string" &&
            /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(hash)
          )
            this.orderHashes.set(String(id), hash);
          Object.values(v).forEach(walk);
        };
        walk(await response.json());
      } catch {}
    });
  }
  setMonitorHook(hook: (mint: string, body: unknown, at: number) => void) {
    this.monitorHook = hook;
  }
  private async rpc(method: string, params: unknown[]) {
    const r = await fetch(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(8000),
      },
    );
    const data = (await r.json()) as any;
    if (!r.ok || data.error) throw Error(`RPC ${method} gagal`);
    return data.result;
  }
  private async recoverAuthorization() {
    if (this.authorization) return;
    const token = await this.controller
      .evaluate(() => {
        const storages = [window.localStorage, window.sessionStorage];
        for (const storage of storages) {
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i) || "";
            if (!/(token|auth)/i.test(key)) continue;
            const value = storage.getItem(key) || "";
            if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))
              return value.startsWith("Bearer ") ? value : "Bearer " + value;
          }
        }
        return "";
      })
      .catch(() => "");
    if (token) this.authorization = token;
  }
  private selectedWallet() {
    return (
      process.env.PROFIT4_EXECUTION_WALLET ||
      this.wallet ||
      this.researchWallet()
    );
  }
  private researchWallet() {
    try {
      const researchDir = join(process.cwd(), "research");
      if (existsSync(researchDir)) {
        const runs = readdirSync(researchDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name));
        for (const run of runs.slice(0, 5)) {
          const auditFile = join(
            researchDir,
            run.name,
            "order-api-audit.jsonl",
          );
          if (!existsSync(auditFile)) continue;
          const match = readFileSync(auditFile, "utf8").match(
            /\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/,
          );
          if (match?.[1]) return match[1];
        }
      }
    } catch {
      // Use the same fallback as the Research dashboard when no recent
      // walletstat request has been captured yet.
    }
    return "F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6";
  }
  async readiness(): Promise<LiveReadiness> {
    const wallet = this.selectedWallet() || null;
    const result: LiveReadiness = {
      sessionReady: false,
      wallet,
      balanceSol: null,
      solUsd: null,
      observedAt: Date.now(),
    };
    try {
      if (wallet) Object.assign(result, await readProfit4WalletBalance(wallet));
      await this.recoverAuthorization();
      if (!wallet)
        throw Error(
          "Wallet GMGN belum terdeteksi. Worker membaca alamat dari request walletstat, seperti Research.",
        );
      if (!this.authorization)
        throw Error(
          "Wallet dipilih, tetapi token sesi GMGN belum terdeteksi. Pastikan login aktif pada Chrome worker.",
        );
      if (
        process.env.PROFIT4_EXECUTION_WALLET &&
        wallet !== process.env.PROFIT4_EXECUTION_WALLET
      )
        throw Error(
          "Wallet GMGN berbeda dari wallet eksekusi yang dikonfigurasi.",
        );
      const sessionValid = await this.controller.evaluate(
        async ({ path, auth }) => {
          const r = await fetch(path, {
            credentials: "include",
            headers: { authorization: auth },
            signal: AbortSignal.timeout(8000),
          });
          const body = await r.json();
          return r.ok && body.code === 0;
        },
        {
          path:
            this.walletStatUrl ||
            `/defi/quotation/v1/smartmoney/sol/walletstat/${wallet}`,
          auth: this.authorization,
        },
      );
      if (!sessionValid)
        throw Error("Sesi GMGN tidak valid. Login ulang pada Chrome worker.");
      if (result.balanceSol == null) throw Error(result.balanceError || "Saldo SOL belum tersedia.");
      if (result.solUsd == null || !(result.solUsd > 0)) throw Error(result.priceError || "Harga SOL tidak tersedia.");
      result.sessionReady = true;
    } catch (e) {
      result.error = e instanceof Error ? e.message : "Sesi tidak siap";
    }
    return result;
  }
  async balance(wallet: string, mint: string) {
    const data = await this.rpc("getTokenAccountsByOwner", [
      wallet,
      { mint },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    const accounts = data.value as any[];
    let amount = 0n,
      decimals = 0;
    for (const account of accounts) {
      const token = account.account.data.parsed.info.tokenAmount;
      amount += BigInt(token.amount);
      decimals = token.decimals;
    }
    return { amount: String(amount), decimals };
  }
  async prepare(id: string, mint: string, wallet: string) {
    const existing = this.pages.get(id);
    if (existing && !existing.page.isClosed()) return;
    const page = await this.context.newPage();
    this.pages.set(id, { page, mint, wallet });
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        try {
          const body = decodeFrame(payload);
          this.monitorHook?.(mint, body, Date.now());
        } catch {}
      }),
    );
    try {
      await page.goto(`https://gmgn.ai/sol/token/${mint}`, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
    } catch (e) {
      this.pages.delete(id);
      await page.close().catch(() => {});
      throw e;
    }
  }
  async restoreMonitor(id: string, mint: string, wallet: string) {
    await this.prepare(id, mint, wallet);
  }
  private item(id: string) {
    const item = this.pages.get(id);
    if (!item || item.page.isClosed())
      throw Error("Tab eksekusi tidak tersedia.");
    return item;
  }
  async quote(
    id: string,
    side: "BUY" | "SELL",
    amount: string,
    config: LiveConfig,
  ) {
    const { page, mint, wallet } = this.item(id);
    return page.evaluate(
      async ({ mint, wallet, side, amount, c, sol }) => {
        const params = new URLSearchParams({
          web_from_source: "token_poll",
          token_in_chain: "sol",
          token_out_chain: "sol",
          from_address: wallet,
          token_in_address: side === "BUY" ? sol : mint,
          token_out_address: side === "BUY" ? mint : sol,
          in_amount: amount,
          slippage: String(
            side === "BUY" ? c.buySlippagePercent : c.sellSlippagePercent,
          ),
          is_anti_mev: String(c.antiMev),
          fee: "0.0002",
          tip_fee: String(c.tipFeeSol),
          priority_fee: String(c.priorityFeeSol),
          legacy: "true",
        });
        const r = await fetch(`/txproxy/v1/get_swap_route?${params}`, {
          credentials: "include",
          signal: AbortSignal.timeout(8000),
        });
        const body = await r.json();
        if (!r.ok || body.code !== 0 || !body.data?.quote)
          throw Error(`Quote ditolak: HTTP ${r.status}, code ${body.code}`);
        return body.data;
      },
      { mint, wallet, side, amount, c: config, sol: SOL_MINT },
    );
  }
  async submit(
    id: string,
    side: "BUY" | "SELL",
    amount: string,
    route: any,
    config: LiveConfig,
    solUsd: number,
    tokenPrice: number,
  ) {
    const { page, mint, wallet } = this.item(id);
    if (wallet !== this.selectedWallet() || !this.authorization)
      throw Error("Sesi atau wallet GMGN berubah.");
    const auth = this.authorization;
    return page.evaluate(
      async ({
        mint,
        wallet,
        side,
        amount,
        route,
        c,
        solUsd,
        tokenPrice,
        auth,
        sol,
      }) => {
        const q = route.quote,
          info = q.routePlan?.[0]?.swapInfo ?? {},
          now = Date.now();
        const input = side === "BUY" ? sol : mint,
          output = side === "BUY" ? mint : sol,
          slippage =
            side === "BUY" ? c.buySlippagePercent : c.sellSlippagePercent;
        const payload = {
          is_auto_tip_fee: false,
          is_auto_priority_fee: false,
          max_auto_fee: String(c.priorityFeeSol + c.tipFeeSol),
          token_in_chain: "sol",
          token_out_chain: "sol",
          from_address: wallet,
          token_in_address: input,
          token_out_address: output,
          is_anti_mev: c.antiMev,
          token_in_price: String(side === "BUY" ? solUsd : tokenPrice),
          token_out_price: String(side === "BUY" ? tokenPrice : solUsd),
          chain: "sol",
          retry_on_submit_failed: 0,
          simulate_before_submit: false,
          input_token: input,
          output_token: output,
          source: "swap_web",
          decimals: q.outDecimals,
          swap_mode: "ExactIn",
          input_amount: amount,
          market_cap: 0,
          priority_gas_price: String(c.priorityFeeSol),
          gas_price: String(c.priorityFeeSol),
          auto_slippage: false,
          slippage,
          fee: "0.0002",
          tip_fee: String(c.tipFeeSol),
          priority_fee: String(c.priorityFeeSol),
          tx_build_info: {
            ok: true,
            fallback: false,
            error: {
              code: "",
              message: "",
              stage: "browser_prompt_route",
              exchange: route.exchange ?? "",
              pool: info.ammKey ?? "",
            },
            summary: {
              totalMs: Number(q.timeTaken ?? 0) * 1000,
              method: "browser_prompt_route",
              entryCount: q.routePlan?.length ?? 0,
            },
            traceFields: {
              query: {
                userId: wallet,
                tokenIn: {
                  address: input,
                  decimals: q.inDecimals,
                  price: side === "BUY" ? solUsd : tokenPrice,
                },
                tokenOut: {
                  address: output,
                  decimals: q.outDecimals,
                  price: side === "BUY" ? tokenPrice : solUsd,
                },
                swapMode: "ExactIn",
                slippage,
                mc: 0,
                isAntiMev: c.antiMev,
                fee: 0.0002,
                exchange: route.exchange ?? "",
                pool: info.ammKey ?? "",
                tipFee: c.tipFeeSol,
                priorityFee: c.priorityFeeSol,
                amountIn: amount,
                legacy: true,
              },
              serverTimeMs: now,
            },
            client_click_at_ms: now,
            order_type: "browser_prompt_submit",
            ws_status: "Stable",
            ws_latency_ms: 0,
            ws_chain_stat_ts: now,
            ws_route_info_ts: now,
          },
        };
        const r = await fetch("/mrtapi/v2/swap_batch_order", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json", authorization: auth },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15000),
        });
        const body = await r.json().catch(() => null);
        // A server/network error can occur after the server accepted the order.
        if (r.status >= 500 || (r.ok && !body))
          throw Error("Hasil submit belum diketahui.");
        return {
          ok: r.ok && body?.code === 0,
          status: r.status,
          orderId: body?.data?.order_id ?? null,
          hash: body?.data?.hash ?? null,
          error: body?.msg ?? body?.message ?? undefined,
        };
      },
      {
        mint,
        wallet,
        side,
        amount,
        route,
        c: config,
        solUsd,
        tokenPrice,
        auth,
        sol: SOL_MINT,
      },
    );
  }
  async confirm(
    wallet: string,
    mint: string,
    order: LiveOrder,
  ): Promise<ExecutionFill | null> {
    const hash =
      order.hash ||
      (order.orderId ? this.orderHashes.get(order.orderId) : null);
    if (!hash) return null;
    order.hash = hash;
    const statuses = await this.rpc("getSignatureStatuses", [
      [hash],
      { searchTransactionHistory: true },
    ]);
    const status = statuses.value?.[0];
    if (
      !status ||
      !["confirmed", "finalized"].includes(status.confirmationStatus)
    )
      return null;
    const tx = await this.rpc("getTransaction", [
      hash,
      {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 1,
      },
    ]);
    return parseExecutionFill(tx, wallet, mint, hash);
  }
  async release(id: string) {
    const item = this.pages.get(id);
    this.pages.delete(id);
    await item?.page.close().catch(() => {});
  }
}
