import type { Candidate, Evidence } from './model.js';
import { validMint } from './parser.js';
const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export async function verifyMint(mint: string, rpcUrl: string, signal?: AbortSignal): Promise<Candidate> {
  if (!validMint(mint)) throw new Error('Invalid mint');
  const url = new URL(rpcUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('RPC requires HTTPS or localhost');
  const res = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }] }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('RPC unavailable');
  const json = await res.json() as any;
  const account = json?.result?.value; const parsed = account?.data?.parsed;
  const now = Date.now(); const fields: Candidate['fields'] = {};
  const ev = (value: number | boolean): Evidence => ({ value, observedAt: now, source: 'solana-rpc:getAccountInfo:confirmed' });
  if (json.error || !Object.hasOwn(json, 'result')) throw new Error('RPC invalid result');
  const verified = !!account && [LEGACY, TOKEN_2022].includes(account.owner) && parsed?.type === 'mint' && parsed.info?.isInitialized === true;
  fields.mintVerified = ev(verified);
  if (verified) {
    const info = parsed.info;
    if (Object.hasOwn(info, 'mintAuthority')) fields.mintAuthorityActive = ev(info.mintAuthority !== null);
    if (Object.hasOwn(info, 'freezeAuthority')) fields.freezeAuthorityActive = ev(info.freezeAuthority !== null);
    if (account.owner === LEGACY) {
      fields.tokenExtensionsVerified = ev(true); fields.transferFeePercent = ev(0); fields.transferHookActive = ev(false);
    }
    // Token-2022 extensions require a dedicated verified decoder. Keep UNKNOWN.
  }
  return { mint, firstSeenAt: now, updatedAt: now, fields };
}
