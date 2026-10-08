import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const db = new DatabaseSync(join(process.cwd(), 'data', 'crypto-bot.sqlite'));

const stmt = db.prepare("DELETE FROM runs WHERE id LIKE '%-2026-09-%' OR id LIKE '%202609%'");
const result = stmt.run();
console.log(`Deleted ${result.changes} old runs from the database.`);

const stmt2 = db.prepare("DELETE FROM trades WHERE run_id LIKE '%-2026-09-%' OR run_id LIKE '%202609%'");
const res2 = stmt2.run();
console.log(`Deleted ${res2.changes} old trades from the database.`);

const stmt3 = db.prepare("DELETE FROM route_quotes WHERE run_id LIKE '%-2026-09-%' OR run_id LIKE '%202609%'");
const res3 = stmt3.run();
console.log(`Deleted ${res3.changes} old route quotes from the database.`);

db.exec("VACUUM");
console.log("Database vacuumed to reclaim space.");
db.close();
