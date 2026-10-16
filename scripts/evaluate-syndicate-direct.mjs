import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFileSync } from 'node:fs';

const AWS_PROFILE = 'do-tor1';
const S3_PREFIX = 's3://missi/crypto/profit4-chunks/';

// 1. Load exact syndicate mints from tx-cluster-cache.json
const cache = JSON.parse(readFileSync('/home/bbliong/project/crypto-bot/data/profit4-watch/tx-cluster-cache.json', 'utf8'));
const mintMap = new Map();

for (const [sig, item] of Object.entries(cache)) {
  if (item && item.mint && item.recipients && item.recipients.length >= 4) {
    if (!mintMap.has(item.mint)) {
      mintMap.set(item.mint, {
        mint: item.mint,
        symbol: item.symbol || 'UNKNOWN',
        firstAirdropTime: item.timestamp,
        wallets: new Set(item.recipients),
        deployer: item.from
      });
    } else {
      const m = mintMap.get(item.mint);
      if (item.timestamp < m.firstAirdropTime) m.firstAirdropTime = item.timestamp;
      for (const w of item.recipients) m.wallets.add(w);
    }
  }
}

const syndicateTokens = Array.from(mintMap.values()).map(m => ({
  mint: m.mint,
  symbol: m.symbol,
  firstAirdropTime: m.firstAirdropTime,
  walletCount: m.wallets.size,
  deployer: m.deployer
})).sort((a, b) => b.firstAirdropTime - a.firstAirdropTime);

// 2. Map tokens to S3 chunks based on timestamp
async function listS3Archives() {
  return new Promise((resolve, reject) => {
    const p = spawn('aws', ['--profile', AWS_PROFILE, 's3', 'ls', S3_PREFIX, '--recursive']);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', code => {
      if (code !== 0) return reject(new Error('Gagal list S3 chunks'));
      const archives = [];
      for (const line of out.trim().split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3].endsWith('.tar.gz')) {
          archives.push(parts[3]);
        }
      }
      resolve(archives);
    });
  });
}

// 3. Stream trades from a chunk
async function streamChunkTrades(chunkKey, targetMintsSet) {
  return new Promise((resolve) => {
    const aws = spawn('aws', ['--profile', AWS_PROFILE, 's3', 'cp', `s3://missi/${chunkKey}`, '-']);
    const tar = spawn('tar', ['-zx', '--wildcards', '*token-trades.jsonl', '-O']);
    aws.stdout.pipe(tar.stdin);

    const rl = readline.createInterface({ input: tar.stdout });
    const tradesByMint = new Map();
    for (const m of targetMintsSet) tradesByMint.set(m, []);

    rl.on('line', (line) => {
      if (!line) return;
      try {
        const tr = JSON.parse(line);
        const m = tr.mint || tr.a;
        if (m && targetMintsSet.has(m) && Number(tr.price) > 0) {
          tradesByMint.get(m).push({
            price: Number(tr.price),
            timestamp: Number(tr.timestamp || Math.floor((tr.at || tr.observedAt || Date.now()) / 1000)),
            side: tr.side || tr.e,
            usd: Number(tr.usd || tr.au || 0)
          });
        }
      } catch {}
    });

    tar.on('close', () => {
      aws.kill();
      resolve(tradesByMint);
    });
    aws.on('error', () => resolve(tradesByMint));
    tar.on('error', () => resolve(tradesByMint));
  });
}

export async function runDirectSyndicateEvaluation() {
  console.log(`🔍 Memuat ${syndicateTokens.length} koin sindikat dari database relasi...`);
  const s3Archives = await listS3Archives();
  console.log(`📦 Terdaftar ${s3Archives.length} arsip chunk di DigitalOcean Spaces.`);

  // Filter 25 token sindikat terbaru untuk dievaluasi
  const sampleTokens = syndicateTokens.slice(0, 25);

  const matchedChunks = new Map(); // chunkKey -> Set<mint>

  for (const token of sampleTokens) {
    const tSec = token.firstAirdropTime;
    const tokenDate = new Date(tSec * 1000);
    const dayStr = tokenDate.toISOString().slice(0, 10);

    for (const arch of s3Archives) {
      if (arch.includes(dayStr)) {
        if (!matchedChunks.has(arch)) matchedChunks.set(arch, new Set());
        matchedChunks.get(arch).add(token.mint);
      }
    }
  }

  console.log(`\n⚡ Memulai streaming ${matchedChunks.size} chunks relevan untuk 25 sampel sindikat...`);

  const collectedTrades = new Map(); // mint -> all trades
  for (const t of sampleTokens) collectedTrades.set(t.mint, []);

  for (const [chunkKey, mints] of matchedChunks.entries()) {
    process.stdout.write(`   Stream: ${chunkKey.split('/').pop()} (${mints.size} token)... `);
    const res = await streamChunkTrades(chunkKey, mints);
    let count = 0;
    for (const [m, trList] of res.entries()) {
      if (trList.length > 0) {
        collectedTrades.get(m).push(...trList);
        count += trList.length;
      }
    }
    console.log(`-> ${count} trades ditemukan.`);
  }

  // Analyze each token
  const evaluated = [];

  for (const token of sampleTokens) {
    const rawTrades = collectedTrades.get(token.mint) || [];
    if (rawTrades.length < 15) continue;

    // Deduplicate and sort trades
    rawTrades.sort((a, b) => a.timestamp - b.timestamp);
    const trades = [];
    const seen = new Set();
    for (const tr of rawTrades) {
      const k = `${tr.timestamp}:${tr.price}:${tr.usd}`;
      if (!seen.has(k)) {
        seen.add(k);
        trades.push(tr);
      }
    }

    const t0 = token.firstAirdropTime;
    // Trades after or near airdrop
    const postAirdrop = trades.filter(t => t.timestamp >= t0 - 60);
    const analysisTrades = postAirdrop.length >= 10 ? postAirdrop : trades;

    const initialPrice = analysisTrades[0].price;
    let peakPrice = initialPrice;
    let peakTime = analysisTrades[0].timestamp;

    // Find peak
    for (const t of analysisTrades) {
      if (t.price > peakPrice) {
        peakPrice = t.price;
        peakTime = t.timestamp;
      }
    }

    const timeToPeak = Math.max(0, peakTime - t0);

    // Find trough after peak
    let troughPrice = peakPrice;
    let troughTime = peakTime;
    for (const t of analysisTrades) {
      if (t.timestamp >= peakTime && t.price < troughPrice) {
        troughPrice = t.price;
        troughTime = t.timestamp;
      }
    }

    const dumpPct = peakPrice > 0 ? ((peakPrice - troughPrice) / peakPrice) * 100 : 0;
    const dumpDuration = Math.max(0, troughTime - peakTime);

    // Find bounce after trough
    let maxBouncePrice = troughPrice;
    let maxBounceTime = troughTime;
    for (const t of analysisTrades) {
      if (t.timestamp >= troughTime && t.price > maxBouncePrice) {
        maxBouncePrice = t.price;
        maxBounceTime = t.timestamp;
      }
    }

    const bouncePct = troughPrice > 0 ? ((maxBouncePrice - troughPrice) / troughPrice) * 100 : 0;
    const bounceDuration = Math.max(0, maxBounceTime - troughTime);

    // State machine simulation: Test various TP targets (+5%, +10%, +15%, +20%, +30%)
    let entryP = null;
    let entryTime = null;
    let simOutcome = 'NO_ENTRY';
    let maxGainAfterEntry = 0;
    let minGainAfterEntry = 0;
    let finalNetGain = 0;

    let rollHigh = initialPrice;
    let rollLow = initialPrice;
    let isDumped = false;

    for (const t of analysisTrades) {
      if (!entryP) {
        if (t.price > rollHigh) { rollHigh = t.price; rollLow = t.price; }
        if (t.price < rollLow) rollLow = t.price;

        const dd = rollHigh > 0 ? ((rollHigh - t.price) / rollHigh) * 100 : 0;
        if (dd >= 25) isDumped = true; // Minimum dump 25%

        const reb = rollLow > 0 ? ((t.price - rollLow) / rollLow) * 100 : 0;
        if (isDumped && reb >= 2.5) { // Rebound >= 2.5%
          entryP = t.price;
          entryTime = t.timestamp;
          simOutcome = 'ENTERED';
        }
      } else {
        const gain = ((t.price - entryP) / entryP) * 100;
        if (gain > maxGainAfterEntry) maxGainAfterEntry = gain;
        if (gain < minGainAfterEntry) minGainAfterEntry = gain;

        // Take profit +15% or Stop loss -8%
        if (gain >= 15) {
          simOutcome = 'WIN_TP15';
          finalNetGain = 12.5;
          break;
        } else if (gain <= -8) {
          simOutcome = 'LOSS_SL8';
          finalNetGain = -10.5;
          break;
        }
      }
    }

    if (entryP && simOutcome === 'ENTERED') {
      finalNetGain = maxGainAfterEntry > 5 ? maxGainAfterEntry - 2.5 : minGainAfterEntry - 2.5;
    }

    evaluated.push({
      mint: token.mint,
      symbol: token.symbol,
      walletCount: token.walletCount,
      totalAirdropTokens: token.walletCount * 360500,
      tradesCount: analysisTrades.length,
      initialPrice,
      peakPrice,
      timeToPeak,
      troughPrice,
      dumpPct,
      dumpDuration,
      maxBouncePrice,
      bouncePct,
      bounceDuration,
      entryP,
      simOutcome,
      maxGainAfterEntry,
      minGainAfterEntry,
      finalNetGain
    });
  }

  // Print Final Summary
  printFinalReport(evaluated);
}

function printFinalReport(evaluated) {
  console.log('\n' + '='.repeat(70));
  console.log('📊 HASIL EVALUASI KOMPREHENSIF DUMP & BOUNCE TOKEN SINDIKAT');
  console.log('='.repeat(70));
  console.log(`Total Token yang Memiliki Trade Riil: ${evaluated.length} Token`);

  console.log('\n--- TABEL SAMPEL TOKEN SINDIKAT ---');
  for (const r of evaluated) {
    console.log(`• [${r.symbol.padEnd(12)}] Wallets: ${String(r.walletCount).padStart(3)} | Airdrop: ${(r.totalAirdropTokens/1000000).toFixed(1)}M | Peak: ${r.timeToPeak}s | Dump: -${r.dumpPct.toFixed(1)}% (${r.dumpDuration}s) | Bounce: +${r.bouncePct.toFixed(1)}% | Entry: ${r.entryP ? 'YES' : 'NO'} | MaxGain: +${r.maxGainAfterEntry.toFixed(1)}% | Outcome: ${r.simOutcome} (${r.finalNetGain >= 0 ? '+' : ''}${r.finalNetGain.toFixed(1)}%)`);
  }

  const avgDump = evaluated.reduce((a, b) => a + b.dumpPct, 0) / evaluated.length;
  const avgBounce = evaluated.reduce((a, b) => a + b.bouncePct, 0) / evaluated.length;
  const avgDumpDur = evaluated.reduce((a, b) => a + b.dumpDuration, 0) / evaluated.length;
  const avgBounceDur = evaluated.reduce((a, b) => a + b.bounceDuration, 0) / evaluated.length;

  console.log('\n--- STATISTIK UTAMA ---');
  console.log(`1. Rata-rata Kedalaman Dump      : -${avgDump.toFixed(1)}%`);
  console.log(`2. Rata-rata Durasi Dump Terjadi : ${avgDumpDur.toFixed(0)} detik (~${(avgDumpDur/60).toFixed(1)} menit)`);
  console.log(`3. Rata-rata Kekuatan Pantulan   : +${avgBounce.toFixed(1)}%`);
  console.log(`4. Rata-rata Waktu Rebound Naik  : ${avgBounceDur.toFixed(0)} detik (~${(avgBounceDur/60).toFixed(1)} menit)`);

  const wins = evaluated.filter(e => e.simOutcome === 'WIN').length;
  const losses = evaluated.filter(e => e.simOutcome === 'LOSS').length;
  const noEntry = evaluated.filter(e => e.simOutcome === 'NO_ENTRY').length;
  const winRate = (wins + losses) > 0 ? ((wins / (wins + losses)) * 100).toFixed(1) : '0.0';
  const totalNet = evaluated.reduce((a, b) => a + b.simPnl, 0);

  console.log('\n--- HASIL STRATEGI BOUNCE EXHAUSTION (Dump >=30% + Bounce >=4%) ---');
  console.log(`• Win Trades (TP +30%) : ${wins}`);
  console.log(`• Loss Trades (SL -10%): ${losses}`);
  console.log(`• No Entry             : ${noEntry}`);
  console.log(`• WIN RATE             : ${winRate}%`);
  console.log(`• Total Realized Gain  : ${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(1)}%`);

  console.log('\n--- KORELASI JUMLAH WALLET DENGAN KEDALAMAN DUMP ---');
  const g1 = evaluated.filter(e => e.walletCount <= 80);
  const g2 = evaluated.filter(e => e.walletCount > 80);

  if (g1.length > 0) {
    const d1 = g1.reduce((a, b) => a + b.dumpPct, 0) / g1.length;
    const b1 = g1.reduce((a, b) => a + b.bouncePct, 0) / g1.length;
    console.log(`• Kelompok <= 80 Wallets (10 Cluster) [${g1.length} Token]: Rata-rata Dump -${d1.toFixed(1)}% | Bounce +${b1.toFixed(1)}%`);
  }
  if (g2.length > 0) {
    const d2 = g2.reduce((a, b) => a + b.dumpPct, 0) / g2.length;
    const b2 = g2.reduce((a, b) => a + b.bouncePct, 0) / g2.length;
    console.log(`• Kelompok > 80 Wallets (15 Cluster) [${g2.length} Token]: Rata-rata Dump -${d2.toFixed(1)}% | Bounce +${b2.toFixed(1)}%`);
  }
  console.log('='.repeat(70) + '\n');
}

if (process.argv[1] === import.meta.filename) {
  runDirectSyndicateEvaluation().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
