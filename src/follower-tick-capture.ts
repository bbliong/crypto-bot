import type { CaptureContext, TickEnvelope, FollowerChannel } from './follower-tick-schema.js';

const CHANNELS = new Set<FollowerChannel>(['token_activity','token_stat','wallet_activity_info']);
const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|api[_-]?key|secret|private[_-]?key|password|token|bearer|session[_-]?id)$/i;

export function redactMarketValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[REDACTED_DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.map(v => redactMarketValue(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
      [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactMarketValue(entry, depth + 1)]));
  }
  return value;
}

export function extractFollowerTicks(payload: string, ctx: CaptureContext): TickEnvelope[] {
  let msg: any;
  try { msg = JSON.parse(payload); } catch { return []; }
  return extractFollowerTicksFromMessage(msg, ctx);
}

export function extractFollowerTicksFromMessage(msg: any, ctx: CaptureContext): TickEnvelope[] {
  if (!msg || !CHANNELS.has(msg.channel) || !Array.isArray(msg.data)) return [];
  const channel = msg.channel as FollowerChannel;
  return msg.data.flatMap((item: unknown, itemIndex: number) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const obj = item as Record<string, unknown>;
    if (channel === 'wallet_activity_info' && obj.m !== ctx.targetWallet && !!obj.m) return [];
    return [{
      schemaVersion: 1 as const,
      sessionId: ctx.sessionId,
      connectionId: ctx.connectionId,
      requestId: ctx.requestId,
      receiveSequence: ctx.receiveSequence,
      itemIndex,
      receivedAt: ctx.receivedAt,
      channel,
      mint: typeof obj.a === 'string' ? obj.a : null,
      source: 'gmgn_browser_ws' as const,
      raw: redactMarketValue(item),
    }];
  });
}
