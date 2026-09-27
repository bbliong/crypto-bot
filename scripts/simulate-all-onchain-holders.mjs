import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Read-only, chain-authoritative holder snapshot. Unlike GMGN's top-100 UI
// endpoint, getProgramAccounts can enumerate every non-zero token account.
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const mint = option('mint');
const rpc = option('rpc') ?? 'https://api.mainnet-beta.solana.com';
const output = option('output') ?? join('research', 'onchain-holder-simulation-' + new Date().toISOString().replace(/[:.]/g, '-'));
if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) throw new Error('Gunakan --mint <alamat token Solana yang valid>.');
mkdirSync(output, { recursive: true });

let id = 0;
async function rpcCall(method, params) {
  const response = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) throw new Error(`${method}: HTTP ${response.status} ${body?.error?.message ?? 'invalid RPC response'}`);
  return body.result;
}

const mintInfo = await rpcCall('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
const tokenProgram = mintInfo?.value?.owner;
if (typeof tokenProgram !== 'string') throw new Error('Mint tidak ditemukan atau RPC tidak mengembalikan owner program.');
const filters = [{ memcmp: { offset: 0, bytes: mint } }];
// Legacy SPL Token accounts are always 165 bytes. Token-2022 accounts carry
// optional extensions and therefore have variable sizes; filtering at 165
// would silently drop real holders.
if (tokenProgram === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') filters.unshift({ dataSize: 165 });
const accounts = await rpcCall('getProgramAccounts', [tokenProgram, {
  commitment: 'confirmed', encoding: 'jsonParsed',
  filters,
}]);
const byOwner = new Map();
for (const item of accounts) {
  const info = item?.account?.data?.parsed?.info;
  const owner = info?.owner, amount = info?.tokenAmount?.amount;
  if (typeof owner !== 'string' || typeof amount !== 'string' || BigInt(amount) <= 0n) continue;
  byOwner.set(owner, (byOwner.get(owner) ?? 0n) + BigInt(amount));
}
const holders = [...byOwner].map(([wallet, rawAmount]) => ({ wallet, rawAmount: rawAmount.toString() })).sort((a, b) => (BigInt(a.rawAmount) > BigInt(b.rawAmount) ? -1 : BigInt(a.rawAmount) < BigInt(b.rawAmount) ? 1 : 0));
const report = {
  mint, observedAt: new Date().toISOString(), source: 'Solana JSON-RPC getProgramAccounts', rpc,
  readOnly: true, tokenProgram, tokenAccountsReturned: accounts.length, uniqueOwnersWithPositiveBalance: holders.length,
  caveat: 'Ini adalah snapshot on-chain pada commitment confirmed. GMGN dapat memakai indeks yang sedikit terlambat serta aturan filter/tag berbeda, sehingga angka GMGN tidak harus identik.',
};
writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2));
writeFileSync(join(output, 'holders.json'), JSON.stringify(holders, null, 2));
console.log('[onchain-holder-simulation]', output);
console.log(JSON.stringify({ tokenAccountsReturned: accounts.length, uniqueOwnersWithPositiveBalance: holders.length }));
