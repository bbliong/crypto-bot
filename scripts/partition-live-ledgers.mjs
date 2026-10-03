import fs from 'node:fs';
import path from 'node:path';
import { getWibSlot } from './crypto-db.mjs';

const projectRoot = process.cwd();
const researchDir = path.join(projectRoot, 'research');

const allLedgers = [];
for (const entry of fs.readdirSync(researchDir, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    const p = path.join(researchDir, entry.name, 'live-trade-ledger.jsonl');
    if (fs.existsSync(p)) allLedgers.push(p);
  }
}

const linesBySlot = new Map();
let totalLines = 0;

for (const p of allLedgers) {
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  totalLines += lines.length;
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      const time = item.observedAt || (item.buy?.time) || (item.time);
      if (time) {
        const slot = getWibSlot(new Date(time), 3);
        const cur = linesBySlot.get(slot.runId) || [];
        cur.push(line);
        linesBySlot.set(slot.runId, cur);
      }
    } catch {}
  }
}

console.log('Total live ledger lines across disk:', totalLines);
for (const [slotId, lines] of linesBySlot.entries()) {
  const targetDir = path.join(researchDir, slotId);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  const targetFile = path.join(targetDir, 'live-trade-ledger.jsonl');
  fs.writeFileSync(targetFile, lines.join('\n') + '\n');
  console.log(`  -> Written ${lines.length} lines to ${slotId}/live-trade-ledger.jsonl`);
}
console.log('✅ Selesai mempartisi live-trade-ledger.jsonl ke seluruh slot kanonikal!');
