import { at, validMint } from './parser.js';
import { createHash } from 'node:crypto';

export type TokenActivity = {
  mint: string;
  side: 'buy' | 'sell';
  occurredAt: number;
  observedAt: number;
  priceUsd?: number;
  amount?: number;
  actorHash?: string;
  actorAddress?: string;
};

// A stable one-way hash permits counting distinct actors without retaining a
// public wallet address or signature.
export function parseTokenActivities(payload: unknown, observedAt: number): TokenActivity[] {
  const channel = at(payload, 'channel');
  if (channel !== 'token_activity_info_all' && channel !== 'token_activity') return [];
  const records = at(payload, 'data');
  if (!Array.isArray(records)) return [];
  const result: TokenActivity[] = [];
  for (const record of records) {
    if (at(record, 'n') !== 'sol') continue;
    const mint = at(record, 'a');
    const side = at(record, 'e');
    if (!validMint(mint) || (side !== 'buy' && side !== 'sell')) continue;
    const seconds = Number(at(record, 't'));
    const occurredAt = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : observedAt;
    const rawPrice = Number(at(record, 'pu'));
    const rawAmount = Number(at(record, 'au'));
    const actor = at(record, 'ad');
    result.push({ mint, side, occurredAt, observedAt,
      ...(Number.isFinite(rawPrice) && rawPrice >= 0 ? { priceUsd: rawPrice } : {}),
      ...(Number.isFinite(rawAmount) && rawAmount >= 0 ? { amount: rawAmount } : {}),
      ...(validMint(actor) ? { actorAddress: actor, actorHash: createHash('sha256').update(actor).digest('hex').slice(0, 16) } : {}),
    });
  }
  return result;
}
