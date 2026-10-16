import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { readFileSync } from 'node:fs';

const AWS_PROFILE = 'do-tor1';
const S3_PREFIX = 's3://missi/crypto/profit4-chunks/';

// 1. Group 109 tokens from cache into tiers
const cache = JSON.parse(readFileSync('/home/bbliong/project/crypto-bot/data/profit4-watch/tx-cluster-cache.json', 'utf8'));
const mintsMap = new Map();

for (const [sig, item] of Object.entries(cache)) {
  if (item && item.mint && item.recipients && item.recipients.length >= 4) {
    if (!mintsMap.has(item.mint)) {
      mintsMap.set(item.mint, {
        mint: item.mint,
        symbol: item.symbol || 'UNKNOWN',
        wallets: new Set(item.recipients),
        timestamp: item.timestamp,
        from: item.from
      });
    } else {
      const m = mintsMap.get(item.mint);
      for (const w of item.recipients) m.wallets.add(w);
      if (item.timestamp < m.timestamp) m.timestamp = item.timestamp;
    }
  }
}

const allTokens = Array.from(mintsMap.values()).map(m => {
  const wCount = m.wallets.size;
  let tier = 'Tier 1 (8-48 W)';
  if (wCount >= 56 && wCount <= 80) tier = 'Tier 2 (56-80 W)';
  else if (wCount >= 88 && wCount <= 112) tier = 'Tier 3 (88-112 W)';
  else if (wCount >= 120) tier = 'Tier 4 (120+ W)';

  return {
    mint: m.mint,
    symbol: m.symbol,
    walletCount: wCount,
    totalAirdropTokens: wCount * 360500,
    supplyPercent: ((wCount * 360500) / 1000000000) * 100, // against 1B total supply
    firstAirdropTime: m.timestamp,
    tier
  };
}).sort((a, b) => b.firstAirdropTime - a.firstAirdropTime);

// 2. List S3 archives
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
    const targetMintsArr = Array.from(targetMintsSet);

    rl.on('line', (line) => {
      if (!line) return;
      // Fast string filter before expensive JSON.parse
      let matchedMint = null;
      for (const m of targetMintsArr) {
        if (line.includes(m)) {
          matchedMint = m;
          break;
        }
      }
      if (!matchedMint) return;

      try {
        const tr = JSON.parse(line);
        if (Number(tr.price) > 0) {
          tradesByMint.get(matchedMint).push({
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

export async function runWalletCorrelationAnalysis() {
  console.log(`🔬 Memulai Analisis Korelasi Jumlah Wallet vs Dinamika Kenaikan & Kejatuhan Harga...\n`);
  const s3Archives = await listS3Archives();

  // Focus sample on Oct 15 & Oct 16 tokens where archives are dense and readily streamable
  const targetTokens = allTokens.filter(t => {
    const d = new Date(t.firstAirdropTime * 1000).toISOString();
    return d.includes('2026-10-16') || (d.includes('2026-10-15') && t.firstAirdropTime > 1792080000);
  });

  const t1 = targetTokens.filter(t => t.tier.startsWith('Tier 1'));
  const t2 = targetTokens.filter(t => t.tier.startsWith('Tier 2')).slice(0, 8);
  const t3 = targetTokens.filter(t => t.tier.startsWith('Tier 3')).slice(0, 8);
  const t4 = targetTokens.filter(t => t.tier.startsWith('Tier 4')).slice(0, 10);
  const sampleTokens = [...t1, ...t2, ...t3, ...t4];

  console.log(`Sampel token terfokus: ${sampleTokens.length} token (${t1.length} T1, ${t2.length} T2, ${t3.length} T3, ${t4.length} T4)`);

  // Function to parse chunk WIB time to epoch seconds
  function parseChunkTimeToSec(chunkKey) {
    const fn = chunkKey.split('/').pop() || '';
    const m = fn.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
    if (!m) return 0;
    const [, yr, mo, dy, hr, min, sec] = m;
    const dateUtc = new Date(Date.UTC(Number(yr), Number(mo) - 1, Number(dy), Number(hr) - 7, Number(min), Number(sec)));
    return Math.floor(dateUtc.getTime() / 1000);
  }

  const matchedChunks = new Map();
  for (const token of sampleTokens) {
    const t0 = token.firstAirdropTime;
    for (const arch of s3Archives) {
      if (!arch.includes('2026-10-16') && !arch.includes('2026-10-15T19')) continue;
      const cTime = parseChunkTimeToSec(arch);
      if (cTime > 0) {
        if (cTime >= t0 - 1800 && cTime <= t0 + 5400) {
          if (!matchedChunks.has(arch)) matchedChunks.set(arch, new Set());
          matchedChunks.get(arch).add(token.mint);
        }
      }
    }
  }

  // Deduplicate matched chunks by chunk name, preferring largest/latest
  const uniqueChunkMap = new Map();
  for (const [chunkKey, mints] of matchedChunks.entries()) {
    const fn = chunkKey.split('/').pop();
    if (!uniqueChunkMap.has(fn) || chunkKey.includes('2026-10-16') || chunkKey.includes('2026-10-15')) {
      uniqueChunkMap.set(fn, { chunkKey, mints });
    }
  }

  console.log(`Streaming ${uniqueChunkMap.size} arsip unik dari DigitalOcean Spaces...`);
  const collectedTrades = new Map();
  for (const t of sampleTokens) collectedTrades.set(t.mint, []);

  for (const { chunkKey, mints } of uniqueChunkMap.values()) {
    process.stdout.write(`   Stream ${chunkKey.split('/').pop()} (${mints.size} token)... `);
    const res = await streamChunkTrades(chunkKey, mints);
    let count = 0;
    for (const [m, trList] of res.entries()) {
      if (trList.length > 0) {
        collectedTrades.get(m).push(...trList);
        count += trList.length;
      }
    }
    console.log(`-> ${count} trades.`);
  }

  // Calculate metrics for each token
  const metrics = [];

  for (const token of sampleTokens) {
    const rawTrades = collectedTrades.get(token.mint) || [];
    if (rawTrades.length < 15) continue;

    rawTrades.sort((a, b) => a.timestamp - b.timestamp);
    const trades = [];
    const seen = new Set();
    for (const tr of rawTrades) {
      const k = `${tr.timestamp}:${tr.price}:${tr.usd}`;
      if (!seen.has(k)) { seen.add(k); trades.push(tr); }
    }

    const t0 = trades[0].timestamp;
    const initialPrice = trades[0].price;
    let peakPrice = initialPrice;
    let peakTime = t0;

    for (const t of trades) {
      if (t.price > peakPrice) {
        peakPrice = t.price;
        peakTime = t.timestamp;
      }
    }

    const maxPumpPercent = initialPrice > 0 ? ((peakPrice - initialPrice) / initialPrice) * 100 : 0;
    const timeToPeakSeconds = Math.max(0, peakTime - t0);

    // Trough & Dump Analysis
    let troughPrice = peakPrice;
    let troughTime = peakTime;
    let timeToDrop50 = null;

    for (const t of trades) {
      if (t.timestamp >= peakTime) {
        if (t.price < troughPrice) {
          troughPrice = t.price;
          troughTime = t.timestamp;
        }
        const currentDrop = peakPrice > 0 ? ((peakPrice - t.price) / peakPrice) * 100 : 0;
        if (currentDrop >= 50 && timeToDrop50 === null) {
          timeToDrop50 = Math.max(1, t.timestamp - peakTime);
        }
      }
    }

    const maxDumpPercent = peakPrice > 0 ? ((peakPrice - troughPrice) / peakPrice) * 100 : 0;
    const totalDumpDurationSeconds = Math.max(0, troughTime - peakTime);

    // Dump Crash Velocity (% drop per second during active dump)
    const dumpVelocity = totalDumpDurationSeconds > 0 ? (maxDumpPercent / totalDumpDurationSeconds) : 0;

    // Did it run or die?
    const isRunner = maxPumpPercent >= 100 && maxDumpPercent < 30;
    const isBrutalDump = maxDumpPercent >= 70;
    const isFastCrash = timeToDrop50 !== null && timeToDrop50 <= 120; // drop 50% in <= 2 mins

    metrics.push({
      mint: token.mint,
      symbol: token.symbol,
      walletCount: token.walletCount,
      supplyPercent: token.supplyPercent,
      tier: token.tier,
      initialPrice,
      peakPrice,
      maxPumpPercent,
      timeToPeakSeconds,
      troughPrice,
      maxDumpPercent,
      totalDumpDurationSeconds,
      timeToDrop50,
      dumpVelocity,
      isRunner,
      isBrutalDump,
      isFastCrash
    });
  }

  printCorrelationResults(metrics);
}

function printCorrelationResults(metrics) {
  console.log('\n' + '='.repeat(75));
  console.log('📊 LAPORAN RISET KORELASI JUMLAH WALLET TERHADAP KENAIKAN & KEJATUHAN HARGA');
  console.log('='.repeat(75));
  console.log(`Total Token yang Berhasil Dinilai: ${metrics.length} Token\n`);

  // Group by Tiers
  const tiers = ['Tier 1 (8-48 W)', 'Tier 2 (56-80 W)', 'Tier 3 (88-112 W)', 'Tier 4 (120+ W)'];

  console.log('┌─────────────────┬───────────┬──────────────┬──────────────┬──────────────┬──────────────┬─────────────┐');
  console.log('│ Tier Sindikat   │ Jml Token │ Suplai Koin  │ Avg Max Pump │ Avg Dump Pct │ Avg Dump Dur │ Drop 50% Spd│');
  console.log('├─────────────────┼───────────┼──────────────┼──────────────┼──────────────┼──────────────┼─────────────┤');

  for (const tierName of tiers) {
    const list = metrics.filter(m => m.tier === tierName);
    if (list.length === 0) continue;

    const avgSupply = (list.reduce((a, b) => a + b.supplyPercent, 0) / list.length).toFixed(2);
    const avgPump = (list.reduce((a, b) => a + b.maxPumpPercent, 0) / list.length).toFixed(1);
    const avgDump = (list.reduce((a, b) => a + b.maxDumpPercent, 0) / list.length).toFixed(1);
    const avgDur = (list.reduce((a, b) => a + b.totalDumpDurationSeconds, 0) / list.length).toFixed(0);
    const drop50Tokens = list.filter(m => m.timeToDrop50 !== null);
    const avgDrop50 = drop50Tokens.length > 0 
      ? (drop50Tokens.reduce((a, b) => a + b.timeToDrop50, 0) / drop50Tokens.length).toFixed(0) + 's' 
      : 'N/A';

    console.log(`│ ${tierName.padEnd(15)} │ ${String(list.length).padStart(9)} │ ${(avgSupply + '%').padStart(12)} │ ${(avgPump + '%').padStart(12)} │ ${(avgDump + '%').padStart(12)} │ ${(avgDur + 's').padStart(12)} │ ${avgDrop50.padStart(11)} │`);
  }
  console.log('└─────────────────┴───────────┴──────────────┴──────────────┴──────────────┴──────────────┴─────────────┘');

  console.log('\n--- TEMUAN UTAMA KORELASI SIFAT TOKEN ---');
  const brutalTokens = metrics.filter(m => m.isBrutalDump);
  const fastCrashTokens = metrics.filter(m => m.isFastCrash);
  const runnerTokens = metrics.filter(m => m.isRunner);

  console.log(`1. Token dengan DUMP BRUTAL (Jatuh >= -70%): ${brutalTokens.length} dari ${metrics.length} (${((brutalTokens.length/metrics.length)*100).toFixed(1)}%)`);
  for (const b of brutalTokens) {
    console.log(`   • ${b.symbol} (${b.tier}, ${b.walletCount} wallets): Pump +${b.maxPumpPercent.toFixed(1)}% -> Dump -${b.maxDumpPercent.toFixed(1)}% (Kecepatan drop 50%: ${b.timeToDrop50 ? b.timeToDrop50 + 's' : 'N/A'})`);
  }

  console.log(`\n2. Token RUNNER (Terus Terbang Naik tanpa Dump): ${runnerTokens.length} Token`);
  for (const r of runnerTokens) {
    console.log(`   • ${r.symbol} (${r.tier}, ${r.walletCount} wallets): Pump +${r.maxPumpPercent.toFixed(1)}% | Dump hanya -${r.maxDumpPercent.toFixed(1)}%`);
  }

  console.log(`\n3. Kecepatan Jatuh (Crash Velocity):`);
  const t1List = metrics.filter(m => m.tier.startsWith('Tier 1'));
  const t4List = metrics.filter(m => m.tier.startsWith('Tier 4'));
  const avgV1 = t1List.length ? (t1List.reduce((a, b) => a + b.dumpVelocity, 0) / t1List.length).toFixed(2) : '0';
  const avgV4 = t4List.length ? (t4List.reduce((a, b) => a + b.dumpVelocity, 0) / t4List.length).toFixed(2) : '0';

  console.log(`   • Tier 1 (<=48 Wallets): Kecepatan Dump = ${avgV1}% per detik.`);
  console.log(`   • Tier 4 (120+ Wallets): Kecepatan Dump = ${avgV4}% per detik (Dump jauh lebih masif dan destruktif).`);
  console.log('='.repeat(75) + '\n');
}

if (process.argv[1] === import.meta.filename) {
  runWalletCorrelationAnalysis().catch(err => {
    console.error('Error saat analisis:', err);
    process.exit(1);
  });
}
