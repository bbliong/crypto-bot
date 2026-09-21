import { DatabaseSync } from 'node:sqlite';

const [mint, windowSeconds = '120'] = process.argv.slice(2);
if (!mint) throw new Error('Usage: analyze-activity.mjs <mint> [windowSeconds]');
const cutoff = Date.now() - Number(windowSeconds) * 1000;
const db = new DatabaseSync('data/monitor.sqlite', { readOnly: true });
try {
  const events = db.prepare(`SELECT side,occurred_at,observed_at,price_usd,actor_hash
    FROM token_activity WHERE mint=? AND observed_at>=? ORDER BY occurred_at`).all(mint, cutoff);
  const bySecond = db.prepare(`SELECT occurred_at,
    SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) AS sells,
    SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) AS buys,
    COUNT(DISTINCT CASE WHEN side='sell' THEN actor_hash END) AS unique_seller_hashes,
    COUNT(DISTINCT CASE WHEN side='buy' THEN actor_hash END) AS unique_buyer_hashes
    FROM token_activity WHERE mint=? AND observed_at>=? GROUP BY occurred_at ORDER BY occurred_at`).all(mint, cutoff);
  console.log(JSON.stringify({ mint, windowSeconds: Number(windowSeconds), events, bySecond }, null, 2));
} finally { db.close(); }
