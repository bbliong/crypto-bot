import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

const db = new DatabaseSync('data/crypto-bot.sqlite');
const wins = db.prepare("SELECT mint FROM trades WHERE trade_return_percent > 30").all();
const mints = new Set(wins.map(w => w.mint));

const researchDir = './research';
const dirs = readdirSync(researchDir).filter(d => d.startsWith('momentum-aggressive-')).sort();

let totalEntryMc = 0;
let count = 0;
const matched = new Set();

for (const dir of dirs) {
    const file = join(researchDir, dir, 'token-summary.jsonl');
    if (existsSync(file)) {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
            try {
                const token = JSON.parse(line);
                if (mints.has(token.mint) && !matched.has(token.mint) && token.openingPriceUsd) {
                    matched.add(token.mint);
                    const mc = token.openingPriceUsd * 1000000000;
                    totalEntryMc += mc;
                    count++;
                }
            } catch(e) {}
        }
    }
}
if (count > 0) {
    console.log(`Average Entry MC: $${(totalEntryMc / count).toFixed(0)}`);
}
