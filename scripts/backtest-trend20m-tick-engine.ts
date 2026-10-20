import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Runtime, Transfer } from '../src/distribution-profit4-runtime.js';
import type { TargetTrade } from '../src/distribution-target-lane.js';

interface BacktestEvent {
  timestamp: number;
  type: 'CANDIDATE' | 'TRADE_TICK' | 'EVALUATE';
  mint?: string;
  transfer?: Transfer;
  trade?: TargetTrade;
}

const PROJECT_DIR = '/home/bbliong/project/crypto-bot';
const SANDBOX_DIR = join(PROJECT_DIR, 'data', 'backtest-trend20m-v2');
const STATE_FILE = join(PROJECT_DIR, 'data/trend20m-watch/2026-10-19T17-55-44-970Z/profit4-state.json');
const TRADE_CHUNKS_DIR = join(PROJECT_DIR, 'data/profit4-watch/2026-10-19T17-55-39-920Z/chunks');

function prepareSandbox(): void {
  if (existsSync(SANDBOX_DIR)) {
    rmSync(SANDBOX_DIR, { recursive: true, force: true });
  }
  mkdirSync(SANDBOX_DIR, { recursive: true });
  writeFileSync(
    join(SANDBOX_DIR, 'bought-mints.json'),
    JSON.stringify({ updatedAt: Date.now(), mints: [] }, null, 2)
  );
}

function loadEvents(): BacktestEvent[] {
  console.log('[1/4] Memuat data kandidat dan trade ticks historical...');
  const events: BacktestEvent[] = [];

  // 1. Muat kandidat GMGN Trend dari profit4-state.json
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    const positions = raw.positions || [];
    for (const p of positions) {
      if (!p.mint) continue;
      const ts = (p.timestamp ? p.timestamp * 1000 : p.entryAt) || 1792432560000;
      const transfer: Transfer = {
        mint: p.mint,
        wallet: p.wallet || 'gmgn_trend',
        symbol: p.symbol || 'GMGN_TREND',
        timestamp: Math.floor(ts / 1000),
        from: p.from || 'gmgn_trend',
        source: 'gmgn_trend_ws',
        priceUsd: p.priceUsd > 0.000004 ? p.priceUsd : (p.entryPrice || 0.000015),
      };

      events.push({
        timestamp: ts,
        type: 'CANDIDATE',
        mint: p.mint,
        transfer,
      });

      // Jika ada entryPrice asli yang valid (> 0.000004), buat trade tick inisial
      if (p.entryPrice && p.entryPrice > 0.000004) {
        events.push({
          timestamp: ts + 100,
          type: 'TRADE_TICK',
          mint: p.mint,
          trade: {
            at: ts + 100,
            timestamp: Math.floor((ts + 100) / 1000),
            price: p.entryPrice,
            side: 'buy',
            wallet: 'trader_initial',
            usd: 50,
            signature: `init_${p.mint.slice(0, 8)}`,
          },
        });
      }

      // Jika ada peakPrice valid (> entryPrice), buat peak trade tick
      const peak = p.facts?.peakPrice;
      if (peak && peak > (p.entryPrice || 0) && peak > 0.000004) {
        const peakAt = ts + 60_000; // Sekitar 1 menit setelah transfer
        events.push({
          timestamp: peakAt,
          type: 'TRADE_TICK',
          mint: p.mint,
          trade: {
            at: peakAt,
            timestamp: Math.floor(peakAt / 1000),
            price: peak,
            side: 'buy',
            wallet: 'trader_peak',
            usd: 100,
            signature: `peak_${p.mint.slice(0, 8)}`,
          },
        });
      }

      // Jika ada exitPrice asli dan bukan 0.000004
      if (p.exitPrice && p.exitPrice > 0.000004 && p.exitAt) {
        events.push({
          timestamp: p.exitAt,
          type: 'TRADE_TICK',
          mint: p.mint,
          trade: {
            at: p.exitAt,
            timestamp: Math.floor(p.exitAt / 1000),
            price: p.exitPrice,
            side: 'sell',
            wallet: 'trader_exit',
            usd: 25,
            signature: `exit_${p.mint.slice(0, 8)}`,
          },
        });
      }
    }
    console.log(`-> Dimuat ${positions.length} kandidat dari trend20m state.`);
  }

  // 2. Muat trade ticks dari file token-trades.jsonl di profit4-watch chunks
  if (existsSync(TRADE_CHUNKS_DIR)) {
    const chunks = readdirSync(TRADE_CHUNKS_DIR);
    let realTradesCount = 0;
    for (const c of chunks) {
      const p = join(TRADE_CHUNKS_DIR, c, 'token-trades.jsonl');
      if (!existsSync(p)) continue;
      const lines = readFileSync(p, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line);
          const price = Number(t.price);
          const at = Number(t.observedAt || t.at);
          // Abaikan fake tick 0.000004
          if (t.mint && price > 0.000004 && at > 0) {
            events.push({
              timestamp: at,
              type: 'TRADE_TICK',
              mint: t.mint,
              trade: {
                at,
                timestamp: Math.floor(at / 1000),
                price,
                side: t.side === 'sell' ? 'sell' : 'buy',
                wallet: t.wallet || 'trader',
                usd: Number(t.usd || 25),
                signature: t.signature || `sig_${at}`,
              },
            });
            realTradesCount++;
          }
        } catch {}
      }
    }
    console.log(`-> Dimuat ${realTradesCount} real market trades dari chunks.`);
  }

  return events;
}

function runBacktest(): void {
  prepareSandbox();
  const events = loadEvents();

  console.log('[2/4] Mengurutkan event queue secara kronologis (tick-by-tick)...');
  events.sort((a, b) => a.timestamp - b.timestamp);

  if (events.length === 0) {
    console.log('Tidak ada event untuk di-backtest.');
    return;
  }

  const startTime = events[0].timestamp;
  const endTime = events[events.length - 1].timestamp;
  console.log(`-> Rentang waktu: ${new Date(startTime).toLocaleString('id-ID')} s.d ${new Date(endTime).toLocaleString('id-ID')}`);
  console.log(`-> Total event queue: ${events.length} events.`);

  console.log('[3/4] Menjalankan Event-Driven Replay Backtest Engine...');
  const writtenRecords: any[] = [];
  const writer = (name: string, val: any) => {
    writtenRecords.push({ name, val });
  };

  const runtime = new DistributionProfit4Runtime(SANDBOX_DIR, writer, SANDBOX_DIR, 'trend20m');

  let lastEvalAt = startTime;
  let processedCount = 0;
  const totalEvents = events.length;

  for (const ev of events) {
    processedCount++;
    if (processedCount % 20000 === 0) {
      process.stdout.write(`   Proses: ${(processedCount / totalEvents * 100).toFixed(1)}% (${processedCount}/${totalEvents})\r`);
    }

    // Jalankan evaluate berkala setiap 1000ms
    while (ev.timestamp - lastEvalAt >= 1000) {
      lastEvalAt += 1000;
      runtime.evaluate(lastEvalAt);
    }

    if (ev.type === 'CANDIDATE' && ev.transfer) {
      runtime.register(ev.transfer, ev.timestamp);
    } else if (ev.type === 'TRADE_TICK' && ev.mint && ev.trade) {
      runtime.trade(ev.mint, ev.trade);
    }
  }

  // Final step
  runtime.evaluate(endTime + 5000);
  console.log('\n[4/4] Simulasi selesai. Menganalisis hasil backtest real case...');

  // Analisis hasil
  const stateFile = join(SANDBOX_DIR, 'profit4-state.json');
  let finalPositions: any[] = [];
  if (existsSync(stateFile)) {
    const s = JSON.parse(readFileSync(stateFile, 'utf8'));
    finalPositions = s.positions || [];
  }

  const entered = finalPositions.filter((p: any) => p.entryAt !== null);
  const closed = entered.filter((p: any) => p.phase === 'CLOSED');
  const openPos = entered.filter((p: any) => p.phase === 'OPEN');

  const wins = closed.filter((p: any) => (p.netReturnPercent || 0) > 0);
  const losses = closed.filter((p: any) => (p.netReturnPercent || 0) <= 0);

  const winRate = closed.length > 0 ? (wins.length / closed.length) * 100 : 0;
  const totalPnl = closed.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);

  const grossWin = wins.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);
  const grossLoss = Math.abs(losses.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

  const reasons: Record<string, number> = {};
  for (const p of closed) {
    const r = p.lastEvent?.reason || 'UNKNOWN';
    reasons[r] = (reasons[r] || 0) + 1;
  }

  console.log('\n' + '='.repeat(80));
  console.log('=== HASIL BACKTEST EVENT-DRIVEN WEBSOCKET REPLAY (REAL CASE) ===');
  console.log('='.repeat(80));
  console.log(`Total kandidat diregister  : ${finalPositions.length}`);
  console.log(`Total posisi entry trade   : ${entered.length}`);
  console.log(`Posisi selesai (closed)    : ${closed.length} (Masih OPEN: ${openPos.length})`);
  console.log(`Menang (Wins)              : ${wins.length}`);
  console.log(`Kalah (Losses)             : ${losses.length}`);
  console.log(`WIN RATE                   : ${winRate.toFixed(1)}%`);
  console.log(`TOTAL PnL USD (Stake $5)   : $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);
  console.log(`PROFIT FACTOR              : ${profitFactor.toFixed(2)}`);
  console.log(`Gross Profit               : +$${grossWin.toFixed(2)}`);
  console.log(`Gross Loss                 : -$${grossLoss.toFixed(2)}`);

  console.log('\nBreakdown Exit Reasons:');
  for (const [r, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${r.padEnd(30)}: ${count} (${(count / closed.length * 100).toFixed(1)}%)`);
  }

  console.log('\nContoh 5 Posisi Pemenang:');
  wins.slice(0, 5).forEach((w: any, idx: number) => {
    const holdSec = w.entryAt && w.exitAt ? ((w.exitAt - w.entryAt) / 1000).toFixed(0) : 'N/A';
    console.log(`  [#${idx + 1}] ${w.mint.slice(0, 8)}... | Net: +${w.netReturnPercent.toFixed(1)}% | PnL: +$${w.pnlUsd.toFixed(2)} | Reason: ${w.lastEvent?.reason} | Hold: ${holdSec}s`);
  });

  console.log('='.repeat(80));
}

runBacktest();
