import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [output, optimizerOutput] = process.argv.slice(2);
if (!output || !optimizerOutput) throw new Error('Usage: node scripts/trigger-mc-optimizer-pause.mjs <run-dir> <optimizer-dir>');
const pauseFile = join(output, 'optimizer-pause-intake.json');
if (existsSync(pauseFile)) throw new Error('Optimizer pause is already active');
const activeDetails = () => {
  try { const status = JSON.parse(readFileSync(join(output, 'formula-live-status.json'), 'utf8')); return Array.isArray(status.activeSessions) ? status.activeSessions.length : 0; }
  catch { return 0; }
};
writeFileSync(pauseFile, JSON.stringify({ reason: 'manual optimizer pause test', startedAt: Date.now() }, null, 2));
console.log('[optimizer-pause-test] intake paused; waiting active details=', activeDetails());
const deadline = Date.now() + 130_000;
while (activeDetails() > 0 && Date.now() < deadline) await delay(500);
console.log('[optimizer-pause-test] starting optimizer; active details=', activeDetails());
const child = spawn(process.execPath, ['scripts/optimize-mc-momentum.mjs', optimizerOutput], { cwd: process.cwd(), stdio: 'inherit' });
const code = await new Promise(resolve => child.once('exit', resolve));
if (existsSync(pauseFile)) unlinkSync(pauseFile);
console.log('[optimizer-pause-test] intake resumed; optimizer exit=', code);
process.exitCode = code ?? 1;
