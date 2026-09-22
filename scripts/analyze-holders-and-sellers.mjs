import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dir = 'research/2026-09-22T08-04-30-955Z';

const targetMints = [
  { symbol: 'AI', mint: '8D7baPHHuaZNykLMNSkHD7PEKGLTc4UkyLy9k3LPcBVf' },
  { symbol: 'FAUCET', mint: 'MhEYcMvbqQnDE55CEYDtRkNhn52Npp62UPYensHJnx7' }
];

const summaries = readFileSync(join(dir, 'token-summary.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const simulatedTrades = readFileSync(join(dir, 'simulated-trades.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const allTrades = readFileSync(join(dir, 'trades.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const screenedTokens = readFileSync(join(dir, 'screened-tokens.jsonl'), 'utf-8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

for (const item of targetMints) {
  const summary = summaries.filter(s => s.mint === item.mint).pop();
  const buy = simulatedTrades.find(x => x.type === 'SIMULATED_BUY' && x.mint === item.mint);
  const sell = simulatedTrades.find(x => x.type === 'SIMULATED_SELL' && x.mint === item.mint);
  const screened = screenedTokens.find(x => x.mint === item.mint);

  const buyTime = buy?.observedAt || 0;
  const sellTime = sell?.observedAt || 0;

  console.log('======================================================================');
  console.log(`TOKEN: ${item.symbol} (${item.mint})`);
  console.log(`BUY : ${new Date(buyTime).toLocaleTimeString('id-ID')} @ $${buy?.entryPriceUsd}`);
  console.log(`SELL: ${new Date(sellTime).toLocaleTimeString('id-ID')} @ $${sell?.exit?.priceUsd} (PnL: ${sell?.pnlPercent?.toFixed(2)}%, Reason: ${sell?.reason})`);

  console.log('\n1. KONDISI SAAT HIJAU / LOLOS:');
  console.log(`  - Umur saat lolos: ${screened?.fields?.ageSeconds?.value || (buyTime - (screened?.fields?.createdAt?.value || buyTime))/1000} detik`);
  console.log(`  - Holder count saat screening: ${screened?.fields?.holders?.value}`);
  console.log(`  - Top 10% saat screening: ${screened?.fields?.top10Percent?.value}%`);
  console.log(`  - Likuiditas pool: $${screened?.fields?.liquidityUsd?.value}`);

  console.log('\n2. PEMBAGIAN TOKEN (DISTRIBUSI / DOMINASI):');
  if (summary && summary.wallets) {
    const wallets = summary.wallets;
    const sortedByHolding = wallets
      .filter(w => w.latestHolderSnapshot?.b || w.estimatedOwnershipPercent)
      .sort((a, b) => {
        const balA = Number(a.latestHolderSnapshot?.b || 0);
        const balB = Number(b.latestHolderSnapshot?.b || 0);
        return balB - balA;
      });

    console.log(`  - Total dompet aktif yang tercatat: ${wallets.length}`);
    console.log(`  - 5 Pemegang Terbesar yang Terdeteksi:`);
    let topSumPct = 0;
    for (const [idx, w] of sortedByHolding.slice(0, 5).entries()) {
      const bal = Number(w.latestHolderSnapshot?.b || 0);
      const estPct = w.estimatedOwnershipPercent ? (w.estimatedOwnershipPercent * 100).toFixed(2) : (bal > 0 ? 'Ada saldo' : '-');
      console.log(`    #${idx+1}: Wallet ${w.wallet}`);
      console.log(`       Saldo token: ${bal.toLocaleString()} koin (~${estPct}%) | Buys=${w.buyCount} Sells=${w.sellCount}`);
    }
  } else {
    console.log('  - Data summary dompet tidak tersedia.');
  }

  console.log('\n3. SIAPA PENJUAL PERTAMA SETELAH KITA BELI & BERAPA YANG DIJUAL:');
  const tokenTrades = allTrades.filter(x => x.mint === item.mint).sort((a, b) => a.occurredAt - b.occurredAt);
  const sellsAfterBuy = tokenTrades.filter(x => x.side === 'sell' && x.occurredAt >= buyTime - 2000 && x.occurredAt <= sellTime + 1000);

  if (sellsAfterBuy.length > 0) {
    console.log(`  - Total transaksi sell setelah kita masuk: ${sellsAfterBuy.length}`);
    const first3Sells = sellsAfterBuy.slice(0, 3);
    for (const [idx, s] of first3Sells.entries()) {
      const w = s.wallet || s.raw?.m || 'Unknown';
      const tokenAmt = Number(s.raw?.ba || s.amount || 0);
      const usdVal = Number(s.raw?.au || s.amountUsd || 0);
      const timeStr = new Date(s.occurredAt).toLocaleTimeString('id-ID');
      const delaySec = ((s.occurredAt - buyTime) / 1000).toFixed(1);
      console.log(`    Sell #${idx+1} [${timeStr} (${delaySec}s setelah buy)]:`);
      console.log(`      Wallet : ${w}`);
      console.log(`      Volume : ${tokenAmt.toLocaleString()} tokens ($${usdVal.toFixed(2)}) @ price $${s.priceUsd}`);
    }
  } else {
    console.log('  - Tidak ada trade sell terdeteksi di window ini.');
  }
}
