import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

async function main() {
  const root = process.cwd();
  const eventsPath = join(root, "data", "convergence-monitor-events.json");
  if (!existsSync(eventsPath)) {
    console.log("File not found:", eventsPath);
    return;
  }

  const events = JSON.parse(readFileSync(eventsPath, "utf8"));
  console.log(`Loaded ${events.length} events from ${eventsPath}`);

  // Find unique mints
  const uniqueMints = Array.from(new Set(events.map(e => e.mint).filter(Boolean)));
  console.log(`Found ${uniqueMints.length} unique mints to check on GMGN...`);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const context = browser.contexts()[0];
  const page = context.pages().find(p => p.url().includes("gmgn.ai")) || context.pages()[0];

  const mintTraderMap = new Map();

  for (let i = 0; i < uniqueMints.length; i++) {
    const mint = uniqueMints[i];
    const params = "device_id=2d641f4c-9eb7-4dda-8e7e-9a0e273b7757&client_id=gmgn_web_20261023-5847-47b0c03&from_app=gmgn&app_ver=20261023-5847-47b0c03&tz_name=Asia_Jakarta&tz_offset=25200&app_lang=en-US&os=web&worker=0";
    const url = `https://gmgn.ai/vas/api/v1/token_traders/sol/${mint}?${params}&limit=100&orderby=profit&direction=desc`;
    try {
      const res = await page.evaluate(async (endpoint) => {
        try {
          const resp = await fetch(endpoint);
          return await resp.json();
        } catch (e) {
          return { error: e.message };
        }
      }, url);

      const list = res.data?.list || [];
      const traderMap = new Map(list.map(t => [t.address, t]));
      mintTraderMap.set(mint, traderMap);
      process.stdout.write(`\r[${i + 1}/${uniqueMints.length}] Fetched traders for ${mint.slice(0, 8)}... (${list.length} traders)`);
    } catch (err) {
      // ignore
    }
    await new Promise(r => setTimeout(r, 120));
  }
  console.log("\nFinished fetching traders from GMGN.");

  let enrichedCount = 0;
  for (const ev of events) {
    const traderMap = mintTraderMap.get(ev.mint);
    if (!traderMap || !ev.walletEntries) continue;

    for (const we of ev.walletEntries) {
      const tr = traderMap.get(we.wallet);
      if (tr) {
        const exitTime = tr.end_holding_at ? Number(tr.end_holding_at) : null;
        const isHolding = (Number(tr.amount_cur || 0) > 0) || !exitTime;
        const exitDate = exitTime ? new Date(exitTime * 1000) : null;
        const exitedAtWib = exitDate ? exitDate.toLocaleTimeString("id-ID", {
          timeZone: "Asia/Jakarta",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }) + " WIB" : (isHolding ? "HOLDING" : null);

        const startTs = tr.start_holding_at || we.timestamp;
        const durSec = exitTime ? Math.max(0, exitTime - startTs) : Math.max(0, Math.floor(Date.now() / 1000) - startTs);
        const durM = Math.floor(durSec / 60);
        const durS = durSec % 60;
        const holdingDurationStr = durM > 0 ? `${durM}m ${durS}s` : `${durS}s`;

        const profitUsd = Math.round(Number(tr.profit ?? tr.realized_profit ?? 0));
        const pnlPercent = Number(((tr.realized_pnl ?? 0) * 100).toFixed(1));
        const totalCostUsd = Math.round(Number(tr.total_cost ?? tr.cost_cur ?? 0));

        we.exitedAt = exitDate ? exitDate.toISOString() : null;
        we.exitedAtWib = exitedAtWib;
        we.exitTimestamp = exitTime;
        we.holdingDurationSec = durSec;
        we.holdingDurationStr = holdingDurationStr;
        we.isHolding = isHolding;
        we.profitUsd = profitUsd;
        we.pnlPercent = pnlPercent;
        we.totalCostUsd = totalCostUsd;
        enrichedCount++;
      }
    }
  }

  writeFileSync(eventsPath, JSON.stringify(events, null, 2), "utf8");
  console.log(`✅ Successfully enriched ${enrichedCount} wallet entries in ${eventsPath}!`);
  await browser.close();
}

main().catch(err => {
  console.error("Enrichment error:", err);
  process.exit(1);
});
