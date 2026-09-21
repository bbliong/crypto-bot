import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { decodeFrame, parseCandidates } from './parser.js';
import { evaluate } from './risk.js';
import { Store } from './store.js';
const [file, configPath] = process.argv.slice(2);
if (!file) throw new Error('Usage: npm run replay -- frames.jsonl [config/rules.yaml]');
const cfg = loadConfig(configPath); cfg.mode = 'observation';
const store = new Store(':memory:');
let total = 0, candidates = 0;
try {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
    total++; const frame = decodeFrame(line); if (!frame) continue;
    for (const update of parseCandidates(frame, cfg.mappings, Date.now(), 'local-replay')) {
      candidates++; const c = store.merge(update); const r = evaluate(c, cfg);
      console.log(JSON.stringify({ mint: c.mint, status: r.status, checks: r.checks }));
    }
  }
  console.log(JSON.stringify({ frames: total, candidateUpdates: candidates }));
} finally { store.close(); }
