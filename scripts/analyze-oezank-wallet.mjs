import { readFileSync, writeFileSync } from 'node:fs';

const env = readFileSync('/home/bbliong/project/crypto-bot/.env', 'utf8');
const key = env.match(/HELIUS_API_KEY=([^\s\r\n]+)/)[1].trim();
const wallet = 'D24y1SsG8dkjUxbgdFK62FKEerviuq6iQsXXuG8TiXcy';
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${key}`;

async function analyzeOezankTrading() {
  console.log(`🔍 Mengambil histori transaksi on-chain untuk wallet: ${wallet}...`);

  // 1. Get recent signatures
  const sigRes = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getSignaturesForAddress',
      params: [wallet, { limit: 60 }]
    })
  });
  const sigData = await sigRes.json();
  const sigs = (sigData.result || []).map(s => s.signature);
  console.log(`Ditemukan ${sigs.length} signature transaksi on-chain.`);

  // 2. Fetch parsed transactions in batches of 5 with 150ms delay
  const trades = [];
  const tokenEvents = [];

  for (let i = 0; i < sigs.length; i++) {
    const s = sigs[i];
    try {
      const txRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
        })
      });
      const txData = await txRes.json();
      const tx = txData.result;
      if (!tx || !tx.meta) continue;

      const blockTime = tx.blockTime ? tx.blockTime : Math.floor(Date.now() / 1000);
      const preTokens = tx.meta.preTokenBalances || [];
      const postTokens = tx.meta.postTokenBalances || [];

      // Find token changes for this wallet
      const relevantMints = new Set();
      preTokens.forEach(b => { if (b.owner === wallet && b.mint) relevantMints.add(b.mint); });
      postTokens.forEach(b => { if (b.owner === wallet && b.mint) relevantMints.add(b.mint); });

      const accountKeys = tx.transaction?.message?.accountKeys || [];
      const walletIdx = accountKeys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === wallet);
      const preSol = walletIdx !== -1 ? (tx.meta.preBalances?.[walletIdx] || 0) / 1e9 : 0;
      const postSol = walletIdx !== -1 ? (tx.meta.postBalances?.[walletIdx] || 0) / 1e9 : 0;
      const solDiff = postSol - preSol;

      for (const mint of relevantMints) {
        // Skip WSOL, USDC, USDT
        if (['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'].includes(mint)) continue;

        const pre = preTokens.find(b => b.owner === wallet && b.mint === mint);
        const post = postTokens.find(b => b.owner === wallet && b.mint === mint);
        const preAmt = Number(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmt = Number(post?.uiTokenAmount?.uiAmount || 0);
        const diffAmt = postAmt - preAmt;

        if (diffAmt > 0) {
          // BUY
          tokenEvents.push({
            type: 'BUY',
            mint,
            tokenAmount: diffAmt,
            solSpent: Math.abs(solDiff),
            timestamp: blockTime,
            tx: s
          });
        } else if (diffAmt < 0) {
          // SELL
          tokenEvents.push({
            type: 'SELL',
            mint,
            tokenAmount: Math.abs(diffAmt),
            solReceived: solDiff > 0 ? solDiff : 0,
            timestamp: blockTime,
            tx: s
          });
        }
      }

      await new Promise(r => setTimeout(r, 80));
    } catch {}
  }

  // 3. Match BUY and SELL into complete round-trip trades
  tokenEvents.sort((a, b) => a.timestamp - b.timestamp);

  const openBuys = new Map(); // mint -> buyEvent
  const roundTrips = [];

  for (const ev of tokenEvents) {
    if (ev.type === 'BUY') {
      openBuys.set(ev.mint, ev);
    } else if (ev.type === 'SELL') {
      const matchingBuy = openBuys.get(ev.mint);
      if (matchingBuy) {
        const holdSec = ev.timestamp - matchingBuy.timestamp;
        const profitSol = ev.solReceived - matchingBuy.solSpent;
        const returnPct = matchingBuy.solSpent > 0 ? (profitSol / matchingBuy.solSpent) * 100 : 0;

        roundTrips.push({
          mint: ev.mint,
          buyTime: matchingBuy.timestamp,
          sellTime: ev.timestamp,
          holdSeconds: holdSec,
          solSpent: matchingBuy.solSpent,
          solReceived: ev.solReceived,
          profitSol,
          returnPct,
          isWin: profitSol > 0
        });
        openBuys.delete(ev.mint);
      } else {
        // Sold without prior buy captured in this window
        roundTrips.push({
          mint: ev.mint,
          sellTime: ev.timestamp,
          solReceived: ev.solReceived,
          isStandaloneSell: true
        });
      }
    }
  }

  // 4. Print Analysis Report
  console.log('\n' + '='.repeat(75));
  console.log(`📊 ANALISIS POLA TRADING WALLET OEZANK IDC (${wallet})`);
  console.log('='.repeat(75));

  const completed = roundTrips.filter(r => !r.isStandaloneSell);
  console.log(`Total Transaksi Token Terdeteksi : ${tokenEvents.length}`);
  console.log(`Total Round-Trip Selesai (Buy->Sell): ${completed.length}`);

  if (completed.length > 0) {
    const wins = completed.filter(c => c.isWin);
    const losses = completed.filter(c => !c.isWin);
    const wr = ((wins.length / completed.length) * 100).toFixed(1);
    const avgHoldSec = completed.reduce((a, b) => a + b.holdSeconds, 0) / completed.length;
    const avgSolSpent = completed.reduce((a, b) => a + b.solSpent, 0) / completed.length;
    const totalPnlSol = completed.reduce((a, b) => a + b.profitSol, 0);

    console.log(`• Win Rate             : ${wr}% (${wins.length} Win / ${losses.length} Loss)`);
    console.log(`• Rata-rata Stake Buy  : ${avgSolSpent.toFixed(3)} SOL (~$${(avgSolSpent * 145).toFixed(1)} USD)`);
    console.log(`• Rata-rata Waktu Hold : ${avgHoldSec.toFixed(0)} detik (~${(avgHoldSec / 60).toFixed(1)} menit)`);
    console.log(`• Total PnL Riil       : ${totalPnlSol >= 0 ? '+' : ''}${totalPnlSol.toFixed(4)} SOL`);

    console.log('\n--- DETAIL SETIAP TRADE ---');
    for (const c of completed) {
      const dStr = new Date(c.buyTime * 1000).toLocaleString('id-ID');
      const resStr = c.isWin ? 'WIN' : 'LOSS';
      const retStr = `${c.returnPct >= 0 ? '+' : ''}${c.returnPct.toFixed(1)}%`;
      console.log(`• Mint: ${c.mint.slice(0, 10)}... | Buy: ${c.solSpent.toFixed(3)} SOL -> Sell: ${c.solReceived.toFixed(3)} SOL | Hold: ${c.holdSeconds}s | ${resStr} (${retStr}) | Jam: ${dStr}`);
    }
  }

  writeFileSync('/home/bbliong/project/crypto-bot/data/profit4-watch/oezank-analysis.json', JSON.stringify({
    wallet,
    tokenEvents,
    roundTrips
  }, null, 2), 'utf8');

  console.log('='.repeat(75) + '\n');
}

analyzeOezankTrading().catch(err => {
  console.error('Error saat analisis:', err);
  process.exit(1);
});
