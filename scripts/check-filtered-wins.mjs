
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function findFiles(dir, name) {
  let res = [];
  try {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) res.push(...findFiles(full, name));
      else if (item === name) res.push(full);
    }
  } catch (e) {}
  return res;
}

const baseDir = "data/profit4-watch";
const runs = fs.readdirSync(baseDir).filter(d => {
  try { return fs.statSync(path.join(baseDir, d)).isDirectory(); } catch { return false; }
});

const closedPositions = [];
for (const r of runs) {
  const statePath = path.join(baseDir, r, "profit4-state.json");
  if (!fs.existsSync(statePath)) continue;
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const p of state.positions || []) {
      if (p.netReturnPercent !== null && p.netReturnPercent !== undefined) {
        closedPositions.push({ ...p, run: r });
      }
    }
  } catch (e) {}
}

const tokensMap = new Map();
for (const p of closedPositions) {
  if (!tokensMap.has(p.mint)) tokensMap.set(p.mint, []);
  tokensMap.get(p.mint).push(p);
}

const tradeFiles = findFiles(baseDir, "token-trades.jsonl");
const mintTrades = new Map();
const allMints = Array.from(tokensMap.keys());
for (const m of allMints) mintTrades.set(m, []);
const mintSet = new Set(allMints);

for (const f of tradeFiles) {
  const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      if (j.mint && mintSet.has(j.mint) && (j.price || j.priceUsd)) {
        mintTrades.get(j.mint).push({
          time: j.observedAt || (j.timestamp ? j.timestamp * 1000 : 0),
          price: j.price || j.priceUsd,
          side: j.side,
          usd: j.usd || 0,
        });
      }
    } catch(e) {}
  }
}
for (const [m, trades] of mintTrades.entries()) trades.sort((a, b) => a.time - b.time);

const filteredWins = [];

for (const [mint, positions] of tokensMap.entries()) {
  const v1Pos = positions.find(p => p.laneLabel === "V1" || p.version?.includes("v1") || !p.laneLabel);
  if (!v1Pos || v1Pos.netReturnPercent <= 0) continue; // Only V1 WINs

  const symbol = v1Pos.symbol || mint.slice(0, 8);
  const trades = mintTrades.get(mint) || [];

  let peak = 0, trough = Infinity, dumpOccurred = false;
  let step1 = null, staircaseConfirmed = false;
  let filterReason = "";

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (t.price > peak) { peak = t.price; trough = t.price; }
    else if (t.price < trough) trough = t.price;

    const dd = peak > 0 ? ((peak - t.price) / peak) * 100 : 0;
    if (dd >= 60) dumpOccurred = true;

    if (!dumpOccurred) continue;
    const bounce = trough > 0 ? ((t.price - trough) / trough) * 100 : 0;

    if (!step1 && bounce >= 3.5 && bounce <= 15.0) {
      step1 = { price: t.price, time: t.time, troughAtStep: trough };
      continue;
    }

    if (step1 && !staircaseConfirmed) {
      const dt = (t.time - step1.time) / 1000;
      if (dt < 2.0) {
        if (t.price < step1.troughAtStep) { filterReason = "Tembus Trough Baru (<2s)"; break; }
      } else if (dt >= 2.0 && dt <= 6.0) {
        if (t.price < step1.troughAtStep) { filterReason = "Tembus Trough Saat Konfirmasi"; break; }
        else if (t.price < step1.price * 0.90) { filterReason = "Spike Ambruk >10% dalam 3 detik"; break; }
        else if (bounce > 18.0) { filterReason = "Overextended >18% (Naik terlalu tinggi duluan)"; break; }
        else if (t.price >= step1.price * 0.97) {
          staircaseConfirmed = true;
          break;
        }
      } else if (dt > 6.0) {
        filterReason = "Tidak Ada Kenaikan Lanjutan (>6s)";
        break;
      }
    }
  }

  if (!dumpOccurred) filterReason = "Tidak Dump >= 60% (Bukan Pola Bounce)";
  else if (!step1 && !filterReason) filterReason = "Pantulan < 3.5% (Tidak Ada Reversal Cukup)";

  if (!staircaseConfirmed) {
    filteredWins.push({
      symbol,
      mint: mint.slice(0, 8),
      v1Net: Number(v1Pos.netReturnPercent.toFixed(1)),
      v1Reason: v1Pos.lastEvent?.reason || v1Pos.reason || "-",
      v1HoldSec: v1Pos.entryAt && v1Pos.exitAt ? Math.round((v1Pos.exitAt - v1Pos.entryAt) / 1000) : 0,
      filterReason: filterReason || "Tidak Memenuhi Konfirmasi"
    });
  }
}

console.log("Total V1 WIN tokens filtered out:", filteredWins.length);
console.log("\nKATEGORI ALASAN TOKEN WIN TERFILTER:");
const cat = {};
for (const f of filteredWins) {
  cat[f.filterReason] = (cat[f.filterReason] || 0) + 1;
}
console.table(cat);

console.log("\nDETAIL TOKEN WIN YANG TERFILTER:");
console.table(filteredWins);
