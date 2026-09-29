import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const readArg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const seconds = Number(readArg('seconds', '43200'));
const workers = Number(readArg('workers', '3'));
const intervalMinutes = Number(readArg('optimizerMinutes', '30'));
const output = readArg('output', join('research', `pump-band-12h-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const optimizerOutput = readArg('optimizerOutput', join('research', 'mc-formula-optimization-live'));
if (!Number.isInteger(seconds) || seconds < 60 || !Number.isInteger(workers) || workers < 1 || !Number.isFinite(intervalMinutes) || intervalMinutes < 5) {
  throw new Error('Invalid seconds, workers, or optimizerMinutes');
}
if (!existsSync('profiles/research-vps')) throw new Error('Profile research-vps tidak ditemukan');
mkdirSync(output, { recursive: true });

const statusFile = join(output, 'optimizer-supervisor-status.json');
const pauseFile = join(output, 'optimizer-pause-intake.json');
const startedAt = Date.now();
let optimizerRunning = false;
let lastOptimizer = null;
function writeStatus(status, extra = {}) {
  writeFileSync(statusFile, JSON.stringify({ status, startedAt, output, optimizerOutput, seconds, workers, intervalMinutes, lastOptimizer, observedAt: Date.now(), ...extra }, null, 2));
}
function activeDetailCount() {
  try { const status = JSON.parse(readFileSync(join(output, 'formula-live-status.json'), 'utf8')); return Array.isArray(status.activeSessions) ? status.activeSessions.length : 0; }
  catch { return 0; }
}
async function optimize() {
  if (optimizerRunning) return;
  optimizerRunning = true;
  lastOptimizer = { startedAt: Date.now(), status: 'pausing_intake' };
  writeFileSync(pauseFile, JSON.stringify({ reason: 'optimizer running', startedAt: Date.now() }, null, 2));
  writeStatus('pausing_intake');
  const drainDeadline = Date.now() + 130_000;
  while (activeDetailCount() > 0 && Date.now() < drainDeadline) await delay(500);
  lastOptimizer = { ...lastOptimizer, optimizerStartedAt: Date.now(), status: 'running', activeDetailsAtStart: activeDetailCount() };
  writeStatus('running');
  const child = spawn(process.execPath, ['scripts/optimize-mc-momentum.mjs', optimizerOutput], { cwd: process.cwd(), stdio: 'inherit' });
  child.once('exit', code => {
    optimizerRunning = false;
    if (existsSync(pauseFile)) unlinkSync(pauseFile);
    lastOptimizer = { ...lastOptimizer, finishedAt: Date.now(), status: code === 0 ? 'complete' : 'failed', exitCode: code };
    writeStatus('running');
  });
}

writeStatus('starting');
const collector = spawn(process.execPath, [
  'scripts/run.mjs', 'mc-momentum-research',
  '--seconds', String(seconds), '--workers', String(workers),
  '--detailSeconds', '30', '--maximumObservationSeconds', '120',
  '--minMarketCap', '40000', '--maxMarketCap', '2000000', '--maxAgeSeconds', '120', '--maxTop1Percent', '50',
  '--profileDir', 'profiles/research-vps', '--profileName', 'Default', '--output', output,
  '--activeFormula', join(optimizerOutput, 'active-formula.json'), '--pauseFile', pauseFile,
], { cwd: process.cwd(), stdio: 'inherit' });
console.log('[mc-study-supervisor]', JSON.stringify({ output, optimizerOutput, seconds, workers, intervalMinutes }));
optimize();
const timer = setInterval(optimize, intervalMinutes * 60_000);
collector.once('exit', code => {
  clearInterval(timer);
  writeStatus(code === 0 ? 'complete' : 'collector_failed', { collectorExitCode: code, finishedAt: Date.now() });
  // One final decision is calculated after the final token summaries flush.
  optimize();
});
