import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (!process.argv.includes('--paperLane')) process.argv.push('--paperLane', 'profit4');
if (!process.argv.includes('--dataDir')) process.argv.push('--dataDir', 'data/profit4-watch');
register();
try { await import('../src/distribution-watch-four-tabs.ts'); }
catch (error) {
  const directory = 'data/profit4-watch'; mkdirSync(directory, { recursive: true });
  let current; try { current = JSON.parse(readFileSync(directory + '/worker-control.json', 'utf8')); } catch {}
  if (!current || current.pid === process.pid) writeFileSync(directory + '/worker-control.json', JSON.stringify({ ...current,
    pid: process.pid, mode: 'profit4-watch', status: 'failed', lastError: error instanceof Error ? error.message : String(error) }));
  console.error(error); process.exitCode = 1;
}
