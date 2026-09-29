#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function findAggressiveRuns() {
  if (!existsSync(researchDir)) return [];
  const entries = readdirSync(researchDir, { withFileTypes: true });
  const runs = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = join(researchDir, entry.name);
    const manifestPath = join(folder, 'manifest.json');
    const strategyPath = join(folder, 'strategy.json');

    let isAggressive = entry.name.includes('aggressive');
    let startedAt = null;

    if (existsSync(strategyPath)) {
      try {
        const strat = JSON.parse(readFileSync(strategyPath, 'utf8'));
        if (strat?.strategy === 'momentum-aggressive') isAggressive = true;
      } catch {}
    }
    if (existsSync(manifestPath)) {
      try {
        const man = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (man?.strategy === 'momentum-aggressive') isAggressive = true;
        startedAt = man?.startedAt;
      } catch {}
    }

    if (isAggressive) {
      let mtime = 0;
      try { mtime = statSync(folder).mtimeMs; } catch {}
      runs.push({
        id: entry.name,
        path: folder,
        startedAt: startedAt || new Date(mtime).toISOString(),
        mtime,
      });
    }
  }

  // Also include general momentum runs if no dedicated aggressive run found yet
  if (runs.length === 0) {
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = join(researchDir, entry.name);
      if (entry.name.includes('momentum') || entry.name.includes('pump-band')) {
        let mtime = 0;
        try { mtime = statSync(folder).mtimeMs; } catch {}
        runs.push({
          id: entry.name,
          path: folder,
          startedAt: new Date(mtime).toISOString(),
          mtime,
        });
      }
    }
  }

  return runs.sort((a, b) => b.mtime - a.mtime);
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

function getAggressiveDashboardData(targetRunId) {
  const allRuns = findAggressiveRuns();
  const selectedRun = targetRunId
    ? allRuns.find(r => r.id === targetRunId) || { id: targetRunId, path: resolve(researchDir, targetRunId) }
    : allRuns[0] || (opts.runFolder ? { id: basename(opts.runFolder), path: resolve(opts.runFolder) } : null);

  if (!selectedRun || !existsSync(selectedRun.path)) {
    return {
      availableRuns: allRuns.map(r => ({ id: r.id, startedAt: r.startedAt })),
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
    };
  }

  const runDir = selectedRun.path;
  const manifest = readJsonFile(join(runDir, 'manifest.json'));
  const strategy = readJsonFile(join(runDir, 'strategy.json'));
  const simulatedTrades = readJsonLines(join(runDir, 'simulated-trades.jsonl'));
  const tradeSignals = readJsonLines(join(runDir, 'trade-signals.jsonl'));
  const routeQuotes = readJsonLines(join(runDir, 'quote-simulated-orders.jsonl'));
  const decisions = readJsonLines(join(runDir, 'momentum-decisions.jsonl'));
  const tokenSummaries = readJsonLines(join(runDir, 'token-summary.jsonl'));
  const socketTicks = readJsonLines(join(runDir, 'socket-ticks.jsonl'));
  const rawTrades = readJsonLines(join(runDir, 'trades.jsonl'));
  const events = readJsonLines(join(runDir, 'events.jsonl'));

  const buys = simulatedTrades.filter(t => t.type === 'SIMULATED_BUY');
  const sells = simulatedTrades.filter(t => t.type === 'SIMULATED_SELL');
  const sellsByPosition = new Map(sells.map(s => [s.positionId, s]));
  const sellsByMint = new Map(sells.map(s => [s.mint, s]));

  // Quotes mapping: signalId/positionId -> quote
  const quotesBySignal = new Map();
  const quotesByPosition = new Map();
  for (const q of routeQuotes) {
    if (q.signalId) quotesBySignal.set(q.signalId, q);
    if (q.positionId) {
      const cur = quotesByPosition.get(q.positionId) || [];
      cur.push(q);
      quotesByPosition.set(q.positionId, cur);
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

  const now = Date.now();

  for (const buy of buys) {
    const posId = buy.positionId || `${buy.mint}:${buy.observedAt}:control`;
    const sell = sellsByPosition.get(posId) || sellsByMint.get(buy.mint);
    const buyQuotes = quotesByPosition.get(posId) || [];
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

      const stakeUsd = buy.stakeUsd || 5.0;
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
      const tokenTicks = socketTicks.filter(t => t.mint === buy.mint);
      const latestTick = tokenTicks[tokenTicks.length - 1];
      const currentPrice = latestTick?.priceUsd || buy.entryPriceUsd;
      const floatingReturn = ((currentPrice / buy.entryPriceUsd) - 1) * 100;

      // Peak price from decisions or ticks
      const tokenDecisions = decisions.filter(d => d.mint === buy.mint);
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

  // Worker status calculation
  const workers = [1, 2, 3].map(wId => {
    // Find active token in events or openPositions
    const activePos = openPositions.find(p => p.worker === wId);
    if (activePos) {
      return {
        id: wId,
        status: 'POSITION_OPEN',
        currentMint: activePos.mint,
        symbol: activePos.symbol,
        ticks: socketTicks.filter(t => t.mint === activePos.mint).length,
        durationSec: activePos.elapsedSec,
      };
    }

    // Check recent detail open events
    const workerEvents = events.filter(e => e.worker === wId);
    const latestEvent = workerEvents[workerEvents.length - 1];
    const isObserving = latestEvent?.type === 'DETAIL_WINDOW_OPEN';
    const mint = latestEvent?.mint || null;
    const summary = tokenSummaries.find(s => s.mint === mint);
    const symbol = summary?.symbol || (mint ? mint.slice(0, 6) : null);

    return {
      id: wId,
      status: isObserving ? 'OBSERVING_SOCKET' : 'SEARCHING',
      currentMint: mint,
      symbol,
      ticks: mint ? socketTicks.filter(t => t.mint === mint).length : 0,
      durationSec: latestEvent ? Math.max(0, Math.round((now - latestEvent.observedAt) / 1000)) : 0,
    };
  });

  const totalTrades = closedTrades.length;
  const socketWinRate = totalTrades > 0 ? (socketWins / totalTrades) * 100 : 0;
  const realWinRate = totalTrades > 0 ? (realWins / totalTrades) * 100 : 0;
  const avgLatencyMs = latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : 0;
  const avgSlippagePct = slippageCount > 0 ? Number((totalSlippagePct / slippageCount).toFixed(2)) : 5.43;

  // Throughput
  const totalRawTrades = rawTrades.length;
  const totalTicks = socketTicks.length;
  const startTime = manifest?.startedAt ? new Date(manifest.startedAt).getTime() : (selectedRun.mtime || now);
  const runtimeSeconds = Math.max(1, Math.round((now - startTime) / 1000));
  const ratePerSec = Number(((totalRawTrades + totalTicks) / runtimeSeconds).toFixed(1));

  // Enrich route quotes with token metadata
  const metadataByMint = new Map();
  for (const b of buys) if (b.mint && b.metadata) metadataByMint.set(b.mint, b.metadata);
  for (const s of tokenSummaries) if (s.mint && s.metadata) metadataByMint.set(s.mint, s.metadata);

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

  return {
    availableRuns: allRuns.map(r => ({ id: r.id, startedAt: r.startedAt })),
    currentRunId: selectedRun.id,
    runStartedAt: manifest?.startedAt || new Date(startTime).toISOString(),
    summary: {
      totalBuys: buys.length,
      closedTrades: totalTrades,
      openPositions: openPositions.length,
      socketWins,
      socketLosses,
      socketWinRate: Number(socketWinRate.toFixed(1)),
      totalNetTradePnlUsd: Number(totalNetTradePnlUsd.toFixed(4)),
      realWins,
      realLosses,
      realWinRate: Number(realWinRate.toFixed(1)),
      totalNetRealPnlUsd: Number(totalNetRealPnlUsd.toFixed(4)),
      avgLatencyMs,
      avgSlippagePct,
    },
    workers,
    openPositions,
    closedTrades: closedTrades.sort((a, b) => b.exitTime - a.exitTime),
    routeQuotes: enrichedRouteQuotes.slice(-50).reverse(),
    throughput: {
      tradesTotal: totalRawTrades,
      ticksTotal: totalTicks,
      ratePerSec,
      runtimeSeconds,
    },
  };
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AGY Aggressive High-Volume Sniper Dashboard</title>
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
    body {
      background: var(--bg);
      background-image: 
        radial-gradient(at 0% 0%, rgba(245, 158, 11, 0.06) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.06) 0px, transparent 50%);
      color: var(--text);
      font-family: 'Inter', sans-serif;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .container { max-width: 1400px; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem; }
    
    /* Header */
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--card-border);
    }
    .title-group h1 {
      font-size: 1.6rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .badge-aggressive {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: #000;
      font-size: 0.75rem;
      font-weight: 800;
      padding: 0.2rem 0.6rem;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .title-group p {
      font-size: 0.85rem;
      color: var(--text-muted);
      margin-top: 0.25rem;
    }
    .controls {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    select, button {
      background: #1f2937;
      color: var(--text);
      border: 1px solid var(--card-border);
      border-radius: 0.5rem;
      padding: 0.5rem 0.8rem;
      font-size: 0.85rem;
      font-family: inherit;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    select:hover, button:hover { border-color: rgba(255, 255, 255, 0.2); }
    .btn-refresh {
      background: #f59e0b;
      color: #000;
      font-weight: 600;
      border: none;
    }
    .btn-refresh:hover { background: #d97706; }
    .live-pulse {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--win);
      box-shadow: 0 0 10px var(--win);
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.9); } 100% { opacity: 1; transform: scale(1); } }

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
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 1rem;
    }
    .kpi-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.85rem;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
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
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.04em;
    }
    .kpi-value {
      font-size: 1.75rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .up { color: var(--win); }
    .down { color: var(--loss); }
    .accent { color: var(--accent); }

    /* Worker Grid */
    .section-title {
      font-size: 1.1rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .worker-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 1rem;
    }
    .worker-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.85rem;
      padding: 1.1rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
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
      font-size: 0.78rem;
      padding: 0.2rem 0.55rem;
      border-radius: 0.4rem;
    }
    .status-badge {
      font-size: 0.75rem;
      font-weight: 600;
      padding: 0.2rem 0.5rem;
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
    }
    table {
      width: 100%;
      min-width: 1100px;
      border-collapse: separate;
      border-spacing: 0;
      text-align: left;
      font-size: 0.85rem;
    }
    th {
      background: #111827;
      padding: 0.85rem 1rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.03em;
      border-bottom: 1px solid var(--card-border);
      white-space: nowrap;
    }
    td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: middle;
      background: inherit;
    }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* Sticky first column (Token) for seamless horizontal mobile scroll */
    th.sticky-col, td.sticky-col {
      position: sticky;
      left: 0;
      z-index: 2;
      background: #0d131f;
      border-right: 1px solid var(--card-border);
      box-shadow: 4px 0 8px -2px rgba(0, 0, 0, 0.6);
      min-width: 135px;
      max-width: 160px;
    }
    th.sticky-col {
      z-index: 3;
      background: #162032;
    }

    .mobile-hint {
      display: none;
      font-size: 0.74rem;
      color: #60a5fa;
      background: rgba(59, 130, 246, 0.1);
      border: 1px dashed rgba(59, 130, 246, 0.35);
      border-radius: 0.5rem;
      padding: 0.45rem 0.8rem;
      margin-bottom: 0.6rem;
    }

    .tag {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.2rem 0.45rem;
      border-radius: 0.35rem;
      text-transform: uppercase;
    }
    .tag-win { background: var(--win-bg); color: var(--win); }
    .tag-loss { background: var(--loss-bg); color: var(--loss); }
    .tag-trail { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
    .tag-stop { background: var(--loss-bg); color: var(--loss); }
    .tag-stag { background: rgba(168, 85, 247, 0.2); color: var(--purple); }
    .tag-flow { background: rgba(59, 130, 246, 0.2); color: var(--blue); }

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

    /* Mobile Responsive Optimizations */
    @media (max-width: 768px) {
      body { padding: 0.75rem 0.5rem; }
      .container { gap: 1rem; }
      header { flex-direction: column; align-items: flex-start; gap: 0.75rem; }
      .title-group h1 { font-size: 1.25rem; }
      .controls { width: 100%; justify-content: space-between; }
      .mobile-hint { display: block; }
      .kpi-grid { grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
      .kpi-card { padding: 0.75rem; }
      .kpi-value { font-size: 1.3rem; }
      .kpi-label { font-size: 0.7rem; }
      .rules-banner { gap: 0.4rem; font-size: 0.72rem; padding: 0.6rem; }
      .worker-grid { grid-template-columns: 1fr; }
      th, td { padding: 0.65rem 0.75rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="title-group">
        <h1>
          <span>⚡ AGY Aggressive Sniper</span>
          <span class="badge-aggressive">Mode Agresif</span>
          <span class="live-pulse"></span>
        </h1>
        <p>Live 3-Worker Parallel Execution · WebSocket Stream Ticks · Live GMGN Swap Route Friction Analysis</p>
      </div>
      <div class="controls">
        <label for="runSelect" style="font-size: 0.8rem; color: var(--text-muted);">Pilih Run:</label>
        <select id="runSelect" onchange="changeRun(this.value)">
          <option value="">Loading runs...</option>
        </select>
        <button class="btn-refresh" onclick="fetchData()">⟳ Refresh</button>
      </div>
    </header>

    <!-- Rules Parameter Banner -->
    <div class="rules-banner">
      <div class="rule-tag">⚙️ <b>Rules Mode Agresif (Master Hybrid):</b></div>
      <div class="rule-tag">MC Sweet Spot: <span>$5.5k – $15k</span></div>
      <div class="rule-tag">Anti-Whale Gate: <span>TopBuyer ≤ 70% (≥4 buyers)</span></div>
      <div class="rule-tag">Volume Surge: <span>BuyUsd ≥ $300 (5s)</span></div>
      <div class="rule-tag">Pure Flow: <span>BuyShare ≥ 95%</span></div>
      <div class="rule-tag">Velocity: <span>R5s ≥ +1.0%</span></div>
      <div class="rule-tag">Scalp Trail: <span>+4% → Lock +2.5% (Trail 1%)</span></div>
      <div class="rule-tag">Runner Trail: <span>≥+11% → Lock +4% (Trail 8%)</span></div>
      <div class="rule-tag">Hard Stop: <span>-3.0%</span></div>
      <div class="rule-tag">Stagnation Auto-Cut: <span>15s if &lt; +2.5%</span></div>
      <div class="rule-tag">Flow Exit: <span>Sell Share ≥ 65%</span></div>
      <div class="rule-tag">Max Observation: <span>90s (1.5 min)</span></div>
    </div>

    <!-- KPI Grid -->
    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Real Swap Win Rate (Uang Riil)</div>
        <div class="kpi-value" id="realWinRate">0.0%</div>
        <div class="kpi-sub" id="realScore">0W / 0L (Berdasarkan Uang Riil)</div>
        <div class="kpi-sub" id="socketScoreCompare" style="color: #60a5fa; margin-top: 2px;">📈 Chart Socket: 0.0% (0W/0L)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Real Net Profit ($)</div>
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
            <tr><td colspan="8" class="empty-state">Tidak ada posisi terbuka saat ini. Worker sedang memindai token baru.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Unified Trades & Route Execution Master Table -->
    <div>
      <div class="section-title">
        <span>📊 Riwayat Transaksi & Eksekusi Swap Terpadu (<span id="closedCount">0</span>)</span>
      </div>
      <div class="mobile-hint">📱 Tampilan Mobile: Geser tabel ke kanan untuk melihat rute swap & detail lengkap ➔</div>
      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th class="sticky-col">Token</th>
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
            <tr><td colspan="10" class="empty-state">Belum ada trade yang ditutup pada sesi ini.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Collapsible Raw Route Quotes Log for Developer Audit -->
    <details style="margin-top: 1.5rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 0.85rem; padding: 1rem;">
      <summary style="cursor: pointer; font-size: 0.85rem; color: var(--text-muted); font-weight: 600; outline: none; user-select: none; display: flex; align-items: center; justify-content: space-between;">
        <span>🔍 Log Raw Panggilan GMGN Swap Route Quotes (Audit API Developer)</span>
        <span style="font-size: 0.75rem; color: #60a5fa;">[Klik untuk buka/tutup log per-panggilan]</span>
      </summary>
      <div style="margin-top: 1rem; overflow-x: auto;">
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
      </div>
    </details>

  </div>

  <script>
    let currentRun = '';

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
      if (reason.includes('PROFIT_TRAIL') || reason.includes('TARGET')) {
        return '<span class="tag tag-trail">' + reason.replace('AGGRESSIVE_', '') + '</span>';
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
      return '<span class="tag">' + reason + '</span>';
    }

    async function fetchData() {
      try {
        const url = '/api/data' + (currentRun ? '?run=' + encodeURIComponent(currentRun) : '');
        const res = await fetch(url);
        const data = await res.json();

        // Update run dropdown
        const runSelect = document.getElementById('runSelect');
        if (data.availableRuns && data.availableRuns.length > 0) {
          const currentOptions = Array.from(runSelect.options).map(o => o.value);
          const newOptions = data.availableRuns.map(r => r.id);
          if (JSON.stringify(currentOptions) !== JSON.stringify(newOptions)) {
            runSelect.innerHTML = data.availableRuns.map(r => 
              '<option value="' + r.id + '"' + (r.id === data.currentRunId ? ' selected' : '') + '>' + r.id + '</option>'
            ).join('');
          }
        }
        currentRun = data.currentRunId || '';

        // Update KPIs
        if (data.summary) {
          const s = data.summary;
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
                '<div style="font-weight: 700; font-size: 1.05rem;">' + tokenTitle + '</div>' +
                '<div class="mono" style="font-size: 0.75rem; color: var(--text-muted); word-break: break-all; margin-top: 3px;">' + mintLink + '</div>' +
              '</div>' +
              '<div style="font-size: 0.8rem; color: var(--text-muted); display: flex; justify-content: space-between;">' +
                '<span>Stream Ticks: <b>' + w.ticks.toLocaleString() + '</b></span>' +
                '<span>Durasi: <b>' + w.durationSec + 's</b></span>' +
              '</div>' +
            '</div>';
          }).join('');
        }

        // Update Open Positions
        const openBody = document.getElementById('openPositionsBody');
        document.getElementById('openCount').textContent = data.openPositions.length;
        if (data.openPositions.length > 0) {
          openBody.innerHTML = data.openPositions.map(p => {
            const estRealReturn = p.floatingReturnPercent - 5.4;
            const estClass = estRealReturn >= 0 ? 'up' : 'down';
            const stagPct = Math.max(0, Math.min(100, (p.stagnationCountdownSec / 12) * 100));
            return '<tr>' +
              '<td class="sticky-col">' +
                '<b><a href="https://gmgn.ai/sol/token/' + p.mint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none; font-size: 0.95rem;">' + p.symbol + ' ↗</a></b><br>' +
                '<a href="https://gmgn.ai/sol/token/' + p.mint + '" target="_blank" rel="noopener" class="mono" style="font-size: 0.72rem; color: #9ca3af; text-decoration: underline;" title="' + p.mint + '">' + p.mint.slice(0, 10) + '...</a>' +
              '</td>' +
              '<td><span class="worker-badge">Worker ' + p.worker + '</span></td>' +
              '<td class="mono">' + formatUsd(p.entryPrice) + '</td>' +
              '<td class="mono">' + formatUsd(p.currentPrice) + '</td>' +
              '<td>' +
                '<div class="mono ' + estClass + '" style="font-weight: 700;">' + (estRealReturn >= 0 ? '+' : '') + estRealReturn.toFixed(2) + '%</div>' +
                '<div class="mono" style="font-size: 0.72rem; color: #60a5fa; margin-top: 2px;">📈 Chart: ' + (p.floatingReturnPercent >= 0 ? '+' : '') + p.floatingReturnPercent.toFixed(2) + '%</div>' +
              '</td>' +
              '<td class="mono up">+' + p.peakReturnPercent.toFixed(2) + '%</td>' +
              '<td class="mono">' + (p.trailingFloorPercent != null ? '+' + p.trailingFloorPercent.toFixed(2) + '%' : '—') + '</td>' +
              '<td>' +
                '<div style="display: flex; justify-content: space-between; font-size: 0.75rem;">' +
                  '<span>' + p.stagnationCountdownSec + 's tersisa</span>' +
                  '<span>' + (p.peakReturnPercent >= 2.5 ? '✅ Lolos Stagnation' : '⚠️ Countdown') + '</span>' +
                '</div>' +
                '<div class="stag-bar"><div class="stag-fill" style="width: ' + stagPct + '%;"></div></div>' +
              '</td>' +
            '</tr>';
          }).join('');
        } else {
          openBody.innerHTML = '<tr><td colspan="8" class="empty-state">Tidak ada posisi terbuka saat ini. Worker sedang memindai order flow token baru.</td></tr>';
        }

        // Update Closed Trades (Unified Master Table)
        const closedBody = document.getElementById('closedTradesBody');
        document.getElementById('closedCount').textContent = data.closedTrades.length;
        if (data.closedTrades.length > 0) {
          closedBody.innerHTML = data.closedTrades.map(t => {
            const realClass = t.realReturnPercent >= 0 ? 'up' : 'down';
            const socketClass = t.socketReturnPercent >= 0 ? 'up' : 'down';
            const tradePnlVal = t.tradePnlUsd != null ? t.tradePnlUsd : t.pnlUsd;
            const swapPnlVal = t.swapPnlUsd != null ? t.swapPnlUsd : t.pnlUsd;
            const swapPnlClass = swapPnlVal >= 0 ? 'up' : 'down';
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
              buyCell = '<div style="font-size: 0.78rem; line-height: 1.4; min-width: 175px;">' +
                '<div style="color: #60a5fa; font-size: 0.73rem; font-weight: 700; margin-bottom: 2px;">🕒 Waktu Buy: <span class="mono">' + buyTimeStr + '</span></div>' +
                '<div style="color: #34d399; font-weight: 600;">' + buyFlow + ' → ' + sr.buyOutTokens + ' tok</div>' +
                '<div style="font-size: 0.7rem; color: #9ca3af;">Slip: <b>' + sr.buySlippage + '</b> · Lat: <b>' + (sr.buyLatencyMs != null ? sr.buyLatencyMs + 'ms' : '—') + '</b></div>' +
              '</div>';
            }

            let sellCell = '<span style="color: #6b7280; font-size: 0.75rem;">—</span>';
            if (sr && sr.hasSell) {
              const sellOut = sr.sellOutSol ? sr.sellOutSol + ' (' + sr.sellOutUsd + ')' : (sr.sellOutUsd || '—');
              const sellTimeStr = formatTime(sr.sellTime || t.exitTime);
              sellCell = '<div style="font-size: 0.78rem; line-height: 1.4; min-width: 175px;">' +
                '<div style="color: #f59e0b; font-size: 0.73rem; font-weight: 700; margin-bottom: 2px;">🕒 Waktu Sell: <span class="mono">' + sellTimeStr + '</span></div>' +
                '<div style="color: #f87171; font-weight: 600;">' + sr.sellInTokens + ' tok → ' + sellOut + '</div>' +
                '<div style="font-size: 0.7rem; color: #9ca3af;">Slip: <b>' + sr.sellSlippage + '</b> · Lat: <b>' + (sr.sellLatencyMs != null ? sr.sellLatencyMs + 'ms' : '—') + '</b></div>' +
              '</div>';
            }

            return '<tr>' +
              '<td class="sticky-col">' +
                '<b><a href="https://gmgn.ai/sol/token/' + t.mint + '" target="_blank" rel="noopener" style="color: #60a5fa; text-decoration: none; font-size: 0.95rem;">' + t.symbol + ' ↗</a></b><br>' +
                (t.name ? '<span style="font-size: 0.75rem; color: #d1d5db; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: inline-block; max-width: 130px;">' + t.name + '</span><br>' : '') +
                '<a href="https://gmgn.ai/sol/token/' + t.mint + '" target="_blank" rel="noopener" class="mono" style="font-size: 0.72rem; color: #9ca3af; text-decoration: underline;" title="' + t.mint + '">' + t.mint.slice(0, 10) + '...</a>' +
              '</td>' +
              '<td><span class="worker-badge">W' + t.worker + '</span></td>' +
              '<td>' +
                '<span class="mono" style="font-size: 0.8rem;">' + formatTime(t.entryTime) + '</span>' +
                '<div style="font-size: 0.72rem; color: #9ca3af; margin-top: 2px;">Durasi: <b>' + t.durationSec + 's</b></div>' +
              '</td>' +
              '<td class="mono" style="font-size: 0.82rem;">' +
                '<span style="color: #9ca3af;">' + formatUsd(t.entryPrice) + '</span><br>' +
                '<span style="color: #f3f4f6; font-weight: 600;">→ ' + formatUsd(t.exitPrice) + '</span>' +
              '</td>' +
              '<td>' + exitReasonBadge(t.exitReason) + '</td>' +
              '<td>' +
                '<div class="mono ' + realClass + '" style="font-size: 0.95rem; font-weight: 700;">' + (t.realReturnPercent >= 0 ? '+' : '') + t.realReturnPercent.toFixed(2) + '%</div>' +
                '<div class="mono" style="font-size: 0.72rem; color: #60a5fa; margin-top: 2px;">📈 Chart: ' + (t.socketReturnPercent >= 0 ? '+' : '') + t.socketReturnPercent.toFixed(2) + '%</div>' +
              '</td>' +
              '<td>' + buyCell + '</td>' +
              '<td>' + sellCell + '</td>' +
              '<td>' +
                '<div class="mono ' + swapPnlClass + '" style="font-size: 0.95rem; font-weight: 700;">' + (swapPnlVal >= 0 ? '+' : '') + '$' + swapPnlVal.toFixed(4) + '</div>' +
                '<div class="mono" style="font-size: 0.72rem; color: #60a5fa; margin-top: 2px;">📈 Chart: ' + (tradePnlVal >= 0 ? '+' : '') + '$' + tradePnlVal.toFixed(4) + '</div>' +
              '</td>' +
              '<td>' + badge + badgeNote + '</td>' +
            '</tr>';
          }).join('');
        } else {
          closedBody.innerHTML = '<tr><td colspan="10" class="empty-state">Belum ada trade yang ditutup pada sesi ini.</td></tr>';
        }

        // Update Route Quotes
        const quotesBody = document.getElementById('routeQuotesBody');
        if (data.routeQuotes && data.routeQuotes.length > 0) {
          quotesBody.innerHTML = data.routeQuotes.map(q => {
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
          }).join('');
        } else {
          quotesBody.innerHTML = '<tr><td colspan="8" class="empty-state">Belum ada swap route quote yang tercatat.</td></tr>';
        }

      } catch (err) {
        console.error('Error fetching dashboard data:', err);
      }
    }

    function changeRun(val) {
      currentRun = val;
      fetchData();
    }

    // Polling every 1500ms
    fetchData();
    setInterval(fetchData, 1500);
  </script>
</body>
</html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/data') {
    const targetRun = url.searchParams.get('run');
    try {
      const data = getAggressiveDashboardData(targetRun);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderHtml());
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
