#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(__dirname, '..');

function parseArgs() {
  const rawArgs = process.argv.slice(2);
  const defaultProfileDir = existsSync(join(projectRoot, 'profiles/research-vps'))
    ? 'profiles/research-vps'
    : 'profiles/research-aria-tele01';
  const defaultProfileName = defaultProfileDir === 'profiles/research-vps' ? 'Default' : 'Profile 12';

  const options = {
    workers: '3',
    seconds: '0',
    detailSeconds: '90',
    stakeUsd: '0.25',
    profileDir: defaultProfileDir,
    profileName: defaultProfileName,
    output: null,
    quoteSimulation: true,
    simulateOrder: true,
    orderCapturePayloads: true,
    passThrough: [],
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--workers' && rawArgs[i + 1]) {
      options.workers = rawArgs[++i];
    } else if (arg.startsWith('--workers=')) {
      options.workers = arg.split('=')[1];
    } else if (arg === '--seconds' && rawArgs[i + 1]) {
      options.seconds = rawArgs[++i];
    } else if (arg.startsWith('--seconds=')) {
      options.seconds = arg.split('=')[1];
    } else if (arg === '--detailSeconds' && rawArgs[i + 1]) {
      options.detailSeconds = rawArgs[++i];
    } else if (arg.startsWith('--detailSeconds=')) {
      options.detailSeconds = arg.split('=')[1];
    } else if (arg === '--stakeUsd' && rawArgs[i + 1]) {
      options.stakeUsd = rawArgs[++i];
    } else if (arg.startsWith('--stakeUsd=')) {
      options.stakeUsd = arg.split('=')[1];
    } else if (arg === '--profileDir' && rawArgs[i + 1]) {
      options.profileDir = rawArgs[++i];
    } else if (arg.startsWith('--profileDir=')) {
      options.profileDir = arg.split('=')[1];
    } else if (arg === '--profileName' && rawArgs[i + 1]) {
      options.profileName = rawArgs[++i];
    } else if (arg.startsWith('--profileName=')) {
      options.profileName = arg.split('=')[1];
    } else if (arg === '--output' && rawArgs[i + 1]) {
      options.output = rawArgs[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.split('=')[1];
    } else {
      options.passThrough.push(arg);
    }
  }

  return options;
}

const opts = parseArgs();

if (!opts.output) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  opts.output = `research/momentum-aggressive-${timestamp}`;
}

const fullOutputDir = join(projectRoot, opts.output);
if (!existsSync(fullOutputDir)) {
  mkdirSync(fullOutputDir, { recursive: true });
}

console.log('=============================================================================');
console.log('         🚀 AGY AGGRESSIVE HIGH-VOLUME SNIPER (3 WORKERS) 🚀                 ');
console.log('=============================================================================');
console.log(` Strategy         : momentum-aggressive (AGY High-Volume Sniper)`);
console.log(` Parallel Workers : ${opts.workers} workers`);
console.log(` Session Timeout  : ${opts.seconds === '0' ? 'Infinite (Runs until Ctrl+C)' : opts.seconds + 's'}`);
console.log(` Detail Window    : ${opts.detailSeconds}s per token`);
console.log(` Stake USD        : $${opts.stakeUsd}`);
console.log(` Output Run Dir   : ${opts.output}`);
console.log(` Profile Dir      : ${opts.profileDir} (${opts.profileName})`);
console.log('-----------------------------------------------------------------------------');
console.log(' Rules Configuration:');
console.log('   • 5s Volume Gate       : BuyUsd >= $300 in 5s rolling window');
console.log('   • Anti-Whale Flow Gate : BuyShare >= 95%, >= 4 distinct buyers, TopBuyerShare <= 70%');
console.log('   • MC Sweet Spot Gate   : $5,500 <= Market Cap <= $15,000 (Avoids raw traps & peak dumps)');
console.log('   • Rising Velocity      : Return5s >= +1.0%, Slope5s > 0, MaxDrawdown <= 2.5%');
console.log('   • Hard Stop Loss       : -3.0% (Strict capital protection)');
console.log('   • Scalp Tier (4%-11%)  : Lock +2.5% -> Tight Trailing 1.0% (Secures quick pumps)');
console.log('   • Runner Tier (>= 11%) : Wide Trailing 8.0% -> Lock +4.0% (Catches +30% to +100% moonshots)');
console.log('   • Stagnation Auto-Cut  : 15s without reaching +2.5% -> Breakeven Cut');
console.log('-----------------------------------------------------------------------------');
console.log(' Data Recorded:');
console.log('   • Full Socket Trades   : trades.jsonl, socket-ticks.jsonl, events.jsonl');
console.log('   • Paper Signals        : trade-signals.jsonl, paper-orders.jsonl');
console.log('   • Order Simulation     : simulated-order-intents.jsonl');
console.log('   • Swap Route Quotes    : quote-simulated-orders.jsonl (Live GMGN Route/Slippage)');
console.log('   • Decisions & Summary  : momentum-decisions.jsonl, token-summary.jsonl');
console.log('-----------------------------------------------------------------------------');
console.log(' 📊 Dashboard: Run "npm run dashboard:aggressive" -> http://localhost:4180');
console.log('=============================================================================\n');

const commandArgs = [
  'scripts/run.mjs',
  'research',
  '--strategy', 'momentum-aggressive',
  '--workers', opts.workers,
  '--seconds', opts.seconds,
  '--detailSeconds', opts.detailSeconds,
  '--stakeUsd', opts.stakeUsd,
  '--profileDir', opts.profileDir,
  '--profileName', opts.profileName,
  '--output', opts.output,
  '--simulateOrder',
  '--quoteSimulation',
  '--controlOnly',
  ...opts.passThrough,
];

const child = spawn(process.execPath, commandArgs, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    AGGRESSIVE_RUN_FOLDER: opts.output,
  },
});

function handleExit(signal) {
  console.log(`\n[AGY Aggressive Runner] Received ${signal}. Shutting down workers gracefully...`);
  if (!child.killed) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));

child.on('close', code => {
  console.log(`\n=============================================================================`);
  console.log(` [AGY Aggressive Runner] Execution completed with exit code: ${code}`);
  console.log(` Run data saved to: ${opts.output}`);
  console.log(` To view the Aggressive Dashboard:`);
  console.log(`   node scripts/serve-aggressive-dashboard-agy.mjs --run ${opts.output}`);
  console.log(`=============================================================================`);
  process.exit(code ?? 0);
});
