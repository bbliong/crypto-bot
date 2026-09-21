import { booleanFields, numericFields, type Candidate, type Field, type Mapping, type TokenMetadata } from './model.js';
export const PARSER_VERSION = 'gmgn-explicit-mapping/2';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function validMint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false;
  let n = 0n;
  for (const c of value) { const i = alphabet.indexOf(c); if (i < 0) return false; n = n * 58n + BigInt(i); }
  let bytes = 0; while (n > 0n) { bytes++; n >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
export function at(value: unknown, path: string): unknown {
  if (!path) return value;
  for (const k of path.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, k) || ['__proto__', 'prototype', 'constructor'].includes(k)) return undefined;
    value = (value as Record<string, unknown>)[k];
  }
  return value;
}
export function decodeFrame(payload: string | Buffer): unknown | null {
  if (Buffer.byteLength(payload) > 2_000_000) return null;
  try { return JSON.parse(payload.toString()); } catch { return null; }
}
export function parseCandidates(payload: unknown, mappings: Mapping[], now: number, source: string): Candidate[] {
  const channel = at(payload, 'channel');
  // gk is a routing/group key, NOT proof of a token mint. Twitter updates are not tokens.
  if (channel === 'chain_stat') return [];
  const out: Candidate[] = [];
  for (const m of mappings) {
    if (channel !== m.channel) continue;
    const records = at(payload, m.recordsPath);
    for (const record of Array.isArray(records) ? records : [records]) {
      if (at(record, m.chainPath) !== m.chainValue) continue;
      if (m.eventPath && at(record, m.eventPath) !== m.eventValue) continue;
      const mint = at(record, m.mintPath);
      if (!validMint(mint)) continue;
      const metadata: TokenMetadata = {};
      for (const [key, path] of Object.entries(m.metadata ?? {})) {
        const raw = at(record, path);
        if (typeof raw !== 'string' || !raw.trim() || raw.length > 160) continue;
        if (key === 'imageUrl') {
          try {
            const url = new URL(raw);
            if (url.protocol !== 'https:' || !url.hostname.endsWith('gmgn.ai')) continue;
          } catch { continue; }
        }
        metadata[key as keyof TokenMetadata] = raw.trim();
      }
      const fields: Candidate['fields'] = {};
      const invalidatedFields: NonNullable<Candidate['invalidatedFields']> = {};
      for (const [key, spec] of Object.entries(m.fields)) {
        const raw = at(record, spec.path); let value: number | boolean;
        if (raw === undefined) continue; // Omitted fields are ordinary partial updates.
        if (![...booleanFields, ...numericFields].includes(key as Field)) continue;
        // Explicitly unusable data revokes an earlier good value until revalidated.
        invalidatedFields[key as Field] = { observedAt: now, source };
        if ((booleanFields as readonly string[]).includes(key)) {
          if (typeof raw !== 'boolean') continue;
          value = raw;
        } else if ((numericFields as readonly string[]).includes(key)) {
          if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim() !== '')) continue;
          value = Number(raw) * (spec.scale ?? 1);
          if (!Number.isFinite(value) || (value < 0 && key !== 'risePercent')) continue;
          if (key.endsWith('Percent') && key !== 'risePercent' && value > 100) continue;
          if (['holders', 'buys', 'sells', 'sameSlotWallets', 'sharedFunderWallets'].includes(key) && !Number.isSafeInteger(value)) continue;
          if (key === 'createdAt' || key === 'tradingStartedAt') {
            if (!spec.unit) continue;
            if (spec.unit === 'seconds') value *= 1000;
            if (value <= 0 || value > now) continue;
          }
        } else continue;
        fields[key as Field] = { value, observedAt: now, source };
        delete invalidatedFields[key as Field];
      }
      out.push({ mint, firstSeenAt: now, updatedAt: now, fields,
        ...(Object.keys(metadata).length ? { metadata } : {}),
        ...(Object.keys(invalidatedFields).length ? { invalidatedFields } : {}) });
    }
  }
  return out;
}
export function parseTokenMetadata(payload: unknown): Array<{ mint: string; metadata: TokenMetadata }> {
  const channel = at(payload, 'channel');
  const records = at(payload, 'data');
  if (!Array.isArray(records)) return [];
  const out: Array<{ mint: string; metadata: TokenMetadata }> = [];
  for (const record of records) {
    const item = record as Record<string, unknown>;
    let mint: unknown; let chain: unknown; let name: unknown; let symbol: unknown; let imageUrl: unknown;
    if (channel === 'public_broadcast' && at(item, 'et') === 'signal') {
      mint = at(item, 'ed.d.a'); chain = at(item, 'ed.c');
      name = at(item, 'ed.d.nm'); symbol = at(item, 'ed.d.s'); imageUrl = at(item, 'ed.d.l');
    } else if (channel === 'token_activity_info_all') {
      mint = item.a; chain = item.n; name = item.bn; symbol = item.bs; imageUrl = item.bl;
    } else continue;
    if (chain !== 'sol' || !validMint(mint)) continue;
    const metadata: TokenMetadata = {};
    if (typeof name === 'string' && name.trim() && name.length <= 160) metadata.name = name.trim();
    if (typeof symbol === 'string' && symbol.trim() && symbol.length <= 80) metadata.symbol = symbol.trim();
    if (typeof imageUrl === 'string') {
      try {
        const url = new URL(imageUrl);
        if (url.protocol === 'https:' && url.hostname.endsWith('gmgn.ai')) metadata.imageUrl = imageUrl;
      } catch { /* image is optional */ }
    }
    if (Object.keys(metadata).length) out.push({ mint, metadata });
  }
  return out;
}

// Probe persists schema only. No frame bodies, credentials, IDs or query strings.
export function describeFrame(value: unknown) {
  const safeName = (x: unknown) => typeof x === 'string' && /^[a-z_][a-z0-9_.-]{0,63}$/i.test(x) ? x : 'unknown';
  const paths: Record<string, string> = {};
  function walk(v: unknown, prefix: string, depth: number) {
    if (depth > 5 || Object.keys(paths).length >= 150) return;
    if (Array.isArray(v)) { paths[prefix] = 'array'; if (v.length) walk(v[0], `${prefix}[]`, depth + 1); }
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v).slice(0, 80)) {
        if (!/^[a-z_][a-z0-9_]{0,39}$/i.test(k)) continue;
        if (/cookie|auth|token$|secret|session|device|tab_id|fp_did|uuid|client_id/i.test(k) && !['token', 'base_token', 'quote_token'].includes(k)) continue;
        walk(child, prefix ? `${prefix}.${k}` : k, depth + 1);
      }
    } else paths[prefix] = v === null ? 'null' : typeof v;
  }
  walk(value, '', 0);
  return { channel: safeName(at(value, 'channel')), event: safeName(at(value, 'data.0.t') ?? at(value, 'data.0.et')), paths };
}
