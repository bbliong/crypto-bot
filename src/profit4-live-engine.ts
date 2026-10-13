import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { DistributionProfit4Lane } from "./distribution-profit4-lane.js";
import {
  DistributionBounceLane,
  DistributionBounceLaneV2,
  DistributionBounceLaneV3,
  DistributionBounceLaneV4,
  DistributionBounceLaneV5,
} from "./distribution-bounce-lane.js";
import {
  TargetObservation,
  type DistributionTargetLane,
} from "./distribution-target-lane.js";
import {
  auditLive,
  atomicJson,
  buysCompleted,
  LIVE_ACTIVE,
  readJson,
  readLiveConfig,
  readLiveState,
  saveLiveConfig,
  type LiveConfig,
  type LiveLane,
  type LivePosition,
  type LiveOrder,
  type LiveState,
} from "./profit4-live-store.js";
import type { LiveAdapter } from "./profit4-gmgn-execution.js";

export type LiveSignal = {
  type: string;
  mint: string;
  laneLabel: LiveLane;
  observedAt: number;
  reason?: string;
  priceUsd?: number;
  entryPrice?: number;
  transfer?: { symbol?: string };
  rules?: Record<string, any>;
};
export class Profit4LiveEngine {
  readonly state: LiveState;
  private working = false;
  private monitors = new Map<
    string,
    { observation: TargetObservation; lane: DistributionTargetLane }
  >();
  constructor(
    readonly dir: string,
    readonly run: string,
    private adapter: LiveAdapter,
    readonly lanes: LiveLane[],
  ) {
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "real-commands"), { recursive: true });
    this.state = readLiveState(dir);
    saveLiveConfig(dir, { enabled: false });
    this.state.readiness = {
      sessionReady: false,
      wallet: null,
      balanceSol: null,
      solUsd: null,
      observedAt: 0,
      workerPid: process.pid,
      activeLanes: lanes,
    };
    for (const p of this.state.positions) {
      const order = this.pendingOrder(p);
      if (
        order &&
        ["SUBMITTING", "SUBMITTED", "UNKNOWN"].includes(order.status)
      ) {
        order.status = "UNKNOWN";
        p.status = "UNKNOWN";
      }
      if (order?.status === "INTENT" && order.side === "BUY") {
        order.status = "FAILED";
        p.status = "FAILED";
        p.lastError = "Entry dibatalkan saat restart.";
      }
    }
    auditLive(dir, this.state, null, "WORKER_RECOVERED", {
      run,
      positions: this.state.positions.filter((p) => LIVE_ACTIVE.has(p.status))
        .length,
    });
  }
  private pendingOrder(p: LivePosition) {
    return [...p.buys, ...p.sells]
      .filter((o) => !["CONFIRMED", "FAILED"].includes(o.status))
      .at(-1);
  }
  private completed() {
    return buysCompleted(this.state, readLiveConfig(this.dir));
  }
  handleSignal(signal: LiveSignal) {
    if (signal.type === "PAPER_EXIT_SIGNAL" || signal.type === "PAPER_SELL") {
      const p = this.state.positions.find(
        (p) =>
          p.run === basename(this.run) &&
          p.mint === signal.mint &&
          p.lane === signal.laneLabel &&
          LIVE_ACTIVE.has(p.status),
      );
      if (p && !p.exitWanted) {
        p.exitWanted = signal.reason || "LANE_EXIT";
        auditLive(this.dir, this.state, p, "EXIT_SIGNAL", signal);
      }
      return;
    }
    if (signal.type !== "PAPER_BUY") return;
    const c = readLiveConfig(this.dir),
      r = this.state.readiness;
    if (
      !c.enabled ||
      c.activeLane !== signal.laneLabel ||
      !this.lanes.includes(signal.laneLabel)
    )
      return;
    const id = createHash("sha256")
      .update(
        `${basename(this.run)}:${signal.mint}:${signal.laneLabel}:${signal.observedAt}`,
      )
      .digest("hex");
    if (
      this.state.positions.some(
        (p) =>
          p.id === id ||
          (p.mint === signal.mint &&
            p.wallet === r.wallet &&
            (p.buyConfirmedAt != null || LIVE_ACTIVE.has(p.status))),
      )
    )
      return;
    const active = this.state.positions.filter((p) =>
      LIVE_ACTIVE.has(p.status),
    );
    const pendingBuys = active.filter((p) => p.buyConfirmedAt == null).length;
    if (
      !r.sessionReady ||
      !r.wallet ||
      Date.now() - r.observedAt > 15000 ||
      active.some((p) => p.status === "UNKNOWN") ||
      active.length >= c.maxActiveRealPositions ||
      (c.maxBuys > 0 && this.completed() + pendingBuys >= c.maxBuys)
    ) {
      auditLive(this.dir, this.state, null, "BUY_SIGNAL_BLOCKED", {
        signal,
        reason: "Sesi, kuota atau kapasitas belum tersedia",
      });
      return;
    }
    const p: LivePosition = {
      id,
      signalId: id,
      run: basename(this.run),
      mint: signal.mint,
      symbol: signal.transfer?.symbol || signal.mint.slice(0, 8),
      lane: signal.laneLabel,
      wallet: r.wallet,
      status: "BUY_PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      rules: signal.rules || {},
      paperEntryPrice: signal.priceUsd || signal.entryPrice || 0,
      acquiredAmount: "0",
      remainingAmount: "0",
      decimals: 0,
      buys: [],
      sells: [],
      audit: [],
      cashflowComplete: true,
      pnlSol: null,
      pnlUsd: null,
    };
    this.state.positions.push(p);
    auditLive(this.dir, this.state, p, "BUY_INTENT", { signal, settings: c });
  }
  private configAllows(p: LivePosition, c: LiveConfig) {
    return (
      c.enabled &&
      c.activeLane === p.lane &&
      this.lanes.includes(p.lane) &&
      this.state.readiness.sessionReady &&
      this.state.readiness.wallet === p.wallet &&
      this.state.positions.filter((p) => LIVE_ACTIVE.has(p.status)).length <=
        c.maxActiveRealPositions &&
      (c.maxBuys === 0 ||
        this.completed() +
          this.state.positions.filter(
            (p) => LIVE_ACTIVE.has(p.status) && p.buyConfirmedAt == null,
          ).length <=
          c.maxBuys)
    );
  }
  private async buy(p: LivePosition) {
    let order: LiveOrder | undefined;
    try {
      let c = readLiveConfig(this.dir);
      const initialSettings = c.updatedAt;
      if (!this.configAllows(p, c))
        throw Error("Entry dibatalkan: konfigurasi atau sesi berubah.");
      const ready = await this.adapter.readiness();
      this.state.readiness = {
        ...ready,
        workerPid: process.pid,
        activeLanes: this.lanes,
      };
      if (
        !ready.sessionReady ||
        ready.wallet !== p.wallet ||
        !ready.solUsd ||
        ready.balanceSol == null
      )
        throw Error(ready.error || "Sesi tidak siap.");
      const balance = await this.adapter.balance(p.wallet, p.mint);
      if (BigInt(balance.amount) !== 0n)
        throw Error("Wallet sudah memiliki token ini.");
      const sol =
        c.stakeMode === "sol" ? c.stakeSol : c.stakeUsd / ready.solUsd;
      const amount = String(Math.floor(sol * 1e9));
      if (BigInt(amount) <= 0n) throw Error("Modal terlalu kecil.");
      if (
        ready.balanceSol <
        sol + c.minSolReserve + 2 * (c.priorityFeeSol + c.tipFeeSol) + 0.005
      )
        throw Error("Saldo SOL tidak cukup untuk modal, fee dan reserve.");
      await this.adapter.prepare(p.id, p.mint, p.wallet);
      const quote = await this.adapter.quote(p.id, "BUY", amount, c);
      auditLive(this.dir, this.state, p, "BUY_QUOTE", {
        quote: quote.quote,
        amountInUsd: quote.amount_in_usd,
        amountOutUsd: quote.amount_out_usd,
      });
      c = readLiveConfig(this.dir);
      if (
        c.updatedAt !== initialSettings ||
        !this.configAllows(p, c) ||
        p.exitWanted
      )
        throw Error("Entry dibatalkan sebelum submit.");
      // Settings that changed during preparation need a new quote.
      const fresh = await this.adapter.quote(p.id, "BUY", amount, c);
      const latest = readLiveConfig(this.dir);
      if (!this.configAllows(p, latest) || latest.updatedAt !== c.updatedAt)
        throw Error("Pengaturan berubah saat quote. Tunggu sinyal berikutnya.");
      order = {
        side: "BUY",
        submittedAt: Date.now(),
        status: "SUBMITTING",
        amount,
        solUsd: ready.solUsd,
      };
      p.buys.push(order);
      auditLive(this.dir, this.state, p, "BUY_SUBMITTING", { order });
      const result = await this.adapter.submit(
        p.id,
        "BUY",
        amount,
        fresh,
        c,
        ready.solUsd,
        p.paperEntryPrice,
      );
      Object.assign(order, {
        orderId: result.orderId,
        hash: result.hash,
        httpStatus: result.status,
        error: result.error,
        status: result.ok ? "SUBMITTED" : "FAILED",
      });
      if (!result.ok) {
        p.status = "FAILED";
        p.lastError = result.error || "Order BUY ditolak.";
      }
      auditLive(
        this.dir,
        this.state,
        p,
        result.ok ? "BUY_SUBMITTED" : "BUY_FAILED",
        result,
      );
      if (!result.ok) await this.adapter.release(p.id);
    } catch (e) {
      p.lastError = e instanceof Error ? e.message : "BUY_ERROR";
      p.status = order ? "UNKNOWN" : "FAILED";
      if (order) order.status = "UNKNOWN";
      auditLive(
        this.dir,
        this.state,
        p,
        order ? "BUY_UNKNOWN" : "BUY_BLOCKED",
        { error: p.lastError },
      );
      if (!order) await this.adapter.release(p.id);
    }
  }
  private monitor(p: LivePosition) {
    let m = this.monitors.get(p.id);
    if (m) return m;
    const emit = (e: any) => {
      if (e.type === "PAPER_EXIT_SIGNAL" && !p.exitWanted) {
        p.exitWanted = e.reason || "RECOVERED_LANE_EXIT";
        auditLive(this.dir, this.state, p, "LIVE_MONITOR_EXIT", e);
      }
    };
    const factory = {
      P4: DistributionProfit4Lane,
      V1: DistributionBounceLane,
      V2: DistributionBounceLaneV2,
      V3: DistributionBounceLaneV3,
      V4: DistributionBounceLaneV4,
      V5: DistributionBounceLaneV5,
    }[p.lane];
    if (!factory) throw new Error(`Unknown lane: ${p.lane}`);
    const lane = new factory(p.mint, emit);
    lane.phase = "OPEN";
    lane.entryAt = p.createdAt;
    lane.entryPrice = p.paperEntryPrice;
    const saved = (p as any).riskState;
    if (saved) Object.assign(lane, saved);
    if (Object.keys(p.rules).length)
      (lane as any).rules = Object.freeze({ ...p.rules });
    m = { observation: new TargetObservation(p.createdAt), lane };
    this.monitors.set(p.id, m);
    return m;
  }
  monitorFrame(mint: string, body: any, at: number) {
    for (const p of this.state.positions.filter(
      (p) =>
        p.mint === mint &&
        LIVE_ACTIVE.has(p.status) &&
        p.buyConfirmedAt != null,
    )) {
      const m = this.monitor(p);
      const walk = (v: any): any[] =>
        v && typeof v === "object"
          ? [v, ...Object.values(v).flatMap(walk)]
          : [];
      for (const row of walk(body)) {
        const token =
          row.token_address ?? row.ta ?? row.a ?? row.token?.address;
        const side = String(row.event_type ?? row.e ?? "").toLowerCase();
        const price = Number(row.pu ?? row.price_usd);
        if (token === mint && ["buy", "sell"].includes(side) && price > 0) {
          const timestamp = Number(row.timestamp ?? row.t);
          if (timestamp)
            m.observation.trade({
              at,
              timestamp,
              price,
              side,
              wallet: String(row.m ?? row.wallet ?? ""),
              usd: Number(row.au ?? row.cost_usd) || null,
              signature: String(row.h ?? row.tx_hash ?? ""),
            });
        }
      }
      if (body?.channel === "token_general_stat_num")
        for (const row of body.data ?? [])
          if (row.t === "holder_count" && Number.isFinite(Number(row.v)))
            m.observation.count({ at, count: Number(row.v) });
    }
  }
  private async reconcile(p: LivePosition, order: LiveOrder) {
    try {
      const fill = await this.adapter.confirm(p.wallet, p.mint, order);
      if (!fill) {
        if (
          Date.now() - order.submittedAt > 60000 &&
          order.status !== "UNKNOWN"
        ) {
          order.status = "UNKNOWN";
          p.status = "UNKNOWN";
          auditLive(this.dir, this.state, p, "CONFIRMATION_UNKNOWN", {
            side: order.side,
            orderId: order.orderId,
            hash: order.hash,
          });
        }
        return;
      }
      if (
        fill.confirmedAt < order.submittedAt - 60000 ||
        (!fill.failed &&
          order.side === "SELL" &&
          BigInt(fill.tokenDelta) !== -BigInt(order.amount))
      ) {
        order.status = "UNKNOWN";
        p.status = "UNKNOWN";
        p.lastError = "Transaksi tidak cocok dengan waktu/jumlah order.";
        auditLive(this.dir, this.state, p, "FILL_MISMATCH", { fill, order });
        return;
      }
      Object.assign(order, fill, {
        status: fill.failed ? "FAILED" : "CONFIRMED",
      });
      if (fill.failed) {
        p.status = order.side === "BUY" ? "FAILED" : "HOLDING";
        p.lastError = "Transaksi gagal on-chain.";
        p.cashflowComplete = false;
        p.exitWanted = undefined;
      } else {
        p.lastError = undefined;
        if (order.side === "BUY") {
          if (BigInt(fill.tokenDelta) <= 0n) {
            order.status = "UNKNOWN";
            p.status = "UNKNOWN";
            p.lastError = "Delta token BUY tidak cocok.";
          } else {
            p.acquiredAmount = fill.tokenDelta;
            p.remainingAmount = fill.tokenDelta;
            p.decimals = fill.decimals;
            p.buyConfirmedAt = Date.now();
            p.status = "HOLDING";
            await this.adapter.restoreMonitor(p.id, p.mint, p.wallet);
            this.monitor(p);
            const c = readLiveConfig(this.dir);
            if (c.maxBuys > 0 && this.completed() >= c.maxBuys)
              saveLiveConfig(this.dir, { enabled: false });
          }
        } else {
          if (BigInt(fill.tokenDelta) >= 0n) {
            order.status = "UNKNOWN";
            p.status = "UNKNOWN";
            p.lastError = "Delta token SELL tidak cocok.";
          } else {
            const remaining = BigInt(p.remainingAmount) + BigInt(fill.tokenDelta);
            p.remainingAmount = String(remaining > 0n ? remaining : 0n);
            if (remaining <= 0n) {
              p.status = "CLOSED";
              p.closedAt = Date.now();
              p.lastError = undefined;
              const orders = [...p.buys, ...p.sells];
              if (
                p.cashflowComplete &&
                orders.every((o) => o.status === "CONFIRMED")
              ) {
                p.pnlSol = orders.reduce((n, o) => n + (o.cashflowSol ?? 0), 0);
                p.pnlUsd = orders.reduce(
                  (n, o) => n + (o.cashflowSol ?? 0) * o.solUsd,
                  0,
                );
              }
              await this.adapter.release(p.id);
              this.monitors.delete(p.id);
            } else {
              p.status = "HOLDING";
              p.exitWanted = "RESIDUAL_TOKENS";
            }
          }
        }
      }
      auditLive(
        this.dir,
        this.state,
        p,
        fill.failed ? "CHAIN_FAILED" : `${order.side}_CONFIRMED`,
        fill,
      );
    } catch (e) {
      p.lastError = e instanceof Error ? e.message : "Rekonsiliasi gagal";
      auditLive(this.dir, this.state, p, "RECONCILE_ERROR", {
        error: p.lastError,
      });
    }
  }
  private async sell(p: LivePosition) {
    let order: LiveOrder | undefined;
    try {
      const ready = await this.adapter.readiness();
      if (!ready.sessionReady || ready.wallet !== p.wallet || !ready.solUsd)
        throw Error(ready.error || "Sesi SELL tidak siap.");
      await this.adapter.restoreMonitor(p.id, p.mint, p.wallet);
      const balance = await this.adapter.balance(p.wallet, p.mint),
        owned = BigInt(p.remainingAmount),
        available = BigInt(balance.amount);
      if (available < owned) {
        p.cashflowComplete = false;
        p.remainingAmount = String(available);
        auditLive(this.dir, this.state, p, "EXTERNAL_BALANCE_CHANGE", {
          expected: String(owned),
          actual: balance.amount,
        });
      }
      if (available === 0n) {
        p.status = "UNKNOWN";
        p.lastError =
          "Saldo token berubah di luar bot; hasil exit belum diketahui.";
        auditLive(this.dir, this.state, p, "EXTERNAL_EXIT_UNKNOWN", {
          balance,
        });
        return;
      }
      const amount = String(available < owned ? available : owned),
        c = readLiveConfig(this.dir);
      const quote = await this.adapter.quote(p.id, "SELL", amount, c);
      auditLive(this.dir, this.state, p, "SELL_QUOTE", {
        quote: quote.quote,
        reason: p.exitWanted,
      });
      order = {
        side: "SELL",
        submittedAt: Date.now(),
        status: "SUBMITTING",
        amount,
        solUsd: ready.solUsd,
      };
      p.sells.push(order);
      p.status = "SELL_PENDING";
      auditLive(this.dir, this.state, p, "SELL_SUBMITTING", {
        order,
        reason: p.exitWanted,
      });
      const result = await this.adapter.submit(
        p.id,
        "SELL",
        amount,
        quote,
        c,
        ready.solUsd,
        p.paperEntryPrice,
      );
      Object.assign(order, {
        status: result.ok ? "SUBMITTED" : "FAILED",
        orderId: result.orderId,
        hash: result.hash,
        httpStatus: result.status,
        error: result.error,
      });
      if (!result.ok) {
        p.status = "HOLDING";
        p.exitWanted = undefined;
        p.manualExit = false;
        p.lastError = result.error || "SELL ditolak.";
      }
      auditLive(
        this.dir,
        this.state,
        p,
        result.ok ? "SELL_SUBMITTED" : "SELL_FAILED",
        result,
      );
    } catch (e) {
      p.lastError = e instanceof Error ? e.message : "SELL_ERROR";
      if (order) {
        order.status = "UNKNOWN";
        p.status = "UNKNOWN";
      } else {
        p.exitWanted = undefined;
        p.manualExit = false;
      }
      auditLive(
        this.dir,
        this.state,
        p,
        order ? "SELL_UNKNOWN" : "SELL_BLOCKED",
        { error: p.lastError },
      );
    }
  }
  private commands() {
    for (const name of readdirSync(join(this.dir, "real-commands")).filter(
      (n) => /^[a-f0-9]{64}\.json$/.test(n),
    )) {
      const path = join(this.dir, "real-commands", name),
        cmd = readJson<any>(path, null),
        p = this.state.positions.find((p) => p.id === cmd?.positionId);
      if (
        p?.audit.some(
          (a) =>
            ["MANUAL_SELL_QUEUED", "MANUAL_RECONCILE_QUEUED"].includes(
              a.type,
            ) && a.details?.commandId === name,
        )
      ) {
        unlinkSync(path);
        continue;
      }
      if (p && cmd.type === "RECONCILE") {
        const order = this.pendingOrder(p);
        const used = this.state.positions.some((v) =>
          [...v.buys, ...v.sells].some(
            (o) => o !== order && o.hash === cmd.signature,
          ),
        );
        if (
          order &&
          !used &&
          typeof cmd.signature === "string" &&
          /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(cmd.signature)
        ) {
          order.hash = cmd.signature;
          auditLive(this.dir, this.state, p, "MANUAL_RECONCILE_QUEUED", {
            commandId: name,
            hash: cmd.signature,
          });
        }
      } else if (p && LIVE_ACTIVE.has(p.status)) {
        p.exitWanted = "MANUAL_SELL";
        p.manualExit = true;
        auditLive(this.dir, this.state, p, "MANUAL_SELL_QUEUED", {
          commandId: name,
        });
      }
      unlinkSync(path);
    }
  }
  async tick() {
    if (this.working) return;
    this.working = true;
    try {
      this.commands();
      if (Date.now() - this.state.readiness.observedAt > 10000) {
        this.state.readiness = {
          ...(await this.adapter.readiness()),
          workerPid: process.pid,
          activeLanes: this.lanes,
        };
        atomicJson(join(this.dir, "real-state.json"), this.state);
      }
      for (const p of this.state.positions.filter((p) =>
        LIVE_ACTIVE.has(p.status),
      )) {
        const order = this.pendingOrder(p);
        if (order) {
          await this.reconcile(p, order);
          continue;
        }
        if (p.status === "BUY_PENDING") {
          await this.buy(p);
          continue;
        }
        if (p.status !== "HOLDING") continue;
        await this.adapter.restoreMonitor(p.id, p.mint, p.wallet);
        const m = this.monitor(p),
          facts = m.observation.facts(Date.now(), []);
        m.lane.step(facts);
        (p as any).riskState = Object.fromEntries(
          Object.entries(m.lane).filter(
            ([k, v]) =>
              !["emit", "policy", "rules", "mint"].includes(k) &&
              typeof v !== "function" &&
              !(typeof v === "number" && !Number.isFinite(v)),
          ),
        );
        const c = readLiveConfig(this.dir);
        if (
          !p.exitWanted &&
          Date.now() - p.createdAt >
            Number(p.rules.maxHoldSeconds || 300) * 1000
        )
          p.exitWanted = "MAX_HOLD";
        if (p.exitWanted && (c.autoSell || p.manualExit)) await this.sell(p);
      }
      this.state.updatedAt = Date.now();
      atomicJson(join(this.dir, "real-state.json"), this.state);
    } finally {
      this.working = false;
    }
  }
  hasActive() {
    return this.state.positions.some((p) => LIVE_ACTIVE.has(p.status));
  }
}
