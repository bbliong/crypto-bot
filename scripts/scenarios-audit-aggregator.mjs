import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function formatWib(ts) {
  if (!ts) return '-';
  const d = new Date(Number(ts));
  const wib = new Date(d.getTime() + 7 * 3600 * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())} ${pad(wib.getUTCHours())}:${pad(wib.getUTCMinutes())}:${pad(wib.getUTCSeconds())}.${pad(wib.getUTCMilliseconds(), 3)} WIB`;
}

export function getScenarioAuditData(scenarioKey = 's6', dataDir = join(process.cwd(), 'data')) {
  const normKey = (scenarioKey || 's6').toLowerCase();
  const scId = normKey.includes('4') ? 'SCENARIO_4_SINGLE_BUY_5USD' : 'SCENARIO_6_REDEPLOY_SNIPER';
  const scName = normKey.includes('4') 
    ? 'Skenario 4: Single Buy $5 (Hanya 1x Buy)' 
    : 'Skenario 6: Re-Deploy Sniper V2 (Split TP 50/50: 5% & 15%)';

  const dryRunFile = join(dataDir, 'dryrun-3scenarios-live.json');
  const ledgerFile = join(dataDir, 'follower-real-ledger.jsonl');

  let sData = { openPositions: [], closedTrades: [], name: scName };
  if (existsSync(dryRunFile)) {
    try {
      const all = JSON.parse(readFileSync(dryRunFile, 'utf8'));
      if (normKey.includes('4') && all.s4) sData = all.s4;
      else if (all.s6) sData = all.s6;
    } catch {}
  }

  // Baca ledger lines
  const ledgerEntries = [];
  if (existsSync(ledgerFile)) {
    try {
      const lines = readFileSync(ledgerFile, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const eScId = entry.details?.scenarioId || '';
          const eType = entry.type || '';
          if (eScId.includes(scId) || eType.includes(scId) || eType.includes(normKey.toUpperCase())) {
            ledgerEntries.push(entry);
          }
        } catch {}
      }
    } catch {}
  }

  // Satukan semua token trades: openPositions + closedTrades
  const allTokens = [];

  // 1. Tambah open positions jika ada
  for (const op of (sData.openPositions || [])) {
    allTokens.push({
      mint: op.mint,
      symbol: op.symbol || 'UNKNOWN',
      name: op.tokenName || op.symbol || 'Token',
      status: 'OPEN',
      investedUsd: op.investedCash || op.stakeUsd || 5.0,
      returnedUsd: 0,
      realizedPnlUsd: 0,
      roiPct: op.unrealizedRoiPct || 0,
      openedAt: op.openedAt || Date.now(),
      closedAt: null,
      exitReason: 'POSISI AKTIF BERJALAN',
      isWin: false,
    });
  }

  // 2. Tambah closed trades
  for (const ct of (sData.closedTrades || [])) {
    allTokens.push({
      mint: ct.mint,
      symbol: ct.symbol || 'UNKNOWN',
      name: ct.tokenName || ct.symbol || 'Token',
      status: 'CLOSED',
      investedUsd: ct.totalInvestedUsd || 5.0,
      returnedUsd: ct.totalReturnedUsd || 0,
      realizedPnlUsd: ct.realizedPnlUsd || 0,
      roiPct: ct.roiPct || 0,
      openedAt: ct.openedAt,
      closedAt: ct.closedAt,
      exitReason: ct.exitReason || 'TP_EXIT',
      isWin: Boolean(ct.isWin),
    });
  }

  // Urutkan trades: terbaru di atas
  allTokens.sort((a, b) => (b.closedAt || b.openedAt || 0) - (a.closedAt || a.openedAt || 0));

  // Build detail step detik demi detik untuk setiap trade
  const enrichedTrades = allTokens.map(trade => {
    const mint = trade.mint;
    const windowStart = (trade.openedAt || 0) - 10000; // toleransi 10 detik sebelum
    const windowEnd = trade.closedAt ? trade.closedAt + 30000 : Date.now() + 60000; // toleransi 30 detik setelah

    // Filter ledger entries yang cocok dengan mint dan dalam rentang waktu trade ini
    const related = ledgerEntries.filter(e => {
      const eMint = e.details?.signal?.mint || e.details?.mint || '';
      if (eMint !== mint) return false;
      const t = e.at || (e.details?.signal?.timestamp ? e.details.signal.timestamp * 1000 : 0);
      return t >= windowStart && t <= windowEnd;
    });

    related.sort((a, b) => (a.at || 0) - (b.at || 0));

    const steps = [];

    for (const item of related) {
      const at = item.at || Date.now();
      const timeWib = formatWib(at);
      const sig = item.details?.signal || {};
      const route = item.details?.route || {};
      const submit = item.details?.submit;
      const isAutoBuy = item.details?.autoBuyEnabled !== false;
      const type = item.type || '';
      const reason = item.details?.reason || '';

      // 1. Event Beli
      if (type.includes('BUY')) {
        // Step A: Target Buy
        if (sig.action === 'buy') {
          steps.push({
            timestamp: at - 500,
            timeWib: formatWib(at - 500),
            tag: '🎯 TARGET BUY',
            badgeClass: 'badge-target-buy',
            title: `Target Wallet Beli ${sig.symbol || trade.symbol}`,
            description: `Target melakukan order BUY sebesar ${(sig.tokenAmount || 0).toLocaleString()} token (~$${(sig.usdAmount || 0).toFixed(2)} USD) @ $${(sig.priceUsd || 0).toFixed(8)} USD`,
            details: {
              action: 'TARGET_BUY',
              tokenAmount: sig.tokenAmount,
              usdAmount: sig.usdAmount,
              solAmount: sig.solAmount,
              priceUsd: sig.priceUsd,
              remainingHolding: sig.remainingHolding,
              txHash: sig.txHash,
              solscanUrl: sig.txHash ? `https://solscan.io/tx/${sig.txHash}` : null
            }
          });
        }

        // Step B: Bot Buy & API Route / Submit
        const isSim = type.includes('SIMULATION') || !isAutoBuy;
        steps.push({
          timestamp: at,
          timeWib,
          tag: isSim ? '⚪ BOT BUY (SIMULASI SWAP)' : '🟢 BOT BUY (HIT API NYATA)',
          badgeClass: isSim ? 'badge-sim' : 'badge-real-buy',
          title: isSim ? `Verifikasi Swap Rute AMM (${reason || 'ENTRY_1'})` : `Kirim Order Buy GMGN API (${reason || 'ENTRY_1'})`,
          description: `Modal: $${(trade.investedUsd || 5).toFixed(2)} USD | Exchange: ${route.exchange || 'Raydium/Meteora'} | Latency: ${route.latencyMs ?? '-'}ms | Status: ${route.ok ? '200 OK' : 'ROUTE FAIL'}`,
          details: {
            action: 'BOT_BUY',
            mode: isSim ? 'SIMULATION' : 'REAL_API_HIT',
            reason: reason || 'ENTRY_1',
            stakeUsd: trade.investedUsd || 5.0,
            routeStatus: route.status,
            routeOk: route.ok,
            latencyMs: route.latencyMs,
            exchange: route.exchange,
            submitStatus: submit?.status,
            submitOk: submit?.ok,
            orderId: submit?.orderId,
            hash: submit?.hash,
            solscanUrl: submit?.hash ? `https://solscan.io/tx/${submit.hash}` : null,
            error: submit?.error || route.error || null
          }
        });

        // Step C: On-chain Verification (jika ada post buy verify)
        if (item.details?.onChain || type.includes('POST_BUY_VERIFIED')) {
          const oc = item.details?.onChain || {};
          steps.push({
            timestamp: at + 2000,
            timeWib: formatWib(at + 2000),
            tag: '🔍 ON-CHAIN BALANCE VERIFIED',
            badgeClass: 'badge-onchain',
            title: 'Verifikasi Saldo On-Chain RPC',
            description: `Saldo aktual terkonfirmasi masuk di ATA: ${(oc.actualTokens || oc.uiAmount || 0).toLocaleString()} tokens (${oc.actualBaseUnits || oc.amount || '-'} base units)`,
            details: oc
          });
        }
      }

      // 2. Event Jual
      else if (type.includes('SELL')) {
        // Step A: Target Sell
        if (sig.action === 'sell') {
          steps.push({
            timestamp: at - 500,
            timeWib: formatWib(at - 500),
            tag: '🎯 TARGET SELL',
            badgeClass: 'badge-target-sell',
            title: `Target Wallet Jual Sebagian/Semua`,
            description: `Target menjual ${(sig.tokenAmount || 0).toLocaleString()} token (~$${(sig.usdAmount || 0).toFixed(2)} USD). Sisa holding target: ${(sig.remainingHolding || 0).toLocaleString()} token`,
            details: {
              action: 'TARGET_SELL',
              tokenAmount: sig.tokenAmount,
              usdAmount: sig.usdAmount,
              solAmount: sig.solAmount,
              priceUsd: sig.priceUsd,
              remainingHolding: sig.remainingHolding,
              txHash: sig.txHash,
              solscanUrl: sig.txHash ? `https://solscan.io/tx/${sig.txHash}` : null
            }
          });
        }

        // Step B: Bot Sell & API Route / Submit
        const isSim = type.includes('SIMULATION') || !isAutoBuy;
        steps.push({
          timestamp: at,
          timeWib,
          tag: isSim ? '⚪ BOT SELL (SIMULASI SWAP)' : '🔴 BOT SELL (HIT API NYATA)',
          badgeClass: isSim ? 'badge-sim' : 'badge-real-sell',
          title: `Eksekusi Sell: ${reason || trade.exitReason}`,
          description: `Alasan Trigger: ${reason || trade.exitReason} | Exchange: ${route.exchange || 'Raydium/Meteora'} | Latency: ${route.latencyMs ?? '-'}ms`,
          details: {
            action: 'BOT_SELL',
            mode: isSim ? 'SIMULATION' : 'REAL_API_HIT',
            reason: reason || trade.exitReason,
            routeStatus: route.status,
            routeOk: route.ok,
            latencyMs: route.latencyMs,
            exchange: route.exchange,
            submitStatus: submit?.status,
            submitOk: submit?.ok,
            orderId: submit?.orderId,
            hash: submit?.hash,
            solscanUrl: submit?.hash ? `https://solscan.io/tx/${submit.hash}` : null,
            error: submit?.error || route.error || null
          }
        });
      }

      // 3. Rent Reclaim Event
      else if (type.includes('RENT_RECLAIM')) {
        steps.push({
          timestamp: at,
          timeWib,
          tag: '♻️ RENT RECLAIM SOL',
          badgeClass: 'badge-reclaim',
          title: 'Auto-Reclaim Rent SOL Berhasil',
          description: `Akun token ATA yang kosong ditutup. Rent SOL +${(item.details?.reclaimedSol || 0.002).toFixed(6)} SOL ditarik kembali ke dompet.`,
          details: item.details
        });
      }
    }

    // Jika tidak ada ledger entry untuk trade ini (misal trade lampau sebelum ledger baru):
    // generate langkah fallback dari record dry-run agar data detik demi detik tetap lengkap
    if (steps.length === 0 && trade.openedAt) {
      steps.push({
        timestamp: trade.openedAt,
        timeWib: formatWib(trade.openedAt),
        tag: '🎯 TARGET & BOT BUY',
        badgeClass: 'badge-target-buy',
        title: `Target Mulai Beli Token Baru (Ground-Zero)`,
        description: `Bot ikut membeli 1x entry senilai $${trade.investedUsd.toFixed(2)} USD mengikuti trigger Skenario.`,
        details: { action: 'BUY', investedUsd: trade.investedUsd, openedAt: trade.openedAt }
      });
      if (trade.closedAt) {
        steps.push({
          timestamp: trade.closedAt,
          timeWib: formatWib(trade.closedAt),
          tag: trade.isWin ? '🟢 BOT SELL (TAKE PROFIT)' : '🔴 BOT SELL (STOP/FALLBACK)',
          badgeClass: trade.isWin ? 'badge-real-buy' : 'badge-real-sell',
          title: `Exit: ${trade.exitReason}`,
          description: `Posisi ditutup. Hasil Realized PnL: ${trade.realizedPnlUsd >= 0 ? '+' : ''}$${trade.realizedPnlUsd.toFixed(2)} USD (${trade.roiPct >= 0 ? '+' : ''}${trade.roiPct.toFixed(1)}%).`,
          details: { action: 'SELL', pnlUsd: trade.realizedPnlUsd, roiPct: trade.roiPct, exitReason: trade.exitReason }
        });
      }
    }

    return {
      ...trade,
      openedAtWib: formatWib(trade.openedAt),
      closedAtWib: formatWib(trade.closedAt),
      durationSec: trade.closedAt && trade.openedAt ? Math.round((trade.closedAt - trade.openedAt) / 1000) : null,
      solscanUrl: `https://solscan.io/token/${trade.mint}`,
      gmgnUrl: `https://gmgn.ai/sol/token/${trade.mint}`,
      steps
    };
  });

  return {
    ok: true,
    scenarioKey: normKey,
    scenarioId: scId,
    scenarioName: scName,
    totalTrades: enrichedTrades.length,
    wins: sData.wins || 0,
    losses: sData.losses || 0,
    realizedPnl: sData.realizedPnl || 0,
    availableCash: sData.availableCash || 0,
    trades: enrichedTrades
  };
}
