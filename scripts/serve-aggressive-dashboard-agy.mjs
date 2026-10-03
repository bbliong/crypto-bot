#!/usr/bin/env node
import { createServer } from 'node:http';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  initCryptoDb,
  getRuns as getSqliteRuns,
  upsertRun as upsertSqliteRun,
  getTrades as getSqliteTrades,
  upsertTrade as upsertSqliteTrade,
  getRealTrades as getSqliteRealTrades,
  upsertRealTrade as upsertSqliteRealTrade,
  getRouteQuotes as getSqliteRouteQuotes,
  getSetting as getSqliteSetting,
  setSetting as setSqliteSetting,
  getWibSlot,
} from './crypto-db.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');
const researchDir = join(projectRoot, 'research');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    port: Number(process.env.AGGRESSIVE_DASHBOARD_PORT || 4180),
    host: process.env.AGGRESSIVE_DASHBOARD_HOST || '0.0.0.0',
    runFolder: process.env.AGGRESSIVE_RUN_FOLDER || null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) options.port = Number(args[++i]);
    else if (args[i].startsWith('--port=')) options.port = Number(args[i].split('=')[1]);
    else if (args[i] === '--host' && args[i + 1]) options.host = args[++i];
    else if (args[i].startsWith('--host=')) options.host = args[i].split('=')[1];
    else if (args[i] === '--run' && args[i + 1]) options.runFolder = args[++i];
    else if (args[i].startsWith('--run=')) options.runFolder = args[i].split('=')[1];
  }
  return options;
}

const opts = parseArgs();

let cachedRuns = null;
let lastRunsScanAt = 0;

function formatWibDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
    const wibTime = new Date(d.getTime() + WIB_OFFSET_MS);
    const hour = wibTime.getUTCHours();
    const minute = wibTime.getUTCMinutes();
    const dateStr = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' });
    const slotStart = Math.floor(hour / 3) * 3;
    const slotEnd = slotStart + 3;
    const slotRange = `${String(slotStart).padStart(2, '0')}.00 - ${String(slotEnd).padStart(2, '0')}.00 WIB`;
    const startDetail = (minute === 0 && hour % 3 === 0)
      ? ''
      : ` (mulai ${d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false })})`;
    return `${dateStr}, ${slotRange}${startDetail}`;
  } catch {
    return String(iso);
  }
}

function formatWibTime(msOrIso) {
  try {
    const d = new Date(msOrIso);
    if (isNaN(d.getTime())) return String(msOrIso);
    return d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short' }) + ', ' +
      d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' WIB';
  } catch {
    return String(msOrIso);
  }
}

const linesCache = new Map();
function countLinesFast(filePath) {
  if (!existsSync(filePath)) return 0;
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return 0;
    const cached = linesCache.get(filePath);
    if (cached && cached.size === stat.size) {
      return cached.count;
    }
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(64 * 1024);
    let count = 0;
    let bytesRead = 0;
    while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 10) count++;
      }
    }
    closeSync(fd);
    linesCache.set(filePath, { size: stat.size, count });
    return count;
  } catch {
    return 0;
  }
}

function findAggressiveRuns(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedRuns && (now - lastRunsScanAt < 5_000)) {
    return cachedRuns;
  }

  const currentSlot = getWibSlot(new Date(), 3);
  const currentLiveSlotId = currentSlot.runId;

  try {
    const sqliteRuns = getSqliteRuns();
    const realCounts = new Map();
    try {
      const db = initCryptoDb();
      const rows = db.prepare('SELECT run_id, COUNT(*) as c FROM real_trades GROUP BY run_id').all();
      for (const row of rows) realCounts.set(row.run_id, row.c);
    } catch {}

    const sortedRuns = [...sqliteRuns].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    let liveRun = sortedRuns.find(r => r.id === currentLiveSlotId);
    if (!liveRun) {
      const liveRunDir = join(researchDir, currentLiveSlotId);
      liveRun = {
        id: currentLiveSlotId,
        path: liveRunDir,
        startedAt: currentSlot.slotStartDate.toISOString(),
        tradesCount: 0,
        isLive: true,
      };
    }

    const otherRuns = sortedRuns.filter(r => r.id !== currentLiveSlotId);
    const combinedRuns = [
      { ...liveRun, isLive: true },
      ...otherRuns.map(r => ({ ...r, isLive: false }))
    ];

    cachedRuns = combinedRuns.map(r => {
      const dateFormatted = formatWibDate(r.startedAt);
      const tradesText = r.tradesCount > 0 ? ` (${r.tradesCount} Trades)` : '';
      const realCount = realCounts.get(r.id) || 0;
      const realText = realCount > 0 ? ` • 💳 ${realCount} Real Tx` : '';
      return {
        id: r.id,
        path: r.path,
        startedAt: r.startedAt,
        tradesCount: r.tradesCount,
        realTradesCount: realCount,
        isLive: r.isLive,
        friendlyLabel: r.isLive
          ? `🔴 [LIVE] ${dateFormatted}${tradesText}${realText}`
          : `📁 [ARSIP] ${dateFormatted}${tradesText}${realText}`
      };
    });
    lastRunsScanAt = now;
    return cachedRuns;
  } catch (err) {
    console.error('Error fetching runs from SQLite:', err);
  }

  return [];
}

function readLastJsonLines(filePath, maxLines = 100) {
  if (!existsSync(filePath)) return [];
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return [];
    const readSize = Math.min(stat.size, 256 * 1024);
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, stat.size - readSize);
    closeSync(fd);
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);
    const targetLines = lines.slice(-maxLines);
    return targetLines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf8');
    return content.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

const autoBuyConfigFile = join(projectRoot, 'config', 'autobuy-settings.json');

function readAutoBuyConfig() {
  const defaultCfg = {
    enabled: false,
    activeLane: 'aggressive-safe',
    stakeMode: 'usd',
    stakeUsd: 0.5,
    stakeSol: 0.03,
    maxBuys: 0, // 0 = unlimited / terus berjalan
    buysCompleted: 0,
    maxActiveRealPositions: 1,
    slippagePercent: 15,
    buySlippagePercent: 9,
    sellSlippagePercent: 14,
    minSolReserve: 0.025,
    priorityFeeSol: 0.0001,
    tipFeeSol: 0.0001,
    maxAutoPriorityFeeSol: 0.0001,
    antiMev: false,
    autoSell: true,
    updatedAt: new Date().toISOString(),
  };
  if (existsSync(autoBuyConfigFile)) {
    try {
      const raw = JSON.parse(readFileSync(autoBuyConfigFile, 'utf8'));
      const merged = { ...defaultCfg, ...raw };
      try { setSqliteSetting('autobuy_settings', merged); } catch {}
      return merged;
    } catch {}
  }

  try {
    const sqliteCfg = getSqliteSetting('autobuy_settings');
    if (sqliteCfg && typeof sqliteCfg === 'object') {
      return { ...defaultCfg, ...sqliteCfg };
    }
  } catch {}

  return defaultCfg;
}

function writeAutoBuyConfig(newCfg) {
  const current = readAutoBuyConfig();
  const merged = {
    ...current,
    ...newCfg,
    updatedAt: new Date().toISOString(),
  };
  try {
    setSqliteSetting('autobuy_settings', merged);
  } catch {}
  writeFileSync(autoBuyConfigFile, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

const feedConfigFile = join(projectRoot, 'config', 'feed-settings.json');

const MC_PRESET_MAP = {
  '10k-100k': { min: 10000, max: 100000, label: '🌊 $10k - $100k (Swing 100k - Rekomendasi)' },
  '5.5k-15k': { min: 5500, max: 15000, label: '⚡ $5.5k - $15k (Micro Fast Scalp)' },
  '15k-50k': { min: 15000, max: 50000, label: '🚀 $15k - $50k (Mid Micro Pump)' },
  '20k-100k': { min: 20000, max: 100000, label: '🛡️ $20k - $100k (Safe Cap Swing)' },
  '50k-250k': { min: 50000, max: 250000, label: '💎 $50k - $250k (Higher Cap Runner)' },
  'all': { min: 0, max: 10000000, label: '🌐 Semua / Tanpa Filter MC' },
};

function readFeedSettings() {
  const defaultSettings = {
    feedUrl: 'https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=new_pair',
    feedUrlPreset: 'https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=new_pair',
    mcPreset: '10k-100k',
    minMarketCapUsd: 10000,
    maxMarketCapUsd: 100000,
    updatedAt: new Date().toISOString(),
  };
  if (existsSync(feedConfigFile)) {
    try {
      const raw = JSON.parse(readFileSync(feedConfigFile, 'utf8'));
      return { ...defaultSettings, ...raw };
    } catch {}
  }
  return defaultSettings;
}

function writeFeedSettings(newSettings) {
  const current = readFeedSettings();
  const mcPreset = newSettings.mcPreset || current.mcPreset || '10k-100k';
  const mcRange = MC_PRESET_MAP[mcPreset] || { min: 10000, max: 100000 };
  const merged = {
    ...current,
    ...newSettings,
    mcPreset,
    minMarketCapUsd: mcRange.min,
    maxMarketCapUsd: mcRange.max,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(feedConfigFile, JSON.stringify(merged, null, 2), 'utf8');

  // Also update config/rules.yaml feedUrl if present
  try {
    const rulesYamlPath = join(projectRoot, 'config', 'rules.yaml');
    if (existsSync(rulesYamlPath)) {
      let yaml = readFileSync(rulesYamlPath, 'utf8');
      yaml = yaml.replace(/^feedUrl:.*$/m, `feedUrl: ${merged.feedUrl}`);
      writeFileSync(rulesYamlPath, yaml, 'utf8');
    }
  } catch {}

  return merged;
}

function getWorkerServiceStatus() {
  try {
    const out = execSync('systemctl --user show crypto-bot-aggressive.service --property=ActiveState,SubState,MainPID', { encoding: 'utf8', timeout: 5000 });
    const props = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
    const active = props.ActiveState === 'active';
    return {
      active,
      activeState: props.ActiveState || 'inactive',
      subState: props.SubState || 'dead',
      mainPid: props.MainPID && props.MainPID !== '0' ? props.MainPID : null,
      status: props.ActiveState || 'inactive',
    };
  } catch (err) {
    return { active: false, status: 'inactive', activeState: 'inactive', subState: 'dead', mainPid: null };
  }
}

function controlWorkerService(action) {
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Aksi tidak valid: ' + action);
  execSync(`systemctl --user ${action} crypto-bot-aggressive.service`, { encoding: 'utf8', timeout: 15000 });
  return getWorkerServiceStatus();
}

let cachedSolBalance = null;
let lastBalanceFetchTime = 0;
let cachedSolPrice = 117.71;
let lastSolPriceFetchTime = 0;

async function getLiveSolPriceUsd() {
  const now = Date.now();
  if (now - lastSolPriceFetchTime < 30_000) return cachedSolPrice;
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const data = await res.json();
      const p = parseFloat(data.price);
      if (p > 0) {
        cachedSolPrice = p;
        lastSolPriceFetchTime = now;
      }
    }
  } catch {}
  return cachedSolPrice;
}

async function getSolanaBalance(walletAddress) {
  const now = Date.now();
  if (cachedSolBalance && (now - lastBalanceFetchTime < 15_000)) {
    return cachedSolBalance;
  }
  if (!walletAddress) return { sol: 0, lamports: 0, solPriceUsd: 117.71, usdValue: 0 };
  const rpcs = [
    'https://api.mainnet-beta.solana.com',
    'https://solana-mainnet.g.alchemy.com/v2/demo',
    'https://rpc.ankr.com/solana'
  ];
  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [walletAddress]
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.result?.value == null) continue;
      const lamports = Number(data.result.value);
      const sol = Number((lamports / 1e9).toFixed(4));
      const solPriceUsd = await getLiveSolPriceUsd();
      const usdValue = Number((sol * solPriceUsd).toFixed(2));
      cachedSolBalance = { sol, lamports, solPriceUsd, usdValue, updatedAt: new Date().toISOString() };
      lastBalanceFetchTime = now;
      return cachedSolBalance;
    } catch {
      continue;
    }
  }
  if (cachedSolBalance) return cachedSolBalance;
  return { sol: 0, lamports: 0, solPriceUsd: 117.71, usdValue: 0, error: 'Semua RPC timeout' };
}

function getActiveWalletAddress(runDir) {
  if (runDir) {
    const auditFile = join(runDir, 'order-api-audit.jsonl');
    if (existsSync(auditFile)) {
      try {
        const text = readFileSync(auditFile, 'utf8');
        const match = text.match(/\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
        if (match && match[1]) return match[1];
      } catch {}
    }
  }
  try {
    if (existsSync(researchDir)) {
      const entries = readdirSync(researchDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name));
      for (const e of entries.slice(0, 5)) {
        const f = join(researchDir, e.name, 'order-api-audit.jsonl');
        if (existsSync(f)) {
          const text = readFileSync(f, 'utf8');
          const match = text.match(/\/smartmoney\/sol\/walletstat\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
          if (match && match[1]) return match[1];
        }
      }
    }
  } catch {}
  return 'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6';
}

let cachedRentInfo = null;
let lastRentInfoFetchTime = 0;

async function getReclaimableRentInfo(walletAddress) {
  const now = Date.now();
  if (cachedRentInfo && (now - lastRentInfoFetchTime < 15_000)) {
    return cachedRentInfo;
  }
  try {
    const { scanEmptyTokenAccounts, getKeypair } = await import('./solana-rent-reclaimer.mjs');
    const { Connection } = await import('@solana/web3.js');
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const scan = await scanEmptyTokenAccounts(connection, walletAddress);
    const keypair = getKeypair();
    cachedRentInfo = {
      emptyCount: scan.emptyCount,
      totalReclaimableSol: scan.totalReclaimableSol,
      totalReclaimableUsd: Number((scan.totalReclaimableSol * 117.71).toFixed(2)),
      hasPrivateKey: !!keypair,
      accounts: scan.emptyAccounts.map(a => ({ pubkey: a.pubkey, mint: a.mint, rentSol: a.rentSol }))
    };
    lastRentInfoFetchTime = now;
    return cachedRentInfo;
  } catch (err) {
    if (cachedRentInfo) return cachedRentInfo;
    return { emptyCount: 0, totalReclaimableSol: 0, totalReclaimableUsd: 0, hasPrivateKey: false, error: err.message };
  }
}

function getRealExecutedTrades(runDir, closedTrades = [], metadataByMint = new Map(), isLive = false) {
  const runId = basename(runDir);
  const ledgerPath = join(runDir, 'live-trade-ledger.jsonl');

  if (!isLive || !existsSync(ledgerPath)) {
    try {
      const sqliteTrades = getSqliteRealTrades(runId);
      if (sqliteTrades && sqliteTrades.length > 0) {
        return sqliteTrades;
      }
    } catch {}
  }

  const autoBuyCfg = readAutoBuyConfig();
  const configStake = Number(autoBuyCfg.stakeUsd) > 0 ? Number(autoBuyCfg.stakeUsd) : 0.5;

  const eventsPath = join(runDir, 'events.jsonl');
  const payloadsPath = join(runDir, 'order-api-payloads.jsonl');

  const ledgerRows = readJsonLines(ledgerPath);
  const eventRows = readJsonLines(eventsPath);
  const payloadRows = existsSync(payloadsPath) ? readJsonLines(payloadsPath) : [];

  const buyOrders = [];
  const sellOrders = [];
  const walletSnapshotsByMint = new Map();

  for (const row of ledgerRows) {
    if (row.type === 'LIVE_ORDER_SUBMITTED') {
      if (row.side === 'BUY') buyOrders.push(row);
      else if (row.side === 'SELL') sellOrders.push(row);
    } else if (row.type === 'GMGN_WALLETSTAT_SNAPSHOT') {
      if (row.token) {
        const snaps = walletSnapshotsByMint.get(row.token) || [];
        snaps.push(row);
        walletSnapshotsByMint.set(row.token, snaps);
      }
    }
  }

  for (const ev of eventRows) {
    if (ev.type === 'BROWSER_BUY_SUBMITTED' || ev.type === 'BROWSER_BUY_NOT_SUBMITTED') {
      if (!buyOrders.some(b => b.mint === ev.mint && Math.abs(b.observedAt - ev.observedAt) < 2000)) {
        buyOrders.push({
          type: 'LIVE_ORDER_SUBMITTED',
          side: 'BUY',
          mint: ev.mint,
          paperLane: ev.paperLane,
          observedAt: ev.observedAt,
          orderId: ev.result?.orderId ?? null,
          hash: ev.result?.hash ?? null,
          acquiredAmount: ev.result?.acquiredAmount ?? null,
          acquiredDecimals: ev.result?.acquiredDecimals ?? null,
          ok: ev.result?.ok ?? (ev.type === 'BROWSER_BUY_SUBMITTED'),
          status: ev.result?.status ?? null,
          code: ev.result?.code ?? null,
          message: ev.result?.message ?? null,
          stakeUsd: ev.stakeUsd ?? configStake,
        });
      }
    } else if (ev.type === 'BROWSER_SELL_SUBMITTED' || ev.type === 'BROWSER_SELL_NOT_SUBMITTED') {
      if (!sellOrders.some(s => s.mint === ev.mint && Math.abs(s.observedAt - ev.observedAt) < 2000)) {
        sellOrders.push({
          type: 'LIVE_ORDER_SUBMITTED',
          side: 'SELL',
          mint: ev.mint,
          paperLane: ev.paperLane,
          originLane: ev.originLane ?? ev.paperLane,
          observedAt: ev.observedAt,
          orderId: ev.result?.orderId ?? null,
          hash: ev.result?.hash ?? null,
          ok: ev.result?.ok ?? (ev.type === 'BROWSER_SELL_SUBMITTED'),
          status: ev.result?.status ?? null,
          code: ev.result?.code ?? null,
          message: ev.result?.message ?? null,
        });
      }
    }
  }

  const payloadsByMint = new Map();
  for (const p of payloadRows) {
    for (const [mint] of metadataByMint) {
      if ((p.url && p.url.includes(mint)) || (p.bodyText && p.bodyText.includes(mint))) {
        const list = payloadsByMint.get(mint) || [];
        list.push(p);
        payloadsByMint.set(mint, list);
      }
    }
  }

  const realTrades = [];

  for (const buy of buyOrders) {
    const mint = buy.mint;
    const snaps = walletSnapshotsByMint.get(mint) || [];
    const snapSymbol = snaps.find(s => s.symbol)?.symbol;
    const snapName = snaps.find(s => s.name)?.name;
    const meta = metadataByMint.get(mint) || {};
    const symbol = snapSymbol || meta.symbol || buy.symbol || (mint ? mint.slice(0, 6) : 'Unknown');
    const name = snapName || meta.name || symbol;
    const lane = buy.originLane || buy.paperLane || 'aggressive-optimal';
    const laneLabel = lane === 'r5-band' ? 'Momentum R5 Band' : lane === 'momentum-v3' ? 'Momentum V3' : lane === 'momentum-v2' ? 'Momentum V2' : lane === 'aggressive-wide' ? 'Wide Aggressive' : lane === 'aggressive-optimal' ? 'Optimal Aggressive' : lane === 'aggressive-safe' ? 'Safe Aggressive' : 'Raw Aggressive';

    const matchingSell = sellOrders.find(s => s.mint === mint && s.observedAt >= buy.observedAt);
    const paperTrade = closedTrades.find(c => c.mint === mint && (c.lane === lane || !c.lane));

    const postBuySnap = snaps.find(s => s.stage === 'POST_BUY');
    const postSellSnap = [...snaps].reverse().find(s => s.stage === 'POST_SELL' || s.stage === 'RETRY_SELL');

    const walletBuyCost = postSellSnap?.historyBoughtCostUsd ?? postBuySnap?.historyBoughtCostUsd ?? buy.stakeUsd ?? configStake;
    const walletSoldIncome = postSellSnap?.historySoldIncomeUsd ?? null;
    const walletPnlUsd = postSellSnap?.grossPnlUsd ?? (walletSoldIncome != null ? walletSoldIncome - walletBuyCost : null);
    const walletPnlPercent = postSellSnap?.grossPnlPercent ?? (walletPnlUsd != null && walletBuyCost > 0 ? (walletPnlUsd / walletBuyCost) * 100 : null);

    const theoryReturnPercent = paperTrade ? paperTrade.socketReturnPercent : null;
    const actualReturnPercent = walletPnlPercent != null ? walletPnlPercent : (matchingSell?.ok && paperTrade ? paperTrade.realReturnPercent : null);
    const slippageDiffPercent = (theoryReturnPercent != null && actualReturnPercent != null) ? (actualReturnPercent - theoryReturnPercent) : null;

    const tradeItem = {
      runId,
      mint,
      symbol,
      name,
      lane,
      laneLabel,
      buy: {
        time: buy.observedAt,
        timeFormatted: formatWibTime(buy.observedAt),
        ok: buy.ok,
        status: buy.status,
        code: buy.code,
        message: buy.message,
        orderId: buy.orderId,
        hash: buy.hash,
        solscanUrl: buy.hash ? `https://solscan.io/tx/${buy.hash}` : null,
        stakeUsd: buy.stakeUsd,
        tokenPriceUsd: buy.tokenPriceUsd,
        acquiredAmount: buy.acquiredAmount,
        acquiredDecimals: buy.acquiredDecimals,
        payloads: (payloadsByMint.get(mint) || []).filter(p => p.type === 'ORDER_REQUEST_PAYLOAD' || p.type === 'SOLANA_RPC_REQUEST_PAYLOAD').slice(-3),
      },
      sell: matchingSell ? {
        time: matchingSell.observedAt,
        timeFormatted: formatWibTime(matchingSell.observedAt),
        ok: matchingSell.ok,
        status: matchingSell.status,
        code: matchingSell.code,
        message: matchingSell.message,
        orderId: matchingSell.orderId,
        hash: matchingSell.hash,
        solscanUrl: matchingSell.hash ? `https://solscan.io/tx/${matchingSell.hash}` : null,
        inputAmount: matchingSell.inputAmount,
        tokenPriceUsd: matchingSell.tokenPriceUsd,
        payloads: (payloadsByMint.get(mint) || []).filter(p => p.type === 'ORDER_REQUEST_PAYLOAD' || p.type === 'SOLANA_RPC_REQUEST_PAYLOAD').slice(-3),
      } : null,
      status: matchingSell ? (matchingSell.ok ? 'COMPLETED' : 'SELL_FAILED') : (buy.ok ? 'HOLDING' : 'BUY_FAILED'),
      durationSec: matchingSell ? Math.max(1, Math.round((matchingSell.observedAt - buy.observedAt) / 1000)) : Math.max(1, Math.round((Date.now() - buy.observedAt) / 1000)),
      theoryReturnPercent,
      actualReturnPercent,
      slippageDiffPercent,
      walletBuyCost,
      walletSoldIncome,
      walletPnlUsd,
      walletSnapshots: snaps,
    };
    realTrades.push(tradeItem);
    try {
      upsertSqliteRealTrade(tradeItem);
    } catch {}
  }

  if (realTrades.length === 0) {
    try {
      const sqliteTrades = getSqliteRealTrades(runId);
      if (sqliteTrades && sqliteTrades.length > 0) {
        return sqliteTrades;
      }
    } catch {}
  }

  return realTrades.reverse();
}

let cachedDashboardResult = new Map();

async function getAggressiveDashboardData(targetRunId) {
  const cacheKey = targetRunId || '__latest__';
  const cached = cachedDashboardResult.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.time < 1200)) {
    return cached.data;
  }

  const allRuns = findAggressiveRuns();
  const selectedRun = targetRunId
    ? allRuns.find(r => r.id === targetRunId) || { id: targetRunId, path: resolve(researchDir, targetRunId) }
    : allRuns[0] || (opts.runFolder ? { id: basename(opts.runFolder), path: resolve(opts.runFolder) } : null);

  if (!selectedRun || !existsSync(selectedRun.path)) {
    const autoBuyCfg = readAutoBuyConfig();
    const walletAddress = getActiveWalletAddress();
    const walletBalance = await getSolanaBalance(walletAddress);
    return {
      availableRuns: allRuns.map(r => ({ id: r.id, startedAt: r.startedAt, friendlyLabel: r.friendlyLabel, isLive: r.isLive, tradesCount: r.tradesCount })),
      currentRunId: null,
      summary: null,
      workers: [
        { id: 1, status: 'IDLE', currentMint: null, symbol: null, ticks: 0, durationSec: 0 },
        { id: 2, status: 'IDLE', currentMint: null, symbol: null, ticks: 0, durationSec: 0 },
        { id: 3, status: 'IDLE', currentMint: null, symbol: null, ticks: 0, durationSec: 0 },
      ],
      openPositions: [],
      closedTrades: [],
      routeQuotes: [],
      throughput: { tradesTotal: 0, ticksTotal: 0, ratePerSec: 0 },
      autoBuy: {
        config: autoBuyCfg,
        walletAddress,
        walletBalance,
        rentInfo: await getReclaimableRentInfo(walletAddress),
        activeRealPositionsCount: 0,
      },
      realTrades: [],
    };
  }

  const runDir = selectedRun.path;
  const isLive = selectedRun.id === allRuns[0]?.id;

  if (!isLive) {
    try {
      const closedTrades = getSqliteTrades(selectedRun.id);
      const simTradesFile = join(runDir, 'simulated-trades.jsonl');
      const hasUnsyncedDiskTrades = closedTrades.length === 0 && existsSync(simTradesFile) && statSync(simTradesFile).size > 50;

      if (!hasUnsyncedDiskTrades) {
        const routeQuotes = getSqliteRouteQuotes(selectedRun.id, 200);
        const realTrades = getSqliteRealTrades(selectedRun.id);
        const allRealTrades = getSqliteRealTrades();
        const autoBuyCfg = readAutoBuyConfig();
        const walletAddress = getActiveWalletAddress(selectedRun.path);
        const walletBalance = await getSolanaBalance(walletAddress);

        function summarizeTradesFast(tradeList) {
        const total = tradeList.length;
        let sWins = 0, sLosses = 0, sPnl = 0;
        let rWins = 0, rLosses = 0, rPnl = 0;
        for (const t of tradeList) {
          if (t.isSocketWin) sWins++; else sLosses++;
          sPnl += (t.tradePnlUsd || 0);
          if (t.isRealWin) rWins++; else rLosses++;
          rPnl += (t.swapPnlUsd || 0);
        }
        return {
          closedTrades: total,
          socketWins: sWins,
          socketLosses: sLosses,
          socketWinRate: total > 0 ? Number(((sWins / total) * 100).toFixed(1)) : 0,
          totalNetTradePnlUsd: Number(sPnl.toFixed(4)),
          realWins: rWins,
          realLosses: rLosses,
          realWinRate: total > 0 ? Number(((rWins / total) * 100).toFixed(1)) : 0,
          totalNetRealPnlUsd: Number(rPnl.toFixed(4)),
        };
      }

      const rawTrades = closedTrades.filter(t => t.lane === 'control');
      const safeTrades = closedTrades.filter(t => t.lane === 'aggressive-safe');
      const optimalTrades = closedTrades.filter(t => t.lane === 'aggressive-optimal');
      const wideTrades = closedTrades.filter(t => t.lane === 'aggressive-wide');
      const swing100kTrades = closedTrades.filter(t => t.lane === 'aggressive-swing-100k');
      const waveTrades = closedTrades.filter(t => t.lane === 'aggressive-wave');
      const v2Trades = closedTrades.filter(t => t.lane === 'momentum-v2');
      const v3Trades = closedTrades.filter(t => t.lane === 'momentum-v3');
      const r5Trades = closedTrades.filter(t => t.lane === 'r5-band');

      const rawSummary = summarizeTradesFast(rawTrades);
      const safeSummary = summarizeTradesFast(safeTrades);
      const optimalSummary = summarizeTradesFast(optimalTrades);
      const wideSummary = summarizeTradesFast(wideTrades);
      const swing100kSummary = summarizeTradesFast(swing100kTrades);
      const waveSummary = summarizeTradesFast(waveTrades);
      const v2Summary = summarizeTradesFast(v2Trades);
      const v3Summary = summarizeTradesFast(v3Trades);
      const r5Summary = summarizeTradesFast(r5Trades);
      const overallSummary = summarizeTradesFast(closedTrades);

      const totalTrades = closedTrades.length;
      const socketWinRate = overallSummary.socketWinRate;
      const realWinRate = overallSummary.realWinRate;

      const result = {
        availableRuns: allRuns.map(r => ({ id: r.id, startedAt: r.startedAt, friendlyLabel: r.friendlyLabel, isLive: r.isLive, tradesCount: r.tradesCount })),
        currentRunId: selectedRun.id,
        isLive: false,
        runStartedAt: selectedRun.startedAt,
        runStartedAtFormatted: formatWibDate(selectedRun.startedAt),
        summary: {
          totalBuys: totalTrades,
          closedTrades: totalTrades,
          openPositions: 0,
          socketWins: overallSummary.socketWins,
          socketLosses: overallSummary.socketLosses,
          socketWinRate,
          totalNetTradePnlUsd: overallSummary.totalNetTradePnlUsd,
          realWins: overallSummary.realWins,
          realLosses: overallSummary.realLosses,
          realWinRate,
          totalNetRealPnlUsd: overallSummary.totalNetRealPnlUsd,
          raw: rawSummary,
          safe: { ...safeSummary, dumpPreventedCount: 0 },
          optimal: { ...optimalSummary, dumpPreventedCount: 0 },
          wide: { ...wideSummary, dumpPreventedCount: 0 },
          swing100k: { ...swing100kSummary, dumpPreventedCount: 0 },
          wave: { ...waveSummary, dumpPreventedCount: 0 },
          v2: { ...v2Summary, dumpPreventedCount: 0 },
          v3: { ...v3Summary, dumpPreventedCount: 0 },
          r5: { ...r5Summary, dumpPreventedCount: 0 },
          avgLatencyMs: 0,
          avgSlippagePct: 5.43,
        },
        workers: [
          { id: 1, status: 'IDLE', currentMint: null, symbol: null, ticks: 0, durationSec: 0 },
          { id: 2, status: 'IDLE', currentMint: null, symbol: null, ticks: 0, durationSec: 0 },
          { id: 3, status: 'IDLE', currentMint: null, symbol: null, ticks: 0, durationSec: 0 },
        ],
        openPositions: [],
        closedTrades,
        routeQuotes,
        throughput: {
          tradesTotal: totalTrades,
          ticksTotal: 0,
          ratePerSec: 0,
          runtimeSeconds: 0,
        },
        autoBuy: {
          config: autoBuyCfg,
          walletAddress,
          walletBalance,
          rentInfo: await getReclaimableRentInfo(walletAddress),
          activeRealPositionsCount: realTrades.filter(t => t.status === 'HOLDING').length,
        },
        realTrades,
        allRealTrades,
      };
        cachedDashboardResult.set(cacheKey, { time: now, data: result });
        return result;
      }
    } catch (e) {
      console.error('Error fetching dashboard data from SQLite:', e);
    }
  }

  const autoBuyCfg = readAutoBuyConfig();
  const configStake = Number(autoBuyCfg.stakeUsd) > 0 ? Number(autoBuyCfg.stakeUsd) : 0.5;

  const manifest = readJsonFile(join(runDir, 'manifest.json'));
  const strategy = readJsonFile(join(runDir, 'strategy.json'));
  const simulatedTrades = readJsonLines(join(runDir, 'simulated-trades.jsonl'));
  const tradeSignals = readJsonLines(join(runDir, 'trade-signals.jsonl'));
  const routeQuotes = readJsonLines(join(runDir, 'quote-simulated-orders.jsonl'));
  const decisions = readLastJsonLines(join(runDir, 'momentum-decisions.jsonl'), 300);
  const screenedTokens = readLastJsonLines(join(runDir, 'screened-tokens.jsonl'), 300);
  const recentTicks = readLastJsonLines(join(runDir, 'socket-ticks.jsonl'), 200);
  const recentEvents = readLastJsonLines(join(runDir, 'events.jsonl'), 400);
  const tokenSummaries = readLastJsonLines(join(runDir, 'token-summary.jsonl'), 100);

  const totalRawTrades = countLinesFast(join(runDir, 'trades.jsonl'));
  const totalTicks = countLinesFast(join(runDir, 'socket-ticks.jsonl'));

  const buys = simulatedTrades.filter(t => t.type === 'SIMULATED_BUY');
  const sells = simulatedTrades.filter(t => t.type === 'SIMULATED_SELL');
  const sellsByPosition = new Map(sells.filter(s => s.positionId).map(s => [s.positionId, s]));
  const sellsByMint = new Map(sells.map(s => [s.mint, s]));

  // Quotes mapping: signalId/positionId/mint -> quote
  const quotesBySignal = new Map();
  const quotesByPosition = new Map();
  const quotesByMint = new Map();
  for (const q of routeQuotes) {
    if (q.signalId) quotesBySignal.set(q.signalId, q);
    if (q.positionId) {
      const cur = quotesByPosition.get(q.positionId) || [];
      cur.push(q);
      quotesByPosition.set(q.positionId, cur);
    }
    if (q.mint) {
      const cur = quotesByMint.get(q.mint) || [];
      cur.push(q);
      quotesByMint.set(q.mint, cur);
    }
  }

  // Active positions & Closed trades
  const openPositions = [];
  const closedTrades = [];

  let socketWins = 0;
  let socketLosses = 0;
  let totalNetTradePnlUsd = 0;
  let realWins = 0;
  let realLosses = 0;
  let totalNetRealPnlUsd = 0;
  let totalLatencyMs = 0;
  let latencyCount = 0;
  let totalSlippagePct = 0;
  let slippageCount = 0;

  for (const buy of buys) {
    const lane = buy.paperLane || 'control';
    const laneLabel = lane === 'aggressive-wave' ? 'Wave Scalper Aggressive' : lane === 'aggressive-swing-100k' ? 'Swing 100k Aggressive' : lane === 'r5-band' ? 'Momentum R5 Band' : lane === 'momentum-v3' ? 'Momentum V3' : lane === 'momentum-v2' ? 'Momentum V2' : lane === 'aggressive-wide' ? 'Wide Aggressive' : lane === 'aggressive-optimal' ? 'Optimal Aggressive' : lane === 'aggressive-safe' ? 'Safe Aggressive' : 'Raw Aggressive';
    const posId = buy.positionId || `${buy.mint}:${buy.observedAt}:${lane}`;
    const sell = sellsByPosition.get(posId) || sells.find(s => s.mint === buy.mint && ((s.paperLane || 'control') === lane)) || sellsByMint.get(buy.mint);
    const buyQuotes = quotesByPosition.get(posId)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:control`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:aggressive-safe`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:aggressive-optimal`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:aggressive-wide`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:aggressive-swing-100k`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:aggressive-wave`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:momentum-v2`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:momentum-v3`)
      || quotesByPosition.get(`${buy.mint}:${buy.observedAt}:r5-band`)
      || quotesByMint.get(buy.mint)
      || [];
    const buyQuote = buyQuotes.find(q => q.type === 'QUOTE_BUY_COMPARISON');
    const sellQuote = buyQuotes.find(q => q.type === 'QUOTE_SELL_COMPARISON');

    if (buyQuote?.latencyMs) {
      totalLatencyMs += buyQuote.latencyMs;
      latencyCount++;
    }
    if (buyQuote?.routeVsSocketPricePercent != null) {
      totalSlippagePct += Math.abs(buyQuote.routeVsSocketPricePercent);
      slippageCount++;
    }

    const symbol = buy.metadata?.symbol || buy.mint.slice(0, 6);
    const name = buy.metadata?.name || symbol;

    if (sell) {
      const socketReturn = sell.pnlPercent ?? ((sell.exitPriceUsd / buy.entryPriceUsd - 1) * 100);
      const isSocketWin = socketReturn > 0;
      if (isSocketWin) socketWins++; else socketLosses++;

      const stakeUsd = buy.stakeUsd || configStake;
      const tradePnlUsd = stakeUsd * (socketReturn / 100);
      totalNetTradePnlUsd += tradePnlUsd;

      // Real return considers exact live GMGN quote amounts (USD/SOL in vs out)
      let realReturn = socketReturn - 3.5;
      let hasExactSwapFill = false;
      const inUsd = Number(buyQuote?.quote?.amountInUsd || 0);
      const outUsd = Number(sellQuote?.quote?.amountOutUsd || 0);
      if (inUsd > 0 && outUsd > 0) {
        realReturn = ((outUsd / inUsd) - 1) * 100;
        hasExactSwapFill = true;
      }

      const isRealWin = realReturn > 0;
      if (isRealWin) realWins++; else realLosses++;

      const swapPnlUsd = hasExactSwapFill
        ? (outUsd - inUsd)
        : (sell.pnlUsd ?? (stakeUsd * (realReturn / 100)));
      totalNetRealPnlUsd += swapPnlUsd;

      const inSol = buyQuote?.inputAmountBaseUnits ? (Number(buyQuote.inputAmountBaseUnits) / 1e9).toFixed(4) + ' SOL' : null;
      const outSol = sellQuote?.quote?.outAmount ? (Number(sellQuote.quote.outAmount) / 1e9).toFixed(4) + ' SOL' : null;

      const swapRouteDetail = {
        hasBuy: !!buyQuote,
        hasSell: !!sellQuote,
        buyTime: buyQuote?.observedAt || buy.observedAt,
        buyInSol: inSol,
        buyInUsd: inUsd > 0 ? '$' + inUsd.toFixed(4) : null,
        buyOutTokens: buyQuote?.routeTokenAmount ? Math.round(buyQuote.routeTokenAmount).toLocaleString() : null,
        buySlippage: buyQuote?.routeVsSocketPricePercent != null ? (buyQuote.routeVsSocketPricePercent >= 0 ? '+' : '') + buyQuote.routeVsSocketPricePercent.toFixed(2) + '%' : '—',
        buyLatencyMs: buyQuote?.latencyMs,
        sellTime: sellQuote?.observedAt || sell.observedAt,
        sellInTokens: sellQuote?.inputAmountBaseUnits ? Math.round(Number(sellQuote.inputAmountBaseUnits) / 10**(sellQuote.tokenDecimals || 6)).toLocaleString() : null,
        sellOutSol: outSol,
        sellOutUsd: outUsd > 0 ? '$' + outUsd.toFixed(4) : null,
        sellSlippage: sellQuote?.routeVsSocketProceedsPercent != null ? (sellQuote.routeVsSocketProceedsPercent >= 0 ? '+' : '') + sellQuote.routeVsSocketProceedsPercent.toFixed(2) + '%' : '—',
        sellLatencyMs: sellQuote?.latencyMs,
      };

      closedTrades.push({
        positionId: posId,
        mint: buy.mint,
        lane,
        laneLabel,
        symbol,
        name,
        worker: buy.worker ?? 1,
        entryPrice: buy.entryPriceUsd,
        entryTime: buy.observedAt,
        exitPrice: sell.exitPriceUsd || sell.exit?.priceUsd,
        exitTime: sell.observedAt,
        durationSec: Math.max(1, Math.round((sell.observedAt - buy.observedAt) / 1000)),
        exitReason: sell.exitReason || sell.reason || 'UNKNOWN',
        tradeReturnPercent: socketReturn,
        socketReturnPercent: socketReturn,
        realReturnPercent: realReturn,
        tradePnlUsd,
        swapPnlUsd,
        pnlUsd: tradePnlUsd,
        isWin: isSocketWin,
        isSocketWin,
        isRealWin,
        swapRoute: swapRouteDetail,
      });
    } else {
      // Still open position
      // Find latest socket tick price
      const tokenTicks = recentTicks.filter(t => t.mint === buy.mint);
      const latestTick = tokenTicks[tokenTicks.length - 1];
      const tokenDecisions = decisions.filter(d => d.mint === buy.mint);
      const latestDecision = tokenDecisions[tokenDecisions.length - 1];
      const currentPrice = latestTick?.priceUsd || latestDecision?.priceUsd || buy.entryPriceUsd;
      const floatingReturn = ((currentPrice / buy.entryPriceUsd) - 1) * 100;

      // Peak price from decisions or ticks
      let peakReturn = floatingReturn;
      for (const d of tokenDecisions) {
        if (d.peakReturnPercent != null && d.peakReturnPercent > peakReturn) {
          peakReturn = d.peakReturnPercent;
        }
      }

      const elapsedSec = Math.max(0, Math.round((now - buy.observedAt) / 1000));
      const stagnationCountdownSec = Math.max(0, 12 - elapsedSec);

      openPositions.push({
        positionId: posId,
        mint: buy.mint,
        lane,
        laneLabel,
        symbol,
        worker: buy.worker ?? 1,
        entryPrice: buy.entryPriceUsd,
        entryTime: buy.observedAt,
        currentPrice,
        floatingReturnPercent: floatingReturn,
        peakReturnPercent: peakReturn,
        trailingFloorPercent: peakReturn >= 4.0 ? Math.max(2.5, peakReturn - 1.0) : null,
        stagnationCountdownSec,
        elapsedSec,
      });
    }
  }

  // Enrich route quotes with token metadata
  const metadataByMint = new Map();
  for (const b of buys) if (b.mint && b.metadata) metadataByMint.set(b.mint, b.metadata);
  for (const s of screenedTokens) if (s.mint && s.metadata) metadataByMint.set(s.mint, s.metadata);
  for (const t of tokenSummaries) if (t.mint && t.metadata) metadataByMint.set(t.mint, t.metadata);

  // Worker status calculation
  const numWorkers = Number(manifest?.workers) || 2;
  const workerIds = Array.from({ length: numWorkers }, (_, i) => i + 1);
  const workers = workerIds.map(wId => {
    // Find active token in events or openPositions
    const activePos = openPositions.find(p => p.worker === wId);
    if (activePos) {
      return {
        id: wId,
        status: 'POSITION_OPEN',
        currentMint: activePos.mint,
        symbol: activePos.symbol,
        ticks: recentTicks.filter(t => t.mint === activePos.mint).length,
        durationSec: activePos.elapsedSec,
      };
    }

    // Check recent detail open events
    const workerStatus = getWorkerServiceStatus();
    const isServiceRunning = workerStatus.active;
    const detailLifecycleTypes = new Set([
      'DETAIL_STARTED',
      'OBSERVATION_ABORTED_DUMP',
      'DETAIL_SLOT_RELEASED_AFTER_SELL_HOLD',
      'DETAIL_ERROR',
      'OPERATOR_RELEASED_DETAIL_SLOT',
      'WORKER_DETAIL_CLEANUP',
      'DETAIL_WINDOW_OPEN'
    ]);
    const workerDetailEvents = recentEvents.filter(e => e.worker === wId && detailLifecycleTypes.has(e.type));
    const latestDetailEvent = workerDetailEvents[workerDetailEvents.length - 1];
    const detailStartTs = latestDetailEvent?.startedAt || latestDetailEvent?.observedAt || 0;
    const detailEventAgeSec = latestDetailEvent ? Math.max(0, Math.round((now - detailStartTs) / 1000)) : 9999;
    const isObserving = (latestDetailEvent?.type === 'DETAIL_STARTED' || latestDetailEvent?.type === 'DETAIL_WINDOW_OPEN') && detailEventAgeSec <= 95;
    const isBotActive = isObserving || detailEventAgeSec <= 90 || (isServiceRunning && isLive);
    const mint = isObserving ? (latestDetailEvent?.mint || null) : null;
    const meta = metadataByMint.get(mint);
    const symbol = latestDetailEvent?.symbol || meta?.symbol || (mint ? mint.slice(0, 6) : null);

    return {
      id: wId,
      status: isObserving ? 'OBSERVING_SOCKET' : (isBotActive ? 'SEARCHING' : 'IDLE (BOT OFF)'),
      currentMint: mint,
      symbol,
      ticks: mint ? recentTicks.filter(t => t.mint === mint).length : 0,
      durationSec: isObserving ? detailEventAgeSec : 0,
    };
  });

  function summarizeTrades(tradeList) {
    const total = tradeList.length;
    let sWins = 0, sLosses = 0, sPnl = 0;
    let rWins = 0, rLosses = 0, rPnl = 0;
    for (const t of tradeList) {
      if (t.isSocketWin) sWins++; else sLosses++;
      sPnl += (t.tradePnlUsd || 0);
      if (t.isRealWin) rWins++; else rLosses++;
      rPnl += (t.swapPnlUsd || 0);
    }
    return {
      closedTrades: total,
      socketWins: sWins,
      socketLosses: sLosses,
      socketWinRate: total > 0 ? Number(((sWins / total) * 100).toFixed(1)) : 0,
      totalNetTradePnlUsd: Number(sPnl.toFixed(4)),
      realWins: rWins,
      realLosses: rLosses,
      realWinRate: total > 0 ? Number(((rWins / total) * 100).toFixed(1)) : 0,
      totalNetRealPnlUsd: Number(rPnl.toFixed(4)),
    };
  }

  const rawTrades = closedTrades.filter(t => t.lane === 'control');
  const safeTrades = closedTrades.filter(t => t.lane === 'aggressive-safe');
  const optimalTrades = closedTrades.filter(t => t.lane === 'aggressive-optimal');
  const wideTrades = closedTrades.filter(t => t.lane === 'aggressive-wide');
  const swing100kTrades = closedTrades.filter(t => t.lane === 'aggressive-swing-100k');
  const waveTrades = closedTrades.filter(t => t.lane === 'aggressive-wave');
  const v2Trades = closedTrades.filter(t => t.lane === 'momentum-v2');
  const v3Trades = closedTrades.filter(t => t.lane === 'momentum-v3');
  const r5Trades = closedTrades.filter(t => t.lane === 'r5-band');
  const rawSummary = summarizeTrades(rawTrades);
  const safeSummary = summarizeTrades(safeTrades);
  const optimalSummary = summarizeTrades(optimalTrades);
  const wideSummary = summarizeTrades(wideTrades);
  const swing100kSummary = summarizeTrades(swing100kTrades);
  const waveSummary = summarizeTrades(waveTrades);
  const v2Summary = summarizeTrades(v2Trades);
  const v3Summary = summarizeTrades(v3Trades);
  const r5Summary = summarizeTrades(r5Trades);
  const overallSummary = summarizeTrades(closedTrades);

  // Prevented dump count for safe & optimal lanes:
  const dumpPreventedCount = recentEvents.filter(e => e.type === 'SIMULATION_BUY_LANE_FILTERED').length;

  const totalTrades = closedTrades.length;
  const socketWinRate = overallSummary.socketWinRate;
  const realWinRate = overallSummary.realWinRate;
  const avgLatencyMs = latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : 0;
  const avgSlippagePct = slippageCount > 0 ? Number((totalSlippagePct / slippageCount).toFixed(2)) : 5.43;

  // Throughput
  const startTime = manifest?.startedAt ? new Date(manifest.startedAt).getTime() : (selectedRun.mtime || now);
  const runtimeSeconds = Math.max(1, Math.round((now - startTime) / 1000));
  const ratePerSec = Number(((totalRawTrades + totalTicks) / runtimeSeconds).toFixed(1));

  const enrichedRouteQuotes = routeQuotes.map(q => {
    const meta = metadataByMint.get(q.mint);
    const isBuy = q.type === 'QUOTE_BUY_COMPARISON';
    const isSell = q.type === 'QUOTE_SELL_COMPARISON';
    const slip = isBuy ? q.routeVsSocketPricePercent : (q.routeVsSocketProceedsPercent ?? q.routeVsSocketPricePercent);
    const inSol = q.inputAmountBaseUnits && isBuy ? (Number(q.inputAmountBaseUnits) / 1e9).toFixed(4) + ' SOL' : null;
    const outTokens = q.routeTokenAmount ? Math.round(q.routeTokenAmount).toLocaleString() : null;
    const inTokens = q.inputAmountBaseUnits && isSell ? Math.round(Number(q.inputAmountBaseUnits) / 10**(q.tokenDecimals || 6)).toLocaleString() : null;
    const outSol = q.quote?.outAmount && isSell ? (Number(q.quote.outAmount) / 1e9).toFixed(4) + ' SOL' : null;
    const flowText = isBuy 
      ? (inSol && outTokens ? `${inSol} → ${outTokens} Tok` : '—')
      : (inTokens && outSol ? `${inTokens} Tok → ${outSol}` : '—');

    return {
      ...q,
      name: meta?.name || q.mint.slice(0, 10),
      symbol: meta?.symbol || q.mint.slice(0, 6),
      isBuy,
      isSell,
      typeLabel: isBuy ? 'BUY ROUTE' : isSell ? 'SELL ROUTE' : (q.type || 'QUOTE'),
      flowText,
      slipPercent: slip != null ? Number(Number(slip).toFixed(2)) : null,
    };
  });

  const walletAddress = getActiveWalletAddress(runDir);
  const walletBalance = await getSolanaBalance(walletAddress);
  const realTrades = getRealExecutedTrades(runDir, closedTrades, metadataByMint, true);
  const allRealTrades = getSqliteRealTrades();

  const result = {
    availableRuns: allRuns.map(r => ({ id: r.id, startedAt: r.startedAt, friendlyLabel: r.friendlyLabel, isLive: r.isLive, tradesCount: r.tradesCount })),
    currentRunId: selectedRun.id,
    isLive: selectedRun.id === allRuns[0]?.id,
    runStartedAt: manifest?.startedAt || selectedRun.startedAt || new Date(startTime).toISOString(),
    runStartedAtFormatted: formatWibDate(manifest?.startedAt || selectedRun.startedAt || startTime),
    summary: {
      totalBuys: buys.length,
      closedTrades: totalTrades,
      openPositions: openPositions.length,
      socketWins: overallSummary.socketWins,
      socketLosses: overallSummary.socketLosses,
      socketWinRate,
      totalNetTradePnlUsd: overallSummary.totalNetTradePnlUsd,
      realWins: overallSummary.realWins,
      realLosses: overallSummary.realLosses,
      realWinRate,
      totalNetRealPnlUsd: overallSummary.totalNetRealPnlUsd,
      raw: rawSummary,
      safe: { ...safeSummary, dumpPreventedCount },
      optimal: { ...optimalSummary, dumpPreventedCount },
      wide: { ...wideSummary, dumpPreventedCount },
      swing100k: { ...swing100kSummary, dumpPreventedCount: 0 },
      wave: { ...waveSummary, dumpPreventedCount: 0 },
      v2: { ...v2Summary, dumpPreventedCount: 0 },
      v3: { ...v3Summary, dumpPreventedCount: 0 },
      r5: { ...r5Summary, dumpPreventedCount: 0 },
      avgLatencyMs,
      avgSlippagePct,
    },
    workers,
    openPositions,
    closedTrades: closedTrades.sort((a, b) => (b.exitTime || b.entryTime || 0) - (a.exitTime || a.entryTime || 0)),
    routeQuotes: enrichedRouteQuotes.slice(-200).reverse(),
    throughput: {
      tradesTotal: totalRawTrades,
      ticksTotal: totalTicks,
      ratePerSec,
      runtimeSeconds,
    },
    autoBuy: {
      config: autoBuyCfg,
      walletAddress,
      walletBalance,
      rentInfo: await getReclaimableRentInfo(walletAddress),
      activeRealPositionsCount: realTrades.filter(t => t.status === 'HOLDING').length,
    },
    realTrades,
    allRealTrades,
  };
  cachedDashboardResult.set(cacheKey, { time: now, data: result });
  return result;
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>AGY Aggressive High-Volume Sniper Dashboard</title>
  <meta name="theme-color" content="#090d16">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="AGY Sniper">
  <meta name="format-detection" content="telephone=no">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" type="image/svg+xml" href="/icons/icon.svg">
  <link rel="apple-touch-icon" href="/icons/icon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(17, 24, 39, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --text: #f3f4f6;
      --text-muted: #9ca3af;
      --accent: #f59e0b;
      --accent-glow: rgba(245, 158, 11, 0.2);
      --win: #10b981;
      --win-bg: rgba(16, 185, 129, 0.15);
      --loss: #ef4444;
      --loss-bg: rgba(239, 68, 68, 0.15);
      --blue: #3b82f6;
      --blue-bg: rgba(59, 130, 246, 0.15);
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html {
      font-size: 12.5px;
      -webkit-text-size-adjust: 100%;
    }
    body {
      background: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(245, 158, 11, 0.06) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.06) 0px, transparent 50%);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      padding: 1.25rem;
    }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .container { max-width: 1400px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.15rem; }
    
    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      padding-bottom: 0.9rem;
      border-bottom: 1px solid var(--card-border);
    }
    .title-group h1 {
      font-size: 1.25rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .badge-aggressive {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #000;
      font-size: 0.68rem;
      font-weight: 800;
      padding: 0.18rem 0.5rem;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .title-group p {
      font-size: 0.76rem;
      color: var(--text-muted);
      margin-top: 0.2rem;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    select, button {
      background: #1f2937;
      color: var(--text);
      border: 1px solid var(--card-border);
      border-radius: 0.45rem;
      padding: 0.42rem 0.7rem;
      font-size: 0.78rem;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    select:hover, button:hover { border-color: rgba(255, 255, 255, 0.2); }
    .btn-refresh {
      background: #f59e0b;
      color: #000;
      font-weight: 700;
      border: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 0.42rem 0.75rem;
      border-radius: 0.5rem;
      font-size: 0.78rem;
      box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25);
    }
    .btn-refresh:hover { background: #d97706; transform: translateY(-1px); }
    .live-pulse {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--win);
      box-shadow: 0 0 8px var(--win);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.9); } 100% { opacity: 1; transform: scale(1); } }

    /* Unified Session & Runner Control Bar */
    .session-bar {
      background: rgba(17, 24, 39, 0.75);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.75rem;
      padding: 0.55rem 0.85rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.65rem;
      backdrop-filter: blur(12px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    }
    .session-bar-left {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      flex-wrap: wrap;
      flex: 1 1 auto;
      min-width: 250px;
    }
    .run-selector-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(31, 41, 55, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.16);
      border-radius: 0.5rem;
      padding: 2px 8px;
      transition: all 0.2s ease;
      flex: 1 1 auto;
      max-width: 480px;
    }
    .run-selector-pill:focus-within {
      border-color: #f59e0b;
      box-shadow: 0 0 10px rgba(245, 158, 11, 0.3);
    }
    .run-picker-label {
      font-size: 0.7rem;
      font-weight: 700;
      color: #94a3b8;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .run-select-dropdown {
      background: transparent;
      color: #f8fafc;
      border: none;
      font-size: 0.76rem;
      font-weight: 700;
      padding: 0.35rem 0.2rem;
      cursor: pointer;
      outline: none;
      width: 100%;
    }
    .run-select-dropdown option {
      background: #111827;
      color: #f8fafc;
    }
    .session-bar-right {
      display: flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .session-meta-pill {
      font-size: 0.7rem;
      color: #cbd5e1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 5px;
      white-space: nowrap;
    }
    .session-pill-accent {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.35);
      font-weight: 700;
    }
    .btn-audit-quick {
      text-decoration: none;
      font-weight: 700;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.15);
      border: 1px solid rgba(56, 189, 248, 0.4);
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 0.7rem;
      white-space: nowrap;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .btn-audit-quick:hover {
      background: rgba(56, 189, 248, 0.3);
      color: #fff;
      transform: translateY(-1px);
    }

    /* Auto-Buy Switch & Modal Styles */
    .switch-container {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      cursor: pointer;
      user-select: none;
    }
    .switch-track {
      position: relative;
      display: inline-block;
      width: 52px;
      height: 28px;
    }
    .switch-track input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .switch-slider {
      position: absolute;
      cursor: pointer;
      top: 0; left: 0; right: 0; bottom: 0;
      background-color: #374151;
      transition: .3s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 34px;
      border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .switch-slider:before {
      position: absolute;
      content: "";
      height: 20px;
      width: 20px;
      left: 3px;
      bottom: 3px;
      background-color: white;
      transition: .3s cubic-bezier(0.4, 0, 0.2, 1);
      border-radius: 50%;
    }
    .switch-track input:checked + .switch-slider {
      background-color: #10b981;
      border-color: #059669;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
    }
    .switch-track input:checked + .switch-slider:before {
      transform: translateX(24px);
    }
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      padding: 1.5rem;
    }
    .modal-box {
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 0.85rem;
      max-width: 860px;
      width: 100%;
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.9);
    }
    .toast-msg {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 10000;
      padding: 12px 20px;
      border-radius: 8px;
      font-weight: 700;
      font-size: 0.88rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.6);
      display: none;
      transition: all 0.3s ease;
      color: #fff;
    }

    /* Rules Banner */
    .rules-banner {
      background: rgba(245, 158, 11, 0.08);
      border: 1px solid rgba(245, 158, 11, 0.25);
      border-radius: 0.75rem;
      padding: 0.85rem 1.25rem;
      display: flex;
      flex-wrap: wrap;
      gap: 1.25rem;
      font-size: 0.82rem;
      align-items: center;
    }
    .rule-tag {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #fde68a;
    }
    .rule-tag span {
      background: rgba(0, 0, 0, 0.3);
      padding: 0.15rem 0.4rem;
      border-radius: 0.3rem;
      color: #fff;
      font-weight: 700;
    }

    /* KPI Grid */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.75rem;
      padding: 0.85rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      backdrop-filter: blur(12px);
      position: relative;
      overflow: hidden;
    }
    .kpi-card::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 2px;
      background: var(--accent);
      opacity: 0.4;
    }
    .kpi-label {
      font-size: 0.68rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .kpi-value {
      font-size: 1.25rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 0.72rem;
      color: var(--text-muted);
    }
    .up { color: var(--win); }
    .down { color: var(--loss); }
    .accent { color: var(--accent); }

    /* Worker Grid */
    .section-title {
      font-size: 0.95rem;
      font-weight: 800;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.65rem;
    }
    .worker-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 0.75rem;
    }
    .worker-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.75rem;
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.55rem;
      backdrop-filter: blur(10px);
    }
    .worker-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .worker-badge {
      background: var(--blue-bg);
      color: var(--blue);
      font-weight: 700;
      font-size: 0.72rem;
      padding: 0.18rem 0.5rem;
      border-radius: 0.35rem;
    }
    .status-badge {
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.18rem 0.45rem;
      border-radius: 9999px;
    }
    .status-active { background: var(--win-bg); color: var(--win); }
    .status-observing { background: var(--blue-bg); color: var(--blue); }
    .status-idle { background: rgba(156, 163, 175, 0.15); color: var(--text-muted); }

    /* Tables */
    .table-container {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.85rem;
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      backdrop-filter: blur(10px);
      position: relative;
      max-height: 72vh;
    }
    table {
      width: 100%;
      min-width: 1020px;
      border-collapse: separate;
      border-spacing: 0;
      text-align: left;
      font-size: 0.76rem;
    }
    thead th {
      position: sticky;
      top: 0;
      z-index: 4;
      background: #0d1424;
      padding: 0.6rem 0.75rem;
      font-size: 0.68rem;
      color: #94a3b8;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
    }
    td {
      padding: 0.55rem 0.75rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
      background: inherit;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.025); }

    /* Sticky first column (Token) for seamless horizontal mobile scroll */
    th.sticky-col, td.sticky-col {
      position: sticky;
      left: 0;
      z-index: 2;
      background: #0d131f;
      border-right: 1px solid var(--card-border);
      box-shadow: 4px 0 10px -2px rgba(0, 0, 0, 0.7);
      min-width: 130px;
      max-width: 155px;
    }
    thead th.sticky-col {
      z-index: 6;
      background: #141d31;
    }

    .mobile-hint {
      display: none;
      font-size: 0.68rem;
      color: #60a5fa;
      background: rgba(59, 130, 246, 0.1);
      border: 1px dashed rgba(59, 130, 246, 0.35);
      border-radius: 0.45rem;
      padding: 0.35rem 0.65rem;
      margin-bottom: 0.5rem;
    }

    .tag {
      font-size: 0.66rem;
      font-weight: 700;
      padding: 0.16rem 0.42rem;
      border-radius: 0.3rem;
      text-transform: uppercase;
      display: inline-block;
    }
    .tag-win { background: var(--win-bg); color: var(--win); }
    .tag-loss { background: var(--loss-bg); color: var(--loss); }
    .tag-trail { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .tag-break { background: rgba(56, 189, 248, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
    .tag-stop { background: var(--loss-bg); color: var(--loss); }
    .tag-stag { background: rgba(168, 85, 247, 0.2); color: var(--purple); }
    .tag-flow { background: rgba(59, 130, 246, 0.2); color: var(--blue); }
    .tag-lane-raw { background: rgba(59, 130, 246, 0.2); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.4); }
    .tag-lane-safe { background: rgba(16, 185, 129, 0.2); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.4); }
    .tag-lane-optimal { background: rgba(168, 85, 247, 0.2); color: #d8b4fe; border: 1px solid rgba(168, 85, 247, 0.4); }
    .tag-lane-wide { background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); }
    .tag-lane-swing { background: rgba(14, 165, 233, 0.2); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); }
    .tag-lane-wave { background: rgba(20, 184, 166, 0.2); color: #2dd4bf; border: 1px solid rgba(45, 212, 191, 0.4); }
    .tag-lane-v2 { background: rgba(59, 130, 246, 0.2); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); }
    .tag-lane-v3 { background: rgba(168, 85, 247, 0.2); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); }
    .tag-lane-r5 { background: rgba(234, 179, 8, 0.2); color: #facc15; border: 1px solid rgba(234, 179, 8, 0.4); }

    /* Filter Chips Bar */
    .filter-chips-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      overflow-x: auto;
      white-space: nowrap;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      padding: 2px 2px 4px 2px;
    }
    .filter-chips-bar::-webkit-scrollbar {
      display: none;
    }
    .btn-filter {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: #94a3b8;
      padding: 0.3rem 0.65rem;
      border-radius: 9999px;
      font-size: 0.72rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.18s ease;
      user-select: none;
      display: inline-flex;
      align-items: center;
      gap: 3px;
      white-space: nowrap;
    }
    .btn-filter:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.22);
    }
    .btn-filter.active {
      background: rgba(59, 130, 246, 0.2);
      border-color: #3b82f6;
      color: #60a5fa;
      box-shadow: 0 0 10px rgba(59, 130, 246, 0.25);
    }

    /* Route Cell Box & Table Elements */
    .route-cell-box {
      font-size: 0.7rem;
      line-height: 1.35;
      min-width: 155px;
      background: rgba(0, 0, 0, 0.28);
      padding: 4px 6px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }
    .route-time {
      font-size: 0.65rem;
      color: #94a3b8;
      font-weight: 600;
      margin-bottom: 1px;
    }
    .route-flow {
      font-weight: 700;
      font-size: 0.7rem;
    }
    .text-win { color: #34d399; }
    .text-loss { color: #f87171; }
    .route-sub {
      font-size: 0.63rem;
      color: #94a3b8;
      margin-top: 1px;
    }
    .duration-badge {
      font-size: 0.65rem;
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 5px;
      border-radius: 3px;
      display: inline-block;
      margin-top: 2px;
    }

    /* On-Chain Top Actions */
    .onchain-top-actions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
      margin-bottom: 0.2rem;
    }
    .onchain-action-card {
      text-decoration: none;
      background: rgba(17, 24, 39, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 0.75rem;
      padding: 0.75rem 0.95rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #38bdf8;
      transition: all 0.2s ease;
      backdrop-filter: blur(10px);
    }
    .onchain-action-card:hover {
      border-color: rgba(56, 189, 248, 0.5);
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
    }
    .action-card-title {
      font-weight: 800;
      font-size: 0.85rem;
      color: #f8fafc;
    }
    .action-card-sub {
      font-size: 0.7rem;
      color: #94a3b8;
      margin-top: 2px;
    }
    .action-card-arrow {
      font-size: 1.1rem;
      color: #38bdf8;
      transition: transform 0.2s ease;
    }
    .onchain-action-card:hover .action-card-arrow {
      transform: translateX(2px);
    }

    /* Auto-Buy Control Panel */
    .autobuy-panel {
      background: rgba(17, 24, 39, 0.88);
      border: 1px solid rgba(245, 158, 11, 0.35);
      border-radius: 0.85rem;
      padding: 1rem 1.15rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }
    .autobuy-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding-bottom: 0.75rem;
    }
    .autobuy-header-left {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      flex: 1 1 280px;
    }
    .autobuy-icon-wrap {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: rgba(245, 158, 11, 0.18);
      border: 1px solid rgba(245, 158, 11, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      flex-shrink: 0;
    }
    .autobuy-title {
      font-size: 0.95rem;
      font-weight: 800;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .autobuy-subtitle {
      font-size: 0.72rem;
      color: #94a3b8;
      margin-top: 1px;
      line-height: 1.35;
    }
    .autobuy-header-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn-save-autobuy {
      padding: 0.45rem 0.95rem;
      font-size: 0.78rem;
      font-weight: 700;
      border-radius: 0.5rem;
      display: flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.3);
    }
    .autobuy-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 0.75rem;
    }
    .config-card {
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 0.65rem;
      padding: 0.75rem 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .config-card-wallet {
      background: rgba(16, 185, 129, 0.04);
      border-color: rgba(16, 185, 129, 0.25);
    }
    .config-label {
      display: block;
      font-size: 0.68rem;
      font-weight: 700;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .sub-label {
      font-size: 0.64rem;
      color: #94a3b8;
      display: block;
      margin-bottom: 2px;
    }
    .config-select, .config-input {
      width: 100%;
      padding: 0.45rem 0.55rem;
      font-size: 0.76rem;
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 0.45rem;
      color: #f3f4f6;
      outline: none;
      transition: border-color 0.2s;
    }
    .config-select:focus, .config-input:focus {
      border-color: #f59e0b;
    }
    .config-hint {
      font-size: 0.68rem;
      color: #94a3b8;
      line-height: 1.35;
    }
    .btn-micro-action {
      padding: 3px 6px;
      font-size: 0.66rem;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      color: #e5e7eb;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.15s ease;
    }
    .btn-micro-action:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #fff;
    }
    .btn-micro-accent {
      background: rgba(56, 189, 248, 0.15);
      border-color: rgba(56, 189, 248, 0.4);
      color: #38bdf8;
      font-weight: 700;
    }
    .btn-micro-accent:hover {
      background: rgba(56, 189, 248, 0.25);
    }

    /* Real Trades Section & Scope Segmented Control */
    .real-trades-container {
      margin-top: 1.15rem;
      border: 1px solid rgba(16, 185, 129, 0.35);
      border-radius: 0.85rem;
      padding: 1rem;
      background: rgba(16, 185, 129, 0.02);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .real-trades-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.65rem;
    }
    .real-trades-title-wrap {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .real-trades-title {
      font-weight: 800;
      font-size: 0.98rem;
      color: #f8fafc;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .real-trades-sub {
      font-size: 0.72rem;
      color: #94a3b8;
    }
    .scope-segmented-control {
      display: inline-flex;
      background: rgba(17, 24, 39, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 0.5rem;
      padding: 2px;
      gap: 2px;
    }
    .scope-segmented-control .btn-filter {
      border-radius: 0.4rem;
      padding: 0.3rem 0.65rem;
      border: none;
      font-size: 0.7rem;
    }

    /* Pagination */
    .pagination-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0.5rem 0.85rem;
      background: rgba(17, 24, 39, 0.85);
      border-top: 1px solid var(--card-border);
      font-size: 0.72rem;
      color: var(--text-muted);
    }
    .pagination-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .btn-page {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #d1d5db;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 0.70rem;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.15s ease;
      user-select: none;
    }
    .btn-page:hover:not(:disabled) {
      background: rgba(59, 130, 246, 0.25);
      border-color: rgba(59, 130, 246, 0.5);
      color: #93c5fd;
    }
    .btn-page:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
    .page-size-select {
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #f3f4f6;
      border-radius: 5px;
      padding: 2px 6px;
      font-size: 0.70rem;
      cursor: pointer;
      outline: none;
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 0.85rem;
      margin-bottom: 0.85rem;
    }
    .lane-card {
      border-radius: 0.75rem;
      padding: 0.85rem 1rem;
      backdrop-filter: blur(12px);
      display: flex;
      flex-direction: column;
      gap: 0.6rem;
    }
    .lane-card-raw {
      background: rgba(30, 58, 138, 0.18);
      border: 1px solid rgba(96, 165, 250, 0.35);
    }
    .lane-card-safe {
      background: rgba(6, 78, 59, 0.22);
      border: 1px solid rgba(52, 211, 153, 0.4);
    }
    .lane-card-optimal {
      background: rgba(88, 28, 135, 0.22);
      border: 1px solid rgba(192, 132, 252, 0.4);
    }
    .lane-card-wide {
      background: rgba(180, 83, 9, 0.2);
      border: 1px solid rgba(251, 191, 36, 0.4);
    }
    .lane-card-swing {
      background: rgba(12, 74, 110, 0.22);
      border: 1px solid rgba(56, 189, 248, 0.4);
    }
    .lane-card-wave {
      background: rgba(13, 148, 136, 0.22);
      border: 1px solid rgba(45, 212, 191, 0.4);
    }
    .lane-card-v2 {
      background: rgba(30, 58, 138, 0.22);
      border: 1px solid rgba(96, 165, 250, 0.4);
    }
    .lane-card-v3 {
      background: rgba(88, 28, 135, 0.28);
      border: 1px solid rgba(192, 132, 252, 0.45);
    }
    .lane-card-r5 {
      background: rgba(113, 63, 18, 0.25);
      border: 1px solid rgba(250, 204, 21, 0.45);
    }
    @media (max-width: 768px) {
      .comparison-grid { grid-template-columns: 1fr; }
    }

    /* Stagnation countdown bar */
    .stag-bar {
      width: 100%;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      margin-top: 4px;
    }
    .stag-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.5s ease;
    }

    /* Empty state */
    .empty-state {
      padding: 3rem 1rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    /* Tab Panes */
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
      animation: tabFadeIn 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes tabFadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* Desktop Segmented Tab Bar */
    .desktop-tabs {
      display: flex;
      align-items: center;
      gap: 6px;
      background: rgba(17, 24, 39, 0.75);
      border: 1px solid var(--card-border);
      padding: 5px;
      border-radius: 0.75rem;
      backdrop-filter: blur(12px);
      overflow-x: auto;
    }
    .desktop-tab-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.45rem 0.8rem;
      font-size: 0.78rem;
      font-weight: 700;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      white-space: nowrap;
      user-select: none;
    }
    .desktop-tab-btn:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.05);
    }
    .desktop-tab-btn.active {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
      border: 1px solid rgba(245, 158, 11, 0.35);
      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.15);
    }

    /* Native App Bottom Navigation Menu */
    .bottom-nav {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      height: calc(54px + env(safe-area-inset-bottom));
      padding-bottom: env(safe-area-inset-bottom);
      background: rgba(10, 14, 23, 0.96);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: none; /* Shown on mobile screens */
      justify-content: space-around;
      align-items: center;
      z-index: 1000;
      box-shadow: 0 -8px 25px rgba(0, 0, 0, 0.6);
    }
    .bottom-nav-item {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      height: 100%;
      color: #94a3b8;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 0.65rem;
      font-weight: 700;
      position: relative;
      transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }
    .bottom-nav-item:active {
      transform: scale(0.92);
    }
    .bottom-nav-item.active {
      color: #f59e0b;
    }
    .bottom-nav-item .nav-icon {
      font-size: 1.1rem;
      line-height: 1;
      transition: transform 0.18s ease;
    }
    .bottom-nav-item.active .nav-icon {
      transform: translateY(-2px);
      filter: drop-shadow(0 0 8px rgba(245, 158, 11, 0.7));
    }
    .bottom-nav-item .nav-indicator {
      position: absolute;
      top: 0;
      width: 28px;
      height: 3px;
      background: #f59e0b;
      border-radius: 0 0 3px 3px;
      box-shadow: 0 0 8px #f59e0b;
      opacity: 0;
      transform: scaleX(0);
      transition: all 0.2s ease;
    }
    .bottom-nav-item.active .nav-indicator {
      opacity: 1;
      transform: scaleX(1);
    }
    .nav-badge {
      position: absolute;
      top: 4px;
      right: 50%;
      margin-right: -18px;
      background: #ef4444;
      color: #fff;
      font-size: 0.60rem;
      font-weight: 800;
      padding: 1px 4px;
      border-radius: 9999px;
      min-width: 14px;
      text-align: center;
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.6);
    }
    .nav-badge.badge-green {
      background: #10b981;
      box-shadow: 0 0 8px rgba(16, 185, 129, 0.6);
    }
    .nav-dot {
      position: absolute;
      top: 6px;
      right: 50%;
      margin-right: -13px;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #6b7280;
    }
    .nav-dot.active {
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    /* PWA Install Button & Modal Styles */
    .btn-pwa-install {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      font-weight: 700;
      border: none;
      padding: 0.38rem 0.7rem;
      border-radius: 0.45rem;
      font-size: 0.75rem;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-pwa-install:hover {
      filter: brightness(1.1);
    }
    .btn-pwa-cta {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
      font-weight: 800;
      text-decoration: none;
      padding: 0.65rem 1.1rem;
      border-radius: 0.6rem;
      font-size: 0.82rem;
      box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);
      transition: all 0.15s ease;
      cursor: pointer;
    }
    .btn-pwa-cta:hover { filter: brightness(1.1); transform: translateY(-1px); }
    .btn-pwa-copy {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.18);
      color: #f3f4f6;
      font-weight: 700;
      padding: 0.65rem 1rem;
      border-radius: 0.6rem;
      font-size: 0.82rem;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-pwa-copy:hover { background: rgba(255, 255, 255, 0.14); }
    .pwa-guide-box {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 0.75rem;
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .pwa-step {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 0.74rem;
      color: #cbd5e1;
      line-height: 1.45;
    }
    .pwa-step-num {
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid rgba(59, 130, 246, 0.4);
      color: #93c5fd;
      font-weight: 800;
      font-size: 0.68rem;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 2px;
    }

    /* Mobile Responsive Optimizations */
    @media (max-width: 768px) {
      html { font-size: 11.5px; }
      body {
        padding: 0.5rem 0.5rem calc(66px + env(safe-area-inset-bottom)) 0.5rem;
      }
      .container { gap: 0.85rem; }
      .desktop-tabs { display: none; }
      .bottom-nav { display: flex; }
      header {
        position: sticky;
        top: 0;
        z-index: 100;
        background: rgba(9, 13, 22, 0.95);
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        margin: -0.5rem -0.5rem 0.65rem -0.5rem;
        padding: 0.65rem 0.75rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        gap: 0.4rem;
      }
      .title-group h1 { font-size: 1.05rem; }
      .title-group p { display: none; }
      .controls { display: flex; align-items: center; gap: 0.35rem; flex-wrap: nowrap; }
      .header-desktop-link { display: none; }
      
      .session-bar {
        padding: 0.5rem 0.65rem;
        gap: 0.4rem;
      }
      .session-bar-left {
        min-width: 100%;
        width: 100%;
        gap: 0.4rem;
      }
      .run-selector-pill {
        width: 100%;
        max-width: 100%;
        padding: 2px 6px;
      }
      .run-select-dropdown {
        width: 100%;
        max-width: 100%;
        font-size: 0.74rem;
        padding: 0.25rem 0.2rem;
      }
      .session-bar-right {
        width: 100%;
        gap: 0.3rem;
      }
      .session-meta-pill {
        font-size: 0.68rem;
        padding: 2px 6px;
      }
      
      .autobuy-panel {
        padding: 0.75rem;
        gap: 0.75rem;
      }
      .autobuy-header {
        flex-direction: column;
        align-items: stretch;
        gap: 0.65rem;
      }
      .autobuy-header-right {
        justify-content: space-between;
      }
      .autobuy-grid {
        grid-template-columns: 1fr;
        gap: 0.65rem;
      }
      .real-trades-container {
        padding: 0.75rem;
      }
      .real-trades-header {
        flex-direction: column;
        align-items: stretch;
        gap: 0.55rem;
      }
      .scope-segmented-control {
        width: 100%;
        display: flex;
      }
      .scope-segmented-control .btn-filter {
        flex: 1;
        text-align: center;
        justify-content: center;
        font-size: 0.68rem;
        padding: 0.28rem 0.45rem;
      }

      .modal-overlay { padding: 0; align-items: flex-end; }
      .modal-box { max-width: 100%; max-height: 90vh; border-radius: 1.25rem 1.25rem 0 0; border-bottom: none; }
      .mobile-hint { display: block; font-size: 0.68rem; margin-bottom: 0.4rem; }
      .kpi-grid { grid-template-columns: repeat(2, 1fr); gap: 0.4rem; }
      .kpi-card { padding: 0.55rem 0.65rem; }
      .kpi-value { font-size: 1.05rem; }
      .kpi-label { font-size: 0.65rem; }
      .kpi-sub { font-size: 0.62rem; }
      .rules-banner { gap: 0.35rem; font-size: 0.68rem; padding: 0.5rem; }
      .worker-grid { grid-template-columns: 1fr; }
      th, td { padding: 0.45rem 0.55rem; font-size: 0.70rem; }
      .route-cell-box { font-size: 0.66rem; min-width: 135px; padding: 3px 5px; }
      .route-time { font-size: 0.62rem; }
      .btn-filter { font-size: 0.68rem; padding: 0.25rem 0.55rem; }
      input, select { font-size: 0.78rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- HTTPS NOTICE BANNER (Active when accessed via insecure HTTP) -->
    <div id="httpsNoticeBanner" style="display: none; background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 0.65rem; padding: 0.5rem 0.85rem; font-size: 0.72rem; color: #a7f3d0; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="font-size: 0.95rem;">🔒</span>
        <span><b>Versi HTTPS PWA Aktif:</b> Browser membatasi instalasi aplikasi di HTTP. Gunakan link HTTPS Cloudflare resmi kami agar bisa dipasang sebagai Aplikasi Native di HP/PC.</span>
      </div>
      <div style="display: flex; gap: 6px; align-items: center;">
        <a id="httpsBannerLink" href="#" target="_blank" rel="noopener" style="background: #10b981; color: #000; font-weight: 700; text-decoration: none; padding: 4px 10px; border-radius: 5px; font-size: 0.70rem; white-space: nowrap;">Buka Versi HTTPS ↗</a>
        <button onclick="document.getElementById('httpsNoticeBanner').style.display='none'" style="background: none; border: none; color: #9ca3af; font-size: 1.1rem; cursor: pointer; padding: 0 4px; line-height: 1;">&times;</button>
      </div>
    </div>

    <header>
      <div class="title-group">
        <h1>
          <span>⚡ AGY Aggressive Sniper</span>
          <span class="badge-aggressive">7-Lane Parallel</span>
          <span class="live-pulse"></span>
        </h1>
        <p>Live 3-Worker Parallel Execution · 7-Lane Real-Time Benchmark · Live GMGN Route Quotes per 500ms</p>
      </div>
      <div class="controls">
        <button class="btn-refresh" onclick="fetchData()" title="Perbarui Data Sinyal & On-Chain">⟳ Refresh</button>
        <button id="btnPwaInstall" class="btn-pwa-install" onclick="triggerPwaInstall()">📲 Pasang App</button>
        <a href="#realTradesSection" onclick="switchTab('onchain')" class="header-desktop-link" style="background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); text-decoration: none; padding: 0.5rem 0.8rem; border-radius: 0.5rem; font-size: 0.82rem; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">💳 On-Chain</a>
        <a href="/simulation" target="_blank" class="header-desktop-link" style="background: rgba(2, 132, 199, 0.2); color: #38bdf8; border: 1px solid rgba(2, 132, 199, 0.4); text-decoration: none; padding: 0.5rem 0.8rem; border-radius: 0.5rem; font-size: 0.82rem; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">💰 Simulasi $20</a>
      </div>
    </header>

    <!-- Unified Runner & Active Session Control Bar -->
    <div id="activeRunBanner" class="session-bar">
      <div class="session-bar-left">
        <div class="run-selector-pill">
          <label for="runSelect" class="run-picker-label">📁 Sesi Run:</label>
          <select id="runSelect" onchange="changeRun(this.value)" class="run-select-dropdown">
            <option value="">Memuat sesi run...</option>
          </select>
        </div>
        <span id="runStatusBadge" class="status-badge status-active">🔴 LIVE RUN</span>
        <span id="bannerRunTitle" style="display: none;">Memuat run...</span>
      </div>
      <div class="session-bar-right">
        <span id="bannerRunDate" class="session-meta-pill">Mulai: —</span>
        <span id="bannerRuntime" class="session-meta-pill">⏱️ Durasi: —</span>
        <span id="bannerTradeCount" class="session-meta-pill session-pill-accent">0 Closed Trades</span>
        <a href="/comparison" target="_blank" class="btn-audit-quick">🔍 Audit 1-Row ↗</a>
      </div>
    </div>

    <!-- Desktop Navigation Tabs (Hidden on mobile) -->
    <div class="desktop-tabs">
      <button class="desktop-tab-btn active" data-tab="overview" onclick="switchTab('overview')">
        <span>📊 Ringkasan Sinyal & 7 Lane</span>
      </button>
      <button class="desktop-tab-btn" data-tab="positions" onclick="switchTab('positions')">
        <span>🎯 Posisi Aktif</span>
        <span class="nav-badge badge-green" id="desktopPosBadge" style="display: none; position: static; margin-left: 4px;">0</span>
      </button>
      <button class="desktop-tab-btn" data-tab="history" onclick="switchTab('history')">
        <span>📜 Riwayat Transaksi</span>
        <span class="nav-badge" id="desktopTradesBadge" style="display: none; position: static; margin-left: 4px;">0</span>
      </button>
      <button class="desktop-tab-btn" data-tab="onchain" onclick="switchTab('onchain')">
        <span>💳 On-Chain & Auto-Buy</span>
        <span class="nav-badge" id="desktopRealBadge" style="display: none; position: static; margin-left: 4px;">0</span>
      </button>
    </div>

    <!-- TAB 1: OVERVIEW & SIGNAL MONITOR -->
    <div id="pane-overview" class="tab-pane active">

    <!-- Multi-Lane Rules Banner (7 Plans) -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px;">
      <div style="background: rgba(6, 78, 59, 0.2); border: 1px solid rgba(52, 211, 153, 0.35); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #6ee7b7; font-size: 0.74rem; margin-bottom: 3px;">🟢 Plan 1: Safe Aggressive (Live Baseline)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> Inflow ≥ $300 (5s), Top Buyer ≤ 70%, Dev ≤ 2.5%, MC $5.5k–$15k, Buyers ≥ 4<br>
          • <b>Exit:</b> Hard Stop -3.0%, Breakeven Lock di <b>+4.0%</b> (Floor +0.5%), Runner Trail ≥ +8.0%
        </div>
      </div>
      <div style="background: rgba(88, 28, 135, 0.22); border: 1px solid rgba(192, 132, 252, 0.4); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #d8b4fe; font-size: 0.74rem; margin-bottom: 3px;">🟣 Plan 2: Aggressive Optimal (Refined High-Win Filter)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> Inflow ≥ <b>$400</b> (5s), Top Buyer ≤ <b>50%</b>, Top1 ≤ <b>6.0%</b>, Flow20s ≥ <b>65%</b><br>
          • <b>Exit:</b> Hard Stop -3.0%, Breakeven Lock di <b>+4.0%</b> (Floor +0.5%), Runner Trail ≥ +8.0%
        </div>
      </div>
      <div style="background: rgba(180, 83, 9, 0.22); border: 1px solid rgba(251, 191, 36, 0.4); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #fcd34d; font-size: 0.74rem; margin-bottom: 3px;">🟠 Plan 3: Aggressive Wide (Anti-Shakeout Runner)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> Inflow ≥ <b>$400</b> (5s), Top Buyer ≤ <b>50%</b>, Ret 5s ≤ <b>22%</b>, Dev ≤ 2.5%, MC $5.5k–$15k<br>
          • <b>Exit:</b> <b>Hard Stop -6.0%</b> (Anti-Shakeout), Breakeven Lock di <b>+4.0%</b>, Runner Trail ≥ +8.0%
        </div>
      </div>
      <div style="background: rgba(12, 74, 110, 0.25); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #38bdf8; font-size: 0.74rem; margin-bottom: 3px;">🌊 Plan 7: Aggressive Swing 100k (MC $10k–$100k Multi-Entry)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> Inflow ≥ <b>$300</b> (5s), MC <b>$10k–$100k</b>, Top1 ≤ 10%, Dev ≤ 2.5%, Multi-entry re-trade<br>
          • <b>Exit:</b> Hard Stop <b>-4.0%</b>, Breakeven Lock di <b>+6.5%</b> (Floor +1.0%), Runner Trail ≥ <b>+9.0%</b>
        </div>
      </div>
      <div style="background: rgba(13, 148, 136, 0.25); border: 1px solid rgba(45, 212, 191, 0.4); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #2dd4bf; font-size: 0.74rem; margin-bottom: 3px;">⚡ Plan 8: Aggressive Wave (Wave Maximizer: Target Dinamis ATH Min +20%, Trailing Runner, Turun Ditunggu)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> Order Flow Buy ≥ <b>60%</b>, Dev ≤ <b>3.5%</b>, Top1 ≤ <b>25%</b>, Buyers ≥ 3, Inflow ≥ $300<br>
          • <b>Exit:</b> <b>Target Dinamis Sejarah Token (Min +20% s/d +150%)</b>, Breakeven Lock di <b>+10%</b> (Floor +3%), Runner Trail <b>5%</b> dari Puncak (&ge;18%), <b>Turun Ditunggu</b> (Hard Stop luas <b>-6.0%</b>, Stagnation 45s)
        </div>
      </div>
      <div style="background: rgba(30, 58, 138, 0.22); border: 1px solid rgba(96, 165, 250, 0.4); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #93c5fd; font-size: 0.74rem; margin-bottom: 3px;">🔵 Plan 4: Momentum V2 (Classic 2x Snapshot Benchmark)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> 2x Holder Growth berturut-turut, Inflow stabil, Dev ≤ 2.5%, MC $5.5k–$15k<br>
          • <b>Exit:</b> Hard Stop -20%, Profit Lock +40%, Major Holder Exit, Polling Live Swap 500ms
        </div>
      </div>
      <div style="background: rgba(88, 28, 135, 0.28); border: 1px solid rgba(192, 132, 252, 0.45); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #c084fc; font-size: 0.74rem; margin-bottom: 3px;">✨ Plan 5: Momentum V3 (Runner & Whale Hold Confirm)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> Inflow/Holder Growth V2/V3 Filter, Dev ≤ 2.5%, MC $5.5k–$15k<br>
          • <b>Exit:</b> 5s Whale Confirm (Hold jika BuyFlow > SellFlow), Runner Absorption Hold, Hard Stop -20%, Polling Swap 500ms
        </div>
      </div>
      <div style="background: rgba(113, 63, 18, 0.25); border: 1px solid rgba(250, 204, 21, 0.45); border-radius: 0.65rem; padding: 0.65rem 0.85rem;">
        <div style="font-weight: 700; color: #facc15; font-size: 0.74rem; margin-bottom: 3px;">🟡 Plan 6: Momentum R5 Band (+5% s/d +10% Anti-Spike)</div>
        <div style="font-size: 0.67rem; color: #cbd5e1; line-height: 1.45;">
          • <b>Entry:</b> 2x Holder Naik, Return 5s di Band <b>+5.0%–+10.0%</b> (No FOMO di Pucuk), MC $5.5k–$15k<br>
          • <b>Exit:</b> Hard Stop -20%, Profit Lock +40%, Major Holder Exit, Polling Live Swap 500ms
        </div>
      </div>
    </div>

    <!-- Multi-Lane Comparative Scorecard (7 Active Plans) -->
    <div class="comparison-grid">
      <!-- Safe Lane Card -->
      <div class="lane-card lane-card-safe">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #6ee7b7;">🟢 SAFE AGGRESSIVE</span>
          <span class="tag tag-lane-safe">Baseline Dev &le; 2.5%</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="safeRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="safeRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="safeRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="safeSocketScore" class="kpi-sub" style="color: #34d399;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="safeTrapNote" style="font-size: 0.66rem; color: #a7f3d0; border-top: 1px dashed rgba(52, 211, 153, 0.3); padding-top: 5px;">
          🛡️ Rules: Inflow &ge; $300 | TopBuyer &le; 70% | BE +4%
        </div>
      </div>

      <!-- Optimal Lane Card -->
      <div class="lane-card lane-card-optimal">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #d8b4fe;">🟣 AGGRESSIVE OPTIMAL</span>
          <span class="tag tag-lane-optimal">Top1 &le; 6% · Flow20s &ge; 65%</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="optimalRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="optimalRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="optimalRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="optimalSocketScore" class="kpi-sub" style="color: #c084fc;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="optimalTrapNote" style="font-size: 0.66rem; color: #e9d5ff; border-top: 1px dashed rgba(168, 85, 247, 0.3); padding-top: 5px;">
          ⚡ Rules: Inflow &ge; $400 | TopBuyer &le; 50% | Top1 &le; 6.0% (Anti-Dump) | Flow20s &ge; 65% | Dev &le; 2.0%
        </div>
      </div>

      <!-- Wide Lane Card -->
      <div class="lane-card lane-card-wide">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #fcd34d;">🟠 AGGRESSIVE WIDE</span>
          <span class="tag tag-lane-wide">Stop -6.0% · Anti-Shakeout</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="wideRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="wideRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="wideRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="wideSocketScore" class="kpi-sub" style="color: #fbbf24;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="wideTrapNote" style="font-size: 0.66rem; color: #fde68a; border-top: 1px dashed rgba(245, 158, 11, 0.3); padding-top: 5px;">
          🚀 Rules: Inflow &ge; $400 | Stop -6.0% | BE +4% | Runner Hold
        </div>
      </div>

      <!-- Swing 100k Lane Card -->
      <div class="lane-card lane-card-swing">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #38bdf8;">🌊 AGGRESSIVE SWING 100K</span>
          <span class="tag tag-lane-swing">MC $10k-$100k · Multi-Entry</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="swingRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="swingRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="swingRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="swingSocketScore" class="kpi-sub" style="color: #38bdf8;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="swingTrapNote" style="font-size: 0.66rem; color: #bae6fd; border-top: 1px dashed rgba(56, 189, 248, 0.3); padding-top: 5px;">
          🌊 Rules: Min MC $10k-$100k | Inflow &ge; $300 | Multi-Entry Re-trade | Target +12% | Stop -5%
        </div>
      </div>

      <!-- Wave Scalper Lane Card -->
      <div class="lane-card lane-card-wave">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #2dd4bf;">⚡ AGGRESSIVE WAVE</span>
          <span class="tag tag-lane-wave">Wave Maximizer · Min +20%</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="waveRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="waveRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="waveRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="waveSocketScore" class="kpi-sub" style="color: #2dd4bf;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="waveTrapNote" style="font-size: 0.66rem; color: #99f6e4; border-top: 1px dashed rgba(45, 212, 191, 0.3); padding-top: 5px;">
          ⚡ Rules: Target Dinamis ATH (Min +20%) | Runner Trail 5% (&ge;18%) | Breakeven +10% | Turun Ditunggu (Stop -6.0%)
        </div>
      </div>

      <!-- Momentum V2 Lane Card -->
      <div class="lane-card lane-card-v2">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #93c5fd;">🔵 MOMENTUM V2</span>
          <span class="tag tag-lane-v2">Classic 2x Snapshot · 500ms AMM</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="v2RealWinRate" class="kpi-value mono">0.0%</div>
            <div id="v2RealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="v2RealPnl" class="kpi-value mono">$0.0000</div>
            <div id="v2SocketScore" class="kpi-sub" style="color: #60a5fa;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="v2TrapNote" style="font-size: 0.66rem; color: #bfdbfe; border-top: 1px dashed rgba(59, 130, 246, 0.3); padding-top: 5px;">
          🔍 Rules: 2x Holder Snapshot Naik | Major Holder Exit | Stop -20% | Target +40%
        </div>
      </div>

      <!-- Momentum V3 Lane Card -->
      <div class="lane-card lane-card-v3">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #c084fc;">✨ MOMENTUM V3</span>
          <span class="tag tag-lane-v3">Whale Confirm · Runner Hold</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="v3RealWinRate" class="kpi-value mono">0.0%</div>
            <div id="v3RealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="v3RealPnl" class="kpi-value mono">$0.0000</div>
            <div id="v3SocketScore" class="kpi-sub" style="color: #c084fc;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="v3TrapNote" style="font-size: 0.66rem; color: #e9d5ff; border-top: 1px dashed rgba(192, 132, 252, 0.3); padding-top: 5px;">
          ⚡ Rules: Hold Whale Sell 5s jika Buy Flow Dominan | Runner Trailing | Target +40%
        </div>
      </div>

      <!-- Momentum R5 Band Lane Card -->
      <div class="lane-card lane-card-r5">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #facc15;">🟡 MOMENTUM R5 BAND</span>
          <span class="tag tag-lane-r5">Band +5%..+10% · Anti-Spike</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="r5RealWinRate" class="kpi-value mono">0.0%</div>
            <div id="r5RealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="r5RealPnl" class="kpi-value mono">$0.0000</div>
            <div id="r5SocketScore" class="kpi-sub" style="color: #facc15;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="r5TrapNote" style="font-size: 0.66rem; color: #fef08a; border-top: 1px dashed rgba(250, 204, 21, 0.3); padding-top: 5px;">
          🎯 Rules: Return 5s di Band +5% s/d +10% | 2x Holder Naik | Stop -20% | Target +40%
        </div>
      </div>

      <!-- Raw Lane Card -->
      <div id="rawLaneCard" class="lane-card lane-card-raw">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-weight: 800; font-size: 0.88rem; color: #93c5fd;">🔵 RAW AGGRESSIVE</span>
          <span class="tag tag-lane-raw">Raw Baseline</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div>
            <div class="kpi-label">Real Win Rate</div>
            <div id="rawRealWinRate" class="kpi-value mono">0.0%</div>
            <div id="rawRealScore" class="kpi-sub">0W / 0L</div>
          </div>
          <div>
            <div class="kpi-label">Net Real Profit ($)</div>
            <div id="rawRealPnl" class="kpi-value mono">$0.0000</div>
            <div id="rawSocketScore" class="kpi-sub" style="color: #60a5fa;">Socket: 0.0% ($0.00)</div>
          </div>
        </div>
        <div id="rawNote" style="font-size: 0.66rem; color: #bfdbfe; border-top: 1px dashed rgba(96, 165, 250, 0.3); padding-top: 5px;">
          🎯 Baseline Agresif: Inflow &gt;= $300 | Stop -3% | BE +5% | Runner Trail 8%
        </div>
      </div>
    </div>

    <!-- Overall Master KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Total Real Swap Win Rate</div>
        <div class="kpi-value" id="realWinRate">0.0%</div>
        <div class="kpi-sub" id="realScore">0W / 0L (Gabungan)</div>
        <div class="kpi-sub" id="socketScoreCompare" style="color: #60a5fa; margin-top: 2px;">📈 Chart Socket: 0.0% (0W/0L)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Total Net Real Profit ($)</div>
        <div class="kpi-value" id="netRealPnl">$0.0000</div>
        <div class="kpi-sub">Hasil swap SELL dikurangi modal BUY</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Chart Socket PnL (Pembanding)</div>
        <div class="kpi-value" id="netTradePnl">$0.0000</div>
        <div class="kpi-sub">Kenaikan harga grafik tanpa slippage pool</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">AMM Route Slippage</div>
        <div class="kpi-value down" id="avgSlippage">-5.43%</div>
        <div class="kpi-sub">Deviasi harga socket vs executable route</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Mean Route Latency</div>
        <div class="kpi-value mono" id="avgLatency">0 ms</div>
        <div class="kpi-sub">WebSocket tick → Decision → GMGN quote</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Socket Throughput</div>
        <div class="kpi-value mono" id="socketRate">0 /s</div>
        <div class="kpi-sub" id="socketTotals">0 trades · 0 ticks</div>
      </div>
    </div>

    <!-- 3-Worker Status Panel -->
    <div>
      <div class="section-title">
        <span>🤖 Status 3 Worker Paralel</span>
      </div>
      <div class="worker-grid" id="workerGrid">
        <!-- Injected via JS -->
      </div>
    </div>
  </div><!-- /#pane-overview -->

  <!-- TAB 2: LIVE POSITIONS -->
  <div id="pane-positions" class="tab-pane">
    <!-- Live Positions Table -->
    <div>
      <div class="section-title">
        <span>🎯 Posisi Aktif Sedang Berjalan (<span id="openCount">0</span>)</span>
      </div>
      <div class="mobile-hint">📱 Tampilan Mobile: Geser tabel ke kanan untuk melihat status posisi ➔</div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th class="sticky-col">Token</th>
              <th>Lane</th>
              <th>Worker</th>
              <th>Harga Entry</th>
              <th>Harga Socket Saat Ini</th>
              <th>Floating PnL % (Est. Swap vs Chart)</th>
              <th>Peak PnL %</th>
              <th>Trailing Stop Floor</th>
              <th>Stagnation Cutdown (12s)</th>
            </tr>
          </thead>
          <tbody id="openPositionsBody">
            <tr><td colspan="9" class="empty-state">Tidak ada posisi terbuka saat ini. Worker sedang memindai token baru.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div><!-- /#pane-positions -->

  <!-- TAB 3: CLOSED TRADES HISTORY -->
  <div id="pane-history" class="tab-pane">
    <!-- Unified Trades & Route Execution Master Table -->
    <div>
      <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <span>📊 Riwayat Transaksi & Eksekusi Swap (<span id="closedCount">0</span>)</span>
        <div class="filter-chips-bar">
          <button id="btnFilterAll" class="btn-filter active" onclick="setLaneFilter('all')">Semua</button>
          <button id="btnFilterOptimal" class="btn-filter" onclick="setLaneFilter('aggressive-optimal')">🟣 Optimal</button>
          <button id="btnFilterWide" class="btn-filter" onclick="setLaneFilter('aggressive-wide')">🟠 Wide</button>
          <button id="btnFilterSwing" class="btn-filter" onclick="setLaneFilter('aggressive-swing-100k')">🌊 Swing 100k</button>
          <button id="btnFilterWave" class="btn-filter" onclick="setLaneFilter('aggressive-wave')">⚡ Wave Maximizer</button>
          <button id="btnFilterSafe" class="btn-filter" onclick="setLaneFilter('aggressive-safe')">🟢 Safe</button>
          <button id="btnFilterV2" class="btn-filter" onclick="setLaneFilter('momentum-v2')">🔵 V2</button>
          <button id="btnFilterV3" class="btn-filter" onclick="setLaneFilter('momentum-v3')">✨ V3</button>
          <button id="btnFilterR5" class="btn-filter" onclick="setLaneFilter('r5-band')">🟡 R5 Band</button>
          <button id="btnFilterRaw" class="btn-filter" onclick="setLaneFilter('control')">⚪ Raw</button>
        </div>
      </div>
      <div class="mobile-hint">📱 Tampilan Mobile: Geser tabel ke kanan untuk melihat rute swap & detail lengkap ➔</div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th class="sticky-col">Token</th>
              <th>Lane</th>
              <th>Worker</th>
              <th>Waktu & Durasi</th>
              <th>Harga Entry → Exit</th>
              <th>Alasan Exit</th>
              <th>Return % (Swap vs Socket)</th>
              <th>🟢 Rute Swap BUY (In → Out)</th>
              <th>🔴 Rute Swap SELL (In → Out)</th>
              <th>Net Profit ($) Riil</th>
              <th>Status Riil</th>
            </tr>
          </thead>
          <tbody id="closedTradesBody">
            <tr><td colspan="11" class="empty-state">Belum ada trade yang ditutup pada sesi ini.</td></tr>
          </tbody>
        </table>
        <div class="pagination-bar" id="closedPaginationBar">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>Tampilkan:</span>
            <select id="closedPageSizeSelect" class="page-size-select" onchange="changeClosedPageSize(this.value)">
              <option value="15">15 per hal</option>
              <option value="25" selected>25 per hal</option>
              <option value="50">50 per hal</option>
              <option value="100">100 per hal</option>
              <option value="99999">Semua</option>
            </select>
            <span id="closedPageInfo" class="mono" style="color: #9ca3af;">Menampilkan 0–0 dari 0 transaksi</span>
          </div>
          <div class="pagination-controls">
            <button class="btn-page" id="btnClosedFirst" onclick="goToClosedPage(1)" title="Halaman Pertama">« Pertama</button>
            <button class="btn-page" id="btnClosedPrev" onclick="goToClosedPage(closedCurrentPage - 1)" title="Sebelumnya">‹ Prev</button>
            <span style="font-weight: 700; color: #f3f4f6; margin: 0 4px;" class="mono" id="closedCurrentPageLabel">1 / 1</span>
            <button class="btn-page" id="btnClosedNext" onclick="goToClosedPage(closedCurrentPage + 1)" title="Berikutnya">Next ›</button>
            <button class="btn-page" id="btnClosedLast" onclick="goToClosedPage(999999)" title="Halaman Terakhir">Terakhir »</button>
          </div>
        </div>
      </div>
    </div>
  </div><!-- /#pane-history -->

  <!-- TAB 4: ON-CHAIN & AUTO-BUY -->
  <div id="pane-onchain" class="tab-pane">
    <!-- Quick Action Cards in On-Chain Tab -->
    <div class="onchain-top-actions">
      <a href="/simulation" target="_blank" class="onchain-action-card">
        <div>
          <div class="action-card-title">💰 Simulasi Cashflow $20 Modal ↗</div>
          <div class="action-card-sub">Proyeksi pertumbuhan modal estafet $20 ke $100+</div>
        </div>
        <span class="action-card-arrow">➔</span>
      </a>
      <a href="/comparison" target="_blank" class="onchain-action-card">
        <div>
          <div class="action-card-title">🔍 Audit 1-Row Eksekusi ↗</div>
          <div class="action-card-sub">Komparasi harga Socket Tick vs Swap Route vs Real</div>
        </div>
        <span class="action-card-arrow">➔</span>
      </a>
    </div>

    <!-- GMGN Feed & Worker Controller Panel -->
    <div class="autobuy-panel" style="margin-bottom: 1.2rem; border-color: rgba(56, 189, 248, 0.4); background: linear-gradient(145deg, rgba(15, 23, 42, 0.95), rgba(8, 47, 73, 0.3));">
      <div class="autobuy-header">
        <div class="autobuy-header-left">
          <div class="autobuy-icon-wrap" style="background: rgba(56, 189, 248, 0.2); border-color: rgba(56, 189, 248, 0.4); color: #38bdf8;">🛰️</div>
          <div>
            <div class="autobuy-title">
              <span>Sumber URL Feed GMGN & Filter Market Cap</span>
              <span id="workerStatusBadge" class="status-badge" style="font-size: 0.75rem; padding: 2px 8px;">Memuat status worker...</span>
            </div>
            <div class="autobuy-subtitle">
              Pilih URL tab screener GMGN dan rentang Market Cap. Klik "Terapkan & Restart" untuk update live tanpa terminal.
            </div>
          </div>
        </div>
        <div class="autobuy-header-right" style="gap: 8px;">
          <button id="btnStartWorker" class="btn-micro-action" style="background: #10b981; color: white; padding: 0.45rem 0.8rem; font-weight: 700; border-radius: 6px; cursor: pointer;" onclick="controlWorkerAction('start')">▶️ Start Worker</button>
          <button id="btnStopWorker" class="btn-micro-action" style="background: #ef4444; color: white; padding: 0.45rem 0.8rem; font-weight: 700; border-radius: 6px; cursor: pointer;" onclick="controlWorkerAction('stop')">⏹️ Stop Worker</button>
          <button id="btnApplyFeed" class="btn-refresh" style="background: linear-gradient(135deg, #0284c7, #0369a1); color: white; padding: 0.45rem 0.9rem; font-weight: 700; border: none; border-radius: 6px; cursor: pointer;" onclick="saveFeedAndRestart()">💾 Terapkan & Restart</button>
        </div>
      </div>

      <div class="autobuy-grid" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));">
        <!-- Card 1: URL Feed GMGN Dropdown -->
        <div class="config-card">
          <label class="config-label">🌐 URL Screener GMGN (Pilihan Cepat)</label>
          <select id="cfgFeedUrlSelect" class="config-select" onchange="onFeedUrlPresetChange(this.value)">
            <option value="https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=new_pair">⚡ New Pair (Ref: bFC8902n) - Rekomendasi</option>
            <option value="https://gmgn.ai/trend?chain=sol&tab=new_pair">⚡ New Pair (Standar GMGN)</option>
            <option value="https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=trending">🔥 Trending Pairs (Ref: bFC8902n)</option>
            <option value="https://gmgn.ai/trend?chain=sol&tab=trending">🔥 Trending Pairs (Standar GMGN)</option>
            <option value="https://gmgn.ai/trend?chain=sol&tab=completing">🎯 Completing (Bonding Curve >80%)</option>
          </select>
          <div class="config-hint" id="cfgFeedUrlDisplay" style="word-break: break-all; font-family: monospace; font-size: 0.72rem; color: #94a3b8; margin-top: 4px;">
            https://gmgn.ai/trend?chain=sol&ref=bFC8902n&tab=new_pair
          </div>
        </div>

        <!-- Card 2: Filter Market Cap Range Dropdown -->
        <div class="config-card">
          <label class="config-label">📊 Filter Rentang Market Cap (Pilihan Cepat)</label>
          <select id="cfgMcPreset" class="config-select" onchange="onMcPresetChange(this.value)">
            <option value="10k-100k">🌊 $10k - $100k (Swing 100k - Rekomendasi)</option>
            <option value="5.5k-15k">⚡ $5.5k - $15k (Micro Fast Scalp)</option>
            <option value="15k-50k">🚀 $15k - $50k (Mid Micro Pump)</option>
            <option value="20k-100k">🛡️ $20k - $100k (Safe Cap Swing)</option>
            <option value="50k-250k">💎 $50k - $250k (Higher Cap Runner)</option>
            <option value="all">🌐 Semua / Tanpa Filter MC (0 - Tak Terbatas)</option>
          </select>
          <div class="config-hint" id="cfgMcDetailDisplay" style="color: #38bdf8; margin-top: 4px;">
            Rentang aktif: Min $10,000 USD — Max $100,000 USD
          </div>
        </div>
      </div>
    </div>

    <!-- Real Auto-Buy Control Panel -->
    <div class="autobuy-panel">
      <!-- Master Header -->
      <div class="autobuy-header">
        <div class="autobuy-header-left">
          <div class="autobuy-icon-wrap">⚡</div>
          <div>
            <div class="autobuy-title">
              <span>Kontrol Real Auto-Buy (Eksekusi On-Chain GMGN Swap)</span>
              <span id="autoBuyBadge" class="status-badge" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid #ef4444; font-size: 0.75rem; padding: 2px 8px;">🔴 OFF (Paper Only)</span>
            </div>
            <div class="autobuy-subtitle">
              Mengeksekusi order riil di GMGN via Direct Swap Batch API saat lane terpilih memicu sinyal buy.
            </div>
          </div>
        </div>
        <div class="autobuy-header-right">
          <label class="switch-container">
            <span style="font-weight: 700; font-size: 0.85rem; color: #f3f4f6;" id="autoBuyToggleLabel">Auto-Buy Master:</span>
            <div class="switch-track">
              <input type="checkbox" id="autoBuyToggle" onchange="toggleAutoBuyMaster(this.checked)">
              <span class="switch-slider"></span>
            </div>
          </label>
          <button class="btn-refresh btn-save-autobuy" onclick="saveAutoBuySettings()">
            💾 Simpan Pengaturan
          </button>
        </div>
      </div>

      <!-- Config 4-Card Responsive Grid -->
      <div class="autobuy-grid">
        <!-- Card 1: Lane Selection -->
        <div class="config-card">
          <label class="config-label">🎯 Lane Pemicu Real Buy</label>
          <select id="cfgLane" class="config-select">
            <option value="aggressive-optimal">🟣 Aggressive Optimal (Rekomendasi)</option>
            <option value="aggressive-swing-100k">🌊 Swing 100k ($10k-$100k MC)</option>
            <option value="aggressive-wave">⚡ Aggressive Wave (Wave Maximizer: Min +20% Target, Trail Runner)</option>
            <option value="aggressive-safe">🟢 Safe Aggressive (Baseline)</option>
            <option value="aggressive-wide">🟠 Wide Aggressive (-6% Stop)</option>
            <option value="momentum-v2">🔵 Momentum V2 (2x Snapshot)</option>
            <option value="momentum-v3">✨ Momentum V3 (Whale Confirm)</option>
            <option value="r5-band">🟡 Momentum R5 Band (+5..+10%)</option>
            <option value="control">🔵 Raw Aggressive (Tanpa Filter)</option>
          </select>
          <div class="config-hint">Hanya order dari lane terpilih yang dieksekusi di pool GMGN.</div>
        </div>

        <!-- Card 2: Modal & Stake -->
        <div class="config-card">
          <label class="config-label">💵 Modal Per Buy</label>
          <div style="display: flex; gap: 6px;">
            <select id="cfgStakeMode" class="config-select" style="width: 90px;" onchange="updateStakeModeUI()">
              <option value="usd">USD ($)</option>
              <option value="sol">SOL (◎)</option>
            </select>
            <input type="number" id="cfgStakeAmount" step="0.01" class="config-input mono" value="0.5">
          </div>
          <div class="config-hint" id="cfgStakeHint">Default: $0.50 USD per order buy.</div>
        </div>

        <!-- Card 3: Kuota, Holding & Gas -->
        <div class="config-card">
          <label class="config-label">🛑 Kuota & Manajemen Risiko</label>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 6px;">
            <div>
              <span class="sub-label">Max Buys:</span>
              <input type="number" id="cfgMaxBuys" min="0" max="9999" placeholder="0 = Unlimited" class="config-input mono" value="0" title="0 = Unlimited">
            </div>
            <div>
              <span class="sub-label">Concurrent Hold:</span>
              <input type="number" id="cfgMaxConcurrent" min="1" max="10" placeholder="1" class="config-input mono" value="1" title="Max posisi hold bersamaan (1 = estafet aman)">
            </div>
          </div>
          <div style="display: flex; gap: 4px; align-items: center; margin-bottom: 6px;">
            <button onclick="setUnlimitedBuys()" class="btn-micro-action btn-micro-accent">♾️ Unlimited</button>
            <button onclick="resetCompletedBuys()" class="btn-micro-action">⟳ Reset (0)</button>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px;">
            <div>
              <span class="sub-label">Slippage %:</span>
              <input type="number" id="cfgSlippage" min="1" max="50" class="config-input mono" value="15" title="Slippage %">
            </div>
            <div>
              <span class="sub-label">Priority SOL:</span>
              <input type="number" id="cfgPriorityFee" step="0.0001" class="config-input mono" value="0.0001" title="Priority Fee SOL">
            </div>
          </div>
          <div class="config-hint" id="cfgQuotaStatus" style="color: #38bdf8; margin-top: 4px;">
            Kuota: 0 order (♾️ Unlimited) · Hold Max: 1 Token
          </div>
        </div>

        <!-- Card 4: Wallet Status -->
        <div class="config-card config-card-wallet">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span class="config-label" style="color: #34d399; margin: 0;">💼 Dompet GMGN Riil</span>
            <span class="live-pulse" style="width: 6px; height: 6px;"></span>
          </div>
          <div id="cfgWalletAddressDisplay" style="font-size: 0.78rem;">
            <a href="https://solscan.io/account/F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6" target="_blank" rel="noopener" id="cfgWalletLink" class="mono" style="color: #60a5fa; text-decoration: none; font-weight: 700;">
              F2yW...xqt6 ↗
            </a>
          </div>
          <div id="cfgWalletBalance" class="mono" style="font-size: 1.1rem; font-weight: 800; color: #34d399;">
            0.0658 SOL (~$7.74)
          </div>
          <div id="cfgRentReclaimRow" style="display: flex; align-items: center; justify-content: space-between; background: rgba(251, 191, 36, 0.08); padding: 5px 8px; border-radius: 6px; border: 1px dashed rgba(251, 191, 36, 0.35);">
            <div>
              <span style="font-size: 0.66rem; color: #94a3b8; display: block;">Rent Terkunci:</span>
              <b id="cfgReclaimableRentSol" class="mono" style="color: #fef08a; font-size: 0.76rem;">0.0000 SOL</b>
            </div>
            <button id="btnReclaimRent" onclick="triggerReclaimRent()" style="background: #eab308; border: none; color: #000; border-radius: 4px; padding: 4px 8px; font-size: 0.72rem; font-weight: 800; cursor: pointer;" title="Tutup akun token kosong dan tarik SOL rent">♻️ Reclaim</button>
          </div>
          <div id="cfgPosLimit" style="font-size: 0.72rem; color: #94a3b8;">
            Posisi Riil Aktif: <b id="cfgActivePosCount" style="color: #f3f4f6;">0</b> / 1 Max
          </div>
          <div style="border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
            <a href="#realTradesSection" onclick="switchTab('onchain')" style="font-size: 0.74rem; color: #38bdf8; text-decoration: underline; font-weight: 600;">➔ Ke Tabel Transaksi Asli ↓</a>
          </div>
        </div>
      </div>
    </div>

    <!-- Real Executed Transactions & GMGN Request/Response Audit Master Table -->
    <div id="realTradesSection" class="real-trades-container">
      <div class="real-trades-header">
        <div class="real-trades-title-wrap">
          <div class="real-trades-title">
            <span style="font-size: 1.25rem;">💳</span>
            <span>Audit Transaksi On-Chain Asli (GMGN Direct API)</span>
            <span id="realTradesCountBadge" class="status-badge status-active" style="font-size: 0.75rem; padding: 2px 8px; background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3);">
              0 Transaksi
            </span>
          </div>
          <div class="real-trades-sub">Komparasi Return Teori Sinyal vs Realita Dompet On-Chain</div>
        </div>
        <div class="scope-segmented-control">
          <button id="btnRealScopeSession" class="btn-filter active" onclick="setRealScope('session')">Sesi Ini</button>
          <button id="btnRealScopeAll" class="btn-filter" onclick="setRealScope('all')">🌐 Semua Portofolio GMGN</button>
        </div>
      </div>
      <div class="mobile-hint">📱 Tampilan Mobile: Geser tabel ke kanan untuk melihat rincian Solscan & Audit Request-Response ➔</div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th class="sticky-col">Token</th>
              <th>Lane</th>
              <th>Order BUY</th>
              <th>Order SELL</th>
              <th>Durasi</th>
              <th>Modal Riil</th>
              <th>Teori Sinyal</th>
              <th>Realita Dompet</th>
              <th>Selisih AMM</th>
              <th>Gross PnL</th>
              <th>Audit GMGN</th>
            </tr>
          </thead>
          <tbody id="realTradesBody">
            <tr><td colspan="11" class="empty-state">Belum ada transaksi on-chain yang dieksekusi. Nyalakan Auto-Buy pada kontrol panel di atas untuk mulai trading riil.</td></tr>
          </tbody>
        </table>
        <div class="pagination-bar" id="realPaginationBar">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>Tampilkan:</span>
            <select id="realPageSizeSelect" class="page-size-select" onchange="changeRealPageSize(this.value)">
              <option value="5">5 per hal</option>
              <option value="10" selected>10 per hal</option>
              <option value="25">25 per hal</option>
              <option value="50">50 per hal</option>
              <option value="99999">Semua</option>
            </select>
            <span id="realPageInfo" class="mono" style="color: #9ca3af;">Menampilkan 0–0 dari 0 transaksi</span>
          </div>
          <div class="pagination-controls">
            <button class="btn-page" id="btnRealFirst" onclick="goToRealPage(1)" title="Halaman Pertama">« Pertama</button>
            <button class="btn-page" id="btnRealPrev" onclick="goToRealPage(realCurrentPage - 1)" title="Sebelumnya">‹ Prev</button>
            <span style="font-weight: 700; color: #f3f4f6; margin: 0 4px;" class="mono" id="realCurrentPageLabel">1 / 1</span>
            <button class="btn-page" id="btnRealNext" onclick="goToRealPage(realCurrentPage + 1)" title="Berikutnya">Next ›</button>
            <button class="btn-page" id="btnRealLast" onclick="goToRealPage(999999)" title="Halaman Terakhir">Terakhir »</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Collapsible Raw Route Quotes Log for Developer Audit -->
    <details style="margin-top: 1.5rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 0.85rem; padding: 1rem;">
      <summary style="cursor: pointer; font-size: 0.85rem; color: var(--text-muted); font-weight: 600; outline: none; user-select: none; display: flex; align-items: center; justify-content: space-between;">
        <span>🔍 Log Raw Panggilan GMGN Swap Route Quotes (Audit API Developer)</span>
        <span style="font-size: 0.75rem; color: #60a5fa;">[Klik untuk buka/tutup log per-panggilan]</span>
      </summary>
      <div style="margin-top: 1rem; overflow-x: auto; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 0.85rem;">
        <table>
          <thead>
            <tr>
              <th>Waktu</th>
              <th>Token</th>
              <th>Aksi Swap Route</th>
              <th>Eksekusi Swap (In → Out)</th>
              <th>Harga Socket Signal</th>
              <th>Harga Route Quote (AMM)</th>
              <th>Slippage / Deviasi AMM</th>
              <th>Latency GMGN</th>
            </tr>
          </thead>
          <tbody id="routeQuotesBody">
            <tr><td colspan="8" class="empty-state">Belum ada swap route quote yang tercatat.</td></tr>
          </tbody>
        </table>
        <div class="pagination-bar" id="quotesPaginationBar">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span>Tampilkan:</span>
            <select id="quotesPageSizeSelect" class="page-size-select" onchange="changeQuotesPageSize(this.value)">
              <option value="10">10 per hal</option>
              <option value="20" selected>20 per hal</option>
              <option value="50">50 per hal</option>
              <option value="100">100 per hal</option>
              <option value="99999">Semua</option>
            </select>
            <span id="quotesPageInfo" class="mono" style="color: #9ca3af;">Menampilkan 0–0 dari 0 quote</span>
          </div>
          <div class="pagination-controls">
            <button class="btn-page" id="btnQuotesFirst" onclick="goToQuotesPage(1)" title="Halaman Pertama">« Pertama</button>
            <button class="btn-page" id="btnQuotesPrev" onclick="goToQuotesPage(quotesCurrentPage - 1)" title="Sebelumnya">‹ Prev</button>
            <span style="font-weight: 700; color: #f3f4f6; margin: 0 4px;" class="mono" id="quotesCurrentPageLabel">1 / 1</span>
            <button class="btn-page" id="btnQuotesNext" onclick="goToQuotesPage(quotesCurrentPage + 1)" title="Berikutnya">Next ›</button>
            <button class="btn-page" id="btnQuotesLast" onclick="goToQuotesPage(999999)" title="Halaman Terakhir">Terakhir »</button>
          </div>
        </div>
      </div>
    </details>
  </div><!-- /#pane-onchain -->

    <!-- AUDIT PAYLOAD MODAL -->
    <div id="payloadModal" class="modal-overlay" style="display: none;" onclick="if (event.target === this) closePayloadModal()">
      <div class="modal-box">
        <div style="padding: 1rem 1.25rem; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
          <div style="font-weight: 800; font-size: 1rem; color: #f8fafc;" id="modalTitle">
            Audit Order Request / Response GMGN
          </div>
          <button onclick="closePayloadModal()" style="background: none; border: none; font-size: 1.4rem; color: #9ca3af; cursor: pointer; padding: 0 4px;">&times;</button>
        </div>
        <div style="padding: 1.25rem; overflow-y: auto; flex: 1; font-size: 0.82rem; line-height: 1.6;" id="modalContent">
          <!-- Injected via JS -->
        </div>
      </div>
    </div>

    <!-- PWA INSTALLATION MODAL -->
    <div id="pwaModal" class="modal-overlay" style="display: none;" onclick="if (event.target === this) closePwaModal()">
      <div class="modal-box" style="max-width: 520px;">
        <div style="padding: 0.85rem 1.15rem; border-bottom: 1px solid rgba(255,255,255,0.1); display: flex; justify-content: space-between; align-items: center;">
          <div style="font-weight: 800; font-size: 0.95rem; color: #f8fafc; display: flex; align-items: center; gap: 6px;">
            <span>📲</span>
            <span>Pasang Aplikasi (PWA) AGY Sniper</span>
          </div>
          <button onclick="closePwaModal()" style="background: none; border: none; font-size: 1.3rem; color: #9ca3af; cursor: pointer; padding: 0 4px; line-height: 1;">&times;</button>
        </div>
        <div style="padding: 1rem 1.15rem; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 0.85rem;">
          
          <!-- HTTPS URL Action Box -->
          <div id="pwaHttpsActionBox" style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 0.65rem; padding: 0.85rem; display: flex; flex-direction: column; gap: 0.6rem;">
            <div style="font-size: 0.76rem; color: #6ee7b7; font-weight: 700; display: flex; align-items: center; gap: 5px;">
              <span>🔒</span>
              <span id="pwaHttpsStatusText">Versi HTTPS Resmi (Cloudflare SSL)</span>
            </div>
            <div style="font-size: 0.70rem; color: #cbd5e1; line-height: 1.4;" id="pwaHttpsSubText">
              Browser (Chrome / Edge / Safari) mewajibkan enkripsi HTTPS yang aman agar fitur instalasi aplikasi native dapat aktif.
            </div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              <a id="pwaModalHttpsBtn" href="#" target="_blank" rel="noopener" class="btn-pwa-cta" style="flex: 1; text-align: center;">🌐 Buka via HTTPS ↗</a>
              <button onclick="copyTunnelUrl()" class="btn-pwa-copy">📋 Salin Link</button>
            </div>
          </div>

          <!-- Step-by-Step Device Guides -->
          <div style="font-size: 0.75rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em;">
            📖 Cara Pasang Sesuai Perangkat Anda
          </div>

          <!-- iOS Card -->
          <div class="pwa-guide-box" id="guideIOS">
            <div style="font-weight: 700; font-size: 0.78rem; color: #93c5fd; display: flex; align-items: center; gap: 5px;">
              <span>🍎</span>
              <span>iPhone / iPad (Apple Safari)</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">1</span>
              <span>Buka link di browser <b>Safari</b> (bukan browser dalam aplikasi Telegram/Chrome).</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">2</span>
              <span>Ketuk ikon <b>Bagikan (Share)</b> berupa kotak dengan panah atas di bilah navigasi bawah Safari.</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">3</span>
              <span>Gulir menu ke bawah lalu pilih <b>"Tambahkan ke Layar Utama" (Add to Home Screen)</b>.</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">4</span>
              <span>Ketuk <b>"Tambah" (Add)</b> di pojok kanan atas. Icon AGY Sniper akan terpasang di layar depan HP Anda.</span>
            </div>
          </div>

          <!-- Android Card -->
          <div class="pwa-guide-box" id="guideAndroid">
            <div style="font-weight: 700; font-size: 0.78rem; color: #6ee7b7; display: flex; align-items: center; gap: 5px;">
              <span>🤖</span>
              <span>Android (Google Chrome / Edge / Samsung)</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">1</span>
              <span>Buka link <b>HTTPS</b> resmi di atas.</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">2</span>
              <span>Ketuk tombol hijau <b>"📲 Pasang App"</b> di header, atau ketuk menu titik tiga (<b>⋮</b>) di pojok kanan atas Chrome.</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">3</span>
              <span>Pilih menu <b>"Pasang Aplikasi" (Install app)</b> atau <b>"Tambahkan ke Layar Utama"</b>.</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">4</span>
              <span>Aplikasi terpasang otomatis dan dapat dibuka tanpa frame browser (full screen).</span>
            </div>
          </div>

          <!-- Desktop Card -->
          <div class="pwa-guide-box" id="guideDesktop">
            <div style="font-weight: 700; font-size: 0.78rem; color: #fcd34d; display: flex; align-items: center; gap: 5px;">
              <span>💻</span>
              <span>Komputer / Laptop (Chrome / Edge / Brave)</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">1</span>
              <span>Buka link <b>HTTPS</b> resmi di atas.</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">2</span>
              <span>Klik ikon <b>Pasang Aplikasi</b> (komputer dengan tanda panah ke bawah) di ujung kanan bilah alamat (Address Bar).</span>
            </div>
            <div class="pwa-step">
              <span class="pwa-step-num">3</span>
              <span>Klik <b>Install</b> untuk membuat jendela aplikasi standalone.</span>
            </div>
          </div>

        </div>
      </div>
    </div>

    <!-- TOAST NOTIFICATION -->
    <div id="toastNotification" class="toast-msg"></div>

  </div>

  <!-- NATIVE MOBILE BOTTOM MENU -->
  <nav class="bottom-nav">
    <button class="bottom-nav-item active" data-tab="overview" onclick="switchTab('overview')">
      <div class="nav-indicator"></div>
      <span class="nav-icon">📊</span>
      <span>Ringkasan</span>
    </button>
    <button class="bottom-nav-item" data-tab="positions" onclick="switchTab('positions')">
      <div class="nav-indicator"></div>
      <span class="nav-icon">🎯</span>
      <span>Posisi</span>
      <span class="nav-badge badge-green" id="navPosBadge" style="display: none;">0</span>
    </button>
    <button class="bottom-nav-item" data-tab="history" onclick="switchTab('history')">
      <div class="nav-indicator"></div>
      <span class="nav-icon">📜</span>
      <span>Riwayat</span>
      <span class="nav-badge" id="navTradesBadge" style="display: none;">0</span>
    </button>
    <button class="bottom-nav-item" data-tab="onchain" onclick="switchTab('onchain')">
      <div class="nav-indicator"></div>
      <span class="nav-icon">💳</span>
      <span>On-Chain</span>
      <span class="nav-dot" id="navOnChainDot"></span>
      <span class="nav-badge" id="navRealBadge" style="display: none;">0</span>
    </button>
  </nav>

  <script>
    let currentRun = '';
    let currentLaneFilter = 'all';
    let currentAutoBuyCfg = null;
    let allRealTrades = [];
    let isUserEditingAutoBuy = false;

    function showToast(msg, isSuccess = true) {
      const el = document.getElementById('toastNotification');
      if (!el) return;
      el.textContent = msg;
      el.style.backgroundColor = isSuccess ? '#059669' : '#dc2626';
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 3500);
    }

    function updateStakeModeUI() {
      const mode = document.getElementById('cfgStakeMode').value;
      const amountInput = document.getElementById('cfgStakeAmount');
      const hint = document.getElementById('cfgStakeHint');
      if (mode === 'sol') {
        if (hint) hint.textContent = 'Nominal dalam SOL (contoh: 0.03 SOL per order).';
        if (currentAutoBuyCfg && amountInput && !isUserEditingAutoBuy) {
          amountInput.value = currentAutoBuyCfg.stakeSol || 0.03;
        }
      } else {
        if (hint) hint.textContent = 'Nominal dalam USD (contoh: $0.50 USD per order).';
        if (currentAutoBuyCfg && amountInput && !isUserEditingAutoBuy) {
          amountInput.value = currentAutoBuyCfg.stakeUsd || 0.5;
        }
      }
    }

    function updateAutoBuyUI(autoBuy) {
      if (!autoBuy || !autoBuy.config) return;
      const cfg = autoBuy.config;
      currentAutoBuyCfg = cfg;

      const badge = document.getElementById('autoBuyBadge');
      const toggle = document.getElementById('autoBuyToggle');
      const toggleLabel = document.getElementById('autoBuyToggleLabel');
      if (toggle) toggle.checked = !!cfg.enabled;
      if (badge) {
        if (cfg.enabled) {
          badge.textContent = '🟢 AUTO-BUY AKTIF';
          badge.style.background = 'rgba(16, 185, 129, 0.2)';
          badge.style.color = '#34d399';
          badge.style.borderColor = '#10b981';
        } else {
          badge.textContent = '🔴 OFF (Paper Only)';
          badge.style.background = 'rgba(239, 68, 68, 0.2)';
          badge.style.color = '#f87171';
          badge.style.borderColor = '#ef4444';
        }
      }
      if (toggleLabel) {
        toggleLabel.textContent = cfg.enabled ? 'Auto-Buy Master: AKTIF' : 'Auto-Buy Master: OFF';
      }

      const walletLink = document.getElementById('cfgWalletLink');
      if (walletLink && autoBuy.walletAddress) {
        walletLink.href = 'https://solscan.io/account/' + autoBuy.walletAddress;
        walletLink.textContent = autoBuy.walletAddress.slice(0, 4) + '...' + autoBuy.walletAddress.slice(-4) + ' ↗';
      }
      const walletBal = document.getElementById('cfgWalletBalance');
      if (walletBal && autoBuy.walletBalance) {
        const solVal = autoBuy.walletBalance.sol || 0;
        const usdVal = autoBuy.walletBalance.usdValue != null ? autoBuy.walletBalance.usdValue.toFixed(2) : (solVal * 117.71).toFixed(2);
        walletBal.textContent = solVal + ' SOL (~$' + usdVal + ')';
      }
      const rentSolEl = document.getElementById('cfgReclaimableRentSol');
      const btnReclaim = document.getElementById('btnReclaimRent');
      if (rentSolEl && autoBuy.rentInfo) {
        const r = autoBuy.rentInfo;
        if (r.emptyCount > 0) {
          rentSolEl.textContent = r.totalReclaimableSol.toFixed(4) + ' SOL (' + r.emptyCount + ' akun)';
          if (btnReclaim) {
            btnReclaim.style.display = 'inline-block';
            btnReclaim.textContent = '♻️ Reclaim (' + r.emptyCount + ')';
            btnReclaim.disabled = false;
            btnReclaim.style.opacity = '1';
          }
        } else {
          rentSolEl.textContent = '0 SOL (Bersih)';
          if (btnReclaim) {
            btnReclaim.textContent = '✅ Bersih';
            btnReclaim.disabled = true;
            btnReclaim.style.opacity = '0.5';
          }
        }
      }
      const activeCountEl = document.getElementById('cfgActivePosCount');
      if (activeCountEl) {
        activeCountEl.textContent = autoBuy.activeRealPositionsCount || 0;
      }

      const quotaStatus = document.getElementById('cfgQuotaStatus');
      if (quotaStatus) {
        const completed = cfg.buysCompleted || 0;
        const max = (cfg.maxBuys != null) ? Number(cfg.maxBuys) : 0;
        if (max <= 0) {
          quotaStatus.innerHTML = 'Kuota: <b style="color:#34d399;">' + completed + ' order</b> telah dieksekusi (<span style="color:#34d399; font-weight:700;">♾️ UNLIMITED / TERUS BERJALAN</span>)';
        } else {
          quotaStatus.textContent = 'Kuota: ' + completed + ' / ' + max + ' order telah terpakai' + (completed >= max ? ' (KUOTA HABIS)' : '');
          quotaStatus.style.color = completed >= max ? '#f87171' : '#38bdf8';
        }
      }

      if (!isUserEditingAutoBuy) {
        const laneSelect = document.getElementById('cfgLane');
        if (laneSelect && cfg.activeLane) laneSelect.value = cfg.activeLane;

        const modeSelect = document.getElementById('cfgStakeMode');
        if (modeSelect) modeSelect.value = cfg.stakeMode || 'usd';

        const amountInput = document.getElementById('cfgStakeAmount');
        if (amountInput) {
          amountInput.value = (cfg.stakeMode === 'sol' ? cfg.stakeSol : cfg.stakeUsd) || 0.5;
        }

        const maxBuysInput = document.getElementById('cfgMaxBuys');
        if (maxBuysInput) maxBuysInput.value = (cfg.maxBuys != null) ? cfg.maxBuys : 0;

        const maxConcurrentInput = document.getElementById('cfgMaxConcurrent');
        if (maxConcurrentInput) maxConcurrentInput.value = cfg.maxActiveRealPositions || 1;

        const slipInput = document.getElementById('cfgSlippage');
        if (slipInput) slipInput.value = cfg.slippagePercent || 15;

        const gasInput = document.getElementById('cfgPriorityFee');
        if (gasInput) gasInput.value = cfg.priorityFeeSol || 0.0001;
      }
    }

    async function toggleAutoBuyMaster(checked) {
      if (checked) {
        const laneName = document.getElementById('cfgLane')?.value || 'aggressive-optimal';
        const ok = confirm('Nyalakan Real Auto-Buy dengan Lane: ' + laneName + '?\\n\\nBot akan mulai mengeksekusi order riil di GMGN swap menggunakan dompet aktif.');
        if (!ok) {
          const toggle = document.getElementById('autoBuyToggle');
          if (toggle) toggle.checked = false;
          return;
        }
      }
      await saveAutoBuySettings({ enabled: checked });
    }

    async function saveAutoBuySettings(overrides = {}) {
      const mode = document.getElementById('cfgStakeMode')?.value || 'usd';
      const amountVal = parseFloat(document.getElementById('cfgStakeAmount')?.value) || (currentAutoBuyCfg?.stakeUsd || 0.5);
      const lane = document.getElementById('cfgLane')?.value || 'aggressive-optimal';
      const rawMaxBuys = document.getElementById('cfgMaxBuys')?.value;
      const parsedMaxBuys = parseInt(rawMaxBuys, 10);
      const maxBuys = (Number.isFinite(parsedMaxBuys) && parsedMaxBuys >= 0) ? parsedMaxBuys : 0;
      const rawConcurrent = document.getElementById('cfgMaxConcurrent')?.value;
      const parsedConcurrent = parseInt(rawConcurrent, 10);
      const maxConcurrent = (Number.isFinite(parsedConcurrent) && parsedConcurrent >= 1) ? parsedConcurrent : 1;
      const slippage = parseFloat(document.getElementById('cfgSlippage')?.value) || 15;
      const priorityFee = parseFloat(document.getElementById('cfgPriorityFee')?.value) || 0.0001;
      const isEnabled = document.getElementById('autoBuyToggle')?.checked || false;

      const payload = {
        enabled: isEnabled,
        activeLane: lane,
        stakeMode: mode,
        stakeUsd: mode === 'usd' ? amountVal : (currentAutoBuyCfg?.stakeUsd || 0.5),
        stakeSol: mode === 'sol' ? amountVal : (currentAutoBuyCfg?.stakeSol || 0.03),
        maxBuys: maxBuys,
        maxActiveRealPositions: maxConcurrent,
        slippagePercent: slippage,
        priorityFeeSol: priorityFee,
        tipFeeSol: 0.0001,
        autoSell: true,
        ...overrides,
      };

      try {
        const res = await fetch('/api/autobuy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (data.ok) {
          currentAutoBuyCfg = data.config;
          isUserEditingAutoBuy = false;
          updateAutoBuyUI({ config: data.config, walletAddress: data.walletAddress, walletBalance: data.balance, activeRealPositionsCount: 0 });
          showToast(payload.enabled ? '✅ Auto-Buy AKTIF dengan Lane: ' + lane : '⏸️ Auto-Buy berhasil dinonaktifkan (Safe Mode)', true);
        } else {
          showToast('❌ Gagal menyimpan: ' + (data.error || 'Unknown error'), false);
        }
      } catch (err) {
        showToast('❌ Gagal koneksi: ' + err.message, false);
      }
    }

    async function setUnlimitedBuys() {
      const maxBuysInput = document.getElementById('cfgMaxBuys');
      if (maxBuysInput) maxBuysInput.value = 0;
      await saveAutoBuySettings({ maxBuys: 0 });
      showToast('♾️ Kuota diatur ke UNLIMITED (Bot berjalan terus tanpa batas order)', true);
    }

    async function resetCompletedBuys() {
      await saveAutoBuySettings({ buysCompleted: 0 });
      showToast('🔄 Kuota buy telah di-reset ke 0 order terpakai', true);
    }

    async function triggerReclaimRent() {
      const btn = document.getElementById('btnReclaimRent');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Memproses...';
      }
      try {
        const res = await fetch('/api/reclaim-rent', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          showToast('🎉 Berhasil reclaim ' + (data.reclaimedSol || 0).toFixed(4) + ' SOL (' + data.reclaimedCount + ' akun ditutup)!', true);
          if (data.urls && data.urls[0]) {
            console.log('Reclaim Transaction URL:', data.urls[0]);
          }
          await loadDashboardData();
        } else {
          showToast('⚠️ ' + (data.error || 'Gagal me-reclaim rent'), false);
        }
      } catch (err) {
        showToast('❌ Error: ' + err.message, false);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // GMGN Screener Feed & Worker Service Controller
    let currentFeedConfig = null;
    let isUserEditingFeed = false;

    const CLIENT_MC_PRESET_MAP = {
      '10k-100k': { min: 10000, max: 100000, label: 'Min $10,000 USD — Max $100,000 USD' },
      '5.5k-15k': { min: 5500, max: 15000, label: 'Min $5,500 USD — Max $15,000 USD' },
      '15k-50k': { min: 15000, max: 50000, label: 'Min $15,000 USD — Max $50,000 USD' },
      '20k-100k': { min: 20000, max: 100000, label: 'Min $20,000 USD — Max $100,000 USD' },
      '50k-250k': { min: 50000, max: 250000, label: 'Min $50,000 USD — Max $250,000 USD' },
      'all': { min: 0, max: 10000000, label: 'Semua / Tanpa Filter MC (0 - Tak Terbatas)' },
    };

    function onFeedUrlPresetChange(val) {
      isUserEditingFeed = true;
      const display = document.getElementById('cfgFeedUrlDisplay');
      if (display) display.textContent = val;
    }

    function onMcPresetChange(val) {
      isUserEditingFeed = true;
      const display = document.getElementById('cfgMcDetailDisplay');
      const info = CLIENT_MC_PRESET_MAP[val];
      if (display && info) {
        display.textContent = 'Rentang aktif: ' + info.label;
      }
    }

    async function fetchFeedConfig() {
      try {
        const res = await fetch('/api/feed-config');
        if (!res.ok) return;
        const data = await res.json();
        if (!data || !data.ok) return;

        currentFeedConfig = data.config;
        const worker = data.worker || {};

        // Update worker badge
        const badge = document.getElementById('workerStatusBadge');
        const btnStart = document.getElementById('btnStartWorker');
        const btnStop = document.getElementById('btnStopWorker');

        if (badge) {
          if (worker.active) {
            badge.textContent = '🟢 RUNNING (' + (worker.subState || 'running') + (worker.mainPid ? ', PID ' + worker.mainPid : '') + ')';
            badge.style.background = 'rgba(16, 185, 129, 0.2)';
            badge.style.color = '#34d399';
            badge.style.border = '1px solid #10b981';
            if (btnStart) {
              btnStart.style.opacity = '0.5';
              btnStart.style.cursor = 'not-allowed';
            }
            if (btnStop) {
              btnStop.style.opacity = '1';
              btnStop.style.cursor = 'pointer';
            }
          } else {
            badge.textContent = '🔴 STOPPED (' + (worker.activeState || 'inactive') + ')';
            badge.style.background = 'rgba(239, 68, 68, 0.2)';
            badge.style.color = '#f87171';
            badge.style.border = '1px solid #ef4444';
            if (btnStart) {
              btnStart.style.opacity = '1';
              btnStart.style.cursor = 'pointer';
            }
            if (btnStop) {
              btnStop.style.opacity = '0.5';
              btnStop.style.cursor = 'not-allowed';
            }
          }
        }

        // Sync dropdown values if user is not actively interacting
        if (!isUserEditingFeed && data.config) {
          const cfg = data.config;
          const urlSelect = document.getElementById('cfgFeedUrlSelect');
          if (urlSelect && cfg.feedUrl) {
            urlSelect.value = cfg.feedUrlPreset || cfg.feedUrl;
          }
          const urlDisplay = document.getElementById('cfgFeedUrlDisplay');
          if (urlDisplay && cfg.feedUrl) {
            urlDisplay.textContent = cfg.feedUrl;
          }

          const mcSelect = document.getElementById('cfgMcPreset');
          if (mcSelect && cfg.mcPreset) {
            mcSelect.value = cfg.mcPreset;
          }
          const mcDisplay = document.getElementById('cfgMcDetailDisplay');
          if (mcDisplay && cfg.mcPreset && CLIENT_MC_PRESET_MAP[cfg.mcPreset]) {
            mcDisplay.textContent = 'Rentang aktif: ' + CLIENT_MC_PRESET_MAP[cfg.mcPreset].label;
          }
        }
      } catch (err) {
        console.error('Error fetching feed-config:', err);
      }
    }

    async function saveFeedAndRestart() {
      const btn = document.getElementById('btnApplyFeed');
      const origText = btn ? btn.textContent : '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Menyimpan & Restart...';
      }
      try {
        const feedUrlSelect = document.getElementById('cfgFeedUrlSelect');
        const mcPresetSelect = document.getElementById('cfgMcPreset');
        const feedUrl = feedUrlSelect ? feedUrlSelect.value : '';
        const mcPreset = mcPresetSelect ? mcPresetSelect.value : '10k-100k';

        const res = await fetch('/api/feed-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            feedUrl,
            feedUrlPreset: feedUrl,
            mcPreset,
            restart: true,
          })
        });
        const data = await res.json();
        if (data.ok) {
          isUserEditingFeed = false;
          showToast('✅ Berhasil update feed & restart worker! Bot membaca filter baru.', true);
          await fetchFeedConfig();
        } else {
          showToast('❌ Gagal: ' + (data.error || 'Unknown error'), false);
        }
      } catch (err) {
        showToast('❌ Error: ' + err.message, false);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = origText;
        }
      }
    }

    async function controlWorkerAction(action) {
      const btnStart = document.getElementById('btnStartWorker');
      const btnStop = document.getElementById('btnStopWorker');
      if (action === 'start' && btnStart) btnStart.textContent = '⏳ Memulai...';
      if (action === 'stop' && btnStop) btnStop.textContent = '⏳ Menghentikan...';

      try {
        const res = await fetch('/api/worker-control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (data.ok) {
          showToast('⚙️ Worker ' + action + ' berhasil dieksekusi', true);
        } else {
          showToast('⚠️ Worker ' + action + ': ' + (data.error || 'Gagal'), false);
        }
        setTimeout(fetchFeedConfig, 1000);
      } catch (err) {
        showToast('❌ Error: ' + err.message, false);
      } finally {
        if (btnStart) btnStart.textContent = '▶️ Start Worker';
        if (btnStop) btnStop.textContent = '⏹️ Stop Worker';
      }
    }

    let realCurrentPage = 1;
    let realPageSize = 10;
    let cachedDisplayedReal = [];
    let totalRealTrades = 0;
    let totalRealPages = 1;
    let isFetchingReal = false;

    let closedCurrentPage = 1;
    let closedPageSize = 25;
    let cachedDisplayedClosed = [];
    let totalClosedTrades = 0;
    let totalClosedPages = 1;
    let isFetchingClosed = false;

    let quotesCurrentPage = 1;
    let quotesPageSize = 20;
    let cachedDisplayedQuotes = [];
    let totalQuotes = 0;
    let totalQuotesPages = 1;
    let isFetchingQuotes = false;

    async function fetchClosedTrades(page = 1) {
      if (isFetchingClosed) return;
      isFetchingClosed = true;
      try {
        const url = '/api/trades?run=' + encodeURIComponent(currentRun || '') +
          '&lane=' + encodeURIComponent(currentLaneFilter) +
          '&page=' + page +
          '&limit=' + closedPageSize;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.ok) return;
        closedCurrentPage = data.page;
        totalClosedTrades = data.total;
        totalClosedPages = data.totalPages;
        cachedDisplayedClosed = data.trades || [];
        renderClosedTradesTable();
      } catch (err) {
        console.error('Error fetching closed trades:', err);
      } finally {
        isFetchingClosed = false;
      }
    }

    function goToClosedPage(page) {
      const targetPage = Math.max(1, Math.min(page, totalClosedPages || 1));
      fetchClosedTrades(targetPage);
    }

    function changeClosedPageSize(val) {
      closedPageSize = parseInt(val, 10) || 25;
      closedCurrentPage = 1;
      fetchClosedTrades(1);
    }

    function renderClosedTradeRow(t) {
      const realClass = t.realReturnPercent >= 0 ? 'up' : 'down';
      const socketClass = t.socketReturnPercent >= 0 ? 'up' : 'down';
      const tradePnlVal = t.tradePnlUsd != null ? t.tradePnlUsd : t.pnlUsd;
      const swapPnlVal = t.swapPnlUsd != null ? t.swapPnlUsd : t.pnlUsd;
      const swapPnlClass = swapPnlVal >= 0 ? 'up' : 'down';
      const laneBadge = t.lane === 'aggressive-wave'
        ? '<span class="tag tag-lane-wave">WAVE SCALPER</span>'
        : t.lane === 'aggressive-swing-100k'
        ? '<span class="tag tag-lane-swing">SWING 100K</span>'
        : t.lane === 'r5-band'
        ? '<span class="tag tag-lane-r5">R5 BAND</span>'
        : t.lane === 'momentum-v3'
        ? '<span class="tag tag-lane-v3">V3</span>'
        : t.lane === 'momentum-v2'
        ? '<span class="tag tag-lane-v2">V2</span>'
        : t.lane === 'aggressive-wide'
        ? '<span class="tag tag-lane-wide">WIDE</span>'
        : t.lane === 'aggressive-optimal'
        ? '<span class="tag tag-lane-optimal">OPTIMAL</span>'
        : t.lane === 'aggressive-safe'
        ? '<span class="tag tag-lane-safe">SAFE</span>'
        : '<span class="tag tag-lane-raw">RAW</span>';
      const badge = t.isRealWin
        ? '<span class="tag tag-win">REAL WIN</span>'
        : '<span class="tag tag-loss">REAL LOSS</span>';
      const badgeNote = (!t.isRealWin && t.isSocketWin)
        ? '<div style="font-size: 0.68rem; color: #f59e0b; margin-top: 3px; font-weight: 600;">⚠️ Chart Win, Pool Slip</div>'
        : '';
      
      const sr = t.swapRoute;
      let buyCell = '<span style="color: #6b7280; font-size: 0.75rem;">—</span>';
      if (sr && sr.hasBuy) {
        const buyFlow = sr.buyInSol ? sr.buyInSol + ' (' + sr.buyInUsd + ')' : (sr.buyInUsd || '—');
        const buyTimeStr = formatTime(sr.buyTime || t.entryTime);
        buyCell = '<div class="route-cell-box">' +
          '<div class="route-time mono">🕒 Buy: ' + buyTimeStr + '</div>' +
          '<div class="route-flow text-win">' + buyFlow + ' → ' + sr.buyOutTokens + ' tok</div>' +
          '<div class="route-sub">Slip: <b>' + sr.buySlippage + '</b> · Lat: <b>' + (sr.buyLatencyMs != null ? sr.buyLatencyMs + 'ms' : '—') + '</b></div>' +
        '</div>';
      }

      let sellCell = '<span style="color: #6b7280; font-size: 0.75rem;">—</span>';
      if (sr && sr.hasSell) {
        const sellOut = sr.sellOutSol ? sr.sellOutSol + ' (' + sr.sellOutUsd + ')' : (sr.sellOutUsd || '—');
        const sellTimeStr = formatTime(sr.sellTime || t.exitTime);
        sellCell = '<div class="route-cell-box">' +
          '<div class="route-time mono" style="color: #f59e0b;">🕒 Sell: ' + sellTimeStr + '</div>' +
          '<div class="route-flow text-loss">' + sr.sellInTokens + ' tok → ' + sellOut + '</div>' +
          '<div class="route-sub">Slip: <b>' + sr.sellSlippage + '</b> · Lat: <b>' + (sr.sellLatencyMs != null ? sr.sellLatencyMs + 'ms' : '—') + '</b></div>' +
        '</div>';
      }

      return '<tr>' +
        '<td class="sticky-col">' +
          '<div style="font-weight: 800; font-size: 0.82rem;"><a href="https://gmgn.ai/sol/token/' + t.mint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none;">' + t.symbol + ' ↗</a></div>' +
          (t.name ? '<div style="font-size: 0.66rem; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 125px;">' + t.name + '</div>' : '') +
          '<a href="https://gmgn.ai/sol/token/' + t.mint + '" target="_blank" rel="noopener" class="mono" style="font-size: 0.65rem; color: #64748b; text-decoration: underline;" title="' + t.mint + '">' + t.mint.slice(0, 8) + '...</a>' +
        '</td>' +
        '<td>' + laneBadge + '</td>' +
        '<td><span class="worker-badge">W' + t.worker + '</span></td>' +
        '<td>' +
          '<div class="mono" style="font-size: 0.72rem; font-weight: 600;">' + formatTime(t.entryTime) + '</div>' +
          '<div class="duration-badge mono">⏱️ ' + t.durationSec + 's</div>' +
        '</td>' +
        '<td class="mono" style="font-size: 0.72rem; line-height: 1.35;">' +
          '<div style="color: #94a3b8;">' + formatUsd(t.entryPrice) + '</div>' +
          '<div style="color: #f8fafc; font-weight: 700;">→ ' + formatUsd(t.exitPrice) + '</div>' +
        '</td>' +
        '<td>' + exitReasonBadge(t.exitReason) + '</td>' +
        '<td>' +
          '<div class="mono ' + realClass + '" style="font-size: 0.82rem; font-weight: 800;">' + (t.realReturnPercent >= 0 ? '+' : '') + t.realReturnPercent.toFixed(2) + '%</div>' +
          '<div class="mono" style="font-size: 0.65rem; color: #60a5fa; margin-top: 1px;">📈 Chart: ' + (t.socketReturnPercent >= 0 ? '+' : '') + t.socketReturnPercent.toFixed(2) + '%</div>' +
        '</td>' +
        '<td>' + buyCell + '</td>' +
        '<td>' + sellCell + '</td>' +
        '<td>' +
          '<div class="mono ' + swapPnlClass + '" style="font-size: 0.82rem; font-weight: 800;">' + (swapPnlVal >= 0 ? '+' : '') + '$' + swapPnlVal.toFixed(4) + '</div>' +
          '<div class="mono" style="font-size: 0.65rem; color: #60a5fa; margin-top: 1px;">📈 Chart: ' + (tradePnlVal >= 0 ? '+' : '') + '$' + tradePnlVal.toFixed(4) + '</div>' +
        '</td>' +
        '<td>' + badge + badgeNote + '</td>' +
      '</tr>';
    }

    function renderClosedTradesTable() {
      const tbody = document.getElementById('closedTradesBody');
      const countEl = document.getElementById('closedCount');
      if (countEl) countEl.textContent = totalClosedTrades;
      if (!tbody) return;

      if (totalClosedTrades === 0 || cachedDisplayedClosed.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">Belum ada trade yang ditutup pada sesi ini' + (currentLaneFilter !== 'all' ? ' untuk lane ini' : '') + '.</td></tr>';
        const info = document.getElementById('closedPageInfo');
        if (info) info.textContent = 'Menampilkan 0 dari 0 transaksi';
        const pageLabel = document.getElementById('closedCurrentPageLabel');
        if (pageLabel) pageLabel.textContent = '1 / 1';
        const btnFirst = document.getElementById('btnClosedFirst');
        const btnPrev = document.getElementById('btnClosedPrev');
        const btnNext = document.getElementById('btnClosedNext');
        const btnLast = document.getElementById('btnClosedLast');
        if (btnFirst) btnFirst.disabled = true;
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        if (btnLast) btnLast.disabled = true;
        return;
      }

      tbody.innerHTML = cachedDisplayedClosed.map(renderClosedTradeRow).join('');

      const startIdx = (closedCurrentPage - 1) * closedPageSize;
      const endIdx = Math.min(startIdx + cachedDisplayedClosed.length, totalClosedTrades);

      const info = document.getElementById('closedPageInfo');
      if (info) info.textContent = 'Menampilkan ' + (startIdx + 1) + '–' + endIdx + ' dari ' + totalClosedTrades + ' transaksi';
      const pageLabel = document.getElementById('closedCurrentPageLabel');
      if (pageLabel) pageLabel.textContent = closedCurrentPage + ' / ' + totalClosedPages;
      const btnFirst = document.getElementById('btnClosedFirst');
      const btnPrev = document.getElementById('btnClosedPrev');
      const btnNext = document.getElementById('btnClosedNext');
      const btnLast = document.getElementById('btnClosedLast');
      if (btnFirst) btnFirst.disabled = (closedCurrentPage <= 1);
      if (btnPrev) btnPrev.disabled = (closedCurrentPage <= 1);
      if (btnNext) btnNext.disabled = (closedCurrentPage >= totalClosedPages);
      if (btnLast) btnLast.disabled = (closedCurrentPage >= totalClosedPages);
    }

    function renderRealTradeRow(t) {
      const laneBadge = t.lane === 'aggressive-wave'
        ? '<span class="tag tag-lane-wave">WAVE SCALPER</span>'
        : t.lane === 'aggressive-swing-100k'
        ? '<span class="tag tag-lane-swing">SWING 100K</span>'
        : t.lane === 'r5-band'
        ? '<span class="tag tag-lane-r5">R5 BAND</span>'
        : t.lane === 'momentum-v3'
        ? '<span class="tag tag-lane-v3">V3</span>'
        : t.lane === 'momentum-v2'
        ? '<span class="tag tag-lane-v2">V2</span>'
        : t.lane === 'aggressive-wide'
        ? '<span class="tag tag-lane-wide">WIDE</span>'
        : t.lane === 'aggressive-optimal'
        ? '<span class="tag tag-lane-optimal">OPTIMAL</span>'
        : t.lane === 'aggressive-safe'
        ? '<span class="tag tag-lane-safe">SAFE</span>'
        : '<span class="tag tag-lane-raw">RAW</span>';

      const buyTimestamp = t.buy?.time || t.startedAt || 0;
      const dateStr = buyTimestamp ? new Date(buyTimestamp).toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' }) : '—';
      const buyTimeStr = buyTimestamp ? new Date(buyTimestamp).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : '—';

      const sellTimestamp = t.sell?.time || 0;
      const sellTimeStr = sellTimestamp ? new Date(sellTimestamp).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) : '—';

      const tokenCell = '<b><a href="https://gmgn.ai/sol/token/' + t.mint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none; font-size: 0.82rem;">' + t.symbol + ' ↗</a></b><br>' +
        (t.name ? '<span style="font-size: 0.66rem; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: 125px;">' + t.name + '</span><br>' : '') +
        '<span style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); color: #fbbf24; font-size: 0.64rem; font-weight: 700; padding: 1px 4px; border-radius: 4px; display: inline-block; margin-bottom: 2px;" class="mono">📅 ' + dateStr + '</span><br>' +
        '<a href="https://gmgn.ai/sol/token/' + t.mint + '" target="_blank" rel="noopener" class="mono" style="font-size: 0.64rem; color: #64748b; text-decoration: underline;" title="' + t.mint + '">' + t.mint.slice(0, 8) + '...</a>';

      const buyStatusBadge = t.buy.ok
        ? '<span class="tag tag-win" style="font-size: 0.66rem;">🟢 SUCCESS</span>'
        : '<span class="tag tag-loss" style="font-size: 0.66rem;">🔴 GAGAL</span>';
      const buyHashLink = t.buy.solscanUrl
        ? '<a href="' + t.buy.solscanUrl + '" target="_blank" rel="noopener" class="mono" style="color: #60a5fa; text-decoration: underline; font-size: 0.66rem;">' + (t.buy.hash ? t.buy.hash.slice(0, 8) + '...' : 'Solscan ↗') + '</a>'
        : '<span style="color: #6b7280; font-size: 0.66rem;">No Tx</span>';
      const buyCell = '<div class="route-cell-box">' +
        '<div style="display: flex; justify-content: space-between; align-items: center; gap: 4px;">' + buyStatusBadge + '<span class="mono" style="font-size: 0.66rem; color: #94a3b8;">🕒 ' + buyTimeStr + '</span></div>' +
        '<div style="margin-top: 3px; font-size: 0.66rem;">Tx: ' + buyHashLink + '</div>' +
      '</div>';

      let sellCell = '<span class="tag" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); font-size: 0.66rem;">🟡 HOLDING</span>';
      if (t.sell) {
        const sellStatusBadge = t.sell.ok
          ? '<span class="tag tag-win" style="font-size: 0.66rem;">🟢 SUCCESS</span>'
          : '<span class="tag tag-loss" style="font-size: 0.66rem;">🔴 GAGAL</span>';
        const sellHashLink = t.sell.solscanUrl
          ? '<a href="' + t.sell.solscanUrl + '" target="_blank" rel="noopener" class="mono" style="color: #60a5fa; text-decoration: underline; font-size: 0.66rem;">' + (t.sell.hash ? t.sell.hash.slice(0, 8) + '...' : 'Solscan ↗') + '</a>'
          : '<span style="color: #6b7280; font-size: 0.66rem;">No Tx</span>';
        sellCell = '<div class="route-cell-box">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; gap: 4px;">' + sellStatusBadge + '<span class="mono" style="font-size: 0.66rem; color: #94a3b8;">🕒 ' + sellTimeStr + '</span></div>' +
          '<div style="margin-top: 3px; font-size: 0.66rem;">Tx: ' + sellHashLink + '</div>' +
        '</div>';
      }

      const buyCost = t.walletBuyCost ?? t.buy?.stakeUsd ?? (currentAutoBuyCfg?.stakeUsd || 0.5);
      const modalCell = '<div style="font-size: 0.72rem; line-height: 1.35;" class="mono">' +
        '<div style="color: #94a3b8;">Buy: $' + Number(buyCost).toFixed(2) + '</div>' +
        (t.walletSoldIncome != null ? '<div style="color: #34d399; font-weight: 700;">Sell: $' + Number(t.walletSoldIncome).toFixed(2) + '</div>' : '<div style="color: #fbbf24;">(Holding)</div>') +
      '</div>';

      const theoryClass = (t.theoryReturnPercent != null && t.theoryReturnPercent >= 0) ? 'up' : 'down';
      const theoryCell = t.theoryReturnPercent != null
        ? '<div class="mono ' + theoryClass + '" style="font-weight: 700; font-size: 0.78rem;">' + (t.theoryReturnPercent >= 0 ? '+' : '') + t.theoryReturnPercent.toFixed(2) + '%</div>'
        : '<span style="color: #6b7280;">—</span>';

      const actualClass = (t.actualReturnPercent != null && t.actualReturnPercent >= 0) ? 'up' : 'down';
      const actualCell = t.actualReturnPercent != null
        ? '<div class="mono ' + actualClass + '" style="font-weight: 800; font-size: 0.82rem;">' + (t.actualReturnPercent >= 0 ? '+' : '') + t.actualReturnPercent.toFixed(2) + '%</div>'
        : '<span style="color: #fbbf24; font-size: 0.72rem;">(Holding)</span>';

      const slipClass = (t.slippageDiffPercent != null && t.slippageDiffPercent >= 0) ? 'up' : 'down';
      const slipCell = t.slippageDiffPercent != null
        ? '<div class="mono ' + slipClass + '" style="font-weight: 600; font-size: 0.74rem;">' + (t.slippageDiffPercent >= 0 ? '+' : '') + t.slippageDiffPercent.toFixed(2) + '%</div>'
        : '<span style="color: #6b7280;">—</span>';

      const pnlClass = (t.walletPnlUsd != null && t.walletPnlUsd >= 0) ? 'up' : 'down';
      const pnlCell = t.walletPnlUsd != null
        ? '<div class="mono ' + pnlClass + '" style="font-weight: 800; font-size: 0.82rem;">' + (t.walletPnlUsd >= 0 ? '+' : '') + '$' + t.walletPnlUsd.toFixed(4) + '</div>'
        : '<span style="color: #6b7280;">—</span>';

      const auditBtn = '<button data-mint="' + t.mint + '" onclick="openPayloadModal(this.dataset.mint)" class="btn-micro-action btn-micro-accent" style="padding: 3px 6px; font-size: 0.68rem;">🔍 Req / Res</button>';

      return '<tr>' +
        '<td class="sticky-col">' + tokenCell + '</td>' +
        '<td>' + laneBadge + '</td>' +
        '<td>' + buyCell + '</td>' +
        '<td>' + sellCell + '</td>' +
        '<td class="mono" style="font-size: 0.72rem;">' + t.durationSec + 's</td>' +
        '<td>' + modalCell + '</td>' +
        '<td>' + theoryCell + '</td>' +
        '<td>' + actualCell + '</td>' +
        '<td>' + slipCell + '</td>' +
        '<td>' + pnlCell + '</td>' +
        '<td>' + auditBtn + '</td>' +
      '</tr>';
    }

    let currentRealScope = (typeof localStorage !== 'undefined' && localStorage.getItem('realTradesScope')) || 'session';

    async function fetchRealTrades(page = 1) {
      if (isFetchingReal) return;
      isFetchingReal = true;
      try {
        const url = '/api/real-trades?run=' + encodeURIComponent(currentRun || '') +
          '&scope=' + encodeURIComponent(currentRealScope) +
          '&page=' + page +
          '&limit=' + realPageSize;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.ok) return;
        realCurrentPage = data.page;
        totalRealTrades = data.total;
        totalRealPages = data.totalPages;
        cachedDisplayedReal = data.trades || [];
        for (const t of cachedDisplayedReal) {
          if (!allRealTrades.some(x => x.mint === t.mint)) {
            allRealTrades.push(t);
          }
        }
        renderRealTradesTable();
      } catch (err) {
        console.error('Error fetching real trades:', err);
      } finally {
        isFetchingReal = false;
      }
    }

    function setRealScope(scope) {
      currentRealScope = scope;
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('realTradesScope', scope);
      } catch {}
      realCurrentPage = 1;
      updateRealScopeButtons();
      fetchRealTrades(1);
    }

    function updateRealScopeButtons() {
      const btnSession = document.getElementById('btnRealScopeSession');
      const btnAll = document.getElementById('btnRealScopeAll');
      if (btnSession) btnSession.className = 'btn-filter' + (currentRealScope === 'session' ? ' active' : '');
      if (btnAll) btnAll.className = 'btn-filter' + (currentRealScope === 'all' ? ' active' : '');
    }

    function goToRealPage(page) {
      const targetPage = Math.max(1, Math.min(page, totalRealPages || 1));
      fetchRealTrades(targetPage);
    }

    function changeRealPageSize(val) {
      realPageSize = parseInt(val, 10) || 10;
      realCurrentPage = 1;
      fetchRealTrades(1);
    }

    function renderRealTradesTable() {
      const tbody = document.getElementById('realTradesBody');
      if (!tbody) return;

      const badge = document.getElementById('realTradesCountBadge');
      if (badge) {
        badge.textContent = totalRealTrades + (currentRealScope === 'session' ? ' Transaksi (Sesi Ini)' : ' Transaksi (Semua Portofolio)');
      }

      if (totalRealTrades === 0 || cachedDisplayedReal.length === 0) {
        const emptyMsg = currentRealScope === 'session'
          ? 'Belum ada transaksi on-chain yang dieksekusi pada sesi ini. Nyalakan Auto-Buy pada kontrol panel di atas untuk mulai trading riil, atau klik <b>"🌐 Semua Portofolio GMGN"</b> untuk melihat riwayat dari sesi lain.'
          : 'Belum ada transaksi on-chain yang dieksekusi di seluruh portofolio. Nyalakan Auto-Buy pada kontrol panel di atas untuk mulai trading riil.';
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">' + emptyMsg + '</td></tr>';
        const info = document.getElementById('realPageInfo');
        if (info) info.textContent = 'Menampilkan 0 dari 0 transaksi';
        const pageLabel = document.getElementById('realCurrentPageLabel');
        if (pageLabel) pageLabel.textContent = '1 / 1';
        const btnFirst = document.getElementById('btnRealFirst');
        const btnPrev = document.getElementById('btnRealPrev');
        const btnNext = document.getElementById('btnRealNext');
        const btnLast = document.getElementById('btnRealLast');
        if (btnFirst) btnFirst.disabled = true;
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        if (btnLast) btnLast.disabled = true;
        return;
      }

      tbody.innerHTML = cachedDisplayedReal.map(renderRealTradeRow).join('');

      const startIdx = (realCurrentPage - 1) * realPageSize;
      const endIdx = Math.min(startIdx + cachedDisplayedReal.length, totalRealTrades);

      const info = document.getElementById('realPageInfo');
      if (info) info.textContent = 'Menampilkan ' + (startIdx + 1) + '–' + endIdx + ' dari ' + totalRealTrades + ' transaksi';
      const pageLabel = document.getElementById('realCurrentPageLabel');
      if (pageLabel) pageLabel.textContent = realCurrentPage + ' / ' + totalRealPages;
      const btnFirst = document.getElementById('btnRealFirst');
      const btnPrev = document.getElementById('btnRealPrev');
      const btnNext = document.getElementById('btnRealNext');
      const btnLast = document.getElementById('btnRealLast');
      if (btnFirst) btnFirst.disabled = (realCurrentPage <= 1);
      if (btnPrev) btnPrev.disabled = (realCurrentPage <= 1);
      if (btnNext) btnNext.disabled = (realCurrentPage >= totalRealPages);
      if (btnLast) btnLast.disabled = (realCurrentPage >= totalRealPages);
    }

    function renderRouteQuoteRow(q) {
      const isBuy = q.isBuy;
      const isSell = q.isSell;
      const routeBadge = isBuy
        ? '<span class="tag tag-win" style="font-size: 0.72rem;">🟢 BUY ROUTE</span>'
        : isSell
        ? '<span class="tag tag-stop" style="font-size: 0.72rem;">🔴 SELL ROUTE</span>'
        : '<span class="tag" style="background: rgba(255,255,255,0.1);">' + (q.typeLabel || q.type || 'QUOTE') + '</span>';

      const slip = q.slipPercent != null ? q.slipPercent : (q.routeVsSocketPricePercent != null ? Number(q.routeVsSocketPricePercent.toFixed(2)) : null);
      const slipText = slip != null ? (slip >= 0 ? '+' : '') + slip.toFixed(2) + '%' : '—';
      const slipClass = slip != null && slip < 0 ? 'down' : 'up';
      
      const tokenCell = q.mint
        ? '<b><a href="https://gmgn.ai/sol/token/' + q.mint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none; font-size: 0.9rem;">' + (q.symbol || 'Token') + ' ↗</a></b><br>' +
          '<a href="https://gmgn.ai/sol/token/' + q.mint + '" target="_blank" rel="noopener" class="mono" style="font-size: 0.72rem; color: #9ca3af; text-decoration: underline;" title="' + q.mint + '">' + q.mint.slice(0, 10) + '...</a>'
        : '—';

      const flowHtml = q.flowText && q.flowText !== '—'
        ? '<span class="mono" style="font-size: 0.8rem; font-weight: 600; color: #f3f4f6;">' + q.flowText + '</span>'
        : '<span style="color: #6b7280; font-size: 0.8rem;">—</span>';

      return '<tr>' +
        '<td class="mono" style="font-size: 0.8rem;">' + formatTime(q.observedAt) + '</td>' +
        '<td>' + tokenCell + '</td>' +
        '<td>' + routeBadge + '</td>' +
        '<td>' + flowHtml + '</td>' +
        '<td class="mono">' + formatUsd(q.signalPriceUsd) + '</td>' +
        '<td class="mono">' + (q.routeImpliedTokenPriceUsd ? formatUsd(q.routeImpliedTokenPriceUsd) : '—') + '</td>' +
        '<td class="mono ' + slipClass + '"><b>' + slipText + '</b></td>' +
        '<td class="mono">' + (q.latencyMs != null ? q.latencyMs + ' ms' : '—') + '</td>' +
      '</tr>';
    }

    async function fetchRouteQuotes(page = 1) {
      if (isFetchingQuotes) return;
      isFetchingQuotes = true;
      try {
        const url = '/api/route-quotes?run=' + encodeURIComponent(currentRun || '') +
          '&page=' + page +
          '&limit=' + quotesPageSize;
        const res = await fetch(url);
        if (!res.ok) return;
        const data = await res.json();
        if (!data.ok) return;
        quotesCurrentPage = data.page;
        totalQuotes = data.total;
        totalQuotesPages = data.totalPages;
        cachedDisplayedQuotes = data.quotes || [];
        renderRouteQuotesTable();
      } catch (err) {
        console.error('Error fetching route quotes:', err);
      } finally {
        isFetchingQuotes = false;
      }
    }

    function goToQuotesPage(page) {
      const targetPage = Math.max(1, Math.min(page, totalQuotesPages || 1));
      fetchRouteQuotes(targetPage);
    }

    function changeQuotesPageSize(val) {
      quotesPageSize = parseInt(val, 10) || 20;
      quotesCurrentPage = 1;
      fetchRouteQuotes(1);
    }

    function renderRouteQuotesTable() {
      const tbody = document.getElementById('routeQuotesBody');
      if (!tbody) return;

      if (totalQuotes === 0 || cachedDisplayedQuotes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Belum ada swap route quote yang tercatat.</td></tr>';
        const info = document.getElementById('quotesPageInfo');
        if (info) info.textContent = 'Menampilkan 0 dari 0 quote';
        const pageLabel = document.getElementById('quotesCurrentPageLabel');
        if (pageLabel) pageLabel.textContent = '1 / 1';
        const btnFirst = document.getElementById('btnQuotesFirst');
        const btnPrev = document.getElementById('btnQuotesPrev');
        const btnNext = document.getElementById('btnQuotesNext');
        const btnLast = document.getElementById('btnQuotesLast');
        if (btnFirst) btnFirst.disabled = true;
        if (btnPrev) btnPrev.disabled = true;
        if (btnNext) btnNext.disabled = true;
        if (btnLast) btnLast.disabled = true;
        return;
      }

      tbody.innerHTML = cachedDisplayedQuotes.map(renderRouteQuoteRow).join('');

      const startIdx = (quotesCurrentPage - 1) * quotesPageSize;
      const endIdx = Math.min(startIdx + cachedDisplayedQuotes.length, totalQuotes);

      const info = document.getElementById('quotesPageInfo');
      if (info) info.textContent = 'Menampilkan ' + (startIdx + 1) + '–' + endIdx + ' dari ' + totalQuotes + ' quote';
      const pageLabel = document.getElementById('quotesCurrentPageLabel');
      if (pageLabel) pageLabel.textContent = quotesCurrentPage + ' / ' + totalQuotesPages;
      const btnFirst = document.getElementById('btnQuotesFirst');
      const btnPrev = document.getElementById('btnQuotesPrev');
      const btnNext = document.getElementById('btnQuotesNext');
      const btnLast = document.getElementById('btnQuotesLast');
      if (btnFirst) btnFirst.disabled = (quotesCurrentPage <= 1);
      if (btnPrev) btnPrev.disabled = (quotesCurrentPage <= 1);
      if (btnNext) btnNext.disabled = (quotesCurrentPage >= totalQuotesPages);
      if (btnLast) btnLast.disabled = (quotesCurrentPage >= totalQuotesPages);
    }

    async function openPayloadModal(mint) {
      let trade = allRealTrades.find(t => t.mint === mint) ||
                  cachedDisplayedReal.find(t => t.mint === mint);
      if (!trade || (!trade.buy?.payloads?.length && !trade.walletSnapshots?.length)) {
        try {
          const res = await fetch('/api/real-trade-detail?mint=' + encodeURIComponent(mint) + '&run=' + encodeURIComponent(currentRun || ''));
          if (res.ok) {
            const data = await res.json();
            if (data.ok && data.trade) trade = data.trade;
          }
        } catch {}
      }
      if (!trade) return;
      const modal = document.getElementById('payloadModal');
      const title = document.getElementById('modalTitle');
      const content = document.getElementById('modalContent');
      if (!modal || !content) return;

      title.innerHTML = '🔍 Audit Request / Response GMGN: <b>' + trade.symbol + '</b> (' + trade.laneLabel + ')';

      let html = '<div style="display: flex; flex-direction: column; gap: 1rem;">';

      const modalCost = trade.walletBuyCost ?? trade.buy?.stakeUsd ?? (currentAutoBuyCfg?.stakeUsd || 0.5);
      html += '<div style="background: rgba(255,255,255,0.04); border-radius: 8px; padding: 10px 14px; display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">' +
        '<div><span style="color: #9ca3af;">Token:</span> <b>' + trade.symbol + '</b> (' + trade.mint.slice(0, 8) + '...)</div>' +
        '<div><span style="color: #9ca3af;">Lane:</span> <b>' + trade.laneLabel + '</b></div>' +
        '<div><span style="color: #9ca3af;">Status:</span> <b>' + trade.status + '</b></div>' +
        '<div><span style="color: #9ca3af;">Modal:</span> <b>$' + Number(modalCost).toFixed(2) + '</b></div>' +
      '</div>';

      html += '<div style="border: 1px solid rgba(16, 185, 129, 0.3); background: rgba(16, 185, 129, 0.05); border-radius: 8px; padding: 12px;">' +
        '<div style="font-weight: 700; color: #34d399; margin-bottom: 6px; font-size: 0.9rem;">🟢 Order BUY Request / Response</div>' +
        '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">' +
          '<div><b>Status:</b> ' + (trade.buy.ok ? '✅ SUCCESS' : '❌ FAILED') + ' (HTTP ' + (trade.buy.status || 200) + ')</div>' +
          '<div><b>Waktu:</b> ' + (trade.buy.timeFormatted || '—') + '</div>' +
          '<div><b>Order ID GMGN:</b> <span class="mono">' + (trade.buy.orderId || '—') + '</span></div>' +
          '<div><b>Solana Tx:</b> ' + (trade.buy.solscanUrl ? '<a href="' + trade.buy.solscanUrl + '" target="_blank" class="mono" style="color: #60a5fa;">' + trade.buy.hash + ' ↗</a>' : '—') + '</div>' +
          '<div><b>Token Diterima:</b> <span class="mono">' + (trade.buy.acquiredAmount ? Number(trade.buy.acquiredAmount).toLocaleString() : '—') + '</span></div>' +
          '<div><b>Pesan GMGN:</b> ' + (trade.buy.message || 'SUCCESS') + '</div>' +
        '</div>';
      if (trade.buy.payloads && trade.buy.payloads.length > 0) {
        html += '<details style="margin-top: 6px;"><summary style="cursor: pointer; color: #93c5fd; font-size: 0.78rem;">📄 Tampilkan Raw JSON Order Payloads (' + trade.buy.payloads.length + ' event)</summary>' +
          '<pre class="mono" style="background: #000; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 0.72rem; margin-top: 6px; max-height: 200px;">' +
          JSON.stringify(trade.buy.payloads, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
          '</pre></details>';
      }
      html += '</div>';

      if (trade.sell) {
        html += '<div style="border: 1px solid rgba(239, 68, 68, 0.3); background: rgba(239, 68, 68, 0.05); border-radius: 8px; padding: 12px;">' +
          '<div style="font-weight: 700; color: #f87171; margin-bottom: 6px; font-size: 0.9rem;">🔴 Order SELL Request / Response</div>' +
          '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">' +
            '<div><b>Status:</b> ' + (trade.sell.ok ? '✅ SUCCESS' : '❌ FAILED') + ' (HTTP ' + (trade.sell.status || 200) + ')</div>' +
            '<div><b>Waktu:</b> ' + (trade.sell.timeFormatted || '—') + '</div>' +
            '<div><b>Order ID GMGN:</b> <span class="mono">' + (trade.sell.orderId || '—') + '</span></div>' +
            '<div><b>Solana Tx:</b> ' + (trade.sell.solscanUrl ? '<a href="' + trade.sell.solscanUrl + '" target="_blank" class="mono" style="color: #60a5fa;">' + trade.sell.hash + ' ↗</a>' : '—') + '</div>' +
            '<div><b>Pesan GMGN:</b> ' + (trade.sell.message || 'SUCCESS') + '</div>' +
          '</div>';
        if (trade.sell.payloads && trade.sell.payloads.length > 0) {
          html += '<details style="margin-top: 6px;"><summary style="cursor: pointer; color: #93c5fd; font-size: 0.78rem;">📄 Tampilkan Raw JSON Order Payloads (' + trade.sell.payloads.length + ' event)</summary>' +
            '<pre class="mono" style="background: #000; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 0.72rem; margin-top: 6px; max-height: 200px;">' +
            JSON.stringify(trade.sell.payloads, null, 2).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</pre></details>';
        }
        html += '</div>';
      } else {
        html += '<div style="border: 1px dashed rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.05); border-radius: 8px; padding: 12px; color: #fde68a;">' +
          '🟡 Posisi ini sedang berjalan (HOLDING). Sinyal SELL akan otomatis dieksekusi saat lane asal (' + trade.laneLabel + ') menyentuh kriteria exit (Take Profit, Breakeven Lock, atau Stop Loss).' +
        '</div>';
      }

      if (trade.walletSnapshots && trade.walletSnapshots.length > 0) {
        html += '<div style="border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.02); border-radius: 8px; padding: 12px;">' +
          '<div style="font-weight: 700; color: #cbd5e1; margin-bottom: 6px; font-size: 0.85rem;">💼 Snapshots Saldo GMGN Walletstat (' + trade.walletSnapshots.length + ' record)</div>' +
          '<div style="display: flex; flex-direction: column; gap: 6px;">' +
          trade.walletSnapshots.map(s => {
            return '<div style="background: rgba(0,0,0,0.3); padding: 8px 10px; border-radius: 6px; font-size: 0.75rem; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px;">' +
              '<span><b>[' + s.stage + ']</b> ' + formatTime(s.observedAt) + '</span>' +
              '<span>Cost: <b>$' + (s.historyBoughtCostUsd != null ? Number(s.historyBoughtCostUsd).toFixed(2) : '—') + '</b></span>' +
              '<span>Income: <b>$' + (s.historySoldIncomeUsd != null ? Number(s.historySoldIncomeUsd).toFixed(2) : '—') + '</b></span>' +
              '<span>PnL: <b style="color: ' + ((s.grossPnlUsd || 0) >= 0 ? '#34d399' : '#f87171') + '">' + (s.grossPnlUsd != null ? (s.grossPnlUsd >= 0 ? '+' : '') + '$' + Number(s.grossPnlUsd).toFixed(4) : '—') + '</b></span>' +
            '</div>';
          }).join('') +
          '</div></div>';
      }

      html += '</div>';

      content.innerHTML = html;
      modal.style.display = 'flex';
    }

    function closePayloadModal() {
      const modal = document.getElementById('payloadModal');
      if (modal) modal.style.display = 'none';
    }

    function renderOpenPositions(openPositions = []) {
      const displayedOpen = (currentLaneFilter === 'all')
        ? openPositions
        : openPositions.filter(p => p.lane === currentLaneFilter);

      const openBody = document.getElementById('openPositionsBody');
      const openCountEl = document.getElementById('openCount');
      if (openCountEl) openCountEl.textContent = displayedOpen.length;
      if (!openBody) return;
      if (displayedOpen.length > 0) {
        openBody.innerHTML = displayedOpen.map(p => {
          const estRealReturn = p.floatingReturnPercent - 5.4;
          const estClass = estRealReturn >= 0 ? 'up' : 'down';
          const stagPct = Math.max(0, Math.min(100, (p.stagnationCountdownSec / 12) * 100));
          const laneBadge = p.lane === 'aggressive-wave'
            ? '<span class="tag tag-lane-wave">WAVE SCALPER</span>'
            : p.lane === 'aggressive-swing-100k'
            ? '<span class="tag tag-lane-swing">SWING 100K</span>'
            : p.lane === 'r5-band'
            ? '<span class="tag tag-lane-r5">R5 BAND</span>'
            : p.lane === 'momentum-v3'
            ? '<span class="tag tag-lane-v3">MOMENTUM V3</span>'
            : p.lane === 'momentum-v2'
            ? '<span class="tag tag-lane-v2">MOMENTUM V2</span>'
            : p.lane === 'aggressive-wide'
            ? '<span class="tag tag-lane-wide">WIDE</span>'
            : p.lane === 'aggressive-optimal'
            ? '<span class="tag tag-lane-optimal">OPTIMAL</span>'
            : p.lane === 'aggressive-safe'
            ? '<span class="tag tag-lane-safe">SAFE</span>'
            : '<span class="tag tag-lane-raw">RAW</span>';
          return '<tr>' +
            '<td class="sticky-col">' +
              '<b><a href="https://gmgn.ai/sol/token/' + p.mint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none; font-size: 0.82rem;">' + p.symbol + ' ↗</a></b><br>' +
              '<a href="https://gmgn.ai/sol/token/' + p.mint + '" target="_blank" rel="noopener" class="mono" style="font-size: 0.65rem; color: #9ca3af; text-decoration: underline;" title="' + p.mint + '">' + p.mint.slice(0, 10) + '...</a>' +
            '</td>' +
            '<td>' + laneBadge + '</td>' +
            '<td><span class="worker-badge">Worker ' + p.worker + '</span></td>' +
            '<td class="mono">' + formatUsd(p.entryPrice) + '</td>' +
            '<td class="mono">' + formatUsd(p.currentPrice) + '</td>' +
            '<td>' +
              '<div class="mono ' + estClass + '" style="font-weight: 700;">' + (estRealReturn >= 0 ? '+' : '') + estRealReturn.toFixed(2) + '%</div>' +
              '<div class="mono" style="font-size: 0.65rem; color: #60a5fa; margin-top: 2px;">📈 Chart: ' + (p.floatingReturnPercent >= 0 ? '+' : '') + p.floatingReturnPercent.toFixed(2) + '%</div>' +
            '</td>' +
            '<td class="mono up">+' + p.peakReturnPercent.toFixed(2) + '%</td>' +
            '<td class="mono">' + (p.trailingFloorPercent != null ? '+' + p.trailingFloorPercent.toFixed(2) + '%' : '—') + '</td>' +
            '<td>' +
              '<div style="display: flex; justify-content: space-between; font-size: 0.68rem;">' +
                '<span>' + p.stagnationCountdownSec + 's tersisa</span>' +
                '<span>' + (p.peakReturnPercent >= 2.5 ? '✅ Lolos Stagnation' : '⚠️ Countdown') + '</span>' +
              '</div>' +
              '<div class="stag-bar"><div class="stag-fill" style="width: ' + stagPct + '%;"></div></div>' +
            '</td>' +
          '</tr>';
        }).join('');
      } else {
        openBody.innerHTML = '<tr><td colspan="9" class="empty-state">Tidak ada posisi terbuka saat ini' + (currentLaneFilter !== 'all' ? ' untuk lane ini' : '') + '. Worker sedang memindai order flow token baru.</td></tr>';
      }
    }

    function setLaneFilter(lane) {
      currentLaneFilter = lane;
      closedCurrentPage = 1;
      const btnAll = document.getElementById('btnFilterAll');
      const btnOptimal = document.getElementById('btnFilterOptimal');
      const btnWide = document.getElementById('btnFilterWide');
      const btnSwing = document.getElementById('btnFilterSwing');
      const btnWave = document.getElementById('btnFilterWave');
      const btnSafe = document.getElementById('btnFilterSafe');
      const btnV2 = document.getElementById('btnFilterV2');
      const btnV3 = document.getElementById('btnFilterV3');
      const btnR5 = document.getElementById('btnFilterR5');
      const btnRaw = document.getElementById('btnFilterRaw');
      if (btnAll) btnAll.className = 'btn-filter' + (lane === 'all' ? ' active' : '');
      if (btnOptimal) btnOptimal.className = 'btn-filter' + (lane === 'aggressive-optimal' ? ' active' : '');
      if (btnWide) btnWide.className = 'btn-filter' + (lane === 'aggressive-wide' ? ' active' : '');
      if (btnSwing) btnSwing.className = 'btn-filter' + (lane === 'aggressive-swing-100k' ? ' active' : '');
      if (btnWave) btnWave.className = 'btn-filter' + (lane === 'aggressive-wave' ? ' active' : '');
      if (btnSafe) btnSafe.className = 'btn-filter' + (lane === 'aggressive-safe' ? ' active' : '');
      if (btnV2) btnV2.className = 'btn-filter' + (lane === 'momentum-v2' ? ' active' : '');
      if (btnV3) btnV3.className = 'btn-filter' + (lane === 'momentum-v3' ? ' active' : '');
      if (btnR5) btnR5.className = 'btn-filter' + (lane === 'r5-band' ? ' active' : '');
      if (btnRaw) btnRaw.className = 'btn-filter' + (lane === 'control' ? ' active' : '');
      if (lastSummaryData) {
        renderOpenPositions(lastSummaryData.openPositions || []);
      }
      fetchClosedTrades(1);
    }

    function formatUsd(val) {
      if (val == null) return '—';
      const num = Number(val);
      if (num < 0.0001 && num > 0) return '$' + num.toExponential(4);
      return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 });
    }

    function formatTime(isoOrTs) {
      if (!isoOrTs) return '—';
      const d = new Date(isoOrTs);
      return d.toLocaleTimeString('id-ID', { hour12: false });
    }

    function exitReasonBadge(reason) {
      if (!reason) return '<span class="tag">UNKNOWN</span>';
      if (reason.includes('RUNNER_TRAIL') || reason.includes('PROFIT_TRAIL') || reason.includes('TARGET')) {
        return '<span class="tag tag-trail">' + reason.replace('AGGRESSIVE_', '') + '</span>';
      }
      if (reason.includes('BREAKEVEN')) {
        return '<span class="tag tag-break">' + reason.replace('AGGRESSIVE_', '') + '</span>';
      }
      if (reason.includes('HARD_STOP') || reason.includes('CRASH')) {
        return '<span class="tag tag-stop">' + reason.replace('AGGRESSIVE_', '') + '</span>';
      }
      if (reason.includes('STAGNATION')) {
        return '<span class="tag tag-stag">' + reason.replace('AGGRESSIVE_', '') + '</span>';
      }
      if (reason.includes('FLOW_EXIT')) {
        return '<span class="tag tag-flow">' + reason.replace('AGGRESSIVE_', '') + '</span>';
      }
      if (reason.includes('HOLDER_SELL') || reason.includes('WHALE')) {
        return '<span class="tag tag-stop">' + reason + '</span>';
      }
      return '<span class="tag">' + reason + '</span>';
    }

    let activeAbortController = null;
    let lastSummaryData = null;
    let hasLoadedInitialTables = false;
    let lastLoadedRun = '';
    let lastKnownClosedTotal = -1;
    let lastKnownRealTotal = -1;
    let lastKnownQuotesTotal = -1;

    async function fetchSummary(overrideRun) {
      if (activeAbortController) {
        try { activeAbortController.abort(); } catch {}
      }
      activeAbortController = new AbortController();

      const runToFetch = (overrideRun !== undefined) ? overrideRun : currentRun;
      try {
        const url = '/api/summary' + (runToFetch ? '?run=' + encodeURIComponent(runToFetch) : '');
        const res = await fetch(url, { signal: activeAbortController.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        lastSummaryData = data;

        // Update run dropdown
        const runSelect = document.getElementById('runSelect');
        if (runSelect && data.availableRuns && data.availableRuns.length > 0) {
          const sig = JSON.stringify(data.availableRuns.map(r => r.id + '|' + (r.tradesCount || 0)));
          if (runSelect.dataset.runsSig !== sig) {
            runSelect.dataset.runsSig = sig;
            runSelect.innerHTML = data.availableRuns.map(r => 
              '<option value="' + r.id + '"' + (r.id === data.currentRunId ? ' selected' : '') + '>' + 
              (r.friendlyLabel || r.id) + 
              '</option>'
            ).join('');
          }
          if (data.currentRunId && runSelect.value !== data.currentRunId) {
            runSelect.value = data.currentRunId;
          }
        }
        currentRun = data.currentRunId || currentRun;

        // Update Active Run Status Banner
        const runStatusBadge = document.getElementById('runStatusBadge');
        const bannerRunTitle = document.getElementById('bannerRunTitle');
        const bannerRunDate = document.getElementById('bannerRunDate');
        const bannerTradeCount = document.getElementById('bannerTradeCount');
        const bannerRuntime = document.getElementById('bannerRuntime');

        const isLiveRun = !!data.isLive;
        if (runStatusBadge) {
          runStatusBadge.className = 'status-badge ' + (isLiveRun ? 'status-active' : 'status-idle');
          runStatusBadge.innerHTML = isLiveRun ? '🔴 LIVE RUN AKTIF' : '📁 ARSIP RUN SEBELUMNYA';
        }
        if (bannerRunTitle) {
          bannerRunTitle.textContent = data.currentRunId || '—';
        }
        if (bannerRunDate) {
          bannerRunDate.textContent = 'Mulai: ' + (data.runStartedAtFormatted || data.runStartedAt || '—');
        }
        if (bannerTradeCount) {
          const totalClosed = data.summary?.closedTrades ?? data.totalClosedTrades ?? 0;
          bannerTradeCount.textContent = totalClosed + ' Closed Trades';
        }
        if (bannerRuntime && data.throughput) {
          const sec = data.throughput.runtimeSeconds || 0;
          const hrs = Math.floor(sec / 3600);
          const mins = Math.floor((sec % 3600) / 60);
          const s = sec % 60;
          const durStr = (hrs > 0 ? hrs + 'j ' : '') + mins + 'm ' + s + 's';
          bannerRuntime.textContent = 'Durasi: ' + durStr;
        }

        // Update Dual-Lane Comparative Scorecard & Overall KPIs
        if (data.summary) {
          const s = data.summary;

          // 🔵 Raw Lane Card
          if (s.raw) {
            const rawWrEl = document.getElementById('rawRealWinRate');
            if (rawWrEl) {
              rawWrEl.textContent = s.raw.realWinRate + '%';
              rawWrEl.className = 'kpi-value mono ' + (s.raw.realWinRate > 0 ? 'up' : (s.raw.closedTrades > 0 ? 'down' : ''));
            }
            const rawScoreEl = document.getElementById('rawRealScore');
            if (rawScoreEl) rawScoreEl.textContent = s.raw.realWins + 'W / ' + s.raw.realLosses + 'L (' + s.raw.closedTrades + ' closed)';
            const rawPnlEl = document.getElementById('rawRealPnl');
            if (rawPnlEl) {
              rawPnlEl.textContent = (s.raw.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.raw.totalNetRealPnlUsd.toFixed(4);
              rawPnlEl.className = 'kpi-value mono ' + (s.raw.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const rawSocketEl = document.getElementById('rawSocketScore');
            if (rawSocketEl) {
              rawSocketEl.textContent = 'Socket: ' + s.raw.socketWinRate + '% (' + (s.raw.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.raw.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // 🟢 Safe Lane Card
          if (s.safe) {
            const safeWrEl = document.getElementById('safeRealWinRate');
            if (safeWrEl) {
              safeWrEl.textContent = s.safe.realWinRate + '%';
              safeWrEl.className = 'kpi-value mono ' + (s.safe.realWinRate > 0 ? 'up' : (s.safe.closedTrades > 0 ? 'down' : ''));
            }
            const safeScoreEl = document.getElementById('safeRealScore');
            if (safeScoreEl) safeScoreEl.textContent = s.safe.realWins + 'W / ' + s.safe.realLosses + 'L (' + s.safe.closedTrades + ' closed)';
            const safePnlEl = document.getElementById('safeRealPnl');
            if (safePnlEl) {
              safePnlEl.textContent = (s.safe.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.safe.totalNetRealPnlUsd.toFixed(4);
              safePnlEl.className = 'kpi-value mono ' + (s.safe.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const safeSocketEl = document.getElementById('safeSocketScore');
            if (safeSocketEl) {
              safeSocketEl.textContent = 'Socket: ' + s.safe.socketWinRate + '% (' + (s.safe.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.safe.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // 🟣 Optimal Lane Card
          if (s.optimal) {
            const optWrEl = document.getElementById('optimalRealWinRate');
            if (optWrEl) {
              optWrEl.textContent = s.optimal.realWinRate + '%';
              optWrEl.className = 'kpi-value mono ' + (s.optimal.realWinRate > 0 ? 'up' : (s.optimal.closedTrades > 0 ? 'down' : ''));
            }
            const optScoreEl = document.getElementById('optimalRealScore');
            if (optScoreEl) optScoreEl.textContent = s.optimal.realWins + 'W / ' + s.optimal.realLosses + 'L (' + s.optimal.closedTrades + ' closed)';
            const optPnlEl = document.getElementById('optimalRealPnl');
            if (optPnlEl) {
              optPnlEl.textContent = (s.optimal.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.optimal.totalNetRealPnlUsd.toFixed(4);
              optPnlEl.className = 'kpi-value mono ' + (s.optimal.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const optSocketEl = document.getElementById('optimalSocketScore');
            if (optSocketEl) {
              optSocketEl.textContent = 'Socket: ' + s.optimal.socketWinRate + '% (' + (s.optimal.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.optimal.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // 🟠 Wide Lane Card
          if (s.wide) {
            const wideWrEl = document.getElementById('wideRealWinRate');
            if (wideWrEl) {
              wideWrEl.textContent = s.wide.realWinRate + '%';
              wideWrEl.className = 'kpi-value mono ' + (s.wide.realWinRate > 0 ? 'up' : (s.wide.closedTrades > 0 ? 'down' : ''));
            }
            const wideScoreEl = document.getElementById('wideRealScore');
            if (wideScoreEl) wideScoreEl.textContent = s.wide.realWins + 'W / ' + s.wide.realLosses + 'L (' + s.wide.closedTrades + ' closed)';
            const widePnlEl = document.getElementById('wideRealPnl');
            if (widePnlEl) {
              widePnlEl.textContent = (s.wide.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.wide.totalNetRealPnlUsd.toFixed(4);
              widePnlEl.className = 'kpi-value mono ' + (s.wide.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const wideSocketEl = document.getElementById('wideSocketScore');
            if (wideSocketEl) {
              wideSocketEl.textContent = 'Socket: ' + s.wide.socketWinRate + '% (' + (s.wide.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.wide.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // 🌊 Swing 100k Lane Card
          if (s.swing100k) {
            const swWrEl = document.getElementById('swingRealWinRate');
            if (swWrEl) {
              swWrEl.textContent = s.swing100k.realWinRate + '%';
              swWrEl.className = 'kpi-value mono ' + (s.swing100k.realWinRate > 0 ? 'up' : (s.swing100k.closedTrades > 0 ? 'down' : ''));
            }
            const swScoreEl = document.getElementById('swingRealScore');
            if (swScoreEl) swScoreEl.textContent = s.swing100k.realWins + 'W / ' + s.swing100k.realLosses + 'L (' + s.swing100k.closedTrades + ' closed)';
            const swPnlEl = document.getElementById('swingRealPnl');
            if (swPnlEl) {
              swPnlEl.textContent = (s.swing100k.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.swing100k.totalNetRealPnlUsd.toFixed(4);
              swPnlEl.className = 'kpi-value mono ' + (s.swing100k.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const swSocketEl = document.getElementById('swingSocketScore');
            if (swSocketEl) {
              swSocketEl.textContent = 'Socket: ' + s.swing100k.socketWinRate + '% (' + (s.swing100k.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.swing100k.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // ⚡ Wave Scalper Lane Card
          if (s.wave) {
            const waveWrEl = document.getElementById('waveRealWinRate');
            if (waveWrEl) {
              waveWrEl.textContent = s.wave.realWinRate + '%';
              waveWrEl.className = 'kpi-value mono ' + (s.wave.realWinRate > 0 ? 'up' : (s.wave.closedTrades > 0 ? 'down' : ''));
            }
            const waveScoreEl = document.getElementById('waveRealScore');
            if (waveScoreEl) waveScoreEl.textContent = s.wave.realWins + 'W / ' + s.wave.realLosses + 'L (' + s.wave.closedTrades + ' closed)';
            const wavePnlEl = document.getElementById('waveRealPnl');
            if (wavePnlEl) {
              wavePnlEl.textContent = (s.wave.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.wave.totalNetRealPnlUsd.toFixed(4);
              wavePnlEl.className = 'kpi-value mono ' + (s.wave.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const waveSocketEl = document.getElementById('waveSocketScore');
            if (waveSocketEl) {
              waveSocketEl.textContent = 'Socket: ' + s.wave.socketWinRate + '% (' + (s.wave.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.wave.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // 🔵 Momentum V2 Lane Card
          if (s.v2) {
            const v2WrEl = document.getElementById('v2RealWinRate');
            if (v2WrEl) {
              v2WrEl.textContent = s.v2.realWinRate + '%';
              v2WrEl.className = 'kpi-value mono ' + (s.v2.realWinRate > 0 ? 'up' : (s.v2.closedTrades > 0 ? 'down' : ''));
            }
            const v2ScoreEl = document.getElementById('v2RealScore');
            if (v2ScoreEl) v2ScoreEl.textContent = s.v2.realWins + 'W / ' + s.v2.realLosses + 'L (' + s.v2.closedTrades + ' closed)';
            const v2PnlEl = document.getElementById('v2RealPnl');
            if (v2PnlEl) {
              v2PnlEl.textContent = (s.v2.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.v2.totalNetRealPnlUsd.toFixed(4);
              v2PnlEl.className = 'kpi-value mono ' + (s.v2.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const v2SocketEl = document.getElementById('v2SocketScore');
            if (v2SocketEl) {
              v2SocketEl.textContent = 'Socket: ' + s.v2.socketWinRate + '% (' + (s.v2.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.v2.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // ✨ Momentum V3 Lane Card
          if (s.v3) {
            const v3WrEl = document.getElementById('v3RealWinRate');
            if (v3WrEl) {
              v3WrEl.textContent = s.v3.realWinRate + '%';
              v3WrEl.className = 'kpi-value mono ' + (s.v3.realWinRate > 0 ? 'up' : (s.v3.closedTrades > 0 ? 'down' : ''));
            }
            const v3ScoreEl = document.getElementById('v3RealScore');
            if (v3ScoreEl) v3ScoreEl.textContent = s.v3.realWins + 'W / ' + s.v3.realLosses + 'L (' + s.v3.closedTrades + ' closed)';
            const v3PnlEl = document.getElementById('v3RealPnl');
            if (v3PnlEl) {
              v3PnlEl.textContent = (s.v3.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.v3.totalNetRealPnlUsd.toFixed(4);
              v3PnlEl.className = 'kpi-value mono ' + (s.v3.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const v3SocketEl = document.getElementById('v3SocketScore');
            if (v3SocketEl) {
              v3SocketEl.textContent = 'Socket: ' + s.v3.socketWinRate + '% (' + (s.v3.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.v3.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // 🟡 Momentum R5 Band Lane Card
          if (s.r5) {
            const r5WrEl = document.getElementById('r5RealWinRate');
            if (r5WrEl) {
              r5WrEl.textContent = s.r5.realWinRate + '%';
              r5WrEl.className = 'kpi-value mono ' + (s.r5.realWinRate > 0 ? 'up' : (s.r5.closedTrades > 0 ? 'down' : ''));
            }
            const r5ScoreEl = document.getElementById('r5RealScore');
            if (r5ScoreEl) r5ScoreEl.textContent = s.r5.realWins + 'W / ' + s.r5.realLosses + 'L (' + s.r5.closedTrades + ' closed)';
            const r5PnlEl = document.getElementById('r5RealPnl');
            if (r5PnlEl) {
              r5PnlEl.textContent = (s.r5.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.r5.totalNetRealPnlUsd.toFixed(4);
              r5PnlEl.className = 'kpi-value mono ' + (s.r5.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
            }
            const r5SocketEl = document.getElementById('r5SocketScore');
            if (r5SocketEl) {
              r5SocketEl.textContent = 'Socket: ' + s.r5.socketWinRate + '% (' + (s.r5.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.r5.totalNetTradePnlUsd.toFixed(2) + ')';
            }
          }

          // Overall Combined KPIs
          const realWinRateEl = document.getElementById('realWinRate');
          if (realWinRateEl) {
            realWinRateEl.textContent = s.realWinRate + '%';
            realWinRateEl.className = 'kpi-value ' + (s.realWinRate > 0 ? 'up' : (s.closedTrades > 0 ? 'down' : ''));
          }
          const realScoreEl = document.getElementById('realScore');
          if (realScoreEl) realScoreEl.textContent = s.realWins + 'W / ' + s.realLosses + 'L (' + s.closedTrades + ' closed)';

          const socketScoreCompareEl = document.getElementById('socketScoreCompare');
          if (socketScoreCompareEl) {
            socketScoreCompareEl.textContent = '📈 Chart Socket: ' + s.socketWinRate + '% (' + s.socketWins + 'W / ' + s.socketLosses + 'L)';
          }

          const pnlEl = document.getElementById('netRealPnl');
          if (pnlEl) {
            pnlEl.textContent = (s.totalNetRealPnlUsd >= 0 ? '+' : '') + '$' + s.totalNetRealPnlUsd.toFixed(4);
            pnlEl.className = 'kpi-value ' + (s.totalNetRealPnlUsd >= 0 ? 'up' : 'down');
          }

          const netTradePnlEl = document.getElementById('netTradePnl');
          if (netTradePnlEl) {
            netTradePnlEl.textContent = (s.totalNetTradePnlUsd >= 0 ? '+' : '') + '$' + s.totalNetTradePnlUsd.toFixed(4);
            netTradePnlEl.className = 'kpi-value ' + (s.totalNetTradePnlUsd >= 0 ? 'up' : 'down');
          }

          const avgSlipEl = document.getElementById('avgSlippage');
          if (avgSlipEl) avgSlipEl.textContent = '-' + s.avgSlippagePct.toFixed(2) + '%';
          const avgLatEl = document.getElementById('avgLatency');
          if (avgLatEl) avgLatEl.textContent = s.avgLatencyMs + ' ms';
        }

        // Update Throughput
        if (data.throughput) {
          const t = data.throughput;
          document.getElementById('socketRate').textContent = t.ratePerSec + ' /s';
          document.getElementById('socketTotals').textContent = t.tradesTotal.toLocaleString() + ' trades · ' + t.ticksTotal.toLocaleString() + ' ticks';
        }

        // Update 3 Workers
        const workerGrid = document.getElementById('workerGrid');
        if (data.workers && data.workers.length > 0) {
          workerGrid.innerHTML = data.workers.map(w => {
            const isPos = w.status === 'POSITION_OPEN';
            const isObs = w.status === 'OBSERVING_SOCKET';
            const badgeClass = isPos ? 'status-active' : isObs ? 'status-observing' : 'status-idle';
            const statusLabel = isPos ? '🔥 TRADING / OPEN' : isObs ? '👁️ OBSERVING DETAIL' : '💤 IDLE / SCANNING';
            const tokenTitle = w.currentMint 
              ? '<a href="https://gmgn.ai/sol/token/' + w.currentMint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none;">' + (w.symbol || 'Token') + ' ↗</a>'
              : (w.symbol || 'Tidak ada token');
            const mintLink = w.currentMint
              ? '<a href="https://gmgn.ai/sol/token/' + w.currentMint + '" target="_blank" rel="noopener" style="color: #9ca3af; text-decoration: underline;">' + w.currentMint + '</a>'
              : '—';
            return '<div class="worker-card">' +
              '<div class="worker-header">' +
                '<span class="worker-badge">Worker #' + w.id + '</span>' +
                '<span class="status-badge ' + badgeClass + '">' + statusLabel + '</span>' +
              '</div>' +
              '<div>' +
                '<div style="font-weight: 700; font-size: 0.88rem;">' + tokenTitle + '</div>' +
                '<div class="mono" style="font-size: 0.66rem; color: var(--text-muted); word-break: break-all; margin-top: 2px;">' + mintLink + '</div>' +
              '</div>' +
              '<div style="font-size: 0.70rem; color: var(--text-muted); display: flex; justify-content: space-between;">' +
                '<span>Stream Ticks: <b>' + w.ticks.toLocaleString() + '</b></span>' +
                '<span>Durasi: <b>' + w.durationSec + 's</b></span>' +
              '</div>' +
            '</div>';
          }).join('');
        }

        // Update Open Positions
        renderOpenPositions(data.openPositions || []);

        // Update Bottom Nav & Desktop Tab Badges
        const openPosCount = (data.openPositions || []).length;
        const navPosBadge = document.getElementById('navPosBadge');
        const desktopPosBadge = document.getElementById('desktopPosBadge');
        if (navPosBadge) {
          navPosBadge.textContent = openPosCount;
          navPosBadge.style.display = openPosCount > 0 ? 'inline-flex' : 'none';
        }
        if (desktopPosBadge) {
          desktopPosBadge.textContent = openPosCount;
          desktopPosBadge.style.display = openPosCount > 0 ? 'inline-flex' : 'none';
        }

        const closedTotal = data.totalClosedTrades ?? (data.summary?.closedTrades ?? 0);
        const navTradesBadge = document.getElementById('navTradesBadge');
        const desktopTradesBadge = document.getElementById('desktopTradesBadge');
        if (navTradesBadge) {
          navTradesBadge.textContent = closedTotal;
          navTradesBadge.style.display = closedTotal > 0 ? 'inline-flex' : 'none';
        }
        if (desktopTradesBadge) {
          desktopTradesBadge.textContent = closedTotal;
          desktopTradesBadge.style.display = closedTotal > 0 ? 'inline-flex' : 'none';
        }

        const realTotal = data.totalRealTrades ?? 0;
        const navRealBadge = document.getElementById('navRealBadge');
        const desktopRealBadge = document.getElementById('desktopRealBadge');
        if (navRealBadge) {
          navRealBadge.textContent = realTotal;
          navRealBadge.style.display = realTotal > 0 ? 'inline-flex' : 'none';
        }
        if (desktopRealBadge) {
          desktopRealBadge.textContent = realTotal;
          desktopRealBadge.style.display = realTotal > 0 ? 'inline-flex' : 'none';
        }

        const onChainDot = document.getElementById('navOnChainDot');
        if (onChainDot) {
          const isEnabled = data.autoBuy?.config?.enabled;
          onChainDot.className = isEnabled ? 'nav-dot active' : 'nav-dot';
        }

        // Update Auto-Buy Controls
        if (data.autoBuy) {
          updateAutoBuyUI(data.autoBuy);
        }

        // Trigger table fetches if initial load or if counts changed
        if (!hasLoadedInitialTables || currentRun !== lastLoadedRun) {
          hasLoadedInitialTables = true;
          lastLoadedRun = currentRun;
          lastKnownClosedTotal = data.totalClosedTrades ?? 0;
          lastKnownRealTotal = data.totalRealTrades ?? 0;
          lastKnownQuotesTotal = data.totalRouteQuotes ?? 0;
          fetchClosedTrades(1);
          fetchRealTrades(1);
          fetchRouteQuotes(1);
        } else {
          if (closedCurrentPage === 1 && data.totalClosedTrades !== lastKnownClosedTotal) {
            lastKnownClosedTotal = data.totalClosedTrades;
            fetchClosedTrades(1);
          }
          if (realCurrentPage === 1 && data.totalRealTrades !== lastKnownRealTotal) {
            lastKnownRealTotal = data.totalRealTrades;
            fetchRealTrades(1);
          }
          if (quotesCurrentPage === 1 && data.totalRouteQuotes !== lastKnownQuotesTotal) {
            lastKnownQuotesTotal = data.totalRouteQuotes;
            fetchRouteQuotes(1);
          }
        }

      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Error fetching dashboard summary:', err);
      }
    }

    const fetchData = fetchSummary;

    let fetchTimer = null;
    let isFetching = false;

    async function loopFetch() {
      if (isFetching) return;
      isFetching = true;
      try {
        await Promise.all([
          fetchSummary(currentRun),
          fetchFeedConfig(),
        ]);
      } finally {
        isFetching = false;
        fetchTimer = setTimeout(loopFetch, 2500);
      }
    }

    async function changeRun(val) {
      if (!val) return;
      currentRun = val;
      closedCurrentPage = 1;
      realCurrentPage = 1;
      quotesCurrentPage = 1;
      if (fetchTimer) {
        clearTimeout(fetchTimer);
        fetchTimer = null;
      }

      const runStatusBadge = document.getElementById('runStatusBadge');
      if (runStatusBadge) {
        runStatusBadge.className = 'status-badge status-observing';
        runStatusBadge.textContent = '⏳ MEMUAT RUN...';
      }
      const bannerRunTitle = document.getElementById('bannerRunTitle');
      if (bannerRunTitle) bannerRunTitle.textContent = val;

      if (activeAbortController) {
        try { activeAbortController.abort(); } catch {}
      }

      await fetchSummary(val);
      await Promise.all([
        fetchClosedTrades(1),
        fetchRealTrades(1),
        fetchRouteQuotes(1),
      ]);

      if (!fetchTimer) {
        fetchTimer = setTimeout(loopFetch, 2500);
      }
    }

    loopFetch();
    fetchFeedConfig();

    ['cfgFeedUrlSelect', 'cfgMcPreset'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('focus', () => { isUserEditingFeed = true; });
        el.addEventListener('change', () => { isUserEditingFeed = true; });
      }
    });

    ['cfgStakeAmount', 'cfgMaxBuys', 'cfgMaxConcurrent', 'cfgSlippage', 'cfgPriorityFee', 'cfgLane', 'cfgStakeMode'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('focus', () => { isUserEditingAutoBuy = true; });
        el.addEventListener('input', () => { isUserEditingAutoBuy = true; });
        el.addEventListener('change', () => { isUserEditingAutoBuy = true; });
      }
    });

    // PWA & Tunnel Manager
    let activeTunnelUrl = null;
    let deferredInstallPrompt = null;

    async function checkPwaAndTunnelStatus() {
      try {
        const res = await fetch('/api/pwa-info');
        if (res.ok) {
          const data = await res.json();
          if (data.tunnelUrl) {
            activeTunnelUrl = data.tunnelUrl;
            
            // Update modal and banner links
            const modalBtn = document.getElementById('pwaModalHttpsBtn');
            if (modalBtn) modalBtn.href = activeTunnelUrl;
            const bannerLink = document.getElementById('httpsBannerLink');
            if (bannerLink) bannerLink.href = activeTunnelUrl;

            // If user is currently browsing via plain HTTP on a non-localhost domain, show the HTTPS notice
            const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            const isHttps = location.protocol === 'https:';
            const banner = document.getElementById('httpsNoticeBanner');
            if (!isHttps && !isLocalhost && banner) {
              banner.style.display = 'flex';
            }
          }
        }
      } catch (err) {
        console.warn('Error fetching PWA info:', err);
      }
    }
    checkPwaAndTunnelStatus();

    // PWA Service Worker Registration
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
          .then(reg => {
            console.log('PWA ServiceWorker registered with scope:', reg.scope);
            reg.update();
          })
          .catch(err => console.log('PWA ServiceWorker registration failed:', err));
      });
    }

    // PWA Install Prompt handling
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
      const btn = document.getElementById('btnPwaInstall');
      if (btn) btn.style.display = 'inline-flex';
    });

    window.addEventListener('appinstalled', () => {
      showToast('🎉 Aplikasi AGY Sniper berhasil dipasang!');
      deferredInstallPrompt = null;
    });

    function triggerPwaInstall() {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt.userChoice.then((choiceResult) => {
          if (choiceResult.outcome === 'accepted') {
            showToast('Aplikasi berhasil dipasang di perangkat!');
          }
          deferredInstallPrompt = null;
        });
      } else {
        openPwaModal();
      }
    }

    function openPwaModal() {
      const modal = document.getElementById('pwaModal');
      if (!modal) return;

      const isHttps = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
      const statusText = document.getElementById('pwaHttpsStatusText');
      const subText = document.getElementById('pwaHttpsSubText');
      const actionBox = document.getElementById('pwaHttpsActionBox');

      if (isHttps) {
        if (statusText) statusText.textContent = '✅ Anda Sudah Berada di Koneksi Aman (HTTPS)';
        if (subText) subText.textContent = 'Koneksi aman aktif! Ikuti petunjuk di bawah untuk menambahkan ikon aplikasi ke layar utama perangkat Anda.';
        if (actionBox) actionBox.style.background = 'rgba(16, 185, 129, 0.15)';
      } else {
        if (statusText) statusText.textContent = '⚠️ Browser Memblokir PWA di HTTP';
        if (subText) subText.textContent = 'Agar dapat dipasang menjadi aplikasi mandiri (PWA full screen), silakan buka Dashboard melalui link HTTPS Resmi di bawah ini:';
        if (actionBox) actionBox.style.background = 'rgba(245, 158, 11, 0.15)';
      }

      // Highlight relevant device guide
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      const isAndroid = /Android/.test(navigator.userAgent);
      
      const gIOS = document.getElementById('guideIOS');
      const gAndroid = document.getElementById('guideAndroid');
      const gDesktop = document.getElementById('guideDesktop');
      
      if (gIOS && isIOS) gIOS.style.border = '1px solid #3b82f6';
      if (gAndroid && isAndroid) gAndroid.style.border = '1px solid #10b981';
      if (gDesktop && !isIOS && !isAndroid) gDesktop.style.border = '1px solid #f59e0b';

      modal.style.display = 'flex';
    }

    function closePwaModal() {
      const modal = document.getElementById('pwaModal');
      if (modal) modal.style.display = 'none';
    }

    function copyTunnelUrl() {
      const target = activeTunnelUrl || location.href;
      navigator.clipboard.writeText(target).then(() => {
        showToast('📋 Link HTTPS berhasil disalin ke clipboard!');
      }).catch(() => {
        prompt('Salin link HTTPS ini:', target);
      });
    }

    // Native Tab Switching Implementation
    function switchTab(tabId, pushState = true) {
      const panes = document.querySelectorAll('.tab-pane');
      panes.forEach(p => p.classList.remove('active'));

      const targetPane = document.getElementById('pane-' + tabId);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      // Update Bottom Nav items
      const navItems = document.querySelectorAll('.bottom-nav-item');
      navItems.forEach(item => {
        if (item.getAttribute('data-tab') === tabId) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });

      // Update Desktop Tab items
      const desktopTabBtns = document.querySelectorAll('.desktop-tab-btn');
      desktopTabBtns.forEach(btn => {
        if (btn.getAttribute('data-tab') === tabId) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });

      try {
        localStorage.setItem('agy_active_tab', tabId);
        if (pushState && location.hash !== '#' + tabId) {
          history.replaceState(null, '', '#' + tabId);
        }
      } catch (e) {}

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    window.addEventListener('hashchange', () => {
      const hash = location.hash.replace('#', '');
      if (hash === 'realTradesSection') {
        switchTab('onchain', false);
        setTimeout(() => {
          const el = document.getElementById('realTradesSection');
          if (el) el.scrollIntoView({ behavior: 'smooth' });
        }, 50);
      } else if (['overview', 'positions', 'history', 'onchain'].includes(hash)) {
        switchTab(hash, false);
      }
    });

    // Restore initial tab
    (function initTabs() {
      const hash = location.hash.replace('#', '');
      if (hash === 'realTradesSection') {
        switchTab('onchain', false);
        setTimeout(() => {
          const el = document.getElementById('realTradesSection');
          if (el) el.scrollIntoView({ behavior: 'smooth' });
        }, 100);
      } else if (['overview', 'positions', 'history', 'onchain'].includes(hash)) {
        switchTab(hash, false);
      } else {
        const savedTab = localStorage.getItem('agy_active_tab') || 'overview';
        switchTab(savedTab, false);
      }
    })();
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/feed-config') {
    if (req.method === 'GET') {
      try {
        const config = readFeedSettings();
        const worker = getWorkerServiceStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, config, worker }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    if (req.method === 'POST') {
      let bodyText = '';
      req.on('data', chunk => { bodyText += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyText);
          const updated = writeFeedSettings(payload);
          let worker = getWorkerServiceStatus();
          if (payload.restart) {
            worker = controlWorkerService('restart');
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, config: updated, worker }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
  }

  if (pathname === '/api/worker-control') {
    if (req.method === 'POST') {
      let bodyText = '';
      req.on('data', chunk => { bodyText += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyText);
          const worker = controlWorkerService(payload.action);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, worker }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    if (req.method === 'GET') {
      const worker = getWorkerServiceStatus();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, worker }));
      return;
    }
  }

  if (pathname === '/api/autobuy') {
    if (req.method === 'GET') {
      try {
        const config = readAutoBuyConfig();
        const walletAddress = getActiveWalletAddress();
        const balance = await getSolanaBalance(walletAddress);
        const rentInfo = await getReclaimableRentInfo(walletAddress);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, config, walletAddress, balance, rentInfo }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }
    if (req.method === 'POST') {
      let bodyText = '';
      req.on('data', chunk => { bodyText += chunk; });
      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyText);
          const updated = writeAutoBuyConfig(payload);
          const walletAddress = getActiveWalletAddress();
          const balance = await getSolanaBalance(walletAddress);
          const rentInfo = await getReclaimableRentInfo(walletAddress);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, config: updated, walletAddress, balance, rentInfo }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
  }

  if (pathname === '/api/reclaim-rent') {
    if (req.method === 'POST') {
      try {
        const { reclaimAllEmptyAccounts, getKeypair } = await import('./solana-rent-reclaimer.mjs');
        if (!getKeypair()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({
            ok: false,
            error: 'SOLANA_PRIVATE_KEY belum ada di .env. Masukkan private key wallet ke file .env di server untuk auto-reclaim on-chain.'
          }));
        }
        const result = await reclaimAllEmptyAccounts();
        cachedSolBalance = null;
        lastBalanceFetchTime = 0;
        cachedRentInfo = null;
        lastRentInfoFetchTime = 0;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    }
  }

  if (pathname === '/api/summary') {
    const targetRun = url.searchParams.get('run');
    try {
      const fullData = await getAggressiveDashboardData(targetRun);
      const summaryData = {
        ok: true,
        availableRuns: fullData.availableRuns,
        currentRunId: fullData.currentRunId,
        isLive: fullData.isLive,
        runStartedAt: fullData.runStartedAt,
        runStartedAtFormatted: fullData.runStartedAtFormatted,
        summary: fullData.summary,
        workers: fullData.workers,
        openPositions: fullData.openPositions,
        throughput: fullData.throughput,
        autoBuy: fullData.autoBuy,
        totalClosedTrades: fullData.closedTrades?.length || 0,
        totalRouteQuotes: fullData.routeQuotes?.length || 0,
        totalRealTrades: fullData.realTrades?.length || 0,
        totalAllRealTrades: fullData.allRealTrades?.length || 0,
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(summaryData));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/trades') {
    const targetRun = url.searchParams.get('run');
    const lane = url.searchParams.get('lane') || 'all';
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 25));
    try {
      const fullData = await getAggressiveDashboardData(targetRun);
      let trades = fullData.closedTrades || [];
      if (lane !== 'all') {
        trades = trades.filter(t => t.lane === lane);
      }
      const total = trades.length;
      const totalPages = Math.ceil(total / limit) || 1;
      const pageIndex = Math.min(page, totalPages);
      const start = (pageIndex - 1) * limit;
      const pageTrades = trades.slice(start, start + limit);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        run: fullData.currentRunId,
        lane,
        page: pageIndex,
        limit,
        total,
        totalPages,
        trades: pageTrades,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/route-quotes') {
    const targetRun = url.searchParams.get('run');
    const type = url.searchParams.get('type') || 'all';
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 20));
    try {
      const fullData = await getAggressiveDashboardData(targetRun);
      let quotes = fullData.routeQuotes || [];
      if (type === 'BUY') {
        quotes = quotes.filter(q => q.isBuy);
      } else if (type === 'SELL') {
        quotes = quotes.filter(q => q.isSell);
      }
      const total = quotes.length;
      const totalPages = Math.ceil(total / limit) || 1;
      const pageIndex = Math.min(page, totalPages);
      const start = (pageIndex - 1) * limit;
      const pageQuotes = quotes.slice(start, start + limit);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        run: fullData.currentRunId,
        type,
        page: pageIndex,
        limit,
        total,
        totalPages,
        quotes: pageQuotes,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/real-trades') {
    const targetRun = url.searchParams.get('run');
    const scope = url.searchParams.get('scope') || 'session';
    const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 10));
    try {
      const fullData = await getAggressiveDashboardData(targetRun);
      const list = (scope === 'all') ? (fullData.allRealTrades || []) : (fullData.realTrades || []);
      const total = list.length;
      const totalPages = Math.ceil(total / limit) || 1;
      const pageIndex = Math.min(page, totalPages);
      const start = (pageIndex - 1) * limit;
      const pageTrades = list.slice(start, start + limit);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        run: fullData.currentRunId,
        scope,
        page: pageIndex,
        limit,
        total,
        totalPages,
        trades: pageTrades,
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (pathname === '/api/real-trade-detail') {
    const mint = url.searchParams.get('mint');
    const targetRun = url.searchParams.get('run');
    try {
      const fullData = await getAggressiveDashboardData(targetRun);
      const trade = (fullData.allRealTrades || []).find(t => t.mint === mint) ||
                    (fullData.realTrades || []).find(t => t.mint === mint);
      if (!trade) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Trade not found' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, trade }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  if (pathname === '/api/pwa-info') {
    const urlFile = join(projectRoot, '.dashboard-tunnel-url');
    let tunnelUrl = null;
    if (existsSync(urlFile)) {
      try {
        tunnelUrl = readFileSync(urlFile, 'utf8').trim() || null;
      } catch (e) {}
    }
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted === true;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, tunnelUrl, isHttps }));
    return;
  }

  if (pathname === '/api/data') {
    const targetRun = url.searchParams.get('run');
    try {
      const data = await getAggressiveDashboardData(targetRun);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/comparison' || pathname === '/audit-eksekusi' || pathname === '/perbandingan') {
    const compFile = join(projectRoot, 'reports', 'perbandingan-socket-swap-real.html');
    if (existsSync(compFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(compFile, 'utf8'));
      return;
    }
  }

  if (pathname === '/simulation' || pathname === '/simulation-20usd' || pathname === '/cashflow') {
    const simFile = join(projectRoot, 'reports', 'simulation-cashflow-20usd.html');
    if (existsSync(simFile)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(readFileSync(simFile, 'utf8'));
      return;
    }
  }

  if (pathname === '/manifest.json' || pathname === '/manifest.webmanifest') {
    const manifestFile = join(projectRoot, 'public', 'manifest.json');
    if (existsSync(manifestFile)) {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      res.end(readFileSync(manifestFile));
      return;
    }
  }

  if (pathname === '/sw.js') {
    const swFile = join(projectRoot, 'public', 'sw.js');
    if (existsSync(swFile)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(readFileSync(swFile));
      return;
    }
  }

  if (pathname.startsWith('/icons/')) {
    const iconName = pathname.replace('/icons/', '');
    const iconFile = join(projectRoot, 'public', 'icons', iconName);
    if (existsSync(iconFile)) {
      const ext = iconName.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
      res.writeHead(200, { 'Content-Type': ext, 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(iconFile));
      return;
    }
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderHtml());
    return;
  }

  if (pathname === '/favicon.ico') {
    const icoFile = join(projectRoot, 'public', 'icons', 'icon-192.png');
    if (existsSync(icoFile)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(icoFile));
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(opts.port, opts.host, () => {
  console.log('=============================================================================');
  console.log('       🔥 AGY AGGRESSIVE HIGH-VOLUME SNIPER DASHBOARD ONLINE 🔥              ');
  console.log('=============================================================================');
  console.log(` Web Dashboard URL : http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${opts.port}`);
  console.log(` Active Run Folder : ${opts.runFolder || 'Auto-discovering latest aggressive runs'}`);
  console.log(` Auto Refresh      : Live Polling (1.5 seconds)`);
  console.log('=============================================================================');
});
