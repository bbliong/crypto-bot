import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const [major, minor] = process.versions.node.split('.').map(Number);
let runtime = process.execPath;
if (major < 22 || (major === 22 && minor < 13)) {
  const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe');
  if (!existsSync(bundled)) throw new Error('Install Node >=22.13 for node:sqlite.');
  runtime = bundled;
}
const command = process.argv[2];
const args = command === 'typecheck' ? ['node_modules/typescript/bin/tsc', '--noEmit']
  : ['--import', 'tsx', ...(command === 'test' ? ['--test', ...readdirSync('tests').filter(f=>f.endsWith('.test.ts') && !f.startsWith('extension-')).map(f=>'tests/'+f)]
    : command === 'dashboard:data' ? ['scripts/dashboard-data.mjs']
    : command === 'momentum:replay' ? ['scripts/replay-momentum.ts']
    : [command === 'monitor' ? 'src/tab-monitor.ts' : command === 'replay' ? 'src/replay.ts' : command === 'research' ? 'src/research-collector.ts' : command === 'pump-research' ? 'src/pump-band-research.ts' : command === 'trade-ui' ? 'src/gmgn-trade-ui.ts' : 'src/main.ts', ...(command === 'probe' ? ['--probe'] : [])])];
const result = spawnSync(runtime, [...args, ...process.argv.slice(3)], { stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
