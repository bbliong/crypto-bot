import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const SEED_TOKENS = [
  { name: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { name: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { name: 'PNUT', mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump' },
  { name: 'GOAT', mint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump' },
  { name: 'MOODENG', mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY' },
  { name: 'ACT', mint: 'GJAFwWjJ3vnTsrQVabjBVK2TYB1YtRCQXRDfDgUnpump' },
  { name: 'BOME', mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82' },
  { name: 'GIGA', mint: '63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9' },
  { name: 'SLERF', mint: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3' },
  { name: 'MEW', mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
  { name: 'LUCE', mint: 'CBdCxKo9QavR9hfPyJxR9vvRE8KAkQQJ2r24GZGOpump' },
  { name: 'BAN', mint: '9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump' },
  { name: 'CHILLGUY', mint: 'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump' },
  { name: 'ZEREBRO', mint: '8x5VqbHA8D7NkD52uNuS5nnt3PwA8pLD34ymskeSo2Wn' },
  { name: 'AI16Z', mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC' }
];

const BOT_TAGS = new Set([
  'sandwich_bot',
  'mev_bot',
  'arbitrage_bot',
  'bot',
  'scammer',
  'phishing'
]);

async function main() {
  console.log(`[HARVEST] Menghubungkan ke Chrome CDP port 9223...`);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
  const page = browser.contexts()[0].pages().find(p => p.url().includes('gmgn.ai'));
  if (!page) {
    throw new Error('Tab GMGN tidak ditemukan pada Chrome CDP port 9223');
  }
  console.log(`[HARVEST] Terhubung ke tab GMGN: ${page.url()}`);

  const qParams = {
    device_id: '2d641f4c-9eb7-4dda-8e7e-9a0e273b7757',
    tab_id: 'mv9ilwm2y8a7',
    fp_did: '53b08a7a5aa335d9621f3643748ed83f',
    client_id: 'gmgn_web_20261015-5468-4781410',
    from_app: 'gmgn',
    app_ver: '20261015-5468-4781410',
    tz_name: 'Asia_Jakarta',
    tz_offset: '25200',
    app_lang: 'en-US',
    os: 'web',
    worker: '0'
  };

  // Step 1: Kumpulkan semua early buyers dari seed tokens
  console.log(`[HARVEST] Mengambil early buyers dari ${SEED_TOKENS.length} seed token legendaris...`);
  const earlyBuyersMap = new Map(); // address -> { address, tokens: [], tags: [] }

  for (const token of SEED_TOKENS) {
    try {
      const res = await page.evaluate(async ({ mint, qParams }) => {
        const q = new URLSearchParams(qParams);
        const r = await fetch(`https://gmgn.ai/api/v1/tokens/top_buyers/sol/${mint}?${q.toString()}`);
        const j = await r.json().catch(() => null);
        return j?.data?.holders?.holderInfo || [];
      }, { mint: token.mint, qParams });

      let added = 0;
      for (const h of res) {
        const addr = h.wallet_address;
        if (!addr || addr.length < 32) continue;

        const tags = (h.tags || []).concat(h.maker_token_tags || []);
        const isBot = tags.some(t => BOT_TAGS.has(t.toLowerCase()));
        if (isBot) continue;

        if (!earlyBuyersMap.has(addr)) {
          earlyBuyersMap.set(addr, { address: addr, tokens: [token.name], tags });
          added++;
        } else {
          earlyBuyersMap.get(addr).tokens.push(token.name);
        }
      }
      console.log(`  ✓ ${token.name}: ${res.length} buyers ditemukan, ${added} kandidat wallet non-bot unik baru.`);
      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      console.error(`  ✗ ${token.name} gagal:`, err.message);
    }
  }

  const candidateList = Array.from(earlyBuyersMap.values());
  console.log(`[HARVEST] Total kandidat wallet unik non-bot: ${candidateList.length}`);

  // Step 2: Audit aktivitas 30 hari & PnL via parallel workers (concurrency 10)
  console.log(`[HARVEST] Memulai verifikasi aktivitas 30 hari & performa (concurrency: 10)...`);
  const nowSec = Math.floor(Date.now() / 1000);
  const thirtyDaysAgoSec = nowSec - 30 * 24 * 3600;

  const validSmartWallets = [];
  const chunkSize = 10;

  for (let i = 0; i < candidateList.length; i += chunkSize) {
    const chunk = candidateList.slice(i, i + chunkSize);
    const audited = await page.evaluate(async ({ chunk, qParams, thirtyDaysAgoSec }) => {
      const q = new URLSearchParams(qParams);
      const results = [];
      for (const item of chunk) {
        try {
          const r = await fetch(`https://gmgn.ai/defi/quotation/v1/smartmoney/sol/walletNew/${item.address}?${q.toString()}`);
          const j = await r.json().catch(() => null);
          const d = j?.data;
          if (!d) {
            results.push({ ...item, pass: false, reason: 'NO_DATA' });
            continue;
          }

          if (d.is_contract) {
            results.push({ ...item, pass: false, reason: 'CONTRACT' });
            continue;
          }

          const lastActive = d.last_active_timestamp || 0;
          const trades30d = (d.buy_30d || 0) + (d.sell_30d || 0);
          const pnl30d = d.realized_profit_30d || d.pnl_30d || 0;
          const allPnl = d.total_profit || d.all_pnl || 0;

          // Syarat lolos manusia pintar (Whale / Insider / Smart Trader):
          // 1. Masih aktif trading dalam 30 hari terakhir
          // 2. Transaksi wajar manusia: antara 1 s/d 3.000 trade per bulan (bukan HFT MEV bot jutaan transaksi)
          // 3. Profitabilitas nyata: total profit > $1,000 atau profit 30d > $0
          const isActive30d = lastActive >= thirtyDaysAgoSec;
          const isHumanTradeVolume = trades30d >= 1 && trades30d <= 3000;
          const isRealProfitable = allPnl >= 1000 || pnl30d > 0;

          if (isActive30d && isHumanTradeVolume && isRealProfitable) {
            results.push({
              address: item.address,
              seedTokens: item.tokens,
              tags: item.tags,
              solBalance: Number(d.sol_balance) || 0,
              totalProfitUsd: allPnl,
              realizedProfit30dUsd: pnl30d,
              winrate: d.winrate ? (d.winrate * 100).toFixed(1) + '%' : 'N/A',
              trades30d,
              lastActiveAt: new Date(lastActive * 1000).toISOString(),
              pass: true
            });
          } else {
            results.push({
              ...item,
              pass: false,
              reason: !isActive30d ? 'INACTIVE_30D' : (!isHumanTradeVolume ? 'BOT_HIGH_FREQUENCY' : 'LOW_PROFIT')
            });
          }
        } catch (e) {
          results.push({ ...item, pass: false, reason: 'FETCH_ERROR' });
        }
      }
      return results;
    }, { chunk, qParams, thirtyDaysAgoSec });

    for (const res of audited) {
      if (res.pass) {
        validSmartWallets.push(res);
        console.log(`  🌟 [SMART HUMAN WHALE] ${res.address.slice(0, 8)}... | Tokens: ${res.seedTokens.join(',')} | 30d Trades: ${res.trades30d} | Total Profit: +$${Math.round(res.totalProfitUsd).toLocaleString()}`);
      }
    }

    if ((i + chunkSize) % 50 === 0 || i + chunkSize >= candidateList.length) {
      console.log(`  Processed ${Math.min(i + chunkSize, candidateList.length)}/${candidateList.length} candidate wallets... (Found: ${validSmartWallets.length})`);
    }
    await new Promise(r => setTimeout(r, 40));
  }

  // Simpan output ke file JSON
  const outputDir = '/home/bbliong/project/crypto-bot/data';
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, 'smart-wallets-watchlist.json');

  const payload = {
    updatedAt: new Date().toISOString(),
    seedTokensCount: SEED_TOKENS.length,
    totalAudited: candidateList.length,
    activeSmartWalletsCount: validSmartWallets.length,
    wallets: validSmartWallets.sort((a, b) => b.totalProfitUsd - a.totalProfitUsd)
  };

  writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`\n✅ [SELESAI] ${validSmartWallets.length} Smart Money Wallets berhasil disimpan ke: ${outputPath}`);

  await browser.close();
}

main().catch(err => {
  console.error('[ERROR] Harvesting gagal:', err);
  process.exit(1);
});
