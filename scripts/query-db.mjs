import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('data/crypto-bot.sqlite');
const counts = db.prepare("SELECT date(created_at) as day, COUNT(*) as trade_count FROM trades GROUP BY day ORDER BY day DESC").all();
console.log(counts);
