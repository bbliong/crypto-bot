import { DistributionProfit4Runtime, type Transfer } from '../src/distribution-profit4-runtime.js';
import type { TargetTrade } from '../src/distribution-target-lane.js';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

async function main() {
  const now = Date.now();
  const thirtyMinutesAgo = now - 30 * 60 * 1000;
  console.log(`[SIMULATION] Starting replay for window: ${new Date(thirtyMinutesAgo).toLocaleTimeString('id-ID')} - ${new Date(now).toLocaleTimeString('id-ID')} WIB`);

  const simDir = path.resolve('/home/bbliong/project/crypto-bot/data/simulation-30m');
  fs.mkdirSync(simDir, { recursive: true });

  const runtime = new DistributionProfit4Runtime(
    simDir,
    () => {}, // No-op event writer
    simDir,
    'bounce' // 'bounce' executes ALL lanes: Momentum (12), Syndicate (13), Smart Money (2)
  );

  // 1. Gather all chunks covering the last 30 minutes
  const masterRunDir = '/home/bbliong/project/crypto-bot/data/profit4-watch/2026-10-19T09-59-29-955Z';
  const chunkFolders = [
    '2026-10-19T17-00-00-000-WIB',
    '2026-10-19T17-30-00-000-WIB'
  ];

  type SimEvent = 
    | { type: 'TRANSFER'; at: number; transfer: Transfer }
    | { type: 'TRADE'; at: number; mint: string; trade: TargetTrade };

  const events: SimEvent[] = [];
  const registeredMints = new Set<string>();

  // Collect transfers
  for (const f of chunkFolders) {
    const tPath = path.join(masterRunDir, 'chunks', f, 'transfers.jsonl');
    if (fs.existsSync(tPath)) {
      const lines = fs.readFileSync(tPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          const at = d.observedAt || (d.timestamp ? d.timestamp * 1000 : 0);
          if (at >= thirtyMinutesAgo) {
            events.push({
              type: 'TRANSFER',
              at,
              transfer: {
                mint: d.mint,
                wallet: d.wallet,
                symbol: d.symbol || 'SYNDICATE',
                timestamp: d.timestamp || Math.floor(at / 1000),
                from: d.from || d.wallet,
                source: d.source || 'syndicate_inflow',
                priceUsd: d.priceUsd || 0.000004,
                syndicateWalletsCount: d.syndicateWalletsCount,
                syndicateTier: d.syndicateTier,
              }
            });
            registeredMints.add(d.mint);
          }
        } catch {}
      }
    }
  }

  // Also collect discovered candidates from watch-events.jsonl
  for (const f of chunkFolders) {
    const wPath = path.join(masterRunDir, 'chunks', f, 'watch-events.jsonl');
    if (fs.existsSync(wPath)) {
      const lines = fs.readFileSync(wPath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          const at = d.observedAt || 0;
          if (at >= thirtyMinutesAgo && d.type === 'TARGET_TOKEN_REGISTERED') {
            if (!registeredMints.has(d.mint)) {
              events.push({
                type: 'TRANSFER',
                at,
                transfer: {
                  mint: d.mint,
                  wallet: d.wallet || 'creator',
                  symbol: d.symbol || 'UNKNOWN',
                  timestamp: Math.floor(at / 1000),
                  from: d.wallet || 'creator',
                  source: d.source || 'gmgn_research_ws',
                  priceUsd: d.priceUsd || 0.000004,
                }
              });
              registeredMints.add(d.mint);
            }
          }
        } catch {}
      }
    }
  }

  // Also collect from master state positions that were registered in this window
  const statePath = path.join(masterRunDir, 'profit4-state.json');
  if (fs.existsSync(statePath)) {
    const stateData = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    for (const p of stateData.positions || []) {
      const at = p.registeredAt || (p.timestamp ? p.timestamp * 1000 : 0);
      if (at >= thirtyMinutesAgo && p.mint && !registeredMints.has(p.mint)) {
        events.push({
          type: 'TRANSFER',
          at,
          transfer: {
            mint: p.mint,
            wallet: p.wallet || 'creator',
            symbol: p.symbol || 'TOKEN',
            timestamp: p.timestamp || Math.floor(at / 1000),
            from: p.from || p.wallet || 'creator',
            source: p.source || 'gmgn_research_ws',
            priceUsd: p.priceUsd || 0.000004,
            marketCapUsd: p.marketCapUsd,
          }
        });
        registeredMints.add(p.mint);
      }
    }
  }

  console.log(`[SIMULATION] Collected ${events.length} candidates/transfers across last 30 minutes.`);

  // Collect trades
  let tradeCount = 0;
  for (const f of chunkFolders) {
    const tradePath = path.join(masterRunDir, 'chunks', f, 'token-trades.jsonl');
    if (fs.existsSync(tradePath)) {
      const lines = fs.readFileSync(tradePath, 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line);
          const at = t.observedAt || t.at || (t.timestamp ? t.timestamp * 1000 : 0);
          if (at >= thirtyMinutesAgo) {
            events.push({
              type: 'TRADE',
              at,
              mint: t.mint,
              trade: {
                at,
                timestamp: t.timestamp || Math.floor(at / 1000),
                price: t.price,
                side: t.side,
                wallet: t.wallet || 'trader',
                usd: t.usd || 10,
                signature: t.signature || 'sig',
              }
            });
            tradeCount++;
          }
        } catch {}
      }
    }
  }

  console.log(`[SIMULATION] Collected ${tradeCount} trades in the last 30 minutes. Sorting event stream...`);

  // Sort events chronologically
  events.sort((a, b) => a.at - b.at);

  console.log(`[SIMULATION] Replaying ${events.length} chronological events through all lanes...`);

  let lastEvalAt = events.length > 0 ? events[0].at : thirtyMinutesAgo;
  let processed = 0;

  for (const ev of events) {
    if (ev.at - lastEvalAt >= 2000) {
      runtime.evaluate(ev.at);
      lastEvalAt = ev.at;
    }
    if (ev.type === 'TRANSFER') {
      runtime.register(ev.transfer, ev.at);
    } else {
      runtime.trade(ev.mint, ev.trade);
    }
    processed++;
    if (processed % 10000 === 0) {
      console.log(`[SIMULATION] Processed ${processed} / ${events.length} events...`);
    }
  }

  // Final evaluation
  runtime.evaluate(now);
  console.log(`[SIMULATION] Replay complete! Aggregating lane metrics...`);

  const simStatePath = path.join(simDir, 'profit4-state.json');
  let positions: any[] = [];
  if (fs.existsSync(simStatePath)) {
    const simState = JSON.parse(fs.readFileSync(simStatePath, 'utf-8'));
    positions = simState.positions || [];
  }
  console.log(`[SIMULATION] Total positions evaluated: ${positions.length}`);

  // Per-lane breakdown
  const laneStats = new Map<string, {
    group: string;
    lane: string;
    watched: number;
    open: number;
    closed: number;
    win: number;
    loss: number;
    pnlUsd: number;
    targetPercent: number;
  }>();

  for (const p of positions) {
    const lane = p.laneLabel || 'unknown';
    const group = ['V1','V2','V3','V4','V5','V6','V7','S1','S2','S3','S4','S1.2','S5'].includes(lane)
      ? 'syndicate'
      : ['G2','G2.1','G2.2','OZ1'].includes(lane)
      ? 'smartmoney'
      : 'momentum';

    if (!laneStats.has(lane)) {
      laneStats.set(lane, {
        group,
        lane,
        watched: 0,
        open: 0,
        closed: 0,
        win: 0,
        loss: 0,
        pnlUsd: 0,
        targetPercent: p.targetPercent || 35,
      });
    }

    const st = laneStats.get(lane)!;
    st.watched++;

    if (p.phase === 'OPEN' || p.phase === 'ENTRY_PENDING') {
      st.open++;
    } else if (p.phase === 'CLOSED' || p.phase === 'EXIT_SUBMITTED' || p.phase === 'EXITED') {
      st.closed++;
      const pnl = p.pnlUsd || 0;
      st.pnlUsd += pnl;
      if (pnl > 0 || (p.netReturnPercent && p.netReturnPercent > 0)) {
        st.win++;
      } else {
        st.loss++;
      }
    }
  }

  // Format and print report
  const sortedLanes = [...laneStats.values()].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return b.pnlUsd - a.pnlUsd;
  });

  const report = {
    simulationWindow: {
      fromWib: new Date(thirtyMinutesAgo).toLocaleTimeString('id-ID'),
      toWib: new Date(now).toLocaleTimeString('id-ID'),
      durationMinutes: 30,
      totalEvents: events.length,
      totalTrades: tradeCount,
      totalMints: registeredMints.size,
    },
    lanes: sortedLanes.map(l => ({
      group: l.group,
      lane: l.lane,
      watched: l.watched,
      open: l.open,
      closed: l.closed,
      win: l.win,
      loss: l.loss,
      winRate: l.closed > 0 ? Number((l.win / l.closed * 100).toFixed(1)) : 0,
      pnlUsd: Number(l.pnlUsd.toFixed(2)),
    })),
    groupTotals: {
      momentum: aggregateGroup(sortedLanes.filter(l => l.group === 'momentum')),
      syndicate: aggregateGroup(sortedLanes.filter(l => l.group === 'syndicate')),
      smartmoney: aggregateGroup(sortedLanes.filter(l => l.group === 'smartmoney')),
    }
  };

  fs.writeFileSync(path.join(simDir, 'simulation-30m-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

function aggregateGroup(lanes: any[]) {
  const closed = lanes.reduce((acc, l) => acc + l.closed, 0);
  const win = lanes.reduce((acc, l) => acc + l.win, 0);
  const loss = lanes.reduce((acc, l) => acc + l.loss, 0);
  const open = lanes.reduce((acc, l) => acc + l.open, 0);
  const watched = lanes.reduce((acc, l) => acc + l.watched, 0);
  const pnlUsd = lanes.reduce((acc, l) => acc + l.pnlUsd, 0);
  return {
    watched,
    open,
    closed,
    win,
    loss,
    winRate: closed > 0 ? Number((win / closed * 100).toFixed(1)) : 0,
    pnlUsd: Number(pnlUsd.toFixed(2)),
  };
}

main().catch(err => {
  console.error('[SIMULATION] Error:', err);
  process.exit(1);
});
