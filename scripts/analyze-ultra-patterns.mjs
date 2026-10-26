import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const TARGET_REF = "3azG8rmtPnNUz77a6UqBKt1ykpk3JQpLLNTaoXW31b34";
const db = new DatabaseSync("data/crypto-bot.sqlite");

// Ambil top 30 wallet ULTRA berdasarkan profit 60 hari
const ultraRows = db.prepare(`
  SELECT address, total_net_pnl, win_day_rate, positive_days, total_days, tier_at_audit 
  FROM wallet_daily_profit_audits 
  WHERE is_ultra = 1 
  ORDER BY total_net_pnl DESC 
  LIMIT 35
`).all();

console.log(`Menguji ${ultraRows.length} wallet ULTRA terhadap pola referensi 3azG8rmt...`);

async function run() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find(p => p.url().includes("3azG8rmt")) || pages[1];

  const results = [];

  for (let i = 0; i < ultraRows.length; i++) {
    const row = ultraRows[i];
    const addr = row.address;

    try {
      const data = await page.evaluate(async (a) => {
        try {
          const res = await fetch(`/defi/quotation/v1/smartmoney/sol/walletNew/${a}`);
          return await res.json();
        } catch (e) {
          return { code: -1, msg: e.message };
        }
      }, addr);

      if (data.code === 0 && data.data) {
        const d = data.data;
        const totalTrades30d = (d.buy_30d || 0) + (d.sell_30d || 0);
        const totalTrades7d = (d.buy_7d || 0) + (d.sell_7d || 0);
        const lastActive = d.last_active_timestamp ? new Date(d.last_active_timestamp * 1000) : null;
        const solBal = parseFloat(d.sol_balance || "0");
        const realized30d = d.realized_profit_30d || 0;
        const realized7d = d.realized_profit_7d || 0;
        const pnl30dPct = (d.pnl_30d || 0) * 100;
        const pnl7dPct = (d.pnl_7d || 0) * 100;

        // Kriteria Kemiripan Pola (Pattern Similarity Score):
        // 1. High Frequency Scalper: totalTrades30d >= 5,000 (ribuan transaksi per bulan)
        // 2. Micro ROI Turnover: PnL % moderat (1% - 50%), bukan 500%+ moonbag
        // 3. Active recently: aktif dalam 24 jam terakhir
        // 4. Sol Balance: modal wajar (5 - 200 SOL)
        const isHFT = totalTrades30d >= 5000;
        const isMicroRoi = pnl30dPct > 0 && pnl30dPct < 60;
        const isRecentlyActive = d.last_active_timestamp && (Date.now() / 1000 - d.last_active_timestamp < 86400 * 3);

        let matchType = "OTHER";
        if (isHFT && isMicroRoi) {
          matchType = "IDENTICAL_MICRO_SCALPER"; // Kembaran persis 3azG8rmt
        } else if (isHFT) {
          matchType = "HIGH_FREQUENCY_TRADER";
        } else if (totalTrades30d >= 1000) {
          matchType = "MEDIUM_FREQUENCY_SWING";
        } else {
          matchType = "LOW_FREQ_SNIPER";
        }

        results.push({
          address: addr,
          isRef: addr === TARGET_REF,
          matchType,
          solBalance: solBal.toFixed(1),
          totalTrades30d,
          totalTrades7d,
          buy30d: d.buy_30d || 0,
          sell30d: d.sell_30d || 0,
          realizedProfit30dUsd: Math.round(realized30d),
          pnl30dPct: pnl30dPct.toFixed(1) + "%",
          realizedProfit7dUsd: Math.round(realized7d),
          pnl7dPct: pnl7dPct.toFixed(1) + "%",
          winDayRate: row.win_day_rate.toFixed(1) + "%",
          lastActiveWib: lastActive ? lastActive.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" }) : "N/A",
          lastActiveDate: lastActive ? lastActive.toISOString().slice(0, 10) : "N/A"
        });
      } else {
        console.log(`[SKIP] ${addr}: code ${data.code}`);
      }

      // Small jitter so we don't spam GMGN
      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`[ERR] ${addr}: ${err.message}`);
    }
  }

  console.log("\n=================== HASIL ANALISIS POLA ===================");
  console.log(`Total Wallet Dianalisis: ${results.length}`);

  const identical = results.filter(r => r.matchType === "IDENTICAL_MICRO_SCALPER");
  const hft = results.filter(r => r.matchType === "HIGH_FREQUENCY_TRADER");
  const medium = results.filter(r => r.matchType === "MEDIUM_FREQUENCY_SWING");
  const sniper = results.filter(r => r.matchType === "LOW_FREQ_SNIPER");

  console.log(`\n1. KEMBARAN IDENTIK (Identical Micro-Scalper): ${identical.length} wallet`);
  console.table(identical);

  console.log(`\n2. HIGH FREQUENCY LAINNYA (HFT >5k Trades): ${hft.length} wallet`);
  console.table(hft);

  console.log(`\n3. MEDIUM FREQUENCY (1k - 5k Trades): ${medium.length} wallet`);
  console.table(medium);

  console.log(`\n4. LOW FREQUENCY SNIPER (<1k Trades): ${sniper.length} wallet`);
  console.table(sniper.slice(0, 5));

  process.exit(0);
}

run();
