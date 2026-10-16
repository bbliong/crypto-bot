import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';

const AWS_PROFILE = 'do-tor1';
const S3_PREFIX = 's3://missi/crypto/profit4-chunks/';

// 1. Get relevant chunk archives from S3 (last 2-3 days)
async function listS3Chunks(limit = 35) {
  return new Promise((resolve, reject) => {
    const p = spawn('aws', ['--profile', AWS_PROFILE, 's3', 'ls', S3_PREFIX, '--recursive']);
    let out = '';
    p.stdout.on('data', d => out += d.toString());
    p.on('close', code => {
      if (code !== 0) return reject(new Error('Gagal list S3 chunks'));
      const lines = out.trim().split('\n');
      const archives = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4 && parts[3].endsWith('.tar.gz')) {
          const key = parts[3];
          // Filter chunks from Oct 14, 15, 16
          if (key.includes('2026-10-14') || key.includes('2026-10-15') || key.includes('2026-10-16')) {
            archives.push(key);
          }
        }
      }
      resolve(archives.slice(-limit)); // Take the latest N archives
    });
  });
}

// 2. Stream transfers.jsonl from an archive
async function streamTransfersFromArchive(key) {
  return new Promise((resolve) => {
    const aws = spawn('aws', ['--profile', AWS_PROFILE, 's3', 'cp', `s3://missi/${key}`, '-']);
    const tar = spawn('tar', ['-zx', '--wildcards', '*transfers.jsonl', '-O']);
    aws.stdout.pipe(tar.stdin);

    const rl = readline.createInterface({ input: tar.stdout });
    const transfers = [];

    rl.on('line', (line) => {
      if (!line) return;
      try {
        const t = JSON.parse(line);
        if (t.mint && (t.amount === '360500' || t.source === 'syndicate_inflow' || t.from)) {
          transfers.push(t);
        }
      } catch {}
    });

    tar.on('close', () => {
      aws.kill();
      resolve(transfers);
    });
    aws.on('error', () => resolve([]));
    tar.on('error', () => resolve([]));
  });
}

// 3. Stream token-trades.jsonl for specific mints from an archive
async function streamTradesForMints(key, targetMintsSet) {
  return new Promise((resolve) => {
    const aws = spawn('aws', ['--profile', AWS_PROFILE, 's3', 'cp', `s3://missi/${key}`, '-']);
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
        if (m && targetMintsSet.has(m) && tr.price > 0) {
          tradesByMint.get(m).push({
            price: Number(tr.price),
            timestamp: Number(tr.timestamp || Math.floor((tr.at || tr.observedAt || Date.now()) / 1000)),
            side: tr.side || tr.e,
            usd: Number(tr.usd || tr.au || 0),
            wallet: tr.wallet || tr.m || ''
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

// 4. Analyze Dump & Bounce Dynamics for a single token
function analyzeTokenDynamics(tokenMeta, trades) {
  if (!trades || trades.length < 5) return null;

  // Sort trades chronologically
  trades.sort((a, b) => a.timestamp - b.timestamp);
  if (trades.length < 10) return null;

  const t0 = trades[0].timestamp;
  const initialPrice = trades[0].price;
  let peakPrice = initialPrice;
  let peakTime = t0;

  // 1. Find peak price across the observation window
  for (const t of trades) {
    if (t.price > peakPrice) {
      peakPrice = t.price;
      peakTime = t.timestamp;
    }
  }

  const timeToPeakSeconds = Math.max(0, peakTime - t0);

  // 2. Find trough (lowest point) after peak
  let troughPrice = peakPrice;
  let troughTime = peakTime;
  const postPeakTrades = trades.filter(t => t.timestamp >= peakTime);

  for (const t of postPeakTrades) {
    if (t.price < troughPrice) {
      troughPrice = t.price;
      troughTime = t.timestamp;
    }
  }

  const dumpPercent = peakPrice > 0 ? ((peakPrice - troughPrice) / peakPrice) * 100 : 0;
  const timeToTroughSeconds = Math.max(0, troughTime - peakTime);
  const totalDumpDurationSeconds = Math.max(0, troughTime - t0);

  // 3. Find bounce after trough
  let maxBouncePrice = troughPrice;
  let maxBounceTime = troughTime;
  const postTroughTrades = trades.filter(t => t.timestamp >= troughTime);

  for (const t of postTroughTrades) {
    if (t.price > maxBouncePrice) {
      maxBouncePrice = t.price;
      maxBounceTime = t.timestamp;
    }
  }

  const bouncePercent = troughPrice > 0 ? ((maxBouncePrice - troughPrice) / troughPrice) * 100 : 0;
  const bounceDurationSeconds = Math.max(0, maxBounceTime - troughTime);

  // 4. Simulation: Realistic rolling state machine
  const simStrategies = {
    'dump20_bounce4': { dumpMin: 20, bounceMin: 4, tp: 25, sl: -10, result: 'NO_ENTRY', pnl: 0 },
    'dump25_bounce4': { dumpMin: 25, bounceMin: 4, tp: 25, sl: -10, result: 'NO_ENTRY', pnl: 0 },
    'dump30_bounce4': { dumpMin: 30, bounceMin: 4, tp: 30, sl: -10, result: 'NO_ENTRY', pnl: 0 },
    'dump35_bounce4': { dumpMin: 35, bounceMin: 4, tp: 35, sl: -12, result: 'NO_ENTRY', pnl: 0 },
    'dump40_bounce5': { dumpMin: 40, bounceMin: 5, tp: 35, sl: -12, result: 'NO_ENTRY', pnl: 0 }
  };

  for (const [sKey, strat] of Object.entries(simStrategies)) {
    let rollPeak = initialPrice;
    let rollLow = initialPrice;
    let inDump = false;
    let entryPrice = null;

    for (const t of trades) {
      if (!entryPrice) {
        if (t.price > rollPeak) {
          rollPeak = t.price;
          rollLow = t.price;
        }
        if (t.price < rollLow) {
          rollLow = t.price;
        }

        const curDrop = rollPeak > 0 ? ((rollPeak - t.price) / rollPeak) * 100 : 0;
        if (curDrop >= strat.dumpMin) {
          inDump = true;
        }

        const curRebound = rollLow > 0 ? ((t.price - rollLow) / rollLow) * 100 : 0;

        // Buy condition: Must have dumped by >= dumpMin, then rebounded by >= bounceMin from low
        if (inDump && curRebound >= strat.bounceMin) {
          entryPrice = t.price;
        }
      } else {
        const pnlPct = ((t.price - entryPrice) / entryPrice) * 100;
        if (pnlPct >= strat.tp) {
          strat.result = 'WIN';
          strat.pnl = strat.tp - 2.5; // deduction for fees & slippage
          break;
        } else if (pnlPct <= strat.sl) {
          strat.result = 'LOSS';
          strat.pnl = strat.sl - 2.5;
          break;
        }
      }
    }
  }

  return {
    mint: tokenMeta.mint,
    symbol: tokenMeta.symbol,
    walletCount: tokenMeta.walletCount,
    totalTokensTransferred: tokenMeta.walletCount * 360500,
    initialPrice,
    peakPrice,
    timeToPeakSeconds,
    troughPrice,
    dumpPercent,
    timeToTroughSeconds,
    totalDumpDurationSeconds,
    maxBouncePrice,
    bouncePercent,
    bounceDurationSeconds,
    simStrategies
  };
}

export async function runStreamingSyndicateEvaluation() {
  console.log('🚀 Memulai Evaluasi On-Chain Streaming Dump Sindikat dari DigitalOcean Spaces...\n');
  const chunks = await listS3Chunks(12);
  console.log(`📦 Ditemukan ${chunks.length} chunk arsip S3 untuk dianalisis:`);
  for (const c of chunks) console.log(`   - ${c}`);

  const allTokensMeta = new Map();

  // Phase 1: Stream transfers.jsonl from each chunk
  console.log('\n📥 Fase 1: Membaca transfer airdrop sindikat via streaming...');
  for (const chunkKey of chunks) {
    const transfers = await streamTransfersFromArchive(chunkKey);
    for (const t of transfers) {
      if (!allTokensMeta.has(t.mint)) {
        allTokensMeta.set(t.mint, {
          mint: t.mint,
          symbol: t.symbol || 'UNKNOWN',
          firstTransferTime: t.timestamp || Math.floor((t.observedAt || Date.now()) / 1000),
          initialPrice: Number(t.priceUsd || 0),
          wallets: new Set([t.wallet]),
          chunkKeys: new Set([chunkKey])
        });
      } else {
        const existing = allTokensMeta.get(t.mint);
        existing.wallets.add(t.wallet);
        existing.chunkKeys.add(chunkKey);
        if (t.timestamp && t.timestamp < existing.firstTransferTime) {
          existing.firstTransferTime = t.timestamp;
        }
      }
    }
  }

  const syndicateTokens = [];
  for (const [mint, meta] of allTokensMeta.entries()) {
    meta.walletCount = meta.wallets.size;
    syndicateTokens.push(meta);
  }

  console.log(`\n🎯 Terdeteksi ${syndicateTokens.length} koin sindikat unik dengan transfer airdrop!`);

  // Group by chunkKey for efficient trade streaming
  const chunkToMints = new Map();
  for (const tok of syndicateTokens) {
    for (const ck of tok.chunkKeys) {
      if (!chunkToMints.has(ck)) chunkToMints.set(ck, new Set());
      chunkToMints.get(ck).add(tok.mint);
    }
  }

  // Phase 2: Stream token-trades.jsonl for these mints
  console.log('\n📈 Fase 2: Streaming tick harga token-trades.jsonl dari DO Spaces...');
  const evaluatedResults = [];

  for (const [chunkKey, mintsSet] of chunkToMints.entries()) {
    console.log(`   ⚡ Streaming trades untuk ${mintsSet.size} token dari ${chunkKey.split('/').pop()}...`);
    const tradesByMint = await streamTradesForMints(chunkKey, mintsSet);

    for (const mint of mintsSet) {
      const tokMeta = syndicateTokens.find(t => t.mint === mint);
      const trades = tradesByMint.get(mint);
      if (tokMeta && trades && trades.length > 5) {
        const analysis = analyzeTokenDynamics(tokMeta, trades);
        if (analysis) evaluatedResults.push(analysis);
      }
    }
  }

  console.log(`\n✅ Analisis Selesai! Berhasil mengumpulkan data dinamika pasar untuk ${evaluatedResults.length} token sindikat.\n`);

  // Output Statistics & Markdown Report
  generateReport(evaluatedResults);
}

function generateReport(results) {
  if (results.length === 0) {
    console.log('Tidak ada data trades yang cukup untuk dianalisis.');
    return;
  }

  const avgTimeToPeak = results.reduce((acc, r) => acc + r.timeToPeakSeconds, 0) / results.length;
  const avgDumpPercent = results.reduce((acc, r) => acc + r.dumpPercent, 0) / results.length;
  const avgDumpDuration = results.reduce((acc, r) => acc + r.totalDumpDurationSeconds, 0) / results.length;
  const avgBouncePercent = results.reduce((acc, r) => acc + r.bouncePercent, 0) / results.length;
  const avgBounceDuration = results.reduce((acc, r) => acc + r.bounceDurationSeconds, 0) / results.length;

  // Correlation with wallet count
  const byWalletGroups = {
    '1-8 Wallets (1 Cluster)': results.filter(r => r.walletCount <= 8),
    '9-24 Wallets (2-3 Clusters)': results.filter(r => r.walletCount > 8 && r.walletCount <= 24),
    '>24 Wallets (Multi-Clusters)': results.filter(r => r.walletCount > 24)
  };

  // Sim results with different dump thresholds
  const stratKeys = ['dump20_bounce4', 'dump25_bounce4', 'dump30_bounce4', 'dump35_bounce4'];
  const stratLabels = {
    'dump20_bounce4': 'Dump >= 20% + Rebound >= 4% (TP +25%, SL -10%)',
    'dump25_bounce4': 'Dump >= 25% + Rebound >= 4% (TP +25%, SL -10%)',
    'dump30_bounce4': 'Dump >= 30% + Rebound >= 4% (TP +30%, SL -10%)',
    'dump35_bounce4': 'Dump >= 35% + Rebound >= 4% (TP +35%, SL -12%)'
  };

  console.log('\n--- DETAIL PER-TOKEN SAMPEL SINDIKAT ---');
  for (const r of results) {
    console.log(`• Token ${r.symbol} (${r.mint.slice(0, 8)}...): Wallets: ${r.walletCount} | Dump: -${r.dumpPercent.toFixed(1)}% | Bounce: +${r.bouncePercent.toFixed(1)}% | Durasi Dump: ${r.totalDumpDurationSeconds}s | Bounce Time: ${r.bounceDurationSeconds}s`);
  }

  console.log('\n' + '='.repeat(65));
  console.log('📊 LAPORAN EVALUASI DINAMIKA DUMP & EXHAUSTION SINDIKAT (S3 STREAM)');
  console.log('='.repeat(65));
  console.log(`Total Sampel Token Sindikat : ${results.length} token`);
  console.log(`Rata-rata Waktu ke Peak      : ${avgTimeToPeak.toFixed(0)} detik`);
  console.log(`Rata-rata Kedalaman Dump    : -${avgDumpPercent.toFixed(1)}%`);
  console.log(`Rata-rata Durasi Dump Selesai: ${avgDumpDuration.toFixed(0)} detik (~${(avgDumpDuration / 60).toFixed(1)} menit)`);
  console.log(`Rata-rata Pantulan (Bounce) : +${avgBouncePercent.toFixed(1)}%`);
  console.log(`Rata-rata Durasi Rebound    : ${avgBounceDuration.toFixed(0)} detik (~${(avgBounceDuration / 60).toFixed(1)} menit)`);

  console.log('\n--- SIMULASI ENTRY STRATEGI DUMP EXHAUSTION BERBAGAI THRESHOLD ---');
  for (const sKey of stratKeys) {
    let w = 0, l = 0, ne = 0, totalPnl = 0;
    for (const r of results) {
      const res = r.simStrategies?.[sKey];
      if (res) {
        if (res.result === 'WIN') { w++; totalPnl += res.pnl; }
        else if (res.result === 'LOSS') { l++; totalPnl += res.pnl; }
        else ne++;
      }
    }
    const wr = (w + l) > 0 ? ((w / (w + l)) * 100).toFixed(1) : '0.0';
    console.log(`\n⚙️ ${stratLabels[sKey]}:`);
    console.log(`   - Win: ${w} | Loss: ${l} | No Entry: ${ne}`);
    console.log(`   - Win Rate: ${wr}%`);
    console.log(`   - Net Return Kumulatif: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(1)}%`);
  }

  console.log('\n--- KORELASI JUMLAH WALLET TERHADAP DUMP & BOUNCE ---');
  for (const [group, items] of Object.entries(byWalletGroups)) {
    if (items.length === 0) continue;
    const gDump = items.reduce((a, b) => a + b.dumpPercent, 0) / items.length;
    const gBounce = items.reduce((a, b) => a + b.bouncePercent, 0) / items.length;
    const gDuration = items.reduce((a, b) => a + b.totalDumpDurationSeconds, 0) / items.length;
    console.log(`• ${group} [${items.length} koin]:`);
    console.log(`   - Kedalaman Dump   : -${gDump.toFixed(1)}%`);
    console.log(`   - Durasi Dump      : ${gDuration.toFixed(0)}s`);
    console.log(`   - Kekuatan Bounce  : +${gBounce.toFixed(1)}%`);
  }
  console.log('='.repeat(65) + '\n');
}

if (process.argv[1] === import.meta.filename) {
  runStreamingSyndicateEvaluation().catch(e => {
    console.error('Error saat evaluasi:', e);
    process.exit(1);
  });
}
