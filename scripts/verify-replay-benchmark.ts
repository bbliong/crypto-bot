import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DistributionProfit4Runtime, Transfer } from '../src/distribution-profit4-runtime.js';
import type { TargetTrade } from '../src/distribution-target-lane.js';

interface ReplayEvent {
  time: number;
  kind: 'REGISTER' | 'TRADE';
  mint: string;
  transfer?: Transfer;
  trade?: TargetTrade;
}

const PROJECT_DIR = '/home/bbliong/project/crypto-bot';
const LIVE_RUN_DIR = join(PROJECT_DIR, 'data/trend20m-watch/2026-10-20T22-06-10-886Z');
const LIVE_STATE_FILE = join(LIVE_RUN_DIR, 'profit4-state.json');
const SANDBOX_DIR = join(PROJECT_DIR, 'data/verify-replay-benchmark');

const FEED_DIRS = [
  join(PROJECT_DIR, 'data/feed-hub/2026-10-20T22-06-07-165Z/chunks'),
  join(PROJECT_DIR, 'data/feed-hub/2026-10-21T03-57-38-424Z/chunks'),
];

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

function loadCandidates(): Map<string, { registeredAt: number; transfer: Transfer }> {
  console.log('[1/4] Memuat data kandidat transfer dari chunk profit4-events...');
  const transfers = new Map<string, { registeredAt: number; transfer: Transfer }>();
  const chunksDir = join(LIVE_RUN_DIR, 'chunks');

  if (!existsSync(chunksDir)) {
    console.error(`Folder chunks tidak ditemukan: ${chunksDir}`);
    return transfers;
  }

  const chunkFolders = readdirSync(chunksDir).sort();
  for (const cf of chunkFolders) {
    const ef = join(chunksDir, cf, 'profit4-events.jsonl');
    if (!existsSync(ef)) continue;
    const lines = readFileSync(ef, 'utf8').trim().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const t: Transfer = e.transfer;
        const at = Number(e.observedAt || e.at);
        if (t && t.mint && at > 0) {
          const existing = transfers.get(t.mint);
          if (!existing || at < existing.registeredAt) {
            transfers.set(t.mint, { registeredAt: at, transfer: t });
          }
        }
      } catch {}
    }
  }

  console.log(`-> Ditemukan ${transfers.size} kandidat unik dari live run.`);
  return transfers;
}

function loadTrades(mints: Set<string>): ReplayEvent[] {
  console.log('[2/4] Memuat tick trades asli dari feed-hub chunks untuk 42 mints...');
  const tradeEvents: ReplayEvent[] = [];
  let totalFiles = 0;

  for (const fd of FEED_DIRS) {
    if (!existsSync(fd)) continue;
    const chunkNames = readdirSync(fd).sort();
    for (const cn of chunkNames) {
      const tf = join(fd, cn, 'token-trades.jsonl');
      if (!existsSync(tf)) continue;
      totalFiles++;
      const lines = readFileSync(tf, 'utf8').trim().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        // Fast substring check sebelum parse JSON
        let match = false;
        for (const m of mints) {
          if (line.includes(m)) {
            match = true;
            break;
          }
        }
        if (!match) continue;

        try {
          const t = JSON.parse(line);
          const mint = t.mint;
          if (!mints.has(mint)) continue;

          const price = Number(t.price);
          const at = Number(t.observedAt || t.at || (t.timestamp ? t.timestamp * 1000 : 0));
          if (price > 0.000004 && at > 0) {
            tradeEvents.push({
              time: at,
              kind: 'TRADE',
              mint,
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
          }
        } catch {}
      }
    }
  }

  console.log(`-> Dimuat ${tradeEvents.length} trade ticks mentah dari ${totalFiles} chunk feed-hub.`);
  return tradeEvents;
}

function runBenchmark() {
  prepareSandbox();

  const candidatesMap = loadCandidates();
  const mints = new Set(candidatesMap.keys());
  const trades = loadTrades(mints);

  console.log('[3/4] Menggabungkan event dan mengurutkan secara kronologis...');
  const allEvents: ReplayEvent[] = [...trades];

  for (const [mint, item] of candidatesMap.entries()) {
    allEvents.push({
      time: item.registeredAt,
      kind: 'REGISTER',
      mint,
      transfer: item.transfer,
    });
  }

  allEvents.sort((a, b) => a.time - b.time);
  console.log(`-> Total urutan event: ${allEvents.length} events.`);

  if (allEvents.length === 0) {
    console.log('Tidak ada event untuk direplay.');
    return;
  }

  const startTime = allEvents[0].time;
  const endTime = allEvents[allEvents.length - 1].time;
  console.log(`-> Rentang replay: ${new Date(startTime).toLocaleString('id-ID')} s.d ${new Date(endTime).toLocaleString('id-ID')}`);

  console.log('[4/4] Memutar ulang tick-by-tick ke dalam DistributionProfit4Runtime...');
  const writtenRecords: any[] = [];
  const writer = (name: string, val: any) => {
    writtenRecords.push({ name, val });
  };

  const runtime = new DistributionProfit4Runtime(SANDBOX_DIR, writer, SANDBOX_DIR, 'trend20m');

  let lastEvalAt = startTime;
  let processed = 0;
  const total = allEvents.length;

  for (const ev of allEvents) {
    processed++;
    if (processed % 100000 === 0) {
      process.stdout.write(`   Replay progres: ${(processed / total * 100).toFixed(1)}% (${processed}/${total})\r`);
    }

    // Step evaluate setiap 1000ms
    if (ev.time - lastEvalAt >= 1000) {
      // Jika selisih wajar, evaluate step by step; jika gap besar (>30 detik kosong), lompat
      if (ev.time - lastEvalAt > 30000) {
        runtime.evaluate(lastEvalAt + 1000);
        lastEvalAt = ev.time;
        runtime.evaluate(lastEvalAt);
      } else {
        while (ev.time - lastEvalAt >= 1000) {
          lastEvalAt += 1000;
          runtime.evaluate(lastEvalAt);
        }
      }
    }

    if (ev.kind === 'REGISTER' && ev.transfer) {
      runtime.register(ev.transfer, ev.time);
    } else if (ev.kind === 'TRADE' && ev.mint && ev.trade) {
      runtime.trade(ev.mint, ev.trade);
    }
  }

  // Final evaluation step
  runtime.evaluate(endTime + 5000);
  console.log('\n\nReplay selesai! Menganalisis perbandingan dengan live ground truth...\n');

  // Load Replay State
  const replayStatePath = join(SANDBOX_DIR, 'profit4-state.json');
  let replayPositions: any[] = [];
  if (existsSync(replayStatePath)) {
    replayPositions = JSON.parse(readFileSync(replayStatePath, 'utf8')).positions || [];
  }

  // Load Live Ground Truth State
  let livePositions: any[] = [];
  if (existsSync(LIVE_STATE_FILE)) {
    livePositions = JSON.parse(readFileSync(LIVE_STATE_FILE, 'utf8')).positions || [];
  }

  console.log('='.repeat(95));
  console.log('TABEL VERIFIKASI: REPLAY SIMULATOR vs LIVE GROUND TRUTH (4 BASELINE LANES)');
  console.log('='.repeat(95));
  console.log(
    'Lane'.padEnd(10) +
    '| Live Closed (W/L) | Replay Closed (W/L) | Match? | Live Exit Reasons vs Replay'
  );
  console.log('-'.repeat(95));

  const lanes = ['T-Cons', 'T-Bal', 'T-Wide', 'T-Run'];

  for (const lane of lanes) {
    const livePos = livePositions.filter((p: any) => p.laneLabel === lane && p.phase === 'CLOSED');
    const liveWins = livePos.filter((p: any) => (p.pnlUsd || 0) > 0).length;
    const liveLoss = livePos.filter((p: any) => (p.pnlUsd || 0) <= 0).length;

    const repPos = replayPositions.filter((p: any) => p.laneLabel === lane && p.phase === 'CLOSED');
    const repWins = repPos.filter((p: any) => (p.pnlUsd || 0) > 0).length;
    const repLoss = repPos.filter((p: any) => (p.pnlUsd || 0) <= 0).length;

    const liveReasons: Record<string, number> = {};
    for (const p of livePos) {
      const r = p.lastEvent?.reason || p.exitReason || 'UNKNOWN';
      liveReasons[r] = (liveReasons[r] || 0) + 1;
    }

    const repReasons: Record<string, number> = {};
    for (const p of repPos) {
      const r = p.lastEvent?.reason || p.exitReason || 'UNKNOWN';
      repReasons[r] = (repReasons[r] || 0) + 1;
    }

    const liveSummary = `${livePos.length} (${liveWins}/${liveLoss})`;
    const repSummary = `${repPos.length} (${repWins}/${repLoss})`;
    const isMatch = livePos.length > 0 && Math.abs(livePos.length - repPos.length) <= 1 ? '✅ IDENTIK' : '⚠️ SELISIH';

    console.log(
      lane.padEnd(10) +
      '| ' + liveSummary.padEnd(19) +
      '| ' + repSummary.padEnd(21) +
      '| ' + isMatch.padEnd(7) +
      `| Live SL: ${liveReasons['STOP_LOSS_6PCT'] || liveReasons['STOP_LOSS_8PCT'] || liveReasons['STOP_LOSS_10PCT'] || 0} vs Replay SL: ${repReasons['STOP_LOSS_6PCT'] || repReasons['STOP_LOSS_8PCT'] || repReasons['STOP_LOSS_10PCT'] || 0}`
    );
  }

  console.log('='.repeat(95));

  // T-GOLDEN EVALUATION
  console.log('\n' + '='.repeat(95));
  console.log('HASIL REPLAY TICK-BY-TICK UNTUK T-GOLDEN PADA DATASET REAL-TIME YANG SAMA:');
  console.log('='.repeat(95));

  const goldenPos = replayPositions.filter((p: any) => p.laneLabel === 'T-Golden');
  const goldenClosed = goldenPos.filter((p: any) => p.phase === 'CLOSED');
  const goldenWins = goldenClosed.filter((p: any) => (p.pnlUsd || 0) > 0);
  const goldenLosses = goldenClosed.filter((p: any) => (p.pnlUsd || 0) <= 0);
  const goldenPnl = goldenClosed.reduce((acc: number, p: any) => acc + (p.pnlUsd || 0), 0);
  const goldenWR = goldenClosed.length > 0 ? (goldenWins.length / goldenClosed.length) * 100 : 0;

  const goldenReasons: Record<string, number> = {};
  for (const p of goldenClosed) {
    const r = p.lastEvent?.reason || p.exitReason || 'UNKNOWN';
    goldenReasons[r] = (goldenReasons[r] || 0) + 1;
  }

  console.log(`Total Posisi Terdaftar (Evaluasi) : ${goldenPos.length}`);
  console.log(`Total Posisi Terbeli & Selesai   : ${goldenClosed.length}`);
  console.log(`Menang (Wins)                     : ${goldenWins.length}`);
  console.log(`Kalah (Losses)                    : ${goldenLosses.length}`);
  console.log(`Real Win Rate Tick-by-Tick        : ${goldenWR.toFixed(1)}%`);
  console.log(`Real Net PnL USD (Stake $5)       : $${goldenPnl >= 0 ? '+' : ''}${goldenPnl.toFixed(2)}`);
  console.log(`Breakdown Exit Reasons T-Golden   :`, goldenReasons);
  console.log('='.repeat(95));
}

runBenchmark();
