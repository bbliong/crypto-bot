import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
register();
const { main } = await import('../src/holder149-watch.ts');
await main();
