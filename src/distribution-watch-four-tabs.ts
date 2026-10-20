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
import { fetchWalletActivityPair, fetchSingleWalletActivity } from "./wallet-activity-poll.js";
import { LOG_CHUNK_MS, RotatingJsonlWriter } from "./rotating-jsonl.js";
import { DistributionTargetRuntime } from "./distribution-target-runtime.js";
import { Profit4LiveEngine } from "./profit4-live-engine.js";
import { GmgnLiveAdapter } from "./profit4-gmgn-execution.js";
import { readJson } from "./profit4-live-store.js";
import { getSmartWalletsWatchlist } from "./distribution-smart-money-lane.js";
import { OEZANK_WALLET } from "./distribution-oezank-lane.js";
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
import { GmgnTokenWebSocketManager } from "./gmgn-token-websocket.js";
import { FeedHubServer } from "./feed-hub-server.js";

type Transfer = {
  wallet: string;
  mint: string;
  symbol?: string;
  timestamp?: number;
  priceUsd?: number;
  marketCapUsd?: number;
  amount?: string | number;
  costUsd?: number;
  solSpent?: number;
  from?: string;
  tx?: string;
  source?: string;
  syndicateWalletsCount?: number;
  syndicateTier?: string;
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
    headlessStream: { type: "string", default: "false" },
    solanaWalletWs: { type: "string", default: "true" },
  },
});
if (!["target", "profit4", "bounce", "feed"].includes(values.paperLane!))
  throw new Error("paperLane tidak valid.");
const isPaperRunner =
  values.paperLane === "profit4" || values.paperLane === "bounce";
const profit4 = isPaperRunner;
const useHeadlessStream = values.headlessStream === "true";
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
const parsedMax = Number(values.maxDetails ?? 0);
const maxDetails =
  Number.isFinite(parsedMax) && parsedMax > 0 ? Math.min(parsedMax, 3) : 0;

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
if (values.paperLane === "feed") {
  writeControl({
    pid: process.pid,
    run: output,
    startedAt: Date.now(),
    mode: "chrome-feed-hub",
    status: "running",
    feedHubPort: Number(process.env.FEED_HUB_PORT || 8765),
  });
}
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
class NoopLane {
  register(_t: any, _n: number) {}
  trade(_m: string, _tr: any) {}
  holderFrame(_m: string, _b: unknown, _at: number) {}
  evaluate(_now: number) {}
  end(_m: string, _now: number, _r?: string) {}
  shutdown(_now: number) {}
  setLiveSignalHandler(_h: any) {}
  setSwapProbeHandlers(_h: any) {}
  isMintActive(_m: string) { return false; }
  onTrackedWalletSold(_m: string, _w: string, _now: number) {}
}

const targetLane: any = values.paperLane === "feed"
  ? new NoopLane()
  : (isPaperRunner
      ? new DistributionProfit4Runtime(
          output,
          write,
          dataDirectory,
          values.paperLane === "bounce" ? "bounce" : "profit4",
        )
      : new DistributionTargetRuntime(output, write));
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
    "--remote-debugging-port=9223",
  ],
});
const controller = context.pages()[0] ?? (await context.newPage());
const gmgnWsManager = new GmgnTokenWebSocketManager(controller, 50, 50);
const feedHub = new FeedHubServer(Number(process.env.FEED_HUB_PORT || 8765));
await feedHub.start().catch((err: Error) => console.warn(`[feed-hub] Start warning: ${err.message}`));

feedHub.onCommand((cmd) => {
  if (cmd.action === 'SUBSCRIBE_MINT') {
    const pool = (cmd as any).pool || 'momentum';
    const maxDur = (cmd as any).maxDurationSeconds || 7200;
    gmgnWsManager.subscribeToken(cmd.mint, pool, maxDur).catch(() => {});
  } else if (cmd.action === 'UNSUBSCRIBE_MINT') {
    gmgnWsManager.unsubscribeToken(cmd.mint).catch(() => {});
  }
});
process.once("exit", () => { void feedHub.close(); });
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

let minMarketCapUsd = 10000;
let maxMarketCapUsd = 100000;
const feedSettingsGlobalFile = join(process.cwd(), "config", "feed-settings.json");
if (existsSync(feedSettingsGlobalFile)) {
  try {
    const cfg = JSON.parse(readFileSync(feedSettingsGlobalFile, "utf8"));
    if (Number.isFinite(cfg.minMarketCapUsd)) minMarketCapUsd = Number(cfg.minMarketCapUsd);
    if (Number.isFinite(cfg.maxMarketCapUsd)) maxMarketCapUsd = Number(cfg.maxMarketCapUsd);
  } catch {}
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

const candidateMeta = new Map<string, { symbol: string; creator: string; originalSource?: string }>();
const promotedTokens = new Set<string>();

function promoteTokenIfQualified(mint: string, priceUsd: number, timestamp: number, wallet: string, source: string) {
  if (promotedTokens.has(mint)) return;
  const estimatedMcap = priceUsd * 1_000_000_000;
  if (estimatedMcap < minMarketCapUsd || estimatedMcap > maxMarketCapUsd) {
    return;
  }
  promotedTokens.add(mint);
  const meta = candidateMeta.get(mint);
  const symbol = meta?.symbol || "TOKEN";
  const creator = meta?.creator || wallet;
  const effectiveSource = meta?.originalSource || source;

  pushActiveDetail({
    mint,
    symbol,
    wallet: creator,
    openedAt: Date.now(),
    source: effectiveSource,
    priceUsd,
    status: "QUALIFIED_10K",
  });
  gmgnWsManager.subscribeToken(mint).catch(() => {});
  feedHub.broadcast({
    type: "CANDIDATE",
    source: effectiveSource,
    transfer: {
      mint,
      wallet: creator,
      symbol,
      timestamp: Math.floor(timestamp / 1000),
      from: creator,
      source: effectiveSource,
      priceUsd,
      marketCapUsd: estimatedMcap,
    },
    observedAt: Date.now(),
  });
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
    promoteTokenIfQualified(mint, trade.price, trade.at, trade.wallet, "pumpportal_ws");
    feedHub.broadcast({
      type: "TRADE_TICK",
      mint,
      trade,
      observedAt: trade.at,
    });
    targetLane.trade(mint, trade);
  });
  tradeStream.on("newToken", (token) => {
    recordHourlyEvent("newToken");
    candidateMeta.set(token.mint, { symbol: token.symbol || "UNKNOWN", creator: token.traderPublicKey || "creator", originalSource: "pumpportal_ws" });
    const solPriceUsd = 150; // Perkiraan SOL
    const priceUsd = (token.initialBuy || 0) > 0 ? (token.marketCapSol * solPriceUsd) / 1_000_000_000 : 0.000005;
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
    tradeStream?.registerMint(token.mint, { symbol: token.symbol, priceUsd });
    promoteTokenIfQualified(token.mint, priceUsd, Date.now(), token.traderPublicKey || "creator", "pumpportal_ws");
    feedHub.broadcast({
      type: "CANDIDATE",
      source: "pumpportal_ws",
      transfer: {
        mint: token.mint,
        wallet: token.traderPublicKey || "creator",
        symbol: token.symbol || "UNKNOWN",
        timestamp: Math.floor(Date.now() / 1000),
        from: token.traderPublicKey || "creator",
        source: "pumpportal_ws",
        priceUsd,
        marketCapUsd: priceUsd * 1_000_000_000,
      },
      observedAt: Date.now(),
    });
    feedHub.broadcast({
      type: "TRADE_TICK",
      mint: token.mint,
      trade: {
        at: Date.now(),
        timestamp: Math.floor(Date.now() / 1000),
        price: priceUsd,
        side: "buy",
        wallet: token.traderPublicKey || "creator",
        usd: (Number(token.initialBuy) || 0.1) * 145,
        signature: "genesis_creation",
      },
      observedAt: Date.now(),
    });
    if (targetLane instanceof DistributionProfit4Runtime) {
      targetLane.register({
        mint: token.mint,
        wallet: token.traderPublicKey || "creator",
        symbol: token.symbol || "UNKNOWN",
        timestamp: Math.floor(Date.now() / 1000),
        from: token.traderPublicKey || "creator",
        source: "pumpportal_ws",
        priceUsd,
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
    gmgnWsManager.subscribeToken(token.mint).catch(() => {});
  });
  tradeStream.on("status", (s: any) => {
    if (!s.ws) recordHourlyEvent("reconnect");
  });
  tradeStream.start();
  process.once("exit", () => tradeStream?.stop());
}

gmgnWsManager.on("trade", (trade) => {
  recordHourlyEvent("trade");
  write("token-trades.jsonl", {
    observedAt: trade.at,
    ...trade,
    source: "gmgn_browser_ws",
  });
  feedHub.broadcast({
    type: "TRADE_TICK",
    mint: trade.mint,
    trade: {
      at: trade.at,
      timestamp: trade.timestamp,
      price: trade.price,
      usd: trade.usd,
      side: trade.side,
      wallet: trade.wallet,
      signature: trade.signature,
    },
    observedAt: trade.at,
  });
  targetLane.trade(trade.mint, {
    at: trade.at,
    timestamp: trade.timestamp,
    price: trade.price,
    usd: trade.usd,
    side: trade.side,
    wallet: trade.wallet,
    signature: trade.signature,
  });
});

gmgnWsManager.on("stat", (stat) => {
  recordHourlyEvent("trade");
  feedHub.broadcast({
    type: "TRADE_TICK",
    mint: stat.mint,
    trade: {
      at: stat.at,
      timestamp: Math.floor(stat.at / 1000),
      price: stat.price,
      usd: 0,
      side: "buy",
      wallet: "gmgn_stat_feeder",
      signature: "stat_update",
    },
    observedAt: stat.at,
  });
  targetLane.trade(stat.mint, {
    at: stat.at,
    timestamp: Math.floor(stat.at / 1000),
    price: stat.price,
    usd: 0,
    side: "buy",
    wallet: "gmgn_stat_feeder",
    signature: "stat_update",
  });
});

gmgnWsManager.on("frame", (frame: any) => {
  if (Array.isArray(frame?.data)) {
    for (const item of frame.data) {
      const mint = item.ta || item.token_address || item.a;
      if (mint) {
        feedHub.broadcast({ type: "HOLDER_FRAME", mint, body: frame, observedAt: Date.now() });
        targetLane.holderFrame(mint, frame, Date.now());
      }
    }
  }
});

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
      if (f.mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.mint)) {
        const symbol = String(f.token?.symbol || (row as any).symbol || "GMGN_NEW");
        const wallet = String(f.token?.creator || (row as any).creator || "gmgn_research");
        const rawPrice = Number(f.token?.price_usd || (row as any).price_usd || 0);
        const priceUsd = rawPrice > 0.000004 ? rawPrice : 0;
        const estMcap = priceUsd > 0 ? priceUsd * 1_000_000_000 : 0;
        if (estMcap >= 10000 && estMcap <= 100000) {
          candidateMeta.set(f.mint, { symbol, creator: wallet, originalSource: "gmgn_research_ws" });
          feedHub.broadcast({
            type: "CANDIDATE",
            source: "gmgn_research_ws",
            transfer: {
              mint: f.mint,
              wallet,
              symbol,
              timestamp: Math.floor(now / 1000),
              from: wallet,
              source: "gmgn_research_ws",
              priceUsd: priceUsd > 0 ? priceUsd : undefined,
              marketCapUsd: estMcap,
            },
            observedAt: now,
          });
        }
        if (priceUsd > 0) {
          tradeStream?.registerMint(f.mint, { symbol, priceUsd });
          promoteTokenIfQualified(f.mint, priceUsd, now, wallet, "gmgn_research_ws");
          feedHub.broadcast({
            type: 'TRADE_TICK',
            mint: f.mint,
            trade: {
              at: now,
              timestamp: Math.floor(now / 1000),
              price: priceUsd,
              side: 'buy',
              wallet,
              usd: 25,
              signature: `gmgn_${now}`,
            },
            observedAt: now,
          });
        }
        if (targetLane instanceof DistributionProfit4Runtime && estMcap >= 10000 && estMcap <= 100000) {
          targetLane.register({
            mint: f.mint,
            wallet,
            symbol,
            timestamp: Math.floor(now / 1000),
            from: wallet,
            source: "gmgn_research_ws",
            priceUsd,
            marketCapUsd: estMcap,
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

controller.on("response", async (response) => {
  const url = response.url();
  if (url.includes("/api/v1/pairs/sol/new_pairs")) {
    try {
      const text = await response.text();
      const json = JSON.parse(text);
      const pairs = json.data?.pairs || [];
      const now = Date.now();
      for (const pair of pairs) {
        const info = pair.base_token_info;
        if (!info?.address) continue;
        const mint = String(info.address);
        const symbol = String(info.symbol || pair.symbol || "NEW_PAIR");
        const wallet = String(info.creator || pair.creator || "gmgn_new_pairs");
        const priceUsd = Number(info.price || pair.price || 0);
        const marketCapUsd = Number(info.market_cap || pair.market_cap || (priceUsd * 1_000_000_000));

        // Sesuai filter Tab 1 New Pairs: MC $10k - $100k
        if (marketCapUsd < 10000 || marketCapUsd > 100000) continue;

        candidateMeta.set(mint, { symbol, creator: wallet, originalSource: "gmgn_research_ws" });
        feedHub.broadcast({
          type: "CANDIDATE",
          source: "gmgn_research_ws",
          transfer: {
            mint,
            wallet,
            symbol,
            timestamp: Math.floor(now / 1000),
            from: wallet,
            source: "gmgn_research_ws",
            priceUsd: priceUsd > 0 ? priceUsd : undefined,
            marketCapUsd,
          },
          observedAt: now,
        });

        if (priceUsd > 0) {
          feedHub.broadcast({
            type: "TRADE_TICK",
            mint,
            trade: {
              at: now,
              timestamp: Math.floor(now / 1000),
              price: priceUsd,
              side: "buy",
              wallet,
              usd: 25,
              signature: `gmgn_pair_${now}`,
            },
            observedAt: now,
          });
        }
      }
    } catch {}
  }
});

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
      feedHub.broadcast({ type: 'HOLDER_FRAME', mint: state.watch.transfer.mint, body, observedAt });
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
        if (trade.timestamp) {
          feedHub.broadcast({
            type: 'TRADE_TICK',
            mint: trade.mint,
            trade: {
              at: observedAt,
              timestamp: trade.timestamp,
              price: trade.price,
              side: trade.side,
              wallet: trade.wallet,
              usd: trade.usd ?? null,
              signature: trade.signature,
            },
            observedAt,
          });
          targetLane.trade(trade.mint, {
            at: observedAt,
            timestamp: trade.timestamp,
            price: trade.price,
            side: trade.side,
            wallet: trade.wallet,
            usd: trade.usd ?? null,
            signature: trade.signature,
          });
        }
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
      if (![...details.values()].some((d) => d.watch.transfer.mint === mint)) {
        feedHub.broadcast({ type: 'DETAIL_CLOSED', mint, reason: 'DETAIL_CLOSED', observedAt: Date.now() });
        targetLane.end(mint, Date.now(), "DETAIL_CLOSED");
      }
    }
  });
}

async function openOrReplaceDetail(next: Transfer) {
  if (!next.source) next.source = "syndicate_inflow";
  const key = `${next.wallet}:${next.mint}:${next.tx || next.timestamp || ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  write("transfers.jsonl", { observedAt: Date.now(), ...next });

  if (useHeadlessStream && tradeStream) {
    targetLane.register(next, Date.now());
    tradeStream.registerMint(next.mint, {
      symbol: next.symbol,
      priceUsd: next.priceUsd,
      isVip: true,
    });
    gmgnWsManager.subscribeToken(next.mint, true).catch(() => {});
    write("watch-events.jsonl", {
      type: "TOKEN_MONITOR_HEADLESS_ATTACHED",
      observedAt: Date.now(),
      trackedWallet: next.wallet,
      transfer: next,
      mode: "headless-websocket",
      isVip: true,
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

await gmgnWsManager.init();

// Ensure controller tab preserves pure momentum filters on new_pair (prefix 9)
await controller.addInitScript(() => {
  try {
    const raw = localStorage.getItem("filter_query_map");
    let map = raw ? JSON.parse(raw) : {};
    const target = map["/trend2_sol"] || {};
    // Pure momentum filters: MC 10k to 100k
    target["9mim"] = "10";
    target["9mam"] = "100";
    target["9im"] = "1";
    // Strip any age, volume or liquidity overrides from prefix 9
    delete target["9mac"];
    delete target["9miv"];
    delete target["9iv"];
    delete target["9miqu"];
    delete target["9iqu"];
    delete target["9maqu"];
    delete target["9mic"];
    delete target["9minhhm"];
    delete target["9mihc"];
    delete target["9ihc"];
    map["/trend2_sol"] = target;
    map["trend2_sol"] = { ...target };
    localStorage.setItem("filter_query_map", JSON.stringify(map));
  } catch {}
});

await controller.goto(controllerTargetUrl, {
  waitUntil: "commit",
});

// Enforce again after load
await controller.evaluate(() => {
  try {
    const raw = localStorage.getItem("filter_query_map");
    let map = raw ? JSON.parse(raw) : {};
    const target = map["/trend2_sol"] || {};
    target["9mim"] = "10";
    target["9mam"] = "100";
    target["9im"] = "1";
    delete target["9mac"];
    delete target["9miv"];
    delete target["9iv"];
    delete target["9miqu"];
    delete target["9iqu"];
    delete target["9maqu"];
    delete target["9mic"];
    delete target["9minhhm"];
    delete target["9mihc"];
    delete target["9ihc"];
    map["/trend2_sol"] = target;
    map["trend2_sol"] = { ...target };
    localStorage.setItem("filter_query_map", JSON.stringify(map));
  } catch {}
});

// -------------------------------------------------------------
// TAB 2: GMGN TREND 20M FILTER INJECTION TAB
// -------------------------------------------------------------
let trendTargetUrl = `https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=trending`;
const trendConfigFile = join(process.cwd(), "config", "trend-filter-settings.json");
let trendFilters: Record<string, string> = {
  "0mic": "20",
  "0mim": "10000",
  "0mihc": "100",
  "0ihc": "1",
};

if (existsSync(trendConfigFile)) {
  try {
    const tcfg = JSON.parse(readFileSync(trendConfigFile, "utf8"));
    if (tcfg.feedUrl) trendTargetUrl = tcfg.feedUrl;
    if (tcfg.filters) {
      trendFilters = { ...trendFilters, ...tcfg.filters };
    }
  } catch {}
}

const trendTab = await context.newPage();

// Inject localStorage filter_query_map before loading page:
// Clean separation: prefix 9 for New Pair, prefix 0 for Trending
const applyTrendStorage = (fObj: Record<string, string>) => {
  try {
    const raw = localStorage.getItem("filter_query_map");
    let map = raw ? JSON.parse(raw) : {};

    const target = map["/trend2_sol"] || {};

    // 1. New Pair (Momentum): MC 10k-100k (prefix 9)
    target["9mim"] = "10";
    target["9mam"] = "100";
    target["9im"] = "1";

    // 2. Trending (Trend 20m): Age >= 20m, MC >= 10k, Holders >= 100 (prefix 0)
    // No max MC, no ATH MC
    target["0mic"] = fObj["0mic"] || "20";
    target["0mim"] = fObj["0mim"] || "10000";
    target["0mihc"] = fObj["0mihc"] || "100";
    target["0ihc"] = "1";
    delete target["0mam"];
    delete target["0minhhm"];
    delete target["0manhhm"];

    map["/trend2_sol"] = target;
    map["trend2_sol"] = { ...target };
    map["/trend_sol"] = { ...target };
    map["trend_sol"] = { ...target };

    localStorage.setItem("filter_query_map", JSON.stringify(map));
  } catch {}
};

await trendTab.addInitScript(applyTrendStorage, trendFilters);

await trendTab.goto(trendTargetUrl, {
  waitUntil: "commit",
});

// Re-verify and enforce localStorage in active tab
await trendTab.evaluate(applyTrendStorage, trendFilters);

// Bring controller (new_pair) to front so it is the active visible window
try {
  await controller.bringToFront();
} catch {}

attachCapture(
  trendTab,
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
      if (f.mint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(f.mint)) {
        const symbol = String(f.token?.symbol || (row as any).symbol || "GMGN_TREND");
        const wallet = String(f.token?.creator || (row as any).creator || "gmgn_trend");
        const rawPrice = Number(f.token?.price_usd || (row as any).price_usd || 0);
        const priceUsd = rawPrice > 0.000004 ? rawPrice : 0;
        candidateMeta.set(f.mint, { symbol, creator: wallet, originalSource: "gmgn_trend_ws" });
        if (priceUsd > 0) {
          tradeStream?.registerMint(f.mint, { symbol, priceUsd });
        }

        // Broadcast token candidate ke FeedHub untuk didistribusikan ke worker Trend20m
        feedHub.broadcast({
          type: "CANDIDATE",
          source: "gmgn_trend_ws",
          transfer: {
            mint: f.mint,
            wallet,
            symbol,
            timestamp: Math.floor(now / 1000),
            from: wallet,
            source: "gmgn_trend_ws",
            priceUsd: priceUsd > 0 ? priceUsd : undefined,
          },
          observedAt: now,
        });

        // Langsung subscribe ke WebSocket pool 'trend20m' dengan limit 10 dan max duration 2 jam
        gmgnWsManager.subscribeToken(f.mint, "trend20m", 7200).catch(() => {});

        // Hanya kirim TRADE_TICK jika harga asli valid (> 0.000004), jangan kirim fallback 0.000004 sebagai trade tick
        if (priceUsd > 0.000004) {
          feedHub.broadcast({
            type: "TRADE_TICK",
            mint: f.mint,
            trade: {
              at: now,
              timestamp: Math.floor(now / 1000),
              price: priceUsd,
              side: "buy",
              wallet,
              usd: 25,
              signature: `gmgn_trend_${now}`,
            },
            observedAt: now,
          });
        }
      }
    }
  }
);
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
      gmgnBrowserWs: {
        status: "ACTIVE",
        maxTokens: 30,
        vipCount: gmgnWsManager.getVipCount(),
        regularCount: gmgnWsManager.getRegularCount(),
        subscribedCount: gmgnWsManager.getSubscribedCount(),
        subscribedMints: gmgnWsManager.getSubscribedMints(),
      },
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
      gmgnSubscribedTokens: gmgnWsManager.getSubscribedMints(),
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
          "S1.2",
          "S5",
          "G2",
          "G2.1",
          "G2.2",
          "OZ1",
          "Safe",
          "Optimal",
          "Wide",
          "Swing 100k",
          "Wave Scalper",
          "Momentum V2",
          "Momentum V3",
          "R5 Band",
          "R5-v2 Band",
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
  smartMoneyStream?.stop();
  clearInterval(targetTimer);
  targetLane.shutdown(Date.now());
});
process.once("SIGTERM", () => {
  walletStream?.stop();
  smartMoneyStream?.stop();
  clearInterval(targetTimer);
  targetLane.shutdown(Date.now());
});
let heliusApiKey = process.env.HELIUS_API_KEY || "";
if (!heliusApiKey) {
  try {
    const envPath = join(process.cwd(), ".env");
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf8");
      const m = envContent.match(/HELIUS_API_KEY=([^\s\r\n]+)/);
      if (m) heliusApiKey = m[1].trim();
    }
  } catch {}
}
const solanaRpcWsUrl = heliusApiKey
  ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
  : "wss://api.mainnet-beta.solana.com";
const solanaRpcHttpUrl = heliusApiKey
  ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
  : "https://api.mainnet-beta.solana.com";
if (heliusApiKey) {
  console.log(`[helius-rpc] Activated dedicated Helius RPC for WebSocket & HTTP transactions`);
}

let walletStream: SolanaWalletStream | null = null;
if (useSolanaWalletWs) {
  walletStream = new SolanaWalletStream({
    rpcWsUrl: solanaRpcWsUrl,
    rpcHttpUrl: solanaRpcHttpUrl,
    maxWalletsPerSocket: 125,
    staggerMs: 30,
  });

  walletStream.on("rawActivity", () => {
    recordHourlyEvent("solanaWs");
  });

  walletStream.on("error", (err) => {
    console.warn(`[wallet-stream-error] ${err.message}`);
  });

function getSyndicateAirdropMeta(mint: string): { walletCount: number; tier: string } {
  try {
    const cachePath = join(process.cwd(), "data", "profit4-watch", "tx-cluster-cache.json");
    if (existsSync(cachePath)) {
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      const recipients = new Set<string>();
      for (const item of Object.values(cache) as any[]) {
        if (item && item.mint === mint && Array.isArray(item.recipients)) {
          for (const r of item.recipients) recipients.add(r);
        }
      }
      const count = recipients.size;
      let tier = "Pending / Unknown";
      if (count >= 8 && count < 56) tier = "Tier 1 (8-48 W)";
      else if (count >= 56 && count < 88) tier = "Tier 2 (56-80 W)";
      else if (count >= 88 && count < 120) tier = "Tier 3 (88-112 W)";
      else if (count >= 120) tier = "Tier 4 (120+ W)";
      return { walletCount: count, tier };
    }
  } catch {}
  return { walletCount: 0, tier: "Unknown" };
}

  walletStream.on("transfer", async (t) => {
    write("watch-events.jsonl", {
      type: "TARGET_TOKEN_REGISTERED",
      observedAt: Date.now(),
      mint: t.mint,
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
    const synMeta = getSyndicateAirdropMeta(t.mint);
    const candidate: Transfer = {
      wallet: t.wallet,
      mint: t.mint,
      symbol: t.symbol,
      timestamp: t.timestamp,
      priceUsd: t.priceUsd,
      amount: t.amount,
      from: t.from,
      tx: t.tx,
      source: "syndicate_inflow",
      syndicateWalletsCount: synMeta.walletCount,
      syndicateTier: synMeta.tier,
    };
    feedHub.broadcast({
      type: "CANDIDATE",
      source: "syndicate_inflow",
      transfer: candidate,
      observedAt: Date.now(),
    });
    await openOrReplaceDetail(candidate);
  });

  walletStream.on("sell", (s) => {
    feedHub.broadcast({
      type: "TRACKED_WALLET_SOLD",
      source: "syndicate",
      mint: s.mint,
      wallet: s.wallet,
      observedAt: Date.now(),
    });
    write("watch-events.jsonl", {
      type: "TRACKED_WALLET_SOLD",
      observedAt: Date.now(),
      trackedWallet: s.wallet,
      mint: s.mint,
      tx: s.tx,
      source: "solana_rpc_ws",
    });
    // Pemicu On-Chain Balance Sensor: Beri tahu seluruh active lanes bahwa wallet sindikat menjual!
    (targetLane as any).onTrackedWalletSold?.(s.mint, s.wallet, Date.now());

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

// ========================================================
// DEDICATED TRACKER 117 SMART MONEY WALLETS
// ========================================================
const SMART_MONEY_BLACKLIST_SYMBOLS = new Set([
  "CASH", "USDC", "USDT", "USDS", "SOL", "WSOL", "BSOL", "JITOSOL", "JUP", "KMNO", "EURC", "WBTC", "WETH",
  "RAY", "MSOL", "BONK", "WIF", "TRUMP", "JUPUSD", "USD1"
]);

let smartMoneyStream: SolanaWalletStream | null = null;
const smartWalletsSet = getSmartWalletsWatchlist();
smartWalletsSet.add(OEZANK_WALLET);
const smartAddresses = [...smartWalletsSet];
const seenSmartTrades = new Set<string>();

if (useSolanaWalletWs && smartAddresses.length > 0) {
  smartMoneyStream = new SolanaWalletStream({
    rpcWsUrl: solanaRpcWsUrl,
    rpcHttpUrl: solanaRpcHttpUrl,
    maxWalletsPerSocket: 125,
    staggerMs: 30,
  });

  smartMoneyStream.on("rawActivity", () => {
    recordHourlyEvent("solanaWs");
  });

  smartMoneyStream.on("error", (err) => {
    console.warn(`[smart-money-error] ${err.message}`);
  });

  smartMoneyStream.on("transfer", async (t) => {
    recordHourlyEvent("transfer");
    const sym = (t.symbol || "").toUpperCase();
    if (SMART_MONEY_BLACKLIST_SYMBOLS.has(sym)) {
      return;
    }
    const isOezank = t.wallet === OEZANK_WALLET;
    // Anti-Dust Filter khusus Oezank: Real trades Oezank adalah >= 0.05 SOL (~$6-$25 USD).
    // Abaikan swap micro-dust / test ping (0.0002 SOL / $0.02 USD)
    if (isOezank && t.solSpent !== undefined && t.solSpent < 0.05) {
      return;
    }
    // Anti-Dust Filter khusus Smart Money Inflow: Minimal $50 USD atau 0.35 SOL
    if (!isOezank) {
      if (t.solSpent !== undefined && t.solSpent < 0.35) return;
      if (t.amount !== undefined && t.priceUsd !== undefined && (t.amount * t.priceUsd) < 50.0) return;
    }
    const sourceTag = isOezank ? "oezank_inflow" : "smart_money_inflow";
    const statusTag = isOezank ? "EVALUATING_OZ1_LANE" : "EVALUATING_G2_LANES";
    const eventType = isOezank ? "OEZANK_TRADER_BUY_DETECTED" : "SMART_MONEY_WHALE_TRANSFER_IN";

    if (isOezank) {
      console.log(`[oezank-tracker] 🇮🇩 Trader Oezank IDC bought/transferred ${t.symbol || t.mint.slice(0, 6)}`);
    } else {
      console.log(`[smart-money-ws] 🐋 Whale ${t.wallet.slice(0, 6)}.. bought/transferred ${t.symbol || t.mint.slice(0, 6)}`);
    }

    const calculatedCostUsd = (t.amount !== undefined && t.priceUsd !== undefined && t.amount > 0 && t.priceUsd > 0)
      ? t.amount * t.priceUsd
      : (t.solSpent ? t.solSpent * 150 : 50);

    const smartCandidate: Transfer = {
      wallet: t.wallet,
      mint: t.mint,
      symbol: t.symbol || (isOezank ? "OEZANK" : "SMART"),
      timestamp: t.timestamp || Math.floor(Date.now() / 1000),
      priceUsd: t.priceUsd,
      amount: t.amount,
      costUsd: calculatedCostUsd,
      solSpent: t.solSpent,
      from: t.from,
      tx: t.tx,
      source: sourceTag,
    };
    pushActiveDetail({
      mint: t.mint,
      symbol: t.symbol || (isOezank ? "OEZANK" : "SMART"),
      wallet: t.wallet,
      openedAt: Date.now(),
      source: sourceTag,
      priceUsd: t.priceUsd,
      tx: t.tx,
      status: statusTag,
    });
    write("watch-events.jsonl", {
      type: eventType,
      observedAt: Date.now(),
      wallet: t.wallet,
      mint: t.mint,
      amount: t.amount,
      costUsd: calculatedCostUsd,
      tx: t.tx,
      source: sourceTag,
    });
    feedHub.broadcast({
      type: "CANDIDATE",
      source: sourceTag,
      transfer: smartCandidate,
      observedAt: Date.now(),
    });
    if (t.priceUsd && t.priceUsd > 0) {
      feedHub.broadcast({
        type: "TRADE_TICK",
        mint: t.mint,
        trade: {
          at: Date.now(),
          timestamp: Math.floor(Date.now() / 1000),
          price: t.priceUsd,
          side: "buy",
          wallet: t.wallet,
          usd: calculatedCostUsd,
          signature: t.tx || `sm_${Date.now()}`,
        },
        observedAt: Date.now(),
      });
    }
    if (useHeadlessStream && tradeStream) {
      tradeStream.registerMint(t.mint, {
        symbol: t.symbol,
        priceUsd: t.priceUsd,
        isVip: true,
      });
    }
    if (targetLane instanceof DistributionProfit4Runtime) {
      targetLane.register(smartCandidate, Date.now());
      if (t.priceUsd && t.priceUsd > 0) {
        targetLane.trade(t.mint, {
          at: Date.now(),
          timestamp: Math.floor(Date.now() / 1000),
          price: t.priceUsd,
          side: "buy",
          wallet: t.wallet,
          usd: calculatedCostUsd,
          signature: t.tx || `sm_${Date.now()}`,
        });
      }
    }
    write("transfers.jsonl", smartCandidate);
    gmgnWsManager.subscribeToken(t.mint, true).catch(() => {});
  });

  smartMoneyStream.on("sell", (s) => {
    const isOezank = s.wallet === OEZANK_WALLET;
    feedHub.broadcast({
      type: "TRACKED_WALLET_SOLD",
      source: isOezank ? "oezank" : "smart_money",
      mint: s.mint,
      wallet: s.wallet,
      observedAt: Date.now(),
    });
    write("watch-events.jsonl", {
      type: isOezank ? "OEZANK_TRADER_SOLD" : "SMART_MONEY_WHALE_SOLD",
      observedAt: Date.now(),
      trackedWallet: s.wallet,
      mint: s.mint,
      tx: s.tx,
      source: "solana_rpc_ws",
    });
    if (isOezank) {
      console.log(`[oezank-tracker] 🚨 Oezank IDC sold token ${s.mint.slice(0, 6)}.. Triggering mirror exit!`);
      (targetLane as any).onTrackedWalletSold?.(s.mint, s.wallet, Date.now());
    }
  });

  void smartMoneyStream.start(smartAddresses);
  process.once("exit", () => smartMoneyStream?.stop());
}
let nextWallet = 0;
let nextSmartWallet = 0;
let loopCounter = 0;
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
        (targetLane as any).onTrackedWalletSold?.(tracked.watch.transfer.mint, wallet, Date.now());
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

    // Dedicated periodic poller for Smart Money Wallets & Oezank
    if (smartAddresses.length > 0 && loopCounter++ % 3 === 2) {
      const pollOezankPriority = loopCounter % 9 === 0;
      const sw = pollOezankPriority ? OEZANK_WALLET : smartAddresses[nextSmartWallet];
      if (!pollOezankPriority) {
        nextSmartWallet = (nextSmartWallet + 1) % smartAddresses.length;
      }
      try {
        const swUrl = `/vas/api/v1/wallet_activity/sol?wallet=${sw}&limit=10&cost=usd`;
        const swRes = await controller.evaluate(fetchSingleWalletActivity, { url: swUrl });
        if (swRes && swRes.valid && swRes.body?.data?.activities) {
          const nowSec = Math.floor(Date.now() / 1000);
          const isOezank = sw === OEZANK_WALLET;
          const sourceTag = isOezank ? "oezank_inflow" : "smart_money_inflow";
          const statusTag = isOezank ? "EVALUATING_OZ1_LANE" : "EVALUATING_G2_LANES";
          const eventType = isOezank ? "OEZANK_TRADER_BUY_DETECTED" : "SMART_MONEY_POLL_BUY_DETECTED";

          for (const act of swRes.body.data.activities as any[]) {
            const ev = String(act.event_type || act.event || "").toLowerCase();
            if (ev === "buy" || ev === "swap_buy") {
              const ts = Number(act.timestamp) || nowSec;
              // Hanya proses transaksi baru (< 5 menit / 300 detik)
              if (nowSec - ts > 300) continue;

              const symbol = String(act.token?.symbol || (isOezank ? "OEZANK" : "SMART"));
              if (SMART_MONEY_BLACKLIST_SYMBOLS.has(symbol.toUpperCase())) continue;

              const mint = String(act.token?.address || act.token_address || "");
              const costUsd = Number(act.cost_usd || (isOezank ? 0 : 50));
              // Anti-Dust Filter: Abaikan micro-swap Oezank < $5 USD
              if (isOezank && costUsd > 0 && costUsd < 5.0) continue;
              // Anti-Dust Filter: Abaikan micro-swap Smart Money < $50 USD
              if (!isOezank && costUsd > 0 && costUsd < 50.0) continue;

              const key = `${sw}:${mint}:${ts}`;
              if (mint && !seenSmartTrades.has(key)) {
                seenSmartTrades.add(key);
                const amount = Number(act.token_amount || act.amount || 0);
                const priceUsd = Number(act.price_usd || (costUsd > 0 && amount > 0 ? costUsd / amount : 0));
                if (priceUsd <= 0) continue;

                if (isOezank) {
                  console.log(`[oezank-poller] 🇮🇩 Trader Oezank IDC bought ${symbol} ($${costUsd.toFixed(1)})`);
                } else {
                  console.log(`[smart-wallet-poller] Whale ${sw.slice(0, 6)}.. bought ${symbol} ($${costUsd.toFixed(1)})`);
                }

                pushActiveDetail({
                  mint,
                  symbol,
                  wallet: sw,
                  openedAt: Date.now(),
                  source: sourceTag,
                  priceUsd,
                  tx: act.tx_hash,
                  status: statusTag,
                });
                write("watch-events.jsonl", {
                  type: eventType,
                  observedAt: Date.now(),
                  wallet: sw,
                  mint,
                  symbol,
                  costUsd,
                  priceUsd,
                  tx: act.tx_hash,
                  source: sourceTag,
                });
                const swCandidate: Transfer = {
                  wallet: sw,
                  mint,
                  symbol,
                  timestamp: ts,
                  priceUsd,
                  amount: Number(amount),
                  costUsd,
                  tx: act.tx_hash,
                  source: sourceTag,
                };
                write("transfers.jsonl", swCandidate);
                feedHub.broadcast({
                  type: "CANDIDATE",
                  source: sourceTag,
                  transfer: swCandidate,
                  observedAt: Date.now(),
                });
                if (priceUsd > 0) {
                  feedHub.broadcast({
                    type: "TRADE_TICK",
                    mint,
                    trade: {
                      at: Date.now(),
                      timestamp: ts,
                      price: priceUsd,
                      side: "buy",
                      wallet: sw,
                      usd: costUsd,
                      signature: act.tx_hash || `sm_poll_${ts}`,
                    },
                    observedAt: Date.now(),
                  });
                }
                if (targetLane instanceof DistributionProfit4Runtime) {
                  targetLane.register(swCandidate, Date.now());
                  if (priceUsd > 0) {
                    targetLane.trade(mint, {
                      at: Date.now(),
                      timestamp: ts,
                      price: priceUsd,
                      side: "buy",
                      wallet: sw,
                      usd: costUsd,
                      signature: act.tx_hash || `sm_poll_${ts}`,
                    });
                  }
                }
                if (useHeadlessStream && tradeStream) {
                  tradeStream.registerMint(mint, { symbol, priceUsd, isVip: true });
                }
                gmgnWsManager.subscribeToken(mint, true).catch(() => {});
              }
            } else if (ev === "sell" || ev === "swap_sell") {
              const mint = String(act.token?.address || act.token_address || "");
              if (mint) {
                if (isOezank) {
                  console.log(`[oezank-poller] 🚨 Oezank IDC sold token ${mint.slice(0, 6)}.. Triggering mirror exit!`);
                }
                feedHub.broadcast({
                  type: "TRACKED_WALLET_SOLD",
                  source: isOezank ? "oezank" : "smart_money",
                  mint,
                  wallet: sw,
                  observedAt: Date.now(),
                });
                if (targetLane instanceof DistributionProfit4Runtime) {
                  targetLane.onTrackedWalletSold(mint, sw, Date.now());
                }
              }
            }
          }
        }
      } catch {}
    }
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
smartMoneyStream?.stop();
targetLane.shutdown(Date.now());
if (profit4) {
  await context.close();
  logWriter.close();
}
