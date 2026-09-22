import { readFileSync } from 'fs';
import { join } from 'path';

const dir = 'research/2026-09-22T08-04-30-955Z';

const simulatedTrades = readFileSync(join(dir, 'simulated-trades.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
const screenedTokens = readFileSync(join(dir, 'screened-tokens.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
const stats = readFileSync(join(dir, 'token-stat.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
const trades = readFileSync(join(dir, 'trades.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));

const tokens = [
  // 7 Losers
  { symbol: '中国人能飞 (Lose)', mint: '5N2MztZWdDFtKUwcPNRJ5n5fezp92ptAgUpJeqfodpA5', group: 'LOSER' },
  { symbol: 'AI', mint: '8D7baPHHuaZNykLMNSkHD7PEKGLTc4UkyLy9k3LPcBVf', group: 'LOSER' },
  { symbol: 'FAUCET', mint: 'MhEYcMvbqQnDE55CEYDtRkNhn52Npp62UPYensHJnx7', group: 'LOSER' },
  { symbol: 'MORE', mint: 'GHwwJLawYUHbyCS6v7V223dPLN8esEW4xqSr15tRZoJ1', group: 'LOSER' },
  { symbol: 'PreStonks', mint: '55MRKXuovEdYjQy49fJpjSEg3fLqXn1gTSB2jnyzBoUU', group: 'LOSER' },
  { symbol: 'GROK (Lose)', mint: 'AY8HWcVgkr99NgrfR9jLKQWuPBsHNYVH62QESLexpump', group: 'LOSER' },
  { symbol: 'MONZ', mint: '6EVAPqUuujVq6poQBrBRVdH1y2j3VJqRXaBdrkehpump', group: 'LOSER' },

  // 10 Winners
  { symbol: 'Mike', mint: 'FGuKDD25whfGt8qypxJ5oLt1UidWmcn6Df3xCMnE7Kmd', group: 'WINNER' },
  { symbol: 'Luke', mint: 'AiR3QJ5g5yXzwcCDw39q2eVQePvw7o4pYzc4inKULuke', group: 'WINNER' },
  { symbol: '中国人能飞 (Win)', mint: 'FCpGbXZsdkggjqCASoUGFAym6ER3Njv4kgVDTJ9EF3aU', group: 'WINNER' },
  { symbol: 'FatElon', mint: 'haGcbYxVKD2CQWKfBFpCKFBqKMCjSJEJuq2KU2gpump', group: 'WINNER' },
  { symbol: 'BUTTHOLE', mint: 'CLdc3jny1jP1w5RmiDS5vpk5gowFLSP9HLf2SUAjwH1', group: 'WINNER' },
  { symbol: 'Launchify', mint: '8QkWgs2pQMgZe5uN3eCWU4cubGG9oUa8CGD7u9qapump', group: 'WINNER' },
  { symbol: 'WEPE', mint: 'J82c6FXjJ5hGminZRgW2AtqGPxYYFcwUkeuHrw3opump', group: 'WINNER' },
  { symbol: 'PAIN', mint: 'EAsqvvyNnKzL2gZrFPsToGRwyi6cPeB5ECitR15opump', group: 'WINNER' },
  { symbol: 'GROK (Win)', mint: '6YstkjZB97wt9cLus6STn1XkZupPp2VBAPSkPercpump', group: 'WINNER' },
  { symbol: 'DogRun', mint: 'J5bcap9Ly5oYDfSsumZtaLyS9vyWdKEGpy58yJybadYk', group: 'WINNER' }
];

console.log('| Token | Status | PnL | Peak | Holder (Scr / Entry) | Top 1 (%) | Top 3 (%) | Top 5 (%) | Dump 5s Pertama |');
console.log('|---|---|---|---|---|---|---|---|---|');

for (const t of tokens) {
  const buy = simulatedTrades.find(x => x.type === 'SIMULATED_BUY' && x.mint === t.mint);
  const sell = simulatedTrades.find(x => x.type === 'SIMULATED_SELL' && x.mint === t.mint);
  const screened = screenedTokens.find(x => x.mint === t.mint);
  const buyTime = buy?.observedAt || 0;

  const statsBefore = stats.filter(x => x.mint === t.mint && x.observedAt <= buyTime);
  const statEntry = statsBefore[statsBefore.length - 1];

  const tradesBeforeBuy = trades.filter(x => x.mint === t.mint && x.observedAt <= buyTime);
  const walletNetTokens = new Map();
  for (const tr of tradesBeforeBuy) {
    const rawBa = Number(tr.raw?.ba || 0);
    const cur = walletNetTokens.get(tr.wallet) || 0;
    if (tr.side === 'buy') {
      walletNetTokens.set(tr.wallet, cur + rawBa);
    } else {
      walletNetTokens.set(tr.wallet, Math.max(0, cur - rawBa));
    }
  }

  const sortedHolders = Array.from(walletNetTokens.entries())
    .filter(([_, bal]) => bal > 0)
    .sort((a, b) => b[1] - a[1]);

  const totalCirculatingBeforeBuy = sortedHolders.reduce((acc, h) => acc + h[1], 0);

  const top1Bal = sortedHolders[0]?.[1] || 0;
  const top3Bal = sortedHolders.slice(0, 3).reduce((acc, h) => acc + h[1], 0);
  const top5Bal = sortedHolders.slice(0, 5).reduce((acc, h) => acc + h[1], 0);

  const top1Pct = totalCirculatingBeforeBuy > 0 ? (top1Bal / totalCirculatingBeforeBuy * 100).toFixed(1) + '%' : '-';
  const top3Pct = totalCirculatingBeforeBuy > 0 ? (top3Bal / totalCirculatingBeforeBuy * 100).toFixed(1) + '%' : '-';
  const top5Pct = totalCirculatingBeforeBuy > 0 ? (top5Bal / totalCirculatingBeforeBuy * 100).toFixed(1) + '%' : '-';

  const tradesAfterBuy = trades.filter(x => x.mint === t.mint && x.observedAt > buyTime && x.observedAt <= buyTime + 5000 && x.side === 'sell');
  const dumpedIn5sUsd = tradesAfterBuy.reduce((acc, x) => acc + (x.amountUsd || 0), 0);

  const pnl = sell ? (sell.pnlPercent > 0 ? '+' : '') + sell.pnlPercent.toFixed(1) + '%' : 'N/A';
  const peak = sell?.decision?.peakReturnPercent !== undefined ? '+' + sell.decision.peakReturnPercent.toFixed(1) + '%' : '-';
  const scrHolders = screened?.fields?.holders?.value ?? '-';
  const entryHolders = statEntry?.holderCount ?? '-';

  console.log(`| **${t.symbol}** | ${t.group} | ${pnl} | ${peak} | ${scrHolders} / ${entryHolders} | ${top1Pct} | ${top3Pct} | ${top5Pct} | $${dumpedIn5sUsd.toFixed(1)} |`);
}
