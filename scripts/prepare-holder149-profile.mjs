import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
register();
const { prepareHolder149Profile } = await import('../src/holder149-profile.ts');
try { console.log(JSON.stringify(await prepareHolder149Profile({ root: fileURLToPath(new URL('../', import.meta.url)) }), null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
