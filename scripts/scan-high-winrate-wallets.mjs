import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(__dirname, '../data');
const storeFile = join(dataDir, 'high-winrate-wallets.json');
const CDP_WS_URL = 'http://127.0.0.1:9223';
const BENCHMARK_WALLET = '3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34';

async function getCdpWsUrl() {
  try {
    const r = await fetch(`${CDP_WS_URL}/json`);
    const tabs = await r.json();
    const gmgnTab = tabs.find(t => t.url && t.url.includes('gmgn.ai')) || tabs.find(t => t.type === 'page');
    return gmgnTab?.webSocketDebuggerUrl || tabs[0]?.webSocketDebuggerUrl;
  } catch (err) {
    throw new Error(`Failed connecting to Chrome CDP on ${CDP_WS_URL}: ${err.message}`);
  }
}

export async function runScanHighWinrateWallets() {
  const wsUrl = await getCdpWsUrl();
  console.log(`[SCANNER-90] Connecting to Chrome CDP at ${wsUrl}...`);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[SCANNER-90] Connected to Chrome DevTools session. Injecting discovery task...');
      const expr = `
        (async () => {
          const BENCHMARK = '${BENCHMARK_WALLET}';
          const tags = ['launchpad_smart', 'smart_degen', 'pump_smart', 'sniper', 'fresh_wallet', 'kol', 'arbitrager'];
          const periods = ['7d', '30d'];
          const orderbys = ['pnl', 'winrate'];
          
          const tg = JSON.parse(localStorage.getItem('tgInfo') || '{}');
          const token = tg?.token?.access_token;
          const authHeaders = token ? { 'Authorization': 'Bearer ' + token } : {};
          const qs = 'device_id=2d641f4c-9eb7-4dda-8e7e-9a0e273b7757&client_id=gmgn_web_20261030-6104-e848387d&from_app=gmgn&app_ver=20261030-6104-e848387d&tz_name=Asia_Jakarta&tz_offset=25200&app_lang=en-US&os=web&worker=0';

          const walletsMap = new Map();

          // 1. Always include Benchmark Target Wallet
          walletsMap.set(BENCHMARK, {
            address: BENCHMARK,
            name: 'TARGET BENCHMARK (3azG8rmt...1b34)',
            avatar: 'https://gmgn.ai/static/halloween/logo_small2.png',
            tags: ['target_baseline', 'micro_rotator', 'smart_degen'],
            solBalance: 10.35,
            wr7d: 95.6,
            wr30d: 95.6,
            pnl7d: 430951,
            pnl30d: 432560,
            txs7d: 35075,
            txs30d: 35075,
            buy7d: 16643,
            sell7d: 18432,
            avgHold7dSec: 153, // ~2.5 min
            tokensCount: 310,
            isBenchmark: true,
            scannedAt: Date.now()
          });

          // 2. Fetch GMGN Rankings across tags, periods and orders
          for (const t of tags) {
            for (const p of periods) {
              for (const o of orderbys) {
                const u = 'https://gmgn.ai/defi/quotation/v1/rank/sol/wallets/' + p + '?tag=' + t + '&orderby=' + o + '_' + p + '&direction=desc&limit=100';
                try {
                  const res = await fetch(u).then(r => r.json());
                  for (const item of (res?.data?.rank || [])) {
                    const addr = item.wallet_address;
                    if (!addr) continue;

                    const wr7d = (item.winrate_7d !== undefined && item.winrate_7d !== null) ? Number(item.winrate_7d) : null;
                    const wr30d = (item.winrate_30d !== undefined && item.winrate_30d !== null) ? Number(item.winrate_30d) : null;
                    const pnl7d = parseFloat(item.realized_profit_7d || 0);
                    const pnl30d = parseFloat(item.realized_profit_30d || 0);
                    const txs7d = Number(item.txs_7d || item.txs || 0);
                    const txs30d = Number(item.txs_30d || 0);
                    const buy7d = Number(item.buy_7d || item.buy || 0);
                    const sell7d = Number(item.sell_7d || item.sell || 0);
                    const avgHold = Math.round(Number(item.avg_holding_period_7d || 0));

                    const existing = walletsMap.get(addr);
                    if (!existing) {
                      walletsMap.set(addr, {
                        address: addr,
                        name: item.name || item.twitter_name || '',
                        avatar: item.avatar || '',
                        tags: item.tags || [t],
                        solBalance: parseFloat(item.sol_balance || item.balance || 0),
                        wr7d: wr7d !== null ? Number((wr7d * 100).toFixed(1)) : 0,
                        wr30d: wr30d !== null ? Number((wr30d * 100).toFixed(1)) : 0,
                        pnl7d: Math.round(pnl7d),
                        pnl30d: Math.round(pnl30d),
                        txs7d,
                        txs30d,
                        buy7d,
                        sell7d,
                        avgHold7dSec: avgHold,
                        dailyProfits7d: item.daily_profit_7d || [],
                        isBenchmark: addr === BENCHMARK,
                        scannedAt: Date.now()
                      });
                    } else if (addr !== BENCHMARK) {
                      // Merge tags
                      const mergedTags = Array.from(new Set([...(existing.tags || []), ...(item.tags || [t])]));
                      existing.tags = mergedTags;
                      if (!existing.wr7d && wr7d) existing.wr7d = Number((wr7d * 100).toFixed(1));
                      if (!existing.wr30d && wr30d) existing.wr30d = Number((wr30d * 100).toFixed(1));
                    }
                  }
                } catch(e) {}
                await new Promise(r => setTimeout(r, 45));
              }
            }
          }

          return Array.from(walletsMap.values());
        })()
      `;

      ws.send(JSON.stringify({
        id: 100,
        method: 'Runtime.evaluate',
        params: { expression: expr, awaitPromise: true, returnByValue: true }
      }));
    });

    ws.on('message', (msg) => {
      const d = JSON.parse(msg.toString());
      if (d.id === 100) {
        ws.close();
        if (d.result?.exceptionDetails) {
          return reject(new Error(JSON.stringify(d.result.exceptionDetails)));
        }
        const rawWallets = d.result?.result?.value || [];
        resolve(rawWallets);
      }
    });

    ws.on('error', reject);
  });
}

export function processAndSaveWallets(rawWallets) {
  // Filter for Smart Wallets with high win rates or proven profitability
  // Category A: Win Rate >= 85% with positive PnL (True High Winrate Clones)
  // Category B: Win Rate >= 70% with high PnL (> $5k) and high volume
  // Plus Benchmark wallet
  const filtered = rawWallets.filter(w => {
    if (w.isBenchmark) return true;
    const maxWr = Math.max(w.wr7d || 0, w.wr30d || 0);
    const maxPnl = Math.max(w.pnl7d || 0, w.pnl30d || 0);
    const totTxs = Math.max(w.txs7d || 0, w.txs30d || 0);

    // 1. High Win Rate tier (WR >= 80% & PnL > $500 & Txs >= 5)
    if (maxWr >= 80 && maxPnl >= 500 && totTxs >= 5) return true;

    // 2. Scalper / Rotator tier (WR >= 70% & PnL >= $3000 & Txs >= 30)
    if (maxWr >= 70 && maxPnl >= 3000 && totTxs >= 30) return true;

    // 3. Super High Winrate micro-trader (WR >= 90% & PnL > 0 & Txs >= 3)
    if (maxWr >= 90 && maxPnl > 0 && totTxs >= 3) return true;

    return false;
  });

  // Calculate similarity score vs benchmark 3azG
  // Benchmark attributes: WR ~ 95%, Hold ~ 150-500s, Txs high, PnL > $100k
  for (const w of filtered) {
    if (w.isBenchmark) {
      w.similarityScore = 100;
      w.archetype = 'Target Benchmark (Original)';
      continue;
    }

    let score = 0;
    const wr = Math.max(w.wr7d, w.wr30d);
    if (wr >= 95) score += 40;
    else if (wr >= 90) score += 35;
    else if (wr >= 80) score += 25;
    else if (wr >= 70) score += 15;

    // PnL scoring
    const pnl = Math.max(w.pnl7d, w.pnl30d);
    if (pnl >= 100000) score += 30;
    else if (pnl >= 30000) score += 25;
    else if (pnl >= 10000) score += 20;
    else if (pnl >= 2000) score += 10;

    // Fast rotation / hold time (< 30 minutes like 3azG)
    const hold = w.avgHold7dSec;
    if (hold > 0 && hold <= 600) score += 20; // super fast <= 10m
    else if (hold > 0 && hold <= 3600) score += 15; // <= 1 hour
    else if (hold > 0 && hold <= 86400) score += 5;

    // High frequency txs
    const txs = Math.max(w.txs7d, w.txs30d);
    if (txs >= 300) score += 10;
    else if (txs >= 50) score += 5;

    w.similarityScore = Math.min(score, 99);

    if (wr >= 90 && txs >= 20) {
      w.archetype = '🎯 High WR Scalper (>90%)';
    } else if (hold > 0 && hold <= 600 && pnl >= 10000) {
      w.archetype = '⚡ Micro-Rotator Clone';
    } else if (pnl >= 50000) {
      w.archetype = '💎 High-Roller Smart Money';
    } else if (wr >= 80) {
      w.archetype = '🔥 High-Precision Trader';
    } else {
      w.archetype = '🚀 Momentum Trader';
    }
  }

  // Sort: Benchmark first, then similarityScore desc, then maxWr desc, then maxPnl desc
  filtered.sort((a, b) => {
    if (a.isBenchmark) return -1;
    if (b.isBenchmark) return 1;
    if (b.similarityScore !== a.similarityScore) return b.similarityScore - a.similarityScore;
    const wrB = Math.max(b.wr7d, b.wr30d);
    const wrA = Math.max(a.wr7d, a.wr30d);
    if (wrB !== wrA) return wrB - wrA;
    return Math.max(b.pnl7d, b.pnl30d) - Math.max(a.pnl7d, a.pnl30d);
  });

  const payload = {
    updatedAt: new Date().toISOString(),
    totalDiscovered: rawWallets.length,
    totalCurated: filtered.length,
    benchmarkWallet: BENCHMARK_WALLET,
    wallets: filtered
  };

  writeFileSync(storeFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`[SCANNER-90] Saved ${filtered.length} high-winrate wallets to ${storeFile}`);
  return payload;
}

if (process.argv[1] && process.argv[1].endsWith('scan-high-winrate-wallets.mjs')) {
  console.log('🚀 Starting GMGN High-Winrate Smart Wallet Scanner...');
  runScanHighWinrateWallets()
    .then(raw => {
      const saved = processAndSaveWallets(raw);
      console.log(`✅ Scan completed successfully. Found ${saved.totalCurated} high winrate smart wallets!`);
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ Scanner failed:', err);
      process.exit(1);
    });
}
