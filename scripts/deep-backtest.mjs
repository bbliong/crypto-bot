import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const db = new DatabaseSync('data/crypto-bot.sqlite');
const wins = db.prepare("SELECT mint, trade_return_percent, date(created_at) as day FROM trades WHERE trade_return_percent > 30 ORDER BY trade_return_percent DESC LIMIT 100").all();
const mints = new Set(wins.map(w => w.mint));

const researchDir = './research';
const dirs = readdirSync(researchDir).filter(d => d.startsWith('momentum-aggressive-')).sort();

let totalHolders = 0;
let totalBuys = 0;
let totalSells = 0;
let matchedCount = 0;
const matchedMints = new Set();

for (const dir of dirs) {
    const file = join(researchDir, dir, 'token-summary.jsonl');
    if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const token = JSON.parse(line);
                if (mints.has(token.mint) && !matchedMints.has(token.mint) && token.comparison?.recent60Seconds) {
                    matchedMints.add(token.mint);
                    matchedCount++;
                    totalHolders += token.comparison.recent60Seconds.activeKnownWallets || 0;
                    totalBuys += token.comparison.recent60Seconds.buys || 0;
                    totalSells += token.comparison.recent60Seconds.sells || 0;
                }
            } catch(e) {}
        }
    }
}

console.log(`Matched ${matchedCount} tokens out of ${mints.size} highly profitable tokens (>30% profit).`);
if (matchedCount > 0) {
    console.log(`\n=== AVERAGE STATS IN FIRST 60 SECONDS (For Winning Tokens) ===`);
    console.log(`Average Holders: ${(totalHolders / matchedCount).toFixed(0)} unique wallets`);
    console.log(`Average Buys: ${(totalBuys / matchedCount).toFixed(0)} txs`);
    console.log(`Average Sells: ${(totalSells / matchedCount).toFixed(0)} txs`);
    console.log(`Average Total Tx: ${((totalBuys + totalSells) / matchedCount).toFixed(0)} txs`);
}
