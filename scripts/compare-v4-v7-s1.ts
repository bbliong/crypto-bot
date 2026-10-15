import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { TargetObservation } from '../src/distribution-target-lane.ts';
import { DistributionBounceLaneV4, DistributionBounceLaneV7, BOUNCE_RULES_V7 } from '../src/distribution-bounce-lane.ts';
import { DistributionStaircaseLaneS1, STAIRCASE_RULES_S1 } from '../src/distribution-staircase-lane.ts';

const CACHE_DIR = 'data/profit4-watch/cached-mints';
const ACTIVE_DIR = 'data/profit4-watch/active-mints';
const FEE_USD = 0.12;
const STAKE_USD = 5.0;

// Subclass for V7 Updated TP +35%
class DistributionBounceLaneV7Updated extends DistributionBounceLaneV7 {
  constructor(mint: string, emit: (event: any) => void = () => {}) {
    super(mint, emit);
    // override rules with cloned object
    (this as any).rules = { ...BOUNCE_RULES_V7, targetPercent: 35 };
  }
}

// Subclass for S1 Updated TP +40%
class DistributionStaircaseLaneS1Updated extends DistributionStaircaseLaneS1 {
  constructor(mint: string, emit: (event: any) => void = () => {}) {
    super(mint, emit);
    (this as any).rules = { ...STAIRCASE_RULES_S1, targetPercent: 40 };
  }
}

interface SimResult {
  mint: string;
  symbol: string;
  date: string;
  entered: boolean;
  net: number;
  pnl: number;
  reason: string;
  holdSeconds: number;
  maxGain: number;
  minDd: number;
}

async function loadFile(filePath: string) {
  const rows: any[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch (e) {}
  }
  rows.sort((a, b) => {
    const tA = a.at || a.observedAt || (a.timestamp ? a.timestamp * 1000 : 0);
    const tB = b.at || b.observedAt || (b.timestamp ? b.timestamp * 1000 : 0);
    return tA - tB;
  });
  return rows;
}

function runLaneSim(LaneClass: any, rows: any[], transferAt: number): SimResult {
  const obs = new TargetObservation(transferAt);
  const events: any[] = [];
  const lane = new LaneClass('mint', (e: any) => events.push(e));

  let lastStepAt = 0;
  for (const r of rows) {
    const now = r.at || r.observedAt || (r.timestamp ? r.timestamp * 1000 : 0);
    const tradeObj = r.trade || (r.price && r.side ? {
      at: now,
      timestamp: r.timestamp || Math.floor(now / 1000),
      wallet: r.wallet,
      price: r.price,
      usd: r.usd || 0,
      side: r.side
    } : null);

    if (tradeObj) {
      obs.trade(tradeObj);
      if ((lane as any).onTrade) (lane as any).onTrade(tradeObj);
    }
    if (r.holding && r.wallet) obs.holding(r.wallet, r.holding);
    if (r.count) obs.count(r.count);

    if (now - lastStepAt >= 1000) {
      lastStepAt = now;
      const facts = obs.facts(now, [], '');
      lane.step(facts);
      if (lane.phase === 'CLOSED') break;
    }
  }

  const buy = events.find(e => e.type === 'PAPER_BUY');
  const sell = events.find(e => e.type === 'PAPER_SELL');
  const lastDec = events.findLast(e => e.type === 'PAPER_ENTRY_DECISION');

  if (!buy) {
    return {
      mint: '',
      symbol: '',
      date: '',
      entered: false,
      net: 0,
      pnl: 0,
      reason: lastDec?.reasons?.[0] || 'NO_ENTRY',
      holdSeconds: 0,
      maxGain: 0,
      minDd: 0
    };
  }

  const net = sell?.netReturnPercent ?? 0;
  const pnl = (net / 100) * STAKE_USD - FEE_USD;
  const holdSeconds = (sell && buy && sell.observedAt && buy.observedAt)
    ? Math.round((sell.observedAt - buy.observedAt) / 1000)
    : (sell?.holdSeconds ?? 0);

  return {
    mint: '',
    symbol: '',
    date: '',
    entered: true,
    net: Number(net.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    reason: sell?.reason || 'OPEN',
    holdSeconds,
    maxGain: 0,
    minDd: 0
  };
}

async function main() {
  const allFiles = [
    ...fs.readdirSync(CACHE_DIR).map(f => path.join(CACHE_DIR, f)),
    ...fs.readdirSync(ACTIVE_DIR).map(f => path.join(ACTIVE_DIR, f))
  ].filter(f => f.endsWith('.jsonl'));

  console.log(`Analyzing ${allFiles.length} token files across V4, V7, and S1...`);

  const tokensData: any[] = [];
  for (const f of allFiles) {
    const rows = await loadFile(f);
    if (rows.length < 30) continue;
    const first = rows[0];
    const ts = first.timestamp || Math.floor((first.at || first.observedAt || 0) / 1000);
    const dateObj = new Date((ts + 7 * 3600) * 1000);
    const dateStr = dateObj.toISOString().slice(0, 10);
    const sym = first.trackedFrom?.symbol || path.basename(f).split('.')[0].slice(0, 8);
    const transferAt = (first.at || first.observedAt || ts * 1000) - 30000;

    tokensData.push({
      file: f,
      date: dateStr,
      symbol: sym,
      rows,
      transferAt
    });
  }

  const datasets = [
    { name: 'DATA 2 HARI TERAKHIR (13-14 OKTOBER 2026)', list: tokensData.filter(t => ['2026-10-13', '2026-10-14'].includes(t.date)) },
    { name: 'DATA KESELURUHAN (133 TOKEN HISTORIS)', list: tokensData }
  ];

  for (const ds of datasets) {
    console.log(`\n======================================================`);
    console.log(`ANALISIS: ${ds.name} (Total: ${ds.list.length} Token)`);
    console.log(`Modal: $${STAKE_USD}.00 USD | Fee Solana: $${FEE_USD} roundtrip`);
    console.log(`======================================================`);

    const lanes = [
      { id: 'Lane V4 (Syarat Dump >=60%, TP +35%, SL -12%)', cls: DistributionBounceLaneV4 },
      { id: 'Lane V7 Original (Syarat Dump >=28%, TP +22%, SL -8%)', cls: DistributionBounceLaneV7 },
      { id: 'Lane V7 UPDATE (Syarat Dump >=28%, TP +35%, SL -8%)', cls: DistributionBounceLaneV7Updated },
      { id: 'Lane S1 Original (Staircase Runner, TP +20%, SL -8%)', cls: DistributionStaircaseLaneS1 },
      { id: 'Lane S1 UPDATE (Staircase Runner, TP +40%, SL -8%)', cls: DistributionStaircaseLaneS1Updated },
    ];

    for (const l of lanes) {
      let enteredCount = 0;
      let wins = 0;
      let losses = 0;
      let totalPnl = 0;
      const details: string[] = [];

      for (const t of ds.list) {
        const res = runLaneSim(l.cls, t.rows, t.transferAt);
        if (res.entered) {
          enteredCount++;
          totalPnl += res.pnl;
          if (res.pnl > 0) wins++;
          else losses++;
          details.push(`    - ${t.symbol.padEnd(10)} (${t.date}): net ${res.net > 0 ? '+' : ''}${res.net}% | pnl $${res.pnl > 0 ? '+' : ''}${res.pnl.toFixed(2)} | reason: ${res.reason}`);
        }
      }

      const wr = enteredCount > 0 ? (wins / enteredCount) * 100 : 0;
      const ev = enteredCount > 0 ? totalPnl / enteredCount : 0;

      console.log(`\n🔹 ${l.id}:`);
      console.log(`   • Trades Sinyal : ${enteredCount} trade`);
      console.log(`   • Win / Loss    : ${wins} Win / ${losses} Loss (WR: ${wr.toFixed(1)}%)`);
      console.log(`   • Total Net PnL : $${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(2)} USD`);
      console.log(`   • EV per Trade  : $${ev > 0 ? '+' : ''}${ev.toFixed(2)} USD`);
      if (enteredCount <= 12 && enteredCount > 0) {
        console.log(`   • Rincian Trade :`);
        details.forEach(d => console.log(d));
      }
    }
  }
}

main().catch(console.error);
