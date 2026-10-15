import { chromium, type Page } from "playwright";
import { parseArgs } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodeFrame } from "./parser.js";
import { fetchWalletActivityPair } from "./wallet-activity-poll.js";
import { LOG_CHUNK_MS, RotatingJsonlWriter } from "./rotating-jsonl.js";
import { DistributionTargetRuntime } from "./distribution-target-runtime.js";
import { Profit4LiveEngine } from "./profit4-live-engine.js";
import { GmgnLiveAdapter } from "./profit4-gmgn-execution.js";
import { readJson } from "./profit4-live-store.js";
import {
  DistributionProfit4Runtime,
  atomicProfit4Json,
} from "./distribution-profit4-runtime.js";
import {
  getBrowserBuySwapRoute,
  getBrowserDualSellSwapRoute,
  DEFAULT_SWAP_WALLET,
} from "./browser-swap-route.js";
import { HeadlessTradeStream } from "./headless-trade-stream.js";
import { SolanaWalletStream } from "./solana-wallet-stream.js";
import { attachCapture } from "./capture.js";

type Transfer = {
  wallet: string;
  mint: string;
  symbol?: string;
  timestamp?: number;
  priceUsd?: number;
  amount?: string;
  from?: string;
  tx?: string;
};
type Watch = { transfer: Transfer };
const defaults = [
  "5bmpgSv6LHyfX6EQ9XnreapgW2VoaDJNAK8mRSNZGZoT",
  "3dKvjSVXCa2s5ysv5MGtjQ8CF4XZ6MKKTds2uGotXpwD",
  "2dVDVvzH4D3ihpUTbiG9yNSEsQBs8iFNRifcZP6TLqVK",
];
const { values } = parseArgs({
  options: {
    addresses: { type: "string", default: defaults.join(",") },
    pollMilliseconds: { type: "string", default: "1200" },
    walletPollMilliseconds: { type: "string", default: "6000" },
    profileDir: { type: "string", default: "profiles/research-vps" },
    profileName: { type: "string", default: "Default" },
    paperLane: { type: "string", default: "target" },
    dataDir: { type: "string", default: "data/distribution-watch" },
    maxDetails: { type: "string", default: "0" },
    headlessStream: { type: "string", default: "true" },
    solanaWalletWs: { type: "string", default: "true" },
  },
});
if (!["target", "profit4", "bounce"].includes(values.paperLane!))
  throw new Error("paperLane tidak valid.");
const isPaperRunner =
  values.paperLane === "profit4" || values.paperLane === "bounce";
const profit4 = isPaperRunner;
const useHeadlessStream = values.headlessStream !== "false";
const useSolanaWalletWs = values.solanaWalletWs !== "false";
const savedAddresses = readJson<{ addresses?: string[] }>(
  join(values.dataDir!, "dashboard-config.json"),
  {},
).addresses;
const addressInput =
  !process.argv.some(
    (a) => a === "--addresses" || a.startsWith("--addresses="),
  ) && Array.isArray(savedAddresses)
    ? savedAddresses.join(",")
    : values.addresses!;
let addresses = [
  ...new Set(
    addressInput
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];
const pollMilliseconds = Number(values.pollMilliseconds);
const walletPollMilliseconds = Number(values.walletPollMilliseconds);
if (
  !addresses.length ||
  addresses.some((x) => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x))
)
  throw new Error("Harus ada minimal satu address wallet Solana yang valid.");
if (!Number.isFinite(pollMilliseconds) || pollMilliseconds < 250)
  throw new Error("--pollMilliseconds minimal 250.");
if (!Number.isFinite(walletPollMilliseconds) || walletPollMilliseconds < 250)
  throw new Error("--walletPollMilliseconds minimal 250.");
if (!existsSync(values.profileDir!))
  throw new Error("Profile Chrome research tidak ditemukan.");
const parsedMax = Number(values.maxDetails ?? (useHeadlessStream ? 0 : 3));
const maxDetails = useHeadlessStream
  ? 0
  : (Number.isFinite(parsedMax) && parsedMax > 0 ? Math.min(parsedMax, 3) : 0);

const dataDirectory = values.dataDir!;
const output = join(
  dataDirectory,
  new Date().toISOString().replace(/[:.]/g, "-"),
);
const controlFile = join(dataDirectory, "worker-control.json");
const stopFile = join(dataDirectory, "stop-request.json");
const writeControl = (value: unknown) =>
  profit4
    ? atomicProfit4Json(controlFile, value)
    : writeFileSync(controlFile, JSON.stringify(value, null, 2));
mkdirSync(output, { recursive: true });
if (profit4 && existsSync(controlFile)) {
  const previous = JSON.parse(readFileSync(controlFile, "utf8"));
  if (previous.pid !== process.pid && Number.isInteger(previous.pid)) {
    let active = false;
    try {
      process.kill(previous.pid, 0);
      active = true;
    } catch {}
    if (active)
      throw new Error(
        "Worker Profit4/Bounce sudah berjalan. Gunakan dashboard untuk restart.",
      );
  }
}
const logWriter = new RotatingJsonlWriter(output);
const write = (name: string, value: unknown) => logWriter.write(name, value);
const targetLane = isPaperRunner
  ? new DistributionProfit4Runtime(
      output,
      write,
      dataDirectory,
      values.paperLane === "bounce" ? "bounce" : "profit4",
    )
  : new DistributionTargetRuntime(output, write);
process.once("exit", () => logWriter.close());
const walk = (
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] => {
  if (Array.isArray(value)) value.forEach((x) => walk(x, out));
  else if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    out.push(row);
    Object.values(row).forEach((x) => walk(x, out));
  }
  return out;
};
function fields(row: Record<string, unknown>) {
  const token = row.token as Record<string, unknown> | undefined;
  return {
    event: String(row.event_type ?? row.e ?? "").toLowerCase(),
    mint: String(token?.address ?? row.token_address ?? row.a ?? ""),
    timestamp: Number(row.timestamp ?? row.t) || 0,
    token,
  };
}
function transfer(
  row: Record<string, unknown>,
  wallet: string,
): Transfer | undefined {
  const f = fields(row);
  if (
    f.event !== "transfer_in" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.mint)
  )
    return;
  return {
    wallet,
    mint: f.mint,
    symbol: String(f.token?.symbol ?? ""),
    timestamp: f.timestamp || undefined,
    priceUsd: Number(row.price_usd ?? row.pu) || undefined,
    amount: String(row.token_amount ?? row.ba ?? ""),
    from: String(row.from_address ?? ""),
    tx: String(row.tx_hash ?? row.h ?? ""),
  };
}
function latestUnsold(body: unknown, wallet: string): Transfer | undefined {
  const rows = walk(body);
  const all = rows.map(fields);
  return rows
    .map((r) => transfer(r, wallet))
    .filter((x): x is Transfer => Boolean(x))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .find(
      (t) =>
        !all.some(
          (a) =>
            (a.event === "sell" || a.event === "swap_sell") &&
            a.mint === t.mint &&
            a.timestamp > (t.timestamp ?? 0),
        ),
    );
}

const context = await chromium.launchPersistentContext(values.profileDir!, {
  channel: "chrome",
  headless: false,
  viewport: null,
  args: [
    "--start-maximized",
    `--profile-directory=${values.profileName}`,
    "--js-flags=--max-old-space-size=512",
    "--disable-dev-shm-usage",
  ],
});
const controller = context.pages()[0] ?? (await context.newPage());
const details = new Map<
  string,
  { page: Page; watch: Watch; openedAt: number }
>();
const seen = new Set<string>();

interface HourlySocketStat {
  hourKey: string;
  hourLabel: string;
  solanaWsEvents: number;
  tradeTicks: number;
  newTokensCaptured: number;
  syndicateTransfers: number;
  reconnects: number;
  status: "HEALTHY" | "DEGRADED";
  lastEventAt: number;
}

const hourlyStatsMap = new Map<string, HourlySocketStat>();

function getHourKey(date: Date = new Date()): { key: string; label: string } {
  const wibTime = new Date(date.getTime() + 7 * 3600 * 1000);
  const key = wibTime.toISOString().slice(0, 13);
  const hourNum = Number(key.slice(11, 13));
  const nextHourNum = (hourNum + 1) % 24;
  const label = `${String(hourNum).padStart(2, "0")}:00 - ${String(nextHourNum).padStart(2, "0")}:00 WIB`;
  return { key, label };
}

function recordHourlyEvent(type: "solanaWs" | "trade" | "newToken" | "transfer" | "reconnect") {
  const { key, label } = getHourKey();
  let stat = hourlyStatsMap.get(key);
  if (!stat) {
    stat = {
      hourKey: key,
      hourLabel: label,
      solanaWsEvents: 0,
      tradeTicks: 0,
      newTokensCaptured: 0,
      syndicateTransfers: 0,
      reconnects: 0,
      status: "HEALTHY",
      lastEventAt: Date.now(),
    };
    hourlyStatsMap.set(key, stat);
  }
  stat.lastEventAt = Date.now();
  if (type === "solanaWs") stat.solanaWsEvents++;
  else if (type === "trade") stat.tradeTicks++;
  else if (type === "newToken") stat.newTokensCaptured++;
  else if (type === "transfer") stat.syndicateTransfers++;
  else if (type === "reconnect") {
    stat.reconnects++;
    if (stat.reconnects > 5) stat.status = "DEGRADED";
  }
}

function initHourlyStatsFromChunks(chunksDir: string) {
  try {
    if (!existsSync(chunksDir)) return;
    const dirs = readdirSync(chunksDir);
    for (const dir of dirs) {
      const m = dir.match(/T(\d\d)-(\d\d)/);
      if (!m) continue;
      const hourStr = m[1];
      const key = `2026-10-15T${hourStr}`;
      const nextHour = (Number(hourStr) + 1) % 24;
      const label = `${hourStr}:00 - ${String(nextHour).padStart(2, "0")}:00 WIB`;
      if (!hourlyStatsMap.has(key)) {
        hourlyStatsMap.set(key, {
          hourKey: key,
          hourLabel: label,
          solanaWsEvents: 0,
          tradeTicks: 0,
          newTokensCaptured: 0,
          syndicateTransfers: 0,
          reconnects: 0,
          status: "HEALTHY",
          lastEventAt: Date.now(),
        });
      }
      const stat = hourlyStatsMap.get(key)!;
      const dirPath = join(chunksDir, dir);
      if (existsSync(join(dirPath, "profit4-events.jsonl"))) {
        stat.solanaWsEvents += readFileSync(join(dirPath, "profit4-events.jsonl"), "utf8").split("\n").filter(Boolean).length;
      }
      if (existsSync(join(dirPath, "token-trades.jsonl"))) {
        stat.tradeTicks += readFileSync(join(dirPath, "token-trades.jsonl"), "utf8").split("\n").filter(Boolean).length;
      }
      if (existsSync(join(dirPath, "transfers.jsonl"))) {
        stat.syndicateTransfers += readFileSync(join(dirPath, "transfers.jsonl"), "utf8").split("\n").filter(Boolean).length;
      }
    }
  } catch {}
}

initHourlyStatsFromChunks(join(output, "chunks"));
try {
  const allRuns = readdirSync(dataDirectory).filter((f) => f.startsWith("2026-10-15"));
  for (const r of allRuns) {
    initHourlyStatsFromChunks(join(dataDirectory, r, "chunks"));
  }
} catch {}

interface ActiveDetailItem {
  mint: string;
  symbol: string;
  wallet: string;
  openedAt: number;
  source: string;
  status: string;
  priceUsd?: number;
  tx?: string;
}

const activeDetailsQueue: ActiveDetailItem[] = [];

function pushActiveDetail(item: ActiveDetailItem) {
  const existingIdx = activeDetailsQueue.findIndex((x) => x.mint === item.mint);
  if (existingIdx >= 0) {
    activeDetailsQueue[existingIdx] = { ...activeDetailsQueue[existingIdx], ...item };
  } else {
    activeDetailsQueue.unshift(item);
    if (activeDetailsQueue.length > 50) activeDetailsQueue.pop();
  }
}

let tradeStream: HeadlessTradeStream | null = null;
if (useHeadlessStream) {
  tradeStream = new HeadlessTradeStream();
  tradeStream.on("trade", (mint, trade) => {
    recordHourlyEvent("trade");
    write("token-trades.jsonl", {
      observedAt: trade.at,
      ...trade,
    });
    targetLane.trade(mint, trade);
  });
  tradeStream.on("newToken", (token) => {
    recordHourlyEvent("newToken");
    write("watch-events.jsonl", {
      type: "RESEARCH_NEW_TOKEN_DISCOVERED",
      observedAt: Date.now(),
      mint: token.mint,
      symbol: token.symbol || "UNKNOWN",
      name: token.name,
      creator: token.traderPublicKey,
      initialBuy: token.initialBuy,
      marketCapSol: token.marketCapSol,
      source: "pumpportal_ws",
    });
    const priceUsd = token.marketCapSol ? (token.marketCapSol * 145) / 1000000000 : 0.000004;
    pushActiveDetail({
      mint: token.mint,
      symbol: token.symbol || "UNKNOWN",
      wallet: token.traderPublicKey,
      openedAt: Date.now(),
      source: "pumpportal_ws",
      priceUsd,
      status: "DISCOVERED_0S",
    });
    tradeStream?.registerMint(token.mint, { symbol: token.symbol, priceUsd });
    if (targetLane instanceof DistributionProfit4Runtime) {
      targetLane.register({
        mint: token.mint,
        wallet: token.traderPublicKey || "creator",
        symbol: token.symbol || "UNKNOWN",
        timestamp: Math.floor(Date.now() / 1000),
        from: token.traderPublicKey || "creator",
      }, Date.now());
      targetLane.trade(token.mint, {
        at: Date.now(),
        timestamp: Math.floor(Date.now() / 1000),
        price: priceUsd,
        side: "buy",
        wallet: token.traderPublicKey || "creator",
        usd: (Number(token.initialBuy) || 0.1) * 145,
        signature: "genesis_creation",
      });
    }
  });
  tradeStream.on("status", (s: any) => {
    if (!s.ws) recordHourlyEvent("reconnect");
  });
  tradeStream.start();
  process.once("exit", () => tradeStream?.stop());
}

attachCapture(
  controller,
  (ev) => {
    if (ev.kind === "open") {
      recordHourlyEvent("solanaWs");
    }
    if (ev.kind === "frame" && ev.direction === "received") {
      recordHourlyEvent("trade");
    }
  },
  (payload, now) => {
    for (const row of walk(payload)) {
      const f = fields(row);
      if (f.mint && f.mint.length >= 32 && f.mint.length <= 44) {
        recordHourlyEvent("newToken");
        const symbol = String(f.token?.symbol || (row as any).symbol || "GMGN_NEW");
        const wallet = String(f.token?.creator || (row as any).creator || "gmgn_research");
        const priceUsd = Number(f.token?.price_usd || (row as any).price_usd || 0.000004);
        pushActiveDetail({
          mint: f.mint,
          symbol,
          wallet,
          openedAt: now,
          source: "gmgn_research_ws",
          priceUsd,
          status: "RESEARCH_DISCOVERED",
        });
        tradeStream?.registerMint(f.mint, { symbol, priceUsd: priceUsd > 0 ? priceUsd : 0.000004 });
        if (targetLane instanceof DistributionProfit4Runtime) {
          targetLane.register({
            mint: f.mint,
            wallet,
            symbol,
            timestamp: Math.floor(now / 1000),
            from: wallet,
          }, now);
          if (priceUsd > 0) {
            targetLane.trade(f.mint, {
              at: now,
              timestamp: Math.floor(now / 1000),
              price: priceUsd,
              side: "buy",
              wallet,
              usd: 25,
              signature: `gmgn_${now}`,
            });
          }
        }
      }
    }
  },
);

let liveEngine: Profit4LiveEngine | null = null;
if (isPaperRunner && targetLane instanceof DistributionProfit4Runtime) {
  const adapter = new GmgnLiveAdapter(context, controller);
  liveEngine = new Profit4LiveEngine(
    dataDirectory,
    output,
    adapter,
    values.paperLane === "bounce" ? ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "S1", "S2", "S3", "S4"] : ["P4"],
  );
  adapter.setMonitorHook((mint, body, at) =>
    liveEngine?.monitorFrame(mint, body, at),
  );
  targetLane.setLiveSignalHandler((signal) => liveEngine?.handleSignal(signal));
}
const liveTimer = setInterval(() => {
  void liveEngine
    ?.tick()
    .catch((error) =>
      write("watch-events.jsonl", {
        type: "REAL_ENGINE_ERROR",
        observedAt: Date.now(),
        message: error instanceof Error ? error.message : "unknown",
      }),
    );
}, 1000);
liveTimer.unref();
process.once("exit", () => clearInterval(liveTimer));

if (isPaperRunner && targetLane instanceof DistributionProfit4Runtime) {
  targetLane.setSwapProbeHandlers({
    getBuyQuote: async (mint: string) => {
      let page: Page | undefined;
      for (const item of details.values()) {
        if (item.watch.transfer.mint === mint && !item.page.isClosed()) {
          page = item.page;
          break;
        }
      }
      if (!page && !controller.isClosed()) page = controller;
      if (!page) return null;
      try {
        return await getBrowserBuySwapRoute(
          page,
          mint,
          DEFAULT_SWAP_WALLET,
          5.0,
          145.0,
          15,
        );
      } catch (err: any) {
        return {
          status: 500,
          latencyMs: 0,
          ok: false,
          error: err?.message || "BUY_PROBE_ERROR",
        };
      }
    },
    getSellQuotes: async (mint: string, inputTokensBaseUnits, decimals) => {
      let page: Page | undefined;
      for (const item of details.values()) {
        if (item.watch.transfer.mint === mint && !item.page.isClosed()) {
          page = item.page;
          break;
        }
      }
      if (!page && !controller.isClosed()) page = controller;
      if (!page) return null;
      try {
        return await getBrowserDualSellSwapRoute(
          page,
          mint,
          DEFAULT_SWAP_WALLET,
          inputTokensBaseUnits ?? "1000000000",
          decimals ?? 6,
          15,
          1000,
        );
      } catch {
        return null;
      }
    },
  });
}
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify(
    {
      addresses,
      pollMilliseconds,
      requestGapMs: pollMilliseconds,
      walletPollIntervalMs: profit4 ? walletPollMilliseconds : null,
      requestMode: "sequential",
      maxTabs: 1 + maxDetails,
      maxDetails,
      startedAt: new Date().toISOString(),
      storage: {
        format: "jsonl",
        directory: "chunks",
        chunkMinutes: LOG_CHUNK_MS / 60_000,
        timezone: "Asia/Jakarta",
      },
      purpose:
        "One controller address tab plus at most one token detail tab per monitored wallet. Each detail remains open until its receiving wallet sells the same mint. Paper monitoring with a separate opt-in real GMGN execution engine. Real Auto-Buy starts OFF.",
    },
    null,
    2,
  ),
);
let stopping = false;
const wait = async (ms: number) => {
  if (!profit4) {
    await delay(ms);
    return;
  }
  const until = Date.now() + ms;
  while (!stopping && Date.now() < until)
    await delay(Math.min(250, until - Date.now()));
};
const control = {
  pid: process.pid,
  mode: profit4 ? "profit4-watch" : "distribution-watch",
  status: "running",
  startedAt: new Date().toISOString(),
  run: output,
  addresses,
  requestGapMs: pollMilliseconds,
  walletPollIntervalMs: profit4 ? walletPollMilliseconds : null,
  requestMode: "sequential",
  logDirectory: join(output, "chunks"),
  chunkMinutes: LOG_CHUNK_MS / 60_000,
};
const health: {
  lastPollAt?: number;
  lastPollWallet?: string;
  lastPollComplete?: boolean;
  lastPollStatus?: number;
  lastError?: string | null;
  lastSocketAt?: number;
  backoffUntil?: number | null;
} = {};
writeControl(control);
const removeControlFile = () => {
  try {
    const state = JSON.parse(readFileSync(controlFile, "utf8"));
    if (state.pid === process.pid) {
      if (profit4)
        writeControl({
          ...state,
          status: state.status === "failed" ? "failed" : "stopped",
          stoppedAt: new Date().toISOString(),
        });
      else unlinkSync(controlFile);
    }
  } catch {}
};
process.once("SIGINT", removeControlFile);
process.once("SIGTERM", removeControlFile);
process.once("exit", removeControlFile);

function attachDetailSocket(page: Page, wallet: string) {
  if (profit4)
    page.on("response", async (response) => {
      if (!/gmgn\.ai\//.test(response.url()) || !/\/api\//.test(response.url()))
        return;
      try {
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = { rawBody: text };
        }
        write("api-responses.jsonl", {
          observedAt: Date.now(),
          role: "token_detail",
          mint: details.get(wallet)?.watch.transfer.mint,
          endpoint: response.url(),
          status: response.status(),
          contentType: response.headers()["content-type"],
          body,
        });
      } catch {
        /* response may disappear while closing the detail */
      }
    });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) =>
      write("websocket-frames.jsonl", {
        observedAt: Date.now(),
        role: "token_detail",
        wallet,
        mint: details.get(wallet)?.watch.transfer.mint,
        direction: "sent",
        socket: socket.url(),
        body: decodeFrame(payload) ?? { undecodable: true },
      }),
    );
    socket.on("framereceived", ({ payload }) => {
      const observedAt = Date.now();
      if (profit4) health.lastSocketAt = observedAt;
      const body = decodeFrame(payload);
      const state = details.get(wallet);
      write("websocket-frames.jsonl", {
        observedAt,
        role: "token_detail",
        wallet,
        mint: state?.watch.transfer.mint,
        direction: "received",
        socket: socket.url(),
        body: body ?? { undecodable: true },
      });
      if (!state) return;
      targetLane.holderFrame(state.watch.transfer.mint, body, observedAt);
      for (const row of walk(body)) {
        const f = fields(row),
          price = Number(row.pu ?? row.price_usd);
        if (
          f.mint !== state.watch.transfer.mint ||
          !["buy", "sell"].includes(f.event) ||
          !Number.isFinite(price)
        )
          continue;
        const trade = {
          mint: f.mint,
          side: f.event,
          price,
          timestamp: f.timestamp || undefined,
          wallet: String(row.m ?? row.wallet ?? ""),
          usd: Number(row.au ?? row.cost_usd) || undefined,
          signature: String(row.h ?? row.tx_hash ?? ""),
        };
        write("token-trades.jsonl", {
          observedAt,
          trackedFrom: state.watch.transfer,
          ...trade,
        });
        if (trade.timestamp)
          targetLane.trade(trade.mint, {
            at: observedAt,
            timestamp: trade.timestamp,
            price: trade.price,
            side: trade.side,
            wallet: trade.wallet,
            usd: trade.usd ?? null,
            signature: trade.signature,
          });
        if (
          profit4 &&
          trade.side === "sell" &&
          trade.wallet === wallet &&
          (trade.timestamp ?? 0) >= (state.watch.transfer.timestamp ?? Infinity)
        ) {
          write("watch-events.jsonl", {
            type: "TRACKED_WALLET_SOLD",
            observedAt,
            trackedWallet: wallet,
            transfer: state.watch.transfer,
            sell: trade,
            source: "socket",
          });
          if (values.paperLane !== "bounce") {
            details.delete(wallet);
            if (
              ![...details.values()].some(
                (d) => d.watch.transfer.mint === trade.mint,
              )
            )
              targetLane.end(
                trade.mint,
                observedAt,
                "TRACKED_WALLET_SOLD_AND_DETAIL_CLOSED",
              );
            void page.close();
            break;
          }
        }
      }
    });
  });
  page.on("close", () => {
    if (details.get(wallet)?.page === page) {
      const mint = details.get(wallet)!.watch.transfer.mint;
      details.delete(wallet);
      if (![...details.values()].some((d) => d.watch.transfer.mint === mint))
        targetLane.end(mint, Date.now(), "DETAIL_CLOSED");
    }
  });
}

async function openOrReplaceDetail(next: Transfer) {
  const key = `${next.wallet}:${next.mint}:${next.tx || next.timestamp || ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  write("transfers.jsonl", { observedAt: Date.now(), ...next });

  if (useHeadlessStream && tradeStream) {
    targetLane.register(next, Date.now());
    tradeStream.registerMint(next.mint, {
      symbol: next.symbol,
      priceUsd: next.priceUsd,
    });
    write("watch-events.jsonl", {
      type: "TOKEN_MONITOR_HEADLESS_ATTACHED",
      observedAt: Date.now(),
      trackedWallet: next.wallet,
      transfer: next,
      mode: "headless-websocket",
    });
    return;
  }

  const existing = details.get(next.wallet);
  if (existing?.watch.transfer.mint === next.mint) return;
  if (!existing && details.size >= maxDetails) {
    let evictCandidate: string | null = null;
    let oldestOpen = Infinity;
    for (const [w, item] of details.entries()) {
      const m = item.watch.transfer.mint;
      if (liveEngine?.hasActiveMint(m)) continue;
      const isPaperLive =
        typeof (targetLane as any).isMintActive === "function"
          ? (targetLane as any).isMintActive(m)
          : false;
      if (!isPaperLive) {
        evictCandidate = w;
        break;
      }
      if (item.openedAt < oldestOpen) {
        oldestOpen = item.openedAt;
        evictCandidate = w;
      }
    }

    const candidateItem = evictCandidate ? details.get(evictCandidate) : null;
    const canEvict =
      candidateItem &&
      (!((targetLane as any).isMintActive?.(
        candidateItem.watch.transfer.mint,
      )) ||
        Date.now() - candidateItem.openedAt > 60_000);

    if (evictCandidate && canEvict && candidateItem) {
      write("watch-events.jsonl", {
        type: "DETAIL_EVICTED_CAPACITY",
        observedAt: Date.now(),
        evictedWallet: evictCandidate,
        evictedMint: candidateItem.watch.transfer.mint,
        newWallet: next.wallet,
        newMint: next.mint,
      });
      details.delete(evictCandidate);
      void candidateItem.page.close().catch(() => {});
    } else {
      write("watch-events.jsonl", {
        type: "DETAIL_SKIPPED_CAPACITY",
        observedAt: Date.now(),
        trackedWallet: next.wallet,
        transfer: next,
        maxDetails,
      });
      return;
    }
  }
  const page = existing?.page ?? (await context.newPage());
  if (!existing) attachDetailSocket(page, next.wallet);
  if (existing) {
    write("watch-events.jsonl", {
      type: "DETAIL_REPLACED_BY_NEW_TRANSFER",
      observedAt: Date.now(),
      trackedWallet: next.wallet,
      previous: existing.watch.transfer,
      next,
    });
    if (
      ![...details.values()].some(
        (d) =>
          d !== existing &&
          d.watch.transfer.mint === existing.watch.transfer.mint,
      )
    )
      targetLane.end(
        existing.watch.transfer.mint,
        Date.now(),
        "DETAIL_REPLACED",
      );
  }
  const watch: Watch = { transfer: next };
  details.set(next.wallet, { page, watch, openedAt: Date.now() });
  targetLane.register(next, Date.now());
  write("watch-events.jsonl", {
    type: "TOKEN_DETAIL_OPENED",
    observedAt: Date.now(),
    trackedWallet: next.wallet,
    transfer: next,
    closeRule: "receiving wallet sells same mint",
  });
  await page.goto(`https://gmgn.ai/sol/token/${next.mint}`, {
    waitUntil: "commit",
  });
}

let controllerTargetUrl = `https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=new_pair`;
const feedSettingsFile = join(process.cwd(), "config", "feed-settings.json");
if (existsSync(feedSettingsFile)) {
  try {
    const cfg = JSON.parse(readFileSync(feedSettingsFile, "utf8"));
    if (cfg.feedUrl) controllerTargetUrl = cfg.feedUrl;
  } catch {}
}

await controller.goto(controllerTargetUrl, {
  waitUntil: "commit",
});
write("watch-events.jsonl", {
  type: "READY",
  observedAt: Date.now(),
  controllerUrl: controllerTargetUrl,
  controllerWallet: addresses[0],
  checkedWallets: addresses,
  maxTabs: 1 + maxDetails,
  maxDetails,
  execution: "READ_ONLY",
});
const targetTimer = setInterval(() => {
  const now = Date.now();
  targetLane.evaluate(now);

  for (const [wallet, item] of details.entries()) {
    const mint = item.watch.transfer.mint;
    const isRealActive = liveEngine?.hasActiveMint(mint);
    if (isRealActive) continue;
    const isPaperLive =
      typeof (targetLane as any).isMintActive === "function"
        ? (targetLane as any).isMintActive(mint)
        : false;
    const ageMs = now - (item.openedAt || now);
    if ((!isPaperLive && ageMs > 30_000) || ageMs > 600_000) {
      write("watch-events.jsonl", {
        type: "DETAIL_AUTO_CLOSED",
        observedAt: now,
        trackedWallet: wallet,
        mint,
        ageSeconds: Math.round(ageMs / 1000),
        reason: !isPaperLive ? "ALL_LANES_FINISHED" : "MAX_OBSERVATION_EXPIRED",
      });
      details.delete(wallet);
      void item.page.close().catch(() => {});
    }
  }

  if (tradeStream) {
    for (const mint of tradeStream.getTrackedMints()) {
      const isRealActive = liveEngine?.hasActiveMint(mint);
      if (isRealActive) continue;
      const isPaperLive =
        typeof (targetLane as any).isMintActive === "function"
          ? (targetLane as any).isMintActive(mint)
          : false;
      if (!isPaperLive) {
        tradeStream.unregisterMint(mint);
      }
    }
  }

  const controllerUrl =
    controller && !controller.isClosed()
      ? controller.url()
      : `https://gmgn.ai/sol/address/${addresses[0]}`;
  const controllerInfo = {
    url: controllerUrl,
    status: controller && !controller.isClosed() ? "READY" : "DISCONNECTED",
    session: "Lolos Cloudflare / Siaga Order",
    cdpPort: 9223,
    tabs: 1,
    maxDetails,
  };

  const socketHealth = {
    activeConnections: {
      solanaRpcPool: {
        status: walletStream?.isConnected() ? "CONNECTED" : "DISCONNECTED",
        endpoint: "wss://api.mainnet-beta.solana.com",
        walletsWatched: addresses.length,
        pools: walletStream?.getStatus().totalSockets || 2,
      },
      pumpPortalWs: {
        status: tradeStream?.isConnected() ? "CONNECTED" : "DISCONNECTED",
        endpoint: "wss://pumpportal.fun/api/data",
        trackedMints: tradeStream?.getTrackedMints().length || 0,
      },
      controllerBrowser: controllerInfo,
    },
    hourlyStats: Array.from(hourlyStatsMap.values()).sort((a, b) =>
      b.hourKey.localeCompare(a.hourKey),
    ),
  };

  if (profit4 && !stopping)
    writeControl({
      ...control,
      ...health,
      heartbeatAt: now,
      openTabs: details.size + 1,
      controller: controllerInfo,
      controllerUrl,
      socketHealth,
      activeDetailsQueue,
      parallelResearch: {
        enabled: true,
        mode: "headless-websocket",
        activeLanes: [
          "V1",
          "V2",
          "V3",
          "V4",
          "V5",
          "V6",
          "V7",
          "S1",
          "S2",
          "S3",
          "S4",
          "G1",
          "Safe",
          "Optimal",
          "Wide",
          "Swing 100k",
          "Wave Scalper",
          "Momentum V2",
          "Momentum V3",
          "R5 Band",
        ],
      },
    });
  if (profit4 && existsSync(stopFile)) {
    try {
      const request = JSON.parse(readFileSync(stopFile, "utf8"));
      if (request.pid === process.pid) {
        if (liveEngine?.hasActive()) {
          write("watch-events.jsonl", {
            type: "STOP_BLOCKED_REAL_POSITIONS",
            observedAt: Date.now(),
          });
          unlinkSync(stopFile);
          return;
        }
        stopping = true;
        targetLane.shutdown(Date.now());
        void context.close();
      }
    } catch {}
  }
}, 1000);
targetTimer.unref();
process.once("SIGINT", () => {
  walletStream?.stop();
  clearInterval(targetTimer);
  targetLane.shutdown(Date.now());
});
process.once("SIGTERM", () => {
  walletStream?.stop();
  clearInterval(targetTimer);
  targetLane.shutdown(Date.now());
});
let walletStream: SolanaWalletStream | null = null;
if (useSolanaWalletWs) {
  walletStream = new SolanaWalletStream({
    maxWalletsPerSocket: 75,
    staggerMs: 20,
  });

  walletStream.on("rawActivity", () => {
    recordHourlyEvent("solanaWs");
  });

  walletStream.on("transfer", async (t) => {
    recordHourlyEvent("transfer");
    pushActiveDetail({
      mint: t.mint,
      symbol: t.symbol || "UNKNOWN",
      wallet: t.wallet,
      openedAt: Date.now(),
      source: "syndicate_inflow",
      priceUsd: t.priceUsd,
      tx: t.tx,
      status: "EVALUATING_12_LANES",
    });
    write("watch-events.jsonl", {
      type: "SOLANA_WALLET_TRANSFER_IN",
      observedAt: Date.now(),
      wallet: t.wallet,
      mint: t.mint,
      amount: t.amount,
      tx: t.tx,
    });
    const candidate: Transfer = {
      wallet: t.wallet,
      mint: t.mint,
      symbol: t.symbol,
      timestamp: t.timestamp,
      priceUsd: t.priceUsd,
      amount: t.amount,
      from: t.from,
      tx: t.tx,
    };
    await openOrReplaceDetail(candidate);
  });

  walletStream.on("sell", (s) => {
    write("watch-events.jsonl", {
      type: "TRACKED_WALLET_SOLD",
      observedAt: Date.now(),
      trackedWallet: s.wallet,
      mint: s.mint,
      tx: s.tx,
      source: "solana_rpc_ws",
    });
    if (values.paperLane !== "bounce") {
      details.delete(s.wallet);
      if (![...details.values()].some((d) => d.watch.transfer.mint === s.mint)) {
        targetLane.end(s.mint, Date.now(), "TRACKED_WALLET_SOLD_SOLANA_WS");
      }
    }
  });

  void walletStream.start(addresses);
  process.once("exit", () => walletStream?.stop());
}
let nextWallet = 0;
let lastConfigReloadAt = Date.now();
while (!controller.isClosed() && !stopping) {
  const pollStartedAt = Date.now();
  if (profit4 && pollStartedAt - lastConfigReloadAt > 15000) {
    lastConfigReloadAt = pollStartedAt;
    try {
      const freshCfg = readJson<{ addresses?: string[] }>(
        join(values.dataDir!, "dashboard-config.json"),
        {},
      );
      if (Array.isArray(freshCfg.addresses) && freshCfg.addresses.length > 0) {
        const freshAddresses = [
          ...new Set(freshCfg.addresses.map((x) => x.trim()).filter(Boolean)),
        ];
        if (
          freshAddresses.length > 0 &&
          (freshAddresses.length !== addresses.length ||
            freshAddresses.some((a, i) => a !== addresses[i]))
        ) {
          addresses = freshAddresses;
          if (nextWallet >= addresses.length) nextWallet = 0;
          if (walletStream) {
            void walletStream.start(addresses);
          }
          write("watch-events.jsonl", {
            type: "WALLET_LIST_RELOADED_DYNAMICALLY",
            observedAt: pollStartedAt,
            totalWallets: addresses.length,
          });
        }
      }
    } catch {}
  }
  const jitter = Math.floor(Math.random() * 500);
  const waitForNextWallet = () => wait(
    profit4
      ? Math.max(0, walletPollMilliseconds + jitter - (Date.now() - pollStartedAt))
      : pollMilliseconds + jitter,
  );
  const wallet = addresses[nextWallet];
  nextWallet = (nextWallet + 1) % addresses.length;
  try {
    const incoming = new URLSearchParams({
      wallet,
      limit: "100",
      cost: "usd",
      type: "transferIn",
    });
    const sells = new URLSearchParams({
      wallet,
      limit: "100",
      cost: "usd",
      type: "sell",
    });
    const result = await controller.evaluate(fetchWalletActivityPair, {
      incomingUrl: `/vas/api/v1/wallet_activity/sol?${incoming}`,
      sellUrl: `/vas/api/v1/wallet_activity/sol?${sells}`,
      requestGapMs: pollMilliseconds,
    });
    write("api-responses.jsonl", {
      observedAt: Date.now(),
      wallet,
      endpoint: "/vas/api/v1/wallet_activity/sol",
      ...result,
    });
    if (profit4)
      Object.assign(health, {
        lastPollAt: Date.now(),
        lastPollWallet: wallet,
        lastPollComplete: result.complete,
        lastPollStatus: result.status,
        backoffUntil: null,
        lastError: result.complete
          ? null
          : "Respons GMGN bukan aktivitas JSON yang valid.",
      });
    if (!result.complete) {
      const failed = result.requests.find((request) => !request.valid);
      write("watch-events.jsonl", {
        type: "ACTIVITY_POLL_ERROR",
        observedAt: Date.now(),
        wallet,
        error:
          "Respons aktivitas tidak valid; body asli disimpan di api-responses.jsonl.",
        status: failed?.status,
        contentType: failed?.contentType,
      });
      if (profit4 && failed?.status === 429) {
        const pause = 30000;
        Object.assign(health, {
          backoffUntil: Date.now() + pause,
          lastError: `GMGN membatasi request (429). Menunggu ${pause / 1000} detik sebelum polling berikutnya; socket tetap direkam.`,
        });
        write("watch-events.jsonl", {
          type: "RATE_LIMIT_BACKOFF",
          observedAt: Date.now(),
          wallet,
          delayMs: pause,
        });
        await wait(pause);
      } else await wait(5000);
      continue;
    }
    const tracked = details.get(wallet);
    if (tracked) {
      const sell = walk(result.body).find((row) => {
        const activity = fields(row);
        return (
          (activity.event === "sell" || activity.event === "swap_sell") &&
          activity.mint === tracked.watch.transfer.mint &&
          activity.timestamp > (tracked.watch.transfer.timestamp ?? 0)
        );
      });
      if (sell) {
        write("watch-events.jsonl", {
          type: "TRACKED_WALLET_SOLD",
          observedAt: Date.now(),
          trackedWallet: wallet,
          transfer: tracked.watch.transfer,
          sell,
        });
        if (values.paperLane !== "bounce") {
          details.delete(wallet);
          if (
            ![...details.values()].some(
              (d) => d.watch.transfer.mint === tracked.watch.transfer.mint,
            )
          )
            targetLane.end(
              tracked.watch.transfer.mint,
              Date.now(),
              "TRACKED_WALLET_SOLD_AND_DETAIL_CLOSED",
            );
          await tracked.page.close();
          await waitForNextWallet();
          continue;
        }
      }
    }
    const candidate = latestUnsold(result.body, wallet);
    if (candidate) await openOrReplaceDetail(candidate);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write("watch-events.jsonl", {
      type: "ACTIVITY_POLL_ERROR",
      observedAt: Date.now(),
      wallet,
      error: message,
    });
    if (profit4 && !stopping)
      Object.assign(health, {
        lastPollAt: Date.now(),
        lastPollWallet: wallet,
        lastPollComplete: false,
        lastError: message,
      });
  }
  await waitForNextWallet();
}
clearInterval(targetTimer);
clearInterval(liveTimer);
walletStream?.stop();
targetLane.shutdown(Date.now());
if (profit4) {
  await context.close();
  logWriter.close();
}
