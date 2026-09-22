import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const dir = 'research/2026-09-22T08-04-30-955Z';

const winningMints = [
  { symbol: 'WEPE', mint: 'J82c6FXjJ5hGminZRgW2AtqGPxYYFcwUkeuHrw3opump' },
  { symbol: 'Mike', mint: 'FGuKDD25whfGt8qypxJ5oLt1UidWmcn6Df3xCMnE7Kmd' },
  { symbol: 'Luke', mint: 'AiR3QJ5g5yXzwcCDw39q2eVQePvw7o4pYzc4inKULuke' },
  { symbol: 'PAIN', mint: 'EAsqvvyNnKzL2gZrFPsToGRwyi6cPeB5ECitR15opump' },
  { symbol: 'GROK_WIN', mint: '6YstkjZB97wt9cLus6STn1XkZupPp2VBAPSkPercpump' },
  { symbol: 'DogRun', mint: 'J5bcap9Ly5oYDfSsumZtaLyS9vyWdKEGpy58yJybadYk' },
  { symbol: 'BUTTHOLE', mint: 'CLdc3jny1jP1w5RmiDS5vpk5gowFLSP9HLf2SUAjwH1' },
  { symbol: 'FatElon', mint: 'haGcbYxVKD2CQWKfBFpCKFBqKMCjSJEJuq2KU2gpump' },
  { symbol: 'Launchify', mint: '8QkWgs2pQMgZe5uN3eCWU4cubGG9oUa8CGD7u9qapump' },
  { symbol: '中国人能飞_WIN', mint: 'FCpGbXZsdkggjqCASoUGFAym6ER3Njv4kgVDTJ9EF3aU' }
];

function readJsonl(fileName) {
  const p = join(dir, fileName);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

const simulatedTrades = readJsonl('simulated-trades.jsonl');
const screenedTokens = readJsonl('screened-tokens.jsonl');
const summaries = readJsonl('token-summary.jsonl');
const tokenStats = readJsonl('token-stat.jsonl');

for (const item of winningMints) {
  const summary = summaries.filter(s => s.mint === item.mint).pop();
  const buy = simulatedTrades.find(x => x.type === 'SIMULATED_BUY' && x.mint === item.mint);
  const sell = simulatedTrades.find(x => x.type === 'SIMULATED_SELL' && x.mint === item.mint);
  const screened = screenedTokens.find(x => x.mint === item.mint);

  const buyTime = buy?.observedAt || 0;
  const sellTime = sell?.observedAt || 0;

  const statsBeforeBuy = tokenStats.filter(x => x.mint === item.mint && x.observedAt <= buyTime);
  const latestStat = statsBeforeBuy[statsBeforeBuy.length - 1] || tokenStats.find(x => x.mint === item.mint);

  console.log('======================================================================');
  console.log(`TOKEN WIN: ${item.symbol} (${item.mint})`);
  console.log(`BUY : ${new Date(buyTime).toLocaleTimeString('id-ID')} @ $${buy?.entryPriceUsd}`);
  console.log(`SELL: ${new Date(sellTime).toLocaleTimeString('id-ID')} @ $${sell?.exit?.priceUsd} (PnL: +${sell?.pnlPercent?.toFixed(2)}%, Reason: ${sell?.reason}, Peak: +${sell?.decision?.peakReturnPercent?.toFixed(1)}%)`);

  console.log('\n1. KONDISI HOLDER:');
  console.log(`  - Holder saat screening: ${screened?.fields?.holders?.value ?? 'N/A'}`);
  console.log(`  - Holder saat beli (detail page): ${latestStat?.holderCount ?? 'N/A'}`);
  console.log(`  - Top 10% saat screening: ${screened?.fields?.top10Percent?.value ?? 'N/A'}%`);
  console.log(`  - Likuiditas pool: $${screened?.fields?.liquidityUsd?.value ?? 'N/A'}`);

  console.log('\n2. DISTRIBUSI TOKEN:');
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
    console.log(`  - 5 Pemegang Terbesar:`);
    let top5Bal = 0;
    for (const [idx, w] of sortedByHolding.slice(0, 5).entries()) {
      const bal = Number(w.latestHolderSnapshot?.b || 0);
      top5Bal += bal;
      const estPct = w.estimatedOwnershipPercent ? (w.estimatedOwnershipPercent * 100).toFixed(2) : '-';
      console.log(`    #${idx+1}: Wallet ${w.wallet} | Saldo: ${bal.toLocaleString()} koin (~${estPct}%) | Buys=${w.buyCount} Sells=${w.sellCount}`);
    }
  } else {
    console.log('  - Data wallet summary tidak tersedia');
  }
}
